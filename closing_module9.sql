-- ============================================================================
-- 2순위 월말 거래처 정산·이체 리스트 + 단가 변동(인상·인하) 대시보드
-- 선행: closing_module8.sql 까지 적용 후 실행.
-- ============================================================================
do $$ begin
  if to_regclass('public.vendor_master') is null or to_regclass('public.inv_item_master') is null
     or to_regclass('public.closing_inventory') is null then
    raise exception '선행 실패: closing_module8.sql 까지 먼저 실행하세요';
  end if;
end $$;

-- ════════════ [2-2] 단가 변동 이력 ════════════
--   기준단가(inv_item_master.unit_price) 대비 변동 감지 로그.
--   명세서 업로드(source=명세서)=미반영(pending), 마스터 직접 수정(source=마스터수정)=반영완료(resolved).
create table if not exists inv_price_change (
  id          bigint generated always as identity primary key,
  item_id     bigint,                 -- inv_item_master.id (있으면)
  vendor_slug text,
  item        text not null,
  spec        text,
  category    text,
  base_price  numeric(14,2),          -- 직전 기준단가
  new_price   numeric(14,2),          -- 감지된 변경 단가
  source      text,                   -- '명세서' / '마스터수정'
  store       text,
  ym          text,
  created_by  uuid,
  created_at  timestamptz default now(),
  resolved    boolean default false,  -- 기준단가 반영 여부
  resolved_by uuid,
  resolved_at timestamptz
);
create index if not exists idx_price_change_pending on inv_price_change (resolved, item);

-- 변동 기록 헬퍼: base(기준) 와 new(신규) 가 모두 있고 서로 다를 때만 기록.
--   미반영(pending) 기록은 같은 품목·거래처당 1건만 유지(최신값으로 갱신).
create or replace function _ch_price_log(p_item_id bigint, p_vendor text, p_item text, p_spec text, p_cat text,
    p_base numeric, p_new numeric, p_source text, p_store text, p_ym text, p_by uuid, p_resolved boolean) returns void as $$
begin
  if p_new is null or p_base is null or p_new = p_base then return; end if;
  if not p_resolved then
    delete from inv_price_change
      where resolved = false and item = p_item and coalesce(vendor_slug,'') = coalesce(p_vendor,'');
  end if;
  insert into inv_price_change(item_id, vendor_slug, item, spec, category, base_price, new_price, source,
      store, ym, created_by, resolved, resolved_by, resolved_at)
    values (p_item_id, nullif(p_vendor,''), p_item, nullif(p_spec,''), nullif(p_cat,''), p_base, p_new, p_source,
      nullif(p_store,''), nullif(p_ym,''), p_by, coalesce(p_resolved,false),
      case when p_resolved then p_by else null end, case when p_resolved then now() else null end);
end; $$ language plpgsql security definer;

-- ════════════ [2-2] 거래명세서 입고 — 합산/덮어쓰기 + 단가 변동 감지 ════════════
--   module8 의 ch_delivery_ingest 를 재정의(in_qty 합산/덮어쓰기 로직 유지 + 명세서 단가 변동 로그 추가).
drop function if exists ch_delivery_ingest(text, text, text, jsonb, text);
create or replace function ch_delivery_ingest(p_token text, p_store text, p_ym text, p_rows jsonb, p_mode text default 'set') returns jsonb as $$
declare u users; rec jsonb; it text; sp text; vn text; ct text; qv numeric; up numeric; bp numeric; mid bigint; n int := 0; addmode boolean;
begin
  u := ch_user(p_token);
  if u.id is null or not ch_is_priv(u) or not ch_can_my_store(u, p_store) then raise exception 'ACCESS_DENIED'; end if;
  if ch_is_locked(p_ym) then raise exception 'MONTH_LOCKED'; end if;
  addmode := (p_mode = 'add');
  for rec in select * from jsonb_array_elements(coalesce(p_rows,'[]'::jsonb)) loop
    it := coalesce(nullif(rec->>'item',''), nullif(rec->>'raw','')); if it is null then continue; end if;
    sp := nullif(rec->>'spec',''); vn := nullif(rec->>'vendor',''); ct := nullif(rec->>'category','');
    qv := coalesce(nullif(rec->>'qty','')::numeric, 0);
    up := nullif(rec->>'unit_price','')::numeric;
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
    -- 단가 변동 감지: 명세서 단가 vs 기준단가(마스터)
    if up is not null then
      select mi.id, mi.unit_price into mid, bp from inv_item_master mi
        where mi.item = it and coalesce(mi.vendor_slug,'') = coalesce(vn,'') and mi.status = 'approved'
        order by mi.id limit 1;
      if bp is not null and up <> bp then
        perform _ch_price_log(mid, vn, it, sp, ct, bp, up, '명세서', p_store, p_ym, u.id, false);
      end if;
    end if;
    n := n + 1;
  end loop;
  return jsonb_build_object('ok', true, 'rows', n, 'mode', p_mode, 'items', (
    select coalesce(jsonb_agg(jsonb_build_object('vendor_slug',vendor_slug,'item',item,'spec',spec,'in_qty',in_qty,
      'count_qty',count_qty,'unit_price', case when ch_is_priv(u) then unit_price else null end) order by item), '[]'::jsonb)
    from closing_inventory where store = p_store and ym = p_ym));
end; $$ language plpgsql security definer;

-- ════════════ [2-2] 품목 마스터 저장 — 단가 수정 시 변동 로그(반영완료) ════════════
--   module5 의 ch_item_save 재정의(기존 로직 유지 + 단가 변경 로그).
create or replace function ch_item_save(p_token text, p_id bigint, p_vendor text, p_category text, p_item text, p_spec text, p_unit text, p_pack_price numeric, p_unit_price numeric, p_tax text, p_product_type text, p_active boolean) returns jsonb as $$
declare u users; nid bigint; old_price numeric;
begin
  u := ch_user(p_token); if u.id is null or not ch_is_hq(u) then raise exception 'ACCESS_DENIED'; end if;
  if p_id is null then
    insert into inv_item_master(vendor_slug, category, item, spec, unit, pack_price, unit_price, tax_type, product_type, status, active)
      values (nullif(p_vendor,''), nullif(p_category,''), p_item, nullif(p_spec,''), nullif(p_unit,''), p_pack_price, p_unit_price, nullif(p_tax,''), coalesce(nullif(p_product_type,''),'purchase'), 'approved', coalesce(p_active,true))
      returning id into nid;
  else
    select unit_price into old_price from inv_item_master where id = p_id;
    update inv_item_master set vendor_slug = nullif(p_vendor,''), category = nullif(p_category,''), item = coalesce(nullif(p_item,''),item),
      spec = nullif(p_spec,''), unit = nullif(p_unit,''), pack_price = p_pack_price, unit_price = p_unit_price,
      tax_type = nullif(p_tax,''), product_type = coalesce(nullif(p_product_type,''),'purchase'), active = coalesce(p_active,true),
      status = 'approved', updated_at = now()
      where id = p_id returning id into nid;
    if old_price is not null and p_unit_price is not null and p_unit_price <> old_price then
      perform _ch_price_log(nid, nullif(p_vendor,''), coalesce(nullif(p_item,''), p_item), nullif(p_spec,''), nullif(p_category,''),
        old_price, p_unit_price, '마스터수정', null, null, u.id, true);
    end if;
  end if;
  return jsonb_build_object('ok', true, 'id', nid);
end; $$ language plpgsql security definer;

-- 단가 변동 대시보드: 매니저(본인 매장 취급 품목) / 본사(전사)
--   pending=미반영(명세서), recent=최근 30일 반영완료 이력
create or replace function ch_price_changes(p_token text) returns jsonb as $$
declare u users; mystores text[];
begin
  u := ch_user(p_token); if u.id is null or not ch_is_priv(u) then raise exception 'ACCESS_DENIED'; end if;
  if ch_is_hq(u) then mystores := null; else mystores := ch_my_stores(u); end if;
  return jsonb_build_object(
    'is_hq', ch_is_hq(u),
    'pending', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', c.id, 'item_id', c.item_id, 'vendor', c.vendor_slug, 'item', c.item, 'spec', c.spec, 'category', c.category,
        'base_price', c.base_price, 'new_price', c.new_price, 'diff', c.new_price - c.base_price,
        'rate', case when c.base_price > 0 then round((c.new_price - c.base_price) / c.base_price * 100, 1) else null end,
        'source', c.source, 'store', c.store, 'ym', c.ym, 'at', c.created_at) order by c.created_at desc), '[]'::jsonb)
      from inv_price_change c
      where c.resolved = false
        and (mystores is null or exists (select 1 from closing_inventory ci where ci.item = c.item and ci.store = any(mystores)))),
    'recent', (select coalesce(jsonb_agg(jsonb_build_object(
        'item', c.item, 'vendor', c.vendor_slug, 'base_price', c.base_price, 'new_price', c.new_price,
        'diff', c.new_price - c.base_price,
        'rate', case when c.base_price > 0 then round((c.new_price - c.base_price) / c.base_price * 100, 1) else null end,
        'source', c.source, 'at', c.resolved_at) order by c.resolved_at desc), '[]'::jsonb)
      from inv_price_change c
      where c.resolved = true and c.resolved_at >= now() - interval '30 days'
        and (mystores is null or exists (select 1 from closing_inventory ci where ci.item = c.item and ci.store = any(mystores)))));
end; $$ language plpgsql security definer;

-- 기준단가 원클릭 갱신(본사 전용): 미반영 변동을 마스터에 반영 + resolved 처리
create or replace function ch_price_apply(p_token text, p_id bigint) returns jsonb as $$
declare u users; c inv_price_change;
begin
  u := ch_user(p_token); if u.id is null or not ch_is_hq(u) then raise exception 'ACCESS_DENIED'; end if;
  select * into c from inv_price_change where id = p_id and resolved = false;
  if c.id is null then return jsonb_build_object('ok', false, 'msg', 'not_found'); end if;
  if c.item_id is not null then
    update inv_item_master set unit_price = c.new_price, updated_at = now() where id = c.item_id;
  else
    update inv_item_master set unit_price = c.new_price, updated_at = now()
      where item = c.item and coalesce(vendor_slug,'') = coalesce(c.vendor_slug,'') and status = 'approved';
  end if;
  update inv_price_change set resolved = true, resolved_by = u.id, resolved_at = now()
    where id = c.id or (resolved = false and item = c.item and coalesce(vendor_slug,'') = coalesce(c.vendor_slug,''));
  return jsonb_build_object('ok', true, 'new_price', c.new_price);
end; $$ language plpgsql security definer;

-- 변동 무시(반려): 미반영 1건 제거(기준단가 유지, 본사 전용)
create or replace function ch_price_dismiss(p_token text, p_id bigint) returns jsonb as $$
declare u users;
begin
  u := ch_user(p_token); if u.id is null or not ch_is_hq(u) then raise exception 'ACCESS_DENIED'; end if;
  delete from inv_price_change where id = p_id and resolved = false;
  return jsonb_build_object('ok', true);
end; $$ language plpgsql security definer;

-- ════════════ [2-1] 월말 거래처 정산·이체 리스트(본사 전용) ════════════
--   vendor_master 정산정보 × 당월 입고 공급가(= in_qty × coalesce(실사단가, 기준단가)) 합산.
create or replace function ch_vendor_settlement(p_token text, p_ym text) returns jsonb as $$
declare u users;
begin
  u := ch_user(p_token); if u.id is null or not ch_is_hq(u) then raise exception 'ACCESS_DENIED'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object(
      'slug', v.slug, 'vendor', v.canonical, 'settle_day', v.settle_day,
      'settle_bank', v.settle_bank, 'settle_acct', v.settle_acct,
      'bankbook_file', v.bankbook_file, 'biz_file', v.biz_file, 'biz_no', v.biz_no,
      'mgr_name', v.mgr_name, 'mgr_phone', v.mgr_phone,
      'amount', coalesce(a.amount, 0), 'store_cnt', coalesce(a.store_cnt, 0), 'item_cnt', coalesce(a.item_cnt, 0)
    ) order by coalesce(a.amount,0) desc), '[]'::jsonb)
    from vendor_master v
    left join (
      select ci.vendor_slug,
        sum(coalesce(ci.in_qty,0) * coalesce(ci.unit_price,
            (select mi.unit_price from inv_item_master mi
               where mi.item = ci.item and coalesce(mi.vendor_slug,'') = coalesce(ci.vendor_slug,'')
                 and mi.status = 'approved' order by mi.id limit 1), 0)) amount,
        count(distinct ci.store) store_cnt, count(distinct ci.item) item_cnt
      from closing_inventory ci
      where ci.ym = p_ym and coalesce(ci.in_qty,0) > 0
      group by ci.vendor_slug
    ) a on a.vendor_slug = v.slug
    where v.active);
end; $$ language plpgsql security definer;

-- RLS Deny + grant
do $$ begin
  execute 'alter table inv_price_change enable row level security';
  execute 'alter table inv_price_change force row level security';
  execute 'revoke all on table inv_price_change from anon, authenticated';
end $$;

grant execute on function ch_delivery_ingest, ch_item_save, ch_price_changes, ch_price_apply, ch_price_dismiss, ch_vendor_settlement
  to anon, authenticated;

-- ════════════ 매뉴얼(manual_sections) 권한별 반영 — 중복 시 교체 ════════════
do $$
declare
  rows jsonb := '[
    {"audience":"manager","title":"단가 변동 내역(인상·인하) 확인","body":"<p><b>매장 재고 관리 → 월말 실사</b> 상단 [단가 변동 내역]에서 본인 소속 매장이 취급하는 품목의 단가 변동을 확인합니다. 거래명세서 업로드나 본사의 품목 단가 수정으로 기준단가가 달라진 품목만 자동으로 추려 <b>직전 단가 → 변경 단가 / 차액 / 변동률</b>로 보여줍니다. (실사 입력 화면의 단가는 팀원/PT에게는 계속 숨겨집니다.)</p>"},
    {"audience":"admin","title":"월말 거래처 정산·이체 리스트","body":"<p><b>매장 재고 관리 → 제출현황</b>(본사) 품목·백데이터 줄의 [정산·이체 리스트]에서 당월 거래처별 매입액과 이체 정보를 한눈에 봅니다. 거래처 마스터의 <b>정산 시점</b>(10일/25일/말일 등)과 <b>정산 계좌(은행/계좌번호)</b>를 당월 입고 공급가 합계와 자동 매칭합니다.</p><ul><li>정산 시점별 필터와 통장사본/사업자등록증 바로보기를 제공합니다.</li><li>[엑셀 다운로드]로 이체 작업용 .xlsx 를 받습니다.</li><li>금액 = 당월 입고량 × 공급가(실사 확정단가 우선, 없으면 품목 마스터 기준단가).</li></ul>"},
    {"audience":"admin","title":"단가 변동 대시보드 · 기준단가 갱신","body":"<p><b>단가 변동 내역</b>(본사)에서는 전사 품목의 인상·인하를 봅니다. 거래명세서로 새로 들어온 단가가 기준단가와 다르면 <b>미반영</b> 목록에 뜨고, [기준단가로 갱신]을 누르면 품목 마스터 단가가 새 값으로 바뀝니다. 반영하지 않을 변동은 [무시]로 정리합니다. 품목 마스터에서 단가를 직접 수정한 건은 <b>반영완료 이력</b>에 기록됩니다.</p>"}
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
-- 완료. 프론트: [정산·이체 리스트](본사·엑셀) + [단가 변동 내역](매니저/본사) UI.
