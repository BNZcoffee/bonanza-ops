/* ============================================================================
 * 매장 재고 관리 (모듈 A) — inventory_helper.js
 * 전 직원(매니저/팀원/PT) 접근. 소속 매장(겸직 포함)만 조회·입력(서버 RPC 재검증).
 *   · 폐기(Loss) / 타매장 이관 = 취합 시즌 무관, 최종 잠금 전까지 상시
 *   · 월말 실사 = 취합 시즌에만 활성, 팀원/PT 금액 블라인드 → 매니저 확정(2단계)
 *   · 웹푸시 구독 배너 + 마감 D-1/D+N 경과 앱내 경고 배너
 * 모든 데이터 접근은 Secure RPC(ch_*)만 사용(RLS Deny). RPC 미존재 시 안내.
 * ==========================================================================*/
(function () {
  'use strict';
  if (window.InventoryMgr) return;
  const IM = (window.InventoryMgr = {});
  const esc = (s) => (window.esc ? window.esc(s) : String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  const sbc = () => window.sb;
  const won = (n) => (Math.round(Number(n) || 0)).toLocaleString('ko-KR');
  const token = () => (typeof getSessionToken === 'function' ? getSessionToken() : (window.__sessionToken || null));
  const VAPID_PUBLIC = 'BIp3aHtVad0aurIhoZZyg22vPQPi4IjrKDSqjAIHnvEggZYObS_zK2Qw4UQAZ3U3-lvdoZFApxS6mU63fdImesY';
  const PUSH_FN_URL = (window.SUPABASE_URL || '') + '/functions/v1/push-send';
  const PUSH_ANON = window.SUPABASE_KEY || '';

  async function rpc(name, args) {
    const { data, error } = await sbc().rpc(name, Object.assign({ p_token: token() }, args || {}));
    if (error) { if (/does not exist|could not find|schema cache/i.test(error.message || '')) { const e = new Error('RPC_MISSING'); e.missing = true; throw e; } throw error; }
    return data;
  }
  IM._rpc = rpc;
  function toast(m) { if (window.ClosingHelper && window.ClosingHelper._toast) return window.ClosingHelper._toast(m); try { alert(m); } catch (_) {} }
  function modal(t, body, ok, onOk) {
    if (window.ClosingHelper && window.ClosingHelper.modal) return window.ClosingHelper.modal(t, body, ok, onOk);
    const old = document.getElementById('imModal'); if (old) old.remove();
    const m = document.createElement('div'); m.id = 'imModal'; m.className = 'modal-bg open';
    m.innerHTML = '<div class="modal-box" style="max-width:560px;width:95%"><div class="modal-title">' + esc(t) + '</div><div style="max-height:64vh;overflow:auto;padding:2px 2px 10px">' + body + '</div><div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px"><button class="btn-cancel-sm" onclick="document.getElementById(\'imModal\').remove()">취소</button><button class="btn-submit" id="imModalOk">' + esc(ok || '확인') + '</button></div></div>';
    document.body.appendChild(m);
    document.getElementById('imModalOk').onclick = async function () { this.disabled = true; let close = true; try { if (onOk) close = (await onOk()) !== false; } catch (e) { alert('오류: ' + (e.message || e)); close = false; } this.disabled = false; if (close) { const mm = document.getElementById('imModal'); if (mm) mm.remove(); } };
  }
  IM.modal = modal;

  /* ───────── 권한 / 매장 스코프 ───────── */
  function cu() { return window.currentUser || {}; }
  function isHQ() { const u = cu(); return !!(u.is_master || u.is_vice_master || u.role === 'admin' || u.role === 'dept' || u.store === '본사'); }
  function isPriv() { const u = cu(); return !!(u.is_master || u.is_vice_master || u.position === '매니저' || u.position === '매니저B' || isHQ()); }
  function myStores() {
    const u = cu();
    if (isHQ()) return window.__imStores || [];
    const arr = []; if (u.store && u.store !== '본사') arr.push(u.store);
    const sub = Array.isArray(u.sub_stores) ? u.sub_stores : []; sub.forEach(s => { if (s && arr.indexOf(s) < 0) arr.push(s); });
    return arr;
  }
  async function loadStoreOptions() { if (window.__imStores) return window.__imStores; try { const { data } = await sbc().from('store_options').select('name,sort_order').order('sort_order'); window.__imStores = (data || []).map(s => s.name).filter(n => n && n !== '본사'); } catch (e) { window.__imStores = []; } return window.__imStores; }

  IM.state = { tab: 'loss', store: '', ym: (new Date()).toISOString().slice(0, 7) };
  function ensureStore() { const sts = myStores(); if (!IM.state.store || sts.indexOf(IM.state.store) === -1) IM.state.store = sts.length ? sts[0] : ''; }

  IM.canAccess = function () { return !!window.currentUser; };
  IM.navVisible = function () { return !!window.currentUser; };
  IM.applyNav = function () { const el = document.getElementById('nav-inventory'); if (el) el.style.display = IM.navVisible() ? '' : 'none'; };

  /* ───────── 메인 렌더 ───────── */
  IM.render = async function (area) {
    area = area || document.getElementById('contentArea'); if (!area) return;
    if (!IM.canAccess()) { area.innerHTML = '<div style="text-align:center;padding:60px;color:var(--th)">로그인이 필요합니다.</div>'; return; }
    await loadStoreOptions();
    ensureStore();
    const tabs = [['loss', '폐기(Loss)', 'ti-trash'], ['transfer', '타매장 이관', 'ti-transfer'], ['count', '월말 실사', 'ti-clipboard-list']];
    if (isHQ()) tabs.push(['hq', '제출현황 / 시즌', 'ti-dashboard']);
    const tab = IM.state.tab;
    const tb = (k, label, icon) => '<button onclick="InventoryMgr.goTab(\'' + k + '\')" style="flex:1;padding:10px 6px;border:none;border-bottom:2.5px solid ' + (tab === k ? 'var(--br,#8a5a2b)' : 'transparent') + ';background:none;font-size:13px;font-weight:' + (tab === k ? '700' : '500') + ';color:' + (tab === k ? 'var(--br,#8a5a2b)' : 'var(--th)') + ';cursor:pointer"><i class="ti ' + icon + '"></i> ' + label + '</button>';
    const sts = myStores();
    const storeSel = (!isHQ() && sts.length <= 1)
      ? '<span style="font-size:14px;font-weight:700"><i class="ti ti-building-store"></i> ' + esc(sts[0] || '담당 매장 없음') + '</span>'
      : '<select class="form-input" style="width:170px" onchange="InventoryMgr.onStore(this.value)">' + sts.map(s => '<option' + (s === IM.state.store ? ' selected' : '') + '>' + esc(s) + '</option>').join('') + '</select>';
    area.innerHTML =
      '<div style="max-width:1120px;margin:0 auto;padding:4px 2px 48px">'
      + '<div style="display:flex;align-items:center;gap:10px;margin-bottom:4px;flex-wrap:wrap"><h2 style="font-size:19px;font-weight:800;margin:0"><i class="ti ti-building-warehouse" style="color:var(--br,#8a5a2b)"></i> 매장 재고 관리</h2>'
      + '<span style="margin-left:auto;display:flex;gap:8px;align-items:center">' + storeSel + '<input type="month" class="form-input" style="width:140px" value="' + IM.state.ym + '" onchange="InventoryMgr.onYm(this.value)"></span></div>'
      + '<div id="imBanner"></div>'
      + '<div style="display:flex;border-bottom:0.5px solid var(--crd);margin:8px 0 14px">' + tabs.map(t => tb(t[0], t[1], t[2])).join('') + '</div>'
      + '<div id="imBody"></div></div>';
    IM.renderBanner();
    if (tab === 'loss') IM.renderLoss(); else if (tab === 'transfer') IM.renderTransfer(); else if (tab === 'count') IM.renderCount(); else IM.renderHQ();
  };
  IM.goTab = function (k) { IM.state.tab = k; IM.render(); };
  IM.onStore = function (v) { IM.state.store = v; IM.render(); };
  IM.onYm = function (v) { IM.state.ym = v; IM.render(); };

  /* ───────── 상단 배너: 푸시 구독 + 마감 경고 ───────── */
  IM.renderBanner = async function () {
    const box = document.getElementById('imBanner'); if (!box) return; let html = '';
    // 마감 D-1/D+N 경고 (현재 매장 기준)
    if (IM.state.store) {
      try {
        const s = await rpc('ch_inv_season', { p_store: IM.state.store, p_ym: IM.state.ym });
        if (s && s.overdue) html += '<div style="background:#FEE2E2;color:#991B1B;border-radius:8px;padding:9px 12px;margin-bottom:8px;font-size:13px;font-weight:700"><i class="ti ti-alert-triangle"></i> 실사 재고 마감 D+' + s.d_plus + '일 경과 — 미완료 상태입니다. ' + (isPriv() ? '입력/확정' : '실사 입력') + '을 서둘러 주세요.' + (s.reject_note ? ' (본사 보완요청: ' + esc(s.reject_note) + ')' : '') + '</div>';
        else if (s && s.d_minus1) html += '<div style="background:#FEF3C7;color:#92400E;border-radius:8px;padding:9px 12px;margin-bottom:8px;font-size:13px;font-weight:700"><i class="ti ti-clock"></i> 실사 재고 마감 D-1 — 내일 마감입니다. 오늘 안에 제출해 주세요.</div>';
        else if (s && s.status === 'rejected') html += '<div style="background:#FEF3C7;color:#92400E;border-radius:8px;padding:9px 12px;margin-bottom:8px;font-size:13px"><i class="ti ti-rotate"></i> 본사 보완요청(반려) 상태입니다' + (s.reject_note ? ': ' + esc(s.reject_note) : '') + '. 수정 후 다시 제출해 주세요.</div>';
      } catch (e) {}
    }
    // 웹푸시 구독 배너
    html += IM.pushBannerHtml();
    box.innerHTML = html;
  };
  IM.pushSupported = function () { return ('serviceWorker' in navigator) && ('PushManager' in window) && ('Notification' in window); };
  IM.pushBannerHtml = function () {
    try { if (localStorage.getItem('im_push_dismiss') === '1') return ''; } catch (_) {}
    const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
    const standalone = (window.navigator.standalone === true) || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
    if (!IM.pushSupported()) {
      if (isIOS && !standalone) return '<div style="background:#EFF6FF;color:#1E40AF;border-radius:8px;padding:9px 12px;margin-bottom:8px;font-size:12.5px"><i class="ti ti-device-mobile"></i> 아이폰은 Safari 공유 → <b>홈 화면에 추가</b> 후 앱으로 열면 마감·이관 푸시 알림을 받을 수 있어요. <button onclick="InventoryMgr.dismissPush()" style="float:right;background:none;border:none;color:#1E40AF;cursor:pointer;font-size:12px">닫기</button></div>';
      return '';
    }
    if (Notification.permission === 'granted') return '';
    return '<div style="background:#EFF6FF;color:#1E40AF;border-radius:8px;padding:9px 12px;margin-bottom:8px;font-size:13px;display:flex;align-items:center;gap:8px"><i class="ti ti-bell-ringing"></i><span style="flex:1">🔔 모바일 마감·이관 알림 받기 — 슬랙을 안 봐도 스마트폰 푸시로 알려드려요.</span><button class="btn-submit" style="font-size:12px;padding:5px 12px" onclick="InventoryMgr.subscribePush()">알림 받기</button><button onclick="InventoryMgr.dismissPush()" style="background:none;border:none;color:#1E40AF;cursor:pointer">✕</button></div>';
  };
  IM.dismissPush = function () { try { localStorage.setItem('im_push_dismiss', '1'); } catch (_) {} IM.renderBanner(); };
  function urlB64ToUint8(b) { const pad = '='.repeat((4 - b.length % 4) % 4); const s = (b + pad).replace(/-/g, '+').replace(/_/g, '/'); const raw = atob(s); const a = new Uint8Array(raw.length); for (let i = 0; i < raw.length; i++) a[i] = raw.charCodeAt(i); return a; }
  IM.subscribePush = async function () {
    if (!IM.pushSupported()) { toast('이 기기는 웹푸시를 지원하지 않습니다'); return; }
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') { toast('알림 권한이 거부되었습니다'); return; }
      await navigator.serviceWorker.register('./sw.js');
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8(VAPID_PUBLIC) });
      const j = sub.toJSON();
      await rpc('ch_push_subscribe', { p_endpoint: sub.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth, p_ua: navigator.userAgent });
      toast('모바일 알림이 등록되었습니다'); IM.renderBanner();
    } catch (e) { toast('알림 등록 실패: ' + (e.message || e)); }
  };
  // Edge Function 호출(푸시 발송 트리거)
  IM.pushSend = async function (payload) {
    try {
      await fetch(PUSH_FN_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + PUSH_ANON, 'apikey': PUSH_ANON }, body: JSON.stringify(Object.assign({ session_token: token() }, payload)) });
    } catch (e) {}
  };

  /* ======================================================================
   * [탭] 폐기(Loss) — 상시 입력, 5분류, 재고/비재고, 당월 요약
   * ==================================================================== */
  IM.renderLoss = async function () {
    const b = document.getElementById('imBody'); if (!b) return;
    b.innerHTML = '<div style="padding:20px;text-align:center;color:var(--th)">불러오는 중…</div>';
    if (!IM.state.store) { b.innerHTML = '<div style="padding:24px;text-align:center;color:var(--th)">담당 매장이 없습니다</div>'; return; }
    let cats = [], res = { items: [], total_qty: 0 };
    try { cats = await rpc('ch_loss_cats', {}) || []; } catch (e) {}
    try { res = await rpc('ch_loss_list', { p_store: IM.state.store, p_ym: IM.state.ym }) || res; } catch (e) { if (e.missing) { b.innerHTML = '<div style="padding:24px;text-align:center;color:#B91C1C">보안 SQL 미실행 — closing_inventory_mgmt.sql 을 먼저 실행하세요</div>'; return; } }
    window.__imLossCats = cats;
    const items = res.items || [];
    const invItems = items.filter(x => x.is_inventory_item), etcItems = items.filter(x => !x.is_inventory_item);
    const catName = c => { const x = cats.find(k => k.code === c); return x ? x.name : (c || '-'); };
    const rowHtml = l => '<tr><td style="padding:4px 8px;border-bottom:0.5px solid var(--crm,#eee)">' + esc(String(l.loss_date || '').slice(5)) + '</td><td style="padding:4px 8px;border-bottom:0.5px solid var(--crm,#eee)">' + esc(catName(l.loss_cat)) + '</td><td style="padding:4px 8px;border-bottom:0.5px solid var(--crm,#eee)">' + esc(l.item) + '</td><td style="padding:4px 8px;border-bottom:0.5px solid var(--crm,#eee);text-align:right">' + (l.qty || '') + '</td><td style="padding:4px 8px;border-bottom:0.5px solid var(--crm,#eee);font-size:11px;color:var(--th)">' + esc(l.memo || '') + '</td><td style="padding:4px 8px;border-bottom:0.5px solid var(--crm,#eee);text-align:center"><button onclick="InventoryMgr.delLoss(' + l.id + ')" style="background:none;border:none;color:#B91C1C;cursor:pointer;font-size:12px">✕</button></td></tr>';
    const tbl = (title, arr) => '<div style="font-size:12px;font-weight:700;margin:10px 0 4px">' + title + ' <span style="font-size:11px;color:var(--th)">(' + arr.length + '건)</span></div>' + '<table style="width:100%;border-collapse:collapse;font-size:12px;background:#fff;border:0.5px solid var(--crd);border-radius:8px;overflow:hidden"><thead><tr style="background:var(--cr,#faf7f2)"><th style="padding:5px 8px;text-align:left">일자</th><th style="padding:5px 8px;text-align:left">분류</th><th style="padding:5px 8px;text-align:left">품목</th><th style="padding:5px 8px;text-align:right">수량</th><th style="padding:5px 8px;text-align:left">사유</th><th style="padding:5px 8px"></th></tr></thead><tbody>' + (arr.length ? arr.map(rowHtml).join('') : '<tr><td colspan="6" style="padding:12px;text-align:center;color:var(--th)">내역 없음</td></tr>') + '</tbody></table>';
    b.innerHTML =
      '<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;flex-wrap:wrap"><div style="background:var(--cr,#faf7f2);border:0.5px solid var(--crd);border-radius:8px;padding:8px 14px;font-size:13px">' + IM.state.ym + ' 우리 매장 총 폐기 <b style="color:#B91C1C">' + won(res.total_qty) + '</b> 건(수량 합)</div>'
      + '<button class="btn-submit" style="font-size:12px;margin-left:auto" onclick="InventoryMgr.openLossAdd()"><i class="ti ti-plus"></i> 폐기 등록</button></div>'
      + tbl('재고 마스터 품목 폐기', invItems) + tbl('기타 / 비재고 폐기', etcItems);
  };
  IM.openLossAdd = function () {
    const cats = window.__imLossCats || [];
    const catOpts = cats.map(c => '<option value="' + esc(c.code) + '">' + esc(c.name) + '</option>').join('');
    const today = (new Date()).toISOString().slice(0, 10);
    modal(IM.state.store + ' 폐기 등록',
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">'
      + '<div><label style="font-size:11px;color:var(--th)">일자</label><input id="loDate" type="date" class="form-input" value="' + today + '"></div>'
      + '<div><label style="font-size:11px;color:var(--th)">분류</label><select id="loCat" class="form-input">' + catOpts + '</select></div>'
      + '<div><label style="font-size:11px;color:var(--th)">수량</label><input id="loQty" type="number" step="0.01" class="form-input"></div>'
      + '<div><label style="font-size:11px;color:var(--th)">구분</label><select id="loInv" class="form-input"><option value="1">재고 마스터 품목</option><option value="0">기타 / 비재고</option></select></div>'
      + '<div style="grid-column:1/3"><label style="font-size:11px;color:var(--th)">품목명</label><input id="loItem" class="form-input" placeholder="품목명"></div>'
      + '<div style="grid-column:1/3"><label style="font-size:11px;color:var(--th)">사유 메모</label><input id="loMemo" class="form-input" placeholder="예: 유통기한 경과 폐기"></div>'
      + '</div><div id="loMsg" style="font-size:12px;color:#B91C1C;margin-top:6px;min-height:14px"></div>',
      '등록', async function () {
        const item = (document.getElementById('loItem').value || '').trim(), qty = Number(document.getElementById('loQty').value || 0);
        if (!item || !qty) { document.getElementById('loMsg').textContent = '품목/수량을 입력하세요'; return false; }
        try { await rpc('ch_loss_add', { p_store: IM.state.store, p_ym: IM.state.ym, p_date: document.getElementById('loDate').value, p_cat: document.getElementById('loCat').value, p_vendor: null, p_item: item, p_qty: qty, p_is_inv: document.getElementById('loInv').value === '1', p_memo: document.getElementById('loMemo').value.trim() || null }); }
        catch (e) { document.getElementById('loMsg').textContent = /MONTH_LOCKED/.test(e.message || '') ? '월마감 잠금 상태' : (e.missing ? '보안 SQL 미실행' : '오류: ' + e.message); return false; }
        toast('폐기 등록 완료'); IM.renderLoss(); return true;
      });
  };
  IM.delLoss = async function (id) { if (!confirm('이 폐기 내역을 삭제할까요?')) return; try { await rpc('ch_loss_del', { p_id: id }); toast('삭제 완료'); IM.renderLoss(); } catch (e) { alert('오류: ' + (/MONTH_LOCKED/.test(e.message || '') ? '월마감 잠금' : e.message)); } };

  /* ======================================================================
   * [탭] 타매장 이관 — 상시, 양쪽 사용량 메모 배지, 받는 매장 푸시
   * ==================================================================== */
  IM.renderTransfer = async function () {
    const b = document.getElementById('imBody'); if (!b) return;
    b.innerHTML = '<div style="padding:20px;text-align:center;color:var(--th)">불러오는 중…</div>';
    if (!IM.state.store) { b.innerHTML = '<div style="padding:24px;text-align:center;color:var(--th)">담당 매장이 없습니다</div>'; return; }
    let list = [];
    try { list = await rpc('ch_transfer_list', { p_store: IM.state.store, p_ym: IM.state.ym }) || []; } catch (e) { if (e.missing) { b.innerHTML = '<div style="padding:24px;text-align:center;color:#B91C1C">보안 SQL 미실행</div>'; return; } }
    const badge = t => t.dir === 'out'
      ? '<span style="font-size:11px;background:#FEE2E2;color:#B91C1C;border-radius:5px;padding:2px 7px">📝 ' + esc(String(t.date || '').slice(5)) + ' ' + esc(t.to_store) + '점 이관(-' + t.qty + ')</span>'
      : '<span style="font-size:11px;background:#DCFCE7;color:#15803D;border-radius:5px;padding:2px 7px">📝 ' + esc(String(t.date || '').slice(5)) + ' ' + esc(t.from_store) + '점 수령(+' + t.qty + ')</span>';
    const rows = list.map(t => '<tr><td style="padding:5px 8px;border-bottom:0.5px solid var(--crm,#eee)">' + badge(t) + '</td><td style="padding:5px 8px;border-bottom:0.5px solid var(--crm,#eee)">' + esc(t.item) + '</td><td style="padding:5px 8px;border-bottom:0.5px solid var(--crm,#eee);text-align:right">' + t.qty + '</td></tr>').join('');
    b.innerHTML =
      '<div style="display:flex;align-items:center;margin-bottom:8px"><div style="font-size:12px;color:var(--th)">보내는 매장이 등록하면 받는 매장 입재고 사용량에 자동 반영되고, 받는 매장에 알림이 갑니다.</div><button class="btn-submit" style="font-size:12px;margin-left:auto" onclick="InventoryMgr.openTransferAdd()"><i class="ti ti-plus"></i> 이관 등록</button></div>'
      + '<table style="width:100%;border-collapse:collapse;font-size:12px;background:#fff;border:0.5px solid var(--crd);border-radius:8px;overflow:hidden"><thead><tr style="background:var(--cr,#faf7f2)"><th style="padding:5px 8px;text-align:left">이관/수령</th><th style="padding:5px 8px;text-align:left">품목</th><th style="padding:5px 8px;text-align:right">수량</th></tr></thead><tbody>' + (rows || '<tr><td colspan="3" style="padding:12px;text-align:center;color:var(--th)">내역 없음</td></tr>') + '</tbody></table>';
  };
  IM.openTransferAdd = async function () {
    const opts = await loadStoreOptions();
    const today = (new Date()).toISOString().slice(0, 10);
    const toOpts = '<option value="">(받는 매장 선택)</option>' + opts.filter(s => s !== IM.state.store).map(s => '<option>' + esc(s) + '</option>').join('');
    modal(IM.state.store + ' → 타매장 이관 등록',
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">'
      + '<div><label style="font-size:11px;color:var(--th)">보내는 매장</label><input class="form-input" value="' + esc(IM.state.store) + '" disabled></div>'
      + '<div><label style="font-size:11px;color:var(--th)">받는 매장</label><select id="trTo" class="form-input">' + toOpts + '</select></div>'
      + '<div><label style="font-size:11px;color:var(--th)">일자</label><input id="trDate" type="date" class="form-input" value="' + today + '"></div>'
      + '<div><label style="font-size:11px;color:var(--th)">수량</label><input id="trQty" type="number" step="0.01" class="form-input"></div>'
      + '<div style="grid-column:1/3"><label style="font-size:11px;color:var(--th)">품목명</label><input id="trItem" class="form-input" placeholder="품목명"></div>'
      + '</div><div id="trMsg" style="font-size:12px;color:#B91C1C;margin-top:6px;min-height:14px"></div>',
      '등록', async function () {
        const to = document.getElementById('trTo').value, item = (document.getElementById('trItem').value || '').trim(), qty = Number(document.getElementById('trQty').value || 0);
        if (!to || !item || !qty) { document.getElementById('trMsg').textContent = '받는 매장/품목/수량을 입력하세요'; return false; }
        try { await rpc('ch_transfer_add', { p_from: IM.state.store, p_to: to, p_date: document.getElementById('trDate').value, p_vendor: null, p_item: item, p_qty: qty }); }
        catch (e) { document.getElementById('trMsg').textContent = e.missing ? '보안 SQL 미실행' : (/ACCESS_DENIED/.test(e.message || '') ? '접근 권한 없음' : '오류: ' + e.message); return false; }
        IM.pushSend({ mode: 'transfer_arrived', to_store: to, from_store: IM.state.store, item: item, qty: qty });
        toast('이관 등록 완료 — ' + to + '점에 알림 발송'); IM.renderTransfer(); return true;
      });
  };

  /* ======================================================================
   * [탭] 월말 실사 — 시즌 활성 + 블라인드 2단계
   * ==================================================================== */
  IM.renderCount = async function () {
    const b = document.getElementById('imBody'); if (!b) return;
    b.innerHTML = '<div style="padding:20px;text-align:center;color:var(--th)">불러오는 중…</div>';
    if (!IM.state.store) { b.innerHTML = '<div style="padding:24px;text-align:center;color:var(--th)">담당 매장이 없습니다</div>'; return; }
    let season = {}, inv = { items: [], blind: true, locked: false };
    try { season = await rpc('ch_inv_season', { p_store: IM.state.store, p_ym: IM.state.ym }) || {}; } catch (e) { if (e.missing) { b.innerHTML = '<div style="padding:24px;text-align:center;color:#B91C1C">보안 SQL 미실행 — closing_inventory_mgmt.sql 을 먼저 실행하세요</div>'; return; } }
    try { inv = await rpc('ch_inv_list', { p_store: IM.state.store, p_ym: IM.state.ym }) || inv; } catch (e) {}
    const open = !!season.open, blind = inv.blind !== false, priv = !blind;
    const statusTxt = { none: '미제출', submitted: '제출됨(매니저 확인 대기)', confirmed: '최종 확정 완료', rejected: '본사 보완요청(반려)' }[season.status || 'none'];
    const seasonLine = season.season_set
      ? (IM.state.ym + ' 실사 기간 ' + (season.inv_start ? String(season.inv_start).slice(0, 16).replace('T', ' ') : '') + ' ~ ' + (season.inv_end ? String(season.inv_end).slice(0, 16).replace('T', ' ') : ''))
      : (IM.state.ym + ' 실사 시즌 미설정 (상시 입력 가능)');
    let head = '<div style="background:var(--cr,#faf7f2);border:0.5px solid var(--crd);border-radius:8px;padding:9px 12px;margin-bottom:10px;font-size:12.5px"><i class="ti ti-calendar-stats"></i> ' + esc(seasonLine) + ' · 상태: <b>' + statusTxt + '</b>' + (season.d_plus ? ' · <span style="color:#B91C1C">D+' + season.d_plus + ' 경과</span>' : '') + (season.locked ? ' · <span style="color:#B91C1C">월마감 잠금</span>' : '') + '</div>';
    if (!open) { b.innerHTML = head + '<div style="padding:24px;text-align:center;color:var(--th)">' + (season.locked ? '월마감 잠금 상태라 입력할 수 없습니다.' : (season.status === 'confirmed' ? '이미 최종 확정되었습니다.' : '현재 실사 입력 기간이 아닙니다. (본사 설정 시즌에만 활성화)')) + '</div>'; return; }
    const items = inv.items || [];
    const rowHtml = (it, i) => '<tr data-i="' + i + '">'
      + '<td style="padding:3px"><input class="iv-cat form-input" style="font-size:12px;padding:4px;width:84px" value="' + esc(it ? it.category || '' : '') + '" placeholder="분류"></td>'
      + '<td style="padding:3px"><input class="iv-item form-input" style="font-size:12px;padding:4px" value="' + esc(it ? it.item || '' : '') + '" placeholder="품명"></td>'
      + '<td style="padding:3px"><input class="iv-spec form-input" style="font-size:12px;padding:4px;width:120px" value="' + esc(it ? it.spec || '' : '') + '" placeholder="규격(예: 1박스=20줄)"></td>'
      + '<td style="padding:3px"><input class="iv-unit form-input" style="font-size:12px;padding:4px;width:64px" value="' + esc(it ? it.unit || '' : '') + '" placeholder="단위"></td>'
      + '<td style="padding:3px"><input class="iv-qty form-input" type="number" step="0.01" style="font-size:12px;padding:4px;width:76px;text-align:right" value="' + (it && it.count_qty != null ? it.count_qty : '') + '"></td>'
      + (priv ? '<td style="padding:3px"><input class="iv-price form-input" type="number" style="font-size:12px;padding:4px;width:90px;text-align:right" value="' + (it && it.unit_price != null ? it.unit_price : '') + '" placeholder="단가"></td>' : '')
      + '<td style="padding:3px;text-align:center"><button onclick="this.closest(\'tr\').remove()" style="background:none;border:none;color:#B91C1C;cursor:pointer">✕</button></td></tr>';
    const bodyRows = (items.length ? items : [null, null, null]).map((it, i) => rowHtml(it, i)).join('');
    head += '<div style="font-size:12px;color:var(--th);margin-bottom:6px">' + (blind ? '팀원/PT 모드 — 분류/품명/규격/단위/실사수량만 입력합니다. (금액·단가·원가는 매니저 확정 단계에서 표시)' : '매니저 모드 — 금액·단가 검수 후 [최종 마감 확정]을 눌러 주세요.') + '</div>';
    head += '<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr style="background:var(--cr,#faf7f2)"><th style="padding:4px">분류</th><th style="padding:4px">품명</th><th style="padding:4px">규격/단위기준</th><th style="padding:4px">단위</th><th style="padding:4px">실사수량</th>' + (priv ? '<th style="padding:4px">단가</th>' : '') + '<th></th></tr></thead><tbody id="ivRows">' + bodyRows + '</tbody></table></div>';
    head += '<button class="btn-cancel-sm" style="font-size:12px;margin-top:6px" onclick="InventoryMgr.addRow()"><i class="ti ti-plus"></i> 행 추가</button>';
    head += '<div style="display:flex;gap:8px;margin-top:12px">'
      + '<button class="btn-submit" style="font-size:13px" onclick="InventoryMgr.saveCount(false)"><i class="ti ti-device-floppy"></i> ' + (blind ? '실사 제출 (매니저 확인 대기)' : '수량 저장') + '</button>'
      + (priv ? '<button class="btn-submit" style="font-size:13px;background:#15803D" onclick="InventoryMgr.saveCount(true)"><i class="ti ti-circle-check"></i> 최종 마감 확정</button>' : '')
      + '</div>';
    b.innerHTML = head;
  };
  IM.addRow = function () { const tb = document.getElementById('ivRows'); if (!tb) return; const priv = !!document.querySelector('.iv-price'); const tr = document.createElement('tr'); tr.innerHTML = '<td style="padding:3px"><input class="iv-cat form-input" style="font-size:12px;padding:4px;width:84px" placeholder="분류"></td><td style="padding:3px"><input class="iv-item form-input" style="font-size:12px;padding:4px" placeholder="품명"></td><td style="padding:3px"><input class="iv-spec form-input" style="font-size:12px;padding:4px;width:120px" placeholder="규격"></td><td style="padding:3px"><input class="iv-unit form-input" style="font-size:12px;padding:4px;width:64px" placeholder="단위"></td><td style="padding:3px"><input class="iv-qty form-input" type="number" step="0.01" style="font-size:12px;padding:4px;width:76px;text-align:right"></td>' + (priv ? '<td style="padding:3px"><input class="iv-price form-input" type="number" style="font-size:12px;padding:4px;width:90px;text-align:right" placeholder="단가"></td>' : '') + '<td style="padding:3px;text-align:center"><button onclick="this.closest(\'tr\').remove()" style="background:none;border:none;color:#B91C1C;cursor:pointer">✕</button></td>'; tb.appendChild(tr); };
  IM.saveCount = async function (confirmFinal) {
    const rows = Array.from(document.querySelectorAll('#ivRows tr')).map(tr => {
      const g = c => { const el = tr.querySelector(c); return el ? el.value.trim() : ''; };
      const r = { vendor_slug: null, item: g('.iv-item'), category: g('.iv-cat'), spec: g('.iv-spec'), unit: g('.iv-unit'), count_qty: g('.iv-qty') };
      const p = tr.querySelector('.iv-price'); if (p) r.unit_price = p.value.trim();
      return r;
    }).filter(r => r.item);
    if (!rows.length) { toast('입력된 품목이 없습니다'); return; }
    try {
      if (confirmFinal) { if (!confirm('최종 마감 확정하면 해당 월 실사가 확정됩니다. 계속할까요?')) return; await rpc('ch_inv_confirm', { p_store: IM.state.store, p_ym: IM.state.ym, p_rows: rows }); toast('최종 마감 확정 완료'); }
      else { await rpc('ch_inv_count_save', { p_store: IM.state.store, p_ym: IM.state.ym, p_rows: rows }); toast('실사 제출 완료'); }
    } catch (e) { alert('오류: ' + (/SEASON_CLOSED/.test(e.message || '') ? '실사 입력 기간이 아닙니다' : (/MONTH_LOCKED/.test(e.message || '') ? '월마감 잠금' : (/ACCESS_DENIED/.test(e.message || '') ? '권한 없음' : (e.missing ? '보안 SQL 미실행' : e.message))))); return; }
    IM.renderCount();
  };

  /* ======================================================================
   * [탭] 본사 — 제출현황 대시보드 + 반려 + 시즌 설정
   * ==================================================================== */
  IM.renderHQ = async function () {
    const b = document.getElementById('imBody'); if (!b) return;
    if (!isHQ()) { b.innerHTML = '<div style="padding:24px;text-align:center;color:var(--th)">본사 관리자 전용입니다.</div>'; return; }
    b.innerHTML = '<div style="padding:20px;text-align:center;color:var(--th)">불러오는 중…</div>';
    let d = { stores: [] };
    try { d = await rpc('ch_inv_status_list', { p_ym: IM.state.ym }) || d; } catch (e) { if (e.missing) { b.innerHTML = '<div style="padding:24px;text-align:center;color:#B91C1C">보안 SQL 미실행</div>'; return; } }
    const SB = { none: '<span style="font-size:11px;background:#F1F5F9;color:#64748B;border-radius:5px;padding:1px 7px">미제출</span>', submitted: '<span style="font-size:11px;background:#FEF3C7;color:#B45309;border-radius:5px;padding:1px 7px">제출(확인대기)</span>', confirmed: '<span style="font-size:11px;background:#DCFCE7;color:#15803D;border-radius:5px;padding:1px 7px">확정</span>', rejected: '<span style="font-size:11px;background:#FEE2E2;color:#B91C1C;border-radius:5px;padding:1px 7px">반려</span>' };
    const stores = d.stores || [];
    const done = stores.filter(s => s.status === 'confirmed').length;
    const rows = stores.map(s => '<tr><td style="padding:5px 8px;border-bottom:0.5px solid var(--crm,#eee);font-weight:600">' + esc(s.store) + '</td><td style="padding:5px 8px;border-bottom:0.5px solid var(--crm,#eee)">' + (SB[s.status] || SB.none) + (s.reject_note ? ' <span style="font-size:11px;color:#B91C1C">(' + esc(s.reject_note) + ')</span>' : '') + '</td><td style="padding:5px 8px;border-bottom:0.5px solid var(--crm,#eee);text-align:center">' + (s.status === 'confirmed' ? '' : '<button class="btn-cancel-sm" style="font-size:11px;padding:2px 8px" onclick="InventoryMgr.rejectStore(\'' + esc(s.store).replace(/'/g, "\\'") + '\')">보완요청</button>') + '</td></tr>').join('');
    b.innerHTML =
      '<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;flex-wrap:wrap"><div style="font-size:14px;font-weight:800">' + IM.state.ym + ' 실사 제출현황 <span style="font-size:12px;color:var(--th)">(확정 ' + done + '/' + stores.length + ')</span>' + (d.d_plus ? ' <span style="font-size:12px;color:#B91C1C">마감 D+' + d.d_plus + '</span>' : '') + '</div>'
      + '<span style="margin-left:auto;display:flex;gap:6px"><button class="btn-cancel-sm" style="font-size:12px" onclick="InventoryMgr.openSeason()"><i class="ti ti-calendar-cog"></i> 취합 시즌 설정</button><button class="btn-cancel-sm" style="font-size:12px" onclick="InventoryMgr.triggerReminder()"><i class="ti ti-bell"></i> 리마인드 지금 발송</button></span></div>'
      + '<table style="width:100%;border-collapse:collapse;font-size:12px;background:#fff;border:0.5px solid var(--crd);border-radius:8px;overflow:hidden"><thead><tr style="background:var(--cr,#faf7f2)"><th style="padding:6px 8px;text-align:left">매장</th><th style="padding:6px 8px;text-align:left">상태</th><th style="padding:6px 8px;text-align:center">반려</th></tr></thead><tbody>' + (rows || '<tr><td colspan="3" style="padding:14px;text-align:center;color:var(--th)">매장 없음</td></tr>') + '</tbody></table>';
  };
  IM.rejectStore = function (store) {
    modal(store + ' 실사 보완요청(반려)',
      '<div style="font-size:12px;color:var(--th);margin-bottom:8px">반려하면 해당 매장의 실사 입력이 다시 열리고, 매장 화면/푸시로 보완요청이 표시됩니다.</div>'
      + '<input id="rjNote" class="form-input" placeholder="보완 요청 사유 (예: 소모품 누락, 수량 재확인)">',
      '반려', async function () {
        try { await rpc('ch_inv_reject', { p_store: store, p_ym: IM.state.ym, p_note: (document.getElementById('rjNote').value || '').trim() || null }); }
        catch (e) { alert('오류: ' + (e.missing ? '보안 SQL 미실행' : e.message)); return false; }
        toast('보완요청 처리 완료'); IM.renderHQ(); return true;
      });
  };
  IM.openSeason = async function () {
    let s = {}; try { s = await rpc('ch_season_get', { p_ym: IM.state.ym }) || {}; } catch (e) {}
    const v = t => t ? String(t).slice(0, 16) : '';
    modal(IM.state.ym + ' 취합 시즌 설정 (월 전체 공통)',
      '<div style="font-size:12px;color:var(--th);margin-bottom:8px">설정한 기간에만 월말 실사 입력이 활성화됩니다. (폐기/이관은 상시) 마감 후 미제출/반려 매장은 완료 시까지 자동 연장됩니다.</div>'
      + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px"><div><label style="font-size:11px;color:var(--th)">시작일시</label><input id="seStart" type="datetime-local" class="form-input" value="' + v(s.inv_start) + '"></div>'
      + '<div><label style="font-size:11px;color:var(--th)">마감일시</label><input id="seEnd" type="datetime-local" class="form-input" value="' + v(s.inv_end) + '"></div></div>'
      + '<input id="seNote" class="form-input" style="margin-top:8px" placeholder="안내 메모(선택)" value="' + esc(s.note || '') + '">',
      '저장', async function () {
        const st = document.getElementById('seStart').value, en = document.getElementById('seEnd').value;
        if (!st || !en) { alert('시작/마감 일시를 입력하세요'); return false; }
        try { await rpc('ch_season_set', { p_ym: IM.state.ym, p_start: new Date(st).toISOString(), p_end: new Date(en).toISOString(), p_note: document.getElementById('seNote').value.trim() || null }); }
        catch (e) { alert('오류: ' + (e.missing ? '보안 SQL 미실행' : e.message)); return false; }
        toast('시즌 저장 완료'); IM.renderHQ(); return true;
      });
  };
  IM.triggerReminder = async function () { await IM.pushSend({ mode: 'inventory_reminders', ym: IM.state.ym }); toast('리마인드 발송을 요청했습니다 (대상 기기에 푸시)'); };

  /* ───────── 마운트 / 로그인 시 푸시 SW 등록 + 리마인드 핑 ───────── */
  IM.boot = function () {
    IM.applyNav();
    // 기존 구독자는 조용히 SW 재등록(갱신). 신규 구독은 배너로.
    try { if ('serviceWorker' in navigator && Notification && Notification.permission === 'granted') navigator.serviceWorker.register('./sw.js'); } catch (e) {}
    // 로그인 시 실사 리마인드 1회 핑(서버가 D-1/초과 판단 + 일일 중복방지)
    try { IM.pushSend({ mode: 'inventory_reminders', ym: (new Date()).toISOString().slice(0, 7) }); } catch (e) {}
  };
  (function waitUser(n) {
    if (window.currentUser && sbc()) { IM.boot(); }
    else if (n < 60) { setTimeout(function () { waitUser(n + 1); }, 250); }
  })(0);
  IM.remount = function () { try { IM.boot(); } catch (e) {} };
})();
