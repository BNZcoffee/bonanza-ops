-- ============================================================================
-- 2순위 [1단계] 거래처 관리 — vendor_master 확장 + CRUD RPC + 매장별 필터
-- 선행: closing_security → v2 → cards → inventory_mgmt → module_c → (이 파일)
-- ============================================================================
do $$ begin
  if to_regclass('public.vendor_master') is null then
    raise exception '선행 실패: closing_security.sql 을 먼저 실행하세요 (vendor_master 없음)';
  end if;
end $$;

-- 1) vendor_master 컬럼 확장 ─────────────────────────────────────────────────
alter table vendor_master add column if not exists biz_no        text;   -- 사업자등록번호
alter table vendor_master add column if not exists biz_file      text;   -- 사업자등록증 파일(Storage 경로)
alter table vendor_master add column if not exists settle_bank   text;   -- 매출 정산 은행명
alter table vendor_master add column if not exists settle_acct   text;   -- 매출 정산 계좌번호
alter table vendor_master add column if not exists bankbook_file text;   -- 통장사본 파일(Storage 경로)
alter table vendor_master add column if not exists mgr_name      text;   -- 담당자 이름
alter table vendor_master add column if not exists mgr_phone     text;   -- 담당자 연락처
alter table vendor_master add column if not exists mgr_email     text;   -- 담당자 이메일
alter table vendor_master add column if not exists settle_day    text;   -- 정산 시점(예: 10 / 25 / 말일)
alter table vendor_master add column if not exists scope         text default 'common'; -- common(전사공통) / store(매장지정)
alter table vendor_master add column if not exists scope_stores  jsonb default '[]'::jsonb; -- 지정 매장 목록
alter table vendor_master add column if not exists tax_type      text;   -- 기본 과세구분(과세/면세)
alter table vendor_master add column if not exists memo          text;
alter table vendor_master add column if not exists is_purchase   boolean default false; -- 사입(공용) 제품 거래처 여부(꾸러미 대상 판별 보조)

-- 2) 거래처 전체 저장(본사) ──────────────────────────────────────────────────
create or replace function ch_vendor_save_full(p_token text, p_slug text, p_canonical text, p_aliases jsonb,
  p_biz_no text, p_biz_file text, p_settle_bank text, p_settle_acct text, p_bankbook_file text,
  p_mgr_name text, p_mgr_phone text, p_mgr_email text, p_settle_day text, p_scope text, p_scope_stores jsonb,
  p_tax_type text, p_memo text, p_active boolean) returns jsonb as $$
declare u users;
begin
  u := ch_user(p_token); if u.id is null or not ch_is_hq(u) then raise exception 'ACCESS_DENIED'; end if;
  insert into vendor_master(slug,canonical,aliases,biz_no,biz_file,settle_bank,settle_acct,bankbook_file,
      mgr_name,mgr_phone,mgr_email,settle_day,scope,scope_stores,tax_type,memo,active,updated_at)
    values (p_slug,p_canonical,coalesce(p_aliases,'[]'::jsonb),p_biz_no,p_biz_file,p_settle_bank,p_settle_acct,p_bankbook_file,
      p_mgr_name,p_mgr_phone,p_mgr_email,p_settle_day,coalesce(p_scope,'common'),coalesce(p_scope_stores,'[]'::jsonb),
      p_tax_type,p_memo,coalesce(p_active,true),now())
    on conflict (slug) do update set canonical=excluded.canonical, aliases=excluded.aliases, biz_no=excluded.biz_no,
      biz_file=coalesce(excluded.biz_file, vendor_master.biz_file), settle_bank=excluded.settle_bank,
      settle_acct=excluded.settle_acct, bankbook_file=coalesce(excluded.bankbook_file, vendor_master.bankbook_file),
      mgr_name=excluded.mgr_name, mgr_phone=excluded.mgr_phone, mgr_email=excluded.mgr_email,
      settle_day=excluded.settle_day, scope=excluded.scope, scope_stores=excluded.scope_stores,
      tax_type=excluded.tax_type, memo=excluded.memo, active=excluded.active, updated_at=now();
  return jsonb_build_object('ok',true);
end; $$ language plpgsql security definer;

create or replace function ch_vendor_del(p_token text, p_slug text) returns jsonb as $$
declare u users;
begin
  u := ch_user(p_token); if u.id is null or not ch_is_hq(u) then raise exception 'ACCESS_DENIED'; end if;
  delete from vendor_master where slug = p_slug; return jsonb_build_object('ok',true);
end; $$ language plpgsql security definer;

-- 3) 매장용 거래처 필터(전사공통 + 해당 매장 지정만) ────────────────────────
create or replace function ch_vendors_for_store(p_token text, p_store text) returns jsonb as $$
declare u users;
begin
  u := ch_user(p_token); if u.id is null or not ch_can_my_store(u, p_store) then raise exception 'ACCESS_DENIED'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('slug',slug,'canonical',canonical,'tax_type',tax_type) order by canonical),'[]'::jsonb)
    from vendor_master where active and (coalesce(scope,'common')='common' or scope_stores ? p_store));
end; $$ language plpgsql security definer;

grant execute on function ch_vendor_save_full, ch_vendor_del, ch_vendors_for_store to anon, authenticated;

notify pgrst, 'reload schema';
-- 완료. 프론트: closing_helper.js [거래처] 탭(본사). 파일첨부=closing-statements 버킷 vendor/ 경로.
