import { state, get, post, h, mount, pill, avatar, stages, stageLabel, fmtRel, fmtDT, daysSince, openReport, downloadFile, input, textarea, select, field, modal, daysAgo, today, toast, errToast, STATUS_LABEL } from "../core.js";
import { projectCard, feedList, newProjectDialog } from "./home.js";
import { teamNoticeView, pinnedStrip } from "./notices.js";
import { DOW, shortDate } from "../week.js";

export async function render(container, categoryId, query) {
  mount(container, h("div.loading", h("span.spinner"), " 불러오는 중…"));
  const [detail, board, notices] = await Promise.all([get(`/api/categories/${categoryId}`), get(`/api/categories/${categoryId}/board`), get(`/api/notices?category_id=${encodeURIComponent(categoryId)}&limit=50`).catch(() => [])]);
  const cat = detail.category;
  const view = query.view || "board";
  const me = state.me;

  const viewSeg = h("div.seg");
  const jrCount = (detail.join_requests || []).length;
  const weeklyTab = cat.week_start || cat.track === "capstone" ? [["weekly", "주차별"]] : [];
  const reportsTab = cat.track === "capstone" ? [["reports", "보고서"]] : [];
  for (const [k, l] of [["board", "보드"], ["list", "목록"], ...weeklyTab, ...reportsTab, ["notices", `공지${notices.length ? " " + notices.length : ""}`], ["members", `구성원${jrCount ? " · 가입 요청 " + jrCount : ""}`], ["review", `검토 대기${detail.review_queue.length ? " " + detail.review_queue.length : ""}`], ["feed", "활동"]]) {
    viewSeg.append(h("button", { class: view === k ? "active" : "", onclick: () => (location.hash = `#/team/${categoryId}?view=${k}`) }, l));
  }

  const header = h("header.hero", { style: { padding: "22px 0 18px" } },
    h("div.eyebrow", `팀 · ${detail.category.track === "capstone" ? "캡스톤 트랙" : "논문 트랙"} · 내 역할: ${detail.my_role === "admin" ? "관리자" : detail.my_role === "lead" ? "리드" : detail.my_role === "evaluator" ? "평가자" : detail.my_role === "viewer" ? "열람자 (읽기 전용)" : "구성원"}`, cat.is_public ? [" · ", pill(cat.pin_set ? "공개 열람 · 핀" : "공개 (핀 미설정)", "ok sm")] : null),
    h("div.row.between.top",
      h("div", h("h1", cat.name), cat.description ? h("p.sub", cat.description) : null),
      h("div.row",
        h("button.btn", { onclick: () => reportDialog(categoryId, cat.name) }, "팀 보고서"),
        detail.my_role !== "evaluator" && detail.my_role !== "viewer" ? h("button.btn.primary", { onclick: () => newProjectDialog(me, categoryId, cat.name) }, "+ 새 프로젝트") : null,
      ),
    ),
    h("div.row", { style: { marginTop: "14px" } }, viewSeg, h("span.spacer"),
      h("span.small.muted", `구성원 ${detail.members.length} · 진행 중 ${detail.projects.filter((p) => p.status === "active").length} · 전체 ${detail.projects.length}`)),
  );

  let body;
  if (view === "board") body = renderBoard(board);
  else if (view === "list") body = renderList(detail.projects);
  else if (view === "members") body = renderMembers(detail, categoryId, container, query);
  else if (view === "review") body = renderReview(detail.review_queue);
  else if (view === "weekly") body = await renderWeekly(categoryId);
  else if (view === "reports") body = await renderReportStatus(categoryId, container, query);
  else if (view === "notices") body = await teamNoticeView(detail, categoryId);
  else body = h("div.card", feedList(detail.activity));

  mount(container, header, view === "notices" ? null : pinnedStrip(notices, categoryId), body);
}

// ---------- 보고서 제출·평가 현황 (캡스톤) ----------
async function renderReportStatus(categoryId, container, query) {
  const d = await get(`/api/categories/${categoryId}/submissions`);
  if (!d.enabled) return h("div.empty", "이 트랙에는 보고서 제출 마일스톤이 없습니다.");
  const refresh = () => render(container, categoryId, { ...query, view: "reports" });
  const head = h("div.row", { style: { flexWrap: "wrap", gap: "10px", marginBottom: "14px" } }, d.milestones.map((m) => {
    const pb = d.publish[m.id];
    return h("div.rep-ms",
      h("div.row", { style: { gap: "8px" } }, h("b", m.label), m.passed ? pill("마감 지남", "mute sm") : null),
      h("div.tiny.muted", m.due ? `마감 ${shortDate(m.due)} 24:00${m.overridden ? " · 변경됨" : " · 주차 기본"}` : "마감 없음"),
      d.is_lead ? h("div.row", { style: { gap: "6px", marginTop: "6px", flexWrap: "wrap" } },
          pill(pb.published ? `공개됨 ${pb.total}건` : pb.total ? `비공개 ${pb.visible}/${pb.total}` : "평가 없음", pb.published ? "ok sm" : "mute sm"),
          pb.total ? h("button.btn.xs" + (pb.published ? "" : ".primary"), { onclick: async () => { try { await post(`/api/categories/${categoryId}/evaluations/publish`, { milestone: m.id, visible: !pb.published }); toast(pb.published ? "비공개로 돌렸습니다" : "팀에게 공개했습니다"); refresh(); } catch (e) { errToast(e); } } }, pb.published ? "비공개로" : "일괄 공개") : null,
          h("button.btn.xs", { onclick: () => downloadFile(`/api/categories/${categoryId}/evaluations/summary?milestone=${m.id}&format=csv`, `${m.id}_scores.csv`) }, "점수표 CSV"))
        : null);
  }));
  const thead = h("thead", h("tr", h("th", "프로젝트"), ...d.milestones.map((m) => h("th", m.label))));
  const tbody = h("tbody", d.projects.map((p) => h("tr",
    h("td", h("a", { href: `#/project/${p.id}?tab=reports` }, p.title), h("div.tiny.muted", p.owner_name)),
    ...d.milestones.map((m) => {
      const c = p.cells[m.id];
      const sub = c.submission
        ? h("div.row", { style: { gap: "6px", flexWrap: "wrap" } }, h("a", { href: `#/project/${p.id}?tab=reports` }, `v${c.submission.version}`), h("span.tiny.muted", shortDate(c.submission.created_at.slice(0, 10))), c.submission.late ? pill("지각", "warn sm") : pill("제출", "ok sm"))
        : h("span.tiny.muted", m.passed ? "미제출" : "—");
      const ev = d.is_lead
        ? h("div.tiny.muted", { style: { marginTop: "3px" } }, c.eval_count ? `평가 ${c.visible_count}/${c.eval_count}${c.avg_total !== null ? ` · 평균 ${c.avg_total}/${d.max_total}` : ""}` : "평가 없음")
        : d.can_evaluate
          ? h("div", { style: { marginTop: "3px" } }, c.my_evaluated ? pill("내 평가 완료", "ok sm") : c.submission ? pill("미평가", "warn sm") : null)
          : h("div.tiny.muted", { style: { marginTop: "3px" } }, c.visible_count ? `평가 공개 ${c.visible_count}건${c.avg_total !== null ? ` · 평균 ${c.avg_total}/${d.max_total}` : ""}` : c.eval_count ? "평가 진행 중" : "");
      return h("td", sub, ev);
    }))));
  return h("div", head, h("div.table-wrap", h("table.table.rep-grid", thead, tbody)),
    h("p.tiny.muted", { style: { marginTop: "8px" } }, d.is_lead ? "평가는 평가자별 초안으로 쌓이고, [일괄 공개] 를 누르면 해당 마일스톤의 모든 팀 평가가 학생에게 익명(평가자 N)으로 공개됩니다. 점수표 CSV 는 평가자 실명 포함." : d.can_evaluate ? "프로젝트 → [보고서] 탭에서 PDF 를 보고 채점합니다. 다른 평가자의 점수는 보이지 않습니다." : "프로젝트 → [보고서] 탭에서 PDF 를 제출합니다. 마감 후 제출은 지각으로 표시됩니다."));
}

// ---------- 주차별 제출 현황 ----------
async function renderWeekly(categoryId) {
  const d = await get(`/api/categories/${categoryId}/weekly`);
  if (!d.enabled) return h("div.empty", "주차 설정이 없습니다. 관리자가 [관리자 → 카테고리 → 수정]에서 1주차 시작일과 마감 요일을 정하면 프로젝트별 주간 보고 제출 현황이 표시됩니다.");
  const cfg = d.cfg, cur = d.current;
  const head = h("div.card.pad-s", { style: { marginBottom: "14px" } },
    h("div.row.between", { style: { flexWrap: "wrap", gap: "6px" } },
      h("div", h("b", cur ? `이번 주 ${cur.n}주차` : d.current_week < 1 ? "학기 시작 전" : "학기 종료"), cur ? h("span.small.muted", ` · ${shortDate(cur.start)}~${shortDate(cur.due)} · 마감 ${shortDate(cur.due)} 24:00 · 제출 ${cur.submitted}/${cur.total}`) : null),
      h("span.small.muted", `1주차 ${cfg.week_start} 시작 · 총 ${cfg.week_count}주 · 마감 매주 ${DOW[cfg.week_due_dow]}요일 자정`)),
    cur && cur.missing.length ? h("div.small", { style: { marginTop: "6px" } }, pill("미제출", "warn sm"), " ", cur.missing.map((m, i) => [i ? ", " : "", h("a", { href: `#/project/${m.id}` }, m.title)])) : cur ? h("div.small", { style: { marginTop: "6px", color: "var(--ok)" } }, "이번 주 주간 보고가 모두 제출되었습니다") : null,
  );
  const thead = h("thead", h("tr", h("th.wk-p", "프로젝트"), ...d.weeks.map((w) => h("th.wk" + (w.current ? ".cur" : ""), { title: `${w.start} ~ ${w.end}` }, `${w.n}주`, h("small", shortDate(w.end)))), h("th", "제출"), h("th", "누락")));
  const tbody = h("tbody", d.projects.map((p) => {
    const created = (p.created_at || "").slice(0, 10);
    return h("tr",
      h("td.wk-p", h("a", { href: `#/project/${p.id}` }, p.title), h("div.tiny.muted", p.owner_name)),
      ...p.cells.map((c, i) => {
        const w = d.weeks[i];
        let cls = "td.wk", txt = "";
        if (c.weekly) { cls += ".ok"; txt = "✓"; }
        else if (c.entries) { cls += ".part"; txt = `·${c.entries}`; }
        else if (w.past && w.end >= created) { cls += ".miss"; txt = "✗"; }
        else if (w.current) { cls += ".wait"; txt = "…"; }
        if (w.current) cls += ".cur";
        const inner = c.entry_id ? h("a", { href: `#/project/${p.id}?entry=${c.entry_id}`, title: `${c.entry_date} ${c.entry_title}` }, txt) : txt;
        return h(cls, { title: c.entries ? `${w.n}주차: 주간 보고 ${c.weekly}건 · 기록 ${c.entries}건` : `${w.n}주차 (${w.start}~${w.end})` }, inner);
      }),
      h("td.num", String(p.submitted)), h("td.num", { style: { color: p.missed ? "var(--bad)" : "" } }, String(p.missed)));
  }));
  return h("div", head, h("div.table-wrap", h("table.table.wk-grid", thead, tbody)),
    h("p.tiny.muted", { style: { marginTop: "8px" } }, "✓ 주간 보고 제출 · ·n 일반 기록만 n건 · ✗ 미제출(지난 주차, 프로젝트 생성 이후만) · … 이번 주 대기. 기록을 쓸 때 「주간 보고로 표시」를 체크하면 ✓ 로 집계됩니다."));
}

function renderBoard(board) {
  const cols = h("div.board");
  for (const col of board.columns) {
    cols.append(h("div.col",
      h("div.col-h", { title: col.hint }, col.label || stageLabel(col.stage), h("span.n", String(col.projects.length))),
      col.milestone ? h("div.tiny", { style: { color: "var(--gold)", fontWeight: 700, padding: "0 4px 4px" } }, "⏱ " + col.milestone) : null,
      col.projects.length ? col.projects.map((p) => projectCard(p, { compact: true })) : h("div.tiny.muted", { style: { padding: "6px 4px" } }, col.hint || ""),
    ));
  }
  const extra = [];
  if (board.paused.length) extra.push(h("div.section", h("div.section-h", h("h2", "일시 중지"), h("p.sub", `${board.paused.length}건`)), h("div.grid.c3", board.paused.map((p) => projectCard(p, { compact: true })))));
  if (board.done.length) extra.push(h("div.section", h("div.section-h", h("h2", "완료"), h("p.sub", `${board.done.length}건`)), h("div.grid.c3", board.done.map((p) => projectCard(p, { compact: true })))));
  return h("div", cols, extra);
}

function renderList(projects) {
  const rows = projects.filter((p) => p.status !== "archived").sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""));
  if (!rows.length) return h("div.empty", "프로젝트가 없습니다");
  const tbl = h("table.table",
    h("thead", h("tr", h("th", "프로젝트"), h("th", "담당"), h("th", "단계"), h("th", "상태"), h("th", "진행"), h("th", "기록"), h("th", "마지막 기록"), h("th", "검토"), h("th", "마감"))),
    h("tbody", rows.map((p) => {
      const stale = daysSince(p.last_entry_at);
      return h("tr", { class: p.status !== "active" ? "dim" : "" },
        h("td", h("a", { href: `#/project/${p.id}`, style: { fontWeight: 700 } }, p.title), p.target_venue ? h("div.tiny.muted", p.target_venue) : null),
        h("td", h("span.row", { style: { gap: "5px" } }, avatar(p.owner_name), p.owner_name)),
        h("td", pill(stageLabel(p.stage))),
        h("td", STATUS_LABEL[p.status]),
        h("td", `${p.stage_done}/${stages(p.track).length}`),
        h("td", String(p.entry_count)),
        h("td", { class: stale > 14 && p.status === "active" ? "stale" : "" }, p.last_entry_at ? fmtRel(p.last_entry_at) : "없음"),
        h("td", p.review_requested ? pill(String(p.review_requested), "bad sm") : ""),
        h("td", p.deadline || ""),
      );
    })),
  );
  return h("div.table-wrap", tbl);
}

const POLICY_LABEL = { open: "즉시 가입", approval: "리드·관리자 승인 후 가입", closed: "초대만" };

function renderMembers(detail, categoryId, container, query) {
  const canDecide = detail.my_role === "admin" || detail.my_role === "lead";
  const jr = detail.join_requests || [];
  const requestsBox = canDecide
    ? h("div.card", { style: { marginBottom: "14px", borderColor: jr.length ? "var(--goldlight)" : "var(--rule)" } },
        h("div.row.between", h("h3", `가입 요청 ${jr.length ? jr.length + "건" : ""}`), h("span.small.muted", `가입 정책: ${POLICY_LABEL[detail.category.join_policy] || detail.category.join_policy} (관리자가 변경)`)),
        jr.length
          ? h("div.stack", { style: { marginTop: "10px" } }, jr.map((r) => h("div.row", { style: { padding: "8px 0", borderTop: "1px solid var(--rule)" } }, avatar(r.user_name), h("div", { style: { flex: 1 } }, h("b", r.user_name), r.user_email ? h("span.small.muted", ` · ${r.user_email}`) : null, h("div.small", r.message || h("span.muted", "(메시지 없음)")), h("div.tiny.muted", fmtDT(r.created_at))),
              h("button.btn.sm.primary", { onclick: () => decide(r, true, categoryId, container, query) }, "승인"), h("button.btn.sm.danger", { onclick: () => decide(r, false, categoryId, container, query) }, "거절"))))
          : h("p.small.muted", { style: { margin: "6px 0 0" } }, "대기 중인 가입 요청이 없습니다. 팀원은 [팀 로비]에서 가입을 요청합니다."))
    : detail.my_role === "viewer"
      ? h("p.small.muted", { style: { marginBottom: "12px" } }, "열람 모드에서는 구성원 목록만 볼 수 있습니다. 팀에 참여하려면 개인 토큰을 발급받아 로비에서 가입하세요.")
      : h("p.small.muted", { style: { marginBottom: "12px" } }, `가입 정책: ${POLICY_LABEL[detail.category.join_policy] || detail.category.join_policy} · 다른 팀은 [팀 로비]에서 찾을 수 있습니다.`);
  const grid = h("div.grid.c3");
  for (const m of detail.members) {
    const mine = detail.projects.filter((p) => p.owner_id === m.id && p.status !== "archived");
    grid.append(h("div.card",
      h("div.row", avatar(m.name, true), h("div", h("div", { style: { fontWeight: 700 } }, m.name, " ", m.role === "lead" ? pill("리드", "gold sm") : m.role === "evaluator" ? pill("평가자", "ai sm") : null), h("div.tiny.muted", m.email || "")), h("span.spacer"),
        h("div.right.tiny.muted", `이번 주 ${m.entries_7d}건`, h("br"), m.last_entry_at ? `마지막 ${fmtRel(m.last_entry_at)}` : "기록 없음")),
      mine.length ? h("div.stack", { style: { marginTop: "10px", gap: "4px" } }, mine.map((p) => h("a.small", { href: `#/project/${p.id}` }, "· ", p.title, " ", pill(stageLabel(p.stage), "sm")))) : h("div.tiny.muted", { style: { marginTop: "8px" } }, "프로젝트 없음"),
    ));
  }
  return h("div", requestsBox, grid);
}

function decide(r, approve, categoryId, container, query) {
  const note = textarea({ rows: 2, placeholder: approve ? "환영 메시지 (선택)" : "거절 사유 (신청자에게 표시)" });
  const role = select([{ value: "member", label: "구성원" }, { value: "lead", label: "리드" }, { value: "evaluator", label: "평가자 (평가·코멘트만)" }], { value: "member" });
  modal({ title: `${approve ? "가입 승인" : "가입 거절"} — ${r.user_name}`, body: h("div.stack", approve ? field("역할", role) : null, field(approve ? "메모" : "사유", note)),
    actions: [{ label: "취소" }, { label: approve ? "승인" : "거절", cls: approve ? "primary" : "danger", onClick: async () => {
      await post(`/api/join-requests/${r.id}/${approve ? "approve" : "reject"}`, { note: note.value, role: role.value });
      toast(approve ? "가입을 승인했습니다" : "거절했습니다");
      render(container, categoryId, { ...query, view: "members" });
    } }] });
}

function renderReview(queue) {
  if (!queue.length) return h("div.empty", "검토 대기 중인 기록이 없습니다");
  return h("div.stack", queue.map((e) => h("a.card.hover", { href: `#/project/${e.project_id}?entry=${e.id}` },
    h("div.row", pill(stageLabel(e.stage)), h("b", e.title), h("span.spacer"), h("span.small.muted", `${e.date} · ${fmtRel(e.updated_at)}`)),
    h("div.small.muted", `${e.project_title} · ${e.author_name}`),
    e.content ? h("div.small", { style: { marginTop: "6px", color: "#3C4E57" } }, e.content.slice(0, 200)) : null,
  )));
}

export function reportDialog(categoryId, name) {
  const from = input({ type: "date", value: daysAgo(30) });
  const to = input({ type: "date", value: today() });
  const all = h("input", { type: "checkbox" });
  const q = () => (all.checked ? "" : `&from=${from.value}&to=${to.value}`);
  modal({
    title: `팀 보고서 — ${name}`,
    body: h("div.stack", h("div.form-grid", field("시작", from), field("종료", to)), h("label.check", all, "기간 제한 없이 전체"), h("p.help", "HTML 보고서는 새 탭에서 열리며 [인쇄 / PDF 저장] 버튼으로 PDF 를 만들 수 있습니다.")),
    actions: [
      { label: "Markdown 다운로드", onClick: () => downloadFile(`/api/categories/${categoryId}/report?format=md&download=1${q()}`, `${name}-report.md`) },
      { label: "HTML 보고서 열기", cls: "primary", onClick: () => openReport(`/api/categories/${categoryId}/report?format=html${q()}`) },
    ],
  });
}
