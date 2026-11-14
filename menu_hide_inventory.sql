-- 매장 재고 관리 메뉴 — 개발·검수 중 기본 숨김(비노출) 등록
-- 관리 > 앱 관리 > 메뉴 숨김 관리에서 총괄이 체크 해제하면 매장 직원에게 노출됨.
-- (총괄/부총괄/admin 은 숨김 상태에서도 '숨김' 뱃지와 함께 항상 접근 가능 — 검수용)
insert into feature_flags (feature_key, enabled, updated_at) values
  ('inventory', false, now()),
  ('sec_inventory', false, now())
on conflict (feature_key) do nothing;
