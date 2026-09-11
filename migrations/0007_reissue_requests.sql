-- 토큰 재발급 요청: 기존 회원이 이름+이메일로 요청 → 관리자 승인 → 본인이 수령 코드로 새 토큰 수령
-- signup_requests 를 재사용한다. kind = 'signup'(신규 가입) | 'reissue'(기존 계정 토큰 재발급, user_id 가 미리 채워짐)
ALTER TABLE signup_requests ADD COLUMN kind TEXT NOT NULL DEFAULT 'signup';
