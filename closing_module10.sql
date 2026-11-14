-- ============================================================================
-- 4순위 모듈 B — 영수증 증빙 메타(업로드 시점/필수보관/파기) + 월간 일괄 증빙 + 90일 정리
--   선행: closing_module9.sql 까지 적용 후 실행. (OCR/WebP 압축은 전부 프론트)
-- ============================================================================
do $$ begin
  if to_regclass('public.closing_card_tx') is null then
    raise exception '선행 실패: closing_cards.sql / closing_module9.sql 을 먼저 실행하세요';
  end if;
end $$;

-- 1) 영수증 증빙 메타 컬럼 ──────────────────────────────────────────────────
alter table closing_card_tx add column if not exists evidence_at     timestamptz; -- 영수증 업로드 시점(90일 기준)
alter table closing_card_tx add column if not exists evidence_type   text;        -- image / pdf
alter table closing_card_tx add column if not exists must_keep       boolean default false; -- [필수 보관 서류](수선비/비품 명세서·견적서 등)
alter table closing_card_tx add column if not exists evidence_purged boolean default false; -- 90일 경과 이미지 파기 여부(금액·내역 텍스트는 영구 보존)

-- 기존 영수증 보유행은 업로드 시점을 updated_at 으로 보정(최초 1회)
update closing_card_tx set evidence_at = coalesce(evidence_at, updated_at)
  where evidence_path is not null and evidence_at is null;

-- 2) 수시등록 재정의 — 영수증 시점/유형/필수보관 태그 반영 ──────────────────
--   기존 8인자 호출과 호환되도록 신규 인자는 기본값과 함께 뒤에 추가.
create or replace function ch_card_tx_add(p_token text, p_store text, p_tx_date date, p_total numeric,
  p_account text, p_memo text, p_card_last text, p_evidence text,
  p_evidence_type text default null, p_must_keep boolean default false) returns jsonb as $$
declare u users; ym text; cl text; newid bigint;
begin
  u := ch_user(p_token);
  if u.id is null or not ch_is_priv(u) or not ch_can_my_store(u, p_store) then raise exception 'ACCESS_DENIED'; end if;
  ym := to_char(coalesce(p_tx_date, current_date), 'YYYY-MM');
  if ch_is_locked(ym) then raise exception 'MONTH_LOCKED'; end if;
  cl := coalesce(nullif(p_card_last,''),
                 (select card_last from store_card_master where store = p_store and active order by updated_at desc limit 1));
  insert into closing_card_tx(ym,store,card_last,tx_date,total_amount,account_code,memo,evidence_path,
      evidence_at,evidence_type,must_keep,status,source,recon_status,created_by,updated_at)
    values(ym,p_store,cl,p_tx_date,coalesce(p_total,0),p_account,p_memo,p_evidence,
      case when p_evidence is not null then now() else null end, nullif(p_evidence_type,''), coalesce(p_must_keep,false),
      case when coalesce(p_account,'')='' then 'pending' else 'classified' end,'store','pending',u.id,now())
    returning id into newid;
  return jsonb_build_object('ok', true, 'id', newid);
end; $$ language plpgsql security definer;

-- 필수 보관 태그 토글(매니저/본사, 본인 매장) ───────────────────────────────
create or replace function ch_card_tx_keep(p_token text, p_id bigint, p_keep boolean) returns jsonb as $$
declare u users; st text;
begin
  u := ch_user(p_token); if u.id is null or not ch_is_priv(u) then raise exception 'ACCESS_DENIED'; end if;
  select store into st from closing_card_tx where id = p_id;
  if not ch_can_my_store(u, st) then raise exception 'ACCESS_DENIED'; end if;
  update closing_card_tx set must_keep = coalesce(p_keep,false), updated_at = now() where id = p_id;
  return jsonb_build_object('ok', true);
end; $$ language plpgsql security definer;

-- 3) 월간 일괄 증빙 PDF(월 중 미등록 매장용) ────────────────────────────────
create table if not exists closing_card_bulk (
  id bigint generated always as identity primary key,
  ym text not null, store text, path text not null, size bigint,
  created_by uuid, created_at timestamptz default now()
);
create index if not exists idx_card_bulk_store_ym on closing_card_bulk (store, ym);

create or replace function ch_card_bulk_add(p_token text, p_ym text, p_store text, p_path text, p_size bigint) returns jsonb as $$
declare u users;
begin
  u := ch_user(p_token); if u.id is null or not ch_is_priv(u) or not ch_can_my_store(u, p_store) then raise exception 'ACCESS_DENIED'; end if;
  insert into closing_card_bulk(ym, store, path, size, created_by) values (p_ym, p_store, p_path, p_size, u.id);
  return jsonb_build_object('ok', true);
end; $$ language plpgsql security definer;

create or replace function ch_card_bulk_list(p_token text, p_store text, p_ym text) returns jsonb as $$
declare u users;
begin
  u := ch_user(p_token); if u.id is null or not ch_is_priv(u) or not ch_can_my_store(u, p_store) then raise exception 'ACCESS_DENIED'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('id',id,'path',path,'size',size,'at',created_at) order by created_at desc),'[]'::jsonb)
    from closing_card_bulk where store = p_store and ym = p_ym);
end; $$ language plpgsql security definer;

create or replace function ch_card_bulk_del(p_token text, p_id bigint) returns jsonb as $$
declare u users; st text;
begin
  u := ch_user(p_token); if u.id is null or not ch_is_priv(u) then raise exception 'ACCESS_DENIED'; end if;
  select store into st from closing_card_bulk where id = p_id;
  if not ch_can_my_store(u, st) then raise exception 'ACCESS_DENIED'; end if;
  delete from closing_card_bulk where id = p_id;
  return jsonb_build_object('ok', true);
end; $$ language plpgsql security definer;

-- 4) 90일 경과 영수증 이미지 정리(본사 전용) ────────────────────────────────
--   대상: evidence_path 보유 · 미파기 · 필수보관 아님 · 업로드 90일 경과.
--   프론트가 후보 path 를 Storage 에서 remove 후, 성공분 id 로 commit(금액·내역 텍스트는 보존).
create or replace function ch_card_purge_candidates(p_token text) returns jsonb as $$
declare u users;
begin
  u := ch_user(p_token); if u.id is null or not ch_is_hq(u) then raise exception 'ACCESS_DENIED'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'path', evidence_path) order by evidence_at), '[]'::jsonb)
    from closing_card_tx
    where evidence_path is not null and not coalesce(evidence_purged,false) and not coalesce(must_keep,false)
      and evidence_at is not null and evidence_at < now() - interval '90 days');
end; $$ language plpgsql security definer;

create or replace function ch_card_purge_commit(p_token text, p_ids jsonb) returns jsonb as $$
declare u users; n int;
begin
  u := ch_user(p_token); if u.id is null or not ch_is_hq(u) then raise exception 'ACCESS_DENIED'; end if;
  with ids as (select value::text::bigint as id from jsonb_array_elements_text(coalesce(p_ids,'[]'::jsonb)))
  update closing_card_tx t set evidence_purged = true, evidence_path = null, updated_at = now()
    from ids where t.id = ids.id and not coalesce(t.must_keep,false)
  returning 1 into n;
  get diagnostics n = row_count;
  return jsonb_build_object('ok', true, 'purged', coalesce(n,0));
end; $$ language plpgsql security definer;

-- RLS Deny + grant
do $$ begin
  execute 'alter table closing_card_bulk enable row level security';
  execute 'alter table closing_card_bulk force row level security';
  execute 'revoke all on table closing_card_bulk from anon, authenticated';
end $$;

grant execute on function ch_card_tx_add, ch_card_tx_keep, ch_card_bulk_add, ch_card_bulk_list, ch_card_bulk_del,
  ch_card_purge_candidates, ch_card_purge_commit to anon, authenticated;

-- ════════════ 매뉴얼(manual_sections) 권한별 반영 — 중복 시 교체 ════════════
do $$
declare
  rows jsonb := '[
    {"audience":"manager","title":"영수증 사진 OCR · 필수 보관 서류","body":"<p><b>법인카드 수시 등록</b>에서 영수증을 촬영/첨부하면 일자와 금액을 자동으로 읽어 입력칸에 채워 줍니다(오인식은 바로 수정). 사진은 1200px WebP로 자동 경량화되어 저장됩니다. 사진 여러 장 선택이나 다페이지 PDF도 지원합니다.</p><ul><li><b>필수 보관 서류</b>: 수선비/비품 등 거래명세서·견적서는 [필수 보관 서류]로 체크해 두면 90일이 지나도 삭제되지 않고 영구 보존됩니다.</li><li><b>거래명세서 업로드</b>에 사진을 첨부하면 품목/수량/단가를 OCR로 읽어 파싱합니다. (원본 사진은 저장하지 않고 파싱 후 즉시 파기)</li></ul>"},
    {"audience":"manager","title":"법인카드 영수증 증빙철 출력","body":"<p><b>법인카드</b> 화면의 [증빙철 출력]으로 당월 영수증을 결제일시순 그리드(No./일자/금액/계정과목/내역)로 자동 조판해 PDF/인쇄뷰로 한 번에 출력합니다. 매장이 월말에 따로 편집할 필요가 없습니다. 월 중 개별 등록을 못 한 경우 [월간 일괄 증빙 PDF 업로드]로 한 파일을 올려 둘 수 있습니다.</p>"},
    {"audience":"admin","title":"영수증 90일 자동 정리","body":"<p>본사 관리자가 접속하면 하루 1회 자동으로 점검하여, 업로드 후 90일(3개월)이 지난 <b>일반 영수증 이미지만</b> 스토리지에서 삭제하고 정리 건수를 팝업으로 알립니다. 금액/내역 등 DB 텍스트와 [필수 보관 서류]로 지정된 증빙은 영구 보존됩니다.</p>"}
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
-- 완료. 프론트: Tesseract.js OCR + WebP 압축 + 증빙철 출력 + 90일 정리(본사 로그인 1회).
