-- ============================================================================
-- 2순위 [보완+1순위] 명세서 합산/덮어쓰기 · 품목 꾸러미(동일품목 그룹핑)·평균 공급가
-- 선행: closing_module7.sql 까지 적용 후 실행.
-- ============================================================================
do $$ begin
  if to_regclass('public.inv_item_master') is null or to_regclass('public.closing_inventory') is null then
    raise exception '선행 실패: closing_module7.sql 을 먼저 실행하세요';
  end if;
end $$;

-- ════════════ [보완] 거래명세서 입고 연동 — 합산/덮어쓰기 모드 ════════════
drop function if exists ch_delivery_ingest(text, text, text, jsonb);
create or replace function ch_delivery_ingest(p_token text, p_store text, p_ym text, p_rows jsonb, p_mode text default 'set') returns jsonb as $$
declare u users; rec jsonb; it text; sp text; vn text; ct text; qv numeric; n int := 0; addmode boolean;
begin
  u := ch_user(p_token);
  if u.id is null or not ch_is_priv(u) or not ch_can_my_store(u, p_store) then raise exception 'ACCESS_DENIED'; end if;
  if ch_is_locked(p_ym) then raise exception 'MONTH_LOCKED'; end if;
  addmode := (p_mode = 'add');
  for rec in select * from jsonb_array_elements(coalesce(p_rows,'[]'::jsonb)) loop
    it := coalesce(nullif(rec->>'item',''), nullif(rec->>'raw','')); if it is null then continue; end if;
    sp := nullif(rec->>'spec',''); vn := nullif(rec->>'vendor',''); ct := nullif(rec->>'category','');
    qv := coalesce(nullif(rec->>'qty','')::numeric, 0);
    if coalesce((rec->>'remember')::boolean,false) and ch_is_hq(u) and nullif(rec->>'raw','') is not null then
      insert into inv_item_alias(raw,item,spec,unit,vendor_slug,category,origin,updated_at)
        values (rec->>'raw', it, sp, nullif(rec->>'unit',''), vn, ct, nullif(rec->>'origin',''), now())
        on conflict (raw) do update set item=excluded.item, spec=excluded.spec, vendor_slug=excluded.vendor_slug,
          category=excluded.category, origin=excluded.origin, updated_at=now();
    end if;
    insert into closing_inventory(store, ym, vendor_slug, item, spec, in_qty, status, updated_at)
      values (p_store, p_ym, vn, it, sp, qv, 'submitted', now())
      on conflict (store, ym, vendor_slug, item) do update set
        in_qty = case when addmode then coalesce(closing_inventory.in_qty,0) + qv else qv end,
        spec = coalesce(excluded.spec, closing_inventory.spec), updated_at = now();
    n := n + 1;
  end loop;
  return jsonb_build_object('ok', true, 'rows', n, 'mode', p_mode, 'items', (
    select coalesce(jsonb_agg(jsonb_build_object('vendor_slug',vendor_slug,'item',item,'spec',spec,'in_qty',in_qty,
      'count_qty',count_qty,'unit_price', case when ch_is_priv(u) then unit_price else null end) order by item), '[]'::jsonb)
    from closing_inventory where store = p_store and ym = p_ym));
end; $$ language plpgsql security definer;

-- ════════════ [1순위] 품목 꾸러미 접근 권한(본사 예외권한) ════════════
create table if not exists inv_bundle_access (
  user_id    uuid primary key,
  granted_by uuid,
  created_at timestamptz default now()
);

create or replace function _ch_bundle_ok(u users) returns boolean as $$
  select u.is_master or exists (select 1 from inv_bundle_access a where a.user_id = u.id);
$$ language sql stable;

create or replace function ch_bundle_access_list(p_token text) returns jsonb as $$
declare u users;
begin
  u := ch_user(p_token); if u.id is null or not u.is_master then raise exception 'ACCESS_DENIED'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('user_id', a.user_id, 'name', us.name, 'store', us.store, 'position', us.position) order by us.name), '[]'::jsonb)
    from inv_bundle_access a left join users us on us.id = a.user_id);
end; $$ language plpgsql security definer;

create or replace function ch_bundle_users(p_token text) returns jsonb as $$
declare u users;
begin
  u := ch_user(p_token); if u.id is null or not u.is_master then raise exception 'ACCESS_DENIED'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'store', store, 'position', position) order by name), '[]'::jsonb)
    from users where coalesce(active,true));
end; $$ language plpgsql security definer;

create or replace function ch_bundle_access_set(p_token text, p_user_id uuid, p_grant boolean) returns jsonb as $$
declare u users;
begin
  u := ch_user(p_token); if u.id is null or not u.is_master then raise exception 'ACCESS_DENIED'; end if;
  if p_grant then insert into inv_bundle_access(user_id, granted_by) values (p_user_id, u.id) on conflict (user_id) do nothing;
  else delete from inv_bundle_access where user_id = p_user_id; end if;
  return jsonb_build_object('ok', true);
end; $$ language plpgsql security definer;

-- 내 꾸러미 접근권한 여부
create or replace function ch_bundle_can(p_token text) returns jsonb as $$
declare u users;
begin
  u := ch_user(p_token); if u.id is null then raise exception 'ACCESS_DENIED'; end if;
  return jsonb_build_object('can', _ch_bundle_ok(u), 'is_master', u.is_master);
end; $$ language plpgsql security definer;

-- ════════════ [1순위] 품목 꾸러미 ════════════
create table if not exists inv_bundle (
  id bigint generated always as identity primary key,
  name text, std_item text, std_spec text,
  created_by uuid, created_at timestamptz default now()
);
create table if not exists inv_bundle_member (
  bundle_id bigint references inv_bundle(id) on delete cascade,
  item_id   bigint,
  primary key (bundle_id, item_id)
);
create table if not exists inv_bundle_reject (
  sig text primary key, created_by uuid, created_at timestamptz default now()
);

-- 자동 후보: 사입(purchase) 품목 중 동일 품명·규격이 2개 이상(미묶음·미반려)
create or replace function ch_bundle_candidates(p_token text) returns jsonb as $$
declare u users;
begin
  u := ch_user(p_token); if u.id is null or not _ch_bundle_ok(u) then raise exception 'ACCESS_DENIED'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object(
      'sig', g.item || '|' || coalesce(g.spec,''), 'item', g.item, 'spec', g.spec, 'cnt', g.cnt, 'members', g.members
    ) order by g.item), '[]'::jsonb)
    from (
      select item, spec, count(*) cnt,
        jsonb_agg(jsonb_build_object('id', id, 'vendor', vendor_slug, 'unit_price', unit_price) order by vendor_slug) members
      from inv_item_master
      where status = 'approved' and active and product_type = 'purchase'
        and id not in (select item_id from inv_bundle_member)
      group by item, spec
      having count(*) >= 2
    ) g
    where (g.item || '|' || coalesce(g.spec,'')) not in (select sig from inv_bundle_reject));
end; $$ language plpgsql security definer;

create or replace function ch_bundle_create(p_token text, p_name text, p_std_item text, p_std_spec text, p_member_ids jsonb) returns jsonb as $$
declare u users; bid bigint; mid bigint;
begin
  u := ch_user(p_token); if u.id is null or not _ch_bundle_ok(u) then raise exception 'ACCESS_DENIED'; end if;
  insert into inv_bundle(name, std_item, std_spec, created_by) values (nullif(p_name,''), nullif(p_std_item,''), nullif(p_std_spec,''), u.id) returning id into bid;
  for mid in select value::text::bigint from jsonb_array_elements_text(coalesce(p_member_ids,'[]'::jsonb)) loop
    insert into inv_bundle_member(bundle_id, item_id) values (bid, mid) on conflict do nothing;
  end loop;
  return jsonb_build_object('ok', true, 'id', bid);
end; $$ language plpgsql security definer;

create or replace function ch_bundle_reject(p_token text, p_sig text) returns jsonb as $$
declare u users;
begin
  u := ch_user(p_token); if u.id is null or not _ch_bundle_ok(u) then raise exception 'ACCESS_DENIED'; end if;
  insert into inv_bundle_reject(sig, created_by) values (p_sig, u.id) on conflict (sig) do nothing;
  return jsonb_build_object('ok', true);
end; $$ language plpgsql security definer;

create or replace function ch_bundle_del(p_token text, p_id bigint) returns jsonb as $$
declare u users;
begin
  u := ch_user(p_token); if u.id is null or not _ch_bundle_ok(u) then raise exception 'ACCESS_DENIED'; end if;
  delete from inv_bundle where id = p_id; return jsonb_build_object('ok', true);
end; $$ language plpgsql security definer;

-- 꾸러미 목록 + 거래처별 공급가 + 단순/가중(입고량) 평균
create or replace function ch_bundle_list(p_token text) returns jsonb as $$
declare u users;
begin
  u := ch_user(p_token); if u.id is null or not _ch_bundle_ok(u) then raise exception 'ACCESS_DENIED'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object(
      'id', b.id, 'name', b.name, 'std_item', b.std_item, 'std_spec', b.std_spec,
      'members', (select coalesce(jsonb_agg(jsonb_build_object('item_id', mi.id, 'vendor', mi.vendor_slug, 'item', mi.item,
          'spec', mi.spec, 'unit_price', mi.unit_price,
          'in_qty', (select coalesce(sum(ci.in_qty),0) from closing_inventory ci where ci.item = mi.item)) order by mi.vendor_slug), '[]'::jsonb)
        from inv_bundle_member bm join inv_item_master mi on mi.id = bm.item_id where bm.bundle_id = b.id),
      'simple_avg', (select round(avg(mi.unit_price),2) from inv_bundle_member bm join inv_item_master mi on mi.id = bm.item_id where bm.bundle_id = b.id and mi.unit_price is not null),
      'weighted_avg', (select case when sum(t.w) > 0 then round(sum(t.up*t.w)/sum(t.w),2) else null end from (
          select mi.unit_price up, coalesce((select sum(ci.in_qty) from closing_inventory ci where ci.item = mi.item),0) w
          from inv_bundle_member bm join inv_item_master mi on mi.id = bm.item_id where bm.bundle_id = b.id and mi.unit_price is not null) t)
    ) order by b.created_at desc), '[]'::jsonb) from inv_bundle b);
end; $$ language plpgsql security definer;

-- 수동 묶기용 사입 품목 검색(미묶음)
create or replace function ch_bundle_search(p_token text, p_kw text) returns jsonb as $$
declare u users;
begin
  u := ch_user(p_token); if u.id is null or not _ch_bundle_ok(u) then raise exception 'ACCESS_DENIED'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'vendor', vendor_slug, 'item', item, 'spec', spec, 'unit_price', unit_price) order by item), '[]'::jsonb)
    from inv_item_master
    where status = 'approved' and active and product_type = 'purchase'
      and id not in (select item_id from inv_bundle_member)
      and (p_kw is null or p_kw = '' or item ilike '%'||p_kw||'%')
    limit 40);
end; $$ language plpgsql security definer;

-- RLS Deny + grant
do $$ declare t text;
begin
  foreach t in array array['inv_bundle_access','inv_bundle','inv_bundle_member','inv_bundle_reject'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('revoke all on table %I from anon, authenticated', t);
  end loop;
end $$;

grant execute on function ch_delivery_ingest, ch_bundle_access_list, ch_bundle_users, ch_bundle_access_set,
  ch_bundle_can, ch_bundle_candidates, ch_bundle_create, ch_bundle_reject, ch_bundle_del, ch_bundle_list, ch_bundle_search
  to anon, authenticated;

-- ════════════ 매뉴얼(manual_sections) 권한별 반영 — 중복 시 교체 ════════════
do $$
declare
  rows jsonb := '[
    {"audience":"manager","title":"거래명세서 업로드 · 입고량 합산/덮어쓰기","body":"<p><b>매장 재고 관리 → 월말 실사</b> 상단 [거래명세서 업로드]에서 거래처 명세서(엑셀)를 올리면 품목/수량/단가가 파싱되어 당월 입고량에 자동 반영됩니다. 원본 파일은 저장하지 않습니다.</p><ul><li><b>기존 입고량에 합산 (추가 업로드용)</b>: 한 달에 주간·상/하반기로 명세서를 나눠 여러 번 올릴 때 선택합니다. 같은 품목의 입고량이 더해집니다. (기본값)</li><li><b>기존 입고량 덮어쓰기 (재업로드용)</b>: 잘못 올려 다시 올리는 경우 선택합니다. 같은 품목의 입고량이 새 값으로 교체됩니다.</li><li>슬래시(/)로 묶인 품목/거래처는 자동 분리되며, 본사가 한 번 정리하면 다음부터 학습 적용됩니다.</li></ul>"},
    {"audience":"admin","title":"품목 꾸러미 · 사입 동일품목 평균 공급가","body":"<p><b>매장 재고 관리 → 제출현황</b>(본사) 품목·백데이터 줄의 [품목 꾸러미]에서 관리합니다. 여러 거래처에서 들여오는 동일 원재료(예: 각 거래처의 매일 생크림 1L)를 하나로 묶어 제조원가 기준 단가를 산출합니다. <b>사입 품목만</b> 대상이며 전용 제품은 제외됩니다.</p><ul><li><b>접근 권한</b>: 총괄(본사)은 기본 접근, 그 외 계정은 [접근 권한 관리]에서 본사가 예외 권한을 부여한 경우에만 조회·승인·반려할 수 있습니다. 매장 매니저·일반 직원은 접근할 수 없습니다.</li><li><b>자동 후보 제안</b>: 품명·규격이 같은 2개 이상 거래처 품목을 자동으로 찾아 띄웁니다. [승인(묶기)]하면 표준 꾸러미로 통합되고, [반려]하면 개별 품목으로 분리되며 같은 조합은 다시 제안되지 않습니다.</li><li><b>수동 묶기</b>: 품명으로 검색해 직접 2개 이상 선택해 묶을 수 있습니다.</li><li><b>평균 공급가</b>: 꾸러미 상세에 거래처별 공급가와 전체 <b>단순평균</b> 및 <b>입고량 가중평균</b>이 표시됩니다.</li></ul>"}
  ]'::jsonb;
  r jsonb; nextsort int;
begin
  if to_regclass('public.manual_sections') is not null then
    for r in select * from jsonb_array_elements(rows) loop
      delete from manual_sections where audience = r->>'audience' and title = r->>'title';
      select coalesce(max(sort_order),0)+1 into nextsort from manual_sections where audience = r->>'audience';
      insert into manual_sections(audience, title, body, sort_order) values (r->>'audience', r->>'title', r->>'body', nextsort);
    end loop;
  end if;
end $$;

notify pgrst, 'reload schema';
-- 완료. 프론트: 명세서 합산/덮어쓰기 라디오 + [품목 꾸러미] 본사 UI.
