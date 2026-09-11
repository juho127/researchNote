# MCP 연동 가이드

연구노트는 **원격 MCP 서버(Streamable HTTP, stateless)** 를 `/mcp` 에 내장합니다. 연구원 PC 에 설치할 것은 없습니다. AI 도구에 URL 과 개인 토큰만 등록하면 됩니다.

**가장 쉬운 방법**: AI 도구에 `https://<URL>/connect 를 읽고 연구노트를 연동해줘` 라고 말하세요. `/connect` 는 에이전트용 안내(markdown)로, 토큰 확인 → 발급 신청/수령 → MCP 등록 → 스킬 저장 → 검증 절차와 정확한 명령이 들어 있습니다.

- Endpoint: `POST https://<배포URL>/mcp`
- 인증: `Authorization: Bearer rn_...` (개인 토큰, 웹 로그인과 동일). 핀 열람 토큰(`rnv_...`, `/#/view` 에서 발급)도 쓸 수 있으나 **조회 도구만** 동작하고 쓰기 도구는 `isError` 로 거부됩니다
- 프로토콜: MCP `2025-06-18` / `2025-03-26` / `2024-11-05` (JSON-RPC 2.0, 단건·배치, 알림은 202)
- 세션 없음(stateless). `GET /mcp` 는 안내 JSON, SSE 스트림은 미지원(405).
- 기능: `tools`, `prompts`, `resources`, `logging`. `initialize` 응답의 `instructions` 에 사용 원칙 포함.

## 클라이언트별 설정

웹 **[설정]** 페이지가 아래 설정을 본인 토큰으로 채워서 보여줍니다.

### Claude Code

```bash
# 현재 프로젝트 폴더 (.mcp.json 은 만들지 않고 로컬 설정에 저장)
claude mcp add --transport http research-note https://<URL>/mcp --header "Authorization: Bearer rn_xxx"
# 모든 프로젝트
claude mcp add --scope user --transport http research-note https://<URL>/mcp --header "Authorization: Bearer rn_xxx"
# 확인
claude mcp list
```

`claude` 안에서 `/mcp` 로 연결 상태를 보고, "연구노트에 오늘 한 일 기록해" 처럼 말하면 됩니다.

#### 플러그인 (스킬 + 슬래시 커맨드)

```bash
export RESEARCH_NOTE_URL=https://<URL>
export RESEARCH_NOTE_TOKEN=rn_xxx
```
```
/plugin marketplace add juho127/researchNote
/plugin install research-note@research-note
```

| 커맨드 | 동작 |
|---|---|
| `/research-note:log [프로젝트] [메모]` | 세션의 연구 작업을 정리해 확인 후 `log_progress` |
| `/research-note:status [id]` | 내 프로젝트/팀 현황 요약 + 이번 주 할 일 제안 |
| `/research-note:review [카테고리|기록 id]` | 검토 대기 기록 읽고 코멘트 초안 → 확인 후 `add_comment` |
| `/research-note:report <프로젝트 id> [from] [to]` | `get_report` 로 주간 보고 초안 |

스킬만 쓰려면 `https://<URL>/SKILL.md` 를 `~/.claude/skills/research-note/SKILL.md` 로 저장하세요.

### Cursor — `.cursor/mcp.json`

```json
{ "mcpServers": { "research-note": { "url": "https://<URL>/mcp", "headers": { "Authorization": "Bearer rn_xxx" } } } }
```

### Claude Desktop — `claude_desktop_config.json`

Settings → Connectors 에서 원격 MCP 를 직접 추가할 수 있으면 URL 만 넣으세요. 커스텀 헤더를 못 넣는 버전이면 `mcp-remote` 브리지:

```json
{ "mcpServers": { "research-note": { "command": "npx", "args": ["-y", "mcp-remote", "https://<URL>/mcp", "--header", "Authorization: Bearer rn_xxx"] } } }
```

### OpenAI Codex CLI — `~/.codex/config.toml`

```toml
[mcp_servers.research-note]
url = "https://<URL>/mcp"
http_headers = { Authorization = "Bearer rn_xxx" }
```

### Gemini CLI — `~/.gemini/settings.json`

```json
{ "mcpServers": { "research-note": { "httpUrl": "https://<URL>/mcp", "headers": { "Authorization": "Bearer rn_xxx" } } } }
```

## 도구 (tools)

| 도구 | 인자 | 설명 |
|---|---|---|
| `whoami` | – | 사용자·소속·내 프로젝트·오늘 날짜·단계 목록. **세션 시작 시 먼저** |
| `list_projects` | `category_id?, mine?, status?, q?` | 열람 가능한 프로젝트 |
| `get_project` | `project_id` | 메타·단계별 정리·할 일·최근 기록 (마크다운) |
| `create_project` | `category_id, title, summary?, stage?, target_venue?, deadline?, tags?` | 새 논문 (명시적 요청 시만) |
| `update_project` | `project_id, title?, summary?, stage?, status?, target_venue?, deadline?, tags?` | 메타 수정 |
| **`log_progress`** | `project_id, title, content, stage?, date?, request_review?` | **날짜별 기록 추가** (source=mcp) |
| `list_entries` | `project_id?, category_id?, since?, until?, stage?, q?, review_status?, limit?, full?` | 기록 조회 |
| `get_entry` | `entry_id` | 본문 + 코멘트 |
| `update_entry` | `entry_id, title?, content?, stage?, date?` | 내 기록 수정 |
| **`update_stage`** | `project_id, stage, summary` | **단계 누적 정리 갱신** (덮어쓰기 → 먼저 읽고 병합). 상태는 흐름에서 자동 |
| `advance_stage` | `project_id, to?` | 현재 단계 완료 → 다음 단계 (마지막이면 논문 완료). `to` 로 특정 단계 이동·되돌리기 |
| `list_tasks` / `add_task` / `update_task` | `project_id` / `task_id` … | 할 일 |
| `add_comment` | `entry_id, content, kind?` | 코멘트 (리드: approve / request_changes) |
| `set_review` | `entry_id, status, note?` | 검토 상태 |
| `team_feed` | `category_id?, limit?` | 팀 활동 |
| `team_overview` | `category_id` | 구성원·프로젝트·검토 대기 |
| `list_evaluations` | `project_id` | 평가자들의 루브릭 점수·피드백과 팀 답변 (단계별 평균) |
| `add_evaluation` | `project_id, stage?, title?, scores?, feedback?, visible?` | 평가 작성 (리드·평가자·관리자) |
| `respond_evaluation` | `evaluation_id, response` | 팀 답변 (담당자·협업자·리드·관리자) |
| `list_teams` | – | 팀 로비: 전체 팀·트랙·가입 정책·내 상태 |
| `join_team` | `category_id, message?` | 가입(open) 또는 가입 요청(approval) |
| `search` | `q, category_id?` | 검색 |
| `get_report` | `project_id, from?, to?, format?` | 보고서 마크다운 |

응답은 사람이 읽기 좋은 텍스트(`content[0].text`) + 구조화 데이터(`structuredContent`). 권한/검증 오류는 `isError: true` 로 반환되어 AI 가 사용자에게 설명할 수 있습니다.

## 프롬프트 · 리소스

- 프롬프트: `log_today(project_id?)`, `weekly_review(project_id)`, `research_note_guide`
- 리소스: `research-note://guide`(SKILL.md), `research-note://me`, 템플릿 `research-note://project/{project_id}`

## 원시 호출 예시

```bash
curl -X POST https://<URL>/mcp -H "Authorization: Bearer rn_xxx" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"log_progress","arguments":{"project_id":"prj_abc","title":"실험 3 완료","content":"## 결과\n- F1 0.83","stage":"experiment"}}}'
```

## AI 가 기록할 때의 원칙 (SKILL.md 요약)

1. `whoami` → 프로젝트 확정 (애매하면 사용자에게 질문)
2. `get_project` 로 맥락 파악, 중복 방지
3. `log_progress` — `## 한 일 / ## 결과 / ## 다음 할 일 / ## 메모`, 제목은 결과가 드러나게, `stage` 는 작업 성격
4. 누적 결론 변화 → `update_stage` (읽고 병합), 다음 할 일 → `add_task`
5. 실제로 한 일과 실제 결과만. 수치엔 단위·시드·반복. 실패도 기록.
6. 세션 끝에 의미 있는 결과가 있는데 기록 요청이 없었으면 한 번 제안.

전체 지침: [`integrations/claude-code/research-note/skills/research-note/SKILL.md`](../integrations/claude-code/research-note/skills/research-note/SKILL.md) (= `https://<URL>/SKILL.md`)
