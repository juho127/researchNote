import { h, setToken, loadMe, state, errToast, input } from "../core.js";

/** 붙여넣은 값 정규화: 따옴표·"Bearer " 접두·공백/줄바꿈 제거 (안내문이나 명령에서 복사한 경우) */
export function normalizeToken(raw) {
  let t = String(raw || "").trim();
  for (let i = 0; i < 3; i++) {
    t = t.replace(/^(authorization\s*:\s*)?bearer\s+/i, "").trim();
    t = t.replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, "").trim();
  }
  return t.replace(/\s+/g, "");
}

export function render({ onLogin, error }) {
  const tok = input({ type: "password", placeholder: "rn_…", autocomplete: "off", spellcheck: false });
  const err = h("p.help", { style: { color: "var(--brick)", minHeight: "18px" } }, error || "");
  const btn = h("button.btn.primary", { type: "submit" }, "들어가기");
  const form = h("form", {
    onsubmit: async (e) => {
      e.preventDefault();
      const t = normalizeToken(tok.value);
      if (!t) { err.textContent = "토큰을 입력하세요"; return; }
      if (t.startsWith("clm_")) {
        // 수령 코드를 토큰 자리에 넣은 경우 → 수령 페이지로 안내
        err.textContent = "이것은 수령 코드(clm_)입니다. 토큰을 먼저 받아야 합니다. 수령 페이지로 이동합니다…";
        setTimeout(() => (location.hash = `#/claim/${t}`), 900);
        return;
      }
      if (/…|\.\.\./.test(t)) {
        err.textContent = "가려진 표시(…)가 들어 있는 값은 토큰이 아닙니다 (설정 화면·관리자 표의 힌트). 발급 때 한 번 보여준 전체 토큰이 필요하며, 없다면 [토큰 재발급]을 이용하세요.";
        return;
      }
      if (!/^rn_[A-Za-z0-9]{40}$/.test(t) && !t.startsWith("rnv_")) {
        err.textContent = `토큰은 rn_ 로 시작하는 43자입니다 (입력값 ${t.length}자). 복사할 때 앞뒤가 잘리지 않았는지, 수령 코드나 링크를 넣은 건 아닌지 확인하세요.`;
        return;
      }
      btn.disabled = true; err.textContent = "";
      setToken(t);
      try { await loadMe({ noRedirect: true }); location.hash = "#/"; onLogin(); }
      catch (ex) { setToken(null); state.me = null; err.textContent = ex.status === 401 ? ex.message : `연결 실패: ${ex.message}`; if (ex.status !== 401) errToast(ex); }
      finally { btn.disabled = false; }
    },
  },
    h("label.field", h("span", "개인 접근 토큰"), tok, h("span.help", "관리자(연구책임자)가 발급했거나 수령 페이지에서 받은 rn_ 토큰을 붙여넣으세요. 수령 코드(clm_)가 아닙니다. 토큰은 이 브라우저에만 저장됩니다.")),
    err,
    h("div.row", { style: { justifyContent: "flex-end" } }, btn),
  );
  return h("div.wrap.narrow", h("div.login",
    h("div.hero", h("div.eyebrow", "Research Note"), h("h1", "연구노트"), h("p.sub", "논문 진행을 날짜별로 기록하고, 같은 팀과 검토하며, AI 도구로 자동 기록하는 연구실 노트")),
    h("div.card", form),
    h("div.grid.c2", { style: { marginTop: "16px" } },
      h("a.card.hover.pad-s", { href: "#/apply" }, h("b", "토큰이 없나요?"), h("div.small.muted", "발급 신청 → 관리자 승인 → 여기서 토큰 수령")),
      h("a.card.hover.pad-s", { href: "#/connect" }, h("b", "AI에게 맡기기"), h("div.small.muted", "주소 하나 주면 AI가 신청·MCP 등록·스킬 설치까지")),
      h("a.card.hover.pad-s", { href: "#/view" }, h("b", "핀으로 열람"), h("div.small.muted", "공개 팀은 핀만 입력하면 읽기 전용으로 볼 수 있습니다 (24시간)")),
    ),
    h("p.small.muted", { style: { marginTop: "12px" } }, "이미 신청했다면 ", h("a", { href: "#/claim" }, "수령 코드로 상태 확인"), " · 토큰을 잃어버렸다면 ", h("a", { href: "#/reissue" }, "토큰 재발급 요청"), "."),
  ));
}
