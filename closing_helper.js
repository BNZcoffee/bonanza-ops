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
      + '<div style="display:flex;border-bottom:0.5px solid var(--crd);margin:8px 0 14px">' + tb(1, '서류 자동검수', 'ti-file-search') + tb(2, '발주 추이 & 원가', 'ti-chart-line') + tb(3, '품목·단가 & 보관함', 'ti-database') + '</div>'
      + '<div id="chTabBody"></div></div>';
    if (tab === 1) CH.renderTab1(); else if (tab === 2) CH.renderTab2(); else CH.renderTab3();
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

  // 로그인/세션 복원 순서와 무관하게 안전 마운트: currentUser 가 준비될 때까지 대기 후 플래그 로드
  (function waitUser(n) {
    if (window.currentUser && typeof sbc() !== 'undefined' && sbc()) { CH.loadFlags(); }
    else if (n < 60) { setTimeout(function () { waitUser(n + 1); }, 250); }
  })(0);
  // 외부(로그인 완료 시)에서도 호출할 수 있는 훅
  CH.remount = function () { try { CH.loadFlags(); } catch (e) {} };
})();
