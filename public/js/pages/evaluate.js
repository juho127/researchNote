// 평가 페이지 (캡스톤 보고서 채점 전용, 평가자·리드·관리자)
//   #/evaluate                       → 평가할 카테고리 선택 (하나면 바로 이동)
//   #/evaluate/<cat>?milestone=       → 팀 목록 · 내 평가 진행 현황
//   #/evaluate/<cat>/<project>?milestone= → 팀별 채점 화면 (보고서 새 창 보기 + 문항별 선택 + 피드백)
import { state, get, post, h, mount, pill, toast, errToast, openFileTab, textarea, fmtDT } from "../core.js";

/** 내가 평가할 수 있는 캡스톤 카테고리 */
export function evalCategories() {
  const me = state.me;
  if (!me || me.viewer) return [];
  return (me.memberships || []).filter((m) => m.track === "capstone" && (m.role === "evaluator" || m.role === "lead" || me.is_admin));
}

const enc = encodeURIComponent;
const listHash = (cid, mid) => `#/evaluate/${enc(cid)}${mid ? `?milestone=${enc(mid)}` : ""}`;
const formHash = (cid, pid, mid) => `#/evaluate/${enc(cid)}/${enc(pid)}?milestone=${enc(mid)}`;

export async function render(container, parts, query) {
  const [, cid, pid] = parts;
  if (!cid) return chooseCategory(container);
  if (pid) return evalForm(container, cid, pid, query);
  return evalList(container, cid, query);
}

function chooseCategory(container) {
  const cats = evalCategories();
  if (cats.length === 1) { location.replace(listHash(cats[0].category_id)); return; }
  mount(container,
    h("header.hero", h("div.eyebrow", "Evaluation"), h("h1", "보고서 평가"), h("p.sub", "평가할 과목(팀)을 고르세요")),
    cats.length
      ? h("div.stack", cats.map((c) => h("a.card.eval-cat", { href: listHash(c.category_id) }, h("b", c.category_name), h("span.tiny.muted", c.role === "evaluator" ? "평가자" : "리드"))))
      : h("div.empty", "평가 권한이 있는 캡스톤 과목이 없습니다."));
}

/** 제출물이 있는 마일스톤 중 마지막(가장 최근) 것을 기본으로 */
function pickMilestone(d, want) {
  if (want && d.milestones.some((m) => m.id === want)) return d.milestones.find((m) => m.id === want);
  const withSubs = d.milestones.filter((m) => d.projects.some((p) => p.cells[m.id]?.submission));
  return withSubs[withSubs.length - 1] || d.milestones[0];
}

async function evalList(container, cid, query) {
  const d = await get(`/api/categories/${enc(cid)}/submissions`);
  const cat = (state.me.memberships || []).find((m) => m.category_id === cid);
  if (!d.enabled) { mount(container, h("div.empty", "이 과목에는 보고서 마일스톤이 없습니다.")); return; }
  if (!d.can_evaluate) { mount(container, h("div.empty", "이 과목의 평가 권한이 없습니다.")); return; }
  const m = pickMilestone(d, query.milestone);
  const targets = d.projects.filter((p) => p.cells[m.id]?.submission);
  const done = targets.filter((p) => p.cells[m.id].my_evaluated).length;
  const pct = targets.length ? Math.round((done / targets.length) * 100) : 0;

  const tabs = h("div.seg", d.milestones.map((x) => h("button", { class: x.id === m.id ? "active" : "", onclick: () => (location.hash = listHash(cid, x.id)) }, x.label)));
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

  mount(container,
    h("header.hero", { style: { paddingBottom: "8px" } }, h("div.eyebrow", "Evaluation"), h("h1", "보고서 평가"), h("p.sub", `${cat?.category_name || cid} · 다른 평가자의 점수는 보이지 않습니다(블라인드). 평가는 리드가 일괄 공개할 때 학생에게 익명으로 공개됩니다.`)),
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
  const back = h("a.small", { href: listHash(cid, m.id) }, "← 평가 목록");
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
