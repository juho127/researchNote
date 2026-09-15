/**
 * 연구노트 MCP 서버 — Streamable HTTP (stateless) / JSON-RPC 2.0
 *
 * 연구자가 쓰는 AI 도구(Claude Code, Cursor, Claude Desktop, Codex 등)가 이 엔드포인트를 등록하면
 * 별도 설치 없이 도구(tools)·프롬프트·리소스로 연구 진행을 읽고 기록할 수 있다.
 *
 *   POST /mcp   JSON-RPC 요청(단건/배치). 알림(id 없음)은 202.
 *   GET  /mcp   405 (서버 발신 스트림 미사용)
 *   DELETE /mcp 200 (세션 종료 no-op)
 */
import type { AuthContext, Env } from "./env";
import { STAGES, STAGE_LABELS, STAGE_HINTS, ALL_STAGE_IDS, TRACKS, stageIds, trackOf } from "./env";
import { authenticate } from "./lib/auth";
import { HttpError, CORS_HEADERS } from "./lib/http";
import { todayIn } from "./lib/time";
import * as P from "./services/projects";
import * as E from "./services/entries";
import * as T from "./services/tasks";
import * as F from "./services/feed";
import * as W from "./services/weekly";
import * as SB from "./services/submissions";
import * as R from "./services/report";
import * as TM from "./services/teams";
import * as EV from "./services/evaluations";
import * as N from "./services/notices";
import { SKILL_MD, SKILL_SHORT } from "./skill";

const SERVER_NAME = "research-note";
const SERVER_VERSION = "1.0.0";
const SUPPORTED_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface ToolDef {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (env: Env, ctx: AuthContext, args: Record<string, unknown>) => Promise<{ text: string; data?: unknown }>;
}

/** 핀 열람 세션(읽기 전용)에서도 호출할 수 있는 도구. 나머지는 열람 모드에서 isError */
const READONLY_TOOLS = new Set(["whoami", "list_projects", "get_project", "list_evaluations", "list_entries", "get_entry", "list_tasks", "team_feed", "team_overview", "list_teams", "search", "get_report", "list_notices"]);

const stageEnum = {
  type: "string",
  enum: [...ALL_STAGE_IDS],
  description: Object.values(TRACKS).map((t) => `${t.label} 트랙: ${t.stages.map((s) => `${s.id}=${s.label}`).join(", ")}`).join(" / ") + ". 프로젝트의 트랙(get_project 의 track)에 맞는 단계만 유효",
};
const idProp = (d: string) => ({ type: "string", description: d });
const dateProp = (d: string) => ({ type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: `${d} (YYYY-MM-DD)` });
const j = (v: unknown) => JSON.stringify(v, null, 2);
const s = (v: unknown) => (v === undefined || v === null ? undefined : String(v));

/** 주차 설정이 있는 프로젝트의 현재 주차·마감·주간 보고 제출 여부 */
function weekLines(p: P.ProjectDetail): string {
  if (!p.week_cfg) return "";
  const r = p.current_week_range;
  const dow = ["일", "월", "화", "수", "목", "금", "토"][p.week_cfg.week_due_dow];
  return `\n\n## 주차 (1주차 ${p.week_cfg.week_start} 시작, 총 ${p.week_cfg.week_count}주, 마감 매주 ${dow}요일 자정)\n- 오늘: ${p.current_week >= 1 ? `${p.current_week}주차` : "학기 시작 전"}${r ? ` (${r.start} ~ ${r.end}, 마감 ${r.end} 자정)` : ""}\n- 이번 주 주간 보고: ${p.weekly_this_week ? "제출됨" : "미제출 — log_progress 에 weekly=true 로 남길 것"}`;
}

function projectSummaryMd(p: P.ProjectDetail): string {
  const L = [
    `# ${p.title}`,
    `- id: ${p.id} · 카테고리: ${p.category_name} (${p.category_id}) · 담당: ${p.owner_name}`,
    `- 트랙: ${p.track_label} (${p.track}) · 현재 단계: ${STAGE_LABELS[p.stage]} (${p.stage}) · 상태: ${p.status}${p.target_venue ? ` · 목표: ${p.target_venue}` : ""}${p.deadline ? ` · 마감: ${p.deadline}` : ""}`,
    `- 단계 순서: ${stageIds(p.track).map((s) => `${s}=${STAGE_LABELS[s]}`).join(" → ")}`,
    `- 기록 ${p.entry_count}건 · 완료 단계 ${p.stage_done}/${stageIds(p.track).length} · 미완료 할 일 ${p.open_tasks}건 · 검토 대기 ${p.review_requested}건`,
    p.collaborators.length ? `- 협업자: ${p.collaborators.map((c) => `${c.name} (${c.id})`).join(", ")}` : "",
  ].filter(Boolean);
  if (p.summary) L.push("", `## 연구 요약`, p.summary);
  L.push("", `## 단계별 정리`);
  for (const st of p.stages) {
    L.push(`### ${STAGE_LABELS[st.stage]} [${st.status}]${st.entry_count ? ` (기록 ${st.entry_count})` : ""}`);
    L.push(st.summary?.trim() ? st.summary.trim() : `_(미정리 · ${STAGE_HINTS[st.stage]})_`);
  }
  if (p.tasks.length) {
    L.push("", `## 할 일`);
    for (const t of p.tasks) L.push(`- [${t.status === "done" ? "x" : " "}] (${t.id}) ${t.title}${t.assignee_name ? ` @${t.assignee_name}` : ""}${t.due ? ` · ${t.due}` : ""}${t.status === "doing" ? " · 진행 중" : ""}`);
  }
  if (p.members.length) L.push("", `## 팀 구성원 (assignee_id / owner_id 로 사용)`, ...p.members.map((m) => `- ${m.name} (${m.id}${m.role === "lead" ? ", 리드" : ""})`));
  if (p.recent_entries.length) {
    L.push("", `## 최근 기록`);
    for (const e of p.recent_entries) L.push(`- ${e.date} [${STAGE_LABELS[e.stage]}] ${e.title} (${e.id}, ${e.author_name}${e.review_status !== "none" ? `, ${e.review_status}` : ""}${e.comment_count ? `, 코멘트 ${e.comment_count}` : ""})`);
  }
  return L.join("\n");
}

const TOOLS: ToolDef[] = [
  {
    name: "whoami",
    title: "내 정보와 소속·프로젝트",
    description: "현재 토큰의 사용자, 소속 카테고리(팀), 내 프로젝트 목록을 반환한다. 세션 시작 시 먼저 호출해 어느 프로젝트에 기록할지 정한다.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async (env, ctx) => {
      const m = await F.me(env, ctx);
      const L = [`사용자: ${m.user.name} (${m.user.id})${m.is_admin ? " · 관리자" : ""}`, `오늘(${env.APP_TZ}): ${todayIn(env.APP_TZ)}`];
      if (m.viewer) L.push(`⚠ 핀 열람 모드(읽기 전용): ${m.viewer.category_name} 팀만 조회 가능 · 만료 ${m.viewer.expires_at.slice(0, 16).replace("T", " ")}Z · 기록·수정 도구는 사용할 수 없다`);
      L.push(`소속 카테고리: ${m.memberships.length ? m.memberships.map((x) => `${x.category_name} (${x.category_id}, ${x.role})`).join(", ") : "없음"}`);
      L.push(`내 프로젝트 ${m.my_projects.length}건:`);
      for (const p of m.my_projects) L.push(`- ${p.title} (${p.id}) · ${STAGE_LABELS[p.stage]} · ${p.status} · 기록 ${p.entry_count}건 · 마지막 ${p.last_entry_date ?? "없음"}`);
      for (const t of Object.values(TRACKS)) L.push(`${t.label} 트랙 단계: ${t.stages.map((st) => `${st.id}=${st.label}`).join(" → ")}`);
      return { text: L.join("\n"), data: m };
    },
  },
  {
    name: "list_projects",
    title: "프로젝트 목록",
    description: "열람 가능한 프로젝트 목록(같은 카테고리 팀원 것 포함). category_id 로 팀 한정, mine=true 로 내 것만.",
    inputSchema: {
      type: "object",
      properties: {
        category_id: idProp("카테고리 ID (생략 시 소속 전체)"),
        mine: { type: "boolean", description: "내 프로젝트만" },
        status: { type: "string", enum: ["active", "paused", "done", "archived", "all"], description: "기본 active" },
        q: { type: "string", description: "제목/요약/태그 검색어" },
      },
      additionalProperties: false,
    },
    handler: async (env, ctx, a) => {
      const rows = await P.listProjects(env, ctx, { category_id: s(a.category_id), owner_id: a.mine ? ctx.user.id : undefined, status: s(a.status), q: s(a.q) });
      const text = rows.length
        ? rows.map((p) => `- ${p.title} (${p.id}) · ${p.category_name} · ${p.owner_name} · ${STAGE_LABELS[p.stage]} · ${p.status} · 기록 ${p.entry_count} · 마지막 ${p.last_entry_date ?? "-"}${p.review_requested ? ` · 검토대기 ${p.review_requested}` : ""}`).join("\n")
        : "프로젝트 없음";
      return { text, data: rows };
    },
  },
  {
    name: "get_project",
    title: "프로젝트 상세",
    description: "프로젝트의 메타·단계별 정리(논문 흐름)·할 일·최근 기록을 반환한다. 기록 전 현재 상태 파악용.",
    inputSchema: { type: "object", properties: { project_id: idProp("프로젝트 ID") }, required: ["project_id"], additionalProperties: false },
    handler: async (env, ctx, a) => {
      const p = await P.getProjectDetail(env, ctx, String(a.project_id));
      return { text: projectSummaryMd(p) + weekLines(p), data: p };
    },
  },
  {
    name: "create_project",
    title: "프로젝트(논문) 생성",
    description: "새 프로젝트(논문 또는 캡스톤)를 만든다. 트랙은 카테고리에 따라 정해진다. 사용자가 명시적으로 새 연구/프로젝트를 시작할 때만 사용.",
    inputSchema: {
      type: "object",
      properties: {
        category_id: idProp("카테고리 ID (whoami 참고)"),
        title: { type: "string", description: "논문/연구 제목" },
        summary: { type: "string", description: "연구 질문·한 줄 요약" },
        stage: { ...stageEnum, description: "시작 단계. 기본 planning. 이미 진행 중인 논문을 뒤늦게 등록할 때만 지정 (앞 단계는 완료로 표시됨)" },
        target_venue: { type: "string", description: "목표 학회/저널" },
        deadline: dateProp("마감일"),
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["category_id", "title"],
      additionalProperties: false,
    },
    handler: async (env, ctx, a) => {
      const p = await P.createProject(env, ctx, a);
      return { text: `생성됨: ${p.title} (${p.id})\n\n` + projectSummaryMd(p), data: p };
    },
  },
  {
    name: "update_project",
    title: "프로젝트 메타 수정",
    description: "제목·요약·현재 단계·상태·목표·마감·태그를 수정한다. 단계 이동은 stage 로.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: idProp("프로젝트 ID"),
        title: { type: "string" },
        summary: { type: "string" },
        stage: stageEnum,
        status: { type: "string", enum: ["active", "paused", "done", "archived"] },
        target_venue: { type: "string" },
        deadline: { type: ["string", "null"], description: "YYYY-MM-DD 또는 null(해제)" },
        tags: { type: "array", items: { type: "string" } },
        collaborators: { type: "array", items: { type: "string" }, description: "협업자 사용자 ID 목록 (전체 교체). 캡스톤 팀원 등 담당자와 같은 편집 권한" },
      },
      required: ["project_id"],
      additionalProperties: false,
    },
    handler: async (env, ctx, a) => {
      const { project_id, collaborators, ...rest } = a;
      let p = Object.keys(rest).length ? await P.updateProject(env, ctx, String(project_id), rest) : await P.getProjectDetail(env, ctx, String(project_id));
      if (collaborators !== undefined) p = await P.setCollaborators(env, ctx, String(project_id), collaborators);
      return { text: `수정됨: ${p.title} (${p.id}) · ${STAGE_LABELS[p.stage]} · ${p.status}${p.collaborators.length ? ` · 협업자 ${p.collaborators.map((c) => c.name).join(", ")}` : ""}`, data: p };
    },
  },
  {
    name: "list_evaluations",
    title: "평가·피드백 목록",
    description: "프로젝트에 대한 평가자들의 평가(루브릭 점수·피드백)와 팀 답변을 본다. 마일스톤(단계)별로 여러 평가자가 평가할 수 있다.",
    inputSchema: { type: "object", properties: { project_id: idProp("프로젝트 ID") }, required: ["project_id"], additionalProperties: false },
    handler: async (env, ctx, a) => {
      const r = await EV.listEvaluations(env, ctx, String(a.project_id));
      const max = r.rubric.reduce((x, y) => x + y.max, 0);
      const L = [`루브릭: ${r.rubric.map((x) => `${x.id}=${x.label}(0~${x.max})`).join(", ")} · 만점 ${max}`];
      for (const ev of r.evaluations) {
        L.push(`### ${ev.title} (${ev.id}) · ${STAGE_LABELS[ev.stage]} · ${ev.evaluator_name} · ${ev.created_at.slice(0, 10)}${ev.total !== null ? ` · ${ev.total}/${max}` : ""}${ev.visible ? "" : " · 초안"}`);
        if (Object.keys(ev.scores).length) L.push(Object.entries(ev.scores).map(([k, v]) => `${STAGE_LABELS[k] ?? r.rubric.find((x) => x.id === k)?.label ?? k}: ${v}`).join(" · "));
        if (ev.feedback) L.push(ev.feedback);
        if (ev.response) L.push(`> 팀 답변 (${ev.response_by_name ?? ""}): ${ev.response}`);
      }
      if (!r.evaluations.length) L.push("평가 없음");
      return { text: L.join("\n"), data: r };
    },
  },
  {
    name: "add_evaluation",
    title: "평가 작성 (리드·평가자·관리자)",
    description: "마일스톤(단계)에 대한 평가를 남긴다. scores 는 트랙 루브릭 축별 점수 {축id: 점수} (list_evaluations 로 축·만점 확인). 사용자가 평가자일 때만.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: idProp("프로젝트 ID"),
        stage: { ...stageEnum, description: "평가 대상 단계 (생략 시 현재 단계). submission_id 를 주면 무시" },
        submission_id: { type: "string", description: "보고서 제출물 ID (list_submissions 로 확인). 주면 제출물 평가로 저장되며 블라인드·초안이 되고 리드가 publish_evaluations 로 일괄 공개. 같은 평가자가 다시 쓰면 갱신" },
        title: { type: "string", description: "예: 1차 보고서 평가" },
        scores: { type: "object", description: "{축id: 점수}" },
        feedback: { type: "string", description: "피드백 (마크다운)" },
        visible: { type: "boolean", description: "false 면 초안(팀에게 비공개)" },
      },
      required: ["project_id"],
      additionalProperties: false,
    },
    handler: async (env, ctx, a) => {
      const ev = await EV.createEvaluation(env, ctx, String(a.project_id), { stage: a.stage, submission_id: a.submission_id, title: a.title, scores: a.scores, feedback: a.feedback, visible: a.visible });
      return { text: `평가 저장됨: ${ev.title} (${ev.id})${ev.total !== null ? ` · ${ev.total}/${ev.max_total}` : ""}`, data: ev };
    },
  },
  {
    name: "respond_evaluation",
    title: "평가에 팀 답변",
    description: "평가자의 피드백에 대한 팀의 답변(반영 계획·반박)을 남긴다. 담당자·협업자·리드·관리자.",
    inputSchema: { type: "object", properties: { evaluation_id: idProp("평가 ID"), response: { type: "string" } }, required: ["evaluation_id", "response"], additionalProperties: false },
    handler: async (env, ctx, a) => {
      const ev = await EV.respondEvaluation(env, ctx, String(a.evaluation_id), a.response);
      return { text: `답변 저장됨: ${ev.title}`, data: ev };
    },
  },
  {
    name: "log_progress",
    title: "연구 진행 기록 추가 (핵심)",
    description:
      "날짜별 연구 진행 기록을 남긴다. 실험을 돌리거나 문헌을 정리하거나 초고를 쓴 뒤 '무엇을 했고, 결과가 어땠고, 다음에 무엇을 할지'를 마크다운으로 기록한다. " +
      "stage 는 그 작업이 속한 논문 단계(기획/리서치/관련기법/실험결과/논문작성/검토). date 생략 시 오늘. request_review=true 면 리드에게 검토 요청.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: idProp("프로젝트 ID"),
        title: { type: "string", description: "한 줄 제목 (예: 'ResNet-50 baseline 실험 완료, acc 91.2%')" },
        content: { type: "string", description: "마크다운 본문. 권장 구성: ## 한 일 / ## 결과 / ## 다음 할 일 / ## 메모(막힌 점·질문)" },
        stage: stageEnum,
        date: dateProp("연구일"),
        request_review: { type: "boolean", description: "검토 요청 여부" },
        weekly: { type: "boolean", description: "주간 보고로 표시. 캡스톤은 카테고리 마감 요일(기본 토요일) 자정까지 주 1건. 제목 예: 3주차 주간 보고: 핵심 한 줄" },
      },
      required: ["project_id", "title", "content"],
      additionalProperties: false,
    },
    handler: async (env, ctx, a) => {
      const e = await E.createEntry(env, ctx, String(a.project_id), { title: a.title, content: a.content, stage: a.stage, date: a.date, review_status: a.request_review === true ? "requested" : undefined, weekly: a.weekly });
      return { text: `기록됨: [${e.date}] ${e.title} (${e.id}) · ${STAGE_LABELS[e.stage]}${e.week ? ` · ${e.week}주차` : ""}${e.weekly ? " · 주간 보고" : ""}${e.review_status === "requested" ? " · 검토 요청됨" : ""}`, data: e };
    },
  },
  {
    name: "list_entries",
    title: "기록 목록",
    description: "날짜별 기록을 조회한다 (본문 요약 포함). project_id 또는 category_id 로 범위 지정, since/until 로 기간.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: idProp("프로젝트 ID"),
        category_id: idProp("카테고리 ID"),
        since: dateProp("시작일"),
        until: dateProp("종료일"),
        stage: stageEnum,
        q: { type: "string", description: "제목/본문 검색어" },
        review_status: { type: "string", enum: ["none", "requested", "changes_requested", "approved"] },
        weekly: { type: "boolean", description: "주간 보고만" },
        limit: { type: "integer", minimum: 1, maximum: 200, description: "기본 30" },
        full: { type: "boolean", description: "본문 전체 포함 (기본 요약 280자)" },
      },
      additionalProperties: false,
    },
    handler: async (env, ctx, a) => {
      const rows = await E.listEntries(env, ctx, { project_id: s(a.project_id), category_id: s(a.category_id), since: s(a.since), until: s(a.until), stage: s(a.stage), q: s(a.q), review_status: s(a.review_status), weekly: a.weekly === true, limit: Number(a.limit) || 30, with_content: !!a.full });
      const text = rows.length
        ? rows.map((e) => `### ${e.date} · ${e.title} (${e.id})\n_${e.project_title} · ${STAGE_LABELS[e.stage]}${e.week ? ` · ${e.week}주차` : ""}${e.weekly ? " · 주간 보고" : ""} · ${e.author_name}${e.review_status !== "none" ? ` · ${e.review_status}` : ""}${e.comment_count ? ` · 코멘트 ${e.comment_count}` : ""}_\n${e.content}`).join("\n\n")
        : "기록 없음";
      return { text, data: rows };
    },
  },
  {
    name: "get_entry",
    title: "기록 상세(코멘트 포함)",
    description: "기록 하나의 전체 본문과 검토 코멘트를 반환한다.",
    inputSchema: { type: "object", properties: { entry_id: idProp("기록 ID") }, required: ["entry_id"], additionalProperties: false },
    handler: async (env, ctx, a) => {
      const e = await E.getEntryFull(env, ctx, String(a.entry_id));
      const L = [`# ${e.title}`, `- ${e.date} · ${e.project_title} · ${STAGE_LABELS[e.stage]} · ${e.author_name} · 검토: ${e.review_status}`, "", e.content];
      if (e.comments?.length) {
        L.push("", "## 코멘트");
        for (const c of e.comments) L.push(`- **${c.author_name}** (${c.kind}, ${c.created_at.slice(0, 16)}): ${c.content}`);
      }
      return { text: L.join("\n"), data: e };
    },
  },
  {
    name: "update_entry",
    title: "기록 수정",
    description: "내가 쓴 기록의 제목·본문·단계·날짜를 수정한다.",
    inputSchema: {
      type: "object",
      properties: { entry_id: idProp("기록 ID"), title: { type: "string" }, content: { type: "string" }, stage: stageEnum, date: dateProp("연구일"), weekly: { type: "boolean", description: "주간 보고 표시 켜기/끄기" } },
      required: ["entry_id"],
      additionalProperties: false,
    },
    handler: async (env, ctx, a) => {
      const { entry_id, ...rest } = a;
      const e = await E.updateEntry(env, ctx, String(entry_id), rest);
      return { text: `수정됨: [${e.date}] ${e.title} (${e.id})`, data: e };
    },
  },
  {
    name: "update_stage",
    title: "단계별 정리 갱신 (논문 뼈대)",
    description:
      "프로젝트의 특정 단계(기획/리서치/관련기법/실험결과/논문작성/검토)의 정리 요약(마크다운)을 갱신한다. " +
      "정리 요약은 그 단계까지의 누적 결론 = 논문 해당 절의 뼈대. 일별 기록은 log_progress, 누적 정리는 이 도구. " +
      "단계 상태(예정/진행 중/완료)는 현재 단계 위치에서 자동으로 정해지므로 직접 바꾸지 않는다. 단계를 옮기려면 advance_stage.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: idProp("프로젝트 ID"),
        stage: stageEnum,
        summary: { type: "string", description: "누적 정리(마크다운). 기존 내용을 덮어쓰므로 get_project 로 먼저 읽고 병합할 것" },
      },
      required: ["project_id", "stage", "summary"],
      additionalProperties: false,
    },
    handler: async (env, ctx, a) => {
      const p = await P.updateStage(env, ctx, String(a.project_id), String(a.stage), { summary: a.summary });
      const st = p.stages.find((x) => x.stage === a.stage)!;
      return { text: `갱신됨: ${p.title} · ${STAGE_LABELS[st.stage]} [${st.status}]${p.stage === st.stage ? " · 현재 단계" : ""}`, data: p };
    },
  },
  {
    name: "advance_stage",
    title: "다음 단계로 진행 (논문 흐름 한 칸)",
    description:
      "논문 흐름은 기획 → 리서치 → 관련기법 → 실험결과 → 논문작성 → 검토·투고 한 줄이다. to 를 생략하면 현재 단계를 완료하고 다음 단계로 넘어간다 " +
      "(마지막 단계에서는 논문 완료 처리). to 를 주면 그 단계로 이동한다 (앞 단계로 되돌리기 포함). 사용자가 '이 단계 끝났다/다음으로 넘어가자' 라고 할 때만 호출.",
    inputSchema: { type: "object", properties: { project_id: idProp("프로젝트 ID"), to: { ...stageEnum, description: "이동할 단계 (생략 시 다음 단계)" } }, required: ["project_id"], additionalProperties: false },
    handler: async (env, ctx, a) => {
      const p = await P.advanceStage(env, ctx, String(a.project_id), a.to);
      return { text: p.status === "done" ? `${p.track_noun} 완료 처리됨: ${p.title}` : `현재 단계: ${STAGE_LABELS[p.stage]} (${p.title}) · 완료 단계 ${p.stage_done}/${stageIds(p.track).length}`, data: p };
    },
  },
  {
    name: "list_tasks",
    title: "할 일 목록",
    description: "프로젝트의 할 일 목록.",
    inputSchema: { type: "object", properties: { project_id: idProp("프로젝트 ID"), status: { type: "string", enum: ["todo", "doing", "done", "all"] } }, required: ["project_id"], additionalProperties: false },
    handler: async (env, ctx, a) => {
      const rows = await T.listTasks(env, ctx, String(a.project_id), s(a.status) ?? "all");
      return { text: rows.length ? rows.map((t) => `- [${t.status === "done" ? "x" : t.status === "doing" ? "~" : " "}] ${t.title} (${t.id})${t.assignee_name ? ` @${t.assignee_name}` : ""}${t.due ? ` · ${t.due}` : ""}`).join("\n") : "할 일 없음", data: rows };
    },
  },
  {
    name: "add_task",
    title: "할 일 추가",
    description: "다음 할 일을 추가한다 (기록의 '다음 할 일'을 실제 항목으로 만들 때).",
    inputSchema: {
      type: "object",
      properties: { project_id: idProp("프로젝트 ID"), title: { type: "string" }, due: dateProp("기한"), stage: stageEnum, assignee_id: idProp("담당자 사용자 ID (기본 없음)") },
      required: ["project_id", "title"],
      additionalProperties: false,
    },
    handler: async (env, ctx, a) => {
      const t = await T.createTask(env, ctx, String(a.project_id), { title: a.title, due: a.due, stage: a.stage, assignee_id: a.assignee_id });
      return { text: `추가됨: ${t.title} (${t.id})`, data: t };
    },
  },
  {
    name: "update_task",
    title: "할 일 갱신",
    description: "할 일의 상태(todo/doing/done)·제목·기한을 바꾼다.",
    inputSchema: {
      type: "object",
      properties: { task_id: idProp("할 일 ID"), status: { type: "string", enum: ["todo", "doing", "done"] }, title: { type: "string" }, due: { type: ["string", "null"] }, assignee_id: { type: ["string", "null"] } },
      required: ["task_id"],
      additionalProperties: false,
    },
    handler: async (env, ctx, a) => {
      const { task_id, ...rest } = a;
      const t = await T.updateTask(env, ctx, String(task_id), rest);
      return { text: `갱신됨: ${t.title} [${t.status}]`, data: t };
    },
  },
  {
    name: "add_comment",
    title: "코멘트(검토 의견) 추가",
    description: "팀원의 기록에 코멘트를 남긴다. 리드/관리자는 kind=approve|request_changes 로 승인·수정요청 가능.",
    inputSchema: {
      type: "object",
      properties: { entry_id: idProp("기록 ID"), content: { type: "string" }, kind: { type: "string", enum: ["comment", "approve", "request_changes"] } },
      required: ["entry_id", "content"],
      additionalProperties: false,
    },
    handler: async (env, ctx, a) => {
      const c = await E.addComment(env, ctx, String(a.entry_id), a.content, a.kind ?? "comment");
      return { text: `코멘트 추가됨 (${c.id}, ${c.kind})`, data: c };
    },
  },
  {
    name: "set_review",
    title: "검토 상태 변경",
    description: "기록의 검토 상태를 바꾼다. 작성자: requested(검토 요청)/none(취소). 리드·관리자: approved/changes_requested (note 는 코멘트로 남음).",
    inputSchema: {
      type: "object",
      properties: { entry_id: idProp("기록 ID"), status: { type: "string", enum: ["none", "requested", "changes_requested", "approved"] }, note: { type: "string" } },
      required: ["entry_id", "status"],
      additionalProperties: false,
    },
    handler: async (env, ctx, a) => {
      const e = await E.setReviewStatus(env, ctx, String(a.entry_id), a.status, a.note);
      return { text: `검토 상태: ${e.title} → ${e.review_status}`, data: e };
    },
  },
  {
    name: "list_notices",
    title: "공지 읽기",
    description: "관리자·리드가 올린 공지(전체 공지 + 소속 팀 공지)를 읽는다. 발표 준비 요령·제출 형식·일정 같은 수업/연구실 안내가 여기 있으므로 세션 시작 시 한 번 읽고, 기록·발표 준비를 도울 때 공지의 요구사항을 따른다. category_id 로 한 팀만.",
    inputSchema: { type: "object", properties: { category_id: idProp("카테고리 ID (생략 시 전체 공지 + 소속 팀 전체)"), limit: { type: "integer", minimum: 1, maximum: 200, description: "기본 20" } }, additionalProperties: false },
    handler: async (env, ctx, a) => {
      const rows = await N.listNotices(env, ctx, { category_id: s(a.category_id), limit: a.limit ?? 20 });
      return { text: N.noticesMarkdown(rows), data: { notices: rows } };
    },
  },
  {
    name: "post_notice",
    title: "공지 올리기 (관리자·리드)",
    description: "팀 공지(category_id 지정: 관리자 또는 그 팀 리드) 또는 전체 공지(category_id 생략: 관리자만)를 올린다. 본문은 마크다운. 사용자가 명시적으로 공지를 올리라고 했을 때만 호출.",
    inputSchema: {
      type: "object",
      properties: { category_id: idProp("팀(카테고리) ID. 생략 시 전체 공지"), title: { type: "string", maxLength: 200 }, content: { type: "string", description: "마크다운 본문" }, pinned: { type: "boolean", description: "상단 고정" } },
      required: ["title", "content"],
      additionalProperties: false,
    },
    handler: async (env, ctx, a) => {
      const n = await N.createNotice(env, ctx, { category_id: s(a.category_id), title: a.title, content: a.content, pinned: a.pinned });
      return { text: `공지를 올렸습니다: ${n.title} (${n.id}) · ${n.category_name ?? "전체 공지"}${n.pinned ? " · 고정" : ""}`, data: n };
    },
  },
  {
    name: "team_feed",
    title: "팀 활동 피드",
    description: "같은 카테고리 팀원들의 최근 활동(기록·코멘트·단계 변경)을 본다. 팀 상황 파악·검토할 것 찾기.",
    inputSchema: { type: "object", properties: { category_id: idProp("카테고리 ID (생략 시 소속 전체)"), limit: { type: "integer", minimum: 1, maximum: 200 } }, additionalProperties: false },
    handler: async (env, ctx, a) => {
      const rows = await F.feed(env, ctx, { category_id: s(a.category_id), limit: a.limit ?? 40 });
      return { text: rows.length ? rows.map((r) => `- ${r.at.slice(0, 16).replace("T", " ")} ${r.actor_name ?? "?"} · ${r.action} · ${r.project_title ?? ""} · ${r.summary}${r.source === "mcp" ? " (AI)" : ""}`).join("\n") : "활동 없음", data: rows };
    },
  },
  {
    name: "team_overview",
    title: "팀(카테고리) 현황",
    description: "카테고리의 구성원(사용자 ID 포함)·프로젝트·검토 대기 목록·최근 활동을 한 번에 본다.",
    inputSchema: { type: "object", properties: { category_id: idProp("카테고리 ID") }, required: ["category_id"], additionalProperties: false },
    handler: async (env, ctx, a) => {
      const d = await F.categoryDetail(env, ctx, String(a.category_id));
      const L = [`# ${(d.category as { name: string }).name}`, `구성원: ${(d.members as { id: string; name: string; role: string }[]).map((m) => `${m.name} (id=${m.id}, ${m.role})`).join(", ")}`, "", "## 프로젝트"];
      for (const p of d.projects) L.push(`- ${p.title} (${p.id}) · ${p.owner_name} · ${STAGE_LABELS[p.stage]} · ${p.status} · 마지막 ${p.last_entry_date ?? "-"}`);
      if (d.review_queue.length) {
        L.push("", "## 검토 대기");
        for (const e of d.review_queue) L.push(`- ${e.date} ${e.title} (${e.id}) · ${e.project_title} · ${e.author_name}`);
      }
      return { text: L.join("\n"), data: d };
    },
  },
  {
    name: "weekly_status",
    title: "주차별 보고 현황 (팀 × 주차)",
    description: "카테고리(팀)의 프로젝트 × 주차 격자로 주간 보고(weekly=true) 제출 여부를 본다. 이번 주 마감·제출 수·미제출 프로젝트 포함. 카테고리에 1주차 시작일이 설정돼 있어야 한다.",
    inputSchema: { type: "object", properties: { category_id: idProp("카테고리 ID") }, required: ["category_id"], additionalProperties: false },
    handler: async (env, ctx, a) => {
      const d = await W.weeklyStatus(env, ctx, String(a.category_id));
      if (!d.enabled) return { text: "이 카테고리는 주차 설정(1주차 시작일)이 없습니다. 관리자가 카테고리 설정에서 정하면 사용할 수 있습니다.", data: d };
      const L = [`# 주차별 보고 현황 · 오늘 ${d.today} = ${d.current_week >= 1 ? `${d.current_week}주차` : "학기 시작 전"}`];
      if (d.current) L.push(`이번 주(${d.current.n}주차 ${d.current.start}~${d.current.due}) 마감 ${d.current.due} 자정 · 제출 ${d.current.submitted}/${d.current.total}${d.current.missing.length ? ` · 미제출: ${d.current.missing.map((m) => m.title).join(", ")}` : ""}`);
      L.push("", "| 프로젝트 | " + d.weeks.map((w) => `${w.n}주`).join(" | ") + " | 제출 | 누락 |", "|---|" + d.weeks.map(() => "---").join("|") + "|---|---|");
      for (const p of d.projects) L.push(`| ${p.title} (${p.id}) | ` + p.cells.map((c, i) => (c.weekly ? "✓" : c.entries ? "·" : d.weeks[i].past ? "✗" : " ")).join(" | ") + ` | ${p.submitted} | ${p.missed} |`);
      L.push("", "✓ 주간 보고 제출 · ✗ 미제출(지난 주차) · '·' 일반 기록만 있음 · 빈칸 아직 아님");
      return { text: L.join("\n"), data: d };
    },
  },
  {
    name: "list_submissions",
    title: "보고서 제출·평가 현황 (캡스톤)",
    description: "project_id 를 주면 그 프로젝트의 마일스톤(1차·중간·최종)별 마감·제출 버전·평가 요약을, category_id 를 주면 팀 × 마일스톤 현황표를 본다. 평가자는 자기 평가만, 학생은 공개된 평가만 보인다.",
    inputSchema: { type: "object", properties: { project_id: idProp("프로젝트 ID"), category_id: idProp("카테고리 ID") }, additionalProperties: false },
    handler: async (env, ctx, a) => {
      if (a.project_id) {
        const d = await SB.listForProject(env, ctx, String(a.project_id));
        if (!d.enabled) return { text: "이 트랙에는 보고서 제출 마일스톤이 없습니다.", data: d };
        const L = [`# 보고서 제출·평가 (오늘 ${d.today})`];
        for (const m of d.milestones) {
          const latest = d.submissions.find((s) => s.milestone === m.id);
          const sm = d.summary[m.id];
          L.push(`- **${m.label}** (${m.id}) · 마감 ${m.due ?? "없음"}${m.passed ? " (지남)" : ""}${m.overridden ? " · 카테고리 설정" : ""} · ${latest ? `제출 v${latest.version} ${latest.created_at.slice(0, 10)}${latest.late ? " 지각" : ""} (submission_id=${latest.id})` : "미제출"} · 평가 ${sm?.count ?? 0}건${sm?.avg_total !== null && sm?.avg_total !== undefined ? ` 평균 ${sm.avg_total}/${d.max_total}` : ""}${sm?.published ? " · 공개됨" : sm?.count ? " · 비공개" : ""}`);
        }
        if (d.evaluations.length) {
          L.push("", "## 평가");
          for (const e of d.evaluations) L.push(`- [${e.milestone}] ${e.title} · ${e.evaluator_name} · ${e.total ?? "-"}/${d.max_total} · ${e.visible ? "공개" : "초안"} (${e.id})${e.feedback ? `\n  ${e.feedback.slice(0, 200).replace(/\n/g, " ")}` : ""}`);
        }
        return { text: L.join("\n"), data: d };
      }
      if (!a.category_id) return { text: "project_id 또는 category_id 를 지정하세요", data: null };
      const d = await SB.categoryStatus(env, ctx, String(a.category_id));
      if (!d.enabled) return { text: "이 카테고리 트랙에는 보고서 제출 마일스톤이 없습니다.", data: d };
      const L = [`# 보고서 제출 현황 (오늘 ${d.today})`, "", "| 프로젝트 | " + d.milestones.map((m) => `${m.label} (마감 ${m.due ?? "-"})`).join(" | ") + " |", "|---|" + d.milestones.map(() => "---").join("|") + "|"];
      for (const p of d.projects) L.push(`| ${p.title} | ` + d.milestones.map((m) => { const c = p.cells[m.id]; return `${c.submission ? `v${c.submission.version} ${c.submission.created_at.slice(5, 10)}${c.submission.late ? " 지각" : ""}` : "미제출"} · 평가 ${c.visible_count}/${c.eval_count}${c.avg_total !== null ? ` 평균 ${c.avg_total}` : ""}`; }).join(" | ") + " |");
      L.push("", "공개 상태: " + d.milestones.map((m) => `${m.label} ${d.publish[m.id].published ? "공개" : `비공개(${d.publish[m.id].visible}/${d.publish[m.id].total})`}`).join(" · "));
      return { text: L.join("\n"), data: d };
    },
  },
  {
    name: "evaluation_summary",
    title: "보고서 평가 점수표 (리드·관리자)",
    description: "카테고리의 마일스톤 하나에 대해 프로젝트 × 평가자 점수표와 프로젝트별 평균·표준편차를 본다. CSV 는 웹 팀 페이지 [보고서] 탭에서 내려받는다.",
    inputSchema: { type: "object", properties: { category_id: idProp("카테고리 ID"), milestone: { type: "string", description: "report1 | report2 | final" } }, required: ["category_id", "milestone"], additionalProperties: false },
    handler: async (env, ctx, a) => {
      const s = await SB.evaluationSummary(env, ctx, String(a.category_id), a.milestone);
      const L = [`# ${s.milestone.label} 점수표 · 마감 ${s.milestone.due ?? "-"} · 평가자 ${s.evaluators.map((e) => `${e.name}(${e.n})`).join(", ") || "없음"}`, "", "| 프로젝트 | 평가자 | " + s.rubric.map((x) => `${x.label}(${x.max})`).join(" | ") + ` | 합계(${s.max_total}) | 공개 |`, "|---|---|" + s.rubric.map(() => "---").join("|") + "|---|---|"];
      for (const r of s.rows) L.push(`| ${r.project_title} | ${r.evaluator_name} | ` + s.rubric.map((x) => r.scores[x.id] ?? "-").join(" | ") + ` | ${r.total ?? "-"} | ${r.visible ? "Y" : "N"} |`);
      L.push("", "| 프로젝트 | 평가 수 | " + s.rubric.map((x) => `${x.label} 평균`).join(" | ") + " | 평균 | 표준편차 | 제출 |", "|---|---|" + s.rubric.map(() => "---").join("|") + "|---|---|---|");
      for (const p of s.projects) L.push(`| ${p.title} | ${p.n} | ` + s.rubric.map((x) => p.axis_avg[x.id] ?? "-").join(" | ") + ` | ${p.avg_total ?? "-"} | ${p.stdev ?? "-"} | ${p.submitted ? "Y" : "N"} |`);
      return { text: L.join("\n"), data: s };
    },
  },
  {
    name: "publish_evaluations",
    title: "보고서 평가 일괄 공개/비공개 (리드·관리자)",
    description: "마일스톤의 제출물 평가를 팀에게 한꺼번에 공개(또는 다시 비공개)한다. 평가자 이름은 학생에게 익명으로 보인다.",
    inputSchema: { type: "object", properties: { category_id: idProp("카테고리 ID"), milestone: { type: "string", description: "report1 | report2 | final" }, visible: { type: "boolean", description: "기본 true (공개). false 면 비공개로 되돌림" } }, required: ["category_id", "milestone"], additionalProperties: false },
    handler: async (env, ctx, a) => {
      const r = await SB.publishEvaluations(env, ctx, String(a.category_id), a.milestone, a.visible);
      return { text: `${r.milestone} 평가 ${r.visible ? "공개" : "비공개"} 처리: ${r.changed}건`, data: r };
    },
  },
  {
    name: "list_teams",
    title: "팀 로비 (전체 팀 목록·가입 상태)",
    description: "연구실의 모든 팀(카테고리)과 구성원·활동 요약, 나의 소속/가입 요청 상태를 본다. 소속 팀이 없거나 다른 팀에 참여하고 싶을 때.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async (env, ctx) => {
      const rows = await TM.lobby(env, ctx);
      const pol: Record<string, string> = { open: "즉시 가입", approval: "승인 후 가입", closed: "초대만" };
      const text = rows.length
        ? rows.map((t) => `- ${t.name} (${t.id}) · ${pol[t.join_policy] ?? t.join_policy} · 구성원 ${t.member_count}${t.lead_names ? ` · 리드 ${t.lead_names}` : ""} · 진행 중 ${t.active_projects} · 이번 주 기록 ${t.entries_7d}${t.my_role ? ` · 나: ${t.my_role}` : t.my_request_status === "pending" ? " · 나: 가입 요청 대기" : ""}${t.description ? `\n  ${t.description.slice(0, 120)}` : ""}`).join("\n")
        : "팀 없음";
      return { text, data: { teams: rows } };
    },
  },
  {
    name: "join_team",
    title: "팀 가입 / 가입 요청",
    description: "팀에 가입한다. 정책이 open 이면 즉시 가입, approval 이면 리드 승인 요청이 만들어진다. 팀 ID 는 category_id 인자로 넘긴다 (list_teams 결과의 id). 사용자가 명시적으로 원할 때만 호출.",
    inputSchema: { type: "object", properties: { category_id: idProp("팀(카테고리) ID. list_teams 결과의 id 값"), message: { type: "string", description: "리드에게 보낼 메시지 (선택)" }, role: { type: "string", enum: ["lead", "member"], description: "관리자만: 구성원 목록에 올릴 역할 (기본 lead)" } }, required: ["category_id"], additionalProperties: false },
    handler: async (env, ctx, a) => {
      const r = await TM.joinTeam(env, ctx, String(a.category_id), a.message, a.role);
      return { text: r.joined ? `${r.category_name} 에 가입했습니다` : `${r.category_name} 가입 요청을 보냈습니다 (리드 승인 대기)`, data: r };
    },
  },
  {
    name: "search",
    title: "검색",
    description: "프로젝트·기록을 검색한다.",
    inputSchema: { type: "object", properties: { q: { type: "string" }, category_id: idProp("카테고리 ID") }, required: ["q"], additionalProperties: false },
    handler: async (env, ctx, a) => {
      const r = await F.search(env, ctx, a.q, s(a.category_id));
      const L = [`프로젝트 ${r.projects.length}건`, ...r.projects.map((p) => `- ${p.title} (${p.id})`), `기록 ${r.entries.length}건`, ...r.entries.map((e) => `- ${e.date} ${e.title} (${e.id}) · ${e.project_title}`)];
      return { text: L.join("\n"), data: r };
    },
  },
  {
    name: "get_report",
    title: "진행 보고서 (마크다운)",
    description: "프로젝트의 진행 보고서를 마크다운으로 생성한다 (단계별 정리 + 날짜별 기록 + 코멘트). 주간 보고·미팅 준비용.",
    inputSchema: {
      type: "object",
      properties: { project_id: idProp("프로젝트 ID"), from: dateProp("시작일"), to: dateProp("종료일"), format: { type: "string", enum: ["markdown", "json"] } },
      required: ["project_id"],
      additionalProperties: false,
    },
    handler: async (env, ctx, a) => {
      const r = await R.projectReport(env, ctx, String(a.project_id), a.format === "json" ? "json" : "md", { from: s(a.from), to: s(a.to) });
      if (r.type === "md") return { text: r.text };
      if (r.type === "json") return { text: "(structuredContent 에 JSON 보고서 데이터가 있습니다)", data: r.data };
      return { text: r.html };
    },
  },
];

const PROMPTS = [
  {
    name: "log_today",
    title: "오늘 연구 기록 남기기",
    description: "지금까지의 대화/작업 내용을 바탕으로 오늘의 연구 진행 기록을 작성해 log_progress 로 저장한다.",
    arguments: [{ name: "project_id", description: "프로젝트 ID (생략 시 whoami 로 고른다)", required: false }],
    build: (a: Record<string, string>) =>
      `오늘 이 세션에서 수행한 연구 작업을 연구노트에 기록해 주세요.\n` +
      `1) ${a.project_id ? `project_id=${a.project_id} 의 get_project` : "whoami → 적절한 프로젝트 선택 후 get_project"} 로 현재 상태를 확인.\n` +
      `2) 아래 형식으로 마크다운 본문을 작성해 log_progress 호출:\n## 한 일\n## 결과 (수치·표·그림 설명)\n## 다음 할 일\n## 메모 (막힌 점·질문)\n` +
      `3) 단계(stage)는 작업 성격에 맞게 고르고, 누적 결론이 바뀌었으면 update_stage 로 해당 단계 정리를 갱신.\n4) '다음 할 일'은 add_task 로도 등록.`,
  },
  {
    name: "weekly_review",
    title: "주간 정리·보고",
    description: "최근 7일 기록을 모아 주간 보고 초안을 만든다.",
    arguments: [{ name: "project_id", description: "프로젝트 ID", required: true }],
    build: (a: Record<string, string>) =>
      `project_id=${a.project_id} 의 최근 7일 기록(list_entries since=7일 전)과 get_project 를 읽고, ` +
      `(1) 이번 주 진행 요약 (2) 핵심 결과 (3) 막힌 점 (4) 다음 주 계획 을 담은 주간 보고 초안을 작성하세요. ` +
      `초안이 확정되면 해당 단계로 log_progress 에 저장하고 request_review=true 로 검토를 요청하세요. ` +
      `캡스톤 트랙(get_project 에 주차 절이 있으면)은 weekly=true 로 저장하고 제목을 'N주차 주간 보고: 핵심 한 줄' 로 하세요.`,
  },
  {
    name: "research_note_guide",
    title: "연구노트 사용 지침",
    description: "AI 도구가 연구노트를 어떻게 활용해야 하는지에 대한 전체 지침 (스킬).",
    arguments: [],
    build: () => SKILL_MD,
  },
];

function rpcError(id: unknown, code: number, message: string, data?: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

/** inputSchema(최상위 properties) 기준 간단 검증: required · type · enum. 오류 문자열 배열 반환 */
function validateArgs(schema: Record<string, unknown>, args: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = (schema.required ?? []) as string[];
  for (const k of required) if (args[k] === undefined || args[k] === null || args[k] === "") errors.push(`필수 인자 누락: ${k}`);
  const typeOk = (t: string, v: unknown) =>
    t === "string" ? typeof v === "string" : t === "boolean" ? typeof v === "boolean" : t === "integer" ? Number.isInteger(v) : t === "number" ? typeof v === "number" : t === "array" ? Array.isArray(v) : t === "null" ? v === null : t === "object" ? typeof v === "object" && v !== null : true;
  for (const [k, v] of Object.entries(args)) {
    const p = props[k];
    if (!p) {
      if (schema.additionalProperties === false) errors.push(`알 수 없는 인자: ${k}`);
      continue;
    }
    if (v === undefined) continue;
    const types = Array.isArray(p.type) ? (p.type as string[]) : p.type ? [p.type as string] : [];
    if (types.length && !types.some((t) => typeOk(t, v))) errors.push(`${k} 는 ${types.join("|")} 이어야 합니다 (받은 값: ${JSON.stringify(v).slice(0, 60)})`);
    if (Array.isArray(p.enum) && !(p.enum as unknown[]).includes(v)) errors.push(`${k} 값은 ${(p.enum as unknown[]).join(" | ")} 중 하나여야 합니다`);
    if (typeof p.pattern === "string" && typeof v === "string" && !new RegExp(p.pattern).test(v)) errors.push(`${k} 형식이 올바르지 않습니다 (${p.description ?? p.pattern})`);
  }
  return errors;
}

async function handleOne(req: JsonRpcRequest, env: Env, ctx: AuthContext): Promise<unknown | null> {
  const { id, method } = req;
  const params: Record<string, unknown> = req.params && typeof req.params === "object" ? req.params : {};
  const isNotification = id === undefined;
  // 알림(id 없음)은 응답하지 않는다 — 규격상 실행 결과를 돌려줄 수 없으므로 상태 변경 도구도 실행하지 않는다
  if (isNotification) return null;
  try {
    switch (method) {
      case "initialize": {
        const requested = String(params.protocolVersion ?? "");
        const protocolVersion = SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0];
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion,
            capabilities: { tools: { listChanged: false }, prompts: { listChanged: false }, resources: { listChanged: false, subscribe: false }, logging: {} },
            serverInfo: { name: SERVER_NAME, title: env.APP_NAME, version: SERVER_VERSION },
            instructions: (ctx.viewer ? `⚠ 이 토큰은 핀 열람 세션(읽기 전용)이다: ${ctx.viewer.category_name} 팀의 프로젝트·기록·평가를 조회만 할 수 있고 log_progress 등 쓰기 도구는 거부된다.\n\n` : "") + SKILL_SHORT.replace("{{USER}}", ctx.user.name).replace("{{TODAY}}", todayIn(env.APP_TZ)),
          },
        };
      }
      case "notifications/initialized":
      case "notifications/cancelled":
      case "notifications/progress":
      case "notifications/roots/list_changed":
        return null;
      case "ping":
        return { jsonrpc: "2.0", id, result: {} };
      case "logging/setLevel":
        return { jsonrpc: "2.0", id, result: {} };
      case "tools/list":
        return { jsonrpc: "2.0", id, result: { tools: TOOLS.map(({ name, title, description, inputSchema }) => ({ name, title, description, inputSchema })) } };
      case "tools/call": {
        const name = String(params.name ?? "");
        const tool = TOOLS.find((t) => t.name === name);
        if (!tool) return rpcError(id, -32602, `알 수 없는 도구: ${name}`);
        const args = (params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments) ? params.arguments : {}) as Record<string, unknown>;
        const problems = validateArgs(tool.inputSchema, args);
        if (problems.length) return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `인자 오류 (${tool.name}):\n- ${problems.join("\n- ")}` }], isError: true } };
        if (ctx.viewer && !READONLY_TOOLS.has(tool.name)) return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `오류: 핀 열람 모드(읽기 전용)에서는 ${tool.name} 을(를) 사용할 수 없습니다. 조회 도구(${[...READONLY_TOOLS].join(", ")})만 가능합니다` }], isError: true } };
        try {
          const r = await tool.handler(env, ctx, args);
          const result: Record<string, unknown> = { content: [{ type: "text", text: r.text }] };
          if (r.data !== undefined && r.data !== null && typeof r.data === "object" && !Array.isArray(r.data)) result.structuredContent = r.data;
          return { jsonrpc: "2.0", id, result };
        } catch (err) {
          const msg = err instanceof HttpError ? `${err.message} (${err.code})` : err instanceof Error ? err.message : String(err);
          return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `오류: ${msg}` }], isError: true } };
        }
      }
      case "prompts/list":
        return { jsonrpc: "2.0", id, result: { prompts: PROMPTS.map(({ name, title, description, arguments: args }) => ({ name, title, description, arguments: args })) } };
      case "prompts/get": {
        const name = String(params.name ?? "");
        const p = PROMPTS.find((x) => x.name === name);
        if (!p) return rpcError(id, -32602, `알 수 없는 프롬프트: ${name}`);
        const args = (params.arguments && typeof params.arguments === "object" ? params.arguments : {}) as Record<string, string>;
        const missing = p.arguments.filter((a) => a.required && !args[a.name]).map((a) => a.name);
        if (missing.length) return rpcError(id, -32602, `필수 인자 누락: ${missing.join(", ")}`);
        return { jsonrpc: "2.0", id, result: { description: p.description, messages: [{ role: "user", content: { type: "text", text: p.build(args) } }] } };
      }
      case "resources/list":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            resources: [
              { uri: "research-note://guide", name: "연구노트 사용 지침 (SKILL.md)", mimeType: "text/markdown", description: "AI 도구용 연구노트 활용 지침" },
              { uri: "research-note://me", name: "내 정보·프로젝트", mimeType: "application/json" },
            ],
          },
        };
      case "resources/templates/list":
        return { jsonrpc: "2.0", id, result: { resourceTemplates: [{ uriTemplate: "research-note://project/{project_id}", name: "프로젝트 상세(마크다운)", mimeType: "text/markdown" }] } };
      case "resources/read": {
        const uri = String(params.uri ?? "");
        if (uri === "research-note://guide") return { jsonrpc: "2.0", id, result: { contents: [{ uri, mimeType: "text/markdown", text: SKILL_MD }] } };
        if (uri === "research-note://me") return { jsonrpc: "2.0", id, result: { contents: [{ uri, mimeType: "application/json", text: j(await F.me(env, ctx)) }] } };
        const m = uri.match(/^research-note:\/\/project\/([^/]+)$/);
        if (m) {
          try {
            const p = await P.getProjectDetail(env, ctx, m[1]);
            return { jsonrpc: "2.0", id, result: { contents: [{ uri, mimeType: "text/markdown", text: projectSummaryMd(p) }] } };
          } catch (err) {
            if (err instanceof HttpError && (err.status === 404 || err.status === 403)) return rpcError(id, -32002, `리소스를 찾을 수 없습니다: ${uri} (${err.message})`);
            throw err;
          }
        }
        return rpcError(id, -32002, `리소스를 찾을 수 없습니다: ${uri}`);
      }
      case "completion/complete":
        return { jsonrpc: "2.0", id, result: { completion: { values: [], hasMore: false } } };
      default:
        if (isNotification) return null;
        return rpcError(id, -32601, `지원하지 않는 메서드: ${method}`);
    }
  } catch (err) {
    if (isNotification) return null;
    const msg = err instanceof HttpError ? err.message : err instanceof Error ? err.message : String(err);
    return rpcError(id, err instanceof HttpError && err.status === 403 ? -32003 : -32603, msg);
  }
}

const MCP_HEADERS = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...CORS_HEADERS };

export async function handleMcp(request: Request, env: Env): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method === "GET") {
    // 브라우저로 열었을 때 안내
    const accept = request.headers.get("accept") || "";
    if (accept.includes("text/event-stream")) return new Response(null, { status: 405, headers: { Allow: "POST, DELETE", ...CORS_HEADERS } });
    return new Response(
      JSON.stringify({ name: SERVER_NAME, version: SERVER_VERSION, transport: "streamable-http", hint: "MCP 클라이언트에서 이 URL 을 POST 로 사용하고 Authorization: Bearer <토큰> 헤더를 붙이세요. 지침: /SKILL.md" }, null, 2),
      { status: 200, headers: MCP_HEADERS }
    );
  }
  if (method === "DELETE") return new Response(null, { status: 200, headers: CORS_HEADERS });
  if (method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST, GET, DELETE", ...CORS_HEADERS } });

  let ctx: AuthContext;
  try {
    ctx = await authenticate(request, env, "mcp");
  } catch (err) {
    if (err instanceof HttpError && err.status === 401) {
      return new Response(JSON.stringify(rpcError(null, -32001, err.message)), { status: 401, headers: { ...MCP_HEADERS, "WWW-Authenticate": `Bearer realm="research-note", error="invalid_token"` } });
    }
    // 인증 중 내부 오류(D1 등)는 401 로 위장하지 않는다
    console.error("mcp auth error", err);
    return new Response(JSON.stringify(rpcError(null, -32603, "서버 내부 오류 (인증 처리 실패)")), { status: 500, headers: MCP_HEADERS });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify(rpcError(null, -32700, "JSON 파싱 실패")), { status: 400, headers: MCP_HEADERS });
  }
  const batch = Array.isArray(body);
  const reqs = (batch ? body : [body]) as JsonRpcRequest[];
  if (!reqs.length || reqs.some((r) => !r || typeof r !== "object" || typeof r.method !== "string")) {
    return new Response(JSON.stringify(rpcError(null, -32600, "잘못된 JSON-RPC 요청")), { status: 400, headers: MCP_HEADERS });
  }
  const results = (await Promise.all(reqs.map((r) => handleOne(r, env, ctx)))).filter((x) => x !== null);
  if (!results.length) return new Response(null, { status: 202, headers: CORS_HEADERS });
  return new Response(JSON.stringify(batch ? results : results[0]), { status: 200, headers: MCP_HEADERS });
}
