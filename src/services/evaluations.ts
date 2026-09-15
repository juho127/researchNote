import type { AuthContext, Env } from "../env";
import { trackOf, isStageOf, stageIds, reportsOf, STAGE_LABELS } from "../env";
import { bad, forbidden, notFound, strLimited, str, bool } from "../lib/http";
import { newId } from "../lib/id";
import { nowIso } from "../lib/time";
import { canEvaluate, categoryRole } from "../lib/auth";
import { getProjectForRead, isCollaborator, logActivity, touchProject, type ProjectRow } from "../lib/db";

export interface EvaluationRow {
  id: string;
  project_id: string;
  stage: string;
  evaluator_id: string;
  evaluator_name: string;
  title: string;
  scores: Record<string, number>;
  total: number | null;
  max_total: number;
  feedback: string;
  response: string;
  response_by: string | null;
  response_by_name: string | null;
  response_at: string | null;
  visible: boolean;
  /** 제출물 평가면 제출물 ID·마일스톤 */
  submission_id: string | null;
  milestone: string | null;
  created_at: string;
  updated_at: string;
  can_edit: boolean;
  can_respond: boolean;
}

export interface RawEvaluationRow {
  id: string; project_id: string; stage: string; evaluator_id: string; evaluator_name: string; title: string; scores: string; total: number | null;
  feedback: string; response: string; response_by: string | null; response_by_name: string | null; response_at: string | null; visible: number;
  submission_id: string | null; milestone: string | null; created_at: string; updated_at: string;
}
type RawRow = RawEvaluationRow;

export const EVAL_SELECT = `SELECT e.*, u.name AS evaluator_name, r.name AS response_by_name
  FROM evaluations e JOIN users u ON u.id = e.evaluator_id LEFT JOIN users r ON r.id = e.response_by`;

function maxTotal(track: string): number {
  return trackOf(track).rubric.reduce((a, x) => a + x.max, 0);
}

export async function canRespond(env: Env, ctx: AuthContext, p: ProjectRow): Promise<boolean> {
  const role = categoryRole(ctx, p.category_id);
  if (role === "admin" || role === "lead") return true;
  if (!role) return false;
  return p.owner_id === ctx.user.id || (await isCollaborator(env, p.id, ctx.user.id));
}

export function shapeEvaluation(raw: RawRow, p: ProjectRow, ctx: AuthContext, responder: boolean): EvaluationRow {
  let scores: Record<string, number> = {};
  try { scores = JSON.parse(raw.scores || "{}"); } catch { scores = {}; }
  return {
    ...raw,
    scores,
    visible: !!raw.visible,
    max_total: maxTotal(p.track),
    can_edit: ctx.isAdmin || raw.evaluator_id === ctx.user.id,
    can_respond: responder,
  };
}

/** 프로젝트의 평가 목록 (초안은 평가자·리드·관리자만) */
export async function listEvaluations(env: Env, ctx: AuthContext, projectId: string): Promise<{ evaluations: EvaluationRow[]; rubric: ReturnType<typeof trackOf>["rubric"]; summary: Record<string, { count: number; avg_total: number | null }> }> {
  const p = await getProjectForRead(env, ctx, projectId);
  const rs = await env.DB.prepare(`${EVAL_SELECT} WHERE e.project_id = ? ORDER BY e.created_at`).bind(projectId).all<RawRow>();
  const responder = await canRespond(env, ctx, p);
  const role = categoryRole(ctx, p.category_id);
  const isLead = ctx.isAdmin || role === "admin" || role === "lead";
  // 캡스톤은 블라인드: 평가자는 자기 평가만, 학생은 공개된 평가만(평가자 이름 익명). 논문 트랙은 기존대로.
  const blind = p.track === "capstone";
  let raws = rs.results ?? [];
  if (!isLead) {
    if (blind) raws = role === "evaluator" ? raws.filter((r) => r.evaluator_id === ctx.user.id) : raws.filter((r) => r.visible);
    else raws = raws.filter((r) => r.visible || canEvaluate(ctx, p.category_id));
  }
  const rows = raws.map((r) => shapeEvaluation(r, p, ctx, responder));
  if (blind && !isLead && role !== "evaluator") anonymizeRows(rows);
  const summary: Record<string, { count: number; avg_total: number | null }> = {};
  for (const s of stageIds(p.track)) {
    const of = rows.filter((r) => r.stage === s && r.visible && r.total !== null);
    summary[s] = { count: rows.filter((r) => r.stage === s && r.visible).length, avg_total: of.length ? Math.round((of.reduce((a, r) => a + (r.total ?? 0), 0) / of.length) * 10) / 10 : null };
  }
  return { evaluations: rows, rubric: trackOf(p.track).rubric, summary };
}

/** 학생에게 평가자 이름을 숨긴다 ('평가자 N', 같은 평가자는 같은 번호) */
export function anonymizeRows(rows: { evaluator_id: string; evaluator_name: string }[]): void {
  const idx = new Map<string, number>();
  for (const r of rows) {
    if (!idx.has(r.evaluator_id)) idx.set(r.evaluator_id, idx.size + 1);
    r.evaluator_name = `평가자 ${idx.get(r.evaluator_id)}`;
    r.evaluator_id = "";
  }
}

export interface EvaluationInput {
  stage?: unknown;
  /** 제출물 평가: 제출물 ID (마일스톤·단계는 제출물에서 정해짐, 초안으로 저장) */
  submission_id?: unknown;
  title?: unknown;
  scores?: unknown;
  feedback?: unknown;
  visible?: unknown;
}

function normScores(track: string, v: unknown): { scores: Record<string, number>; total: number | null } {
  const rubric = trackOf(track).rubric;
  if (v === undefined || v === null) return { scores: {}, total: null };
  if (typeof v !== "object" || Array.isArray(v)) bad("scores 는 {축id: 점수} 객체여야 합니다");
  const out: Record<string, number> = {};
  let any = false;
  for (const ax of rubric) {
    const raw = (v as Record<string, unknown>)[ax.id];
    if (raw === undefined || raw === null || raw === "") continue;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0 || n > ax.max) bad(`${ax.label} 점수는 0~${ax.max} 사이여야 합니다`);
    out[ax.id] = Math.round(n * 10) / 10;
    any = true;
  }
  const unknown = Object.keys(v as object).filter((k) => !rubric.some((ax) => ax.id === k));
  if (unknown.length) bad(`알 수 없는 평가 축: ${unknown.join(", ")} (허용: ${rubric.map((a) => a.id).join(", ")})`);
  return { scores: out, total: any ? Math.round(Object.values(out).reduce((a, b) => a + b, 0) * 10) / 10 : null };
}

export async function createEvaluation(env: Env, ctx: AuthContext, projectId: string, input: EvaluationInput): Promise<EvaluationRow> {
  const p = await getProjectForRead(env, ctx, projectId);
  if (!canEvaluate(ctx, p.category_id)) forbidden("평가는 리드·평가자·관리자만 작성할 수 있습니다");
  const role = categoryRole(ctx, p.category_id);
  const isLead = ctx.isAdmin || role === "admin" || role === "lead";
  let stage: string = input.stage === undefined || input.stage === null || input.stage === "" ? p.stage : String(input.stage);
  let milestone: string | null = null;
  let submissionId: string | null = null;
  let defaultTitle = "";
  if (input.submission_id !== undefined && input.submission_id !== null && input.submission_id !== "") {
    const sid = str(input.submission_id, 60);
    const sub = await env.DB.prepare(`SELECT id, project_id, milestone, version FROM submissions WHERE id = ?`).bind(sid).first<{ id: string; project_id: string; milestone: string; version: number }>();
    if (!sub || sub.project_id !== projectId) bad("submission_id 가 이 프로젝트의 제출물이 아닙니다");
    const rep = reportsOf(p.track).find((r) => r.id === sub!.milestone);
    if (!rep) bad("제출물의 마일스톤이 트랙 설정에 없습니다");
    milestone = rep!.id;
    submissionId = sub!.id;
    stage = rep!.stage;
    defaultTitle = `${rep!.label} 평가 (v${sub!.version})`;
    // 같은 평가자가 같은 제출물을 다시 평가하면 갱신
    const prev = await env.DB.prepare(`SELECT id FROM evaluations WHERE submission_id = ? AND evaluator_id = ?`).bind(sub!.id, ctx.user.id).first<{ id: string }>();
    if (prev) return updateEvaluation(env, ctx, prev.id, { title: input.title, scores: input.scores, feedback: input.feedback });
  }
  if (!isStageOf(p.track, stage)) bad(`stage 값이 올바르지 않습니다 (${trackOf(p.track).label} 트랙: ${stageIds(p.track).join(", ")})`);
  const { scores, total } = normScores(p.track, input.scores);
  const feedback = strLimited(input.feedback, 50_000, "feedback");
  if (!feedback && total === null) bad("점수나 피드백 중 하나는 있어야 합니다");
  const title = strLimited(input.title, 200, "title") || defaultTitle || `${STAGE_LABELS[stage]} 평가`;
  // 제출물 평가는 초안으로 저장하고 리드가 마일스톤 단위로 일괄 공개한다 (리드·관리자가 직접 쓸 때만 visible 지정 가능)
  const visible = milestone
    ? (isLead && input.visible !== undefined && input.visible !== null ? bool(input.visible) : false)
    : (input.visible === undefined || input.visible === null ? true : bool(input.visible));
  const id = newId("evl");
  const at = nowIso();
  await env.DB
    .prepare(`INSERT INTO evaluations (id, project_id, stage, evaluator_id, title, scores, total, feedback, visible, submission_id, milestone, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, projectId, stage, ctx.user.id, title, JSON.stringify(scores), total, feedback, visible ? 1 : 0, submissionId, milestone, at, at)
    .run();
  await touchProject(env, projectId);
  await logActivity(env, { actor_id: ctx.user.id, category_id: p.category_id, project_id: projectId, action: "evaluation.create", target_id: id, summary: `${title}${total !== null ? ` · ${total}/${maxTotal(p.track)}` : ""}${visible ? "" : " (초안)"}`, source: ctx.source });
  return (await getEvaluation(env, ctx, id));
}

export async function getEvaluation(env: Env, ctx: AuthContext, id: string): Promise<EvaluationRow> {
  const raw = await env.DB.prepare(`${EVAL_SELECT} WHERE e.id = ?`).bind(id).first<RawRow>();
  if (!raw) notFound("평가를 찾을 수 없습니다");
  const p = await getProjectForRead(env, ctx, raw.project_id);
  const role = categoryRole(ctx, p.category_id);
  const isLead = ctx.isAdmin || role === "admin" || role === "lead";
  if (!isLead) {
    if (p.track === "capstone") {
      if (role === "evaluator" ? raw.evaluator_id !== ctx.user.id : !raw.visible) notFound("평가를 찾을 수 없습니다");
    } else if (!raw.visible && !canEvaluate(ctx, p.category_id)) notFound("평가를 찾을 수 없습니다");
  }
  const row = shapeEvaluation(raw, p, ctx, await canRespond(env, ctx, p));
  if (p.track === "capstone" && !isLead && role !== "evaluator") anonymizeRows([row]);
  return row;
}

export async function updateEvaluation(env: Env, ctx: AuthContext, id: string, input: EvaluationInput): Promise<EvaluationRow> {
  const raw = await env.DB.prepare(`SELECT * FROM evaluations WHERE id = ?`).bind(id).first<RawRow>();
  if (!raw) notFound("평가를 찾을 수 없습니다");
  const p = await getProjectForRead(env, ctx, raw.project_id);
  if (!(ctx.isAdmin || raw.evaluator_id === ctx.user.id)) forbidden("평가는 작성한 평가자·관리자만 수정할 수 있습니다");
  const roleU = categoryRole(ctx, p.category_id);
  const isLeadU = ctx.isAdmin || roleU === "admin" || roleU === "lead";
  const sets: string[] = [];
  const params: unknown[] = [];
  if (raw.milestone && input.visible !== undefined && input.visible !== null && !isLeadU) forbidden("제출물 평가의 공개는 리드·관리자가 마일스톤 단위로 일괄 처리합니다");
  if (input.stage !== undefined && input.stage !== null && input.stage !== "" && !raw.milestone) {
    if (!isStageOf(p.track, input.stage)) bad("stage 값이 올바르지 않습니다");
    sets.push("stage = ?"); params.push(input.stage);
  }
  if (input.title !== undefined) { sets.push("title = ?"); params.push(strLimited(input.title, 200, "title")); }
  if (input.scores !== undefined) {
    const { scores, total } = normScores(p.track, input.scores);
    sets.push("scores = ?", "total = ?"); params.push(JSON.stringify(scores), total);
  }
  if (input.feedback !== undefined) { sets.push("feedback = ?"); params.push(strLimited(input.feedback, 50_000, "feedback")); }
  if (input.visible !== undefined && input.visible !== null) { sets.push("visible = ?"); params.push(bool(input.visible) ? 1 : 0); }
  if (!sets.length) bad("변경할 필드가 없습니다");
  sets.push("updated_at = ?"); params.push(nowIso(), id);
  await env.DB.prepare(`UPDATE evaluations SET ${sets.join(", ")} WHERE id = ?`).bind(...params).run();
  await touchProject(env, raw.project_id);
  await logActivity(env, { actor_id: ctx.user.id, category_id: p.category_id, project_id: raw.project_id, action: "evaluation.update", target_id: id, summary: raw.title, source: ctx.source });
  return getEvaluation(env, ctx, id);
}

export async function deleteEvaluation(env: Env, ctx: AuthContext, id: string): Promise<void> {
  const raw = await env.DB.prepare(`SELECT * FROM evaluations WHERE id = ?`).bind(id).first<RawRow>();
  if (!raw) notFound("평가를 찾을 수 없습니다");
  const p = await getProjectForRead(env, ctx, raw.project_id);
  if (!(ctx.isAdmin || raw.evaluator_id === ctx.user.id)) forbidden("평가는 작성한 평가자·관리자만 삭제할 수 있습니다");
  await env.DB.prepare(`DELETE FROM evaluations WHERE id = ?`).bind(id).run();
  await logActivity(env, { actor_id: ctx.user.id, category_id: p.category_id, project_id: raw.project_id, action: "evaluation.delete", target_id: id, summary: raw.title, source: ctx.source });
}

/** 팀(담당자·협업자·리드·관리자)의 답변 */
export async function respondEvaluation(env: Env, ctx: AuthContext, id: string, response: unknown): Promise<EvaluationRow> {
  const raw = await env.DB.prepare(`SELECT * FROM evaluations WHERE id = ?`).bind(id).first<RawRow>();
  if (!raw) notFound("평가를 찾을 수 없습니다");
  const p = await getProjectForRead(env, ctx, raw.project_id);
  if (!(await canRespond(env, ctx, p))) forbidden("답변은 프로젝트 담당자·협업자·리드·관리자만 작성할 수 있습니다");
  const text = strLimited(response, 50_000, "response");
  const at = nowIso();
  await env.DB.prepare(`UPDATE evaluations SET response = ?, response_by = ?, response_at = ?, updated_at = ? WHERE id = ?`).bind(text, ctx.user.id, text ? at : null, at, id).run();
  await touchProject(env, raw.project_id);
  await logActivity(env, { actor_id: ctx.user.id, category_id: p.category_id, project_id: raw.project_id, action: "evaluation.respond", target_id: id, summary: `${raw.title}: ${text.slice(0, 100)}`, source: ctx.source });
  return getEvaluation(env, ctx, id);
}

/** 보고서용: 공개 평가 전체 (평가자·답변 포함) */
export async function evaluationsForReport(env: Env, projectId: string): Promise<RawRow[]> {
  const rs = await env.DB.prepare(`${EVAL_SELECT} WHERE e.project_id = ? AND e.visible = 1 ORDER BY e.created_at`).bind(projectId).all<RawRow>();
  const rows = rs.results ?? [];
  const p = await env.DB.prepare(`SELECT track FROM projects WHERE id = ?`).bind(projectId).first<{ track: string }>();
  if (p?.track === "capstone") anonymizeRows(rows); // 보고서는 팀에게 가므로 평가자 익명
  return rows;
}
export { str };
