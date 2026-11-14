-- ============================================================================
-- [긴급] 사용자 ID 컬럼 타입 교정 — bigint → uuid (users.id 실제 타입 = uuid)
--   ch_user 가 반환하는 u.id(uuid)를 _by/user_id 컬럼(bigint)에 넣다 실패하던 것 전수 수정.
--   영향: 취합시즌 저장/월말 실사 저장/폐기·이관/카드 수시등록/푸시 구독 등 모든 쓰기.
--   _by 감사 컬럼은 테스트값을 null 로 비우고 uuid 로 변환(데이터 행 자체는 보존).
-- 선행: 기존 closing_* 스키마가 모두 적용된 상태에서 1회 실행.
-- ============================================================================

-- NOT NULL / PK 인 사용자ID 테이블(테스트 데이터만 존재 → 제거 후 변환)
delete from push_subscriptions;
delete from admin_security_pin;
delete from closing_card_audit_logs;

alter table push_subscriptions      alter column user_id      type uuid using null::uuid;
alter table admin_security_pin       alter column user_id      type uuid using null::uuid;
alter table closing_card_audit_logs  alter column user_id      type uuid using null::uuid;

-- 나머지 _by 감사 컬럼(nullable) — 값만 null 로 비우고 타입 변환(행 보존)
alter table closing_locks       alter column locked_by    type uuid using null::uuid;
alter table closing_orders      alter column updated_by   type uuid using null::uuid;
alter table closing_statements  alter column uploaded_by  type uuid using null::uuid;
alter table closing_card_tx     alter column created_by   type uuid using null::uuid;
alter table closing_evidence    alter column uploaded_by  type uuid using null::uuid;
alter table closing_loss        alter column created_by   type uuid using null::uuid;
alter table closing_transfer    alter column created_by   type uuid using null::uuid;
alter table closing_inventory   alter column counted_by   type uuid using null::uuid;
alter table closing_inventory   alter column confirmed_by type uuid using null::uuid;
alter table store_card_master   alter column created_by   type uuid using null::uuid;
alter table closing_seasons     alter column set_by       type uuid using null::uuid;

notify pgrst, 'reload schema';
-- 완료. 이후 모든 쓰기 RPC 가 u.id(uuid)를 정상 저장합니다. (보안 PIN/푸시는 재설정·재구독 필요)
