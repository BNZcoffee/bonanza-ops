// ============================================================================
// push-send — 보난자 운영앱 웹푸시 Edge Function (Deno)
// 배포: supabase functions deploy push-send
// 시크릿(한 번): supabase secrets set VAPID_PRIVATE_KEY=... VAPID_PUBLIC_KEY=... VAPID_SUBJECT=mailto:ops@bonanzacoffee.kr
// (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 는 기본 주입됨)
//
// 요청 바디(JSON): { session_token, mode, ... }
//   mode='test'                → 호출자 본인 기기에 테스트 발송
//   mode='inventory_reminders' + {ym}  → 실사 D-1 사전알림 / 기한초과 매일1회 리마인드(일일 중복방지)
//   mode='transfer_arrived'    + {to_store,item,qty,from_store} → 받는 매장 기기에 이관도착 알림
// 모든 발송은 service role 로 서버에서 대상 조회 후 VAPID 서명 발송.
// ============================================================================
import webpush from 'npm:web-push@3.6.7';
import { createClient } from 'npm:@supabase/supabase-js@2.45.0';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const SB_URL = Deno.env.get('SUPABASE_URL')!;
const SB_SVC = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const VAPID_PUB = Deno.env.get('VAPID_PUBLIC_KEY')!;
const VAPID_PRIV = Deno.env.get('VAPID_PRIVATE_KEY')!;
const VAPID_SUB = Deno.env.get('VAPID_SUBJECT') || 'mailto:ops@bonanzacoffee.kr';

webpush.setVapidDetails(VAPID_SUB, VAPID_PUB, VAPID_PRIV);
const admin = createClient(SB_URL, SB_SVC, { auth: { persistSession: false } });

function kstDate(d = new Date()): string {
  const k = new Date(d.getTime() + 9 * 3600 * 1000);
  return k.toISOString().slice(0, 10);
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

// 세션 토큰 → 사용자(검증)
async function resolveUser(token: string) {
  if (!token) return null;
  const { data } = await admin.from('app_sessions').select('user_id').eq('token', token).maybeSingle();
  if (!data) return null;
  const { data: u } = await admin.from('users').select('id,name,store,is_master,role,part').eq('id', data.user_id).maybeSingle();
  return u || null;
}

async function sendToSubs(subs: any[], payload: object) {
  let ok = 0, gone: number[] = [];
  const body = JSON.stringify(payload);
  for (const s of subs) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body);
      ok++;
    } catch (err: any) {
      const code = err && err.statusCode;
      if (code === 404 || code === 410) gone.push(s.id); // 만료 구독 정리
    }
  }
  if (gone.length) await admin.from('push_subscriptions').update({ active: false }).in('id', gone);
  return ok;
}

async function activeSubsForStores(stores: string[]) {
  if (!stores.length) return [];
  const { data } = await admin.from('push_subscriptions').select('id,endpoint,p256dh,auth,store,user_id').eq('active', true).in('store', stores);
  return data || [];
}

// 하루 1회 중복방지 (app_settings)
async function onceToday(key: string): Promise<boolean> {
  const today = kstDate();
  const lockKey = key + '_' + today;
  const { data } = await admin.from('app_settings').select('value').eq('key', lockKey).maybeSingle();
  if (data && String(data.value) === '1') return false;
  await admin.from('app_settings').upsert({ key: lockKey, value: '1' }, { onConflict: 'key' });
  return true;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const b = await req.json().catch(() => ({}));
    const user = await resolveUser(b.session_token);
    if (!user) return json({ error: 'unauthorized' }, 401);
    const mode = b.mode || 'test';

    if (mode === 'test') {
      const { data: mine } = await admin.from('push_subscriptions').select('id,endpoint,p256dh,auth').eq('user_id', user.id).eq('active', true);
      const n = await sendToSubs(mine || [], { title: '보난자 운영', body: '모바일 알림이 정상 등록되었습니다.', tag: 'test', url: './index.html' });
      return json({ ok: true, sent: n });
    }

    if (mode === 'transfer_arrived') {
      if (!b.to_store) return json({ error: 'no_store' }, 400);
      const subs = await activeSubsForStores([b.to_store]);
      const n = await sendToSubs(subs, {
        title: '📦 타 매장 이관 도착',
        body: `${b.from_store || ''}점에서 ${b.item || '품목'} ${b.qty || ''}개가 이관 도착했습니다. 수령 확인을 해주세요.`,
        tag: 'transfer', url: './index.html',
      });
      return json({ ok: true, sent: n });
    }

    if (mode === 'inventory_reminders') {
      const ym = b.ym; if (!ym) return json({ error: 'no_ym' }, 400);
      const { data: season } = await admin.from('closing_seasons').select('inv_start,inv_end').eq('ym', ym).maybeSingle();
      if (!season || !season.inv_end) return json({ ok: true, skipped: 'no_season' });
      const now = new Date();
      const end = new Date(season.inv_end);
      const dayMs = 86400000;
      const diffDays = Math.floor((now.getTime() - end.getTime()) / dayMs);

      // 확정 매장 제외 대상 조회
      const { data: stRows } = await admin.from('closing_inv_status').select('store,status').eq('ym', ym);
      const confirmed = new Set((stRows || []).filter((r: any) => r.status === 'confirmed').map((r: any) => r.store));
      const { data: allStores } = await admin.from('store_options').select('name').neq('name', '본사');
      const targetStores = (allStores || []).map((s: any) => s.name).filter((s: string) => !confirmed.has(s));

      // D-1 사전 알림 (마감 하루 전, 하루 1회)
      if (now < end && (end.getTime() - now.getTime()) <= dayMs) {
        if (!(await onceToday('inv_remind_d1_' + ym))) return json({ ok: true, deduped: 'd1' });
        const subs = await activeSubsForStores(targetStores);
        const n = await sendToSubs(subs, { title: '⏰ 실사 재고 마감 D-1', body: '내일이 월말 실사 재고 입력 마감입니다. 오늘 안에 제출해 주세요.', tag: 'inv-d1', url: './index.html' });
        return json({ ok: true, mode: 'd1', sent: n });
      }
      // 기한 초과 리마인드 (매일 1회)
      if (diffDays >= 0 && targetStores.length) {
        if (!(await onceToday('inv_remind_over_' + ym))) return json({ ok: true, deduped: 'overdue' });
        const subs = await activeSubsForStores(targetStores);
        const n = await sendToSubs(subs, {
          title: `🚨 실사 마감 D+${diffDays} 경과`,
          body: `아직 실사 재고가 미완료입니다. (마감 ${diffDays}일 경과) 지금 입력/확정해 주세요.`,
          tag: 'inv-over', url: './index.html',
        });
        return json({ ok: true, mode: 'overdue', dplus: diffDays, sent: n, stores: targetStores.length });
      }
      return json({ ok: true, skipped: 'not_due' });
    }

    return json({ error: 'unknown_mode' }, 400);
  } catch (e) {
    return json({ error: String(e && (e as any).message || e) }, 500);
  }
});
