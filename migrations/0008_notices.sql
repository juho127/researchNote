-- 공지 (notices)
-- 관리자·리드가 팀(카테고리) 또는 전체를 대상으로 올리는 안내문. 홈·팀 페이지 상단과 MCP(list_notices)로 읽는다.
CREATE TABLE IF NOT EXISTS notices (
  id           TEXT PRIMARY KEY,                 -- ntc_...
  category_id  TEXT REFERENCES categories(id) ON DELETE CASCADE,  -- NULL 이면 전체 공지 (관리자만 작성)
  author_id    TEXT NOT NULL REFERENCES users(id),
  title        TEXT NOT NULL,
  content      TEXT NOT NULL DEFAULT '',         -- 마크다운
  pinned       INTEGER NOT NULL DEFAULT 0,       -- 1 이면 목록 맨 위 + 팀 페이지 상단 띠에 표시
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  archived_at  TEXT                              -- 내리기(소프트 삭제)
);
CREATE INDEX IF NOT EXISTS idx_notices_category ON notices(category_id, archived_at, pinned DESC, created_at DESC);
