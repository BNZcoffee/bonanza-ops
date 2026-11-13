-- ============================================================================
-- 월말 정산 도우미 (closing_helper) — Supabase 마이그레이션
--  실행 순서: 이 SQL 을 먼저 실행 → index.html / closing_helper.js 배포
--  (프로젝트 규칙: SQL 변경은 항상 코드보다 먼저)
-- ============================================================================

-- 1) 피처플래그 / 권한 설정값 (app_settings 재사용) --------------------------
insert into app_settings (key, value) values
  ('closing_menu_visible', 'false'),       -- 기본 숨김 (총괄에게만 [개발중] 노출)
  ('closing_allowed_parts', '[]'),         -- 허용 부서담당 파트(JSON 배열)
  ('closing_allowed_users', '[]')          -- 예외 허용자 id(JSON 배열)
on conflict (key) do nothing;

-- 2) 발주/매출 테이블 ---------------------------------------------------------
create table if not exists closing_sales (
  store      text not null,
  ym         text not null,                -- 'YYYY-MM'
  net_sales  numeric default 0,            -- 순매출
  updated_at timestamptz default now(),
  primary key (store, ym)
);

create table if not exists closing_orders (
  id           bigint generated always as identity primary key,
  store        text not null,
  ym           text not null,              -- 'YYYY-MM'
  category     text not null,              -- 원재료/부재료/소모품/상품/법인카드/미분류
  vendor       text not null default '(미지정)',
  amount       numeric default 0,
  is_corp_card boolean default false,      -- 법인카드 결제분
  updated_by   bigint,
  updated_at   timestamptz default now(),
  unique (store, ym, category, vendor, is_corp_card)
);
create index if not exists idx_closing_orders_ym    on closing_orders (ym);
create index if not exists idx_closing_orders_store on closing_orders (store, ym);

-- 3) 품목·단가 마스터 ---------------------------------------------------------
create table if not exists closing_items (
  id          bigint generated always as identity primary key,
  name        text not null,
  vendor      text,
  category    text default '미분류',
  unit        text,                        -- 규격/단위
  unit_price  numeric default 0,           -- 최신 단가
  prev_price  numeric,                     -- 직전 단가
  price_date  date,
  classified  boolean default false,       -- 분류 완료 여부(미분류 관리용)
  updated_at  timestamptz default now()
);
create index if not exists idx_closing_items_name   on closing_items (name);
create index if not exists idx_closing_items_vendor on closing_items (vendor);
create index if not exists idx_closing_items_class  on closing_items (classified);

-- 4) 원본 보관 메타 (파일 본체는 Storage, DB 에는 메타만) ---------------------
create table if not exists closing_statements (
  id          bigint generated always as identity primary key,
  ym          text not null,               -- 'YYYY-MM'
  vendor      text not null,               -- 거래처명(=파일명)
  file_path   text not null,               -- Storage 경로 'YYYY-MM/거래처명.xlsx'
  size_bytes  bigint default 0,
  uploaded_by bigint,
  uploaded_at timestamptz default now(),
  unique (ym, vendor)                       -- 동일 파일 덮어쓰기
);
create index if not exists idx_closing_stmt_ym on closing_statements (ym);

-- 5) RLS — 앱이 anon 키로 접근하므로, 기존 다른 테이블과 동일하게 열어두되
--     클라이언트(closing_helper.js)에서 권한 게이팅. (추후 Secure RPC 로 강화 가능)
alter table closing_sales      enable row level security;
alter table closing_orders     enable row level security;
alter table closing_items      enable row level security;
alter table closing_statements enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where tablename='closing_sales' and policyname='closing_sales_all') then
    create policy closing_sales_all on closing_sales for all using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename='closing_orders' and policyname='closing_orders_all') then
    create policy closing_orders_all on closing_orders for all using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename='closing_items' and policyname='closing_items_all') then
    create policy closing_items_all on closing_items for all using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename='closing_statements' and policyname='closing_statements_all') then
    create policy closing_statements_all on closing_statements for all using (true) with check (true);
  end if;
end $$;

-- 6) Storage 버킷 (비공개) + 정책 -------------------------------------------
--    대시보드 > Storage 에서 버킷을 만들어도 되고, 아래 SQL 로 생성해도 됩니다.
insert into storage.buckets (id, name, public)
values ('closing-statements', 'closing-statements', false)
on conflict (id) do nothing;

-- 버킷 객체 정책 (anon 키 접근 허용 — 클라이언트에서 권한 게이팅).
do $$
begin
  if not exists (select 1 from pg_policies where tablename='objects' and policyname='closing_bucket_rw') then
    create policy closing_bucket_rw on storage.objects for all
      using (bucket_id = 'closing-statements')
      with check (bucket_id = 'closing-statements');
  end if;
end $$;

-- 완료. (강화 옵션: 위 using(true) 를 Secure RPC + iv_auth 토큰 검증으로 교체하면
--  interview_comments 와 동일한 서버사이드 보안 수준으로 올릴 수 있습니다.)
