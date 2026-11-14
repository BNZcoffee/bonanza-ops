-- ============================================================================
-- 2순위 [실사 UX 고도화] 상태/최종저장자 표시 · 리마인드 수신자(매니저) 조회 · 시즌 note
-- 선행: closing_typefix.sql 적용 후 실행.
-- ============================================================================
do $$ begin
  if to_regclass('public.closing_inv_status') is null then
    raise exception '선행 실패: closing_inventory_mgmt.sql / closing_typefix.sql 를 먼저 실행하세요';
  end if;
end $$;

-- 1) 최종 저장자/일시 표시용 컬럼 ────────────────────────────────────────────
alter table closing_inv_status add column if not exists last_saver_id   uuid;
alter table closing_inv_status add column if not exists last_saver_name text;
alter table closing_inv_status add column if not exists last_saved_at   timestamptz;

-- 2) 실사 저장/확정 RPC — 최종저장자 기록 추가(재정의) ──────────────────────
create or replace function ch_inv_count_save(p_token text, p_store text, p_ym text, p_rows jsonb) returns jsonb as $$
declare u users; rec jsonb; n int := 0;
begin
  u := ch_user(p_token); if u.id is null or not ch_can_my_store(u, p_store) then raise exception 'ACCESS_DENIED'; end if;
  if ch_is_locked(p_ym) then raise exception 'MONTH_LOCKED'; end if;
  if not _ch_inv_open(p_store, p_ym) then raise exception 'SEASON_CLOSED'; end if;
  for rec in select * from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) loop
    -- 빈칸(null)=미입력, 0=재고0 구분 저장. store,ym,item 기준 UPSERT(중복 누적 방지).
    insert into closing_inventory(store, ym, vendor_slug, item, category, spec, unit, count_qty, status, counted_by, updated_at)
      values (p_store, p_ym, rec->>'vendor_slug', rec->>'item', rec->>'category', rec->>'spec', rec->>'unit',
              nullif(rec->>'count_qty', '')::numeric, 'submitted', u.id, now())
      on conflict (store, ym, vendor_slug, item) do update set count_qty = nullif(rec->>'count_qty','')::numeric,
        category = excluded.category, spec = excluded.spec, unit = excluded.unit, status = 'submitted', counted_by = u.id, updated_at = now();
    n := n + 1;
  end loop;
  insert into closing_inv_status(store, ym, status, submitted_at, last_saver_id, last_saver_name, last_saved_at, updated_at)
    values (p_store, p_ym, 'submitted', now(), u.id, u.name, now(), now())
    on conflict (store, ym) do update set status = case when closing_inv_status.status = 'confirmed' then 'confirmed' else 'submitted' end,
      submitted_at = now(), last_saver_id = u.id, last_saver_name = u.name, last_saved_at = now(), updated_at = now();
  return jsonb_build_object('ok', true, 'rows', n, 'status', 'submitted');
end; $$ language plpgsql security definer;

create or replace function ch_inv_confirm(p_token text, p_store text, p_ym text, p_rows jsonb) returns jsonb as $$
declare u users; rec jsonb; n int := 0;
begin
  u := ch_user(p_token); if u.id is null or not ch_is_priv(u) or not ch_can_my_store(u, p_store) then raise exception 'ACCESS_DENIED'; end if;
  if ch_is_locked(p_ym) then raise exception 'MONTH_LOCKED'; end if;
  for rec in select * from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) loop
    update closing_inventory set
      opening_qty = coalesce(nullif(rec->>'opening_qty', '')::numeric, opening_qty),
      in_qty      = coalesce(nullif(rec->>'in_qty', '')::numeric, in_qty),
      use_qty     = coalesce(nullif(rec->>'use_qty', '')::numeric, use_qty),
      unit_price  = coalesce(nullif(rec->>'unit_price', '')::numeric, unit_price),
      count_qty   = coalesce(nullif(rec->>'count_qty', '')::numeric, count_qty),
      status = 'confirmed', confirmed_by = u.id, updated_at = now()
    where store = p_store and ym = p_ym and vendor_slug = rec->>'vendor_slug' and item = rec->>'item';
    n := n + 1;
  end loop;
  insert into closing_inv_status(store, ym, status, confirmed_at, last_saver_id, last_saver_name, last_saved_at, updated_at)
    values (p_store, p_ym, 'confirmed', now(), u.id, u.name, now(), now())
    on conflict (store, ym) do update set status = 'confirmed', confirmed_at = now(), reject_note = null,
      last_saver_id = u.id, last_saver_name = u.name, last_saved_at = now(), updated_at = now();
  return jsonb_build_object('ok', true, 'rows', n, 'status', 'confirmed');
end; $$ language plpgsql security definer;

-- 3) 리마인드 수신자(매니저) 미리보기 — 본사, 모드별 대상 매장 + 매니저 명단 ───
--    mode: unsubmitted(미확정 전체) / rejected(보완요청) / custom(p_stores)
create or replace function ch_inv_managers(p_token text, p_ym text, p_mode text, p_stores jsonb) returns jsonb as $$
declare u users; tgt text[];
begin
  u := ch_user(p_token); if u.id is null or not ch_is_hq(u) then raise exception 'ACCESS_DENIED'; end if;
  if p_mode = 'custom' then
    select array_agg(value::text) into tgt from jsonb_array_elements_text(coalesce(p_stores,'[]'::jsonb)) value;
  elsif p_mode = 'rejected' then
    select array_agg(store) into tgt from closing_inv_status where ym = p_ym and status = 'rejected';
  else -- unsubmitted = 미확정(confirmed 아님)
    select array_agg(o.name) into tgt from store_options o
      left join closing_inv_status x on x.store = o.name and x.ym = p_ym
      where o.name <> '본사' and not ch_is_pdc(o.name) and coalesce(x.status,'none') <> 'confirmed';
  end if;
  tgt := coalesce(tgt, array[]::text[]);
  return jsonb_build_object('ym', p_ym, 'mode', p_mode, 'stores', (
    select coalesce(jsonb_agg(jsonb_build_object(
      'store', s,
      'status', coalesce((select status from closing_inv_status where store = s and ym = p_ym),'none'),
      'managers', (select coalesce(jsonb_agg(jsonb_build_object('name', name, 'position', position) order by position), '[]'::jsonb)
                   from users where store = s and active and position in ('매니저','매니저B'))
    )), '[]'::jsonb) from unnest(tgt) s));
end; $$ language plpgsql security definer;

-- 4) 매장 관점 시즌/상태 — 최종저장자/제출일시 추가(재정의) ──────────────────
create or replace function ch_inv_season(p_token text, p_store text, p_ym text) returns jsonb as $$
declare u users; s closing_seasons; st closing_inv_status; nowt timestamptz := now(); dplus int := 0; openn boolean;
begin
  u := ch_user(p_token); if u.id is null or not ch_can_my_store(u, p_store) then raise exception 'ACCESS_DENIED'; end if;
  select * into s from closing_seasons where ym = p_ym;
  select * into st from closing_inv_status where store = p_store and ym = p_ym;
  openn := _ch_inv_open(p_store, p_ym);
  if s.inv_end is not null and nowt > s.inv_end then dplus := floor(extract(epoch from (nowt - s.inv_end)) / 86400)::int; end if;
  return jsonb_build_object(
    'ym', p_ym, 'store', p_store,
    'inv_start', s.inv_start, 'inv_end', s.inv_end, 'season_set', s.ym is not null,
    'open', openn, 'locked', ch_is_locked(p_ym),
    'status', coalesce(st.status, 'none'), 'reject_note', st.reject_note,
    'last_saver_name', st.last_saver_name, 'last_saved_at', st.last_saved_at,
    'submitted_at', st.submitted_at, 'confirmed_at', st.confirmed_at,
    'overdue', (s.inv_end is not null and nowt > s.inv_end and coalesce(st.status,'none') <> 'confirmed'),
    'd_plus', dplus,
    'd_minus1', (s.inv_end is not null and nowt <= s.inv_end and (s.inv_end - nowt) <= interval '1 day')
  );
end; $$ language plpgsql security definer;

-- 5) 자동 이상치 감지(본사 반려 모달/검수용) ─────────────────────────────────
create or replace function ch_inv_anomalies(p_token text, p_store text, p_ym text) returns jsonb as $$
declare u users;
begin
  u := ch_user(p_token); if u.id is null or not ch_is_hq(u) then raise exception 'ACCESS_DENIED'; end if;
  return jsonb_build_object(
    'unfilled', (select count(*) from closing_inventory where store = p_store and ym = p_ym and count_qty is null),
    'negative_use', (select coalesce(jsonb_agg(jsonb_build_object('item', item, 'opening', opening_qty, 'in', in_qty, 'count', count_qty)), '[]'::jsonb)
                     from closing_inventory where store = p_store and ym = p_ym and count_qty is not null
                       and coalesce(opening_qty,0) + coalesce(in_qty,0) < count_qty),
    'in_no_count', (select coalesce(jsonb_agg(jsonb_build_object('item', item, 'in', in_qty)), '[]'::jsonb)
                    from closing_inventory where store = p_store and ym = p_ym and coalesce(in_qty,0) > 0 and count_qty = 0),
    'transfers', (select count(*) from closing_transfer where (from_store = p_store or to_store = p_store) and ym = p_ym)
  );
end; $$ language plpgsql security definer;

grant execute on function ch_inv_managers, ch_inv_season, ch_inv_anomalies to anon, authenticated;

notify pgrst, 'reload schema';
-- 완료. 프론트(inventory_helper.js): 상태·최종저장자 표시 / 리마인드 대상선택·수신자 미리보기 /
--   보완요청 textarea+자동 이상치 / 시즌 일자 단순화 / 공지 분리 / 역할별 버튼.
