# 연구노트 (Research Note)

연구실 논문 프로젝트의 **진행 상황을 날짜별로 기록**하고, **같은 카테고리(팀) 연구원끼리 공유·검토**하며, 각자 쓰는 **AI 도구(Claude Code 등)가 MCP 로 직접 기록**하는 연구 기록 시스템입니다. Cloudflare Workers + D1 위에서 서버 관리 없이 동작하며, 연구책임자가 이 리포를 그대로 가져다 자기 연구실용으로 배포할 수 있습니다.

```
연구원 브라우저 ──┐
Claude Code(MCP) ─┼──▶  Cloudflare Worker  ──▶  D1 (SQLite)
Cursor / Codex ───┘     ├─ /            SPA (정적)
                        ├─ /api/*       REST API (Bearer 토큰)
                        ├─ /mcp         원격 MCP 서버 (Streamable HTTP)
                        └─ /SKILL.md    AI 도구용 사용 지침
```

## 무엇을 할 수 있나

| 역할 | 기능 |
|---|---|
| **연구원** | 프로젝트(논문) 생성 → 날짜별 진행 기록(마크다운) → 단계별 누적 정리 → 할 일 관리 → 검토 요청 → 보고서(HTML/PDF/Markdown) |
| **같은 카테고리 팀원** | 칸반 보드로 서로의 진행 파악, 기록에 코멘트, 팀 활동 피드, 팀 보고서 |
| **리드(카테고리 책임자)** | 팀원 기록 승인/수정요청, 팀원 프로젝트에 기록·할 일 추가, 담당자 변경 |
| **관리자(연구책임자)** | 카테고리·연구원·토큰 관리, 전체 대시보드(단계 분포·활동 추이·정체 연구원·검토 대기·마감) |
| **평가자** | 카테고리 역할(여러 명). 마일스톤별 루브릭 채점·피드백, 초안/공개, 팀 답변 확인 |
| **AI 도구** | MCP 도구 26종으로 whoami → get_project → log_progress → update_stage 자동 기록, 팀 피드 조회, 보고서 초안 |

### 논문 흐름대로 기록한다

프로젝트마다 6개 단계가 있고, 기록은 단계에 붙습니다. 단계별 **누적 정리**는 논문 해당 절의 뼈대가 되고, 보고서는 이 순서로 생성됩니다. 흐름은 한 줄입니다. 프로젝트는 항상 기획에서 시작하고, **[다음 단계로 →]** 버튼(또는 MCP `advance_stage`)으로 넘어가며 현재 단계 앞은 자동으로 완료, 뒤는 예정이 됩니다. 마지막 단계에서 버튼을 누르면 논문 완료로 처리되고, 필요하면 앞 단계로 되돌릴 수 있습니다(정리 내용은 유지).

카테고리(팀)마다 **트랙**이 있고 트랙이 단계 구성과 평가 루브릭을 정합니다.

**논문 트랙** (`paper`)

| 단계 | id | 무엇을 정리하나 |
|---|---|---|
| 기획 | `planning` | 연구 질문·가설·기여점·범위 |
| 리서치 | `literature` | 선행연구·문헌 정리·차별점 |
| 관련기법 | `method` | 적용 기법·모델·실험 설계 |
| 실험결과 | `experiment` | 데이터·실험 결과·분석 |
| 논문작성 | `writing` | 초고·그림·표·구성 |
| 검토·투고 | `review` | 내부 검토·수정·투고·리뷰 대응 |

**캡스톤 트랙** (`capstone`, 졸업 프로젝트: 가설→빌드→배포→피드백→학습 루프를 3~4회)

| 단계 | id | 무엇을 정리하나 | 마일스톤 |
|---|---|---|---|
| 주제·문제 발견 | `topic` | 문제·목표 고객·검증할 가설 | 2주차 주제 발표 (루프 0) |
| 시장·사업모델 | `market` | 고객 니즈 조사, TAM-SAM-SOM, 린 캔버스 v1, 프로토타입 계획 | 4주차 1차 보고서 |
| MVP 빌드·배포 | `mvp` | MVP 범위, AI 도구 구현, 실배포 URL | 배포된 MVP |
| 피드백·개선 | `feedback` | 지표·사용자 테스트, 회고, 린 캔버스 v2 | 8주차 2차 보고서 · 9주차 데모 |
| 사업성·최종보고 | `business` | 루프별 기록, 3년 손익·사업성, 최종보고서 | 12주차 최종보고서 |
| 최종 발표 | `final` | 발표 자료·시연·Q&A 대응 | 기말 발표 |

캡스톤은 팀 작업이므로 프로젝트에 **협업자**(팀원)를 두어 담당자와 같은 권한으로 기록합니다(논문 트랙에서도 공저자에게 쓸 수 있습니다). 루프 기록은 날짜별 기록으로 남기고 제목에 루프 번호를 붙이는 것을 권장합니다.

### 평가·피드백

리드·**평가자**(카테고리 역할, 여러 명 가능)·관리자가 마일스톤(단계)마다 **루브릭 점수 + 피드백**을 남기고, 팀은 각 평가에 **답변**(반영 계획)을 답니다. 여러 평가자의 점수는 단계별 평균으로 집계되고, 보고서에 평가와 답변이 함께 실립니다("1차 평가의견 답변 첨부"). 초안으로 저장하면 평가자끼리만 보입니다.

| 트랙 | 루브릭 (만점 100) |
|---|---|
| 논문 | 문제 정의·기여 25 · 방법 타당성 25 · 실험·근거 25 · 글쓰기·완성도 25 |
| 캡스톤 | 직전 대비 개선도 30 · 목표 대비 달성률 30 · 기록 충실도 20 · 완성도·사업성 20 |

루브릭·단계는 `src/env.ts` 의 `TRACKS` 에서 바꿀 수 있습니다.

## 빠른 시작 (연구책임자, 약 10분)

사전 준비: Node.js 20+, [Cloudflare 계정](https://dash.cloudflare.com/sign-up) (무료 플랜으로 충분), `git`.

```bash
git clone https://github.com/juho127/researchNote.git research-note
cd research-note
npm install
npx wrangler login          # 브라우저에서 Cloudflare 로그인 (또는 CLOUDFLARE_API_TOKEN 환경변수)
npm run setup               # D1 생성 → 마이그레이션 → 배포 → 관리자 토큰 발급
```

`setup` 이 끝나면 **배포 URL** 과 **관리자 토큰**이 출력됩니다. 토큰은 해시로만 저장되므로 이때 복사해 두세요.

1. 배포 URL 에 접속해 관리자 토큰으로 로그인
2. **[관리자] → 카테고리** 에서 연구 그룹(팀) 생성 (예: "LLM 응용"). **트랙**(논문 / 캡스톤)과 가입 정책(승인 후 가입(기본) / 즉시 가입 / 초대만) 선택. 캡스톤 수업이면 캡스톤 트랙 팀을 만들고 조교·심사위원을 **평가자**로 배정
3. 연구원 온보딩은 둘 중 하나
   - **자율 신청(권장)**: 연구원에게 `https://<배포URL>/#/apply` 를 알려준다 → 신청 → **[관리자] → 발급 신청** 에서 승인 → 연구원이 수령 코드로 토큰을 직접 1회 수령
   - **직접 등록**: **[관리자] → 연구원** 에서 등록 + "등록과 동시에 토큰 발급" → 토큰 전달
4. 연구원은 **[팀 로비]** 에서 다른 팀에도 가입(정책에 따라 즉시 또는 리드 승인)할 수 있다
5. AI 도구 연동은 **[설정]** 의 명령을 복사하거나, AI 에게 `https://<배포URL>/connect` 주소만 주면 AI 가 스스로 연동한다

워커 이름을 바꾸려면 `npm run setup -- --name my-lab-notes --db my-lab-notes-db`. 기관명·단계 라벨 커스터마이즈는 [커스터마이즈](#커스터마이즈) 참고.

> `wrangler.jsonc` 의 `database_id` 는 setup 이 자동으로 채웁니다. 이후 코드 변경 배포는 `npm run deploy` 만 하면 됩니다.

## 연구원 사용 흐름

0. **토큰 받기**: `/#/apply` 에서 발급 신청 → 관리자 승인 → 수령 코드로 토큰 1회 수령(`/#/claim/<코드>`). 또는 AI 에게 `/connect` 주소를 주면 신청부터 연동까지 대신 진행.
0'. **팀 로비**: 전체 팀 목록·구성원·활동을 보고 가입(즉시/승인). 여러 팀에 속할 수 있고, 리드는 팀 페이지 [구성원] 에서 가입 요청을 승인한다.
1. **홈**: "오늘의 기록" 폼에 지금 한 일을 바로 기록. 내 프로젝트 카드(단계 진행 바·마지막 기록·할 일 수)와 팀 활동 피드.
2. **팀 페이지**: 단계별 칸반 보드 / 목록 / 구성원 / 검토 대기 / 활동. 팀원 프로젝트를 열어 기록을 읽고 코멘트.
3. **프로젝트 페이지**
   - 상단 단계 스테퍼(클릭 → 단계별 정리)
   - **타임라인**: 날짜별 기록. 단계·검토 상태 필터. 수정/삭제/검토 요청, 코멘트 스레드
   - **단계별 정리**: 6개 단계의 누적 결론(마크다운). [다음 단계로 →] / [이 단계로 되돌리기] 로 한 흐름 진행 (상태는 자동)
   - **할 일**: 체크리스트, 담당·기한·진행 중 표시
   - **보고서**: 기간 지정 → HTML(새 탭, 인쇄/PDF 저장 버튼) 또는 Markdown 다운로드
4. **설정**: 내 정보, AI 도구 연동 명령(토큰 자동 삽입, 기본 가림), 로그아웃

기록 본문은 마크다운이며 표·코드·체크박스·링크를 지원합니다. 권장 구조: `## 한 일 / ## 결과 / ## 다음 할 일 / ## 메모`.

## AI 도구 연동 (웹 MCP)

이 서버는 **원격 MCP 서버**를 내장합니다. 연구원 컴퓨터에 아무것도 설치하지 않고, AI 도구에 URL 과 토큰만 등록하면 됩니다.

### 가장 쉬운 방법: AI 에게 주소 하나

`https://<배포URL>/connect` 는 에이전트가 읽는 연동 안내(markdown)입니다. AI 도구에 "이 주소를 읽고 연구노트를 연동해줘" 라고 하면 AI 가 토큰 확인 → (없으면) 발급 신청·승인 확인·수령 → MCP 등록 → 스킬 저장 → `whoami` 검증까지 수행합니다. `/llms.txt`, `/ai` 도 같은 문서입니다.

### Claude Code (권장)

```bash
claude mcp add --transport http research-note https://<배포URL>/mcp --header "Authorization: Bearer rn_xxx"
```

이후 `claude` 안에서:

- "오늘 한 실험 결과를 연구노트에 기록해" → `whoami` → `get_project` → `log_progress`
- "실험 단계 정리를 지금 결과로 갱신해" → `update_stage`
- "팀원들 이번 주 뭐 했는지 보여줘" → `team_feed`
- "이 프로젝트 주간 보고서 초안 만들어" → `get_report`

서버가 `initialize` 응답의 `instructions` 로 사용 원칙을 전달하므로 스킬 없이도 동작합니다. 더 정교한 절차와 `/research-note:log` 같은 슬래시 커맨드가 필요하면 **플러그인**을 설치하세요 (`integrations/claude-code/research-note`):

```bash
# 환경변수 (PowerShell: $env:RESEARCH_NOTE_URL="..." )
export RESEARCH_NOTE_URL=https://<배포URL>
export RESEARCH_NOTE_TOKEN=rn_xxx
# claude 안에서
/plugin marketplace add juho127/researchNote
/plugin install research-note@research-note
```

플러그인은 MCP 서버 등록 + 스킬(`skills/research-note/SKILL.md`) + 커맨드 4종(`/research-note:log`, `:status`, `:review`, `:report`)을 제공합니다. 스킬 파일만 쓰고 싶으면 `https://<배포URL>/SKILL.md` 를 `~/.claude/skills/research-note/SKILL.md` 로 저장하면 됩니다.

### 다른 도구

Cursor · Claude Desktop(mcp-remote) · Codex CLI · Gemini CLI 설정 예시는 웹 **[설정]** 페이지가 토큰을 채워 보여줍니다. 명세는 [docs/MCP.md](docs/MCP.md).

### MCP 도구 목록

`whoami` `list_projects` `get_project` `create_project` `update_project`(협업자 포함) `log_progress` `list_entries` `get_entry` `update_entry` `update_stage` `advance_stage` `list_tasks` `add_task` `update_task` `add_comment` `set_review` `list_evaluations` `add_evaluation` `respond_evaluation` `team_feed` `team_overview` `list_teams` `join_team` `search` `get_report` + 프롬프트 `log_today` `weekly_review` `research_note_guide` + 리소스 `research-note://guide`, `research-note://me`, `research-note://project/{id}`

## 보고서

- 프로젝트 보고서: 메타 → 연구 요약 → **단계별 정리(논문 순서)** → 할 일 → **날짜별 기록 + 검토 코멘트**
- 팀 보고서: 카테고리의 프로젝트별 진행 바 + 기간 내 기록 요약
- 형식: `?format=html`(기본, 인쇄 CSS 포함 → 브라우저 "PDF로 저장") · `md` · `json`. `from`/`to` 로 기간 지정.
- MCP `get_report` 는 마크다운을 반환하므로 AI 가 주간 보고 초안을 바로 씁니다.

## 권한 모델

| 동작 | 관리자 | 카테고리 리드 | 담당자·협업자 | 같은 카테고리 구성원 | 평가자 | 핀 열람자 | 외부 |
|---|---|---|---|---|---|---|---|
| 프로젝트 보기·기록 읽기·보고서 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ (공개 팀만) | ✗ |
| 코멘트 | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ |
| 프로젝트 생성 | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ |
| 기록 작성 | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ |
| 기록 수정·삭제 | ✓ | 본인 것 | 본인 것 | 본인 것 | ✗ | ✗ | ✗ |
| 프로젝트 메타·단계 정리·단계 진행 | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ |
| 협업자 지정 | ✓ | ✓ | 담당자 | ✗ | ✗ | ✗ | ✗ |
| 검토 요청 | ✓ | ✓ | 작성자 | ✗ | ✗ | ✗ | ✗ |
| 승인 / 수정 요청 | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ |
| 평가 작성 (루브릭·피드백) | ✓ | ✓ | ✗ | ✗ | ✓ | ✗ | ✗ |
| 평가에 답변 | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ |
| 할 일 추가·갱신 | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ |
| 카테고리·연구원·토큰 관리 | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |

토큰은 `rn_` 접두 40자, 서버에는 SHA-256 해시만 저장. 회수 즉시 웹·MCP 접근 차단. 관리자 페이지에서 "마지막 사용" 을 볼 수 있습니다.

### 핀 열람 (공개 카테고리)

외부 심사위원·다음 기수·수업 참관자처럼 **가입 없이 보기만** 하면 되는 사람을 위해, 관리자가 카테고리를 **공개**로 두고 **핀**(영문·숫자 4~12자)을 정하면 `/#/view` 에서 핀만 입력해 읽기 전용으로 열람할 수 있습니다.

- 핀은 관리자가 바꿀 때까지 유지, 열람 세션(`rnv_` 토큰)은 **24시간** 뒤 만료. 핀 변경·해제·공개 해제 시 기존 세션은 즉시 끊깁니다.
- 무차별 대입 방지: 카테고리+IP 기준 5회 실패 → 10분 잠금. 핀은 해시로만 저장.
- 열람자는 프로젝트·기록·단계 정리·공개된 평가·보고서(PDF)를 볼 수 있고, 구성원 이메일·가입 요청·초안 평가·다른 팀은 보지 못합니다. 쓰기 API 와 MCP 쓰기 도구는 서버에서 전부 거부됩니다.
- 열람 토큰은 REST·MCP 에도 그대로 쓸 수 있어, 외부 심사위원이 자기 AI 에게 "이 팀 진행 요약해줘" 를 시킬 수 있습니다 (조회 도구만).

### 온보딩·가입 흐름

| 흐름 | 누가 | 어떻게 |
|---|---|---|
| 토큰 발급 신청 | 신규 연구원 | `/#/apply` 에서 이름·이메일·희망 팀 입력 → 수령 코드 보관 → 관리자 승인 후 `/#/claim/<코드>` 에서 토큰 1회 수령 (관리자는 토큰을 보지 않음) |
| 신청 승인/거절 | 관리자 | [관리자] → 발급 신청. 승인 시 계정·소속 생성, 역할(구성원/리드) 지정 |
| 팀 가입 | 기존 연구원 | [팀 로비] → 가입. 팀의 가입 정책이 즉시/승인/초대만 중 무엇인지에 따라 즉시 가입 또는 요청 |
| 가입 요청 승인 | 팀 리드 또는 관리자 | 팀 페이지 [구성원] 또는 [관리자] → 발급 신청 하단 |
| 탈퇴 | 본인 | [팀 로비] → 탈퇴 (진행 중인 내 프로젝트가 있으면 불가, 유일한 리드는 불가) |
| 핀 열람 | 외부인 | `/#/view` → 공개 팀 선택 → 핀 입력 → 24시간 읽기 전용 열람 (가입·토큰 불필요) |
| 토큰 재발급 | 기존 연구원 | `/#/reissue` 에서 등록한 이름+이메일 입력 → 일치하면 **즉시 새 토큰**(기본으로 기존 토큰 회수, 5회 불일치 시 10분 잠금, 시간당 3회). 이름·이메일만으로 발급되므로 승인 절차가 필요하면 `REISSUE_AUTO: "false"` (요청 → 관리자 승인 → 수령) |

스팸 방지: `npx wrangler secret put SIGNUP_CODE` 로 신청 코드를 두면 신청 폼에 코드 입력이 필요합니다. 공개 신청을 끄려면 `wrangler.jsonc` 의 `SIGNUP_ENABLED` 를 `"false"` 로.

## 로컬 개발

```bash
npm install
npm run migrate:local                       # 로컬 D1 스키마
node scripts/bootstrap-admin.mjs --local    # 로컬 관리자 토큰
npm run dev                                 # http://127.0.0.1:8787
BASE_URL=http://127.0.0.1:8787 ADMIN_TOKEN=rn_... npm test        # 116개 E2E 스모크
BASE_URL=http://127.0.0.1:8787 ADMIN_TOKEN=rn_... npm run seed:demo   # 데모 데이터 (기존 팀에 넣으려면 -- --team-a <id> --team-b <id>)
```

`.dev.vars` 의 `ADMIN_TOKEN` 은 로컬 부트스트랩용 시크릿입니다 (배포본에도 `npx wrangler secret put ADMIN_TOKEN` 으로 넣으면 그 값으로 관리자 로그인 가능 — DB 관리자를 만든 뒤에는 지우는 것을 권장).

## 커스터마이즈

- **기관명·마크·앱 이름·타임존**: `wrangler.jsonc` 의 `vars` (`APP_NAME`, `ORG_NAME`, `ORG_SUB`, `ORG_MARK`, `APP_TZ`)
- **단계 이름/설명**: `src/env.ts` 의 `STAGE_LABELS`, `STAGE_HINTS` (id 는 유지 권장)
- **디자인**: `public/styles.css` 상단 CSS 변수 (HUFS 팔레트: navy/teal/gold)
- **자동 배포**: `.github/workflows/deploy.yml` — 리포 Secrets 에 `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, Variables 에 `CF_AUTO_DEPLOY=true`

## 리포 구성

```
src/
  index.ts          라우팅 엔트리 (/api, /mcp, /SKILL.md, 정적)
  routes.ts         REST 라우터
  mcp.ts            MCP 서버 (JSON-RPC, tools/prompts/resources)
  skill.ts          AI 지침 (SKILL.md 임포트)
  env.ts            타입·단계 정의
  lib/              auth(토큰), db, http, markdown, id, time
  services/         projects, entries(코멘트·검토), tasks, admin, feed, report
public/             SPA (빌드 없음, ES 모듈)
  js/core.js        API 클라이언트·DOM·마크다운·모달
  js/pages/         login, home, team, project, admin, settings
migrations/         D1 스키마
scripts/            setup, bootstrap-admin, seed-demo
tests/smoke.mjs     E2E 스모크 테스트
integrations/claude-code/research-note/   Claude Code 플러그인 (스킬·커맨드·.mcp.json)
docs/               API · MCP · 데이터 모델 · 관리자/연구원 가이드
```

문서: [API](docs/API.md) · [MCP](docs/MCP.md) · [데이터 모델](docs/DATA_MODEL.md) · [관리자 가이드](docs/ADMIN_GUIDE.md) · [연구원 가이드](docs/USER_GUIDE.md)

## FAQ

- **비용?** Cloudflare 무료 플랜: Workers 10만 요청/일, D1 5GB·500만 행 읽기/일. 연구실 규모에서는 무료.
- **PDF 는?** HTML 보고서의 [인쇄 / PDF 저장] → 브라우저 인쇄 대화상자에서 PDF 로 저장. 서버 측 PDF 렌더링(Browser Rendering)은 유료라 채택하지 않았습니다.
- **첨부파일?** 링크(마크다운)로 붙입니다. R2 업로드는 로드맵.
- **토큰을 잃어버리면?** 관리자가 [토큰] 탭에서 회수 후 재발급.
- **여러 연구실이 하나의 배포를 공유?** 카테고리로 분리됩니다. 관리자만 전체를 봅니다.

## 라이선스

MIT — 한국외국어대학교 Global Business & Technology, 배주호 (juho@hufs.ac.kr)
