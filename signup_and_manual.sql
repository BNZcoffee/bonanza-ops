-- ============================================================================
-- [가입 인증 수단 + 매뉴얼 업데이트] signup_and_manual.sql
--   1) 비로그인 회원가입 화면에서 app_settings(가입 인증 수단)를 안전하게 읽는 공개 RPC
--   2) 사용 설명서(User) '안드로이드 배터리 제한없음 필수' 섹션 추가
--   3) 신규 입사자 빠른 시작 가이드(app_configs)에 배터리 안내 1줄 append
--   index.html 보다 먼저 실행하세요. (idempotent — 여러 번 실행해도 중복/손상 없음)
-- ============================================================================

-- 1) 가입 인증 수단 공개 조회 RPC (비로그인 anon 호출 허용, 민감정보 없음)
create or replace function get_signup_auth()
returns table(method text, email_template text)
language sql
security definer
stable
as $$
  select
    coalesce((select value from app_settings where key = 'signup_auth_method'), 'slack') as method,
    coalesce((select value from app_settings where key = 'signup_email_template'),
             '보난자 운영앱 가입 인증번호는 [{인증번호}] 입니다. (10분 이내 입력)')          as email_template;
$$;
grant execute on function get_signup_auth() to anon, authenticated;

-- 2) 사용 설명서(User 카테고리) — 안드로이드 배터리 제한없음 필수 섹션 (없을 때만 추가)
insert into manual_sections (audience, title, body, sort_order)
select 'user',
       '모바일 알림 필수 설정 (안드로이드)',
       '안드로이드/갤럭시 사용자는 배터리 설정을 ''제한 없음''으로 변경해야 현장 공지와 마감 알림을 지연 없이 받습니다.' || chr(10)
       || '홈 화면에 설치한 보난자커피 앱 아이콘을 길게 누른 뒤 ⓘ(앱 정보) → 배터리 → ''제한 없음''을 선택하세요.' || chr(10)
       || '''최적화됨'' 상태에서는 백그라운드 알림이 차단될 수 있습니다.' || chr(10)
       || '로그인 후 뜨는 ''알림 최우선 수신 필수 설정'' 안내를 끝까지 완료해야 앱 사용이 시작됩니다.' || chr(10)
       || '아이폰/PC는 배터리 설정 없이 ''알림 허용''만 완료하면 됩니다.',
       coalesce((select max(sort_order) + 1 from manual_sections where audience = 'user'), 100)
where not exists (
  select 1 from manual_sections where audience = 'user' and title = '모바일 알림 필수 설정 (안드로이드)'
);

-- 3) 신규 입사자 빠른 시작 가이드(app_configs.quick_start_guide)에 배터리 안내 append (중복 방지)
update app_configs
set value = value || '<div style="margin-top:10px;padding:10px 12px;background:#FFF7ED;border:1px solid #FED7AA;border-radius:8px;font-size:12px;line-height:1.7"><b>📱 안드로이드/갤럭시 필수</b><br>배터리 설정을 <b>제한 없음</b>으로 바꿔야 공지 알림을 놓치지 않습니다. 앱 아이콘 길게 누르기 → ⓘ 앱 정보 → 배터리 → 제한 없음. (아이폰/PC는 알림 허용만 필수)</div>',
    updated_at = now()
where key = 'quick_start_guide'
  and value is not null
  and value not like '%배터리%제한%없음%'
  and value not like '%배터리 설정을 <b>제한 없음</b>%';

-- 완료.
