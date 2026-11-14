-- ============================================================================
-- 월말 정산 도우미 — 법인카드 마스터 암호화 + 수시등록 + 월말 자동대사 + 총괄 2차 PIN
-- 선행(순서): closing_security.sql → closing_v2_schema.sql → (이 파일) closing_cards.sql
--   · 민감 4필드(카드번호/유효기간/CVC/PW) = pgcrypto 대칭암호화(bytea) 저장
--   · 복호화 키 = Supabase Vault 에 랜덤 자동생성(소스/깃 미노출)
--   · 총괄 전용 6자리 보안 PIN = bcrypt 단방향 해시(로그인 PW 와 완전 분리)
--   · ch_reveal_card_secret = is_master + PIN 검증 후에만 복호화 · 5회 오류 10분 잠금 · 감사로그
-- ============================================================================

-- 0) 선행 점검 ───────────────────────────────────────────────────────────────
do $$ begin
  if to_regclass('public.store_card_master') is null
     or to_regclass('public.closing_card_tx') is null
     or to_regclass('public.closing_accounts') is null then
    raise exception '선행 실패: closing_v2_schema.sql 을 먼저 실행하세요 (store_card_master/closing_card_tx/closing_accounts 없음)';
  end if;
end $$;

-- 1) 확장 ────────────────────────────────────────────────────────────────────
create extension if not exists pgcrypto;
create extension if not exists supabase_vault;

-- 2) 암호화 키 (Vault · 없으면 랜덤 생성) ─────────────────────────────────────
do $$ begin
  if not exists (select 1 from vault.secrets where name = 'card_enc_key') then
    perform vault.create_secret(encode(gen_random_bytes(32),'hex'), 'card_enc_key', 'BCK 법인카드 민감필드 대칭암호화 키');
  end if;
end $$;

create or replace function _ch_cardkey() returns text as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'card_enc_key' limit 1;
$$ language sql security definer stable;
revoke all on function _ch_cardkey() from anon, authenticated;   -- 내부 전용(정의자 함수에서만 호출)

-- 3) store_card_master 컬럼 확장 ─────────────────────────────────────────────
--    card_last = 끝 4자리(평문·조회/대사용) · store = store_options 기준 매장명 · label = 카드 별칭
alter table store_card_master add column if not exists category        text;          -- 분류
alter table store_card_master add column if not exists card_user       text;          -- 사용자
alter table store_card_master add column if not exists remark          text;          -- 비고(매출입금계좌)
alter table store_card_master add column if not exists limit_amount    numeric(14,0); -- 결제 한도
alter table store_card_master add column if not exists card_number_enc bytea;         -- 전체 카드번호(암호화)
alter table store_card_master add column if not exists expiry_enc      bytea;         -- 유효기간 MM/YY(암호화)
alter table store_card_master add column if not exists cvc_enc         bytea;         -- CVC(암호화)
alter table store_card_master add column if not exists card_pw_enc     bytea;         -- 결제 PIN(암호화)
alter table store_card_master add column if not exists created_by      bigint;

-- 4) closing_card_tx 컬럼 확장 (수시등록/자동대사) ───────────────────────────
alter table closing_card_tx add column if not exists source          text default 'store';  -- store(매장수시) / accounting(회계엑셀)
alter table closing_card_tx add column if not exists recon_status    text;                  -- pending/matched/need_input/review
alter table closing_card_tx add column if not exists approved_amount numeric(14,2);         -- 회계 승인금액
alter table closing_card_tx add column if not exists evidence_path   text;                  -- 영수증 링크(스토리지 경로)

-- 5) 총괄 보안 PIN · 감사로그 테이블 ─────────────────────────────────────────
create table if not exists admin_security_pin (
  user_id      bigint primary key,
  pin_hash     text not null,                 -- crypt(pin, gen_salt('bf')) · 단방향
  fail_count   int default 0,
  locked_until timestamptz,
  updated_at   timestamptz default now()
);

create table if not exists closing_card_audit_logs (
  id         bigint generated always as identity primary key,
  user_id    bigint,
  user_name  text,
  store      text,
  card_id    bigint,
  action     text,                            -- reveal / edit_secret / set_pin
  created_at timestamptz default now()
);
create index if not exists idx_card_audit_created on closing_card_audit_logs (created_at desc);

-- 6) 보안 PIN 내부 검증기 (실패 카운트/10분 잠금 포함) ───────────────────────
create or replace function _ch_pin_check(u users, p_pin text) returns void as $$
declare rec admin_security_pin; newfail int;
begin
  select * into rec from admin_security_pin where user_id = u.id;
  if rec.user_id is null then raise exception 'PIN_NOT_SET'; end if;
  if rec.locked_until is not null and rec.locked_until > now() then raise exception 'PIN_LOCKED'; end if;
  if rec.pin_hash = crypt(coalesce(p_pin,''), rec.pin_hash) then
    update admin_security_pin set fail_count = 0, locked_until = null where user_id = u.id;
    return;
  end if;
  newfail := coalesce(rec.fail_count,0) + 1;
  if newfail >= 5 then
    update admin_security_pin set fail_count = 0, locked_until = now() + interval '10 minutes' where user_id = u.id;
    raise exception 'PIN_LOCKED';
  else
    update admin_security_pin set fail_count = newfail where user_id = u.id;
    raise exception 'PIN_WRONG:%', (5 - newfail);
  end if;
end; $$ language plpgsql security definer;
revoke all on function _ch_pin_check(users, text) from anon, authenticated;

-- 7) 보안 PIN 상태/설정 RPC ──────────────────────────────────────────────────
create or replace function ch_secpin_status(p_token text) returns jsonb as $$
declare u users; rec admin_security_pin;
begin
  u := ch_user(p_token); if u.id is null or not u.is_master then raise exception 'ACCESS_DENIED'; end if;
  select * into rec from admin_security_pin where user_id = u.id;
  return jsonb_build_object('set', rec.user_id is not null,
    'locked', (rec.locked_until is not null and rec.locked_until > now()),
    'locked_until', rec.locked_until);
end; $$ language plpgsql security definer;

create or replace function ch_secpin_set(p_token text, p_old_pin text, p_new_pin text) returns jsonb as $$
declare u users; rec admin_security_pin;
begin
  u := ch_user(p_token); if u.id is null or not u.is_master then raise exception 'ACCESS_DENIED'; end if;
  if p_new_pin !~ '^[0-9]{6}$' then raise exception 'PIN_FORMAT'; end if;
  select * into rec from admin_security_pin where user_id = u.id;
  if rec.user_id is not null then
    if rec.locked_until is not null and rec.locked_until > now() then raise exception 'PIN_LOCKED'; end if;
    if rec.pin_hash <> crypt(coalesce(p_old_pin,''), rec.pin_hash) then raise exception 'PIN_WRONG'; end if;
    update admin_security_pin set pin_hash = crypt(p_new_pin, gen_salt('bf')), fail_count = 0, locked_until = null, updated_at = now() where user_id = u.id;
  else
    insert into admin_security_pin(user_id, pin_hash) values (u.id, crypt(p_new_pin, gen_salt('bf')));
  end if;
  insert into closing_card_audit_logs(user_id, user_name, action) values (u.id, u.name, 'set_pin');
  return jsonb_build_object('ok', true);
end; $$ language plpgsql security definer;

-- 8) 카드 목록(안전필드만) · 기본정보 저장 · 삭제 ───────────────────────────
--    ch_cards: 암호문/민감필드 절대 미반환. 본사=전체, 매장매니저=본인매장 끝4자리·한도만
create or replace function ch_cards(p_token text) returns jsonb as $$
declare u users;
begin
  u := ch_user(p_token); if u.id is null then raise exception 'ACCESS_DENIED'; end if;
  if ch_is_hq(u) then
    return (select coalesce(jsonb_agg(jsonb_build_object(
        'id',c.id,'category',c.category,'store',c.store,'card_last',c.card_last,'label',c.label,
        'card_user',c.card_user,'remark',c.remark,'limit_amount',c.limit_amount,'active',c.active,
        'has_number',c.card_number_enc is not null,'has_expiry',c.expiry_enc is not null,
        'has_cvc',c.cvc_enc is not null,'has_pw',c.card_pw_enc is not null
      ) order by c.store, c.card_last),'[]'::jsonb) from store_card_master c);
  else
    return (select coalesce(jsonb_agg(jsonb_build_object(
        'id',c.id,'store',c.store,'card_last',c.card_last,'label',c.label,'limit_amount',c.limit_amount,'active',c.active
      ) order by c.card_last),'[]'::jsonb) from store_card_master c
      where c.active and c.store = any(ch_my_stores(u)));
  end if;
end; $$ language plpgsql security definer;

-- 시그니처 변경 → 기존(v2) 버전 제거 후 재생성
drop function if exists ch_card_save(text, bigint, text, text, text, boolean);
create or replace function ch_card_save(p_token text, p_id bigint, p_category text, p_store text, p_card_last text,
  p_label text, p_card_user text, p_remark text, p_limit numeric, p_active boolean) returns jsonb as $$
declare u users; nid bigint;
begin
  u := ch_user(p_token); if u.id is null or not ch_is_hq(u) then raise exception 'ACCESS_DENIED'; end if;
  if p_id is null then
    insert into store_card_master(category,store,card_last,label,card_user,remark,limit_amount,active,created_by,updated_at)
      values(p_category,p_store,p_card_last,p_label,p_card_user,p_remark,p_limit,coalesce(p_active,true),u.id,now())
      returning id into nid;
  else
    update store_card_master set category=p_category,store=p_store,card_last=p_card_last,label=p_label,
      card_user=p_card_user,remark=p_remark,limit_amount=p_limit,active=coalesce(p_active,true),updated_at=now()
      where id=p_id returning id into nid;
  end if;
  return jsonb_build_object('ok',true,'id',nid);
end; $$ language plpgsql security definer;

-- 삭제: 총괄만(민감정보 포함 완전삭제)
create or replace function ch_card_del(p_token text, p_id bigint) returns jsonb as $$
declare u users;
begin
  u := ch_user(p_token); if u.id is null or not u.is_master then raise exception 'ACCESS_DENIED'; end if;
  delete from store_card_master where id = p_id; return jsonb_build_object('ok', true);
end; $$ language plpgsql security definer;

-- 9) 민감필드 암호화 저장(총괄 + PIN) ───────────────────────────────────────
--    빈문자열('') = 해당 필드 삭제, null = 기존값 유지
create or replace function ch_card_set_secret(p_token text, p_id bigint, p_pin text,
  p_card_number text, p_expiry text, p_cvc text, p_card_pw text) returns jsonb as $$
declare u users; k text; digits text;
begin
  u := ch_user(p_token); if u.id is null or not u.is_master then raise exception 'ACCESS_DENIED'; end if;
  perform _ch_pin_check(u, p_pin);
  k := _ch_cardkey();
  digits := nullif(regexp_replace(coalesce(p_card_number,''), '\D', '', 'g'), '');
  update store_card_master set
    card_number_enc = case when p_card_number is null then card_number_enc
                           when digits is null then null else pgp_sym_encrypt(digits, k) end,
    card_last       = case when p_card_number is null then card_last
                           when digits is null then card_last else right(digits, 4) end,
    expiry_enc      = case when p_expiry is null then expiry_enc
                           when p_expiry = '' then null else pgp_sym_encrypt(p_expiry, k) end,
    cvc_enc         = case when p_cvc is null then cvc_enc
                           when p_cvc = '' then null else pgp_sym_encrypt(p_cvc, k) end,
    card_pw_enc     = case when p_card_pw is null then card_pw_enc
                           when p_card_pw = '' then null else pgp_sym_encrypt(p_card_pw, k) end,
    updated_at = now()
  where id = p_id;
  insert into closing_card_audit_logs(user_id, user_name, store, card_id, action)
    select u.id, u.name, c.store, p_id, 'edit_secret' from store_card_master c where c.id = p_id;
  return jsonb_build_object('ok', true);
end; $$ language plpgsql security definer;

-- 10) 민감정보 2차 인증 복호화 열람(총괄 + PIN) + 감사로그 ──────────────────
create or replace function ch_reveal_card_secret(p_token text, p_id bigint, p_pin text) returns jsonb as $$
declare u users; c store_card_master; k text;
begin
  u := ch_user(p_token); if u.id is null or not u.is_master then raise exception 'ACCESS_DENIED'; end if;
  perform _ch_pin_check(u, p_pin);
  select * into c from store_card_master where id = p_id;
  if c.id is null then raise exception 'NOT_FOUND'; end if;
  k := _ch_cardkey();
  insert into closing_card_audit_logs(user_id, user_name, store, card_id, action)
    values (u.id, u.name, c.store, c.id, 'reveal');
  return jsonb_build_object('ok', true,
    'card_number', case when c.card_number_enc is not null then pgp_sym_decrypt(c.card_number_enc, k) else null end,
    'expiry',      case when c.expiry_enc      is not null then pgp_sym_decrypt(c.expiry_enc, k)      else null end,
    'cvc',         case when c.cvc_enc         is not null then pgp_sym_decrypt(c.cvc_enc, k)         else null end,
    'card_pw',     case when c.card_pw_enc     is not null then pgp_sym_decrypt(c.card_pw_enc, k)     else null end,
    'store', c.store, 'card_last', c.card_last);
end; $$ language plpgsql security definer;

create or replace function ch_card_audit_list(p_token text, p_limit int) returns jsonb as $$
declare u users;
begin
  u := ch_user(p_token); if u.id is null or not u.is_master then raise exception 'ACCESS_DENIED'; end if;
  return (select coalesce(jsonb_agg(to_jsonb(a) order by a.created_at desc),'[]'::jsonb)
    from (select * from closing_card_audit_logs order by created_at desc limit coalesce(p_limit,100)) a);
end; $$ language plpgsql security definer;

-- 11) 매장 수시 등록 · 실시간 한도/잔액 ─────────────────────────────────────
create or replace function ch_card_tx_add(p_token text, p_store text, p_tx_date date, p_total numeric,
  p_account text, p_memo text, p_card_last text, p_evidence text) returns jsonb as $$
declare u users; ym text; cl text;
begin
  u := ch_user(p_token);
  if u.id is null or not ch_is_priv(u) or not ch_can_my_store(u, p_store) then raise exception 'ACCESS_DENIED'; end if;
  ym := to_char(coalesce(p_tx_date, current_date), 'YYYY-MM');
  if ch_is_locked(ym) then raise exception 'MONTH_LOCKED'; end if;
  cl := coalesce(nullif(p_card_last,''),
                 (select card_last from store_card_master where store = p_store and active order by updated_at desc limit 1));
  insert into closing_card_tx(ym,store,card_last,tx_date,total_amount,account_code,memo,evidence_path,
      status,source,recon_status,created_by,updated_at)
    values(ym,p_store,cl,p_tx_date,coalesce(p_total,0),p_account,p_memo,p_evidence,
      case when coalesce(p_account,'')='' then 'pending' else 'classified' end,'store','pending',u.id,now());
  return jsonb_build_object('ok', true);
end; $$ language plpgsql security definer;

create or replace function ch_card_usage(p_token text, p_store text, p_ym text) returns jsonb as $$
declare u users; lim numeric; used numeric;
begin
  u := ch_user(p_token);
  if u.id is null or not ch_can_my_store(u, p_store) then raise exception 'ACCESS_DENIED'; end if;
  select limit_amount into lim from store_card_master where store = p_store and active order by updated_at desc limit 1;
  select coalesce(sum(total_amount),0) into used from closing_card_tx where store = p_store and ym = p_ym and not cancelled;
  return jsonb_build_object('limit', lim, 'used', used,
    'remain', case when lim is not null then lim - used else null end,
    'pct',    case when lim > 0 then round(used/lim*100, 1) else null end);
end; $$ language plpgsql security definer;

-- 12) 월말 자동대사(회계 승인엑셀) — 끝4자리+결제일+금액 매칭 ─────────────────
create or replace function ch_card_reconcile(p_token text, p_ym text, p_rows jsonb) returns jsonb as $$
declare u users; rec jsonb; st text; cl text; amt numeric; txd date; canc boolean;
  mid bigint; mamt numeric; mstatus text; n_match int:=0; n_need int:=0; n_review int:=0;
begin
  u := ch_user(p_token); if u.id is null or not ch_is_hq(u) then raise exception 'ACCESS_DENIED'; end if;
  if ch_is_locked(p_ym) then raise exception 'MONTH_LOCKED'; end if;
  for rec in select * from jsonb_array_elements(coalesce(p_rows,'[]'::jsonb)) loop
    cl  := rec->>'card_last';
    txd := nullif(rec->>'tx_date','')::date;
    amt := coalesce((rec->>'amount')::numeric, 0);
    canc := coalesce((rec->>'cancelled')::boolean, false);
    select store into st from store_card_master where card_last = cl and active order by updated_at desc limit 1;
    if canc then
      insert into closing_card_tx(ym,store,card_last,tx_date,total_amount,approved_amount,status,source,recon_status,cancelled,memo,created_by,updated_at)
        values(p_ym,st,cl,txd,amt,amt,'pending','accounting','review',true,'취소 전표',u.id,now());
      n_review := n_review + 1; continue;
    end if;
    select id,total_amount,status into mid,mamt,mstatus from closing_card_tx
      where ym = p_ym and card_last = cl and tx_date = txd and source = 'store'
        and recon_status = 'pending' and not cancelled
      order by abs(total_amount - amt) asc limit 1;
    if mid is not null and abs(coalesce(mamt,0) - amt) <= 1 then
      update closing_card_tx set approved_amount = amt,
        recon_status = case when mstatus = 'classified' then 'matched' else 'need_input' end, updated_at = now()
        where id = mid;
      if mstatus = 'classified' then n_match := n_match + 1; else n_need := n_need + 1; end if;
    elsif mid is not null then
      update closing_card_tx set approved_amount = amt, recon_status = 'review', updated_at = now() where id = mid;
      n_review := n_review + 1;
    else
      insert into closing_card_tx(ym,store,card_last,tx_date,total_amount,approved_amount,status,source,recon_status,created_by,updated_at)
        values(p_ym,st,cl,txd,amt,amt,'pending','accounting','need_input',u.id,now());
      n_need := n_need + 1;
    end if;
  end loop;
  return jsonb_build_object('ok',true,'matched',n_match,'need_input',n_need,'review',n_review);
end; $$ language plpgsql security definer;

-- 13) 초기 카드 26건 적재 (사내카페/미운영 제외 · 매장명=store_options 기준 변환) ──
--     card_last=카드번호 끝4자리 · cvc 공란 · pw: 군자 공란 외 7980
insert into store_card_master(store, card_last, card_number_enc, expiry_enc, card_pw_enc, active, updated_at)
select v.store, right(v.num,4),
       pgp_sym_encrypt(v.num, _ch_cardkey()),
       pgp_sym_encrypt(v.exp, _ch_cardkey()),
       case when v.pw <> '' then pgp_sym_encrypt(v.pw, _ch_cardkey()) else null end,
       true, now()
from (values
  ('군자','9410499867684804','08/27',''),
  ('인천','5130413375926927','11/31','7980'),
  ('스타필드수원','5130410813591958','03/27','7980'),
  ('파주','5585031566609969','10/28','7980'),
  ('대전','4140031801827971','03/29','7980'),
  ('롯데수원','6264150736720989','11/25','7980'),
  ('평촌','5585031849259996','04/29','7980'),
  ('기장','5585031849380909','04/29','7980'),
  ('잠실','5585031948338907','05/29','7980'),
  ('안성','5585031984204971','06/29','7980'),
  ('천호','5585032017647954','07/29','7980'),
  ('목동','5585032017647988','07/29','7980'),
  ('미아','5585032017667978','07/29','7980'),
  ('김포','5585032017687968','07/29','7980'),
  ('광교','4140032298522984','12/29','7980'),
  ('의왕','4140032298524923','12/29','7980'),
  ('창원','4140032331726980','01/30','7980'),
  ('송도','5585032618323971','06/30','7980'),
  ('울산','5585032618313949','06/30','7980'),
  ('의정부','5585032618383967','06/30','7980'),
  ('한남','5585032618303957','06/30','7980'),
  ('성수','5130413375906945','11/31','7980'),
  ('코엑스','5130413375946958','11/31','7980'),
  ('운정','4140032113202978','08/29','7980'),
  ('김해','4140032113282939','08/29','7980'),
  ('동부산','4140032113261990','08/29','7980')
) as v(store, num, exp, pw)
on conflict (card_last, store) do nothing;

-- 14) RLS Deny-All (신규 테이블) + grant ─────────────────────────────────────
do $$ declare t text;
begin
  foreach t in array array['admin_security_pin','closing_card_audit_logs'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('revoke all on table %I from anon, authenticated', t);
  end loop;
end $$;

grant execute on function ch_cards, ch_card_save, ch_card_del, ch_card_set_secret, ch_reveal_card_secret,
  ch_card_audit_list, ch_secpin_status, ch_secpin_set, ch_card_tx_add, ch_card_usage, ch_card_reconcile
  to anon, authenticated;

notify pgrst, 'reload schema';
-- 완료. 프론트엔드(closing_helper.js — 법인카드 탭)는 이 스키마 위에서 동작.
