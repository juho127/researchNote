-- 캡스톤 보고서 회차 가중치 덮어쓰기 JSON {마일스톤id: 퍼센트} (없으면 트랙 기본값: 1차 20 · 2차 30 · 최종 50)
ALTER TABLE categories ADD COLUMN milestone_weight TEXT;
