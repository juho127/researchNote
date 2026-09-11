/**
 * /connect — AI 에이전트용 자기 연동 안내 (markdown).
 * 사용자가 AI 도구에 이 URL 하나만 주면, AI 가 읽고 토큰 확보 → MCP 등록 → 스킬 저장 → 검증까지 스스로 수행한다.
 */
import type { Env } from "./env";
import { publicConfig } from "./services/signup";

export async function connectMarkdown(env: Env, base: string): Promise<string> {
  const cfg = await publicConfig(env);
  const cats = cfg.categories.length ? cfg.categories.map((c) => `  - \`${c.id}\` ${c.name}${c.description ? ` — ${c.description}` : ""}`).join("\n") : "  - (아직 카테고리가 없습니다. 관리자가 만든 뒤 신청하세요)";
  const mcp = `${base}/mcp`;
  return `# ${cfg.app.name} — AI 에이전트 연동 안내 (agent-readable)

이 문서는 AI 코딩 에이전트(Claude Code, Cursor, Codex CLI, Gemini CLI 등)가 **읽고 스스로 실행**하기 위한 절차다.
사람에게 보여줄 때는 각 단계에서 필요한 정보(이름·토큰 등)만 묻고, 나머지는 에이전트가 수행한다.
언어: 사용자의 언어(기본 한국어)로 대화한다.

- 서비스: ${cfg.app.name} (${cfg.app.org} ${cfg.app.org_sub}) — 연구실 논문 진행 기록·공유 시스템
- BASE_URL: \`${base}\`
- MCP 엔드포인트: \`${mcp}\` (Streamable HTTP, 인증 헤더 \`Authorization: Bearer <토큰>\`)
- 사용 지침(스킬): \`${base}/SKILL.md\`
- 공개 API 는 인증 없이, 그 외 \`/api/*\` 와 \`/mcp\` 는 개인 토큰(\`rn_\` 로 시작)이 필요하다.
- 읽기만 필요한 외부 심사위원 등은 핀 열람 토큰(\`rnv_\`, \`${base}/#/view\` 에서 핀 입력 → 24시간)을 같은 방식으로 등록할 수 있다. 이 경우 조회 도구만 동작한다.

## 0. 이미 연결됐는지 확인

다음 중 하나라도 참이면 **5단계(검증)** 로 건너뛴다.
- 환경변수 \`RESEARCH_NOTE_TOKEN\` 이 있다.
- 현재 도구의 MCP 설정에 \`research-note\` 서버가 이미 있다 (Claude Code: \`claude mcp list\`).

## 1. 토큰 확보

사용자에게 "연구노트 토큰(rn_…)을 이미 받았나요?" 라고 묻는다.

**(a) 토큰이 있으면** 그대로 2단계로.

**(b) 토큰이 없으면 발급 신청**${cfg.signup_enabled ? "" : " — ⚠ 현재 공개 신청이 꺼져 있다. 관리자에게 직접 토큰을 요청하라고 안내하고 종료."}

1. 사용자에게 묻는다: 이름(필수), 이메일(선택), 희망 카테고리(아래 목록에서), 메모(학번·과정·지도교수 등, 선택)${cfg.signup_code_required ? ", 신청 코드(연구책임자가 알려준 코드, 필수)" : ""}.
   카테고리 목록:
${cats}
2. 신청을 보낸다:
   \`\`\`bash
   curl -s -X POST ${base}/api/public/requests -H "Content-Type: application/json" \\
     -d '{"name":"<이름>","email":"<이메일>","category_id":"<카테고리id>","note":"<메모>"${cfg.signup_code_required ? ',"signup_code":"<신청코드>"' : ""}}'
   # → {"id":"req_…","claim_code":"clm_…","status":"pending"}
   \`\`\`
3. 응답의 \`claim_code\` 를 사용자에게 **반드시 보여주고 보관하라고** 안내한다 (수령 코드, 다시 조회 불가). 상태 확인 URL: \`${base}/#/claim/<claim_code>\`
4. 사용자에게 "관리자(연구책임자)에게 승인을 요청하세요" 라고 안내한다. 승인 여부 확인:
   \`\`\`bash
   curl -s ${base}/api/public/requests/<claim_code>
   # → {"status":"pending" | "approved" | "rejected", "claimed": false, ...}
   \`\`\`
   승인 전이면 여기서 멈추고, 나중에 사용자가 다시 요청하면 이 단계부터 재개한다 (폴링을 오래 반복하지 않는다).
5. \`status\` 가 \`approved\` 이고 \`claimed\` 가 false 이면 토큰을 수령한다 (**1회만 가능**):
   \`\`\`bash
   curl -s -X POST ${base}/api/public/requests/<claim_code>/claim
   # → {"token":"rn_…","user_id":"…","name":"…"}
   \`\`\`
   토큰은 다시 볼 수 없으므로 사용자에게 보여주고 안전하게 저장하라고 안내한다.

## 2. MCP 등록 (사용 중인 도구에 맞게 하나)

- **Claude Code** (권장):
  \`\`\`bash
  claude mcp add --transport http research-note ${mcp} --header "Authorization: Bearer <토큰>"
  # 모든 프로젝트에서 쓰려면 --scope user 추가
  \`\`\`
- **Cursor** \`.cursor/mcp.json\`: \`{"mcpServers":{"research-note":{"url":"${mcp}","headers":{"Authorization":"Bearer <토큰>"}}}}\`
- **Codex CLI** \`~/.codex/config.toml\`: \`[mcp_servers.research-note]\\nurl = "${mcp}"\\nhttp_headers = { Authorization = "Bearer <토큰>" }\`
- **Gemini CLI** \`~/.gemini/settings.json\`: \`{"mcpServers":{"research-note":{"httpUrl":"${mcp}","headers":{"Authorization":"Bearer <토큰>"}}}}\`
- **Claude Desktop** (헤더 미지원 시): \`{"mcpServers":{"research-note":{"command":"npx","args":["-y","mcp-remote","${mcp}","--header","Authorization: Bearer <토큰>"]}}}\`

설정 파일에 토큰을 넣었다면 그 파일이 git 에 커밋되지 않도록 \`.gitignore\` 를 확인한다. 가능하면 환경변수 \`RESEARCH_NOTE_TOKEN\` 을 쓰고 설정에서는 \`\${RESEARCH_NOTE_TOKEN}\` 으로 참조한다.

## 3. 스킬 저장 (선택, Claude Code)

MCP 서버가 \`initialize\` 응답으로 사용 원칙을 주므로 필수는 아니지만, 더 정교한 기록 절차와 슬래시 커맨드를 원하면 둘 중 하나:
- 스킬 파일만: \`mkdir -p ~/.claude/skills/research-note && curl -s ${base}/SKILL.md -o ~/.claude/skills/research-note/SKILL.md\`
  (프로젝트 한정이면 \`.claude/skills/research-note/SKILL.md\`)
- 플러그인(스킬 + \`/research-note:log\` \`:status\` \`:review\` \`:report\`): 환경변수 \`RESEARCH_NOTE_URL=${base}\`, \`RESEARCH_NOTE_TOKEN=<토큰>\` 설정 후 Claude Code 안에서 \`/plugin marketplace add juho127/researchNote\` → \`/plugin install research-note@research-note\`

## 4. 프로젝트 메모 (선택)

현재 저장소에 \`CLAUDE.md\`(또는 도구별 지침 파일)가 있으면 아래 한 줄을 추가해 두면 이후 세션에서 자동으로 기록 습관이 유지된다:
\`실험·문헌정리·초고 작성 등 의미 있는 작업이 끝나면 research-note MCP 의 log_progress 로 연구노트에 기록한다 (whoami → get_project → log_progress).\`

## 5. 검증

- MCP 로: \`whoami\` 도구를 호출해 사용자 이름·소속·프로젝트가 나오면 성공.
- 또는 REST 로: \`curl -s ${base}/api/me -H "Authorization: Bearer <토큰>"\` 가 200 이면 성공. 401 이면 토큰 오류(회수/오타).
- 사용자에게 결과를 요약해 알려준다: 사용자 이름, 소속 카테고리, 프로젝트 수, 그리고 "이제 '오늘 한 일 연구노트에 기록해' 라고 말하면 됩니다".
- 소속 팀이 없으면 \`list_teams\` 로 팀 목록을 보여주고, 사용자가 고르면 \`join_team\` 으로 가입(또는 가입 요청)한다. 인자는 \`category_id\` (\`list_teams\` 결과의 \`id\`; 팀 = 카테고리, \`team_id\` 가 아님).

## 6. 이후 사용법 (요약)

- 세션 시작: \`whoami\` → 기록할 프로젝트 확정 (없으면 사용자에게 묻고, 새 연구일 때만 \`create_project\`)
- 작업 후: \`log_progress\` (제목은 결과가 드러나게, 본문은 \`## 한 일 / ## 결과 / ## 다음 할 일 / ## 메모\`)
- 누적 결론 변화: \`update_stage\` (읽고 병합 후 덮어쓰기) · 단계 진행: \`advance_stage\` · 다음 할 일: \`add_task\`
- 팀: \`team_feed\`, \`team_overview\`, \`add_comment\`, \`set_review\` · 팀 찾기/가입: \`list_teams\`, \`join_team(category_id)\` · 보고서: \`get_report\`
- 평가(마일스톤별, 평가자 여러 명): \`list_evaluations\` → 평가자는 \`add_evaluation\`(루브릭 점수+피드백), 팀은 \`respond_evaluation\`(답변)
- 트랙: 카테고리가 논문(paper) 또는 캡스톤(capstone) 트랙. 단계 id 는 \`get_project\` 의 "단계 순서"를 따른다. 캡스톤은 협업자(팀원)를 \`update_project.collaborators\` 로 지정
- 전체 지침: \`${base}/SKILL.md\`
`;
}
