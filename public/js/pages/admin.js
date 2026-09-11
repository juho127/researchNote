import { state, get, post, patch, put, del, h, mount, pill, avatar, stages, stageLabel, fmtRel, fmtDT, daysSince, input, textarea, field, select, modal, confirmDialog, toast, errToast, copyText, ACTION_LABEL } from "../core.js";
import { ApiError } from "../core.js";
import { feedList } from "./home.js";

export async function render(container, sub, query) {
  const tab = sub || "overview";
  const tabs = h("div.tabs");
  for (const [k, l] of [["overview", "개요"], ["requests", "발급 신청"], ["categories", "카테고리"], ["users", "연구원"], ["tokens", "토큰"], ["activity", "활동 로그"]]) tabs.append(h("button", { class: tab === k ? "active" : "", onclick: () => (location.hash = `#/admin/${k}`) }, l));
  const body = h("div", h("div.loading", h("span.spinner")));
  mount(container, h("header.hero", { style: { padding: "18px 0 6px", border: 0, margin: 0 } }, h("div.eyebrow", "Administration"), h("h1", "관리자 대시보드"), h("p.sub", "카테고리(팀)·연구원·토큰을 관리하고 전체 진행 현황을 봅니다")), tabs, body);
  try {
    if (tab === "overview") await overview(body);
    else if (tab === "requests") await requests(body, query);
    else if (tab === "categories") await categories(body);
    else if (tab === "users") await users(body, query);
    else if (tab === "tokens") await tokens(body, query);
    else await activity(body);
  } catch (e) { mount(body, h("div.empty", e.message)); }
}

// ---------- 개요 ----------
async function overview(body) {
  const o = await get("/api/admin/overview");
  const c = o.counts;
  const stats = [[c.users, "연구원"], [c.categories, "카테고리"], [c.active_projects, "진행 중 프로젝트"], [c.done_projects, "완료 프로젝트"], [c.entries, "전체 기록"], [c.entries_7d, "7일 기록"], [c.entries_30d, "30일 기록"], [c.entries_mcp, "AI(MCP) 기록"], [c.review_requested, "검토 대기"], [c.active_tokens, "활성 토큰"]];
  const pendingBanner = c.pending_requests || c.pending_joins ? h("a.card.hover.pad-s", { href: "#/admin/requests", style: { display: "block", marginBottom: "14px", borderColor: "var(--goldlight)", background: "#FFF9E8" } }, h("b", [c.pending_requests ? `토큰 발급 신청 ${c.pending_requests}건` : null, c.pending_requests && c.pending_joins ? " · " : null, c.pending_joins ? `팀 가입 요청 ${c.pending_joins}건` : null], "이 승인을 기다립니다"), h("span.small.muted", " → 발급 신청 탭에서 처리")) : null;
  const maxStage = Math.max(1, ...Object.values(o.by_stage));
  const trackBlocks = Object.values(o.by_track || {}).filter((t) => t.stages.some((s) => s.n > 0) || Object.keys(o.by_track).length === 1);
  const stageBars = h("div.card", h("h3", "진행 중 프로젝트 · 단계 분포"),
    ...(trackBlocks.length ? trackBlocks : Object.values(o.by_track || {})).map((t) => h("div", { style: { marginTop: "10px" } }, h("div.tiny.muted", { style: { fontWeight: 700, letterSpacing: ".06em", marginBottom: "4px" } }, t.label.toUpperCase() + " 트랙"),
      h("div.stack", { style: { gap: "5px" } }, t.stages.map((s) => h("div.row", h("span.small", { style: { width: "110px" } }, s.label), h("div", { style: { flex: 1, height: "10px", background: "var(--wash)", borderRadius: "5px", overflow: "hidden" } }, h("i", { style: { display: "block", height: "100%", width: `${(s.n / maxStage) * 100}%`, background: t.label === "캡스톤" ? "var(--goldlight)" : "var(--mint)" } })), h("span.small.muted", { style: { width: "24px", textAlign: "right" } }, String(s.n))))))));
  const days = o.daily_activity;
  const maxDay = Math.max(1, ...days.map((d) => d.n));
  const byDay = new Map(days.map((d) => [d.day, d.n]));
  const bars = h("div.bars");
  for (let i = 41; i >= 0; i--) { const d = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10); const n = byDay.get(d) || 0; bars.append(h("i", { style: { height: `${Math.max(4, (n / maxDay) * 100)}%`, opacity: n ? 0.85 : 0.25 }, title: `${d}: ${n}` })); }
  const activityCard = h("div.card", h("h3", "최근 6주 활동 (기록·코멘트·단계·프로젝트)"), h("div", { style: { marginTop: "10px" } }, bars), h("div.row.between.tiny.muted", h("span", "6주 전"), h("span", "오늘")));

  const catTable = h("div.table-wrap", h("table.table", h("thead", h("tr", h("th", "카테고리"), h("th", "구성원"), h("th", "진행 중"), h("th", "7일 기록"), h("th", "30일 기록"), h("th", "마지막 기록"))),
    h("tbody", o.by_category.map((r) => h("tr", h("td", h("a", { href: `#/team/${r.id}`, style: { fontWeight: 700 } }, r.name)), h("td", String(r.members)), h("td", String(r.active_projects)), h("td", String(r.entries_7d)), h("td", String(r.entries_30d)), h("td", { class: daysSince(r.last_entry_at) > 14 ? "stale" : "" }, r.last_entry_at ? fmtRel(r.last_entry_at) : "없음"))))));
  const userTable = h("div.table-wrap", h("table.table", h("thead", h("tr", h("th", "연구원"), h("th", "소속"), h("th", "진행 중"), h("th", "7일"), h("th", "30일"), h("th", "마지막 기록"), h("th", "최근 접속"))),
    h("tbody", o.per_user.map((u) => h("tr", { class: u.role === "admin" ? "dim" : "" }, h("td", h("span.row", { style: { gap: "5px" } }, avatar(u.name), u.name, u.role === "admin" ? pill("관리자", "gold sm") : null)), h("td.small", u.category_names || "-"), h("td", String(u.active_projects)), h("td", String(u.entries_7d)), h("td", String(u.entries_30d)), h("td", { class: u.role !== "admin" && daysSince(u.last_entry_at) > 14 ? "stale" : "" }, u.last_entry_at ? fmtRel(u.last_entry_at) : "없음"), h("td.small.muted", u.last_seen_at ? fmtRel(u.last_seen_at) : "-"))))));
  const rq = o.review_queue.length ? h("div.stack", o.review_queue.map((e) => h("a.card.hover.pad-s", { href: `#/project/${e.project_id}?entry=${e.id}` }, h("div.row", pill(stageLabel(e.stage), "sm"), h("b", e.title), h("span.spacer"), h("span.tiny.muted", fmtRel(e.updated_at))), h("div.small.muted", `${e.category_name} · ${e.project_title} · ${e.author_name}`)))) : h("div.small.muted", "검토 대기 없음");
  const dl = o.deadlines.length ? h("div.stack", o.deadlines.map((p) => h("a.card.hover.pad-s", { href: `#/project/${p.id}` }, h("div.row", h("b", p.deadline), h("span", p.title), h("span.spacer"), pill(stageLabel(p.stage), "sm")), h("div.small.muted", `${p.category_name} · ${p.owner_name}${p.target_venue ? " · " + p.target_venue : ""}`)))) : h("div.small.muted", "다가오는 마감 없음");

  mount(body,
    pendingBanner,
    h("div.grid.c4", stats.map(([n, l]) => h("div.card.stat", h("div.n", String(n)), h("div.l", l)))),
    h("div.grid.c2", { style: { marginTop: "14px" } }, stageBars, activityCard),
    h("div.section", h("div.section-h", h("h2", "카테고리별 현황")), catTable),
    h("div.section", h("div.section-h", h("h2", "연구원별 현황"), h("p.sub", "14일 이상 기록이 없으면 붉게 표시")), userTable),
    h("div.grid.c2", { style: { marginTop: "22px" } }, h("div", h("div.section-h", h("h2", "검토 대기")), rq), h("div", h("div.section-h", h("h2", "다가오는 마감")), dl)),
  );
}

// ---------- 발급 신청 ----------
async function requests(body, query) {
  const status = query.status || "pending";
  const [list, cats] = await Promise.all([get(`/api/admin/requests?status=${status}`), get("/api/admin/categories")]);
  const seg = h("div.seg");
  for (const [k, l] of [["pending", "대기"], ["approved", "승인됨"], ["rejected", "거절됨"], ["all", "전체"]]) seg.append(h("button", { class: status === k ? "active" : "", onclick: () => (location.hash = `#/admin/requests?status=${k}`) }, l));
  const origin = location.origin;
  const rows = list.map((r) => h("tr", { class: r.status === "pending" ? "" : "dim" },
    h("td", h("b", r.name), r.kind === "reissue" ? [" ", pill("재발급", "navy sm")] : null, h("div.tiny.muted", r.email || "-"), r.kind === "reissue" && r.user_id ? h("div.tiny.muted", `계정: ${r.user_id}`) : null),
    h("td.small", r.category_name || h("span.muted", "미정")),
    h("td.small", { style: { maxWidth: "280px" } }, r.note || ""),
    h("td.small.muted", fmtDT(r.created_at)),
    h("td", r.status === "pending" ? pill("대기", "warn sm") : r.status === "approved" ? [pill("승인", "ok sm"), r.claimed_at ? h("div.tiny.muted", `수령 ${fmtRel(r.claimed_at)}`) : h("div.tiny", { style: { color: "var(--brick)" } }, "미수령")] : pill("거절", "bad sm"),
      r.decided_at ? h("div.tiny.muted", `${r.decided_by_name || ""} · ${fmtRel(r.decided_at)}`) : null, r.decision_note && r.status === "rejected" ? h("div.tiny.muted", r.decision_note) : null),
    h("td.right", r.status === "pending"
      ? h("div.row", { style: { justifyContent: "flex-end", gap: "4px" } }, h("button.btn.xs.primary", { onclick: () => (r.kind === "reissue" ? reissueApproveDialog(r, body) : approveDialog(r, cats, body)) }, "승인"), h("button.btn.xs.danger", { onclick: () => rejectDialog(r, body) }, "거절"))
      : h("div.row", { style: { justifyContent: "flex-end", gap: "4px" } },
          r.status === "approved" ? h("button.btn.xs" + (r.claimed_at ? "" : ".primary"), { title: r.claimed_at ? "이미 수령했지만 토큰을 잃어버린 경우 (기존 토큰은 유지)" : "학생이 수령 코드를 잃어버린 경우 새 코드를 만들어 전달", onclick: () => reissueClaimDialog(r, body, query) }, r.claimed_at ? "코드 재발급" : "수령 코드 재발급") : null,
          r.user_id ? h("a.btn.xs", { href: "#/admin/users" }, "연구원") : null,
          h("button.btn.ghost.xs", { onclick: async () => { if (await confirmDialog("이 신청 기록을 삭제할까요?", { danger: true, okLabel: "삭제" })) { await del(`/api/admin/requests/${r.id}`); render(body.parentElement, "requests", query); } } }, "삭제"))),
  ));
  const joins = await get(`/api/join-requests?status=${status === "all" ? "all" : status === "pending" ? "pending" : status}`);
  const joinRows = joins.map((r) => h("tr", { class: r.status === "pending" ? "" : "dim" },
    h("td", h("b", r.user_name), h("div.tiny.muted", r.user_email || r.user_id)),
    h("td", h("a", { href: `#/team/${r.category_id}?view=members` }, r.category_name)),
    h("td.small", { style: { maxWidth: "280px" } }, r.message || ""),
    h("td.small.muted", fmtDT(r.created_at)),
    h("td", r.status === "pending" ? pill("대기", "warn sm") : r.status === "approved" ? pill("승인", "ok sm") : r.status === "rejected" ? pill("거절", "bad sm") : pill("취소", "mute sm"), r.decided_at ? h("div.tiny.muted", `${r.decided_by_name || ""} · ${fmtRel(r.decided_at)}`) : null),
    h("td.right", r.status === "pending" ? h("div.row", { style: { justifyContent: "flex-end", gap: "4px" } },
      h("button.btn.xs.primary", { onclick: async () => { await post(`/api/join-requests/${r.id}/approve`, {}); toast("승인했습니다"); render(body.parentElement, "requests", query); } }, "승인"),
      h("button.btn.xs.danger", { onclick: async () => { await post(`/api/join-requests/${r.id}/reject`, { note: "" }); toast("거절했습니다"); render(body.parentElement, "requests", query); } }, "거절")) : null),
  ));
  mount(body,
    h("div.row.between", { style: { marginBottom: "12px" } }, h("div.row", seg, h("button.btn.ghost.xs", { title: "핀 열람·토큰 재발급에서 5회 틀려 잠긴 IP 를 모두 풉니다", onclick: async () => { if (await confirmDialog("핀·재발급 시도 잠금을 모두 해제할까요?", { okLabel: "해제" })) { const r = await post("/api/admin/locks/clear", {}); toast(`잠금 ${r.cleared}건 해제`); } } }, "잠금 해제")), h("span.small.muted", "신청: ", h("a", { href: "#/apply", target: "_blank" }, `${origin}/#/apply`), " · 재발급: ", h("a", { href: "#/reissue", target: "_blank" }, `${origin}/#/reissue`), " · AI 연동: ", h("a", { href: "#/connect", target: "_blank" }, `${origin}/connect`))),
    h("div.section-h", { style: { marginTop: 0 } }, h("h2", "토큰 발급 신청"), h("p.sub", `${list.length}건 · 신규 연구원`)),
    list.length ? h("div.table-wrap", h("table.table", h("thead", h("tr", h("th", "신청자"), h("th", "희망 카테고리"), h("th", "메모"), h("th", "신청일"), h("th", "상태"), h("th", ""))), h("tbody", rows))) : h("div.empty", status === "pending" ? "대기 중인 신청이 없습니다" : "신청이 없습니다"),
    h("p.small.muted", { style: { marginTop: "10px" } }, "승인하면 연구원 계정과 소속이 만들어지고, 신청자는 자기 수령 코드로 토큰을 직접 1회 수령합니다(관리자는 토큰을 보지 않음). ", h("b", "미수령"), " 상태가 오래가면 학생이 수령 코드를 잃어버린 경우가 대부분입니다 → [수령 코드 재발급]으로 새 코드를 만들어 전달하세요 (또는 [연구원] 탭에서 토큰을 직접 발급). 학생이 로그인 창에 수령 코드(clm_)를 넣으면 '토큰이 아님' 안내와 함께 수령 페이지로 이동합니다."),
    h("div.section-h", { style: { marginTop: "26px" } }, h("h2", "팀 가입 요청"), h("p.sub", `${joins.length}건 · 기존 연구원의 로비 가입 요청 (팀 리드도 팀 페이지에서 처리 가능)`)),
    joins.length ? h("div.table-wrap", h("table.table", h("thead", h("tr", h("th", "연구원"), h("th", "팀"), h("th", "메시지"), h("th", "요청일"), h("th", "상태"), h("th", ""))), h("tbody", joinRows))) : h("div.empty", "팀 가입 요청이 없습니다"),
  );
}
function approveDialog(r, cats, body) {
  const name = input({ value: r.name });
  const id = input({ placeholder: "비우면 이름에서 자동 생성 (영문·숫자·하이픈)" });
  const email = input({ value: r.email || "" });
  const cat = select([{ value: "", label: "소속 없음 (나중에 배정)" }, ...cats.map((c) => ({ value: c.id, label: c.name }))], { value: r.category_id || "" });
  const role = select([{ value: "member", label: "구성원" }, { value: "lead", label: "리드 (검토 승인 권한)" }, { value: "evaluator", label: "평가자 (평가·코멘트만)" }], { value: "member" });
  const note = input({ value: r.note || "" });
  modal({ title: `승인 — ${r.name}`, body: h("div.stack", h("div.form-grid", field("이름", name), field("ID", id), field("이메일", email)), h("div.form-grid", field("소속 카테고리", cat), field("역할", role)), field("메모", note), h("p.help", "승인 즉시 계정이 생성됩니다. 토큰은 신청자가 수령 코드로 직접 받습니다.")),
    actions: [{ label: "취소" }, { label: "승인", cls: "primary", onClick: async () => {
      const payload = { name: name.value.trim(), id: id.value.trim() || undefined, email: email.value.trim(), category_id: cat.value || null, role: role.value, note: note.value };
      try { await post(`/api/admin/requests/${r.id}/approve`, payload); }
      catch (e) {
        if (e instanceof ApiError && e.code === "duplicate_email") {
          // 같은 이메일 계정이 이미 있음: 중복 신청이면 거절, 별도 계정이면 강행
          const go = await confirmDialog(`${e.message}\n\n그래도 별도 계정으로 승인할까요? (중복 신청이면 [취소] 후 거절하고 기존 계정의 수령 코드를 재발급하세요)`, { okLabel: "별도 계정으로 승인" });
          if (!go) return false;
          await post(`/api/admin/requests/${r.id}/approve`, { ...payload, force: true });
        } else throw e;
      }
      toast("승인했습니다"); render(body.parentElement, "requests", {});
    } }] });
}
function reissueClaimDialog(r, body, query) {
  modal({ title: `수령 코드 재발급 — ${r.name}`, body: h("div.stack",
      h("p", r.claimed_at ? "이 신청자는 이미 토큰을 한 번 수령했습니다. 재발급하면 새 수령 코드로 토큰을 한 번 더 받을 수 있고, 기존 토큰은 그대로 유효합니다 (유출이 의심되면 [토큰] 탭에서 회수)." : "새 수령 코드를 만들어 신청자에게 전달하세요. 이전 코드는 즉시 무효가 됩니다."),
      h("p.help", "코드는 지금 한 번만 표시됩니다. 관리자는 토큰을 보지 않고, 신청자가 코드로 직접 받습니다.")),
    actions: [{ label: "취소" }, { label: "재발급", cls: "primary", onClick: async () => {
      const res = await post(`/api/admin/requests/${r.id}/reissue-claim`);
      const link = `${location.origin}/#/claim/${res.claim_code}`;
      modal({ title: `새 수령 코드 — ${res.name}`, wide: true, body: h("div.stack",
          h("div", h("div.small.muted", "수령 코드"), h("div.tokenbox", res.claim_code)),
          h("div", h("div.small.muted", "수령 링크 (이 링크에서 [토큰 받기])"), h("div.tokenbox", { style: { background: "var(--wash)", color: "var(--navy)" } }, link)),
          h("div.row", h("button.btn.sm", { onclick: () => copyText(res.claim_code) }, "코드 복사"), h("button.btn.sm.primary", { onclick: () => copyText(`${res.name} 님, 연구노트 토큰 수령 링크입니다 (1회):\n${link}\n\n[토큰 받기]를 누르면 rn_ 로 시작하는 토큰이 표시됩니다. 그 토큰으로 로그인하세요 (수령 코드가 아니라 토큰으로).`) }, "안내문 복사")),
        ), actions: [{ label: "닫기", onClick: () => render(body.parentElement, "requests", query) }] });
    } }] });
}
function reissueApproveDialog(r, body) {
  const revoke = h("input", { type: "checkbox", checked: true });
  modal({ title: `토큰 재발급 승인 — ${r.name}`, body: h("div.stack",
      h("p", "기존 계정 ", h("code", r.user_id), " 의 토큰 재발급 요청입니다. 승인하면 본인이 수령 코드로 새 토큰을 1회 받습니다 (관리자는 토큰을 보지 않음)."),
      r.note ? h("p.small.muted", `사유: ${r.note}`) : null,
      h("label.check", revoke, "기존 토큰 모두 회수 (분실·유출이면 켜두세요. 새 기기 추가면 끄세요)"),
    ),
    actions: [{ label: "취소" }, { label: "승인", cls: "primary", onClick: async () => {
      const res = await post(`/api/admin/requests/${r.id}/approve`, { revoke_existing: revoke.checked });
      toast(`승인했습니다${res.revoked ? ` · 기존 토큰 ${res.revoked}건 회수` : ""}`); render(body.parentElement, "requests", {});
    } }] });
}
function rejectDialog(r, body) {
  const reason = textarea({ rows: 3, placeholder: "사유 (신청자에게 표시)" });
  modal({ title: `거절 — ${r.name}`, body: field("사유", reason),
    actions: [{ label: "취소" }, { label: "거절", cls: "danger", onClick: async () => { await post(`/api/admin/requests/${r.id}/reject`, { reason: reason.value }); toast("거절했습니다"); render(body.parentElement, "requests", {}); } }] });
}

// ---------- 카테고리 ----------
async function categories(body) {
  const cats = await get("/api/admin/categories?all=1");
  const POL = { open: ["즉시", "ok"], approval: ["승인", "warn"], closed: ["초대", "mute"] };
  const pubCell = (c) => {
    if (!c.is_public) return h("span.tiny.muted", "-");
    const p = c.pin_set ? pill("공개 · 핀", "ok sm") : pill("공개 · 핀 없음", "warn sm");
    const n = c.active_viewers ? h("div.tiny.muted", `열람 세션 ${c.active_viewers}`, " ", h("button.btn.ghost.xs", { title: "지금 열람 중인 세션을 모두 끊습니다 (핀은 유지)", onclick: async () => { if (await confirmDialog(`${c.name} 의 열람 세션 ${c.active_viewers}건을 만료시킬까요? (핀은 유지)`, { okLabel: "만료" })) { await post(`/api/admin/categories/${c.id}/viewers/revoke`); toast("열람 세션을 만료시켰습니다"); categories(body); } } }, "만료")) : null;
    return h("div", p, n);
  };
  const table = h("div.table-wrap", h("table.table", h("thead", h("tr", h("th", "이름"), h("th", "트랙"), h("th", "ID"), h("th", "설명"), h("th", "가입"), h("th", "공개 열람"), h("th", "리드"), h("th", "구성원"), h("th", "프로젝트"), h("th", ""))),
    h("tbody", cats.map((c) => h("tr", { class: c.archived_at ? "dim" : "" },
      h("td", h("a", { href: `#/team/${c.id}`, style: { fontWeight: 700 } }, c.name), c.archived_at ? [" ", pill("보관", "mute sm")] : null),
      h("td", pill(c.track === "capstone" ? "캡스톤" : "논문", c.track === "capstone" ? "gold sm" : "sm")),
      h("td", h("code", c.id)), h("td.small", c.description || ""), h("td", pill((POL[c.join_policy] || [c.join_policy, ""])[0], (POL[c.join_policy] || ["", ""])[1] + " sm")), h("td", pubCell(c)), h("td.small", c.lead_names || "-"), h("td", String(c.member_count)), h("td", String(c.project_count)),
      h("td.right", h("button.btn.xs", { onclick: () => categoryDialog(c, body) }, "수정")))))));
  const viewUrl = `${location.origin}/#/view`;
  mount(body, h("div.row.between", { style: { marginBottom: "12px" } }, h("p.small.muted", "카테고리 = 연구 그룹/팀. 같은 카테고리 구성원끼리 프로젝트를 공유·검토합니다. 공개 열람을 켜고 핀을 정하면 외부인이 ", h("a", { href: "#/view", target: "_blank" }, viewUrl), " 에서 핀만으로 읽기 전용 열람(24시간)을 할 수 있습니다."), h("button.btn.primary", { onclick: () => categoryDialog(null, body) }, "+ 카테고리")), cats.length ? table : h("div.empty", "카테고리를 만들어 연구원을 배정하세요"));
}
function categoryDialog(c, body) {
  const name = input({ value: c?.name || "", placeholder: "예: LLM 응용, 시계열 예측, 인과추론" });
  const id = input({ value: c?.id || "", placeholder: "비우면 이름에서 자동 생성 (영문·숫자·하이픈)", disabled: !!c });
  const desc = textarea({ value: c?.description || "", rows: 3, placeholder: "연구 주제·목표 (팀 페이지·로비·보고서에 표시)" });
  const policy = select([{ value: "approval", label: "승인 후 가입 (리드·관리자가 로비 가입 요청을 승인)" }, { value: "open", label: "즉시 가입 (로비에서 누구나)" }, { value: "closed", label: "초대만 (관리자가 직접 배정)" }], { value: c?.join_policy || "approval" });
  const trackSel = select([{ value: "paper", label: "논문 — 기획 → 리서치 → 관련기법 → 실험결과 → 논문작성 → 검토·투고" }, { value: "capstone", label: "캡스톤 — 주제·문제 발견 → 시장·사업모델 → MVP 빌드·배포 → 피드백·개선 → 사업성·최종보고 → 최종 발표" }], { value: c?.track || "paper", disabled: !!(c && c.project_count > 0) });
  const archived = h("input", { type: "checkbox", checked: !!c?.archived_at });
  // 공개 열람 · 핀
  const isPublic = h("input", { type: "checkbox", checked: !!c?.is_public });
  const pin = input({ placeholder: c?.pin_set ? "설정됨 · 바꾸려면 새 핀 입력 (영문·숫자 4~12자)" : "영문·숫자 4~12자 (예: 2026a)", maxlength: 12, autocomplete: "off", spellcheck: false, disabled: !isPublic.checked });
  const clearPin = h("input", { type: "checkbox", disabled: !isPublic.checked || !c?.pin_set });
  const pinHelp = h("span.help", c?.pin_set ? `핀 설정됨${c.pin_updated_at ? ` (${fmtRel(c.pin_updated_at)} 변경)` : ""} · 핀을 바꾸거나 해제하면 현재 열람 세션은 모두 끊깁니다` : "핀이 없으면 공개로 표시되어도 열람할 수 없습니다");
  isPublic.addEventListener("change", () => { pin.disabled = !isPublic.checked; clearPin.disabled = !isPublic.checked || !c?.pin_set; });
  const publicBox = h("div.card.pad-s", { style: { background: "var(--wash)" } },
    h("label.check", isPublic, h("b", "공개 열람 허용"), h("span.small.muted", " — 토큰·가입 없이 핀만으로 읽기 전용 열람 (세션 24시간, 5회 오류 시 10분 잠금)")),
    h("div.form-grid", { style: { marginTop: "8px" } }, h("label.field", h("span", c?.pin_set ? "새 핀 (비우면 유지)" : "핀"), pin, pinHelp), c?.pin_set ? h("label.check", { style: { alignSelf: "end" } }, clearPin, "핀 해제 (열람 중단)") : null),
    h("p.help", { style: { margin: "6px 0 0" } }, "열람자는 프로젝트·기록·단계 정리·공개된 평가·보고서를 볼 수 있고, 구성원 이메일·가입 요청·초안 평가는 보지 못합니다. 열람 페이지: ", h("code", `${location.origin}/#/view`)),
  );
  modal({ title: c ? "카테고리 수정" : "새 카테고리", wide: true, body: h("div.stack", field("이름", name), field("ID", id), field("설명", desc), field("트랙 (단계 구성·평가 루브릭)", trackSel, c && c.project_count > 0 ? "프로젝트가 있는 카테고리는 트랙을 바꿀 수 없습니다" : "캡스톤 트랙은 팀 프로젝트(협업자)·마일스톤·루프 기반 평가 루브릭을 씁니다"), field("가입 정책", policy, "팀 로비에서의 가입 방식"), publicBox, c ? h("label.check", archived, "보관 (목록에서 숨김, 구성원 접근 차단)") : null),
    actions: [{ label: "취소" }, { label: c ? "저장" : "만들기", cls: "primary", onClick: async () => {
      if (!name.value.trim()) { toast("이름을 입력하세요", true); return false; }
      const pinVal = pin.value.trim();
      if (isPublic.checked && !c?.pin_set && !pinVal && !clearPin.checked) { toast("공개 열람을 켜려면 핀을 정하세요", true); pin.focus(); return false; }
      const pinField = clearPin.checked ? "" : pinVal || undefined; // undefined = 변경 없음
      if (c) await patch(`/api/admin/categories/${c.id}`, { name: name.value.trim(), description: desc.value, archived: archived.checked, join_policy: policy.value, track: trackSel.value, is_public: isPublic.checked, pin: pinField });
      else await post("/api/admin/categories", { name: name.value.trim(), description: desc.value, id: id.value.trim() || undefined, join_policy: policy.value, track: trackSel.value, is_public: isPublic.checked, pin: pinField });
      toast("저장했습니다"); state.me = null; window.dispatchEvent(new Event("rn:refresh"));
    } }] });
}

// ---------- 연구원 ----------
async function users(body, query) {
  const [list, cats] = await Promise.all([get("/api/admin/users"), get("/api/admin/categories")]);
  const q = input({ placeholder: "이름·이메일·ID 검색", style: { width: "240px" } });
  const tbody = h("tbody");
  const draw = () => {
    const term = q.value.trim().toLowerCase();
    mount(tbody, list.filter((u) => !term || [u.name, u.email, u.id].some((x) => (x || "").toLowerCase().includes(term))).map((u) => h("tr", { class: u.disabled_at ? "dim" : "" },
      h("td", h("span.row", { style: { gap: "6px" } }, avatar(u.name), h("span", h("b", u.name), u.role === "admin" ? [" ", pill("관리자", "gold sm")] : null, u.disabled_at ? [" ", pill("비활성", "mute sm")] : null, h("div.tiny.muted", u.id + (u.email ? " · " + u.email : ""))))),
      h("td", h("div.chip-list", (u.memberships || []).map((m) => h("span.chip", m.category_name, m.role === "lead" ? pill("리드", "gold sm") : m.role === "evaluator" ? pill("평가자", "ai sm") : null)), !u.memberships?.length ? h("span.tiny.muted", "소속 없음") : null)),
      h("td", h("span", `${u.active_tokens}/${u.token_count}`), " ", h("button.btn.xs", { onclick: () => issueTokenDialog(u) }, "발급")),
      h("td", String(u.project_count)), h("td", String(u.entry_count)),
      h("td", { class: u.role !== "admin" && !u.disabled_at && daysSince(u.last_entry_at) > 14 ? "stale" : "" }, u.last_entry_at ? fmtRel(u.last_entry_at) : "없음"),
      h("td.right", h("button.btn.xs", { onclick: () => userDialog(u, cats, body) }, "수정")),
    )));
  };
  q.addEventListener("input", draw);
  draw();
  mount(body,
    h("div.row.between", { style: { marginBottom: "12px" } }, h("div.row", q, h("span.small.muted", `${list.length}명`)), h("button.btn.primary", { onclick: () => userDialog(null, cats, body) }, "+ 연구원 등록")),
    h("div.table-wrap", h("table.table", h("thead", h("tr", h("th", "연구원"), h("th", "소속 (카테고리)"), h("th", "토큰 활성/전체"), h("th", "프로젝트"), h("th", "기록"), h("th", "마지막 기록"), h("th", ""))), tbody)),
    h("p.small.muted", { style: { marginTop: "10px" } }, "토큰은 발급 시 한 번만 표시됩니다(서버에는 해시만 저장). 잃어버리면 회수 후 재발급하세요."),
  );
}
function membershipEditor(cats, initial = []) {
  const stateMap = new Map(initial.map((m) => [m.category_id, m.role]));
  const wrap = h("div.stack", { style: { gap: "6px" } });
  const rows = [];
  if (!cats.length) wrap.append(h("span.small.muted", "카테고리가 없습니다. 먼저 카테고리를 만드세요."));
  for (const c of cats) {
    const cb = h("input", { type: "checkbox", checked: stateMap.has(c.id) });
    const roleSel = select([{ value: "member", label: "구성원" }, { value: "lead", label: "리드 (검토 승인·가입 승인·평가)" }, { value: "evaluator", label: "평가자 (평가·코멘트만, 여러 명 가능)" }], { value: stateMap.get(c.id) || "member", disabled: !cb.checked, style: { width: "260px" } });
    cb.addEventListener("change", () => { roleSel.disabled = !cb.checked; });
    rows.push({ id: c.id, cb, roleSel });
    wrap.append(h("div.row", h("label.check", { style: { minWidth: "220px" } }, cb, c.name, " ", pill(c.track === "capstone" ? "캡스톤" : "논문", "sm")), roleSel));
  }
  return { el: wrap, value: () => rows.filter((r) => r.cb.checked).map((r) => ({ category_id: r.id, role: r.roleSel.value })) };
}
function userDialog(u, cats, body) {
  const name = input({ value: u?.name || "", placeholder: "이름" });
  const id = input({ value: u?.id || "", placeholder: "비우면 이름에서 자동 생성", disabled: !!u });
  const email = input({ value: u?.email || "", placeholder: "이메일 (선택)" });
  const role = select([{ value: "member", label: "연구원" }, { value: "admin", label: "관리자 (전체 권한)" }], { value: u?.role || "member" });
  const note = input({ value: u?.note || "", placeholder: "메모 (학번·과정 등)" });
  const mem = membershipEditor(cats, u?.memberships || []);
  const issue = h("input", { type: "checkbox", checked: !u });
  const disabled = h("input", { type: "checkbox", checked: !!u?.disabled_at });
  modal({
    title: u ? `연구원 수정 — ${u.name}` : "연구원 등록", wide: true,
    body: h("div.stack", h("div.form-grid", field("이름", name), field("ID", id), field("이메일", email), field("권한", role)), field("메모", note), h("div.field", h("span", "소속 카테고리"), mem.el), u ? h("label.check", disabled, "비활성화 (로그인·MCP 차단)") : h("label.check", issue, "등록과 동시에 토큰 발급")),
    actions: [{ label: "취소" }, { label: u ? "저장" : "등록", cls: "primary", onClick: async () => {
      if (!name.value.trim()) { toast("이름을 입력하세요", true); return false; }
      const payload = { name: name.value.trim(), email: email.value.trim(), role: role.value, note: note.value, categories: mem.value() };
      if (u) { await patch(`/api/admin/users/${u.id}`, { ...payload, disabled: disabled.checked }); toast("저장했습니다"); render(body.parentElement, "users", {}); }
      else { const r = await post("/api/admin/users", { ...payload, id: id.value.trim() || undefined, issue_token: issue.checked }); toast("등록했습니다"); if (r.token) tokenReveal(r.user, r.token); render(body.parentElement, "users", {}); }
    } }],
  });
}
export function issueTokenDialog(u) {
  const label = input({ placeholder: "용도 (예: 노트북, Claude Code)" });
  modal({ title: `토큰 발급 — ${u.name || u.user_name}`, body: h("div.stack", field("라벨", label), h("p.help", "새 토큰을 발급해도 기존 토큰은 유지됩니다. 분실 시에는 [토큰] 탭에서 기존 것을 회수하세요.")),
    actions: [{ label: "취소" }, { label: "발급", cls: "primary", onClick: async () => { const r = await post("/api/admin/tokens", { user_id: u.id || u.user_id, label: label.value }); tokenReveal(u, r.token); } }] });
}
function tokenReveal(u, token) {
  const origin = location.origin;
  const cmd = `claude mcp add --transport http research-note ${origin}/mcp --header "Authorization: Bearer ${token}"`;
  modal({ title: `토큰 — ${u.name || u.user_name}`, wide: true,
    body: h("div.stack",
      h("p", "아래 토큰은 지금 한 번만 표시됩니다. 연구원에게 안전한 채널로 전달하세요."),
      h("div.tokenbox", token), h("div.row", h("button.btn.sm", { onclick: () => copyText(token) }, "토큰 복사"), h("button.btn.sm", { onclick: () => copyText(`${origin}\n토큰: ${token}\n\nClaude Code 연동:\n${cmd}`) }, "안내문 복사")),
      h("p.small.muted", "연구원 안내: 1) 위 주소로 접속해 토큰으로 로그인 2) AI 도구 연동은 [설정] 페이지 참고"),
      h("pre", { style: { fontSize: "12px" } }, cmd),
    ), actions: [{ label: "닫기" }] });
}

// ---------- 토큰 ----------
async function tokens(body, query) {
  const [list, users] = await Promise.all([get("/api/admin/tokens"), get("/api/admin/users")]);
  const sel = select([{ value: "", label: "연구원 선택…" }, ...users.filter((u) => !u.disabled_at).map((u) => ({ value: u.id, label: u.name }))], { style: { width: "200px" } });
  const btn = h("button.btn.primary", { onclick: () => { const u = users.find((x) => x.id === sel.value); if (!u) { toast("연구원을 선택하세요", true); return; } issueTokenDialog(u); } }, "토큰 발급");
  const table = h("div.table-wrap", h("table.table", h("thead", h("tr", h("th", "연구원"), h("th", "토큰"), h("th", "라벨"), h("th", "발급"), h("th", "마지막 사용"), h("th", "상태"), h("th", ""))),
    h("tbody", list.map((t) => h("tr", { class: t.revoked_at ? "dim" : "" }, h("td", t.user_name), h("td", h("code", t.hint)), h("td.small", t.label || ""), h("td.small.muted", fmtDT(t.created_at)), h("td.small.muted", t.last_used_at ? fmtRel(t.last_used_at) : "미사용"), h("td", t.revoked_at ? pill("회수됨", "mute sm") : pill("활성", "ok sm")),
      h("td.right", t.revoked_at ? null : h("button.btn.xs.danger", { onclick: async () => { if (await confirmDialog(`${t.user_name} 의 토큰 ${t.hint} 을 회수할까요? 즉시 로그인·MCP 접근이 차단됩니다.`, { danger: true, okLabel: "회수" })) { await post(`/api/admin/tokens/${t.id}/revoke`); toast("회수했습니다"); render(body.parentElement, "tokens", {}); } } }, "회수")))))));
  mount(body, h("div.row", { style: { marginBottom: "12px" } }, sel, btn, h("span.spacer"), h("span.small.muted", `활성 ${list.filter((t) => !t.revoked_at).length} / 전체 ${list.length}`)), list.length ? table : h("div.empty", "발급된 토큰이 없습니다"));
}

// ---------- 활동 로그 ----------
async function activity(body) {
  const rows = await get("/api/admin/activity?limit=150");
  mount(body, h("div.card", feedList(rows)));
}
