/**
 * 보고서 제출 — 마일스톤(1차·중간·최종)별 PDF 를 R2(FILES_R2, 없으면 KV FILES) 에 저장하고 D1 에 메타를 남긴다.
 *
 * - 마감: 카테고리 milestone_due(JSON, 날짜) 덮어쓰기 → 없으면 주차 설정의 N주차 마감일 → 없으면 마감 없음. 마감 이후 제출은 late=1.
 * - 평가: evaluations.submission_id 로 연결. 캡스톤은 블라인드(평가자끼리·학생에게 평가자 비공개)이고
 *   초안(visible=0)으로 저장되며 리드·관리자가 마일스톤 단위로 일괄 공개한다.
 * - 파일 열람은 카테고리 구성원(평가자 포함)만. 핀 열람자는 제출 현황만 본다.
 */
import type { AuthContext, Env } from "../env";
import { reportsOf, trackOf, type ReportDef } from "../env";
import { canEvaluate, categoryRole, requireCategoryMember } from "../lib/auth";
import { bad, forbidden, notFound, str, strLimited } from "../lib/http";
import { newId } from "../lib/id";
import { endOfDayIso, nowIso, todayIn } from "../lib/time";
import { weekCfgOf, weekRange } from "../lib/week";
import { getProjectForRead, isCollaborator, logActivity, touchProject, type ProjectRow } from "../lib/db";
import { EVAL_SELECT, canRespond, shapeEvaluation, type EvaluationRow, type RawEvaluationRow } from "./evaluations";

export const MAX_FILE_BYTES = 20 * 1024 * 1024;

/** 파일 저장소 어댑터: R2 바인딩이 있으면 R2, 아니면 KV */
interface FileStore {
  kind: "r2" | "kv";
  put(key: string, data: ArrayBuffer, meta: Record<string, string>): Promise<void>;
  get(key: string): Promise<ReadableStream | null>;
  delete(key: string): Promise<void>;
}
function fileStore(env: Env): FileStore {
  if (env.FILES_R2) {
    const r2 = env.FILES_R2;
    return {
      kind: "r2",
      put: async (key, data, meta) => { await r2.put(key, data, { httpMetadata: { contentType: "application/pdf" }, customMetadata: meta }); },
      get: async (key) => (await r2.get(key))?.body ?? null,
      delete: async (key) => { await r2.delete(key); },
    };
  }
  if (env.FILES) {
    const kv = env.FILES;
    return {
      kind: "kv",
      put: async (key, data, meta) => { await kv.put(key, data, { metadata: meta }); },
      get: async (key) => kv.get(key, "stream"),
      delete: async (key) => { await kv.delete(key); },
    };
  }
  throw new Error("파일 저장소 바인딩(FILES_R2 또는 FILES)이 없습니다");
}

export interface SubmissionRow {
  id: string;
  project_id: string;
  milestone: string;
  version: number;
  filename: string;
  size: number;
  content_type: string;
  note: string;
  late: number;
  submitted_by: string;
  submitted_by_name: string;
  created_at: string;
}
type SubmissionRaw = SubmissionRow & { storage_key: string };

export interface MilestoneInfo extends ReportDef {
  due: string | null;      // YYYY-MM-DD
  due_at: string | null;   // ISO (그날 자정 APP_TZ)
  overridden: boolean;     // 카테고리 설정으로 덮어쓴 마감인지
  passed: boolean;         // 마감 지남
}

interface CatRow {
  id: string;
  track: string;
  week_start: string | null;
  week_count: number;
  week_due_dow: number;
  milestone_due: string | null;
}

const SUB_SELECT = `SELECT s.*, u.name AS submitted_by_name FROM submissions s JOIN users u ON u.id = s.submitted_by`;

async function loadCat(env: Env, categoryId: string): Promise<CatRow> {
  const c = await env.DB.prepare(`SELECT id, track, week_start, week_count, week_due_dow, milestone_due FROM categories WHERE id = ?`).bind(categoryId).first<CatRow>();
  if (!c) notFound("카테고리를 찾을 수 없습니다");
  return c;
}

export function parseMilestoneDue(json: string | null | undefined): Record<string, string> {
  if (!json) return {};
  try {
    const o = JSON.parse(json);
    return o && typeof o === "object" && !Array.isArray(o) ? (o as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** 카테고리의 보고서 마일스톤 목록과 마감 (트랙에 reports 가 없으면 빈 배열) */
export function milestonesFor(env: Env, cat: CatRow): MilestoneInfo[] {
  const reports = reportsOf(cat.track);
  const cfg = weekCfgOf(cat);
  const over = parseMilestoneDue(cat.milestone_due);
  const now = nowIso();
  return reports.map((r) => {
    const due = over[r.id] || (cfg ? weekRange(cfg, r.week).end : null);
    const due_at = due ? endOfDayIso(due, env.APP_TZ) : null;
    return { ...r, due, due_at, overridden: !!over[r.id], passed: !!due_at && due_at < now };
  });
}

async function canSubmit(env: Env, ctx: AuthContext, p: ProjectRow): Promise<boolean> {
  if (ctx.viewer) return false;
  const role = categoryRole(ctx, p.category_id);
  if (role === "admin" || role === "lead") return true;
  if (!role || role === "evaluator") return false;
  return p.owner_id === ctx.user.id || (await isCollaborator(env, p.id, ctx.user.id));
}

function stripKey(s: SubmissionRaw): SubmissionRow {
  const { storage_key, ...rest } = s;
  void storage_key;
  return rest;
}

export async function getSubmission(env: Env, id: string): Promise<SubmissionRaw> {
  const s = await env.DB.prepare(`${SUB_SELECT} WHERE s.id = ?`).bind(id).first<SubmissionRaw>();
  if (!s) notFound("제출물을 찾을 수 없습니다");
  return s;
}

/** 학생 번호 매기기: 같은 프로젝트 안에서 평가자별로 안정적인 '평가자 N' */
function anonymize(rows: EvaluationRow[]): void {
  const idx = new Map<string, number>();
  for (const r of rows) {
    if (!idx.has(r.evaluator_id)) idx.set(r.evaluator_id, idx.size + 1);
    r.evaluator_name = `평가자 ${idx.get(r.evaluator_id)}`;
    r.evaluator_id = "";
  }
}

export interface MilestoneSummary {
  count: number;          // 평가 건수 (내가 볼 수 있는 범위)
  visible_count: number;
  avg_total: number | null;
  axis_avg: Record<string, number>;
  published: boolean;     // 모든 평가가 공개됨
}

/** 프로젝트의 제출·평가 현황 (역할별 블라인드 적용) */
export async function listForProject(env: Env, ctx: AuthContext, projectId: string) {
  const p = await getProjectForRead(env, ctx, projectId);
  const cat = await loadCat(env, p.category_id);
  const milestones = milestonesFor(env, cat);
  const rubric = trackOf(p.track).rubric;
  const role = categoryRole(ctx, p.category_id);
  const isLead = ctx.isAdmin || role === "admin" || role === "lead";
  const base = { enabled: milestones.length > 0, milestones, rubric, max_total: rubric.reduce((a, x) => a + x.max, 0), today: todayIn(env.APP_TZ), is_lead: isLead, can_submit: false, can_evaluate: false, is_viewer: !!ctx.viewer };
  if (!milestones.length) return { ...base, submissions: [] as SubmissionRow[], evaluations: [] as EvaluationRow[], summary: {} as Record<string, MilestoneSummary> };

  const [subRs, evRs] = await env.DB.batch([
    env.DB.prepare(`${SUB_SELECT} WHERE s.project_id = ? ORDER BY s.milestone, s.version DESC`).bind(projectId),
    env.DB.prepare(`${EVAL_SELECT} WHERE e.project_id = ? AND e.milestone IS NOT NULL ORDER BY e.created_at`).bind(projectId),
  ]);
  const submissions = ((subRs.results ?? []) as SubmissionRaw[]).map(stripKey);
  const responder = await canRespond(env, ctx, p);
  let raws = (evRs.results ?? []) as RawEvaluationRow[];
  if (!isLead) {
    if (role === "evaluator") raws = raws.filter((r) => r.evaluator_id === ctx.user.id);
    else raws = raws.filter((r) => r.visible);
  }
  const evaluations = raws.map((r) => shapeEvaluation(r, p, ctx, responder));
  if (!isLead && role !== "evaluator") anonymize(evaluations);

  // 요약: 공개 여부는 전체 기준으로 계산 (학생도 '평가 진행 중/공개됨' 은 알 수 있게)
  const allRs = await env.DB.prepare(`SELECT milestone, visible, total, scores FROM evaluations WHERE project_id = ? AND milestone IS NOT NULL`).bind(projectId).all<{ milestone: string; visible: number; total: number | null; scores: string }>();
  const all = allRs.results ?? [];
  const summary: Record<string, MilestoneSummary> = {};
  for (const m of milestones) {
    const of = all.filter((e) => e.milestone === m.id);
    const scoped = isLead ? of : of.filter((e) => e.visible); // 평가자·학생에게는 공개된 것만 집계 (평가자는 자기 것 외 점수 비공개)
    const withTotal = scoped.filter((e) => e.total !== null);
    const axis_avg: Record<string, number> = {};
    for (const ax of rubric) {
      const vals = scoped.map((e) => { try { return JSON.parse(e.scores || "{}")[ax.id]; } catch { return undefined; } }).filter((v) => typeof v === "number") as number[];
      if (vals.length) axis_avg[ax.id] = Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10;
    }
    summary[m.id] = {
      count: of.length,
      visible_count: of.filter((e) => e.visible).length,
      avg_total: withTotal.length && (isLead || role !== "evaluator") ? Math.round((withTotal.reduce((a, e) => a + (e.total ?? 0), 0) / withTotal.length) * 10) / 10 : null,
      axis_avg: isLead || role !== "evaluator" ? axis_avg : {},
      published: of.length > 0 && of.every((e) => e.visible),
    };
  }
  return { ...base, can_submit: await canSubmit(env, ctx, p), can_evaluate: !ctx.viewer && canEvaluate(ctx, p.category_id), submissions, evaluations, summary };
}

/** multipart 업로드: milestone, file(PDF ≤ 20MB), note */
export async function upload(env: Env, ctx: AuthContext, request: Request, projectId: string): Promise<SubmissionRow> {
  const p = await getProjectForRead(env, ctx, projectId);
  if (!(await canSubmit(env, ctx, p))) forbidden("제출은 프로젝트 담당자·협업자·리드·관리자만 할 수 있습니다");
  if (p.status === "archived") forbidden("보관된 프로젝트에는 제출할 수 없습니다");
  const cat = await loadCat(env, p.category_id);
  const ms = milestonesFor(env, cat);
  if (!ms.length) bad("이 트랙에는 보고서 제출 마일스톤이 없습니다");
  let form: FormData;
  try { form = await request.formData(); } catch { bad("multipart/form-data 로 보내야 합니다 (milestone, file, note)"); }
  const milestone = str(form!.get("milestone"), 40);
  const m = ms.find((x) => x.id === milestone);
  if (!m) bad(`milestone 은 ${ms.map((x) => `${x.id}(${x.label})`).join(", ")} 중 하나여야 합니다`);
  const file = form!.get("file");
  if (!(file instanceof File)) bad("file 이 필요합니다");
  const filename = str(file.name, 200) || "report.pdf";
  const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(filename);
  if (!isPdf) bad("PDF 파일만 제출할 수 있습니다");
  if (file.size <= 0) bad("빈 파일입니다");
  if (file.size > MAX_FILE_BYTES) bad(`파일이 너무 큽니다 (최대 ${MAX_FILE_BYTES / 1024 / 1024} MB)`);
  const note = strLimited(form!.get("note"), 2000, "note");
  const prev = await env.DB.prepare(`SELECT COALESCE(MAX(version), 0) AS v FROM submissions WHERE project_id = ? AND milestone = ?`).bind(projectId, m!.id).first<{ v: number }>();
  const version = (prev?.v ?? 0) + 1;
  const id = newId("sub");
  const at = nowIso();
  const key = `sub/${projectId}/${m!.id}/${id}.pdf`;
  const late = m!.due_at && at > m!.due_at ? 1 : 0;
  await fileStore(env).put(key, await file.arrayBuffer(), { project_id: projectId, milestone: m!.id, filename, size: String(file.size), version: String(version) });
  await env.DB
    .prepare(`INSERT INTO submissions (id, project_id, milestone, version, filename, size, content_type, storage_key, note, late, submitted_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, projectId, m!.id, version, filename, file.size, "application/pdf", key, note, late, ctx.user.id, at)
    .run();
  await touchProject(env, projectId);
  await logActivity(env, { actor_id: ctx.user.id, category_id: p.category_id, project_id: projectId, action: "submission.create", target_id: id, summary: `${m!.label} v${version} · ${filename}${late ? " (지각)" : ""}`, source: ctx.source });
  return stripKey(await getSubmission(env, id));
}

/** 파일 응답 (inline 또는 download). 핀 열람자는 불가 */
export async function fileResponse(env: Env, ctx: AuthContext, id: string, download: boolean): Promise<Response> {
  const s = await getSubmission(env, id);
  await getProjectForRead(env, ctx, s.project_id);
  if (ctx.viewer) forbidden("열람 모드에서는 제출 파일을 열 수 없습니다. 팀원·평가자 계정으로 로그인하세요");
  const body = await fileStore(env).get(s.storage_key);
  if (!body) notFound("파일이 저장소에 없습니다");
  const fname = encodeURIComponent(s.filename);
  return new Response(body, {
    headers: {
      "Content-Type": s.content_type || "application/pdf",
      "Content-Length": String(s.size),
      "Content-Disposition": `${download ? "attachment" : "inline"}; filename*=UTF-8''${fname}`,
      "Cache-Control": "private, no-store",
    },
  });
}

/** 제출 삭제: 제출자(평가 전) 또는 리드·관리자 */
export async function remove(env: Env, ctx: AuthContext, id: string): Promise<void> {
  const s = await getSubmission(env, id);
  const p = await getProjectForRead(env, ctx, s.project_id);
  const role = categoryRole(ctx, p.category_id);
  const isLead = ctx.isAdmin || role === "admin" || role === "lead";
  if (!(isLead || s.submitted_by === ctx.user.id)) forbidden("제출물은 제출자·리드·관리자만 삭제할 수 있습니다");
  const n = await env.DB.prepare(`SELECT COUNT(*) AS n FROM evaluations WHERE submission_id = ?`).bind(id).first<{ n: number }>();
  if ((n?.n ?? 0) > 0 && !isLead) forbidden("이미 평가가 달린 제출물은 삭제할 수 없습니다. 새 버전으로 다시 제출하세요");
  await fileStore(env).delete(s.storage_key);
  await env.DB.prepare(`DELETE FROM submissions WHERE id = ?`).bind(id).run();
  await logActivity(env, { actor_id: ctx.user.id, category_id: p.category_id, project_id: s.project_id, action: "submission.delete", target_id: id, summary: `${s.milestone} v${s.version} · ${s.filename}`, source: ctx.source });
}

export interface CategoryCell {
  submission: { id: string; version: number; created_at: string; late: number; filename: string } | null;
  eval_count: number;
  visible_count: number;
  avg_total: number | null;
  my_evaluated: boolean;
}

/** 팀 페이지: 프로젝트 × 마일스톤 제출·평가 현황 */
export async function categoryStatus(env: Env, ctx: AuthContext, categoryId: string) {
  const role = requireCategoryMember(ctx, categoryId);
  const cat = await loadCat(env, categoryId);
  const milestones = milestonesFor(env, cat);
  const isLead = ctx.isAdmin || role === "admin" || role === "lead";
  const rubric = trackOf(cat.track).rubric;
  const base = { enabled: milestones.length > 0, milestones, is_lead: isLead, can_evaluate: !ctx.viewer && canEvaluate(ctx, categoryId), max_total: rubric.reduce((a, x) => a + x.max, 0), today: todayIn(env.APP_TZ) };
  if (!milestones.length) return { ...base, projects: [], publish: {} as Record<string, { total: number; visible: number; published: boolean }> };
  const [prs, subs, evs] = await env.DB.batch([
    env.DB.prepare(`SELECT p.id, p.title, p.owner_id, u.name AS owner_name, p.status FROM projects p JOIN users u ON u.id = p.owner_id WHERE p.category_id = ? AND p.status IN ('active','paused') ORDER BY p.title`).bind(categoryId),
    env.DB.prepare(`SELECT s.id, s.project_id, s.milestone, s.version, s.created_at, s.late, s.filename FROM submissions s JOIN projects p ON p.id = s.project_id WHERE p.category_id = ? ORDER BY s.version DESC`).bind(categoryId),
    env.DB.prepare(`SELECT e.project_id, e.milestone, e.evaluator_id, e.total, e.visible FROM evaluations e JOIN projects p ON p.id = e.project_id WHERE p.category_id = ? AND e.milestone IS NOT NULL`).bind(categoryId),
  ]);
  const latest = new Map<string, CategoryCell["submission"]>();
  for (const s of (subs.results ?? []) as { id: string; project_id: string; milestone: string; version: number; created_at: string; late: number; filename: string }[]) {
    const k = `${s.project_id}|${s.milestone}`;
    if (!latest.has(k)) latest.set(k, { id: s.id, version: s.version, created_at: s.created_at, late: s.late, filename: s.filename });
  }
  const evRows = (evs.results ?? []) as { project_id: string; milestone: string; evaluator_id: string; total: number | null; visible: number }[];
  const projects = ((prs.results ?? []) as { id: string; title: string; owner_id: string; owner_name: string; status: string }[]).map((p) => {
    const cells: Record<string, CategoryCell> = {};
    for (const m of milestones) {
      const of = evRows.filter((e) => e.project_id === p.id && e.milestone === m.id);
      const scoped = isLead ? of : of.filter((e) => e.visible);
      const withTotal = scoped.filter((e) => e.total !== null);
      cells[m.id] = {
        submission: latest.get(`${p.id}|${m.id}`) ?? null,
        eval_count: of.length,
        visible_count: of.filter((e) => e.visible).length,
        avg_total: withTotal.length && (isLead || role !== "evaluator") ? Math.round((withTotal.reduce((a, e) => a + (e.total ?? 0), 0) / withTotal.length) * 10) / 10 : null,
        my_evaluated: of.some((e) => e.evaluator_id === ctx.user.id),
      };
    }
    return { ...p, cells };
  });
  const publish: Record<string, { total: number; visible: number; published: boolean }> = {};
  for (const m of milestones) {
    const of = evRows.filter((e) => e.milestone === m.id);
    publish[m.id] = { total: of.length, visible: of.filter((e) => e.visible).length, published: of.length > 0 && of.every((e) => e.visible) };
  }
  return { ...base, projects, publish };
}

/** 마일스톤 평가 일괄 공개/비공개 (리드·관리자) */
export async function publishEvaluations(env: Env, ctx: AuthContext, categoryId: string, milestone: unknown, visible: unknown): Promise<{ milestone: string; visible: boolean; changed: number }> {
  const role = requireCategoryMember(ctx, categoryId);
  if (!(ctx.isAdmin || role === "admin" || role === "lead")) forbidden("평가 공개는 리드·관리자만 할 수 있습니다");
  const cat = await loadCat(env, categoryId);
  const m = milestonesFor(env, cat).find((x) => x.id === str(milestone, 40));
  if (!m) bad("milestone 값이 올바르지 않습니다");
  const on = visible === undefined || visible === null ? true : !!visible && visible !== "false" && visible !== 0;
  const r = await env.DB
    .prepare(`UPDATE evaluations SET visible = ?, updated_at = ? WHERE milestone = ? AND project_id IN (SELECT id FROM projects WHERE category_id = ?)`)
    .bind(on ? 1 : 0, nowIso(), m.id, categoryId)
    .run();
  const changed = r.meta.changes ?? 0;
  await logActivity(env, { actor_id: ctx.user.id, category_id: categoryId, action: "evaluation.publish", target_id: m.id, summary: `${m.label} 평가 ${on ? "공개" : "비공개"} (${changed}건)`, source: ctx.source });
  return { milestone: m.id, visible: on, changed };
}

export interface SummaryRow { project_id: string; project_title: string; evaluator_id: string; evaluator_name: string; scores: Record<string, number>; total: number | null; visible: boolean; created_at: string }
export interface EvaluationSummary {
  milestone: MilestoneInfo;
  rubric: { id: string; label: string; max: number }[];
  max_total: number;
  rows: SummaryRow[];
  projects: { id: string; title: string; n: number; avg_total: number | null; stdev: number | null; axis_avg: Record<string, number>; submitted: boolean }[];
  evaluators: { id: string; name: string; n: number }[];
  filename: string;
}

/** 리드·관리자용 점수표: 프로젝트 × 평가자 */
export async function evaluationSummary(env: Env, ctx: AuthContext, categoryId: string, milestone: unknown): Promise<EvaluationSummary> {
  const role = requireCategoryMember(ctx, categoryId);
  if (!(ctx.isAdmin || role === "admin" || role === "lead")) forbidden("점수표는 리드·관리자만 볼 수 있습니다");
  const cat = await loadCat(env, categoryId);
  const m = milestonesFor(env, cat).find((x) => x.id === str(milestone, 40));
  if (!m) bad("milestone 값이 올바르지 않습니다 (예: report1)");
  const rubric = trackOf(cat.track).rubric.map((x) => ({ id: x.id, label: x.label, max: x.max }));
  const [prs, evs, subs] = await env.DB.batch([
    env.DB.prepare(`SELECT id, title FROM projects WHERE category_id = ? AND status IN ('active','paused') ORDER BY title`).bind(categoryId),
    env.DB.prepare(`SELECT e.project_id, p.title AS project_title, e.evaluator_id, u.name AS evaluator_name, e.scores, e.total, e.visible, e.created_at FROM evaluations e JOIN projects p ON p.id = e.project_id JOIN users u ON u.id = e.evaluator_id WHERE p.category_id = ? AND e.milestone = ? ORDER BY p.title, u.name`).bind(categoryId, m.id),
    env.DB.prepare(`SELECT DISTINCT s.project_id FROM submissions s JOIN projects p ON p.id = s.project_id WHERE p.category_id = ? AND s.milestone = ?`).bind(categoryId, m.id),
  ]);
  const submitted = new Set(((subs.results ?? []) as { project_id: string }[]).map((s) => s.project_id));
  const rows: SummaryRow[] = ((evs.results ?? []) as { project_id: string; project_title: string; evaluator_id: string; evaluator_name: string; scores: string; total: number | null; visible: number; created_at: string }[]).map((r) => {
    let scores: Record<string, number> = {};
    try { scores = JSON.parse(r.scores || "{}"); } catch { scores = {}; }
    return { ...r, scores, visible: !!r.visible };
  });
  const projects = ((prs.results ?? []) as { id: string; title: string }[]).map((p) => {
    const of = rows.filter((r) => r.project_id === p.id);
    const totals = of.map((r) => r.total).filter((t): t is number => t !== null);
    const avg = totals.length ? totals.reduce((a, b) => a + b, 0) / totals.length : null;
    const stdev = totals.length > 1 && avg !== null ? Math.sqrt(totals.reduce((a, t) => a + (t - avg) ** 2, 0) / (totals.length - 1)) : null;
    const axis_avg: Record<string, number> = {};
    for (const ax of rubric) {
      const vals = of.map((r) => r.scores[ax.id]).filter((v) => typeof v === "number");
      if (vals.length) axis_avg[ax.id] = Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10;
    }
    return { id: p.id, title: p.title, n: of.length, avg_total: avg === null ? null : Math.round(avg * 10) / 10, stdev: stdev === null ? null : Math.round(stdev * 10) / 10, axis_avg, submitted: submitted.has(p.id) };
  });
  const evMap = new Map<string, { id: string; name: string; n: number }>();
  for (const r of rows) {
    const e = evMap.get(r.evaluator_id) ?? { id: r.evaluator_id, name: r.evaluator_name, n: 0 };
    e.n += 1;
    evMap.set(r.evaluator_id, e);
  }
  return { milestone: m, rubric, max_total: rubric.reduce((a, x) => a + x.max, 0), rows, projects, evaluators: [...evMap.values()], filename: `${cat.id}_${m.id}_scores.csv` };
}

export function summaryCsv(s: EvaluationSummary): string {
  const esc = (v: unknown) => { const t = String(v ?? ""); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
  const L: string[] = [];
  L.push(["프로젝트", "평가자", ...s.rubric.map((x) => `${x.label}(${x.max})`), `합계(${s.max_total})`, "공개", "작성"].map(esc).join(","));
  for (const r of s.rows) L.push([r.project_title, r.evaluator_name, ...s.rubric.map((x) => r.scores[x.id] ?? ""), r.total ?? "", r.visible ? "Y" : "N", r.created_at.slice(0, 16).replace("T", " ")].map(esc).join(","));
  L.push("");
  L.push(["프로젝트", "평가 수", ...s.rubric.map((x) => `${x.label} 평균`), "합계 평균", "표준편차", "제출"].map(esc).join(","));
  for (const p of s.projects) L.push([p.title, p.n, ...s.rubric.map((x) => p.axis_avg[x.id] ?? ""), p.avg_total ?? "", p.stdev ?? "", p.submitted ? "Y" : "N"].map(esc).join(","));
  return "﻿" + L.join("\n");
}
