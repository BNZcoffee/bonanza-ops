/* ============================================================================
 * 월말 정산 도우미 (보난자 월말 도우미 통합판) — closing_helper.js
 * index.html 하단에서 SheetJS(xlsx) + JSZip + Chart.js 와 함께 로드되는 분리 모듈.
 *
 * 숨김 메뉴(Feature Flag): app_settings.closing_menu_visible (기본 false)
 *   - false → 총괄(is_master) 사이드바에만 '[개발중] 월말 정산 도우미' 노출
 *   - true  → 접근 권한자 전원 노출
 * 접근 권한: 총괄(is_master) / 매장관리자(position 매니저·매니저B) /
 *            허용 파트의 부서담당(role==='dept' & part ∈ closing_allowed_parts) /
 *            예외 허용자(id ∈ closing_allowed_users). 팀원·PT 는 원천 차단.
 *
 * 1차 버전(구조 우선): 파싱 규칙(거래명세서 열 매핑/카테고리 분류)은 아래
 *   CH.COLMAP / CH.CATEGORY_RULES 로 분리. 실제 거래명세서 샘플로 이 두 상수만
 *   보정하면 숫자 정합성이 맞춰진다.
 * ==========================================================================*/
(function () {
  'use strict';
  if (window.ClosingHelper) return;
  const CH = (window.ClosingHelper = {});
  const esc = (s) => (window.esc ? window.esc(s) : String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  const sbc = () => window.sb;
  const ADMIN = () => !!(window.currentUser && window.currentUser.is_master);

  // ── 거래명세서 파싱 규칙 (실제 샘플로 보정) ───────────────────────────────
  CH.COLMAP = {           // 헤더 텍스트에 아래 키워드가 포함되면 해당 필드로 인식
    name:  ['품목', '품명', '상품명', '규격품명', '품목명'],
    spec:  ['규격', '단위규격'],
    qty:   ['수량', '입수', '박스'],
    unit:  ['단가', '공급단가'],
    amount:['금액', '공급가', '공급가액', '합계', '합계금액'],
    vendor:['거래처', '업체', '공급처'],
    cat:   ['분류', '카테고리', '구분']
  };
  CH.CATEGORY_RULES = [   // 분류열이 없을 때 품목명 키워드로 카테고리 추정
    { cat: '원재료', kw: ['원두', '우유', '생크림', '시럽원액', '커피', '에스프레소'] },
    { cat: '부재료', kw: ['시럽', '소스', '파우더', '토핑', '분말', '농축'] },
    { cat: '소모품', kw: ['컵', '뚜껑', '빨대', '홀더', '냅킨', '봉투', '장갑', '행주', '세제'] },
    { cat: '상품',   kw: ['원두판매', 'MD', '굿즈', '텀블러', '머그', '드립백'] }
  ];
  CH.CATEGORIES = ['원재료', '부재료', '소모품', '상품', '법인카드', '미분류'];
  const STORAGE_BUCKET = 'closing-statements';

  /* ───────────────────────── 권한 / 피처플래그 ──────────────────────────── */
  CH.canAccess = function (u) {
    u = u || window.currentUser; if (!u) return false;
    if (u.is_master) return true;
    const pos = String(u.position || '');
    if (pos === '매니저' || pos === '매니저B') return true;
    if (u.role === 'dept' && Array.isArray(window.__closingParts) && window.__closingParts.map(String).includes(String(u.part || ''))) return true;
    if (Array.isArray(window.__closingUsers) && window.__closingUsers.map(String).includes(String(u.id))) return true;
    return false;
  };
  CH.navVisible = function (u) {
    u = u || window.currentUser; if (!u) return false;
    if (window.__closingVisible === true) return CH.canAccess(u);   // 전체 공개
    return !!u.is_master;                                           // 숨김(기본): 총괄만
  };
  CH.applyNav = function () {
    const el = document.getElementById('nav-closingHelper');
    if (!el) return;
    el.style.display = CH.navVisible() ? '' : 'none';
    const dev = (window.__closingVisible !== true);   // 미공개 상태면 [개발중] 표식
    el.innerHTML = '<i class="ti ti-calculator"></i> ' + (dev ? '[개발중] ' : '') + '월말 정산 도우미';
  };
  CH.loadFlags = async function () {
    window.__closingVisible = false; window.__closingParts = []; window.__closingUsers = [];
    try {
      const { data } = await sbc().from('app_settings').select('key,value')
        .in('key', ['closing_menu_visible', 'closing_allowed_parts', 'closing_allowed_users']);
      (data || []).forEach(r => {
        if (r.key === 'closing_menu_visible') {
          const v = String(r.value).toLowerCase().replace(/"/g, '').trim();
          window.__closingVisible = (v === 'true' || v === '1');
        } else {
          try { const a = typeof r.value === 'string' ? JSON.parse(r.value) : r.value;
            if (Array.isArray(a)) { if (r.key === 'closing_allowed_parts') window.__closingParts = a.map(String); else window.__closingUsers = a.map(String); } } catch (e) {}
        }
      });
    } catch (e) {}
    CH.applyNav();
    return true;
  };

  function toast(msg) {
    try {
      let t = document.getElementById('chToast');
      if (!t) { t = document.createElement('div'); t.id = 'chToast'; t.style.cssText = 'position:fixed;left:50%;bottom:32px;transform:translateX(-50%);background:rgba(43,26,14,.92);color:#fff;padding:10px 18px;border-radius:10px;font-size:13px;z-index:100000;box-shadow:0 6px 24px rgba(0,0,0,.25);max-width:90vw;text-align:center'; document.body.appendChild(t); }
      t.textContent = msg; t.style.display = 'block';
      clearTimeout(window.__chToastT); window.__chToastT = setTimeout(() => { try { t.style.display = 'none'; } catch (_) {} }, 2600);
    } catch (e) { try { alert(msg); } catch (_) {} }
  }
  CH._toast = toast;
  const won = (n) => (Number(n) || 0).toLocaleString('ko-KR');

  /* ───────────────────────── 메인 렌더 (3-Tab) ──────────────────────────── */
  CH.state = { tab: 1, parsed: null, stockParsed: null, store: '', ym: (new Date()).toISOString().slice(0, 7) };

  CH.render = function (area) {
    if (!CH.canAccess()) { area.innerHTML = '<div style="text-align:center;padding:60px;color:var(--th)">접근 권한이 없습니다. (총괄 / 매장관리자 / 허용 부서담당 / 예외 허용자만 사용 가능합니다)</div>'; return; }
    const tab = CH.state.tab;
    const tabBtn = (n, label, icon) => '<button onclick="ClosingHelper.goTab(' + n + ')" class="ch-tab" style="flex:1;padding:10px 8px;border:none;border-bottom:2.5px solid ' + (tab === n ? 'var(--br,#8a5a2b)' : 'transparent') + ';background:none;font-size:13px;font-weight:' + (tab === n ? '700' : '500') + ';color:' + (tab === n ? 'var(--br,#8a5a2b)' : 'var(--th)') + ';cursor:pointer"><i class="ti ' + icon + '"></i> ' + label + '</button>';
    const settingsBtn = ADMIN() ? '<button class="btn-cancel-sm" style="font-size:12px" onclick="ClosingHelper.openSettings()"><i class="ti ti-shield-lock"></i> 권한 설정</button>' : '';
    area.innerHTML =
      '<div style="max-width:1180px;margin:0 auto;padding:4px 2px 40px">'
      + '<div style="display:flex;align-items:center;gap:10px;margin-bottom:4px">'
      +   '<h2 style="font-size:19px;font-weight:800;margin:0"><i class="ti ti-calculator" style="color:var(--br,#8a5a2b)"></i> 월말 정산 도우미</h2>'
      +   (window.__closingVisible !== true ? '<span style="font-size:11px;background:#FEF3C7;color:#92400E;border-radius:6px;padding:2px 8px;font-weight:700">개발중 · 총괄 전용 노출</span>' : '')
      +   '<span style="margin-left:auto">' + settingsBtn + '</span>'
      + '</div>'
      + '<div style="font-size:12px;color:var(--th);margin-bottom:10px">브라우저 내 처리(검수용 엑셀은 서버 미저장) · 보관용 원본만 Supabase Storage 저장</div>'
      + '<div style="display:flex;border-bottom:0.5px solid var(--crd);margin-bottom:14px">'
      +   tabBtn(1, '서류 자동검수', 'ti-file-search')
      +   tabBtn(2, '발주 비중 & 원가', 'ti-chart-donut')
      +   tabBtn(3, '품목·단가 & 보관함', 'ti-database')
      + '</div>'
      + '<div id="chTabBody"></div>'
      + '</div>';
    if (tab === 1) CH.renderTab1();
    else if (tab === 2) CH.renderTab2();
    else CH.renderTab3();
  };
  CH.goTab = function (n) { CH.state.tab = n; CH.render(document.getElementById('contentArea')); };

  /* ======================================================================
   * [탭 1] 서류 자동검수 (거래명세서 & 입재고)
   * ==================================================================== */
  CH.renderTab1 = function () {
    const b = document.getElementById('chTabBody'); if (!b) return;
    b.innerHTML =
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px">'
      + '<div style="border:1.5px dashed var(--crd);border-radius:10px;padding:18px;text-align:center;background:var(--cr,#faf7f2);cursor:pointer" onclick="document.getElementById(\'chFile\').click()">'
      +   '<i class="ti ti-file-spreadsheet" style="font-size:28px;color:var(--br,#8a5a2b)"></i>'
      +   '<div style="font-size:13px;font-weight:700;margin-top:6px">거래명세서 엑셀 업로드</div>'
      +   '<div style="font-size:11px;color:var(--th);margin-top:2px">.xlsx / .xls / .csv — 원재료·부재료·소모품·상품 합계 자동 산출</div>'
      +   '<input type="file" id="chFile" accept=".xlsx,.xls,.csv" style="display:none" onchange="ClosingHelper.parseStatement(this.files[0])">'
      + '</div>'
      + '<div style="border:1.5px dashed var(--crd);border-radius:10px;padding:18px;text-align:center;background:var(--cr,#faf7f2);cursor:pointer" onclick="document.getElementById(\'chStock\').click()">'
      +   '<i class="ti ti-clipboard-check" style="font-size:28px;color:#1E40AF"></i>'
      +   '<div style="font-size:13px;font-weight:700;margin-top:6px">입재고 파일 업로드 (검수 대조)</div>'
      +   '<div style="font-size:11px;color:var(--th);margin-top:2px">거래명세서와 품목/금액 일치·불일치 자동 검수</div>'
      +   '<input type="file" id="chStock" accept=".xlsx,.xls,.csv" style="display:none" onchange="ClosingHelper.parseStock(this.files[0])">'
      + '</div>'
      + '</div>'
      + '<div id="chParseResult"></div>';
    if (CH.state.parsed) CH.renderParseResult();
  };

  function sheetToRows(file, cb) {
    const reader = new FileReader();
    reader.onload = function (e) {
      try {
        const wb = XLSX.read(new Uint8Array(e.target.result), { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
        cb(null, rows, wb.SheetNames[0]);
      } catch (err) { cb(err); }
    };
    reader.onerror = () => cb(reader.error);
    reader.readAsArrayBuffer(file);
  }
  function findCol(headerRow, keys) {
    for (let i = 0; i < headerRow.length; i++) {
      const h = String(headerRow[i] || '').replace(/\s/g, '');
      if (keys.some(k => h.indexOf(k) >= 0)) return i;
    }
    return -1;
  }
  function detectHeader(rows) {
    for (let r = 0; r < Math.min(rows.length, 20); r++) {
      const nameC = findCol(rows[r], CH.COLMAP.name);
      const amtC = findCol(rows[r], CH.COLMAP.amount);
      if (nameC >= 0 && amtC >= 0) return r;
    }
    return -1;
  }
  function guessCategory(name) {
    const n = String(name || '');
    for (const rule of CH.CATEGORY_RULES) if (rule.kw.some(k => n.indexOf(k) >= 0)) return rule.cat;
    return '미분류';
  }
  CH.parseWorkbook = function (file, cb) {
    sheetToRows(file, function (err, rows) {
      if (err) { cb(err); return; }
      const hr = detectHeader(rows);
      if (hr < 0) { cb(new Error('헤더(품목/금액 열)를 찾지 못했습니다. COLMAP 키워드를 보정하세요.')); return; }
      const H = rows[hr];
      const cName = findCol(H, CH.COLMAP.name), cQty = findCol(H, CH.COLMAP.qty), cUnit = findCol(H, CH.COLMAP.unit),
        cAmt = findCol(H, CH.COLMAP.amount), cVen = findCol(H, CH.COLMAP.vendor), cCat = findCol(H, CH.COLMAP.cat);
      const items = [];
      for (let r = hr + 1; r < rows.length; r++) {
        const row = rows[r]; if (!row) continue;
        const name = String(row[cName] || '').trim(); if (!name) continue;
        if (/합\s*계|소\s*계|총\s*계|합계금액/.test(name)) continue;   // 합계행 제외
        const amount = Number(String(row[cAmt] == null ? '' : row[cAmt]).replace(/[^0-9.-]/g, '')) || 0;
        const qty = cQty >= 0 ? (Number(String(row[cQty]).replace(/[^0-9.-]/g, '')) || 0) : 0;
        const unit = cUnit >= 0 ? (Number(String(row[cUnit]).replace(/[^0-9.-]/g, '')) || 0) : (qty ? Math.round(amount / qty) : 0);
        const vendor = cVen >= 0 ? String(row[cVen] || '').trim() : '';
        const cat = (cCat >= 0 && String(row[cCat] || '').trim()) ? String(row[cCat]).trim() : guessCategory(name);
        if (!amount && !qty) continue;
        items.push({ name, qty, unit, amount, vendor, cat });
      }
      cb(null, items);
    });
  };
  CH.parseStatement = function (file) {
    if (!file) return;
    CH.parseWorkbook(file, function (err, items) {
      if (err) { alert('파싱 오류: ' + err.message); return; }
      CH.state.parsed = { fileName: file.name, items };
      CH.renderParseResult();
    });
  };
  CH.parseStock = function (file) {
    if (!file) return;
    CH.parseWorkbook(file, function (err, items) {
      if (err) { alert('입재고 파싱 오류: ' + err.message); return; }
      CH.state.stockParsed = { fileName: file.name, items };
      CH.renderParseResult();
    });
  };
  CH.renderParseResult = function () {
    const box = document.getElementById('chParseResult'); if (!box) return;
    const P = CH.state.parsed;
    if (!P) { box.innerHTML = ''; return; }
    // 카테고리별 합계
    const byCat = {}; CH.CATEGORIES.forEach(c => byCat[c] = 0);
    P.items.forEach(it => { byCat[it.cat] = (byCat[it.cat] || 0) + it.amount; });
    const total = P.items.reduce((a, it) => a + it.amount, 0);
    const catRows = Object.keys(byCat).filter(c => byCat[c]).map(c =>
      '<tr><td style="padding:5px 10px;border-bottom:0.5px solid var(--crd)">' + esc(c) + '</td>'
      + '<td style="padding:5px 10px;border-bottom:0.5px solid var(--crd);text-align:right;font-weight:700">' + won(byCat[c]) + '</td>'
      + '<td style="padding:5px 10px;border-bottom:0.5px solid var(--crd);text-align:right;color:var(--th)">' + (total ? (byCat[c] / total * 100).toFixed(1) : 0) + '%</td></tr>').join('');
    // 입재고 대조
    let checkHtml = '';
    if (CH.state.stockParsed) checkHtml = CH.buildStockCheck();
    box.innerHTML =
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">'
      +   '<span style="font-size:13px;font-weight:700"><i class="ti ti-file-check"></i> ' + esc(P.fileName) + '</span>'
      +   '<span style="font-size:12px;color:var(--th)">품목 ' + P.items.length + '건 · 합계 ' + won(total) + '원</span>'
      +   '<span style="margin-left:auto;display:flex;gap:6px">'
      +     '<button class="btn-cancel-sm" style="font-size:12px" onclick="ClosingHelper.exportCsv()"><i class="ti ti-download"></i> CSV 내보내기</button>'
      +     '<button class="btn-submit" style="font-size:12px" onclick="ClosingHelper.openApplyToOrders()"><i class="ti ti-arrow-bar-to-right"></i> 발주 비중에 반영</button>'
      +   '</span>'
      + '</div>'
      + '<div style="display:grid;grid-template-columns:320px 1fr;gap:14px;align-items:start">'
      +   '<table style="width:100%;border-collapse:collapse;background:#fff;border:0.5px solid var(--crd);border-radius:8px;overflow:hidden;font-size:13px">'
      +     '<thead><tr style="background:var(--cr,#faf7f2)"><th style="padding:6px 10px;text-align:left">카테고리</th><th style="padding:6px 10px;text-align:right">금액</th><th style="padding:6px 10px;text-align:right">비중</th></tr></thead>'
      +     '<tbody>' + catRows + '<tr style="background:#FEF9F0"><td style="padding:6px 10px;font-weight:800">합계</td><td style="padding:6px 10px;text-align:right;font-weight:800">' + won(total) + '</td><td style="padding:6px 10px;text-align:right">100%</td></tr></tbody>'
      +   '</table>'
      +   '<div>' + CH.itemsTableHtml(P.items) + '</div>'
      + '</div>'
      + checkHtml;
  };
  CH.itemsTableHtml = function (items) {
    const rows = items.slice(0, 400).map(it =>
      '<tr><td style="padding:4px 8px;border-bottom:0.5px solid var(--crm,#eee)">' + esc(it.name) + '</td>'
      + '<td style="padding:4px 8px;border-bottom:0.5px solid var(--crm,#eee);text-align:center;color:var(--th)">' + esc(it.cat) + '</td>'
      + '<td style="padding:4px 8px;border-bottom:0.5px solid var(--crm,#eee);text-align:right">' + (it.qty || '') + '</td>'
      + '<td style="padding:4px 8px;border-bottom:0.5px solid var(--crm,#eee);text-align:right">' + (it.unit ? won(it.unit) : '') + '</td>'
      + '<td style="padding:4px 8px;border-bottom:0.5px solid var(--crm,#eee);text-align:right;font-weight:600">' + won(it.amount) + '</td></tr>').join('');
    return '<div style="max-height:360px;overflow:auto;border:0.5px solid var(--crd);border-radius:8px;background:#fff">'
      + '<table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr style="background:var(--cr,#faf7f2);position:sticky;top:0">'
      + '<th style="padding:6px 8px;text-align:left">품목</th><th style="padding:6px 8px">분류</th><th style="padding:6px 8px;text-align:right">수량</th><th style="padding:6px 8px;text-align:right">단가</th><th style="padding:6px 8px;text-align:right">금액</th></tr></thead>'
      + '<tbody>' + rows + '</tbody></table></div>';
  };
  CH.buildStockCheck = function () {
    const stmt = CH.state.parsed.items, stock = CH.state.stockParsed.items;
    const sMap = {}; stock.forEach(it => { sMap[it.name] = (sMap[it.name] || 0) + it.amount; });
    const diffs = [];
    stmt.forEach(it => { const sv = sMap[it.name]; if (sv == null) diffs.push({ name: it.name, a: it.amount, b: null, type: '입재고 누락' }); else if (Math.abs(sv - it.amount) > 0.5) diffs.push({ name: it.name, a: it.amount, b: sv, type: '금액 불일치' }); });
    const stmtNames = new Set(stmt.map(it => it.name));
    stock.forEach(it => { if (!stmtNames.has(it.name)) diffs.push({ name: it.name, a: null, b: it.amount, type: '명세서 누락' }); });
    const rows = diffs.map(d => '<tr><td style="padding:4px 8px;border-bottom:0.5px solid var(--crm,#eee)">' + esc(d.name) + '</td>'
      + '<td style="padding:4px 8px;border-bottom:0.5px solid var(--crm,#eee);text-align:right">' + (d.a == null ? '-' : won(d.a)) + '</td>'
      + '<td style="padding:4px 8px;border-bottom:0.5px solid var(--crm,#eee);text-align:right">' + (d.b == null ? '-' : won(d.b)) + '</td>'
      + '<td style="padding:4px 8px;border-bottom:0.5px solid var(--crm,#eee);text-align:center"><span style="background:#FEE2E2;color:#B91C1C;border-radius:5px;padding:0 6px;font-size:11px">' + esc(d.type) + '</span></td></tr>').join('');
    return '<div style="margin-top:16px"><div style="font-size:13px;font-weight:700;margin-bottom:6px"><i class="ti ti-clipboard-data"></i> 입재고 대조 — ' + (diffs.length ? '불일치 ' + diffs.length + '건' : '전부 일치 ✓') + '</div>'
      + (diffs.length ? '<div style="max-height:260px;overflow:auto;border:0.5px solid var(--crd);border-radius:8px;background:#fff"><table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr style="background:var(--cr,#faf7f2)"><th style="padding:6px 8px;text-align:left">품목</th><th style="padding:6px 8px;text-align:right">명세서</th><th style="padding:6px 8px;text-align:right">입재고</th><th style="padding:6px 8px">검수</th></tr></thead><tbody>' + rows + '</tbody></table></div>'
          : '<div style="font-size:13px;color:#15803D;background:#DCFCE7;border-radius:8px;padding:10px">명세서와 입재고가 모두 일치합니다.</div>') + '</div>';
  };
  CH.exportCsv = function () {
    const P = CH.state.parsed; if (!P) return;
    const head = ['품목', '분류', '수량', '단가', '금액', '거래처'];
    const lines = [head.join(',')].concat(P.items.map(it => [it.name, it.cat, it.qty, it.unit, it.amount, it.vendor].map(v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"').join(',')));
    const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob); const a = document.createElement('a');
    a.href = url; a.download = (P.fileName || '거래명세서').replace(/\.[^.]+$/, '') + '_검수.csv'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  };

  // [핵심] 거래명세서 산출 결과 → 탭2 발주금액 자동 채움
  CH.openApplyToOrders = async function () {
    const P = CH.state.parsed; if (!P) return;
    await CH.loadStores();
    const byCat = {}; P.items.forEach(it => { byCat[it.cat] = (byCat[it.cat] || 0) + it.amount; });
    const stores = window.__chStores || [];
    const storeOpts = stores.map(s => '<option value="' + esc(s) + '"' + (s === CH.state.store ? ' selected' : '') + '>' + esc(s) + '</option>').join('');
    const catLines = Object.keys(byCat).filter(c => byCat[c]).map(c => '<div style="display:flex;justify-content:space-between;font-size:13px;padding:3px 0"><span>' + esc(c) + '</span><b>' + won(byCat[c]) + '</b></div>').join('');
    CH.modal('발주 비중에 반영',
      '<div style="font-size:12px;color:var(--th);margin-bottom:10px">아래 산출 결과를 선택한 매장/연월의 카테고리별 발주금액으로 저장합니다. (기존 값은 덮어씀)</div>'
      + '<div style="display:flex;gap:8px;margin-bottom:10px">'
      +   '<select id="chApStore" class="form-input" style="flex:1"><option value="">매장 선택</option>' + storeOpts + '</select>'
      +   '<input type="month" id="chApYm" class="form-input" value="' + CH.state.ym + '" style="width:150px">'
      + '</div>'
      + '<div style="border:0.5px solid var(--crd);border-radius:8px;padding:10px;background:var(--cr,#faf7f2)">' + catLines + '</div>',
      '저장', async function () {
        const store = document.getElementById('chApStore').value; const ym = document.getElementById('chApYm').value;
        if (!store || !ym) { alert('매장과 연월을 선택하세요.'); return false; }
        let n = 0;
        for (const c of Object.keys(byCat)) {
          if (!byCat[c]) continue;
          const { error } = await sbc().from('closing_orders').upsert({ store, ym, category: c, vendor: '(명세서합계)', amount: byCat[c], is_corp_card: (c === '법인카드'), updated_by: window.currentUser.id, updated_at: new Date().toISOString() }, { onConflict: 'store,ym,category,vendor,is_corp_card' });
          if (!error) n++;
        }
        toast(store + ' ' + ym + ' 발주금액 ' + n + '건 반영 완료'); CH.state.store = store; CH.state.ym = ym;
        return true;
      });
  };

  /* ======================================================================
   * [탭 2] 발주 비중 & 원가 대시보드
   * ==================================================================== */
  CH.loadStores = async function () {
    if (window.__chStores) return window.__chStores;
    try { const { data } = await sbc().from('users').select('store').eq('active', true);
      const set = Array.from(new Set((data || []).map(r => r.store).filter(Boolean))).sort();
      window.__chStores = set; } catch (e) { window.__chStores = []; }
    return window.__chStores;
  };
  CH.renderTab2 = async function () {
    const b = document.getElementById('chTabBody'); if (!b) return;
    b.innerHTML = '<div style="padding:30px;text-align:center;color:var(--th)">불러오는 중…</div>';
    await CH.loadStores();
    const stores = window.__chStores || [];
    const ym = CH.state.ym;
    let orders = [], sales = [];
    try { const o = await sbc().from('closing_orders').select('*').eq('ym', ym); orders = o.data || []; } catch (e) {}
    try { const s = await sbc().from('closing_sales').select('*').eq('ym', ym); sales = s.data || []; } catch (e) {}
    const salesMap = {}; sales.forEach(r => salesMap[r.store] = r.net_sales);
    // 전 매장 요약표
    const sumRows = stores.map(st => {
      const os = orders.filter(o => o.store === st);
      const tot = os.reduce((a, o) => a + Number(o.amount || 0), 0);
      const ns = Number(salesMap[st] || 0);
      const ratio = ns > 0 ? (tot / ns * 100).toFixed(1) + '%' : '-';
      return '<tr><td style="padding:5px 10px;border-bottom:0.5px solid var(--crd);font-weight:600">' + esc(st) + '</td>'
        + '<td style="padding:5px 10px;border-bottom:0.5px solid var(--crd);text-align:right">' + won(ns) + '</td>'
        + '<td style="padding:5px 10px;border-bottom:0.5px solid var(--crd);text-align:right">' + won(tot) + '</td>'
        + '<td style="padding:5px 10px;border-bottom:0.5px solid var(--crd);text-align:right;font-weight:700;color:' + (ns > 0 && tot / ns > 0.4 ? '#B91C1C' : 'var(--tm)') + '">' + ratio + '</td>'
        + '<td style="padding:5px 10px;border-bottom:0.5px solid var(--crd);text-align:center"><button class="btn-cancel-sm" style="font-size:11px" onclick="ClosingHelper.openStoreInput(\'' + esc(st).replace(/'/g, "\\'") + '\')">입력/수정</button></td></tr>';
    }).join('');
    const storeOpts = stores.map(s => '<option value="' + esc(s) + '"' + (s === CH.state.store ? ' selected' : '') + '>' + esc(s) + '</option>').join('');
    b.innerHTML =
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">'
      +   '<input type="month" id="chT2Ym" class="form-input" value="' + ym + '" style="width:150px" onchange="ClosingHelper.state.ym=this.value;ClosingHelper.renderTab2()">'
      +   '<select id="chT2Store" class="form-input" style="width:170px" onchange="ClosingHelper.state.store=this.value;ClosingHelper.drawCharts()"><option value="">매장(차트) 선택</option>' + storeOpts + '</select>'
      +   '<button class="btn-cancel-sm" style="font-size:12px;margin-left:auto" onclick="ClosingHelper.openStoreInput(ClosingHelper.state.store)"><i class="ti ti-plus"></i> 발주/매출 입력</button>'
      + '</div>'
      + '<div style="display:grid;grid-template-columns:1fr 360px;gap:16px;align-items:start">'
      +   '<div><div style="font-size:13px;font-weight:700;margin-bottom:6px"><i class="ti ti-building-store"></i> ' + ym + ' 전 매장 요약</div>'
      +     '<table style="width:100%;border-collapse:collapse;background:#fff;border:0.5px solid var(--crd);border-radius:8px;overflow:hidden;font-size:13px">'
      +     '<thead><tr style="background:var(--cr,#faf7f2)"><th style="padding:6px 10px;text-align:left">매장</th><th style="padding:6px 10px;text-align:right">순매출</th><th style="padding:6px 10px;text-align:right">발주합계</th><th style="padding:6px 10px;text-align:right">발주비중</th><th style="padding:6px 10px"></th></tr></thead>'
      +     '<tbody>' + (sumRows || '<tr><td colspan="5" style="padding:14px;text-align:center;color:var(--th)">매장 데이터가 없습니다</td></tr>') + '</tbody></table></div>'
      +   '<div><div style="font-size:13px;font-weight:700;margin-bottom:6px"><i class="ti ti-chart-donut"></i> 카테고리 비중 <span style="font-size:11px;color:var(--th);font-weight:500">(매장 선택)</span></div>'
      +     '<div style="background:#fff;border:0.5px solid var(--crd);border-radius:8px;padding:12px"><canvas id="chDonut" height="200"></canvas></div>'
      +     '<div style="font-size:13px;font-weight:700;margin:14px 0 6px"><i class="ti ti-chart-line"></i> 3개월 추이</div>'
      +     '<div style="background:#fff;border:0.5px solid var(--crd);border-radius:8px;padding:12px"><canvas id="chTrend" height="180"></canvas></div>'
      +     '<div id="chDrill" style="margin-top:12px"></div>'
      +   '</div>'
      + '</div>';
    CH._orders = orders;
    CH.drawCharts();
  };
  CH.drawCharts = async function () {
    const st = CH.state.store; if (!st || typeof Chart === 'undefined') return;
    const ym = CH.state.ym;
    const os = (CH._orders || []).filter(o => o.store === st);
    const byCat = {}; os.forEach(o => { byCat[o.category] = (byCat[o.category] || 0) + Number(o.amount || 0); });
    const labels = Object.keys(byCat), vals = labels.map(l => byCat[l]);
    const palette = ['#8a5a2b', '#C8964B', '#E0B36A', '#6B8E5A', '#4A6FA5', '#B0574C', '#9A8478'];
    try { if (CH._donut) CH._donut.destroy(); const c1 = document.getElementById('chDonut');
      if (c1) CH._donut = new Chart(c1, { type: 'doughnut', data: { labels, datasets: [{ data: vals, backgroundColor: palette }] }, options: { plugins: { legend: { position: 'bottom', labels: { font: { size: 11 } } } } } }); } catch (e) {}
    // 3개월 추이
    const months = []; const d = new Date(ym + '-01');
    for (let i = 2; i >= 0; i--) { const dd = new Date(d.getFullYear(), d.getMonth() - i, 1); months.push(dd.toISOString().slice(0, 7)); }
    let tseries = [];
    try { const { data } = await sbc().from('closing_orders').select('ym,amount').eq('store', st).in('ym', months);
      const m = {}; months.forEach(x => m[x] = 0); (data || []).forEach(r => { m[r.ym] = (m[r.ym] || 0) + Number(r.amount || 0); }); tseries = months.map(x => m[x]); } catch (e) { tseries = months.map(() => 0); }
    try { if (CH._trend) CH._trend.destroy(); const c2 = document.getElementById('chTrend');
      if (c2) CH._trend = new Chart(c2, { type: 'line', data: { labels: months, datasets: [{ label: '발주합계', data: tseries, borderColor: '#8a5a2b', backgroundColor: 'rgba(138,90,43,.12)', fill: true, tension: .3 }] }, options: { plugins: { legend: { display: false } }, scales: { y: { ticks: { callback: v => (v / 10000) + '만' } } } } }); } catch (e) {}
    // 업체별 드릴다운
    const byVen = {}; os.forEach(o => { byVen[o.vendor || '(미지정)'] = (byVen[o.vendor || '(미지정)'] || 0) + Number(o.amount || 0); });
    const vrows = Object.keys(byVen).sort((a, b) => byVen[b] - byVen[a]).map(v => '<div style="display:flex;justify-content:space-between;font-size:12px;padding:3px 0;border-bottom:0.5px solid var(--crm,#eee)"><span>' + esc(v) + '</span><b>' + won(byVen[v]) + '</b></div>').join('');
    const dd = document.getElementById('chDrill'); if (dd) dd.innerHTML = vrows ? '<div style="font-size:12px;font-weight:700;margin-bottom:4px">업체별 발주 (' + esc(st) + ')</div>' + vrows : '';
  };
  CH.openStoreInput = async function (store) {
    await CH.loadStores();
    const ym = CH.state.ym; store = store || CH.state.store || '';
    let orders = [], sale = 0;
    if (store) { try { const { data } = await sbc().from('closing_orders').select('*').eq('store', store).eq('ym', ym); orders = data || []; } catch (e) {}
      try { const { data } = await sbc().from('closing_sales').select('net_sales').eq('store', store).eq('ym', ym).maybeSingle(); sale = (data && data.net_sales) || 0; } catch (e) {} }
    const stores = window.__chStores || [];
    const storeOpts = stores.map(s => '<option value="' + esc(s) + '"' + (s === store ? ' selected' : '') + '>' + esc(s) + '</option>').join('');
    const rowHtml = (o) => '<tr>'
      + '<td style="padding:3px"><select class="ch-or-cat form-input" style="font-size:12px;padding:4px">' + CH.CATEGORIES.map(c => '<option' + (o && o.category === c ? ' selected' : '') + '>' + c + '</option>').join('') + '</select></td>'
      + '<td style="padding:3px"><input class="ch-or-ven form-input" style="font-size:12px;padding:4px" value="' + esc(o ? (o.vendor || '') : '') + '" placeholder="업체"></td>'
      + '<td style="padding:3px"><input class="ch-or-amt form-input" type="number" style="font-size:12px;padding:4px;text-align:right" value="' + (o ? (o.amount || '') : '') + '" placeholder="금액"></td>'
      + '<td style="padding:3px;text-align:center"><input class="ch-or-card" type="checkbox"' + (o && o.is_corp_card ? ' checked' : '') + '></td>'
      + '<td style="padding:3px;text-align:center"><button onclick="this.closest(\'tr\').remove()" style="background:none;border:none;color:#B91C1C;cursor:pointer">✕</button></td></tr>';
    const bodyRows = (orders.length ? orders : [null, null, null]).map(rowHtml).join('');
    CH.modal(ym + ' 발주/매출 입력',
      '<div style="display:flex;gap:8px;margin-bottom:10px">'
      +   '<select id="chInStore" class="form-input" style="flex:1"><option value="">매장 선택</option>' + storeOpts + '</select>'
      +   '<input id="chInSales" class="form-input" type="number" style="width:170px" placeholder="순매출" value="' + (sale || '') + '">'
      + '</div>'
      + '<table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr style="background:var(--cr,#faf7f2)"><th style="padding:4px">카테고리</th><th style="padding:4px">업체</th><th style="padding:4px">금액</th><th style="padding:4px">법인카드</th><th></th></tr></thead><tbody id="chInRows">' + bodyRows + '</tbody></table>'
      + '<button class="btn-cancel-sm" style="font-size:12px;margin-top:6px" onclick="var tb=document.getElementById(\'chInRows\');tb.insertAdjacentHTML(\'beforeend\', ClosingHelper._orRow())"><i class="ti ti-plus"></i> 행 추가</button>',
      '저장', async function () {
        const st = document.getElementById('chInStore').value; if (!st) { alert('매장을 선택하세요'); return false; }
        const ns = Number(document.getElementById('chInSales').value || 0);
        // 매출 upsert
        await sbc().from('closing_sales').upsert({ store: st, ym, net_sales: ns, updated_at: new Date().toISOString() }, { onConflict: 'store,ym' });
        // 기존 매장/연월 발주 삭제 후 재삽입
        await sbc().from('closing_orders').delete().eq('store', st).eq('ym', ym);
        const trs = Array.from(document.querySelectorAll('#chInRows tr'));
        const rows = [];
        trs.forEach(tr => {
          const cat = tr.querySelector('.ch-or-cat').value; const ven = tr.querySelector('.ch-or-ven').value.trim();
          const amt = Number(tr.querySelector('.ch-or-amt').value || 0); const card = tr.querySelector('.ch-or-card').checked;
          if (amt) rows.push({ store: st, ym, category: cat, vendor: ven || '(미지정)', amount: amt, is_corp_card: card, updated_by: window.currentUser.id, updated_at: new Date().toISOString() });
        });
        if (rows.length) { const { error } = await sbc().from('closing_orders').insert(rows); if (error) { alert('저장 오류: ' + error.message); return false; } }
        toast(st + ' ' + ym + ' 저장 완료 (' + rows.length + '건)'); CH.state.store = st; CH.renderTab2(); return true;
      });
  };
  CH._orRow = function () { return '<tr>'
    + '<td style="padding:3px"><select class="ch-or-cat form-input" style="font-size:12px;padding:4px">' + CH.CATEGORIES.map(c => '<option>' + c + '</option>').join('') + '</select></td>'
    + '<td style="padding:3px"><input class="ch-or-ven form-input" style="font-size:12px;padding:4px" placeholder="업체"></td>'
    + '<td style="padding:3px"><input class="ch-or-amt form-input" type="number" style="font-size:12px;padding:4px;text-align:right" placeholder="금액"></td>'
    + '<td style="padding:3px;text-align:center"><input class="ch-or-card" type="checkbox"></td>'
    + '<td style="padding:3px;text-align:center"><button onclick="this.closest(\'tr\').remove()" style="background:none;border:none;color:#B91C1C;cursor:pointer">✕</button></td></tr>'; };

  /* ======================================================================
   * [탭 3] 품목·단가 마스터 & 원본 보관함
   * ==================================================================== */
  CH.renderTab3 = function () {
    const b = document.getElementById('chTabBody'); if (!b) return;
    b.innerHTML =
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;align-items:start">'
      + '<div>'
      +   '<div style="font-size:13px;font-weight:700;margin-bottom:6px"><i class="ti ti-search"></i> 품목·단가 마스터</div>'
      +   '<input id="chItemSearch" class="form-input" placeholder="품목명 / 거래처 검색" oninput="ClosingHelper.searchItems(this.value)" style="margin-bottom:8px">'
      +   '<div style="margin-bottom:8px;display:flex;gap:6px"><button class="btn-cancel-sm" style="font-size:12px" onclick="ClosingHelper.searchItems(\'\',true)">미분류만</button><button class="btn-cancel-sm" style="font-size:12px" onclick="ClosingHelper.searchItems(\'\')">전체</button></div>'
      +   '<div id="chItemList" style="max-height:420px;overflow:auto;border:0.5px solid var(--crd);border-radius:8px;background:#fff"></div>'
      + '</div>'
      + '<div>'
      +   '<div style="font-size:13px;font-weight:700;margin-bottom:6px"><i class="ti ti-archive"></i> 원본 보관함 (Supabase Storage)</div>'
      +   '<div style="border:1.5px dashed var(--crd);border-radius:10px;padding:14px;text-align:center;background:var(--cr,#faf7f2);cursor:pointer;margin-bottom:10px" onclick="document.getElementById(\'chUpload\').click()">'
      +     '<i class="ti ti-upload" style="font-size:22px;color:var(--br,#8a5a2b)"></i>'
      +     '<div style="font-size:12px;font-weight:700;margin-top:4px">새 거래명세서 일괄 업로드</div>'
      +     '<div style="font-size:11px;color:var(--th)">파일명 = 거래처명 / 저장경로 YYYY-MM/거래처명.xlsx (동일파일 덮어쓰기)</div>'
      +     '<input type="file" id="chUpload" multiple accept=".xlsx,.xls" style="display:none" onchange="ClosingHelper.uploadOriginals(this.files)">'
      +   '</div>'
      +   '<div style="display:flex;gap:8px;margin-bottom:8px"><input type="month" id="chArcYm" class="form-input" value="' + CH.state.ym + '" style="width:150px" onchange="ClosingHelper.loadArchive()">'
      +     '<button class="btn-cancel-sm" style="font-size:12px" onclick="ClosingHelper.downloadZip()"><i class="ti ti-file-zip"></i> 원본 ZIP 내려받기</button>'
      +     (ADMIN() ? '<button class="btn-cancel-sm" style="font-size:12px;color:#B91C1C;border-color:#FCA5A5;margin-left:auto" onclick="ClosingHelper.cleanupOld()"><i class="ti ti-trash"></i> 1년 경과 원본 정리</button>' : '')
      +   '</div>'
      +   '<div id="chArchiveList" style="max-height:360px;overflow:auto;border:0.5px solid var(--crd);border-radius:8px;background:#fff"></div>'
      + '</div>'
      + '</div>';
    CH.searchItems('');
    CH.loadArchive();
  };
  CH.searchItems = async function (q, unclassifiedOnly) {
    const box = document.getElementById('chItemList'); if (!box) return;
    let query = sbc().from('closing_items').select('*').order('name').limit(200);
    if (q) query = query.or('name.ilike.%' + q + '%,vendor.ilike.%' + q + '%');
    if (unclassifiedOnly) query = query.eq('classified', false);
    let items = [];
    try { const { data } = await query; items = data || []; } catch (e) {}
    box.innerHTML = '<table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr style="background:var(--cr,#faf7f2);position:sticky;top:0"><th style="padding:6px 8px;text-align:left">품목</th><th style="padding:6px 8px;text-align:left">거래처</th><th style="padding:6px 8px;text-align:right">최신단가</th><th style="padding:6px 8px;text-align:center">변동</th><th style="padding:6px 8px">분류</th></tr></thead><tbody>'
      + (items.length ? items.map(CH.itemRow).join('') : '<tr><td colspan="5" style="padding:14px;text-align:center;color:var(--th)">데이터 없음</td></tr>') + '</tbody></table>';
  };
  CH.itemRow = function (it) {
    const prev = Number(it.prev_price || 0), cur = Number(it.unit_price || 0);
    let delta = '';
    if (prev && cur > prev) delta = '<span style="color:#B91C1C">▲ ' + won(cur - prev) + '</span>';
    else if (prev && cur < prev) delta = '<span style="color:#1E40AF">▼ ' + won(prev - cur) + '</span>';
    else if (prev) delta = '<span style="color:var(--th)">-</span>';
    return '<tr><td style="padding:4px 8px;border-bottom:0.5px solid var(--crm,#eee)">' + esc(it.name) + (prev ? '<div style="font-size:10px;color:var(--th)">이전 ' + won(prev) + '</div>' : '') + '</td>'
      + '<td style="padding:4px 8px;border-bottom:0.5px solid var(--crm,#eee)">' + esc(it.vendor || '') + '</td>'
      + '<td style="padding:4px 8px;border-bottom:0.5px solid var(--crm,#eee);text-align:right;font-weight:600">' + won(cur) + '</td>'
      + '<td style="padding:4px 8px;border-bottom:0.5px solid var(--crm,#eee);text-align:center">' + delta + '</td>'
      + '<td style="padding:4px 8px;border-bottom:0.5px solid var(--crm,#eee);text-align:center"><select onchange="ClosingHelper.setItemCat(' + it.id + ',this.value)" style="font-size:11px">' + ['미분류'].concat(CH.CATEGORIES.filter(c => c !== '미분류')).map(c => '<option' + (it.category === c ? ' selected' : '') + '>' + c + '</option>').join('') + '</select></td></tr>';
  };
  CH.setItemCat = async function (id, cat) {
    try { await sbc().from('closing_items').update({ category: cat, classified: cat !== '미분류', updated_at: new Date().toISOString() }).eq('id', id); toast('분류 저장'); } catch (e) { alert('오류: ' + e.message); }
  };

  // 원본 업로드 → Storage (경로 YYYY-MM/거래처명.xlsx, 덮어쓰기) + 메타 기록
  CH.uploadOriginals = async function (files) {
    if (!files || !files.length) return;
    const ym = document.getElementById('chArcYm') ? document.getElementById('chArcYm').value : CH.state.ym;
    let ok = 0;
    for (const f of files) {
      const vendor = f.name.replace(/\.[^.]+$/, '');
      const path = ym + '/' + f.name;
      try {
        const up = await sbc().storage.from(STORAGE_BUCKET).upload(path, f, { upsert: true, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
        if (up.error) { console.warn(up.error); continue; }
        await sbc().from('closing_statements').upsert({ ym, vendor, file_path: path, size_bytes: f.size, uploaded_by: window.currentUser.id, uploaded_at: new Date().toISOString() }, { onConflict: 'ym,vendor' });
        // 품목 단가 마스터 갱신(선택적): 파싱해서 upsert
        try { CH.parseWorkbook(f, async function (err, items) { if (err) return; for (const it of items.slice(0, 500)) { if (!it.unit) continue;
          const { data: ex } = await sbc().from('closing_items').select('id,unit_price').eq('name', it.name).eq('vendor', vendor).maybeSingle();
          if (ex) { if (Number(ex.unit_price) !== it.unit) await sbc().from('closing_items').update({ prev_price: ex.unit_price, unit_price: it.unit, price_date: ym + '-01', updated_at: new Date().toISOString() }).eq('id', ex.id); }
          else await sbc().from('closing_items').insert({ name: it.name, vendor, category: it.cat, unit: it.spec || '', unit_price: it.unit, prev_price: null, price_date: ym + '-01', classified: it.cat !== '미분류', updated_at: new Date().toISOString() }); } }); } catch (e) {}
        ok++;
      } catch (e) { console.warn(e); }
    }
    toast('원본 ' + ok + '건 업로드 완료'); CH.loadArchive(); CH.searchItems('');
  };
  CH.loadArchive = async function () {
    const box = document.getElementById('chArchiveList'); if (!box) return;
    const ym = document.getElementById('chArcYm') ? document.getElementById('chArcYm').value : CH.state.ym;
    let metas = [];
    try { const { data } = await sbc().from('closing_statements').select('*').eq('ym', ym).order('vendor'); metas = data || []; } catch (e) {}
    box.innerHTML = metas.length ? metas.map(m => '<div style="display:flex;align-items:center;gap:8px;padding:7px 10px;border-bottom:0.5px solid var(--crm,#eee)">'
      + '<i class="ti ti-file-type-xls" style="color:#15803D"></i><span style="font-size:13px;font-weight:600">' + esc(m.vendor) + '</span>'
      + '<span style="font-size:11px;color:var(--th)">' + ((m.size_bytes / 1024) | 0) + 'KB</span>'
      + '<span style="margin-left:auto;font-size:11px;color:var(--th)">' + (m.uploaded_at ? String(m.uploaded_at).slice(0, 10) : '') + '</span></div>').join('')
      : '<div style="padding:14px;text-align:center;color:var(--th);font-size:12px">' + ym + ' 보관된 원본이 없습니다</div>';
  };
  CH.downloadZip = async function () {
    const pw = prompt('원본 ZIP 내려받기 — 본사 비밀번호를 입력하세요.');
    if (!pw) return;
    try { const { data, error } = await sbc().rpc('verify_password', { p_user_id: window.currentUser.id, p_password: pw });
      if (error || !data) { alert('비밀번호가 일치하지 않습니다.'); return; } } catch (e) { alert('인증 오류: ' + e.message); return; }
    const ym = document.getElementById('chArcYm') ? document.getElementById('chArcYm').value : CH.state.ym;
    let metas = [];
    try { const { data } = await sbc().from('closing_statements').select('*').eq('ym', ym); metas = data || []; } catch (e) {}
    if (!metas.length) { alert('해당 월 원본이 없습니다.'); return; }
    if (typeof JSZip === 'undefined') { alert('JSZip 로드 실패'); return; }
    toast('원본 ' + metas.length + '건 압축 중…');
    const zip = new JSZip();
    for (const m of metas) {
      try { const { data, error } = await sbc().storage.from(STORAGE_BUCKET).download(m.file_path); if (error || !data) continue; zip.file(m.vendor + '.xlsx', data); } catch (e) {}
    }
    const blob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = '거래명세서원본_' + ym + '.zip'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };
  CH.cleanupOld = async function () {
    if (!ADMIN()) return;
    if (!confirm('1년 이상 지난 보관 원본을 Storage에서 삭제합니다. 계속할까요? (복구 불가)')) return;
    const cutoff = new Date(); cutoff.setFullYear(cutoff.getFullYear() - 1);
    const cutYm = cutoff.toISOString().slice(0, 7);
    let metas = [];
    try { const { data } = await sbc().from('closing_statements').select('*').lt('ym', cutYm); metas = data || []; } catch (e) {}
    if (!metas.length) { alert('정리할 1년 경과 원본이 없습니다.'); return; }
    let n = 0;
    for (const m of metas) { try { await sbc().storage.from(STORAGE_BUCKET).remove([m.file_path]); await sbc().from('closing_statements').delete().eq('id', m.id); n++; } catch (e) {} }
    toast(n + '건 정리 완료'); CH.loadArchive();
  };

  /* ───────────────────────── 권한 설정 모달 (총괄) ──────────────────────── */
  CH.openSettings = async function () {
    if (!ADMIN()) return;
    await CH.loadFlags();
    let users = [];
    try { const { data } = await sbc().from('users').select('id,name,store,part,role').eq('active', true).order('name'); users = data || []; } catch (e) {}
    const parts = Array.from(new Set(users.map(u => u.part).filter(Boolean))).sort();
    const partChk = parts.map(p => '<label style="display:inline-flex;align-items:center;gap:4px;font-size:12px;margin:2px 8px 2px 0"><input type="checkbox" class="ch-part" value="' + esc(p) + '"' + (window.__closingParts.includes(p) ? ' checked' : '') + '> ' + esc(p) + '</label>').join('');
    const userOpts = users.map(u => '<option value="' + u.id + '"' + (window.__closingUsers.includes(String(u.id)) ? ' selected' : '') + '>' + esc(u.name) + ' (' + esc(u.store || u.part || '') + ')</option>').join('');
    CH.modal('월말 정산 도우미 — 권한 설정',
      '<label style="display:flex;align-items:center;gap:8px;font-size:13px;margin-bottom:12px"><input type="checkbox" id="chVisible"' + (window.__closingVisible ? ' checked' : '') + '> <b>메뉴 전체 공개</b> <span style="color:var(--th)">(해제 시 총괄에게만 [개발중]으로 노출)</span></label>'
      + '<div style="font-size:12px;font-weight:700;margin-bottom:4px">허용 부서담당 파트</div><div style="margin-bottom:12px">' + (partChk || '<span style="font-size:12px;color:var(--th)">파트 없음</span>') + '</div>'
      + '<div style="font-size:12px;font-weight:700;margin-bottom:4px">예외 허용자 (개별 지정)</div>'
      + '<select id="chUsers" multiple size="8" style="width:100%;font-size:12px;border:0.5px solid var(--crd);border-radius:6px;padding:4px">' + userOpts + '</select>'
      + '<div style="font-size:11px;color:var(--th);margin-top:4px">Ctrl/⌘ 로 복수 선택. 매니저·매니저B·총괄은 항상 접근 가능합니다.</div>',
      '저장', async function () {
        const visible = document.getElementById('chVisible').checked;
        const selParts = Array.from(document.querySelectorAll('.ch-part:checked')).map(x => x.value);
        const selUsers = Array.from(document.getElementById('chUsers').selectedOptions).map(o => o.value);
        try {
          await sbc().from('app_settings').upsert({ key: 'closing_menu_visible', value: visible ? 'true' : 'false' }, { onConflict: 'key' });
          await sbc().from('app_settings').upsert({ key: 'closing_allowed_parts', value: JSON.stringify(selParts) }, { onConflict: 'key' });
          await sbc().from('app_settings').upsert({ key: 'closing_allowed_users', value: JSON.stringify(selUsers) }, { onConflict: 'key' });
        } catch (e) { alert('저장 오류: ' + e.message); return false; }
        await CH.loadFlags(); toast('권한 설정 저장 완료'); return true;
      });
  };

  /* ───────────────────────── 공용 모달 ─────────────────────────────────── */
  CH.modal = function (title, bodyHtml, okLabel, onOk) {
    const old = document.getElementById('chModal'); if (old) old.remove();
    const m = document.createElement('div'); m.id = 'chModal'; m.className = 'modal-bg open';
    m.innerHTML = '<div class="modal-box" style="max-width:560px;width:94%">'
      + '<div class="modal-title">' + esc(title) + '</div>'
      + '<div style="max-height:62vh;overflow:auto;padding:2px 2px 10px">' + bodyHtml + '</div>'
      + '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px">'
      +   '<button class="btn-cancel-sm" onclick="document.getElementById(\'chModal\').remove()">취소</button>'
      +   '<button class="btn-submit" id="chModalOk">' + esc(okLabel || '확인') + '</button>'
      + '</div></div>';
    document.body.appendChild(m);
    document.getElementById('chModalOk').onclick = async function () {
      this.disabled = true;
      let close = true;
      try { if (onOk) close = (await onOk()) !== false; } catch (e) { alert('오류: ' + (e.message || e)); close = false; }
      this.disabled = false;
      if (close) { const mm = document.getElementById('chModal'); if (mm) mm.remove(); }
    };
  };

  // 초기 플래그 로드 (로그인 후 사이드바 토글용) — index.html 에서도 호출
  if (window.currentUser) CH.loadFlags();
})();
