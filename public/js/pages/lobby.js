// 팀 로비: 전체 팀 목록 · 가입 · 내 상태
import { state, get, post, del, h, mount, pill, avatar, fmtRel, textarea, select, field, modal, confirmDialog, toast, errToast, loadMe } from "../core.js";

const POLICY = { open: ["즉시 가입", "ok"], approval: ["승인 후 가입", "warn"], closed: ["초대만", "mute"] };

export async function render(container, query) {
  mount(container, h("div.loading", h("span.spinner"), " 불러오는 중…"));
  const teams = await get("/api/lobby");
  const me = state.me;
  // 관리자는 모든 팀에 접근 권한이 있지만, "내 팀" 은 실제 구성원으로 등록된 팀만
  const isMine = (t) => (me.is_admin ? !!t.my_membership : !!t.my_role);
  const mine = teams.filter(isMine);
  const others = teams.filter((t) => !isMine(t));

  const card = (t) => {
    const [pl, pc] = POLICY[t.join_policy] || ["", ""];
    const members = (t.member_names || "").split(",").map((s) => s.trim()).filter(Boolean);
    const actions = h("div.row", { style: { marginTop: "auto", paddingTop: "10px", gap: "6px" } });
    const add = (...els) => actions.append(...els.filter(Boolean));
    if (me.is_admin && !t.my_membership) {
      // 관리자: 접근은 되지만 구성원 목록에는 없음 → 구성원(리드)으로 등록 가능
      add(h("a.btn.primary.sm", { href: `#/team/${t.id}` }, "팀 페이지"), h("button.btn.sm", { onclick: () => joinDialog(t, container) }, "구성원으로 가입"), h("span.tiny.muted", "관리자 권한으로 열람·관리 중"));
    } else if (t.my_role) {
      add(h("a.btn.primary.sm", { href: `#/team/${t.id}` }, "팀 페이지"), t.my_membership ? h("button.btn.ghost.sm", { onclick: () => leave(t, container) }, "탈퇴") : null);
    } else if (t.my_request_status === "pending") {
      add(pill("가입 요청 대기", "warn"), h("span.spacer"), h("button.btn.sm", { onclick: () => leave(t, container) }, "요청 취소"));
    } else if (t.join_policy === "closed" && !me.is_admin) {
      add(h("span.small.muted", "리드나 관리자의 초대가 필요합니다"));
    } else {
      add(h("button.btn.primary.sm", { onclick: () => joinDialog(t, container) }, t.join_policy === "open" || me.is_admin ? "가입하기" : "가입 요청"), t.my_request_status === "rejected" ? pill("이전 요청 거절됨", "bad sm") : null);
    }
    return h("div.card.pcard", { style: { minHeight: "200px" } },
      h("div.row.between.top", h("div.row", { style: { gap: "6px" } }, pill(t.track === "capstone" ? "캡스톤" : "논문", t.track === "capstone" ? "gold sm" : "sm"), pill(pl, pc + " sm"), t.is_public ? pill("공개 열람", "ok sm") : null,
        t.my_membership ? pill(t.my_membership === "lead" ? "리드" : t.my_membership === "evaluator" ? "평가자" : "구성원", "navy sm") : t.my_role === "admin" ? pill("관리자 접근", "mute sm") : null), h("span.small.muted", t.last_activity_at ? `활동 ${fmtRel(t.last_activity_at)}` : "활동 없음")),
      h("div.title", t.name),
      t.description ? h("div.small", { style: { color: "#3C4E57" } }, t.description.length > 140 ? t.description.slice(0, 140) + "…" : t.description) : null,
      h("div.row", { style: { gap: "4px", flexWrap: "wrap", marginTop: "4px" } }, members.slice(0, 8).map((n) => avatar(n)), members.length > 8 ? h("span.tiny.muted", `+${members.length - 8}`) : null),
      h("div.small.muted", `구성원 ${t.member_count}${t.lead_names ? ` · 리드 ${t.lead_names}` : ""} · 진행 중 프로젝트 ${t.active_projects} · 이번 주 기록 ${t.entries_7d}`),
      actions,
    );
  };

  mount(container,
    h("header.hero", { style: { padding: "22px 0 16px" } }, h("div.eyebrow", "Lobby"), h("h1", "팀 로비"), h("p.sub", "연구실의 팀(연구 그룹)을 둘러보고 가입하세요. 여러 팀에 동시에 속할 수 있습니다. 가입하면 팀 페이지에서 팀원들의 프로젝트·활동을 보고 함께 검토합니다.")),
    mine.length ? h("div.section", { style: { marginTop: 0 } }, h("div.section-h", h("h2", "내 팀"), h("p.sub", `${mine.length}개`)), h("div.grid.c3", mine.map(card))) : null,
    h("div.section", h("div.section-h", h("h2", mine.length ? "다른 팀" : "가입 가능한 팀"), h("p.sub", `${others.length}개`)),
      others.length ? h("div.grid.c3", others.map(card)) : h("div.empty", teams.length ? "모든 팀에 이미 속해 있습니다" : "아직 팀이 없습니다. 관리자가 팀을 만들면 여기에 표시됩니다.")),
  );
}

function joinDialog(t, container) {
  const me = state.me;
  const immediate = t.join_policy === "open" || me.is_admin;
  const msg = textarea({ rows: 3, placeholder: "자기소개 · 관심 주제 · 지도교수 등 (리드가 승인 판단에 참고)" });
  const roleSel = select([{ value: "lead", label: "리드 (구성원 목록에 리드로 표시)" }, { value: "member", label: "구성원" }], { value: "lead" });
  modal({
    title: `${t.name} ${immediate ? "가입" : "가입 요청"}`,
    body: h("div.stack", t.description ? h("p.small", { style: { margin: 0, color: "#3C4E57" } }, t.description) : null,
      me.is_admin ? [h("p.small.muted", "관리자는 이미 모든 팀을 열람·관리할 수 있습니다. 가입하면 이 팀의 구성원 목록과 상단 메뉴에 표시됩니다."), field("역할", roleSel)] : immediate ? h("p.small.muted", "즉시 가입됩니다.") : field("메시지 (선택)", msg)),
    actions: [{ label: "취소" }, { label: immediate ? "가입" : "요청 보내기", cls: "primary", onClick: async () => {
      const r = await post(`/api/lobby/${t.id}/join`, { message: msg.value, role: me.is_admin ? roleSel.value : undefined });
      if (r.joined) { toast(`${t.name}에 가입했습니다`); state.me = null; await loadMe(); window.dispatchEvent(new Event("rn:refresh")); }
      else { toast("가입 요청을 보냈습니다. 리드 승인을 기다리세요"); render(container, {}); }
    } }],
  });
}

async function leave(t, container) {
  const isReq = t.my_request_status === "pending" && !t.my_role;
  if (!(await confirmDialog(isReq ? `${t.name} 가입 요청을 취소할까요?` : `${t.name}에서 탈퇴할까요? 팀 프로젝트와 기록을 더 볼 수 없게 됩니다.`, { danger: !isReq, okLabel: isReq ? "요청 취소" : "탈퇴" }))) return;
  try {
    await del(`/api/lobby/${t.id}/join`);
    toast(isReq ? "요청을 취소했습니다" : "탈퇴했습니다");
    state.me = null; await loadMe();
    window.dispatchEvent(new Event("rn:refresh"));
  } catch (e) { errToast(e); }
}
