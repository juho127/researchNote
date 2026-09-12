import { state, get, post, h, mount, pill, avatar, stages, stageLabel, fmtRel, fmtDT, daysSince, openReport, downloadFile, input, textarea, select, field, modal, daysAgo, today, toast, errToast, STATUS_LABEL } from "../core.js";
import { projectCard, feedList, newProjectDialog } from "./home.js";
import { teamNoticeView, pinnedStrip } from "./notices.js";

export async function render(container, categoryId, query) {
  mount(container, h("div.loading", h("span.spinner"), " 불러오는 중…"));
  const [detail, board, notices] = await Promise.all([get(`/api/categories/${categoryId}`), get(`/api/categories/${categoryId}/board`), get(`/api/notices?category_id=${encodeURIComponent(categoryId)}&limit=50`).catch(() => [])]);
  const cat = detail.category;
  const view = query.view || "board";
  const me = state.me;

  const viewSeg = h("div.seg");
  const jrCount = (detail.join_requests || []).length;
  for (const [k, l] of [["board", "보드"], ["list", "목록"], ["notices", `공지${notices.length ? " " + notices.length : ""}`], ["members", `구성원${jrCount ? " · 가입 요청 " + jrCount : ""}`], ["review", `검토 대기${detail.review_queue.length ? " " + detail.review_queue.length : ""}`], ["feed", "활동"]]) {
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
  else if (view === "notices") body = await teamNoticeView(detail, categoryId);
  else body = h("div.card", feedList(detail.activity));

  mount(container, header, view === "notices" ? null : pinnedStrip(notices, categoryId), body);
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
