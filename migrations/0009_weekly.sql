-- 주차별 보고 (캡스톤 등 주 단위 진행 점검)
-- 카테고리에 1주차 시작일·총 주차·마감 요일을 두고, 기록에 '주간 보고' 표시를 둔다.
-- 주차 계산: 1주차 = [week_start, week_start 이후 첫 마감 요일], 이후 7일 단위. 마감은 해당 요일 자정(APP_TZ).
ALTER TABLE categories ADD COLUMN week_start TEXT;                          -- 1주차 시작일 YYYY-MM-DD (NULL 이면 주차 기능 꺼짐)
ALTER TABLE categories ADD COLUMN week_count INTEGER NOT NULL DEFAULT 15;   -- 총 주차 수
ALTER TABLE categories ADD COLUMN week_due_dow INTEGER NOT NULL DEFAULT 6;  -- 마감 요일 0=일 … 6=토
ALTER TABLE entries ADD COLUMN weekly INTEGER NOT NULL DEFAULT 0;           -- 1 이면 주간 보고
CREATE INDEX IF NOT EXISTS idx_entries_weekly ON entries(project_id, weekly, date);
