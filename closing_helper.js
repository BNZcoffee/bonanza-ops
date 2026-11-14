/* ============================================================================
 * 월말 정산 도우미 (보난자 월말 도우미 통합판) — closing_helper.js  (보안 RPC 판)
 *
 * 모든 데이터 접근은 Secure RPC(ch_*)만 사용한다. closing_* 테이블은 RLS Deny 라
 * 직접 sb.from(...) 은 막혀 있다(설계상). RPC 가 아직 없으면(보안 SQL 미실행) 안내만 띄운다.
 *
 * 접근/매장 범위는 서버(ch_access/ch_stores)가 결정해 내려준다(PDC 제외, 매니저=본인+겸직).
 * 클라이언트는 받은 목록만 보여줄 뿐, 파라미터 조작해도 RPC 내부에서 재검증·차단된다.
 *
 * 거래처 파싱: 기존 월말 도우미 vendor-parsers.js 를 그대로 이식(파일명→거래처→시트 파서).
 * 분류: 서버 분류 마스터(ch_classify) 기준. 카테고리 = 원재료/부재료/소모품/상품(+법인카드 업체라인).
 * ==========================================================================*/
(function () {
  'use strict';
  if (window.ClosingHelper) return;
  const CH = (window.ClosingHelper = {});
  const esc = (s) => (window.esc ? window.esc(s) : String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  const sbc = () => window.sb;
  const won = (n) => (Math.round(Number(n) || 0)).toLocaleString('ko-KR');
  const pct = (a, b) => (b > 0 ? (a / b * 100) : 0);
  const token = () => (typeof getSessionToken === 'function' ? getSessionToken() : (window.__sessionToken || null));
  const STORAGE_BUCKET = 'closing-statements';
  const CATEGORIES = ['원재료', '부재료', '소모품', '상품'];
  const CORP = '💳 법인카드 사용액';

  /* ───────────── 거래처 파서 (vendor-parsers.js 이식) ───────────── */
  const VP = (function () {
    const VENDORS = [
      { slug: '엠티엘컴퍼니', canonical: '㈜엠티엘컴퍼니' },
      { slug: '공주엔엔아이', canonical: '주식회사 공주엔엔아이' },
      { slug: '청오팜', canonical: '청오팜(주)' },
      { slug: '가람비엔에프', canonical: '㈜ 가람비엔에프' },
      { slug: '갤러리아지기', canonical: '갤러리아지기' }
    ];
    function detectVendor(filename) {
      const f = String(filename).toLowerCase();
      if (f.indexOf('mtl') !== -1 || filename.indexOf('엠티엘') !== -1) return '엠티엘컴퍼니';
      if (filename.indexOf('갤러리아') !== -1) return '갤러리아지기';
      if (filename.indexOf('공주') !== -1) return '공주엔엔아이';
      if (filename.indexOf('가람') !== -1) return '가람비엔에프';
      if (filename.indexOf('청오') !== -1) return '청오팜';
      return null;
    }
    function numJS(v) { if (v == null || v === '') return 0; if (typeof v === 'number') return v; const n = parseFloat(String(v).replace(/,/g, '')); return isNaN(n) ? 0 : n; }
    function cleanItem(s) { s = String(s).trim(); return s.replace(/^\[[^\]]*\]\s*/, '').trim(); }
    function sheetToAoa(ws) { if (!ws) return null; try { const range = ws['!ref'] ? XLSX.utils.decode_range(ws['!ref']) : { s: { r: 0, c: 0 }, e: { r: 0, c: 0 } }; range.s.r = 0; range.s.c = 0; return XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true, range }); } catch (e) { return null; } }
    function parseMTL(wb) {
      const aoa = sheetToAoa(wb.Sheets['거래명세서']); if (!aoa) return [];
      const rows = []; let store = null, inTable = false, cI = -1, cQ = -1, cS = -1, cV = -1;
      for (let r = 0; r < aoa.length; r++) {
        const c1 = aoa[r][0];
        if (typeof c1 === 'string' && c1.startsWith('수신-거래처')) { const i = c1.indexOf(':'); store = i !== -1 ? c1.slice(i + 1).trim() : c1.trim(); inTable = false; continue; }
        if (c1 === '출고일') { inTable = true; const row = aoa[r] || []; cI = row.indexOf('품목명'); cQ = row.indexOf('수량'); cS = row.indexOf('공급가액'); cV = row.indexOf('부가세'); continue; }
        if (typeof c1 === 'string' && c1.startsWith('전표번호')) { inTable = false; continue; }
        if (!inTable || cI === -1 || cQ === -1 || cS === -1 || cV === -1) continue;
        const item = aoa[r][cI]; if (!item) continue;
        const supply = numJS(aoa[r][cS]), vat = numJS(aoa[r][cV]);
        rows.push({ store, item: cleanItem(item), qty: numJS(aoa[r][cQ]), supply, vat, total: supply + vat });
      }
      return rows;
    }
    const SKIP_GJ = new Set(['이월', '일계', '월계', '누계', '전기이월']);
    function parseGalleriajigi(wb) {
      const rows = []; wb.SheetNames.forEach(sn => {
        const aoa = sheetToAoa(wb.Sheets[sn]); if (!aoa) return; let hr = -1;
        for (let r = 0; r < Math.min(aoa.length, 15); r++) if (aoa[r][3] === '품목(규격)/계정') { hr = r; break; }
        if (hr === -1) return;
        for (let r = hr + 1; r < aoa.length; r++) { const item = aoa[r][3]; if (!item) continue; const s = String(item).trim(); if (SKIP_GJ.has(s) || s.startsWith('RUNDATE')) continue; rows.push({ store: sn, item: cleanItem(s), qty: numJS(aoa[r][4]), supply: numJS(aoa[r][6]), vat: numJS(aoa[r][7]), total: numJS(aoa[r][8]) }); }
      }); return rows;
    }
    function parseGongju(wb) {
      const rows = []; wb.SheetNames.forEach(sn => {
        const aoa = sheetToAoa(wb.Sheets[sn]); if (!aoa) return; const store = sn.replace(/(과세|면세)$/, ''); let hr = -1;
        for (let r = 0; r < Math.min(aoa.length, 10); r++) { const v = aoa[r][2]; if (v && String(v).indexOf('품목명') !== -1) { hr = r; break; } }
        if (hr === -1) return;
        for (let r = hr + 1; r < aoa.length; r++) { const item = aoa[r][2], no2 = aoa[r][1]; if (!item || no2 == null) continue; rows.push({ store, item: cleanItem(item), qty: numJS(aoa[r][3]), supply: numJS(aoa[r][5]), vat: numJS(aoa[r][6]), total: numJS(aoa[r][7]) }); }
      }); return rows;
    }
    const SKIP_GR = new Set(['전기이월', '일계', '월계', '업체계', '면세품 합계', '과세품 합계', '영세품 합계', '총 합계']);
    function parseGaram(wb) {
      const rows = []; wb.SheetNames.forEach(sn => {
        const aoa = sheetToAoa(wb.Sheets[sn]); if (!aoa) return;
        let hr = -1, cI = -1, cQ = -1, cS = -1, cV = -1, cT = -1, cVn = -1;
        for (let r = 0; r < Math.min(aoa.length, 10); r++) { const row = aoa[r] || []; const i = row.indexOf('상품명'); if (i !== -1) { hr = r; cI = i; cQ = row.indexOf('수량'); cS = row.indexOf('공급가액'); cV = row.indexOf('부가세'); cT = row.indexOf('합계액'); cVn = row.indexOf('거래처명'); break; } }
        if (hr === -1 || cQ === -1 || cS === -1 || cV === -1 || cT === -1) return;
        for (let r = hr + 1; r < aoa.length; r++) {
          const item = aoa[r][cI]; if (!item) continue; let s = String(item).trim().replace(/^\[+/, '').replace(/\]+$/, ''); if (SKIP_GR.has(s)) continue;
          let store = sn; if (cVn !== -1) { const vr = aoa[r][cVn]; if (vr) { const p = String(vr).trim().split('-'); store = p.length > 1 ? p[p.length - 1].trim() : String(vr).trim(); } }
          rows.push({ store, item: cleanItem(s), qty: numJS(aoa[r][cQ]), supply: numJS(aoa[r][cS]), vat: numJS(aoa[r][cV]), total: numJS(aoa[r][cT]) });
        }
      }); return rows;
    }
    function parseCheongo(wb) {
      const rows = [];
      function ext(aoa) { let hr = -1; for (let r = 0; r < Math.min(aoa.length, 11); r++) if (aoa[r][2] === '상품명') { hr = r; break; } if (hr === -1) return; for (let r = hr + 1; r < aoa.length; r++) { const item = aoa[r][2], sr = aoa[r][0]; if (!item || !sr) continue; const p = String(sr).split('/'); rows.push({ store: p[p.length - 1].trim(), item: cleanItem(item), qty: numJS(aoa[r][5]), supply: numJS(aoa[r][8]), vat: numJS(aoa[r][9]), total: numJS(aoa[r][10]) }); } }
      const led = sheetToAoa(wb.Sheets['월별원장']); if (led) ext(led);
      if (!rows.length) wb.SheetNames.forEach(sn => { if (sn === '월별원장') return; const aoa = sheetToAoa(wb.Sheets[sn]); if (aoa) ext(aoa); });
      return rows;
    }
    const PARSERS = { '엠티엘컴퍼니': parseMTL, '갤러리아지기': parseGalleriajigi, '공주엔엔아이': parseGongju, '가람비엔에프': parseGaram, '청오팜': parseCheongo };
    function parseStatement(slug, wb) { const p = PARSERS[slug]; if (!p) return []; return p(wb).filter(r => r.qty !== 0 || r.supply !== 0 || r.vat !== 0 || r.total !== 0); }
    function aggregateByItem(rows) { const m = {}; rows.forEach(r => { const a = m[r.item] || (m[r.item] = { qty: 0, supply: 0, vat: 0, total: 0 }); a.qty += r.qty; a.supply += r.supply; a.vat += r.vat; a.total += r.total; }); return Object.keys(m).map(it => ({ item: it, qty: m[it].qty, supply: Math.round(m[it].supply), vat: Math.round(m[it].vat), total: Math.round(m[it].total) })); }
    return { VENDORS, detectVendor, parseStatement, aggregateByItem };
  })();
  CH.VP = VP;

  /* ───────────── RPC 래퍼 ───────────── */
  async function rpc(name, args) {
    const { data, error } = await sbc().rpc(name, Object.assign({ p_token: token() }, args || {}));
    if (error) {
      if (/does not exist|could not find|schema cache|function .* does not exist/i.test(error.message || '')) { const e = new Error('RPC_MISSING'); e.missing = true; throw e; }
      throw error;
    }
    return data;
  }
  CH._rpc = rpc;

  function toast(msg) {
    try { let t = document.getElementById('chToast'); if (!t) { t = document.createElement('div'); t.id = 'chToast'; t.style.cssText = 'position:fixed;left:50%;bottom:32px;transform:translateX(-50%);background:rgba(43,26,14,.92);color:#fff;padding:10px 18px;border-radius:10px;font-size:13px;z-index:100000;box-shadow:0 6px 24px rgba(0,0,0,.25);max-width:90vw;text-align:center'; document.body.appendChild(t); } t.textContent = msg; t.style.display = 'block'; clearTimeout(window.__chToastT); window.__chToastT = setTimeout(() => { try { t.style.display = 'none'; } catch (_) {} }, 2600); } catch (e) { try { alert(msg); } catch (_) {} }
  }
  CH._toast = toast;

  /* ───────────── 권한 / 피처플래그 / 매장 스코프 ───────────── */
  CH.canAccess = function () { return !!(window.__closingAccess && window.__closingAccess.role && window.__closingAccess.role !== 'none'); };
  CH.isHQ = function () { return !!(window.__closingAccess && window.__closingAccess.role === 'hq'); };
  CH.stores = function () { return (window.__closingAccess && Array.isArray(window.__closingAccess.stores)) ? window.__closingAccess.stores : []; };
  CH.navVisible = function () {
    const u = window.currentUser; if (!u) return false;
    if (window.__closingVisible === true) return CH.canAccess();
    return !!u.is_master;   // 미공개(기본): 총괄만
  };
  CH.applyNav = function () {
    const el = document.getElementById('nav-closingHelper'); if (!el) return;
    el.style.display = CH.navVisible() ? '' : 'none';
    el.innerHTML = '<i class="ti ti-calculator"></i> ' + (window.__closingVisible !== true ? '[개발중] ' : '') + '월말 정산 도우미';
  };
  CH.loadFlags = async function () {
    // 공개 플래그는 app_settings(공개 테이블) 직접 조회 — 민감정보 아님
    window.__closingVisible = false;
    try { const { data } = await sbc().from('app_settings').select('key,value').eq('key', 'closing_menu_visible'); if (data && data[0]) { const v = String(data[0].value).toLowerCase().replace(/"/g, '').trim(); window.__closingVisible = (v === 'true' || v === '1'); } } catch (e) {}
    // 권한/매장 범위는 서버가 결정
    try { window.__closingAccess = await rpc('ch_access', {}); } catch (e) { window.__closingAccess = (window.currentUser && window.currentUser.is_master) ? { role: 'hq', stores: [], canManageVendors: true, _degraded: true } : { role: 'none', stores: [] }; }
    CH.applyNav();
    return true;
  };

  CH.state = { tab: 1, parsed: null, year: (new Date()).toISOString().slice(0, 4), ym: (new Date()).toISOString().slice(0, 7), store: '' };

  function ensureStore() {
    const sts = CH.stores();
    if (!CH.state.store || sts.indexOf(CH.state.store) === -1) CH.state.store = sts.length ? sts[0] : '';
  }
  function storeSelectorHtml(onchange) {
    const sts = CH.stores();
    if (!CH.isHQ() && sts.length <= 1) {
      return '<span style="font-size:13px;font-weight:700"><i class="ti ti-building-store"></i> ' + esc(sts[0] || '담당 매장 없음') + '</span>';
    }
    const opts = (CH.isHQ() ? ['<option value="__ALL__">전 매장(요약)</option>'] : []).concat(sts.map(s => '<option value="' + esc(s) + '"' + (s === CH.state.store ? ' selected' : '') + '>' + esc(s) + '</option>')).join('');
    return '<select class="form-input" style="width:190px" onchange="' + onchange + '">' + opts + '</select>';
  }

  /* ───────────── 메인 렌더 ───────────── */
  CH.render = function (area) {
    if (!CH.canAccess()) { area.innerHTML = '<div style="text-align:center;padding:60px;color:var(--th)">접근 권한이 없습니다. (총괄 / 매장관리자 / 허용 부서담당 / 예외 허용자만)</div>'; return; }
    if (window.__closingAccess && window.__closingAccess._degraded) { area.innerHTML = '<div style="text-align:center;padding:50px;color:#B91C1C">보안 RPC(ch_*)가 아직 적용되지 않았습니다. Supabase에서 closing_security.sql을 먼저 실행해주세요.</div>'; return; }
    ensureStore();
    const tab = CH.state.tab;
    const tb = (n, label, icon) => '<button onclick="ClosingHelper.goTab(' + n + ')" style="flex:1;padding:10px 8px;border:none;border-bottom:2.5px solid ' + (tab === n ? 'var(--br,#8a5a2b)' : 'transparent') + ';background:none;font-size:13px;font-weight:' + (tab === n ? '700' : '500') + ';color:' + (tab === n ? 'var(--br,#8a5a2b)' : 'var(--th)') + ';cursor:pointer"><i class="ti ' + icon + '"></i> ' + label + '</button>';
    const settingsBtn = CH.isHQ() ? '<button class="btn-cancel-sm" style="font-size:12px" onclick="ClosingHelper.openSettings()"><i class="ti ti-shield-lock"></i> 권한/거래처 설정</button>' : '';
    area.innerHTML =
      '<div style="max-width:1220px;margin:0 auto;padding:4px 2px 40px">'
      + '<div style="display:flex;align-items:center;gap:10px;margin-bottom:4px"><h2 style="font-size:19px;font-weight:800;margin:0"><i class="ti ti-calculator" style="color:var(--br,#8a5a2b)"></i> 월말 정산 도우미</h2>'
      + (window.__closingVisible !== true ? '<span style="font-size:11px;background:#FEF3C7;color:#92400E;border-radius:6px;padding:2px 8px;font-weight:700">개발중 · 총괄 전용</span>' : '')
      + '<span style="font-size:11px;color:var(--th)">' + (CH.isHQ() ? '본사 관리자' : '매장 관리자') + '</span>'
      + '<span style="margin-left:auto">' + settingsBtn + '</span></div>'
      + '<div style="display:flex;border-bottom:0.5px solid var(--crd);margin:8px 0 14px;flex-wrap:wrap">' + tb(1, '서류 자동검수', 'ti-file-search') + tb(2, '발주 추이 & 원가', 'ti-chart-line') + tb(3, '품목·단가 & 보관함', 'ti-database') + tb(4, '법인카드', 'ti-credit-card') + (CH.isHQ() ? tb(5, '거래처', 'ti-truck') : '') + '</div>'
      + '<div id="chTabBody"></div></div>';
    if (tab === 1) CH.renderTab1(); else if (tab === 2) CH.renderTab2(); else if (tab === 3) CH.renderTab3(); else if (tab === 4) CH.renderTab4(); else CH.renderTab5();
  };
  CH.goTab = function (n) { CH.state.tab = n; CH.render(document.getElementById('contentArea')); };

  /* ======================================================================
   * [탭 1] 서류 자동검수 — 거래명세서(전사 합산) + 입재고(전월↔당월)
   * ==================================================================== */
  CH.renderTab1 = function () {
    const b = document.getElementById('chTabBody'); if (!b) return;
    b.innerHTML =
      '<div style="border:1.5px dashed var(--crd);border-radius:10px;padding:16px;text-align:center;background:var(--cr,#faf7f2);cursor:pointer;margin-bottom:12px" onclick="document.getElementById(\'chFile\').click()">'
      + '<i class="ti ti-file-spreadsheet" style="font-size:26px;color:var(--br,#8a5a2b)"></i>'
      + '<div style="font-size:13px;font-weight:700;margin-top:6px">거래명세서 엑셀 업로드 (전 매장 합산 검수)</div>'
      + '<div style="font-size:11px;color:var(--th)">파일명으로 거래처 자동 인식 — 엠티엘/갤러리아/공주/가람/청오. 분류 마스터로 카테고리 집계</div>'
      + '<input type="file" id="chFile" accept=".xlsx,.xls" style="display:none" onchange="ClosingHelper.parseStatement(this.files[0])"></div>'
      + '<div id="chParseResult"></div>';
    if (CH.state.parsed) CH.renderParseResult();
  };
  CH.parseStatement = function (file) {
    if (!file) return;
    const slug = VP.detectVendor(file.name);
    if (!slug) { alert('파일명에서 거래처를 인식하지 못했습니다.\n(엠티엘/갤러리아/공주/가람/청오 가 파일명에 있어야 합니다)'); return; }
    const reader = new FileReader();
    reader.onload = async function (e) {
      try {
        const wb = XLSX.read(new Uint8Array(e.target.result), { type: 'array' });
        const rows = VP.parseStatement(slug, wb);
        const agg = VP.aggregateByItem(rows);
        let clsMap = {};
        try { clsMap = await rpc('ch_classify', { p_vendor: slug }) || {}; } catch (err) { clsMap = {}; }
        agg.forEach(it => { it.cat = clsMap[it.item] || '미분류'; });
        CH.state.parsed = { fileName: file.name, slug, ym: (CH.state.ym), items: agg, rawCount: rows.length };
        CH.renderParseResult();
      } catch (err) { alert('파싱 오류: ' + err.message); }
    };
    reader.readAsArrayBuffer(file);
  };
  CH.renderParseResult = function () {
    const box = document.getElementById('chParseResult'); if (!box) return; const P = CH.state.parsed; if (!P) { box.innerHTML = ''; return; }
    const byCat = {}; CATEGORIES.concat(['미분류']).forEach(c => byCat[c] = 0);
    P.items.forEach(it => { byCat[it.cat] = (byCat[it.cat] || 0) + it.total; });
    const total = P.items.reduce((a, it) => a + it.total, 0);
    const catRows = Object.keys(byCat).filter(c => byCat[c]).map(c => '<tr><td style="padding:5px 10px;border-bottom:0.5px solid var(--crd)">' + esc(c) + '</td><td style="padding:5px 10px;border-bottom:0.5px solid var(--crd);text-align:right;font-weight:700">' + won(byCat[c]) + '</td><td style="padding:5px 10px;border-bottom:0.5px solid var(--crd);text-align:right;color:var(--th)">' + (total ? pct(byCat[c], total).toFixed(1) : 0) + '%</td></tr>').join('');
    const unclassified = P.items.filter(it => it.cat === '미분류').length;
    box.innerHTML =
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px"><span style="font-size:13px;font-weight:700"><i class="ti ti-file-check"></i> ' + esc(P.fileName) + '</span>'
      + '<span style="font-size:12px;color:var(--th)">거래처 ' + esc(P.slug) + ' · 품목 ' + P.items.length + '건 · 합계 ' + won(total) + '원' + (unclassified ? ' · 미분류 ' + unclassified + '건' : '') + '</span>'
      + '<span style="margin-left:auto;display:flex;gap:6px"><button class="btn-cancel-sm" style="font-size:12px" onclick="ClosingHelper.exportCsv()"><i class="ti ti-download"></i> CSV</button>'
      + (CH.isHQ() ? '<button class="btn-cancel-sm" style="font-size:12px" onclick="ClosingHelper.saveMonthly()"><i class="ti ti-database-import"></i> 단가이력 저장</button>' : '')
      + '<button class="btn-submit" style="font-size:12px" onclick="ClosingHelper.openApply()"><i class="ti ti-arrow-bar-to-right"></i> 발주 비중에 반영</button></span></div>'
      + '<div style="display:grid;grid-template-columns:320px 1fr;gap:14px;align-items:start">'
      + '<table style="width:100%;border-collapse:collapse;background:#fff;border:0.5px solid var(--crd);border-radius:8px;overflow:hidden;font-size:13px"><thead><tr style="background:var(--cr,#faf7f2)"><th style="padding:6px 10px;text-align:left">카테고리</th><th style="padding:6px 10px;text-align:right">금액</th><th style="padding:6px 10px;text-align:right">비중</th></tr></thead><tbody>' + catRows + '<tr style="background:#FEF9F0"><td style="padding:6px 10px;font-weight:800">합계</td><td style="padding:6px 10px;text-align:right;font-weight:800">' + won(total) + '</td><td style="padding:6px 10px;text-align:right">100%</td></tr></tbody></table>'
      + '<div>' + CH.itemsTableHtml(P.items) + '</div></div>';
  };
  CH.itemsTableHtml = function (items) {
    const rows = items.slice(0, 500).map(it => '<tr><td style="padding:4px 8px;border-bottom:0.5px solid var(--crm,#eee)">' + esc(it.item) + '</td><td style="padding:4px 8px;border-bottom:0.5px solid var(--crm,#eee);text-align:center;color:' + (it.cat === '미분류' ? '#B91C1C' : 'var(--th)') + '">' + esc(it.cat) + '</td><td style="padding:4px 8px;border-bottom:0.5px solid var(--crm,#eee);text-align:right">' + (it.qty || '') + '</td><td style="padding:4px 8px;border-bottom:0.5px solid var(--crm,#eee);text-align:right;font-weight:600">' + won(it.total) + '</td></tr>').join('');
    return '<div style="max-height:380px;overflow:auto;border:0.5px solid var(--crd);border-radius:8px;background:#fff"><table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr style="background:var(--cr,#faf7f2);position:sticky;top:0"><th style="padding:6px 8px;text-align:left">품목</th><th style="padding:6px 8px">분류</th><th style="padding:6px 8px;text-align:right">수량</th><th style="padding:6px 8px;text-align:right">합계</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
  };
  CH.exportCsv = function () {
    const P = CH.state.parsed; if (!P) return;
    const lines = [['품목', '분류', '수량', '공급가액', '부가세', '합계'].join(',')].concat(P.items.map(it => [it.item, it.cat, it.qty, it.supply, it.vat, it.total].map(v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"').join(',')));
    const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = (P.fileName || '거래명세서').replace(/\.[^.]+$/, '') + '_검수.csv'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1500);
  };
  CH.saveMonthly = async function () {
    const P = CH.state.parsed; if (!P || !CH.isHQ()) return;
    const ym = prompt('이 거래명세서의 연월을 입력하세요 (YYYY-MM):', CH.state.ym); if (!ym) return;
    try { const r = await rpc('ch_monthly_upsert', { p_vendor: P.slug, p_ym: ym, p_rows: P.items.map(it => ({ item: it.item, qty: it.qty, supply: it.supply, vat: it.vat, total: it.total })) }); toast(P.slug + ' ' + ym + ' 단가이력 ' + (r.rows || 0) + '건 저장'); } catch (e) { alert('저장 오류: ' + (e.missing ? '보안 SQL 미실행' : e.message)); }
  };
  // 발주 반영 — 전사 합산 금액을 '선택 매장' 입력칸에 이 거래처 업체라인으로 미리 채움(최종 입력은 수기)
  CH.openApply = function () {
    const P = CH.state.parsed; if (!P) return;
    const canonical = (VP.VENDORS.find(v => v.slug === P.slug) || {}).canonical || P.slug;
    const byCat = {}; P.items.forEach(it => { if (it.cat && it.cat !== '미분류') byCat[it.cat] = (byCat[it.cat] || 0) + it.total; });
    const sts = CH.stores();
    const storeOpts = sts.map(s => '<option value="' + esc(s) + '"' + (s === CH.state.store ? ' selected' : '') + '>' + esc(s) + '</option>').join('');
    const catLines = Object.keys(byCat).map(c => '<div style="display:flex;justify-content:space-between;font-size:13px;padding:3px 0"><span>' + esc(c) + ' / ' + esc(canonical) + '</span><b>' + won(byCat[c]) + '</b></div>').join('') || '<span style="color:var(--th)">분류된 금액이 없습니다</span>';
    CH.modal('발주 비중에 반영 (' + esc(canonical) + ')',
      '<div style="font-size:12px;color:var(--th);margin-bottom:10px">거래명세서는 전 매장 합산입니다. 선택한 매장/연월의 입력 화면에 이 거래처 금액을 업체라인으로 미리 채워드립니다. 매장별 실제 금액은 입력 화면에서 확인/수정 후 저장하세요.</div>'
      + '<div style="display:flex;gap:8px;margin-bottom:10px"><select id="chApStore" class="form-input" style="flex:1">' + storeOpts + '</select><input type="month" id="chApYm" class="form-input" value="' + CH.state.ym + '" style="width:150px"></div>'
      + '<div style="border:0.5px solid var(--crd);border-radius:8px;padding:10px;background:var(--cr,#faf7f2)">' + catLines + '</div>',
      '입력 화면 열기', function () {
        const store = document.getElementById('chApStore').value, ym = document.getElementById('chApYm').value;
        if (!store || !ym) { alert('매장/연월 선택'); return false; }
        CH.state.store = store; CH.state.ym = ym;
        CH.openStoreInput(store, ym, { vendor: canonical, byCat: byCat });
        return true;
      });
  };

  /* ======================================================================
   * [탭 2] 발주 추이 & 실질 원가율 — 연도별 1~12월 매트릭스
   * ==================================================================== */
  CH.renderTab2 = async function () {
    const b = document.getElementById('chTabBody'); if (!b) return;
    b.innerHTML = '<div style="padding:30px;text-align:center;color:var(--th)">불러오는 중…</div>';
    ensureStore();
    const yearOpts = ['2025', '2026', '2027'].map(y => '<option value="' + y + '"' + (y === CH.state.year ? ' selected' : '') + '>' + y + '년</option>').join('');
    const header = '<div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">'
      + storeSelectorHtml('ClosingHelper.onStoreChange(this.value)')
      + '<select class="form-input" style="width:120px" onchange="ClosingHelper.state.year=this.value;ClosingHelper.renderTab2()">' + yearOpts + '</select>'
      + '<button class="btn-cancel-sm" style="font-size:12px;margin-left:auto" onclick="ClosingHelper.openStoreInput(ClosingHelper.state.store, ClosingHelper.state.year+\'-\'+String(new Date().getMonth()+1).padStart(2,\'0\'))"><i class="ti ti-plus"></i> 월 입력/수정</button></div>';
    // 본사 전 매장 요약 모드
    if (CH.isHQ() && CH.state.store === '__ALL__') {
      let sum = [];
      try { sum = await rpc('ch_summary', { p_ym: CH.state.year + '-' + String(new Date().getMonth() + 1).padStart(2, '0') }); } catch (e) {}
      const rows = (sum || []).map(r => '<tr><td style="padding:5px 10px;border-bottom:0.5px solid var(--crd);font-weight:600">' + esc(r.store) + '</td><td style="padding:5px 10px;border-bottom:0.5px solid var(--crd);text-align:right">' + won(r.net_sales) + '</td><td style="padding:5px 10px;border-bottom:0.5px solid var(--crd);text-align:right">' + won(r.order_total) + '</td><td style="padding:5px 10px;border-bottom:0.5px solid var(--crd);text-align:right;font-weight:700;color:' + (r.net_sales > 0 && r.order_total / r.net_sales > 0.4 ? '#B91C1C' : 'var(--tm)') + '">' + (r.net_sales > 0 ? pct(r.order_total, r.net_sales).toFixed(1) + '%' : '-') + '</td><td style="padding:5px 10px;border-bottom:0.5px solid var(--crd);text-align:center"><button class="btn-cancel-sm" style="font-size:11px" onclick="ClosingHelper.onStoreChange(\'' + esc(r.store).replace(/'/g, "\\'") + '\')">연간 보기</button></td></tr>').join('');
      b.innerHTML = header + '<div style="font-size:12px;color:var(--th);margin-bottom:6px">' + CH.state.year + '년 당월 기준 전 매장 요약 (PDC 제외). 매장을 고르면 1~12월 매트릭스로 들어갑니다.</div><table style="width:100%;border-collapse:collapse;background:#fff;border:0.5px solid var(--crd);border-radius:8px;overflow:hidden;font-size:13px"><thead><tr style="background:var(--cr,#faf7f2)"><th style="padding:6px 10px;text-align:left">매장</th><th style="padding:6px 10px;text-align:right">순매출</th><th style="padding:6px 10px;text-align:right">발주합계</th><th style="padding:6px 10px;text-align:right">발주비중</th><th></th></tr></thead><tbody>' + (rows || '<tr><td colspan="5" style="padding:14px;text-align:center;color:var(--th)">데이터 없음</td></tr>') + '</tbody></table>';
      return;
    }
    // 단일 매장 연간 매트릭스
    const store = CH.state.store; if (!store) { b.innerHTML = header + '<div style="padding:30px;text-align:center;color:var(--th)">담당 매장이 없습니다</div>'; return; }
    let months = [];
    try { months = await rpc('ch_annual', { p_store: store, p_year: CH.state.year }); } catch (e) { b.innerHTML = header + '<div style="padding:30px;text-align:center;color:#B91C1C">' + (e.missing ? '보안 SQL 미실행' : '불러오기 오류: ' + e.message) + '</div>'; return; }
    b.innerHTML = header + CH.annualTableHtml(store, months);
  };
  CH.onStoreChange = function (v) { CH.state.store = v; CH.renderTab2(); };
  CH.annualTableHtml = function (store, months) {
    const col = (lbl) => '<th style="padding:5px 6px;text-align:right;white-space:nowrap;font-size:11px">' + lbl + '</th>';
    let head = '<tr style="background:var(--cr,#faf7f2)"><th style="padding:5px 6px;text-align:left;font-size:11px">월</th>' + col('순매출') + col('발주합계') + col('발주%') + col('원재료') + col('부재료') + col('소모품') + col('상품') + col('기초재고') + col('기말재고') + col('실질원가%') + '</th>';
    const tot = { ns: 0, ot: 0, 원재료: 0, 부재료: 0, 소모품: 0, 상품: 0 }; let cntNs = 0, costSum = 0, costCnt = 0;
    const cell = (v, bold) => '<td style="padding:4px 6px;text-align:right;border-bottom:0.5px solid var(--crm,#eee)' + (bold ? ';font-weight:700' : '') + '">' + v + '</td>';
    const body = (months || []).map(m => {
      const mi = parseInt(m.ym.slice(5), 10);
      const bc = m.by_cat || {}; const ns = Number(m.net_sales || 0), ot = Number(m.order_total || 0);
      tot.ns += ns; tot.ot += ot; if (ns) cntNs++;
      CATEGORIES.forEach(c => tot[c] += Number(bc[c] || 0));
      const matCost = Number(bc['원재료'] || 0) + Number(bc['부재료'] || 0) + Number(bc['상품'] || 0);
      let costRate = '-';
      if (ns > 0 && m.opening_stock != null && m.closing_stock != null) { const cr = (Number(m.opening_stock) + matCost - Number(m.closing_stock)) / ns * 100; costRate = cr.toFixed(1) + '%'; costSum += cr; costCnt++; }
      return '<tr style="cursor:pointer" onclick="ClosingHelper.openStoreInput(\'' + esc(store).replace(/'/g, "\\'") + '\',\'' + m.ym + '\')">'
        + '<td style="padding:4px 6px;border-bottom:0.5px solid var(--crm,#eee);font-weight:600">' + mi + '월</td>'
        + cell(ns ? won(ns) : '-') + cell(ot ? won(ot) : '-') + cell(ns ? pct(ot, ns).toFixed(1) + '%' : '-')
        + cell((bc['원재료'] ? won(bc['원재료']) : '-')) + cell((bc['부재료'] ? won(bc['부재료']) : '-')) + cell((bc['소모품'] ? won(bc['소모품']) : '-')) + cell((bc['상품'] ? won(bc['상품']) : '-'))
        + cell(m.opening_stock != null ? won(m.opening_stock) : '-') + cell(m.closing_stock != null ? won(m.closing_stock) : '-')
        + '<td style="padding:4px 6px;text-align:right;border-bottom:0.5px solid var(--crm,#eee);font-weight:700;color:' + (costRate !== '-' && parseFloat(costRate) > 40 ? '#B91C1C' : 'var(--tm)') + '">' + costRate + '</td></tr>';
    }).join('');
    const avg = (v, n) => n ? won(v / n) : '-';
    const footer = '<tr style="background:#FEF9F0;font-weight:700"><td style="padding:5px 6px">합계</td>' + cell(won(tot.ns), 1) + cell(won(tot.ot), 1) + cell(tot.ns ? pct(tot.ot, tot.ns).toFixed(1) + '%' : '-', 1) + cell(won(tot.원재료), 1) + cell(won(tot.부재료), 1) + cell(won(tot.소모품), 1) + cell(won(tot.상품), 1) + cell('', 1) + cell('', 1) + cell(costCnt ? (costSum / costCnt).toFixed(1) + '%(평균)' : '-', 1) + '</tr>';
    return '<div style="font-size:12px;color:var(--th);margin-bottom:6px"><b>' + esc(store) + '</b> ' + CH.state.year + '년 · 월 클릭 = 입력/수정. 실질원가율 = (기초재고 + 원·부·상품 발주 − 기말재고) ÷ 순매출</div>'
      + '<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;background:#fff;border:0.5px solid var(--crd);border-radius:8px;overflow:hidden;font-size:12px"><thead>' + head + '</thead><tbody>' + body + footer + '</tbody></table></div>';
  };

  // 월 상세 입력/수정 (순매출, 기초/기말재고, 카테고리×업체 발주액, 법인카드)
  CH.openStoreInput = async function (store, ym, prefill) {
    if (!store || store === '__ALL__') { alert('매장을 먼저 선택하세요'); return; }
    let cur = { net_sales: 0, opening_stock: null, closing_stock: null, orders: [] };
    try { cur = await rpc('ch_order_get', { p_store: store, p_ym: ym }); } catch (e) { if (e.missing) { alert('보안 SQL 미실행'); return; } if (/ACCESS_DENIED/.test(e.message || '')) { alert('이 매장에 접근 권한이 없습니다.'); return; } }
    let orders = (cur.orders || []).slice();
    if (prefill && prefill.byCat) { Object.keys(prefill.byCat).forEach(cat => { orders.push({ category: cat, vendor: prefill.vendor, amount: prefill.byCat[cat], is_corp_card: false }); }); }
    const vmOpts = (window.__chVendors || []).map(v => v.canonical || v.slug);
    const rowHtml = (o) => '<tr>'
      + '<td style="padding:3px"><select class="ch-o-cat form-input" style="font-size:12px;padding:4px">' + CATEGORIES.map(c => '<option' + (o && o.category === c ? ' selected' : '') + '>' + c + '</option>').join('') + '</select></td>'
      + '<td style="padding:3px"><input class="ch-o-ven form-input" list="chVenList" style="font-size:12px;padding:4px" value="' + esc(o ? (o.vendor || '') : '') + '" placeholder="업체 또는 💳 법인카드"></td>'
      + '<td style="padding:3px"><input class="ch-o-amt form-input" type="number" style="font-size:12px;padding:4px;text-align:right" value="' + (o ? (o.amount || '') : '') + '"></td>'
      + '<td style="padding:3px;text-align:center"><input class="ch-o-card" type="checkbox"' + (o && o.is_corp_card ? ' checked' : '') + '></td>'
      + '<td style="padding:3px;text-align:center"><button onclick="this.closest(\'tr\').remove()" style="background:none;border:none;color:#B91C1C;cursor:pointer">✕</button></td></tr>';
    const bodyRows = (orders.length ? orders : [null, null, null]).map(rowHtml).join('');
    CH.modal(esc(store) + ' ' + ym + ' 월 입력',
      '<datalist id="chVenList">' + vmOpts.map(v => '<option value="' + esc(v) + '">').join('') + '<option value="' + CORP + '"></datalist>'
      + '<div style="display:flex;gap:8px;margin-bottom:8px;flex-wrap:wrap"><input id="chInSales" class="form-input" type="number" style="flex:1;min-width:130px" placeholder="순매출" value="' + (cur.net_sales || '') + '"><input id="chInOpen" class="form-input" type="number" style="width:140px" placeholder="기초재고(선택)" value="' + (cur.opening_stock != null ? cur.opening_stock : '') + '"><input id="chInClose" class="form-input" type="number" style="width:140px" placeholder="기말재고(선택)" value="' + (cur.closing_stock != null ? cur.closing_stock : '') + '"></div>'
      + '<table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr style="background:var(--cr,#faf7f2)"><th style="padding:4px">분야</th><th style="padding:4px">업체</th><th style="padding:4px">금액</th><th style="padding:4px">법인</th><th></th></tr></thead><tbody id="chInRows">' + bodyRows + '</tbody></table>'
      + '<button class="btn-cancel-sm" style="font-size:12px;margin-top:6px" onclick="document.getElementById(\'chInRows\').insertAdjacentHTML(\'beforeend\', ClosingHelper._oRow())"><i class="ti ti-plus"></i> 행 추가</button>',
      '저장', async function () {
        const rows = Array.from(document.querySelectorAll('#chInRows tr')).map(tr => ({ category: tr.querySelector('.ch-o-cat').value, vendor: tr.querySelector('.ch-o-ven').value.trim(), amount: Number(tr.querySelector('.ch-o-amt').value || 0), is_corp_card: tr.querySelector('.ch-o-card').checked })).filter(r => r.amount);
        const ns = Number(document.getElementById('chInSales').value || 0);
        const op = document.getElementById('chInOpen').value, cl = document.getElementById('chInClose').value;
        try { await rpc('ch_order_save', { p_store: store, p_ym: ym, p_net_sales: ns, p_opening: op === '' ? null : Number(op), p_closing: cl === '' ? null : Number(cl), p_rows: rows }); }
        catch (e) { alert('저장 오류: ' + (e.missing ? '보안 SQL 미실행' : (/ACCESS_DENIED/.test(e.message || '') ? '접근 권한 없음' : e.message))); return false; }
        toast(store + ' ' + ym + ' 저장 완료'); CH.state.store = store; if (CH.state.tab === 2) CH.renderTab2(); return true;
      });
  };
  CH._oRow = function () { return '<tr><td style="padding:3px"><select class="ch-o-cat form-input" style="font-size:12px;padding:4px">' + CATEGORIES.map(c => '<option>' + c + '</option>').join('') + '</select></td><td style="padding:3px"><input class="ch-o-ven form-input" list="chVenList" style="font-size:12px;padding:4px" placeholder="업체"></td><td style="padding:3px"><input class="ch-o-amt form-input" type="number" style="font-size:12px;padding:4px;text-align:right"></td><td style="padding:3px;text-align:center"><input class="ch-o-card" type="checkbox"></td><td style="padding:3px;text-align:center"><button onclick="this.closest(\'tr\').remove()" style="background:none;border:none;color:#B91C1C;cursor:pointer">✕</button></td></tr>'; };

  /* ======================================================================
   * [탭 3] 품목·단가 마스터 & 원본 보관함
   * ==================================================================== */
  CH.renderTab3 = async function () {
    const b = document.getElementById('chTabBody'); if (!b) return;
    try { window.__chVendors = await rpc('ch_vendors', {}); } catch (e) { window.__chVendors = []; }
    b.innerHTML =
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;align-items:start">'
      + '<div><div style="font-size:13px;font-weight:700;margin-bottom:6px"><i class="ti ti-search"></i> 품목·단가 마스터</div>'
      + '<input id="chItemSearch" class="form-input" placeholder="품목명 / 거래처 검색" oninput="ClosingHelper.searchItems(this.value)" style="margin-bottom:8px">'
      + '<div style="margin-bottom:8px;display:flex;gap:6px"><button class="btn-cancel-sm" style="font-size:12px" onclick="ClosingHelper.searchItems(\'\',true)">미분류만</button><button class="btn-cancel-sm" style="font-size:12px" onclick="ClosingHelper.searchItems(\'\')">전체</button></div>'
      + '<div id="chItemList" style="max-height:440px;overflow:auto;border:0.5px solid var(--crd);border-radius:8px;background:#fff"></div></div>'
      + '<div><div style="font-size:13px;font-weight:700;margin-bottom:6px"><i class="ti ti-archive"></i> 원본 보관함' + (CH.isHQ() ? '' : ' <span style="font-size:11px;color:var(--th)">(본사 전용)</span>') + '</div>'
      + (CH.isHQ() ? '<div style="border:1.5px dashed var(--crd);border-radius:10px;padding:14px;text-align:center;background:var(--cr,#faf7f2);cursor:pointer;margin-bottom:10px" onclick="document.getElementById(\'chUpload\').click()"><i class="ti ti-upload" style="font-size:20px;color:var(--br,#8a5a2b)"></i><div style="font-size:12px;font-weight:700;margin-top:4px">거래명세서 원본 업로드</div><div style="font-size:11px;color:var(--th)">파일명=거래처 / YYYY-MM/파일명 저장(덮어쓰기)</div><input type="file" id="chUpload" multiple accept=".xlsx,.xls" style="display:none" onchange="ClosingHelper.uploadOriginals(this.files)"></div>'
          + '<div style="display:flex;gap:8px;margin-bottom:8px"><input type="month" id="chArcYm" class="form-input" value="' + CH.state.ym + '" style="width:150px" onchange="ClosingHelper.loadArchive()"><button class="btn-cancel-sm" style="font-size:12px" onclick="ClosingHelper.downloadZip()"><i class="ti ti-file-zip"></i> ZIP</button><button class="btn-cancel-sm" style="font-size:12px;color:#B91C1C;border-color:#FCA5A5;margin-left:auto" onclick="ClosingHelper.cleanupOld()"><i class="ti ti-trash"></i> 1년 경과 정리</button></div>'
          + '<div id="chArchiveList" style="max-height:360px;overflow:auto;border:0.5px solid var(--crd);border-radius:8px;background:#fff"></div>'
        : '<div style="font-size:12px;color:var(--th);padding:14px;border:0.5px solid var(--crd);border-radius:8px;background:#fff">원본 보관함은 본사 관리자만 접근할 수 있습니다.</div>')
      + '</div></div>';
    CH.searchItems('');
    if (CH.isHQ()) CH.loadArchive();
  };
  CH.searchItems = async function (q, uncl) {
    const box = document.getElementById('chItemList'); if (!box) return;
    let items = [];
    try { items = await rpc('ch_items', { p_q: q || '', p_unclassified: !!uncl }); } catch (e) { box.innerHTML = '<div style="padding:14px;color:#B91C1C;font-size:12px">' + (e.missing ? '보안 SQL 미실행' : '오류: ' + e.message) + '</div>'; return; }
    box.innerHTML = '<table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr style="background:var(--cr,#faf7f2);position:sticky;top:0"><th style="padding:6px 8px;text-align:left">품목</th><th style="padding:6px 8px;text-align:left">거래처</th><th style="padding:6px 8px;text-align:right">최신단가</th><th style="padding:6px 8px">분류</th></tr></thead><tbody>'
      + ((items && items.length) ? items.map(CH.itemRow).join('') : '<tr><td colspan="4" style="padding:14px;text-align:center;color:var(--th)">데이터 없음</td></tr>') + '</tbody></table>';
  };
  CH.itemRow = function (it) {
    const up = it.unit_price != null ? won(it.unit_price) : '-';
    const catSel = CH.isHQ()
      ? '<select onchange="ClosingHelper.setItemCat(' + it.id + ',this.value)" style="font-size:11px">' + ['미분류'].concat(CATEGORIES).map(c => '<option' + (it.category === c ? ' selected' : '') + '>' + c + '</option>').join('') + '</select>'
      : '<span style="font-size:11px;color:var(--th)">' + esc(it.category || '미분류') + '</span>';
    return '<tr><td style="padding:4px 8px;border-bottom:0.5px solid var(--crm,#eee)">' + esc(it.name) + '</td><td style="padding:4px 8px;border-bottom:0.5px solid var(--crm,#eee)">' + esc(it.vendor_slug || '') + '</td><td style="padding:4px 8px;border-bottom:0.5px solid var(--crm,#eee);text-align:right;font-weight:600">' + up + '</td><td style="padding:4px 8px;border-bottom:0.5px solid var(--crm,#eee);text-align:center">' + catSel + '</td></tr>';
  };
  CH.setItemCat = async function (id, cat) { try { await rpc('ch_item_setcat', { p_id: id, p_cat: cat }); toast('분류 저장'); } catch (e) { alert('오류: ' + (e.missing ? '보안 SQL 미실행' : e.message)); } };
  CH.uploadOriginals = async function (files) {
    if (!files || !files.length || !CH.isHQ()) return;
    const ym = document.getElementById('chArcYm') ? document.getElementById('chArcYm').value : CH.state.ym; let ok = 0;
    for (const f of files) {
      const vendor = f.name.replace(/\.[^.]+$/, ''); const path = ym + '/' + f.name;
      try { const up = await sbc().storage.from(STORAGE_BUCKET).upload(path, f, { upsert: true }); if (up.error) { console.warn(up.error); continue; } await rpc('ch_statement_upsert', { p_ym: ym, p_vendor: vendor, p_path: path, p_size: f.size }); ok++; } catch (e) { console.warn(e); }
    }
    toast('원본 ' + ok + '건 업로드'); CH.loadArchive();
  };
  CH.loadArchive = async function () {
    const box = document.getElementById('chArchiveList'); if (!box) return;
    const ym = document.getElementById('chArcYm') ? document.getElementById('chArcYm').value : CH.state.ym; let metas = [];
    try { metas = await rpc('ch_statements', { p_ym: ym }); } catch (e) { box.innerHTML = '<div style="padding:12px;font-size:12px;color:#B91C1C">' + (e.missing ? '보안 SQL 미실행' : '오류') + '</div>'; return; }
    box.innerHTML = (metas && metas.length) ? metas.map(m => '<div style="display:flex;align-items:center;gap:8px;padding:7px 10px;border-bottom:0.5px solid var(--crm,#eee)"><i class="ti ti-file-type-xls" style="color:#15803D"></i><span style="font-size:13px;font-weight:600">' + esc(m.vendor) + '</span><span style="font-size:11px;color:var(--th)">' + (((m.size_bytes || 0) / 1024) | 0) + 'KB</span><span style="margin-left:auto;font-size:11px;color:var(--th)">' + (m.uploaded_at ? String(m.uploaded_at).slice(0, 10) : '') + '</span></div>').join('') : '<div style="padding:14px;text-align:center;color:var(--th);font-size:12px">' + ym + ' 보관 원본 없음</div>';
  };
  CH.downloadZip = async function () {
    const pw = prompt('원본 ZIP 내려받기 — 본사 비밀번호'); if (!pw) return;
    try { const { data, error } = await sbc().rpc('verify_password', { p_user_id: window.currentUser.id, p_password: pw }); if (error || !data) { alert('비밀번호 불일치'); return; } } catch (e) { alert('인증 오류'); return; }
    const ym = document.getElementById('chArcYm') ? document.getElementById('chArcYm').value : CH.state.ym; let metas = [];
    try { metas = await rpc('ch_statements', { p_ym: ym }); } catch (e) { return; }
    if (!metas || !metas.length) { alert('원본 없음'); return; }
    if (typeof JSZip === 'undefined') { alert('JSZip 로드 실패'); return; }
    toast('압축 중…'); const zip = new JSZip();
    for (const m of metas) { try { const { data } = await sbc().storage.from(STORAGE_BUCKET).download(m.file_path); if (data) zip.file(m.vendor + '.xlsx', data); } catch (e) {} }
    const blob = await zip.generateAsync({ type: 'blob' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = '거래명세서원본_' + ym + '.zip'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 2000);
  };
  CH.cleanupOld = async function () {
    if (!CH.isHQ()) return;
    if (!confirm('1년 이상 지난 보관 원본을 삭제합니다. 계속할까요? (복구 불가)')) return;
    const cut = new Date(); cut.setFullYear(cut.getFullYear() - 1); const cutYm = cut.toISOString().slice(0, 7);
    // Storage 파일 삭제 후 메타 삭제
    let metas = [];
    try { for (let y = 2024; y <= cut.getFullYear(); y++) for (let mo = 1; mo <= 12; mo++) { const ym = y + '-' + String(mo).padStart(2, '0'); if (ym >= cutYm) continue; const mm = await rpc('ch_statements', { p_ym: ym }); (mm || []).forEach(x => metas.push(x)); } } catch (e) {}
    for (const m of metas) { try { await sbc().storage.from(STORAGE_BUCKET).remove([m.file_path]); } catch (e) {} }
    try { const r = await rpc('ch_cleanup_old', { p_cut_ym: cutYm }); toast((r.deleted || 0) + '건 정리'); } catch (e) { alert('오류'); }
    CH.loadArchive();
  };

  /* ───────────── 권한 / 거래처 통합 설정 (본사) ───────────── */
  CH.openSettings = async function () {
    if (!CH.isHQ()) return;
    await CH.loadFlags();
    let parts = [], users = [], vendors = [];
    try { const { data } = await sbc().from('users').select('id,name,store,part,role').eq('active', true).order('name'); users = data || []; } catch (e) {}
    try { const { data } = await sbc().from('app_settings').select('key,value').in('key', ['closing_allowed_parts', 'closing_allowed_users']); var ap = {}; (data || []).forEach(r => ap[r.key] = r.value); window.__cAllowParts = JSON.parse(ap.closing_allowed_parts || '[]'); window.__cAllowUsers = JSON.parse(ap.closing_allowed_users || '[]'); } catch (e) { window.__cAllowParts = []; window.__cAllowUsers = []; }
    try { vendors = await rpc('ch_vendors', {}); } catch (e) {}
    const partList = Array.from(new Set(users.map(u => u.part).filter(Boolean))).sort();
    const partChk = partList.map(p => '<label style="display:inline-flex;align-items:center;gap:4px;font-size:12px;margin:2px 8px 2px 0"><input type="checkbox" class="c-part" value="' + esc(p) + '"' + (window.__cAllowParts.map(String).includes(p) ? ' checked' : '') + '> ' + esc(p) + '</label>').join('');
    const userOpts = users.map(u => '<option value="' + u.id + '"' + (window.__cAllowUsers.map(String).includes(String(u.id)) ? ' selected' : '') + '>' + esc(u.name) + ' (' + esc(u.store || u.part || '') + ')</option>').join('');
    const venRows = (vendors || []).map(v => '<tr><td style="padding:3px 6px;font-size:12px">' + esc(v.slug) + '</td><td style="padding:3px"><input class="c-vcanon" data-slug="' + esc(v.slug) + '" class="form-input" style="font-size:12px;padding:3px" value="' + esc(v.canonical || '') + '"></td><td style="padding:3px"><input class="c-valias" data-slug="' + esc(v.slug) + '" class="form-input" style="font-size:12px;padding:3px" value="' + esc((v.aliases || []).join(', ')) + '" placeholder="유사 표기, 쉼표"></td></tr>').join('');
    CH.modal('월말 정산 도우미 — 권한 / 거래처 통합 설정',
      '<label style="display:flex;align-items:center;gap:8px;font-size:13px;margin-bottom:12px"><input type="checkbox" id="cVisible"' + (window.__closingVisible ? ' checked' : '') + '> <b>메뉴 전체 공개</b> <span style="color:var(--th)">(해제 시 총괄에게만 [개발중] 노출)</span></label>'
      + '<div style="font-size:12px;font-weight:700;margin-bottom:4px">허용 부서담당 파트</div><div style="margin-bottom:10px">' + (partChk || '<span style="font-size:12px;color:var(--th)">파트 없음</span>') + '</div>'
      + '<div style="font-size:12px;font-weight:700;margin-bottom:4px">예외 허용자</div><select id="cUsers" multiple size="5" style="width:100%;font-size:12px;border:0.5px solid var(--crd);border-radius:6px;padding:4px;margin-bottom:12px">' + userOpts + '</select>'
      + '<div style="font-size:12px;font-weight:700;margin-bottom:4px">거래처 통합 (본사 관리 · 유사 표기 묶기)</div>'
      + '<table style="width:100%;border-collapse:collapse"><thead><tr style="background:var(--cr,#faf7f2);font-size:11px"><th style="padding:3px 6px;text-align:left">코드</th><th style="padding:3px;text-align:left">정식명</th><th style="padding:3px;text-align:left">유사 표기(alias)</th></tr></thead><tbody>' + venRows + '</tbody></table>'
      + '<div style="font-size:11px;color:var(--th);margin-top:4px">매니저·매니저B·총괄은 항상 접근 가능. 거래처 통합은 본사만 수정합니다.</div>',
      '저장', async function () {
        const visible = document.getElementById('cVisible').checked;
        const selParts = Array.from(document.querySelectorAll('.c-part:checked')).map(x => x.value);
        const selUsers = Array.from(document.getElementById('cUsers').selectedOptions).map(o => o.value);
        try {
          await sbc().from('app_settings').upsert({ key: 'closing_menu_visible', value: visible ? 'true' : 'false' }, { onConflict: 'key' });
          await sbc().from('app_settings').upsert({ key: 'closing_allowed_parts', value: JSON.stringify(selParts) }, { onConflict: 'key' });
          await sbc().from('app_settings').upsert({ key: 'closing_allowed_users', value: JSON.stringify(selUsers) }, { onConflict: 'key' });
          // 거래처 통합 저장
          const canons = document.querySelectorAll('.c-vcanon'); const aliases = document.querySelectorAll('.c-valias');
          for (let i = 0; i < canons.length; i++) { const slug = canons[i].getAttribute('data-slug'); const al = (aliases[i].value || '').split(',').map(s => s.trim()).filter(Boolean); await rpc('ch_vendor_save', { p_slug: slug, p_canonical: canons[i].value.trim(), p_aliases: al, p_active: true }); }
        } catch (e) { alert('저장 오류: ' + (e.missing ? '보안 SQL 미실행' : e.message)); return false; }
        await CH.loadFlags(); toast('설정 저장 완료'); return true;
      });
  };

  /* ───────────── 공용 모달 ───────────── */
  CH.modal = function (title, bodyHtml, okLabel, onOk) {
    const old = document.getElementById('chModal'); if (old) old.remove();
    const m = document.createElement('div'); m.id = 'chModal'; m.className = 'modal-bg open';
    m.innerHTML = '<div class="modal-box" style="max-width:600px;width:95%"><div class="modal-title">' + esc(title) + '</div><div style="max-height:64vh;overflow:auto;padding:2px 2px 10px">' + bodyHtml + '</div><div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px"><button class="btn-cancel-sm" onclick="document.getElementById(\'chModal\').remove()">취소</button><button class="btn-submit" id="chModalOk">' + esc(okLabel || '확인') + '</button></div></div>';
    document.body.appendChild(m);
    document.getElementById('chModalOk').onclick = async function () { this.disabled = true; let close = true; try { if (onOk) close = (await onOk()) !== false; } catch (e) { alert('오류: ' + (e.message || e)); close = false; } this.disabled = false; if (close) { const mm = document.getElementById('chModal'); if (mm) mm.remove(); } };
  };

  /* ======================================================================
   * [탭 4] 법인카드 — 마스터(암호화) · 수시등록/한도 · 월말 자동대사 · 총괄 2차 PIN
   * ==================================================================== */
  CH.card = { reveal: {} };
  const isMaster = () => !!(window.currentUser && window.currentUser.is_master);
  const mask4 = (last) => '•••• ' + (last || '····');
  async function loadAccounts() { if (window.__chAccounts) return window.__chAccounts; try { window.__chAccounts = await rpc('ch_accounts', {}) || []; } catch (e) { window.__chAccounts = []; } return window.__chAccounts; }
  async function loadStoreOptions() { if (window.__chStoreOpts) return window.__chStoreOpts; try { const { data } = await sbc().from('store_options').select('name,sort_order').order('sort_order'); window.__chStoreOpts = (data || []).map(s => s.name).filter(n => n && n !== '본사'); } catch (e) { window.__chStoreOpts = []; } return window.__chStoreOpts; }

  CH.renderTab4 = async function () {
    const b = document.getElementById('chTabBody'); if (!b) return;
    b.innerHTML = '<div style="padding:24px;text-align:center;color:var(--th)">불러오는 중…</div>';
    await loadAccounts();
    if (CH.isHQ()) return CH.renderCardAdmin(b);
    return CH.renderCardStore(b);
  };

  /* ───────── 본사: 카드 마스터 + 자동대사 ───────── */
  CH.renderCardAdmin = async function (b) {
    let cards = [];
    try { cards = await rpc('ch_cards', {}) || []; } catch (e) { b.innerHTML = '<div style="padding:24px;text-align:center;color:#B91C1C">' + (e.missing ? '보안 SQL 미실행 — closing_cards.sql 을 먼저 실행하세요' : '오류: ' + esc(e.message)) + '</div>'; return; }
    let pin = { set: false, locked: false };
    if (isMaster()) { try { pin = await rpc('ch_secpin_status', {}) || pin; } catch (e) {} }
    const master = isMaster();
    const pinBtn = master ? '<button class="btn-cancel-sm" style="font-size:12px" onclick="ClosingHelper.openSecPin()"><i class="ti ti-lock-cog"></i> 보안 PIN ' + (pin.set ? '변경' : '설정') + '</button>' : '';
    const auditBtn = master ? '<button class="btn-cancel-sm" style="font-size:12px" onclick="ClosingHelper.openCardAudit()"><i class="ti ti-history"></i> 열람 기록</button>' : '';
    const pinWarn = (master && !pin.set) ? '<div style="font-size:12px;background:#FEF3C7;color:#92400E;border-radius:8px;padding:8px 12px;margin-bottom:10px"><i class="ti ti-alert-triangle"></i> 보안 PIN 미설정 — 민감정보 열람/수정 전에 [보안 PIN 설정]을 먼저 완료하세요.</div>' : '';
    const head = '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:10px">'
      + '<span style="font-size:14px;font-weight:800"><i class="ti ti-credit-card"></i> 법인카드 마스터 <span style="font-size:11px;color:var(--th)">(' + cards.length + '매장)</span></span>'
      + '<span style="margin-left:auto;display:flex;gap:6px;flex-wrap:wrap">' + pinBtn + auditBtn
      + '<button class="btn-cancel-sm" style="font-size:12px" onclick="ClosingHelper.exportAccountingExcel(\'all\')"><i class="ti ti-file-spreadsheet"></i> 회계 통합엑셀</button>'
      + '<button class="btn-submit" style="font-size:12px" onclick="ClosingHelper.openCardEdit(null)"><i class="ti ti-plus"></i> 카드 등록</button></span></div>';
    b.innerHTML = head + pinWarn + CH.cardTableHtml(cards) + CH.reconcileBoxHtml();
    window.__chRecon = null;
  };
  CH.cardTableHtml = function (cards) {
    const master = isMaster();
    window.__chCard = {};
    const td = (v) => '<td style="padding:5px 8px;border-bottom:0.5px solid var(--crm,#eee)">' + v + '</td>';
    const sens = (has, id, field) => '<span id="cs-' + field + '-' + id + '" style="font-family:monospace">' + (has ? '••••' : '-') + '</span>';
    const rows = cards.map(c => {
      window.__chCard[c.id] = c;
      const act = master
        ? '<button class="btn-cancel-sm" style="font-size:11px;padding:3px 7px" onclick="ClosingHelper.revealCard(' + c.id + ')"><i class="ti ti-eye"></i> 열람</button>'
          + ' <button class="btn-cancel-sm" style="font-size:11px;padding:3px 7px" onclick="ClosingHelper.openCardEdit(' + c.id + ')">수정</button>'
          + ' <button class="btn-cancel-sm" style="font-size:11px;padding:3px 7px;color:#B91C1C;border-color:#FCA5A5" onclick="ClosingHelper.delCard(' + c.id + ')">삭제</button>'
        : '<button class="btn-cancel-sm" style="font-size:11px;padding:3px 7px" onclick="ClosingHelper.openCardEdit(' + c.id + ')">수정</button>';
      return '<tr id="cardrow-' + c.id + '">'
        + td(esc(c.category || '-')) + td('<b>' + esc(c.store) + '</b>')
        + '<td style="padding:5px 8px;border-bottom:0.5px solid var(--crm,#eee);font-family:monospace"><span id="cs-num-' + c.id + '">' + mask4(c.card_last) + '</span></td>'
        + '<td style="padding:5px 8px;border-bottom:0.5px solid var(--crm,#eee);text-align:center">' + (master ? sens(c.has_expiry, c.id, 'exp') : '-') + '</td>'
        + '<td style="padding:5px 8px;border-bottom:0.5px solid var(--crm,#eee);text-align:center">' + (master ? sens(c.has_cvc, c.id, 'cvc') : '-') + '</td>'
        + '<td style="padding:5px 8px;border-bottom:0.5px solid var(--crm,#eee);text-align:center">' + (master ? sens(c.has_pw, c.id, 'pw') : '-') + '</td>'
        + td(esc(c.card_user || '-')) + td(esc(c.remark || '-'))
        + '<td style="padding:5px 8px;border-bottom:0.5px solid var(--crm,#eee);text-align:right">' + (c.limit_amount != null ? won(c.limit_amount) : '-') + '</td>'
        + '<td style="padding:5px 8px;border-bottom:0.5px solid var(--crm,#eee);white-space:nowrap">' + act + '</td></tr>';
    }).join('');
    return '<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:12px;background:#fff;border:0.5px solid var(--crd);border-radius:8px;overflow:hidden"><thead><tr style="background:var(--cr,#faf7f2)">'
      + ['분류', '매장 명', '카드번호', '유효기간', 'CVC', 'PW', '사용자', '비고(입금계좌)', '결제한도', '관리'].map(h => '<th style="padding:6px 8px;text-align:left;white-space:nowrap">' + h + '</th>').join('')
      + '</tr></thead><tbody>' + (rows || '<tr><td colspan="10" style="padding:16px;text-align:center;color:var(--th)">등록된 카드 없음</td></tr>') + '</tbody></table></div>'
      + (isMaster() ? '<div style="font-size:11px;color:var(--th);margin-top:6px"><i class="ti ti-lock"></i> 카드번호/유효기간/CVC/PW는 암호화 저장 — [열람] 시 보안 PIN 인증 후 30초간만 표시됩니다.</div>' : '<div style="font-size:11px;color:var(--th);margin-top:6px">민감정보 열람·수정은 총괄만 가능합니다.</div>');
  };

  /* ───────── 민감정보 2차 인증 열람(30초 자동 재마스킹) ───────── */
  CH.revealCard = function (id) {
    if (!isMaster()) return;
    CH.pinPrompt('민감정보 열람 — 보안 PIN', async function (pin) {
      let r; try { r = await rpc('ch_reveal_card_secret', { p_id: id, p_pin: pin }); } catch (e) { document.getElementById('chPinMsg').textContent = CH.pinMsg(e); return false; }
      CH.showCardSecret(id, r); return true;
    });
  };
  CH.showCardSecret = function (id, r) {
    const fmt = n => String(n || '').replace(/(\d{4})(?=\d)/g, '$1 ').trim();
    const c = (window.__chCard || {})[id] || {};
    const numEl = document.getElementById('cs-num-' + id); if (numEl) numEl.textContent = r.card_number ? fmt(r.card_number) : mask4(c.card_last);
    const set = (f, v) => { const el = document.getElementById('cs-' + f + '-' + id); if (el) el.textContent = (v == null || v === '') ? '-' : v; };
    set('exp', r.expiry); set('cvc', r.cvc); set('pw', r.card_pw);
    if (CH.card.reveal[id]) clearTimeout(CH.card.reveal[id]);
    toast('30초 후 자동으로 다시 가려집니다');
    CH.card.reveal[id] = setTimeout(function () {
      if (numEl) numEl.textContent = mask4(c.card_last);
      [['exp', 'has_expiry'], ['cvc', 'has_cvc'], ['pw', 'has_pw']].forEach(p => { const el = document.getElementById('cs-' + p[0] + '-' + id); if (el) el.textContent = c[p[1]] ? '••••' : '-'; });
    }, 30000);
  };
  CH.pinPrompt = function (title, onPin) {
    CH.modal(title,
      '<div style="font-size:12px;color:var(--th);margin-bottom:8px">총괄 전용 6자리 보안 PIN을 입력하세요. (로그인 비밀번호와 별개)</div>'
      + '<input id="chPinInp" class="form-input" type="password" inputmode="numeric" maxlength="6" placeholder="● ● ● ● ● ●" autocomplete="off" style="text-align:center;letter-spacing:8px;font-size:20px">'
      + '<div id="chPinMsg" style="font-size:12px;color:#B91C1C;margin-top:6px;min-height:16px"></div>',
      '확인', async function () {
        const pin = (document.getElementById('chPinInp').value || '').trim();
        if (!/^[0-9]{6}$/.test(pin)) { document.getElementById('chPinMsg').textContent = '6자리 숫자를 입력하세요.'; return false; }
        return await onPin(pin);
      });
    setTimeout(() => { const i = document.getElementById('chPinInp'); if (i) i.focus(); }, 120);
  };
  CH.pinMsg = function (e) { const m = (e && e.message) || ''; if (/PIN_WRONG:(\d+)/.test(m)) return 'PIN 불일치 — 남은 시도 ' + RegExp.$1 + '회'; if (/PIN_WRONG/.test(m)) return 'PIN 불일치'; if (/PIN_LOCKED/.test(m)) return '5회 오류 — 10분간 잠깁니다.'; if (/PIN_NOT_SET/.test(m)) return '보안 PIN 미설정 — 먼저 설정하세요.'; if (/ACCESS_DENIED/.test(m)) return '총괄만 가능합니다.'; if (e && e.missing) return '보안 SQL 미실행'; return '오류: ' + m; };

  CH.openSecPin = async function () {
    if (!isMaster()) return;
    let st = { set: false }; try { st = await rpc('ch_secpin_status', {}) || st; } catch (e) {}
    CH.modal('총괄 보안 PIN ' + (st.set ? '변경' : '설정'),
      (st.set ? '<input id="spOld" class="form-input" type="password" inputmode="numeric" maxlength="6" placeholder="기존 PIN 6자리" style="text-align:center;letter-spacing:6px;margin-bottom:8px">' : '')
      + '<input id="spNew" class="form-input" type="password" inputmode="numeric" maxlength="6" placeholder="새 PIN 6자리" style="text-align:center;letter-spacing:6px;margin-bottom:8px">'
      + '<input id="spNew2" class="form-input" type="password" inputmode="numeric" maxlength="6" placeholder="새 PIN 확인" style="text-align:center;letter-spacing:6px">'
      + '<div id="spMsg" style="font-size:12px;color:#B91C1C;margin-top:6px;min-height:16px"></div>'
      + '<div style="font-size:11px;color:var(--th);margin-top:4px">로그인 비밀번호와 별개 / 서버에 단방향 해시로만 저장 / 분실 시 복구 불가(재설정만 가능)</div>',
      '저장', async function () {
        const oldEl = document.getElementById('spOld'); const old = oldEl ? oldEl.value.trim() : '';
        const n1 = (document.getElementById('spNew').value || '').trim(), n2 = (document.getElementById('spNew2').value || '').trim();
        const msg = document.getElementById('spMsg');
        if (!/^[0-9]{6}$/.test(n1)) { msg.textContent = '새 PIN은 6자리 숫자'; return false; }
        if (n1 !== n2) { msg.textContent = '새 PIN 확인이 일치하지 않습니다'; return false; }
        try { await rpc('ch_secpin_set', { p_old_pin: old, p_new_pin: n1 }); } catch (e) { const m = e.message || ''; msg.textContent = /PIN_WRONG/.test(m) ? '기존 PIN 불일치' : (/PIN_LOCKED/.test(m) ? '잠금 상태 — 잠시 후 시도' : (e.missing ? '보안 SQL 미실행' : '오류: ' + m)); return false; }
        toast('보안 PIN 저장 완료'); CH.renderTab4(); return true;
      });
  };
  CH.openCardAudit = async function () {
    if (!isMaster()) return;
    let logs = []; try { logs = await rpc('ch_card_audit_list', { p_limit: 100 }) || []; } catch (e) {}
    const A = { reveal: '🔓 열람', edit_secret: '✏️ 민감수정', set_pin: '🔑 PIN설정' };
    const rows = logs.map(l => '<tr><td style="padding:4px 8px;border-bottom:0.5px solid var(--crm,#eee);font-size:11px;white-space:nowrap">' + esc(String(l.created_at || '').replace('T', ' ').slice(0, 16)) + '</td><td style="padding:4px 8px;border-bottom:0.5px solid var(--crm,#eee)">' + esc(l.user_name || '') + '</td><td style="padding:4px 8px;border-bottom:0.5px solid var(--crm,#eee)">' + (A[l.action] || esc(l.action || '')) + '</td><td style="padding:4px 8px;border-bottom:0.5px solid var(--crm,#eee)">' + esc(l.store || '') + '</td></tr>').join('');
    CH.modal('민감정보 열람 기록 (최근 100건)',
      '<table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr style="background:var(--cr,#faf7f2)"><th style="padding:5px 8px;text-align:left">일시</th><th style="padding:5px 8px;text-align:left">사용자</th><th style="padding:5px 8px;text-align:left">동작</th><th style="padding:5px 8px;text-align:left">매장</th></tr></thead><tbody>' + (rows || '<tr><td colspan="4" style="padding:14px;text-align:center;color:var(--th)">기록 없음</td></tr>') + '</tbody></table>', '닫기', function () { return true; });
  };

  /* ───────── 카드 기본정보 등록/수정 · 민감정보 저장 · 삭제 ───────── */
  CH.openCardEdit = async function (id) {
    if (!CH.isHQ()) return;
    const c = id != null ? (window.__chCard || {})[id] : null;
    const opts = await loadStoreOptions();
    const storeSel = '<select id="ceStore" class="form-input">' + opts.map(s => '<option' + (c && c.store === s ? ' selected' : '') + '>' + esc(s) + '</option>').join('') + '</select>';
    CH.modal((c ? '카드 수정' : '카드 등록') + (c ? ' — ' + esc(c.store) : ''),
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">'
      + '<div><label style="font-size:11px;color:var(--th)">분류</label><input id="ceCat" class="form-input" value="' + esc(c ? c.category || '' : '') + '" placeholder="예: 법인/신한"></div>'
      + '<div><label style="font-size:11px;color:var(--th)">매장 명</label>' + storeSel + '</div>'
      + '<div><label style="font-size:11px;color:var(--th)">카드 끝 4자리</label><input id="ceLast" class="form-input" maxlength="4" value="' + esc(c ? c.card_last || '' : '') + '" placeholder="4804"></div>'
      + '<div><label style="font-size:11px;color:var(--th)">사용자</label><input id="ceUser" class="form-input" value="' + esc(c ? c.card_user || '' : '') + '"></div>'
      + '<div style="grid-column:1/3"><label style="font-size:11px;color:var(--th)">비고(매출입금계좌)</label><input id="ceRemark" class="form-input" value="' + esc(c ? c.remark || '' : '') + '"></div>'
      + '<div><label style="font-size:11px;color:var(--th)">결제 한도(원)</label><input id="ceLimit" type="number" class="form-input" value="' + (c && c.limit_amount != null ? c.limit_amount : '') + '"></div>'
      + '<div><label style="font-size:11px;color:var(--th)">카드 별칭</label><input id="ceLabel" class="form-input" value="' + esc(c ? c.label || '' : '') + '"></div>'
      + '</div>'
      + (isMaster() ? '<div style="margin-top:10px;padding:10px;border:0.5px dashed var(--crd);border-radius:8px;background:var(--cr,#faf7f2)"><div style="font-size:12px;font-weight:700"><i class="ti ti-lock"></i> 민감정보(암호화) — 총괄 + 보안PIN</div><div style="font-size:11px;color:var(--th);margin-top:2px">카드번호 전체/유효기간/CVC/PW는 ' + (c ? '아래 버튼' : '카드 저장 후 [수정]') + '에서 암호화 저장합니다.</div>' + (c ? '<button type="button" class="btn-cancel-sm" style="font-size:12px;margin-top:6px" onclick="ClosingHelper.openCardSecret(' + c.id + ')"><i class="ti ti-key"></i> 민감정보 입력/변경</button>' : '') + '</div>' : '')
      ,
      '저장', async function () {
        const last = (document.getElementById('ceLast').value || '').trim();
        if (last && !/^[0-9]{3,4}$/.test(last)) { alert('카드 끝 4자리는 숫자로 입력'); return false; }
        const limit = document.getElementById('ceLimit').value;
        try { await rpc('ch_card_save', { p_id: id, p_category: document.getElementById('ceCat').value.trim() || null, p_store: document.getElementById('ceStore').value, p_card_last: last || null, p_label: document.getElementById('ceLabel').value.trim() || null, p_card_user: document.getElementById('ceUser').value.trim() || null, p_remark: document.getElementById('ceRemark').value.trim() || null, p_limit: limit === '' ? null : Number(limit), p_active: true }); }
        catch (e) { alert('저장 오류: ' + (e.missing ? '보안 SQL 미실행' : (/ACCESS_DENIED/.test(e.message || '') ? '본사 관리자만 가능' : e.message))); return false; }
        toast('저장 완료'); CH.renderTab4(); return true;
      });
  };
  CH.openCardSecret = function (id) {
    if (!isMaster()) return;
    const c = (window.__chCard || {})[id] || {};
    CH.modal('민감정보 입력/변경 — ' + esc(c.store || ''),
      '<div style="font-size:11px;color:var(--th);margin-bottom:8px">입력한 값만 암호화 저장됩니다(비우면 기존값 유지). 저장 시 보안 PIN을 확인합니다.</div>'
      + '<label style="font-size:11px;color:var(--th)">카드번호 전체</label><input id="csNum" class="form-input" inputmode="numeric" placeholder="숫자(공백 가능)" style="margin-bottom:6px">'
      + '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px">'
      + '<div><label style="font-size:11px;color:var(--th)">유효기간 MM/YY</label><input id="csExp" class="form-input" maxlength="5" placeholder="08/27"></div>'
      + '<div><label style="font-size:11px;color:var(--th)">CVC</label><input id="csCvc" class="form-input" maxlength="4" inputmode="numeric"></div>'
      + '<div><label style="font-size:11px;color:var(--th)">결제 PW</label><input id="csPw" class="form-input" maxlength="8" inputmode="numeric"></div></div>'
      + '<div style="font-size:11px;color:#B91C1C;margin-top:8px"><i class="ti ti-alert-triangle"></i> CVC 저장은 카드망 규정상 권장되지 않습니다. 꼭 필요한 경우에만 입력하세요.</div>'
      + '<div id="csMsg" style="font-size:12px;color:#B91C1C;margin-top:6px;min-height:16px"></div>'
      + '<label style="font-size:11px;color:var(--th);display:block;margin-top:6px">보안 PIN 6자리</label><input id="csPin" class="form-input" type="password" inputmode="numeric" maxlength="6" style="text-align:center;letter-spacing:6px">',
      '암호화 저장', async function () {
        const pin = (document.getElementById('csPin').value || '').trim();
        if (!/^[0-9]{6}$/.test(pin)) { document.getElementById('csMsg').textContent = '보안 PIN 6자리를 입력하세요'; return false; }
        const val = f => { const v = document.getElementById(f).value; return v === '' ? null : v; };
        try { await rpc('ch_card_set_secret', { p_id: id, p_pin: pin, p_card_number: val('csNum'), p_expiry: val('csExp'), p_cvc: val('csCvc'), p_card_pw: val('csPw') }); }
        catch (e) { document.getElementById('csMsg').textContent = CH.pinMsg(e); return false; }
        toast('민감정보 암호화 저장 완료'); CH.renderTab4(); return true;
      });
  };
  CH.delCard = function (id) {
    if (!isMaster()) return;
    const c = (window.__chCard || {})[id] || {};
    if (!confirm((c.store || '') + ' 카드를 삭제합니다. 암호화된 민감정보도 함께 삭제됩니다. 계속할까요?')) return;
    rpc('ch_card_del', { p_id: id }).then(() => { toast('삭제 완료'); CH.renderTab4(); }).catch(e => alert('오류: ' + (e.missing ? '보안 SQL 미실행' : (/ACCESS_DENIED/.test(e.message || '') ? '총괄만 가능' : e.message))));
  };

  /* ───────── 월말 자동대사 (회계 승인엑셀 → 매장 수시등록 매칭) ───────── */
  CH.reconcileBoxHtml = function () {
    return '<div style="margin-top:18px;border-top:0.5px solid var(--crd);padding-top:14px">'
      + '<div style="font-size:14px;font-weight:800;margin-bottom:6px"><i class="ti ti-file-import"></i> 월말 카드 자동대사</div>'
      + '<div style="font-size:12px;color:var(--th);margin-bottom:8px">회계팀 카드 승인 엑셀을 올리면 <b>끝4자리 + 결제일 + 승인금액</b>으로 매장 수시등록 내역과 자동 매칭합니다. (일치=자동마감 / 미등록=매장입력필요 / 불일치·취소=확인필요)</div>'
      + '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">'
      + '<input type="month" id="rcYm" class="form-input" value="' + CH.state.ym + '" style="width:150px">'
      + '<label class="btn-cancel-sm" style="font-size:12px;cursor:pointer"><i class="ti ti-upload"></i> 승인 엑셀 선택<input type="file" id="rcFile" accept=".xlsx,.xls" style="display:none" onchange="ClosingHelper.reconcileParse(this.files[0])"></label>'
      + '</div><div id="rcResult" style="margin-top:10px"></div></div>';
  };
  CH.reconcileParse = function (file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function (e) {
      try {
        const wb = XLSX.read(new Uint8Array(e.target.result), { type: 'array', cellDates: true });
        const aoa = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: null, raw: true });
        let hr = -1, cLast = -1, cDate = -1, cAmt = -1, cCanc = -1;
        for (let r = 0; r < Math.min(aoa.length, 25); r++) {
          const row = (aoa[r] || []).map(x => String(x == null ? '' : x));
          const find = (kw) => row.findIndex(v => kw.some(k => v.indexOf(k) !== -1));
          const li = find(['카드번호', '카드No', '승인카드', '카드']); const ai = find(['승인금액', '결제금액', '이용금액', '합계', '금액']);
          if (li !== -1 && ai !== -1) { hr = r; cLast = li; cDate = find(['결제일', '승인일', '거래일', '매출일', '이용일', '일자', '일시']); cAmt = ai; cCanc = find(['취소', '상태', '구분']); break; }
        }
        if (hr === -1) { document.getElementById('rcResult').innerHTML = '<div style="color:#B91C1C;font-size:12px">헤더(카드번호/금액)를 인식하지 못했습니다. 승인내역 엑셀인지 확인해 주세요.</div>'; return; }
        const last4 = v => { const d = String(v == null ? '' : v).replace(/\D/g, ''); return d.length >= 4 ? d.slice(-4) : ''; };
        const toDate = v => { if (v instanceof Date) { const z = new Date(v.getTime() - v.getTimezoneOffset() * 60000); return z.toISOString().slice(0, 10); } const s = String(v == null ? '' : v); let m = s.match(/(\d{4})[.\-\/]\s?(\d{1,2})[.\-\/]\s?(\d{1,2})/); if (m) return m[1] + '-' + String(m[2]).padStart(2, '0') + '-' + String(m[3]).padStart(2, '0'); m = s.match(/(\d{2})[.\-\/](\d{1,2})[.\-\/](\d{1,2})/); if (m) return '20' + m[1] + '-' + String(m[2]).padStart(2, '0') + '-' + String(m[3]).padStart(2, '0'); return ''; };
        const num = v => { const n = parseFloat(String(v == null ? '' : v).replace(/[^0-9.\-]/g, '')); return isNaN(n) ? 0 : n; };
        const rows = [];
        for (let r = hr + 1; r < aoa.length; r++) {
          const row = aoa[r] || []; const l4 = last4(row[cLast]); const amt = num(row[cAmt]); if (!l4 || !amt) continue;
          const canc = cCanc !== -1 ? /취소|반품|cancel/i.test(String(row[cCanc] || '')) : (amt < 0);
          rows.push({ card_last: l4, tx_date: cDate !== -1 ? toDate(row[cDate]) : '', amount: Math.abs(amt), cancelled: canc });
        }
        window.__chRecon = { ym: document.getElementById('rcYm').value, rows: rows, fileName: file.name };
        CH.renderReconPreview();
      } catch (err) { document.getElementById('rcResult').innerHTML = '<div style="color:#B91C1C;font-size:12px">파싱 오류: ' + esc(err.message) + '</div>'; }
    };
    reader.readAsArrayBuffer(file);
  };
  CH.renderReconPreview = function () {
    const R = window.__chRecon; const box = document.getElementById('rcResult'); if (!R || !box) return;
    const prev = R.rows.slice(0, 8).map(x => '<tr><td style="padding:3px 8px;border-bottom:0.5px solid var(--crm,#eee);font-family:monospace">••••' + esc(x.card_last) + '</td><td style="padding:3px 8px;border-bottom:0.5px solid var(--crm,#eee)">' + esc(x.tx_date || '-') + '</td><td style="padding:3px 8px;border-bottom:0.5px solid var(--crm,#eee);text-align:right">' + won(x.amount) + '</td><td style="padding:3px 8px;border-bottom:0.5px solid var(--crm,#eee);text-align:center">' + (x.cancelled ? '<span style="color:#B91C1C">취소</span>' : '') + '</td></tr>').join('');
    box.innerHTML = '<div style="font-size:12px;margin-bottom:6px">' + esc(R.fileName) + ' — <b>' + R.rows.length + '</b>건 인식 (' + esc(R.ym) + ' 귀속)</div>'
      + '<table style="width:100%;border-collapse:collapse;font-size:12px;background:#fff;border:0.5px solid var(--crd);border-radius:8px;overflow:hidden"><thead><tr style="background:var(--cr,#faf7f2)"><th style="padding:4px 8px;text-align:left">카드</th><th style="padding:4px 8px;text-align:left">결제일</th><th style="padding:4px 8px;text-align:right">승인금액</th><th style="padding:4px 8px">취소</th></tr></thead><tbody>' + prev + '</tbody></table>'
      + (R.rows.length > 8 ? '<div style="font-size:11px;color:var(--th);margin-top:4px">… 외 ' + (R.rows.length - 8) + '건</div>' : '')
      + '<button class="btn-submit" style="font-size:12px;margin-top:8px" onclick="ClosingHelper.reconcileCommit()"><i class="ti ti-check"></i> 자동대사 실행</button>';
  };
  CH.reconcileCommit = async function () {
    const R = window.__chRecon; if (!R || !R.rows.length) return;
    if (!confirm(R.ym + ' 귀속 ' + R.rows.length + '건 자동대사를 실행합니다. 계속할까요?')) return;
    let r; try { r = await rpc('ch_card_reconcile', { p_ym: R.ym, p_rows: R.rows }); } catch (e) { alert('오류: ' + (e.missing ? '보안 SQL 미실행' : (/MONTH_LOCKED/.test(e.message || '') ? '월마감 잠금 상태' : (/ACCESS_DENIED/.test(e.message || '') ? '본사 관리자만 가능' : e.message)))); return; }
    document.getElementById('rcResult').innerHTML = '<div style="padding:10px;border:0.5px solid var(--crd);border-radius:8px;background:var(--cr,#faf7f2);font-size:13px">자동대사 완료 — <b style="color:#15803D">일치·자동마감 ' + r.matched + '</b> / <b style="color:#B45309">매장입력필요 ' + r.need_input + '</b> / <b style="color:#B91C1C">확인필요 ' + r.review + '</b></div>';
    window.__chRecon = null;
  };

  /* ───────── 매장: 한도바 + 수시등록 + 당월 내역 ───────── */
  CH.renderCardStore = async function (b) {
    const sts = CH.stores(); const store = (CH.state.store && sts.indexOf(CH.state.store) !== -1) ? CH.state.store : (sts[0] || '');
    if (!store) { b.innerHTML = '<div style="padding:24px;text-align:center;color:var(--th)">담당 매장이 없습니다</div>'; return; }
    const ym = CH.state.ym;
    const sel = sts.length > 1 ? '<select class="form-input" style="width:160px" onchange="ClosingHelper.state.store=this.value;ClosingHelper.renderTab4()">' + sts.map(s => '<option' + (s === store ? ' selected' : '') + '>' + esc(s) + '</option>').join('') + '</select>' : '<span style="font-size:14px;font-weight:700"><i class="ti ti-building-store"></i> ' + esc(store) + '</span>';
    let usage = {}; try { usage = await rpc('ch_card_usage', { p_store: store, p_ym: ym }) || {}; } catch (e) { if (e.missing) { b.innerHTML = '<div style="padding:24px;text-align:center;color:#B91C1C">보안 SQL 미실행 — closing_cards.sql 을 먼저 실행하세요</div>'; return; } }
    let txs = []; try { txs = await rpc('ch_card_tx_list', { p_store: store, p_ym: ym }) || []; } catch (e) {}
    const used = usage.used || 0, lim = usage.limit, pctv = usage.pct;
    const bar = lim != null
      ? '<div style="margin:8px 0 4px"><div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px"><span>당월 사용 ' + won(used) + '원</span><span style="color:var(--th)">한도 ' + won(lim) + '원 · 잔여 ' + won(usage.remain) + '원</span></div><div style="height:12px;background:#EEE;border-radius:6px;overflow:hidden"><div style="height:100%;width:' + Math.min(100, pctv || 0) + '%;background:' + ((pctv || 0) > 90 ? '#B91C1C' : (pctv || 0) > 70 ? '#D97706' : '#15803D') + '"></div></div><div style="text-align:right;font-size:11px;color:var(--th);margin-top:2px">' + (pctv != null ? pctv + '% 사용' : '') + '</div></div>'
      : '<div style="margin:8px 0;font-size:13px">당월 사용 <b>' + won(used) + '</b>원 <span style="font-size:11px;color:var(--th)">(한도 미설정)</span></div>';
    const RB = { matched: '<span style="font-size:10px;background:#DCFCE7;color:#15803D;border-radius:5px;padding:1px 6px">일치·마감</span>', need_input: '<span style="font-size:10px;background:#FEF3C7;color:#B45309;border-radius:5px;padding:1px 6px">입력필요</span>', review: '<span style="font-size:10px;background:#FEE2E2;color:#B91C1C;border-radius:5px;padding:1px 6px">확인필요</span>', pending: '<span style="font-size:10px;background:#F1F5F9;color:#64748B;border-radius:5px;padding:1px 6px">대기</span>' };
    const accName = code => { const a = (window.__chAccounts || []).find(x => x.code === code); return a ? a.name : (code || '-'); };
    const rows = txs.map(t => '<tr><td style="padding:4px 8px;border-bottom:0.5px solid var(--crm,#eee)">' + esc(String(t.tx_date || '').slice(5)) + '</td><td style="padding:4px 8px;border-bottom:0.5px solid var(--crm,#eee);text-align:right;font-weight:600">' + won(t.total_amount) + '</td><td style="padding:4px 8px;border-bottom:0.5px solid var(--crm,#eee)">' + esc(accName(t.account_code)) + '</td><td style="padding:4px 8px;border-bottom:0.5px solid var(--crm,#eee);font-size:11px;color:var(--th)">' + esc(t.memo || '') + '</td><td style="padding:4px 8px;border-bottom:0.5px solid var(--crm,#eee);text-align:center">' + (RB[t.recon_status] || RB.pending) + (t.source === 'accounting' && t.recon_status === 'need_input' ? ' <button class="btn-cancel-sm" style="font-size:10px;padding:1px 6px" onclick="ClosingHelper.classifyTx(' + t.id + ')">입력</button>' : '') + '</td></tr>').join('');
    b.innerHTML = '<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">' + sel + '<input type="month" class="form-input" style="width:140px" value="' + ym + '" onchange="ClosingHelper.state.ym=this.value;ClosingHelper.renderTab4()"><span style="margin-left:auto;display:flex;gap:6px"><button class="btn-cancel-sm" style="font-size:12px" onclick="ClosingHelper.exportAccountingExcel(\'' + esc(store).replace(/'/g, "\\'") + '\')"><i class="ti ti-file-spreadsheet"></i> 내 매장 엑셀</button><button class="btn-submit" style="font-size:12px" onclick="ClosingHelper.openCardTxAdd(\'' + esc(store).replace(/'/g, "\\'") + '\')"><i class="ti ti-plus"></i> 수시 등록</button></span></div>'
      + bar
      + '<div style="font-size:12px;font-weight:700;margin:12px 0 4px">' + ym + ' 카드 사용내역 <span style="font-size:11px;color:var(--th)">(' + txs.length + '건)</span></div>'
      + '<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:12px;background:#fff;border:0.5px solid var(--crd);border-radius:8px;overflow:hidden"><thead><tr style="background:var(--cr,#faf7f2)"><th style="padding:5px 8px;text-align:left">일자</th><th style="padding:5px 8px;text-align:right">금액</th><th style="padding:5px 8px;text-align:left">계정과목</th><th style="padding:5px 8px;text-align:left">내역</th><th style="padding:5px 8px">상태</th></tr></thead><tbody>' + (rows || '<tr><td colspan="5" style="padding:14px;text-align:center;color:var(--th)">등록된 내역 없음</td></tr>') + '</tbody></table></div>';
  };
  CH.openCardTxAdd = function (store) {
    const accs = window.__chAccounts || [];
    const accOpts = '<option value="">(계정과목 선택)</option>' + accs.map(a => '<option value="' + esc(a.code) + '">' + esc(a.name) + '</option>').join('');
    const today = (new Date()).toISOString().slice(0, 10);
    CH.modal(esc(store) + ' 카드 사용 수시 등록',
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">'
      + '<div><label style="font-size:11px;color:var(--th)">결제일자</label><input id="txDate" type="date" class="form-input" value="' + today + '"></div>'
      + '<div><label style="font-size:11px;color:var(--th)">결제금액</label><input id="txAmt" type="number" class="form-input" placeholder="원"></div>'
      + '<div style="grid-column:1/3"><label style="font-size:11px;color:var(--th)">계정과목</label><select id="txAcc" class="form-input">' + accOpts + '</select></div>'
      + '<div style="grid-column:1/3"><label style="font-size:11px;color:var(--th)">사용내역(인원/목적)</label><input id="txMemo" class="form-input" placeholder="예: 매장 비품 구입 / 3인"></div>'
      + '</div>'
      + '<div style="margin-top:8px"><label style="font-size:11px;color:var(--th)">영수증 사진(선택)</label><input id="txFile" type="file" accept="image/*" capture="environment" class="form-input" style="font-size:12px"></div>'
      + '<div id="txMsg" style="font-size:12px;color:#B91C1C;margin-top:6px;min-height:14px"></div>',
      '등록', async function () {
        const date = document.getElementById('txDate').value, amt = Number(document.getElementById('txAmt').value || 0);
        if (!date || !amt) { document.getElementById('txMsg').textContent = '결제일자/금액을 입력하세요'; return false; }
        let evid = null; const f = document.getElementById('txFile').files[0];
        if (f) { try { const path = 'card/' + date.slice(0, 7) + '/' + store + '/' + Date.now() + '_' + f.name; const up = await sbc().storage.from(STORAGE_BUCKET).upload(path, f, { upsert: true }); if (!up.error) evid = path; } catch (e) {} }
        try { await rpc('ch_card_tx_add', { p_store: store, p_tx_date: date, p_total: amt, p_account: document.getElementById('txAcc').value || null, p_memo: document.getElementById('txMemo').value.trim() || null, p_card_last: null, p_evidence: evid }); }
        catch (e) { document.getElementById('txMsg').textContent = /MONTH_LOCKED/.test(e.message || '') ? '월마감 잠금 상태' : (e.missing ? '보안 SQL 미실행' : '오류: ' + e.message); return false; }
        toast('등록 완료'); CH.renderTab4(); return true;
      });
  };
  CH.classifyTx = function (id) {
    const accs = window.__chAccounts || [];
    const accOpts = '<option value="">(계정과목 선택)</option>' + accs.map(a => '<option value="' + esc(a.code) + '">' + esc(a.name) + '</option>').join('');
    CH.modal('미등록 결제건 입력',
      '<div style="font-size:12px;color:var(--th);margin-bottom:8px">회계 승인내역에만 있던 결제건입니다. 계정과목과 사용내역을 입력하세요.</div>'
      + '<select id="ctAcc" class="form-input" style="margin-bottom:8px">' + accOpts + '</select>'
      + '<input id="ctMemo" class="form-input" placeholder="사용내역(인원/목적)">',
      '저장', async function () {
        try { await rpc('ch_card_tx_update', { p_id: id, p_account: document.getElementById('ctAcc').value || null, p_memo: document.getElementById('ctMemo').value.trim() || null }); }
        catch (e) { alert('오류: ' + (e.missing ? '보안 SQL 미실행' : e.message)); return false; }
        toast('저장 완료'); CH.renderTab4(); return true;
      });
  };

  /* ======================================================================
   * [탭 5] 거래처 관리 (본사) — vendor_master 확장 + 파일첨부 + 매장지정
   * ==================================================================== */
  async function vendorUpload(file, slug, kind) {
    const path = 'vendor/' + slug + '/' + kind + '_' + Date.now() + '_' + file.name;
    const up = await sbc().storage.from('closing-statements').upload(path, file, { upsert: true });
    if (up.error) throw up.error; return path;
  }
  CH.renderTab5 = async function () {
    const b = document.getElementById('chTabBody'); if (!b) return;
    if (!CH.isHQ()) { b.innerHTML = '<div style="padding:24px;text-align:center;color:var(--th)">본사 관리자 전용입니다.</div>'; return; }
    b.innerHTML = '<div style="padding:20px;text-align:center;color:var(--th)">불러오는 중…</div>';
    let vs = [];
    try { vs = await rpc('ch_vendors', {}) || []; } catch (e) { b.innerHTML = '<div style="padding:24px;text-align:center;color:#B91C1C">' + (e.missing ? '보안 SQL 미실행 (closing_vendors.sql)' : '오류: ' + esc(e.message)) + '</div>'; return; }
    window.__chVendorMap = {}; vs.forEach(v => { window.__chVendorMap[v.slug] = v; });
    const scopeTxt = v => v.scope === 'store' ? ('매장지정(' + ((v.scope_stores || []).length) + ')') : '전사공통';
    const rows = vs.map(v => '<tr>'
      + '<td style="padding:5px 8px;border-bottom:0.5px solid var(--crm,#eee);font-weight:600">' + esc(v.canonical || v.slug) + '</td>'
      + '<td style="padding:5px 8px;border-bottom:0.5px solid var(--crm,#eee)">' + esc(v.biz_no || '-') + '</td>'
      + '<td style="padding:5px 8px;border-bottom:0.5px solid var(--crm,#eee)">' + esc(v.settle_day || '-') + '</td>'
      + '<td style="padding:5px 8px;border-bottom:0.5px solid var(--crm,#eee)">' + esc(scopeTxt(v)) + '</td>'
      + '<td style="padding:5px 8px;border-bottom:0.5px solid var(--crm,#eee)">' + esc(v.tax_type || '-') + '</td>'
      + '<td style="padding:5px 8px;border-bottom:0.5px solid var(--crm,#eee);white-space:nowrap"><button class="btn-cancel-sm" style="font-size:11px;padding:3px 7px" onclick="ClosingHelper.openVendorEdit(\'' + esc(v.slug).replace(/'/g, "\\'") + '\')">수정</button> <button class="btn-cancel-sm" style="font-size:11px;padding:3px 7px;color:#B91C1C;border-color:#FCA5A5" onclick="ClosingHelper.delVendor(\'' + esc(v.slug).replace(/'/g, "\\'") + '\')">삭제</button></td></tr>').join('');
    b.innerHTML = '<div style="display:flex;align-items:center;margin-bottom:10px"><span style="font-size:14px;font-weight:800"><i class="ti ti-truck"></i> 거래처 관리 <span style="font-size:11px;color:var(--th)">(' + vs.length + ')</span></span><button class="btn-submit" style="font-size:12px;margin-left:auto" onclick="ClosingHelper.openVendorEdit(null)"><i class="ti ti-plus"></i> 거래처 등록</button></div>'
      + '<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:12px;background:#fff;border:0.5px solid var(--crd);border-radius:8px;overflow:hidden"><thead><tr style="background:var(--cr,#faf7f2)"><th style="padding:6px 8px;text-align:left">업체명</th><th style="padding:6px 8px;text-align:left">사업자번호</th><th style="padding:6px 8px;text-align:left">정산시점</th><th style="padding:6px 8px;text-align:left">거래구분</th><th style="padding:6px 8px;text-align:left">과세</th><th style="padding:6px 8px">관리</th></tr></thead><tbody>' + (rows || '<tr><td colspan="6" style="padding:14px;text-align:center;color:var(--th)">등록된 거래처 없음</td></tr>') + '</tbody></table></div>';
  };
  CH.openVendorEdit = async function (slug) {
    const v = slug ? (window.__chVendorMap || {})[slug] : null;
    const opts = await loadStoreOptions();
    const selStores = (v && v.scope_stores) || [];
    const storeChks = opts.map(s => '<label style="display:inline-flex;align-items:center;gap:3px;font-size:11px;margin:2px 6px 2px 0"><input type="checkbox" class="vdStore" value="' + esc(s) + '"' + (selStores.indexOf(s) >= 0 ? ' checked' : '') + '> ' + esc(s) + '</label>').join('');
    CH.modal((v ? '거래처 수정' : '거래처 등록'),
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">'
      + '<div><label style="font-size:11px;color:var(--th)">업체명(정식)</label><input id="vdName" class="form-input" value="' + esc(v ? v.canonical || '' : '') + '"></div>'
      + '<div><label style="font-size:11px;color:var(--th)">코드(slug·영문)</label><input id="vdSlug" class="form-input" value="' + esc(v ? v.slug : '') + '"' + (v ? ' disabled' : '') + ' placeholder="예: delishop"></div>'
      + '<div><label style="font-size:11px;color:var(--th)">사업자등록번호</label><input id="vdBiz" class="form-input" value="' + esc(v ? v.biz_no || '' : '') + '"></div>'
      + '<div><label style="font-size:11px;color:var(--th)">기본 과세구분</label><select id="vdTax" class="form-input"><option value="">(선택)</option><option' + (v && v.tax_type === '과세' ? ' selected' : '') + '>과세</option><option' + (v && v.tax_type === '면세' ? ' selected' : '') + '>면세</option></select></div>'
      + '<div><label style="font-size:11px;color:var(--th)">정산 은행</label><input id="vdBank" class="form-input" value="' + esc(v ? v.settle_bank || '' : '') + '"></div>'
      + '<div><label style="font-size:11px;color:var(--th)">정산 계좌번호</label><input id="vdAcct" class="form-input" value="' + esc(v ? v.settle_acct || '' : '') + '"></div>'
      + '<div><label style="font-size:11px;color:var(--th)">정산 시점</label><input id="vdDay" class="form-input" value="' + esc(v ? v.settle_day || '' : '') + '" placeholder="예: 10 / 25 / 말일"></div>'
      + '<div><label style="font-size:11px;color:var(--th)">담당자 이름</label><input id="vdMgr" class="form-input" value="' + esc(v ? v.mgr_name || '' : '') + '"></div>'
      + '<div><label style="font-size:11px;color:var(--th)">담당자 연락처</label><input id="vdPhone" class="form-input" value="' + esc(v ? v.mgr_phone || '' : '') + '"></div>'
      + '<div><label style="font-size:11px;color:var(--th)">담당자 이메일</label><input id="vdEmail" class="form-input" value="' + esc(v ? v.mgr_email || '' : '') + '"></div>'
      + '</div>'
      + '<div style="margin-top:8px"><label style="font-size:11px;color:var(--th)">거래 구분</label><select id="vdScope" class="form-input" onchange="document.getElementById(\'vdStores\').style.display=this.value===\'store\'?\'\':\'none\'"><option value="common"' + (!v || v.scope !== 'store' ? ' selected' : '') + '>전사 공통</option><option value="store"' + (v && v.scope === 'store' ? ' selected' : '') + '>특정 매장 지정</option></select></div>'
      + '<div id="vdStores" style="margin-top:6px;' + (v && v.scope === 'store' ? '' : 'display:none') + '">' + storeChks + '</div>'
      + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px">'
      + '<div><label style="font-size:11px;color:var(--th)">사업자등록증' + (v && v.biz_file ? ' <span style="color:#15803D">(등록됨)</span>' : '') + '</label><input id="vdBizFile" type="file" class="form-input" style="font-size:11px"></div>'
      + '<div><label style="font-size:11px;color:var(--th)">통장사본' + (v && v.bankbook_file ? ' <span style="color:#15803D">(등록됨)</span>' : '') + '</label><input id="vdBankFile" type="file" class="form-input" style="font-size:11px"></div>'
      + '</div>'
      + '<div style="margin-top:8px"><label style="font-size:11px;color:var(--th)">비고</label><input id="vdMemo" class="form-input" value="' + esc(v ? v.memo || '' : '') + '"></div>'
      + '<div id="vdMsg" style="font-size:12px;color:#B91C1C;margin-top:6px;min-height:14px"></div>',
      '저장', async function () {
        const name = document.getElementById('vdName').value.trim();
        const vslug = (v ? v.slug : document.getElementById('vdSlug').value.trim());
        if (!name || !vslug) { document.getElementById('vdMsg').textContent = '업체명/코드를 입력하세요'; return false; }
        let bizFile = null, bankFile = null;
        try {
          const bf = document.getElementById('vdBizFile').files[0]; if (bf) bizFile = await vendorUpload(bf, vslug, 'biz');
          const kf = document.getElementById('vdBankFile').files[0]; if (kf) bankFile = await vendorUpload(kf, vslug, 'bank');
        } catch (e) { document.getElementById('vdMsg').textContent = '파일 업로드 오류: ' + (e.message || e); return false; }
        const scope = document.getElementById('vdScope').value;
        const scopeStores = scope === 'store' ? Array.from(document.querySelectorAll('.vdStore:checked')).map(x => x.value) : [];
        try {
          await rpc('ch_vendor_save_full', { p_slug: vslug, p_canonical: name, p_aliases: (v && v.aliases) || [], p_biz_no: document.getElementById('vdBiz').value.trim() || null, p_biz_file: bizFile, p_settle_bank: document.getElementById('vdBank').value.trim() || null, p_settle_acct: document.getElementById('vdAcct').value.trim() || null, p_bankbook_file: bankFile, p_mgr_name: document.getElementById('vdMgr').value.trim() || null, p_mgr_phone: document.getElementById('vdPhone').value.trim() || null, p_mgr_email: document.getElementById('vdEmail').value.trim() || null, p_settle_day: document.getElementById('vdDay').value.trim() || null, p_scope: scope, p_scope_stores: scopeStores, p_tax_type: document.getElementById('vdTax').value || null, p_memo: document.getElementById('vdMemo').value.trim() || null, p_active: true });
        } catch (e) { document.getElementById('vdMsg').textContent = e.missing ? '보안 SQL 미실행' : (/ACCESS_DENIED/.test(e.message || '') ? '본사 관리자만 가능' : '오류: ' + e.message); return false; }
        toast('거래처 저장 완료'); CH.renderTab5(); return true;
      });
  };
  CH.delVendor = function (slug) {
    const v = (window.__chVendorMap || {})[slug] || {};
    if (!confirm((v.canonical || slug) + ' 거래처를 삭제할까요?')) return;
    rpc('ch_vendor_del', { p_slug: slug }).then(() => { toast('삭제 완료'); CH.renderTab5(); }).catch(e => alert('오류: ' + (e.missing ? '보안 SQL 미실행' : (/ACCESS_DENIED/.test(e.message || '') ? '본사 관리자만 가능' : e.message))));
  };

  /* ======================================================================
   * [모듈 C] 회계팀 제출용 통합 엑셀 (ExcelJS)
   *   본사=전 매장(PDC 제외), 매니저=본인 매장. 동일 레이아웃 + 실제 계산값.
   * ==================================================================== */
  CH.exportAccountingExcel = async function (scope) {
    if (typeof ExcelJS === 'undefined') { alert('엑셀 라이브러리 로딩 중입니다. 잠시 후 다시 시도해주세요.'); return; }
    toast('엑셀 생성 중…');
    let d;
    try { d = await rpc('ch_export_data', { p_ym: CH.state.ym, p_store: (scope === 'all' ? null : scope) }); }
    catch (e) { alert('데이터 조회 오류: ' + (e.missing ? '보안 SQL 미실행 (closing_module_c.sql)' : (/ACCESS_DENIED/.test(e.message || '') ? '권한 없음' : e.message))); return; }
    const accounts = d.accounts || [], stores = d.stores || [], ym = d.ym;
    if (!stores.length) { alert('대상 매장이 없습니다'); return; }
    const accName = c => { const a = accounts.find(x => x.code === c); return a ? a.name : (c || '미분류'); };
    const num = n => Number(n || 0);
    const money = '#,##0';
    const HDR = { argb: 'FFF3EAD9' };
    const thin = { top: { style: 'thin', color: { argb: 'FFDDDDDD' } }, left: { style: 'thin', color: { argb: 'FFDDDDDD' } }, bottom: { style: 'thin', color: { argb: 'FFDDDDDD' } }, right: { style: 'thin', color: { argb: 'FFDDDDDD' } } };
    const wb = new ExcelJS.Workbook(); wb.creator = '보난자 월말 정산 도우미';
    const safe = s => String(s || '').replace(/[\[\]\*\?\/\\:]/g, '').slice(0, 22);
    function headerRow(ws, cells, from) {
      const r = ws.addRow(cells);
      r.eachCell((c, i) => { if (!from || i >= from) { c.font = { bold: true }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: HDR }; c.alignment = { vertical: 'middle', horizontal: 'center' }; c.border = thin; } });
      return r;
    }
    // 1) 법인카드 전사집계 (전체 모드)
    if (scope === 'all' && stores.length > 1) {
      const ws = wb.addWorksheet('법인카드 전사집계');
      ws.getCell('A1').value = '법인카드 계정별 전사집계 (' + ym + ') — 합계금액 기준, PDC 제외'; ws.getCell('A1').font = { bold: true, size: 13 };
      ws.addRow([]);
      headerRow(ws, ['구분', '계정과목'].concat(stores.map(s => s.store)).concat(['합계']));
      accounts.forEach(a => {
        const row = [a.kind, a.name]; let tot = 0;
        stores.forEach(s => { const v = (s.cards || []).filter(c => !c.cancelled && c.account_code === a.code).reduce((x, c) => x + num(c.total), 0); row.push(v); tot += v; });
        row.push(tot); const rr = ws.addRow(row);
        for (let i = 3; i <= stores.length + 3; i++) rr.getCell(i).numFmt = money;
      });
      ws.columns.forEach((c, i) => { c.width = i < 2 ? 12 : 12; });
    }
    // 2) 업체별 합산 (전체 모드) — 발주(세금계산서 발급분) 합계금액 기준
    if (scope === 'all' && stores.length > 1) {
      const ws = wb.addWorksheet('업체별 합산');
      ws.getCell('A1').value = '업체별 합산 (' + ym + ') — 합계금액 기준, PDC 제외'; ws.getCell('A1').font = { bold: true, size: 13 };
      ws.addRow([]);
      const vendors = Array.from(new Set([].concat.apply([], stores.map(s => (s.orders || []).map(o => o.vendor || '(미지정)'))))).sort();
      headerRow(ws, ['업체명'].concat(stores.map(s => s.store)).concat(['합계']));
      vendors.forEach(v => {
        const row = [v]; let tot = 0;
        stores.forEach(s => { const amt = (s.orders || []).filter(o => (o.vendor || '(미지정)') === v).reduce((x, o) => x + num(o.total || o.amount), 0); row.push(amt); tot += amt; });
        row.push(tot); const rr = ws.addRow(row);
        for (let i = 2; i <= stores.length + 2; i++) rr.getCell(i).numFmt = money;
      });
      ws.columns.forEach((c, i) => { c.width = i === 0 ? 20 : 12; });
    }
    // 3) 매장별 법인카드 사용세부내역 (좌측 17계정 집계 + 우측 상세)
    stores.forEach(s => {
      const ws = wb.addWorksheet('카드_' + safe(s.store));
      ws.getCell('A1').value = '[' + s.store + '] 법인카드 사용세부내역 (' + ym.replace('-', '.') + '월)'; ws.getCell('A1').font = { bold: true, size: 12 };
      ws.addRow([]);
      headerRow(ws, ['구분', '계정과목', '금액', '', 'No.', '일자', '금액', '계정과목', '내용(인원/사용내역)', '카드번호']);
      const cards = (s.cards || []).filter(c => !c.cancelled);
      const sumByAcc = code => cards.filter(c => c.account_code === code).reduce((x, c) => x + num(c.total), 0);
      const maxRows = Math.max(accounts.length, cards.length);
      let gtot = 0;
      for (let i = 0; i < maxRows; i++) {
        const a = accounts[i], c = cards[i];
        const left = a ? [a.kind, a.name, (function () { const v = sumByAcc(a.code); gtot += v; return v; })()] : ['', '', null];
        const right = c ? ['', (c.tx_date ? String(c.tx_date).slice(5).replace('-', '.') : ''), num(c.total), accName(c.account_code), c.memo || '', (c.card_last ? '****' + c.card_last : '')] : ['', '', null, '', '', ''];
        const rr = ws.addRow(left.concat(right));
        rr.getCell(3).numFmt = money; rr.getCell(7).numFmt = money;
        rr.eachCell((cell) => { cell.border = thin; });
      }
      // 합계행
      const tr = ws.addRow(['', '합  계', gtot]); tr.getCell(2).font = { bold: true }; tr.getCell(3).font = { bold: true }; tr.getCell(3).numFmt = money;
      ws.columns = [{ width: 8 }, { width: 18 }, { width: 13 }, { width: 2 }, { width: 5 }, { width: 8 }, { width: 13 }, { width: 14 }, { width: 40 }, { width: 16 }];
    });
    // 4) 매장별 입재고 종합
    stores.forEach(s => {
      const ws = wb.addWorksheet('입재고_' + safe(s.store));
      ws.getCell('A1').value = '[' + s.store + '] 입재고 종합 (' + ym + ')'; ws.getCell('A1').font = { bold: true, size: 12 };
      ws.addRow([]);
      headerRow(ws, ['분류', '품명', '규격', '단위', '기초수량', '입고', '사용', '기말(실사)', '단가', '기말금액']);
      (s.inventory || []).forEach(it => {
        const closeQ = num(it.count_qty), up = num(it.unit_price);
        const rr = ws.addRow([it.category || '', it.item || '', it.spec || '', it.unit || '', num(it.opening_qty), num(it.in_qty), num(it.use_qty), closeQ, up, closeQ * up]);
        [5, 6, 7, 8].forEach(i => rr.getCell(i).numFmt = '#,##0.##');
        [9, 10].forEach(i => rr.getCell(i).numFmt = money);
        rr.eachCell(c => c.border = thin);
      });
      ws.columns = [{ width: 10 }, { width: 26 }, { width: 16 }, { width: 8 }, { width: 11 }, { width: 10 }, { width: 10 }, { width: 11 }, { width: 11 }, { width: 14 }];
    });
    // 5) 매장별 세금계산서 사용세부내역 (발주 기준)
    stores.forEach(s => {
      const ws = wb.addWorksheet('계산서_' + safe(s.store));
      ws.getCell('A1').value = '[' + s.store + '] 세금계산서 사용세부내역 (' + ym + ')'; ws.getCell('A1').font = { bold: true, size: 12 };
      ws.addRow([]);
      headerRow(ws, ['No.', '업체명', '구분(계정)', '공급가', '부가세', '합계금액']);
      let i = 1;
      (s.orders || []).filter(o => !o.is_corp_card).forEach(o => {
        const supply = num(o.supply) || Math.round(num(o.total || o.amount) / 1.1), vat = num(o.vat) || (num(o.total || o.amount) - supply), total = num(o.total) || num(o.amount);
        const rr = ws.addRow([i++, o.vendor || '(미지정)', o.category || '', supply, vat, total]);
        [4, 5, 6].forEach(k => rr.getCell(k).numFmt = money);
        rr.eachCell(c => c.border = thin);
      });
      ws.columns = [{ width: 5 }, { width: 22 }, { width: 14 }, { width: 14 }, { width: 12 }, { width: 14 }];
    });

    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob); const a = document.createElement('a');
    a.href = url; a.download = '회계제출_' + (scope === 'all' ? '전매장' : scope) + '_' + ym + '.xlsx'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2500);
    toast('엑셀 다운로드 완료');
  };

  // 로그인/세션 복원 순서와 무관하게 안전 마운트: currentUser 가 준비될 때까지 대기 후 플래그 로드
  (function waitUser(n) {
    if (window.currentUser && typeof sbc() !== 'undefined' && sbc()) { CH.loadFlags(); }
    else if (n < 60) { setTimeout(function () { waitUser(n + 1); }, 250); }
  })(0);
  // 외부(로그인 완료 시)에서도 호출할 수 있는 훅
  CH.remount = function () { try { CH.loadFlags(); } catch (e) {} };
})();
