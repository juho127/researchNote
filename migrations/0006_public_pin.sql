-- 공개 카테고리 · 핀 열람
-- 관리자가 카테고리를 공개(is_public=1)로 두고 핀을 설정하면, 토큰 없이 핀만으로 읽기 전용 열람 세션(24시간)을 발급한다.
ALTER TABLE categories ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0;
ALTER TABLE categories ADD COLUMN pin_hash TEXT;            -- SHA-256(category_id + ':' + pin). NULL 이면 핀 미설정(열람 불가)
ALTER TABLE categories ADD COLUMN pin_updated_at TEXT;      -- 핀 변경 시각 (이전에 발급된 열람 세션은 무효)

-- 핀 입력 후 발급되는 열람 세션 (rnv_ 토큰, 해시만 저장)
CREATE TABLE IF NOT EXISTS viewer_sessions (
  id           TEXT PRIMARY KEY,
  category_id  TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,
  hint         TEXT NOT NULL,
  label        TEXT NOT NULL DEFAULT '',   -- 열람자가 적은 이름/소속 (선택)
  ip           TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_viewer_sessions_category ON viewer_sessions(category_id, expires_at);

-- 핀 무차별 대입 방지: 카테고리+IP 별 실패 횟수와 잠금
CREATE TABLE IF NOT EXISTS pin_attempts (
  category_id  TEXT NOT NULL,
  ip           TEXT NOT NULL,
  fails        INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (category_id, ip)
);
