-- ============================================================================
-- 2순위 [수정 4+5] 품목 중복 병합 · 슬래시 파싱 학습사전 · 거래명세서 입고 연동(입고량)
-- 선행: closing_module5.sql 까지 적용 후 실행.
-- ============================================================================
do $$ begin
  if to_regclass('public.inv_item_master') is null then
    raise exception '선행 실패: closing_module5.sql 을 먼저 실행하세요';
  end if;
end $$;

-- ════════════ [4] 품목 마스터 중복 병합 (동일 품명·공급가 1개 대표) ════════════
--   동일 (item, 개당단가) 중복 approved 행은 최소 id 1개만 남기고 정리.
delete from inv_item_master a using inv_item_master b
 where a.status = 'approved' and b.status = 'approved'
   and a.item = b.item and coalesce(a.unit_price,-1) = coalesce(b.unit_price,-1)
   and a.id > b.id;

-- ════════════ [4] 슬래시(/) 파싱 학습 사전 ════════════
--   원본 문자열(raw) ↔ 표준 항목 매핑. 본사가 한 번 매핑하면 다음 업로드부터 자동 적용.
create table if not exists inv_item_alias (
  raw         text primary key,              -- 명세서 원본 문자열(품목/거래처)
  item        text,                          -- 표준 품명
  spec        text,                          -- 규격·기준단위
  unit        text,
  vendor_slug text,                          -- 표준 공급사
  category    text,                          -- 구분(파트)
  origin      text,                          -- 원산지·비고
  updated_at  timestamptz default now()
);

-- 본사: 파싱 규칙(별칭) 직접 저장/수정
create or replace function ch_alias_set(p_token text, p_raw text, p_item text, p_spec text, p_unit text, p_vendor text, p_category text, p_origin text) returns jsonb as $$
declare u users;
begin
  u := ch_user(p_token); if u.id is null or not ch_is_hq(u) then raise exception 'ACCESS_DENIED'; end if;
  if coalesce(p_raw,'') = '' then return jsonb_build_object('ok', false); end if;
  insert into inv_item_alias(raw, item, spec, unit, vendor_slug, category, origin, updated_at)
    values (p_raw, nullif(p_item,''), nullif(p_spec,''), nullif(p_unit,''), nullif(p_vendor,''), nullif(p_category,''), nullif(p_origin,''), now())
    on conflict (raw) do update set item = excluded.item, spec = excluded.spec, unit = excluded.unit,
      vendor_slug = excluded.vendor_slug, category = excluded.category, origin = excluded.origin, updated_at = now();
  return jsonb_build_object('ok', true);
end; $$ language plpgsql security definer;

-- 명세서 raw 문자열 배치 해석(학습된 별칭 반환 → 프론트가 미리 적용)
create or replace function ch_alias_resolve(p_token text, p_raws jsonb) returns jsonb as $$
declare u users;
begin
  u := ch_user(p_token); if u.id is null then raise exception 'ACCESS_DENIED'; end if;
  return (select coalesce(jsonb_object_agg(a.raw, to_jsonb(a)), '{}'::jsonb)
    from inv_item_alias a where a.raw in (select value::text from jsonb_array_elements_text(coalesce(p_raws,'[]'::jsonb))));
end; $$ language plpgsql security definer;

-- ════════════ [5] 거래명세서 입고 연동 (파일 미저장 · 입고량 합산) ════════════
--   p_rows: [{raw,item,spec,unit,vendor,category,origin,qty,unit_price,remember}]
--   매니저/본사만. closing_inventory.in_qty 를 품목별 업로드 수량으로 설정(재업로드 멱등),
--   remember=true 행은 inv_item_alias 에 학습 저장. 미등록 품목은 자동 추가(실사 리스트업).
create or replace function ch_delivery_ingest(p_token text, p_store text, p_ym text, p_rows jsonb) returns jsonb as $$
declare u users; rec jsonb; it text; sp text; vn text; ct text; qv numeric; n int := 0;
begin
  u := ch_user(p_token);
  if u.id is null or not ch_is_priv(u) or not ch_can_my_store(u, p_store) then raise exception 'ACCESS_DENIED'; end if;
  if ch_is_locked(p_ym) then raise exception 'MONTH_LOCKED'; end if;
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
      on conflict (store, ym, vendor_slug, item) do update set in_qty = excluded.in_qty,
        spec = coalesce(excluded.spec, closing_inventory.spec), updated_at = now();
    n := n + 1;
  end loop;
  -- 입고 반영된 당월 품목 목록 반환(프론트가 실사 리스트에 머지)
  return jsonb_build_object('ok', true, 'rows', n, 'items', (
    select coalesce(jsonb_agg(jsonb_build_object('vendor_slug',vendor_slug,'item',item,'spec',spec,'in_qty',in_qty,
      'count_qty',count_qty,'unit_price', case when ch_is_priv(u) then unit_price else null end) order by item), '[]'::jsonb)
    from closing_inventory where store = p_store and ym = p_ym));
end; $$ language plpgsql security definer;

-- RLS Deny + grant
do $$ begin
  execute 'alter table inv_item_alias enable row level security';
  execute 'alter table inv_item_alias force row level security';
  execute 'revoke all on table inv_item_alias from anon, authenticated';
end $$;

-- ch_inv_count_save 재정의 — 입고량(in_qty) 저장 반영 포함
create or replace function ch_inv_count_save(p_token text, p_store text, p_ym text, p_rows jsonb) returns jsonb as $$
declare u users; rec jsonb; n int := 0;
begin
  u := ch_user(p_token); if u.id is null or not ch_can_my_store(u, p_store) then raise exception 'ACCESS_DENIED'; end if;
  if ch_is_locked(p_ym) then raise exception 'MONTH_LOCKED'; end if;
  if not _ch_inv_open(p_store, p_ym) then raise exception 'SEASON_CLOSED'; end if;
  for rec in select * from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) loop
    insert into closing_inventory(store, ym, vendor_slug, item, category, spec, unit, count_qty, in_qty, status, counted_by, updated_at)
      values (p_store, p_ym, rec->>'vendor_slug', rec->>'item', rec->>'category', rec->>'spec', rec->>'unit',
              nullif(rec->>'count_qty', '')::numeric, nullif(rec->>'in_qty','')::numeric, 'submitted', u.id, now())
      on conflict (store, ym, vendor_slug, item) do update set count_qty = nullif(rec->>'count_qty','')::numeric,
        in_qty = coalesce(nullif(rec->>'in_qty','')::numeric, closing_inventory.in_qty),
        category = excluded.category, spec = excluded.spec, unit = excluded.unit, status = 'submitted', counted_by = u.id, updated_at = now();
    n := n + 1;
  end loop;
  insert into closing_inv_status(store, ym, status, submitted_at, last_saver_id, last_saver_name, last_saved_at, updated_at)
    values (p_store, p_ym, 'submitted', now(), u.id, u.name, now(), now())
    on conflict (store, ym) do update set status = case when closing_inv_status.status = 'confirmed' then 'confirmed' else 'submitted' end,
      submitted_at = now(), last_saver_id = u.id, last_saver_name = u.name, last_saved_at = now(), updated_at = now();
  return jsonb_build_object('ok', true, 'rows', n, 'status', 'submitted');
end; $$ language plpgsql security definer;

grant execute on function ch_alias_set, ch_alias_resolve, ch_delivery_ingest, ch_inv_count_save to anon, authenticated;

notify pgrst, 'reload schema';
-- 완료. 프론트: [거래명세서 업로드](매니저/본사·파일 미저장 파싱·슬래시 분리) + 실사 입고량 컬럼 연동.
