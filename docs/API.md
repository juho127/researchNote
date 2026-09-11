# REST API

- Base: `https://<배포URL>`
- 인증: 모든 `/api/*` 요청에 `Authorization: Bearer rn_...` (또는 `X-API-Key`). 실패 시 `401 {error:"unauthorized"}`
- 요청/응답 JSON (UTF-8). 날짜는 `YYYY-MM-DD`, 시각은 ISO 8601 UTC.
- 오류 형식: `{ "error": "<code>", "message": "<한국어 설명>" }` — `bad_request` 400, `unauthorized` 401, `forbidden` 403, `not_found` 404, `too_large` 413, `internal` 500
- 선택 헤더 `X-Client: web|mcp|api` — 활동 로그의 `source` 에 기록 (기본 `api`)
- CORS: `*` 허용 (Bearer 인증이므로 쿠키 없음)

## 공개 (인증 불필요)

| Method | Path | 설명 |
|---|---|---|
| GET | `/health` | 상태 확인 |
| GET | `/connect` (= `/ai`, `/llms.txt`) | AI 에이전트용 자기 연동 안내 (markdown) |
| GET | `/SKILL.md` | AI 사용 지침 |
| GET | `/api/public/config` | `{app, signup_enabled, signup_code_required, categories[]}` |
| POST | `/api/public/requests` | `{name*, email, category_id, note, signup_code?}` → 201 `{id, claim_code(1회 표시), status}`. 같은 이메일로 대기 중이면 400, 이미 계정이 있으면 409 `already_registered` |
| GET | `/api/public/requests/:claim_code` | `{status: pending|approved|rejected, claimed, decision_note, ...}` |
| POST | `/api/public/requests/:claim_code/claim` | 승인된 신청의 토큰 1회 수령 → `{token, user_id, name}` (409: 대기/거절/이미 수령) |
| POST | `/api/public/reissue` | 기존 회원 토큰 재발급 `{name*, email*, note, revoke_existing(기본 true)}`. 이름+이메일이 활성 계정과 일치해야 함(404 `no_match`, IP당 5회 → 10분 잠금 429). `REISSUE_AUTO` 기본: 201 `{mode:"auto", token(1회 표시), user_id, revoked}` 즉시 발급(시간당 3회). `REISSUE_AUTO="false"`: 201 `{mode:"approval", id, claim_code, status}` → 관리자 승인 후 `/claim` |
| GET | `/api/public/teams` | 핀 열람이 가능한(공개 + 핀 설정) 팀 목록 `[{id, name, description, track, member_count, active_projects}]` |
| POST | `/api/public/teams/:id/pin` | `{pin*, label?}` → `{viewer_token(rnv_…), expires_at, category}`. 401 핀 오류(남은 시도 표시), 429 5회 실패 후 10분 잠금(카테고리+IP), 404 비공개 |

### 핀 열람 세션 (읽기 전용)

`rnv_` 토큰은 `Authorization: Bearer` 로 `rn_` 토큰과 똑같이 쓰되 **해당 카테고리에 한해 GET 만** 허용됩니다 (다른 메서드는 403 `forbidden`). 24시간 뒤 만료(401). 관리자가 핀을 바꾸거나 공개를 끄면 즉시 무효. `/api/me` 에 `viewer: {category_id, category_name, expires_at}` 가 실립니다. MCP 에서도 조회 도구(`whoami, list_projects, get_project, list_entries, get_entry, list_tasks, list_evaluations, team_feed, team_overview, list_teams, search, get_report`)만 동작합니다. 구성원 이메일·가입 요청·초안 평가는 보이지 않습니다.

## 공통

| Method | Path | 설명 |
|---|---|---|
| GET | `/api/me` | 내 정보·소속·내 프로젝트·단계 정의·앱 설정 |
| GET | `/api/categories` | 내 소속 카테고리 (관리자: 전체) |
| GET | `/api/categories/:id` | 카테고리 상세: `category, members[], projects[], activity[], review_queue[], my_role` |
| GET | `/api/categories/:id/board` | 칸반: `columns[{stage, projects[]}], paused[], done[]` |
| GET | `/api/categories/:id/report?format=html|md|json&from=&to=&download=1` | 팀 보고서 |
| GET | `/api/feed?category_id=&project_id=&limit=&before=` | 활동 피드 (내 소속 전체 또는 지정) |
| GET | `/api/search?q=&category_id=&limit=` | `{projects[], entries[]}` |

## 프로젝트

| Method | Path | Body / Query |
|---|---|---|
| GET | `/api/projects` | `?category_id= &mine=1 &owner_id= &status=active|paused|done|archived|all &q= &limit=` |
| POST | `/api/projects` | `{category_id*, title*, summary, stage, target_venue, deadline, tags(문자열|배열), owner_id}` → 201 상세 |
| GET | `/api/projects/:id` | 상세: 카드 필드 + `stages[6], tasks[], members[], recent_entries[], can_edit, can_review` |
| PATCH | `/api/projects/:id` | 위 필드 중 일부. `stage` 변경 시 해당 단계가 todo 면 doing 으로. `owner_id`(리드+), `category_id`(관리자) |
| DELETE | `/api/projects/:id` | 보관(status=archived). 데이터 유지 |
| PUT | `/api/projects/:id/stages/:stage` | `{summary(마크다운, 덮어쓰기)}` → 상세. 상태는 흐름에서 도출됨. 호환 별칭: `set_current:true` 또는 `status:"doing"` → 그 단계로 이동, `status:"done"`(현재 단계) → 다음 단계로 |
| PUT | `/api/projects/:id/collaborators` | `{user_ids: [...]}` 협업자 전체 교체 (담당자·리드·관리자). 같은 카테고리 구성원만, 평가자 제외 |
| GET | `/api/projects/:id/evaluations` | `{evaluations[], rubric[], summary{stage: {count, avg_total}}}`. 초안(visible=false)은 평가자·리드·관리자만 |
| POST | `/api/projects/:id/evaluations` | `{stage?, title?, scores: {축id: 점수}, feedback(md), visible?}` (리드·평가자·관리자) → 201 |
| GET/PATCH/DELETE | `/api/evaluations/:id` | 작성한 평가자·관리자 |
| POST | `/api/evaluations/:id/respond` | `{response(md)}` 팀 답변 (담당자·협업자·리드·관리자) |
| POST | `/api/projects/:id/advance` | `{to?: stage}` 생략: 현재 단계 완료 → 다음 단계 (마지막 단계면 논문 완료 `status=done`). `to`: 그 단계로 이동(되돌리기 포함). 앞 단계=done, 대상=doing, 뒤=todo 로 재계산 |
| GET | `/api/projects/:id/report?format=html|md|json&from=&to=&comments=0&download=1` | 프로젝트 보고서 |

프로젝트 카드 필드: `id, category_id, category_name, owner_id, owner_name, title, summary, stage, status, track(paper|capstone), target_venue, deadline, tags, created_at, updated_at, entry_count, last_entry_date, last_entry_at, open_tasks, review_requested, stage_done`. 상세에는 `stages[](트랙 순서), tasks[], members[](role: lead|member|evaluator), collaborators[], can_edit, can_review, can_evaluate, track_label, track_noun` 추가. `stage` 값은 프로젝트 트랙의 단계만 유효 (`GET /api/me` 의 `tracks` 참고).

## 기록 (entries)

| Method | Path | Body / Query |
|---|---|---|
| GET | `/api/entries` | `?project_id= &category_id= &mine=1 &author_id= &stage= &since= &until= &review_status= &q= &limit= &offset= &brief=1` |
| GET | `/api/projects/:id/entries` | `?stage= &since= &until= &review_status= &limit= &offset=` (project 고정, 본문 전체 포함) |
| POST | `/api/projects/:id/entries` | `{title*, content(md), stage(기본: 프로젝트 현재 단계), date(기본: 오늘 KST), review_status: none|requested}` → 201 |
| GET | `/api/entries/:id` | 상세 + `comments[]` |
| PATCH | `/api/entries/:id` | `{title, content, stage, date, review_status}` (작성자·관리자) |
| DELETE | `/api/entries/:id` | 삭제 (코멘트 함께) |
| POST | `/api/entries/:id/review` | `{status: none|requested|changes_requested|approved, note}` — 승인/수정요청은 리드·관리자. note 는 코멘트로 저장 |
| GET | `/api/entries/:id/comments` | 코멘트 목록 |
| POST | `/api/entries/:id/comments` | `{content*, kind: comment|approve|request_changes}` → 201 (approve/request_changes 는 검토 상태도 변경) |
| DELETE | `/api/comments/:id` | 작성자·관리자 |

기록 필드: `id, project_id, project_title, category_id, author_id, author_name, date, stage, title, content, source(web|mcp|api), review_status, comment_count, created_at, updated_at, can_edit`

## 할 일 (tasks)

| Method | Path | Body |
|---|---|---|
| GET | `/api/projects/:id/tasks?status=` | |
| POST | `/api/projects/:id/tasks` | `{title*, status, assignee_id, due, stage}` |
| PATCH | `/api/tasks/:id` | 위 필드 (done → `done_at` 기록) |
| DELETE | `/api/tasks/:id` | 생성자·프로젝트 소유자·리드·관리자 |

## 팀 로비 · 가입

| Method | Path | Body / 설명 |
|---|---|---|
| GET | `/api/lobby` | 활성 팀 전체: `id, name, description, join_policy(open|approval|closed), member_count, lead_names, member_names, active_projects, entries_7d, last_activity_at, my_role, my_request_status` |
| POST | `/api/lobby/:id/join` | `{message}` → open: `{joined:true}` / approval: `{pending:true, request_id}` / closed: 403 |
| DELETE | `/api/lobby/:id/join` | 대기 중 요청 취소 또는 탈퇴 (진행 중 내 프로젝트가 있으면 400) |
| GET | `/api/join-requests?category_id=&status=` | 리드(자기 팀)·관리자(전체) |
| POST | `/api/join-requests/:id/approve` | `{note, role: member|lead}` (리드·관리자) |
| POST | `/api/join-requests/:id/reject` | `{note}` |

## 관리자 (`role=admin` 필요)

| Method | Path | Body / 설명 |
|---|---|---|
| GET | `/api/admin/requests?status=pending|approved|rejected|all` | 토큰 발급 신청 목록 |
| POST | `/api/admin/requests/:id/approve` | 가입(kind=signup): `{name, id, email, note, category_id, role: member|lead|evaluator, decision_note, force}` → 계정 생성 `{request_id, user}`. 같은 이메일 계정이 있으면 409 `duplicate_email` (force=true 로 강행). 재발급(kind=reissue): `{revoke_existing: bool, decision_note}` → `{request_id, user, revoked}` (계정 생성 없음) |
| POST | `/api/admin/requests/:id/reject` | `{reason}` |
| DELETE | `/api/admin/requests/:id` | 처리된 신청 기록 삭제 |
| POST | `/api/admin/requests/:id/reissue-claim` | 승인된 신청의 수령 코드 재발급 → `{claim_code(1회 표시), name, user_id, was_claimed}`. 이전 코드 즉시 무효, 미수령 상태로 복귀 |

| Method | Path | Body / 설명 |
|---|---|---|
| GET | `/api/admin/overview` | `counts, by_stage, by_category[], per_user[], daily_activity[], review_queue[], deadlines[]` |
| GET | `/api/admin/activity?category_id=&actor_id=&limit=&before=` | 활동 로그 |
| GET | `/api/admin/categories?all=1` | 보관 포함 |
| POST | `/api/admin/categories` | `{name*, description, color, id, join_policy: open|approval|closed, track: paper|capstone, is_public: bool, pin: "영문·숫자 4~12자"}` |
| PATCH | `/api/admin/categories/:id` | `{name, description, color, archived: bool, join_policy, track(프로젝트가 없을 때만), is_public: bool, pin: 새 핀 \| ""(해제)}`. 핀 변경·해제·공개 해제·보관 시 열람 세션 전부 만료. 응답에 `pin_set`, `pin_updated_at`, `active_viewers` (핀·해시는 절대 반환하지 않음) |
| POST | `/api/admin/categories/:id/viewers/revoke` | 현재 열람 세션 전부 만료 (핀 유지) → `{revoked}` |
| POST | `/api/admin/locks/clear` | `{category_id?, ip?}` 핀 입력·재발급 시도 잠금 해제 (비우면 전체) → `{cleared}` |
| GET | `/api/admin/users` | 사용자 + `memberships[], token_count, active_tokens, project_count, entry_count, last_entry_at` |
| POST | `/api/admin/users` | `{name*, id, email, role: admin|member, note, categories: ["cat"] | [{category_id, role: lead|member}], issue_token: bool}` → `{user, token?, token_hint?}` |
| PATCH | `/api/admin/users/:id` | `{name, email, role, note, disabled: bool, categories(전체 교체)}` |
| PUT | `/api/admin/users/:id/memberships/:cat` | `{role: lead|member}` |
| DELETE | `/api/admin/users/:id/memberships/:cat` | |
| GET | `/api/admin/tokens?user_id=` | `id, user_id, user_name, hint, label, created_at, last_used_at, revoked_at` |
| POST | `/api/admin/tokens` | `{user_id*, label}` → `{id, token(1회 표시), hint}` |
| POST | `/api/admin/tokens/:id/revoke` | 회수 |

## 예시

```bash
# 기록 추가
curl -X POST https://<URL>/api/projects/prj_abc/entries \
  -H "Authorization: Bearer rn_xxx" -H "Content-Type: application/json" \
  -d '{"title":"baseline 완료, acc 0.91","content":"## 결과\n| 모델 | acc |\n|---|---|\n| A | 0.91 |","stage":"experiment"}'

# 단계 정리 갱신 + 현재 단계로
curl -X PUT https://<URL>/api/projects/prj_abc/stages/experiment \
  -H "Authorization: Bearer rn_xxx" -H "Content-Type: application/json" \
  -d '{"status":"doing","summary":"## 실험\n- baseline 0.91","set_current":true}'

# 마크다운 보고서
curl -H "Authorization: Bearer rn_xxx" "https://<URL>/api/projects/prj_abc/report?format=md&from=2026-09-01"
```

Python:

```python
import requests
S = requests.Session(); S.headers["Authorization"] = "Bearer rn_xxx"
BASE = "https://<URL>"
me = S.get(f"{BASE}/api/me").json()
pid = me["my_projects"][0]["id"]
S.post(f"{BASE}/api/projects/{pid}/entries", json={"title": "실험 3 완료", "content": "## 결과\n- F1 0.83", "stage": "experiment"})
```
