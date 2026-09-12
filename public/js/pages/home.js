import { state, get, post, h, mount, pill, avatar, stageLabel, stageSelect, projectProgress, fmtRel, daysSince, today, input, textarea, field, select, toast, errToast, loadMe, STATUS_LABEL, ACTION_LABEL, fmtDT, modal } from "../core.js";
import { homeNoticeCard } from "./notices.js";

export function projectCard(p, { showOwner = true, compact = false } = {}) {
  const stale = daysSince(p.last_entry_at);
  const card = h("a.card.hover.pcard" + (compact ? ".pad-s" : ""), { href: `#/project/${p.id}` },
    h("div.row.between.top",
      pill(stageLabel(p.stage), p.status === "active" ? "" : "mute"),
      p.track === "capstone" ? pill("캡스톤", "gold sm") : null,
      h("span.spacer"),
      p.review_requested ? pill(`검토 ${p.review_requested}`, "bad sm") : null,
      p.status !== "active" ? pill(STATUS_LABEL[p.status], "mute sm") : null,
    ),
    h("div.title", p.title),
    p.summary && !compact ? h("div.small.muted", p.summary.length > 110 ? p.summary.slice(0, 110) + "…" : p.summary) : null,
    projectProgress(p),
    h("div.foot",
      showOwner ? h("span.row", { style: { gap: "5px" } }, avatar(p.owner_name), p.owner_name) : null,
      h("span", `기록 ${p.entry_count}`),
      h("span" + (stale > 14 && p.status === "active" ? ".stale" : ""), p.last_entry_at ? `마지막 ${fmtRel(p.last_entry_at)}` : "기록 없음"),
      p.open_tasks ? h("span", `할 일 ${p.open_tasks}`) : null,
      p.deadline ? h("span", `마감 ${p.deadline}`) : null,
    ),
  );
  return card;
}

export function feedList(rows, { showProject = true } = {}) {
  if (!rows.length) return h("div.empty", "최근 활동이 없습니다");
  const list = h("div.feed");
  for (const r of rows) {
    const target = r.project_id ? `#/project/${r.project_id}` : r.category_id ? `#/team/${r.category_id}` : null;
    list.append(h("div.f",
      avatar(r.actor_name || "?"),
      h("div",
        h("div.f-t", h("b", r.actor_name || "시스템"), " · ", ACTION_LABEL[r.action] || r.action, r.source === "mcp" ? [" ", pill("AI", "ai sm")] : null,
          showProject && r.project_title ? [" · ", target ? h("a", { href: target }, r.project_title) : r.project_title] : null),
        h("div.f-m", r.summary ? h("span", r.summary.length > 120 ? r.summary.slice(0, 120) + "…" : r.summary) : null, " ", h("span", fmtDT(r.at))),
      ),
    ));
  }
  return list;
}

export function quickLogForm(projects, { onSaved, defaultProject } = {}) {
  if (!projects.length) return h("div.empty", "기록할 프로젝트가 없습니다. 먼저 팀 페이지에서 프로젝트를 만드세요.");
  const proj = select(projects.map((p) => ({ value: p.id, label: `${p.title} (${stageLabel(p.stage)})` })), { value: defaultProject || projects[0].id });
  const date = input({ type: "date", value: today(), max: "2099-12-31" });
  const stageWrap = h("div");
  let stage = stageSelect(projects[0]?.stage, [], projects[0]?.track);
  stageWrap.append(stage);
  proj.addEventListener("change", () => { const p = projects.find((x) => x.id === proj.value); if (p) { stage = stageSelect(p.stage, [], p.track); mount(stageWrap, stage); } });
  const title = input({ placeholder: "한 줄 제목 — 예: ResNet-50 baseline, CIFAR-10 acc 91.2%", maxlength: 200 });
  const content = textarea({ placeholder: "## 한 일\n- \n\n## 결과\n- \n\n## 다음 할 일\n- [ ] \n\n## 메모\n- ", rows: 8 });
  const review = h("input", { type: "checkbox" });
  const btn = h("button.btn.primary", { type: "submit" }, "기록 저장");
  const form = h("form.stack", {
    onsubmit: async (e) => {
      e.preventDefault();
      if (!title.value.trim()) { toast("제목을 입력하세요", true); title.focus(); return; }
      btn.disabled = true;
      try {
        const en = await post(`/api/projects/${proj.value}/entries`, { date: date.value, stage: stage.value, title: title.value.trim(), content: content.value, review_status: review.checked ? "requested" : "none" });
        toast("기록을 저장했습니다");
        title.value = ""; content.value = ""; review.checked = false;
        onSaved?.(en);
      } catch (ex) { errToast(ex); } finally { btn.disabled = false; }
    },
  },
    h("div.form-grid",
      field("프로젝트", proj), field("연구일", date), field("단계", stageWrap),
    ),
    field("제목", title),
    field("내용 (마크다운)", content, "## 한 일 / ## 결과 / ## 다음 할 일 / ## 메모 구조를 권장합니다. 표(|)·코드(```)·체크박스(- [ ]) 지원."),
    h("div.row.between", h("label.check", review, "리드에게 검토 요청"), btn),
  );
  return form;
}

export async function render(container) {
  mount(container, h("div.loading", h("span.spinner"), " 불러오는 중…"));
  const me = await loadMe();
  const [feed, myEntries, reviewMine, noticeCard] = await Promise.all([
    get("/api/feed?limit=25"),
    get(`/api/entries?mine=1&since=${encodeURIComponent(daysAgoStr(7))}&brief=1&limit=100`),
    get("/api/entries?review_status=requested&brief=1&limit=50"),
    homeNoticeCard(me),
  ]);
  const mine = me.my_projects.filter((p) => p.status !== "archived");
  const active = mine.filter((p) => p.status === "active");
  const openTasks = active.reduce((a, p) => a + (p.open_tasks || 0), 0);
  const teamReview = reviewMine.filter((e) => e.author_id !== me.user.id);
  const stats = [
    [active.length, "진행 중인 논문"],
    [myEntries.length, "이번 주 내 기록"],
    [openTasks, "미완료 할 일"],
    [teamReview.length, "팀 검토 요청 대기"],
  ];
  const hour = new Date().getHours();
  const greet = hour < 6 ? "늦은 시간까지 수고가 많습니다" : hour < 12 ? "좋은 아침입니다" : hour < 18 ? "좋은 오후입니다" : "좋은 저녁입니다";

  const quickWrap = h("div.card.quick", h("div.section-h", h("h2", "오늘의 기록"), h("p.sub", "지금 한 일을 바로 남기세요")), quickLogForm(active, { onSaved: () => window.dispatchEvent(new Event("rn:refresh")) }));

  mount(container,
    h("header.hero", h("div.eyebrow", `${me.app.org || ""} · ${me.app.name}`), h("h1", `${greet}, ${me.user.name} 님`),
      h("p.sub", me.memberships.length ? [`소속: ${me.memberships.map((m) => m.category_name + (m.role === "lead" ? " (리드)" : "")).join(" · ")} · `, h("a", { href: "#/lobby" }, "팀 로비")] : ["아직 소속 팀이 없습니다. ", h("a", { href: "#/lobby" }, "팀 로비"), "에서 팀을 찾아 가입하세요."]),
      me.pending_joins ? h("p.small", { style: { marginTop: "8px" } }, h("a.btn.sm", { href: "#/lobby" }, `가입 요청 ${me.pending_joins}건 대기 (리드 승인 필요)`)) : null),
    h("div.grid.c4", stats.map(([n, l]) => h("div.card.stat", h("div.n", String(n)), h("div.l", l)))),
    noticeCard ? h("div", { style: { marginTop: "18px" } }, noticeCard) : null,
    h("div.two", { style: { marginTop: "18px" } },
      h("div.stack",
        quickWrap,
        h("div.section",
          h("div.section-h", h("h2", "내 논문 프로젝트"), h("p.sub", `${mine.length}건`), h("span.spacer"),
            me.memberships.length ? h("button.btn.sm", { onclick: () => newProjectDialog(me) }, "+ 새 프로젝트") : null),
          mine.length ? h("div.grid.c2", mine.map((p) => projectCard(p, { showOwner: false }))) : h("div.empty", "아직 프로젝트가 없습니다. 새 논문 연구를 시작하면 프로젝트를 만드세요."),
        ),
      ),
      h("div.stack",
        teamReview.length ? h("div.card", h("div.section-h", h("h2", "검토 요청"), h("p.sub", "팀원이 검토를 기다립니다")),
          h("div.stack", teamReview.slice(0, 8).map((e) => h("a.card.hover.pad-s", { href: `#/project/${e.project_id}?entry=${e.id}` }, h("div", { style: { fontWeight: 700 } }, e.title), h("div.small.muted", `${e.project_title} · ${e.author_name} · ${e.date}`))))) : null,
        h("div.card", h("div.section-h", h("h2", "팀 활동"), h("p.sub", "소속 카테고리 전체")), feedList(feed)),
      ),
    ),
  );
}

function daysAgoStr(n) { return new Date(Date.now() - n * 864e5).toISOString().slice(0, 10); }

export function newProjectDialog(me, categoryId, categoryName) {
  const cats = me.memberships.slice();
  // 관리자가 비구성원 카테고리의 팀 페이지에서 만들 때: 그 카테고리를 선택지에 추가
  if (categoryId && !cats.some((m) => m.category_id === categoryId)) cats.unshift({ category_id: categoryId, category_name: categoryName || categoryId });
  if (!cats.length) { toast("소속 카테고리가 없어 프로젝트를 만들 수 없습니다", true); return; }
  const cat = select(cats.map((m) => ({ value: m.category_id, label: m.category_name })), { value: categoryId || cats[0]?.category_id });
  const title = input({ placeholder: "논문 제목 (가제)", maxlength: 200 });
  const summary = textarea({ placeholder: "연구 질문 · 가설 · 기여점을 한두 문장으로", rows: 3 });
  const venue = input({ placeholder: "예: NeurIPS 2027, KDD, 한국정보과학회" });
  const deadline = input({ type: "date" });
  const tags = input({ placeholder: "쉼표로 구분: LLM, 시계열, 인과추론" });
  modal({
    title: "새 논문 프로젝트",
    body: h("div.stack", field("카테고리", cat), field("제목", title), field("연구 요약", summary), h("div.form-grid", field("목표 학회/저널", venue), field("마감", deadline)), field("태그", tags),
      h("p.help", "논문 트랙: 기획 → 리서치 → 관련기법 → 실험결과 → 논문작성 → 검토·투고. 캡스톤 트랙: 주제·문제 발견 → 시장·사업모델 → MVP 빌드·배포 → 피드백·개선 → 사업성·최종보고 → 최종 발표. 첫 단계에서 시작하며 프로젝트 화면의 [다음 단계로] 버튼으로 넘어갑니다. 팀 프로젝트는 만든 뒤 [팀] 탭에서 협업자를 추가하세요.")),
    actions: [{ label: "취소" }, { label: "만들기", cls: "primary", onClick: async () => {
      if (!title.value.trim()) { toast("제목을 입력하세요", true); return false; }
      const p = await post("/api/projects", { category_id: cat.value, title: title.value.trim(), summary: summary.value, target_venue: venue.value, deadline: deadline.value || null, tags: tags.value });
      toast("프로젝트를 만들었습니다");
      location.hash = `#/project/${p.id}`;
    } }],
  });
}
