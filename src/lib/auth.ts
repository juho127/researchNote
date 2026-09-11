import type { AuthContext, Env, Membership, User, ViewerInfo } from "../env";
import { sha256Hex } from "./id";
import { nowIso } from "./time";
import { unauthorized, forbidden } from "./http";

/** ADMIN_TOKEN 시크릿 전용 사용자 id (UI 에서 만드는 일반 사용자와 충돌하지 않도록 예약) */
const BOOTSTRAP_ADMIN_ID = "bootstrap-admin";

function extractToken(request: Request): string {
  const auth = request.headers.get("authorization") || "";
  if (/^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, "").trim();
  const key = request.headers.get("x-api-key");
  if (key) return key.trim();
  return "";
}

async function loadMemberships(db: D1Database, userId: string): Promise<Membership[]> {
  const rs = await db
    .prepare(
      `SELECT m.category_id, c.name AS category_name, m.role
         FROM memberships m JOIN categories c ON c.id = m.category_id
        WHERE m.user_id = ? AND c.archived_at IS NULL
        ORDER BY c.name`
    )
    .bind(userId)
    .all<{ category_id: string; category_name: string; role: "lead" | "member" | "evaluator" }>();
  return rs.results ?? [];
}

/** 열람 세션 토큰 접두어 (개인 토큰 rn_ 과 구분) */
export const VIEWER_PREFIX = "rnv_";

/**
 * 핀 열람 세션 토큰 → 읽기 전용 AuthContext.
 * 카테고리가 여전히 공개·핀 설정 상태이고 세션이 만료되지 않았을 때만 유효하다.
 */
async function authenticateViewer(token: string, env: Env, source: AuthContext["source"]): Promise<AuthContext> {
  const hash = await sha256Hex(token);
  const row = await env.DB
    .prepare(
      `SELECT v.id, v.category_id, v.label, v.expires_at, v.created_at, c.name AS category_name, c.is_public, c.pin_hash, c.archived_at
         FROM viewer_sessions v JOIN categories c ON c.id = v.category_id
        WHERE v.token_hash = ?`
    )
    .bind(hash)
    .first<{ id: string; category_id: string; label: string; expires_at: string; created_at: string; category_name: string; is_public: number; pin_hash: string | null; archived_at: string | null }>();
  if (!row) unauthorized("유효하지 않은 열람 토큰입니다. 핀을 다시 입력하세요");
  const now = nowIso();
  if (row.expires_at <= now) unauthorized("열람 세션이 만료되었습니다 (24시간). 핀을 다시 입력하세요");
  if (!row.is_public || !row.pin_hash || row.archived_at) unauthorized("이 팀은 더 이상 공개 열람을 허용하지 않습니다");
  await env.DB.prepare(`UPDATE viewer_sessions SET last_used_at = ? WHERE id = ?`).bind(now, row.id).run().catch(() => {});
  const viewer: ViewerInfo = { session_id: row.id, category_id: row.category_id, category_name: row.category_name, expires_at: row.expires_at };
  const user: User = { id: `viewer:${row.category_id}`, name: row.label || "열람자", email: "", role: "member", note: "핀 열람 세션", created_at: row.created_at, disabled_at: null, last_seen_at: null };
  return {
    user,
    memberships: [{ category_id: row.category_id, category_name: row.category_name, role: "viewer" }],
    tokenId: null,
    isAdmin: false,
    source,
    viewer,
  };
}

/** 부트스트랩 관리자 사용자 행을 보장 (ADMIN_TOKEN 시크릿으로 로그인 시) */
async function ensureBootstrapAdmin(db: D1Database): Promise<User> {
  const existing = await db.prepare(`SELECT * FROM users WHERE id = ?`).bind(BOOTSTRAP_ADMIN_ID).first<User>();
  if (existing) return existing;
  const at = nowIso();
  await db
    .prepare(`INSERT INTO users (id, name, email, role, note, created_at) VALUES (?, ?, '', 'admin', '부트스트랩 관리자(ADMIN_TOKEN)', ?)`)
    .bind(BOOTSTRAP_ADMIN_ID, "부트스트랩 관리자", at)
    .run();
  return (await db.prepare(`SELECT * FROM users WHERE id = ?`).bind(BOOTSTRAP_ADMIN_ID).first<User>())!;
}

/**
 * 요청의 Bearer 토큰을 검증해 AuthContext 를 만든다.
 * - ADMIN_TOKEN 시크릿과 일치 → 부트스트랩 관리자
 * - tokens.token_hash 일치 & 미회수 & 사용자 활성 → 해당 사용자
 */
export async function authenticate(request: Request, env: Env, source: AuthContext["source"]): Promise<AuthContext> {
  const token = extractToken(request);
  if (!token) unauthorized();

  if (token.startsWith(VIEWER_PREFIX)) return authenticateViewer(token, env, source);

  if (env.ADMIN_TOKEN && token === env.ADMIN_TOKEN) {
    const user = await ensureBootstrapAdmin(env.DB);
    // 관리자 화면에서 bootstrap-admin 을 비활성화하면 시크릿 토큰도 막힌다
    if (user.disabled_at) unauthorized("부트스트랩 관리자가 비활성화되어 있습니다");
    return { user: { ...user, role: "admin" }, memberships: await loadMemberships(env.DB, user.id), tokenId: null, isAdmin: true, source };
  }

  const hash = await sha256Hex(token);
  const row = await env.DB
    .prepare(
      `SELECT t.id AS token_id, t.revoked_at, u.*
         FROM tokens t JOIN users u ON u.id = t.user_id
        WHERE t.token_hash = ?`
    )
    .bind(hash)
    .first<User & { token_id: string; revoked_at: string | null }>();
  if (!row) unauthorized("유효하지 않은 토큰입니다");
  if (row.revoked_at) unauthorized("회수된 토큰입니다. 관리자에게 새 토큰을 요청하세요");
  if (row.disabled_at) unauthorized("비활성화된 계정입니다");

  const { token_id, revoked_at: _r, ...user } = row;
  const at = nowIso();
  // 마지막 사용 시각 갱신 (실패해도 무시)
  await Promise.all([
    env.DB.prepare(`UPDATE tokens SET last_used_at = ? WHERE id = ?`).bind(at, token_id).run().catch(() => {}),
    env.DB.prepare(`UPDATE users SET last_seen_at = ? WHERE id = ?`).bind(at, user.id).run().catch(() => {}),
  ]);
  return {
    user: user as User,
    memberships: await loadMemberships(env.DB, user.id),
    tokenId: token_id,
    isAdmin: user.role === "admin",
    source,
  };
}

export function requireAdmin(ctx: AuthContext): void {
  if (!ctx.isAdmin) forbidden("관리자 권한이 필요합니다");
}

/** 열람 모드(핀 세션)에서는 어떤 쓰기도 허용하지 않는다 */
export function requireWriter(ctx: AuthContext): void {
  if (ctx.viewer) forbidden("열람 모드에서는 읽기만 가능합니다. 기록·수정하려면 개인 토큰으로 로그인하세요");
}

export type EffectiveRole = "admin" | "lead" | "member" | "evaluator" | "viewer";

export function categoryRole(ctx: AuthContext, categoryId: string): EffectiveRole | null {
  if (ctx.isAdmin) return "admin";
  const m = ctx.memberships.find((x) => x.category_id === categoryId);
  return m ? m.role : null;
}

/** 카테고리 열람 권한 (관리자 또는 구성원·평가자·핀 열람자) */
export function requireCategoryMember(ctx: AuthContext, categoryId: string): EffectiveRole {
  const r = categoryRole(ctx, categoryId);
  if (!r) forbidden("이 카테고리의 구성원이 아닙니다");
  return r;
}

/** 검토 권한: 관리자 / 카테고리 리드 */
export function canReview(ctx: AuthContext, categoryId: string): boolean {
  const r = categoryRole(ctx, categoryId);
  return r === "admin" || r === "lead";
}

/** 평가 권한: 관리자 / 리드 / 평가자 (여러 명 가능) */
export function canEvaluate(ctx: AuthContext, categoryId: string): boolean {
  const r = categoryRole(ctx, categoryId);
  return r === "admin" || r === "lead" || r === "evaluator";
}
