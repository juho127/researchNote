import type { AuthContext, Env, Stage } from "../env";
import { REVIEW_STATUSES, isStage, isStageOf, stageIds, trackOf } from "../env";
import { bad, bool, forbidden, notFound, isDateStr, oneOf, str, strLimited, clampInt } from "../lib/http";
import { weekCfgOf, weekOf } from "../lib/week";
import { newId } from "../lib/id";
import { nowIso, todayIn } from "../lib/time";
import { categoryRole, requireCategoryMember, canReview } from "../lib/auth";
import { getEntry, getProject, getProjectForRead, isCollaborator, logActivity, touchProject, type EntryRow } from "../lib/db";

export interface EntryFull extends EntryRow {
  author_name: string;
  project_title?: string;
  category_id?: string;
  comment_count: number;
  comments?: CommentRow[];
  can_edit?: boolean;
  /** 카테고리 주차 설정 기준 주차 (설정 없으면 null) */
  week?: number | null;
}

export interface CommentRow {
  id: string;
  entry_id: string;
  author_id: string;
  author_name: string;
  content: string;
  kind: string;
  created_at: string;
}

const ENTRY_SELECT = `
  SELECT e.*, u.name AS author_name, p.title AS project_title, p.category_id,
    (SELECT COUNT(*) FROM comments c WHERE c.entry_id = e.id) AS comment_count
  FROM entries e JOIN users u ON u.id = e.author_id JOIN projects p ON p.id = e.project_id`;

export interface EntryListOpts {
  project_id?: string;
  category_id?: string;
  author_id?: string;
  stage?: string;
  since?: string; // YYYY-MM-DD (date >=)
  until?: string; // YYYY-MM-DD (date <=)
  review_status?: string;
  weekly?: boolean; // true 면 주간 보고만
  q?: string;
  limit?: number;
  offset?: number;
  with_content?: boolean;
}

export async function listEntries(env: Env, ctx: AuthContext, opts: EntryListOpts): Promise<EntryFull[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.project_id) {
    await getProjectForRead(env, ctx, opts.project_id);
    where.push("e.project_id = ?");
    params.push(opts.project_id);
  } else if (opts.category_id) {
    requireCategoryMember(ctx, opts.category_id);
    where.push("p.category_id = ?");
    params.push(opts.category_id);
  } else if (!ctx.isAdmin) {
    const ids = ctx.memberships.map((m) => m.category_id);
    if (!ids.length) return [];
    where.push(`p.category_id IN (${ids.map(() => "?").join(",")})`);
    params.push(...ids);
  }
  if (opts.author_id) {
    where.push("e.author_id = ?");
    params.push(opts.author_id);
  }
  if (opts.stage) {
    if (!isStage(opts.stage)) bad("stage 값이 올바르지 않습니다");
    where.push("e.stage = ?");
    params.push(opts.stage);
  }
  if (opts.since) {
    if (!isDateStr(opts.since)) bad("since 는 YYYY-MM-DD 형식");
    where.push("e.date >= ?");
    params.push(opts.since);
  }
  if (opts.until) {
    if (!isDateStr(opts.until)) bad("until 은 YYYY-MM-DD 형식");
    where.push("e.date <= ?");
    params.push(opts.until);
  }
  if (opts.review_status) {
    where.push("e.review_status = ?");
    params.push(oneOf(opts.review_status, REVIEW_STATUSES, "review_status"));
  }
  if (opts.weekly) where.push("e.weekly = 1");
  if (opts.q) {
    // LIKE 패턴 길이 제한(D1)을 피하기 위해 instr 사용
    const needle = str(opts.q, 200).toLowerCase();
    where.push("(instr(lower(e.title), ?) > 0 OR instr(lower(e.content), ?) > 0)");
    params.push(needle, needle);
  }
  const limit = clampInt(opts.limit, 100, 1, 500);
  const offset = clampInt(opts.offset, 0, 0, 100_000);
  params.push(limit, offset);
  const rs = await env.DB
    .prepare(`${ENTRY_SELECT} ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY e.date DESC, e.created_at DESC LIMIT ? OFFSET ?`)
    .bind(...params)
    .all<EntryFull>();
  const rows = rs.results ?? [];
  for (const r of rows) {
    r.can_edit = ctx.isAdmin || r.author_id === ctx.user.id;
    if (opts.with_content === false) r.content = r.content.slice(0, 280);
  }
  await attachWeeks(env, rows);
  return rows;
}

/** 각 기록에 카테고리 주차 설정 기준 week 를 붙인다 (설정 없으면 null) */
async function attachWeeks(env: Env, rows: EntryFull[]): Promise<void> {
  const ids = [...new Set(rows.map((r) => r.category_id).filter((x): x is string => !!x))];
  if (!ids.length) return;
  const rs = await env.DB.prepare(`SELECT id, week_start, week_count, week_due_dow FROM categories WHERE id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all<{ id: string; week_start: string | null; week_count: number; week_due_dow: number }>();
  const cfgs = new Map((rs.results ?? []).map((c) => [c.id, weekCfgOf(c)]));
  for (const r of rows) {
    const cfg = cfgs.get(r.category_id!);
    r.week = cfg ? weekOf(cfg, r.date) : null;
  }
}

export async function getEntryFull(env: Env, ctx: AuthContext, id: string): Promise<EntryFull> {
  const row = await env.DB.prepare(`${ENTRY_SELECT} WHERE e.id = ?`).bind(id).first<EntryFull>();
  if (!row) notFound("기록을 찾을 수 없습니다");
  if (!categoryRole(ctx, row.category_id!)) forbidden("이 기록이 속한 카테고리의 구성원이 아닙니다");
  const cs = await env.DB
    .prepare(`SELECT c.*, u.name AS author_name FROM comments c JOIN users u ON u.id = c.author_id WHERE c.entry_id = ? ORDER BY c.created_at`)
    .bind(id)
    .all<CommentRow>();
  row.comments = cs.results ?? [];
  row.can_edit = ctx.isAdmin || row.author_id === ctx.user.id;
  await attachWeeks(env, [row]);
  return row;
}

export interface EntryInput {
  date?: unknown;
  stage?: unknown;
  title?: unknown;
  content?: unknown;
  review_status?: unknown;
  /** 주간 보고 표시 (캡스톤: 마감 요일 자정까지 주 1건) */
  weekly?: unknown;
}

export async function createEntry(env: Env, ctx: AuthContext, projectId: string, input: EntryInput): Promise<EntryFull> {
  const p = await getProjectForRead(env, ctx, projectId);
  // 기록 작성: 소유자 / 리드 / 관리자. 같은 카테고리 구성원은 코멘트로 참여.
  const role = categoryRole(ctx, p.category_id);
  if (!(role === "admin" || role === "lead" || p.owner_id === ctx.user.id || (await isCollaborator(env, p.id, ctx.user.id)))) forbidden("기록은 프로젝트 담당자·협업자·리드·관리자만 작성할 수 있습니다 (팀원은 코멘트로 참여)");
  if (p.status === "archived") forbidden("보관된 프로젝트에는 기록할 수 없습니다. 먼저 상태를 되돌리세요");
  const title = strLimited(input.title, 200, "title");
  if (!title) bad("title 이 필요합니다");
  const date = input.date === undefined || input.date === null || input.date === "" ? todayIn(env.APP_TZ) : (isDateStr(input.date) ? input.date : bad("date 는 YYYY-MM-DD 형식"));
  let stage: Stage = p.stage;
  if (input.stage !== undefined && input.stage !== null && input.stage !== "") {
    if (!isStageOf(p.track, input.stage)) bad(`stage 값이 올바르지 않습니다 (${trackOf(p.track).label} 트랙: ${stageIds(p.track).join(", ")})`);
    stage = input.stage;
  }
  const content = strLimited(input.content, 200_000, "content");
  const review = input.review_status === undefined || input.review_status === null ? "none" : oneOf(input.review_status, ["none", "requested"] as const, "review_status (생성 시)");
  const weekly = input.weekly === undefined || input.weekly === null ? 0 : bool(input.weekly) ? 1 : 0;
  const id = newId("ent");
  const at = nowIso();
  const source = ctx.source;
  await env.DB
    .prepare(
      `INSERT INTO entries (id, project_id, author_id, date, stage, title, content, source, review_status, weekly, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(id, projectId, ctx.user.id, date, stage, title, content, source, review, weekly, at, at)
    .run();
  // 해당 단계가 todo 였다면 doing 으로
  await env.DB
    .prepare(`UPDATE project_stages SET status = 'doing', updated_at = ?, updated_by = ? WHERE project_id = ? AND stage = ? AND status = 'todo'`)
    .bind(at, ctx.user.id, projectId, stage)
    .run();
  await touchProject(env, projectId);
  await logActivity(env, { actor_id: ctx.user.id, category_id: p.category_id, project_id: projectId, action: "entry.create", target_id: id, summary: `[${date}] ${title}${weekly ? " (주간 보고)" : ""}`, source });
  if (review === "requested") {
    await logActivity(env, { actor_id: ctx.user.id, category_id: p.category_id, project_id: projectId, action: "review.request", target_id: id, summary: title, source });
  }
  return getEntryFull(env, ctx, id);
}

const REVIEW_ACTION: Record<string, string> = { requested: "review.request", approved: "review.approve", changes_requested: "review.changes", none: "review.clear" };

export async function updateEntry(env: Env, ctx: AuthContext, id: string, input: EntryInput): Promise<EntryFull> {
  const e = await getEntry(env, id);
  const p = await getProject(env, e.project_id);
  // 작성자라도 현재 카테고리 구성원이어야 한다 (탈퇴자 차단)
  if (!(ctx.isAdmin || (e.author_id === ctx.user.id && categoryRole(ctx, p.category_id)))) forbidden("기록은 작성자·관리자만 수정할 수 있습니다");
  const sets: string[] = [];
  const params: unknown[] = [];
  let contentChanged = false;
  if (p.status === "archived" && !ctx.isAdmin) forbidden("보관된 프로젝트의 기록은 수정할 수 없습니다");
  if (input.title !== undefined) {
    const t = strLimited(input.title, 200, "title");
    if (!t) bad("title 은 비울 수 없습니다");
    if (t !== e.title) contentChanged = true;
    sets.push("title = ?");
    params.push(t);
  }
  if (input.content !== undefined) {
    const c = strLimited(input.content, 200_000, "content");
    if (c !== e.content) contentChanged = true;
    sets.push("content = ?");
    params.push(c);
  }
  if (input.date !== undefined) {
    if (!isDateStr(input.date)) bad("date 는 YYYY-MM-DD 형식");
    sets.push("date = ?");
    params.push(input.date);
  }
  if (input.stage !== undefined) {
    if (!isStageOf(p.track, input.stage)) bad(`stage 값이 올바르지 않습니다 (${trackOf(p.track).label} 트랙: ${stageIds(p.track).join(", ")})`);
    sets.push("stage = ?");
    params.push(input.stage);
  }
  if (input.weekly !== undefined && input.weekly !== null) {
    sets.push("weekly = ?");
    params.push(bool(input.weekly) ? 1 : 0);
  }
  let reviewChange: string | null = null;
  if (input.review_status !== undefined) {
    const rs = oneOf(input.review_status, REVIEW_STATUSES, "review_status");
    // 작성자는 검토 요청/취소만, 승인·수정요청은 검토자
    if ((rs === "approved" || rs === "changes_requested") && !canReview(ctx, p.category_id)) forbidden("승인·수정요청은 리드·관리자만 가능합니다");
    if (rs !== e.review_status) reviewChange = rs;
  } else if (contentChanged && e.review_status === "approved") {
    // 승인 후 내용이 바뀌면 승인은 무효 — 재검토 필요 상태로 되돌린다
    reviewChange = "none";
  }
  if (reviewChange !== null) {
    sets.push("review_status = ?");
    params.push(reviewChange);
  }
  if (!sets.length) bad("변경할 필드가 없습니다");
  sets.push("updated_at = ?");
  params.push(nowIso(), id);
  await env.DB.prepare(`UPDATE entries SET ${sets.join(", ")} WHERE id = ?`).bind(...params).run();
  await touchProject(env, e.project_id);
  await logActivity(env, { actor_id: ctx.user.id, category_id: p.category_id, project_id: e.project_id, action: "entry.update", target_id: id, summary: str(input.title, 200) || e.title, source: ctx.source });
  if (reviewChange !== null) {
    await logActivity(env, { actor_id: ctx.user.id, category_id: p.category_id, project_id: e.project_id, action: REVIEW_ACTION[reviewChange], target_id: id, summary: input.review_status === undefined ? `${e.title} (수정으로 승인 해제)` : e.title, source: ctx.source });
  }
  return getEntryFull(env, ctx, id);
}

export async function deleteEntry(env: Env, ctx: AuthContext, id: string): Promise<void> {
  const e = await getEntry(env, id);
  const p = await getProject(env, e.project_id);
  if (!(ctx.isAdmin || (e.author_id === ctx.user.id && categoryRole(ctx, p.category_id)))) forbidden("기록은 작성자·관리자만 삭제할 수 있습니다");
  await env.DB.prepare(`DELETE FROM entries WHERE id = ?`).bind(id).run();
  await touchProject(env, e.project_id);
  await logActivity(env, { actor_id: ctx.user.id, category_id: p.category_id, project_id: e.project_id, action: "entry.delete", target_id: id, summary: e.title, source: ctx.source });
}

/** 검토 상태 변경 (검토자: 승인/수정요청, 작성자: 요청/취소) */
export async function setReviewStatus(env: Env, ctx: AuthContext, id: string, status: unknown, note?: unknown): Promise<EntryFull> {
  const e = await getEntry(env, id);
  const p = await getProject(env, e.project_id);
  if (!categoryRole(ctx, p.category_id)) forbidden("이 카테고리의 구성원이 아닙니다");
  const rs = oneOf(status, REVIEW_STATUSES, "status");
  const reviewer = canReview(ctx, p.category_id);
  const author = e.author_id === ctx.user.id;
  if ((rs === "approved" || rs === "changes_requested") && !reviewer) forbidden("승인·수정요청은 리드·관리자만 가능합니다");
  if ((rs === "requested" || rs === "none") && !(author || reviewer)) forbidden("검토 요청은 작성자·리드·관리자만 가능합니다");
  // 작성자는 리드의 판정(승인/수정요청)을 지울 수 없다 — 자기 요청 취소만 가능
  if (rs === "none" && !reviewer && e.review_status !== "requested") forbidden("리드의 검토 판정은 작성자가 해제할 수 없습니다");
  const noteText = str(note, 5000);
  // 같은 상태를 다시 설정하면(코멘트 없이) 중복 코멘트·활동을 만들지 않는다
  if (rs === e.review_status && !noteText) return getEntryFull(env, ctx, id);
  const at = nowIso();
  await env.DB.prepare(`UPDATE entries SET review_status = ?, updated_at = ? WHERE id = ?`).bind(rs, at, id).run();
  if (noteText || ((rs === "approved" || rs === "changes_requested") && rs !== e.review_status)) {
    const kind = rs === "approved" ? "approve" : rs === "changes_requested" ? "request_changes" : "comment";
    await env.DB
      .prepare(`INSERT INTO comments (id, entry_id, author_id, content, kind, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(newId("cmt"), id, ctx.user.id, noteText || (rs === "approved" ? "승인" : "수정 요청"), kind, at)
      .run();
  }
  await touchProject(env, e.project_id);
  const action = rs === "requested" ? "review.request" : rs === "approved" ? "review.approve" : rs === "changes_requested" ? "review.changes" : "review.clear";
  await logActivity(env, { actor_id: ctx.user.id, category_id: p.category_id, project_id: e.project_id, action, target_id: id, summary: e.title, source: ctx.source });
  return getEntryFull(env, ctx, id);
}

export async function addComment(env: Env, ctx: AuthContext, entryId: string, content: unknown, kind: unknown = "comment"): Promise<CommentRow> {
  const e = await getEntry(env, entryId);
  const p = await getProject(env, e.project_id);
  if (!categoryRole(ctx, p.category_id)) forbidden("이 카테고리의 구성원만 코멘트할 수 있습니다");
  const text = strLimited(content, 20_000, "content");
  if (!text) bad("content 가 필요합니다");
  const k = oneOf(kind ?? "comment", ["comment", "approve", "request_changes"] as const, "kind");
  if (k !== "comment" && !canReview(ctx, p.category_id)) forbidden("승인·수정요청은 리드·관리자만 가능합니다");
  const id = newId("cmt");
  const at = nowIso();
  await env.DB.prepare(`INSERT INTO comments (id, entry_id, author_id, content, kind, created_at) VALUES (?, ?, ?, ?, ?, ?)`).bind(id, entryId, ctx.user.id, text, k, at).run();
  if (k === "approve") await env.DB.prepare(`UPDATE entries SET review_status = 'approved', updated_at = ? WHERE id = ?`).bind(at, entryId).run();
  if (k === "request_changes") await env.DB.prepare(`UPDATE entries SET review_status = 'changes_requested', updated_at = ? WHERE id = ?`).bind(at, entryId).run();
  await touchProject(env, e.project_id);
  await logActivity(env, {
    actor_id: ctx.user.id, category_id: p.category_id, project_id: e.project_id,
    action: k === "approve" ? "review.approve" : k === "request_changes" ? "review.changes" : "comment.create",
    target_id: entryId, summary: `${e.title}: ${text.slice(0, 120)}`, source: ctx.source,
  });
  return { id, entry_id: entryId, author_id: ctx.user.id, author_name: ctx.user.name, content: text, kind: k, created_at: at };
}

export async function deleteComment(env: Env, ctx: AuthContext, id: string): Promise<void> {
  const c = await env.DB.prepare(`SELECT * FROM comments WHERE id = ?`).bind(id).first<CommentRow>();
  if (!c) notFound("코멘트를 찾을 수 없습니다");
  const e = await getEntry(env, c.entry_id);
  const p = await getProject(env, e.project_id);
  if (!(ctx.isAdmin || (c.author_id === ctx.user.id && categoryRole(ctx, p.category_id)))) forbidden("코멘트는 작성자·관리자만 삭제할 수 있습니다");
  await env.DB.prepare(`DELETE FROM comments WHERE id = ?`).bind(id).run();
}
