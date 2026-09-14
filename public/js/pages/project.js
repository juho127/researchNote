import { DOW, weekOf, weekRange, shortDate } from "../week.js";
import { state, get, post, patch, put, del, h, mount, clear, pill, avatar, stages, stageLabel, stageHint, stageMilestone, stageIndex, stageSelect, track as trackDef, ROLE_LABEL, fmtRel, fmtDT, weekday, today, daysAgo, input, textarea, field, select, modal, confirmDialog, toast, errToast, mdEl, openReport, downloadFile, projectProgress, STATUS_LABEL, STAGE_STATUS_LABEL, REVIEW_LABEL, REVIEW_CLASS } from "../core.js";

let current = null; // { project, tab, filters }

export async function render(container, projectId, query) {
  mount(container, h("div.loading", h("span.spinner"), " 불러오는 중…"));
  const project = await get(`/api/projects/${projectId}`);
  current = { project, tab: query.tab || "timeline", entryFocus: query.entry || null, stageFilter: query.stage || "", reviewFilter: query.review || "" };
  draw(container);
  return project;
}

async function reload(container) {
  current.project = await get(`/api/projects/${current.project.id}`);
  draw(container);
}

function draw(container) {
  const p = current.project;
  const me = state.me;
  const header = h("header.hero", { style: { padding: "20px 0 16px" } },
    h("div.eyebrow", h("a", { href: `#/team/${p.category_id}` }, p.category_name), " · ", p.track_label || "논문", " 트랙 · ", STATUS_LABEL[p.status]),
    h("div.row.between.top",
      h("div", { style: { flex: 1, minWidth: "260px" } },
        h("h1", p.title),
        p.summary ? h("p.sub", { style: { maxWidth: "760px" } }, p.summary) : null,
        h("div.row", { style: { marginTop: "10px", gap: "8px" } },
          h("span.row", { style: { gap: "5px" } }, avatar(p.owner_name), p.owner_name),
          ...(p.collaborators || []).map((c) => h("span.row", { style: { gap: "5px" }, title: "협업자" }, avatar(c.name), c.name)),
          p.target_venue ? h("span.tag", p.target_venue) : null,
          p.deadline ? h("span.tag", `마감 ${p.deadline}`) : null,
          ...(p.tags ? p.tags.split(",").filter(Boolean).map((t) => h("span.tag", "#" + t.trim())) : []),
          h("span.small.muted", `기록 ${p.entry_count}건 · ${p.last_entry_at ? "마지막 " + fmtRel(p.last_entry_at) : "기록 없음"}`),
        ),
      ),
      h("div.row",
        h("button.btn", { onclick: () => reportDialog(p) }, "보고서"),
        p.can_edit ? h("button.btn", { onclick: () => editProjectDialog(p, container) }, "수정") : null,
        p.can_edit ? h("button.btn.primary", { onclick: () => entryEditor(p, null, container) }, "+ 기록 추가") : null,
      ),
    ),
    h("div.row", { style: { marginTop: "16px", alignItems: "stretch" } },
      h("div.stepper", { style: { flex: 1 } }, p.stages.map((s) => h("div.step." + s.status + (p.stage === s.stage ? ".current" : ""), {
        title: stageHint(s.stage) + " · 클릭: 단계별 정리",
        onclick: () => { current.tab = "stages"; current.focusStage = s.stage; draw(container); },
      }, h("div.s-l", stageLabel(s.stage)), h("div.s-s", STAGE_STATUS_LABEL[s.status], s.entry_count ? ` · 기록 ${s.entry_count}` : null), stageMilestone(s.stage) ? h("div.tiny", { style: { color: "var(--gold)", marginTop: "2px" } }, "⏱ " + stageMilestone(s.stage)) : null))),
      p.can_edit && p.status !== "archived" ? advanceButton(p, container) : null,
    ),
    p.week_cfg && p.current_week >= 1 && p.current_week <= p.week_cfg.week_count && p.current_week_range
      ? h("div.row", { style: { marginTop: "10px", gap: "10px", flexWrap: "wrap" } },
          pill(`${p.current_week}주차`, "navy sm"),
          h("span.small.muted", `${shortDate(p.current_week_range.start)}~${shortDate(p.current_week_range.end)} · 주간 보고 마감 ${shortDate(p.current_week_range.end)} 24:00`),
          p.weekly_this_week ? pill("이번 주 주간 보고 제출됨", "ok sm") : pill("이번 주 주간 보고 미제출", "warn sm"),
          !p.weekly_this_week && p.can_edit && p.status === "active" ? h("button.btn.xs.primary", { onclick: () => entryEditor(p, null, container, { weekly: true }) }, "+ 주간 보고") : null)
      : null,
  );

  const tabs = h("div.tabs");
  const tabDefs = [["timeline", "타임라인", p.entry_count], ["stages", "단계별 정리", p.stage_done + "/" + p.stages.length], ["tasks", "할 일", p.open_tasks], ["evaluations", "평가·피드백"], ["members", "팀"]];
  for (const [k, l, n] of tabDefs) tabs.append(h("button", { class: current.tab === k ? "active" : "", onclick: () => { current.tab = k; draw(container); } }, l, n !== undefined && n !== null ? h("span.n", String(n)) : null));

  const body = h("div");
  mount(container, header, tabs, body);
  if (current.tab === "timeline") renderTimeline(body, container);
  else if (current.tab === "stages") renderStages(body, container);
  else if (current.tab === "tasks") renderTasks(body, container);
  else if (current.tab === "evaluations") renderEvaluations(body, container);
  else renderMembers(body, container);
}

/** 헤더의 "다음 단계로 →" (마지막 단계면 "논문 완료") */
function advanceButton(p, container) {
  const list = stages(p.track);
  const noun = p.track_noun || "논문";
  const idx = stageIndex(p.stage, p.track);
  const last = idx >= list.length - 1;
  if (p.status === "done") return h("div.row", { style: { alignItems: "center" } }, pill(`${noun} 완료`, "ok"), h("button.btn.sm", { onclick: () => advance(p, container, list[list.length - 1].id) }, `${list[list.length - 1].label} 단계로 되돌리기`));
  const next = last ? null : list[idx + 1];
  return h("button.btn.mint", { style: { alignSelf: "center", whiteSpace: "nowrap" }, title: last ? `${list[idx].label}을(를) 마치고 ${noun}을(를) 완료 처리합니다` : `${stageLabel(p.stage)} 완료 → ${next.label}`, onclick: () => advance(p, container) }, last ? `${noun} 완료 ✓` : `다음 단계로: ${next.label} →`);
}

async function advance(p, container, to) {
  const list = stages(p.track);
  const noun = p.track_noun || "논문";
  const idx = stageIndex(p.stage, p.track);
  const last = idx >= list.length - 1;
  const msg = to
    ? `현재 단계를 ${stageLabel(to)}(으)로 옮길까요? ${stageIndex(to, p.track) < idx ? "그 뒤 단계들은 다시 '예정'이 됩니다 (정리 내용은 유지)." : "그 앞 단계들은 완료로 표시됩니다."}`
    : last ? `${list[idx].label}을(를) 마치고 ${noun}을(를) 완료 처리할까요? (모든 단계 완료, 상태 '완료')` : `${stageLabel(p.stage)} 단계를 완료하고 ${list[idx + 1].label} 단계로 넘어갈까요?`;
  if (!(await confirmDialog(msg, { okLabel: to ? "이동" : last ? "완료" : "다음 단계로" }))) return;
  try {
    await post(`/api/projects/${p.id}/advance`, to ? { to } : {});
    toast(to ? `${stageLabel(to)} 단계로 이동했습니다` : last ? `${noun}을(를) 완료 처리했습니다` : `${list[idx + 1].label} 단계로 넘어갔습니다`);
    reload(container);
  } catch (e) { errToast(e); }
}

// ---------- 타임라인 ----------
async function renderTimeline(body, container) {
  const p = current.project;
  mount(body, h("div.loading", h("span.spinner")));
  const qs = new URLSearchParams({ limit: "200" });
  if (current.stageFilter) qs.set("stage", current.stageFilter);
  if (current.reviewFilter) qs.set("review_status", current.reviewFilter);
  const entries = await get(`/api/projects/${p.id}/entries?${qs}`);

  // 보기 방식: 날짜별(평면) / 단계별(트랙 순서로 묶고 접었다 펼침). 브라우저에 기억
  let view = current.timelineView;
  if (!view) { try { view = localStorage.getItem("rn.timeline.view") || "date"; } catch { view = "date"; } current.timelineView = view; }
  const setView = (v) => { current.timelineView = v; try { localStorage.setItem("rn.timeline.view", v); } catch {} renderTimeline(body, container); };
  if (view === "week" && !p.week_cfg) view = "date";
  const viewSeg = h("div.seg", h("button", { class: view === "date" ? "active" : "", onclick: () => setView("date") }, "날짜별"), p.week_cfg ? h("button", { class: view === "week" ? "active" : "", onclick: () => setView("week") }, "주차별") : null, h("button", { class: view === "stage" ? "active" : "", onclick: () => setView("stage") }, "단계별"));

  const stageSel = select([{ value: "", label: "모든 단계" }, ...stages(p.track).map((s) => ({ value: s.id, label: s.label }))], { value: current.stageFilter, onchange: (e) => { current.stageFilter = e.target.value; renderTimeline(body, container); } });
  const reviewSel = select([{ value: "", label: "모든 검토 상태" }, { value: "requested", label: "검토 요청" }, { value: "changes_requested", label: "수정 요청" }, { value: "approved", label: "승인" }], { value: current.reviewFilter, onchange: (e) => { current.reviewFilter = e.target.value; renderTimeline(body, container); } });
  const expandAll = view === "stage" ? h("button.btn.ghost.xs", { onclick: () => { current.collapsedStages = new Set(); renderTimeline(body, container); } }, "모두 펼치기") : null;
  const collapseAll = view === "stage" ? h("button.btn.ghost.xs", { onclick: () => { current.collapsedStages = new Set(stages(p.track).map((s) => s.id)); renderTimeline(body, container); } }, "모두 접기") : null;
  const toolbar = h("div.row", { style: { marginBottom: "14px" } }, viewSeg, view === "date" ? h("div", { style: { width: "160px" } }, stageSel) : null, h("div", { style: { width: "170px" } }, reviewSel), expandAll, collapseAll, h("span.spacer"), h("span.small.muted", `${entries.length}건`));

  if (!entries.length) { mount(body, toolbar, h("div.empty", p.can_edit ? "아직 기록이 없습니다. [+ 기록 추가]로 오늘 한 일을 남겨보세요." : "아직 기록이 없습니다")); return; }

  // 날짜별 묶음 → .day 요소들
  const dayGroups = (rows) => {
    const out = [];
    let lastDate = null, dayEl = null;
    for (const e of rows) {
      if (e.date !== lastDate) {
        lastDate = e.date;
        dayEl = h("div.day", h("div.d", e.date, h("small", weekday(e.date))), h("div.stack"));
        out.push(dayEl);
      }
      dayEl.lastChild.append(entryCard(e, container));
    }
    return out;
  };

  let tl;
  if (view === "stage") {
    // 처음엔 현재 단계만 펼치고 나머지는 접는다 (세션 동안 기억)
    if (!current.collapsedStages) current.collapsedStages = new Set(stages(p.track).map((s) => s.id).filter((id) => id !== p.stage));
    const byStage = new Map(stages(p.track).map((s) => [s.id, []]));
    for (const e of entries) (byStage.get(e.stage) || byStage.set(e.stage, []).get(e.stage)).push(e);
    tl = h("div.stack", { style: { gap: "10px" } });
    stages(p.track).forEach((s, i) => {
      const rows = byStage.get(s.id) || [];
      const st = p.stages.find((x) => x.stage === s.id);
      const isCurrent = p.stage === s.id && p.status !== "done";
      const collapsed = current.collapsedStages.has(s.id);
      const bodyEl = h("div.timeline", { style: { display: collapsed ? "none" : "", padding: "12px 4px 4px" } }, rows.length ? dayGroups(rows) : h("div.small.muted", { style: { padding: "4px 0 8px" } }, "이 단계의 기록이 없습니다"));
      const caret = h("span.tiny.muted", { style: { fontFamily: "var(--mono)" } }, collapsed ? "▼" : "▲");
      const head = h("button", { type: "button", style: { all: "unset", cursor: "pointer", display: "flex", alignItems: "center", gap: "8px", width: "100%", padding: "10px 12px", boxSizing: "border-box" },
        onclick: () => { const nowCollapsed = bodyEl.style.display !== "none"; bodyEl.style.display = nowCollapsed ? "none" : ""; caret.textContent = nowCollapsed ? "▼" : "▲"; if (nowCollapsed) current.collapsedStages.add(s.id); else current.collapsedStages.delete(s.id); } },
        caret, h("b", { style: { color: "var(--navy)" } }, `${i + 1}. ${s.label}`),
        st ? pill(STAGE_STATUS_LABEL[st.status], st.status === "done" ? "ok sm" : st.status === "doing" ? "warn sm" : "mute sm") : null,
        isCurrent ? pill("현재", "navy sm") : null,
        h("span.small.muted", `기록 ${rows.length}건`),
        rows.some((e) => e.review_status === "requested") ? pill(`검토 대기 ${rows.filter((e) => e.review_status === "requested").length}`, "bad sm") : null,
        h("span.spacer"), h("span.tiny.muted", s.hint));
      tl.append(h("div.card", { style: { padding: 0, borderColor: isCurrent ? "var(--navy)" : "var(--rule)" } }, head, bodyEl));
    });
  } else if (view === "week" && p.week_cfg) {
    // 주차별: 카테고리 주차 설정으로 묶고, 주간 보고 제출 여부를 표시
    const cfg = p.week_cfg;
    const byWeek = new Map();
    for (const e of entries) { const n = e.week ?? weekOf(cfg, e.date); (byWeek.get(n) || byWeek.set(n, []).get(n)).push(e); }
    const ns = [...byWeek.keys()];
    if (p.current_week >= 1 && p.current_week <= cfg.week_count && !ns.includes(p.current_week)) ns.push(p.current_week);
    ns.sort((a, b) => b - a);
    const td = today();
    tl = h("div.stack", { style: { gap: "10px" } });
    for (const n of ns) {
      const rows = byWeek.get(n) || [];
      const r = n >= 1 ? weekRange(cfg, n) : null;
      const hasWeekly = rows.some((e) => e.weekly);
      const isCur = n === p.current_week;
      const past = r ? r.end < td : false;
      const status = n < 1 ? null : hasWeekly ? pill("주간 보고 제출", "ok sm") : isCur ? pill("주간 보고 미제출", "warn sm") : past ? pill("주간 보고 누락", "bad sm") : null;
      const head = h("div.row", { style: { padding: "10px 12px", gap: "8px", flexWrap: "wrap" } },
        h("b", { style: { color: "var(--navy)" } }, n >= 1 ? `${n}주차` : "학기 시작 전"),
        r ? h("span.small.muted", `${shortDate(r.start)}~${shortDate(r.end)} · 마감 ${shortDate(r.end)} 24:00`) : null,
        isCur ? pill("이번 주", "navy sm") : null, status,
        h("span.small.muted", `기록 ${rows.length}건`),
        h("span.spacer"),
        isCur && !hasWeekly && p.can_edit && p.status === "active" ? h("button.btn.xs.primary", { onclick: () => entryEditor(p, null, container, { weekly: true }) }, "+ 주간 보고") : null);
      tl.append(h("div.card", { style: { padding: 0, borderColor: isCur ? "var(--navy)" : "var(--rule)" } }, head,
        h("div.timeline", { style: { padding: "12px 4px 4px" } }, rows.length ? dayGroups(rows) : h("div.small.muted", { style: { padding: "4px 0 8px" } }, "이 주차의 기록이 없습니다"))));
    }
  } else {
    tl = h("div.timeline", dayGroups(entries));
  }
  mount(body, toolbar, tl);
  if (current.entryFocus && view === "stage") {
    // 포커스할 기록이 접힌 단계에 있으면 펼친다
    const target = entries.find((e) => e.id === current.entryFocus);
    if (target && current.collapsedStages.has(target.stage)) { current.collapsedStages.delete(target.stage); renderTimeline(body, container); return; }
  }
  if (current.entryFocus) {
    const el = body.querySelector(`[data-entry="${current.entryFocus}"]`);
    if (el) { el.scrollIntoView({ block: "center" }); el.style.boxShadow = "0 0 0 3px rgba(47,163,169,.35)"; setTimeout(() => (el.style.boxShadow = ""), 2500); }
    current.entryFocus = null;
  }
}

function entryCard(e, container) {
  const p = current.project;
  const me = state.me;
  const long = (e.content || "").length > 600 || (e.content || "").split("\n").length > 14;
  const bodyEl = mdEl(e.content || "", "e-b md" + (long ? " clamp" : ""));
  const more = long ? h("button.btn.ghost.xs", { onclick: () => { bodyEl.classList.toggle("clamp"); more.textContent = bodyEl.classList.contains("clamp") ? "더 보기" : "접기"; } }, "더 보기") : null;
  const comments = h("div.comments");
  const card = h("div.card.entry.rv-" + e.review_status, { dataset: { entry: e.id } },
    h("div.e-h", h("div.e-t", e.title), pill(stageLabel(e.stage)), e.week ? pill(`${e.week}주차`, "sm") : null, e.weekly ? pill("주간 보고", "gold sm") : null, e.source === "mcp" ? pill("AI 기록", "ai") : null, e.review_status !== "none" ? pill(REVIEW_LABEL[e.review_status], REVIEW_CLASS[e.review_status]) : null),
    h("div.e-m", avatar(e.author_name), h("span", e.author_name), h("span", "·"), h("span", fmtDT(e.created_at)), e.updated_at !== e.created_at ? h("span.tiny", `(수정 ${fmtRel(e.updated_at)})`) : null),
    e.content ? bodyEl : null,
    more,
    h("div.e-actions",
      e.can_edit ? h("button.btn.xs", { onclick: () => entryEditor(p, e, container) }, "수정") : null,
      e.can_edit ? h("button.btn.xs.danger", { onclick: async () => { if (await confirmDialog("이 기록을 삭제할까요? 코멘트도 함께 삭제됩니다.", { danger: true, okLabel: "삭제" })) { await del(`/api/entries/${e.id}`); toast("삭제했습니다"); reload(container); } } }, "삭제") : null,
      (e.author_id === me.user.id || p.can_review) && e.review_status !== "requested" ? h("button.btn.xs", { onclick: () => setReview(e, "requested", container) }, "검토 요청") : null,
      (e.author_id === me.user.id || p.can_review) && e.review_status === "requested" ? h("button.btn.xs", { onclick: () => setReview(e, "none", container) }, "요청 취소") : null,
      p.can_review && e.review_status !== "approved" ? h("button.btn.xs.mint", { onclick: () => reviewDialog(e, "approved", container) }, "승인") : null,
      p.can_review && e.review_status !== "changes_requested" ? h("button.btn.xs", { onclick: () => reviewDialog(e, "changes_requested", container) }, "수정 요청") : null,
      h("span.spacer"),
      (me.viewer && !e.comment_count) ? null : h("button.btn.ghost.xs", { onclick: () => toggleComments(e, comments) }, e.comment_count ? `코멘트 ${e.comment_count}` : "코멘트"),
    ),
    comments,
  );
  comments.hidden = true;
  if (e.comment_count && (e.review_status === "requested" || e.review_status === "changes_requested")) toggleComments(e, comments);
  return card;
}

async function toggleComments(e, box) {
  if (!box.hidden && box.dataset.loaded) { box.hidden = true; return; }
  box.hidden = false;
  if (!box.dataset.loaded) { mount(box, h("span.spinner")); await loadComments(e, box); }
}
async function loadComments(e, box) {
  const full = await get(`/api/entries/${e.id}`);
  box.dataset.loaded = "1";
  const me = state.me;
  const list = full.comments.map((c) => h("div.cmt." + c.kind, avatar(c.author_name), h("div.c-b", h("div.c-m", h("b", c.author_name), " · ", c.kind === "approve" ? pill("승인", "ok sm") : c.kind === "request_changes" ? pill("수정 요청", "warn sm") : null, " ", fmtDT(c.created_at),
    (c.author_id === me.user.id || me.is_admin) ? h("button.btn.ghost.xs", { style: { marginLeft: "6px" }, onclick: async () => { if (await confirmDialog("코멘트를 삭제할까요?", { danger: true, okLabel: "삭제" })) { await del(`/api/comments/${c.id}`); e.comment_count--; await loadComments(e, box); } } }, "삭제") : null),
    mdEl(c.content))));
  const ta = textarea({ placeholder: "코멘트를 남기세요 (마크다운)", rows: 2 });
  const btn = h("button.btn.sm.primary", { onclick: async () => {
    if (!ta.value.trim()) return;
    btn.disabled = true;
    try { await post(`/api/entries/${e.id}/comments`, { content: ta.value }); e.comment_count = (e.comment_count || 0) + 1; await loadComments(e, box); } catch (ex) { errToast(ex); btn.disabled = false; }
  } }, "남기기");
  mount(box, list.length ? list : h("div.small.muted", "아직 코멘트가 없습니다"), me.viewer ? h("div.tiny.muted", { style: { marginTop: "6px" } }, "열람 모드에서는 코멘트를 남길 수 없습니다") : h("div.cmt-form", ta, btn));
}

async function setReview(e, status, container) {
  try { await post(`/api/entries/${e.id}/review`, { status }); toast(status === "requested" ? "검토를 요청했습니다" : "검토 요청을 취소했습니다"); reload(container); } catch (ex) { errToast(ex); }
}
function reviewDialog(e, status, container) {
  const note = textarea({ placeholder: status === "approved" ? "승인 의견 (선택)" : "무엇을 수정해야 하는지 구체적으로", rows: 4 });
  modal({
    title: status === "approved" ? `승인 — ${e.title}` : `수정 요청 — ${e.title}`,
    body: field("코멘트", note),
    actions: [{ label: "취소" }, { label: status === "approved" ? "승인" : "수정 요청", cls: status === "approved" ? "mint" : "primary", onClick: async () => { await post(`/api/entries/${e.id}/review`, { status, note: note.value }); toast("처리했습니다"); reload(container); } }],
  });
}

export function entryEditor(p, e, container, opts = {}) {
  const asWeekly = !e && !!opts.weekly && !!p.week_cfg;
  const date = input({ type: "date", value: e?.date || today() });
  const stage = stageSelect(e?.stage || p.stage, [], p.track);
  const title = input({ value: e?.title || (asWeekly && p.current_week >= 1 ? `${p.current_week}주차 주간 보고: ` : ""), placeholder: "한 줄 제목 — 결과가 드러나게", maxlength: 200 });
  const content = textarea({ rows: 14, value: e?.content ?? (asWeekly ? "## 이번 주 한 일\n- \n\n## 결과·지표\n- \n\n## 막힌 점\n- \n\n## 다음 주 계획\n- [ ] " : "## 한 일\n- \n\n## 결과\n- \n\n## 다음 할 일\n- [ ] \n\n## 메모\n- ") });
  const weekly = h("input", { type: "checkbox", checked: e ? !!e.weekly : asWeekly });
  const review = h("input", { type: "checkbox", checked: e?.review_status === "requested" });
  const preview = h("div.md", { style: { display: "none", minHeight: "200px", border: "1px solid var(--rule)", borderRadius: "9px", padding: "10px 12px", background: "#fff" } });
  const seg = h("div.seg", h("button.active", { onclick: (ev) => { swap(ev.target, false); } }, "편집"), h("button", { onclick: (ev) => { swap(ev.target, true); } }, "미리보기"));
  function swap(btn, showPreview) { seg.querySelectorAll("button").forEach((b) => b.classList.remove("active")); btn.classList.add("active"); if (showPreview) { preview.innerHTML = mdEl(content.value).innerHTML; preview.style.display = ""; content.style.display = "none"; } else { preview.style.display = "none"; content.style.display = ""; } }
  content.addEventListener("keydown", (ev) => { if (ev.key === "Tab") { ev.preventDefault(); const s = content.selectionStart; content.setRangeText("  ", s, content.selectionEnd, "end"); } });
  modal({
    title: e ? "기록 수정" : "기록 추가",
    wide: true,
    body: h("div.stack",
      h("div.form-grid", field("연구일", date), field("단계", stage)),
      field("제목", title),
      h("div.field", h("div.row.between", h("span", "내용 (마크다운)"), seg), content, preview, h("span.help", "표(| a | b |), 코드(```), 체크박스(- [ ]), 링크 지원. Tab 으로 들여쓰기.")),
      p.week_cfg ? h("label.check", weekly, "주간 보고로 표시", h("span.small.muted", ` — 매주 ${DOW[p.week_cfg.week_due_dow]}요일 자정까지 1건, 팀 페이지 [주차별] 탭에 ✓ 로 집계`)) : null,
      e ? null : h("label.check", review, "리드에게 검토 요청"),
    ),
    actions: [{ label: "취소" }, { label: e ? "저장" : "기록 저장", cls: "primary", onClick: async () => {
      if (!title.value.trim()) { toast("제목을 입력하세요", true); return false; }
      if (e) await patch(`/api/entries/${e.id}`, { date: date.value, stage: stage.value, title: title.value.trim(), content: content.value, weekly: weekly.checked });
      else await post(`/api/projects/${p.id}/entries`, { date: date.value, stage: stage.value, title: title.value.trim(), content: content.value, review_status: review.checked ? "requested" : "none", weekly: weekly.checked });
      toast(e ? "수정했습니다" : "기록을 저장했습니다");
      current.tab = "timeline";
      reload(container);
    } }],
  });
  setTimeout(() => title.focus(), 50);
}

// ---------- 단계별 정리 ----------
function renderStages(body, container) {
  const p = current.project;
  const grid = h("div.stack");
  const curIdx = stageIndex(p.stage, p.track);
  const lastIdx = stages(p.track).length - 1;
  const noun = p.track_noun || "논문";
  for (const s of p.stages) {
    const isCurrent = p.stage === s.stage && p.status !== "done";
    const idx = stageIndex(s.stage, p.track);
    const ta = textarea({ value: s.summary || "", rows: Math.max(4, Math.min(18, (s.summary || "").split("\n").length + 2)), placeholder: `${stageLabel(s.stage)} 단계의 누적 정리 — ${stageHint(s.stage)}. 논문 해당 절의 뼈대가 되도록 마크다운으로.`, disabled: !p.can_edit });
    const view = mdEl(s.summary || "");
    const editing = h("div.stack", { style: { display: "none" } }, ta);
    const save = h("button.btn.sm.primary", { onclick: async () => {
      save.disabled = true;
      try { await put(`/api/projects/${p.id}/stages/${s.stage}`, { summary: ta.value }); toast("저장했습니다"); await reload(container); } catch (ex) { errToast(ex); save.disabled = false; }
    } }, "저장");
    const editBtn = h("button.btn.sm", { onclick: () => { const on = editing.style.display === "none"; editing.style.display = on ? "" : "none"; view.style.display = on ? "none" : ""; editBtn.textContent = on ? "편집 닫기" : "편집"; if (on) ta.focus(); } }, "편집");
    // 흐름 버튼: 현재 → 다음 단계로 / 앞 단계 → 되돌리기 / 뒤 단계 → 여기까지 진행
    let flowBtn = null;
    if (p.can_edit && p.status !== "archived") {
      if (p.status === "done") flowBtn = h("button.btn.sm", { onclick: () => advance(p, container, s.stage) }, "이 단계로 되돌리기");
      else if (isCurrent) flowBtn = h("button.btn.sm.mint", { onclick: () => advance(p, container) }, idx >= lastIdx ? `${noun} 완료 ✓` : "다음 단계로 →");
      else if (idx < curIdx) flowBtn = h("button.btn.sm", { onclick: () => advance(p, container, s.stage) }, "이 단계로 되돌리기");
      else flowBtn = h("button.btn.sm", { onclick: () => advance(p, container, s.stage) }, "여기까지 진행");
    }
    const statusPill = pill(STAGE_STATUS_LABEL[s.status], s.status === "done" ? "ok" : s.status === "doing" ? "warn" : "mute");
    // 이 단계의 날짜별 기록을 카드 안에서 펼쳐 본다 (타임라인으로 이동하지 않음)
    const rollout = h("div", { style: { display: "none", marginTop: "12px", paddingTop: "12px", borderTop: "1px dashed var(--rule)" } });
    let loaded = false;
    const toggle = s.entry_count ? h("button.btn.ghost.xs", { onclick: async () => {
      const open = rollout.style.display === "none";
      rollout.style.display = open ? "" : "none";
      toggle.textContent = open ? "기록 접기 ▲" : `기록 ${s.entry_count}건 펼치기 ▼`;
      if (open && !loaded) {
        loaded = true;
        mount(rollout, h("div.loading", h("span.spinner")));
        try {
          const rows = await get(`/api/projects/${p.id}/entries?stage=${encodeURIComponent(s.stage)}&limit=100`);
          mount(rollout,
            h("div.row.between", { style: { marginBottom: "8px" } }, h("span.small.muted", `${stageLabel(s.stage)} 단계 기록 ${rows.length}건 · 최신순`), h("button.btn.ghost.xs", { onclick: () => { current.tab = "timeline"; current.stageFilter = s.stage; draw(container); } }, "타임라인에서 보기 →")),
            h("div.stack", rows.map((e) => entryCard(e, container))),
          );
        } catch (ex) { mount(rollout, h("div.small.muted", `불러오기 실패: ${ex.message}`)); loaded = false; }
      }
    } }, `기록 ${s.entry_count}건 펼치기 ▼`) : null;
    const card = h("div.card.stage-card", { id: `stage-${s.stage}`, style: isCurrent ? { borderColor: "var(--navy)" } : idx > curIdx && p.status !== "done" ? { opacity: ".85" } : {} },
      h("div.sc-h", h("h3", `${idx + 1}. ${stageLabel(s.stage)}`), statusPill, isCurrent ? pill("현재", "navy sm") : null, toggle, h("span.spacer"),
        p.can_edit ? [flowBtn, editBtn, save] : null),
      h("div.hint", stageHint(s.stage), s.updated_by ? ` · 갱신 ${fmtRel(s.updated_at)}` : ""),
      stageMilestone(s.stage) ? h("div.tiny", { style: { color: "var(--gold)", fontWeight: 700 } }, "⏱ 마일스톤: " + stageMilestone(s.stage)) : null,
      s.summary ? view : h("div.small.muted", { style: { fontStyle: "italic" } }, "아직 정리되지 않았습니다."),
      editing,
      rollout,
    );
    if (!s.summary) view.style.display = "none";
    if (current.focusStage === s.stage) { setTimeout(() => card.scrollIntoView({ block: "center", behavior: "smooth" }), 50); current.focusStage = null; }
    grid.append(card);
  }
  mount(body, h("p.small.muted", { style: { margin: "0 0 12px" } }, `${p.track_label || "논문"} 트랙은 한 흐름으로 진행됩니다: 현재 단계 앞은 완료, 뒤는 예정. 각 단계의 누적 결론을 여기에 정리하세요 (보고서와 ${p.track === "capstone" ? "최종보고서" : "초고"}의 뼈대). 단계가 끝나면 [다음 단계로 →]. AI 도구(MCP)의 update_stage / advance_stage 로도 갱신됩니다.`), grid);
}

// ---------- 할 일 ----------
async function renderTasks(body, container) {
  const p = current.project;
  const me = state.me;
  const tasks = p.tasks;
  const title = input({ placeholder: "할 일 추가 — 예: 시드 5개로 반복 실험" });
  const due = input({ type: "date", style: { width: "150px" } });
  const assignee = select([{ value: "", label: "담당 없음" }, ...p.members.map((m) => ({ value: m.id, label: m.name }))], { value: p.owner_id, style: { width: "140px" } });
  const add = h("button.btn.primary.sm", { onclick: async () => {
    if (!title.value.trim()) return;
    try { await post(`/api/projects/${p.id}/tasks`, { title: title.value.trim(), due: due.value || null, assignee_id: assignee.value || null }); title.value = ""; toast("추가했습니다"); reload(container); } catch (ex) { errToast(ex); }
  } }, "추가");
  title.addEventListener("keydown", (ev) => { if (ev.key === "Enter") add.click(); });
  const ro = !!me.viewer; // 열람 모드: 할 일 조회만
  const form = ro ? h("p.small.muted", { style: { margin: 0 } }, "열람 모드에서는 할 일을 추가·변경할 수 없습니다.") : h("div.card.pad-s", h("div.row", h("div", { style: { flex: 1, minWidth: "220px" } }, title), due, assignee, add));
  const list = h("div.card");
  const todayStr = today();
  if (!tasks.length) list.append(h("div.small.muted", "할 일이 없습니다"));
  for (const t of tasks) {
    const cb = h("input", { type: "checkbox", checked: t.status === "done", disabled: ro, onchange: async () => { try { await patch(`/api/tasks/${t.id}`, { status: cb.checked ? "done" : "todo" }); reload(container); } catch (ex) { errToast(ex); cb.checked = !cb.checked; } } });
    const over = t.due && t.status !== "done" && t.due < todayStr;
    list.append(h("div.task." + t.status, cb,
      h("div", { style: { flex: 1 } }, h("div.t-t", t.title), h("div.t-m", t.assignee_name ? h("span", "@" + t.assignee_name) : null, t.due ? h("span.due" + (over ? ".over" : ""), `기한 ${t.due}${over ? " (지남)" : ""}`) : null, t.stage ? pill(stageLabel(t.stage), "sm") : null, t.status === "doing" ? pill("진행 중", "warn sm") : null)),
      !ro && t.status !== "done" ? h("button.btn.xs", { onclick: async () => { await patch(`/api/tasks/${t.id}`, { status: t.status === "doing" ? "todo" : "doing" }); reload(container); } }, t.status === "doing" ? "대기로" : "진행 중") : null,
      ro ? null : h("button.btn.ghost.xs", { onclick: () => taskEditor(t, p, container) }, "수정"),
      !ro && (p.can_edit || t.created_by === me.user.id) ? h("button.btn.ghost.xs.danger", { onclick: async () => { if (await confirmDialog("할 일을 삭제할까요?", { danger: true, okLabel: "삭제" })) { await del(`/api/tasks/${t.id}`); reload(container); } } }, "삭제") : null,
    ));
  }
  mount(body, h("div.stack", form, list));
}
function taskEditor(t, p, container) {
  const title = input({ value: t.title });
  const due = input({ type: "date", value: t.due || "" });
  const assignee = select([{ value: "", label: "담당 없음" }, ...p.members.map((m) => ({ value: m.id, label: m.name }))], { value: t.assignee_id || "" });
  const stage = stageSelect(t.stage || "", [{ value: "", label: "단계 없음" }], p.track);
  modal({ title: "할 일 수정", body: h("div.stack", field("내용", title), h("div.form-grid", field("기한", due), field("담당", assignee), field("단계", stage))),
    actions: [{ label: "취소" }, { label: "저장", cls: "primary", onClick: async () => { await patch(`/api/tasks/${t.id}`, { title: title.value, due: due.value || null, assignee_id: assignee.value || null, stage: stage.value || null }); reload(container); } }] });
}

// ---------- 팀 (구성원 · 협업자) ----------
function renderMembers(body, container) {
  const p = current.project;
  const me = state.me;
  const collabIds = new Set((p.collaborators || []).map((c) => c.id));
  const canManage = me.is_admin || p.can_review || p.owner_id === me.user.id;
  const candidates = p.members.filter((m) => m.id !== p.owner_id && m.role !== "evaluator");
  const boxes = candidates.map((m) => ({ m, cb: h("input", { type: "checkbox", checked: collabIds.has(m.id), disabled: !canManage }) }));
  const save = canManage ? h("button.btn.sm.primary", { onclick: async () => {
    try { await put(`/api/projects/${p.id}/collaborators`, { user_ids: boxes.filter((b) => b.cb.checked).map((b) => b.m.id) }); toast("협업자를 저장했습니다"); reload(container); } catch (e) { errToast(e); }
  } }, "협업자 저장") : null;
  mount(body,
    h("div.card", h("div.row.between", h("h3", `협업자 ${p.collaborators?.length ? p.collaborators.length + "명" : ""}`), save),
      h("p.small.muted", { style: { margin: "6px 0 10px" } }, p.track === "capstone" ? "캡스톤 팀원을 협업자로 추가하면 담당자와 똑같이 기록·단계 정리·할 일·평가 답변을 쓸 수 있습니다." : "공저자를 협업자로 추가하면 담당자와 똑같이 기록·단계 정리를 쓸 수 있습니다."),
      boxes.length ? h("div.grid.c3", boxes.map((b) => h("label.check", b.cb, avatar(b.m.name), b.m.name, b.m.role === "lead" ? pill("리드", "gold sm") : null))) : h("div.small.muted", "추가할 수 있는 팀원이 없습니다 (같은 카테고리 구성원만)")),
    h("div.section", h("div.section-h", h("h2", "카테고리 구성원")),
      h("div.grid.c3", p.members.map((m) => h("div.card.pad-s", h("div.row", avatar(m.name), h("b", m.name), m.role === "lead" ? pill("리드", "gold sm") : m.role === "evaluator" ? pill("평가자", "ai sm") : null, m.id === p.owner_id ? pill("담당", "navy sm") : collabIds.has(m.id) ? pill("협업자", "ok sm") : null))))),
    h("p.small.muted", { style: { marginTop: "12px" } }, me.viewer ? "열람 모드(핀)에서는 구성원·협업자를 볼 수만 있습니다." : "같은 카테고리 구성원은 이 프로젝트의 기록을 읽고 코멘트할 수 있습니다. 기록 작성은 담당자·협업자·리드·관리자, 승인/수정요청은 리드·관리자, 평가는 리드·평가자·관리자."),
  );
}

// ---------- 평가·피드백 ----------
async function renderEvaluations(body, container) {
  const p = current.project;
  const me = state.me;
  mount(body, h("div.loading", h("span.spinner")));
  const data = await get(`/api/projects/${p.id}/evaluations`);
  const rubric = data.rubric || [];
  const max = rubric.reduce((a, x) => a + x.max, 0);
  const list = stages(p.track);
  const groups = list.map((s) => ({ s, evs: data.evaluations.filter((e) => e.stage === s.id) })).filter((g) => g.evs.length || g.s.id === p.stage);
  const head = h("div.row", { style: { marginBottom: "12px" } },
    h("p.small.muted", { style: { margin: 0, flex: 1 } }, `평가자(리드·평가자·관리자, 여러 명 가능)가 마일스톤마다 루브릭으로 채점하고 피드백을 남기면 팀이 답변합니다. 루브릭: ${rubric.map((x) => `${x.label} ${x.max}`).join(" · ")} (만점 ${max})`),
    p.can_evaluate ? h("button.btn.primary", { onclick: () => evaluationEditor(p, null, rubric, container) }, "+ 평가 작성") : null);
  if (!data.evaluations.length) { mount(body, head, h("div.empty", p.can_evaluate ? "아직 평가가 없습니다. [+ 평가 작성]으로 첫 평가를 남기세요." : "아직 평가가 없습니다.")); return; }
  const sections = [];
  for (const g of groups) {
    if (!g.evs.length) continue;
    const sum = data.summary?.[g.s.id];
    sections.push(h("div.section", { style: { marginTop: "18px" } },
      h("div.section-h", h("h2", g.s.label), h("p.sub", `${g.evs.length}건${sum?.avg_total !== null && sum?.avg_total !== undefined ? ` · 평균 ${sum.avg_total}/${max}` : ""}${g.s.milestone ? ` · ⏱ ${g.s.milestone}` : ""}`)),
      h("div.stack", g.evs.map((ev) => evaluationCard(ev, p, rubric, max, container))),
    ));
  }
  mount(body, head, ...sections);
}

function evaluationCard(ev, p, rubric, max, container) {
  const scored = rubric.filter((x) => ev.scores?.[x.id] !== undefined);
  const scoreRow = scored.length ? h("div.row", { style: { gap: "6px", flexWrap: "wrap", margin: "6px 0" } }, scored.map((x) => h("span.tag", `${x.label} ${ev.scores[x.id]}/${x.max}`)), ev.total !== null ? pill(`합계 ${ev.total}/${max}`, "ok") : null) : null;
  const respBox = h("div.comments", { style: { marginTop: "10px" } });
  const drawResp = () => {
    const ta = textarea({ value: ev.response || "", rows: 4, placeholder: "평가 의견에 대한 팀의 답변 · 반영 계획 · 반박 (마크다운). 다음 보고서에 '평가의견 답변'으로 첨부됩니다." });
    const editing = h("div.stack", { style: { display: "none" } }, ta, h("div.row", { style: { justifyContent: "flex-end" } }, h("button.btn.sm.primary", { onclick: async () => { try { await post(`/api/evaluations/${ev.id}/respond`, { response: ta.value }); toast("답변을 저장했습니다"); renderEvaluations(container.querySelector(".tabs")?.nextSibling || container, container); } catch (e) { errToast(e); } } }, "답변 저장")));
    const toggle = ev.can_respond ? h("button.btn.ghost.xs", { onclick: () => { editing.style.display = editing.style.display === "none" ? "" : "none"; if (editing.style.display === "") ta.focus(); } }, ev.response ? "답변 수정" : "답변 작성") : null;
    mount(respBox, h("div.row", h("b", "팀 답변"), ev.response_by_name ? h("span.tiny.muted", `${ev.response_by_name} · ${fmtDT(ev.response_at)}`) : null, h("span.spacer"), toggle), ev.response ? mdEl(ev.response) : h("div.small.muted", "아직 답변이 없습니다"), editing);
  };
  drawResp();
  return h("div.card.entry" + (ev.visible ? "" : ".rv-changes_requested"),
    h("div.e-h", h("div.e-t", ev.title), ev.visible ? null : pill("초안 (팀 비공개)", "warn")),
    h("div.e-m", avatar(ev.evaluator_name), h("span", ev.evaluator_name), h("span", "·"), h("span", fmtDT(ev.created_at)), ev.updated_at !== ev.created_at ? h("span.tiny", `(수정 ${fmtRel(ev.updated_at)})`) : null),
    scoreRow,
    ev.feedback ? mdEl(ev.feedback, "e-b md") : null,
    h("div.e-actions", ev.can_edit ? h("button.btn.xs", { onclick: () => evaluationEditor(p, ev, rubric, container) }, "수정") : null,
      ev.can_edit ? h("button.btn.xs.danger", { onclick: async () => { if (await confirmDialog("이 평가를 삭제할까요?", { danger: true, okLabel: "삭제" })) { await del(`/api/evaluations/${ev.id}`); toast("삭제했습니다"); reload(container); } } }, "삭제") : null),
    respBox,
  );
}

function evaluationEditor(p, ev, rubric, container) {
  const stage = select(stages(p.track).map((s) => ({ value: s.id, label: s.milestone ? `${s.label} (${s.milestone})` : s.label })), { value: ev?.stage || p.stage });
  const title = input({ value: ev?.title || "", placeholder: `예: ${stageMilestone(p.stage) || stageLabel(p.stage) + " 평가"}`, maxlength: 200 });
  const inputs = rubric.map((x) => ({ x, el: input({ type: "number", min: 0, max: x.max, step: 0.5, value: ev?.scores?.[x.id] ?? "", placeholder: `0~${x.max}`, style: { width: "110px" } }) }));
  const totalEl = h("span.pill.ok", "");
  const recalc = () => { const vals = inputs.map((i) => i.el.value).filter((v) => v !== ""); totalEl.textContent = vals.length ? `합계 ${Math.round(vals.reduce((a, v) => a + Number(v), 0) * 10) / 10} / ${rubric.reduce((a, x) => a + x.max, 0)}` : "점수 없음"; };
  inputs.forEach((i) => i.el.addEventListener("input", recalc)); recalc();
  const feedback = textarea({ value: ev?.feedback || "", rows: 10, placeholder: "## 잘한 점\n- \n\n## 개선할 점\n- \n\n## 다음 마일스톤까지 권고\n- " });
  const visible = h("input", { type: "checkbox", checked: ev ? ev.visible : true });
  modal({
    title: ev ? "평가 수정" : "평가 작성", wide: true,
    body: h("div.stack",
      h("div.form-grid", field("대상 단계(마일스톤)", stage), field("제목", title)),
      h("div.field", h("span", "루브릭 점수 (비워도 됨)"), h("div.grid.c2", inputs.map((i) => h("div.row", i.el, h("div", h("div.small", { style: { fontWeight: 600 } }, `${i.x.label} (${i.x.max})`), i.x.hint ? h("div.tiny.muted", i.x.hint) : null)))), h("div", { style: { marginTop: "6px" } }, totalEl)),
      field("피드백 (마크다운)", feedback),
      h("label.check", visible, "팀에게 공개 (끄면 초안: 평가자·리드·관리자만 봄)"),
    ),
    actions: [{ label: "취소" }, { label: ev ? "저장" : "평가 저장", cls: "primary", onClick: async () => {
      const scores = {}; for (const i of inputs) if (i.el.value !== "") scores[i.x.id] = Number(i.el.value);
      const body = { stage: stage.value, title: title.value.trim(), scores, feedback: feedback.value, visible: visible.checked };
      if (ev) await patch(`/api/evaluations/${ev.id}`, body); else await post(`/api/projects/${p.id}/evaluations`, body);
      toast(ev ? "수정했습니다" : "평가를 저장했습니다");
      current.tab = "evaluations";
      reload(container);
    } }],
  });
}

// ---------- 프로젝트 수정 / 보고서 ----------
function editProjectDialog(p, container) {
  const me = state.me;
  const title = input({ value: p.title, maxlength: 200 });
  const summary = textarea({ value: p.summary, rows: 3 });
  const venue = input({ value: p.target_venue });
  const deadline = input({ type: "date", value: p.deadline || "" });
  const tags = input({ value: p.tags });
  const status = select([{ value: "active", label: "진행 중" }, { value: "paused", label: "일시 중지" }, { value: "done", label: "완료" }, { value: "archived", label: "보관" }], { value: p.status });
  const owner = select(p.members.map((m) => ({ value: m.id, label: m.name })), { value: p.owner_id, disabled: !(me.is_admin || p.can_review) });
  modal({
    title: "프로젝트 수정",
    body: h("div.stack", field("제목", title), field("연구 요약", summary), h("div.form-grid", field("목표 학회/저널", venue), field("마감", deadline), field("상태", status), field("담당", owner, me.is_admin || p.can_review ? "" : "리드·관리자만 변경 가능")), field("태그", tags)),
    actions: [
      { label: "보관(삭제)", cls: "danger", closeAfter: true, onClick: async () => { if (!(await confirmDialog("프로젝트를 보관 처리할까요? 목록에서 숨겨지며 기록은 유지됩니다.", { danger: true, okLabel: "보관" }))) return false; await del(`/api/projects/${p.id}`); toast("보관했습니다"); location.hash = `#/team/${p.category_id}`; } },
      { label: "취소" },
      { label: "저장", cls: "primary", onClick: async () => {
        const b = { title: title.value.trim(), summary: summary.value, target_venue: venue.value, deadline: deadline.value || null, tags: tags.value, status: status.value };
        if (owner.value !== p.owner_id) b.owner_id = owner.value;
        await patch(`/api/projects/${p.id}`, b); toast("저장했습니다"); reload(container);
      } },
    ],
  });
}

function reportDialog(p) {
  const from = input({ type: "date", value: daysAgo(30) });
  const to = input({ type: "date", value: today() });
  const all = h("input", { type: "checkbox", checked: true });
  const q = () => (all.checked ? "" : `&from=${from.value}&to=${to.value}`);
  modal({
    title: `진행 보고서 — ${p.title}`,
    body: h("div.stack", h("label.check", all, "전체 기간"), h("div.form-grid", field("시작", from), field("종료", to)), h("p.help", "HTML 보고서는 새 탭에서 열리며 상단 [인쇄 / PDF 저장] 버튼으로 PDF 를 만들 수 있습니다. 단계별 정리 + 날짜별 기록 + 검토 코멘트가 논문 흐름 순서로 정리됩니다.")),
    actions: [
      { label: "Markdown 다운로드", onClick: () => downloadFile(`/api/projects/${p.id}/report?format=md&download=1${q()}`, `${p.title}-report.md`) },
      { label: "HTML 보고서 열기", cls: "primary", onClick: () => openReport(`/api/projects/${p.id}/report?format=html${q()}`) },
    ],
  });
}
