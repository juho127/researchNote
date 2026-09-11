// 공개 페이지: 토큰 발급 신청(#/apply) · 신청 상태/토큰 수령(#/claim/<code>) · AI 자동 연동 안내(#/connect)
import { h, mount, input, textarea, select, field, toast, errToast, copyText, setToken, state, pill, fmtDT } from "../core.js";

async function pub(method, path, body) {
  const r = await fetch(path, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(data.message || `HTTP ${r.status}`); e.status = r.status; e.code = data.error; throw e; }
  return data;
}

export async function loadPublicConfig() {
  try { return await pub("GET", "/api/public/config"); } catch { return { app: { name: "연구노트", org: "", org_sub: "", mark: "RN" }, signup_enabled: false, signup_code_required: false, categories: [] }; }
}

export function shell(cfg, ...content) {
  const a = cfg.app || {};
  return h("div",
    h("div.topbar", h("div.inner", h("div.mark", a.mark || "RN"), h("div.who", h("b", a.org || a.name), h("span", a.org_sub || "")), h("a.doc", { href: "#/" }, a.name || "연구노트"),
      h("nav.nav", h("a", { href: "#/login" }, "로그인"), h("a", { href: "#/apply" }, "발급 신청"), h("a", { href: "#/view" }, "핀 열람"), h("a", { href: "#/connect" }, "AI 연동")))),
    h("div.wrap.narrow", ...content, h("div.foot", `${a.org || ""} ${a.org_sub ? "· " + a.org_sub : ""} · ${a.name || ""}`, " · ", h("a", { href: "https://hufs-ai-lecture.pages.dev/", target: "_blank", rel: "noopener" }, "강의 홈 ↗"))),
  );
}

// ---------- 발급 신청 ----------
export async function renderApply(container) {
  const cfg = await loadPublicConfig();
  if (!cfg.signup_enabled) {
    mount(container, shell(cfg, h("div.login", h("div.hero", h("div.eyebrow", "Token Request"), h("h1", "토큰 발급 신청"), h("p.sub", "현재 공개 신청을 받지 않습니다. 연구책임자에게 직접 토큰을 요청하세요.")), h("p", h("a", { href: "#/login" }, "← 로그인으로")))));
    return;
  }
  const name = input({ placeholder: "홍길동", maxlength: 100, autocomplete: "name" });
  const email = input({ type: "email", placeholder: "you@univ.ac.kr (선택, 승인 안내에 사용)", maxlength: 200, autocomplete: "email" });
  const cat = select([{ value: "", label: "미정 (관리자가 배정)" }, ...cfg.categories.map((c) => ({ value: c.id, label: `${c.name}${c.track === "capstone" ? " (캡스톤)" : ""}` }))], { value: cfg.categories[0]?.id || "" });
  const note = textarea({ placeholder: "학번 · 과정(석사/박사/학부연구생) · 지도교수 · 연구 주제 등", rows: 3, maxlength: 500 });
  const code = input({ placeholder: "연구책임자가 알려준 신청 코드", autocomplete: "off" });
  const btn = h("button.btn.primary", { type: "submit" }, "신청하기");
  const form = h("form.stack", {
    onsubmit: async (e) => {
      e.preventDefault();
      if (!name.value.trim()) { toast("이름을 입력하세요", true); name.focus(); return; }
      btn.disabled = true;
      try {
        const r = await pub("POST", "/api/public/requests", { name: name.value.trim(), email: email.value.trim(), category_id: cat.value || null, note: note.value, signup_code: cfg.signup_code_required ? code.value.trim() : undefined });
        renderSubmitted(container, cfg, r);
      } catch (ex) { errToast(ex); btn.disabled = false; }
    },
  },
    field("이름 *", name),
    field("이메일", email),
    field("희망 카테고리(연구 그룹)", cat, cfg.categories.find((c) => c.id === cat.value)?.description || ""),
    field("메모", note, "관리자가 승인 판단에 참고합니다"),
    cfg.signup_code_required ? field("신청 코드 *", code) : null,
    h("div.row", { style: { justifyContent: "flex-end" } }, btn),
  );
  cat.addEventListener("change", () => { const d = cfg.categories.find((c) => c.id === cat.value)?.description || ""; form.querySelectorAll(".help")[0].textContent = d; });
  mount(container, shell(cfg, h("div.login",
    h("div.hero", h("div.eyebrow", "Token Request"), h("h1", "토큰 발급 신청"), h("p.sub", "신청하면 연구책임자(관리자)가 승인합니다. 승인 후 이 사이트에서 토큰을 직접 수령합니다.")),
    h("div.card", form),
    h("p.small.muted", { style: { marginTop: "16px" } }, "이미 신청했다면 ", h("a", { href: "#/claim" }, "수령 코드로 상태 확인"), " · 토큰이 있다면 ", h("a", { href: "#/login" }, "로그인")),
  )));
}

function renderSubmitted(container, cfg, r, reissue = false) {
  const link = `${location.origin}/#/claim/${r.claim_code}`;
  mount(container, shell(cfg, h("div.login",
    h("div.hero", h("div.eyebrow", reissue ? "Reissue Requested" : "Submitted"), h("h1", reissue ? "재발급 요청이 접수되었습니다" : "신청이 접수되었습니다"), h("p.sub", "관리자가 승인하면 아래 수령 코드로 토큰을 받을 수 있습니다. 코드는 지금 한 번만 표시됩니다. 수령 코드는 로그인 토큰이 아닙니다.")),
    h("div.card.stack",
      h("div", h("div.small.muted", "수령 코드"), h("div.tokenbox", r.claim_code)),
      h("div", h("div.small.muted", "상태 확인 / 토큰 수령 링크"), h("div.tokenbox", { style: { background: "var(--wash)", color: "var(--navy)" } }, link)),
      h("div.row", h("button.btn", { onclick: () => copyText(r.claim_code) }, "코드 복사"), h("button.btn", { onclick: () => copyText(link) }, "링크 복사"), h("span.spacer"), h("a.btn.primary", { href: `#/claim/${r.claim_code}` }, "상태 보기")),
      h("p.small.muted", "관리자(연구책임자)에게 승인을 요청해 주세요. 승인 전에는 토큰이 발급되지 않습니다."),
    ),
  )));
}

// ---------- 토큰 재발급 요청 (기존 회원) ----------
export async function renderReissue(container) {
  const cfg = await loadPublicConfig();
  const name = input({ placeholder: "등록할 때 쓴 이름", maxlength: 100, autocomplete: "name" });
  const email = input({ type: "email", placeholder: "등록된 이메일", maxlength: 200, autocomplete: "email" });
  const note = textarea({ placeholder: "사유 (선택) — 예: 노트북 교체, 토큰 분실", rows: 2, maxlength: 500 });
  const revoke = h("input", { type: "checkbox", checked: true });
  const auto = cfg.reissue_auto !== false;
  const btn = h("button.btn.primary", { type: "submit" }, auto ? "새 토큰 발급" : "재발급 요청");
  const form = h("form.stack", {
    onsubmit: async (e) => {
      e.preventDefault();
      if (!name.value.trim() || !email.value.trim()) { toast("이름과 이메일을 입력하세요", true); return; }
      btn.disabled = true;
      try {
        const r = await pub("POST", "/api/public/reissue", { name: name.value.trim(), email: email.value.trim(), note: note.value, revoke_existing: revoke.checked });
        if (r.mode === "auto" && r.token) renderClaimed(container, cfg, r, { reissued: true, revoked: r.revoked });
        else renderSubmitted(container, cfg, r, true);
      } catch (ex) { errToast(ex); btn.disabled = false; }
    },
  },
    field("이름 *", name), field("이메일 *", email, "등록된 이름·이메일과 정확히 일치해야 합니다 (5회 틀리면 10분 잠금)"), field("사유", note),
    auto ? h("label.check", revoke, "기존 토큰 모두 회수 (분실·유출이면 켜두세요. 다른 기기에서 계속 쓰려면 끄세요)") : null,
    h("div.row", { style: { justifyContent: "flex-end" } }, btn),
  );
  mount(container, shell(cfg, h("div.login",
    h("div.hero", h("div.eyebrow", "Token Reissue"), h("h1", auto ? "토큰 재발급" : "토큰 재발급 요청"), h("p.sub", auto ? "이미 계정이 있는데 토큰을 잃어버렸거나 새 기기에서 쓰려면 등록한 이름과 이메일을 입력하세요. 일치하면 새 토큰이 바로 발급됩니다. 새로 가입 신청할 필요가 없습니다." : "이미 계정이 있는데 토큰을 잃어버렸거나 새 기기에서 쓰려면 여기서 요청하세요. 관리자가 승인하면 수령 코드로 새 토큰을 직접 받습니다. 새로 가입 신청할 필요가 없습니다.")),
    h("div.card", form),
    h("p.small.muted", { style: { marginTop: "16px" } }, "계정이 아직 없다면 ", h("a", { href: "#/apply" }, "발급 신청"), " · 수령 코드가 있다면 ", h("a", { href: "#/claim" }, "상태 확인"), " · 토큰이 있다면 ", h("a", { href: "#/login" }, "로그인")),
  )));
}

// ---------- 상태 확인 / 토큰 수령 ----------
export async function renderClaim(container, claimCode) {
  const cfg = await loadPublicConfig();
  if (!claimCode) {
    const code = input({ placeholder: "clm_…", autocomplete: "off" });
    mount(container, shell(cfg, h("div.login",
      h("div.hero", h("div.eyebrow", "Claim"), h("h1", "신청 상태 확인"), h("p.sub", "신청 시 받은 수령 코드를 입력하세요")),
      h("div.card", h("form.stack", { onsubmit: (e) => { e.preventDefault(); const v = code.value.replace(/\s+/g, "").replace(/^.*#\/claim\//, ""); if (v.startsWith("rn_")) { toast("rn_ 로 시작하는 값은 이미 토큰입니다. 로그인 페이지에 붙여넣으세요", true); return; } if (v) location.hash = `#/claim/${v}`; } }, field("수령 코드", code, "신청 직후 화면에 표시된 clm_ 코드 (링크를 통째로 붙여넣어도 됩니다)"), h("div.row", { style: { justifyContent: "flex-end" } }, h("button.btn.primary", { type: "submit" }, "확인")))),
      h("p.small.muted", { style: { marginTop: "16px" } }, h("a", { href: "#/apply" }, "새로 신청"), " · ", h("a", { href: "#/login" }, "로그인")),
    )));
    return;
  }
  let st;
  try { st = await pub("GET", `/api/public/requests/${encodeURIComponent(claimCode)}`); }
  catch (e) {
    mount(container, shell(cfg, h("div.login", h("div.hero", h("h1", "신청을 찾을 수 없습니다"), h("p.sub", e.message)),
      h("div.card.stack", h("p.small", { style: { margin: 0 } }, "가능한 원인: 코드 오타 · 관리자가 수령 코드를 재발급함(이전 코드는 무효) · 다른 서버의 코드. 이미 계정이 있는데 코드나 토큰을 잃어버렸다면 ", h("a", { href: "#/reissue" }, "토큰 재발급 요청"), "을 이용하세요 (이름+이메일 확인 → 관리자 승인 → 새 토큰 수령). 새로 신청하면 같은 이메일로는 중복 신청이 막힙니다.")),
      h("p", { style: { marginTop: "12px" } }, h("a", { href: "#/claim" }, "← 코드 다시 입력"), " · ", h("a", { href: "#/login" }, "토큰이 있다면 로그인")))));
    return;
  }
  const statusPill = st.status === "pending" ? pill("승인 대기", "warn") : st.status === "approved" ? pill(st.claimed ? "수령 완료" : "승인됨", "ok") : pill("거절", "bad");
  const body = h("div.card.stack",
    h("div.row", h("b", st.name), st.kind === "reissue" ? pill("토큰 재발급", "navy sm") : null, statusPill, st.category_name ? h("span.tag", st.category_name) : null, h("span.spacer"), h("span.small.muted", `신청 ${fmtDT(st.created_at)}`)),
  );
  if (st.status === "pending") {
    body.append(h("p", "관리자 승인을 기다리는 중입니다. 승인되면 이 페이지에서 토큰을 받을 수 있습니다."), h("div.row", h("button.btn", { onclick: () => renderClaim(container, claimCode) }, "새로고침")));
  } else if (st.status === "rejected") {
    body.append(h("p", "신청이 거절되었습니다.", st.decision_note ? ` 사유: ${st.decision_note}` : ""), h("p.small.muted", "문의는 연구책임자에게. 다시 신청하려면 ", h("a", { href: "#/apply" }, "발급 신청"), "."));
  } else if (st.claimed) {
    body.append(h("p", "이미 토큰을 수령했습니다. 토큰을 잃어버렸다면 ", h("a", { href: "#/reissue" }, "토큰 재발급 요청"), "을 이용하세요."), h("div.row", h("a.btn.primary", { href: "#/login" }, "로그인")));
  } else {
    const btn = h("button.btn.primary", { onclick: async () => {
      btn.disabled = true;
      try {
        const r = await pub("POST", `/api/public/requests/${encodeURIComponent(claimCode)}/claim`);
        renderClaimed(container, cfg, r);
      } catch (ex) { errToast(ex); btn.disabled = false; }
    } }, "토큰 받기 (1회)");
    body.append(h("p", "승인되었습니다. 토큰은 한 번만 표시되므로 받은 즉시 안전한 곳에 저장하세요."), h("div.row", btn));
  }
  mount(container, shell(cfg, h("div.login", h("div.hero", h("div.eyebrow", "Claim"), h("h1", "신청 상태")), body)));
}

function renderClaimed(container, cfg, r, { reissued = false, revoked = 0 } = {}) {
  const cmd = `claude mcp add --transport http research-note ${location.origin}/mcp --header "Authorization: Bearer ${r.token}"`;
  mount(container, shell(cfg, h("div.login",
    h("div.hero", h("div.eyebrow", reissued ? "Token Reissued" : "Token Issued"), h("h1", `${r.name} 님, ${reissued ? "새 토큰이" : "토큰이"} 발급되었습니다`), h("p.sub", `지금 한 번만 표시됩니다. 복사해서 비밀번호처럼 보관하세요.${revoked ? ` 기존 토큰 ${revoked}건은 회수되어 더 이상 쓸 수 없습니다 (AI 도구 설정도 새 토큰으로 바꾸세요).` : ""}`)),
    h("div.card.stack",
      h("div", h("div.small.muted", "개인 접근 토큰"), h("div.tokenbox", r.token)),
      h("div.row", h("button.btn", { onclick: () => copyText(r.token) }, "토큰 복사"), h("button.btn", { onclick: () => copyText(cmd) }, "Claude Code 등록 명령 복사"), h("span.spacer"),
        h("button.btn.primary", { onclick: () => { setToken(r.token); state.me = null; location.hash = "#/"; } }, "이 토큰으로 로그인")),
      h("p.small.muted", "AI 도구 연동: 로그인 후 [설정] 페이지에 도구별 명령이 있습니다. 또는 AI 에게 ", h("code", `${location.origin}/connect`), " 주소를 주면 스스로 연동합니다."),
    ),
  )));
}

// ---------- AI 자동 연동 안내 (사람용) ----------
export async function renderConnect(container) {
  const cfg = await loadPublicConfig();
  const url = `${location.origin}/connect`;
  const prompt = `${url} 를 읽고 연구노트를 이 환경에 연동해줘. 토큰이 없으면 발급 신청부터 진행해.`;
  mount(container, shell(cfg, h("div.login", { style: { maxWidth: "640px" } },
    h("div.hero", h("div.eyebrow", "AI Onboarding"), h("h1", "AI에게 주소 하나만 주세요"), h("p.sub", "Claude Code·Cursor·Codex·Gemini CLI 등 AI 코딩 도구에 아래 주소를 주면, AI가 안내 문서를 읽고 토큰 발급 신청 → 승인 확인 → 토큰 수령 → MCP 등록 → 스킬 저장 → 검증을 스스로 수행합니다.")),
    h("div.card.stack",
      h("div", h("div.small.muted", "에이전트용 안내 주소"), h("div.tokenbox", { style: { background: "var(--wash)", color: "var(--navy)" } }, url)),
      h("div", h("div.small.muted", "AI에게 이렇게 말하세요"), h("div.tokenbox", { style: { background: "var(--wash)", color: "var(--navy)", userSelect: "text" } }, prompt)),
      h("div.row", h("button.btn", { onclick: () => copyText(url) }, "주소 복사"), h("button.btn.primary", { onclick: () => copyText(prompt) }, "문장 복사"), h("span.spacer"), h("a.btn", { href: "/connect", target: "_blank" }, "문서 보기")),
      h("p.small.muted", "이미 토큰이 있으면 AI가 그 토큰으로 바로 등록합니다. 없으면 AI가 이름·카테고리를 물어 신청을 넣고, 관리자 승인 뒤 다시 요청하면 이어서 진행합니다."),
    ),
    h("p.small.muted", { style: { marginTop: "16px" } }, h("a", { href: "#/login" }, "로그인"), " · ", h("a", { href: "#/apply" }, "직접 발급 신청")),
  )));
}
