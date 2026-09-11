import type { AuthContext, Env } from "../env";
import { bad, forbidden, notFound, oneOf, str, strLimited, HttpError } from "../lib/http";
import { newId } from "../lib/id";
import { nowIso, daysAgoIso } from "../lib/time";
import { logActivity } from "../lib/db";
import { categoryRole } from "../lib/auth";

export const JOIN_POLICIES = ["open", "approval", "closed"] as const;
export type JoinPolicy = (typeof JOIN_POLICIES)[number];

export interface LobbyTeam {
  id: string;
  name: string;
  description: string;
  join_policy: JoinPolicy;
  track: string;
  /** 공개 열람(핀) 허용 여부 */
  is_public: number;
  member_count: number;
  lead_names: string | null;
  member_names: string | null;
  active_projects: number;
  entries_7d: number;
  last_activity_at: string | null;
  my_role: "admin" | "lead" | "member" | "evaluator" | "viewer" | null;
  /** 실제 구성원 행의 역할 (관리자는 접근 권한과 별개로 구성원 목록에 올라 있는지 구분) */
  my_membership: "lead" | "member" | "evaluator" | null;
  my_request_status: "pending" | "rejected" | null;
  my_request_id: string | null;
}

/** 로비: 활성 팀 전체 + 나의 관계 */
export async function lobby(env: Env, ctx: AuthContext): Promise<LobbyTeam[]> {
  const rs = await env.DB
    .prepare(
      `SELECT c.id, c.name, c.description, c.join_policy, c.track, (c.is_public = 1 AND c.pin_hash IS NOT NULL) AS is_public,
         (SELECT COUNT(*) FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.category_id = c.id AND u.disabled_at IS NULL) AS member_count,
         (SELECT GROUP_CONCAT(u.name, ', ') FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.category_id = c.id AND m.role = 'lead' AND u.disabled_at IS NULL) AS lead_names,
         (SELECT GROUP_CONCAT(u.name, ', ') FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.category_id = c.id AND u.disabled_at IS NULL) AS member_names,
         (SELECT COUNT(*) FROM projects p WHERE p.category_id = c.id AND p.status = 'active') AS active_projects,
         (SELECT COUNT(*) FROM entries e JOIN projects p ON p.id = e.project_id WHERE p.category_id = c.id AND e.created_at >= ?) AS entries_7d,
         (SELECT MAX(a.at) FROM activity a WHERE a.category_id = c.id) AS last_activity_at,
         (SELECT r.status FROM join_requests r WHERE r.category_id = c.id AND r.user_id = ? AND r.status IN ('pending','rejected') ORDER BY r.created_at DESC LIMIT 1) AS my_request_status,
         (SELECT r.id FROM join_requests r WHERE r.category_id = c.id AND r.user_id = ? AND r.status IN ('pending','rejected') ORDER BY r.created_at DESC LIMIT 1) AS my_request_id
       FROM categories c WHERE c.archived_at IS NULL ORDER BY c.name`
    )
    .bind(daysAgoIso(7), ctx.user.id, ctx.user.id)
    .all<LobbyTeam>();
  return (rs.results ?? [])
    // 핀 열람자는 다른 팀의 존재를 알 필요가 없다
    .filter((t) => !ctx.viewer || t.id === ctx.viewer.category_id)
    .map((t) => ({ ...t, my_role: categoryRole(ctx, t.id), my_membership: (ctx.memberships.find((m) => m.category_id === t.id)?.role as LobbyTeam["my_membership"]) ?? null }));
}

/** 가입 (정책에 따라 즉시 가입 또는 요청 생성). 관리자는 항상 즉시 가입하며 role(기본 lead)을 고를 수 있다 */
export async function joinTeam(env: Env, ctx: AuthContext, categoryId: string, message: unknown, role?: unknown) {
  const c = await env.DB.prepare(`SELECT id, name, join_policy FROM categories WHERE id = ? AND archived_at IS NULL`).bind(categoryId).first<{ id: string; name: string; join_policy: JoinPolicy }>();
  if (!c) notFound("팀을 찾을 수 없습니다");
  if (ctx.memberships.some((m) => m.category_id === categoryId)) bad("이미 이 팀의 구성원입니다");
  const msg = strLimited(message, 500, "message");
  const at = nowIso();
  if (c.join_policy === "closed" && !ctx.isAdmin) throw new HttpError(403, "이 팀은 초대로만 가입할 수 있습니다. 리드나 관리자에게 요청하세요", "closed");
  if (c.join_policy === "open" || ctx.isAdmin) {
    const memberRole = ctx.isAdmin ? oneOf(role ?? "lead", ["lead", "member"] as const, "role") : "member";
    await env.DB.prepare(`INSERT OR REPLACE INTO memberships (user_id, category_id, role, created_at) VALUES (?, ?, ?, ?)`).bind(ctx.user.id, categoryId, memberRole, at).run();
    await env.DB.prepare(`UPDATE join_requests SET status = 'approved', decided_at = ?, decided_by = ? WHERE user_id = ? AND category_id = ? AND status = 'pending'`).bind(at, ctx.user.id, ctx.user.id, categoryId).run();
    await logActivity(env, { actor_id: ctx.user.id, category_id: categoryId, action: "team.join", target_id: ctx.user.id, summary: `${ctx.user.name} 가입 (${c.name}${memberRole === "lead" ? ", 리드" : ""})`, source: ctx.source });
    return { joined: true, pending: false, role: memberRole, category_id: categoryId, category_name: c.name };
  }
  const existing = await env.DB.prepare(`SELECT id FROM join_requests WHERE user_id = ? AND category_id = ? AND status = 'pending'`).bind(ctx.user.id, categoryId).first();
  if (existing) bad("이미 가입 요청이 대기 중입니다");
  const id = newId("jr");
  await env.DB.prepare(`INSERT INTO join_requests (id, user_id, category_id, message, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)`).bind(id, ctx.user.id, categoryId, msg, at).run();
  await logActivity(env, { actor_id: ctx.user.id, category_id: categoryId, action: "team.join_request", target_id: id, summary: `${ctx.user.name} 가입 요청 (${c.name})${msg ? `: ${msg.slice(0, 80)}` : ""}`, source: ctx.source });
  return { joined: false, pending: true, request_id: id, category_id: categoryId, category_name: c.name };
}

/** 가입 요청 취소 또는 팀 탈퇴 */
export async function leaveTeam(env: Env, ctx: AuthContext, categoryId: string) {
  const at = nowIso();
  const pending = await env.DB.prepare(`SELECT id FROM join_requests WHERE user_id = ? AND category_id = ? AND status = 'pending'`).bind(ctx.user.id, categoryId).first<{ id: string }>();
  if (pending) {
    await env.DB.prepare(`UPDATE join_requests SET status = 'cancelled', decided_at = ? WHERE id = ?`).bind(at, pending.id).run();
    return { cancelled: true };
  }
  const m = ctx.memberships.find((x) => x.category_id === categoryId);
  if (!m) bad("이 팀의 구성원이 아닙니다");
  const active = await env.DB.prepare(`SELECT COUNT(*) AS n FROM projects WHERE owner_id = ? AND category_id = ? AND status IN ('active','paused')`).bind(ctx.user.id, categoryId).first<{ n: number }>();
  if ((active?.n ?? 0) > 0) bad(`이 팀에 진행 중인 내 프로젝트가 ${active!.n}건 있습니다. 완료·보관하거나 담당자를 바꾼 뒤 탈퇴하세요`);
  if (m.role === "lead") {
    const leads = await env.DB.prepare(`SELECT COUNT(*) AS n FROM memberships WHERE category_id = ? AND role = 'lead'`).bind(categoryId).first<{ n: number }>();
    if ((leads?.n ?? 0) <= 1) bad("유일한 리드는 탈퇴할 수 없습니다. 관리자에게 리드 변경을 요청하세요");
  }
  await env.DB.prepare(`DELETE FROM memberships WHERE user_id = ? AND category_id = ?`).bind(ctx.user.id, categoryId).run();
  await logActivity(env, { actor_id: ctx.user.id, category_id: categoryId, action: "team.leave", target_id: ctx.user.id, summary: `${ctx.user.name} 탈퇴`, source: ctx.source });
  return { left: true };
}

export interface JoinRequestRow {
  id: string;
  user_id: string;
  user_name: string;
  user_email: string;
  category_id: string;
  category_name: string;
  message: string;
  status: string;
  decided_by: string | null;
  decided_by_name: string | null;
  decided_at: string | null;
  decision_note: string;
  created_at: string;
}

const JR_SELECT = `SELECT r.*, u.name AS user_name, u.email AS user_email, c.name AS category_name, d.name AS decided_by_name
  FROM join_requests r JOIN users u ON u.id = r.user_id JOIN categories c ON c.id = r.category_id LEFT JOIN users d ON d.id = r.decided_by`;

/** 팀 가입 요청 목록: 리드/관리자 (categoryId 지정) 또는 관리자 전체 */
export async function listJoinRequests(env: Env, ctx: AuthContext, opts: { category_id?: string; status?: string }): Promise<JoinRequestRow[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.category_id) {
    const r = categoryRole(ctx, opts.category_id);
    if (r !== "admin" && r !== "lead") forbidden("리드·관리자만 가입 요청을 볼 수 있습니다");
    where.push("r.category_id = ?");
    params.push(opts.category_id);
  } else if (!ctx.isAdmin) {
    const leadCats = ctx.memberships.filter((m) => m.role === "lead").map((m) => m.category_id);
    if (!leadCats.length) return [];
    where.push(`r.category_id IN (${leadCats.map(() => "?").join(",")})`);
    params.push(...leadCats);
  }
  const status = opts.status || "pending";
  if (status !== "all") {
    where.push("r.status = ?");
    params.push(oneOf(status, ["pending", "approved", "rejected", "cancelled"] as const, "status"));
  }
  const rs = await env.DB.prepare(`${JR_SELECT} ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY CASE r.status WHEN 'pending' THEN 0 ELSE 1 END, r.created_at DESC LIMIT 500`).bind(...params).all<JoinRequestRow>();
  return rs.results ?? [];
}

async function loadRequest(env: Env, id: string): Promise<JoinRequestRow> {
  const r = await env.DB.prepare(`${JR_SELECT} WHERE r.id = ?`).bind(id).first<JoinRequestRow>();
  if (!r) notFound("가입 요청을 찾을 수 없습니다");
  return r;
}

export async function decideJoinRequest(env: Env, ctx: AuthContext, id: string, approve: boolean, note: unknown, role: unknown = "member") {
  const r = await loadRequest(env, id);
  const myRole = categoryRole(ctx, r.category_id);
  if (myRole !== "admin" && myRole !== "lead") forbidden("리드·관리자만 가입 요청을 처리할 수 있습니다");
  if (r.status !== "pending") bad(`이미 처리된 요청입니다 (${r.status})`);
  const at = nowIso();
  if (approve) {
    const memberRole = oneOf(role ?? "member", ["lead", "member", "evaluator"] as const, "role");
    await env.DB.batch([
      env.DB.prepare(`INSERT OR REPLACE INTO memberships (user_id, category_id, role, created_at) VALUES (?, ?, ?, ?)`).bind(r.user_id, r.category_id, memberRole, at),
      env.DB.prepare(`UPDATE join_requests SET status = 'approved', decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ?`).bind(ctx.user.id, at, str(note, 500), id),
    ]);
    await logActivity(env, { actor_id: ctx.user.id, category_id: r.category_id, action: "team.join_approve", target_id: r.user_id, summary: `${r.user_name} 가입 승인 (${memberRole})`, source: ctx.source });
  } else {
    await env.DB.prepare(`UPDATE join_requests SET status = 'rejected', decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ?`).bind(ctx.user.id, at, str(note, 500), id).run();
    await logActivity(env, { actor_id: ctx.user.id, category_id: r.category_id, action: "team.join_reject", target_id: r.user_id, summary: `${r.user_name} 가입 거절${note ? `: ${str(note, 80)}` : ""}`, source: ctx.source });
  }
  return loadRequest(env, id);
}

export async function pendingJoinCount(env: Env, ctx: AuthContext): Promise<number> {
  if (ctx.isAdmin) {
    const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM join_requests WHERE status = 'pending'`).first<{ n: number }>();
    return r?.n ?? 0;
  }
  const leadCats = ctx.memberships.filter((m) => m.role === "lead").map((m) => m.category_id);
  if (!leadCats.length) return 0;
  const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM join_requests WHERE status = 'pending' AND category_id IN (${leadCats.map(() => "?").join(",")})`).bind(...leadCats).first<{ n: number }>();
  return r?.n ?? 0;
}
