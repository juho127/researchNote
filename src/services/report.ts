import type { AuthContext, Env, Stage } from "../env";
import { rubricOf, rubricMax, STAGE_LABELS, STAGE_HINTS, stageIds, trackOf } from "../env";
import { requireCategoryMember } from "../lib/auth";
import { escapeHtml, renderMarkdown } from "../lib/markdown";
import { isDateStr, bad } from "../lib/http";
import { getProjectDetail, listProjects, type ProjectDetail } from "./projects";
import { listEntries, type EntryFull, type CommentRow } from "./entries";
import { evaluationsForReport } from "./evaluations";

const STATUS_LABEL: Record<string, string> = { active: "진행 중", paused: "일시 중지", done: "완료", archived: "보관" };
const STAGE_STATUS_LABEL: Record<string, string> = { todo: "예정", doing: "진행 중", done: "완료" };
const REVIEW_LABEL: Record<string, string> = { none: "", requested: "검토 요청", changes_requested: "수정 요청", approved: "승인" };
const KIND_LABEL: Record<string, string> = { comment: "코멘트", approve: "승인", request_changes: "수정 요청" };

export interface ReportOpts {
  from?: string;
  to?: string;
  include_comments?: boolean;
}

interface ProjectReportData {
  project: ProjectDetail;
  entries: EntryFull[];
  comments: Record<string, CommentRow[]>;
  evaluations: Awaited<ReturnType<typeof evaluationsForReport>>;
  generated_at: string;
  from?: string;
  to?: string;
}

/** 500건 페이지를 이어 붙여 전체 기록을 가져온다 (최대 REPORT_MAX 건) */
const REPORT_MAX = 5000;
async function listAllEntries(env: Env, ctx: AuthContext, base: { project_id?: string; category_id?: string; since?: string; until?: string }): Promise<EntryFull[]> {
  const all: EntryFull[] = [];
  for (let offset = 0; offset < REPORT_MAX; offset += 500) {
    const page = await listEntries(env, ctx, { ...base, limit: 500, offset });
    all.push(...page);
    if (page.length < 500) break;
  }
  return all;
}

async function collectProject(env: Env, ctx: AuthContext, projectId: string, opts: ReportOpts): Promise<ProjectReportData> {
  const project = await getProjectDetail(env, ctx, projectId);
  if (opts.from && !isDateStr(opts.from)) bad("from 은 YYYY-MM-DD 형식");
  if (opts.to && !isDateStr(opts.to)) bad("to 는 YYYY-MM-DD 형식");
  const entries = await listAllEntries(env, ctx, { project_id: projectId, since: opts.from, until: opts.to });
  entries.reverse(); // 오래된 순
  const comments: Record<string, CommentRow[]> = {};
  if (opts.include_comments !== false && entries.length) {
    const ids = entries.map((e) => e.id);
    for (let i = 0; i < ids.length; i += 90) {
      const chunk = ids.slice(i, i + 90);
      const rs = await env.DB
        .prepare(`SELECT c.*, u.name AS author_name FROM comments c JOIN users u ON u.id = c.author_id WHERE c.entry_id IN (${chunk.map(() => "?").join(",")}) ORDER BY c.created_at`)
        .bind(...chunk)
        .all<CommentRow>();
      for (const c of rs.results ?? []) (comments[c.entry_id] ||= []).push(c);
    }
  }
  const evaluations = await evaluationsForReport(env, projectId);
  return { project, entries, comments, evaluations, generated_at: new Date().toISOString(), from: opts.from, to: opts.to };
}

function fmtDateTime(iso: string | null | undefined, tz: string): string {
  if (!iso) return "";
  try {
    return new Intl.DateTimeFormat("ko-KR", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
  } catch {
    return iso;
  }
}

// ---------- Markdown ----------

export function projectReportMarkdown(d: ProjectReportData, tz: string): string {
  const p = d.project;
  const L: string[] = [];
  L.push(`# ${p.title}`);
  L.push("");
  L.push(`- 카테고리: ${p.category_name} (${trackOf(p.track).label} 트랙)`);
  L.push(`- 담당: ${p.owner_name}`);
  L.push(`- 현재 단계: ${STAGE_LABELS[p.stage]} · 상태: ${STATUS_LABEL[p.status] ?? p.status}`);
  if (p.target_venue) L.push(`- 목표 학회/저널: ${p.target_venue}`);
  if (p.deadline) L.push(`- 마감: ${p.deadline}`);
  if (p.tags) L.push(`- 태그: ${p.tags}`);
  L.push(`- 기록 ${p.entry_count}건 · 완료 단계 ${p.stage_done}/${stageIds(p.track).length} · 미완료 할 일 ${p.open_tasks}건`);
  L.push(`- 생성일: ${fmtDateTime(p.created_at, tz)} · 보고서 생성: ${fmtDateTime(d.generated_at, tz)}`);
  if (d.from || d.to) L.push(`- 기간: ${d.from ?? "처음"} ~ ${d.to ?? "현재"}`);
  L.push("");
  if (p.summary) {
    L.push("## 연구 요약");
    L.push("");
    L.push(p.summary);
    L.push("");
  }
  L.push("## 단계별 정리 (논문 흐름)");
  L.push("");
  for (const s of p.stages) {
    L.push(`### ${STAGE_LABELS[s.stage as Stage]} — ${STAGE_STATUS_LABEL[s.status] ?? s.status}${s.entry_count ? ` (기록 ${s.entry_count}건)` : ""}`);
    L.push("");
    L.push(s.summary?.trim() ? s.summary.trim() : `_(아직 정리되지 않음 · ${STAGE_HINTS[s.stage as Stage]})_`);
    L.push("");
  }
  if (d.evaluations.length) {
    L.push("## 평가·피드백 (평가자 → 팀 답변)");
    L.push("");
    for (const ev of d.evaluations) {
      let sc: Record<string, number> = {};
      try { sc = JSON.parse(ev.scores || "{}"); } catch {}
      const rubric = rubricOf(p.track, ev.milestone);
      const max = rubricMax(rubric);
      L.push(`### ${ev.title} — ${STAGE_LABELS[ev.stage] ?? ev.stage} · ${ev.evaluator_name} · ${fmtDateTime(ev.created_at, tz)}${ev.total !== null ? ` · **${ev.total}/${max}**` : ""}`);
      if (Object.keys(sc).length) L.push("", "| 축 | 점수 |", "|---|---|", ...rubric.filter((a) => sc[a.id] !== undefined).map((a) => `| ${a.label} | ${sc[a.id]}/${a.max} |`));
      if (ev.feedback) L.push("", ev.feedback);
      if (ev.response) L.push("", `> **팀 답변** (${ev.response_by_name ?? ""}, ${fmtDateTime(ev.response_at, tz)})`, ...ev.response.split("\n").map((l) => `> ${l}`));
      L.push("");
    }
  }
  if (p.tasks.length) {
    L.push("## 할 일");
    L.push("");
    for (const t of p.tasks) {
      L.push(`- [${t.status === "done" ? "x" : " "}] ${t.title}${t.assignee_name ? ` (@${t.assignee_name})` : ""}${t.due ? ` · 기한 ${t.due}` : ""}${t.status === "doing" ? " · 진행 중" : ""}`);
    }
    L.push("");
  }
  L.push(`## 날짜별 진행 기록 (${d.entries.length}건)`);
  L.push("");
  let lastDate = "";
  for (const e of d.entries) {
    if (e.date !== lastDate) {
      L.push(`### ${e.date}`);
      L.push("");
      lastDate = e.date;
    }
    const flags = [STAGE_LABELS[e.stage as Stage], e.author_name, e.source === "mcp" ? "AI 기록" : "", REVIEW_LABEL[e.review_status] || ""].filter(Boolean).join(" · ");
    L.push(`#### ${e.title}`);
    L.push(`_${flags}_`);
    L.push("");
    if (e.content?.trim()) {
      L.push(e.content.trim());
      L.push("");
    }
    const cs = d.comments[e.id] ?? [];
    if (cs.length) {
      L.push(`> **검토 코멘트**`);
      for (const c of cs) L.push(`> - **${c.author_name}** (${KIND_LABEL[c.kind] ?? c.kind}, ${fmtDateTime(c.created_at, tz)}): ${c.content.replace(/\n/g, " ")}`);
      L.push("");
    }
  }
  if (!d.entries.length) L.push("_(기간 내 기록 없음)_");
  return L.join("\n");
}

// ---------- HTML ----------

const REPORT_CSS = `
:root{--paper:#F5F7F7;--card:#FFFFFF;--ink:#0E2230;--navy:#002B49;--teal:#146E7A;--mint:#2FA3A9;--brick:#A6432E;--muted:#66787F;--rule:#DCE4E6;--wash:#EDF3F3;--gold:#B08A2E;
--sans:"Pretendard Variable",Pretendard,-apple-system,BlinkMacSystemFont,"Malgun Gothic","Apple SD Gothic Neo","Noto Sans KR",sans-serif;--serif:"Noto Serif KR","Nanum Myeongjo",Batang,serif;--mono:"SFMono-Regular",Menlo,Consolas,"D2Coding",monospace}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font-family:var(--sans);font-size:14.5px;line-height:1.7;word-break:keep-all;-webkit-font-smoothing:antialiased}
.page{max-width:860px;margin:0 auto;padding:40px 28px 80px}
.toolbar{position:sticky;top:0;background:rgba(245,247,247,.95);backdrop-filter:blur(6px);border-bottom:1px solid var(--rule);padding:10px 28px;display:flex;gap:10px;align-items:center;font-size:13px;color:var(--muted)}
.toolbar button{font:inherit;border:1px solid var(--rule);background:var(--card);border-radius:8px;padding:6px 12px;cursor:pointer;color:var(--navy);font-weight:600}
.toolbar button:hover{border-color:var(--mint)}
.eyebrow{font-size:11px;letter-spacing:.18em;color:var(--gold);font-weight:700;text-transform:uppercase}
h1{font-family:var(--serif);color:var(--navy);font-size:30px;line-height:1.3;margin:6px 0 10px;letter-spacing:-.01em}
h2{font-family:var(--serif);color:var(--navy);font-size:20px;margin:36px 0 12px;padding-bottom:6px;border-bottom:1px solid var(--rule)}
h3{font-size:16px;color:var(--navy);margin:22px 0 6px}
h4{font-size:15px;margin:14px 0 2px;color:var(--ink)}
h5,h6{font-size:14px;margin:12px 0 2px}
.meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:6px 18px;font-size:13px;color:#3C4E57;background:var(--card);border:1px solid var(--rule);border-radius:12px;padding:14px 18px;margin:14px 0 6px}
.meta b{color:var(--navy);font-weight:600}
.summary{background:var(--wash);border-radius:12px;padding:12px 16px}
.stage{background:var(--card);border:1px solid var(--rule);border-radius:12px;padding:12px 16px;margin:10px 0}
.stage h3{margin:0 0 6px;display:flex;gap:8px;align-items:center}
.pill{display:inline-block;font-family:var(--mono);font-size:10.5px;letter-spacing:.08em;border-radius:999px;padding:2px 9px;font-weight:700;background:var(--wash);color:var(--teal)}
.pill.done{background:#E3F3EA;color:#1F7A4D}.pill.doing{background:#FFF4D6;color:#8A6A12}.pill.todo{background:var(--wash);color:var(--muted)}
.pill.req{background:#FDECE7;color:var(--brick)}.pill.appr{background:#E3F3EA;color:#1F7A4D}.pill.chg{background:#FFF4D6;color:#8A6A12}.pill.ai{background:#E7F0FA;color:#2B5A8C}
.empty{color:var(--muted);font-style:italic}
.entry{border-left:3px solid var(--rule);padding:4px 0 4px 16px;margin:10px 0 16px}
.entry .flags{font-size:12px;color:var(--muted);display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:4px}
.entry .body p{margin:6px 0}
.comments{margin-top:8px;background:var(--wash);border-radius:10px;padding:8px 12px;font-size:13px}
.comments .c{margin:4px 0}.comments b{color:var(--navy)}
.md pre{background:#0E2230;color:#E6EEF2;padding:10px 12px;border-radius:8px;overflow:auto;font-size:12.5px;font-family:var(--mono)}
.md code{font-family:var(--mono);font-size:.92em;background:var(--wash);padding:1px 5px;border-radius:4px}.md pre code{background:none;padding:0}
.md table{border-collapse:collapse;margin:8px 0;font-size:13px}.md th,.md td{border:1px solid var(--rule);padding:4px 8px}.md th{background:var(--wash)}
.md blockquote{border-left:3px solid var(--mint);margin:8px 0;padding:2px 12px;color:#3C4E57}
.md li.task{list-style:none;margin-left:-18px}.md li.task.done{color:var(--muted);text-decoration:line-through}
.tasks li{margin:2px 0}.tasks .done{color:var(--muted);text-decoration:line-through}
.foot{margin-top:50px;padding-top:16px;border-top:1px solid var(--rule);font-size:12px;color:var(--muted)}
.proj{background:var(--card);border:1px solid var(--rule);border-radius:12px;padding:14px 18px;margin:12px 0}
.proj h3{margin:0 0 4px}
.proj .row{font-size:13px;color:var(--muted)}
.bar{height:6px;background:var(--wash);border-radius:3px;overflow:hidden;margin:8px 0}.bar i{display:block;height:100%;background:var(--mint)}
@media print{.toolbar{display:none}body{background:#fff;font-size:12.5px}.page{padding:0;max-width:none}.stage,.proj,.meta{break-inside:avoid}h2{break-after:avoid}@page{margin:18mm 16mm}}
`;

function htmlShell(title: string, body: string, env: Env): string {
  return `<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Noto+Serif+KR:wght@500;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable.min.css">
<style>${REPORT_CSS}</style></head><body>
<div class="toolbar"><span>${escapeHtml(env.APP_NAME)} 보고서</span><span style="margin-left:auto"></span><button onclick="window.print()">인쇄 / PDF 저장</button></div>
<div class="page">${body}
<div class="foot">${escapeHtml(env.ORG_NAME)} · ${escapeHtml(env.ORG_SUB)} · ${escapeHtml(env.APP_NAME)}</div>
</div></body></html>`;
}

export function projectReportHtml(d: ProjectReportData, env: Env): string {
  const tz = env.APP_TZ || "Asia/Seoul";
  const p = d.project;
  const H: string[] = [];
  H.push(`<div class="eyebrow">${escapeHtml(p.category_name)} · 연구 진행 보고서</div>`);
  H.push(`<h1>${escapeHtml(p.title)}</h1>`);
  H.push(`<div class="meta">
    <div><b>담당</b> ${escapeHtml(p.owner_name)}</div>
    <div><b>현재 단계</b> ${STAGE_LABELS[p.stage]} · ${STATUS_LABEL[p.status] ?? p.status}</div>
    ${p.target_venue ? `<div><b>목표</b> ${escapeHtml(p.target_venue)}</div>` : ""}
    ${p.deadline ? `<div><b>마감</b> ${p.deadline}</div>` : ""}
    ${p.tags ? `<div><b>태그</b> ${escapeHtml(p.tags)}</div>` : ""}
    <div><b>기록</b> ${p.entry_count}건 · 완료 단계 ${p.stage_done}/${stageIds(p.track).length} · 미완료 할 일 ${p.open_tasks}건</div>
    <div><b>생성</b> ${fmtDateTime(p.created_at, tz)}</div>
    <div><b>보고서</b> ${fmtDateTime(d.generated_at, tz)}${d.from || d.to ? ` · 기간 ${d.from ?? "처음"} ~ ${d.to ?? "현재"}` : ""}</div>
  </div>`);
  if (p.summary) H.push(`<h2>연구 요약</h2><div class="summary md">${renderMarkdown(p.summary)}</div>`);
  H.push(`<h2>단계별 정리 (논문 흐름)</h2>`);
  for (const s of p.stages) {
    H.push(`<div class="stage"><h3>${STAGE_LABELS[s.stage as Stage]} <span class="pill ${s.status}">${STAGE_STATUS_LABEL[s.status] ?? s.status}</span>${s.entry_count ? `<span class="pill">기록 ${s.entry_count}</span>` : ""}</h3>
      <div class="md">${s.summary?.trim() ? renderMarkdown(s.summary) : `<p class="empty">아직 정리되지 않음 · ${STAGE_HINTS[s.stage as Stage]}</p>`}</div></div>`);
  }
  if (d.evaluations.length) {
    H.push(`<h2>평가·피드백 (평가자 → 팀 답변)</h2>`);
    for (const ev of d.evaluations) {
      let sc: Record<string, number> = {};
      try { sc = JSON.parse(ev.scores || "{}"); } catch {}
      const rubric = rubricOf(p.track, ev.milestone);
      const max = rubricMax(rubric);
      H.push(`<div class="stage"><h3>${escapeHtml(ev.title)} <span class="pill">${escapeHtml(STAGE_LABELS[ev.stage] ?? ev.stage)}</span>${ev.total !== null ? `<span class="pill appr">${ev.total}/${max}</span>` : ""}</h3>
        <div class="tiny" style="color:var(--muted)">${escapeHtml(ev.evaluator_name)} · ${fmtDateTime(ev.created_at, tz)}</div>
        ${Object.keys(sc).length ? `<table class="md"><thead><tr>${rubric.filter((a) => sc[a.id] !== undefined).map((a) => `<th>${escapeHtml(a.label)}</th>`).join("")}</tr></thead><tbody><tr>${rubric.filter((a) => sc[a.id] !== undefined).map((a) => `<td>${sc[a.id]}/${a.max}</td>`).join("")}</tr></tbody></table>` : ""}
        <div class="md">${renderMarkdown(ev.feedback)}</div>
        ${ev.response ? `<div class="comments"><b>팀 답변</b> <span style="color:var(--muted)">${escapeHtml(ev.response_by_name ?? "")} · ${fmtDateTime(ev.response_at, tz)}</span><div class="md">${renderMarkdown(ev.response)}</div></div>` : ""}
      </div>`);
    }
  }
  if (p.tasks.length) {
    H.push(`<h2>할 일</h2><ul class="tasks">`);
    for (const t of p.tasks)
      H.push(`<li class="${t.status}">${t.status === "done" ? "☑" : t.status === "doing" ? "◐" : "☐"} ${escapeHtml(t.title)}${t.assignee_name ? ` <span class="pill">@${escapeHtml(t.assignee_name)}</span>` : ""}${t.due ? ` <span class="pill">${t.due}</span>` : ""}</li>`);
    H.push(`</ul>`);
  }
  H.push(`<h2>날짜별 진행 기록 (${d.entries.length}건)</h2>`);
  let lastDate = "";
  for (const e of d.entries) {
    if (e.date !== lastDate) {
      H.push(`<h3>${e.date}</h3>`);
      lastDate = e.date;
    }
    const rv = e.review_status;
    H.push(`<div class="entry"><h4>${escapeHtml(e.title)}</h4>
      <div class="flags"><span class="pill">${STAGE_LABELS[e.stage as Stage]}</span><span>${escapeHtml(e.author_name)}</span>${e.source === "mcp" ? `<span class="pill ai">AI 기록</span>` : ""}${rv === "requested" ? `<span class="pill req">검토 요청</span>` : rv === "approved" ? `<span class="pill appr">승인</span>` : rv === "changes_requested" ? `<span class="pill chg">수정 요청</span>` : ""}</div>
      <div class="body md">${e.content?.trim() ? renderMarkdown(e.content) : ""}</div>`);
    const cs = d.comments[e.id] ?? [];
    if (cs.length) {
      H.push(`<div class="comments"><b>검토 코멘트</b>`);
      for (const c of cs) H.push(`<div class="c"><b>${escapeHtml(c.author_name)}</b> <span class="pill ${c.kind === "approve" ? "appr" : c.kind === "request_changes" ? "chg" : ""}">${KIND_LABEL[c.kind] ?? c.kind}</span> <span style="color:var(--muted)">${fmtDateTime(c.created_at, tz)}</span><div>${renderMarkdown(c.content)}</div></div>`);
      H.push(`</div>`);
    }
    H.push(`</div>`);
  }
  if (!d.entries.length) H.push(`<p class="empty">기간 내 기록 없음</p>`);
  return htmlShell(`${p.title} — 연구 진행 보고서`, H.join("\n"), env);
}

export async function projectReport(env: Env, ctx: AuthContext, projectId: string, format: string, opts: ReportOpts) {
  const d = await collectProject(env, ctx, projectId, opts);
  if (format === "json") return { type: "json" as const, data: d };
  if (format === "md" || format === "markdown") return { type: "md" as const, text: projectReportMarkdown(d, env.APP_TZ || "Asia/Seoul"), title: d.project.title };
  return { type: "html" as const, html: projectReportHtml(d, env), title: d.project.title };
}

// ---------- 카테고리(팀) 보고서 ----------

export async function categoryReport(env: Env, ctx: AuthContext, categoryId: string, format: string, opts: ReportOpts) {
  requireCategoryMember(ctx, categoryId);
  const cat = await env.DB.prepare(`SELECT * FROM categories WHERE id = ?`).bind(categoryId).first<{ id: string; name: string; description: string }>();
  if (!cat) bad("카테고리를 찾을 수 없습니다");
  if (opts.from && !isDateStr(opts.from)) bad("from 은 YYYY-MM-DD 형식");
  if (opts.to && !isDateStr(opts.to)) bad("to 는 YYYY-MM-DD 형식");
  const projects = (await listProjects(env, ctx, { category_id: categoryId, status: "all", limit: 300 })).filter((p) => p.status !== "archived");
  const entries = await listAllEntries(env, ctx, { category_id: categoryId, since: opts.from, until: opts.to });
  const byProject = new Map<string, EntryFull[]>();
  for (const e of entries) (byProject.get(e.project_id) ?? byProject.set(e.project_id, []).get(e.project_id)!).push(e);
  const tz = env.APP_TZ || "Asia/Seoul";
  const generated = new Date().toISOString();
  const period = opts.from || opts.to ? `${opts.from ?? "처음"} ~ ${opts.to ?? "현재"}` : "전체";

  if (format === "json") return { type: "json" as const, data: { category: cat, projects, entries, generated_at: generated } };

  if (format === "md" || format === "markdown") {
    const L: string[] = [`# ${cat.name} — 팀 연구 진행 보고서`, "", `- 기간: ${period}`, `- 프로젝트 ${projects.length}건 · 기간 내 기록 ${entries.length}건`, `- 생성: ${fmtDateTime(generated, tz)}`, ""];
    if (cat.description) L.push(cat.description, "");
    for (const p of projects) {
      const es = (byProject.get(p.id) ?? []).slice().reverse();
      L.push(`## ${p.title}`, "", `- 담당 ${p.owner_name} · ${STAGE_LABELS[p.stage]} · ${STATUS_LABEL[p.status] ?? p.status} · 완료 단계 ${p.stage_done}/${stageIds(p.track).length}${p.deadline ? ` · 마감 ${p.deadline}` : ""}${p.target_venue ? ` · ${p.target_venue}` : ""}`, "");
      if (p.summary) L.push(p.summary, "");
      if (es.length) {
        for (const e of es) {
          L.push(`- **${e.date}** [${STAGE_LABELS[e.stage as Stage]}] ${e.title} (${e.author_name}${e.review_status !== "none" ? `, ${REVIEW_LABEL[e.review_status]}` : ""})`);
          const body = e.content?.trim();
          if (body) L.push(`  ${body.split("\n")[0].slice(0, 200)}`);
        }
        L.push("");
      } else L.push("_(기간 내 기록 없음)_", "");
    }
    return { type: "md" as const, text: L.join("\n"), title: cat.name };
  }

  const H: string[] = [];
  H.push(`<div class="eyebrow">팀 연구 진행 보고서</div><h1>${escapeHtml(cat.name)}</h1>`);
  H.push(`<div class="meta"><div><b>기간</b> ${escapeHtml(period)}</div><div><b>프로젝트</b> ${projects.length}건</div><div><b>기간 내 기록</b> ${entries.length}건</div><div><b>생성</b> ${fmtDateTime(generated, tz)}</div></div>`);
  if (cat.description) H.push(`<div class="summary md">${renderMarkdown(cat.description)}</div>`);
  for (const p of projects) {
    const es = (byProject.get(p.id) ?? []).slice().reverse();
    const pct = Math.round((p.stage_done / stageIds(p.track).length) * 100);
    H.push(`<div class="proj"><h3>${escapeHtml(p.title)}</h3>
      <div class="row">${escapeHtml(p.owner_name)} · <span class="pill">${STAGE_LABELS[p.stage]}</span> ${STATUS_LABEL[p.status] ?? p.status}${p.deadline ? ` · 마감 ${p.deadline}` : ""}${p.target_venue ? ` · ${escapeHtml(p.target_venue)}` : ""}</div>
      <div class="bar"><i style="width:${pct}%"></i></div>
      ${p.summary ? `<div class="md">${renderMarkdown(p.summary)}</div>` : ""}`);
    if (es.length) {
      H.push(`<ul>`);
      for (const e of es) {
        const first = (e.content?.trim().split("\n")[0] ?? "").slice(0, 200);
        H.push(`<li><b>${e.date}</b> <span class="pill">${STAGE_LABELS[e.stage as Stage]}</span> ${escapeHtml(e.title)} <span style="color:var(--muted)">· ${escapeHtml(e.author_name)}</span>${e.review_status === "requested" ? ` <span class="pill req">검토 요청</span>` : e.review_status === "approved" ? ` <span class="pill appr">승인</span>` : e.review_status === "changes_requested" ? ` <span class="pill chg">수정 요청</span>` : ""}${first ? `<div style="color:#3C4E57;font-size:13px">${escapeHtml(first)}</div>` : ""}</li>`);
      }
      H.push(`</ul>`);
    } else H.push(`<p class="empty">기간 내 기록 없음</p>`);
    H.push(`</div>`);
  }
  if (!projects.length) H.push(`<p class="empty">프로젝트 없음</p>`);
  return { type: "html" as const, html: htmlShell(`${cat.name} — 팀 연구 진행 보고서`, H.join("\n"), env), title: cat.name };
}
