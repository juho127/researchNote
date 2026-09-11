/**
 * 공개 카테고리 핀 열람 — 토큰·권한 없이 핀만으로 읽기 전용 세션을 발급한다.
 *
 * - 관리자가 카테고리를 공개(is_public)로 두고 핀을 설정해야 한다 (admin.updateCategory).
 * - 핀은 해시로만 저장. 카테고리+IP 별 5회 실패 시 10분 잠금.
 * - 성공하면 rnv_ 토큰(열람 세션, 24시간). 핀 변경·공개 해제 시 기존 세션은 모두 무효.
 */
import type { Env } from "../env";
import { trackOf } from "../env";
import { bad, HttpError, str, strLimited, unauthorized } from "../lib/http";
import { newId, randomString, sha256Hex, tokenHint } from "../lib/id";
import { nowIso } from "../lib/time";
import { logActivity } from "../lib/db";

export const VIEWER_TTL_MS = 24 * 60 * 60 * 1000; // 열람 세션 24시간
const MAX_FAILS = 5;
const LOCK_MS = 10 * 60 * 1000;
const PIN_RE = /^[A-Za-z0-9]{4,12}$/;

export function pinHash(categoryId: string, pin: string): Promise<string> {
  return sha256Hex(`${categoryId}:${pin}`);
}

/** 핀 형식: 영문·숫자 4~12자 (공백 제거). 빈 문자열은 '핀 해제' */
export function normPin(v: unknown): string {
  const s = str(v, 40).replace(/\s+/g, "");
  if (!s) return "";
  if (!PIN_RE.test(s)) bad("핀은 영문·숫자 4~12자여야 합니다");
  return s;
}

export interface PublicTeam {
  id: string;
  name: string;
  description: string;
  track: string;
  track_label: string;
  member_count: number;
  active_projects: number;
  last_activity_at: string | null;
}

/** 핀 열람이 가능한(공개 + 핀 설정) 카테고리 목록 — 인증 불필요 */
export async function listPublicTeams(env: Env): Promise<PublicTeam[]> {
  const rs = await env.DB
    .prepare(
      `SELECT c.id, c.name, c.description, c.track,
         (SELECT COUNT(*) FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.category_id = c.id AND u.disabled_at IS NULL) AS member_count,
         (SELECT COUNT(*) FROM projects p WHERE p.category_id = c.id AND p.status = 'active') AS active_projects,
         (SELECT MAX(a.at) FROM activity a WHERE a.category_id = c.id) AS last_activity_at
       FROM categories c WHERE c.archived_at IS NULL AND c.is_public = 1 AND c.pin_hash IS NOT NULL ORDER BY c.name`
    )
    .all<Omit<PublicTeam, "track_label">>();
  return (rs.results ?? []).map((t) => ({ ...t, track_label: trackOf(t.track).label }));
}

function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";
}

/** 핀 검증 → 열람 세션 발급 */
export async function pinLogin(env: Env, request: Request, categoryId: string, input: { pin?: unknown; label?: unknown }) {
  const cat = await env.DB
    .prepare(`SELECT id, name, description, track, is_public, pin_hash FROM categories WHERE id = ? AND archived_at IS NULL`)
    .bind(categoryId)
    .first<{ id: string; name: string; description: string; track: string; is_public: number; pin_hash: string | null }>();
  if (!cat || !cat.is_public || !cat.pin_hash) throw new HttpError(404, "핀 열람이 가능한 팀이 아닙니다", "not_public");
  const pin = str(input.pin, 40).replace(/\s+/g, "");
  if (!pin) bad("핀을 입력하세요");
  const ip = clientIp(request);
  const now = Date.now();
  const nowStr = new Date(now).toISOString();

  // 잠금 확인
  const att = await env.DB.prepare(`SELECT fails, locked_until FROM pin_attempts WHERE category_id = ? AND ip = ?`).bind(cat.id, ip).first<{ fails: number; locked_until: string | null }>();
  if (att?.locked_until && att.locked_until > nowStr) {
    const left = Math.max(1, Math.ceil((new Date(att.locked_until).getTime() - now) / 60000));
    throw new HttpError(429, `핀 오류가 너무 많습니다. ${left}분 후 다시 시도하세요`, "locked");
  }

  const ok = (await pinHash(cat.id, pin)) === cat.pin_hash;
  if (!ok) {
    const fails = (att?.locked_until && att.locked_until > nowStr ? 0 : att?.fails ?? 0) + 1;
    const lock = fails >= MAX_FAILS;
    await env.DB
      .prepare(`INSERT OR REPLACE INTO pin_attempts (category_id, ip, fails, locked_until, updated_at) VALUES (?, ?, ?, ?, ?)`)
      .bind(cat.id, ip, lock ? 0 : fails, lock ? new Date(now + LOCK_MS).toISOString() : null, nowStr)
      .run();
    if (lock) throw new HttpError(429, `핀을 ${MAX_FAILS}회 틀려 10분간 잠겼습니다`, "locked");
    unauthorized(`핀이 올바르지 않습니다 (남은 시도 ${MAX_FAILS - fails}회)`);
  }

  // 성공: 실패 기록 삭제, 만료 세션 정리, 새 세션 발급
  const token = "rnv_" + randomString(40);
  const id = newId("vs");
  const expires = new Date(now + VIEWER_TTL_MS).toISOString();
  const label = strLimited(input.label, 60, "label");
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM pin_attempts WHERE category_id = ? AND ip = ?`).bind(cat.id, ip),
    env.DB.prepare(`DELETE FROM viewer_sessions WHERE expires_at < ?`).bind(nowStr),
    env.DB.prepare(`INSERT INTO viewer_sessions (id, category_id, token_hash, hint, label, ip, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, cat.id, await sha256Hex(token), tokenHint(token), label, ip, nowStr, expires),
  ]);
  await logActivity(env, { actor_id: null as unknown as string, category_id: cat.id, action: "viewer.login", target_id: id, summary: `핀 열람 시작${label ? ` (${label})` : ""}`, source: "web" });
  return {
    viewer_token: token,
    expires_at: expires,
    category: { id: cat.id, name: cat.name, description: cat.description, track: cat.track, track_label: trackOf(cat.track).label },
  };
}

/** 카테고리의 열람 세션 전부 무효화 (핀 변경·공개 해제 시) */
export async function revokeViewerSessions(env: Env, categoryId: string): Promise<number> {
  const r = await env.DB.prepare(`DELETE FROM viewer_sessions WHERE category_id = ?`).bind(categoryId).run();
  return r.meta.changes ?? 0;
}

/** 관리자용: 카테고리별 활성 열람 세션 수 */
export async function activeViewerCount(env: Env, categoryId: string): Promise<number> {
  const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM viewer_sessions WHERE category_id = ? AND expires_at > ?`).bind(categoryId, nowIso()).first<{ n: number }>();
  return r?.n ?? 0;
}
