-- ============================================================================
-- 월말 정산 도우미 — 보안 격상 (RLS Deny-All + Secure RPC) + 신규 테이블
--   실행 순서(중요):
--     (1) 이 파일 전체 실행 → 테이블/RPC 생성 (closing_* 는 생성 시점부터 RLS Deny)
--     (2) closing_helper_seed.sql 실행 (RPC/SECURITY DEFINER 로 적재되므로 Deny 상태여도 OK)
--   세션: 기존 app_sessions(token,user_id) 토큰을 p_token 으로 전달(getSessionToken()).
--   권한: 본사관리자 = is_master/is_vice_master OR (role='dept' & part ∈ closing_allowed_parts)
--                      OR id ∈ closing_allowed_users.  매장관리자 = position 매니저/매니저B.
--   매장 접근: 본사관리자=전 매장(PDC 제외), 매니저=본인 소속+겸직(sub_stores)만. 서버에서 강제.
-- ============================================================================

-- ── 0) 신규/보강 테이블 ─────────────────────────────────────────────────────
create table if not exists vendor_master (
  slug       text primary key,
  canonical  text,
  aliases    jsonb default '[]'::jsonb,   -- 유사 표기 묶음(정식명/byVendor 키 등). 본사 관리자만 수정
  active     boolean default true,
  updated_at timestamptz default now()
);

-- 분류 마스터(품목 단가는 closing_monthly 에서 합계/수량으로 계산 → 여기엔 단가 저장 안 함)
drop table if exists closing_items cascade;
create table closing_items (
  id          bigint generated always as identity primary key,
  vendor_slug text not null,
  name        text not null,
  category    text default '미분류',       -- 원재료/부재료/소모품/상품/미분류
  source      text,                         -- 기본/추가/수정/이관 시 분류/PC 파일 보충
  updated_at  timestamptz default now(),
  unique (vendor_slug, name)
);
create index if not exists idx_closing_items_name on closing_items (name);

-- 월별 거래처 품목 단가 이력 (전 매장 합산). 단가 = total/qty (부가세 포함, 반올림)
create table if not exists closing_monthly (
  id          bigint generated always as identity primary key,
  vendor_slug text not null,
  ym          text not null,               -- 'YYYY-MM'
  item        text not null,
  qty         numeric default 0,
  supply      numeric default 0,           -- 공급가액
  vat         numeric default 0,           -- 부가세
  total       numeric default 0,           -- 합계
  unique (vendor_slug, ym, item)
);
create index if not exists idx_closing_monthly_item on closing_monthly (item);
create index if not exists idx_closing_monthly_v_ym on closing_monthly (vendor_slug, ym);

-- 발주/매출 테이블(기존). 없으면 생성, 있으면 재고 컬럼 보강.
create table if not exists closing_sales (
  store text not null, ym text not null, net_sales numeric default 0,
  updated_at timestamptz default now(), primary key (store, ym)
);
alter table closing_sales add column if not exists opening_stock numeric;  -- 기초재고(선택)
alter table closing_sales add column if not exists closing_stock numeric;  -- 기말재고(선택)

create table if not exists closing_orders (
  id bigint generated always as identity primary key,
  store text not null, ym text not null, category text not null,
  vendor text not null default '(미지정)', amount numeric default 0,
  is_corp_card boolean default false, updated_by bigint, updated_at timestamptz default now(),
  unique (store, ym, category, vendor, is_corp_card)
);
create index if not exists idx_closing_orders_store on closing_orders (store, ym);

create table if not exists closing_statements (
  id bigint generated always as identity primary key,
  ym text not null, vendor text not null, file_path text not null,
  size_bytes bigint default 0, uploaded_by bigint, uploaded_at timestamptz default now(),
  unique (ym, vendor)
);

-- ── 1) 공통 보안 헬퍼 (SECURITY DEFINER) ────────────────────────────────────
-- 토큰 → users 행
create or replace function ch_user(p_token text) returns users as $$
  select u.* from users u
  join app_sessions s on s.user_id = u.id
  where s.token::text = p_token and coalesce(u.active,true) = true
  limit 1;
$$ language sql security definer stable;

-- PDC 사내카페 판별(유사 표기 포함)
create or replace function ch_is_pdc(p_store text) returns boolean as $$
  select coalesce(p_store,'') in ('PDC사내카페','PDC 사내카페','사내카페','PDC');
$$ language sql immutable;

-- 본사 관리자 여부
create or replace function ch_is_hq(u users) returns boolean as $$
declare parts jsonb; usersj jsonb;
begin
  if u.id is null then return false; end if;
  if coalesce(u.is_master,false) or coalesce(u.is_vice_master,false) then return true; end if;
  select value::jsonb into parts from app_settings where key='closing_allowed_parts';
  select value::jsonb into usersj from app_settings where key='closing_allowed_users';
  if u.role='dept' and parts is not null and parts ? coalesce(u.part,'') then return true; end if;
  if usersj is not null and usersj ? (u.id::text) then return true; end if;
  return false;
end; $$ language plpgsql security definer stable;

-- 매장 관리자 여부
create or replace function ch_is_mgr(u users) returns boolean as $$
  select coalesce(u.position,'') in ('매니저','매니저B');
$$ language sql immutable;

-- 접근 가능 매장 목록(PDC 제외). 본사=전 매장, 매니저=본인+겸직
create or replace function ch_stores(u users) returns text[] as $$
declare arr text[];
begin
  if ch_is_hq(u) then
    select array_agg(distinct store) into arr from users
      where active = true and store is not null and store <> '' and not ch_is_pdc(store);
    return coalesce(arr,'{}');
  elsif ch_is_mgr(u) then
    declare subj jsonb;
    begin
      arr := array[]::text[];
      if u.store is not null and u.store <> '' and not ch_is_pdc(u.store) then arr := array_append(arr, u.store); end if;
      -- sub_stores 가 jsonb/json/text[] 어떤 형태여도 안전하게 배열로 변환
      begin subj := to_jsonb(u.sub_stores); exception when others then subj := '[]'::jsonb; end;
      if subj is not null and jsonb_typeof(subj) = 'array' then
        select array_agg(distinct x) into arr from (
          select unnest(arr) as x
          union
          select jsonb_array_elements_text(subj)
        ) t where x is not null and x <> '' and not ch_is_pdc(x);
      end if;
      return coalesce(arr,'{}');
    end;
  end if;
  return '{}';
end; $$ language plpgsql security definer stable;

create or replace function ch_can_store(u users, p_store text) returns boolean as $$
  select p_store = any(ch_stores(u));
$$ language sql security definer stable;

-- ── 2) 접근 컨텍스트 ────────────────────────────────────────────────────────
create or replace function ch_access(p_token text) returns jsonb as $$
declare u users; r text;
begin
  u := ch_user(p_token);
  if u.id is null then return jsonb_build_object('role','none','stores','[]'::jsonb); end if;
  if ch_is_hq(u) then r:='hq'; elsif ch_is_mgr(u) then r:='manager'; else r:='none'; end if;
  return jsonb_build_object(
    'role', r,
    'stores', to_jsonb(ch_stores(u)),
    'canManageVendors', ch_is_hq(u),
    'name', u.name
  );
end; $$ language plpgsql security definer stable;

-- ── 3) 발주/매출 조회·저장 (매장 접근 서버 강제) ────────────────────────────
create or replace function ch_order_get(p_token text, p_store text, p_ym text) returns jsonb as $$
declare u users; s record; o jsonb;
begin
  u := ch_user(p_token);
  if u.id is null or not ch_can_store(u, p_store) then raise exception 'ACCESS_DENIED'; end if;
  select net_sales, opening_stock, closing_stock into s from closing_sales where store=p_store and ym=p_ym;
  select coalesce(jsonb_agg(jsonb_build_object('category',category,'vendor',vendor,'amount',amount,'is_corp_card',is_corp_card) order by category, vendor),'[]'::jsonb)
    into o from closing_orders where store=p_store and ym=p_ym;
  return jsonb_build_object('store',p_store,'ym',p_ym,
    'net_sales',coalesce(s.net_sales,0),'opening_stock',s.opening_stock,'closing_stock',s.closing_stock,'orders',o);
end; $$ language plpgsql security definer;

create or replace function ch_order_save(p_token text, p_store text, p_ym text, p_net_sales numeric,
  p_opening numeric, p_closing numeric, p_rows jsonb) returns jsonb as $$
declare u users; rec jsonb; n int := 0;
begin
  u := ch_user(p_token);
  if u.id is null or not ch_can_store(u, p_store) then raise exception 'ACCESS_DENIED'; end if;
  insert into closing_sales(store,ym,net_sales,opening_stock,closing_stock,updated_at)
    values (p_store,p_ym,coalesce(p_net_sales,0),p_opening,p_closing,now())
    on conflict (store,ym) do update set net_sales=excluded.net_sales,
      opening_stock=excluded.opening_stock, closing_stock=excluded.closing_stock, updated_at=now();
  delete from closing_orders where store=p_store and ym=p_ym;
  for rec in select * from jsonb_array_elements(coalesce(p_rows,'[]'::jsonb)) loop
    if coalesce((rec->>'amount')::numeric,0) <> 0 then
      insert into closing_orders(store,ym,category,vendor,amount,is_corp_card,updated_by,updated_at)
        values (p_store,p_ym, rec->>'category', coalesce(nullif(rec->>'vendor',''),'(미지정)'),
                (rec->>'amount')::numeric, coalesce((rec->>'is_corp_card')::boolean,false), u.id, now());
      n := n + 1;
    end if;
  end loop;
  return jsonb_build_object('ok',true,'rows',n);
end; $$ language plpgsql security definer;

-- 전 매장 요약(접근 가능 매장만). 본사=전 매장, 매니저=본인 매장들
create or replace function ch_summary(p_token text, p_ym text) returns jsonb as $$
declare u users; sts text[];
begin
  u := ch_user(p_token);
  if u.id is null then raise exception 'ACCESS_DENIED'; end if;
  sts := ch_stores(u);
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'store', st,
      'net_sales', coalesce((select net_sales from closing_sales where store=st and ym=p_ym),0),
      'order_total', coalesce((select sum(amount) from closing_orders where store=st and ym=p_ym),0)
    ) order by st),'[]'::jsonb)
    from unnest(sts) st
  );
end; $$ language plpgsql security definer;

-- 연도별 1~12월 매트릭스 (매장 접근 강제)
create or replace function ch_annual(p_token text, p_store text, p_year text) returns jsonb as $$
declare u users;
begin
  u := ch_user(p_token);
  if u.id is null or not ch_can_store(u, p_store) then raise exception 'ACCESS_DENIED'; end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'ym', ym,
      'net_sales', coalesce((select net_sales from closing_sales s where s.store=p_store and s.ym=ym),0),
      'opening_stock', (select opening_stock from closing_sales s where s.store=p_store and s.ym=ym),
      'closing_stock', (select closing_stock from closing_sales s where s.store=p_store and s.ym=ym),
      'order_total', coalesce((select sum(amount) from closing_orders o where o.store=p_store and o.ym=ym),0),
      'by_cat', coalesce((select jsonb_object_agg(category, catsum) from
                   (select category, sum(amount) catsum from closing_orders o where o.store=p_store and o.ym=ym group by category) q),'{}'::jsonb)
    ) order by ym),'[]'::jsonb)
    from (select p_year||'-'||lpad(g::text,2,'0') as ym from generate_series(1,12) g) months
  );
end; $$ language plpgsql security definer;

-- 월 상세: 업체별 드릴다운(한 매장/월/분야)
create or replace function ch_order_drill(p_token text, p_store text, p_ym text, p_cat text) returns jsonb as $$
declare u users;
begin
  u := ch_user(p_token);
  if u.id is null or not ch_can_store(u, p_store) then raise exception 'ACCESS_DENIED'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('vendor',vendor,'amount',amount,'is_corp_card',is_corp_card) order by amount desc),'[]'::jsonb)
          from closing_orders where store=p_store and ym=p_ym and category=p_cat);
end; $$ language plpgsql security definer;

-- ── 4) 품목·단가 마스터 / 월별 단가 (읽기=접근자 전원, 쓰기=본사) ────────────
create or replace function ch_items(p_token text, p_q text, p_unclassified boolean) returns jsonb as $$
declare u users;
begin
  u := ch_user(p_token);
  if u.id is null then raise exception 'ACCESS_DENIED'; end if;
  return (select coalesce(jsonb_agg(to_jsonb(t) order by t.name),'[]'::jsonb) from (
    select ci.id, ci.vendor_slug, ci.name, ci.category, ci.source,
      (select total/nullif(qty,0) from closing_monthly m where m.vendor_slug=ci.vendor_slug and m.item=ci.name order by ym desc limit 1) as unit_price
    from closing_items ci
    where (p_q is null or p_q='' or ci.name ilike '%'||p_q||'%' or ci.vendor_slug ilike '%'||p_q||'%')
      and (not coalesce(p_unclassified,false) or ci.category='미분류')
    order by ci.name limit 300) t);
end; $$ language plpgsql security definer;

create or replace function ch_item_setcat(p_token text, p_id bigint, p_cat text) returns jsonb as $$
declare u users;
begin
  u := ch_user(p_token);
  if u.id is null or not ch_is_hq(u) then raise exception 'ACCESS_DENIED'; end if;
  update closing_items set category=p_cat, source=coalesce(source,'수정'), updated_at=now() where id=p_id;
  return jsonb_build_object('ok',true);
end; $$ language plpgsql security definer;

-- 품목 최신/직전 단가
create or replace function ch_item_price(p_token text, p_vendor text, p_item text) returns jsonb as $$
declare u users;
begin
  u := ch_user(p_token);
  if u.id is null then raise exception 'ACCESS_DENIED'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('ym',ym,'unit', round(total/nullif(qty,0)),'qty',qty,'total',total) order by ym desc),'[]'::jsonb)
          from closing_monthly where vendor_slug=p_vendor and item=p_item);
end; $$ language plpgsql security definer;

-- ── 5) 거래처 마스터 (읽기=접근자, 쓰기=본사) ───────────────────────────────
create or replace function ch_vendors(p_token text) returns jsonb as $$
declare u users;
begin
  u := ch_user(p_token);
  if u.id is null then raise exception 'ACCESS_DENIED'; end if;
  return (select coalesce(jsonb_agg(to_jsonb(v) order by v.slug),'[]'::jsonb) from vendor_master v);
end; $$ language plpgsql security definer;

create or replace function ch_vendor_save(p_token text, p_slug text, p_canonical text, p_aliases jsonb, p_active boolean) returns jsonb as $$
declare u users;
begin
  u := ch_user(p_token);
  if u.id is null or not ch_is_hq(u) then raise exception 'ACCESS_DENIED'; end if;
  insert into vendor_master(slug,canonical,aliases,active,updated_at)
    values (p_slug,p_canonical,coalesce(p_aliases,'[]'::jsonb),coalesce(p_active,true),now())
    on conflict (slug) do update set canonical=excluded.canonical, aliases=excluded.aliases, active=excluded.active, updated_at=now();
  return jsonb_build_object('ok',true);
end; $$ language plpgsql security definer;

-- ── 6) 원본 보관함 메타 (본사 전용 — 거래명세서는 전 매장 집계라 매장 범위 없음) ──
create or replace function ch_statements(p_token text, p_ym text) returns jsonb as $$
declare u users;
begin
  u := ch_user(p_token);
  if u.id is null or not ch_is_hq(u) then raise exception 'ACCESS_DENIED'; end if;
  return (select coalesce(jsonb_agg(to_jsonb(cs) order by cs.vendor),'[]'::jsonb) from closing_statements cs where cs.ym=p_ym);
end; $$ language plpgsql security definer;

create or replace function ch_statement_upsert(p_token text, p_ym text, p_vendor text, p_path text, p_size bigint) returns jsonb as $$
declare u users;
begin
  u := ch_user(p_token);
  if u.id is null or not ch_is_hq(u) then raise exception 'ACCESS_DENIED'; end if;
  insert into closing_statements(ym,vendor,file_path,size_bytes,uploaded_by,uploaded_at)
    values (p_ym,p_vendor,p_path,coalesce(p_size,0),u.id,now())
    on conflict (ym,vendor) do update set file_path=excluded.file_path, size_bytes=excluded.size_bytes, uploaded_by=excluded.uploaded_by, uploaded_at=now();
  return jsonb_build_object('ok',true);
end; $$ language plpgsql security definer;

create or replace function ch_statement_del(p_token text, p_id bigint) returns jsonb as $$
declare u users;
begin
  u := ch_user(p_token);
  if u.id is null or not ch_is_hq(u) then raise exception 'ACCESS_DENIED'; end if;
  delete from closing_statements where id=p_id;
  return jsonb_build_object('ok',true);
end; $$ language plpgsql security definer;

create or replace function ch_cleanup_old(p_token text, p_cut_ym text) returns jsonb as $$
declare u users; cnt int;
begin
  u := ch_user(p_token);
  if u.id is null or not ch_is_hq(u) then raise exception 'ACCESS_DENIED'; end if;
  with del as (delete from closing_statements where ym < p_cut_ym returning *) select count(*) into cnt from del;
  return jsonb_build_object('ok',true,'deleted',cnt);
end; $$ language plpgsql security definer;

-- 월별 품목 적재(본사) — 거래명세서 업로드 시 단가 이력 반영
create or replace function ch_monthly_upsert(p_token text, p_vendor text, p_ym text, p_rows jsonb) returns jsonb as $$
declare u users; rec jsonb; n int := 0;
begin
  u := ch_user(p_token);
  if u.id is null or not ch_is_hq(u) then raise exception 'ACCESS_DENIED'; end if;
  for rec in select * from jsonb_array_elements(coalesce(p_rows,'[]'::jsonb)) loop
    insert into closing_monthly(vendor_slug,ym,item,qty,supply,vat,total)
      values (p_vendor,p_ym, rec->>'item', coalesce((rec->>'qty')::numeric,0), coalesce((rec->>'supply')::numeric,0),
              coalesce((rec->>'vat')::numeric,0), coalesce((rec->>'total')::numeric,0))
      on conflict (vendor_slug,ym,item) do update set qty=excluded.qty, supply=excluded.supply, vat=excluded.vat, total=excluded.total;
    -- 신규 품목이면 미분류로 등록
    insert into closing_items(vendor_slug,name,category,source) values (p_vendor, rec->>'item','미분류','업로드')
      on conflict (vendor_slug,name) do nothing;
    n := n + 1;
  end loop;
  return jsonb_build_object('ok',true,'rows',n);
end; $$ language plpgsql security definer;

-- 거래처 전체 분류맵 {품목명:구분} (Tab1 카테고리 집계용, 제한 없음)
create or replace function ch_classify(p_token text, p_vendor text) returns jsonb as $$
declare u users;
begin
  u := ch_user(p_token);
  if u.id is null then raise exception 'ACCESS_DENIED'; end if;
  return coalesce((select jsonb_object_agg(name, category) from closing_items where vendor_slug=p_vendor),'{}'::jsonb);
end; $$ language plpgsql security definer;

grant execute on function ch_access, ch_order_get, ch_order_save, ch_summary, ch_annual, ch_order_drill,
  ch_items, ch_item_setcat, ch_item_price, ch_vendors, ch_vendor_save, ch_statements, ch_statement_upsert,
  ch_statement_del, ch_cleanup_old, ch_monthly_upsert, ch_classify to anon, authenticated;

-- ── 7) RLS Deny-All (가장 마지막) — RPC(SECURITY DEFINER)로만 접근 ───────────
--   anon/authenticated 직접 sb.from('closing_*') 전면 차단. 함수는 definer 권한으로 우회.
do $$
declare t text;
begin
  foreach t in array array['closing_items','closing_monthly','closing_sales','closing_orders','closing_statements','vendor_master'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('revoke all on table %I from anon, authenticated', t);
    -- 기존 열람 정책(이전 closing_helper.sql 의 using(true))이 있으면 제거
    execute format('drop policy if exists %I on %I', t||'_all', t);
  end loop;
end $$;

-- 스토리지 버킷: 직접 접근 차단(원본은 본사만, verify_password + 메타 RPC 경유).
--   기존 개방 정책 제거. 업/다운로드는 service가 아닌 RPC 메타 + 서명 URL 흐름으로 제한 권장.
do $$
begin
  if exists (select 1 from pg_policies where tablename='objects' and policyname='closing_bucket_rw') then
    drop policy closing_bucket_rw on storage.objects;
  end if;
end $$;

notify pgrst, 'reload schema';
-- 완료. 다음: closing_helper_seed.sql 실행.
