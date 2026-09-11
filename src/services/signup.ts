import type { AuthContext, Env } from "../env";
import { bad, bool, notFound, oneOf, str, strLimited, HttpError } from "../lib/http";
import { newId, newClaimCode, sha256Hex, tokenHint } from "../lib/id";
import { nowIso } from "../lib/time";
import { logActivity } from "../lib/db";
import { createUser, issueToken, listCategories, listUsers } from "./admin";

export interface SignupRow {
  id: string;
  name: string;
  email: string;
  category_id: string | null;
  category_name?: string | null;
  note: string;
  /** signup = 신규 가입, reissue = 기존 계정 토큰 재발급 (user_id 가 처음부터 채워짐) */
  kind: "signup" | "reissue";
  status: "pending" | "approved" | "rejected";
  claim_hint: string;
  user_id: string | null;
  decided_by: string | null;
  decided_by_name?: string | null;
  decided_at: string | null;
  decision_note: string;
  claimed_at: string | null;
  created_at: string;
}

const MAX_PENDING = 200;

export function signupEnabled(env: Env): boolean {
  return (env.SIGNUP_ENABLED ?? "true").toLowerCase() !== "false";
}

/** 토큰 재발급을 관리자 승인 없이 즉시 처리할지 (기본 true) */
export function reissueAuto(env: Env): boolean {
  return (env.REISSUE_AUTO ?? "true").toLowerCase() !== "false";
}

/** 공개 설정: 신청 폼에 필요한 정보 */
export async function publicConfig(env: Env) {
  const cats = signupEnabled(env) ? await listCategories(env, false) : [];
  return {
    app: { name: env.APP_NAME, org: env.ORG_NAME, org_sub: env.ORG_SUB, mark: env.ORG_MARK },
    signup_enabled: signupEnabled(env),
    signup_code_required: !!env.SIGNUP_CODE,
    reissue_auto: reissueAuto(env),
    categories: cats.map((c) => ({ id: c.id, name: c.name, description: c.description, track: c.track })),
  };
}

export async function createRequest(env: Env, input: Record<string, unknown>): Promise<{ id: string; claim_code: string; status: string }> {
  if (!signupEnabled(env)) throw new HttpError(403, "현재 발급 신청을 받지 않습니다. 관리자에게 직접 요청하세요", "signup_disabled");
  if (env.SIGNUP_CODE) {
    if (str(input.signup_code, 100) !== env.SIGNUP_CODE) throw new HttpError(403, "신청 코드가 올바르지 않습니다 (연구책임자에게 확인)", "bad_signup_code");
  }
  const name = strLimited(input.name, 100, "name");
  if (!name) bad("이름을 입력하세요");
  const email = strLimited(input.email, 200, "email");
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) bad("이메일 형식이 올바르지 않습니다");
  const note = strLimited(input.note, 500, "note");
  let categoryId: string | null = null;
  if (input.category_id !== undefined && input.category_id !== null && input.category_id !== "") {
    categoryId = str(input.category_id, 100);
    const c = await env.DB.prepare(`SELECT id FROM categories WHERE id = ? AND archived_at IS NULL`).bind(categoryId).first();
    if (!c) bad("선택한 카테고리가 없습니다");
  }
  const pending = await env.DB.prepare(`SELECT COUNT(*) AS n FROM signup_requests WHERE status = 'pending'`).first<{ n: number }>();
  if ((pending?.n ?? 0) >= MAX_PENDING) throw new HttpError(429, "대기 중인 신청이 너무 많습니다. 잠시 후 다시 시도하세요", "too_many");
  if (email) {
    const dup = await env.DB.prepare(`SELECT id FROM signup_requests WHERE status = 'pending' AND email = ?`).bind(email).first();
    if (dup) bad("같은 이메일로 대기 중인 신청이 있습니다. 수령 코드로 상태를 확인하세요");
    // 이미 계정이 있으면(승인 완료) 다시 신청하지 말고 수령 코드/재발급으로 안내 (중복 계정 방지)
    const existing = await env.DB.prepare(`SELECT id, name FROM users WHERE email = ? AND disabled_at IS NULL`).bind(email).first<{ id: string; name: string }>();
    if (existing) throw new HttpError(409, `이 이메일로 이미 계정(${existing.name})이 있습니다. 토큰을 잃어버렸다면 새로 신청하지 말고 [토큰 재발급 요청](/#/reissue)을 이용하세요 (이름+이메일 확인 → 관리자 승인 → 새 토큰 수령)`, "already_registered");
  }
  const claim = newClaimCode();
  const id = newId("req");
  const at = nowIso();
  await env.DB
    .prepare(`INSERT INTO signup_requests (id, name, email, category_id, note, status, claim_hash, claim_hint, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`)
    .bind(id, name, email, categoryId, note, await sha256Hex(claim), tokenHint(claim), at)
    .run();
  await logActivity(env, { actor_id: null as unknown as string, category_id: categoryId, action: "signup.request", target_id: id, summary: `${name}${email ? ` <${email}>` : ""}`, source: "web" });
  return { id, claim_code: claim, status: "pending" };
}

async function findByClaim(env: Env, claim: string): Promise<SignupRow> {
  const c = str(claim, 100);
  if (!c) notFound("신청을 찾을 수 없습니다");
  const row = await env.DB
    .prepare(`SELECT r.*, c.name AS category_name FROM signup_requests r LEFT JOIN categories c ON c.id = r.category_id WHERE r.claim_hash = ?`)
    .bind(await sha256Hex(c))
    .first<SignupRow>();
  if (!row) notFound("수령 코드에 해당하는 신청이 없습니다");
  return row;
}

/**
 * 기존 회원의 토큰 재발급 요청 (공개): 이름 + 이메일이 등록된 활성 계정과 일치해야 한다.
 * 자동 승인은 하지 않는다 (이메일 인증 수단이 없어 계정 탈취 위험). 관리자가 승인하면 본인이 수령 코드로 새 토큰을 받는다.
 */
const REISSUE_LOCK_KEY = "__reissue__";
const REISSUE_MAX_FAILS = 5;
const REISSUE_LOCK_MS = 10 * 60 * 1000;

export type ReissueResult =
  | { mode: "auto"; token: string; hint: string; user_id: string; name: string; revoked: number }
  | { mode: "approval"; id: string; claim_code: string; status: string; name: string };

export async function requestReissue(env: Env, request: Request, input: Record<string, unknown>): Promise<ReissueResult> {
  const name = strLimited(input.name, 100, "name");
  const email = strLimited(input.email, 200, "email").toLowerCase();
  if (!name || !email) bad("이름과 이메일을 모두 입력하세요");
  const note = strLimited(input.note, 500, "note");
  const ip = request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";
  const now = Date.now();
  const nowStr = new Date(now).toISOString();
  // 이름·이메일 추측 시도 방지: IP 당 5회 불일치 → 10분 잠금 (pin_attempts 테이블 재사용)
  const att = await env.DB.prepare(`SELECT fails, locked_until FROM pin_attempts WHERE category_id = ? AND ip = ?`).bind(REISSUE_LOCK_KEY, ip).first<{ fails: number; locked_until: string | null }>();
  if (att?.locked_until && att.locked_until > nowStr) {
    const left = Math.max(1, Math.ceil((new Date(att.locked_until).getTime() - now) / 60000));
    throw new HttpError(429, `시도가 너무 많습니다. ${left}분 후 다시 시도하세요`, "locked");
  }
  const users = await env.DB
    .prepare(`SELECT id, name, email, disabled_at FROM users WHERE lower(email) = ? AND disabled_at IS NULL`)
    .bind(email)
    .all<{ id: string; name: string; email: string; disabled_at: string | null }>();
  const norm = (s: string) => s.replace(/\s+/g, "").toLowerCase();
  const u = (users.results ?? []).find((x) => norm(x.name) === norm(name));
  if (!u) {
    const fails = (att?.fails ?? 0) + 1;
    const lock = fails >= REISSUE_MAX_FAILS;
    await env.DB
      .prepare(`INSERT OR REPLACE INTO pin_attempts (category_id, ip, fails, locked_until, updated_at) VALUES (?, ?, ?, ?, ?)`)
      .bind(REISSUE_LOCK_KEY, ip, lock ? 0 : fails, lock ? new Date(now + REISSUE_LOCK_MS).toISOString() : null, nowStr)
      .run();
    if (lock) throw new HttpError(429, `${REISSUE_MAX_FAILS}회 불일치로 10분간 잠겼습니다`, "locked");
    throw new HttpError(404, `이름과 이메일이 일치하는 계정이 없습니다 (남은 시도 ${REISSUE_MAX_FAILS - fails}회). 등록 때 쓴 이름·이메일 그대로 입력하세요. 계정이 없다면 [발급 신청]으로 새로 신청하세요`, "no_match");
  }
  await env.DB.prepare(`DELETE FROM pin_attempts WHERE category_id = ? AND ip = ?`).bind(REISSUE_LOCK_KEY, ip).run();

  if (reissueAuto(env)) {
    // 즉시 발급: 기본으로 기존 토큰을 회수한다 (분실·유출 대응이자, 타인이 몰래 발급받으면 본인이 알아차리게 하는 장치)
    const revokeExisting = input.revoke_existing === undefined || input.revoke_existing === null ? true : bool(input.revoke_existing);
    const recent = await env.DB.prepare(`SELECT COUNT(*) AS n FROM tokens WHERE user_id = ? AND label = '본인 재발급' AND created_at > ?`).bind(u.id, new Date(now - 60 * 60 * 1000).toISOString()).first<{ n: number }>();
    if ((recent?.n ?? 0) >= 3) throw new HttpError(429, "한 시간에 3회까지만 재발급할 수 있습니다. 관리자에게 문의하세요", "too_many");
    let revoked = 0;
    if (revokeExisting) {
      const res = await env.DB.prepare(`UPDATE tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`).bind(nowStr, u.id).run();
      revoked = res.meta.changes ?? 0;
    }
    const systemCtx = { user: { id: u.id, name: u.name }, source: "web" } as AuthContext;
    const t = await issueToken(env, systemCtx, { user_id: u.id, label: "본인 재발급" });
    await logActivity(env, { actor_id: u.id, action: "token.reissue", target_id: u.id, summary: `${u.name} 본인 재발급 ${t.hint}${revoked ? ` (기존 ${revoked}건 회수)` : ""}${note ? ` · ${note.slice(0, 80)}` : ""} · IP ${ip}`, source: "web" });
    return { mode: "auto", token: t.token, hint: t.hint, user_id: u.id, name: u.name, revoked };
  }

  const pending = await env.DB.prepare(`SELECT id FROM signup_requests WHERE status = 'pending' AND kind = 'reissue' AND user_id = ?`).bind(u.id).first();
  if (pending) bad("이미 대기 중인 재발급 요청이 있습니다. 관리자 승인을 기다리거나, 그때 받은 수령 코드로 상태를 확인하세요");
  const claim = newClaimCode();
  const id = newId("req");
  const at = nowIso();
  await env.DB
    .prepare(`INSERT INTO signup_requests (id, name, email, category_id, note, status, claim_hash, claim_hint, user_id, kind, created_at) VALUES (?, ?, ?, NULL, ?, 'pending', ?, ?, ?, 'reissue', ?)`)
    .bind(id, u.name, u.email, note, await sha256Hex(claim), tokenHint(claim), u.id, at)
    .run();
  await logActivity(env, { actor_id: u.id, action: "signup.reissue_request", target_id: id, summary: `${u.name} 토큰 재발급 요청${note ? `: ${note.slice(0, 80)}` : ""}`, source: "web" });
  return { mode: "approval", id, claim_code: claim, status: "pending", name: u.name };
}

/** 신청자 상태 조회 (수령 코드로) */
export async function requestStatus(env: Env, claim: string) {
  const r = await findByClaim(env, claim);
  return {
    id: r.id, name: r.name, status: r.status, kind: r.kind ?? "signup", category_name: r.category_name, created_at: r.created_at,
    decided_at: r.decided_at, decision_note: r.status === "rejected" ? r.decision_note : "", claimed: !!r.claimed_at,
  };
}

/** 승인된 신청의 토큰 수령 (1회) */
export async function claimToken(env: Env, claim: string): Promise<{ token: string; hint: string; user_id: string; name: string }> {
  const r = await findByClaim(env, claim);
  if (r.status === "pending") throw new HttpError(409, "아직 승인 대기 중입니다", "pending");
  if (r.status === "rejected") throw new HttpError(409, `신청이 거절되었습니다${r.decision_note ? `: ${r.decision_note}` : ""}`, "rejected");
  if (r.claimed_at) throw new HttpError(409, "이미 토큰을 수령했습니다. 분실했다면 관리자에게 재발급을 요청하세요", "already_claimed");
  if (!r.user_id) throw new HttpError(500, "승인 데이터가 손상되었습니다 (user_id 없음)", "internal");
  const u = await env.DB.prepare(`SELECT id, name, disabled_at FROM users WHERE id = ?`).bind(r.user_id).first<{ id: string; name: string; disabled_at: string | null }>();
  if (!u || u.disabled_at) throw new HttpError(409, "계정이 비활성화되었습니다. 관리자에게 문의하세요", "disabled");
  // 수령 표시를 먼저 갱신해 이중 수령을 막는다
  const upd = await env.DB.prepare(`UPDATE signup_requests SET claimed_at = ? WHERE id = ? AND claimed_at IS NULL`).bind(nowIso(), r.id).run();
  if (!upd.meta.changes) throw new HttpError(409, "이미 토큰을 수령했습니다", "already_claimed");
  const systemCtx = { user: { id: u.id, name: u.name } } as AuthContext;
  const t = await issueToken(env, systemCtx, { user_id: u.id, label: r.kind === "reissue" ? "재발급 수령" : "가입 승인 수령" });
  await logActivity(env, { actor_id: u.id, action: "signup.claim", target_id: r.id, summary: `${u.name} ${t.hint}`, source: "web" });
  return { token: t.token, hint: t.hint, user_id: u.id, name: u.name };
}

// ---------- 관리자 ----------

export async function listRequests(env: Env, status?: string): Promise<SignupRow[]> {
  const where = status && status !== "all" ? "WHERE r.status = ?" : "";
  const params = status && status !== "all" ? [oneOf(status, ["pending", "approved", "rejected"] as const, "status")] : [];
  const rs = await env.DB
    .prepare(
      `SELECT r.*, c.name AS category_name, u.name AS decided_by_name
       FROM signup_requests r LEFT JOIN categories c ON c.id = r.category_id LEFT JOIN users u ON u.id = r.decided_by
       ${where} ORDER BY CASE r.status WHEN 'pending' THEN 0 ELSE 1 END, r.created_at DESC LIMIT 500`
    )
    .bind(...params)
    .all<SignupRow>();
  return (rs.results ?? []).map((r) => ({ ...r, claim_hash: undefined }) as unknown as SignupRow);
}

export async function approveRequest(env: Env, ctx: AuthContext, id: string, input: { name?: unknown; id?: unknown; email?: unknown; note?: unknown; category_id?: unknown; role?: unknown; decision_note?: unknown; force?: unknown; revoke_existing?: unknown }) {
  const r = await env.DB.prepare(`SELECT * FROM signup_requests WHERE id = ?`).bind(id).first<SignupRow>();
  if (!r) notFound("신청을 찾을 수 없습니다");
  if (r.status !== "pending") bad(`이미 처리된 신청입니다 (${r.status})`);
  if (r.kind === "reissue") {
    // 재발급: 계정을 새로 만들지 않고 승인만. 본인이 수령 코드로 새 토큰을 받는다. 분실·유출이면 기존 토큰 회수 옵션
    if (!r.user_id) bad("재발급 요청에 연결된 계정이 없습니다");
    const u = await env.DB.prepare(`SELECT id, name, disabled_at FROM users WHERE id = ?`).bind(r.user_id).first<{ id: string; name: string; disabled_at: string | null }>();
    if (!u) bad("연결된 계정이 없습니다");
    if (u.disabled_at) bad("비활성화된 계정입니다. 먼저 [연구원] 탭에서 활성화하세요");
    const at = nowIso();
    let revoked = 0;
    if (bool(input.revoke_existing)) {
      const res = await env.DB.prepare(`UPDATE tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`).bind(at, u.id).run();
      revoked = res.meta.changes ?? 0;
    }
    await env.DB
      .prepare(`UPDATE signup_requests SET status = 'approved', decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ?`)
      .bind(ctx.user.id, at, str(input.decision_note, 500), id)
      .run();
    await logActivity(env, { actor_id: ctx.user.id, action: "signup.reissue_approve", target_id: id, summary: `${u.name} 토큰 재발급 승인${revoked ? ` (기존 토큰 ${revoked}건 회수)` : ""}`, source: ctx.source });
    const user = (await listUsers(env)).find((x) => x.id === u.id)!;
    return { request_id: id, user, revoked };
  }
  const categoryId = input.category_id !== undefined ? str(input.category_id, 100) : r.category_id;
  // 같은 이메일의 계정이 이미 있으면 중복 계정이 생기지 않도록 막는다 (force 로 강행 가능)
  const emailToUse = str(input.email !== undefined ? input.email : r.email, 200);
  if (emailToUse && !bool(input.force)) {
    const dupUser = await env.DB.prepare(`SELECT id, name, disabled_at FROM users WHERE email = ?`).bind(emailToUse).first<{ id: string; name: string; disabled_at: string | null }>();
    if (dupUser) throw new HttpError(409, `같은 이메일의 계정이 이미 있습니다: ${dupUser.name} (${dupUser.id}${dupUser.disabled_at ? ", 비활성" : ""}). 중복 신청이면 거절하고, 그 계정의 수령 코드를 재발급하거나 토큰을 직접 발급하세요. 별도 계정이 맞으면 force=true 로 승인`, "duplicate_email");
  }
  const role = input.role === undefined ? "member" : oneOf(input.role, ["lead", "member", "evaluator"] as const, "role");
  const created = await createUser(env, ctx, {
    name: input.name !== undefined ? input.name : r.name,
    id: input.id,
    email: input.email !== undefined ? input.email : r.email,
    note: input.note !== undefined ? input.note : r.note,
    categories: categoryId ? [{ category_id: categoryId, role }] : [],
    issue_token: false,
  });
  const at = nowIso();
  await env.DB
    .prepare(`UPDATE signup_requests SET status = 'approved', user_id = ?, decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ?`)
    .bind(created.user.id, ctx.user.id, at, str(input.decision_note, 500), id)
    .run();
  await logActivity(env, { actor_id: ctx.user.id, category_id: categoryId, action: "signup.approve", target_id: id, summary: `${created.user.name} (${created.user.id})`, source: ctx.source });
  return { request_id: id, user: created.user };
}

export async function rejectRequest(env: Env, ctx: AuthContext, id: string, reason: unknown) {
  const r = await env.DB.prepare(`SELECT * FROM signup_requests WHERE id = ?`).bind(id).first<SignupRow>();
  if (!r) notFound("신청을 찾을 수 없습니다");
  if (r.status !== "pending") bad(`이미 처리된 신청입니다 (${r.status})`);
  await env.DB
    .prepare(`UPDATE signup_requests SET status = 'rejected', decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ?`)
    .bind(ctx.user.id, nowIso(), str(reason, 500), id)
    .run();
  await logActivity(env, { actor_id: ctx.user.id, category_id: r.category_id, action: "signup.reject", target_id: id, summary: `${r.name}${reason ? `: ${str(reason, 120)}` : ""}`, source: ctx.source });
  return { ok: true };
}

/**
 * 수령 코드 재발급 (관리자): 승인된 신청의 수령 코드를 새로 만들고 미수령 상태로 되돌린다.
 * 학생이 수령 코드를 잃어버렸거나, 수령 전에 토큰이 사라졌을 때. 새 코드는 1회만 반환된다.
 * 이미 수령한 뒤 재발급하면 기존 토큰은 그대로 살아 있다 (필요하면 [토큰] 탭에서 회수).
 */
export async function reissueClaim(env: Env, ctx: AuthContext, id: string): Promise<{ request_id: string; claim_code: string; name: string; user_id: string | null; was_claimed: boolean }> {
  const r = await env.DB.prepare(`SELECT * FROM signup_requests WHERE id = ?`).bind(id).first<SignupRow>();
  if (!r) notFound("신청을 찾을 수 없습니다");
  if (r.status !== "approved") bad(`승인된 신청만 재발급할 수 있습니다 (현재 ${r.status})`);
  if (!r.user_id) bad("승인 데이터가 손상되었습니다 (user_id 없음)");
  const u = await env.DB.prepare(`SELECT disabled_at FROM users WHERE id = ?`).bind(r.user_id).first<{ disabled_at: string | null }>();
  if (!u) bad("연결된 사용자가 없습니다");
  if (u.disabled_at) bad("비활성화된 계정입니다. 먼저 [연구원] 탭에서 활성화하세요");
  const claim = newClaimCode();
  await env.DB
    .prepare(`UPDATE signup_requests SET claim_hash = ?, claim_hint = ?, claimed_at = NULL WHERE id = ?`)
    .bind(await sha256Hex(claim), tokenHint(claim), id)
    .run();
  await logActivity(env, { actor_id: ctx.user.id, category_id: r.category_id, action: "signup.reissue", target_id: id, summary: `${r.name} 수령 코드 재발급${r.claimed_at ? " (기존 수령분 있음)" : ""}`, source: ctx.source });
  return { request_id: id, claim_code: claim, name: r.name, user_id: r.user_id, was_claimed: !!r.claimed_at };
}

export async function deleteRequest(env: Env, id: string) {
  const res = await env.DB.prepare(`DELETE FROM signup_requests WHERE id = ? AND status != 'pending'`).bind(id).run();
  if (!res.meta.changes) bad("대기 중인 신청은 삭제할 수 없습니다 (승인 또는 거절 후 삭제)");
  return { ok: true };
}

export async function pendingCount(env: Env): Promise<number> {
  const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM signup_requests WHERE status = 'pending'`).first<{ n: number }>();
  return r?.n ?? 0;
}
