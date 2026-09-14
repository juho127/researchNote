// 핀 열람 (#/view, #/view/<팀id>): 공개 카테고리를 토큰 없이 핀만으로 읽기 전용 열람
import { h, mount, input, field, pill, fmtRel, fmtDT, toast, errToast, setToken, getToken, state } from "../core.js";
import { loadPublicConfig, shell } from "./apply.js";

async function pub(method, path, body) {
  const r = await fetch(path, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(data.message || `HTTP ${r.status}`); e.status = r.status; e.code = data.error; throw e; }
  return data;
}

export async function renderView(container, teamId, query = {}) {
  const cfg = await loadPublicConfig();
  let teams = [];
  try { teams = await pub("GET", "/api/public/teams"); } catch (e) { errToast(e); }
  const tok = getToken();
  const loggedIn = tok && !tok.startsWith("rnv_");
  const viewing = tok && tok.startsWith("rnv_");

  const notice = query.expired
    ? h("div.card.pad-s", { style: { borderColor: "var(--goldlight)", background: "#FFF9E8", marginBottom: "14px" } }, h("b", "열람 세션이 만료되었거나 유효하지 않습니다."), ` 핀을 다시 입력하세요 (세션은 ${cfg.viewer_until ? cfg.viewer_until + "까지" : "24시간"} 유지).`)
    : loggedIn
      ? h("div.card.pad-s", { style: { marginBottom: "14px" } }, "이미 개인 토큰으로 로그인되어 있습니다. 핀으로 열람하면 이 브라우저는 열람 모드로 바뀝니다. ", h("a", { href: "#/" }, "내 연구노트로 가기"))
      : viewing
        ? h("div.card.pad-s", { style: { marginBottom: "14px" } }, "현재 열람 모드입니다. ", h("a", { href: `#/team/${state.me?.viewer?.category_id || ""}` }, "열람 중인 팀으로 가기"))
        : null;

  const card = (t) => {
    const open = teamId === t.id || (!teamId && teams.length === 1);
    const pin = input({ type: "password", inputmode: "numeric", autocomplete: "one-time-code", placeholder: "핀 (영문·숫자 4~12자)", maxlength: 12, spellcheck: false });
    const label = input({ placeholder: "이름·소속 (선택, 예: 심사위원 홍길동)", maxlength: 60 });
    const btn = h("button.btn.primary", { type: "submit" }, "열람 시작");
    const form = h("form.stack", { style: { display: open ? "" : "none", marginTop: "10px", gap: "8px" }, onsubmit: async (e) => {
      e.preventDefault();
      if (!pin.value.trim()) { toast("핀을 입력하세요", true); pin.focus(); return; }
      btn.disabled = true;
      try {
        const r = await pub("POST", `/api/public/teams/${encodeURIComponent(t.id)}/pin`, { pin: pin.value.trim(), label: label.value.trim() });
        setToken(r.viewer_token); state.me = null;
        toast(`${r.category.name} 열람을 시작합니다 (${r.until ? r.until + "까지" : "24시간"})`);
        location.hash = `#/team/${t.id}`;
      } catch (ex) { errToast(ex); btn.disabled = false; pin.select(); }
    } }, field("핀", pin), field("열람자 표시 이름", label), h("div.row", { style: { justifyContent: "flex-end" } }, btn));
    const toggle = h("button.btn.sm" + (open ? ".ghost" : ".primary"), { type: "button", onclick: () => { const on = form.style.display === "none"; form.style.display = on ? "" : "none"; toggle.textContent = on ? "접기" : "핀 입력"; if (on) setTimeout(() => pin.focus(), 30); } }, open ? "접기" : "핀 입력");
    if (open) setTimeout(() => pin.focus(), 60);
    return h("div.card.pcard", { id: `view-${t.id}` },
      h("div.row.between.top", h("div.row", { style: { gap: "6px" } }, pill(t.track === "capstone" ? "캡스톤" : "논문", t.track === "capstone" ? "gold sm" : "sm"), pill("공개 열람", "ok sm")), h("span.small.muted", t.last_activity_at ? `활동 ${fmtRel(t.last_activity_at)}` : "활동 없음")),
      h("div.title", t.name),
      t.description ? h("div.small", { style: { color: "#3C4E57" } }, t.description.length > 160 ? t.description.slice(0, 160) + "…" : t.description) : null,
      h("div.small.muted", `구성원 ${t.member_count} · 진행 중 프로젝트 ${t.active_projects}`),
      h("div.row", { style: { marginTop: "auto", paddingTop: "8px" } }, toggle),
      form,
    );
  };

  mount(container, shell(cfg, h("div", { style: { maxWidth: "980px", margin: "40px auto 0" } },
    h("div.hero", { style: { padding: "0 0 22px" } }, h("div.eyebrow", "Public View"), h("h1", "핀으로 열람"), h("p.sub", `관리자가 공개로 설정한 팀은 토큰이나 가입 없이 핀만 입력하면 진행 상황을 볼 수 있습니다. 읽기 전용이며 열람 세션은 ${cfg.viewer_until ? cfg.viewer_until + "까지 유지됩니다" : "24시간 뒤 만료됩니다"}. 핀은 연구책임자나 리드에게 확인하세요.`)),
    notice,
    teams.length ? h("div.grid.c3", teams.map(card)) : h("div.empty", "현재 공개 열람이 가능한 팀이 없습니다. 관리자가 카테고리를 공개로 설정하고 핀을 정하면 여기에 표시됩니다."),
    h("p.small.muted", { style: { marginTop: "18px" } }, "팀원으로 기록·수정하려면 ", h("a", { href: "#/login" }, "개인 토큰으로 로그인"), " 또는 ", h("a", { href: "#/apply" }, "토큰 발급 신청"), ". 열람 토큰은 REST·MCP 에서도 조회 도구에 한해 사용할 수 있습니다."),
  )));
  void fmtDT;
}
