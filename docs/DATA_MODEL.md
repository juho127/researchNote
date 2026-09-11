# 데이터 모델 (D1 / SQLite)

스키마: [`migrations/0001_init.sql`](../migrations/0001_init.sql)

```
categories 1 ──< memberships >── 1 users 1 ──< tokens
     │                              │
     └──< projects >────────────────┘ (owner)
            │
            ├──< project_stages (6행 고정: planning … review)
            ├──< entries ──< comments
            ├──< tasks
            └──< activity (감사 로그, project/category 참조)
```

| 테이블 | 핵심 컬럼 | 비고 |
|---|---|---|
| `categories` | `id`(slug), `name` UNIQUE, `description`, `track` paper\|capstone, `join_policy` open\|approval\|closed, `is_public`, `pin_hash`(SHA-256(id:pin)), `pin_updated_at`, `archived_at` | 연구 그룹/팀. 트랙이 단계·루브릭을 결정. 보관 시 구성원 접근 차단. 공개+핀이면 핀 열람 가능 |
| `viewer_sessions` | `category_id`, `token_hash`(rnv_ 토큰 해시), `hint`, `label`, `ip`, `expires_at`(24h), `last_used_at` | 핀 열람 세션(읽기 전용). 핀 변경·공개 해제·보관 시 삭제 |
| `pin_attempts` | (`category_id`,`ip`) PK, `fails`, `locked_until` | 핀 무차별 대입 방지 (5회 → 10분 잠금) |
| `project_collaborators` | (`project_id`,`user_id`) PK | 담당자와 같은 편집 권한 (캡스톤 팀원·공저자) |
| `evaluations` | `project_id`, `stage`, `evaluator_id`, `title`, `scores`(JSON {축: 점수}), `total`, `feedback`(md), `response`(md), `response_by`, `visible` | 마일스톤별 평가자 채점·피드백 + 팀 답변. 평가자 여러 명 가능 |
| `join_requests` | `user_id`, `category_id`, `message`, `status` pending\|approved\|rejected\|cancelled | 로비 가입 요청 |
| `signup_requests` | `name`, `email`, `category_id`, `status`, `claim_hash`, `user_id`, `claimed_at` | 공개 토큰 발급 신청 |
| `users` | `id`(slug), `name`, `email`, `role` admin\|member, `disabled_at`, `last_seen_at` | 전역 역할은 admin/member 두 가지 |
| `memberships` | (`user_id`,`category_id`) PK, `role` lead\|member\|evaluator | 카테고리별 역할. 평가자는 열람·코멘트·평가만 |
| `tokens` | `token_hash` SHA-256 UNIQUE, `hint` `rn_abcd…wxyz`, `label`, `last_used_at`, `revoked_at` | 평문 미저장. 한 사용자가 여러 토큰 가능 |
| `projects` | `category_id`, `owner_id`, `title`, `summary`, `stage`(현재 단계), `status` active\|paused\|done\|archived, `target_venue`, `deadline`, `tags`(쉼표) | |
| `project_stages` | (`project_id`,`stage`) PK, `status` todo\|doing\|done, `summary`(md), `updated_by` | 프로젝트 생성 시 6행 생성 (`ensureStageRows`) |
| `entries` | `project_id`, `author_id`, `date`(연구일), `stage`, `title`, `content`(md ≤200KB), `source` web\|mcp\|api, `review_status` none\|requested\|changes_requested\|approved | 날짜별 기록 |
| `comments` | `entry_id`, `author_id`, `content`, `kind` comment\|approve\|request_changes | 승인/수정요청 코멘트는 entries.review_status 도 갱신 |
| `tasks` | `project_id`, `title`, `status` todo\|doing\|done, `assignee_id`, `due`, `stage`, `done_at` | |
| `activity` | `at`, `actor_id`, `category_id`, `project_id`, `action`, `target_id`, `summary`, `source` | 피드·관리자 로그·활동 추이 |

## 활동 action 목록

`project.create|update|archive`, `entry.create|update|delete`, `stage.update|advance`, `comment.create`, `review.request|approve|changes|clear`, `task.create|update|delete`, `category.create|update`, `user.create|update`, `membership.set|remove`, `token.issue|revoke`, `signup.request|approve|reject|claim`, `team.join|join_request|join_approve|join_reject|leave`, `evaluation.create|update|delete|respond`, `viewer.login`

## ID 규칙

- 카테고리·사용자: 이름에서 slug (한글 유지, 공백→`-`), 충돌 시 4자 접미
- 프로젝트 `prj_` · 기록 `ent_` · 코멘트 `cmt_` · 할 일 `tsk_` · 토큰 `tok_` + 12자 랜덤

## 시각·날짜

- `created_at` 등은 UTC ISO. `entries.date`, `deadline`, `due` 는 `YYYY-MM-DD` (연구자 로컬 날짜). 기본 "오늘" 은 `APP_TZ`(기본 Asia/Seoul) 기준.

## 스키마 변경

`migrations/000N_xxx.sql` 을 추가하고 `npm run migrate:remote` (로컬은 `migrate:local`). wrangler 가 적용 이력을 `d1_migrations` 테이블로 관리합니다.

## 백업

```bash
npx wrangler d1 export DB --remote --output backup.sql
```
