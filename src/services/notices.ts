import type { AuthContext, Env } from "../env";
import { categoryRole, requireCategoryMember, requireWriter } from "../lib/auth";
import { logActivity } from "../lib/db";
import { newId } from "../lib/id";
import { bad, bool, clampInt, forbidden, notFound, str, strLimited } from "../lib/http";
import { nowIso } from "../lib/time";

export interface NoticeRow {
  id: string;
  category_id: string | null;
  author_id: string;
  title: string;
  content: string;
  pinned: number;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface Notice extends NoticeRow {
  author_name: string;
  category_name: string | null;
  /** 현재 사용자가 수정·내릴 수 있는가 */
  can_edit: boolean;
}

const MAX_TITLE = 200;
const MAX_CONTENT = 60_000;

/** 공지 작성·수정 권한: 전체 공지는 관리자, 팀 공지는 관리자 또는 해당 팀 리드 */
function canManage(ctx: AuthContext, categoryId: string | null): boolean {
  if (ctx.viewer) return false;
  if (ctx.isAdmin) return true;
  if (!categoryId) return false;
  return categoryRole(ctx, categoryId) === "lead";
}

function shape(ctx: AuthContext, r: NoticeRow & { author_name: string; category_name: string | null }): Notice {
  return { ...r, pinned: r.pinned ? 1 : 0, can_edit: canManage(ctx, r.category_id) };
}

const SELECT = `SELECT n.*, u.name AS author_name, c.name AS category_name
                  FROM notices n JOIN users u ON u.id = n.author_id LEFT JOIN categories c ON c.id = n.category_id`;

async function getRow(env: Env, id: string) {
  const r = await env.DB.prepare(`${SELECT} WHERE n.id = ?`).bind(id).first<NoticeRow & { author_name: string; category_name: string | null }>();
  if (!r) notFound("공지를 찾을 수 없습니다");
  return r;
}

/**
 * 공지 목록. category_id 를 주면 그 팀 공지 + 전체 공지, 없으면 전체 공지 + 소속 팀 전체의 공지.
 * 고정(pinned) 먼저, 그 다음 최신순.
 */
export async function listNotices(env: Env, ctx: AuthContext, opts: { category_id?: string; limit?: unknown; include_archived?: boolean } = {}): Promise<Notice[]> {
  const lim = clampInt(opts.limit, 50, 1, 200);
  const archived = opts.include_archived ? "" : "AND n.archived_at IS NULL";
  let where: string;
  const binds: unknown[] = [];
  if (opts.category_id) {
    requireCategoryMember(ctx, opts.category_id);
    where = `(n.category_id IS NULL OR n.category_id = ?)`;
    binds.push(opts.category_id);
  } else if (ctx.isAdmin) {
    where = `1 = 1`;
  } else {
    const ids = ctx.memberships.map((m) => m.category_id);
    where = ids.length ? `(n.category_id IS NULL OR n.category_id IN (${ids.map(() => "?").join(",")}))` : `n.category_id IS NULL`;
    binds.push(...ids);
  }
  const rs = await env.DB
    .prepare(`${SELECT} WHERE ${where} ${archived} AND (c.id IS NULL OR c.archived_at IS NULL) ORDER BY n.pinned DESC, n.created_at DESC LIMIT ?`)
    .bind(...binds, lim)
    .all<NoticeRow & { author_name: string; category_name: string | null }>();
  // 내려간 공지는 관리 권한이 있는 사람에게만 보인다
  return (rs.results ?? []).map((r) => shape(ctx, r)).filter((n) => !n.archived_at || n.can_edit);
}

export async function getNotice(env: Env, ctx: AuthContext, id: string): Promise<Notice> {
  const r = await getRow(env, id);
  if (r.category_id) requireCategoryMember(ctx, r.category_id);
  if (r.archived_at && !canManage(ctx, r.category_id)) notFound("내려간 공지입니다");
  return shape(ctx, r);
}

export async function createNotice(env: Env, ctx: AuthContext, body: Record<string, unknown>): Promise<Notice> {
  requireWriter(ctx);
  const categoryId = body.category_id === undefined || body.category_id === null || body.category_id === "" ? null : str(body.category_id, 100);
  if (categoryId) {
    const c = await env.DB.prepare(`SELECT id FROM categories WHERE id = ? AND archived_at IS NULL`).bind(categoryId).first();
    if (!c) notFound("카테고리를 찾을 수 없습니다");
  }
  if (!canManage(ctx, categoryId)) forbidden(categoryId ? "팀 공지는 관리자 또는 그 팀의 리드만 올릴 수 있습니다" : "전체 공지는 관리자만 올릴 수 있습니다");
  const title = strLimited(body.title, MAX_TITLE, "제목");
  if (!title) bad("제목을 입력하세요");
  const content = strLimited(body.content, MAX_CONTENT, "본문");
  const id = newId("ntc");
  const at = nowIso();
  await env.DB
    .prepare(`INSERT INTO notices (id, category_id, author_id, title, content, pinned, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, categoryId, ctx.user.id, title, content, bool(body.pinned) ? 1 : 0, at, at)
    .run();
  await logActivity(env, { actor_id: ctx.user.id, category_id: categoryId, action: "notice.create", target_id: id, summary: title, source: ctx.source });
  return getNotice(env, ctx, id);
}

export async function updateNotice(env: Env, ctx: AuthContext, id: string, body: Record<string, unknown>): Promise<Notice> {
  requireWriter(ctx);
  const r = await getRow(env, id);
  if (!canManage(ctx, r.category_id)) forbidden("이 공지를 수정할 권한이 없습니다");
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (body.title !== undefined) {
    const t = strLimited(body.title, MAX_TITLE, "제목");
    if (!t) bad("제목을 입력하세요");
    sets.push("title = ?"); binds.push(t);
  }
  if (body.content !== undefined) { sets.push("content = ?"); binds.push(strLimited(body.content, MAX_CONTENT, "본문")); }
  if (body.pinned !== undefined) { sets.push("pinned = ?"); binds.push(bool(body.pinned) ? 1 : 0); }
  if (body.archived !== undefined) { sets.push("archived_at = ?"); binds.push(bool(body.archived) ? nowIso() : null); }
  if (!sets.length) bad("변경할 필드가 없습니다");
  sets.push("updated_at = ?"); binds.push(nowIso());
  await env.DB.prepare(`UPDATE notices SET ${sets.join(", ")} WHERE id = ?`).bind(...binds, id).run();
  const action = body.archived !== undefined ? (bool(body.archived) ? "notice.archive" : "notice.restore") : "notice.update";
  await logActivity(env, { actor_id: ctx.user.id, category_id: r.category_id, action, target_id: id, summary: (body.title !== undefined ? String(body.title) : r.title).slice(0, 200), source: ctx.source });
  return getNotice(env, ctx, id);
}

/** 내리기 (소프트 삭제). 되살리려면 updateNotice archived=false */
export async function archiveNotice(env: Env, ctx: AuthContext, id: string): Promise<void> {
  await updateNotice(env, ctx, id, { archived: true });
}

/** MCP 용 마크다운 */
export function noticesMarkdown(rows: Notice[]): string {
  if (!rows.length) return "공지 없음";
  return rows
    .map((n) => {
      const head = `## ${n.pinned ? "📌 " : ""}${n.title}\n_${n.category_name ?? "전체 공지"} · ${n.author_name} · ${n.created_at.slice(0, 10)}${n.updated_at !== n.created_at ? ` (수정 ${n.updated_at.slice(0, 10)})` : ""} · ${n.id}_`;
      return n.content.trim() ? `${head}\n\n${n.content.trim()}` : head;
    })
    .join("\n\n---\n\n");
}
