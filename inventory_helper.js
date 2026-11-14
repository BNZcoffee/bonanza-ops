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
  const sbc = () => window.sb || (typeof sb !== 'undefined' ? sb : null);
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
  // currentUser 는 index.html 의 전역 let(바인딩 공유). window.currentUser 는 미부착이라 직접 참조.
  function curUser() { try { if (typeof currentUser !== 'undefined' && currentUser) return currentUser; } catch (e) {} return window.currentUser || null; }
  function cu() { return curUser() || {}; }

  /* ===================================================================
   * 작성 가이드(공용) — 폐기/이관/실사/명세서/법인카드 Step 예시 팝업
   *   window.OpsGuide.open('loss'|'transfer'|'count'|'delivery'|'card')
   * =================================================================== */
  (function () {
    const G = {};
    const fld = (label, val, hint) => '<div style="margin:5px 0"><div style="font-size:10px;color:var(--th);margin-bottom:2px">' + label + '</div><div style="border:1px solid var(--crd);border-radius:6px;padding:6px 9px;font-size:12px;background:#fff;color:#111">' + val + '</div>' + (hint ? '<div style="font-size:10px;color:#15803D;margin-top:2px">' + hint + '</div>' : '') + '</div>';
    const sel = (label, val) => '<div style="margin:5px 0"><div style="font-size:10px;color:var(--th);margin-bottom:2px">' + label + '</div><div style="border:1px solid var(--crd);border-radius:6px;padding:6px 9px;font-size:12px;background:#fff;color:#111;display:flex;justify-content:space-between"><span>' + val + '</span><span style="color:var(--th)">▾</span></div></div>';
    const radio = (opts, selIdx) => '<div style="display:flex;flex-direction:column;gap:4px;margin:5px 0">' + opts.map((o, i) => '<div style="border:1px solid ' + (i === selIdx ? '#8a5a2b' : 'var(--crd)') + ';border-radius:6px;padding:6px 9px;font-size:12px;background:' + (i === selIdx ? '#FAF5EF' : '#fff') + ';color:#111"><span style="color:' + (i === selIdx ? '#8a5a2b' : 'var(--th)') + '">' + (i === selIdx ? '◉' : '○') + '</span> ' + o + '</div>').join('') + '</div>';
    const grid2 = inner => '<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px">' + inner + '</div>';
    const step = (n, title, body) => '<div style="border:0.5px solid var(--crd);border-radius:10px;padding:10px 12px;margin-bottom:8px;background:var(--cr,#faf7f2)"><div style="display:flex;align-items:center;gap:6px;margin-bottom:7px"><span style="background:#8a5a2b;color:#fff;border-radius:999px;font-size:10px;font-weight:700;padding:2px 9px">STEP ' + n + '</span><b style="font-size:12.5px">' + title + '</b></div>' + body + '</div>';
    const warn = t => '<div style="background:#FEF3C7;border:1px solid #FDE68A;border-radius:8px;padding:8px 11px;margin-bottom:10px;font-size:12px;color:#92400E;line-height:1.5"><b>⚠ 핵심 주의</b><br>' + t + '</div>';
    const mock = inner => '<div style="border:0.5px dashed var(--crd);border-radius:8px;padding:8px 10px;background:#fff">' + inner + '</div>';

    G.DATA = {
      loss: { title: '폐기(Loss) 작성 가이드', html:
        warn('폐기는 발생 즉시 그날 등록합니다. 월말에 몰아서 입력하면 원인 분석과 발주 조정이 어렵습니다.')
        + step(1, '일자 / 분류 선택', mock(grid2(fld('일자', '2026-11-15') + sel('분류', '유통기한 경과'))) )
        + step(2, '구분 / 품목 / 수량 입력', mock(grid2(sel('구분', '재고 마스터 품목') + fld('수량', '2')) + fld('품목명', '매일 생크림 1L', '재고 품목은 마스터명과 동일하게')) )
        + step(3, '사유 메모 후 [등록]', mock(fld('사유 메모', '오픈 검수 중 유통기한 1일 경과 확인')) + '<div style="font-size:11px;color:var(--th);margin-top:6px">재고 마스터 품목은 품목별로 자동 합산되고, 기타/비재고는 별도 누적됩니다.</div>') },
      transfer: { title: '타매장 이관 작성 가이드', html:
        warn('이관은 보내는 매장에서만 등록합니다. 받는 매장은 알림만 받으며 중복 등록하면 수량이 이중 반영됩니다.')
        + step(1, '받는 매장 선택', mock(sel('받는 매장', '성수점')) )
        + step(2, '품목 / 수량 입력', mock(grid2(fld('품목명', '에스프레소 원두 1kg') + fld('수량', '3'))) )
        + step(3, '메모 후 [이관 등록]', mock(fld('메모(선택)', '주말 물량 부족분 지원')) + '<div style="font-size:11px;color:var(--th);margin-top:6px">등록 즉시 양쪽 매장 재고에 반영되고, 받는 매장에 슬랙/푸시 알림이 갑니다.</div>') },
      count: { title: '월말 실사 작성 가이드', html:
        warn('본사 취합 기간에만 열립니다. 품목은 자동으로 떠 있으니 수량 칸에 숫자만 정확히 입력하세요. 팀원/PT는 실사수량만, 매니저는 단가까지 검수합니다.')
        + step(1, '품목 확인 / 필터', mock('<div style="display:flex;gap:4px;flex-wrap:wrap"><span style="border:1px solid var(--crd);border-radius:6px;padding:4px 8px;font-size:11px;background:#fff;color:#111">구분 전체 ▾</span><span style="border:1px solid var(--crd);border-radius:6px;padding:4px 8px;font-size:11px;background:#fff;color:#111">공급사 전체 ▾</span><span style="border:1px solid var(--crd);border-radius:6px;padding:4px 8px;font-size:11px;background:#fff;color:#111">품목명 🔍 조회</span></div>') )
        + step(2, '실사수량 입력', mock('<table style="width:100%;border-collapse:collapse;font-size:11px"><tr style="background:var(--cr,#faf7f2)"><th style="padding:4px;text-align:left">품명</th><th style="padding:4px">입고량</th><th style="padding:4px">실사수량</th></tr><tr><td style="padding:4px">매일 생크림 1L</td><td style="padding:4px;text-align:center;color:var(--th)">12</td><td style="padding:4px"><span style="border:1px solid #8a5a2b;border-radius:4px;padding:2px 10px;background:#fff;color:#111">9</span></td></tr></table>') )
        + step(3, '[실사 제출] / 매니저 [최종 제출]', '<div style="font-size:11px;color:var(--th)">사용량이 마이너스거나 입고가 있는데 실사 0인 행은 자동으로 빨강/노랑 표시됩니다. 수정 후 제출하세요. 중간 저장은 자동(임시저장)됩니다.</div>') },
      delivery: { title: '거래명세서 업로드 작성 가이드', html:
        warn('엑셀(.xlsx) 또는 CSV만 올립니다. 원본 파일은 저장하지 않고 파싱 후 즉시 파기합니다.')
        + step(1, '파일 선택 → 미리보기', mock('<div style="border:1px dashed var(--crd);border-radius:6px;padding:10px;text-align:center;font-size:11px;color:var(--th)">거래명세서.xlsx 선택됨 — 품목/수량/단가 자동 파싱</div>') )
        + step(2, '합산 / 덮어쓰기 선택', mock(radio(['기존 입고량에 합산 (주간/반기 반복 업로드용)', '기존 입고량 덮어쓰기 (잘못 올려 재업로드)'], 0)) )
        + step(3, '확인 후 [입고 반영]', mock('<table style="width:100%;border-collapse:collapse;font-size:11px"><tr style="background:var(--cr,#faf7f2)"><th style="padding:4px;text-align:left">품명</th><th style="padding:4px">수량</th><th style="padding:4px">단가</th></tr><tr><td style="padding:4px">매일 생크림 1L</td><td style="padding:4px;text-align:center">12</td><td style="padding:4px;text-align:right">3,200</td></tr></table>') + '<div style="font-size:11px;color:var(--th);margin-top:6px">반영 즉시 월말 실사 입고량에 자동 연동됩니다. 슬래시(/)로 묶인 품목은 자동 분리됩니다.</div>') },
      card: { title: '법인카드 수시 등록 가이드', html:
        warn('결제가 끝나면 바로 등록하세요. 끝4자리/결제일/금액으로 월말 회계 승인건과 자동 대사됩니다.')
        + step(1, '결제일 / 금액 / 계정과목', mock(grid2(fld('결제일', '2026-11-15') + fld('금액', '48,000')) + sel('계정과목', '소모품비')) )
        + step(2, '사용내역 / 영수증 첨부', mock(fld('사용내역', '매장 비품(행주/세제) 구입') + '<div style="border:1px dashed var(--crd);border-radius:6px;padding:8px;text-align:center;font-size:11px;color:var(--th);margin-top:4px">📷 영수증 사진 촬영/첨부</div>') )
        + step(3, '[저장] → 한도바 반영', '<div style="font-size:11px;color:var(--th)">저장하면 상단 한도 바의 당월 사용액/잔여에 즉시 반영됩니다. 수선비/비품 등 보관 필요 서류는 [필수 보관 서류]로 구분됩니다.</div>') }
    };

    G.open = function (key) {
      const g = G.DATA[key]; if (!g) return;
      const old = document.getElementById('opsGuideModal'); if (old) old.remove();
      const m = document.createElement('div'); m.id = 'opsGuideModal'; m.className = 'modal-bg open';
      m.innerHTML = '<div class="modal-box" style="max-width:520px;width:95%"><div class="modal-title" style="display:flex;align-items:center;gap:6px">📖 ' + g.title + '</div>'
        + '<div style="max-height:66vh;overflow:auto;padding:2px 2px 8px">' + g.html + '</div>'
        + '<div style="display:flex;justify-content:flex-end;margin-top:10px"><button class="btn-submit" onclick="document.getElementById(\'opsGuideModal\').remove()">닫기</button></div></div>';
      m.addEventListener('click', e => { if (e.target === m) m.remove(); });
      document.body.appendChild(m);
    };
    window.OpsGuide = G;
  })();

  const guideBtn = key => '<button class="btn-cancel-sm" style="font-size:12px;color:#8a5a2b" onclick="OpsGuide.open(\'' + key + '\')"><i class="ti ti-book"></i> 작성 가이드</button>';
  IM._guideBtn = guideBtn;

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

  IM.canAccess = function () { return !!curUser(); };
  IM.navVisible = function () {
    if (!curUser()) return false;
    try { if (typeof isFeatureEnabled === 'function') return isFeatureEnabled('inventory'); } catch (e) {}
    return true;
  };
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
      + '<div id="imNotice"></div>'
      + '<div id="imBanner"></div>'
      + '<div style="display:flex;border-bottom:0.5px solid var(--crd);margin:8px 0 14px">' + tabs.map(t => tb(t[0], t[1], t[2])).join('') + '</div>'
      + '<div id="imBody"></div></div>';
    IM.renderNotice();
    IM.renderBanner();
    if (tab === 'loss') IM.renderLoss(); else if (tab === 'transfer') IM.renderTransfer(); else if (tab === 'count') IM.renderCount(); else IM.renderHQ();
  };
  IM.goTab = function (k) { IM.state.tab = k; IM.render(); };
  IM.onStore = function (v) { IM.state.store = v; IM.render(); };
  IM.onYm = function (v) { IM.state.ym = v; IM.render(); };

  /* ───────── 탭별 개별 공지사항 ───────── */
  IM._noticeKey = function () { return ({ loss: 'inv_notice_loss', transfer: 'inv_notice_transfer', count: 'inv_notice_count', hq: 'inv_notice_hq' })[IM.state.tab] || 'inv_notice_count'; };
  IM._noticeLabel = function () { return ({ loss: '폐기(Loss)', transfer: '타매장 이관', count: '월말 실사', hq: '제출현황/시즌' })[IM.state.tab] || ''; };
  IM.renderNotice = async function () {
    const box = document.getElementById('imNotice'); if (!box) return;
    const key = IM._noticeKey(); let notice = '';
    try { const { data } = await sbc().from('app_settings').select('value').eq('key', key).maybeSingle(); notice = (data && data.value) || ''; } catch (e) {}
    window.__imNotice = notice; window.__imNoticeKey = key;
    const editBtn = isHQ() ? '<button onclick="InventoryMgr.editNotice()" style="background:none;border:none;color:var(--br,#8a5a2b);cursor:pointer;font-size:12px;white-space:nowrap"><i class="ti ti-pencil"></i> ' + (notice ? '공지 수정' : '공지 등록') + '</button>' : '';
    if (!notice && !isHQ()) { box.innerHTML = ''; return; }
    box.innerHTML = '<div style="background:#FFFBEB;border:1px solid #FDE68A;border-radius:8px;padding:10px 12px;margin-bottom:8px;display:flex;gap:8px;align-items:flex-start">'
      + '<i class="ti ti-speakerphone" style="color:#B45309;margin-top:2px"></i>'
      + '<div style="flex:1;font-size:12.5px;color:#92400E;white-space:pre-wrap;line-height:1.5"><b style="font-size:11px">[' + esc(IM._noticeLabel()) + ' 공지]</b><br>' + (notice ? esc(notice) : '<span style="color:#B45309;opacity:.7">등록된 공지사항이 없습니다. (본사 관리자만 등록)</span>') + '</div>'
      + editBtn + '</div>';
  };
  IM.editNotice = function () {
    if (!isHQ()) return;
    modal('[' + IM._noticeLabel() + '] 공지사항',
      '<div style="font-size:12px;color:var(--th);margin-bottom:8px">이 탭 전용 공지입니다. 해당 탭을 보는 전 직원 화면 상단에 노출됩니다. (장문 작성 가능)</div>'
      + '<textarea id="imNoticeInp" class="form-input" rows="6" style="resize:vertical">' + esc(window.__imNotice || '') + '</textarea>',
      '저장', async function () {
        const val = (document.getElementById('imNoticeInp').value || '').trim();
        try { await sbc().from('app_settings').upsert({ key: window.__imNoticeKey, value: val }, { onConflict: 'key' }); }
        catch (e) { alert('저장 오류: ' + (e.message || e)); return false; }
        toast('공지 저장 완료'); IM.renderNotice(); return true;
      });
  };

  /* ───────── 상단 배너: 푸시 구독 + 마감 경고 ───────── */
  IM.renderBanner = async function () {
    const box = document.getElementById('imBanner'); if (!box) return; let html = '';
    // 마감 D-1/D+N 경고 (현재 매장 기준)
    if (IM.state.store) {
      try {
        const s = await rpc('ch_inv_season', { p_store: IM.state.store, p_ym: IM.state.ym });
        const toCount = IM.state.tab !== 'count' ? ' <button onclick="InventoryMgr.goTab(\'count\')" style="background:#fff;border:1px solid currentColor;border-radius:6px;padding:2px 8px;font-size:11px;cursor:pointer;color:inherit">[월말 실사] 탭으로 이동</button>' : '';
        if (s && s.status === 'rejected') html += '<div style="background:#FEE2E2;color:#991B1B;border-radius:8px;padding:9px 12px;margin-bottom:8px;font-size:12.5px;line-height:1.5"><b><i class="ti ti-rotate"></i> [월말 실사] 보완요청(반려)</b>' + (s.reject_note ? '<br><span style="font-weight:600">보완 사유:</span> ' + esc(s.reject_note) : '') + '<br>[월말 실사] 탭에서 수정 후 다시 제출해 주세요.' + toCount + '</div>';
        else if (s && s.overdue) html += '<div style="background:#FEE2E2;color:#991B1B;border-radius:8px;padding:9px 12px;margin-bottom:8px;font-size:13px;font-weight:700"><i class="ti ti-alert-triangle"></i> [월말 실사] 마감 D+' + s.d_plus + '일 경과 — 미완료 상태입니다. ' + (isPriv() ? '입력/확정' : '실사 입력') + '을 서둘러 주세요.' + toCount + '</div>';
        else if (s && s.d_minus1) html += '<div style="background:#FEF3C7;color:#92400E;border-radius:8px;padding:9px 12px;margin-bottom:8px;font-size:13px;font-weight:700"><i class="ti ti-clock"></i> [월말 실사] 마감 D-1 — 내일 마감입니다. 오늘 안에 제출해 주세요.' + toCount + '</div>';
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
      + '<span style="margin-left:auto;display:flex;gap:6px">' + guideBtn('loss') + '<button class="btn-submit" style="font-size:12px" onclick="InventoryMgr.openLossAdd()"><i class="ti ti-plus"></i> 폐기 등록</button></span></div>'
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
      '<div style="display:flex;align-items:center;gap:6px;margin-bottom:8px;flex-wrap:wrap"><div style="font-size:12px;color:var(--th);flex:1;min-width:180px">보내는 매장이 등록하면 받는 매장 입재고 사용량에 자동 반영되고, 받는 매장에 알림이 갑니다.</div>' + guideBtn('transfer') + '<button class="btn-submit" style="font-size:12px" onclick="InventoryMgr.openTransferAdd()"><i class="ti ti-plus"></i> 이관 등록</button></div>'
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
    const roleTag = isHQ() ? '본사' : (priv ? '매니저' : '팀원/PT');
    const saverLine = season.last_saver_name ? (' · 최종 저장 <b>' + esc(season.last_saver_name) + '</b> · ' + String(season.last_saved_at || '').replace('T', ' ').slice(5, 16)) : '';
    let head = '<div style="background:var(--cr,#faf7f2);border:0.5px solid var(--crd);border-radius:8px;padding:9px 12px;margin-bottom:10px;font-size:12.5px"><i class="ti ti-calendar-stats"></i> ' + esc(seasonLine) + ' · 상태: <b>' + statusTxt + '</b>' + ' <span style="font-size:11px;background:#E0E7FF;color:#3730A3;border-radius:5px;padding:1px 6px">' + roleTag + '</span>' + saverLine + (season.d_plus ? ' · <span style="color:#B91C1C">D+' + season.d_plus + ' 경과</span>' : '') + (season.locked ? ' · <span style="color:#B91C1C">월마감 잠금</span>' : '') + '</div>';
    if (!open) { b.innerHTML = head + '<div style="padding:24px;text-align:center;color:var(--th)">' + (season.locked ? '월마감 잠금 상태라 입력할 수 없습니다.' : (season.status === 'confirmed' ? '이미 최종 확정되었습니다.' : '현재 실사 입력 기간이 아닙니다. (본사 설정 시즌에만 활성화)')) + '</div>'; return; }
    // 데이터 로드: 기존 입력분 + 전월 이월 + 임시저장(당일) + 품목 마스터
    let tmpl = { items: [] }, draft = {}, master = [];
    try { tmpl = await rpc('ch_inv_template', { p_store: IM.state.store, p_ym: IM.state.ym }) || tmpl; } catch (e) {}
    try { draft = await rpc('ch_inv_draft_get', { p_store: IM.state.store, p_ym: IM.state.ym }) || {}; } catch (e) {}
    try { master = await rpc('ch_item_master_list', { p_vendor: null, p_category: null }) || []; } catch (e) {}
    window.__imMaster = master;
    const mkey = x => (x.item || '') + '|' + (x.vendor_slug || '');
    const norm = x => ({ vendor_slug: x.vendor_slug || null, category: x.category || '', item: x.item || '', spec: x.spec || '', unit: x.unit || '', count_qty: (x.count_qty != null ? x.count_qty : ''), unit_price: (x.unit_price != null ? x.unit_price : ''), opening_qty: x.opening_qty, in_qty: x.in_qty, pending: !!x.pending });
    let rows, restored = false;
    if (draft.exists && Array.isArray(draft.rows)) { rows = draft.rows.map(norm); restored = true; }
    else {
      const existing = (inv.items || []).map(norm);
      const seen = {}; existing.forEach(x => { seen[mkey(x)] = true; });
      rows = existing.concat((tmpl.items || []).filter(t => !seen[mkey(t)]).map(norm));
    }
    IM.cnt = { head: head, rows: rows, priv: priv, blind: blind, restored: restored, draftAt: draft.saved_at || null, fVendor: '', fCat: '', fSearch: '' };
    IM.renderCountBody();
  };
  IM.renderCountBody = function () {
    const b = document.getElementById('imBody'); if (!b || !IM.cnt) return;
    const c = IM.cnt, priv = c.priv;
    const vendors = Array.from(new Set(c.rows.map(r => r.vendor_slug).concat((window.__imMaster || []).map(m => m.vendor_slug)).filter(Boolean))).sort();
    const cats = Array.from(new Set(c.rows.map(r => r.category).concat((window.__imMaster || []).map(m => m.category)).filter(Boolean))).sort();
    const vOpt = '<option value="">공급사 전체</option>' + vendors.map(v => '<option' + (c.fVendor === v ? ' selected' : '') + '>' + esc(v) + '</option>').join('');
    const cOpt = '<option value="">구분 전체</option>' + cats.map(v => '<option' + (c.fCat === v ? ' selected' : '') + '>' + esc(v) + '</option>').join('');
    const filterBar = '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px;align-items:center">'
      + '<select id="cntFCat" class="form-input" style="width:120px;font-size:12px" onchange="InventoryMgr.cntFilter()">' + cOpt + '</select>'
      + '<select id="cntFVendor" class="form-input" style="width:140px;font-size:12px" onchange="InventoryMgr.cntFilter()">' + vOpt + '</select>'
      + '<input id="cntFSearch" class="form-input" style="width:150px;font-size:12px" placeholder="품목명 (키워드 일부)" value="' + esc(c.fSearch) + '" onkeydown="if(event.key===\'Enter\')InventoryMgr.cntLookup()">'
      + '<button class="btn-cancel-sm" style="font-size:12px" onclick="InventoryMgr.cntLookup()"><i class="ti ti-search"></i> 조회</button>'
      + '<span style="margin-left:auto;display:flex;gap:6px;flex-wrap:wrap">'
      + guideBtn('count')
      + (priv ? '<label class="btn-cancel-sm" style="font-size:12px;cursor:pointer"><i class="ti ti-file-invoice"></i> 거래명세서 업로드<input type="file" accept=".xlsx,.xls,.csv" style="display:none" onchange="InventoryMgr.openDelivery(this.files[0])"></label>' : '')
      + (priv ? '<button class="btn-cancel-sm" style="font-size:12px;color:#B45309;border-color:#FCD34D" onclick="InventoryMgr.openPriceChanges()"><i class="ti ti-arrows-up-down"></i> 단가 변동 내역</button>' : '')
      + '<button class="btn-cancel-sm" style="font-size:12px" onclick="InventoryMgr.cntNewItem()"><i class="ti ti-plus"></i> 신규 품목 등록 요청</button></span></div>';
    const anom = r => { if (!priv || r.count_qty === '' || r.count_qty == null) return ''; const base = Number(r.opening_qty || 0) + Number(r.in_qty || 0); if (base < Number(r.count_qty)) return 'background:#FEF2F2'; if (Number(r.in_qty || 0) > 0 && Number(r.count_qty) === 0) return 'background:#FFFBEB'; return ''; };
    const fv = c.fVendor, fc = c.fCat, fs = (c.fSearch || '').toLowerCase();
    const trs = c.rows.map((r, i) => {
      if (fv && r.vendor_slug !== fv) return '';
      if (fc && r.category !== fc) return '';
      if (fs && (r.item || '').toLowerCase().indexOf(fs) === -1) return '';
      const nameCell = esc(r.item) + (r.pending ? ' <span style="font-size:10px;background:#FEF3C7;color:#B45309;border-radius:4px;padding:1px 5px">신규·본사 분류대기</span>' : '');
      return '<tr style="' + anom(r) + '">'
        + '<td style="padding:4px 6px;border-bottom:0.5px solid var(--crm,#eee);color:var(--th)">' + esc(r.vendor_slug || '-') + '</td>'
        + '<td style="padding:4px 6px;border-bottom:0.5px solid var(--crm,#eee);color:var(--th)">' + esc(r.category || '-') + '</td>'
        + '<td style="padding:4px 6px;border-bottom:0.5px solid var(--crm,#eee)">' + nameCell + '</td>'
        + '<td style="padding:4px 6px;border-bottom:0.5px solid var(--crm,#eee);font-size:11px;color:var(--th)">' + esc(r.spec || '') + (r.unit ? ' / ' + esc(r.unit) : '') + '</td>'
        + (priv
          ? '<td style="padding:3px;border-bottom:0.5px solid var(--crm,#eee)"><input type="number" step="0.01" class="form-input" style="font-size:12px;padding:4px;width:72px;text-align:right;background:#F8FAFC" value="' + (r.in_qty == null ? '' : r.in_qty) + '" title="당월 명세서 입고량(수정 가능)" oninput="InventoryMgr.cntInput(' + i + ',\'in_qty\',this.value)"></td>'
          : '<td style="padding:4px 6px;border-bottom:0.5px solid var(--crm,#eee);text-align:right;color:var(--th)">' + (r.in_qty == null ? '-' : r.in_qty) + '</td>')
        + '<td style="padding:3px;border-bottom:0.5px solid var(--crm,#eee)"><input type="number" step="0.01" class="form-input" style="font-size:12px;padding:4px;width:80px;text-align:right" value="' + (r.count_qty === '' || r.count_qty == null ? '' : r.count_qty) + '" oninput="InventoryMgr.cntInput(' + i + ',\'count_qty\',this.value)"></td>'
        + (priv ? '<td style="padding:3px;border-bottom:0.5px solid var(--crm,#eee)"><input type="number" class="form-input" style="font-size:12px;padding:4px;width:90px;text-align:right" value="' + (r.unit_price === '' || r.unit_price == null ? '' : r.unit_price) + '" placeholder="개당단가" oninput="InventoryMgr.cntInput(' + i + ',\'unit_price\',this.value)"></td>' : '')
        + '<td style="padding:3px;border-bottom:0.5px solid var(--crm,#eee);text-align:center"><button onclick="InventoryMgr.cntRemove(' + i + ')" style="background:none;border:none;color:#B91C1C;cursor:pointer">✕</button></td></tr>';
    }).join('');
    const total = c.rows.length, filled = c.rows.filter(r => r.count_qty !== '' && r.count_qty != null).length;
    let html = (c.restored ? '<div style="background:#EFF6FF;color:#1E40AF;border-radius:8px;padding:7px 12px;margin-bottom:8px;font-size:12px"><i class="ti ti-history"></i> 임시저장(' + String(c.draftAt || '').replace('T', ' ').slice(5, 16) + ')에서 복원했습니다. 저장하려면 [저장]을 눌러주세요.</div>' : '');
    html += '<div style="font-size:12px;color:var(--th);margin-bottom:4px">' + (c.blind ? '팀원/PT 모드 — 등록된 품목에서 실사수량만 입력합니다. (단가·금액은 매니저 확정 단계)' : '매니저 모드 — 수량/단가 검수 후 [최종 제출]하세요.') + ' · 품목 ' + total + ' · 입력 ' + filled + '</div>';
    html += filterBar;
    html += '<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:12px;background:#fff;border:0.5px solid var(--crd);border-radius:8px;overflow:hidden"><thead><tr style="background:var(--cr,#faf7f2)"><th style="padding:5px 6px;text-align:left">공급처</th><th style="padding:5px 6px;text-align:left">구분</th><th style="padding:5px 6px;text-align:left">품명</th><th style="padding:5px 6px;text-align:left">규격/단위</th><th style="padding:5px 6px">입고량</th><th style="padding:5px 6px">실사수량</th>' + (priv ? '<th style="padding:5px 6px">개당단가</th>' : '') + '<th></th></tr></thead><tbody>' + (trs || '<tr><td colspan="' + (priv ? 8 : 7) + '" style="padding:14px;text-align:center;color:var(--th)">표시할 품목이 없습니다. [품목 추가]로 불러오세요.</td></tr>') + '</tbody></table></div>';
    html += '<div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;align-items:center">'
      + '<button class="btn-cancel-sm" style="font-size:13px" onclick="InventoryMgr.draftSave(true)"><i class="ti ti-clock-pause"></i> 임시저장</button>'
      + '<button class="btn-submit" style="font-size:13px" onclick="InventoryMgr.saveCount(false)"><i class="ti ti-device-floppy"></i> ' + (priv ? '저장 (부분 입력 가능)' : '저장 (매니저 검토용 제출)') + '</button>'
      + (priv ? '<button class="btn-submit" style="font-size:13px;background:#15803D" onclick="InventoryMgr.saveCount(true)"><i class="ti ti-circle-check"></i> 최종 제출 (본사 마감)</button>' : '')
      + '<span id="cntDraftMsg" style="font-size:11px;color:var(--th)">' + (c.draftAt ? '최근 임시저장 ' + String(c.draftAt).replace('T', ' ').slice(5, 16) : '') + '</span></div>';
    html += '<div style="margin-top:8px;background:#FFF7ED;border:1px solid #FED7AA;border-radius:8px;padding:8px 12px;font-size:12px;color:#9A3412">⚠️ 임시저장은 최종 제출이 아닙니다. 입력 후 반드시 <b>[저장]</b> 버튼을 눌러야 반영되며, 당일 자정(24:00)이 지나면 자동 삭제됩니다.</div>';
    b.innerHTML = c.head + html;
  };
  IM.cntInput = function (i, field, val) { if (!IM.cnt || !IM.cnt.rows[i]) return; IM.cnt.rows[i][field] = val; IM.scheduleAutosave(); };
  IM.cntFilter = function () { if (!IM.cnt) return; IM.cnt.fVendor = (document.getElementById('cntFVendor') || {}).value || ''; IM.cnt.fCat = (document.getElementById('cntFCat') || {}).value || ''; IM.cnt.fSearch = (document.getElementById('cntFSearch') || {}).value || ''; IM.renderCountBody(); setTimeout(() => { const s = document.getElementById('cntFSearch'); if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); } }, 0); };
  IM.cntRemove = function (i) { if (!IM.cnt) return; IM.cnt.rows.splice(i, 1); IM.renderCountBody(); IM.scheduleAutosave(); };
  IM.cntNewItem = async function () {
    const vs = await loadVendorsForStore();
    const vOpt = '<option value="">(공급처 선택/미지정)</option>' + vs.map(v => '<option value="' + esc(v.slug) + '">' + esc(v.canonical || v.slug) + '</option>').join('');
    modal('신규 품목 등록 요청',
      '<div style="font-size:12px;color:var(--th);margin-bottom:8px">본사가 표준 구분/공급처/단가를 지정·승인하면 전 매장 마스터에 공통 반영됩니다. 승인 전까지 수량 입력만 가능합니다.</div>'
      + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">'
      + '<div><label style="font-size:11px;color:var(--th)">공급처</label><select id="niVendor" class="form-input">' + vOpt + '</select></div>'
      + '<div><label style="font-size:11px;color:var(--th)">구분</label><input id="niCat" class="form-input" placeholder="예: 원재료"></div>'
      + '<div style="grid-column:1/3"><label style="font-size:11px;color:var(--th)">품목명</label><input id="niItem" class="form-input" placeholder="품목명"></div>'
      + '<div><label style="font-size:11px;color:var(--th)">규격단위</label><input id="niSpec" class="form-input" placeholder="예: 1박스=20줄"></div>'
      + '<div><label style="font-size:11px;color:var(--th)">단위</label><input id="niUnit" class="form-input" placeholder="줄/개/g"></div>'
      + '</div><div id="niMsg" style="font-size:12px;color:#B91C1C;margin-top:6px;min-height:14px"></div>',
      '등록 요청', async function () {
        const item = (document.getElementById('niItem').value || '').trim();
        if (!item) { document.getElementById('niMsg').textContent = '품목명을 입력하세요'; return false; }
        const vendor = document.getElementById('niVendor').value, cat = document.getElementById('niCat').value.trim(), spec = document.getElementById('niSpec').value.trim(), unit = document.getElementById('niUnit').value.trim();
        try { await rpc('ch_item_request', { p_store: IM.state.store, p_vendor: vendor || null, p_category: cat || null, p_item: item, p_spec: spec || null, p_unit: unit || null }); }
        catch (e) { document.getElementById('niMsg').textContent = e.missing ? '보안 SQL 미실행 (closing_module5.sql)' : '오류: ' + e.message; return false; }
        IM.cnt.rows.push({ vendor_slug: vendor || null, category: cat, item: item, spec: spec, unit: unit, count_qty: '', unit_price: '', pending: true });
        IM.renderCountBody(); toast('신규 품목 등록 요청 완료 (본사 분류대기)'); return true;
      });
  };
  IM.cntLookup = async function () {
    const kw = ((document.getElementById('cntFSearch') || {}).value || '').trim();
    const fc = (document.getElementById('cntFCat') || {}).value || '';
    const fv = (document.getElementById('cntFVendor') || {}).value || '';
    let list = [];
    try { list = kw ? (await rpc('ch_item_search', { p_kw: kw }) || []) : (await rpc('ch_item_master_list', { p_vendor: fv || null, p_category: fc || null }) || []); }
    catch (e) { alert(e.missing ? '보안 SQL 미실행 (closing_module5.sql)' : '오류: ' + e.message); return; }
    if (kw) list = list.filter(m => (!fc || m.category === fc) && (!fv || m.vendor_slug === fv));
    list.sort((a, b) => String(a.item || '').localeCompare(String(b.item || ''), 'ko'));
    window.__lkList = list;
    const rows = list.map((m, i) => '<label style="display:flex;gap:8px;align-items:center;padding:6px 8px;border-bottom:0.5px solid var(--crm,#eee);cursor:pointer;font-size:12px"><input type="checkbox" class="lkChk" value="' + i + '"><b>' + esc(m.item) + '</b><span style="color:var(--th)">' + esc(m.vendor_slug || '') + (m.category ? ' / ' + esc(m.category) : '') + (m.spec ? ' / ' + esc(m.spec) : '') + '</span></label>').join('');
    modal('품목 조회 (' + list.length + '건' + (kw ? ' · "' + esc(kw) + '"' : ' · 전체') + ')',
      '<div style="font-size:11px;color:var(--th);margin-bottom:6px">가나다순. 체크 후 아래 [선택 품목 일괄 추가]를 누르세요.</div>'
      + '<div style="margin-bottom:6px"><label style="font-size:11px"><input type="checkbox" onclick="document.querySelectorAll(\'.lkChk\').forEach(c=>c.checked=this.checked)"> 전체 선택</label></div>'
      + '<div style="max-height:46vh;overflow:auto;border:0.5px solid var(--crd);border-radius:8px">' + (rows || '<div style="padding:14px;text-align:center;color:var(--th)">품목이 없습니다. [신규 품목 등록 요청]을 이용하세요.</div>') + '</div>'
      + '<button class="btn-submit" style="font-size:13px;margin-top:10px;width:100%" onclick="InventoryMgr.lookupAddChecked()"><i class="ti ti-plus"></i> 선택 품목 일괄 추가</button>', '닫기', function () { return true; });
  };
  IM.lookupAddChecked = function () {
    if (!IM.cnt) return;
    const picks = Array.from(document.querySelectorAll('.lkChk:checked')).map(c => (window.__lkList || [])[Number(c.value)]).filter(Boolean);
    if (!picks.length) { toast('선택된 품목이 없습니다'); return; }
    let added = 0;
    picks.forEach(m => {
      if (IM.cnt.rows.some(r => (r.item || '') === m.item && (r.vendor_slug || '') === (m.vendor_slug || ''))) return;
      IM.cnt.rows.push({ vendor_slug: m.vendor_slug || null, category: m.category || '', item: m.item, spec: m.spec || '', unit: m.unit || '', count_qty: '', unit_price: (m.unit_price != null ? m.unit_price : ''), pending: false });
      added++;
    });
    const mm = document.getElementById('imModal'); if (mm) mm.remove();
    IM.renderCountBody(); toast(added + '개 품목 추가됨' + (picks.length - added ? ' (중복 ' + (picks.length - added) + ' 제외)' : ''));
  };
  async function loadVendorsForStore() { try { return await rpc('ch_vendors_for_store', { p_store: IM.state.store }) || []; } catch (e) { return []; } }

  /* ───────── 거래명세서 업로드(파일 미저장 파싱) → 입고량 연동 ───────── */
  function parseItemStr(raw) {
    const parts = String(raw).split('/').map(s => s.trim()).filter(Boolean);
    if (!parts.length) return { item: raw, spec: '', origin: '' };
    const item = parts[0]; let spec = '', origin = '';
    for (let i = 1; i < parts.length; i++) {
      if (!spec && /\d+\s*(kg|g|ml|l|ea|개|박스|줄|포|팩|병|캔|롤|말|봉|매|장)/i.test(parts[i])) spec = parts[i];
      else if (!origin) origin = parts[i];
    }
    return { item: item, spec: spec, origin: origin };
  }
  function parseVendorStr(raw) {
    const parts = String(raw).split('/').map(s => s.trim()).filter(Boolean);
    if (parts.length >= 4) return { vendor: parts[0], brand: parts[1], store: parts[2], category: parts[3] };
    if (parts.length) return { vendor: parts[0], category: parts[parts.length - 1] || '' };
    return { vendor: '', category: '' };
  }
  IM.openDelivery = function (file) {
    if (!file) return;
    if (typeof XLSX === 'undefined') { alert('엑셀 라이브러리 로딩 중입니다.'); return; }
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    const reader = new FileReader();
    reader.onload = async function (e) {
      try {
        let aoa;
        if (ext === 'csv') { const text = new TextDecoder('utf-8').decode(new Uint8Array(e.target.result)); const wb = XLSX.read(text, { type: 'string' }); aoa = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' }); }
        else { const wb = XLSX.read(new Uint8Array(e.target.result), { type: 'array' }); aoa = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' }); }
        let hr = -1, ci = {};
        for (let r = 0; r < Math.min(aoa.length, 25); r++) {
          const row = (aoa[r] || []).map(x => String(x == null ? '' : x));
          const find = kw => row.findIndex(v => kw.some(k => v.replace(/\s/g, '').indexOf(k) !== -1));
          const pi = find(['품목', '품명', '상품']), qi = find(['수량', '입고수량', '납품수량']);
          if (pi !== -1 && qi !== -1) { hr = r; ci = { item: pi, qty: qi, vendor: find(['거래처', '공급처', '업체']), spec: find(['규격']), price: find(['단가', '공급단가', '개당']), cat: find(['구분', '분류', '파트']) }; break; }
        }
        if (hr === -1) { alert('명세서 헤더(품목/수량)를 인식하지 못했습니다. 양식을 확인해 주세요.'); return; }
        const rows = [];
        for (let r = hr + 1; r < aoa.length; r++) {
          const row = aoa[r] || []; const rawItem = String(row[ci.item] || '').trim(); const qty = Number(String(row[ci.qty] || '').replace(/[^0-9.\-]/g, '')); if (!rawItem || !qty) continue;
          const pI = parseItemStr(rawItem); const rawV = ci.vendor !== -1 ? String(row[ci.vendor] || '').trim() : ''; const pV = parseVendorStr(rawV);
          rows.push({ raw: rawItem, item: pI.item, spec: (ci.spec !== -1 ? String(row[ci.spec] || '').trim() : '') || pI.spec, origin: pI.origin, vendor: pV.vendor || '', category: (ci.cat !== -1 ? String(row[ci.cat] || '').trim() : '') || pV.category || '', qty: qty, unit_price: ci.price !== -1 ? String(row[ci.price] || '').replace(/[^0-9.\-]/g, '') : '', remember: false });
        }
        if (!rows.length) { alert('입고 데이터를 찾지 못했습니다.'); return; }
        try { const al = await rpc('ch_alias_resolve', { p_raws: rows.map(x => x.raw) }) || {}; rows.forEach(x => { const a = al[x.raw]; if (a) { x.item = a.item || x.item; x.spec = a.spec || x.spec; x.vendor = a.vendor_slug || x.vendor; x.category = a.category || x.category; x.origin = a.origin || x.origin; } }); } catch (e2) {}
        window.__delivRows = rows; IM.deliveryPreview();
      } catch (err) { alert('파싱 오류: ' + (err.message || err)); }
    };
    reader.readAsArrayBuffer(file);
  };
  IM.deliveryPreview = function () {
    const rows = window.__delivRows || []; const hq = isHQ();
    const inp = (i, f, w) => '<input value="' + esc(rows[i][f] || '') + '" style="font-size:11px;padding:3px;width:' + w + 'px;border:0.5px solid var(--crd);border-radius:5px" oninput="InventoryMgr.delivInput(' + i + ',\'' + f + '\',this.value)">';
    const trs = rows.map((x, i) => '<tr>'
      + '<td style="padding:2px">' + inp(i, 'item', 110) + '</td>'
      + '<td style="padding:2px">' + inp(i, 'spec', 90) + '</td>'
      + '<td style="padding:2px">' + inp(i, 'vendor', 80) + '</td>'
      + '<td style="padding:2px">' + inp(i, 'category', 70) + '</td>'
      + '<td style="padding:2px">' + inp(i, 'origin', 70) + '</td>'
      + '<td style="padding:2px">' + inp(i, 'qty', 56) + '</td>'
      + (hq ? '<td style="padding:2px;text-align:center"><input type="checkbox" onclick="InventoryMgr.delivInput(' + i + ',\'remember\',this.checked)"></td>' : '')
      + '</tr>').join('');
    modal('거래명세서 입고 반영 (' + rows.length + '건)',
      '<div style="display:flex;justify-content:flex-end;margin-bottom:4px">' + guideBtn('delivery') + '</div>'
      + '<div style="font-size:12px;color:var(--th);margin-bottom:6px">슬래시(/) 복합 표기를 자동 분리했습니다. 필요 시 수정하세요.' + (hq ? ' "기억" 체크 시 다음 업로드부터 자동 적용됩니다.' : '') + ' 원본 파일은 저장하지 않습니다.</div>'
      + '<div style="font-size:12px;margin-bottom:8px;display:flex;gap:14px;align-items:center;flex-wrap:wrap;background:var(--cr,#faf7f2);padding:7px 10px;border-radius:8px"><b style="font-size:11px">반영 방식:</b><label><input type="radio" name="delivMode" value="add" checked> 기존 입고량에 합산 (추가 업로드용)</label><label><input type="radio" name="delivMode" value="set"> 기존 입고량 덮어쓰기 (재업로드용)</label></div>'
      + '<div style="max-height:46vh;overflow:auto"><table style="width:100%;border-collapse:collapse;font-size:11px"><thead><tr style="background:var(--cr,#faf7f2)"><th style="padding:4px">품명</th><th style="padding:4px">규격</th><th style="padding:4px">공급사</th><th style="padding:4px">구분</th><th style="padding:4px">원산지</th><th style="padding:4px">입고량</th>' + (hq ? '<th style="padding:4px">기억</th>' : '') + '</tr></thead><tbody>' + trs + '</tbody></table></div>'
      + '<button class="btn-submit" style="font-size:13px;margin-top:10px;width:100%" onclick="InventoryMgr.ingestDelivery()"><i class="ti ti-check"></i> 입고 반영 (실사 리스트 연동)</button>', '닫기', function () { return true; });
  };
  IM.delivInput = function (i, f, v) { if (window.__delivRows && window.__delivRows[i]) window.__delivRows[i][f] = v; };
  IM.ingestDelivery = async function () {
    const rows = window.__delivRows || []; if (!rows.length) return;
    const mode = (document.querySelector('input[name=delivMode]:checked') || {}).value || 'add';
    let res; try { res = await rpc('ch_delivery_ingest', { p_store: IM.state.store, p_ym: IM.state.ym, p_rows: rows, p_mode: mode }); }
    catch (e) { alert('오류: ' + (e.missing ? '보안 SQL 미실행 (closing_module8.sql)' : (/MONTH_LOCKED/.test(e.message || '') ? '월마감 잠금' : (/ACCESS_DENIED/.test(e.message || '') ? '매니저/본사만 가능' : e.message)))); return; }
    IM.mergeDelivery(res.items || []);
    const mm = document.getElementById('imModal'); if (mm) mm.remove();
    toast('입고 반영 완료 — ' + res.rows + '건 (실사 입고량 자동 연동)');
  };
  IM.mergeDelivery = function (items) {
    if (!IM.cnt) return;
    const byKey = {}; IM.cnt.rows.forEach(r => { byKey[(r.item || '') + '|' + (r.vendor_slug || '')] = r; });
    items.forEach(it => {
      const k = (it.item || '') + '|' + (it.vendor_slug || '');
      if (byKey[k]) { byKey[k].in_qty = it.in_qty; if (it.spec && !byKey[k].spec) byKey[k].spec = it.spec; }
      else IM.cnt.rows.push({ vendor_slug: it.vendor_slug || null, category: it.category || '', item: it.item, spec: it.spec || '', unit: '', count_qty: (it.count_qty != null ? it.count_qty : ''), unit_price: (it.unit_price != null ? it.unit_price : ''), in_qty: it.in_qty, pending: false });
    });
    IM.renderCountBody();
  };

  /* ───────── 임시저장(자동/수동/로그아웃 훅) ───────── */
  IM.scheduleAutosave = function () { if (IM._autosaveT) clearTimeout(IM._autosaveT); IM._autosaveT = setTimeout(function () { IM.draftSave(false); }, 3000); };
  IM.draftSave = async function (manual) {
    if (!IM.cnt || !IM.state.store) return;
    try {
      await rpc('ch_inv_draft_save', { p_store: IM.state.store, p_ym: IM.state.ym, p_rows: IM.cnt.rows });
      const now = new Date(); const t = now.toISOString(); IM.cnt.draftAt = t;
      const el = document.getElementById('cntDraftMsg'); if (el) el.textContent = '최근 임시저장 ' + t.replace('T', ' ').slice(5, 16);
      if (manual) toast('임시저장 완료');
    } catch (e) { if (manual) toast('임시저장 실패: ' + (e.message || e)); }
  };
  IM.saveCount = async function (confirmFinal) {
    if (!IM.cnt) return;
    const rows = IM.cnt.rows.filter(r => r.item).map(r => ({ vendor_slug: r.vendor_slug || null, item: r.item, category: r.category || '', spec: r.spec || '', unit: r.unit || '', count_qty: (r.count_qty === '' || r.count_qty == null) ? '' : String(r.count_qty), unit_price: (r.unit_price === '' || r.unit_price == null) ? '' : String(r.unit_price), in_qty: (r.in_qty === '' || r.in_qty == null) ? '' : String(r.in_qty) }));
    if (!rows.length) { toast('입력된 품목이 없습니다'); return; }
    const unfilled = rows.filter(r => r.count_qty === '').length;
    try {
      if (confirmFinal) {
        let msg = '최종 제출하면 해당 월 실사가 본사로 마감 제출됩니다.';
        msg += unfilled ? ('\n\n⚠️ 실사수량 미입력 품목이 ' + unfilled + '건 있습니다. 그대로 제출할까요?') : ' 계속할까요?';
        if (!confirm(msg)) return;
        await rpc('ch_inv_confirm', { p_store: IM.state.store, p_ym: IM.state.ym, p_rows: rows }); toast('최종 제출 완료');
      } else { await rpc('ch_inv_count_save', { p_store: IM.state.store, p_ym: IM.state.ym, p_rows: rows }); toast('저장 완료' + (unfilled ? ' (미입력 ' + unfilled + '건)' : '')); }
      try { await rpc('ch_inv_draft_clear', { p_store: IM.state.store, p_ym: IM.state.ym }); } catch (e) {}
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
    let pendN = 0; try { pendN = (await rpc('ch_item_pending', {}) || []).length; } catch (e) {}
    let bundleCan = false; try { const bc = await rpc('ch_bundle_can', {}); bundleCan = !!(bc && bc.can); } catch (e) {}
    const dt = t => t ? String(t).replace('T', ' ').slice(0, 16) : '-';
    const rows = stores.map(s => '<tr><td style="padding:5px 8px;border-bottom:0.5px solid var(--crm,#eee);font-weight:600">' + esc(s.store) + '</td><td style="padding:5px 8px;border-bottom:0.5px solid var(--crm,#eee)">' + (SB[s.status] || SB.none) + (s.reject_note ? ' <span style="font-size:11px;color:#B91C1C">(' + esc(s.reject_note) + ')</span>' : '') + '</td><td style="padding:5px 8px;border-bottom:0.5px solid var(--crm,#eee);font-size:11px;color:var(--th);white-space:nowrap">' + dt(s.confirmed_at || s.submitted_at) + '</td><td style="padding:5px 8px;border-bottom:0.5px solid var(--crm,#eee);text-align:center">' + (s.status === 'confirmed' ? '' : '<button class="btn-cancel-sm" style="font-size:11px;padding:2px 8px" onclick="InventoryMgr.rejectStore(\'' + esc(s.store).replace(/'/g, "\\'") + '\')">보완요청</button>') + '</td></tr>').join('');
    b.innerHTML =
      '<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;flex-wrap:wrap"><div style="font-size:14px;font-weight:800">' + IM.state.ym + ' 실사 제출현황 <span style="font-size:12px;color:var(--th)">(확정 ' + done + '/' + stores.length + ')</span>' + (d.d_plus ? ' <span style="font-size:12px;color:#B91C1C">마감 D+' + d.d_plus + '</span>' : '') + '</div>'
      + '<span style="margin-left:auto;display:flex;gap:6px"><button class="btn-cancel-sm" style="font-size:12px" onclick="InventoryMgr.openSeason()"><i class="ti ti-calendar-cog"></i> 취합 시즌 설정</button><button class="btn-cancel-sm" style="font-size:12px" onclick="InventoryMgr.triggerReminder()"><i class="ti ti-bell"></i> 리마인드 지금 발송</button></span></div>'
      + '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px;padding:8px 10px;background:var(--cr,#faf7f2);border:0.5px solid var(--crd);border-radius:8px"><span style="font-size:12px;font-weight:700;align-self:center;color:var(--th)">품목·백데이터</span>'
      + '<button class="btn-cancel-sm" style="font-size:12px" onclick="InventoryMgr.openItemMaster()"><i class="ti ti-list-details"></i> 품목 마스터</button>'
      + '<button class="btn-cancel-sm" style="font-size:12px' + (pendN ? ';color:#B45309;border-color:#FCD34D' : '') + '" onclick="InventoryMgr.openPending()"><i class="ti ti-inbox"></i> 신규 분류대기' + (pendN ? ' (' + pendN + ')' : '') + '</button>'
      + '<button class="btn-cancel-sm" style="font-size:12px" onclick="InventoryMgr.downloadBackdataTemplate()"><i class="ti ti-file-download"></i> 백데이터 양식</button>'
      + '<label class="btn-cancel-sm" style="font-size:12px;cursor:pointer"><i class="ti ti-upload"></i> 백데이터 업로드<input type="file" accept=".xlsx,.xls" style="display:none" onchange="InventoryMgr.uploadBackdata(this.files[0])"></label>'
      + (bundleCan ? '<button class="btn-cancel-sm" style="font-size:12px;color:#6D28D9;border-color:#DDD6FE" onclick="InventoryMgr.openBundle()"><i class="ti ti-packages"></i> 품목 꾸러미</button>' : '')
      + '<button class="btn-cancel-sm" style="font-size:12px;color:#0F766E;border-color:#99F6E4" onclick="InventoryMgr.openSettlement()"><i class="ti ti-cash-banknote"></i> 정산·이체 리스트</button>'
      + '</div>'
      + '<table style="width:100%;border-collapse:collapse;font-size:12px;background:#fff;border:0.5px solid var(--crd);border-radius:8px;overflow:hidden"><thead><tr style="background:var(--cr,#faf7f2)"><th style="padding:6px 8px;text-align:left">매장</th><th style="padding:6px 8px;text-align:left">상태</th><th style="padding:6px 8px;text-align:left">제출/확정 일시</th><th style="padding:6px 8px;text-align:center">반려</th></tr></thead><tbody>' + (rows || '<tr><td colspan="4" style="padding:14px;text-align:center;color:var(--th)">매장 없음</td></tr>') + '</tbody></table>';
  };
  IM.rejectStore = async function (store) {
    let an = {}; try { an = await rpc('ch_inv_anomalies', { p_store: store, p_ym: IM.state.ym }) || {}; } catch (e) {}
    const neg = an.negative_use || [], inc = an.in_no_count || [];
    let issues = [];
    if (an.unfilled) issues.push('미입력 품목 ' + an.unfilled + '건');
    if (neg.length) issues.push('사용량 마이너스 이상치 ' + neg.length + '건 (' + neg.slice(0, 3).map(x => esc(x.item)).join(', ') + (neg.length > 3 ? ' 외' : '') + ')');
    if (inc.length) issues.push('입고 있으나 실사 0 ' + inc.length + '건 (' + inc.slice(0, 3).map(x => esc(x.item)).join(', ') + (inc.length > 3 ? ' 외' : '') + ')');
    if (an.transfers) issues.push('당월 이관 ' + an.transfers + '건 — 수령/반영 확인 필요');
    const issueBox = issues.length
      ? '<div style="background:#FEF2F2;border:1px solid #FECACA;border-radius:8px;padding:9px 12px;margin-bottom:8px;font-size:12px;color:#991B1B"><b><i class="ti ti-alert-triangle"></i> 자동 감지된 수정 필요 항목</b><ul style="margin:6px 0 0;padding-left:18px">' + issues.map(i => '<li>' + i + '</li>').join('') + '</ul></div>'
      : '<div style="background:#F0FDF4;border:1px solid #BBF7D0;border-radius:8px;padding:8px 12px;margin-bottom:8px;font-size:12px;color:#15803D"><i class="ti ti-circle-check"></i> 자동 감지된 이상치는 없습니다.</div>';
    const autoText = issues.length ? ('[자동 감지] ' + issues.join(' / ') + '\n\n') : '';
    modal(store + ' 실사 보완요청(반려)',
      '<div style="font-size:12px;color:var(--th);margin-bottom:8px">반려하면 해당 매장의 실사 입력이 다시 열리고, 매장 화면/푸시로 보완요청이 표시됩니다.</div>'
      + issueBox
      + '<label style="font-size:11px;color:var(--th)">보완 요청 사유 (장문 가능)</label>'
      + '<textarea id="rjNote" class="form-input" rows="5" style="resize:vertical" placeholder="예: 소모품 누락, 특정 품목 수량 재확인 요망">' + esc(autoText) + '</textarea>',
      '반려 처리', async function () {
        try { await rpc('ch_inv_reject', { p_store: store, p_ym: IM.state.ym, p_note: (document.getElementById('rjNote').value || '').trim() || null }); }
        catch (e) { alert('오류: ' + (e.missing ? '보안 SQL 미실행' : e.message)); return false; }
        toast('보완요청 처리 완료'); IM.renderHQ(); return true;
      });
  };
  IM.openSeason = async function () {
    let s = {}; try { s = await rpc('ch_season_get', { p_ym: IM.state.ym }) || {}; } catch (e) {}
    const dv = t => t ? String(t).slice(0, 10) : '';
    modal(IM.state.ym + ' 취합 시즌 설정 (월 전체 공통)',
      '<div style="font-size:12px;color:var(--th);margin-bottom:8px">설정한 기간에만 월말 실사 입력이 활성화됩니다. (폐기/이관은 상시) 시작일 00:00 ~ 마감일 23:59 로 자동 적용되고, 마감 후 미제출/반려 매장은 완료 시까지 자동 연장됩니다.</div>'
      + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px"><div><label style="font-size:11px;color:var(--th)">시작일</label><input id="seStart" type="date" class="form-input" value="' + dv(s.inv_start) + '"></div>'
      + '<div><label style="font-size:11px;color:var(--th)">마감일</label><input id="seEnd" type="date" class="form-input" value="' + dv(s.inv_end) + '"></div></div>'
      + '<div style="font-size:11px;color:var(--th);margin-top:6px"><i class="ti ti-info-circle"></i> 공지사항은 메뉴 상단 공지 박스에서 별도로 등록합니다.</div>',
      '저장', async function () {
        const st = document.getElementById('seStart').value, en = document.getElementById('seEnd').value;
        if (!st || !en) { alert('시작일/마감일을 선택하세요'); return false; }
        if (en < st) { alert('마감일이 시작일보다 빠릅니다'); return false; }
        try { await rpc('ch_season_set', { p_ym: IM.state.ym, p_start: new Date(st + 'T00:00:00').toISOString(), p_end: new Date(en + 'T23:59:59').toISOString(), p_note: null }); }
        catch (e) { alert('오류: ' + (e.missing ? '보안 SQL 미실행' : e.message)); return false; }
        toast('시즌 저장 완료'); IM.renderHQ(); return true;
      });
  };
  IM.triggerReminder = async function () {
    const opts = await loadStoreOptions();
    const storeChks = opts.map(s => '<label style="display:inline-flex;align-items:center;gap:3px;font-size:11px;margin:2px 6px 2px 0"><input type="checkbox" class="rmStore" value="' + esc(s) + '"> ' + esc(s) + '</label>').join('');
    window.__rmTargets = null;
    modal('리마인드 발송 대상 선택',
      '<div style="font-size:12px;margin-bottom:8px;color:var(--th)">발송 전 수신자(매장 매니저)를 먼저 확인합니다. 일반 팀원에게는 가지 않습니다.</div>'
      + '<div style="display:flex;flex-direction:column;gap:6px;font-size:13px">'
      + '<label><input type="radio" name="rmMode" value="unsubmitted" checked onclick="InventoryMgr._rmToggle()"> 미제출(미확정) 매장 전체</label>'
      + '<label><input type="radio" name="rmMode" value="rejected" onclick="InventoryMgr._rmToggle()"> 보완요청(반려) 매장</label>'
      + '<label><input type="radio" name="rmMode" value="custom" onclick="InventoryMgr._rmToggle()"> 특정 매장 직접 선택</label>'
      + '</div>'
      + '<div id="rmStores" style="display:none;margin-top:6px;max-height:120px;overflow:auto;border:0.5px solid var(--crd);border-radius:6px;padding:6px">' + storeChks + '</div>'
      + '<button class="btn-cancel-sm" style="font-size:12px;margin-top:8px" onclick="InventoryMgr.previewReminder()"><i class="ti ti-users"></i> 수신자 확인</button>'
      + '<div id="rmPreview" style="margin-top:8px"></div>',
      '확인 후 발송', async function () {
        if (!window.__rmTargets || !window.__rmTargets.length) { alert('먼저 [수신자 확인]을 눌러 대상을 확인하세요'); return false; }
        await IM.pushSend({ mode: 'notify_stores', stores: window.__rmTargets, title: '⏰ 월말 실사 리마인드', body: IM.state.ym + ' 실사 재고 제출을 완료해 주세요.', url: './index.html' });
        toast(window.__rmTargets.length + '개 매장 매니저에게 리마인드를 발송했습니다'); window.__rmTargets = null; return true;
      });
  };
  IM._rmToggle = function () { const m = document.querySelector('input[name=rmMode]:checked').value; document.getElementById('rmStores').style.display = m === 'custom' ? '' : 'none'; document.getElementById('rmPreview').innerHTML = ''; window.__rmTargets = null; };
  IM.previewReminder = async function () {
    const mode = document.querySelector('input[name=rmMode]:checked').value;
    const stores = mode === 'custom' ? Array.from(document.querySelectorAll('.rmStore:checked')).map(x => x.value) : [];
    if (mode === 'custom' && !stores.length) { document.getElementById('rmPreview').innerHTML = '<div style="font-size:12px;color:#B91C1C">매장을 선택하세요</div>'; return; }
    let d; try { d = await rpc('ch_inv_managers', { p_ym: IM.state.ym, p_mode: mode, p_stores: stores }); } catch (e) { document.getElementById('rmPreview').innerHTML = '<div style="font-size:12px;color:#B91C1C">' + (e.missing ? '보안 SQL 미실행 (closing_inv_ux.sql)' : esc(e.message)) + '</div>'; return; }
    const list = d.stores || [];
    window.__rmTargets = list.map(s => s.store);
    const rows = list.map(s => '<tr><td style="padding:3px 8px;border-bottom:0.5px solid var(--crm,#eee);font-weight:600">' + esc(s.store) + '</td><td style="padding:3px 8px;border-bottom:0.5px solid var(--crm,#eee)">' + ((s.managers || []).length ? s.managers.map(m => esc(m.name) + ' (' + esc(m.position) + ')').join(', ') : '<span style="color:#B91C1C">매니저 미지정</span>') + '</td></tr>').join('');
    document.getElementById('rmPreview').innerHTML = '<div style="font-size:12px;margin-bottom:4px">대상 <b>' + list.length + '</b>개 매장 · 수신자:</div><table style="width:100%;border-collapse:collapse;font-size:12px;border:0.5px solid var(--crd);border-radius:6px;overflow:hidden"><tbody>' + (rows || '<tr><td colspan="2" style="padding:8px;text-align:center;color:var(--th)">대상 없음</td></tr>') + '</tbody></table>';
  };

  /* ───────── 본사: 품목 마스터 / 분류대기 승인 / 백데이터 ───────── */
  IM.openItemMaster = async function () {
    if (!isHQ()) return;
    let list = []; try { list = await rpc('ch_item_master_list', { p_vendor: null, p_category: null }) || []; } catch (e) {}
    window.__imMasterMap = {}; list.forEach(m => { window.__imMasterMap[m.id] = m; });
    const rows = list.map(m => '<tr><td style="padding:4px 6px;border-bottom:0.5px solid var(--crm,#eee)">' + esc(m.vendor_slug || '-') + '</td><td style="padding:4px 6px;border-bottom:0.5px solid var(--crm,#eee)">' + esc(m.category || '-') + '</td><td style="padding:4px 6px;border-bottom:0.5px solid var(--crm,#eee);font-weight:600">' + esc(m.item) + (m.product_type === 'exclusive' ? ' <span style="font-size:10px;color:#3730A3">전용</span>' : '') + '</td><td style="padding:4px 6px;border-bottom:0.5px solid var(--crm,#eee);font-size:11px;color:var(--th)">' + esc(m.spec || '') + '</td><td style="padding:4px 6px;border-bottom:0.5px solid var(--crm,#eee);text-align:right">' + (m.unit_price != null ? won(m.unit_price) : '-') + '</td><td style="padding:4px 6px;border-bottom:0.5px solid var(--crm,#eee);text-align:center"><button class="btn-cancel-sm" style="font-size:11px;padding:2px 7px" onclick="InventoryMgr.openItemEdit(' + m.id + ')">수정</button></td></tr>').join('');
    modal('품목 마스터 (' + list.length + ')',
      '<div style="text-align:right;margin-bottom:6px"><button class="btn-submit" style="font-size:12px" onclick="InventoryMgr.openItemEdit(null)"><i class="ti ti-plus"></i> 품목 추가</button></div>'
      + '<div style="max-height:52vh;overflow:auto"><table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr style="background:var(--cr,#faf7f2)"><th style="padding:5px 6px;text-align:left">공급처</th><th style="padding:5px 6px;text-align:left">구분</th><th style="padding:5px 6px;text-align:left">품목명</th><th style="padding:5px 6px;text-align:left">규격</th><th style="padding:5px 6px;text-align:right">개당단가</th><th></th></tr></thead><tbody>' + (rows || '<tr><td colspan="6" style="padding:12px;text-align:center;color:var(--th)">등록된 품목이 없습니다</td></tr>') + '</tbody></table></div>', '닫기', function () { return true; });
  };
  IM.openItemEdit = async function (id) {
    const m = id != null ? (window.__imMasterMap || {})[id] : null;
    const vs = await loadVendorsForStore();
    const allV = await rpc('ch_vendors', {}).catch(() => []);
    const vlist = (allV && allV.length) ? allV : vs;
    const vOpt = '<option value="">(공급처)</option>' + vlist.map(v => '<option value="' + esc(v.slug) + '"' + (m && m.vendor_slug === v.slug ? ' selected' : '') + '>' + esc(v.canonical || v.slug) + '</option>').join('');
    modal((m ? '품목 수정' : '품목 추가'),
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">'
      + '<div><label style="font-size:11px;color:var(--th)">공급처</label><select id="itV" class="form-input">' + vOpt + '</select></div>'
      + '<div><label style="font-size:11px;color:var(--th)">구분</label><input id="itC" class="form-input" value="' + esc(m ? m.category || '' : '') + '"></div>'
      + '<div style="grid-column:1/3"><label style="font-size:11px;color:var(--th)">품목명</label><input id="itI" class="form-input" value="' + esc(m ? m.item || '' : '') + '"></div>'
      + '<div><label style="font-size:11px;color:var(--th)">규격단위</label><input id="itS" class="form-input" value="' + esc(m ? m.spec || '' : '') + '" placeholder="1박스=20줄"></div>'
      + '<div><label style="font-size:11px;color:var(--th)">단위</label><input id="itU" class="form-input" value="' + esc(m ? m.unit || '' : '') + '"></div>'
      + '<div><label style="font-size:11px;color:var(--th)">규격당 단가</label><input id="itPP" type="number" class="form-input" value="' + (m && m.pack_price != null ? m.pack_price : '') + '"></div>'
      + '<div><label style="font-size:11px;color:var(--th)">개당 단가</label><input id="itUP" type="number" class="form-input" value="' + (m && m.unit_price != null ? m.unit_price : '') + '"></div>'
      + '<div><label style="font-size:11px;color:var(--th)">과세구분</label><select id="itT" class="form-input"><option value="">(선택)</option><option' + (m && m.tax_type === '과세' ? ' selected' : '') + '>과세</option><option' + (m && m.tax_type === '면세' ? ' selected' : '') + '>면세</option></select></div>'
      + '<div><label style="font-size:11px;color:var(--th)">제품구분</label><select id="itPT" class="form-input"><option value="purchase"' + (!m || m.product_type !== 'exclusive' ? ' selected' : '') + '>사입(공용)</option><option value="exclusive"' + (m && m.product_type === 'exclusive' ? ' selected' : '') + '>전용</option></select></div>'
      + '</div><div id="itMsg" style="font-size:12px;color:#B91C1C;margin-top:6px;min-height:14px"></div>',
      '저장', async function () {
        const item = (document.getElementById('itI').value || '').trim();
        if (!item) { document.getElementById('itMsg').textContent = '품목명을 입력하세요'; return false; }
        const nv = x => { const v = document.getElementById(x).value; return v === '' ? null : Number(v); };
        try { await rpc('ch_item_save', { p_id: id, p_vendor: document.getElementById('itV').value || null, p_category: document.getElementById('itC').value.trim() || null, p_item: item, p_spec: document.getElementById('itS').value.trim() || null, p_unit: document.getElementById('itU').value.trim() || null, p_pack_price: nv('itPP'), p_unit_price: nv('itUP'), p_tax: document.getElementById('itT').value || null, p_product_type: document.getElementById('itPT').value, p_active: true }); }
        catch (e) { document.getElementById('itMsg').textContent = e.missing ? '보안 SQL 미실행 (closing_module5.sql)' : '오류: ' + e.message; return false; }
        toast('저장 완료'); IM.openItemMaster(); return true;
      });
  };
  IM.openPending = async function () {
    if (!isHQ()) return;
    let list = []; try { list = await rpc('ch_item_pending', {}) || []; } catch (e) {}
    window.__imPendMap = {}; list.forEach(m => { window.__imPendMap[m.id] = m; });
    const rows = list.map(m => '<tr><td style="padding:4px 6px;border-bottom:0.5px solid var(--crm,#eee);font-weight:600">' + esc(m.item) + '</td><td style="padding:4px 6px;border-bottom:0.5px solid var(--crm,#eee);font-size:11px;color:var(--th)">' + esc(m.vendor_slug || '-') + ' / ' + esc(m.category || '-') + ' / ' + esc(m.spec || '-') + '</td><td style="padding:4px 6px;border-bottom:0.5px solid var(--crm,#eee);font-size:11px;color:var(--th)">' + esc(m.requested_store || '') + '</td><td style="padding:4px 6px;border-bottom:0.5px solid var(--crm,#eee);white-space:nowrap"><button class="btn-submit" style="font-size:11px;padding:2px 8px" onclick="InventoryMgr.approveItem(' + m.id + ')">승인</button> <button class="btn-cancel-sm" style="font-size:11px;padding:2px 8px;color:#B91C1C;border-color:#FCA5A5" onclick="InventoryMgr.rejectItem(' + m.id + ')">반려</button></td></tr>').join('');
    modal('신규 품목 분류대기 (' + list.length + ')',
      '<div style="font-size:12px;color:var(--th);margin-bottom:8px">승인 시 표준 구분/공급처/단가를 지정하면 전 매장 마스터에 공통 반영됩니다.</div>'
      + '<div style="max-height:52vh;overflow:auto"><table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr style="background:var(--cr,#faf7f2)"><th style="padding:5px 6px;text-align:left">품목명</th><th style="padding:5px 6px;text-align:left">공급처/구분/규격</th><th style="padding:5px 6px;text-align:left">요청매장</th><th></th></tr></thead><tbody>' + (rows || '<tr><td colspan="4" style="padding:12px;text-align:center;color:var(--th)">분류대기 품목이 없습니다</td></tr>') + '</tbody></table></div>', '닫기', function () { return true; });
  };
  IM.approveItem = function (id) {
    const m = (window.__imPendMap || {})[id]; if (!m) return;
    window.__imMasterMap = window.__imMasterMap || {}; window.__imMasterMap[id] = m;
    IM.openItemEdit(id);
    // openItemEdit 저장 시 ch_item_save 로 status=approved 처리됨
  };
  IM.rejectItem = function (id) {
    if (!confirm('이 신규 품목 요청을 반려(삭제)할까요?')) return;
    rpc('ch_item_reject', { p_id: id }).then(() => { toast('반려 완료'); IM.openPending(); }).catch(e => alert('오류: ' + (e.message || e)));
  };
  /* ───────── 본사(+예외권한): 품목 꾸러미 (사입 동일품목 그룹핑) ───────── */
  const won2 = n => (n == null ? '-' : won(n) + '원');
  IM.openBundle = async function () {
    let cans = [], bundles = [];
    try { cans = await rpc('ch_bundle_candidates', {}) || []; }
    catch (e) {
      if (e.missing) { alert('보안 SQL(closing_module8.sql)을 먼저 실행해 주세요.'); return; }
      if (/ACCESS_DENIED/.test(e.message || '')) { alert('품목 꾸러미 접근 권한이 없습니다.'); return; }
    }
    try { bundles = await rpc('ch_bundle_list', {}) || []; } catch (e) {}
    window.__bundleCand = cans;
    const bHtml = bundles.map(b => {
      const mem = (b.members || []).map(m => '<div style="font-size:11px;color:var(--th);padding:1px 0">· ' + esc(m.vendor || '') + ' · ' + esc(m.item) + (m.spec ? ' (' + esc(m.spec) + ')' : '') + ' — ' + won2(m.unit_price) + ' / 입고 ' + (m.in_qty || 0) + '</div>').join('');
      return '<div style="border:0.5px solid var(--crd);border-radius:8px;padding:8px 10px;margin-bottom:6px;background:#fff"><div style="display:flex;align-items:center;margin-bottom:3px"><b style="font-size:12px">' + esc(b.std_item || b.name || '꾸러미') + (b.std_spec ? ' / ' + esc(b.std_spec) : '') + '</b><button class="btn-cancel-sm" style="margin-left:auto;font-size:10px;padding:2px 7px;color:#B91C1C;border-color:#FCA5A5" onclick="InventoryMgr.bundleDel(' + b.id + ')">해제</button></div>' + mem + '<div style="font-size:12px;margin-top:5px;color:#15803D;font-weight:700">단순평균 ' + won2(b.simple_avg) + ' · 입고량 가중평균 ' + won2(b.weighted_avg) + '</div></div>';
    }).join('');
    const cHtml = cans.map((g, i) => '<div style="border:0.5px dashed #FBBF24;border-radius:8px;padding:8px 10px;margin-bottom:6px;background:#FFFBEB"><div style="display:flex;align-items:center;flex-wrap:wrap;gap:4px"><b style="font-size:12px">' + esc(g.item) + (g.spec ? ' / ' + esc(g.spec) : '') + '</b> <span style="font-size:10px;color:#B45309">(' + g.cnt + '개 거래처)</span><span style="margin-left:auto;display:flex;gap:4px"><button class="btn-submit" style="font-size:10px;padding:3px 9px" onclick="InventoryMgr.bundleApprove(' + i + ')">승인(묶기)</button><button class="btn-cancel-sm" style="font-size:10px;padding:3px 9px" onclick="InventoryMgr.bundleReject(' + i + ')">반려</button></span></div>' + (g.members || []).map(m => '<div style="font-size:11px;color:var(--th);padding:1px 0">· ' + esc(m.vendor || '') + ' — ' + won2(m.unit_price) + '</div>').join('') + '</div>').join('');
    const masterBtn = cu().is_master ? '<button class="btn-cancel-sm" style="font-size:12px" onclick="InventoryMgr.openBundleAccess()"><i class="ti ti-key"></i> 접근 권한 관리</button>' : '';
    modal('품목 꾸러미 · 사입 동일품목 그룹핑',
      '<div style="font-size:11px;color:var(--th);margin-bottom:8px">여러 거래처에서 들여오는 동일 원재료를 하나로 묶어 거래처별 공급가와 평균 단가(제조원가 기준)를 산출합니다. 사입 품목만 대상입니다.</div>'
      + '<div style="display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap"><button class="btn-cancel-sm" style="font-size:12px" onclick="InventoryMgr.bundleManual()"><i class="ti ti-plus"></i> 수동 묶기</button>' + masterBtn + '</div>'
      + '<div style="font-size:12px;font-weight:800;margin:4px 0 5px">자동 후보 제안 (' + cans.length + ')</div><div style="max-height:30vh;overflow:auto">' + (cHtml || '<div style="font-size:12px;color:var(--th);padding:8px">제안할 동일품목 후보가 없습니다.</div>') + '</div>'
      + '<div style="font-size:12px;font-weight:800;margin:12px 0 5px">등록된 꾸러미 (' + bundles.length + ')</div><div style="max-height:32vh;overflow:auto">' + (bHtml || '<div style="font-size:12px;color:var(--th);padding:8px">등록된 꾸러미가 없습니다.</div>') + '</div>',
      '닫기', function () { return true; });
  };
  IM.bundleApprove = function (i) {
    const g = (window.__bundleCand || [])[i]; if (!g) return;
    modal('꾸러미 승인 · ' + esc(g.item),
      '<div style="font-size:12px;color:var(--th);margin-bottom:8px">아래 거래처 품목을 하나의 표준 꾸러미로 통합합니다.</div>'
      + '<label style="font-size:11px;font-weight:700">표준 품명</label><input id="bkItem" class="form-input" value="' + esc(g.item) + '" style="margin:3px 0 8px">'
      + '<label style="font-size:11px;font-weight:700">표준 규격</label><input id="bkSpec" class="form-input" value="' + esc(g.spec || '') + '" style="margin:3px 0 8px">'
      + '<div style="font-size:11px;color:var(--th);background:var(--cr,#faf7f2);border-radius:6px;padding:7px 9px">' + (g.members || []).map(m => '· ' + esc(m.vendor || '') + ' (' + won2(m.unit_price) + ')').join('<br>') + '</div>',
      '승인(묶기)', async function () {
        try { await rpc('ch_bundle_create', { p_name: null, p_std_item: (document.getElementById('bkItem').value || '').trim(), p_std_spec: (document.getElementById('bkSpec').value || '').trim() || null, p_member_ids: (g.members || []).map(m => m.id) }); }
        catch (e) { alert('오류: ' + (e.message || e)); return false; }
        toast('꾸러미 승인 완료'); IM.openBundle(); return true;
      });
  };
  IM.bundleReject = async function (i) {
    const g = (window.__bundleCand || [])[i]; if (!g) return;
    if (!confirm("'" + g.item + "' 를 일치하지 않는 품목으로 반려하면 다시 제안되지 않습니다. 계속할까요?")) return;
    try { await rpc('ch_bundle_reject', { p_sig: g.sig }); toast('반려 완료'); IM.openBundle(); } catch (e) { alert('오류: ' + (e.message || e)); }
  };
  IM.bundleDel = async function (id) {
    if (!confirm('이 꾸러미를 해제할까요? (개별 품목으로 되돌아갑니다)')) return;
    try { await rpc('ch_bundle_del', { p_id: id }); toast('해제 완료'); IM.openBundle(); } catch (e) { alert('오류: ' + (e.message || e)); }
  };
  IM.bundleManual = function () {
    window.__bmPicks = [];
    modal('수동 묶기 · 사입 품목 검색',
      '<input id="bmKw" class="form-input" placeholder="품명으로 검색" oninput="InventoryMgr.bmSearch(this.value)" style="margin-bottom:6px">'
      + '<div id="bmResult" style="max-height:28vh;overflow:auto"></div>'
      + '<div style="font-size:12px;font-weight:800;margin-top:10px">선택됨 (<span id="bmCount">0</span>)</div><div id="bmPicked" style="max-height:16vh;overflow:auto;margin-top:3px"></div>'
      + '<label style="font-size:11px;font-weight:700;display:block;margin-top:8px">표준 품명</label><input id="bmItem" class="form-input" style="margin-top:3px">'
      + '<button class="btn-submit" style="font-size:13px;margin-top:10px;width:100%" onclick="InventoryMgr.bmCreate()">꾸러미 생성</button>',
      '닫기', function () { return true; });
    IM.bmSearch('');
  };
  IM.bmSearch = async function (kw) {
    const box = document.getElementById('bmResult'); if (!box) return;
    let list = []; try { list = await rpc('ch_bundle_search', { p_kw: kw || '' }) || []; } catch (e) {}
    window.__bmList = list;
    box.innerHTML = list.length ? list.map((m, i) => '<div onclick="InventoryMgr.bmPick(' + i + ')" style="padding:6px 8px;border:0.5px solid var(--crd);border-radius:6px;margin-bottom:3px;cursor:pointer;font-size:12px">' + esc(m.vendor || '') + ' · ' + esc(m.item) + (m.spec ? ' (' + esc(m.spec) + ')' : '') + (m.unit_price != null ? ' — ' + won(m.unit_price) + '원' : '') + '</div>').join('') : '<div style="font-size:12px;color:var(--th);padding:8px">검색 결과 없음(미묶음 사입 품목만 표시)</div>';
  };
  IM.bmPick = function (i) {
    const m = (window.__bmList || [])[i]; if (!m) return;
    if ((window.__bmPicks || []).some(x => x.id === m.id)) return;
    window.__bmPicks.push(m); IM.bmRenderPicked();
    const it = document.getElementById('bmItem'); if (it && !it.value) it.value = m.item;
  };
  IM.bmRenderPicked = function () {
    const el = document.getElementById('bmPicked'), c = document.getElementById('bmCount'), p = window.__bmPicks || [];
    if (c) c.textContent = p.length;
    if (el) el.innerHTML = p.map((m, i) => '<div style="font-size:11px;padding:2px 0">· ' + esc(m.vendor || '') + ' ' + esc(m.item) + ' <span onclick="InventoryMgr.bmUnpick(' + i + ')" style="color:#B91C1C;cursor:pointer;font-weight:700">✕</span></div>').join('');
  };
  IM.bmUnpick = function (i) { (window.__bmPicks || []).splice(i, 1); IM.bmRenderPicked(); };
  IM.bmCreate = async function () {
    const p = window.__bmPicks || []; if (p.length < 2) { alert('2개 이상 선택하세요.'); return; }
    const item = (document.getElementById('bmItem').value || '').trim();
    try { await rpc('ch_bundle_create', { p_name: null, p_std_item: item || p[0].item, p_std_spec: p[0].spec || null, p_member_ids: p.map(m => m.id) }); }
    catch (e) { alert('오류: ' + (e.message || e)); return; }
    const mm = document.getElementById('imModal'); if (mm) mm.remove();
    toast('꾸러미 생성 완료'); IM.openBundle();
  };
  IM.openBundleAccess = async function () {
    if (!cu().is_master) return;
    let granted = [], users = [];
    try { granted = await rpc('ch_bundle_access_list', {}) || []; } catch (e) {}
    try { users = await rpc('ch_bundle_users', {}) || []; } catch (e) {}
    const gset = {}; granted.forEach(g => { gset[g.user_id] = true; });
    const rows = users.map(u => '<tr><td style="padding:4px 6px;border-bottom:0.5px solid var(--crm,#eee)">' + esc(u.name) + ' <span style="font-size:10px;color:var(--th)">' + esc(u.store || '') + (u.position ? ' / ' + esc(u.position) : '') + '</span></td><td style="padding:4px 6px;border-bottom:0.5px solid var(--crm,#eee);text-align:center">' + (gset[u.id] ? '<button class="btn-cancel-sm" style="font-size:10px;padding:2px 9px;color:#B91C1C;border-color:#FCA5A5" onclick="InventoryMgr.bundleAccessSet(\'' + u.id + '\',false)">해제</button>' : '<button class="btn-submit" style="font-size:10px;padding:2px 9px" onclick="InventoryMgr.bundleAccessSet(\'' + u.id + '\',true)">부여</button>') + '</td></tr>').join('');
    modal('꾸러미 접근 권한 관리',
      '<div style="font-size:12px;color:var(--th);margin-bottom:8px">총괄(본사)은 기본 접근됩니다. 아래에서 계정별 예외 권한을 부여/해제하세요.</div>'
      + '<div style="max-height:54vh;overflow:auto"><table style="width:100%;border-collapse:collapse;font-size:12px"><tbody>' + (rows || '<tr><td style="padding:12px;text-align:center;color:var(--th)">직원이 없습니다</td></tr>') + '</tbody></table></div>',
      '닫기', function () { return true; });
  };
  IM.bundleAccessSet = async function (uid, grant) {
    try { await rpc('ch_bundle_access_set', { p_user_id: uid, p_grant: grant }); toast(grant ? '권한 부여' : '권한 해제'); IM.openBundleAccess(); } catch (e) { alert('오류: ' + (e.message || e)); }
  };
  /* ───────── 거래처 첨부파일(통장사본/사업자등록증) 서명 URL 열기 ───────── */
  IM.openVendorFile = async function (path) {
    if (!path) { alert('등록된 파일이 없습니다.'); return; }
    try {
      const { data, error } = await sbc().storage.from('closing-statements').createSignedUrl(path, 120);
      if (error || !data) { alert('파일을 열 수 없습니다.'); return; }
      window.open(data.signedUrl, '_blank');
    } catch (e) { alert('파일 열기 오류: ' + (e.message || e)); }
  };

  /* ───────── 본사: 월말 거래처 정산·이체 리스트 ───────── */
  IM.openSettlement = async function () {
    if (!isHQ()) return;
    let list = [];
    try { list = await rpc('ch_vendor_settlement', { p_ym: IM.state.ym }) || []; }
    catch (e) {
      if (e.missing) { alert('보안 SQL(closing_module9.sql)을 먼저 실행해 주세요.'); return; }
      if (/ACCESS_DENIED/.test(e.message || '')) { alert('본사 관리자만 조회할 수 있습니다.'); return; }
      alert('오류: ' + (e.message || e)); return;
    }
    window.__settle = list; window.__settleDay = '';
    IM._settleRender();
  };
  IM._settleRender = function () {
    const all = window.__settle || [], fday = window.__settleDay || '';
    const days = Array.from(new Set(all.map(v => v.settle_day).filter(Boolean)));
    const rows = all.filter(v => (v.amount || 0) > 0 && (!fday || (v.settle_day || '') === fday));
    const totalAmt = rows.reduce((s, v) => s + Number(v.amount || 0), 0);
    const dayBtns = '<button class="btn-cancel-sm" style="font-size:11px;padding:3px 9px' + (fday === '' ? ';background:#0F766E;color:#fff' : '') + '" onclick="InventoryMgr.settleFilter(\'\')">전체</button>'
      + days.map(d => '<button class="btn-cancel-sm" style="font-size:11px;padding:3px 9px' + (fday === d ? ';background:#0F766E;color:#fff' : '') + '" onclick="InventoryMgr.settleFilter(\'' + esc(d).replace(/'/g, "\\'") + '\')">' + esc(d) + (/^\d+$/.test(d) ? '일' : '') + '</button>').join('');
    const tr = rows.map(v => '<tr>'
      + '<td style="padding:5px 7px;border-bottom:0.5px solid var(--crm,#eee);font-weight:600">' + esc(v.vendor || v.slug) + (v.settle_day ? ' <span style="font-size:10px;color:#0F766E">(' + esc(v.settle_day) + (/^\d+$/.test(v.settle_day) ? '일' : '') + ')</span>' : '') + '</td>'
      + '<td style="padding:5px 7px;border-bottom:0.5px solid var(--crm,#eee);font-size:11px;color:var(--th)">' + (v.settle_bank ? esc(v.settle_bank) + ' ' : '') + esc(v.settle_acct || '-') + '</td>'
      + '<td style="padding:5px 7px;border-bottom:0.5px solid var(--crm,#eee);text-align:right;font-weight:700">' + won(v.amount) + '원</td>'
      + '<td style="padding:5px 7px;border-bottom:0.5px solid var(--crm,#eee);text-align:center;white-space:nowrap">'
      + (v.bankbook_file ? '<button class="btn-cancel-sm" style="font-size:10px;padding:2px 6px" onclick="InventoryMgr.openVendorFile(\'' + esc(v.bankbook_file).replace(/'/g, "\\'") + '\')">통장</button> ' : '')
      + (v.biz_file ? '<button class="btn-cancel-sm" style="font-size:10px;padding:2px 6px" onclick="InventoryMgr.openVendorFile(\'' + esc(v.biz_file).replace(/'/g, "\\'") + '\')">사업자</button>' : '')
      + '</td></tr>').join('');
    modal(IM.state.ym + ' 거래처 정산·이체 리스트',
      '<div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:8px;align-items:center"><span style="font-size:11px;font-weight:700;color:var(--th)">정산시점</span>' + dayBtns
      + '<button class="btn-submit" style="font-size:11px;padding:3px 10px;margin-left:auto" onclick="InventoryMgr.exportSettlement()"><i class="ti ti-file-spreadsheet"></i> 엑셀</button></div>'
      + '<div style="font-size:12px;color:var(--th);margin-bottom:6px">대상 ' + rows.length + '개 거래처 · 합계 <b style="color:#0F766E">' + won(totalAmt) + '원</b> <span style="color:var(--th)">(금액 = 당월 입고량 × 공급가)</span></div>'
      + '<div style="max-height:56vh;overflow:auto"><table style="width:100%;border-collapse:collapse;font-size:12px;background:#fff"><thead><tr style="background:var(--cr,#faf7f2)"><th style="padding:6px 7px;text-align:left">거래처</th><th style="padding:6px 7px;text-align:left">정산 계좌</th><th style="padding:6px 7px;text-align:right">당월 매입액</th><th style="padding:6px 7px;text-align:center">서류</th></tr></thead><tbody>' + (tr || '<tr><td colspan="4" style="padding:14px;text-align:center;color:var(--th)">당월 매입 내역이 있는 거래처가 없습니다.</td></tr>') + '</tbody></table></div>',
      '닫기', function () { return true; });
  };
  IM.settleFilter = function (d) { window.__settleDay = d; IM._settleRender(); };
  IM.exportSettlement = function () {
    if (typeof XLSX === 'undefined') { alert('엑셀 라이브러리 로딩 중입니다.'); return; }
    const all = window.__settle || [], fday = window.__settleDay || '';
    const rows = all.filter(v => (v.amount || 0) > 0 && (!fday || (v.settle_day || '') === fday));
    const aoa = [['거래처', '정산시점', '은행', '계좌번호', '사업자번호', '담당자', '연락처', '매장수', '품목수', '당월 매입액']];
    rows.forEach(v => aoa.push([v.vendor || v.slug, v.settle_day || '', v.settle_bank || '', v.settle_acct || '', v.biz_no || '', v.mgr_name || '', v.mgr_phone || '', v.store_cnt || 0, v.item_cnt || 0, Math.round(Number(v.amount || 0))]));
    aoa.push(['합계', '', '', '', '', '', '', '', '', rows.reduce((s, v) => s + Math.round(Number(v.amount || 0)), 0)]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), '정산이체');
    XLSX.writeFile(wb, '거래처_정산이체_' + IM.state.ym + (fday ? '_' + fday : '') + '.xlsx');
  };

  /* ───────── 단가 변동(인상·인하) 대시보드 — 매니저/본사 ───────── */
  IM.openPriceChanges = async function () {
    let d = {};
    try { d = await rpc('ch_price_changes', {}) || {}; }
    catch (e) {
      if (e.missing) { alert('보안 SQL(closing_module9.sql)을 먼저 실행해 주세요.'); return; }
      if (/ACCESS_DENIED/.test(e.message || '')) { alert('매니저·본사만 조회할 수 있습니다.'); return; }
      alert('오류: ' + (e.message || e)); return;
    }
    const isHq = !!d.is_hq, pend = d.pending || [], rec = d.recent || [];
    const arrow = diff => diff > 0 ? '<span style="color:#B91C1C;font-weight:700">▲</span>' : '<span style="color:#1D4ED8;font-weight:700">▼</span>';
    const diffTxt = (diff, rate) => (diff > 0 ? '+' : '') + won(diff) + '원 ' + arrow(diff) + (rate != null ? ' <span style="font-size:10px;color:var(--th)">(' + (rate > 0 ? '+' : '') + rate + '%)</span>' : '');
    const pHtml = pend.map(c => '<div style="border:0.5px solid var(--crd);border-radius:8px;padding:8px 10px;margin-bottom:6px;background:#fff"><div style="display:flex;align-items:center;flex-wrap:wrap;gap:4px"><b style="font-size:12px">' + esc(c.item) + '</b> <span style="font-size:10px;color:var(--th)">' + esc(c.vendor || '') + (c.spec ? ' / ' + esc(c.spec) : '') + '</span>'
      + '<span style="margin-left:auto;font-size:10px;color:#B45309;background:#FEF3C7;border-radius:4px;padding:1px 6px">' + esc(c.source || '') + '</span></div>'
      + '<div style="font-size:13px;margin-top:4px">' + won(c.base_price) + '원 → <b>' + won(c.new_price) + '원</b> · ' + diffTxt(c.diff, c.rate) + '</div>'
      + (isHq ? '<div style="display:flex;gap:4px;margin-top:6px"><button class="btn-submit" style="font-size:10px;padding:3px 9px" onclick="InventoryMgr.priceApply(' + c.id + ')">기준단가로 갱신</button><button class="btn-cancel-sm" style="font-size:10px;padding:3px 9px" onclick="InventoryMgr.priceDismiss(' + c.id + ')">무시</button></div>' : '')
      + '</div>').join('');
    const rHtml = rec.map(c => '<div style="font-size:11px;color:var(--th);padding:3px 0;border-bottom:0.5px solid var(--crm,#eee)">' + esc(c.item) + ' <span style="color:var(--th)">' + esc(c.vendor || '') + '</span> — ' + won(c.base_price) + ' → ' + won(c.new_price) + ' ' + ((c.diff || 0) > 0 ? '▲' : '▼') + ' <span style="font-size:10px">' + esc(c.source || '') + '</span></div>').join('');
    modal('단가 변동 내역' + (isHq ? ' (전사)' : ' (내 매장 품목)'),
      '<div style="font-size:11px;color:var(--th);margin-bottom:8px">거래명세서 업로드 또는 품목 단가 수정으로 기준단가와 달라진 품목입니다.' + (isHq ? ' [기준단가로 갱신]을 누르면 품목 마스터 단가가 새 값으로 바뀝니다.' : ' (기준단가 갱신은 본사에서 처리합니다.)') + '</div>'
      + '<div style="font-size:12px;font-weight:800;margin:4px 0 5px">미반영 변동 (' + pend.length + ')</div><div style="max-height:40vh;overflow:auto">' + (pHtml || '<div style="font-size:12px;color:var(--th);padding:8px">미반영 단가 변동이 없습니다.</div>') + '</div>'
      + (rec.length ? '<div style="font-size:12px;font-weight:800;margin:12px 0 5px">최근 반영 이력 (30일)</div><div style="max-height:24vh;overflow:auto">' + rHtml + '</div>' : ''),
      '닫기', function () { return true; });
  };
  IM.priceApply = async function (id) {
    try { const r = await rpc('ch_price_apply', { p_id: id }); if (r && r.ok) toast('기준단가 갱신 완료'); else { alert('이미 처리된 항목입니다.'); } IM.openPriceChanges(); } catch (e) { alert('오류: ' + (e.message || e)); }
  };
  IM.priceDismiss = async function (id) {
    if (!confirm('이 단가 변동을 무시할까요? (기준단가는 그대로 유지됩니다)')) return;
    try { await rpc('ch_price_dismiss', { p_id: id }); toast('무시 처리'); IM.openPriceChanges(); } catch (e) { alert('오류: ' + (e.message || e)); }
  };

  IM.downloadBackdataTemplate = function () {
    if (typeof XLSX === 'undefined') { alert('엑셀 라이브러리 로딩 중입니다.'); return; }
    const wb = XLSX.utils.book_new();
    const items = [['공급처', '구분', '품목명', '규격단위', '단위', '규격당단가', '개당단가', '과면세구분', '제품구분(전용/사입)'],
      ['청오팜', '원재료', '매일 생크림 1L', '1박스=12개', '개', '', '', '과세', '사입'],
      ['', '소모품', '빨대 (낱개)', '1박스=2000개', '개', '', '', '과세', '전용']];
    const stock = [['매장', '공급처', '품목명', '규격단위', '전월기말수량'],
      ['인천', '청오팜', '매일 생크림 1L', '1박스=12개', '5']];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(items), '품목마스터');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(stock), '매장별기말재고');
    XLSX.writeFile(wb, '백데이터_양식_' + IM.state.ym + '.xlsx');
  };
  IM.uploadBackdata = function (file) {
    if (!file) return;
    if (typeof XLSX === 'undefined') { alert('엑셀 라이브러리 로딩 중입니다.'); return; }
    const reader = new FileReader();
    reader.onload = async function (e) {
      try {
        const wb = XLSX.read(new Uint8Array(e.target.result), { type: 'array' });
        const findSheet = kw => wb.SheetNames.find(n => n.replace(/\s/g, '').indexOf(kw) !== -1);
        const itemSheet = findSheet('품목') || wb.SheetNames[0];
        const stockSheet = findSheet('기말') || findSheet('재고') || wb.SheetNames[1];
        const iaoa = XLSX.utils.sheet_to_json(wb.Sheets[itemSheet], { header: 1, defval: '' });
        const items = [];
        for (let r = 1; r < iaoa.length; r++) { const row = iaoa[r]; if (!row || !String(row[2] || '').trim()) continue; items.push({ vendor: String(row[0] || '').trim(), category: String(row[1] || '').trim(), item: String(row[2] || '').trim(), spec: String(row[3] || '').trim(), unit: String(row[4] || '').trim(), pack_price: String(row[5] || '').replace(/[^0-9.\-]/g, ''), unit_price: String(row[6] || '').replace(/[^0-9.\-]/g, ''), tax_type: String(row[7] || '').trim(), product_type: String(row[8] || '').indexOf('전용') !== -1 ? 'exclusive' : 'purchase' }); }
        const stock = [];
        if (stockSheet && wb.Sheets[stockSheet]) { const saoa = XLSX.utils.sheet_to_json(wb.Sheets[stockSheet], { header: 1, defval: '' }); for (let r = 1; r < saoa.length; r++) { const row = saoa[r]; if (!row || !String(row[0] || '').trim() || !String(row[2] || '').trim()) continue; stock.push({ store: String(row[0] || '').trim(), vendor: String(row[1] || '').trim(), item: String(row[2] || '').trim(), spec: String(row[3] || '').trim(), qty: String(row[4] || '').replace(/[^0-9.\-]/g, '') }); } }
        if (!items.length && !stock.length) { alert('업로드할 데이터를 찾지 못했습니다. 양식을 확인해 주세요.'); return; }
        if (!confirm('품목 ' + items.length + '건 / 기말재고 ' + stock.length + '건을 일괄 적재합니다. 계속할까요?')) return;
        let res; try { res = await rpc('ch_backdata_upload', { p_ym: IM.state.ym, p_items: items, p_stock: stock }); }
        catch (err) { alert('오류: ' + (err.missing ? '보안 SQL 미실행 (closing_module5.sql)' : (/ACCESS_DENIED/.test(err.message || '') ? '본사 관리자만 가능' : err.message))); return; }
        alert('적재 완료 — 품목 ' + res.items + '건 / 신규 공급처 ' + res.vendors_new + '건 / ' + res.prev_ym + ' 기말재고 ' + res.stock + '건');
        IM.renderHQ();
      } catch (err) { alert('파싱 오류: ' + (err.message || err)); }
    };
    reader.readAsArrayBuffer(file);
  };

  /* ───────── 마운트 / 로그인 시 푸시 SW 등록 + 리마인드 핑 ───────── */
  IM.boot = function () {
    IM.applyNav();
    // 30분 자동 로그아웃 직전 실사 임시저장 훅
    window.__beforeAutoLogout = async function () { try { if (IM.cnt && IM.state.tab === 'count') await IM.draftSave(false); } catch (e) {} };
    // 기존 구독자는 조용히 SW 재등록(갱신). 신규 구독은 배너로.
    try { if ('serviceWorker' in navigator && Notification && Notification.permission === 'granted') navigator.serviceWorker.register('./sw.js'); } catch (e) {}
    // 로그인 시 실사 리마인드 1회 핑(서버가 D-1/초과 판단 + 일일 중복방지)
    try { IM.pushSend({ mode: 'inventory_reminders', ym: (new Date()).toISOString().slice(0, 7) }); } catch (e) {}
  };
  (function waitUser(n) {
    if (curUser() && sbc()) { IM.boot(); }
    else if (n < 60) { setTimeout(function () { waitUser(n + 1); }, 250); }
  })(0);
  IM.remount = function () { try { IM.boot(); } catch (e) {} };
})();
