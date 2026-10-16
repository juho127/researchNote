-- 기록(entry) 이미지 첨부
-- 이미지 본문은 R2(FILES_R2, 없으면 KV FILES) 에 r2_key 로 저장하고, 여기에는 메타만 둔다.
-- 본문 마크다운에서는 ![설명](/files/<id>) 로 참조한다 (/files/:id 는 토큰 또는 서명 URL 로 인증).
CREATE TABLE IF NOT EXISTS attachments (
  id           TEXT PRIMARY KEY,                 -- att_...
  entry_id     TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  uploader_id  TEXT NOT NULL REFERENCES users(id),
  filename     TEXT NOT NULL,
  content_type TEXT NOT NULL,                    -- image/png | image/jpeg | image/webp | image/gif | image/svg+xml
  size         INTEGER NOT NULL DEFAULT 0,
  r2_key       TEXT NOT NULL,
  caption      TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attachments_entry ON attachments(entry_id, created_at);
CREATE INDEX IF NOT EXISTS idx_attachments_project ON attachments(project_id);

-- 배포 단위 설정값 (예: 파일 서명 URL 키 — 첫 사용 시 자동 생성)
CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
