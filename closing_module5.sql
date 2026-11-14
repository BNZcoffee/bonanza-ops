-- ============================================================================
-- 2순위 [개선 2+5] 임시저장(자정만료) · 품목 마스터 · 백데이터 일괄업로드 · 신규품목 승인 · 검색
-- 선행: closing_inv_ux.sql 까지 적용 후 실행.
-- ============================================================================
do $$ begin
  if to_regclass('public.closing_inventory') is null or to_regclass('public.vendor_master') is null then
    raise exception '선행 실패: 이전 closing_* SQL 을 먼저 실행하세요';
  end if;
end $$;

-- ════════════ [개선 2] 임시저장 1슬롯 (KST 당일 자정 만료) ════════════
create table if not exists closing_inv_draft (
  store     text not null,
  ym        text not null,
  rows      jsonb default '[]'::jsonb,
  saved_by  uuid,
  saved_at  timestamptz default now(),
  primary key (store, ym)
);

create or replace function ch_inv_draft_save(p_token text, p_store text, p_ym text, p_rows jsonb) returns jsonb as $$
declare u users;
begin
  u := ch_user(p_token); if u.id is null or not ch_can_my_store(u, p_store) then raise exception 'ACCESS_DENIED'; end if;
  insert into closing_inv_draft(store, ym, rows, saved_by, saved_at)
    values (p_store, p_ym, coalesce(p_rows,'[]'::jsonb), u.id, now())
    on conflict (store, ym) do update set rows = excluded.rows, saved_by = u.id, saved_at = now();
  return jsonb_build_object('ok', true, 'saved_at', now());
end; $$ language plpgsql security definer;

-- 조회: 임시저장 시각이 KST 당일이 아니면 만료(삭제) 후 빈 값 반환
create or replace function ch_inv_draft_get(p_token text, p_store text, p_ym text) returns jsonb as $$
declare u users; d closing_inv_draft;
begin
  u := ch_user(p_token); if u.id is null or not ch_can_my_store(u, p_store) then raise exception 'ACCESS_DENIED'; end if;
  select * into d from closing_inv_draft where store = p_store and ym = p_ym;
  if d.store is null then return jsonb_build_object('exists', false); end if;
  if (d.saved_at at time zone 'Asia/Seoul')::date < (now() at time zone 'Asia/Seoul')::date then
    delete from closing_inv_draft where store = p_store and ym = p_ym;
    return jsonb_build_object('exists', false, 'expired', true);
  end if;
  return jsonb_build_object('exists', true, 'rows', d.rows, 'saved_at', d.saved_at);
end; $$ language plpgsql security definer;

create or replace function ch_inv_draft_clear(p_token text, p_store text, p_ym text) returns jsonb as $$
declare u users;
begin
  u := ch_user(p_token); if u.id is null or not ch_can_my_store(u, p_store) then raise exception 'ACCESS_DENIED'; end if;
  delete from closing_inv_draft where store = p_store and ym = p_ym;
  return jsonb_build_object('ok', true);
end; $$ language plpgsql security definer;

-- ════════════ [개선 5] 품목 마스터 ════════════
create table if not exists inv_item_master (
  id             bigint generated always as identity primary key,
  vendor_slug    text,
  category       text,                         -- 구분
  item           text not null,                -- 품목명
  spec           text,                         -- 규격단위(예: 1박스=20줄)
  unit           text,                         -- 단위(줄/개/g)
  pack_price     numeric(14,2),                -- 규격당 단가
  unit_price     numeric(14,2),                -- 개당 단가
  tax_type       text,                         -- 과세/면세
  product_type   text default 'purchase',      -- exclusive(전용) / purchase(사입)
  status         text default 'approved',      -- approved / pending(신규 본사 분류대기)
  requested_by   uuid,
  requested_store text,
  active         boolean default true,
  created_at     timestamptz default now(),
  updated_at     timestamptz default now()
);
create unique index if not exists uq_item_master_appr on inv_item_master (coalesce(vendor_slug,''), item) where status = 'approved';
create index if not exists idx_item_master_item on inv_item_master (item);

-- 승인 품목 목록(전 직원 · 비권한자 단가 블라인드)
create or replace function ch_item_master_list(p_token text, p_vendor text, p_category text) returns jsonb as $$
declare u users; priv boolean;
begin
  u := ch_user(p_token); if u.id is null then raise exception 'ACCESS_DENIED'; end if;
  priv := ch_is_priv(u);
  return (select coalesce(jsonb_agg(jsonb_build_object(
      'id', id, 'vendor_slug', vendor_slug, 'category', category, 'item', item, 'spec', spec, 'unit', unit,
      'pack_price', case when priv then pack_price else null end,
      'unit_price', case when priv then unit_price else null end,
      'tax_type', tax_type, 'product_type', product_type
    ) order by category, item), '[]'::jsonb)
    from inv_item_master
    where status = 'approved' and active
      and (p_vendor is null or p_vendor = '' or vendor_slug = p_vendor)
      and (p_category is null or p_category = '' or category = p_category));
end; $$ language plpgsql security definer;

-- 연관 키워드 검색(품목 추가용)
create or replace function ch_item_search(p_token text, p_kw text) returns jsonb as $$
declare u users; priv boolean;
begin
  u := ch_user(p_token); if u.id is null then raise exception 'ACCESS_DENIED'; end if;
  priv := ch_is_priv(u);
  return (select coalesce(jsonb_agg(jsonb_build_object(
      'id', id, 'vendor_slug', vendor_slug, 'category', category, 'item', item, 'spec', spec, 'unit', unit,
      'pack_price', case when priv then pack_price else null end,
      'unit_price', case when priv then unit_price else null end, 'tax_type', tax_type
    ) order by item), '[]'::jsonb)
    from inv_item_master
    where status = 'approved' and active and (p_kw is null or p_kw = '' or item ilike '%'||p_kw||'%')
    limit 40);
end; $$ language plpgsql security definer;

-- 매장 신규 품목 등록 요청(본사 분류대기)
create or replace function ch_item_request(p_token text, p_store text, p_vendor text, p_category text, p_item text, p_spec text, p_unit text) returns jsonb as $$
declare u users; nid bigint;
begin
  u := ch_user(p_token); if u.id is null or not ch_can_my_store(u, p_store) then raise exception 'ACCESS_DENIED'; end if;
  if coalesce(p_item,'') = '' then raise exception 'NO_ITEM'; end if;
  insert into inv_item_master(vendor_slug, category, item, spec, unit, status, requested_by, requested_store)
    values (nullif(p_vendor,''), nullif(p_category,''), p_item, nullif(p_spec,''), nullif(p_unit,''), 'pending', u.id, p_store)
    returning id into nid;
  return jsonb_build_object('ok', true, 'id', nid);
end; $$ language plpgsql security definer;

-- 본사: 분류대기 목록 / 승인 / 반려 / 직접 등록·수정
create or replace function ch_item_pending(p_token text) returns jsonb as $$
declare u users;
begin
  u := ch_user(p_token); if u.id is null or not ch_is_hq(u) then raise exception 'ACCESS_DENIED'; end if;
  return (select coalesce(jsonb_agg(to_jsonb(m) order by m.created_at desc), '[]'::jsonb) from inv_item_master m where m.status = 'pending');
end; $$ language plpgsql security definer;

create or replace function ch_item_approve(p_token text, p_id bigint, p_vendor text, p_category text, p_item text, p_spec text, p_unit text, p_pack_price numeric, p_unit_price numeric, p_tax text, p_product_type text) returns jsonb as $$
declare u users;
begin
  u := ch_user(p_token); if u.id is null or not ch_is_hq(u) then raise exception 'ACCESS_DENIED'; end if;
  update inv_item_master set vendor_slug = nullif(p_vendor,''), category = nullif(p_category,''),
    item = coalesce(nullif(p_item,''), item), spec = nullif(p_spec,''), unit = nullif(p_unit,''),
    pack_price = p_pack_price, unit_price = p_unit_price, tax_type = nullif(p_tax,''),
    product_type = coalesce(nullif(p_product_type,''),'purchase'), status = 'approved', updated_at = now()
  where id = p_id;
  return jsonb_build_object('ok', true);
end; $$ language plpgsql security definer;

create or replace function ch_item_reject(p_token text, p_id bigint) returns jsonb as $$
declare u users;
begin
  u := ch_user(p_token); if u.id is null or not ch_is_hq(u) then raise exception 'ACCESS_DENIED'; end if;
  delete from inv_item_master where id = p_id and status = 'pending';
  return jsonb_build_object('ok', true);
end; $$ language plpgsql security definer;

create or replace function ch_item_save(p_token text, p_id bigint, p_vendor text, p_category text, p_item text, p_spec text, p_unit text, p_pack_price numeric, p_unit_price numeric, p_tax text, p_product_type text, p_active boolean) returns jsonb as $$
declare u users; nid bigint;
begin
  u := ch_user(p_token); if u.id is null or not ch_is_hq(u) then raise exception 'ACCESS_DENIED'; end if;
  if p_id is null then
    insert into inv_item_master(vendor_slug, category, item, spec, unit, pack_price, unit_price, tax_type, product_type, status, active)
      values (nullif(p_vendor,''), nullif(p_category,''), p_item, nullif(p_spec,''), nullif(p_unit,''), p_pack_price, p_unit_price, nullif(p_tax,''), coalesce(nullif(p_product_type,''),'purchase'), 'approved', coalesce(p_active,true))
      returning id into nid;
  else
    update inv_item_master set vendor_slug = nullif(p_vendor,''), category = nullif(p_category,''), item = coalesce(nullif(p_item,''),item),
      spec = nullif(p_spec,''), unit = nullif(p_unit,''), pack_price = p_pack_price, unit_price = p_unit_price,
      tax_type = nullif(p_tax,''), product_type = coalesce(nullif(p_product_type,''),'purchase'), active = coalesce(p_active,true),
      status = 'approved', updated_at = now()
      where id = p_id returning id into nid;
  end if;
  return jsonb_build_object('ok', true, 'id', nid);
end; $$ language plpgsql security definer;

-- ════════════ [개선 5] 백데이터 일괄 업로드(본사) ════════════
--   p_items: 품목 마스터 [{vendor,category,item,spec,unit,pack_price,unit_price,tax_type,product_type}]
--   p_stock: 매장별 직전월 기말재고 [{store,item,spec,qty}] (p_ym 의 전월에 적재 → 당월 자동채움)
create or replace function ch_backdata_upload(p_token text, p_ym text, p_items jsonb, p_stock jsonb) returns jsonb as $$
declare u users; rec jsonb; prev_ym text; v_slug text; ni int := 0; nv int := 0; ns int := 0;
begin
  u := ch_user(p_token); if u.id is null or not ch_is_hq(u) then raise exception 'ACCESS_DENIED'; end if;
  prev_ym := to_char((to_date(p_ym||'-01','YYYY-MM-DD') - interval '1 month'), 'YYYY-MM');

  for rec in select * from jsonb_array_elements(coalesce(p_items,'[]'::jsonb)) loop
    v_slug := nullif(trim(rec->>'vendor'), '');
    if v_slug is not null and not exists (select 1 from vendor_master vm where vm.slug = v_slug) then
      insert into vendor_master(slug, canonical, active) values (v_slug, v_slug, true) on conflict (slug) do nothing;
      nv := nv + 1;
    end if;
    insert into inv_item_master(vendor_slug, category, item, spec, unit, pack_price, unit_price, tax_type, product_type, status)
      values (v_slug, nullif(rec->>'category',''), rec->>'item', nullif(rec->>'spec',''), nullif(rec->>'unit',''),
              nullif(rec->>'pack_price','')::numeric, nullif(rec->>'unit_price','')::numeric, nullif(rec->>'tax_type',''),
              coalesce(nullif(rec->>'product_type',''),'purchase'), 'approved')
      on conflict (coalesce(vendor_slug,''), item) where status = 'approved'
      do update set category = excluded.category, spec = excluded.spec, unit = excluded.unit,
        pack_price = excluded.pack_price, unit_price = excluded.unit_price, tax_type = excluded.tax_type,
        product_type = excluded.product_type, updated_at = now();
    ni := ni + 1;
  end loop;

  for rec in select * from jsonb_array_elements(coalesce(p_stock,'[]'::jsonb)) loop
    insert into closing_inventory(store, ym, vendor_slug, item, spec, count_qty, status, updated_at)
      values (rec->>'store', prev_ym, nullif(rec->>'vendor',''), rec->>'item', nullif(rec->>'spec',''),
              nullif(rec->>'qty','')::numeric, 'confirmed', now())
      on conflict (store, ym, vendor_slug, item) do update set count_qty = excluded.count_qty, spec = excluded.spec, updated_at = now();
    ns := ns + 1;
  end loop;
  return jsonb_build_object('ok', true, 'items', ni, 'vendors_new', nv, 'stock', ns, 'prev_ym', prev_ym);
end; $$ language plpgsql security definer;

-- RLS Deny + grant
do $$ declare t text;
begin
  foreach t in array array['closing_inv_draft','inv_item_master'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('revoke all on table %I from anon, authenticated', t);
  end loop;
end $$;

grant execute on function ch_inv_draft_save, ch_inv_draft_get, ch_inv_draft_clear,
  ch_item_master_list, ch_item_search, ch_item_request, ch_item_pending, ch_item_approve, ch_item_reject,
  ch_item_save, ch_backdata_upload to anon, authenticated;

notify pgrst, 'reload schema';
-- 완료. 프론트: 임시저장(자동/수동/로그아웃훅) · 실사 드롭박스 통제 · 필터/검색 · 신규품목요청 ·
--   본사 품목마스터/분류대기 승인 · 백데이터 양식/업로드.
