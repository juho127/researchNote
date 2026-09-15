-- 보고서 제출 (마일스톤별 PDF, 버전 누적) · 카테고리별 마감 덮어쓰기 · 평가-제출물 연결
-- 파일 본문은 KV(FILES) 에 storage_key 로 저장하고, 여기에는 메타만 둔다.
CREATE TABLE IF NOT EXISTS submissions (
  id           TEXT PRIMARY KEY,                 -- sub_...
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  milestone    TEXT NOT NULL,                    -- 트랙 reports 의 id (캡스톤: report1 | report2 | final)
  version      INTEGER NOT NULL DEFAULT 1,       -- 같은 마일스톤 재제출 시 +1
  filename     TEXT NOT NULL,
  size         INTEGER NOT NULL DEFAULT 0,
  content_type TEXT NOT NULL DEFAULT 'application/pdf',
  storage_key  TEXT NOT NULL,
  note         TEXT NOT NULL DEFAULT '',         -- 제출 메모
  late         INTEGER NOT NULL DEFAULT 0,       -- 마감 이후 제출
  submitted_by TEXT NOT NULL REFERENCES users(id),
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sub_project ON submissions(project_id, milestone, version);

-- 카테고리별 마감 덮어쓰기: JSON {milestone_id: "YYYY-MM-DD"} (그날 자정 APP_TZ). NULL 이면 주차 설정의 N주차 마감일을 쓴다.
ALTER TABLE categories ADD COLUMN milestone_due TEXT;

-- 제출물 평가: submission_id 로 연결, milestone 은 조회 편의용 복사본
ALTER TABLE evaluations ADD COLUMN submission_id TEXT REFERENCES submissions(id) ON DELETE SET NULL;
ALTER TABLE evaluations ADD COLUMN milestone TEXT;
CREATE INDEX IF NOT EXISTS idx_eval_submission ON evaluations(submission_id);
CREATE INDEX IF NOT EXISTS idx_eval_milestone ON evaluations(project_id, milestone);
