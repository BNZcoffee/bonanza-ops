-- ============================================================================
-- 모듈 A — 매장 재고 관리: 취합 시즌 / 매장별 제출·반려 상태 / 지연(D+N) / 웹푸시 구독
-- 선행(순서): closing_security.sql → closing_v2_schema.sql → closing_cards.sql → (이 파일)
--   · Loss/이관 = 취합 시즌 무관, 최종 잠금(closing_locks) 전까지 상시 (v2 그대로)
--   · 월말 실사(closing_inventory)만 시즌 게이팅 + 미제출/반려 매장 잠금 지연(D+N)
-- ============================================================================

-- 0) 선행 점검 ───────────────────────────────────────────────────────────────
do $$ begin
  if to_regclass('public.closing_inventory') is null or to_regclass('public.closing_locks') is null then
    raise exception '선행 실패: closing_v2_schema.sql 을 먼저 실행하세요 (closing_inventory/closing_locks 없음)';
  end if;
end $$;

-- 1) 취합 시즌(월 전체 공통 1개) ─────────────────────────────────────────────
create table if not exists closing_seasons (
  ym         text primary key,              -- 귀속월 YYYY-MM
  inv_start  timestamptz,                   -- 실사 입력 시작일시
  inv_end    timestamptz,                   -- 실사 입력 마감일시
  note       text,
  set_by     uuid,
  updated_at timestamptz default now()
);

-- 2) 매장별 실사 제출/확정/반려 상태 ────────────────────────────────────────
create table if not exists closing_inv_status (
  store        text not null,
  ym           text not null,
  status       text default 'none',         -- none/submitted/confirmed/rejected
  reject_note  text,
  submitted_at timestamptz,
  confirmed_at timestamptz,
  rejected_at  timestamptz,
  updated_at   timestamptz default now(),
  primary key (store, ym)
);

-- 3) 웹푸시 구독(기기별) ─────────────────────────────────────────────────────
create table if not exists push_subscriptions (
  id         bigint generated always as identity primary key,
  user_id    uuid not null,
  store      text,
  endpoint   text not null unique,
  p256dh     text not null,
  auth       text not null,
  ua         text,
  active     boolean default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists idx_push_user on push_subscriptions (user_id);

-- 4) 실사 입력 활성 판정(내부) ──────────────────────────────────────────────
--    열림 조건: 미잠금 & 상태<>confirmed & (시즌미설정 | 기간내 | 마감후-미확정연장) & 시작전 아님
create or replace function _ch_inv_open(p_store text, p_ym text) returns boolean as $$
declare s closing_seasons; st text; nowt timestamptz := now();
begin
  if ch_is_locked(p_ym) then return false; end if;
  select status into st from closing_inv_status where store = p_store and ym = p_ym;
  if st = 'confirmed' then return false; end if;
  select * into s from closing_seasons where ym = p_ym;
  if s.ym is null then return true; end if;                                   -- 시즌 미설정 → 상시 열림
  if s.inv_start is not null and nowt < s.inv_start then return false; end if; -- 시작 전
  if s.inv_end is null or nowt <= s.inv_end then return true; end if;          -- 기간 내
  return coalesce(st, 'none') <> 'confirmed';                                  -- 마감 후 → 미확정 매장만 연장
end; $$ language plpgsql security definer stable;
revoke all on function _ch_inv_open(text, text) from anon, authenticated;

-- 5) 시즌/상태 조회·설정 RPC ─────────────────────────────────────────────────
create or replace function ch_season_get(p_token text, p_ym text) returns jsonb as $$
declare u users; s closing_seasons;
begin
  u := ch_user(p_token); if u.id is null then raise exception 'ACCESS_DENIED'; end if;
  select * into s from closing_seasons where ym = p_ym;
  return jsonb_build_object('ym', p_ym, 'inv_start', s.inv_start, 'inv_end', s.inv_end, 'note', s.note);
end; $$ language plpgsql security definer;

create or replace function ch_season_set(p_token text, p_ym text, p_start timestamptz, p_end timestamptz, p_note text) returns jsonb as $$
declare u users;
begin
  u := ch_user(p_token); if u.id is null or not ch_is_hq(u) then raise exception 'ACCESS_DENIED'; end if;
  insert into closing_seasons(ym, inv_start, inv_end, note, set_by, updated_at)
    values (p_ym, p_start, p_end, p_note, u.id, now())
    on conflict (ym) do update set inv_start = excluded.inv_start, inv_end = excluded.inv_end, note = excluded.note, set_by = u.id, updated_at = now();
  return jsonb_build_object('ok', true);
end; $$ language plpgsql security definer;

-- 매장 관점 시즌/지연 상태(전 직원, 본인 매장)
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
    'overdue', (s.inv_end is not null and nowt > s.inv_end and coalesce(st.status,'none') <> 'confirmed'),
    'd_plus', dplus,
    'd_minus1', (s.inv_end is not null and nowt <= s.inv_end and (s.inv_end - nowt) <= interval '1 day')
  );
end; $$ language plpgsql security definer;

-- 본사: 전 매장 실사 제출현황(리마인드/반려 대상)
create or replace function ch_inv_status_list(p_token text, p_ym text) returns jsonb as $$
declare u users; s closing_seasons; nowt timestamptz := now(); dplus int := 0;
begin
  u := ch_user(p_token); if u.id is null or not ch_is_hq(u) then raise exception 'ACCESS_DENIED'; end if;
  select * into s from closing_seasons where ym = p_ym;
  if s.inv_end is not null and nowt > s.inv_end then dplus := floor(extract(epoch from (nowt - s.inv_end)) / 86400)::int; end if;
  return jsonb_build_object('ym', p_ym, 'inv_start', s.inv_start, 'inv_end', s.inv_end, 'd_plus', dplus,
    'stores', (select coalesce(jsonb_agg(jsonb_build_object(
        'store', o.name,
        'status', coalesce(x.status, 'none'),
        'reject_note', x.reject_note,
        'submitted_at', x.submitted_at, 'confirmed_at', x.confirmed_at
      ) order by o.sort_order), '[]'::jsonb)
      from store_options o left join closing_inv_status x on x.store = o.name and x.ym = p_ym
      where o.name <> '본사' and not ch_is_pdc(o.name)));
end; $$ language plpgsql security definer;

-- 본사: 매장 반려(보완 필요) → 입력 재오픈
create or replace function ch_inv_reject(p_token text, p_store text, p_ym text, p_note text) returns jsonb as $$
declare u users;
begin
  u := ch_user(p_token); if u.id is null or not ch_is_hq(u) then raise exception 'ACCESS_DENIED'; end if;
  insert into closing_inv_status(store, ym, status, reject_note, rejected_at, updated_at)
    values (p_store, p_ym, 'rejected', p_note, now(), now())
    on conflict (store, ym) do update set status = 'rejected', reject_note = p_note, rejected_at = now(), updated_at = now();
  return jsonb_build_object('ok', true);
end; $$ language plpgsql security definer;

-- 6) 실사 저장/확정 RPC 재정의(시즌 게이팅 + 매장 상태 동기화) ─────────────────
create or replace function ch_inv_count_save(p_token text, p_store text, p_ym text, p_rows jsonb) returns jsonb as $$
declare u users; rec jsonb; n int := 0;
begin
  u := ch_user(p_token); if u.id is null or not ch_can_my_store(u, p_store) then raise exception 'ACCESS_DENIED'; end if;
  if ch_is_locked(p_ym) then raise exception 'MONTH_LOCKED'; end if;
  if not _ch_inv_open(p_store, p_ym) then raise exception 'SEASON_CLOSED'; end if;
  for rec in select * from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) loop
    insert into closing_inventory(store, ym, vendor_slug, item, category, spec, unit, count_qty, status, counted_by, updated_at)
      values (p_store, p_ym, rec->>'vendor_slug', rec->>'item', rec->>'category', rec->>'spec', rec->>'unit',
              nullif(rec->>'count_qty', '')::numeric, 'submitted', u.id, now())
      on conflict (store, ym, vendor_slug, item) do update set count_qty = excluded.count_qty, status = 'submitted', counted_by = u.id, updated_at = now();
    n := n + 1;
  end loop;
  insert into closing_inv_status(store, ym, status, submitted_at, updated_at)
    values (p_store, p_ym, 'submitted', now(), now())
    on conflict (store, ym) do update set status = case when closing_inv_status.status = 'confirmed' then 'confirmed' else 'submitted' end,
      submitted_at = now(), updated_at = now();
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
  insert into closing_inv_status(store, ym, status, confirmed_at, updated_at)
    values (p_store, p_ym, 'confirmed', now(), now())
    on conflict (store, ym) do update set status = 'confirmed', confirmed_at = now(), reject_note = null, updated_at = now();
  return jsonb_build_object('ok', true, 'rows', n, 'status', 'confirmed');
end; $$ language plpgsql security definer;

-- 7) 웹푸시 구독 RPC ─────────────────────────────────────────────────────────
create or replace function ch_push_subscribe(p_token text, p_endpoint text, p_p256dh text, p_auth text, p_ua text) returns jsonb as $$
declare u users;
begin
  u := ch_user(p_token); if u.id is null then raise exception 'ACCESS_DENIED'; end if;
  insert into push_subscriptions(user_id, store, endpoint, p256dh, auth, ua, active, updated_at)
    values (u.id, u.store, p_endpoint, p_p256dh, p_auth, p_ua, true, now())
    on conflict (endpoint) do update set user_id = u.id, store = u.store, p256dh = excluded.p256dh, auth = excluded.auth, ua = excluded.ua, active = true, updated_at = now();
  return jsonb_build_object('ok', true);
end; $$ language plpgsql security definer;

create or replace function ch_push_unsub(p_token text, p_endpoint text) returns jsonb as $$
declare u users;
begin
  u := ch_user(p_token); if u.id is null then raise exception 'ACCESS_DENIED'; end if;
  update push_subscriptions set active = false, updated_at = now() where endpoint = p_endpoint and user_id = u.id;
  return jsonb_build_object('ok', true);
end; $$ language plpgsql security definer;

-- 현재 사용자 기기 구독 여부(배너 노출 판단)
create or replace function ch_push_mine(p_token text) returns jsonb as $$
declare u users;
begin
  u := ch_user(p_token); if u.id is null then raise exception 'ACCESS_DENIED'; end if;
  return jsonb_build_object('count', (select count(*) from push_subscriptions where user_id = u.id and active));
end; $$ language plpgsql security definer;

-- 8) RLS Deny-All + grant ────────────────────────────────────────────────────
do $$ declare t text;
begin
  foreach t in array array['closing_seasons', 'closing_inv_status', 'push_subscriptions'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('revoke all on table %I from anon, authenticated', t);
  end loop;
end $$;

grant execute on function ch_season_get, ch_season_set, ch_inv_season, ch_inv_status_list, ch_inv_reject,
  ch_push_subscribe, ch_push_unsub, ch_push_mine to anon, authenticated;

notify pgrst, 'reload schema';
-- 완료. 프론트(inventory_helper.js) + 웹푸시(sw.js / push-send Edge Function)는 이 스키마 위에서 동작.
