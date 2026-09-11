import { state, getToken, logout, h, mount, pill, copyText, loadMe, fmtDT } from "../core.js";

export async function render(container) {
  const me = await loadMe();
  const origin = location.origin;
  const token = getToken();
  const mcpUrl = `${origin}/mcp`;
  const masked = token ? `${token.slice(0, 7)}…${token.slice(-4)}` : "";
  let reveal = false;
  const tokView = (t) => (reveal ? t : t.replace(token, "<YOUR_TOKEN>"));

  const claudeCmd = `claude mcp add --transport http research-note ${mcpUrl} --header "Authorization: Bearer ${token}"`;
  const claudeCmdUser = `claude mcp add --scope user --transport http research-note ${mcpUrl} --header "Authorization: Bearer ${token}"`;
  const jsonCfg = JSON.stringify({ mcpServers: { "research-note": { type: "http", url: mcpUrl, headers: { Authorization: `Bearer ${token}` } } } }, null, 2);
  const cursorCfg = JSON.stringify({ mcpServers: { "research-note": { url: mcpUrl, headers: { Authorization: `Bearer ${token}` } } } }, null, 2);
  const desktopCfg = JSON.stringify({ mcpServers: { "research-note": { command: "npx", args: ["-y", "mcp-remote", mcpUrl, "--header", `Authorization: Bearer ${token}`] } } }, null, 2);
  const codexCfg = `[mcp_servers.research-note]\nurl = "${mcpUrl}"\nhttp_headers = { Authorization = "Bearer ${token}" }`;
  const geminiCfg = JSON.stringify({ mcpServers: { "research-note": { httpUrl: mcpUrl, headers: { Authorization: `Bearer ${token}` } } } }, null, 2);
  const pluginCmd = `# 환경변수 설정 후 (PowerShell: $env:RESEARCH_NOTE_URL / bash: export)\nRESEARCH_NOTE_URL=${origin}\nRESEARCH_NOTE_TOKEN=${token}\n\n# Claude Code 안에서\n/plugin marketplace add juho127/researchNote\n/plugin install research-note@research-note`;

  const snippets = [];
  const snippet = (title, code, desc) => {
    const pre = h("pre", tokView(code));
    snippets.push({ pre, code });
    return h("div.card", h("div.row.between", h("h3", title), h("button.btn.xs", { onclick: () => copyText(code) }, "복사")), desc ? h("p.small.muted", { style: { margin: "4px 0 8px" } }, desc) : null, pre);
  };
  const toggle = h("button.btn.sm", { onclick: () => { reveal = !reveal; toggle.textContent = reveal ? "토큰 가리기" : "토큰 표시"; for (const s of snippets) s.pre.textContent = tokView(s.code); } }, "토큰 표시");

  mount(container,
    h("header.hero", { style: { padding: "18px 0 14px" } }, h("div.eyebrow", "Settings"), h("h1", "설정 · AI 도구 연동"), h("p.sub", "내 계정 정보와, 각자 쓰는 AI 도구(Claude Code 등)가 이 연구노트에 직접 기록하도록 연결하는 방법")),
    h("div.grid.c2",
      h("div.card", h("h3", "내 계정"), h("div.kv", { style: { marginTop: "10px" } },
        h("b", "이름"), h("span", me.user.name, " ", me.is_admin ? pill("관리자", "gold sm") : null),
        h("b", "ID"), h("code", me.user.id),
        h("b", "이메일"), h("span", me.user.email || "-"),
        h("b", "소속"), h("span", me.memberships.length ? me.memberships.map((m) => `${m.category_name}${m.role === "lead" ? " (리드)" : ""}`).join(", ") : "없음"),
        h("b", "토큰"), h("span", h("code", me.bootstrap ? "ADMIN_TOKEN (부트스트랩)" : me.token_hint || masked), h("span.tiny.muted", " (앞뒤 일부만 표시 · 전체 토큰은 발급 때 한 번만 보여주며 서버는 해시만 보관)")),
        h("b", "가입"), h("span", fmtDT(me.user.created_at)),
      ), h("div.row", { style: { marginTop: "14px" } }, h("button.btn.danger", { onclick: logout }, "이 브라우저에서 로그아웃"))),
      h("div.card", h("h3", "웹 MCP 란"), h("p.small", { style: { margin: "8px 0" } }, "이 서버는 원격(HTTP) MCP 서버를 내장합니다. 연구원 컴퓨터에 아무것도 설치할 필요 없이, AI 도구에 아래 주소와 토큰을 등록하면 AI 가 whoami → log_progress → update_stage 같은 도구로 연구 진행을 대신 기록·조회합니다."),
        h("div.kv", h("b", "MCP URL"), h("code", mcpUrl), h("b", "인증"), h("span", "Authorization: Bearer <토큰>"), h("b", "지침"), h("a", { href: "/SKILL.md", target: "_blank" }, "/SKILL.md (AI 가 읽는 사용 지침)")),
        h("p.small.muted", { style: { marginTop: "8px" } }, "⚠ 토큰은 비밀번호와 같습니다. 공용 저장소·채팅에 올리지 마세요. 아래 코드는 기본적으로 토큰을 가려서 보여줍니다."), toggle),
    ),
    h("div.section", h("div.section-h", h("h2", "AI에게 맡기기"), h("p.sub", "주소 하나로 자동 연동")),
      h("div.card.stack",
        h("p.small", { style: { margin: 0 } }, "AI 코딩 도구(Claude Code 등)에 아래 문장을 붙여넣으면 AI가 ", h("code", "/connect"), " 안내를 읽고 MCP 등록·스킬 저장·검증을 스스로 합니다. 토큰이 없는 동료에게는 발급 신청부터 진행해 줍니다."),
        h("div.tokenbox", { style: { background: "var(--wash)", color: "var(--navy)" } }, `${origin}/connect 를 읽고 연구노트를 이 환경에 연동해줘. 내 토큰: ${reveal ? token : "<YOUR_TOKEN>"}`),
        h("div.row", h("button.btn.sm", { onclick: () => copyText(`${origin}/connect 를 읽고 연구노트를 이 환경에 연동해줘. 내 토큰: ${token}`) }, "문장 복사 (토큰 포함)"), h("button.btn.sm", { onclick: () => copyText(`${origin}/connect`) }, "주소만 복사"), h("a.btn.sm", { href: "/connect", target: "_blank" }, "안내 문서 보기")),
      )),
    h("div.section", h("div.section-h", h("h2", "Claude Code"), h("p.sub", "직접 등록 · 한 줄로 끝")),
      h("div.stack",
        snippet("① 현재 프로젝트 폴더에 등록", claudeCmd, "터미널에서 실행. 그 폴더에서 claude 를 열면 research-note 도구를 씁니다. 등록 후 /mcp 로 연결 확인."),
        snippet("② 모든 프로젝트에서 사용 (user scope)", claudeCmdUser, "①·② 중 하나만 하면 됩니다."),
        snippet("③ (선택) 플러그인: 스킬 + /research-note:log 등 슬래시 커맨드", pluginCmd, "플러그인은 기록 절차 스킬과 커맨드(/research-note:log, :status, :review, :report)를 추가합니다. MCP 등록만으로도 서버가 지침을 제공하므로 필수는 아닙니다."),
        h("div.card", h("h3", "AI 에게 이렇게 말하면 됩니다"), h("ul.small", { style: { margin: "8px 0 0", paddingLeft: "18px" } },
          h("li", "\"오늘 한 실험 결과를 연구노트에 기록해\" → whoami → get_project → log_progress"),
          h("li", "\"실험 단계 정리를 지금 결과로 갱신해\" → update_stage"),
          h("li", "\"팀원들 이번 주 뭐 했는지 보여줘\" → team_feed / team_overview"),
          h("li", "\"이 프로젝트 주간 보고서 초안 만들어\" → get_report"),
          h("li", "\"이 기록 리드한테 검토 요청해\" → set_review requested"),
        )),
      )),
    h("div.section", h("div.section-h", h("h2", "다른 AI 도구"), h("p.sub", "같은 URL·토큰")),
      h("div.grid.c2",
        snippet("Cursor — .cursor/mcp.json", cursorCfg),
        snippet("Claude Desktop — claude_desktop_config.json (mcp-remote 브리지)", desktopCfg, "Claude Desktop 은 Settings → Connectors 에서 원격 MCP 를 직접 추가할 수도 있습니다 (커스텀 헤더 미지원 시 mcp-remote 사용)."),
        snippet("OpenAI Codex CLI — ~/.codex/config.toml", codexCfg),
        snippet("Gemini CLI — ~/.gemini/settings.json", geminiCfg),
        snippet("범용 mcpServers JSON", jsonCfg),
        snippet("REST API (스크립트·노트북에서 직접 기록)", `curl -X POST ${origin}/api/projects/<PROJECT_ID>/entries \\\n  -H "Authorization: Bearer ${token}" -H "Content-Type: application/json" \\\n  -d '{"title":"baseline 완료","content":"## 결과\\n- acc 0.91","stage":"experiment"}'`, "전체 명세: GitHub 리포의 docs/API.md"),
      )),
  );
}
