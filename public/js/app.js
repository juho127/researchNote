import { state, getToken, loadMe, logout, h, mount, parseRoute, errToast, get, fmtDT, pill } from "./core.js";
import * as Login from "./pages/login.js";
import * as Home from "./pages/home.js";
import * as Team from "./pages/team.js";
import * as Project from "./pages/project.js";
import * as Admin from "./pages/admin.js";
import * as Settings from "./pages/settings.js";
import * as Public from "./pages/apply.js";
import * as Lobby from "./pages/lobby.js";
import * as View from "./pages/view.js";

const app = document.getElementById("app");
let reviewCount = 0;
let pendingRequests = 0;

function layout(content, active) {
  const me = state.me;
  const a = me?.app || { name: "연구노트", org: "", org_sub: "", mark: "RN" };
  const nav = h("nav.nav");
  const link = (href, label, key, badge) => nav.append(h("a", { href, class: active === key ? "active" : "" }, label, badge ? h("span.badge", badge) : null));
  if (me?.viewer) {
    // 핀 열람 모드: 해당 팀 하나만, 읽기 전용 표시
    const v = me.viewer;
    link(`#/team/${v.category_id}`, v.category_name, `team:${v.category_id}`);
    nav.append(pill("열람 모드 · 읽기 전용", "gold sm"), h("a", { href: "#/view", onclick: (e) => { e.preventDefault(); logout(); } }, "나가기"));
    nav.append(h("span.me", me.user?.name || "열람자"));
    const top = h("div.topbar", h("div.inner", h("div.mark", a.mark || "RN"), h("div.who", h("b", a.org || a.name), h("span", a.org_sub || "")), h("a.doc", { href: `#/team/${v.category_id}` }, a.name), nav));
    const banner = h("div.viewer-banner", h("div.inner", h("b", "🔒 열람 모드"), ` · ${v.category_name} 팀을 핀으로 보고 있습니다. 기록·코멘트·수정은 할 수 없습니다 · 세션 만료 ${fmtDT(v.expires_at)}`, h("span.spacer"), h("a", { href: "#/login", onclick: (e) => { e.preventDefault(); logout(); location.hash = "#/login"; } }, "팀원 로그인")));
    mount(app, top, banner, content, h("div.foot", `${a.org || ""} ${a.org_sub ? "· " + a.org_sub : ""} · ${a.name}`, " · ", h("a", { href: "https://hufs-ai-lecture.pages.dev/", target: "_blank", rel: "noopener" }, "강의 홈 ↗")));
    return;
  }
  link("#/", "홈", "home");
  const teams = me?.memberships || [];
  if (teams.length <= 2) {
    for (const m of teams) link(`#/team/${m.category_id}`, m.category_name, `team:${m.category_id}`);
  } else {
    // 팀이 많으면 드롭다운 하나로 묶는다 (팀 페이지에서는 현재 팀 이름 표시)
    const cur = teams.find((m) => active === `team:${m.category_id}`);
    const menu = h("div.dd-menu");
    for (const m of teams) menu.append(h("a", { href: `#/team/${m.category_id}`, class: cur?.category_id === m.category_id ? "active" : "" }, m.category_name, m.role === "lead" ? h("span.pill.gold.sm", "리드") : m.role === "evaluator" ? h("span.pill.ai.sm", "평가자") : null));
    menu.append(h("div.dd-sep"), h("a", { href: "#/lobby" }, "팀 로비 · 팀 찾기/가입"));
    const btn = h("button.dd-btn", { type: "button", class: cur ? "active" : "", "aria-haspopup": "true", "aria-expanded": "false" }, cur ? cur.category_name : `내 팀 ${teams.length}`, h("span.caret", "▾"));
    const dd = h("div.dd", btn, menu);
    btn.addEventListener("click", (e) => { e.stopPropagation(); const open = dd.classList.toggle("open"); btn.setAttribute("aria-expanded", String(open)); });
    document.addEventListener("click", () => dd.classList.remove("open"));
    menu.addEventListener("click", () => dd.classList.remove("open"));
    nav.append(dd);
  }
  link("#/lobby", "팀 로비", "lobby", me?.pending_joins || null);
  if (me?.is_admin) link("#/admin", "관리자", "admin", (pendingRequests + reviewCount) || null);
  link("#/settings", "설정", "settings");
  nav.append(h("span.me", me?.user?.name || ""));
  const top = h("div.topbar", h("div.inner",
    h("div.mark", a.mark || "RN"),
    h("div.who", h("b", a.org || a.name), h("span", a.org_sub || "")),
    h("a.doc", { href: "#/" }, a.name),
    nav,
  ));
  mount(app, top, content, h("div.foot", `${a.org || ""} ${a.org_sub ? "· " + a.org_sub : ""} · ${a.name}`, " · ", h("a", { href: "https://hufs-ai-lecture.pages.dev/", target: "_blank", rel: "noopener" }, "강의 홈 ↗"), " · ", h("a", { href: "/SKILL.md", target: "_blank" }, "AI 연동 지침"), " · ", h("a", { href: "https://github.com/juho127/researchNote", target: "_blank", rel: "noopener" }, "GitHub")));
}

async function render() {
  const route = parseRoute();
  const [head, id] = route.parts;

  // 공개 페이지 (토큰 불필요)
  if (head === "apply" || head === "claim" || head === "connect" || head === "view") {
    const c = h("div");
    mount(app, c);
    try {
      if (head === "apply") await Public.renderApply(c);
      else if (head === "claim") await Public.renderClaim(c, route.parts.slice(1).join("/") || "");
      else if (head === "view") await View.renderView(c, route.parts[1] || "", route.query);
      else await Public.renderConnect(c);
    } catch (e) { mount(c, h("div.wrap.narrow", h("div.empty", `오류: ${e.message}`))); }
    window.scrollTo(0, 0);
    return;
  }

  if (!getToken()) {
    mount(app, Login.render({ onLogin: render }));
    return;
  }
  if (!state.me) {
    try { await loadMe(); } catch (e) {
      if (e.status === 401) { mount(app, Login.render({ onLogin: render, error: e.message })); return; }
      mount(app, h("div.wrap.narrow", h("div.empty", `서버 오류: ${e.message}`), h("p.right", h("button.btn", { onclick: logout }, "로그아웃"))));
      return;
    }
    if (state.me.is_admin) get("/api/admin/overview").then((o) => { reviewCount = o.review_queue?.length || 0; pendingRequests = o.counts?.pending_requests || 0; }).catch(() => {});
  }
  if (head === "login") { location.hash = "#/"; return; }
  if (state.me.viewer) {
    // 열람 모드에서는 팀·프로젝트 페이지만. 나머지는 해당 팀으로
    const vid = state.me.viewer.category_id;
    if (!(head === "team" || head === "project")) { location.hash = `#/team/${vid}`; return; }
  }

  const container = h("div.wrap");
  let active = "home";
  try {
    if (!head) { await Home.render(container); }
    else if (head === "team" && id) { active = `team:${id}`; await Team.render(container, id, route.query); }
    else if (head === "project" && id) { const p = await Project.render(container, id, route.query); active = p?.category_id ? `team:${p.category_id}` : "home"; }
    else if (head === "lobby") { active = "lobby"; await Lobby.render(container, route.query); }
    else if (head === "admin") { active = "admin"; await Admin.render(container, route.parts[1], route.query); }
    else if (head === "settings") { active = "settings"; await Settings.render(container); }
    else mount(container, h("div.empty", "페이지를 찾을 수 없습니다"));
  } catch (e) {
    if (e.status === 401) return; // api() 가 로그인으로 보냄
    mount(container, h("div.empty", `오류: ${e.message}`));
    errToast(e);
  }
  layout(container, active);
  window.scrollTo(0, 0);
}

window.addEventListener("hashchange", render);
window.addEventListener("rn:refresh", render);
render();
