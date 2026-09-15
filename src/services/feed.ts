import type { AuthContext, Env } from "../env";
import { TRACKS, DEFAULT_TRACK } from "../env";
import { requireCategoryMember } from "../lib/auth";
import { clampInt, str, notFound } from "../lib/http";
import { daysAgoIso } from "../lib/time";
import { listActivity } from "./admin";
import { listProjects } from "./projects";
import { listEntries } from "./entries";
import { pendingJoinCount } from "./teams";
import { shapeCategory } from "./admin";

/** /api/me — 로그인 사용자 요약 */
export async function me(env: Env, ctx: AuthContext) {
  let tokenHint: string | null = null;
  if (ctx.tokenId) {
    const t = await env.DB.prepare(`SELECT hint, label, created_at, last_used_at FROM tokens WHERE id = ?`).bind(ctx.tokenId).first<{ hint: string; label: string; created_at: string; last_used_at: string | null }>();
    tokenHint = t?.hint ?? null;
  }
  const projects = ctx.viewer ? [] : await listProjects(env, ctx, { owner_id: ctx.user.id, status: "all", limit: 100 });
  const pendingJoins = ctx.viewer ? 0 : await pendingJoinCount(env, ctx);
  return {
    pending_joins: pendingJoins,
    user: { id: ctx.user.id, name: ctx.user.name, email: ctx.user.email, role: ctx.user.role, created_at: ctx.user.created_at },
    is_admin: ctx.isAdmin,
    /** 핀 열람 모드면 {category_id, category_name, expires_at} (읽기 전용) */
    viewer: ctx.viewer ? { category_id: ctx.viewer.category_id, category_name: ctx.viewer.category_name, expires_at: ctx.viewer.expires_at } : null,
    bootstrap: ctx.tokenId === null && !ctx.viewer,
    token_hint: tokenHint,
    memberships: ctx.memberships,
    my_projects: projects.filter((p) => p.status !== "archived"),
    // 하위 호환: stages = 기본(논문) 트랙. 트랙별 단계·루브릭은 tracks 참고
    stages: TRACKS[DEFAULT_TRACK].stages.map((s) => ({ id: s.id, label: s.label, hint: s.hint })),
    tracks: Object.fromEntries(Object.values(TRACKS).map((t) => [t.id, { id: t.id, label: t.label, noun: t.noun, description: t.description, stages: t.stages, rubric: t.rubric, reports: t.reports ?? [] }])),
    app: { name: env.APP_NAME, org: env.ORG_NAME, org_sub: env.ORG_SUB, mark: env.ORG_MARK, tz: env.APP_TZ },
  };
}

/** 카테고리 상세 (구성원 · 프로젝트 · 최근 활동) */
export async function categoryDetail(env: Env, ctx: AuthContext, categoryId: string) {
  requireCategoryMember(ctx, categoryId);
  const catRaw = await env.DB.prepare(`SELECT * FROM categories WHERE id = ?`).bind(categoryId).first<{ id: string; name: string; description: string; track: string; join_policy: string; pin_hash?: string | null; is_public?: number }>();
  if (!catRaw) notFound("카테고리를 찾을 수 없습니다");
  const cat = shapeCategory(catRaw);
  const members = await env.DB
    .prepare(
      `SELECT u.id, u.name, u.email, m.role, u.last_seen_at,
         (SELECT COUNT(*) FROM projects p WHERE p.owner_id = u.id AND p.category_id = m.category_id AND p.status = 'active') AS active_projects,
         (SELECT COUNT(*) FROM entries e JOIN projects p ON p.id = e.project_id WHERE e.author_id = u.id AND p.category_id = m.category_id AND e.created_at >= ?) AS entries_7d,
         (SELECT MAX(e.created_at) FROM entries e JOIN projects p ON p.id = e.project_id WHERE e.author_id = u.id AND p.category_id = m.category_id) AS last_entry_at
       FROM memberships m JOIN users u ON u.id = m.user_id
       WHERE m.category_id = ? AND u.disabled_at IS NULL ORDER BY m.role = 'lead' DESC, u.name`
    )
    .bind(daysAgoIso(7), categoryId)
    .all();
  const [projects, activity, reviewQueue] = await Promise.all([
    listProjects(env, ctx, { category_id: categoryId, status: "all", limit: 300 }),
    listActivity(env, { category_id: categoryId, limit: 40 }),
    listEntries(env, ctx, { category_id: categoryId, review_status: "requested", limit: 50, with_content: false }),
  ]);
  const myRole = requireCategoryMember(ctx, categoryId);
  let joinRequests: unknown[] = [];
  if (myRole === "admin" || myRole === "lead") {
    const jr = await env.DB.prepare(`SELECT r.id, r.user_id, u.name AS user_name, u.email AS user_email, r.message, r.created_at FROM join_requests r JOIN users u ON u.id = r.user_id WHERE r.category_id = ? AND r.status = 'pending' ORDER BY r.created_at`).bind(categoryId).all();
    joinRequests = jr.results ?? [];
  }
  // 핀 열람자에게는 구성원 이메일을 보여주지 않는다
  const memberRows = (members.results ?? []).map((m) => (ctx.viewer ? { ...(m as Record<string, unknown>), email: "" } : m));
  return { category: cat, members: memberRows, projects, activity, review_queue: reviewQueue, my_role: myRole, join_requests: joinRequests };
}

/** 팀 활동 피드 (소속 카테고리 전체 또는 지정 카테고리) */
export async function feed(env: Env, ctx: AuthContext, opts: { category_id?: string; project_id?: string; limit?: unknown; before?: unknown }) {
  if (opts.category_id) requireCategoryMember(ctx, opts.category_id);
  const ids = ctx.isAdmin ? undefined : ctx.memberships.map((m) => m.category_id);
  return listActivity(env, {
    category_id: opts.category_id,
    project_id: opts.project_id,
    category_ids: opts.category_id ? undefined : ids,
    limit: opts.limit,
    before: opts.before,
  });
}

/** 통합 검색: 프로젝트 + 기록 */
export async function search(env: Env, ctx: AuthContext, q: unknown, categoryId?: string, limit?: unknown) {
  const query = str(q, 200);
  if (!query) return { projects: [], entries: [] };
  const lim = clampInt(limit, 20, 1, 100);
  const [projects, entries] = await Promise.all([
    listProjects(env, ctx, { category_id: categoryId, q: query, status: "all", limit: lim }),
    listEntries(env, ctx, { category_id: categoryId, q: query, limit: lim, with_content: false }),
  ]);
  return { projects, entries };
}
