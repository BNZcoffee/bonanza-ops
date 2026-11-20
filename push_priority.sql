-- ============================================================================
-- [알림 최우선 수신 필수 설정] push_priority — 직원별 '배터리 제한없음 등 필수설정 완료' 기록
--   안드로이드/갤럭시 배터리 '제한 없음' + 알림 허용 + 테스트 수신 확인 완료 시각 저장.
--   값이 있으면 재접속 시 필수 설정 모달을 다시 띄우지 않음. 본사 [알림 필수설정 현황]에서 조회.
--   민감정보 아님. users 직접접근(anon) 방식과 동일.
-- ============================================================================
alter table users add column if not exists push_priority_verified_at timestamptz;
alter table users add column if not exists push_priority_platform    text;   -- android | ios | pc

-- (참고) 백업 알림 채널 / 문자·알림톡 키는 app_settings 행(upsert)로 저장되므로 별도 컬럼 불필요.
--   키: notify_channel_mode(slack|both|backup), backup_webhook_url,
--       sms_api_key, sms_api_secret, sms_sender, sms_template_code

-- 완료. index.html 보다 먼저 실행하세요.
