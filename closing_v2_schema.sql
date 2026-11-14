-- ============================================================================
-- 월말 정산 도우미 v2 — 최종 통합 스키마 + 보안 RPC (1개 파일)
--   전제: closing_security.sql(1차)이 이미 실행됨 → ch_user/ch_is_hq/ch_is_mgr/
--         ch_stores/ch_can_store/ch_access 등 공통 보안 헬퍼가 존재.
--   이 파일은 그 위에 "5대 데이터 방어 + 4대 기능" 테이블/참조데이터/RPC를 추가한다.
--   모두 idempotent(if not exists / create or replace / on conflict).
--   세션/권한/매장접근은 1차와 동일하게 서버에서 강제. PDC 전역 제외.
-- ============================================================================

-- ════════ 공통 보조: 전 직원 매장범위 / 금액열람권한 / 월마감 잠금 ════════
-- 전 직원(팀원/PT 포함) 본인 매장범위 — 재고관리 기능용(HQ=전 매장, 그 외=본인+겸직)
create or replace function ch_my_stores(u users) returns text[] as $$
declare arr text[]; subj jsonb;
begin
  if u.id is null then return '{}'; end if;
  if ch_is_hq(u) then
    select array_agg(distinct store) into arr from users
      where active=true and store is not null and store<>'' and not ch_is_pdc(store);
    return coalesce(arr,'{}');
  end if;
  arr := array[]::text[];
  if u.store is not null and u.store<>'' and not ch_is_pdc(u.store) then arr := array_append(arr,u.store); end if;
  begin subj := to_jsonb(u.sub_stores); exception when others then subj := '[]'::jsonb; end;
  if subj is not null and jsonb_typeof(subj)='array' then
    select array_agg(distinct x) into arr from (
      select unnest(arr) x union select jsonb_array_elements_text(subj)
    ) t where x is not null and x<>'' and not ch_is_pdc(x);
  end if;
  return coalesce(arr,'{}');
end; $$ language plpgsql security definer stable;

create or replace function ch_can_my_store(u users, p_store text) returns boolean as $$
  select p_store = any(ch_my_stores(u));
$$ language sql security definer stable;

-- 금액/원가 열람 권한: 본사관리자 또는 매장관리자(매니저/매니저B)만. 팀원/PT=블라인드
create or replace function ch_is_priv(u users) returns boolean as $$
  select ch_is_hq(u) or ch_is_mgr(u);
$$ language sql security definer stable;

-- ════════ [방어 5] 월마감 최종 잠금 (Snapshot Lock) ════════
create table if not exists closing_locks (
  ym         text primary key,              -- 귀속월 'YYYY-MM' (전사 잠금)
  locked     boolean default false,
  locked_by  uuid,
  locked_at  timestamptz,
  note       text
);
create or replace function ch_is_locked(p_ym text) returns boolean as $$
  select coalesce((select locked from closing_locks where ym=p_ym), false);
$$ language sql security definer stable;

create or replace function ch_lock_status(p_token text, p_ym text) returns jsonb as $$
declare u users;
begin
  u := ch_user(p_token); if u.id is null then raise exception 'ACCESS_DENIED'; end if;
  return jsonb_build_object('ym',p_ym,'locked',ch_is_locked(p_ym),
    'can_manage', ch_is_hq(u));
end; $$ language plpgsql security definer;

create or replace function ch_lock_set(p_token text, p_ym text, p_locked boolean, p_note text) returns jsonb as $$
declare u users;
begin
  u := ch_user(p_token); if u.id is null or not ch_is_hq(u) then raise exception 'ACCESS_DENIED'; end if;
  insert into closing_locks(ym,locked,locked_by,locked_at,note)
    values (p_ym,coalesce(p_locked,true),u.id,now(),p_note)
    on conflict (ym) do update set locked=excluded.locked, locked_by=u.id, locked_at=now(), note=excluded.note;
  return jsonb_build_object('ok',true,'ym',p_ym,'locked',coalesce(p_locked,true));
end; $$ language plpgsql security definer;

-- ════════ [방어 1·2·3] 품목 마스터 / 월별 단가 이력 보강 ════════
-- 품목 마스터: 단일 품목 유지(단가변동 시 행 복제 금지). 규격/단위 명시.
alter table closing_items add column if not exists spec text;          -- 규격(예: 1박스=20줄)
alter table closing_items add column if not exists unit text;          -- 입고/실사 단위(예: 박스/줄/개/g)
-- 월별 단가 이력: 공급가/부가세/합계/과세구분 분리, 수량 소수점
alter table closing_monthly add column if not exists tax_type text;    -- 과세/면세
-- 기존 supply/vat/total 컬럼명을 명시형으로 보강(뷰 호환 위해 컬럼 추가 후 동기화)
alter table closing_monthly add column if not exists supply_amount numeric(14,2);
alter table closing_monthly add column if not exists vat_amount    numeric(14,2);
alter table closing_monthly add column if not exists total_amount  numeric(14,2);
update closing_monthly set supply_amount=coalesce(supply_amount,supply),
  vat_amount=coalesce(vat_amount,vat), total_amount=coalesce(total_amount,total),
  tax_type=coalesce(tax_type, case when coalesce(vat,0)>0 then '과세' else '면세' end)
  where supply_amount is null or vat_amount is null or total_amount is null or tax_type is null;
alter table closing_monthly alter column qty type numeric(14,2);

-- ════════ [방어 1] 발주(업체별) 금액 분리 ════════
alter table closing_orders add column if not exists supply_amount numeric(14,2);
alter table closing_orders add column if not exists vat_amount    numeric(14,2);
alter table closing_orders add column if not exists total_amount  numeric(14,2);
alter table closing_orders add column if not exists tax_type      text;
-- 기존 amount(합계 기준)로 분리열 초기화
update closing_orders set total_amount=coalesce(total_amount,amount) where total_amount is null;

-- ════════ [방어 4] 법인카드 ↔ 매장 매핑 마스터 ════════
create table if not exists store_card_master (
  id         bigint generated always as identity primary key,
  card_last  text not null,                 -- 카드 끝자리/식별(예: '기업 3933')
  store      text not null,
  label      text,                          -- 메모(카드명 등)
  active     boolean default true,
  updated_at timestamptz default now(),
  unique (card_last, store)
);
create index if not exists idx_store_card_last on store_card_master (card_last);

create or replace function ch_cards(p_token text) returns jsonb as $$
declare u users;
begin
  u := ch_user(p_token); if u.id is null then raise exception 'ACCESS_DENIED'; end if;
  -- 매장관리자는 본인 매장 카드만, 본사는 전체
  if ch_is_hq(u) then
    return (select coalesce(jsonb_agg(to_jsonb(c) order by c.store, c.card_last),'[]'::jsonb) from store_card_master c);
  else
    return (select coalesce(jsonb_agg(to_jsonb(c) order by c.card_last),'[]'::jsonb) from store_card_master c where c.store = any(ch_my_stores(u)));
  end if;
end; $$ language plpgsql security definer;

create or replace function ch_card_save(p_token text, p_id bigint, p_card_last text, p_store text, p_label text, p_active boolean) returns jsonb as $$
declare u users;
begin
  u := ch_user(p_token); if u.id is null or not ch_is_hq(u) then raise exception 'ACCESS_DENIED'; end if;
  if p_id is null then
    insert into store_card_master(card_last,store,label,active,updated_at) values (p_card_last,p_store,p_label,coalesce(p_active,true),now())
      on conflict (card_last,store) do update set label=excluded.label, active=excluded.active, updated_at=now();
  else
    update store_card_master set card_last=p_card_last, store=p_store, label=p_label, active=coalesce(p_active,true), updated_at=now() where id=p_id;
  end if;
  return jsonb_build_object('ok',true);
end; $$ language plpgsql security definer;

create or replace function ch_card_del(p_token text, p_id bigint) returns jsonb as $$
declare u users;
begin
  u := ch_user(p_token); if u.id is null or not ch_is_hq(u) then raise exception 'ACCESS_DENIED'; end if;
  delete from store_card_master where id=p_id; return jsonb_build_object('ok',true);
end; $$ language plpgsql security definer;

-- ════════ [기능 3] 법인카드 17개 계정과목 (고정 참조) ════════
create table if not exists closing_accounts (
  code  text primary key,
  name  text not null,
  kind  text not null,                      -- 재고/자산/비용
  sort  int default 0,
  active boolean default true
);
insert into closing_accounts(code,name,kind,sort) values
  ('INV_RAW','원재료','재고',1), ('INV_SUB','부재료','재고',2), ('INV_GOODS','상품','재고',3),
  ('AST_EQUIP','비품/집기','자산',4), ('AST_FURN','인테리어/시설','자산',5),
  ('EXP_SUPPLY','소모품비','비용',6), ('EXP_REPAIR','수선비','비용',7), ('EXP_CLEAN','청소/위생','비용',8),
  ('EXP_UNIFORM','유니폼/피복','비용',9), ('EXP_WELFARE','복리후생','비용',10), ('EXP_MEETING','회의/접대','비용',11),
  ('EXP_TRANSPORT','운반/교통','비용',12), ('EXP_UTIL','수도광열/통신','비용',13), ('EXP_OFFICE','사무용품','비용',14),
  ('EXP_MKT','판촉/마케팅','비용',15), ('EXP_EDU','교육훈련','비용',16), ('EXP_ETC','기타잡비','비용',17)
on conflict (code) do nothing;

create or replace function ch_accounts(p_token text) returns jsonb as $$
declare u users;
begin
  u := ch_user(p_token); if u.id is null then raise exception 'ACCESS_DENIED'; end if;
  return (select coalesce(jsonb_agg(to_jsonb(a) order by a.sort),'[]'::jsonb) from closing_accounts a where a.active);
end; $$ language plpgsql security definer;

-- ════════ [기능 3] 법인카드 거래내역 (배분/계정분류/증빙) ════════
create table if not exists closing_card_tx (
  id            bigint generated always as identity primary key,
  ym            text not null,              -- 귀속월
  store         text,                       -- store_card_master 로 자동 매핑(미매핑시 null)
  card_last     text,
  tx_date       date,
  supply_amount numeric(14,2) default 0,
  vat_amount    numeric(14,2) default 0,
  total_amount  numeric(14,2) default 0,
  tax_type      text,
  account_code  text,                       -- 매장이 선택(17 계정)
  memo          text,                       -- 인원/목적
  status        text default 'pending',     -- pending/classified
  cancelled     boolean default false,      -- 취소 전표 여부
  created_by    uuid, updated_at timestamptz default now(),
  import_key    text                        -- 중복 import 방지 키(옵션)
);
create index if not exists idx_card_tx_store_ym on closing_card_tx (store, ym);
create unique index if not exists uq_card_tx_import on closing_card_tx (import_key) where import_key is not null;

-- 본사: 카드 승인 엑셀 일괄 적재 → store_card_master 로 매장 자동 매핑
create or replace function ch_card_tx_import(p_token text, p_ym text, p_rows jsonb) returns jsonb as $$
declare u users; rec jsonb; st text; n int:=0;
begin
  u := ch_user(p_token); if u.id is null or not ch_is_hq(u) then raise exception 'ACCESS_DENIED'; end if;
  if ch_is_locked(p_ym) then raise exception 'MONTH_LOCKED'; end if;
  for rec in select * from jsonb_array_elements(coalesce(p_rows,'[]'::jsonb)) loop
    select store into st from store_card_master where card_last = rec->>'card_last' and active order by updated_at desc limit 1;
    insert into closing_card_tx(ym,store,card_last,tx_date,supply_amount,vat_amount,total_amount,tax_type,created_by,import_key)
      values (p_ym, st, rec->>'card_last', nullif(rec->>'tx_date','')::date,
        coalesce((rec->>'supply_amount')::numeric,0), coalesce((rec->>'vat_amount')::numeric,0),
        coalesce((rec->>'total_amount')::numeric,0), rec->>'tax_type', u.id, rec->>'import_key')
      on conflict (import_key) where import_key is not null do nothing;
    n := n+1;
  end loop;
  return jsonb_build_object('ok',true,'rows',n);
end; $$ language plpgsql security definer;

-- 매장: 본인 매장 카드내역 조회(블라인드 아님 — 카드는 매장관리자 이상만)
create or replace function ch_card_tx_list(p_token text, p_store text, p_ym text) returns jsonb as $$
declare u users;
begin
  u := ch_user(p_token);
  if u.id is null or not ch_is_priv(u) or not ch_can_my_store(u,p_store) then raise exception 'ACCESS_DENIED'; end if;
  return (select coalesce(jsonb_agg(to_jsonb(t) order by t.tx_date),'[]'::jsonb) from closing_card_tx t where t.store=p_store and t.ym=p_ym);
end; $$ language plpgsql security definer;

create or replace function ch_card_tx_update(p_token text, p_id bigint, p_account text, p_memo text) returns jsonb as $$
declare u users; st text; ym2 text;
begin
  u := ch_user(p_token); if u.id is null or not ch_is_priv(u) then raise exception 'ACCESS_DENIED'; end if;
  select store, ym into st, ym2 from closing_card_tx where id=p_id;
  if not ch_can_my_store(u, st) then raise exception 'ACCESS_DENIED'; end if;
  if ch_is_locked(ym2) then raise exception 'MONTH_LOCKED'; end if;
  update closing_card_tx set account_code=p_account, memo=p_memo, status='classified', updated_at=now() where id=p_id;
  return jsonb_build_object('ok',true);
end; $$ language plpgsql security definer;

-- ════════ [기능 3] 증빙 메타 (파일 본체=Google Drive, DB=링크/메타) ════════
create table if not exists closing_evidence (
  id         bigint generated always as identity primary key,
  ref_type   text not null,                 -- card_tx / inventory / loss / etc
  ref_id     bigint,
  kind       text,                          -- 영수증/거래명세서/견적서
  drive_link text,
  file_name  text,
  meta       jsonb default '{}'::jsonb,      -- {amount,date,ocr,warn:[...]}
  uploaded_by uuid, uploaded_at timestamptz default now()
);
create index if not exists idx_evidence_ref on closing_evidence (ref_type, ref_id);

create or replace function ch_evidence_add(p_token text, p_ref_type text, p_ref_id bigint, p_kind text, p_link text, p_name text, p_meta jsonb) returns jsonb as $$
declare u users;
begin
  u := ch_user(p_token); if u.id is null then raise exception 'ACCESS_DENIED'; end if;
  insert into closing_evidence(ref_type,ref_id,kind,drive_link,file_name,meta,uploaded_by)
    values (p_ref_type,p_ref_id,p_kind,p_link,p_name,coalesce(p_meta,'{}'::jsonb),u.id)
    returning id into p_ref_id;
  return jsonb_build_object('ok',true,'id',p_ref_id);
end; $$ language plpgsql security definer;

create or replace function ch_evidence_list(p_token text, p_ref_type text, p_ref_id bigint) returns jsonb as $$
declare u users;
begin
  u := ch_user(p_token); if u.id is null then raise exception 'ACCESS_DENIED'; end if;
  return (select coalesce(jsonb_agg(to_jsonb(e) order by e.uploaded_at),'[]'::jsonb) from closing_evidence e where e.ref_type=p_ref_type and e.ref_id=p_ref_id);
end; $$ language plpgsql security definer;

-- ════════ [기능 4] 매장 재고 관리 — 폐기(Loss) / 타매장 이관 / 블라인드 실사 ════════
-- 본사 지정 폐기 분류
create table if not exists closing_loss_categories (
  code text primary key, name text not null, sort int default 0, active boolean default true
);
insert into closing_loss_categories(code,name,sort) values
  ('EXPIRE','유통기한 경과',1),('DEFECT','제조 실수/파손',2),('QUALITY','품질 변질',3),('MACHINE','기기 이상',4),('ETC','기타',5)
on conflict (code) do nothing;

-- 폐기 등록
create table if not exists closing_loss (
  id bigint generated always as identity primary key,
  store text not null, ym text not null, loss_date date,
  loss_cat text, vendor_slug text, item text, qty numeric(10,2) default 0,
  is_inventory_item boolean default true,    -- 재고 마스터 품목 여부(아니면 기타/비재고)
  memo text, created_by uuid, created_at timestamptz default now()
);
create index if not exists idx_loss_store_ym on closing_loss (store, ym);

-- 타매장 이관
create table if not exists closing_transfer (
  id bigint generated always as identity primary key,
  ym text not null, tr_date date,
  from_store text not null, to_store text not null,
  vendor_slug text, item text, qty numeric(10,2) default 0,
  created_by uuid, created_at timestamptz default now()
);
create index if not exists idx_transfer_ym on closing_transfer (ym);

-- 월말 실사 재고(품목별, 2단계 승인). 금액은 매니저 확정 시 산정.
create table if not exists closing_inventory (
  id bigint generated always as identity primary key,
  store text not null, ym text not null,
  vendor_slug text, item text not null, category text, spec text, unit text,
  opening_qty numeric(10,2), in_qty numeric(10,2), use_qty numeric(10,2),
  loss_qty numeric(10,2) default 0, transfer_out_qty numeric(10,2) default 0, transfer_in_qty numeric(10,2) default 0,
  count_qty numeric(10,2),                    -- 실사 수량(팀원/매니저 입력)
  unit_price numeric(14,2),                   -- 매니저 확정 시 산정(블라인드엔 숨김)
  status text default 'draft',                -- draft/submitted/confirmed
  counted_by uuid, confirmed_by uuid, updated_at timestamptz default now(),
  unique (store, ym, vendor_slug, item)
);
create index if not exists idx_inv_store_ym on closing_inventory (store, ym);

-- 폐기 등록 RPC (전 직원, 본인 매장, 미잠금)
create or replace function ch_loss_add(p_token text, p_store text, p_ym text, p_date text, p_cat text, p_vendor text, p_item text, p_qty numeric, p_is_inv boolean, p_memo text) returns jsonb as $$
declare u users;
begin
  u := ch_user(p_token); if u.id is null or not ch_can_my_store(u,p_store) then raise exception 'ACCESS_DENIED'; end if;
  if ch_is_locked(p_ym) then raise exception 'MONTH_LOCKED'; end if;
  insert into closing_loss(store,ym,loss_date,loss_cat,vendor_slug,item,qty,is_inventory_item,memo,created_by)
    values (p_store,p_ym,nullif(p_date,'')::date,p_cat,p_vendor,p_item,coalesce(p_qty,0),coalesce(p_is_inv,true),p_memo,u.id);
  return jsonb_build_object('ok',true);
end; $$ language plpgsql security definer;

create or replace function ch_loss_list(p_token text, p_store text, p_ym text) returns jsonb as $$
declare u users;
begin
  u := ch_user(p_token); if u.id is null or not ch_can_my_store(u,p_store) then raise exception 'ACCESS_DENIED'; end if;
  return jsonb_build_object(
    'items', (select coalesce(jsonb_agg(to_jsonb(l) order by l.loss_date),'[]'::jsonb) from closing_loss l where l.store=p_store and l.ym=p_ym),
    'total_qty', coalesce((select sum(qty) from closing_loss where store=p_store and ym=p_ym),0)
  );
end; $$ language plpgsql security definer;

create or replace function ch_loss_del(p_token text, p_id bigint) returns jsonb as $$
declare u users; st text; ym2 text;
begin
  u := ch_user(p_token); if u.id is null then raise exception 'ACCESS_DENIED'; end if;
  select store,ym into st,ym2 from closing_loss where id=p_id;
  if not ch_can_my_store(u,st) then raise exception 'ACCESS_DENIED'; end if;
  if ch_is_locked(ym2) then raise exception 'MONTH_LOCKED'; end if;
  delete from closing_loss where id=p_id; return jsonb_build_object('ok',true);
end; $$ language plpgsql security definer;

-- 이관 등록 (보내는 매장 접근권 필요). 양쪽 매장 입재고 사용량 메모는 조회 시 합성.
create or replace function ch_transfer_add(p_token text, p_from text, p_to text, p_date text, p_vendor text, p_item text, p_qty numeric) returns jsonb as $$
declare u users;
begin
  u := ch_user(p_token); if u.id is null or (not ch_can_my_store(u,p_from) and not ch_can_my_store(u,p_to)) then raise exception 'ACCESS_DENIED'; end if;
  insert into closing_transfer(ym,tr_date,from_store,to_store,vendor_slug,item,qty,created_by)
    values (to_char(coalesce(nullif(p_date,'')::date, current_date),'YYYY-MM'), nullif(p_date,'')::date, p_from,p_to,p_vendor,p_item,coalesce(p_qty,0),u.id);
  return jsonb_build_object('ok',true);
end; $$ language plpgsql security definer;

create or replace function ch_transfer_list(p_token text, p_store text, p_ym text) returns jsonb as $$
declare u users;
begin
  u := ch_user(p_token); if u.id is null or not ch_can_my_store(u,p_store) then raise exception 'ACCESS_DENIED'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('id',id,'date',tr_date,'from_store',from_store,'to_store',to_store,'item',item,'qty',qty,
            'dir', case when from_store=p_store then 'out' else 'in' end) order by tr_date),'[]'::jsonb)
          from closing_transfer where ym=p_ym and (from_store=p_store or to_store=p_store));
end; $$ language plpgsql security definer;

-- [핵심 보안] 실사 입재고 조회 — 팀원/PT 는 금액/단가/매출/원가 전부 null(블라인드)
create or replace function ch_inv_list(p_token text, p_store text, p_ym text) returns jsonb as $$
declare u users; priv boolean;
begin
  u := ch_user(p_token); if u.id is null or not ch_can_my_store(u,p_store) then raise exception 'ACCESS_DENIED'; end if;
  priv := ch_is_priv(u);   -- 매장관리자/본사만 금액 열람
  return jsonb_build_object(
    'store',p_store,'ym',p_ym,'blind', not priv, 'locked', ch_is_locked(p_ym),
    'items', (select coalesce(jsonb_agg(jsonb_build_object(
        'id',id,'category',category,'vendor_slug',vendor_slug,'item',item,'spec',spec,'unit',unit,
        'count_qty',count_qty,'status',status,
        -- 블라인드: 금액 관련 필드 제거
        'opening_qty', case when priv then opening_qty else null end,
        'use_qty', case when priv then use_qty else null end,
        'loss_qty', case when priv then loss_qty else null end,
        'unit_price', case when priv then unit_price else null end,
        'amount', case when priv then (coalesce(count_qty,0)*coalesce(unit_price,0)) else null end
      ) order by category, item),'[]'::jsonb) from closing_inventory where store=p_store and ym=p_ym)
  );
end; $$ language plpgsql security definer;

-- 실사 수량 저장(팀원/PT 포함 전 직원) → status=submitted. 금액/단가 건드리지 않음.
create or replace function ch_inv_count_save(p_token text, p_store text, p_ym text, p_rows jsonb) returns jsonb as $$
declare u users; rec jsonb; n int:=0;
begin
  u := ch_user(p_token); if u.id is null or not ch_can_my_store(u,p_store) then raise exception 'ACCESS_DENIED'; end if;
  if ch_is_locked(p_ym) then raise exception 'MONTH_LOCKED'; end if;
  for rec in select * from jsonb_array_elements(coalesce(p_rows,'[]'::jsonb)) loop
    insert into closing_inventory(store,ym,vendor_slug,item,category,spec,unit,count_qty,status,counted_by,updated_at)
      values (p_store,p_ym, rec->>'vendor_slug', rec->>'item', rec->>'category', rec->>'spec', rec->>'unit',
              nullif(rec->>'count_qty','')::numeric, 'submitted', u.id, now())
      on conflict (store,ym,vendor_slug,item) do update set count_qty=excluded.count_qty, status='submitted', counted_by=u.id, updated_at=now();
    n := n+1;
  end loop;
  return jsonb_build_object('ok',true,'rows',n,'status','submitted');
end; $$ language plpgsql security definer;

-- 매니저/본사 최종 마감 확정(금액·원가 산정 후) → status=confirmed
create or replace function ch_inv_confirm(p_token text, p_store text, p_ym text, p_rows jsonb) returns jsonb as $$
declare u users; rec jsonb; n int:=0;
begin
  u := ch_user(p_token); if u.id is null or not ch_is_priv(u) or not ch_can_my_store(u,p_store) then raise exception 'ACCESS_DENIED'; end if;
  if ch_is_locked(p_ym) then raise exception 'MONTH_LOCKED'; end if;
  for rec in select * from jsonb_array_elements(coalesce(p_rows,'[]'::jsonb)) loop
    update closing_inventory set
      opening_qty=coalesce(nullif(rec->>'opening_qty','')::numeric, opening_qty),
      in_qty=coalesce(nullif(rec->>'in_qty','')::numeric, in_qty),
      use_qty=coalesce(nullif(rec->>'use_qty','')::numeric, use_qty),
      unit_price=coalesce(nullif(rec->>'unit_price','')::numeric, unit_price),
      count_qty=coalesce(nullif(rec->>'count_qty','')::numeric, count_qty),
      status='confirmed', confirmed_by=u.id, updated_at=now()
    where store=p_store and ym=p_ym and vendor_slug=rec->>'vendor_slug' and item=rec->>'item';
    n := n+1;
  end loop;
  return jsonb_build_object('ok',true,'rows',n,'status','confirmed');
end; $$ language plpgsql security definer;

create or replace function ch_loss_cats(p_token text) returns jsonb as $$
  select coalesce(jsonb_agg(to_jsonb(l) order by l.sort),'[]'::jsonb) from closing_loss_categories l where l.active;
$$ language sql security definer;

-- ════════ RLS Deny-All (신규 테이블) + grant ════════
do $$
declare t text;
begin
  foreach t in array array['closing_locks','store_card_master','closing_accounts','closing_card_tx',
    'closing_evidence','closing_loss_categories','closing_loss','closing_transfer','closing_inventory'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('revoke all on table %I from anon, authenticated', t);
  end loop;
end $$;

grant execute on function ch_my_stores, ch_can_my_store, ch_is_priv, ch_is_locked, ch_lock_status, ch_lock_set,
  ch_cards, ch_card_save, ch_card_del, ch_accounts, ch_card_tx_import, ch_card_tx_list, ch_card_tx_update,
  ch_evidence_add, ch_evidence_list, ch_loss_add, ch_loss_list, ch_loss_del, ch_transfer_add, ch_transfer_list,
  ch_inv_list, ch_inv_count_save, ch_inv_confirm, ch_loss_cats to anon, authenticated;

notify pgrst, 'reload schema';
-- 완료. 프론트엔드(closing_helper.js v2)는 이 스키마 위에서 단계별로 배포.
