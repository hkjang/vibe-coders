package proxy

const adminHTML = `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AI 코딩 프록시 게이트웨이</title>
  <style>
    :root[data-theme="light"], :root {
      color-scheme: light;
      --bg: #f6f7f9;
      --panel: #ffffff;
      --panel-alt: #fbfcfe;
      --ink: #18202a;
      --muted: #667085;
      --line: #d9dee7;
      --line-strong: #c4cad6;
      --accent: #0f766e;
      --accent-2: #7c3aed;
      --warn: #b45309;
      --bad: #b42318;
      --good-bg: #ccfbf1;
      --good-ink: #064e3b;
      --warn-bg: #fef3c7;
      --bad-bg: #fee4e2;
      --row-hover: #f0f4f8;
      --pill-bg: #eef2f7;
    }
    :root[data-theme="dark"] {
      color-scheme: dark;
      --bg: #0b1220;
      --panel: #131c2e;
      --panel-alt: #18233a;
      --ink: #e6ecf5;
      --muted: #94a3b8;
      --line: #243049;
      --line-strong: #324363;
      --accent: #2dd4bf;
      --accent-2: #c4b5fd;
      --warn: #facc15;
      --bad: #f87171;
      --good-bg: #064e3b;
      --good-ink: #6ee7b7;
      --warn-bg: #422006;
      --bad-bg: #450a0a;
      --row-hover: #1c2942;
      --pill-bg: #1b2740;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--ink);
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Apple SD Gothic Neo", "Malgun Gothic", sans-serif;
      font-size: 14px;
    }
    header {
      display: flex; align-items: center; justify-content: space-between;
      gap: 16px; padding: 14px 28px;
      border-bottom: 1px solid var(--line);
      background: var(--panel);
      position: sticky; top: 0; z-index: 4;
    }
    h1 { margin: 0; font-size: 18px; font-weight: 700; }
    nav { display: flex; gap: 2px; flex-wrap: wrap; }
    nav a {
      text-decoration: none; color: var(--muted); padding: 8px 12px;
      border-radius: 6px; font-weight: 700;
    }
    nav a.active { background: var(--ink); color: var(--bg); }
    .header-tools { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    main { width: min(1440px, 100%); margin: 0 auto; padding: 18px 28px 60px; }
    section {
      margin-top: 16px; background: var(--panel);
      border: 1px solid var(--line); border-radius: 8px; overflow: hidden;
    }
    section > h2 {
      margin: 0; padding: 12px 14px;
      border-bottom: 1px solid var(--line);
      font-size: 13px; color: var(--muted); font-weight: 800;
      display: flex; justify-content: space-between; align-items: center; gap: 8px;
    }
    .toolbar { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; padding: 12px; border-bottom: 1px solid var(--line); }
    input, button, select, textarea {
      height: 34px; border: 1px solid var(--line); border-radius: 6px;
      background: var(--panel); color: var(--ink); padding: 0 10px; font: inherit;
    }
    input::placeholder, textarea::placeholder { color: var(--muted); }
    input { min-width: 140px; }
    button {
      cursor: pointer; background: var(--accent); border-color: var(--accent);
      color: #fff; font-weight: 650;
    }
    button.secondary { background: var(--panel); color: var(--ink); border-color: var(--line); }
    button.ghost { background: transparent; color: var(--ink); border-color: var(--line); }
    button.danger { background: var(--bad); border-color: var(--bad); color: #fff; }
    .kpis {
      display: grid; grid-template-columns: repeat(4, minmax(160px, 1fr));
      gap: 1px; background: var(--line);
    }
    .kpi { background: var(--panel); padding: 14px; min-height: 80px; }
    .kpi .label { color: var(--muted); font-size: 12px; font-weight: 700; }
    .kpi .value { margin-top: 8px; font-size: 22px; font-weight: 800; overflow-wrap: anywhere; }
    .grid3 { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; margin-top: 16px; }
    .grid2 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; margin-top: 16px; }
    .inline-form { display: grid; gap: 8px; padding: 12px; border-bottom: 1px solid var(--line); }
    .inline-form input, .inline-form select { width: 100%; }
    .secret-once {
      display: none; padding: 10px 12px; border-bottom: 1px solid var(--line);
      color: var(--good-ink); background: var(--good-bg);
      font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
      overflow-wrap: anywhere;
    }
    table { width: 100%; border-collapse: collapse; table-layout: fixed; }
    th, td { padding: 9px 12px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; overflow-wrap: anywhere; }
    th { color: var(--muted); font-size: 12px; font-weight: 800; background: var(--panel-alt); }
    th.sortable { cursor: pointer; user-select: none; }
    th.sortable:hover { color: var(--ink); }
    th.sortable .arrow { opacity: 0.4; margin-left: 4px; font-size: 10px; }
    th.sortable.asc .arrow, th.sortable.desc .arrow { opacity: 1; color: var(--accent); }
    tr.row-link { cursor: pointer; }
    tr.row-link:hover td { background: var(--row-hover); }
    .status {
      display: inline-flex; align-items: center; min-width: 54px;
      justify-content: center; border-radius: 999px; padding: 2px 8px;
      font-size: 12px; font-weight: 800;
      color: var(--good-ink); background: var(--good-bg);
    }
    .status.error { color: var(--bad); background: var(--bad-bg); }
    .status.warn  { color: var(--warn); background: var(--warn-bg); }
    .muted { color: var(--muted); }
    .empty, .error-line { padding: 18px; color: var(--muted); }
    .error-line { color: var(--bad); }
    .prompt { max-height: 80px; overflow: hidden; color: var(--ink); white-space: pre-wrap; }
    .pill { display: inline-block; padding: 2px 8px; border-radius: 999px; background: var(--pill-bg); color: var(--ink); font-size: 12px; }

    .modal-backdrop {
      position: fixed; inset: 0; background: rgba(15,23,42,0.55);
      display: none; align-items: flex-start; justify-content: center;
      z-index: 10; padding: 32px;
    }
    .modal-backdrop.open { display: flex; }
    .modal {
      width: min(960px, 100%); max-height: 90vh; background: var(--panel);
      border-radius: 10px; overflow: auto; border: 1px solid var(--line);
    }
    .modal header { position: sticky; top: 0; }
    .modal .body { padding: 18px; }
    .modal h3 { margin: 0 0 4px; }
    .kv { display: grid; grid-template-columns: 160px 1fr; gap: 6px 16px; }
    .kv .k { color: var(--muted); font-size: 12px; font-weight: 700; }
    .kv .v { overflow-wrap: anywhere; }
    .prompt-block {
      padding: 10px 12px; border: 1px solid var(--line); border-radius: 6px;
      background: var(--panel-alt); white-space: pre-wrap; font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
      font-size: 13px; overflow-wrap: anywhere;
    }
    .prompt-role { font-weight: 800; margin-bottom: 4px; }

    .progress {
      position: relative; background: var(--pill-bg); border-radius: 999px;
      height: 10px; overflow: hidden;
    }
    .progress > span { position: absolute; left: 0; top: 0; bottom: 0; background: var(--accent); }
    .progress > span.warn { background: var(--warn); }
    .progress > span.danger { background: var(--bad); }

    kbd {
      display: inline-block; padding: 1px 6px; border: 1px solid var(--line-strong);
      border-bottom-width: 2px; border-radius: 4px;
      background: var(--panel-alt); font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
      font-size: 12px; color: var(--ink);
    }
    .help-grid { display: grid; grid-template-columns: max-content 1fr; gap: 8px 16px; align-items: center; }

    .ago { cursor: help; }

    @media (max-width: 960px) {
      header { flex-direction: column; align-items: flex-start; gap: 8px; }
      main { padding: 14px; }
      .kpis, .grid3, .grid2 { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <header>
    <h1>AI 코딩 프록시 게이트웨이</h1>
    <nav id="tabs">
      <a href="#/dashboard" data-tab="dashboard" class="active">대시보드</a>
      <a href="#/llm" data-tab="llm">LLM 관측</a>
      <a href="#/mcp" data-tab="mcp">MCP</a>
      <a href="#/requests" data-tab="requests">호출 이력</a>
      <a href="#/prompts" data-tab="prompts">프롬프트 검색</a>
      <a href="#/users" data-tab="users">사용자</a>
      <a href="#/teams" data-tab="teams">팀</a>
      <a href="#/ips" data-tab="ips">IP</a>
      <a href="#/quotas" data-tab="quotas">사용 한도</a>
      <a href="#/safety" data-tab="safety">안전</a>
      <a href="#/settings" data-tab="settings">설정</a>
    </nav>
    <div class="header-tools">
      <select id="refresh-interval" title="자동 새로고침 주기">
        <option value="0">자동 새로고침 끔</option>
        <option value="5">5초 마다</option>
        <option value="10">10초 마다</option>
        <option value="30">30초 마다</option>
        <option value="60">60초 마다</option>
      </select>
      <button id="theme-toggle" class="ghost" type="button" title="라이트/다크 전환 (t)">🌓</button>
      <button id="help-toggle" class="ghost" type="button" title="단축키 도움말 (?)">?</button>
      <input id="token" type="password" autocomplete="off" placeholder="관리자 토큰">
    </div>
  </header>
  <main>
    <div id="view"></div>
  </main>

  <div id="modal-backdrop" class="modal-backdrop">
    <div class="modal">
      <header>
        <h3 id="modal-title">상세</h3>
        <div style="display: flex; gap: 8px;">
          <button id="modal-analyze" type="button" class="secondary" style="display: none; background: var(--accent); color: #fff; border-color: var(--accent); height: 34px;">AI 분석</button>
          <button class="secondary" type="button" id="modal-close">닫기 (esc)</button>
        </div>
      </header>
      <div class="body" id="modal-body"></div>
    </div>
  </div>

  <script>
    // ---------- theme ----------
    function applyTheme(theme) {
      document.documentElement.setAttribute('data-theme', theme);
      sessionStorage.setItem('adminTheme', theme);
      const btn = document.getElementById('theme-toggle');
      if (btn) btn.textContent = theme === 'dark' ? '☀️' : '🌓';
    }
    applyTheme(sessionStorage.getItem('adminTheme') || 'light');
    document.getElementById('theme-toggle').addEventListener('click', () => {
      const next = (sessionStorage.getItem('adminTheme') || 'light') === 'dark' ? 'light' : 'dark';
      applyTheme(next);
    });

    // ---------- token ----------
    const tokenInput = document.getElementById('token');
    tokenInput.value = sessionStorage.getItem('adminToken') || '';
    tokenInput.addEventListener('change', () => {
      sessionStorage.setItem('adminToken', tokenInput.value);
      route();
    });

    // ---------- modal ----------
    document.getElementById('modal-close').addEventListener('click', () => closeModal());
    document.getElementById('modal-backdrop').addEventListener('click', (e) => {
      if (e.target.id === 'modal-backdrop') closeModal();
    });
    function openModal(title, html, requestId) {
      document.getElementById('modal-title').textContent = title;
      document.getElementById('modal-body').innerHTML = html;
      
      const btn = document.getElementById('modal-analyze');
      if (btn) {
        if (requestId) {
          btn.style.display = 'inline-block';
          const newBtn = btn.cloneNode(true);
          btn.parentNode.replaceChild(newBtn, btn);
          newBtn.addEventListener('click', () => runAIAnalysis(requestId));
        } else {
          btn.style.display = 'none';
        }
      }
      
      document.getElementById('modal-backdrop').classList.add('open');
    }
    function closeModal() {
      document.getElementById('modal-backdrop').classList.remove('open');
    }
    async function runAIAnalysis(id) {
      const areaId = 'ai-analysis-result';
      let area = document.getElementById(areaId);
      if (!area) {
        const body = document.getElementById('modal-body');
        body.insertAdjacentHTML('beforeend', 
          '<section id="' + areaId + '-section" style="margin-top:18px; border:1px solid var(--accent); border-radius:8px; overflow:hidden;">' +
            '<h2 style="background:var(--accent); color:#fff; margin:0; padding:12px 14px; font-size:13px; font-weight:800;">AI 분석 요약</h2>' +
            '<div class="body-pad" id="' + areaId + '" style="padding:14px; line-height:1.6; white-space:normal;">' +
              '분석 중…' +
            '</div>' +
          '</section>'
        );
        area = document.getElementById(areaId);
        document.getElementById(areaId + '-section').scrollIntoView({ behavior: 'smooth' });
      } else {
        area.innerHTML = '분석 중…';
        document.getElementById(areaId + '-section').scrollIntoView({ behavior: 'smooth' });
      }
      
      try {
        const result = await api('/admin/requests/' + encodeURIComponent(id) + '/analyze', { method: 'POST' });
        area.innerHTML = renderMarkdown(result.analysis);
      } catch (err) {
        area.innerHTML = '<div class="error-line">분석 실패: ' + escapeHTML(err.message) + '</div>';
      }
    }

    // ---------- HTTP ----------
    function headers() {
      const h = { Accept: 'application/json' };
      const token = tokenInput.value.trim();
      if (token) h.Authorization = 'Bearer ' + token;
      return h;
    }
    async function api(path, options = {}) {
      const requestHeaders = headers();
      if (options.body) requestHeaders['Content-Type'] = 'application/json';
      const res = await fetch(path, { ...options, headers: requestHeaders });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || res.statusText);
      }
      if (res.status === 204) return null;
      return res.json();
    }

    // ---------- formatting ----------
    function fmt(value) { return Number(value || 0).toLocaleString('ko-KR'); }
    function money(value) {
      const n = Number(value || 0);
      if (!isFinite(n) || n === 0) return '₩0';
      if (Math.abs(n) >= 1) return '₩' + Math.round(n).toLocaleString('ko-KR');
      return '₩' + n.toLocaleString('ko-KR', { maximumFractionDigits: 4 });
    }
    function pct(value) {
      const n = Number(value || 0);
      return Math.round(n * 100) + '%';
    }
    function escapeHTML(value) {
      return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    }
    // escapeAttr is for values placed inside a single-quoted inline handler string.
    function escapeAttr(value) {
      return String(value ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/[<>&"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
    }
    function formatTextIfJSON(text) {
      if (!text) return '';
      const trimmed = text.trim();
      if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
        try {
          const parsed = JSON.parse(trimmed);
          return JSON.stringify(parsed, null, 2);
        } catch (e) {
          // ignore
        }
      }
      return text;
    }
    function renderMarkdown(md) {
      if (!md) return '';
      let html = escapeHTML(md);
      
      const bt = String.fromCharCode(96);
      const bt3 = bt + bt + bt;
      
      // Code blocks
      const reBlock = new RegExp(bt3 + '([\\s\\S]*?)' + bt3, 'gm');
      html = html.replace(reBlock, (match, p1) => {
        return '<pre class="prompt-block" style="background:var(--panel-alt); border:1px solid var(--line); font-family:ui-monospace, SFMono-Regular, Consolas, monospace; padding:10px; margin:8px 0; overflow:auto; white-space:pre-wrap;">' + p1.trim() + '</pre>';
      });
      
      // Inline code
      const reInline = new RegExp(bt + '([^' + bt + ']+)' + bt, 'g');
      html = html.replace(reInline, '<code style="background:var(--pill-bg); padding:2px 4px; border-radius:4px; font-family:ui-monospace, SFMono-Regular, Consolas, monospace; font-size:90%;">$1</code>');
      
      // Headings
      html = html.replace(/^### (.*?)$/gm, '<h5 style="margin:12px 0 6px; font-size:14px; font-weight:700">$1</h5>');
      html = html.replace(/^## (.*?)$/gm, '<h4 style="margin:16px 0 8px; font-size:15px; font-weight:700">$1</h4>');
      html = html.replace(/^# (.*?)$/gm, '<h3 style="margin:20px 0 10px; font-size:16px; font-weight:800; border-bottom:1px solid var(--line); padding-bottom:4px;">$1</h3>');
      
      // Bold
      html = html.replace(/\*\*([^*]+)\*\*/g, '<strong style="font-weight:700">$1</strong>');
      
      // Bullet lists
      html = html.replace(/^\s*[-*]\s+(.*?)$/gm, '<li style="margin-left:16px; margin-top:4px;">$1</li>');
      
      // Line breaks
      html = html.replace(/\n/g, '<br>');
      
      return html;
    }
    function statusBadge(code) {
      const cls = (code >= 200 && code < 300) ? '' : (code === 429 ? 'warn' : 'error');
      return '<span class="status ' + cls + '">' + code + '</span>';
    }
    function sourceLabel(source) {
      if (source === 'usage') return '실측';
      if (source === 'estimated') return '추정';
      return source || '미집계';
    }
    function scopeLabel(scope) {
      return { api_key: 'API 키', team: '팀', ip: 'IP', global: '전체' }[scope] || scope;
    }
    function periodLabel(period) {
      return { daily: '일별', monthly: '월별' }[period] || period;
    }

    // ---------- relative time ----------
    function relativeTime(iso) {
      if (!iso) return '';
      const ts = Date.parse(iso);
      if (isNaN(ts)) return iso;
      const diffSec = Math.round((Date.now() - ts) / 1000);
      const abs = Math.abs(diffSec);
      const suffix = diffSec >= 0 ? ' 전' : ' 후';
      const map = [
        { sec: 60, div: 1, unit: '초' },
        { sec: 3600, div: 60, unit: '분' },
        { sec: 86400, div: 3600, unit: '시간' },
        { sec: 604800, div: 86400, unit: '일' },
        { sec: 2592000, div: 604800, unit: '주' },
        { sec: 31536000, div: 2592000, unit: '개월' },
      ];
      for (const m of map) {
        if (abs < m.sec) return Math.max(1, Math.floor(abs / m.div)) + m.unit + suffix;
      }
      return Math.floor(abs / 31536000) + '년' + suffix;
    }
    function ago(iso) {
      if (!iso) return '<span class="muted">-</span>';
      const rel = relativeTime(iso);
      const safeIso = escapeHTML(iso);
      return '<span class="ago" data-ts="' + safeIso + '" title="' + safeIso + '">' + escapeHTML(rel) + '</span>';
    }
    setInterval(() => {
      document.querySelectorAll('.ago[data-ts]').forEach(el => {
        el.textContent = relativeTime(el.dataset.ts);
      });
    }, 15000);

    // ---------- routing ----------
    function setActiveTab(name) {
      document.querySelectorAll('#tabs a').forEach(a => {
        a.classList.toggle('active', a.dataset.tab === name);
      });
    }
    function parseHash() {
      const raw = (location.hash || '#/dashboard').replace(/^#\//, '');
      const [path, query] = raw.split('?');
      const params = new URLSearchParams(query || '');
      const parts = path.split('/');
      return { path, parts, query: query || '', params };
    }
    function updateHashParams(params) {
      const { parts } = parseHash();
      const q = params.toString();
      const next = '#/' + parts.join('/') + (q ? '?' + q : '');
      if (next !== location.hash) {
        history.replaceState(null, '', next);
      }
    }
    async function route() {
      const { parts, params } = parseHash();
      const [tab, ...rest] = parts;
      setActiveTab(tab);
      try {
        switch (tab) {
          case 'dashboard': await renderDashboard(); break;
          case 'llm':       await renderLLMObservability(); break;
          case 'requests':  await renderRequestsView(params); break;
          case 'prompts':   await renderPromptsView(params); break;
          case 'users':     rest.length ? await renderUserDetail(rest.join('/')) : await renderUsers(); break;
          case 'teams':     rest.length ? await renderTeamDetail(decodeURIComponent(rest.join('/'))) : await renderTeams(); break;
          case 'ips':       rest.length ? await renderIPDetail(decodeURIComponent(rest.join('/'))) : await renderIPs(); break;
          case 'quotas':    await renderQuotas(); break;
          case 'mcp':       await renderMCP(params); break;
          case 'safety':    await renderSafety(); break;
          case 'settings':  await renderSettings(); break;
          default: await renderDashboard();
        }
      } catch (err) {
        document.getElementById('view').innerHTML = '<div class="error-line">' + escapeHTML(err.message) + '</div>';
      }
    }
    window.addEventListener('hashchange', route);

    // ---------- auto-refresh ----------
    let refreshTimer = null;
    function applyRefreshInterval(seconds) {
      sessionStorage.setItem('adminRefresh', String(seconds));
      if (refreshTimer) clearInterval(refreshTimer);
      if (seconds > 0) {
        refreshTimer = setInterval(() => { route(); }, seconds * 1000);
      }
    }
    const refreshSelect = document.getElementById('refresh-interval');
    refreshSelect.value = sessionStorage.getItem('adminRefresh') || '0';
    refreshSelect.addEventListener('change', () => {
      const v = Number(refreshSelect.value || 0);
      applyRefreshInterval(v);
    });
    applyRefreshInterval(Number(refreshSelect.value || 0));

    // ---------- sortable tables ----------
    // Use data-sort="num" on <th> for numeric columns, data-sort="str" otherwise.
    // The numeric value is read from data-num on the matching <td> if present, otherwise from textContent.
    function makeSortable(rootSel, storageKey) {
      const root = typeof rootSel === 'string' ? document.querySelector(rootSel) : rootSel;
      if (!root) return;
      root.querySelectorAll('table').forEach((table, idx) => {
        const headers = Array.from(table.querySelectorAll('thead th'));
        if (!headers.length) return;
        const key = (storageKey || 'tbl') + ':' + idx;
        const saved = JSON.parse(sessionStorage.getItem('sort:' + key) || 'null');
        headers.forEach((th, col) => {
          if (!th.dataset.sort) return;
          th.classList.add('sortable');
          if (!th.querySelector('.arrow')) th.insertAdjacentHTML('beforeend', '<span class="arrow">▾</span>');
          if (saved && saved.col === col) {
            th.classList.add(saved.dir);
            sortBy(table, col, saved.dir, th.dataset.sort);
          }
          th.addEventListener('click', () => {
            const dir = th.classList.contains('asc') ? 'desc' : 'asc';
            headers.forEach(h => h.classList.remove('asc', 'desc'));
            th.classList.add(dir);
            sortBy(table, col, dir, th.dataset.sort);
            sessionStorage.setItem('sort:' + key, JSON.stringify({ col, dir }));
          });
        });
      });
    }
    function sortBy(table, col, dir, type) {
      const tbody = table.tBodies[0];
      if (!tbody) return;
      const rows = Array.from(tbody.rows);
      rows.sort((a, b) => {
        const av = cellValue(a.cells[col], type);
        const bv = cellValue(b.cells[col], type);
        if (av < bv) return dir === 'asc' ? -1 : 1;
        if (av > bv) return dir === 'asc' ? 1 : -1;
        return 0;
      });
      rows.forEach(r => tbody.appendChild(r));
    }
    function cellValue(td, type) {
      if (!td) return type === 'num' ? -Infinity : '';
      if (td.dataset.num !== undefined) return Number(td.dataset.num);
      const txt = td.innerText.trim();
      if (type === 'num') {
        const n = Number(txt.replace(/[^\d\-.]/g, ''));
        return isNaN(n) ? -Infinity : n;
      }
      return txt.toLowerCase();
    }

    // ---------- dashboard ----------
    const dashboardState = { window: sessionStorage.getItem('dashWindow') || '24h' };
    async function renderDashboard() {
      const win = dashboardState.window;
      const bucket = win === '24h' ? 'hour' : 'day';
      const heatWindow = win === '24h' ? '7d' : (win === '30d' ? '30d' : '7d');
      const [stats, ts, heat, recent] = await Promise.all([
        api('/admin/stats'),
        api('/admin/timeseries?window=' + win + '&bucket=' + bucket),
        api('/admin/heatmap?window=' + heatWindow),
        api('/admin/requests?limit=20'),
      ]);

      const html =
        section('요약', kpiBlock(stats)) +
        '<div class="grid3" style="grid-template-columns: 2fr 1fr 1fr;">' +
          card('시계열 — ' + windowLabel(win),
            windowToolbar() +
            timeseriesChart(ts.points || [], bucket)
          ) +
          card('상위 사용자 (요청 수)', topUsersTable(stats.top_users || [])) +
          card('상태 분포', statusCard(stats.by_status || [], stats.total_requests)) +
        '</div>' +
        '<div class="grid3">' +
          card('IP별 사용량', groupedTable(stats.by_ip || [], 'IP', (k) => '#/ips/' + encodeURIComponent(k))) +
          card('모델별 사용량', groupedTable(stats.by_model || [], '모델')) +
          card('언어별 사용량', languagesTable(stats.by_language || [])) +
        '</div>' +
        section('시간대 히트맵 (Asia/Seoul, 최근 ' + heatWindow + ')', heatmapHTML(heat.cells || [])) +
        section('최근 호출 이력', requestsTable(recent.requests || []));

      document.getElementById('view').innerHTML = html;
      attachRequestRowHandlers();
      makeSortable('#view', 'dashboard');
      document.querySelectorAll('[data-window]').forEach(btn => {
        btn.addEventListener('click', () => {
          dashboardState.window = btn.dataset.window;
          sessionStorage.setItem('dashWindow', dashboardState.window);
          route();
        });
      });
    }
    function windowLabel(win) {
      return { '24h': '최근 24시간 (시간별)', '7d': '최근 7일 (일별)', '30d': '최근 30일 (일별)' }[win] || win;
    }
    function windowToolbar() {
      const cur = dashboardState.window;
      const btn = (w, label) =>
        '<button type="button" class="' + (cur === w ? '' : 'secondary') + '" data-window="' + w + '">' + label + '</button>';
      return '<div class="toolbar" style="border-bottom:0; padding-bottom:0">' +
        btn('24h', '24시간') + btn('7d', '7일') + btn('30d', '30일') + '</div>';
    }

    function timeseriesChart(points, bucket) {
      if (!points.length) return '<div class="empty">데이터 없음</div>';
      const W = 720, H = 220, padL = 56, padR = 16, padT = 14, padB = 28;
      const innerW = W - padL - padR, innerH = H - padT - padB;
      const maxReq = Math.max(1, ...points.map(p => p.requests || 0));
      const maxCost = Math.max(1, ...points.map(p => p.cost_krw || 0));
      const x = i => padL + (points.length === 1 ? innerW / 2 : (i * innerW) / (points.length - 1));
      const yReq = v => padT + innerH - (v / maxReq) * innerH;
      const yCost = v => padT + innerH - (v / maxCost) * innerH;

      const reqLine = points.map((p, i) => (i ? 'L' : 'M') + x(i) + ',' + yReq(p.requests || 0)).join(' ');
      const costLine = points.map((p, i) => (i ? 'L' : 'M') + x(i) + ',' + yCost(p.cost_krw || 0)).join(' ');

      const labelEvery = Math.max(1, Math.ceil(points.length / 8));
      const xLabels = points.map((p, i) => {
        if (i % labelEvery !== 0 && i !== points.length - 1) return '';
        const label = bucket === 'hour'
          ? p.date.replace('T', ' ').slice(5, 13) + 'h'
          : p.date.slice(5);
        return '<text x="' + x(i) + '" y="' + (H - 8) + '" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.6">' + escapeHTML(label) + '</text>';
      }).join('');

      const yReqLabel = '<text x="6" y="' + (padT + 8) + '" font-size="10" fill="currentColor" opacity="0.7">요청 ' + fmt(maxReq) + '</text>' +
                       '<text x="6" y="' + (padT + innerH) + '" font-size="10" fill="currentColor" opacity="0.5">0</text>';
      const yCostLabel = '<text x="' + (W - 6) + '" y="' + (padT + 8) + '" font-size="10" text-anchor="end" fill="currentColor" opacity="0.7">비용 ' + money(maxCost) + '</text>';

      const dots = points.map((p, i) =>
        '<circle cx="' + x(i) + '" cy="' + yReq(p.requests || 0) + '" r="3" fill="var(--accent)"><title>' +
        escapeHTML(p.date) + ' · 요청 ' + fmt(p.requests) + ' · 토큰 ' + fmt(p.tokens) + ' · ' + money(p.cost_krw) + '</title></circle>'
      ).join('');

      return '<div style="padding:14px"><svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" height="' + H + '" style="font-family:inherit; color:var(--ink)">' +
        '<line x1="' + padL + '" y1="' + (padT + innerH) + '" x2="' + (W - padR) + '" y2="' + (padT + innerH) + '" stroke="var(--line)"/>' +
        '<path d="' + reqLine + '" fill="none" stroke="var(--accent)" stroke-width="2"/>' +
        '<path d="' + costLine + '" fill="none" stroke="var(--accent-2)" stroke-width="2" stroke-dasharray="4 3"/>' +
        dots + xLabels + yReqLabel + yCostLabel +
      '</svg>' +
      '<div class="muted" style="font-size:12px; margin-top:4px">실선 = 요청 수, 점선 = 비용(KRW). 점에 마우스를 올리면 상세값.</div></div>';
    }

    function topUsersTable(rows) {
      if (!rows.length) return '<div class="empty">데이터 없음</div>';
      return '<table><thead><tr>' +
        '<th data-sort="str">이름</th>' +
        '<th data-sort="num">요청</th>' +
        '<th data-sort="num">비용</th></tr></thead><tbody>' +
        rows.map(u =>
          '<tr class="row-link" onclick="location.hash=\'#/users/' + encodeURIComponent(u.api_key_id) + '\'">' +
            '<td>' + escapeHTML(u.name) + '<div class="muted">' + escapeHTML(u.team || u.owner || u.api_key_id) + '</div></td>' +
            '<td data-num="' + (u.requests || 0) + '">' + fmt(u.requests) + '</td>' +
            '<td data-num="' + (u.cost_krw || 0) + '">' + money(u.cost_krw) + '</td>' +
          '</tr>').join('') +
        '</tbody></table>';
    }

    function statusCard(rows, total) {
      if (!rows.length) return '<div class="empty">데이터 없음</div>';
      const cls = (c) => c === '2xx' ? '' : (c === 'quota' ? 'warn' : 'error');
      const label = (c) => c === 'quota' ? '429 (쿼터)' : c;
      const sum = rows.reduce((acc, r) => acc + r.requests, 0) || total || 1;
      const segs = rows.map(r => {
        const w = (r.requests / sum) * 100;
        const color = r.class === '2xx' ? 'var(--accent)' : (r.class === 'quota' ? 'var(--warn)' : 'var(--bad)');
        return '<span style="background:' + color + '; width:' + w.toFixed(1) + '%" title="' + label(r.class) + ' · ' + fmt(r.requests) + ' (' + w.toFixed(1) + '%)"></span>';
      }).join('');
      const list = rows.map(r =>
        '<div style="display:flex; justify-content:space-between; padding:4px 0">' +
          '<span class="status ' + cls(r.class) + '">' + label(r.class) + '</span>' +
          '<span>' + fmt(r.requests) + ' · ' + ((r.requests / sum) * 100).toFixed(1) + '%</span>' +
        '</div>').join('');
      return '<div style="padding:14px">' +
        '<div class="progress" style="height:14px; display:flex">' + segs + '</div>' +
        '<div style="margin-top:10px">' + list + '</div>' +
      '</div>';
    }

    function heatmapHTML(cells) {
      const days = ['일', '월', '화', '수', '목', '금', '토'];
      const grid = Array.from({length: 7}, () => Array(24).fill(0));
      let max = 0;
      cells.forEach(c => { grid[c.day][c.hour] = c.requests; if (c.requests > max) max = c.requests; });
      if (max === 0) return '<div class="empty">데이터 없음</div>';
      const cell = 22, padL = 28, padT = 18;
      const W = padL + cell * 24 + 6, H = padT + cell * 7 + 6;
      const rects = [];
      for (let d = 0; d < 7; d++) {
        for (let h = 0; h < 24; h++) {
          const v = grid[d][h];
          const intensity = v === 0 ? 0 : 0.15 + 0.85 * (v / max);
          rects.push('<rect x="' + (padL + h * cell) + '" y="' + (padT + d * cell) + '" width="' + (cell - 2) + '" height="' + (cell - 2) + '" rx="3" fill="var(--accent)" fill-opacity="' + intensity.toFixed(2) + '">' +
            '<title>' + days[d] + ' ' + h + '시 · ' + fmt(v) + '건</title></rect>');
        }
      }
      const dayLabels = days.map((d, i) =>
        '<text x="' + (padL - 4) + '" y="' + (padT + i * cell + cell / 2 + 4) + '" text-anchor="end" font-size="10" fill="currentColor" opacity="0.7">' + d + '</text>'
      ).join('');
      const hourLabels = [0, 6, 12, 18].map(h =>
        '<text x="' + (padL + h * cell + (cell - 2) / 2) + '" y="' + (padT - 4) + '" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.6">' + h + 'h</text>'
      ).join('');
      return '<div style="padding:14px; overflow:auto"><svg viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" style="font-family:inherit; color:var(--ink)">' +
        dayLabels + hourLabels + rects.join('') +
      '</svg></div>';
    }
    function kpiBlock(stats) {
      const q = stats.latency_quantiles || {};
      const p50 = (q.p50 || 0), p95 = (q.p95 || 0), p99 = (q.p99 || 0);
      const fq = stats.first_chunk_quantiles || {};
      const fc50 = (fq.p50 || 0), fc95 = (fq.p95 || 0), fc99 = (fq.p99 || 0);
      const cache = stats.cache || {};
      const hits = Number(stats.cache_hits || 0), misses = Number(stats.cache_misses || 0);
      const total = hits + misses;
      const ratio = total > 0 ? (hits / total * 100).toFixed(1) + '%' : '-';
      return '<div class="kpis">' +
        kpi('총 요청 수', fmt(stats.total_requests)) +
        kpi('총 토큰', fmt(stats.total_tokens)) +
        kpi('누적 비용', money(stats.total_cost_krw)) +
        kpi('지연 P50 / P95', fmt(p50) + ' / <span style="color:var(--accent)">' + fmt(p95) + '</span> ms' +
          '<div class="muted" style="font-size:11px; font-weight:500; margin-top:6px">P99 ' + fmt(p99) + ' ms · 평균 ' + Math.round(stats.average_latency_ms || 0) + ' ms</div>') +
        kpi('첫 청크 P50 / P95', fmt(fc50) + ' / <span style="color:var(--accent-2)">' + fmt(fc95) + '</span> ms' +
          '<div class="muted" style="font-size:11px; font-weight:500; margin-top:6px">P99 ' + fmt(fc99) + ' ms</div>') +
      '</div>' +
      '<div class="kpis" style="margin-top:1px">' +
        kpi('임베딩 캐시 적중률', ratio + '<div class="muted" style="font-size:11px; font-weight:500; margin-top:6px">' + fmt(hits) + ' hits / ' + fmt(total) + ' total</div>') +
        kpi('캐시 항목', fmt(cache.entries) + '<div class="muted" style="font-size:11px; font-weight:500; margin-top:6px">' + Math.round((cache.bytes || 0) / 1024) + ' KB</div>') +
        kpi('총 캐시 히트', fmt(cache.total_hits)) +
        kpi('폴백 발생', fmt(stats.failover_total || 0)) +
      '</div>';
    }
    function kpi(label, value) {
      return '<div class="kpi"><div class="label">' + label + '</div><div class="value">' + value + '</div></div>';
    }
    function section(title, inner) { return '<section><h2>' + escapeHTML(title) + '</h2>' + inner + '</section>'; }
    function card(title, inner)    { return '<section><h2>' + escapeHTML(title) + '</h2>' + inner + '</section>'; }
    function cardWithID(id, title, inner) { return '<section id="' + escapeHTML(id) + '"><h2>' + escapeHTML(title) + '</h2>' + inner + '</section>'; }

    // ---------- LLM observability ----------
    const llmState = {
      window: sessionStorage.getItem('llmWindow') || '24h',
      apiKeyID: sessionStorage.getItem('llmApiKeyID') || '',
      team: sessionStorage.getItem('llmTeam') || '',
      model: '',
      sessionID: '',
      promptName: '',
      promptVersion: '',
      evaluationName: '',
      focus: '',
    };
    async function renderLLMObservability() {
      syncLLMStateFromHash();
      const win = llmState.window;
      const bucket = win === '24h' ? 'hour' : 'day';
      const scope = llmScopeParams();
      const [traces, sessions, evals, prompts, patterns, insights, feedback, ts] = await Promise.all([
        api('/admin/llm/traces?limit=100&' + scope.toString()),
        api('/admin/llm/sessions?limit=100&' + scope.toString()),
        api('/admin/llm/evaluations?limit=100&' + scope.toString()),
        api('/admin/llm/prompts?limit=100&' + scope.toString()),
        api('/admin/llm/patterns?limit=50&' + scope.toString()),
        api('/admin/llm/insights?window=' + win + '&limit=50&' + scope.toString()),
        api('/admin/llm/feedback?limit=50&' + scope.toString()),
        api('/admin/llm/timeseries?window=' + win + '&bucket=' + bucket + '&' + scope.toString()),
      ]);
      const summary = evals.summary || [];
      const recentEvals = evals.evaluations || [];
      const failed = recentEvals.filter(e => !e.passed).length;
      const promptRows = prompts.prompts || [];
      const patternRows = patterns.patterns || [];
      const insightRows = insights.insights || [];
      const tsPoints = ts.points || [];
      const feedbackRows = feedback.feedback || [];
      const feedbackSummary = feedback.summary || {};
      const feedbackLabels = feedback.labels || [];
      const feedbackPrompts = feedback.prompts || [];
      const alignment = feedback.alignment || {};
      const alignmentPrompts = feedback.alignment_prompts || [];
      const trend = llmTimeseriesSummary(tsPoints);
      const html =
        section('LLM 필터', llmScopeToolbar()) +
        section('LLM Observability 요약',
          '<div class="kpis">' +
            kpi('Trace', fmt((traces.traces || []).length)) +
            kpi('Session', fmt((sessions.sessions || []).length)) +
            kpi('Prompt', fmt(promptRows.length)) +
            kpi('Pattern', fmt(patternRows.length)) +
            kpi('Insight', fmt(insightRows.length)) +
            kpi('Evaluation', fmt(recentEvals.length)) +
            kpi('최근 실패 평가', fmt(failed)) +
            kpi('긍정 피드백', fmt(feedbackSummary.positive || 0)) +
            kpi('부정 피드백', fmt(feedbackSummary.negative || 0)) +
            kpi('Alignment', pct(alignment.alignment_rate || 0)) +
          '</div>'
        ) +
        '<div class="grid2">' +
          card('Trend Volume — ' + windowLabel(win),
            llmWindowToolbar() +
            timeseriesChart(tsPoints, bucket)
          ) +
          card('Trend Quality — ' + windowLabel(win),
            llmTrendSummaryBar(trend) +
            llmQualityChart(tsPoints, bucket)
          ) +
        '</div>' +
        section('Insights', llmInsightTable(insightRows)) +
        '<div class="grid2">' +
          cardWithID('llm-card-traces', 'Trace Explorer', llmTraceTable(traces.traces || [])) +
          cardWithID('llm-card-sessions', 'Session Explorer', llmSessionTable(sessions.sessions || [])) +
        '</div>' +
        '<div class="grid2">' +
          cardWithID('llm-card-prompts', 'Prompt Tracking', llmPromptTable(promptRows)) +
          cardWithID('llm-card-patterns', 'Patterns', llmPatternTable(patternRows)) +
        '</div>' +
        '<div class="grid2">' +
          cardWithID('llm-card-evaluations', 'Evaluation 요약', llmEvaluationSummaryTable(summary)) +
          cardWithID('llm-card-evaluation-list', '최근 Evaluation', llmEvaluationTable(recentEvals)) +
        '</div>' +
        '<div class="grid2">' +
          cardWithID('llm-card-feedback', '최근 Feedback', llmFeedbackTable(feedbackRows)) +
          card('Feedback 요약', llmFeedbackSummaryCard(feedbackSummary)) +
        '</div>' +
        '<div class="grid2">' +
          card('Feedback by Prompt', llmFeedbackPromptTable(feedbackPrompts)) +
          card('Feedback Labels', llmFeedbackLabelTable(feedbackLabels)) +
        '</div>' +
        '<div class="grid2">' +
          cardWithID('llm-card-alignment', 'Alignment 요약', llmAlignmentSummaryCard(alignment)) +
          cardWithID('llm-card-alignment-prompts', 'Alignment by Prompt', llmAlignmentPromptTable(alignmentPrompts)) +
        '</div>';
      document.getElementById('view').innerHTML = html;
      attachRequestRowHandlers();
      makeSortable('#view', 'llm');
      document.querySelectorAll('.prompt-compare').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          openPromptCompare(btn.dataset.promptName || '', btn.dataset.promptVersion || '', '');
        });
      });
      document.querySelectorAll('.insight-compare').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          openPromptCompare(btn.dataset.promptName || '', btn.dataset.promptVersion || '', '');
        });
      });
      document.querySelectorAll('.insight-session-bundle').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          e.preventDefault();
          e.stopPropagation();
          await openSessionInsightBundle(btn.dataset.sessionId || '', btn.dataset.title || '');
        });
      });
      document.querySelectorAll('[data-llm-window]').forEach(btn => {
        btn.addEventListener('click', () => {
          llmState.window = btn.dataset.llmWindow;
          sessionStorage.setItem('llmWindow', llmState.window);
          updateHashParams(llmHashParams());
          route();
        });
      });
      const applyBtn = document.getElementById('llm-scope-apply');
      if (applyBtn) {
        applyBtn.addEventListener('click', () => {
          llmState.apiKeyID = document.getElementById('llm-api-key').value.trim();
          llmState.team = document.getElementById('llm-team').value.trim();
          sessionStorage.setItem('llmApiKeyID', llmState.apiKeyID);
          sessionStorage.setItem('llmTeam', llmState.team);
          updateHashParams(llmHashParams());
          route();
        });
      }
      const clearBtn = document.getElementById('llm-scope-clear');
      if (clearBtn) {
        clearBtn.addEventListener('click', () => {
          llmState.apiKeyID = '';
          llmState.team = '';
          llmState.model = '';
          llmState.sessionID = '';
          llmState.promptName = '';
          llmState.promptVersion = '';
          llmState.evaluationName = '';
          llmState.focus = '';
          sessionStorage.removeItem('llmApiKeyID');
          sessionStorage.removeItem('llmTeam');
          updateHashParams(llmHashParams());
          route();
        });
      }
      const clearFocusBtn = document.getElementById('llm-focus-clear');
      if (clearFocusBtn) {
        clearFocusBtn.addEventListener('click', () => {
          llmState.model = '';
          llmState.sessionID = '';
          llmState.promptName = '';
          llmState.promptVersion = '';
          llmState.evaluationName = '';
          llmState.focus = '';
          updateHashParams(llmHashParams());
          route();
        });
      }
      if (llmState.focus) {
        const target = document.getElementById('llm-card-' + llmState.focus);
        if (target) target.scrollIntoView({ block: 'start', behavior: 'smooth' });
      }
    }

    function syncLLMStateFromHash() {
      const { params } = parseHash();
      if (!params.has('window') && !params.has('api_key_id') && !params.has('team') &&
          !params.has('model') && !params.has('session_id') && !params.has('prompt_name') &&
          !params.has('prompt_version') && !params.has('evaluation_name') && !params.has('focus')) return;
      llmState.window = params.get('window') || llmState.window || '24h';
      llmState.apiKeyID = params.get('api_key_id') || '';
      llmState.team = params.get('team') || '';
      llmState.model = params.get('model') || '';
      llmState.sessionID = params.get('session_id') || '';
      llmState.promptName = params.get('prompt_name') || '';
      llmState.promptVersion = params.get('prompt_version') || '';
      llmState.evaluationName = params.get('evaluation_name') || '';
      llmState.focus = params.get('focus') || '';
      sessionStorage.setItem('llmWindow', llmState.window);
      if (llmState.apiKeyID) sessionStorage.setItem('llmApiKeyID', llmState.apiKeyID);
      else sessionStorage.removeItem('llmApiKeyID');
      if (llmState.team) sessionStorage.setItem('llmTeam', llmState.team);
      else sessionStorage.removeItem('llmTeam');
    }

    function llmScopeParams() {
      const params = new URLSearchParams();
      if (llmState.apiKeyID) params.set('api_key_id', llmState.apiKeyID);
      if (llmState.team) params.set('team', llmState.team);
      if (llmState.model) params.set('model', llmState.model);
      if (llmState.sessionID) params.set('session_id', llmState.sessionID);
      if (llmState.promptName) params.set('prompt_name', llmState.promptName);
      if (llmState.promptVersion) params.set('prompt_version', llmState.promptVersion);
      if (llmState.evaluationName) params.set('evaluation_name', llmState.evaluationName);
      return params;
    }

    function llmHashParams() {
      const params = llmScopeParams();
      if (llmState.window) params.set('window', llmState.window);
      if (llmState.focus) params.set('focus', llmState.focus);
      return params;
    }

    function llmScopeToolbar() {
      let focusHTML = '';
      const chips = [];
      if (llmState.model) chips.push('<span class="status">모델 ' + escapeHTML(llmState.model) + '</span>');
      if (llmState.sessionID) chips.push('<span class="status">세션 ' + escapeHTML(llmState.sessionID) + '</span>');
      if (llmState.promptName) chips.push('<span class="status">프롬프트 ' + escapeHTML(llmState.promptName) + '</span>');
      if (llmState.promptVersion) chips.push('<span class="status">버전 ' + escapeHTML(llmState.promptVersion) + '</span>');
      if (llmState.evaluationName) chips.push('<span class="status">평가 ' + escapeHTML(llmState.evaluationName) + '</span>');
      if (chips.length) {
        focusHTML = '<div style="padding:0 14px 14px"><div class="muted" style="margin-bottom:8px">현재 drill-down</div>' +
          chips.join(' ') + ' <button type="button" class="ghost" id="llm-focus-clear">focus 해제</button></div>';
      }
      return '<div class="toolbar">' +
        '<input id="llm-api-key" placeholder="API 키 ID" value="' + escapeHTML(llmState.apiKeyID || '') + '">' +
        '<input id="llm-team" placeholder="팀" value="' + escapeHTML(llmState.team || '') + '">' +
        '<button type="button" id="llm-scope-apply">적용</button>' +
        '<button type="button" id="llm-scope-clear" class="secondary">초기화</button>' +
      '</div>' + focusHTML;
    }

    function llmWindowToolbar() {
      const cur = llmState.window;
      const btn = (w, label) =>
        '<button type="button" class="' + (cur === w ? '' : 'secondary') + '" data-llm-window="' + w + '">' + label + '</button>';
      return '<div class="toolbar" style="border-bottom:0; padding-bottom:0">' +
        btn('24h', '24시간') + btn('7d', '7일') + btn('30d', '30일') + '</div>';
    }

    function llmScopedLink(apiKeyID, team) {
      const params = new URLSearchParams();
      if (llmState.window) params.set('window', llmState.window);
      if (apiKeyID) params.set('api_key_id', apiKeyID);
      if (team) params.set('team', team);
      return '#/llm?' + params.toString();
    }

    function llmInsightLink(insight) {
      const params = llmHashParams();
      switch (insight.kind) {
        case 'prompt_injection_risk':
        case 'session_errors':
          if (insight.scope_value) params.set('session_id', insight.scope_value);
          params.set('focus', 'traces');
          break;
        case 'missing_usage':
        case 'slow_first_chunk':
          if (insight.scope_value) params.set('model', insight.scope_value);
          params.set('focus', 'traces');
          break;
        case 'negative_human_feedback':
          if (insight.scope_value) params.set('prompt_name', insight.scope_value);
          if (insight.scope_detail) params.set('prompt_version', insight.scope_detail);
          params.set('focus', 'feedback');
          break;
        case 'feedback_eval_mismatch':
          if (insight.scope_value) params.set('prompt_name', insight.scope_value);
          if (insight.scope_detail) params.set('prompt_version', insight.scope_detail);
          params.set('focus', 'alignment');
          break;
        case 'evaluation_failure':
          if (insight.scope_value) params.set('evaluation_name', insight.scope_value);
          params.set('focus', 'evaluation-list');
          break;
        default:
          params.set('focus', 'traces');
      }
      return '#/llm?' + params.toString();
    }

    function llmInsightActions(insight) {
      let html = '<a class="ghost" href="' + llmInsightLink(insight) + '">열기</a>';
      if ((insight.kind === 'prompt_injection_risk' || insight.kind === 'session_errors') && insight.scope_value) {
        html += ' <button type="button" class="ghost insight-session-bundle" data-session-id="' + escapeHTML(insight.scope_value || '') + '" data-title="' + escapeHTML(insight.title || '') + '">세션 묶음</button>';
      }
      if ((insight.kind === 'negative_human_feedback' || insight.kind === 'feedback_eval_mismatch') && insight.scope_value) {
        html += ' <button type="button" class="ghost insight-compare" data-prompt-name="' + escapeHTML(insight.scope_value || '') + '" data-prompt-version="' + escapeHTML(insight.scope_detail || '') + '">비교</button>';
      }
      return html + '<div class="muted" style="margin-top:6px">' + escapeHTML(insight.recommendation || '') + '</div>';
    }

    async function openSessionInsightBundle(sessionID, title) {
      if (!sessionID) return;
      const q = llmScopeParams();
      q.set('session_id', sessionID);
      q.set('limit', '50');
      const rows = (await api('/admin/llm/traces?' + q.toString())).traces || [];
      openModal((title || '세션 묶음') + ' - ' + sessionID, llmSessionInsightBundleHTML(sessionID, rows));
      const jsonBtn = document.getElementById('llm-session-bundle-json');
      if (jsonBtn) {
        jsonBtn.addEventListener('click', () => {
          downloadBlob(
            new Blob([JSON.stringify(rows, null, 2)], { type: 'application/json;charset=utf-8' }),
            'llm-session-' + safeFilePart(sessionID) + '-' + timestampForFile() + '.json'
          );
        });
      }
      const csvBtn = document.getElementById('llm-session-bundle-csv');
      if (csvBtn) {
        csvBtn.addEventListener('click', () => {
          downloadBlob(
            new Blob([traceRowsToCSV(rows)], { type: 'text/csv;charset=utf-8' }),
            'llm-session-' + safeFilePart(sessionID) + '-' + timestampForFile() + '.csv'
          );
        });
      }
      attachRequestRowHandlers();
      makeSortable('#modal-body', 'llm-session-bundle');
    }

    function llmSessionInsightBundleHTML(sessionID, rows) {
      return '<div class="toolbar" style="justify-content:flex-end; border-bottom:0; padding-bottom:8px">' +
        '<button type="button" id="llm-session-bundle-json" class="secondary">JSON 다운로드</button>' +
        '<button type="button" id="llm-session-bundle-csv" class="secondary">CSV 다운로드</button>' +
      '</div>' +
      '<div class="kpis" style="margin-bottom:12px">' +
        kpi('Session', escapeHTML(sessionID || 'no-session')) +
        kpi('최근 Trace', fmt(rows.length)) +
      '</div>' +
      llmTraceTable(rows);
    }

    function timestampForFile() {
      return new Date().toISOString().replace(/[:.]/g, '-');
    }

    function safeFilePart(value) {
      return String(value || 'bundle').replace(/[^a-zA-Z0-9._-]+/g, '_');
    }

    function downloadBlob(blob, filename) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    }

    function traceRowsToCSV(rows) {
      const header = ['request_id', 'trace_id', 'created_at', 'session_id', 'prompt_name', 'prompt_version', 'model', 'provider', 'status_code', 'first_chunk_ms', 'latency_ms', 'total_tokens', 'estimated_cost', 'tool_count'];
      const esc = (value) => {
        const text = String(value ?? '');
        return '"' + text.replace(/"/g, '""') + '"';
      };
      const lines = [header.join(',')];
      rows.forEach(r => {
        lines.push([
          r.id,
          r.trace_id,
          r.created_at,
          r.session_id,
          r.prompt_name,
          r.prompt_version,
          r.model,
          r.provider,
          r.status_code,
          r.first_chunk_ms,
          r.latency_ms,
          r.total_tokens,
          r.estimated_cost,
          r.tool_count,
        ].map(esc).join(','));
      });
      return '\uFEFF' + lines.join('\n');
    }

    function llmTimeseriesSummary(points) {
      return points.reduce((acc, p) => {
        acc.requests += Number(p.requests || 0);
        acc.evaluationFailures += Number(p.evaluation_failures || 0);
        acc.negativeFeedback += Number(p.negative_feedback || 0);
        acc.feedbackTotal += Number(p.feedback_total || 0);
        acc.alignmentSamples += Number(p.alignment_samples || 0);
        acc.weightedAlignment += Number(p.alignment_rate || 0) * Number(p.alignment_samples || 0);
        return acc;
      }, { requests: 0, evaluationFailures: 0, negativeFeedback: 0, feedbackTotal: 0, alignmentSamples: 0, weightedAlignment: 0 });
    }

    function llmTrendSummaryBar(summary) {
      const alignmentRate = summary.alignmentSamples ? (summary.weightedAlignment / summary.alignmentSamples) : 0;
      return '<div class="kpis" style="margin-bottom:1px">' +
        kpi('요청', fmt(summary.requests)) +
        kpi('평가 실패', fmt(summary.evaluationFailures)) +
        kpi('부정 피드백', fmt(summary.negativeFeedback)) +
        kpi('관측 Alignment', pct(alignmentRate)) +
      '</div>';
    }

    function llmQualityChart(points, bucket) {
      if (!points.length) return '<div class="empty">데이터 없음</div>';
      const W = 720, H = 220, padL = 56, padR = 42, padT = 14, padB = 28;
      const innerW = W - padL - padR, innerH = H - padT - padB;
      const maxCount = Math.max(1, ...points.map(p => Math.max(p.evaluation_failures || 0, p.negative_feedback || 0, p.feedback_total || 0)));
      const x = i => padL + (points.length === 1 ? innerW / 2 : (i * innerW) / (points.length - 1));
      const yCount = v => padT + innerH - (v / maxCount) * innerH;
      const yRate = v => padT + innerH - Math.max(0, Math.min(1, v || 0)) * innerH;
      const line = (getter) => points.map((p, i) => (i ? 'L' : 'M') + x(i) + ',' + getter(p)).join(' ');
      const evalLine = line(p => yCount(p.evaluation_failures || 0));
      const feedbackLine = line(p => yCount(p.negative_feedback || 0));
      const alignLine = line(p => yRate(p.alignment_rate || 0));
      const labelEvery = Math.max(1, Math.ceil(points.length / 8));
      const xLabels = points.map((p, i) => {
        if (i % labelEvery !== 0 && i !== points.length - 1) return '';
        const label = bucket === 'hour'
          ? p.date.replace('T', ' ').slice(5, 13) + 'h'
          : p.date.slice(5);
        return '<text x="' + x(i) + '" y="' + (H - 8) + '" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.6">' + escapeHTML(label) + '</text>';
      }).join('');
      const dots = points.map((p, i) =>
        '<g>' +
          '<circle cx="' + x(i) + '" cy="' + yCount(p.evaluation_failures || 0) + '" r="3" fill="var(--bad)"><title>' +
            escapeHTML(p.date) + ' · 평가 실패 ' + fmt(p.evaluation_failures || 0) + ' · 부정 피드백 ' + fmt(p.negative_feedback || 0) + ' · alignment ' + pct(p.alignment_rate || 0) +
          '</title></circle>' +
          '<circle cx="' + x(i) + '" cy="' + yCount(p.negative_feedback || 0) + '" r="3" fill="var(--warn)"></circle>' +
          '<circle cx="' + x(i) + '" cy="' + yRate(p.alignment_rate || 0) + '" r="3" fill="var(--accent-2)"></circle>' +
        '</g>'
      ).join('');
      return '<div style="padding:14px"><svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" height="' + H + '" style="font-family:inherit; color:var(--ink)">' +
        '<line x1="' + padL + '" y1="' + (padT + innerH) + '" x2="' + (W - padR) + '" y2="' + (padT + innerH) + '" stroke="var(--line)"/>' +
        '<path d="' + evalLine + '" fill="none" stroke="var(--bad)" stroke-width="2"/>' +
        '<path d="' + feedbackLine + '" fill="none" stroke="var(--warn)" stroke-width="2" stroke-dasharray="4 3"/>' +
        '<path d="' + alignLine + '" fill="none" stroke="var(--accent-2)" stroke-width="2"/>' +
        dots + xLabels +
        '<text x="6" y="' + (padT + 8) + '" font-size="10" fill="currentColor" opacity="0.7">이슈 ' + fmt(maxCount) + '</text>' +
        '<text x="' + (W - 6) + '" y="' + (padT + 8) + '" font-size="10" text-anchor="end" fill="currentColor" opacity="0.7">정렬 100%</text>' +
        '<text x="' + (W - 6) + '" y="' + (padT + innerH) + '" font-size="10" text-anchor="end" fill="currentColor" opacity="0.5">0%</text>' +
      '</svg>' +
      '<div class="muted" style="font-size:12px; margin-top:4px">빨강 = 평가 실패, 노랑 = 부정 피드백, 보라 = human/eval alignment.</div></div>';
    }

    function llmTraceTable(rows) {
      if (!rows.length) return '<div class="empty">trace 없음</div>';
      return '<table><thead><tr>' +
        '<th data-sort="str">Trace</th><th data-sort="str">Session</th><th data-sort="str">Prompt</th>' +
        '<th data-sort="str">모델</th><th data-sort="num">지연</th><th data-sort="num">토큰/비용</th><th data-sort="num">Tools</th><th data-sort="num">상태</th>' +
        '</tr></thead><tbody>' +
        rows.map(r => '<tr class="row-link" data-request-id="' + escapeHTML(r.id) + '">' +
          '<td>' + escapeHTML(r.trace_id || r.id) + '<div class="muted">' + ago(r.created_at) + '</div></td>' +
          '<td>' + escapeHTML(r.session_id || 'no-session') + '</td>' +
          '<td>' + escapeHTML(r.prompt_name || 'ad-hoc') + '<div class="muted">' + escapeHTML(r.prompt_version || '') + '</div></td>' +
          '<td>' + escapeHTML(r.model || '') + '<div class="muted">' + escapeHTML(r.provider || '') + '</div></td>' +
          '<td data-num="' + (r.latency_ms || 0) + '">' + latencyLabel(r) + '</td>' +
          '<td data-num="' + (r.total_tokens || 0) + '">' + fmt(r.total_tokens || 0) + ' tok<div class="muted">' + money(r.estimated_cost || 0) + '</div></td>' +
          '<td data-num="' + (r.tool_count || 0) + '">' + fmt(r.tool_count || 0) + '</td>' +
          '<td data-num="' + (r.status_code || 0) + '">' + statusBadge(r.status_code) + '</td>' +
        '</tr>').join('') + '</tbody></table>';
    }

    function llmInsightTable(rows) {
      if (!rows.length) return '<div class="empty">insight 없음</div>';
      return '<table><thead><tr><th data-sort="str">Severity</th><th data-sort="str">Insight</th><th data-sort="str">Scope</th><th data-sort="num">Count</th><th data-sort="num">Value</th><th>Action</th><th data-sort="str">최근</th></tr></thead><tbody>' +
        rows.map(i => '<tr>' +
          '<td><span class="status ' + (i.severity === 'high' ? 'error' : '') + '">' + escapeHTML(i.severity || '') + '</span></td>' +
          '<td>' + escapeHTML(i.title || '') + '<div class="muted">' + escapeHTML(i.detail || '') + '</div></td>' +
          '<td>' + escapeHTML(i.scope || '') + '<div class="muted">' + escapeHTML(i.scope_value || '') + (i.scope_detail ? (' / ' + escapeHTML(i.scope_detail)) : '') + '</div></td>' +
          '<td data-num="' + (i.count || 0) + '">' + fmt(i.count || 0) + '</td>' +
          '<td data-num="' + (i.metric_value || 0) + '">' + fmt(Math.round(i.metric_value || 0)) + '</td>' +
          '<td>' + llmInsightActions(i) + '</td>' +
          '<td>' + ago(i.last_seen) + '</td>' +
        '</tr>').join('') + '</tbody></table>';
    }

    function llmSessionTable(rows) {
      if (!rows.length) return '<div class="empty">session 없음</div>';
      return '<table><thead><tr><th data-sort="str">Session</th><th data-sort="num">요청</th><th data-sort="num">토큰</th><th data-sort="num">비용</th><th data-sort="num">오류</th><th data-sort="num">평가 실패</th><th data-sort="str">최근</th></tr></thead><tbody>' +
        rows.map(s => '<tr>' +
          '<td>' + escapeHTML(s.session_id || 'no-session') + '</td>' +
          '<td data-num="' + (s.requests || 0) + '">' + fmt(s.requests || 0) + '</td>' +
          '<td data-num="' + (s.tokens || 0) + '">' + fmt(s.tokens || 0) + '</td>' +
          '<td data-num="' + (s.cost_krw || 0) + '">' + money(s.cost_krw || 0) + '</td>' +
          '<td data-num="' + (s.errors || 0) + '">' + fmt(s.errors || 0) + '</td>' +
          '<td data-num="' + (s.evaluation_failures || 0) + '">' + fmt(s.evaluation_failures || 0) + '</td>' +
          '<td>' + ago(s.last_seen) + '</td>' +
        '</tr>').join('') + '</tbody></table>';
    }

    function llmEvaluationSummaryTable(rows) {
      if (!rows.length) return '<div class="empty">evaluation 없음</div>';
      return '<table><thead><tr><th data-sort="str">이름</th><th data-sort="str">범주</th><th data-sort="num">전체</th><th data-sort="num">통과</th><th data-sort="num">실패</th><th data-sort="num">평균 점수</th></tr></thead><tbody>' +
        rows.map(e => '<tr>' +
          '<td>' + escapeHTML(e.name) + '</td><td>' + escapeHTML(e.category) + '</td>' +
          '<td data-num="' + (e.total || 0) + '">' + fmt(e.total || 0) + '</td>' +
          '<td data-num="' + (e.passed || 0) + '">' + fmt(e.passed || 0) + '</td>' +
          '<td data-num="' + (e.failed || 0) + '">' + fmt(e.failed || 0) + '</td>' +
          '<td data-num="' + (e.average_score || 0) + '">' + Number(e.average_score || 0).toFixed(2) + '</td>' +
        '</tr>').join('') + '</tbody></table>';
    }

    function llmPromptTable(rows) {
      if (!rows.length) return '<div class="empty">prompt 없음</div>';
      return '<table><thead><tr><th data-sort="str">Prompt</th><th data-sort="num">호출</th><th data-sort="num">지연</th><th data-sort="num">토큰/비용</th><th data-sort="num">오류</th><th data-sort="num">평가 실패</th><th data-sort="str">최근</th><th>비교</th></tr></thead><tbody>' +
        rows.map(p => '<tr>' +
          '<td>' + escapeHTML(p.prompt_name || 'ad-hoc') + '<div class="muted">' + escapeHTML(p.prompt_version || '') + '</div></td>' +
          '<td data-num="' + (p.calls || 0) + '">' + fmt(p.calls || 0) + '</td>' +
          '<td data-num="' + (p.average_latency_ms || 0) + '">' + fmt(Math.round(p.average_latency_ms || 0)) + ' ms</td>' +
          '<td data-num="' + (p.tokens || 0) + '">' + fmt(p.tokens || 0) + ' tok<div class="muted">' + money(p.cost_krw || 0) + '</div></td>' +
          '<td data-num="' + (p.errors || 0) + '">' + fmt(p.errors || 0) + '</td>' +
          '<td data-num="' + (p.eval_failures || 0) + '">' + fmt(p.eval_failures || 0) + '</td>' +
          '<td>' + ago(p.last_seen) + '</td>' +
          '<td><button type="button" class="ghost prompt-compare" data-prompt-name="' + escapeHTML(p.prompt_name || 'ad-hoc') + '" data-prompt-version="' + escapeHTML(p.prompt_version || '') + '">비교</button></td>' +
        '</tr>').join('') + '</tbody></table>';
    }

    async function openPromptCompare(promptName, candidateVersion, baselineVersion, candidateLimit) {
      const q = new URLSearchParams({ prompt_name: promptName || '' });
      if (candidateVersion) q.set('candidate', candidateVersion);
      if (baselineVersion) q.set('baseline', baselineVersion);
      const compareLimit = String(candidateLimit || sessionStorage.getItem('promptCompareCandidateLimit') || '3');
      q.set('candidate_limit', compareLimit);
      const scope = llmScopeParams();
      scope.forEach((value, key) => q.set(key, value));
      const data = await api('/admin/llm/prompts/compare?' + q.toString());
      data.candidate_limit = compareLimit;
      openModal('Prompt 비교 - ' + (data.prompt_name || promptName), promptCompareHTML(data));
      const candidateSel = document.getElementById('prompt-compare-candidate');
      const baselineSel = document.getElementById('prompt-compare-baseline');
      const limitSel = document.getElementById('prompt-compare-candidate-limit');
      const reloadBtn = document.getElementById('prompt-compare-reload');
      document.querySelectorAll('.prompt-compare-candidate-pick').forEach(btn => {
        btn.addEventListener('click', async () => {
          await openPromptCompare(data.prompt_name || promptName, currentCandidateVersion(promptName, data), btn.dataset.baselineVersion || '', limitSel ? limitSel.value : compareLimit);
        });
      });
      if (limitSel) {
        limitSel.addEventListener('change', () => {
          sessionStorage.setItem('promptCompareCandidateLimit', limitSel.value);
        });
      }
      if (reloadBtn && candidateSel && baselineSel) {
        reloadBtn.addEventListener('click', async () => {
          const nextLimit = limitSel ? limitSel.value : compareLimit;
          sessionStorage.setItem('promptCompareCandidateLimit', nextLimit);
          await openPromptCompare(data.prompt_name || promptName, candidateSel.value, baselineSel.value, nextLimit);
        });
      }
    }

    function currentCandidateVersion(promptName, data) {
      return (data && data.candidate && data.candidate.prompt_version) || '';
    }

    function promptCompareHTML(data) {
      const versions = data.available_versions || [];
      const current = data.candidate || {};
      const baseline = data.baseline || null;
      const optionHTML = (selected) => versions.map(v =>
        '<option value="' + escapeHTML(v) + '"' + (v === selected ? ' selected' : '') + '>' + escapeHTML(v || '(empty)') + '</option>'
      ).join('');
      const signed = (value, render) => {
        const n = Number(value || 0);
        const text = render ? render(Math.abs(n)) : String(Math.abs(n));
        return (n > 0 ? '+' : n < 0 ? '-' : '') + text;
      };
      const deltaPct = (value) => signed(value, v => pct(v));
      const deltaNum = (value) => signed(value, v => fmt(Math.round(v)));
      const limitOption = (value) =>
        '<option value="' + value + '"' + (String(data.candidate_limit || '3') === String(value) ? ' selected' : '') + '>' + value + '개 후보</option>';
      return '<div class="toolbar">' +
        '<select id="prompt-compare-candidate">' + optionHTML(current.prompt_version || '') + '</select>' +
        '<select id="prompt-compare-baseline">' + optionHTML((baseline && baseline.prompt_version) || '') + '</select>' +
        '<select id="prompt-compare-candidate-limit">' + limitOption(3) + limitOption(5) + limitOption(10) + '</select>' +
        '<button type="button" id="prompt-compare-reload">다시 비교</button>' +
      '</div>' +
      (data.baseline_reason ? '<div class="muted" style="padding:0 14px 10px">baseline 선택: ' + escapeHTML(promptCompareReasonLabel(data.baseline_reason)) + '</div>' : '') +
      (data.candidate_ordering ? '<div class="muted" style="padding:0 14px 10px">후보 정렬: ' + escapeHTML(promptCompareOrderingLabel(data.candidate_ordering)) + '</div>' : '') +
      promptCompareCandidatesHTML(data.baseline_candidates || []) +
      (!baseline ? '<div class="empty">비교 가능한 다른 버전이 없습니다.</div>' : (
        '<div class="kpis">' +
          kpi('호출 delta', signed(data.delta.calls || 0, v => fmt(v))) +
          kpi('토큰 delta', signed(data.delta.tokens || 0, v => fmt(v))) +
          kpi('비용 delta', signed(data.delta.cost_krw || 0, v => money(v))) +
          kpi('지연 delta', deltaNum(data.delta.average_latency_ms || 0) + ' ms') +
        '</div>' +
        '<div class="kpis" style="margin-top:1px">' +
          kpi('오류율 delta', deltaPct(data.delta.error_rate || 0)) +
          kpi('평가 실패율 delta', deltaPct(data.delta.eval_failure_rate || 0)) +
          kpi('현재 버전', escapeHTML(current.prompt_version || '')) +
          kpi('기준 버전', escapeHTML(baseline.prompt_version || '')) +
        '</div>' +
        '<div class="grid2" style="margin-top:16px">' +
          card('Candidate', promptCompareSummaryCard(current, data.candidate_error_rate || 0, data.candidate_eval_failure_rate || 0)) +
          card('Baseline', promptCompareSummaryCard(baseline, data.baseline_error_rate || 0, data.baseline_eval_failure_rate || 0)) +
        '</div>'
      ));
    }

    function promptCompareCandidatesHTML(candidates) {
      if (!candidates.length) return '';
      return '<div style="padding:0 14px 10px"><div class="muted" style="margin-bottom:8px">추천 후보</div><div style="display:flex; flex-wrap:wrap; gap:8px">' +
        candidates.map(c =>
          '<button type="button" class="ghost prompt-compare-candidate-pick" data-baseline-version="' + escapeHTML(c.prompt_version || '') + '">' +
            escapeHTML((c.prompt_version || '(empty)') + ' - ' + promptCompareReasonLabel(c.reason)) +
            '<div class="muted" style="font-size:11px; margin-top:4px">' + escapeHTML(promptCompareCandidateMeta(c)) + '</div>' +
          '</button>'
        ).join('') +
      '</div></div>';
    }

    function promptCompareCandidateMeta(c) {
      return fmt(c.calls || 0) + ' calls · ' +
        fmt(Math.round(c.average_latency_ms || 0)) + ' ms · 오류 ' +
        pct(c.error_rate || 0) + ' · 평가 실패 ' +
        pct(c.eval_failure_rate || 0) + ' · ' +
        (c.last_seen || '');
    }

    function promptCompareReasonLabel(reason) {
      switch (reason) {
        case 'manual':
          return '수동 지정';
        case 'nearest_previous_version':
          return '가장 가까운 이전 버전 자동 선택';
        case 'recent_activity_fallback':
          return '최근 활동 기준 대체 baseline 자동 선택';
        default:
          return reason || '';
      }
    }

    function promptCompareOrderingLabel(ordering) {
      switch (ordering) {
        case 'nearest_previous_version_then_recent_activity':
          return '가까운 이전 버전 우선, 이후 최근 활동 순';
        default:
          return ordering || '';
      }
    }

    function promptCompareSummaryCard(item, errorRate, evalRate) {
      return '<div style="padding:14px"><div class="kv">' +
        row('버전', escapeHTML(item.prompt_version || '')) +
        row('호출', fmt(item.calls || 0)) +
        row('토큰', fmt(item.tokens || 0)) +
        row('비용', money(item.cost_krw || 0)) +
        row('평균 지연', Math.round(item.average_latency_ms || 0) + ' ms') +
        row('오류율', pct(errorRate || 0)) +
        row('평가 실패율', pct(evalRate || 0)) +
        row('첫 시각', escapeHTML(item.first_seen || '')) +
        row('최근 시각', escapeHTML(item.last_seen || '')) +
      '</div></div>';
    }

    function llmPatternTable(rows) {
      if (!rows.length) return '<div class="empty">pattern 없음</div>';
      return '<table><thead><tr><th data-sort="str">Pattern</th><th data-sort="num">요청</th><th data-sort="num">토큰/비용</th><th data-sort="num">오류</th><th data-sort="num">지연</th><th>Sample</th></tr></thead><tbody>' +
        rows.map(p => '<tr>' +
          '<td>' + escapeHTML(p.pattern || '') + '<div class="muted">' + escapeHTML(p.language || '') + '</div></td>' +
          '<td data-num="' + (p.requests || 0) + '">' + fmt(p.requests || 0) + '</td>' +
          '<td data-num="' + (p.tokens || 0) + '">' + fmt(p.tokens || 0) + ' tok<div class="muted">' + money(p.cost_krw || 0) + '</div></td>' +
          '<td data-num="' + (p.errors || 0) + '">' + fmt(p.errors || 0) + '</td>' +
          '<td data-num="' + (p.average_latency_ms || 0) + '">' + fmt(Math.round(p.average_latency_ms || 0)) + ' ms</td>' +
          '<td>' + escapeHTML(p.sample || '') + '</td>' +
        '</tr>').join('') + '</tbody></table>';
    }

    function llmEvaluationTable(rows) {
      if (!rows.length) return '<div class="empty">evaluation 없음</div>';
      return '<table><thead><tr><th data-sort="str">시각</th><th data-sort="str">Trace</th><th data-sort="str">이름</th><th data-sort="str">Label</th><th data-sort="num">Score</th><th>사유</th></tr></thead><tbody>' +
        rows.map(e => '<tr class="row-link" data-request-id="' + escapeHTML(e.request_id) + '">' +
          '<td>' + ago(e.created_at) + '</td><td>' + escapeHTML(e.trace_id || '') + '</td>' +
          '<td>' + escapeHTML(e.name) + '<div class="muted">' + escapeHTML(e.category || '') + '</div></td>' +
          '<td><span class="status ' + (e.passed ? '' : 'error') + '">' + escapeHTML(e.label || '') + '</span></td>' +
          '<td data-num="' + (e.score || 0) + '">' + Number(e.score || 0).toFixed(2) + '</td>' +
          '<td>' + escapeHTML(e.reason || '') + '</td>' +
        '</tr>').join('') + '</tbody></table>';
    }

    function llmFeedbackTable(rows) {
      if (!rows.length) return '<div class="empty">feedback 없음</div>';
      return '<table><thead><tr><th data-sort="str">시각</th><th data-sort="str">Trace</th><th data-sort="num">평가</th><th data-sort="str">Label</th><th>Comment</th><th data-sort="str">By</th></tr></thead><tbody>' +
        rows.map(f => '<tr class="row-link" data-request-id="' + escapeHTML(f.request_id) + '">' +
          '<td>' + ago(f.created_at) + '</td>' +
          '<td>' + escapeHTML(f.trace_id || '') + '</td>' +
          '<td data-num="' + (f.rating || 0) + '">' + feedbackBadge(f.rating) + '</td>' +
          '<td>' + escapeHTML(f.label || '') + '</td>' +
          '<td>' + escapeHTML(f.comment || '') + '</td>' +
          '<td>' + escapeHTML(f.created_by || f.source || '') + '</td>' +
        '</tr>').join('') + '</tbody></table>';
    }

    function llmFeedbackSummaryCard(summary) {
      return '<div class="kpis">' +
        kpi('전체', fmt(summary.total || 0)) +
        kpi('긍정', fmt(summary.positive || 0)) +
        kpi('부정', fmt(summary.negative || 0)) +
        kpi('중립', fmt(summary.neutral || 0)) +
        kpi('평균', Number(summary.average_rating || 0).toFixed(2)) +
      '</div>';
    }

    function llmFeedbackLabelTable(rows) {
      if (!rows.length) return '<div class="empty">label 없음</div>';
      return '<table><thead><tr><th data-sort="str">Label</th><th data-sort="num">전체</th><th data-sort="num">긍정</th><th data-sort="num">부정</th><th data-sort="num">중립</th><th data-sort="num">평균</th></tr></thead><tbody>' +
        rows.map(r => '<tr>' +
          '<td>' + escapeHTML(r.label || '') + '</td>' +
          '<td data-num="' + (r.total || 0) + '">' + fmt(r.total || 0) + '</td>' +
          '<td data-num="' + (r.positive || 0) + '">' + fmt(r.positive || 0) + '</td>' +
          '<td data-num="' + (r.negative || 0) + '">' + fmt(r.negative || 0) + '</td>' +
          '<td data-num="' + (r.neutral || 0) + '">' + fmt(r.neutral || 0) + '</td>' +
          '<td data-num="' + (r.average_rating || 0) + '">' + Number(r.average_rating || 0).toFixed(2) + '</td>' +
        '</tr>').join('') + '</tbody></table>';
    }

    function llmFeedbackPromptTable(rows) {
      if (!rows.length) return '<div class="empty">prompt feedback 없음</div>';
      return '<table><thead><tr><th data-sort="str">Prompt</th><th data-sort="num">전체</th><th data-sort="num">긍정</th><th data-sort="num">부정</th><th data-sort="num">중립</th><th data-sort="num">평균</th><th data-sort="str">최근</th></tr></thead><tbody>' +
        rows.map(r => '<tr>' +
          '<td>' + escapeHTML(r.prompt_name || 'ad-hoc') + '<div class="muted">' + escapeHTML(r.prompt_version || '') + '</div></td>' +
          '<td data-num="' + (r.total || 0) + '">' + fmt(r.total || 0) + '</td>' +
          '<td data-num="' + (r.positive || 0) + '">' + fmt(r.positive || 0) + '</td>' +
          '<td data-num="' + (r.negative || 0) + '">' + fmt(r.negative || 0) + '</td>' +
          '<td data-num="' + (r.neutral || 0) + '">' + fmt(r.neutral || 0) + '</td>' +
          '<td data-num="' + (r.average_rating || 0) + '">' + Number(r.average_rating || 0).toFixed(2) + '</td>' +
          '<td>' + ago(r.last_seen) + '</td>' +
        '</tr>').join('') + '</tbody></table>';
    }

    function llmAlignmentSummaryCard(summary) {
      return '<div class="kpis">' +
        kpi('전체', fmt(summary.total || 0)) +
        kpi('일치', fmt(summary.aligned || 0)) +
        kpi('불일치', fmt(summary.misaligned || 0)) +
        kpi('일치율', pct(summary.alignment_rate || 0)) +
        kpi('사람 부정', fmt(summary.human_negative_count || 0)) +
      '</div>';
    }

    function llmAlignmentPromptTable(rows) {
      if (!rows.length) return '<div class="empty">alignment 없음</div>';
      return '<table><thead><tr><th data-sort="str">Prompt</th><th data-sort="num">전체</th><th data-sort="num">일치</th><th data-sort="num">불일치</th><th data-sort="num">일치율</th><th data-sort="num">사람 부정</th><th data-sort="num">Eval 실패율</th><th data-sort="str">최근</th></tr></thead><tbody>' +
        rows.map(r => '<tr>' +
          '<td>' + escapeHTML(r.prompt_name || 'ad-hoc') + '<div class="muted">' + escapeHTML(r.prompt_version || '') + '</div></td>' +
          '<td data-num="' + (r.total || 0) + '">' + fmt(r.total || 0) + '</td>' +
          '<td data-num="' + (r.aligned || 0) + '">' + fmt(r.aligned || 0) + '</td>' +
          '<td data-num="' + (r.misaligned || 0) + '">' + fmt(r.misaligned || 0) + '</td>' +
          '<td data-num="' + (r.alignment_rate || 0) + '">' + pct(r.alignment_rate || 0) + '</td>' +
          '<td data-num="' + (r.human_negative || 0) + '">' + fmt(r.human_negative || 0) + '</td>' +
          '<td data-num="' + (r.eval_failure_rate || 0) + '">' + pct(r.eval_failure_rate || 0) + '</td>' +
          '<td>' + ago(r.last_seen) + '</td>' +
        '</tr>').join('') + '</tbody></table>';
    }

    function groupedTable(rows, firstCol, hrefBuilder) {
      if (!rows.length) return '<div class="empty">데이터 없음</div>';
      return '<table><thead><tr>' +
        '<th data-sort="str">' + escapeHTML(firstCol) + '</th>' +
        '<th data-sort="num">요청</th>' +
        '<th data-sort="num">토큰</th>' +
        '<th data-sort="num">비용</th></tr></thead><tbody>' +
        rows.map(r => {
          const key = escapeHTML(r.key);
          const cell = hrefBuilder ? '<a href="' + hrefBuilder(r.key) + '">' + key + '</a>' : key;
          return '<tr><td>' + cell + '</td>' +
            '<td data-num="' + (r.requests || 0) + '">' + fmt(r.requests) + '</td>' +
            '<td data-num="' + (r.tokens || 0) + '">' + fmt(r.tokens) + '</td>' +
            '<td data-num="' + (r.cost_krw || 0) + '">' + money(r.cost_krw) + '</td></tr>';
        }).join('') + '</tbody></table>';
    }
    function languagesTable(rows) {
      if (!rows.length) return '<div class="empty">데이터 없음</div>';
      return '<table><thead><tr>' +
        '<th data-sort="str">언어</th>' +
        '<th data-sort="num">요청</th>' +
        '<th data-sort="num">신뢰도</th></tr></thead><tbody>' +
        rows.map(r => '<tr><td>' + escapeHTML(r.language) + '</td>' +
          '<td data-num="' + (r.requests || 0) + '">' + fmt(r.requests) + '</td>' +
          '<td data-num="' + (r.average_confidence || 0) + '">' + pct(r.average_confidence) + '</td></tr>').join('') +
        '</tbody></table>';
    }
    function requestsTable(rows, opts) {
      if (!rows.length) return '<div class="empty">요청 없음</div>';
      const selectable = opts && opts.selectable;
      const head =
        (selectable ? '<th style="width:32px"></th>' : '') +
        '<th data-sort="num">상태</th>' +
        '<th data-sort="str">시간</th>' +
        '<th data-sort="str">클라이언트</th>' +
        '<th data-sort="str">모델</th>' +
        '<th data-sort="num">첫 청크/전체</th>' +
        '<th data-sort="num">토큰/비용</th>' +
        '<th>프롬프트</th>';
      return '<table><thead><tr>' + head + '</tr></thead><tbody>' +
        rows.map(r => {
          const langs = (r.languages || []).map(l => l.language).join(', ');
          const prompt = (r.prompts || []).map(p => p.role + ': ' + p.redacted_text).join('\n\n');
          const tags = (r.tags || []).map(t => '<span class="pill" title="태그">#' + escapeHTML(t) + '</span>').join(' ');
          const note = r.note ? '<div class="muted" title="' + escapeHTML(r.note) + '">📝 ' + escapeHTML(r.note.length > 60 ? r.note.slice(0, 60) + '…' : r.note) + '</div>' : '';
          const checkCell = selectable ? '<td><input type="checkbox" class="diff-check" value="' + escapeHTML(r.id) + '"></td>' : '';
          return '<tr class="row-link" data-request-id="' + escapeHTML(r.id) + '">' + checkCell +
            '<td data-num="' + r.status_code + '">' + statusBadge(r.status_code) + '</td>' +
            '<td>' + ago(r.created_at) + '<div class="muted">' + escapeHTML(r.trace_id) + '</div></td>' +
            '<td><a href="#/ips/' + encodeURIComponent(r.client_ip || 'unknown') + '">' + escapeHTML(r.client_ip || '알 수 없음') + '</a>' +
              '<div class="muted">' + (r.api_key_id ? '<a href="#/users/' + encodeURIComponent(r.api_key_id) + '">' + escapeHTML(r.api_key_id) + '</a>' : '') + '</div></td>' +
            '<td>' + escapeHTML(r.model || '알 수 없음') + '<div class="muted">' + escapeHTML(langs || '') + '</div>' + (tags ? '<div style="margin-top:4px">' + tags + '</div>' : '') + '</td>' +
            '<td data-num="' + (r.first_chunk_ms || 0) + '">' + fmt(r.first_chunk_ms || 0) + ' ms<div class="muted">전체 ' + fmt(r.latency_ms || 0) + ' ms</div></td>' +
            '<td data-num="' + (r.total_tokens || 0) + '">' + fmt(r.total_tokens) + ' tok<div class="muted">' + money(r.estimated_cost) + ' · ' + escapeHTML(sourceLabel(r.token_source)) + '</div></td>' +
            '<td><div class="prompt">' + escapeHTML(prompt) + '</div>' + note + '</td></tr>';
        }).join('') + '</tbody></table>';
    }
    function attachRequestRowHandlers() {
      document.querySelectorAll('tr.row-link').forEach(row => {
        row.addEventListener('click', async (e) => {
          if (e.target.closest('a')) return;
          const id = row.dataset.requestId;
          if (!id) return;
          try {
            const [detail, note] = await Promise.all([
              api('/admin/requests/' + encodeURIComponent(id)),
              api('/admin/requests/' + encodeURIComponent(id) + '/note').catch(() => ({ tags: [], note: '' })),
            ]);
            openModal('요청 상세 - ' + (detail.request.trace_id || id), requestDetailHTML(detail, note), id);
            wireNoteEditor(id);
            wireFeedbackEditor(id);
          } catch (err) {
            openModal('오류', '<div class="error-line">' + escapeHTML(err.message) + '</div>');
          }
        });
      });
    }

    function noteEditor(id, note) {
      const tags = (note.tags || []).join(', ');
      return '<section style="margin-top:18px"><h2>태그 · 메모 · 재실행</h2><div style="padding:14px">' +
        '<label class="muted" style="font-size:12px; font-weight:700">태그 (콤마 구분, # 없이)</label>' +
        '<input id="note-tags" value="' + escapeHTML(tags) + '" placeholder="예: 의심,재현필요,검토대기">' +
        '<label class="muted" style="font-size:12px; font-weight:700; margin-top:10px; display:block">메모</label>' +
        '<textarea id="note-text" rows="4" style="width:100%; height:auto; padding:8px 10px">' + escapeHTML(note.note || '') + '</textarea>' +
        '<div style="margin-top:10px; display:flex; gap:8px; flex-wrap:wrap; align-items:center">' +
          '<button id="note-save" type="button" data-id="' + escapeHTML(id) + '">저장</button>' +
          '<button id="note-clear" type="button" class="ghost" data-id="' + escapeHTML(id) + '">태그·메모 삭제</button>' +
          '<button id="note-replay" type="button" class="secondary" data-id="' + escapeHTML(id) + '" title="원본 body 가 보관된 경우 동일한 요청을 다시 실행합니다 (LOG_RAW_BODIES=true 필요)">동일 요청 재실행</button>' +
          (note.updated_at ? '<span class="muted" style="margin-left:auto; align-self:center">최근 변경 ' + escapeHTML(note.updated_at) + ' by ' + escapeHTML(note.created_by || '') + '</span>' : '') +
        '</div>' +
        '<pre id="replay-output" class="prompt-block" style="display:none; margin-top:10px; max-height:240px; overflow:auto"></pre>' +
      '</div></section>';
    }

    function feedbackComposer(id) {
      return '<section style="margin-top:18px"><h2>LLM Feedback</h2><div style="padding:14px">' +
        '<div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center">' +
          '<button id="fb-positive" type="button" data-id="' + escapeHTML(id) + '">좋음</button>' +
          '<button id="fb-negative" type="button" class="ghost" data-id="' + escapeHTML(id) + '">문제 있음</button>' +
          '<button id="fb-neutral" type="button" class="secondary" data-id="' + escapeHTML(id) + '">중립</button>' +
          '<input id="fb-label" placeholder="라벨 (예: helpful, hallucination, unsafe)">' +
        '</div>' +
        '<textarea id="fb-comment" rows="3" style="width:100%; height:auto; padding:8px 10px; margin-top:10px" placeholder="짧은 코멘트"></textarea>' +
      '</div></section>';
    }

    function wireNoteEditor(id) {
      const save = document.getElementById('note-save');
      const clear = document.getElementById('note-clear');
      const replay = document.getElementById('note-replay');
      if (save) save.addEventListener('click', async () => {
        const raw = document.getElementById('note-tags').value;
        const tags = raw.split(',').map(t => t.trim()).filter(Boolean);
        const noteText = document.getElementById('note-text').value;
        await api('/admin/requests/' + encodeURIComponent(id) + '/note', { method: 'PUT', body: JSON.stringify({ tags, note: noteText }) });
        closeModal();
        route();
      });
      if (clear) clear.addEventListener('click', async () => {
        if (!confirm('태그와 메모를 삭제하시겠습니까?')) return;
        await api('/admin/requests/' + encodeURIComponent(id) + '/note', { method: 'DELETE' });
        closeModal();
        route();
      });
      if (replay) replay.addEventListener('click', async () => {
        if (!confirm('동일한 요청을 다시 upstream 으로 보내시겠습니까? (비용 발생)')) return;
        const out = document.getElementById('replay-output');
        out.style.display = 'block';
        out.textContent = '재실행 중…';
        try {
          const res = await fetch('/admin/requests/' + encodeURIComponent(id) + '/replay', { method: 'POST', headers: headers() });
          const text = await res.text();
          if (!res.ok) {
            out.textContent = '실패: ' + text;
            return;
          }
          out.textContent = text;
        } catch (err) {
          out.textContent = '오류: ' + err.message;
        }
      });
    }
    function wireFeedbackEditor(id) {
      [['fb-positive', 1], ['fb-negative', -1], ['fb-neutral', 0]].forEach(([buttonID, rating]) => {
        const button = document.getElementById(buttonID);
        if (!button) return;
        button.addEventListener('click', async () => {
          const label = (document.getElementById('fb-label') || {}).value || '';
          const comment = (document.getElementById('fb-comment') || {}).value || '';
          await api('/admin/llm/feedback', {
            method: 'POST',
            body: JSON.stringify({ request_id: id, rating, label: label.trim(), comment: comment.trim() })
          });
          closeModal();
          route();
        });
      });
    }
    function requestDetailHTML(d, note) {
      const r = d.request;
      const langs = (d.languages || []).map(l => escapeHTML(l.language) + ' <span class="muted">(' + pct(l.confidence) + ')</span>').join(', ') || '<span class="muted">없음</span>';
      const prompts = (d.prompts || []).map(p => {
        const text = p.redacted_text || p.content_text || '';
        const trimmed = text.trim();
        const isJson = (trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'));
        
        let formatted = '';
        if (isJson) {
          formatted = '<pre style="margin:0; white-space:pre-wrap; font-family:ui-monospace, SFMono-Regular, Consolas, monospace; font-size:13px; background:transparent; border:none; padding:0;">' + escapeHTML(formatTextIfJSON(text)) + '</pre>';
        } else {
          formatted = '<div style="white-space:normal; line-height:1.6; font-size:13.5px;">' + renderMarkdown(text) + '</div>';
        }
        
        return '<div class="prompt-block" style="white-space:normal;">' +
          '<div class="prompt-role" style="border-bottom:1px solid var(--line); padding-bottom:6px; margin-bottom:10px; font-weight:800;">' + 
            escapeHTML(p.role) + (p.language_hint ? ' · <span class="pill">' + escapeHTML(p.language_hint) + '</span>' : '') + 
          '</div>' +
          formatted +
          (p.content_text && p.content_text !== p.redacted_text ? '<div class="muted" style="margin-top:8px; font-size:12px;">원문 별도 보관됨</div>' : '') +
          '</div>';
      }).join('<div style="height:12px"></div>') || '<div class="empty">프롬프트 없음</div>';

      const resp = d.response ? (
        '<div class="kv">' +
          '<div class="k">상태</div><div class="v">' + statusBadge(d.response.status_code) + '</div>' +
          '<div class="k">finish_reason</div><div class="v">' + escapeHTML(d.response.finish_reason || '') + '</div>' +
          '<div class="k">응답 hash</div><div class="v">' + escapeHTML(d.response.response_hash || '') + '</div>' +
          '<div class="k">캡처된 응답</div><div class="v">' + (d.response.response_text_optional ? ('<div class="prompt-block">' + escapeHTML(formatTextIfJSON(d.response.response_text_optional)) + '</div>') : '<span class="muted">없음 (LOG_RESPONSE_TEXT=false)</span>') + '</div>' +
        '</div>'
      ) : '<div class="muted">응답 메타 없음</div>';
      const spans = (d.spans || []).length ? (
        '<table><thead><tr><th>Name</th><th>Kind</th><th>Status</th><th>지연</th><th>토큰/비용</th><th>Tools</th></tr></thead><tbody>' +
        (d.spans || []).map(s => '<tr>' +
          '<td>' + escapeHTML(s.name || '') + '<div class="muted">' + escapeHTML(s.id || '') + '</div></td>' +
          '<td>' + escapeHTML(s.kind || '') + '</td>' +
          '<td><span class="status ' + (s.status === 'error' ? 'error' : '') + '">' + escapeHTML(s.status || '') + '</span></td>' +
          '<td>' + fmt(s.first_chunk_ms || 0) + ' / ' + fmt(s.latency_ms || 0) + ' ms</td>' +
          '<td>' + fmt(s.total_tokens || 0) + ' tok<div class="muted">' + money(s.estimated_cost || 0) + '</div></td>' +
          '<td>' + fmt(s.tool_count || 0) + '</td>' +
        '</tr>').join('') + '</tbody></table>'
      ) : '<div class="muted">span 없음</div>';
      const evals = (d.evaluations || []).length ? (
        '<table><thead><tr><th>이름</th><th>범주</th><th>결과</th><th>점수</th><th>사유</th></tr></thead><tbody>' +
        (d.evaluations || []).map(e => '<tr>' +
          '<td>' + escapeHTML(e.name) + '</td>' +
          '<td>' + escapeHTML(e.category || '') + '</td>' +
          '<td><span class="status ' + (e.passed ? '' : 'error') + '">' + escapeHTML(e.label || '') + '</span></td>' +
          '<td>' + Number(e.score || 0).toFixed(2) + '</td>' +
          '<td>' + escapeHTML(e.reason || '') + '</td>' +
        '</tr>').join('') + '</tbody></table>'
      ) : '<div class="muted">평가 없음</div>';
      const feedback = (d.feedback || []).length ? (
        '<table><thead><tr><th>시각</th><th>평가</th><th>Label</th><th>Comment</th><th>By</th></tr></thead><tbody>' +
        (d.feedback || []).map(f => '<tr>' +
          '<td>' + ago(f.created_at) + '</td>' +
          '<td>' + feedbackBadge(f.rating) + '</td>' +
          '<td>' + escapeHTML(f.label || '') + '</td>' +
          '<td>' + escapeHTML(f.comment || '') + '</td>' +
          '<td>' + escapeHTML(f.created_by || f.source || '') + '</td>' +
        '</tr>').join('') + '</tbody></table>'
      ) : '<div class="muted">feedback 없음</div>';

      return (
        '<div class="kv">' +
          row('요청 ID', escapeHTML(r.id)) +
          row('Trace ID', escapeHTML(r.trace_id)) +
          row('생성 시각', escapeHTML(r.created_at) + ' · ' + ago(r.created_at)) +
          row('상태', statusBadge(r.status_code)) +
          row('지연', escapeHTML(latencyLabel(r))) +
          row('endpoint', escapeHTML(r.endpoint)) +
          row('모델', escapeHTML(r.model || '알 수 없음')) +
          row('provider', escapeHTML(r.provider || '')) +
          row('stream', r.stream ? '예' : '아니오') +
          row('Session', escapeHTML(r.session_id || '')) +
          row('Prompt', escapeHTML((r.prompt_name || 'ad-hoc') + (r.prompt_version ? (' @ ' + r.prompt_version) : ''))) +
          row('Prompt variables hash', escapeHTML(r.prompt_variables_hash || '')) +
          row('Tool count', fmt(r.tool_count || 0)) +
          row('클라이언트 IP', '<a href="#/ips/' + encodeURIComponent(r.client_ip || 'unknown') + '">' + escapeHTML(r.client_ip || '알 수 없음') + '</a>') +
          row('X-Forwarded-For', escapeHTML(r.forwarded_for || '')) +
          row('User-Agent', escapeHTML(r.user_agent || '')) +
          row('API 키', r.api_key_id ? '<a href="#/users/' + encodeURIComponent(r.api_key_id) + '">' + escapeHTML(r.api_key_id) + '</a>' : '<span class="muted">미식별</span>') +
          row('언어 추론', langs) +
          row('토큰 분해', escapeHTML('prompt ' + fmt(r.prompt_tokens) + ' / completion ' + fmt(r.completion_tokens) + ' / cached ' + fmt(r.cached_tokens) + ' / reasoning ' + fmt(r.reasoning_tokens) + ' / total ' + fmt(r.total_tokens))) +
          row('비용', money(r.estimated_cost) + ' · ' + escapeHTML(sourceLabel(r.token_source))) +
          row('오류', escapeHTML(r.error || '없음')) +
        '</div>' +
        '<h3 style="margin-top:18px">프롬프트 (마스킹 적용)</h3>' + prompts +
        '<h3 style="margin-top:18px">응답</h3>' + resp +
        '<h3 style="margin-top:18px">LLM Spans</h3>' + spans +
        '<h3 style="margin-top:18px">LLM Evaluation</h3>' + evals +
        '<h3 style="margin-top:18px">LLM Feedback</h3>' + feedback +
        feedbackComposer(r.id) +
        noteEditor(r.id, note || { tags: [], note: '' })
      );
    }
    function row(k, v) {
      return '<div class="k">' + escapeHTML(k) + '</div><div class="v">' + v + '</div>';
    }
    function latencyLabel(r) {
      return '첫 청크 ' + fmt(r.first_chunk_ms || 0) + ' ms / 전체 ' + fmt(r.latency_ms || 0) + ' ms';
    }
    function feedbackBadge(rating) {
      if (Number(rating) > 0) return '<span class="status">좋음</span>';
      if (Number(rating) < 0) return '<span class="status error">문제 있음</span>';
      return '<span class="status">중립</span>';
    }

    // ---------- requests view ----------
    let diffSelection = JSON.parse(sessionStorage.getItem('diffSelection') || '[]');
    async function renderRequestsView(initial) {
      const view = document.getElementById('view');
      const [models, ips, langs] = await Promise.all([
        suggestList('model'), suggestList('ip'), suggestList('language')
      ]);
      view.innerHTML = section('호출 이력 검색',
        '<form class="toolbar" id="req-filter" autocomplete="off">' +
          '<input id="f-ip" placeholder="IP 필터" list="dl-ip">' +
          '<input id="f-model" placeholder="모델 필터" list="dl-model">' +
          '<input id="f-language" placeholder="언어 필터" list="dl-lang">' +
          '<input id="f-limit" type="number" min="1" max="200" placeholder="개수" value="100">' +
          '<button type="submit">검색</button>' +
          '<button type="button" id="diff-btn" class="ghost" title="선택한 두 요청 비교 (행 좌측 체크박스로 선택)">두 요청 비교</button>' +
          '<span id="diff-count" class="muted" style="font-size:12px"></span>' +
          datalist('dl-ip', ips) + datalist('dl-model', models) + datalist('dl-lang', langs) +
        '</form>' +
        '<div id="req-results"></div>'
      );
      // restore from hash query if provided
      if (initial) {
        const map = { ip: 'f-ip', model: 'f-model', language: 'f-language', limit: 'f-limit' };
        Object.entries(map).forEach(([k, id]) => {
          const v = initial.get(k);
          if (v !== null && v !== undefined) document.getElementById(id).value = v;
        });
      }
      document.getElementById('req-filter').addEventListener('submit', async (e) => {
        e.preventDefault();
        await loadRequests();
      });
      document.getElementById('diff-btn').addEventListener('click', openDiffModal);
      updateDiffCount();
      await loadRequests();

      async function loadRequests() {
        const params = new URLSearchParams();
        const ip = document.getElementById('f-ip').value.trim();
        const model = document.getElementById('f-model').value.trim();
        const language = document.getElementById('f-language').value.trim();
        const limit = document.getElementById('f-limit').value.trim() || '100';
        if (ip) params.set('ip', ip);
        if (model) params.set('model', model);
        if (language) params.set('language', language);
        params.set('limit', limit);
        updateHashParams(params);
        const r = await api('/admin/requests?' + params.toString());
        document.getElementById('req-results').innerHTML = requestsTable(r.requests || [], { selectable: true });
        attachRequestRowHandlers();
        attachDiffSelectionHandlers();
        makeSortable('#req-results', 'requests');
      }
    }

    async function suggestList(field) {
      try {
        const r = await api('/admin/suggest?field=' + field);
        return r.values || [];
      } catch (e) { return []; }
    }
    function datalist(id, values) {
      return '<datalist id="' + id + '">' + (values || []).map(v => '<option value="' + escapeHTML(v) + '"></option>').join('') + '</datalist>';
    }
    function attachDiffSelectionHandlers() {
      document.querySelectorAll('.diff-check').forEach(box => {
        box.checked = diffSelection.includes(box.value);
        box.addEventListener('click', (e) => {
          e.stopPropagation();
          const id = box.value;
          const idx = diffSelection.indexOf(id);
          if (box.checked) {
            if (idx < 0) diffSelection.push(id);
            if (diffSelection.length > 2) diffSelection = diffSelection.slice(-2);
          } else if (idx >= 0) {
            diffSelection.splice(idx, 1);
          }
          sessionStorage.setItem('diffSelection', JSON.stringify(diffSelection));
          updateDiffCount();
        });
      });
    }
    function updateDiffCount() {
      const el = document.getElementById('diff-count');
      if (el) el.textContent = '선택된 항목 ' + diffSelection.length + '/2';
    }
    async function openDiffModal() {
      if (diffSelection.length !== 2) { alert('두 행을 체크박스로 선택해주세요'); return; }
      const [a, b] = diffSelection;
      const diff = await api('/admin/requests/diff?a=' + encodeURIComponent(a) + '&b=' + encodeURIComponent(b));
      openModal('요청 비교', diffHTML(diff));
    }
    function diffHTML(d) {
      const side = (label, x) => {
        const r = x.request;
        const prompts = (x.prompts || []).map(p => '<div class="prompt-block"><div class="prompt-role">' + escapeHTML(p.role) + '</div>' + escapeHTML(p.redacted_text || p.content_text || '') + '</div>').join('<div style="height:6px"></div>') || '<div class="empty">프롬프트 없음</div>';
        return '<div><h3 style="margin-top:0">' + label + '</h3><div class="kv">' +
          row('요청 ID', escapeHTML(r.id)) +
          row('생성', escapeHTML(r.created_at)) +
          row('모델', escapeHTML(r.model || '')) +
          row('상태', statusBadge(r.status_code)) +
          row('지연', escapeHTML(latencyLabel(r))) +
          row('토큰', escapeHTML('prompt ' + fmt(r.prompt_tokens) + ' / completion ' + fmt(r.completion_tokens) + ' / total ' + fmt(r.total_tokens))) +
          row('비용', money(r.estimated_cost)) +
          '</div><div style="margin-top:10px">' + prompts + '</div></div>';
      };
      return '<div class="grid2">' + side('A', d.left) + side('B', d.right) + '</div>';
    }

    // ---------- prompts search ----------
    async function renderPromptsView(initial) {
      const view = document.getElementById('view');
      const saved = (await api('/admin/saved-filters').catch(() => ({ filters: [] }))).filters || [];
      const promptFilters = saved.filter(f => f.view === 'prompts');
      const savedOptions = '<option value="">저장된 필터 선택…</option>' +
        promptFilters.map(f => '<option value="' + encodeURIComponent(f.params) + '" data-id="' + escapeHTML(f.id) + '">' + escapeHTML(f.name) + '</option>').join('');
      view.innerHTML = section('프롬프트 키워드 검색',
        '<form class="toolbar" id="prompt-filter" autocomplete="off">' +
          '<input id="p-keyword" placeholder="키워드 (#tag 검색 가능)" style="min-width:240px">' +
          '<input id="p-language" placeholder="언어">' +
          '<input id="p-ip" placeholder="IP">' +
          '<input id="p-key" placeholder="API 키 ID">' +
          '<input id="p-since" type="datetime-local" placeholder="이후">' +
          '<input id="p-limit" type="number" min="1" max="10000" value="100">' +
          '<button type="submit">검색</button>' +
          '<button type="button" id="p-export" class="secondary">CSV 다운로드</button>' +
          '<select id="p-saved" title="저장된 필터">' + savedOptions + '</select>' +
          '<button type="button" id="p-save" class="ghost">현재 필터 저장</button>' +
          '<button type="button" id="p-delete-saved" class="ghost" title="선택한 저장된 필터 삭제">선택 삭제</button>' +
        '</form>' +
        '<div id="prompt-results"></div>'
      );
      const collectParams = () => {
        const params = new URLSearchParams();
        const kw = document.getElementById('p-keyword').value.trim();
        const language = document.getElementById('p-language').value.trim();
        const ip = document.getElementById('p-ip').value.trim();
        const key = document.getElementById('p-key').value.trim();
        const since = document.getElementById('p-since').value.trim();
        const limit = document.getElementById('p-limit').value.trim() || '100';
        if (kw) params.set('q', kw);
        if (language) params.set('language', language);
        if (ip) params.set('ip', ip);
        if (key) params.set('api_key_id', key);
        if (since) params.set('since', new Date(since).toISOString());
        params.set('limit', limit);
        return params;
      };
      if (initial) applyPromptParams(initial);
      const runSearch = async () => {
        const params = collectParams();
        updateHashParams(params);
        const r = await api('/admin/prompts?' + params.toString());
        document.getElementById('prompt-results').innerHTML = requestsTable(r.requests || []);
        attachRequestRowHandlers();
        makeSortable('#prompt-results', 'prompts');
      };
      document.getElementById('prompt-filter').addEventListener('submit', async (e) => {
        e.preventDefault();
        await runSearch();
      });
      if (initial && initial.toString().length > 0) {
        // auto-run search when entering with a shared URL
        runSearch();
      }
      document.getElementById('p-export').addEventListener('click', async () => {
        const params = collectParams();
        const res = await fetch('/admin/export.csv?' + params.toString(), { headers: headers() });
        if (!res.ok) { alert('CSV 다운로드 실패: ' + (await res.text())); return; }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'requests-' + new Date().toISOString().replace(/[:.]/g, '-') + '.csv';
        document.body.appendChild(a); a.click(); a.remove();
        URL.revokeObjectURL(url);
      });

      const savedSel = document.getElementById('p-saved');
      savedSel.addEventListener('change', () => {
        const encoded = savedSel.value;
        if (!encoded) return;
        const params = new URLSearchParams(decodeURIComponent(encoded));
        applyPromptParams(params);
        document.getElementById('prompt-filter').dispatchEvent(new Event('submit'));
      });
      document.getElementById('p-save').addEventListener('click', async () => {
        const name = prompt('필터 이름을 입력하세요');
        if (!name) return;
        await api('/admin/saved-filters', { method: 'POST', body: JSON.stringify({
          name: name.trim(), view: 'prompts', params: collectParams().toString(),
        }) });
        route();
      });
      document.getElementById('p-delete-saved').addEventListener('click', async () => {
        const selected = savedSel.options[savedSel.selectedIndex];
        const id = selected && selected.dataset.id;
        if (!id) { alert('삭제할 저장된 필터를 먼저 선택하세요'); return; }
        if (!confirm('"' + selected.text + '" 저장된 필터를 삭제하시겠습니까?')) return;
        await api('/admin/saved-filters/' + encodeURIComponent(id), { method: 'DELETE' });
        route();
      });
    }

    function applyPromptParams(params) {
      const map = { q: 'p-keyword', language: 'p-language', ip: 'p-ip', api_key_id: 'p-key', since: 'p-since', limit: 'p-limit' };
      Object.entries(map).forEach(([k, id]) => {
        const el = document.getElementById(id);
        if (!el) return;
        let v = params.get(k) || '';
        if (k === 'since' && v) {
          const d = new Date(v);
          if (!isNaN(d)) v = d.toISOString().slice(0, 16);
        }
        el.value = v;
      });
    }

    // ---------- users ----------
    async function renderUsers() {
      const r = await api('/admin/users');
      const rows = r.users || [];
      const html = section('사용자 (Proxy API 키) 별 사용량',
        rows.length ? (
          '<table><thead><tr>' +
          '<th data-sort="str">이름</th>' +
          '<th data-sort="str">소유자</th>' +
          '<th data-sort="str">팀</th>' +
          '<th data-sort="str">상태</th>' +
          '<th data-sort="num">요청</th>' +
          '<th data-sort="num">토큰</th>' +
          '<th data-sort="num">비용</th>' +
          '<th data-sort="num">평균 지연</th>' +
          '<th data-sort="str">마지막 호출</th></tr></thead><tbody>' +
          rows.map(u =>
            '<tr class="row-link" onclick="location.hash=\'#/users/' + encodeURIComponent(u.api_key_id) + '\'">' +
              '<td>' + escapeHTML(u.name) + '<div class="muted">' + escapeHTML(u.api_key_id) + '</div></td>' +
              '<td>' + escapeHTML(u.owner || '') + '</td>' +
              '<td>' + (u.team ? '<a href="#/teams/' + encodeURIComponent(u.team) + '" onclick="event.stopPropagation()">' + escapeHTML(u.team) + '</a>' : '') + '</td>' +
              '<td><span class="status ' + (u.status === 'active' ? '' : 'error') + '">' + escapeHTML(u.status) + '</span></td>' +
              '<td data-num="' + (u.requests || 0) + '">' + fmt(u.requests) + '</td>' +
              '<td data-num="' + (u.tokens || 0) + '">' + fmt(u.tokens) + '</td>' +
              '<td data-num="' + (u.cost_krw || 0) + '">' + money(u.cost_krw) + '</td>' +
              '<td data-num="' + (u.average_latency_ms || 0) + '">' + Math.round(u.average_latency_ms || 0) + ' ms</td>' +
              '<td>' + ago(u.last_seen) + '</td>' +
            '</tr>'
          ).join('') + '</tbody></table>'
        ) : '<div class="empty">사용자 없음</div>'
      );
      document.getElementById('view').innerHTML = html;
      makeSortable('#view', 'users');
    }

    async function renderUserDetail(id) {
      const d = await api('/admin/users/' + encodeURIComponent(id) + '?limit=100');
      const k = d.api_key, s = d.stats;
      const a = d.advanced || {};
      const heat = d.heatmap || {};
      const llm = d.llm || {};
      const html =
        '<section><h2>사용자 ' + escapeHTML(k.name) + '</h2>' +
          '<div style="padding:14px"><div class="kv">' +
            row('API 키 ID', escapeHTML(k.id)) +
            row('소유자', escapeHTML(k.owner || '')) +
            row('팀', k.team ? '<a href="#/teams/' + encodeURIComponent(k.team) + '">' + escapeHTML(k.team) + '</a>' : '') +
            row('상태', escapeHTML(k.status)) +
            row('총 요청', fmt(s.requests)) +
            row('총 토큰', fmt(s.tokens)) +
            row('누적 비용', money(s.cost_krw)) +
            row('평균 지연', Math.round(s.average_latency_ms || 0) + ' ms') +
            row('마지막 호출', ago(s.last_seen)) +
            row('LLM 관측', '<a href="' + llmScopedLink(k.id, k.team || '') + '">필터된 LLM 보기</a>') +
          '</div></div>' +
        '</section>' +
        section('사용자 고급 지표', userAdvancedHTML(a)) +
        section('사용자 LLM 관측', userLLMSummaryHTML(llm.summary || {})) +
        '<div class="grid2">' +
          card('LLM Trend (24h)', llmQualityChart(llm.timeseries || [], 'hour')) +
          card('상위 Prompt (LLM)', llmUserPromptTable(llm.prompts || [])) +
        '</div>' +
        '<div class="grid2">' +
          card('LLM Feedback Labels', llmFeedbackLabelTable(llm.feedback_labels || [])) +
          card('최근 호출', requestsTable(d.recent || [])) +
        '</div>' +
        '<div class="grid3">' +
          card('일별 사용량', dailyTable(d.daily || [])) +
          card('모델별', groupedTable(d.by_model || [], '모델')) +
          card('IP별', groupedTable(d.by_ip || [], 'IP', (key) => '#/ips/' + encodeURIComponent(key))) +
        '</div>' +
        '<div class="grid2">' +
          card('상태 분포', statusCard(d.by_status || [], s.requests || 0)) +
          card('시간대 히트맵 (Asia/Seoul, 최근 30일)', heatmapHTML(heat.cells || [])) +
        '</div>' + 
        '<div class="grid2">' +
          card('언어별', languagesTable(d.by_language || [])) +
          card('LLM Trend Summary', llmTrendSummaryBar(llmTimeseriesSummary(llm.timeseries || []))) +
        '</div>';
      document.getElementById('view').innerHTML = html;
      attachRequestRowHandlers();
      makeSortable('#view', 'user-detail');
    }

    async function renderTeams() {
      const r = await api('/admin/teams');
      const rows = r.teams || [];
      const html = section('팀별 사용량',
        rows.length ? (
          '<table><thead><tr>' +
          '<th data-sort="str">팀</th>' +
          '<th data-sort="num">키 수</th>' +
          '<th data-sort="num">요청</th>' +
          '<th data-sort="num">토큰</th>' +
          '<th data-sort="num">비용</th>' +
          '<th data-sort="num">평균 지연</th>' +
          '<th data-sort="str">마지막 호출</th></tr></thead><tbody>' +
          rows.map(t =>
            '<tr class="row-link" onclick="location.hash=\'#/teams/' + encodeURIComponent(t.team) + '\'">' +
              '<td>' + escapeHTML(t.team || 'unassigned') + '</td>' +
              '<td data-num="' + (t.keys || 0) + '">' + fmt(t.keys || 0) + '</td>' +
              '<td data-num="' + (t.requests || 0) + '">' + fmt(t.requests || 0) + '</td>' +
              '<td data-num="' + (t.tokens || 0) + '">' + fmt(t.tokens || 0) + '</td>' +
              '<td data-num="' + (t.cost_krw || 0) + '">' + money(t.cost_krw || 0) + '</td>' +
              '<td data-num="' + (t.average_latency_ms || 0) + '">' + Math.round(t.average_latency_ms || 0) + ' ms</td>' +
              '<td>' + ago(t.last_seen) + '</td>' +
            '</tr>'
          ).join('') + '</tbody></table>'
        ) : '<div class="empty">팀 없음</div>'
      );
      document.getElementById('view').innerHTML = html;
      makeSortable('#view', 'teams');
    }

    async function renderTeamDetail(team) {
      const d = await api('/admin/teams/' + encodeURIComponent(team) + '?limit=100');
      const s = d.stats || {};
      const a = d.advanced || {};
      const heat = d.heatmap || {};
      const llm = d.llm || {};
      const html =
        '<section><h2>팀 ' + escapeHTML(s.team || team) + '</h2>' +
          '<div style="padding:14px"><div class="kv">' +
            row('팀', escapeHTML(s.team || team)) +
            row('API 키 수', fmt(s.keys || 0)) +
            row('총 요청', fmt(s.requests || 0)) +
            row('총 토큰', fmt(s.tokens || 0)) +
            row('누적 비용', money(s.cost_krw || 0)) +
            row('평균 지연', Math.round(s.average_latency_ms || 0) + ' ms') +
            row('마지막 호출', ago(s.last_seen)) +
            row('LLM 관측', '<a href="' + llmScopedLink('', s.team || team) + '">필터된 LLM 보기</a>') +
          '</div></div>' +
        '</section>' +
        section('팀 고급 지표', userAdvancedHTML(a)) +
        section('팀 LLM 관측', userLLMSummaryHTML(llm.summary || {})) +
        '<div class="grid2">' +
          card('LLM Trend (24h)', llmQualityChart(llm.timeseries || [], 'hour')) +
          card('상위 Prompt (LLM)', llmUserPromptTable(llm.prompts || [])) +
        '</div>' +
        '<div class="grid2">' +
          card('LLM Feedback Labels', llmFeedbackLabelTable(llm.feedback_labels || [])) +
          card('최근 호출', requestsTable(d.recent || [])) +
        '</div>' +
        '<div class="grid3">' +
          card('일별 사용량', dailyTable(d.daily || [])) +
          card('모델별', groupedTable(d.by_model || [], '모델')) +
          card('API 키별', groupedTable(d.by_key || [], 'API 키', (key) => '#/users/' + encodeURIComponent(key))) +
        '</div>' +
        '<div class="grid2">' +
          card('상태 분포', statusCard(d.by_status || [], s.requests || 0)) +
          card('시간대 히트맵 (Asia/Seoul, 최근 30일)', heatmapHTML(heat.cells || [])) +
        '</div>' +
        '<div class="grid2">' +
          card('언어별', languagesTable(d.by_language || [])) +
          card('IP별', groupedTable(d.by_ip || [], 'IP', (key) => '#/ips/' + encodeURIComponent(key))) +
        '</div>';
      document.getElementById('view').innerHTML = html;
      attachRequestRowHandlers();
      makeSortable('#view', 'team-detail');
    }

    function userAdvancedHTML(a) {
      return '<div class="kpis">' +
        kpi('최근 24h 요청', fmt(a.requests_24h || 0) + '<div class="muted" style="font-size:11px; font-weight:500; margin-top:6px">' + fmt(a.tokens_24h || 0) + ' tok · ' + money(a.cost_krw_24h || 0) + '</div>') +
        kpi('오류율', pct(a.error_rate || 0) + '<div class="muted" style="font-size:11px; font-weight:500; margin-top:6px">' + fmt(a.errors || 0) + ' errors</div>') +
        kpi('지연 P95', fmt(Math.round(a.latency_p95_ms || 0)) + ' ms<div class="muted" style="font-size:11px; font-weight:500; margin-top:6px">첫 청크 P95 ' + fmt(Math.round(a.first_chunk_p95_ms || 0)) + ' ms</div>') +
        kpi('평균 첫 청크', fmt(Math.round(a.average_first_chunk_ms || 0)) + ' ms<div class="muted" style="font-size:11px; font-weight:500; margin-top:6px">모델 ' + fmt(a.distinct_models || 0) + ' · IP ' + fmt(a.distinct_ips || 0) + '</div>') +
      '</div>' +
      '<div class="kpis" style="margin-top:1px">' +
        kpi('Prompt 토큰', fmt(a.prompt_tokens || 0)) +
        kpi('Completion 토큰', fmt(a.completion_tokens || 0)) +
        kpi('Cached 토큰', fmt(a.cached_tokens || 0)) +
        kpi('Reasoning 토큰', fmt(a.reasoning_tokens || 0)) +
      '</div>';
    }

    function userLLMSummaryHTML(s) {
      return '<div class="kpis">' +
        kpi('LLM 요청', fmt(s.requests || 0)) +
        kpi('세션', fmt(s.sessions || 0)) +
        kpi('Prompt variant', fmt(s.prompt_variants || 0)) +
        kpi('Eval 실패', fmt(s.eval_failures || 0) + '<div class="muted" style="font-size:11px; font-weight:500; margin-top:6px">' + fmt(s.evaluations || 0) + ' eval</div>') +
      '</div>' +
      '<div class="kpis" style="margin-top:1px">' +
        kpi('부정 피드백', fmt(s.negative_feedback || 0) + '<div class="muted" style="font-size:11px; font-weight:500; margin-top:6px">' + fmt(s.feedback_total || 0) + ' feedback</div>') +
        kpi('Alignment', pct(s.alignment_rate || 0) + '<div class="muted" style="font-size:11px; font-weight:500; margin-top:6px">' + fmt(s.alignment_samples || 0) + ' samples</div>') +
        kpi('평균 첫 청크', fmt(Math.round(s.average_first_chunk_ms || 0)) + ' ms') +
        kpi('마지막 LLM 호출', s.last_seen ? ago(s.last_seen) : '<span class="muted">-</span>') +
      '</div>';
    }

    function llmUserPromptTable(rows) {
      if (!rows.length) return '<div class="empty">prompt 없음</div>';
      return '<table><thead><tr>' +
        '<th data-sort="str">Prompt</th><th data-sort="num">호출</th><th data-sort="num">평균 지연</th><th data-sort="num">평가 실패</th><th data-sort="str">최근</th>' +
        '</tr></thead><tbody>' +
        rows.map(r => '<tr>' +
          '<td>' + escapeHTML(r.prompt_name || 'ad-hoc') + '<div class="muted">' + escapeHTML(r.prompt_version || '') + '</div></td>' +
          '<td data-num="' + (r.calls || 0) + '">' + fmt(r.calls || 0) + '</td>' +
          '<td data-num="' + (r.average_latency_ms || 0) + '">' + Math.round(r.average_latency_ms || 0) + ' ms</td>' +
          '<td data-num="' + (r.eval_failures || 0) + '">' + fmt(r.eval_failures || 0) + '</td>' +
          '<td>' + ago(r.last_seen) + '</td>' +
        '</tr>').join('') +
        '</tbody></table>';
    }

    function dailyTable(rows) {
      if (!rows.length) return '<div class="empty">데이터 없음</div>';
      return '<table><thead><tr>' +
        '<th data-sort="str">일자</th>' +
        '<th data-sort="num">요청</th>' +
        '<th data-sort="num">토큰</th>' +
        '<th data-sort="num">비용</th></tr></thead><tbody>' +
        rows.map(d => '<tr><td>' + escapeHTML(d.date) + '</td>' +
          '<td data-num="' + (d.requests || 0) + '">' + fmt(d.requests) + '</td>' +
          '<td data-num="' + (d.tokens || 0) + '">' + fmt(d.tokens) + '</td>' +
          '<td data-num="' + (d.cost_krw || 0) + '">' + money(d.cost_krw) + '</td></tr>').join('') +
        '</tbody></table>';
    }

    // ---------- ips ----------
    async function renderIPs() {
      const r = await api('/admin/ips');
      const rows = r.ips || [];
      const html = section('IP 별 사용량',
        rows.length ? (
          '<table><thead><tr>' +
          '<th data-sort="str">IP</th>' +
          '<th data-sort="num">요청</th>' +
          '<th data-sort="num">토큰</th>' +
          '<th data-sort="num">비용</th>' +
          '<th data-sort="num">고유 키</th>' +
          '<th data-sort="num">평균 지연</th>' +
          '<th data-sort="str">마지막 호출</th></tr></thead><tbody>' +
          rows.map(ip =>
            '<tr class="row-link" onclick="location.hash=\'#/ips/' + encodeURIComponent(ip.ip) + '\'">' +
              '<td>' + escapeHTML(ip.ip) + '</td>' +
              '<td data-num="' + (ip.requests || 0) + '">' + fmt(ip.requests) + '</td>' +
              '<td data-num="' + (ip.tokens || 0) + '">' + fmt(ip.tokens) + '</td>' +
              '<td data-num="' + (ip.cost_krw || 0) + '">' + money(ip.cost_krw) + '</td>' +
              '<td data-num="' + (ip.distinct_keys || 0) + '">' + fmt(ip.distinct_keys) + '</td>' +
              '<td data-num="' + (ip.average_latency_ms || 0) + '">' + Math.round(ip.average_latency_ms || 0) + ' ms</td>' +
              '<td>' + ago(ip.last_seen) + '</td>' +
            '</tr>'
          ).join('') + '</tbody></table>'
        ) : '<div class="empty">IP 데이터 없음</div>'
      );
      document.getElementById('view').innerHTML = html;
      makeSortable('#view', 'ips');
    }

    async function renderIPDetail(ip) {
      const d = await api('/admin/ips/' + encodeURIComponent(ip) + '?limit=100');
      const s = d.stats;
      const html =
        '<section><h2>IP ' + escapeHTML(ip) + '</h2>' +
          '<div style="padding:14px"><div class="kv">' +
            row('IP', escapeHTML(s.ip)) +
            row('총 요청', fmt(s.requests)) +
            row('총 토큰', fmt(s.tokens)) +
            row('누적 비용', money(s.cost_krw)) +
            row('평균 지연', Math.round(s.average_latency_ms || 0) + ' ms') +
            row('마지막 호출', ago(s.last_seen)) +
            row('고유 키 수', fmt(s.distinct_keys)) +
          '</div></div>' +
        '</section>' +
        '<div class="grid3">' +
          card('일별 사용량', dailyTable(d.daily || [])) +
          card('모델별', groupedTable(d.by_model || [], '모델')) +
          card('API 키 별', groupedTable(d.by_key || [], 'API 키', (key) => '#/users/' + encodeURIComponent(key))) +
        '</div>' +
        '<div class="grid2">' +
          card('언어별', languagesTable(d.by_language || [])) +
          card('최근 호출', requestsTable(d.recent || [])) +
        '</div>';
      document.getElementById('view').innerHTML = html;
      attachRequestRowHandlers();
      makeSortable('#view', 'ip-detail');
    }

    // ---------- quotas ----------
    async function renderQuotas() {
      const r = await api('/admin/quotas');
      const usage = r.usage || [];
      const quotaRow = (u) => {
        const q = u.quota;
        const tokenBar = q.token_limit > 0 ? progressBar(1 - u.token_remain_ratio) : '<span class="muted">미설정</span>';
        const krwBar = q.krw_limit > 0 ? progressBar(1 - u.krw_remain_ratio) : '<span class="muted">미설정</span>';
        return '<tr>' +
          '<td>' + scopeLabel(q.scope) + '<div class="muted">' + escapeHTML(q.scope_value) + '</div></td>' +
          '<td>' + periodLabel(q.period) + '</td>' +
          '<td>' + (q.token_limit > 0 ? fmt(u.tokens) + ' / ' + fmt(q.token_limit) : '<span class="muted">-</span>') + tokenBar + '</td>' +
          '<td>' + (q.krw_limit > 0 ? money(u.cost_krw) + ' / ' + money(q.krw_limit) : '<span class="muted">-</span>') + krwBar + '</td>' +
          '<td><span class="status ' + (q.enabled ? '' : 'error') + '">' + (q.enabled ? '사용' : '중지') + '</span></td>' +
          '<td>' + escapeHTML(q.note || '') + '</td>' +
          '<td>' +
            '<button class="secondary" type="button" onclick="toggleQuota(\'' + q.id + '\', ' + (!q.enabled) + ')">' + (q.enabled ? '중지' : '사용') + '</button> ' +
            '<button class="danger" type="button" onclick="deleteQuota(\'' + q.id + '\')">삭제</button>' +
          '</td></tr>';
      };
      const table = usage.length ? (
        '<table><thead><tr><th>대상</th><th>주기</th><th>토큰</th><th>비용</th><th>상태</th><th>메모</th><th>동작</th></tr></thead><tbody>' +
        usage.map(quotaRow).join('') + '</tbody></table>'
      ) : '<div class="empty">설정된 한도 없음</div>';

      const html = section('사용 한도 (Quota)',
        '<form class="inline-form" id="quota-form" style="grid-template-columns: 120px minmax(120px,1fr) 110px minmax(120px,1fr) minmax(120px,1fr) minmax(120px,1fr) 80px;">' +
          '<select id="q-scope">' +
            '<option value="api_key">API 키</option>' +
            '<option value="team">팀</option>' +
            '<option value="ip">IP</option>' +
            '<option value="global">전체</option>' +
          '</select>' +
          '<input id="q-value" placeholder="대상 값 (전체는 자동)">' +
          '<select id="q-period">' +
            '<option value="daily">일별</option>' +
            '<option value="monthly">월별</option>' +
          '</select>' +
          '<input id="q-tokens" type="number" min="0" placeholder="토큰 한도">' +
          '<input id="q-krw" type="number" min="0" step="100" placeholder="KRW 한도">' +
          '<input id="q-note" placeholder="메모">' +
          '<button type="submit">추가</button>' +
        '</form>' +
        table
      );
      document.getElementById('view').innerHTML = html;
      document.getElementById('quota-form').addEventListener('submit', addQuota);
    }
    function progressBar(filled) {
      const pctVal = Math.max(0, Math.min(1, Number(filled) || 0));
      const cls = pctVal >= 1 ? 'danger' : (pctVal >= 0.8 ? 'warn' : '');
      return '<div class="progress" style="margin-top:6px"><span class="' + cls + '" style="width:' + (pctVal * 100).toFixed(1) + '%"></span></div>';
    }
    async function addQuota(event) {
      event.preventDefault();
      const scope = document.getElementById('q-scope').value;
      const body = {
        scope,
        scope_value: scope === 'global' ? '*' : document.getElementById('q-value').value.trim(),
        period: document.getElementById('q-period').value,
        token_limit: Number(document.getElementById('q-tokens').value || 0),
        krw_limit: Number(document.getElementById('q-krw').value || 0),
        note: document.getElementById('q-note').value.trim(),
        enabled: true
      };
      await api('/admin/quotas', { method: 'POST', body: JSON.stringify(body) });
      route();
    }
    window.toggleQuota = async (id, enabled) => {
      await api('/admin/quotas/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify({ enabled }) });
      route();
    };
    window.deleteQuota = async (id) => {
      if (!confirm('해당 한도를 삭제하시겠습니까?')) return;
      await api('/admin/quotas/' + encodeURIComponent(id), { method: 'DELETE' });
      route();
    };

    // ---------- MCP / tool observability ----------
    async function renderMCP(initial) {
      const apiKeyId = initial ? (initial.get('api_key_id') || '') : '';
      const serverFilter = initial ? (initial.get('server') || '') : '';
      const mcpOnly = initial ? (initial.get('mcp_only') === '1') : false;
      const qs = new URLSearchParams();
      if (apiKeyId) qs.set('api_key_id', apiKeyId);
      if (serverFilter) qs.set('server', serverFilter);
      if (mcpOnly) qs.set('mcp_only', '1');

      const [serversResp, toolsResp] = await Promise.all([
        api('/admin/mcp/servers' + (qs.toString() ? '?' + qs.toString() : '')),
        api('/admin/mcp/tools' + (qs.toString() ? '?' + qs.toString() : '')),
      ]);
      const servers = serversResp.servers || [];
      const summary = serversResp.summary || {};
      const tools = toolsResp.tools || [];

      const kpis = '<div class="kpis">' +
        kpi('tool 호출 수', fmt(summary.total_calls)) +
        kpi('tool 오류 수', fmt(summary.total_errors) + '<div class="muted" style="font-size:11px; font-weight:500; margin-top:6px">' + errorRatePct(summary.total_errors, summary.total_calls) + '</div>') +
        kpi('고유 tool 수', fmt(summary.distinct_tools)) +
        kpi('MCP 서버 수', fmt(summary.mcp_servers)) +
      '</div>';

      const filterBar =
        '<form class="toolbar" id="mcp-filter" autocomplete="off">' +
          '<input id="mcp-api-key" placeholder="API 키 ID" value="' + escapeHTML(apiKeyId) + '">' +
          '<input id="mcp-server" placeholder="서버 라벨" value="' + escapeHTML(serverFilter) + '">' +
          '<label style="display:flex; align-items:center; gap:6px"><input type="checkbox" id="mcp-only" ' + (mcpOnly ? 'checked' : '') + ' style="width:auto; height:auto; min-width:0"> MCP만</label>' +
          '<button type="submit">적용</button>' +
        '</form>';

      const serverRows = servers.length ? servers.map(s =>
        '<tr class="row-link" onclick="mcpFilterServer(\'' + escapeAttr(s.server_label) + '\')">' +
          '<td>' + (s.is_mcp ? '<span class="pill">MCP</span> ' : '') + escapeHTML(s.server_label) + '</td>' +
          '<td data-num="' + (s.tools || 0) + '">' + fmt(s.tools) + '</td>' +
          '<td data-num="' + (s.calls || 0) + '">' + fmt(s.calls) + '</td>' +
          '<td data-num="' + (s.errors || 0) + '">' + fmt(s.errors) + '</td>' +
          '<td data-num="' + (s.error_rate || 0) + '">' + (Number(s.error_rate || 0) * 100).toFixed(1) + '%</td>' +
          '<td data-num="' + (s.distinct_keys || 0) + '">' + fmt(s.distinct_keys) + '</td>' +
          '<td>' + ago(s.last_seen) + '</td>' +
        '</tr>').join('') : '';
      const serverTable = servers.length ?
        '<table><thead><tr><th data-sort="str">서버</th><th data-sort="num">tool 종류</th><th data-sort="num">호출</th><th data-sort="num">오류</th><th data-sort="num">오류율</th><th data-sort="num">고유 키</th><th data-sort="str">마지막</th></tr></thead><tbody>' + serverRows + '</tbody></table>'
        : '<div class="empty">MCP/tool 호출 기록 없음. 클라이언트가 tools/MCP 서버를 사용하면 여기에 집계됩니다.</div>';

      const toolRows = tools.map(t => {
        const sl = t.server_label || '(none)';
        return '<tr>' +
          '<td>' + (t.is_mcp ? '<span class="pill">MCP</span> ' : '') + escapeHTML(t.tool_name) + '<div class="muted">' + escapeHTML(sl) + '</div></td>' +
          '<td data-num="' + (t.definitions || 0) + '">' + fmt(t.definitions) + '</td>' +
          '<td data-num="' + (t.calls || 0) + '">' + fmt(t.calls) + '</td>' +
          '<td data-num="' + (t.results || 0) + '">' + fmt(t.results) + '</td>' +
          '<td data-num="' + (t.errors || 0) + '">' + fmt(t.errors) + '</td>' +
          '<td data-num="' + (t.error_rate || 0) + '">' + (Number(t.error_rate || 0) * 100).toFixed(1) + '%</td>' +
          '<td data-num="' + (t.distinct_keys || 0) + '">' + fmt(t.distinct_keys) + '</td>' +
          '<td><button class="secondary" type="button" onclick="mcpToolRequests(\'' + escapeAttr(sl) + '\',\'' + escapeAttr(t.tool_name) + '\',false)">호출</button> ' +
          (t.errors > 0 ? '<button class="danger" type="button" onclick="mcpToolRequests(\'' + escapeAttr(sl) + '\',\'' + escapeAttr(t.tool_name) + '\',true)">오류</button>' : '') +
          '</td>' +
        '</tr>';
      }).join('');
      const toolTable = tools.length ?
        '<table><thead><tr><th data-sort="str">tool</th><th data-sort="num">정의</th><th data-sort="num">호출</th><th data-sort="num">결과</th><th data-sort="num">오류</th><th data-sort="num">오류율</th><th data-sort="num">고유 키</th><th>드릴다운</th></tr></thead><tbody>' + toolRows + '</tbody></table>'
        : '<div class="empty">tool 기록 없음</div>';

      document.getElementById('view').innerHTML =
        section('MCP / Tool 요약', kpis + filterBar) +
        section('MCP 서버별', serverTable) +
        section('Tool 리더보드', toolTable);

      document.getElementById('mcp-filter').addEventListener('submit', (e) => {
        e.preventDefault();
        const p = new URLSearchParams();
        const k = document.getElementById('mcp-api-key').value.trim();
        const sv = document.getElementById('mcp-server').value.trim();
        if (k) p.set('api_key_id', k);
        if (sv) p.set('server', sv);
        if (document.getElementById('mcp-only').checked) p.set('mcp_only', '1');
        location.hash = '#/mcp' + (p.toString() ? '?' + p.toString() : '');
      });
      makeSortable('#view', 'mcp');
    }
    function errorRatePct(errors, calls) {
      const c = Number(calls || 0);
      if (c === 0) return '호출 없음';
      return (Number(errors || 0) / c * 100).toFixed(1) + '% 오류율';
    }
    window.mcpFilterServer = (server) => {
      location.hash = '#/mcp?server=' + encodeURIComponent(server);
    };
    window.mcpToolRequests = async (server, tool, errorsOnly) => {
      const p = new URLSearchParams();
      if (server && server !== '(none)') p.set('server', server);
      if (tool) p.set('tool', tool);
      if (errorsOnly) p.set('errors', '1');
      p.set('limit', '50');
      try {
        const r = await api('/admin/mcp/requests?' + p.toString());
        const title = (errorsOnly ? '오류 호출' : '호출') + ' - ' + tool;
        openModal(title, requestsTable(r.requests || []));
        attachRequestRowHandlers();
      } catch (err) {
        openModal('오류', '<div class="error-line">' + escapeHTML(err.message) + '</div>');
      }
    };

    // ---------- safety (kill switch + alerts) ----------
    async function renderSafety() {
      const [kill, alerts] = await Promise.all([
        api('/admin/kill-switch'),
        api('/admin/alerts'),
      ]);
      const rules = alerts.rules || [];
      const events = alerts.events || [];

      const killCard = '<div style="padding:14px"><div class="kv">' +
        row('현재 상태', kill.disabled
          ? '<span class="status error">정지 중</span>'
          : '<span class="status">정상 운영</span>') +
        row('사유', escapeHTML(kill.reason || '')) +
        row('변경 시각', kill.updated_at ? (ago(kill.updated_at) + ' <span class="muted">(' + escapeHTML(kill.updated_at) + ')</span>') : '<span class="muted">-</span>') +
        row('변경자', escapeHTML(kill.updated_by || '')) +
        '</div>' +
        '<div style="margin-top:12px; display:flex; gap:8px; align-items:center">' +
          '<input id="kill-reason" placeholder="사유(선택)" style="min-width:240px">' +
          (kill.disabled
            ? '<button id="kill-resume" type="button">정상 운영 재개</button>'
            : '<button id="kill-stop" class="danger" type="button">⚠️ 모든 /v1 호출 즉시 차단</button>') +
        '</div>' +
        '<div class="muted" style="margin-top:8px; font-size:12px">차단 중에는 모든 /v1 호출이 HTTP 503 + Retry-After 60 + X-Kill-Switch=global 헤더로 응답합니다.</div>' +
      '</div>';

      const ruleTable = rules.length ? (
        '<table><thead><tr>' +
          '<th data-sort="str">이름</th><th>지표</th><th>대상</th><th>윈도우</th>' +
          '<th>임계값 / 최근값</th><th>Webhook</th><th>상태</th><th>최근 발화</th><th>동작</th>' +
        '</tr></thead><tbody>' +
        rules.map(r => '<tr>' +
          '<td>' + escapeHTML(r.name) + '<div class="muted">' + escapeHTML(r.note || '') + '</div></td>' +
          '<td>' + metricLabel(r.metric) + '</td>' +
          '<td>' + scopeLabel(r.scope) + '<div class="muted">' + escapeHTML(r.scope_value) + '</div></td>' +
          '<td>' + fmt(r.window_seconds) + '초</td>' +
          '<td>' + formatThreshold(r.metric, r.threshold) + '<div class="muted">최근 ' + (r.last_value ? formatThreshold(r.metric, r.last_value) : '-') + '</div></td>' +
          '<td>' + (r.webhook_url ? '<span class="pill">설정됨</span>' : '<span class="muted">없음 (DB 기록만)</span>') + '</td>' +
          '<td><span class="status ' + (r.enabled ? '' : 'error') + '">' + (r.enabled ? '사용' : '중지') + '</span></td>' +
          '<td>' + (r.last_fired_at ? ago(r.last_fired_at) : '<span class="muted">없음</span>') + '</td>' +
          '<td>' +
            '<button class="secondary" type="button" onclick="toggleAlert(\'' + r.id + '\', ' + (!r.enabled) + ')">' + (r.enabled ? '중지' : '사용') + '</button> ' +
            '<button class="danger" type="button" onclick="deleteAlert(\'' + r.id + '\')">삭제</button>' +
          '</td></tr>').join('') + '</tbody></table>'
      ) : '<div class="empty">설정된 알림 규칙 없음</div>';

      const eventTable = events.length ? (
        '<table><thead><tr><th>시각</th><th>규칙</th><th>지표</th><th>값</th><th>임계값</th><th>전송</th></tr></thead><tbody>' +
        events.map(e => '<tr>' +
          '<td>' + ago(e.created_at) + '</td>' +
          '<td>' + escapeHTML(e.rule_name) + '</td>' +
          '<td>' + metricLabel(e.metric) + '</td>' +
          '<td>' + formatThreshold(e.metric, e.value) + '</td>' +
          '<td>' + formatThreshold(e.metric, e.threshold) + '</td>' +
          '<td>' + (e.delivered ? '<span class="status">성공</span>' : (e.delivery_error ? '<span class="status error" title="' + escapeHTML(e.delivery_error) + '">실패</span>' : '<span class="muted">webhook 없음</span>')) + '</td>' +
          '</tr>').join('') + '</tbody></table>'
      ) : '<div class="empty">발화 이력 없음</div>';

      const html =
        section('긴급 정지 (Kill Switch)', killCard) +
        section('알림 규칙',
          '<form class="inline-form" id="alert-form" style="grid-template-columns: minmax(140px,1fr) 150px 90px 100px 110px minmax(160px,1fr) minmax(150px,1.4fr) 80px;">' +
            '<input id="alert-name" placeholder="이름" required>' +
            '<select id="alert-metric">' +
              '<option value="requests">요청 수</option>' +
              '<option value="errors">오류율(0-1)</option>' +
              '<option value="krw">KRW 비용</option>' +
              '<option value="tokens">토큰</option>' +
              '<option value="latency_p95_ms">전체 지연 P95</option>' +
              '<option value="first_chunk_p95_ms">첫 청크 P95</option>' +
              '<option value="llm_eval_failures">LLM 평가 실패 수</option>' +
              '<option value="llm_eval_failure_rate">LLM 평가 실패율</option>' +
              '<option value="tool_errors">tool 오류 수</option>' +
              '<option value="tool_error_rate">tool 오류율</option>' +
            '</select>' +
            '<select id="alert-scope">' +
              '<option value="global">전체</option>' +
              '<option value="api_key">API 키</option>' +
              '<option value="team">팀</option>' +
              '<option value="ip">IP</option>' +
              '<option value="model">모델</option>' +
            '</select>' +
            '<input id="alert-scope-value" placeholder="대상 (전체는 자동)">' +
            '<input id="alert-window" type="number" min="30" value="300" title="평가 윈도우(초)">' +
            '<input id="alert-threshold" type="number" step="0.01" placeholder="임계값">' +
            '<input id="alert-webhook" placeholder="Slack/웹훅 URL (선택)">' +
            '<button type="submit">추가</button>' +
          '</form>' +
          ruleTable
        ) +
        section('최근 발화 이력', eventTable);

      document.getElementById('view').innerHTML = html;
      const stopBtn = document.getElementById('kill-stop');
      const resumeBtn = document.getElementById('kill-resume');
      if (stopBtn) stopBtn.addEventListener('click', () => toggleKillSwitch(true));
      if (resumeBtn) resumeBtn.addEventListener('click', () => toggleKillSwitch(false));
      document.getElementById('alert-form').addEventListener('submit', addAlert);
      makeSortable('#view', 'safety');
    }

    async function toggleKillSwitch(disable) {
      const reason = (document.getElementById('kill-reason') || {}).value || '';
      if (disable && !confirm('정말로 모든 /v1 호출을 즉시 차단하시겠습니까?')) return;
      await api('/admin/kill-switch', { method: 'POST', body: JSON.stringify({ disabled: disable, reason }) });
      route();
    }

    function metricLabel(metric) {
      return { requests: '요청 수', errors: '오류율', krw: 'KRW 비용', tokens: '토큰', latency_p95_ms: '전체 지연 P95', first_chunk_p95_ms: '첫 청크 P95', llm_eval_failures: 'LLM 평가 실패 수', llm_eval_failure_rate: 'LLM 평가 실패율', tool_errors: 'tool 오류 수', tool_error_rate: 'tool 오류율' }[metric] || metric;
    }
    function formatThreshold(metric, value) {
      if (metric === 'krw') return money(value);
      if (metric === 'errors' || metric === 'llm_eval_failure_rate') return (Number(value) * 100).toFixed(1) + '%';
      if (metric === 'latency_p95_ms' || metric === 'first_chunk_p95_ms') return fmt(Math.round(Number(value))) + ' ms';
      return fmt(Math.round(Number(value)));
    }
    async function addAlert(event) {
      event.preventDefault();
      const scope = document.getElementById('alert-scope').value;
      const body = {
        name: document.getElementById('alert-name').value.trim(),
        metric: document.getElementById('alert-metric').value,
        scope,
        scope_value: scope === 'global' ? '*' : document.getElementById('alert-scope-value').value.trim(),
        window_seconds: Number(document.getElementById('alert-window').value || 300),
        threshold: Number(document.getElementById('alert-threshold').value || 0),
        webhook_url: document.getElementById('alert-webhook').value.trim(),
        enabled: true,
      };
      await api('/admin/alerts', { method: 'POST', body: JSON.stringify(body) });
      route();
    }
    window.toggleAlert = async (id, enabled) => {
      await api('/admin/alerts/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify({ enabled }) });
      route();
    };
    window.deleteAlert = async (id) => {
      if (!confirm('해당 알림 규칙을 삭제하시겠습니까?')) return;
      await api('/admin/alerts/' + encodeURIComponent(id), { method: 'DELETE' });
      route();
    };

    // ---------- settings ----------
    async function renderSettings() {
      const [keys, providers, retention, fallback, audit] = await Promise.all([
        api('/admin/api-keys'),
        api('/admin/providers'),
        api('/admin/retention'),
        api('/admin/fallback'),
        api('/admin/audit-logs?limit=50'),
      ]);

      const html =
        '<div class="grid2">' +
          card('프록시 API 키',
            '<form class="inline-form" id="key-form" autocomplete="off" style="grid-template-columns: repeat(5, minmax(110px, 1fr));">' +
              '<input id="key-name" placeholder="이름" required>' +
              '<input id="key-owner" placeholder="소유자">' +
              '<input id="key-team" placeholder="팀">' +
              '<input id="key-secret-input" type="password" autocomplete="new-password" placeholder="시크릿(선택)">' +
              '<button type="submit">발급</button>' +
            '</form>' +
            '<div id="key-secret" class="secret-once"></div>' +
            apiKeyTable(keys.api_keys || [])
          ) +
          card('업스트림 프로바이더',
            '<form class="inline-form" id="provider-form" autocomplete="off" style="grid-template-columns: 110px minmax(160px, 1.5fr) minmax(120px, 1fr) 100px minmax(140px, 1fr) 80px;">' +
              '<input id="provider-name" placeholder="이름" required>' +
              '<input id="provider-base-url" type="url" placeholder="Base URL" required>' +
              '<input id="provider-api-key" type="password" autocomplete="new-password" placeholder="API 키">' +
              '<input id="provider-timeout" type="number" min="1" placeholder="타임아웃 ms">' +
              '<input id="provider-patterns" placeholder="모델 패턴 (예: claude-*,anthropic/*)">' +
              '<button type="submit">저장</button>' +
            '</form>' +
            providerTable(providers.providers || [])
          ) +
        '</div>' +
        section('데이터 보존 정책', retentionPanel(retention)) +
        section('Fallback 로그 재처리', fallbackPanel(fallback)) +
        section('관리자 변경 이력', auditPanel(audit.audit_logs || []));

      document.getElementById('view').innerHTML = html;
      document.getElementById('key-form').addEventListener('submit', createProxyKey);
      document.getElementById('provider-form').addEventListener('submit', saveProvider);
      const retentionBtn = document.getElementById('retention-run');
      if (retentionBtn) retentionBtn.addEventListener('click', runRetention);
      const fallbackBtn = document.getElementById('fallback-replay');
      if (fallbackBtn) fallbackBtn.addEventListener('click', replayFallback);
      const auditCsv = document.getElementById('audit-csv');
      if (auditCsv) auditCsv.addEventListener('click', async () => {
        const res = await fetch('/admin/audit-logs.csv?limit=5000', { headers: headers() });
        if (!res.ok) { alert('감사 CSV 다운로드 실패: ' + (await res.text())); return; }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = 'audit-' + new Date().toISOString().replace(/[:.]/g, '-') + '.csv';
        document.body.appendChild(a); a.click(); a.remove();
        URL.revokeObjectURL(url);
      });
      makeSortable('#view', 'settings');
    }
    function apiKeyTable(rows) {
      if (!rows.length) return '<div class="empty">발급된 키 없음</div>';
      return '<table><thead><tr>' +
        '<th data-sort="str">이름</th>' +
        '<th data-sort="str">소유자</th>' +
        '<th data-sort="str">팀</th>' +
        '<th data-sort="str">상태</th>' +
        '<th>동작</th></tr></thead><tbody>' +
        rows.map(r =>
          '<tr><td><a href="#/users/' + encodeURIComponent(r.id) + '">' + escapeHTML(r.name) + '</a><div class="muted">' + escapeHTML(r.id) + '</div></td>' +
          '<td>' + escapeHTML(r.owner || '') + '</td><td>' + escapeHTML(r.team || '') + '</td>' +
          '<td><span class="status ' + (r.status === 'active' ? '' : 'error') + '">' + (r.status === 'active' ? '활성' : '비활성') + '</span></td>' +
          '<td><button class="secondary" type="button" onclick="setKeyStatus(\'' + r.id + '\', \'' + (r.status === 'active' ? 'disabled' : 'active') + '\')">' + (r.status === 'active' ? '비활성화' : '활성화') + '</button></td></tr>'
        ).join('') + '</tbody></table>';
    }
    function providerTable(rows) {
      if (!rows.length) return '<div class="empty">등록된 프로바이더 없음</div>';
      return '<table><thead><tr>' +
        '<th data-sort="str">이름</th>' +
        '<th data-sort="str">Base URL</th>' +
        '<th data-sort="str">키</th>' +
        '<th data-sort="num">타임아웃</th>' +
        '<th>모델 패턴</th>' +
        '<th data-sort="str">상태</th>' +
        '<th>동작</th></tr></thead><tbody>' +
        rows.map(r => '<tr><td>' + escapeHTML(r.name) + '</td><td>' + escapeHTML(r.base_url) + '</td>' +
          '<td>' + (r.api_key_configured ? '설정됨' : '미설정') + '</td>' +
          '<td data-num="' + (r.timeout_ms || 0) + '">' + fmt(r.timeout_ms) + ' ms</td>' +
          '<td>' + (r.model_patterns ? '<span class="pill">' + escapeHTML(r.model_patterns) + '</span>' : '<span class="muted">자동 라우팅 없음</span>') + '</td>' +
          '<td><span class="status ' + (r.enabled ? '' : 'error') + '">' + (r.enabled ? '사용' : '중지') + '</span></td>' +
          '<td><button class="danger" type="button" onclick="deleteProvider(\'' + r.name + '\')">삭제</button></td></tr>').join('') +
        '</tbody></table>';
    }
    function retentionPanel(s) {
      return '<div style="padding:14px"><div class="kv">' +
        row('요청 보존', fmt(s.request_days) + ' 일') +
        row('프롬프트 보존', fmt(s.prompt_days) + ' 일') +
        row('응답 보존', fmt(s.response_days) + ' 일') +
        row('현재 요청 수', fmt(s.requests)) +
        row('현재 프롬프트 수', fmt(s.prompts)) +
        row('현재 응답 수', fmt(s.responses)) +
        row('마지막 정리 실행', s.last_run_at ? ago(s.last_run_at) : '<span class="muted">아직 없음</span>') +
        row('누적 삭제 행', fmt(s.last_deleted)) +
      '</div><div style="margin-top:10px"><button id="retention-run" class="secondary" type="button">지금 정리 실행</button></div></div>';
    }
    function fallbackPanel(s) {
      return '<div style="padding:14px"><div class="kv">' +
        row('파일 경로', escapeHTML(s.path || '')) +
        row('파일 존재', s.exists ? '있음' : '<span class="muted">없음</span>') +
        row('대기 라인', fmt(s.lines || 0)) +
        row('파일 크기', fmt(s.bytes || 0) + ' bytes') +
        row('마지막 변경', s.modified_at ? ago(s.modified_at) : '<span class="muted">-</span>') +
      '</div><div style="margin-top:10px"><button id="fallback-replay" class="secondary" type="button">DB로 재처리</button></div></div>';
    }
    function auditPanel(rows) {
      const csvBtn = '<div class="toolbar" style="border-bottom:0; justify-content:flex-end"><button type="button" id="audit-csv" class="secondary">감사 로그 CSV 다운로드</button></div>';
      if (!rows.length) return csvBtn + '<div class="empty">관리자 변경 이력 없음</div>';
      return csvBtn + '<table><thead><tr>' +
        '<th data-sort="str">동작</th>' +
        '<th data-sort="str">관리자</th>' +
        '<th>변경 후</th>' +
        '<th data-sort="str">시간</th></tr></thead><tbody>' +
        rows.map(r => '<tr><td>' + escapeHTML(r.action) + '</td><td>' + escapeHTML(r.admin_id) + '</td><td>' + escapeHTML(r.after_value) + '</td><td>' + ago(r.created_at) + '</td></tr>').join('') +
        '</tbody></table>';
    }

    async function createProxyKey(event) {
      event.preventDefault();
      const body = {
        name: document.getElementById('key-name').value.trim(),
        owner: document.getElementById('key-owner').value.trim(),
        team: document.getElementById('key-team').value.trim(),
        key: document.getElementById('key-secret-input').value.trim()
      };
      const result = await api('/admin/api-keys', { method: 'POST', body: JSON.stringify(body) });
      const secret = document.getElementById('key-secret');
      secret.style.display = 'block';
      secret.textContent = '발급된 시크릿(한 번만 표시): ' + result.secret;
      route();
    }
    window.setKeyStatus = async (id, status) => {
      await api('/admin/api-keys/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify({ status }) });
      route();
    };
    async function saveProvider(event) {
      event.preventDefault();
      const timeout = Number(document.getElementById('provider-timeout').value || 0);
      const body = {
        name: document.getElementById('provider-name').value.trim(),
        base_url: document.getElementById('provider-base-url').value.trim(),
        api_key: document.getElementById('provider-api-key').value.trim(),
        timeout_ms: timeout,
        model_patterns: document.getElementById('provider-patterns').value.trim(),
        enabled: true
      };
      await api('/admin/providers', { method: 'POST', body: JSON.stringify(body) });
      route();
    }
    window.deleteProvider = async (name) => {
      if (!confirm('프로바이더 "' + name + '"을(를) 삭제하시겠습니까?')) return;
      try {
        await api('/admin/providers/' + encodeURIComponent(name), { method: 'DELETE' });
        route();
      } catch (err) {
        alert('삭제 실패: ' + err.message);
      }
    };
    async function runRetention() {
      await api('/admin/retention', { method: 'POST' });
      route();
    }
    async function replayFallback() {
      const result = await api('/admin/fallback', { method: 'POST' });
      alert('재처리 완료: imported=' + fmt(result.imported) + ', duplicates=' + fmt(result.duplicates) + ', failed=' + fmt(result.failed));
      route();
    }

    // ---------- keyboard ----------
    const tabMap = { d: 'dashboard', l: 'llm', c: 'mcp', r: 'requests', p: 'prompts', u: 'users', m: 'teams', i: 'ips', q: 'quotas', a: 'safety', s: 'settings' };
    let gPending = false;
    let gTimer = null;
    function isTyping(target) {
      const t = (target && target.tagName) || '';
      return t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT' || (target && target.isContentEditable);
    }
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeModal();
        gPending = false;
        return;
      }
      if (isTyping(e.target)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      if (e.key === '?') { e.preventDefault(); openHelp(); return; }
      if (e.key === '/') {
        e.preventDefault();
        const target =
          document.getElementById('p-keyword') ||
          document.getElementById('f-ip') ||
          document.getElementById('token');
        target && target.focus();
        return;
      }
      if (e.key === 't') { e.preventDefault(); document.getElementById('theme-toggle').click(); return; }
      if (e.key === 'r') { e.preventDefault(); route(); return; }

      if (e.key === 'g') {
        gPending = true;
        clearTimeout(gTimer);
        gTimer = setTimeout(() => { gPending = false; }, 1200);
        return;
      }
      if (gPending && tabMap[e.key]) {
        e.preventDefault();
        location.hash = '#/' + tabMap[e.key];
        gPending = false;
      }
    });

    function openHelp() {
      openModal('단축키 도움말', helpHTML());
    }
    function helpHTML() {
      const pairs = [
        ['<kbd>?</kbd>', '단축키 도움말 열기'],
        ['<kbd>/</kbd>', '검색 입력 포커스'],
        ['<kbd>t</kbd>', '다크 모드 토글'],
        ['<kbd>r</kbd>', '현재 페이지 다시 불러오기'],
        ['<kbd>Esc</kbd>', '모달/오버레이 닫기'],
        ['<kbd>g</kbd> <kbd>d</kbd>', '대시보드'],
        ['<kbd>g</kbd> <kbd>l</kbd>', 'LLM 관측'],
        ['<kbd>g</kbd> <kbd>c</kbd>', 'MCP'],
        ['<kbd>g</kbd> <kbd>r</kbd>', '호출 이력'],
        ['<kbd>g</kbd> <kbd>p</kbd>', '프롬프트 검색'],
        ['<kbd>g</kbd> <kbd>u</kbd>', '사용자 목록'],
        ['<kbd>g</kbd> <kbd>m</kbd>', '팀 목록'],
        ['<kbd>g</kbd> <kbd>i</kbd>', 'IP 목록'],
        ['<kbd>g</kbd> <kbd>q</kbd>', '사용 한도'],
        ['<kbd>g</kbd> <kbd>a</kbd>', '안전 (Kill Switch / 알림)'],
        ['<kbd>g</kbd> <kbd>s</kbd>', '설정'],
      ];
      return '<div class="help-grid">' +
        pairs.map(p => '<div>' + p[0] + '</div><div>' + p[1] + '</div>').join('') +
        '</div><p class="muted" style="margin-top:14px">표 헤더를 클릭하면 정렬할 수 있고, 시간 표시에 마우스를 올리면 절대 시각이 표시됩니다.</p>';
    }
    document.getElementById('help-toggle').addEventListener('click', openHelp);

    route();
  </script>
</body>
</html>`
