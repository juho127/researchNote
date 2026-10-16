-- 계정당 첨부 용량 한도 (bytes). NULL 이면 기본값(코드 DEFAULT_ACCOUNT_QUOTA_BYTES = 10 MB, 또는 ATTACHMENT_QUOTA_MB 변수).
-- 사용량은 attachments.size 를 uploader_id 기준으로 합산한다.
ALTER TABLE users ADD COLUMN attachment_quota_bytes INTEGER;
CREATE INDEX IF NOT EXISTS idx_attachments_uploader ON attachments(uploader_id);
