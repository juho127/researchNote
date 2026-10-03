// 보고서 평가 (캡스톤, 평가자·리드·관리자). 평가는 팀(카테고리)에 속한다.
//   #/team/<cat>?view=evaluate&milestone=     → 팀 페이지의 [평가] 탭: 팀 목록 · 내 평가 진행 현황 (renderList)
//   #/evaluate/<cat>/<project>?milestone=     → 팀별 채점 화면 (보고서 새 창 보기 + 문항별 선택 + 피드백)
//   #/evaluate[/<cat>]                        → 해당 팀의 [평가] 탭으로 이동
import { state, get, post, patch, h, mount, pill, toast, errToast, openFileTab, downloadFile, textarea, mdEl, fmtDT } from "../core.js";

/** 내가 평가할 수 있는 캡스톤 카테고리 */
export function evalCategories() {
  const me = state.me;
  if (!me || me.viewer) return [];
  return (me.memberships || []).filter((m) => m.track === "capstone" && (m.role === "evaluator" || m.role === "lead" || me.is_admin));
}

const enc = encodeURIComponent;
const listHash = (cid, mid, sub) => `#/team/${enc(cid)}?view=evaluate${mid ? `&milestone=${enc(mid)}` : ""}${sub ? `&sub=${sub}` : ""}`;
const formHash = (cid, pid, mid) => `#/evaluate/${enc(cid)}/${enc(pid)}?milestone=${enc(mid)}`;

export async function render(container, parts, query) {
  const [, cid, pid] = parts;
  if (pid) return evalForm(container, cid, pid, query);
  const target = cid || evalCategories()[0]?.category_id;
  if (target) location.replace(listHash(target, query.milestone));
  else mount(container, h("div.empty", "평가 권한이 있는 캡스톤 팀이 없습니다."));
}

/** 제출물이 있는 마일스톤 중 마지막(가장 최근) 것을 기본으로 */
function pickMilestone(d, want) {
  if (want && d.milestones.some((m) => m.id === want)) return d.milestones.find((m) => m.id === want);
  const withSubs = d.milestones.filter((m) => d.projects.some((p) => p.cells[m.id]?.submission));
  return withSubs[withSubs.length - 1] || d.milestones[0];
}

/** 팀 페이지 [평가] 탭 본문 */
export async function renderList(cid, query) {
  const d = await get(`/api/categories/${enc(cid)}/submissions`);
  if (!d.enabled) return h("div.empty", "이 팀에는 보고서 마일스톤이 없습니다.");
  if (!d.can_evaluate) return h("div.empty", "이 팀의 평가 권한이 없습니다.");
  const m = pickMilestone(d, query.milestone);
  const targets = d.projects.filter((p) => p.cells[m.id]?.submission);
  const done = targets.filter((p) => p.cells[m.id].my_evaluated).length;
  const pct = targets.length ? Math.round((done / targets.length) * 100) : 0;

  // 리드·관리자: [평가 현황] (기본) · [내 평가] · [종합 점수]
  const sub = d.is_lead ? (["status", "mine", "composite"].includes(query.sub) ? query.sub : "status") : "mine";
  const tabs = h("div.seg", d.milestones.map((x) => h("button", { class: x.id === m.id ? "active" : "", onclick: () => (location.hash = listHash(cid, x.id, d.is_lead ? sub : "")) }, x.label)));
  const subSeg = d.is_lead ? h("div.seg", [["status", "평가 현황"], ["mine", "내 평가"], ["composite", "종합 점수"]].map(([k, l]) => h("button", { class: sub === k ? "active" : "", onclick: () => (location.hash = listHash(cid, m.id, k)) }, l))) : null;
  if (sub === "status" || sub === "composite") {
    const content = sub === "status" ? await statusView(cid, m) : await compositeSection(cid, { editable: !!state.me.is_admin, onSaved: () => window.dispatchEvent(new Event("rn:refresh")) });
    return h("div",
      h("div.row", { style: { gap: "12px", flexWrap: "wrap", margin: "0 0 14px" } }, subSeg, sub === "status" ? tabs : null),
      content);
  }
  const criteria = h("div.card.eval-criteria",
    h("div.row", h("b", `${m.label} 평가 기준`), h("span.spacer"), h("span.small.muted", `만점 ${m.max_total} · ${m.rubric?.some((x) => x.choices) ? "문항마다 선택, 모든 문항 필수" : "축별 점수"}`)),
    h("ol.small", { style: { margin: "8px 0 0", paddingLeft: "20px" } }, (m.rubric || []).map((x) => h("li", x.hint || x.label, x.choices ? h("span.tiny.muted", `  (${x.choices.map((c) => `${c.label} ${c.score}`).join(" · ")})`) : h("span.tiny.muted", `  (0~${x.max})`)))));

  const cards = d.projects.map((p) => {
    const c = p.cells[m.id];
    const sub = c?.submission;
    const mine = !!c?.my_evaluated;
    return h("div.card.eval-team" + (mine ? ".done" : ""),
      h("div.eval-team-h",
        h("div", h("b.eval-team-t", p.title), h("div.tiny.muted", p.owner_name)),
        sub ? (mine ? pill("내 평가 완료", "ok") : pill("미평가", "warn")) : pill("미제출", "mute")),
      sub ? h("div.small.muted", `v${sub.version} · ${sub.filename} · ${fmtDT(sub.created_at)}${sub.late ? " · 지각" : ""}`) : null,
      d.is_lead && c?.eval_count ? h("div.tiny.muted", `전체 평가 ${c.eval_count}건${c.avg_total !== null ? ` · 평균 ${c.avg_total}/${m.max_total}` : ""}`) : null,
      sub
        ? h("div.row", { style: { gap: "8px", marginTop: "10px", flexWrap: "wrap" } },
            h("a.btn.lg" + (mine ? "" : ".primary"), { href: formHash(cid, p.id, m.id) }, mine ? "평가 수정" : "평가하기"),
            h("button.btn", { onclick: () => openFileTab(`/api/submissions/${sub.id}/file`) }, "보고서 새 창에서 보기"))
        : null);
  });

  return h("div",
    subSeg ? h("div", { style: { marginBottom: "10px" } }, subSeg) : null,
    h("p.small.muted", { style: { margin: "0 0 4px" } }, "다른 평가자의 점수는 보이지 않습니다(블라인드). 평가는 리드가 일괄 공개할 때 학생에게 '평가자 N'으로 익명 공개됩니다."),
    h("div.row", { style: { gap: "12px", flexWrap: "wrap", margin: "6px 0 14px" } }, tabs, h("span.spacer"),
      h("div.eval-progress", h("div.small", h("b", `내 평가 ${done} / ${targets.length}팀`), m.due ? h("span.muted", ` · 제출 마감 ${m.due}`) : null), h("div.bar", h("i", { style: { width: `${pct}%` } })))),
    criteria,
    targets.length ? null : h("div.empty", `${m.label} 제출물이 아직 없습니다.`),
    h("div.eval-grid", cards));
}

async function evalForm(container, cid, pid, query) {
  const [d, ps] = await Promise.all([get(`/api/categories/${enc(cid)}/submissions`), get(`/api/projects/${enc(pid)}/submissions`)]);
  const m = ps.milestones.find((x) => x.id === query.milestone) || pickMilestone(d, query.milestone);
  const proj = d.projects.find((p) => p.id === pid);
  const latest = ps.submissions.filter((s) => s.milestone === m.id)[0] || null;
  const catName = (state.me.memberships || []).find((x) => x.category_id === cid)?.category_name || "";
  const back = h("a.small", { href: listHash(cid, m.id) }, `← ${catName} 평가 목록`);
  if (!ps.can_evaluate) { mount(container, back, h("div.empty", "이 프로젝트의 평가 권한이 없습니다.")); return; }
  if (!latest) { mount(container, back, h("div.empty", `${proj?.title || "이 팀"}은(는) 아직 ${m.label}를 제출하지 않았습니다.`)); return; }
  const meId = state.me.user.id;
  const mine = ps.evaluations.find((e) => e.milestone === m.id && e.submission_id === latest.id && e.evaluator_id === meId) || null;
  const prevMine = mine ? null : ps.evaluations.find((e) => e.milestone === m.id && e.evaluator_id === meId) || null;
  const rubric = m.rubric || ps.rubric || [];
  const required = rubric.some((x) => x.choices);

  // 문항: 선택형은 큰 선택 버튼, 그 밖은 숫자 입력
  const totalEl = h("b");
  const items = rubric.map((x, i) => {
    const cur = mine?.scores?.[x.id];
    if (!x.choices) {
      const el = h("input.input", { type: "number", min: 0, max: x.max, step: 0.5, value: cur ?? "", placeholder: `0~${x.max}`, style: { width: "120px" }, oninput: recalc });
      return { x, get: () => el.value, box: el };
    }
    const name = `q${i}`;
    const opts = x.choices.map((c) => {
      const r = h("input", { type: "radio", name, value: String(c.score), checked: cur === c.score, onchange: recalc });
      return h("label.eval-choice", r, h("span.eval-choice-l", c.label), h("span.eval-choice-s", `${c.score}점`));
    });
    const box = h("div.eval-choices", opts);
    return { x, get: () => box.querySelector("input:checked")?.value ?? "", box };
  });
  function recalc() {
    const vals = items.map((it) => it.get()).filter((v) => v !== "");
    totalEl.textContent = `${Math.round(vals.reduce((a, v) => a + Number(v), 0) * 10) / 10} / ${m.max_total}점 · ${vals.length}/${items.length}문항`;
    items.forEach((it) => it.card?.classList.toggle("answered", it.get() !== ""));
  }
  const feedback = textarea({ value: mine?.feedback || "", rows: 8, placeholder: "잘한 점, 개선할 점, 다음 보고서까지 권고 등 (선택, 마크다운)" });

  // 다음으로 평가할 팀: 목록 순서상 이 팀 뒤에서 제출물이 있고 아직 내가 평가하지 않은 팀
  const order = d.projects.filter((p) => p.cells[m.id]?.submission);
  const idx = order.findIndex((p) => p.id === pid);
  const next = [...order.slice(idx + 1), ...order.slice(0, Math.max(idx, 0))].find((p) => !p.cells[m.id].my_evaluated) || null;

  const save = async (goNext, btn) => {
    const missing = items.filter((it) => it.get() === "");
    if (required && missing.length) {
      toast(`모든 문항을 채점해야 합니다: ${missing.map((it) => it.x.label).join(", ")}`, true);
      missing[0].card?.scrollIntoView({ behavior: "smooth", block: "center" });
      missing.forEach((it) => it.card?.classList.add("missing"));
      return;
    }
    const scores = {};
    for (const it of items) if (it.get() !== "") scores[it.x.id] = Number(it.get());
    btn.disabled = true;
    try {
      await post(`/api/projects/${enc(pid)}/evaluations`, { submission_id: latest.id, title: `${m.label} 평가 (v${latest.version})`, scores, feedback: feedback.value });
      toast(`${proj?.title || "평가"} 저장했습니다`);
      location.hash = goNext && next ? formHash(cid, next.id, m.id) : listHash(cid, m.id);
    } catch (e) { errToast(e); btn.disabled = false; }
  };
  const saveBtn = h("button.btn.lg", { onclick: (e) => save(false, e.currentTarget) }, "저장하고 목록으로");
  const nextBtn = next ? h("button.btn.lg.primary", { onclick: (e) => save(true, e.currentTarget) }, `저장하고 다음 팀 → ${next.title.split(" — ")[0]}`) : h("button.btn.lg.primary", { onclick: (e) => save(false, e.currentTarget) }, "평가 저장");

  mount(container,
    h("div", { style: { margin: "14px 0 4px" } }, back),
    h("header.hero", { style: { padding: "6px 0 10px", border: 0 } }, h("div.eyebrow", `${m.label} 평가`), h("h1", proj?.title || pid), h("p.sub", `${proj?.owner_name ? proj.owner_name + " · " : ""}v${latest.version} · ${latest.filename} · 제출 ${fmtDT(latest.created_at)}`)),
    h("div.card.eval-file",
      h("div", h("b", "보고서"), h("div.small.muted", "새 창에 띄워 두고 이 화면에서 채점하세요.")),
      h("button.btn.lg.mint", { onclick: () => openFileTab(`/api/submissions/${latest.id}/file`) }, "보고서 새 창에서 보기")),
    mine ? h("p.small", pill("저장된 내 평가", "ok"), ` ${fmtDT(mine.updated_at)} · 고친 뒤 다시 저장하면 갱신됩니다 (공개 전까지)`) : prevMine ? h("p.small", pill("이전 버전에 평가함", "warn"), " 팀이 새 버전을 냈습니다. 새 버전 기준으로 다시 평가해 주세요.") : null,
    h("div.stack", { style: { marginTop: "10px" } }, items.map((it, n) => {
      it.card = h("div.card.eval-q", h("div.eval-q-t", h("span.eval-q-n", String(n + 1)), h("div", h("div", it.x.hint || it.x.label), h("div.tiny.muted", `${it.x.label} · ${it.x.max}점${required ? " · 필수" : ""}`))), it.box);
      it.card.addEventListener("change", () => it.card.classList.remove("missing"));
      return it.card;
    })),
    h("div.card", { style: { marginTop: "12px" } }, h("div.small", { style: { fontWeight: 600, marginBottom: "6px" } }, "피드백 의견 (선택)"), feedback),
    h("div.eval-actions", h("div", "합계 ", totalEl), h("span.spacer"), saveBtn, nextBtn));
  recalc();
}

/** 리드·관리자: 회차 가중치 종합 점수 카드. editable 이면 가중치 편집(관리자) */
export async function compositeSection(cid, { editable = false, onSaved } = {}) {
  const s = await get(`/api/categories/${enc(cid)}/evaluations/composite`);
  const ms = s.milestones;
  const weightLine = h("span.small.muted", `가중치 ${ms.map((m) => `${m.label} ${m.weight}%`).join(" · ")}${ms.some((m) => m.weight_overridden) ? " (변경됨)" : " (기본)"}`);
  const editBox = h("div", { style: { display: "none", marginTop: "10px" } });
  if (editable) {
    const ins = ms.map((m) => ({ m, el: h("input.input", { type: "number", min: 0, max: 100, step: 5, value: m.weight, style: { width: "80px" } }) }));
    const sumEl = h("b");
    const recalc = () => { const sum = ins.reduce((a, i) => a + (Number(i.el.value) || 0), 0); sumEl.textContent = `합계 ${sum}%`; sumEl.style.color = Math.abs(sum - 100) < 0.01 ? "var(--ok)" : "var(--bad)"; };
    ins.forEach((i) => i.el.addEventListener("input", recalc)); recalc();
    const save = async (body) => { try { await patch(`/api/admin/categories/${enc(cid)}`, body); toast("가중치를 저장했습니다"); onSaved?.(); } catch (e) { errToast(e); } };
    mount(editBox, h("div.row", { style: { gap: "12px", flexWrap: "wrap", alignItems: "flex-end" } },
      ins.map((i) => h("label.field", { style: { margin: 0 } }, h("span", `${i.m.label} (%)`), i.el)), sumEl,
      h("button.btn.sm.primary", { onclick: () => save({ milestone_weight: Object.fromEntries(ins.map((i) => [i.m.id, Number(i.el.value) || 0])) }) }, "저장"),
      h("button.btn.sm", { onclick: () => save({ milestone_weight: "" }) }, "기본값으로")));
  }
  const rows = [...s.rows].sort((a, b) => a.rank - b.rank);
  const fmt = (v) => (v === null || v === undefined ? "—" : v);
  const table = h("table.table.rep-grid",
    h("thead", h("tr", h("th", "순위"), h("th", "프로젝트"), ...ms.map((m) => h("th", `${m.label}`, h("div.tiny.muted", `평균/${m.max_total} → 100점 × ${m.weight}%`))), h("th", "종합 (100)"))),
    h("tbody", rows.map((r) => h("tr",
      h("td", h("b", String(r.rank))),
      h("td", r.title, h("div.tiny.muted", r.owner_name)),
      ...ms.map((m) => { const c = r.cells[m.id]; return h("td", c.n ? [h("div", `${fmt(c.avg)} → ${fmt(c.scaled)}`), h("div.tiny.muted", `반영 ${fmt(c.weighted)} · 평가 ${c.n}건`)] : h("span.tiny.muted", "평가 없음")); }),
      h("td", h("b", String(r.composite)), h("div.tiny.muted", `반영 ${r.counted}/${ms.length}회차`))))));
  return h("div.card", { style: { marginTop: "16px" } },
    h("div.row", { style: { gap: "10px", flexWrap: "wrap" } }, h("b", "종합 점수 (회차 가중치)"), weightLine, h("span.spacer"),
      editable ? h("button.btn.xs", { onclick: () => (editBox.style.display = editBox.style.display === "none" ? "" : "none") }, "가중치 설정") : null,
      h("button.btn.xs", { onclick: () => downloadFile(`/api/categories/${enc(cid)}/evaluations/composite?format=csv`, s.filename) }, "종합 점수 CSV")),
    editBox,
    h("p.tiny.muted", { style: { margin: "6px 0 8px" } }, "회차 점수 = 평가자 전원의 합계 평균(초안 포함). 종합 = Σ (회차 평균 ÷ 회차 만점 × 100) × 가중치. 아직 평가가 없는 회차는 0점으로 반영되므로 학기 중에는 반영된 회차까지의 누적 점수입니다."),
    h("div.table-wrap", table));
}

/** 리드·관리자: 평가 현황 (프로젝트 × 평가자). 칸을 누르면 문항별 점수·피드백 */
async function statusView(cid, m) {
  const s = await get(`/api/categories/${enc(cid)}/evaluations/summary?milestone=${enc(m.id)}`);
  const rubric = m.rubric || s.rubric;
  const roster = s.roster;
  const projects = s.projects;
  const submittedN = projects.filter((p) => p.submitted).length;
  const detail = h("div.card.eval-detail", { hidden: true });
  let activeCell = null;
  const show = (cell, r, p) => {
    if (activeCell) activeCell.classList.remove("active");
    if (activeCell === cell) { activeCell = null; detail.hidden = true; return; }
    activeCell = cell; cell.classList.add("active");
    detail.hidden = false;
    mount(detail,
      h("div.row", { style: { gap: "8px", flexWrap: "wrap" } }, h("b", `${p.title}`), h("span.muted", "·"), h("b", r.evaluator_name), h("span.spacer"),
        r.visible ? pill("공개됨", "ok sm") : pill("초안 (학생 비공개)", "warn sm"),
        r.submission_id && s.latest[p.id] && r.submission_id !== s.latest[p.id] ? pill("이전 버전 평가", "warn sm") : null,
        h("span.tiny.muted", `작성 ${fmtDT(r.created_at)}${r.updated_at !== r.created_at ? ` · 수정 ${fmtDT(r.updated_at)}` : ""}`)),
      h("div.row", { style: { gap: "6px", flexWrap: "wrap", margin: "8px 0" } },
        rubric.map((x) => { const v = r.scores[x.id]; const c = x.choices?.find((c) => c.score === v); return h("span.tag", { title: x.hint || "" }, `${x.label} ${v ?? "—"}/${x.max}${c ? ` (${c.label})` : ""}`); }),
        r.total !== null ? pill(`합계 ${r.total}/${s.max_total}`, "ok") : null),
      r.feedback ? mdEl(r.feedback, "md") : h("div.small.muted", "피드백 없음"));
    detail.scrollIntoView({ behavior: "smooth", block: "nearest" });
  };
  const thead = h("thead", h("tr", h("th", "프로젝트"),
    ...roster.map((u) => h("th.c", u.name, h("div.tiny.muted", `${u.n}/${submittedN}${u.role === "evaluator" ? "" : " · 리드"}`))),
    h("th.c", "평균", h("div.tiny.muted", `/${s.max_total}`))));
  const tbody = h("tbody", projects.map((p) => h("tr",
    h("td", p.title, p.submitted ? null : h("div.tiny.muted", "미제출")),
    ...roster.map((u) => {
      const r = s.rows.find((x) => x.project_id === p.id && x.evaluator_id === u.id);
      if (!r) return h("td.c", p.submitted ? h("span.eval-miss", "미평가") : h("span.tiny.muted", "—"));
      const stale = r.submission_id && s.latest[p.id] && r.submission_id !== s.latest[p.id];
      const cell = h("button.eval-cell" + (stale ? ".stale" : ""), { type: "button", title: "눌러서 문항별 점수·피드백 보기" }, h("b", r.total ?? "—"), r.feedback ? h("span.tiny", " 💬") : null);
      cell.addEventListener("click", () => show(cell, r, p));
      return h("td.c", cell);
    }),
    h("td.c", p.avg_total !== null ? h("b", String(p.avg_total)) : h("span.tiny.muted", "—"), p.stdev !== null ? h("div.tiny.muted", `±${p.stdev}`) : null))));
  const doneAll = s.rows.filter((r) => projects.find((p) => p.id === r.project_id)?.submitted).length;
  const need = submittedN * roster.length;
  return h("div",
    h("div.row", { style: { gap: "10px", flexWrap: "wrap", marginBottom: "8px" } },
      h("b", `${m.label} 평가 현황`), h("span.small.muted", `완료 ${doneAll} / ${need}칸 · 평가자 ${roster.length}명 · 제출 ${submittedN}팀${m.due ? ` · 제출 마감 ${m.due}` : ""}`), h("span.spacer"),
      h("button.btn.sm", { onclick: () => downloadFile(`/api/categories/${enc(cid)}/evaluations/summary?milestone=${m.id}&format=csv`, `${cid}_${m.id}_scores.csv`) }, "점수표 CSV")),
    roster.length ? h("div.table-wrap", h("table.table.eval-matrix", thead, tbody)) : h("div.empty", "이 팀에 평가자가 없습니다. [관리자] → 연구원에서 평가자 역할을 지정하세요."),
    h("p.tiny.muted", { style: { marginTop: "6px" } }, "점수(합계)를 누르면 문항별 점수와 피드백이 아래에 펼쳐집니다. 💬 는 피드백 있음, 노란 칸은 팀이 새 버전을 낸 뒤의 이전 버전 평가입니다. 리드·관리자에게만 보이는 화면입니다(평가자 실명)."),
    detail);
}
