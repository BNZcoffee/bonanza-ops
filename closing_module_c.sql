-- ============================================================================
-- 모듈 C — 회계 통합엑셀용 데이터 RPC + 실사 품목 자동채움 + 실제 17계정 교체 + 매뉴얼
-- 선행: closing_security → closing_v2 → closing_cards → closing_inventory_mgmt → (이 파일)
-- ============================================================================

-- 0) 선행 점검 ───────────────────────────────────────────────────────────────
do $$ begin
  if to_regclass('public.closing_accounts') is null or to_regclass('public.closing_card_tx') is null then
    raise exception '선행 실패: closing_v2_schema.sql / closing_cards.sql 를 먼저 실행하세요';
  end if;
end $$;

-- 1) 실제 회계 17계정으로 교체 (재고3 · 자산2 · 비용12) ───────────────────────
--    기존 임시 계정명 제거 후, 회계팀 법인카드 사용세부내역 좌측 집계표와 동일하게 적재
delete from closing_accounts;
insert into closing_accounts(code,name,kind,sort) values
  ('INV_RAW','원재료','재고',1), ('INV_GOODS','상품','재고',2), ('INV_SUB','부재료','재고',3),
  ('AST_INT','인테리어','자산',4), ('AST_EQUIP','비품','자산',5),
  ('EXP_LUNCH','중식(간식)','비용',6), ('EXP_DINNER','석식','비용',7), ('EXP_TRAVEL','여비교통비','비용',8),
  ('EXP_CAR','차량유지비(법인차량)','비용',9), ('EXP_ENT','접대비(외부미팅)','비용',10), ('EXP_ADMKT','광고·마케팅','비용',11),
  ('EXP_SUPPLY','소모품비','비용',12), ('EXP_SITE','사이트운영','비용',13), ('EXP_TRANS','운반비','비용',14),
  ('EXP_INS','4대보험','비용',15), ('EXP_COMM','통신비','비용',16), ('EXP_FEE','지급수수료','비용',17);

-- 2) 월말 실사 품목 자동채움 — 전월 기말재고 이월 품목(분류·품명·규격·단위) ───────
--    (당월 거래명세서 입고 품목은 품목-매장 단위 저장분이 생기면 UNION 확장)
create or replace function ch_inv_template(p_token text, p_store text, p_ym text) returns jsonb as $$
declare u users; prev_ym text;
begin
  u := ch_user(p_token); if u.id is null or not ch_can_my_store(u, p_store) then raise exception 'ACCESS_DENIED'; end if;
  prev_ym := to_char((to_date(p_ym || '-01','YYYY-MM-DD') - interval '1 month'), 'YYYY-MM');
  return jsonb_build_object('items', (
    select coalesce(jsonb_agg(jsonb_build_object(
        'vendor_slug', vendor_slug, 'category', category, 'item', item, 'spec', spec, 'unit', unit
      ) order by category, item), '[]'::jsonb)
    from (
      -- 당월 이미 입력분 우선
      select vendor_slug, category, item, spec, unit from closing_inventory where store = p_store and ym = p_ym
      union
      -- 전월 품목 이월(당월에 없는 것만)
      select p.vendor_slug, p.category, p.item, p.spec, p.unit from closing_inventory p
      where p.store = p_store and p.ym = prev_ym
        and not exists (select 1 from closing_inventory c where c.store = p_store and c.ym = p_ym and c.item = p.item and coalesce(c.vendor_slug,'') = coalesce(p.vendor_slug,''))
    ) t
  ));
end; $$ language plpgsql security definer;

-- 3) 회계 통합엑셀 데이터 — 매장 스코프별 카드/발주/입재고 일괄 반환 ──────────────
--    본사=전 매장(PDC 제외), 매니저=본인 매장(들), p_store 지정 시 해당 1개
create or replace function ch_export_data(p_token text, p_ym text, p_store text) returns jsonb as $$
declare u users; sts text[];
begin
  u := ch_user(p_token); if u.id is null then raise exception 'ACCESS_DENIED'; end if;
  if p_store is not null and p_store <> '' then
    if not ch_can_my_store(u, p_store) then raise exception 'ACCESS_DENIED'; end if;
    sts := array[p_store];
  elsif ch_is_hq(u) then
    select array_agg(name order by sort_order) into sts from store_options where name <> '본사' and not ch_is_pdc(name);
  elsif ch_is_priv(u) then
    sts := ch_my_stores(u);
  else
    raise exception 'ACCESS_DENIED';
  end if;

  return jsonb_build_object(
    'ym', p_ym,
    'accounts', (select coalesce(jsonb_agg(jsonb_build_object('code',code,'name',name,'kind',kind,'sort',sort) order by sort),'[]'::jsonb) from closing_accounts where active),
    'stores', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'store', s,
        'cards', (select coalesce(jsonb_agg(jsonb_build_object(
            'tx_date', tx_date, 'account_code', account_code, 'memo', memo,
            'supply', supply_amount, 'vat', vat_amount, 'total', total_amount,
            'card_last', card_last, 'cancelled', cancelled, 'tax_type', tax_type
          ) order by tx_date), '[]'::jsonb) from closing_card_tx where store = s and ym = p_ym),
        'orders', (select coalesce(jsonb_agg(jsonb_build_object(
            'category', category, 'vendor', vendor, 'amount', amount, 'is_corp_card', is_corp_card,
            'supply', supply_amount, 'vat', vat_amount, 'total', total_amount, 'tax_type', tax_type
          ) order by category, vendor), '[]'::jsonb) from closing_orders where store = s and ym = p_ym),
        'inventory', (select coalesce(jsonb_agg(jsonb_build_object(
            'category', category, 'vendor_slug', vendor_slug, 'item', item, 'spec', spec, 'unit', unit,
            'opening_qty', opening_qty, 'in_qty', in_qty, 'use_qty', use_qty, 'count_qty', count_qty,
            'loss_qty', loss_qty, 'transfer_in_qty', transfer_in_qty, 'transfer_out_qty', transfer_out_qty,
            'unit_price', unit_price
          ) order by category, item), '[]'::jsonb) from closing_inventory where store = s and ym = p_ym)
      )), '[]'::jsonb)
      from unnest(sts) s
    )
  );
end; $$ language plpgsql security definer;

grant execute on function ch_inv_template, ch_export_data to anon, authenticated;

-- 4) 매뉴얼(manual_sections) — 권한별 사용법 추가(중복 시 교체) ────────────────
do $$
declare
  rows jsonb := '[
    {"audience":"user","title":"매장 재고 관리 — 폐기/이관/실사","body":"<p><b>사이드바 [매장 재고 관리]</b>에서 본인 소속 매장(겸직 포함)의 재고 업무를 처리합니다.</p><ul><li><b>폐기(Loss)</b>: 월 중 언제든 등록. 분류(유통기한 경과/제조 실수 파손/품질 변질/기기 이상/기타)와 수량, 사유를 입력합니다. 재고 품목은 자동 합산, 비재고는 기타로 누적됩니다.</li><li><b>타매장 이관</b>: 보내는 매장에서 받는 매장/품목/수량을 등록하면 양쪽에 반영되고 받는 매장에 알림이 갑니다.</li><li><b>월말 실사</b>: 본사가 연 취합 기간에만 열립니다. 분류/품명/규격/단위가 자동으로 떠 있으니 <b>실사 수량 칸에 숫자만</b> 입력하고 [실사 제출]을 누르세요. (금액은 매니저 확정 단계에서 처리)</li><li><b>모바일 알림</b>: 상단 [알림 받기] 배너로 구독하면 마감 D-1/경과, 이관 도착을 휴대폰 푸시로 받습니다. (아이폰은 홈 화면에 추가 후)</li></ul>"},
    {"audience":"manager","title":"법인카드 수시 등록 & 월말 실사 확정","body":"<p><b>월말 정산 도우미 → 법인카드</b> 탭에서 결제 시마다 [수시 등록](결제일/금액/계정과목/사용내역/영수증)으로 올려두면 월말 대사가 자동으로 맞춰집니다. 상단 한도 바에서 당월 사용액/잔여를 확인하세요.</p><p><b>매장 재고 관리 → 월말 실사</b>에서 팀원이 제출한 실사 수량을 금액/단가까지 검수한 뒤 [최종 마감 확정]을 누르면 제출이 완료됩니다. 본사 보완요청(반려)이 오면 수정 후 다시 확정하세요.</p>"},
    {"audience":"admin","title":"법인카드 마스터 · 보안 PIN · 월말 자동대사","body":"<p><b>법인카드 탭(본사)</b>에서 카드 등록/수정/삭제와 민감정보(암호화) 관리를 합니다.</p><ul><li><b>보안 PIN</b>: 총괄은 [보안 PIN 설정](6자리, 로그인 PW와 별개)을 먼저 등록하세요. 카드번호/유효기간/CVC/PW 열람 시 PIN 인증이 필요하며, 열람 후 30초 뒤 자동으로 다시 가려집니다. 5회 오류 시 10분 잠금, 열람 기록은 감사 로그로 남습니다.</li><li><b>월말 자동대사</b>: 회계팀 카드 승인 엑셀을 올리면 끝4자리+결제일+금액으로 매장 수시등록과 매칭됩니다. (일치=자동마감 / 미등록=매장 입력필요 / 불일치·취소=확인필요)</li></ul>"},
    {"audience":"admin","title":"취합 시즌 / 보완요청 / 회계 통합 엑셀","body":"<p><b>매장 재고 관리 → 제출현황/시즌</b>(본사)에서 운영합니다.</p><ul><li><b>취합 시즌</b>: 매월 실사 입력 시작/마감 일시를 1회 설정하면 전 매장에 동일 적용됩니다. 마감 후 미제출/반려 매장은 완료 시까지 자동 연장되고 D+N 경과가 표시됩니다.</li><li><b>보완요청(반려)</b>: 매장 실사가 미흡하면 [보완요청]으로 반려해 입력을 다시 엽니다.</li><li><b>회계팀 제출용 통합 엑셀</b>: [통합 엑셀 다운로드]로 법인카드 사용세부내역(17계정 집계+상세)/업체별 합산/매장별 입재고 종합을 한 파일로 받습니다. (PDC 제외) 매니저 계정은 본인 매장분만 받습니다.</li></ul>"}
  ]'::jsonb;
  r jsonb; nextsort int;
begin
  for r in select * from jsonb_array_elements(rows) loop
    delete from manual_sections where audience = r->>'audience' and title = r->>'title';
    select coalesce(max(sort_order),0)+1 into nextsort from manual_sections where audience = r->>'audience';
    insert into manual_sections(audience, title, body, sort_order) values (r->>'audience', r->>'title', r->>'body', nextsort);
  end loop;
end $$;

notify pgrst, 'reload schema';
-- 완료. 프론트: closing_helper.js(ExcelJS 통합 다운로드) + inventory_helper.js(실사 자동채움).
