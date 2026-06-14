package proxy

const adminHTML = `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AI 게이트웨이</title>
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
    .banner { padding: 12px 14px; border-radius: 8px; font-size: 13px; line-height: 1.5; border: 1px solid var(--line); color: var(--ink); }
    .banner.warn { background: var(--warn-bg); border-color: var(--warn); }
    .banner.error { background: var(--bad-bg); border-color: var(--bad); }
    .banner code { font-size: 12px; padding: 1px 4px; border-radius: 4px; background: var(--pill-bg); }
    .prompt { max-height: 80px; overflow: hidden; color: var(--ink); white-space: pre-wrap; }
    .pill { display: inline-block; padding: 2px 8px; border-radius: 999px; background: var(--pill-bg); color: var(--ink); font-size: 12px; }

    .modal-backdrop {
      position: fixed; inset: 0; background: rgba(15,23,42,0.55);
      display: none; align-items: flex-start; justify-content: center;
      z-index: 10; padding: 32px;
    }
    .modal-backdrop.open { display: flex; }
    .login-backdrop {
      position: fixed; inset: 0; background: var(--bg, #f4f6fa);
      display: none; align-items: center; justify-content: center; z-index: 50;
    }
    .login-backdrop.open { display: flex; }
    .login-card {
      width: min(380px, 92vw); background: var(--panel); border: 1px solid var(--line);
      border-radius: 12px; padding: 28px; box-shadow: 0 8px 30px rgba(15,23,42,0.12);
    }
    .login-card h2 { margin: 0 0 4px; font-size: 18px; }
    .login-card .sub { color: var(--muted); font-size: 13px; margin-bottom: 18px; }
    .login-card label { display: block; font-size: 12px; font-weight: 700; color: var(--muted); margin: 12px 0 4px; }
    .login-card input { width: 100%; box-sizing: border-box; }
    .login-card button[type="submit"] { width: 100%; margin-top: 18px; height: 38px; }
    .login-card .error-line { padding: 8px 0 0; font-size: 13px; }
    .user-chip {
      display: none; align-items: center; gap: 6px; padding: 4px 10px;
      border: 1px solid var(--line); border-radius: 999px; font-size: 12px; color: var(--ink);
      background: var(--pill-bg); white-space: nowrap;
    }
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
    <h1>AI 게이트웨이</h1>
    <nav id="tabs">
      <a href="#/dashboard" data-tab="dashboard" class="active">대시보드</a>
      <a href="#/xview" data-tab="xview">XView</a>
      <a href="#/waterfall" data-tab="waterfall">Waterfall</a>
      <a href="#/llm" data-tab="llm">LLM 관측</a>
      <a href="#/mcp" data-tab="mcp">MCP</a>
      <a href="#/agents" data-tab="agents">에이전트</a>
      <a href="#/vcs" data-tab="vcs">VCS</a>
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
      <span id="auth-user" class="user-chip"></span>
      <button id="auth-logout" class="ghost" type="button" style="display:none" title="로그아웃">로그아웃</button>
      <input id="token" type="password" autocomplete="off" placeholder="관리자 토큰">
    </div>
  </header>
  <main>
    <div id="view"></div>
  </main>

  <div id="login-backdrop" class="login-backdrop">
    <form class="login-card" id="login-form" autocomplete="on">
      <h2>관리자 로그인</h2>
      <div class="sub">AI 게이트웨이 어드민</div>
      <label for="login-email">이메일</label>
      <input id="login-email" type="email" autocomplete="username" placeholder="admin@company.com" required>
      <label for="login-password">비밀번호</label>
      <input id="login-password" type="password" autocomplete="current-password" placeholder="••••••••" required>
      <div id="login-error" class="error-line" style="display:none"></div>
      <button type="submit" id="login-submit">로그인</button>
    </form>
  </div>

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

    // ---------- token (legacy ADMIN_TOKEN mode) ----------
    const tokenInput = document.getElementById('token');
    tokenInput.value = sessionStorage.getItem('adminToken') || '';
    tokenInput.addEventListener('change', () => {
      sessionStorage.setItem('adminToken', tokenInput.value);
      route();
    });

    // ---------- auth (AUTH_ENABLED: email/password → JWT) ----------
    const authState = {
      enabled: false,
      access: sessionStorage.getItem('authAccess') || '',
      refresh: sessionStorage.getItem('authRefresh') || '',
      user: JSON.parse(sessionStorage.getItem('authUser') || 'null'),
    };
    function saveAuth(tokens) {
      authState.access = tokens.access_token || '';
      authState.refresh = tokens.refresh_token || '';
      if (tokens.user) authState.user = tokens.user;
      sessionStorage.setItem('authAccess', authState.access);
      sessionStorage.setItem('authRefresh', authState.refresh);
      if (authState.user) sessionStorage.setItem('authUser', JSON.stringify(authState.user));
    }
    function clearAuth() {
      authState.access = ''; authState.refresh = ''; authState.user = null;
      sessionStorage.removeItem('authAccess');
      sessionStorage.removeItem('authRefresh');
      sessionStorage.removeItem('authUser');
    }
    function renderAuthHeader() {
      const chip = document.getElementById('auth-user');
      const logoutBtn = document.getElementById('auth-logout');
      if (authState.enabled) {
        tokenInput.style.display = 'none'; // JWT 모드: 수동 토큰 입력 숨김
        if (authState.user) {
          chip.style.display = 'inline-flex';
          const loginId = (authState.user.email || '').split('@')[0];
          chip.textContent = loginId + ' · ' + (authState.user.role || '');
          chip.title = authState.user.email || ''; // 전체 이메일은 hover로
          logoutBtn.style.display = 'inline-block';
        } else {
          chip.style.display = 'none';
          logoutBtn.style.display = 'none';
        }
      } else {
        tokenInput.style.display = '';
        chip.style.display = 'none';
        logoutBtn.style.display = 'none';
      }
    }
    function showLogin(message) {
      renderAuthHeader();
      const err = document.getElementById('login-error');
      if (message) { err.textContent = message; err.style.display = 'block'; }
      else { err.style.display = 'none'; }
      document.getElementById('login-backdrop').classList.add('open');
      setTimeout(() => document.getElementById('login-email').focus(), 50);
    }
    function hideLogin() {
      document.getElementById('login-backdrop').classList.remove('open');
    }
    async function tryRefresh() {
      if (!authState.refresh) return false;
      try {
        const res = await fetch('/auth/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token: authState.refresh }),
        });
        if (!res.ok) return false;
        saveAuth(await res.json()); // rotation: 새 access + 새 refresh 저장
        return true;
      } catch { return false; }
    }
    document.getElementById('login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = document.getElementById('login-submit');
      const err = document.getElementById('login-error');
      btn.disabled = true; btn.textContent = '로그인 중…'; err.style.display = 'none';
      try {
        const res = await fetch('/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: document.getElementById('login-email').value.trim(),
            password: document.getElementById('login-password').value,
          }),
        });
        if (!res.ok) {
          err.textContent = res.status === 401 ? '이메일 또는 비밀번호가 올바르지 않습니다.' : '로그인 실패 (' + res.status + ')';
          err.style.display = 'block';
          return;
        }
        saveAuth(await res.json());
        document.getElementById('login-password').value = '';
        hideLogin();
        renderAuthHeader();
        route();
      } catch (ex) {
        err.textContent = '로그인 실패: ' + ex.message;
        err.style.display = 'block';
      } finally {
        btn.disabled = false; btn.textContent = '로그인';
      }
    });
    document.getElementById('auth-logout').addEventListener('click', async () => {
      try {
        await fetch('/auth/logout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + authState.access },
          body: JSON.stringify({ refresh_token: authState.refresh }),
        });
      } catch {}
      clearAuth();
      renderAuthHeader();
      showLogin();
    });
    // 부팅 동선: 인증 모드 감지 → 세션 복원/리프레시 → 즉시 로그인 화면 또는 대시보드
    async function initAuth() {
      try {
        const h = authState.access ? { Authorization: 'Bearer ' + authState.access } : {};
        const res = await fetch('/auth/me', { headers: h });
        if (res.ok) {
          const me = await res.json();
          authState.enabled = !!me.auth_enabled;
          if (me.user) { authState.user = me.user; sessionStorage.setItem('authUser', JSON.stringify(me.user)); }
          renderAuthHeader();
          route();
          return;
        }
        if (res.status === 401) { // 인증 모드인데 access 만료/없음 → 조용히 refresh 시도
          authState.enabled = true;
          if (await tryRefresh()) { renderAuthHeader(); route(); return; }
          clearAuth();
          showLogin();
          return;
        }
      } catch {}
      // /auth/me 자체가 실패해도 화면은 띄움 (레거시 모드 가정)
      renderAuthHeader();
      route();
    }

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
      if (authState.enabled) {
        if (authState.access) h.Authorization = 'Bearer ' + authState.access;
        return h;
      }
      const token = tokenInput.value.trim();
      if (token) h.Authorization = 'Bearer ' + token;
      return h;
    }
    async function api(path, options = {}) {
      const doFetch = () => {
        const requestHeaders = headers();
        if (options.body) requestHeaders['Content-Type'] = 'application/json';
        return fetch(path, { ...options, headers: requestHeaders });
      };
      let res = await doFetch();
      // JWT 모드: access 만료 시 refresh 회전 후 1회 재시도, 실패하면 재로그인 유도
      if (res.status === 401 && authState.enabled) {
        if (await tryRefresh()) {
          res = await doFetch();
        } else {
          clearAuth();
          showLogin('세션이 만료되었습니다. 다시 로그인해주세요.');
          throw new Error('세션 만료');
        }
      }
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
          case 'xview':     await renderXView(params); break;
          case 'waterfall': await renderWaterfall(params); break;
          case 'llm':       await renderLLMObservability(); break;
          case 'requests':  await renderRequestsView(params); break;
          case 'prompts':   await renderPromptsView(params); break;
          case 'users':     rest.length ? await renderUserDetail(rest.join('/')) : await renderUsers(); break;
          case 'teams':     rest.length ? await renderTeamDetail(decodeURIComponent(rest.join('/'))) : await renderTeams(); break;
          case 'ips':       rest.length ? await renderIPDetail(decodeURIComponent(rest.join('/'))) : await renderIPs(); break;
          case 'quotas':    await renderQuotas(); break;
          case 'mcp':       await renderMCP(params); break;
          case 'agents':    await renderAgents(params); break;
          case 'vcs':       await renderVCS(params); break;
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

    // ---------- XView (transaction scatter plot) ----------
    const xviewState = {
      window: sessionStorage.getItem('xviewWindow') || '1h',
      scale: sessionStorage.getItem('xviewScale') || 'log',
      metric: sessionStorage.getItem('xviewMetric') || 'latency',
    };
    function xviewCategory(p) {
      // priority: error > kill/blocked > cache > failover > high-cost > normal
      if (p.status_code >= 400) return 'error';
      if (p.policy_decision_count || p.approval_count || p.secret_event_count) return 'governance';
      if (p.provider === 'cache') return 'cache';
      if (p.failover) return 'failover';
      if ((p.risk_score || 0) >= 60) return 'complex';
      if ((p.total_tokens || 0) >= xviewState.complexityTokens) return 'complex';
      return 'normal';
    }
    const xviewColors = {
      error:   { c: '#ef4444', label: '오류' },
      governance: { c: '#f97316', label: '거버넌스' },
      cache:   { c: '#22c55e', label: '캐시 히트' },
      failover:{ c: '#eab308', label: '폴백' },
      complex: { c: '#a855f7', label: '고비용/복잡' },
      normal:  { c: '#3b82f6', label: '정상' },
    };

    async function renderXView(initial) {
      if (initial) {
        if (initial.get('window')) xviewState.window = initial.get('window');
        if (initial.get('metric')) xviewState.metric = initial.get('metric');
      }
      const params = new URLSearchParams();
      params.set('window', xviewState.window);
      const model = initial ? (initial.get('model') || '') : '';
      const endpoint = initial ? (initial.get('endpoint') || '') : '';
      if (model) params.set('model', model);
      if (endpoint) params.set('endpoint', endpoint);
      params.set('limit', '6000');

      const data = await api('/admin/scatter?' + params.toString());
      const points = data.points || [];
      // complexity threshold = 90th percentile of tokens (so "high" is relative), min 4000
      const tokenVals = points.map(p => p.total_tokens || 0).filter(v => v > 0).sort((a, b) => a - b);
      xviewState.complexityTokens = Math.max(4000, tokenVals.length ? tokenVals[Math.floor(tokenVals.length * 0.9)] : 4000);

      const view = document.getElementById('view');
      view.innerHTML = section('XView — 트랜잭션 응답시간 분포',
        '<div class="toolbar">' +
          '<select id="xv-window">' +
            ['5m','15m','1h','6h','24h'].map(wd => '<option value="' + wd + '"' + (xviewState.window === wd ? ' selected' : '') + '>' + wd + '</option>').join('') +
          '</select>' +
          '<select id="xv-metric">' +
            '<option value="latency"' + (xviewState.metric === 'latency' ? ' selected' : '') + '>전체 응답시간</option>' +
            '<option value="first_chunk"' + (xviewState.metric === 'first_chunk' ? ' selected' : '') + '>첫 청크 지연</option>' +
          '</select>' +
          '<select id="xv-scale">' +
            '<option value="log"' + (xviewState.scale === 'log' ? ' selected' : '') + '>로그 스케일</option>' +
            '<option value="linear"' + (xviewState.scale === 'linear' ? ' selected' : '') + '>선형 스케일</option>' +
          '</select>' +
          '<input id="xv-model" placeholder="모델 필터" value="' + escapeHTML(model) + '">' +
          '<input id="xv-endpoint" placeholder="endpoint 필터" value="' + escapeHTML(endpoint) + '">' +
          '<button id="xv-apply" type="submit">적용</button>' +
          '<span class="muted">' + fmt(points.length) + '건' + (data.truncated ? ' (최근 6000건으로 제한됨)' : '') + '</span>' +
        '</div>' +
        '<div id="xv-chart" style="padding:14px"></div>' +
        '<div id="xv-legend" style="padding:0 14px 14px"></div>'
      );
      drawScatter(points);

      const apply = () => {
        xviewState.window = document.getElementById('xv-window').value;
        xviewState.metric = document.getElementById('xv-metric').value;
        xviewState.scale = document.getElementById('xv-scale').value;
        sessionStorage.setItem('xviewWindow', xviewState.window);
        sessionStorage.setItem('xviewMetric', xviewState.metric);
        sessionStorage.setItem('xviewScale', xviewState.scale);
        const p = new URLSearchParams();
        p.set('window', xviewState.window);
        p.set('metric', xviewState.metric);
        const m = document.getElementById('xv-model').value.trim();
        const e = document.getElementById('xv-endpoint').value.trim();
        if (m) p.set('model', m);
        if (e) p.set('endpoint', e);
        location.hash = '#/xview?' + p.toString();
      };
      document.getElementById('xv-apply').addEventListener('click', apply);
      ['xv-window', 'xv-metric', 'xv-scale'].forEach(id => document.getElementById(id).addEventListener('change', apply));
    }

    function drawScatter(points) {
      const host = document.getElementById('xv-chart');
      if (!points.length) { host.innerHTML = '<div class="empty">해당 구간에 요청 없음</div>'; return; }
      const yField = xviewState.metric === 'first_chunk' ? 'first_chunk_ms' : 'latency_ms';
      const W = 1000, H = 420, padL = 64, padR = 16, padT = 14, padB = 34;
      const innerW = W - padL - padR, innerH = H - padT - padB;

      const times = points.map(p => Date.parse(p.created_at)).filter(t => !isNaN(t));
      const tMin = Math.min(...times), tMax = Math.max(...times);
      const tSpan = Math.max(1, tMax - tMin);
      const yMaxRaw = Math.max(1, ...points.map(p => p[yField] || 0));
      const logScale = xviewState.scale === 'log';
      const yMin = logScale ? 1 : 0;
      const yMax = yMaxRaw;
      const yPos = v => {
        v = Math.max(yMin, v || 0);
        if (logScale) {
          const lo = Math.log10(Math.max(1, yMin)), hi = Math.log10(Math.max(10, yMax));
          return padT + innerH - ((Math.log10(v) - lo) / (hi - lo)) * innerH;
        }
        return padT + innerH - (v / yMax) * innerH;
      };
      const xPos = t => padL + ((t - tMin) / tSpan) * innerW;

      // y gridlines (ms markers)
      const yTicks = logScale ? [1, 10, 100, 500, 1000, 2000, 5000, 10000, 30000].filter(v => v <= yMax * 1.2)
                              : [0, yMax * 0.25, yMax * 0.5, yMax * 0.75, yMax];
      const grid = yTicks.map(v => {
        const y = yPos(v);
        return '<line x1="' + padL + '" y1="' + y.toFixed(1) + '" x2="' + (W - padR) + '" y2="' + y.toFixed(1) + '" stroke="var(--line)" stroke-dasharray="2 3"/>' +
          '<text x="' + (padL - 6) + '" y="' + (y + 3).toFixed(1) + '" text-anchor="end" font-size="10" fill="currentColor" opacity="0.6">' + msLabel(v) + '</text>';
      }).join('');

      // x time labels
      const xLabels = [0, 0.25, 0.5, 0.75, 1].map(f => {
        const t = tMin + tSpan * f, x = xPos(t);
        const d = new Date(t);
        const hh = String(d.getHours()).padStart(2, '0'), mm = String(d.getMinutes()).padStart(2, '0'), ss = String(d.getSeconds()).padStart(2, '0');
        return '<text x="' + x.toFixed(1) + '" y="' + (H - 10) + '" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.6">' + hh + ':' + mm + ':' + ss + '</text>';
      }).join('');

      // percentile reference lines (on the chosen metric)
      const sorted = points.map(p => p[yField] || 0).sort((a, b) => a - b);
      const pct = q => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q))];
      const p50 = pct(0.5), p95 = pct(0.95), p99 = pct(0.99);
      const pctLine = (v, label, color) => {
        const y = yPos(v);
        return '<line x1="' + padL + '" y1="' + y.toFixed(1) + '" x2="' + (W - padR) + '" y2="' + y.toFixed(1) + '" stroke="' + color + '" stroke-width="1" stroke-opacity="0.7"/>' +
          '<text x="' + (W - padR) + '" y="' + (y - 3).toFixed(1) + '" text-anchor="end" font-size="10" fill="' + color + '">' + label + ' ' + msLabel(v) + '</text>';
      };

      // dots
      const dots = points.map((p, i) => {
        const cat = xviewCategory(p);
        const col = xviewColors[cat].c;
        const t = Date.parse(p.created_at);
        if (isNaN(t)) return '';
        const cx = xPos(t).toFixed(1), cy = yPos(p[yField] || 0).toFixed(1);
        const gov = (p.policy_decision_count || p.approval_count || p.secret_event_count)
          ? ' · policy ' + fmt(p.policy_decision_count || 0) + (p.policy_decision ? '(' + p.policy_decision + ')' : '') +
            ' · approval ' + fmt(p.approval_count || 0) + (p.approval_status ? '(' + p.approval_status + ')' : '') +
            ' · secret ' + fmt(p.secret_event_count || 0) + (p.secret_action ? '(' + p.secret_action + ')' : '')
          : '';
        const tip = (p.model || '?') + ' · ' + (p.provider || '?') + ' · ' + msLabel(p[yField] || 0) +
          ' · complexity ' + fmt(p.complexity || 0) + ' · risk ' + fmt(p.risk_score || 0) +
          ' · health ' + fmt(p.health_score || 0) + ' · ' + fmt(p.total_tokens) + 'tok · ' + money(p.cost_krw) + ' · ' + (p.status_code) +
          gov + ' · ' + new Date(t).toLocaleTimeString('ko-KR');
        return '<circle class="xv-dot" data-rid="' + escapeHTML(p.request_id) + '" cx="' + cx + '" cy="' + cy + '" r="3.2" fill="' + col + '" fill-opacity="0.72" stroke="' + col + '" stroke-opacity="0.9"><title>' + escapeHTML(tip) + '</title></circle>';
      }).join('');

      host.innerHTML = '<svg id="xv-svg" viewBox="0 0 ' + W + ' ' + H + '" width="100%" height="' + H + '" style="color:var(--ink); cursor:crosshair">' +
        grid +
        '<line x1="' + padL + '" y1="' + (padT + innerH) + '" x2="' + (W - padR) + '" y2="' + (padT + innerH) + '" stroke="var(--line-strong)"/>' +
        '<line x1="' + padL + '" y1="' + padT + '" x2="' + padL + '" y2="' + (padT + innerH) + '" stroke="var(--line-strong)"/>' +
        pctLine(p99, 'P99', 'var(--bad)') + pctLine(p95, 'P95', 'var(--warn)') + pctLine(p50, 'P50', 'var(--muted)') +
        dots + xLabels +
        '</svg>';

      // legend with live counts
      const counts = { error: 0, governance: 0, cache: 0, failover: 0, complex: 0, normal: 0 };
      points.forEach(p => counts[xviewCategory(p)]++);
      document.getElementById('xv-legend').innerHTML =
        '<div style="display:flex; gap:16px; flex-wrap:wrap; align-items:center">' +
        Object.keys(xviewColors).map(k =>
          '<span style="display:inline-flex; align-items:center; gap:6px"><span style="width:10px;height:10px;border-radius:50%;background:' + xviewColors[k].c + '"></span>' +
          xviewColors[k].label + ' <span class="muted">' + fmt(counts[k]) + '</span></span>').join('') +
        '<span class="muted" style="margin-left:auto">점을 클릭하면 요청 상세, 가로=시간 / 세로=' + (xviewState.metric === 'first_chunk' ? '첫 청크 지연' : '응답시간') + '</span>' +
        '</div>';

      // click → explainability panel (why was this handled this way)
      host.querySelectorAll('.xv-dot').forEach(dot => {
        dot.addEventListener('click', () => openExplain(dot.getAttribute('data-rid')));
      });
    }

    // ---------- Waterfall View (transaction trace) ----------
    const waterfallColors = {
      error:    { c: '#ef4444', label: '오류' },
      fallback: { c: '#eab308', label: '폴백' },
      cache:    { c: '#22c55e', label: '캐시 히트' },
      complex:  { c: '#a855f7', label: '고복잡도' },
      normal:   { c: '#3b82f6', label: '정상' },
    };
    window.openWaterfall = (sessionID) => {
      location.hash = '#/waterfall?session_id=' + encodeURIComponent(sessionID || 'no-session');
    };
    const wfState = { trace: null, sessionID: '', hidden: {}, slowMs: 0 };
    let wfResizeBound = false;
    async function renderWaterfall(initial) {
      const sessionID = initial ? (initial.get('session_id') || '') : '';
      const view = document.getElementById('view');
      if (!sessionID) {
        const data = await api('/admin/llm/sessions?limit=100');
        const rows = data.sessions || [];
        const picker = rows.length ? (
          '<table><thead><tr><th data-sort="str">세션</th><th data-sort="num">요청</th><th data-sort="num">토큰</th><th data-sort="num">비용</th><th data-sort="num">오류</th><th data-sort="str">최근</th><th>워터폴</th></tr></thead><tbody>' +
          rows.map(s => '<tr>' +
            '<td>' + escapeHTML(s.session_id || 'no-session') + '</td>' +
            '<td data-num="' + (s.requests || 0) + '">' + fmt(s.requests || 0) + '</td>' +
            '<td data-num="' + (s.tokens || 0) + '">' + fmt(s.tokens || 0) + '</td>' +
            '<td data-num="' + (s.cost_krw || 0) + '">' + money(s.cost_krw || 0) + '</td>' +
            '<td data-num="' + (s.errors || 0) + '">' + fmt(s.errors || 0) + '</td>' +
            '<td>' + ago(s.last_seen) + '</td>' +
            '<td><button class="secondary" type="button" onclick="openWaterfall(\'' + escapeAttr(s.session_id || 'no-session') + '\')">보기</button></td>' +
          '</tr>').join('') + '</tbody></table>'
        ) : '<div class="empty">세션 없음</div>';
        view.innerHTML = section('Waterfall — 세션 선택',
          '<div style="padding:16px 18px 20px">' +
          '<p class="muted" style="margin:0 0 16px 2px; line-height:1.7">트랜잭션(요청)을 시간순 워터폴로 펼쳐 봅니다. 세션을 고르면 각 요청의 시작 시점 · 첫 응답 대기(TTFB) · 스트리밍 수신 구간과, 요청 사이의 대기(생각) 시간을 한 줄씩 막대로 보여줍니다.</p>' +
          picker + '</div>');
        makeSortable('#view', 'wf-sessions');
        return;
      }
      if (wfState.sessionID !== sessionID) wfState.hidden = {}; // reset filters on session switch
      wfState.sessionID = sessionID;
      const qs = '?session_id=' + encodeURIComponent(sessionID) + '&limit=500' + (wfState.slowMs > 0 ? '&slow_ms=' + wfState.slowMs : '');
      const trace = await api('/admin/waterfall' + qs);
      wfState.trace = trace;
      view.innerHTML = section('Waterfall — ' + escapeHTML(sessionID),
        '<div class="toolbar">' +
          '<button class="secondary" type="button" onclick="location.hash=\'#/waterfall\'">← 세션 목록</button>' +
          '<button class="secondary" type="button" onclick="openSessionTimeline(\'' + escapeAttr(sessionID) + '\')">비용 타임라인</button>' +
          '<label class="muted" style="display:inline-flex; align-items:center; gap:6px">느림 기준(ms) <input id="wf-slow" type="number" min="0" step="500" value="' + (wfState.slowMs || '') + '" placeholder="' + fmt(trace.slow_ms) + ' 자동" style="width:110px"></label>' +
          '<button class="secondary" type="button" onclick="wfExportCSV()">CSV 내보내기</button>' +
          '<span class="muted" style="margin-left:auto">' + (trace.truncated ? '※ 최대 500개 요청만 표시' : (fmt(trace.requests) + '개 요청')) + '</span>' +
        '</div>' +
        '<div id="wf-body" style="padding:16px 18px 20px"></div>');
      const slowInput = document.getElementById('wf-slow');
      if (slowInput) slowInput.addEventListener('change', () => { wfState.slowMs = Number(slowInput.value || 0); renderWaterfall(initial); });
      wfRenderBody();
      if (!wfResizeBound) {
        wfResizeBound = true;
        let rt;
        window.addEventListener('resize', () => {
          clearTimeout(rt);
          rt = setTimeout(() => {
            if ((location.hash || '').indexOf('#/waterfall') === 0 && wfState.trace && document.getElementById('wf-body')) wfRenderBody();
          }, 200);
        });
      }
    }
    function wfVisibleSpans() {
      const t = wfState.trace;
      return (t.spans || []).filter(s => !wfState.hidden[s.category]);
    }
    window.wfToggleCat = (cat) => {
      wfState.hidden[cat] = !wfState.hidden[cat];
      wfRenderBody();
    };
    window.wfExportCSV = () => {
      const t = wfState.trace;
      if (!t || !t.spans) return;
      const head = ['seq', 'request_id', 'model', 'requested_model', 'provider', 'category', 'status', 'start_offset_ms', 'gap_before_ms', 'ttfb_ms', 'total_ms', 'tokens', 'cost_krw', 'tool_calls', 'tool_errors', 'slow', 'created_at'];
      const esc = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
      const lines = [head.join(',')].concat(t.spans.map(s => [s.seq, s.request_id, s.model, s.requested_model, s.provider, s.category, s.status_code, s.start_offset_ms, s.gap_before_ms, s.ttfb_ms, s.total_ms, s.total_tokens, s.cost_krw, s.tool_calls, s.tool_errors, s.slow ? 1 : 0, s.created_at].map(esc).join(',')));
      const blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'waterfall_' + (t.session_id || 'session') + '.csv';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    };
    function wfRenderBody() {
      const t = wfState.trace;
      const spans = wfVisibleSpans();
      document.getElementById('wf-body').innerHTML =
        waterfallSummary(t) +
        waterfallBottleneck(t) +
        waterfallLegend(t) +
        waterfallChartSVG(t, spans) +
        waterfallTable(spans);
      document.querySelectorAll('#wf-body .wf-row, #wf-body .wf-rowlink').forEach(el => el.addEventListener('click', () => openExplain(el.getAttribute('data-rid'))));
      makeSortable('#wf-body', 'waterfall');
    }
    function waterfallSummary(t) {
      const busyPct = t.wall_ms > 0 ? (t.busy_ratio * 100).toFixed(0) + '%' : '-';
      // time-composition stacked bar: first-token wait vs streaming vs idle
      const seg = [
        { v: t.wait_ms || 0, c: '#f59e0b', label: '첫 응답 대기' },
        { v: t.stream_ms || 0, c: '#3b82f6', label: '스트리밍 수신' },
        { v: t.idle_ms || 0, c: 'var(--muted)', label: '클라이언트 대기' },
      ];
      const segSum = seg.reduce((a, s) => a + s.v, 0) || 1;
      const phaseBar = '<div style="margin:12px 0 24px; padding:0 2px">' +
        '<div style="display:flex; height:18px; border-radius:4px; overflow:hidden; border:1px solid var(--line)">' +
        seg.map(s => '<div title="' + s.label + ' ' + msLabel(s.v) + '" style="width:' + (s.v / segSum * 100).toFixed(2) + '%; background:' + s.c + '"></div>').join('') +
        '</div>' +
        '<div style="display:flex; gap:20px; flex-wrap:wrap; margin-top:10px; padding-left:4px; font-size:12px" class="muted">' +
        seg.map(s => '<span style="display:inline-flex; align-items:center; gap:6px"><span style="width:10px;height:10px;border-radius:2px;background:' + s.c + '"></span>' + s.label + ' ' + msLabel(s.v) + ' (' + (s.v / segSum * 100).toFixed(0) + '%)</span>').join('') +
        '</div></div>';
      return '<div class="kpis">' +
        kpi('요청 수', fmt(t.requests)) +
        kpi('총 소요(wall)', msLabel(t.wall_ms)) +
        kpi('LLM 처리(busy)', msLabel(t.busy_ms) + '<div class="muted" style="font-size:11px; font-weight:500; margin-top:6px">처리율 ' + busyPct + '</div>') +
        kpi('대기/생각(idle)', msLabel(t.idle_ms)) +
        kpi('느린 요청', fmt(t.slow_count || 0) + '<div class="muted" style="font-size:11px; font-weight:500; margin-top:6px">기준 ' + msLabel(t.slow_ms) + ' 이상</div>') +
        kpi('누적 비용', money(t.total_cost_krw) + '<div class="muted" style="font-size:11px; font-weight:500; margin-top:6px">' + fmt(t.total_tokens) + ' tok · 도구 ' + fmt(t.tool_calls) + '</div>') +
      '</div>' + phaseBar;
    }
    function waterfallBottleneck(t) {
      const bn = t.bottleneck || {};
      const slowSpan = (t.spans || []).find(s => s.seq === bn.slowest_seq);
      const items = [];
      if (bn.slowest_ms > 0 && slowSpan) {
        items.push('<div class="kpi" style="cursor:pointer" onclick="openExplain(\'' + escapeAttr(slowSpan.request_id) + '\')">' +
          '<div class="label">가장 느린 요청</div>' +
          '<div class="value">#' + bn.slowest_seq + ' · ' + msLabel(bn.slowest_ms) + '</div>' +
          '<div class="muted" style="font-size:11px; font-weight:500; margin-top:6px">' + escapeHTML(slowSpan.model || '') + ' · 전체의 ' + (bn.slowest_pct || 0).toFixed(0) + '% · 클릭→근거</div></div>');
      }
      if (bn.longest_gap_ms > 0) {
        const gapSpan = (t.spans || []).find(s => s.seq === bn.longest_gap_seq);
        items.push('<div class="kpi">' +
          '<div class="label">가장 긴 대기(생각)</div>' +
          '<div class="value">' + msLabel(bn.longest_gap_ms) + '</div>' +
          '<div class="muted" style="font-size:11px; font-weight:500; margin-top:6px">#' + bn.longest_gap_seq + (gapSpan ? ' (' + escapeHTML(gapSpan.model || '') + ')' : '') + ' 직전 · 전체의 ' + (bn.longest_gap_pct || 0).toFixed(0) + '%</div></div>');
      }
      if (!items.length) return '';
      const verdict = (t.idle_ms > t.busy_ms)
        ? '병목은 <strong>클라이언트 대기(생각·도구 실행)</strong> 쪽입니다. 모델 증설보다 에이전트 동작을 점검하세요.'
        : ((t.wait_ms > t.stream_ms)
          ? '업스트림 시간 대부분이 <strong>첫 토큰 대기(TTFB)</strong>입니다. 모델 큐·프롬프트 길이를 점검하세요.'
          : '업스트림 시간 대부분이 <strong>스트리밍 수신</strong>입니다. 출력 길이가 깁니다.');
      return '<h3 style="margin:20px 0 12px; font-size:14px">병목 분석</h3>' +
        '<div class="kpis" style="margin-bottom:12px">' + items.join('') + '</div>' +
        '<div class="muted" style="font-size:12px; margin-bottom:20px; padding-left:2px; line-height:1.6">' + verdict + '</div>';
    }
    function waterfallLegend(t) {
      const cats = t.categories || {};
      return '<div style="display:flex; gap:14px; flex-wrap:wrap; align-items:center; margin:0 0 16px; padding-left:2px">' +
        '<span class="muted" style="font-size:12px">분류 필터:</span>' +
        Object.keys(waterfallColors).map(k => {
          const off = wfState.hidden[k];
          return '<span onclick="wfToggleCat(\'' + k + '\')" title="클릭하여 숨기기/보이기" style="cursor:pointer; user-select:none; display:inline-flex; align-items:center; gap:6px; padding:4px 10px; border:1px solid var(--line); border-radius:14px; opacity:' + (off ? '0.4' : '1') + '; text-decoration:' + (off ? 'line-through' : 'none') + '">' +
            '<span style="width:10px;height:10px;border-radius:2px;background:' + waterfallColors[k].c + '"></span>' +
            waterfallColors[k].label + ' <span class="muted">' + fmt(cats[k] || 0) + '</span></span>';
        }).join('') +
        '</div>';
    }
    function waterfallChartSVG(t, spans) {
      spans = spans || t.spans || [];
      if (!spans.length) return '<div class="empty">표시할 요청 없음 (필터 확인)</div>';
      // Size the viewBox to the actual panel width so the bar track fills the space
      // instead of being letterboxed/centered at a fixed 960px width.
      const host = document.getElementById('wf-body');
      const W = Math.max(760, Math.round(((host && host.clientWidth) ? host.clientWidth : 960) - 4));
      const padL = 168, padR = 30, padT = 36, padB = 14, rowH = 28, barH = 14;
      const innerW = W - padL - padR;
      const H = padT + spans.length * rowH + padB;
      const span = Math.max(1, t.wall_ms);
      const xs = ms => padL + (Math.max(0, ms) / span) * innerW;
      const maxLabel = Math.max(8, Math.floor((padL - 12) / 6.4));
      const ticks = [0, 0.25, 0.5, 0.75, 1];
      const grid = ticks.map(f => {
        const x = padL + f * innerW;
        return '<line x1="' + x.toFixed(1) + '" y1="' + padT + '" x2="' + x.toFixed(1) + '" y2="' + (H - padB) + '" stroke="var(--line)" stroke-dasharray="2,3"/>' +
          '<text x="' + x.toFixed(1) + '" y="' + (padT - 8) + '" font-size="10" fill="currentColor" opacity="0.6" text-anchor="middle">' + msLabel(span * f) + '</text>';
      }).join('');
      const rows = spans.map((sp, i) => {
        const y = padT + i * rowH;
        const col = (waterfallColors[sp.category] || waterfallColors.normal).c;
        const x0 = xs(sp.start_offset_ms);
        const totalW = Math.max(3, (sp.total_ms / span) * innerW);
        const ttfbW = Math.min(totalW, (sp.ttfb_ms / span) * innerW);
        const label = '#' + sp.seq + ' ' + (sp.model || '?');
        const labelShort = label.length > maxLabel ? label.slice(0, maxLabel - 1) + '…' : label;
        const tip = '#' + sp.seq + ' ' + (sp.model || '?') + (sp.requested_model && sp.requested_model !== sp.model ? ' (요청:' + sp.requested_model + ')' : '') +
          ' · ' + (sp.provider || '?') + ' · 상태 ' + sp.status_code +
          ' · TTFB ' + msLabel(sp.ttfb_ms) + ' · 총 ' + msLabel(sp.total_ms) +
          (sp.gap_before_ms > 0 ? ' · 직전 대기 ' + msLabel(sp.gap_before_ms) : '') +
          ' · ' + fmt(sp.total_tokens) + 'tok · ' + money(sp.cost_krw) +
          (sp.tool_calls > 0 ? ' · 도구 ' + fmt(sp.tool_calls) + (sp.tool_errors > 0 ? '(' + fmt(sp.tool_errors) + '오류)' : '') : '') +
          ' · ' + ((waterfallColors[sp.category] || {}).label || sp.category) +
          (sp.slow ? ' · ⚠느림' : '');
        const stripe = i % 2 ? '<rect x="0" y="' + y + '" width="' + W + '" height="' + rowH + '" fill="var(--line)" opacity="0.05"/>' : '';
        const gapLabel = (sp.gap_before_ms >= 1000 && x0 - 4 > padL) ?
          '<text x="' + (x0 - 4).toFixed(1) + '" y="' + (y + rowH / 2 + 3) + '" font-size="9" fill="currentColor" opacity="0.45" text-anchor="end">' + msLabel(sp.gap_before_ms) + ' 대기</text>' : '';
        const barY = y + (rowH - barH) / 2;
        const ttfbRect = ttfbW > 0.5 ? '<rect x="' + x0.toFixed(1) + '" y="' + barY + '" width="' + ttfbW.toFixed(1) + '" height="' + barH + '" rx="2" fill="' + col + '" fill-opacity="0.4"/>' : '';
        const streamX = x0 + ttfbW, streamW = Math.max(1, totalW - ttfbW);
        const slowStroke = sp.slow ? ' stroke="var(--bad)" stroke-width="1.5"' : '';
        const streamRect = '<rect x="' + streamX.toFixed(1) + '" y="' + barY + '" width="' + streamW.toFixed(1) + '" height="' + barH + '" rx="2" fill="' + col + '" fill-opacity="0.95"' + slowStroke + '/>';
        const markX = Math.min(x0 + totalW + 5, W - 12);
        const slowMark = sp.slow ? '<text x="' + markX.toFixed(1) + '" y="' + (y + rowH / 2 + 3) + '" font-size="11" fill="var(--bad)">⚠</text>' : '';
        return '<g class="wf-row" data-rid="' + escapeHTML(sp.request_id) + '" style="cursor:pointer">' +
          stripe +
          '<text x="6" y="' + (y + rowH / 2 + 3) + '" font-size="11" fill="currentColor" opacity="0.85">' + escapeHTML(labelShort) + '</text>' +
          gapLabel + ttfbRect + streamRect + slowMark +
          '<title>' + escapeHTML(tip) + '</title>' +
        '</g>';
      }).join('');
      return '<div style="overflow:auto; max-height:600px; border:1px solid var(--line); border-radius:8px; margin-top:4px">' +
        '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" height="' + H + '" preserveAspectRatio="xMinYMin meet" style="color:var(--ink); display:block">' +
        grid +
        '<line x1="' + padL + '" y1="' + padT + '" x2="' + padL + '" y2="' + (H - padB) + '" stroke="var(--line-strong)"/>' +
        rows +
        '</svg></div>' +
        '<div class="muted" style="font-size:12px; margin:10px 0 20px; padding-left:2px; line-height:1.6">막대 = 한 요청. 연한 부분 = 첫 응답 대기(TTFB), 진한 부분 = 스트리밍 수신. 막대 사이 빈 공간 = 클라이언트 대기/생각 시간. ⚠/빨간 테두리 = 느린 요청(기준 ' + msLabel(t.slow_ms) + '). 막대 클릭 시 라우팅 근거(Explain) 표시.</div>';
    }
    function waterfallTable(spans) {
      spans = spans || [];
      if (!spans.length) return '';
      return '<table><thead><tr><th data-sort="num">#</th><th data-sort="str">모델</th><th data-sort="str">분류</th><th data-sort="num">시작(+)</th><th data-sort="num">직전 대기</th><th data-sort="num">TTFB</th><th data-sort="num">총 지연</th><th data-sort="num">토큰</th><th data-sort="num">비용</th><th data-sort="num">도구</th><th data-sort="num">상태</th></tr></thead><tbody>' +
        spans.map(sp => {
          const cc = waterfallColors[sp.category] || waterfallColors.normal;
          return '<tr class="wf-rowlink" data-rid="' + escapeAttr(sp.request_id) + '" style="cursor:pointer">' +
            '<td>' + sp.seq + '</td>' +
            '<td>' + escapeHTML(sp.model || '') + (sp.requested_model && sp.requested_model !== sp.model ? '<div class="muted">요청: ' + escapeHTML(sp.requested_model) + '</div>' : '') + '</td>' +
            '<td><span class="status" style="background:' + cc.c + '22; color:' + cc.c + '">' + cc.label + '</span></td>' +
            '<td data-num="' + sp.start_offset_ms + '">' + msLabel(sp.start_offset_ms) + '</td>' +
            '<td data-num="' + sp.gap_before_ms + '">' + (sp.gap_before_ms > 0 ? msLabel(sp.gap_before_ms) : '-') + '</td>' +
            '<td data-num="' + sp.ttfb_ms + '">' + msLabel(sp.ttfb_ms) + '</td>' +
            '<td data-num="' + sp.total_ms + '">' + msLabel(sp.total_ms) + (sp.slow ? ' <span class="status error">느림</span>' : '') + '</td>' +
            '<td data-num="' + (sp.total_tokens || 0) + '">' + fmt(sp.total_tokens) + '</td>' +
            '<td data-num="' + (sp.cost_krw || 0) + '">' + money(sp.cost_krw) + '</td>' +
            '<td data-num="' + (sp.tool_calls || 0) + '">' + fmt(sp.tool_calls) + (sp.tool_errors > 0 ? ' <span class="status error">' + fmt(sp.tool_errors) + '</span>' : '') + '</td>' +
            '<td data-num="' + sp.status_code + '">' + statusBadge(sp.status_code) + '</td>' +
          '</tr>';
        }).join('') + '</tbody></table>';
    }

    // ---------- Agent Performance Analytics ----------
    const agentsState = { window: sessionStorage.getItem('agentsWindow') || '7d' };
    async function renderAgents(initial) {
      if (initial && initial.get('window')) agentsState.window = initial.get('window');
      const view = document.getElementById('view');
      const data = await api('/admin/agents?window=' + encodeURIComponent(agentsState.window));
      const agents = data.agents || [];
      const totalReq = agents.reduce((a, x) => a + (x.requests || 0), 0);
      const totalCost = agents.reduce((a, x) => a + (x.total_cost_krw || 0), 0);
      const weighted = totalReq ? agents.reduce((a, x) => a + (x.success_rate || 0) * (x.requests || 0), 0) / totalReq : 0;
      const rateCell = (v) => { const pc = Math.round((v || 0) * 100); const cls = pc >= 90 ? '' : (pc >= 75 ? 'warn' : 'error'); return '<span class="status ' + cls + '">' + pc + '%</span>'; };
      const toolCell = (r) => (r.tool_calls > 0) ? ('<span class="status ' + ((r.tool_error_rate || 0) >= 0.1 ? 'error' : '') + '">' + Math.round((r.tool_error_rate || 0) * 100) + '%</span> <span class="muted">' + fmt(r.tool_errors) + '/' + fmt(r.tool_calls) + '</span>') : '<span class="muted">-</span>';
      const table = agents.length ? (
        '<table><thead><tr>' +
        '<th data-sort="str">에이전트</th><th data-sort="num">요청</th><th data-sort="num">성공률</th><th data-sort="num">폴백률</th>' +
        '<th data-sort="num">평균 비용</th><th data-sort="num">누적 비용</th><th data-sort="num">평균 지연</th><th data-sort="num">첫 청크</th>' +
        '<th data-sort="num">도구 오류율</th><th data-sort="num">토큰</th><th data-sort="str">최근</th></tr></thead><tbody>' +
        agents.map(r => '<tr title="' + escapeAttr(r.sample_ua || '') + '">' +
          '<td><strong>' + escapeHTML(r.agent) + '</strong></td>' +
          '<td data-num="' + (r.requests || 0) + '">' + fmt(r.requests) + '</td>' +
          '<td data-num="' + (r.success_rate || 0) + '">' + rateCell(r.success_rate) + '</td>' +
          '<td data-num="' + (r.fallback_rate || 0) + '">' + Math.round((r.fallback_rate || 0) * 100) + '%</td>' +
          '<td data-num="' + (r.avg_cost_krw || 0) + '">' + money(r.avg_cost_krw) + '</td>' +
          '<td data-num="' + (r.total_cost_krw || 0) + '">' + money(r.total_cost_krw) + '</td>' +
          '<td data-num="' + (r.avg_latency_ms || 0) + '">' + Math.round(r.avg_latency_ms || 0) + ' ms</td>' +
          '<td data-num="' + (r.avg_first_chunk_ms || 0) + '">' + Math.round(r.avg_first_chunk_ms || 0) + ' ms</td>' +
          '<td data-num="' + (r.tool_error_rate || 0) + '">' + toolCell(r) + '</td>' +
          '<td data-num="' + (r.tokens || 0) + '">' + fmt(r.tokens) + '</td>' +
          '<td>' + ago(r.last_seen) + '</td>' +
        '</tr>').join('') + '</tbody></table>'
      ) : '<div class="empty">에이전트 데이터 없음 (chat 호출이 쌓이면 표시됩니다)</div>';
      const windowSel = '<select id="agents-window">' + ['24h', '7d', '30d'].map(wd => '<option value="' + wd + '"' + (agentsState.window === wd ? ' selected' : '') + '>' + wd + '</option>').join('') + '</select>';
      view.innerHTML = section('에이전트 성능 분석 (Agent Performance)',
        '<div class="toolbar">' + windowSel + '<span class="muted" style="margin-left:auto">User-Agent 기반 식별 · chat 호출 기준</span></div>' +
        '<div class="kpis">' +
          kpi('에이전트 수', fmt(agents.length)) +
          kpi('총 요청', fmt(totalReq)) +
          kpi('가중 성공률', Math.round(weighted * 100) + '%') +
          kpi('누적 비용', money(totalCost)) +
        '</div>' +
        table +
        '<div class="muted" style="font-size:12px; padding:0 14px 12px">성공 = 2xx · 오류 없음 · 폴백 없음. 에이전트는 User-Agent 키워드로 분류하며(미상은 UA 앞 토큰), 행에 마우스를 올리면 예시 User-Agent가 보입니다. 성공률 ≥90% 녹색 · ≥75% 노랑 · 그 외 빨강.</div>');
      const sel = document.getElementById('agents-window');
      if (sel) sel.addEventListener('change', () => { agentsState.window = sel.value; sessionStorage.setItem('agentsWindow', agentsState.window); renderAgents(); });
      makeSortable('#view', 'agents');
    }

    // ---------- VCS correlation (Prompt → Commit → MR) ----------
    async function renderVCS(initial) {
      const view = document.getElementById('view');
      const get = (k) => initial ? (initial.get(k) || '') : '';
      const repo = get('repo'), session = get('session_id'), key = get('api_key_id'), kind = get('kind');
      const qs = new URLSearchParams();
      if (repo) qs.set('repo', repo);
      if (session) qs.set('session_id', session);
      if (key) qs.set('api_key_id', key);
      if (kind) qs.set('kind', kind);
      qs.set('limit', '300');
      const data = await api('/admin/vcs/events?' + qs.toString());
      const events = data.events || [];

      const filter =
        '<form class="toolbar" id="vcs-filter" autocomplete="off">' +
          '<input id="vcs-repo" placeholder="저장소" value="' + escapeHTML(repo) + '">' +
          '<input id="vcs-session" placeholder="세션 ID" value="' + escapeHTML(session) + '">' +
          '<input id="vcs-key" placeholder="API 키 ID" value="' + escapeHTML(key) + '">' +
          '<select id="vcs-kind">' +
            '<option value="">전체 유형</option>' +
            '<option value="commit"' + (kind === 'commit' ? ' selected' : '') + '>commit</option>' +
            '<option value="merge_request"' + (kind === 'merge_request' ? ' selected' : '') + '>merge_request</option>' +
          '</select>' +
          '<button type="submit">검색</button>' +
        '</form>';

      const kindBadge = (e) => e.kind === 'merge_request'
        ? '<span class="status ' + (e.state === 'merged' ? '' : (e.state === 'closed' ? 'error' : 'warn')) + '">MR ' + escapeHTML(e.state || '') + '</span>'
        : '<span class="pill">' + escapeHTML(e.kind || 'commit') + '</span>' + (e.provider === 'inferred' ? ' <span class="muted" style="font-size:11px">추론</span>' : '');
      const rows = events.map(e => {
        const title = e.url ? '<a href="' + escapeAttr(e.url) + '" target="_blank" rel="noopener">' + escapeHTML(e.title || e.ref) + '</a>' : escapeHTML(e.title || e.ref);
        const sess = e.session_id ? '<a href="#" onclick="openSessionTimeline(\'' + escapeAttr(e.session_id) + '\');return false">' + escapeHTML(e.session_id) + '</a>' : '<span class="muted">미연결</span>';
        const usr = e.api_key_id ? '<a href="#/users/' + encodeURIComponent(e.api_key_id) + '">' + escapeHTML(e.api_key_id) + '</a>' : '';
        return '<tr>' +
          '<td>' + kindBadge(e) + '</td>' +
          '<td>' + title + '<div class="muted">' + escapeHTML(e.provider) + ' · ' + escapeHTML(e.repo || '') + (e.branch ? (' · ' + escapeHTML(e.branch)) : '') + '</div></td>' +
          '<td>' + escapeHTML(e.author_name || e.author_email || '') + '</td>' +
          '<td>' + sess + '</td>' +
          '<td>' + usr + '</td>' +
          '<td>' + ago(e.created_at) + '</td>' +
        '</tr>';
      }).join('');

      const setupHelp =
        '<div class="banner warn" style="margin:0 14px 14px">' +
          '<strong>아직 수집된 VCS 이벤트가 없습니다.</strong><br>' +
          '· <strong>자동(설정 불필요)</strong>: 에이전트 대화에 <code>git commit -m "…"</code>·<code>git push</code> 가 나타나면 <em>추론</em> 이벤트로 자동 기록됩니다(현재 세션·사용자에 연결). 아직 그런 호출이 없으면 비어 있습니다.<br>' +
          '· <strong>정식 연동(MR·머지까지)</strong>: <code>VCS_WEBHOOK_SECRET</code> 설정 후 GitLab 웹훅 <code>http://&lt;gateway&gt;:8080/vcs/webhook/gitlab</code>(Secret Token=시크릿, Push·MR) 또는 Bitbucket <code>/vcs/webhook/bitbucket?token=&lt;시크릿&gt;</code>, 또는 CI·git 훅 <code>POST /vcs/events</code>(헤더 <code>X-Vibe-VCS-Secret</code>). 커밋 메시지/MR 제목의 <code>Vibe-Session: &lt;세션ID&gt;</code> 마커로 세션 연결.' +
        '</div>';

      const table = events.length
        ? '<table><thead><tr><th data-sort="str">유형</th><th data-sort="str">제목 / 저장소</th><th data-sort="str">작성자</th><th>세션</th><th>사용자</th><th data-sort="str">시각</th></tr></thead><tbody>' + rows + '</tbody></table>'
        : setupHelp;

      view.innerHTML = section('VCS 상관 (Prompt → Commit → MR → Merge)',
        filter + table +
        '<div class="muted" style="font-size:12px; padding:0 14px 12px">커밋·MR 을 코딩 세션과 사용자에 연결합니다. 세션/사용자 링크로 그 작업의 프롬프트 타임라인·사용량으로 이동할 수 있습니다. (GitLab·Bitbucket·범용 수집, 오프라인망 지원)</div>');

      document.getElementById('vcs-filter').addEventListener('submit', (ev) => {
        ev.preventDefault();
        const p = new URLSearchParams();
        const rv = document.getElementById('vcs-repo').value.trim();
        const sv = document.getElementById('vcs-session').value.trim();
        const kv = document.getElementById('vcs-key').value.trim();
        const tv = document.getElementById('vcs-kind').value;
        if (rv) p.set('repo', rv);
        if (sv) p.set('session_id', sv);
        if (kv) p.set('api_key_id', kv);
        if (tv) p.set('kind', tv);
        location.hash = '#/vcs' + (p.toString() ? '?' + p.toString() : '');
      });
      makeSortable('#view', 'vcs');
    }

    // ---------- Explainability View (XView) ----------
    window.openExplain = async (id) => {
      if (!id) return;
      try {
        const x = await api('/admin/requests/' + encodeURIComponent(id) + '/explain');
        openModal('XView 설명 — ' + (x.trace_id || id), explainHTML(x));
      } catch (err) {
        openModal('오류', '<div class="error-line">' + escapeHTML(err.message) + '</div>');
      }
    };
    function explainPanel(title, bodyHTML, accent) {
      return '<section style="margin-top:14px"><h2 style="border-left:4px solid ' + (accent || 'var(--accent)') + '">' + escapeHTML(title) + '</h2>' +
        '<div style="padding:14px">' + bodyHTML + '</div></section>';
    }
    function explainHTML(x) {
      const rt = x.routing || {}, fb = x.fallback || {}, ca = x.cache || {}, sf = x.safety || {}, gv = x.governance || {}, co = x.cost || {}, se = x.session || {};
      const tierBadge = { reasoning: 'error', complex: 'warn', standard: '', simple: '' }[rt.tier] || '';

      const modelLine = rt.model_changed
        ? '<span class="status warn">' + escapeHTML(rt.requested_model || '') + '</span> → <strong>' + escapeHTML(rt.chosen_model || '') + '</strong> <span class="muted">(복잡도 규칙으로 변경)</span>'
        : escapeHTML(rt.chosen_model || '');
      const routing = '<div class="kv">' +
        row('선택 provider', escapeHTML(rt.chosen_provider || '')) +
        row('선택 모델', modelLine) +
        row('라우팅 근거', escapeHTML(rt.reason_text || rt.reason || '') + (rt.detail ? ' <span class="muted">(' + escapeHTML(rt.detail) + ')</span>' : '')) +
        row('복잡도 점수', '<span class="status ' + tierBadge + '">' + fmt(rt.complexity || 0) + ' / 100 · ' + escapeHTML(rt.tier || '') + ' tier</span>' + progressBar((rt.complexity || 0) / 100)) +
        row('위험도 점수', '<span class="status ' + ((rt.risk_score || 0) >= 60 ? 'warn' : '') + '">' + fmt(rt.risk_score || 0) + ' / 100 · ' + escapeHTML(rt.risk_tier || 'low') + '</span>' + ((rt.risk_categories || []).length ? ' <span class="muted">(' + escapeHTML((rt.risk_categories || []).join(', ')) + ')</span>' : '')) +
        row('Provider health', '<span class="status">' + fmt(rt.health_score || 0) + ' / 100</span>') +
        (rt.decision_reason ? row('Explain reason', escapeHTML(rt.decision_reason)) : '') +
        ((rt.fallback_path || []).length ? row('Fallback chain', escapeHTML((rt.fallback_path || []).join(' → '))) : '') +
        row('endpoint', escapeHTML(rt.endpoint || '')) +
      '</div><div class="muted" style="font-size:12px; margin-top:6px">복잡도는 길이·토큰 추정·코드 밀도·파일 수·대화 깊이·지시/추론/리팩토링/디버깅 키워드 기반 휴리스틱 추정치입니다.</div>';

      const fallback = fb.occurred
        ? '<div class="kv">' +
            row('상태', '<span class="status warn">폴백 발생</span>') +
            row('최초 provider', escapeHTML(fb.from_provider || '')) +
            row('대체 provider', escapeHTML(fb.to_provider || '')) +
            row('사유', escapeHTML(fb.reason || '')) +
            (fb.error ? row('오류', escapeHTML(fb.error)) : '') +
          '</div>'
        : '<div class="muted">폴백 없음 — 최초 선택 provider가 정상 응답했습니다.' + (fb.error ? ' (' + escapeHTML(fb.error) + ')' : '') + '</div>';

      const cacheRows = [];
      cacheRows.push(row('캐시 히트', ca.hit ? '<span class="status">예 (응답 재사용)</span>' : '아니오'));
      cacheRows.push(row('cached 토큰', fmt(ca.cached_tokens || 0)));
      if (ca.savings_krw) cacheRows.push(row('캐시 절감액', '<strong>' + money(ca.savings_krw) + '</strong>'));
      if (ca.cached_savings_krw) cacheRows.push(row('프롬프트 캐시 절감액', '<strong>' + money(ca.cached_savings_krw) + '</strong>'));
      const cache = '<div class="kv">' + cacheRows.join('') + '</div>';

      const findings = (sf.findings || []).map(f =>
        '<div style="margin-top:4px"><span class="status error">' + escapeHTML(f.name) + '</span> <span class="muted">' + escapeHTML(f.reason || f.label || '') + '</span></div>').join('');
      const safety = '<div class="kv">' +
        row('차단 여부', sf.blocked ? '<span class="status error">차단됨</span>' : '<span class="status">통과</span>') +
        row('마스킹', escapeHTML(sf.masking || '')) +
        row('안전 위반', sf.finding_count > 0 ? (fmt(sf.finding_count) + '건' + findings) : '<span class="muted">없음</span>') +
      '</div>';
      const governance = governanceHTML(gv);

      const cost = '<div class="kv">' +
        row('실제 비용', '<strong>' + money(co.actual_krw) + '</strong> <span class="muted">(' + escapeHTML(sourceLabel(co.token_source)) + ')</span>') +
        (co.priced ? row('정가(캐시 미적용 시)', money(co.list_krw)) : row('가격표', '<span class="muted">이 모델은 가격 미설정</span>')) +
        (co.savings_krw ? row('절감액', '<strong style="color:var(--accent)">' + money(co.savings_krw) + '</strong>') : '') +
        row('토큰 분해', escapeHTML('prompt ' + fmt(co.prompt_tokens) + ' / completion ' + fmt(co.completion_tokens) + ' / cached ' + fmt(co.cached_tokens) + ' / reasoning ' + fmt(co.reasoning_tokens) + ' / total ' + fmt(co.total_tokens))) +
      '</div>';

      const session = '<div class="kv">' +
        row('세션', se.session_id ? ('<a href="#" onclick="closeModal();openSessionTimeline(\'' + escapeAttr(se.session_id) + '\');return false">' + escapeHTML(se.session_id) + '</a>') : '<span class="muted">없음</span>') +
        (se.session_id ? row('워터폴', '<a href="#" onclick="closeModal();openWaterfall(\'' + escapeAttr(se.session_id) + '\');return false">트랜잭션 타임라인 보기</a>') : '') +
        row('스트리밍', se.stream ? '예' : '아니오') +
        row('요청 상세', '<a href="#" onclick="closeModal();openRequestDetail(\'' + escapeAttr(x.request_id) + '\');return false">원문/프롬프트/응답 보기</a>') +
      '</div>';

      return explainPanel('🧭 라우팅 (왜 이 모델인가)', routing, 'var(--accent)') +
        explainPanel('🔁 폴백', fallback, 'var(--warn)') +
        explainPanel('🟢 캐시', cache, '#22c55e') +
        explainPanel('🛡 안전', safety, 'var(--bad)') +
        explainPanel('거버넌스', governance, 'var(--accent-2)') +
        explainPanel('💰 비용', cost, 'var(--accent-2)') +
        explainPanel('🧵 세션', session, 'var(--muted)');
    }
    function governanceStatusClass(value) {
      const v = String(value || '').toLowerCase();
      if (v === 'block' || v.startsWith('deny_') || v === 'rejected' || v === 'expired' || v === 'critical' || v === 'high') return 'error';
      if (v === 'require_approval' || v === 'pending' || v === 'mask' || v === 'medium' || v === 'warn') return 'warn';
      return '';
    }
    function governanceHTML(gv) {
      gv = gv || {};
      const policy = gv.policy_decisions || [];
      const approvals = gv.approvals || [];
      const secrets = gv.secret_events || [];
      const anomalies = gv.anomaly_events || [];
      const summary = '<div class="kv">' +
        row('정책 판단', fmt(gv.policy_decision_count || policy.length || 0) + '건') +
        row('승인', fmt(gv.approval_count || approvals.length || 0) + '건' + (gv.approval_status ? ' · <span class="status ' + governanceStatusClass(gv.approval_status) + '">' + escapeHTML(gv.approval_status) + '</span>' : '')) +
        row('Secret Firewall', fmt(gv.secret_event_count || secrets.length || 0) + '건') +
        row('이상 탐지', fmt(gv.anomaly_event_count || anomalies.length || 0) + '건') +
      '</div>';
      const policyTable = policy.length ? (
        '<table style="margin-top:12px"><thead><tr><th>단계</th><th>판단</th><th>정책 / 룰</th><th>대상</th><th>점수</th><th>근거</th></tr></thead><tbody>' +
        policy.map(e => '<tr>' +
          '<td>' + escapeHTML(e.phase || '') + '</td>' +
          '<td><span class="status ' + governanceStatusClass(e.decision) + '">' + escapeHTML(e.decision || '') + '</span></td>' +
          '<td>' + escapeHTML(e.policy_id || '') + '<div class="muted">' + escapeHTML(e.rule_name || e.rule_id || '') + '</div></td>' +
          '<td>' + escapeHTML(e.model || '') + '<div class="muted">' + escapeHTML(e.provider || e.endpoint || '') + '</div></td>' +
          '<td>risk ' + fmt(e.risk_score || 0) + '<div class="muted">complexity ' + fmt(e.complexity_score || 0) + (e.cost_krw ? ' · ' + money(e.cost_krw) : '') + '</div></td>' +
          '<td>' + escapeHTML(e.reason || '') + '</td>' +
        '</tr>').join('') + '</tbody></table>'
      ) : '<div class="muted" style="margin-top:12px">정책 판단 이벤트 없음</div>';
      const approvalTable = approvals.length ? (
        '<table style="margin-top:12px"><thead><tr><th>상태</th><th>승인 ID</th><th>사유</th><th>위험/비용</th><th>만료/결정</th></tr></thead><tbody>' +
        approvals.map(a => '<tr>' +
          '<td><span class="status ' + governanceStatusClass(a.status) + '">' + escapeHTML(a.status || '') + '</span></td>' +
          '<td>' + escapeHTML(a.id || '') + '</td>' +
          '<td>' + escapeHTML(a.reason || '') + '</td>' +
          '<td>risk ' + fmt(a.risk_score || 0) + '<div class="muted">' + money(a.cost_krw || 0) + '</div></td>' +
          '<td>' + (a.expires_at ? ('만료 ' + ago(a.expires_at)) : '<span class="muted">-</span>') + (a.decided_by ? '<div class="muted">' + escapeHTML(a.decided_by) + '</div>' : '') + '</td>' +
        '</tr>').join('') + '</tbody></table>'
      ) : '';
      const secretTable = secrets.length ? (
        '<table style="margin-top:12px"><thead><tr><th>Action</th><th>유형</th><th>위치</th><th>Hash</th><th>시각</th></tr></thead><tbody>' +
        secrets.map(s => '<tr>' +
          '<td><span class="status ' + governanceStatusClass(s.action) + '">' + escapeHTML(s.action || '') + '</span></td>' +
          '<td>' + escapeHTML(s.secret_type || '') + '</td>' +
          '<td>' + escapeHTML(s.location || '') + '</td>' +
          '<td>' + escapeHTML(s.matched_hash || '') + '</td>' +
          '<td>' + (s.created_at ? ago(s.created_at) : '') + '</td>' +
        '</tr>').join('') + '</tbody></table>'
      ) : '';
      const anomalyTable = anomalies.length ? (
        '<table style="margin-top:12px"><thead><tr><th>심각도</th><th>범위</th><th>지표</th><th>값 / 기준선</th><th>상태</th></tr></thead><tbody>' +
        anomalies.map(a => '<tr>' +
          '<td><span class="status ' + governanceStatusClass(a.severity) + '">' + escapeHTML(a.severity || '') + '</span></td>' +
          '<td>' + escapeHTML(a.scope || '') + '<div class="muted">' + escapeHTML(a.scope_value || '') + '</div></td>' +
          '<td>' + escapeHTML(a.metric || '') + '</td>' +
          '<td>' + fmt(a.value || 0) + '<div class="muted">baseline ' + fmt(a.baseline || 0) + '</div></td>' +
          '<td>' + escapeHTML(a.status || '') + '</td>' +
        '</tr>').join('') + '</tbody></table>'
      ) : '';
      return summary + policyTable + approvalTable + secretTable + anomalyTable;
    }
    window.openRequestDetail = async (id) => {
      try {
        const [detail, note] = await Promise.all([
          api('/admin/requests/' + encodeURIComponent(id)),
          api('/admin/requests/' + encodeURIComponent(id) + '/note').catch(() => ({ tags: [], note: '' })),
        ]);
        openModal('요청 상세 - ' + (detail.request.trace_id || id), requestDetailHTML(detail, note));
        wireNoteEditor(id);
      } catch (err) {
        openModal('오류', '<div class="error-line">' + escapeHTML(err.message) + '</div>');
      }
    };
    function msLabel(v) {
      v = Math.round(v || 0);
      if (v >= 1000) return (v / 1000).toFixed(v % 1000 === 0 ? 0 : 1) + 's';
      return v + 'ms';
    }

    // ---------- dashboard ----------
    const dashboardState = { window: sessionStorage.getItem('dashWindow') || '24h' };
    async function renderDashboard() {
      const win = dashboardState.window;
      const bucket = win === '24h' ? 'hour' : 'day';
      const heatWindow = win === '24h' ? '7d' : (win === '30d' ? '30d' : '7d');
      const [stats, ts, heat, recent, anomalyResp, ops] = await Promise.all([
        api('/admin/stats'),
        api('/admin/timeseries?window=' + win + '&bucket=' + bucket),
        api('/admin/heatmap?window=' + heatWindow),
        api('/admin/requests?limit=20'),
        api('/admin/anomalies?recent=6h&z=3').catch(() => ({ anomalies: [] })),
        api('/admin/ops/status').catch(() => null),
      ]);
      const anomalies = (anomalyResp && anomalyResp.anomalies) || [];

      const html =
        section('요약', kpiBlock(stats)) +
        (ops ? section('운영 상태', opsStatusHTML(ops)) : '') +
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
        section('이상 징후 (최근 6시간 vs 7일 기준선, |z| ≥ 3)', anomalyTable(anomalies)) +
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

    function opsBytes(n) {
      n = n || 0;
      const u = ['B', 'KB', 'MB', 'GB', 'TB'];
      let i = 0;
      while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
      return (i === 0 ? n : n.toFixed(1)) + ' ' + u[i];
    }
    function opsPill(ok, label) {
      const color = ok ? 'var(--accent)' : 'var(--bad)';
      return '<span style="display:inline-block; padding:2px 8px; border-radius:10px; font-size:12px; font-weight:700; color:#fff; background:' + color + '">' + escapeHTML(label) + '</span>';
    }
    function opsStatusHTML(ops) {
      const sec = ops.security || {};
      const log = ops.logging || {};
      const fb = ops.fallback || {};
      const disk = ops.disk || {};
      const providers = ops.providers || [];

      const secItems = [
        opsPill(sec.auth_enabled, sec.auth_enabled ? '인증 ON' : '인증 OFF'),
        opsPill(!sec.dev_secret, sec.dev_secret ? '개발용 secret' : 'secret 설정됨'),
        opsPill(sec.pricing_configured, sec.pricing_configured ? '가격표 설정' : '가격표 미설정'),
        opsPill(!sec.raw_prompts_logged, sec.raw_prompts_logged ? '원문 프롬프트 저장' : '프롬프트 마스킹'),
        opsPill(!sec.raw_bodies_logged, sec.raw_bodies_logged ? '원본 body 저장' : 'body 미저장'),
      ].join(' ');

      const logDropOk = (log.dropped || 0) === 0;
      const logHTML =
        '<div>큐 깊이 <b>' + fmt(log.queue_depth || 0) + '</b> · 기록 <b>' + fmt(log.written || 0) + '</b></div>' +
        '<div>로그 drop ' + opsPill(logDropOk, fmt(log.dropped || 0) + ' 건') + '</div>';

      const fbOk = !fb.exists || (fb.lines || 0) === 0;
      const fbHTML = fb.exists
        ? '<div>적체 ' + opsPill(fbOk, fmt(fb.lines || 0) + ' 줄 · ' + opsBytes(fb.bytes)) + '</div>' +
          '<div class="muted" style="font-size:12px">' + escapeHTML(fb.path || '') + '</div>'
        : '<div>' + opsPill(true, '백로그 없음') + '</div>';

      const diskOk = !disk.available || disk.used_percent < 90;
      const diskHTML = disk.available
        ? '<div>사용률 ' + opsPill(diskOk, (disk.used_percent || 0).toFixed(1) + '%') + '</div>' +
          '<div class="muted" style="font-size:12px">여유 ' + opsBytes(disk.free_bytes) + ' / ' + opsBytes(disk.total_bytes) + ' · ' + escapeHTML(disk.path || '') + '</div>'
        : '<div class="muted">디스크 정보 없음</div>';

      const provRows = providers.length
        ? '<table><thead><tr><th data-sort="str">Provider</th><th data-sort="num">점수</th><th data-sort="num">P95(ms)</th><th data-sort="num">429</th><th data-sort="num">5xx</th><th data-sort="num">fallback%</th></tr></thead><tbody>' +
          providers.map(p => {
            const score = p.score || 0;
            const color = score >= 80 ? 'var(--accent)' : (score >= 50 ? 'var(--warn)' : 'var(--bad)');
            return '<tr>' +
              '<td>' + escapeHTML(p.provider || '') + '</td>' +
              '<td data-num="' + score + '"><b style="color:' + color + '">' + score + '</b></td>' +
              '<td data-num="' + (p.p95_latency_ms || 0) + '">' + fmt(p.p95_latency_ms || 0) + '</td>' +
              '<td data-num="' + (p.rate_429 || 0) + '">' + fmt(p.rate_429 || 0) + '</td>' +
              '<td data-num="' + (p.rate_5xx || 0) + '">' + fmt(p.rate_5xx || 0) + '</td>' +
              '<td data-num="' + (p.fallback_rate || 0) + '">' + ((p.fallback_rate || 0) * 100).toFixed(1) + '%</td>' +
            '</tr>';
          }).join('') +
          '</tbody></table>'
        : '<div class="empty">최근 1시간 Provider 트래픽 없음</div>';

      return '<div class="grid3">' +
        card('보안 위험 설정', '<div style="padding:12px; line-height:2">' + secItems + '</div>') +
        card('로그 / Fallback', '<div style="padding:12px; line-height:1.8">' + logHTML + fbHTML + '</div>') +
        card('디스크', '<div style="padding:12px; line-height:1.8">' + diskHTML + '</div>') +
      '</div>' +
      card('Provider 상태 (최근 1시간)', provRows);
    }

    function opsDuration(sec) {
      sec = Math.round(sec || 0);
      if (sec < 60) return sec + '초';
      if (sec < 3600) return Math.round(sec / 60) + '분';
      const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
      return h + '시간' + (m ? ' ' + m + '분' : '');
    }
    function weeklyReportHTML(rep) {
      const topModel = (rep.top_models && rep.top_models[0]) ? rep.top_models[0].key : '—';
      const topLang = (rep.top_languages && rep.top_languages[0]) ? rep.top_languages[0].language : '—';
      const errPct = ((rep.error_rate || 0) * 100).toFixed(1);
      const errCls = (rep.error_rate || 0) > 0.1 ? 'error' : ((rep.error_rate || 0) > 0.03 ? 'warn' : '');
      const kpi = (label, value, sub) =>
        '<div style="flex:1; min-width:120px; padding:12px; background:var(--panel-alt); border:1px solid var(--line); border-radius:10px">' +
          '<div class="muted" style="font-size:12px">' + escapeHTML(label) + '</div>' +
          '<div style="font-size:20px; font-weight:800; margin-top:2px">' + value + '</div>' +
          (sub ? '<div class="muted" style="font-size:11px; margin-top:2px">' + escapeHTML(sub) + '</div>' : '') +
        '</div>';
      return '<div style="padding:14px; display:flex; gap:10px; flex-wrap:wrap">' +
        kpi('요청 수', fmt(rep.requests || 0), '') +
        kpi('비용', money(rep.cost_krw || 0), fmt(rep.tokens || 0) + ' 토큰') +
        kpi('오류율', '<span class="status ' + errCls + '">' + errPct + '%</span>', fmt(rep.error_requests || 0) + ' 건') +
        kpi('주 사용 모델', '<span style="font-size:15px">' + escapeHTML(topModel) + '</span>', '') +
        kpi('많이 쓰는 언어', '<span style="font-size:15px">' + escapeHTML(topLang) + '</span>', '') +
        kpi('세션', fmt(rep.sessions || 0), '평균 ' + opsDuration(rep.average_session_seconds)) +
        kpi('총 작업 시간', opsDuration(rep.work_seconds), '세션 합산') +
      '</div>';
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

    function anomalyTable(rows) {
      if (!rows.length) return '<div class="empty">최근 이상 징후 없음 (모델별 비용·지연이 기준선 범위 내).</div>';
      const metricLabel = (m) => ({ cost_per_request: '요청당 비용', latency_ms: '전체 지연', first_chunk_ms: '첫 청크 지연' }[m] || m);
      const fmtVal = (m, v) => m === 'cost_per_request' ? money(v) : (fmt(Math.round(v)) + ' ms');
      return '<table><thead><tr><th data-sort="str">모델</th><th data-sort="str">지표</th><th>방향</th><th data-sort="num">기준선</th><th data-sort="num">최근</th><th data-sort="num">z-score</th><th>표본</th></tr></thead><tbody>' +
        rows.map(a => {
          const up = a.direction === 'up';
          const arrow = up ? '▲' : '▼';
          const cls = (Math.abs(a.z_score) >= 5 || up) ? 'error' : 'warn';
          return '<tr>' +
            '<td>' + escapeHTML(a.model) + '</td>' +
            '<td>' + metricLabel(a.metric) + '</td>' +
            '<td><span class="status ' + cls + '">' + arrow + ' ' + (up ? '급증' : '급감') + '</span></td>' +
            '<td data-num="' + a.baseline_mean + '">' + fmtVal(a.metric, a.baseline_mean) + '<div class="muted">σ ' + fmtVal(a.metric, a.baseline_std) + '</div></td>' +
            '<td data-num="' + a.recent_mean + '">' + fmtVal(a.metric, a.recent_mean) + '</td>' +
            '<td data-num="' + Math.abs(a.z_score) + '"><strong>' + a.z_score.toFixed(1) + '</strong></td>' +
            '<td class="muted">기준 ' + fmt(a.baseline_samples) + ' / 최근 ' + fmt(a.recent_samples) + '</td>' +
          '</tr>';
        }).join('') + '</tbody></table>';
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
      return '<table><thead><tr><th data-sort="str">Session</th><th data-sort="num">요청</th><th data-sort="num">토큰</th><th data-sort="num">비용</th><th data-sort="num">오류</th><th data-sort="num">평가 실패</th><th data-sort="str">최근</th><th>타임라인</th></tr></thead><tbody>' +
        rows.map(s => '<tr>' +
          '<td>' + escapeHTML(s.session_id || 'no-session') + '</td>' +
          '<td data-num="' + (s.requests || 0) + '">' + fmt(s.requests || 0) + '</td>' +
          '<td data-num="' + (s.tokens || 0) + '">' + fmt(s.tokens || 0) + '</td>' +
          '<td data-num="' + (s.cost_krw || 0) + '">' + money(s.cost_krw || 0) + '</td>' +
          '<td data-num="' + (s.errors || 0) + '">' + fmt(s.errors || 0) + '</td>' +
          '<td data-num="' + (s.evaluation_failures || 0) + '">' + fmt(s.evaluation_failures || 0) + '</td>' +
          '<td>' + ago(s.last_seen) + '</td>' +
          '<td><button class="secondary" type="button" onclick="openSessionTimeline(\'' + escapeAttr(s.session_id || 'no-session') + '\')">보기</button></td>' +
        '</tr>').join('') + '</tbody></table>';
    }

    window.openSessionTimeline = async (sessionID) => {
      try {
        const [tl, vcs] = await Promise.all([
          api('/admin/llm/session?session_id=' + encodeURIComponent(sessionID)),
          api('/admin/vcs/events?session_id=' + encodeURIComponent(sessionID)).catch(() => ({ events: [] })),
        ]);
        openModal('세션 타임라인 - ' + sessionID, sessionTimelineHTML(tl) + vcsEventsHTML(vcs.events || []));
      } catch (err) {
        openModal('오류', '<div class="error-line">' + escapeHTML(err.message) + '</div>');
      }
    };
    function vcsEventsHTML(events) {
      if (!events.length) {
        return '<h4 style="margin:16px 0 6px; font-size:14px">연결된 VCS (커밋 / MR)</h4>' +
          '<div class="muted" style="font-size:12px">이 세션에 연결된 커밋·MR 이 없습니다. 커밋 메시지/브랜치/ MR 제목에 <code>Vibe-Session: ' + '…' + '</code> 마커를 넣고 GitLab/Bitbucket 웹훅(또는 CI)을 게이트웨이로 보내면 Prompt→Commit→MR 이 연결됩니다.</div>';
      }
      const kindBadge = (e) => e.kind === 'merge_request'
        ? '<span class="status ' + (e.state === 'merged' ? '' : (e.state === 'closed' ? 'error' : 'warn')) + '">MR ' + escapeHTML(e.state || '') + '</span>'
        : '<span class="pill">' + escapeHTML(e.kind || 'commit') + '</span>' + (e.provider === 'inferred' ? ' <span class="muted" style="font-size:11px">추론</span>' : '');
      const rowsHtml = events.map(e => {
        const label = e.url ? '<a href="' + escapeAttr(e.url) + '" target="_blank" rel="noopener">' + escapeHTML(e.title || e.ref) + '</a>' : escapeHTML(e.title || e.ref);
        return '<tr>' +
          '<td>' + kindBadge(e) + '</td>' +
          '<td>' + label + '<div class="muted">' + escapeHTML(e.provider) + ' · ' + escapeHTML(e.repo || '') + (e.branch ? (' · ' + escapeHTML(e.branch)) : '') + '</div></td>' +
          '<td>' + escapeHTML(e.author_name || e.author_email || '') + '</td>' +
          '<td>' + ago(e.created_at) + '</td>' +
        '</tr>';
      }).join('');
      return '<h4 style="margin:16px 0 6px; font-size:14px">연결된 VCS (커밋 / MR) — ' + events.length + '건</h4>' +
        '<table><thead><tr><th>유형</th><th>제목 / 저장소</th><th>작성자</th><th>시각</th></tr></thead><tbody>' + rowsHtml + '</tbody></table>';
    }

    function sessionTimelineHTML(tl) {
      const pts = tl.points || [];
      const summary = '<div class="kv" style="margin-bottom:14px">' +
        row('요청 수', fmt(tl.requests)) +
        row('누적 비용', money(tl.total_cost_krw)) +
        row('누적 토큰', fmt(tl.total_tokens)) +
        row('도구 호출', fmt(tl.tool_calls)) +
        row('세션 길이', fmt(tl.duration_seconds) + ' 초') +
        row('워터폴', '<a href="#" onclick="closeModal();openWaterfall(\'' + escapeAttr(tl.session_id || 'no-session') + '\');return false">트랜잭션 워터폴 보기</a>') +
      '</div>';
      if (!pts.length) return summary + '<div class="empty">턴 없음</div>';

      // cumulative cost area chart
      const W = 880, H = 200, padL = 56, padR = 16, padT = 14, padB = 26;
      const innerW = W - padL - padR, innerH = H - padT - padB;
      const maxCum = Math.max(1, ...pts.map(p => p.cumulative_cost_krw || 0));
      const x = i => padL + (pts.length === 1 ? innerW / 2 : (i * innerW) / (pts.length - 1));
      const y = v => padT + innerH - (v / maxCum) * innerH;
      const line = pts.map((p, i) => (i ? 'L' : 'M') + x(i) + ',' + y(p.cumulative_cost_krw || 0)).join(' ');
      const area = 'M' + x(0) + ',' + (padT + innerH) + ' ' + line.replace(/^M/, 'L') + ' L' + x(pts.length - 1) + ',' + (padT + innerH) + ' Z';
      const dots = pts.map((p, i) => {
        const cls = p.status_code >= 400 ? 'var(--bad)' : (p.eval_failures > 0 ? 'var(--warn)' : 'var(--accent)');
        return '<circle cx="' + x(i) + '" cy="' + y(p.cumulative_cost_krw || 0) + '" r="3" fill="' + cls + '"><title>' +
          escapeHTML('#' + (i + 1) + ' ' + p.model + ' · ' + money(p.cost_krw) + ' (누적 ' + money(p.cumulative_cost_krw) + ') · ' + fmt(p.total_tokens) + 'tok · 도구 ' + fmt(p.tool_calls) + (p.status_code >= 400 ? ' · 오류 ' + p.status_code : '')) + '</title></circle>';
      }).join('');
      const chart = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" height="' + H + '" style="color:var(--ink)">' +
        '<path d="' + area + '" fill="var(--accent)" fill-opacity="0.12"/>' +
        '<path d="' + line + '" fill="none" stroke="var(--accent)" stroke-width="2"/>' + dots +
        '<text x="6" y="' + (padT + 8) + '" font-size="10" fill="currentColor" opacity="0.7">누적 ' + money(maxCum) + '</text>' +
      '</svg><div class="muted" style="font-size:12px; margin:4px 0 12px">누적 비용 곡선. 점: 초록=정상, 노랑=평가실패, 빨강=오류. 마우스 오버로 턴 상세.</div>';

      const tbl = '<table><thead><tr><th>#</th><th>시각</th><th>모델</th><th>프롬프트</th><th data-sort="num">상태</th><th data-sort="num">첫청크</th><th data-sort="num">토큰</th><th data-sort="num">비용</th><th data-sort="num">누적비용</th><th data-sort="num">도구</th></tr></thead><tbody>' +
        pts.map((p, i) => '<tr>' +
          '<td>' + (i + 1) + '</td>' +
          '<td>' + ago(p.created_at) + '</td>' +
          '<td>' + escapeHTML(p.model || '') + '</td>' +
          '<td>' + escapeHTML(p.prompt_name || '') + '</td>' +
          '<td>' + statusBadge(p.status_code) + '</td>' +
          '<td data-num="' + (p.first_chunk_ms || 0) + '">' + fmt(p.first_chunk_ms || 0) + ' ms</td>' +
          '<td data-num="' + (p.total_tokens || 0) + '">' + fmt(p.total_tokens) + '</td>' +
          '<td data-num="' + (p.cost_krw || 0) + '">' + money(p.cost_krw) + '</td>' +
          '<td data-num="' + (p.cumulative_cost_krw || 0) + '">' + money(p.cumulative_cost_krw) + '</td>' +
          '<td data-num="' + (p.tool_calls || 0) + '">' + fmt(p.tool_calls) + (p.tool_errors > 0 ? ' <span class="status error">' + fmt(p.tool_errors) + '오류</span>' : '') + '</td>' +
        '</tr>').join('') + '</tbody></table>';
      return summary + chart + tbl;
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
      const explainBtn = '<div style="margin-bottom:12px"><button class="secondary" type="button" onclick="closeModal();openExplain(\'' + escapeAttr(r.id) + '\')">🧭 XView 설명 (왜 이렇게 처리됐나)</button></div>';
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
      const governance = governanceHTML(d.governance || {});

      return (
        explainBtn +
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
        '<h3 style="margin-top:18px">Governance</h3>' + governance +
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
      ) + section('프롬프트 지문 — 반복 작업 클러스터 (Prompt Fingerprint)',
        '<div class="toolbar"><select id="pf-window">' +
          ['24h', '7d', '30d'].map(wd => '<option value="' + wd + '"' + (wd === '7d' ? ' selected' : '') + '>' + wd + '</option>').join('') +
        '</select><span class="muted" style="margin-left:auto">유사한 작업 프롬프트를 지문으로 묶어 건수·평균 비용·추천 모델을 집계합니다</span></div>' +
        '<div id="prompt-fingerprints"></div>'
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

      const pfWindow = document.getElementById('pf-window');
      const loadFingerprints = async () => {
        const host = document.getElementById('prompt-fingerprints');
        host.innerHTML = '<div class="muted" style="padding:14px">불러오는 중…</div>';
        const d = await api('/admin/prompts/fingerprints?window=' + pfWindow.value + '&limit=100').catch(() => ({ fingerprints: [] }));
        host.innerHTML = promptFingerprintTable(d.fingerprints || []);
        makeSortable('#prompt-fingerprints', 'pf');
      };
      pfWindow.addEventListener('change', loadFingerprints);
      loadFingerprints();
    }
    function promptFingerprintTable(rows) {
      if (!rows.length) return '<div class="empty">지문 데이터 없음 (chat 호출이 쌓이면 표시됩니다)</div>';
      return '<table><thead><tr>' +
        '<th>예시 프롬프트</th><th data-sort="str">유형</th><th data-sort="num">건수</th>' +
        '<th data-sort="num">성공률</th><th data-sort="num">평균 비용</th><th data-sort="num">누적 비용</th>' +
        '<th data-sort="num">평균 토큰</th><th data-sort="num">모델 수</th><th>최다/최저가 모델</th><th data-sort="str">최근</th></tr></thead><tbody>' +
        rows.map(r => '<tr title="' + escapeAttr(r.fingerprint) + '">' +
          '<td>' + escapeHTML(r.sample_prompt || r.fingerprint) + '<div class="muted">' + escapeHTML(r.fingerprint) + '</div></td>' +
          '<td>' + escapeHTML(wfTaskLabel[r.task_type] || r.task_type || '') + '</td>' +
          '<td data-num="' + (r.requests || 0) + '">' + fmt(r.requests) + '</td>' +
          '<td data-num="' + (r.success_rate || 0) + '">' + Math.round((r.success_rate || 0) * 100) + '%</td>' +
          '<td data-num="' + (r.avg_cost_krw || 0) + '">' + money(r.avg_cost_krw || 0) + '</td>' +
          '<td data-num="' + (r.total_cost_krw || 0) + '">' + money(r.total_cost_krw || 0) + '</td>' +
          '<td data-num="' + (r.avg_tokens || 0) + '">' + fmt(Math.round(r.avg_tokens || 0)) + '</td>' +
          '<td data-num="' + (r.distinct_models || 0) + '">' + fmt(r.distinct_models) + '</td>' +
          '<td>' + escapeHTML(r.top_model || '') + (r.cheapest_model && r.cheapest_model !== r.top_model ? '<div class="muted">최저가: ' + escapeHTML(r.cheapest_model) + '</div>' : '') + '</td>' +
          '<td>' + ago(r.last_seen) + '</td>' +
        '</tr>').join('') + '</tbody></table>' +
        '<div class="muted" style="font-size:12px; padding:8px 14px">프롬프트에서 붙여넣은 코드를 제거하고 핵심 키워드 + 작업유형으로 만든 <strong>어휘 지문</strong>입니다(의미 임베딩 아님). 같은 템플릿/반복 작업이 한 행으로 묶입니다. "최저가 모델" = 최고 성공률 대비 5%p 이내에서 가장 저렴한 모델.</div>';
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
      const [r, prod] = await Promise.all([
        api('/admin/users'),
        api('/admin/benchmark/users?window=30d&limit=50').catch(() => ({ users: [] })),
      ]);
      const rows = r.users || [];
      const prodRows = prod.users || [];
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
          '<th data-sort="str">마지막 호출</th>' +
          '<th>동작</th></tr></thead><tbody>' +
          rows.map(u =>
            '<tr class="row-link" onclick="location.hash=\'#/users/' + encodeURIComponent(u.api_key_id) + '\'">' +
              '<td>' + escapeHTML(u.name) + '<div class="muted">' + escapeHTML(u.api_key_id) + '</div></td>' +
              '<td>' + escapeHTML(u.owner || '') + '</td>' +
              '<td>' + (u.team ? '<a href="#/teams/' + encodeURIComponent(u.team) + '" onclick="event.stopPropagation()">' + escapeHTML(u.team) + '</a>' : '') + '</td>' +
              '<td><span class="status ' + (u.status === 'active' ? '' : (u.status === 'external' ? 'warn' : 'error')) + '">' + escapeHTML(u.status) + '</span></td>' +
              '<td data-num="' + (u.requests || 0) + '">' + fmt(u.requests) + '</td>' +
              '<td data-num="' + (u.tokens || 0) + '">' + fmt(u.tokens) + '</td>' +
              '<td data-num="' + (u.cost_krw || 0) + '">' + money(u.cost_krw) + '</td>' +
              '<td data-num="' + (u.average_latency_ms || 0) + '">' + Math.round(u.average_latency_ms || 0) + ' ms</td>' +
              '<td>' + ago(u.last_seen) + '</td>' +
              '<td>' + (u.status === 'external' ? '<button class="secondary" type="button" onclick="event.stopPropagation();promoteExternalKey(\'' + escapeAttr(u.api_key_id) + '\', \'' + escapeAttr(u.name) + '\')">관리 등록</button>' : '') + '</td>' +
            '</tr>'
          ).join('') + '</tbody></table>'
        ) : '<div class="empty">사용자 없음</div>'
      ) + section('AI 활용지수 (최근 30일)', productivityTable(prodRows));
      document.getElementById('view').innerHTML = html;
      makeSortable('#view', 'users');
    }
    function productivityTable(rows) {
      if (!rows.length) return '<div class="empty">활동 데이터 없음 (chat 호출이 쌓이면 표시됩니다)</div>';
      const scoreBadge = (s) => '<span class="status ' + (s >= 70 ? '' : (s >= 40 ? 'warn' : 'error')) + '">' + fmt(s) + '점</span>';
      return '<table><thead><tr>' +
        '<th data-sort="str">사용자</th><th data-sort="str">팀</th><th data-sort="num">Prompt</th><th data-sort="num">세션</th><th data-sort="num">활동일</th>' +
        '<th data-sort="num">커밋</th><th data-sort="num">머지 MR</th><th data-sort="num">도구 호출</th><th data-sort="num">성공률</th><th data-sort="num">비용</th><th data-sort="num">활용지수</th></tr></thead><tbody>' +
        rows.map(u => '<tr class="row-link" onclick="location.hash=\'#/users/' + encodeURIComponent(u.api_key_id) + '\'">' +
          '<td>' + escapeHTML(u.name) + '<div class="muted">' + escapeHTML(u.api_key_id) + '</div></td>' +
          '<td>' + escapeHTML(u.team || '') + '</td>' +
          '<td data-num="' + (u.requests || 0) + '">' + fmt(u.requests) + '</td>' +
          '<td data-num="' + (u.sessions || 0) + '">' + fmt(u.sessions) + '</td>' +
          '<td data-num="' + (u.active_days || 0) + '">' + fmt(u.active_days) + '</td>' +
          '<td data-num="' + (u.commits || 0) + '">' + fmt(u.commits) + '</td>' +
          '<td data-num="' + (u.merged_mrs || 0) + '">' + fmt(u.merged_mrs) + '</td>' +
          '<td data-num="' + (u.tool_calls || 0) + '">' + fmt(u.tool_calls) + '</td>' +
          '<td data-num="' + (u.success_rate || 0) + '">' + Math.round((u.success_rate || 0) * 100) + '%</td>' +
          '<td data-num="' + (u.cost_krw || 0) + '">' + money(u.cost_krw) + '</td>' +
          '<td data-num="' + (u.score || 0) + '">' + scoreBadge(u.score || 0) + '</td>' +
        '</tr>').join('') + '</tbody></table>' +
        '<div class="muted" style="font-size:12px; padding:8px 14px 12px">활용지수 = 요청량 30% + 활동일수 20% + 커밋 20% + 머지 MR 15% + 성공률 15% (관측 기반 휴리스틱 — 인사평가 지표가 아닌 도입 현황 파악용). 커밋·MR은 VCS 상관으로 연결된 것만 집계됩니다.</div>';
    }
    window.promoteExternalKey = async (id, current) => {
      const name = prompt('외부(미등록) 키를 관리 사용자로 등록합니다.\n클라이언트가 보내는 키는 그대로 두고, 이 식별자에 이름·팀을 부여해 정식 사용자(active)로 승격합니다.\n\n표시 이름:', current && current.indexOf('external-') !== 0 ? current : '');
      if (name === null) return;
      const team = prompt('팀 (선택, 비우면 미지정):', '');
      if (team === null) return;
      await api('/admin/api-keys/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify({ status: 'active', name: name.trim() || id, team: team.trim() }) });
      route();
    };

    async function renderUserDetail(id) {
      const [d, report] = await Promise.all([
        api('/admin/users/' + encodeURIComponent(id) + '?limit=100'),
        api('/admin/users/' + encodeURIComponent(id) + '/report?window=7d').catch(() => null),
      ]);
      const k = d.api_key, s = d.stats;
      const a = d.advanced || {};
      const heat = d.heatmap || {};
      const llm = d.llm || {};
      const isExternal = k.status === 'external';
      let notice = '';
      if (isExternal) {
        notice = '<div class="banner warn" style="margin:0 14px 12px">외부(미등록) 키 — 클라이언트가 보낸 키를 지문(키 해시)으로 자동 식별한 사용자입니다(상태 <code>external</code>). ' +
          '<button class="secondary" type="button" onclick="promoteExternalKey(\'' + escapeAttr(k.id) + '\', \'' + escapeAttr(k.name) + '\')">관리 사용자로 등록</button> 하면 이름·팀을 부여하고 정식(active) 키로 승격합니다(클라이언트 재설정 불필요).</div>';
      } else if (k.status === 'active' && (s.requests || 0) === 0) {
        notice = '<div class="banner error" style="margin:0 14px 12px"><strong>이 키로 집계된 요청이 0건입니다.</strong> 클라이언트가 <em>이 키를 정확히</em> 보내고 있는지 확인하세요(키 오타·공백·옛 키·잘못된 Bearer 값). ' +
          '실제 트래픽은 <a href="#/users">사용자 목록</a>의 <code>passthrough</code>/<code>anonymous</code> 또는 상태가 <code>external</code> 인 항목에 있을 수 있습니다. 클라이언트가 보내는 키가 곧 사용자 식별자이며, 등록된 키와 글자 단위로 일치해야 집계됩니다. 응답 헤더 <code>X-Api-Key-Id</code> 로 게이트웨이가 어떤 식별자로 인식했는지 확인할 수 있습니다.</div>';
      }
      const html =
        '<section><h2>사용자 ' + escapeHTML(k.name) + '</h2>' +
          notice +
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
        (report ? section('주간 AI 코딩 리포트 (최근 7일)', weeklyReportHTML(report)) : '') +
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
      const [r, bench] = await Promise.all([
        api('/admin/teams'),
        api('/admin/benchmark/teams?window=30d').catch(() => ({ teams: [] })),
      ]);
      const rows = r.teams || [];
      const benchRows = bench.teams || [];
      const scoreBadge = (s) => '<span class="status ' + (s >= 70 ? '' : (s >= 40 ? 'warn' : 'error')) + '">' + fmt(s) + '점</span>';
      const benchTable = benchRows.length ? (
        '<table><thead><tr>' +
        '<th data-sort="str">팀</th><th data-sort="num">활성 인원</th><th data-sort="num">요청</th><th data-sort="num">월비용(30d)</th>' +
        '<th data-sort="num">성공률</th><th data-sort="num">커밋</th><th data-sort="num">머지 MR</th><th data-sort="num">생산성 점수</th></tr></thead><tbody>' +
        benchRows.map(b => '<tr class="row-link" onclick="location.hash=\'#/teams/' + encodeURIComponent(b.team) + '\'">' +
          '<td>' + escapeHTML(b.team) + '</td>' +
          '<td data-num="' + (b.active_users || 0) + '">' + fmt(b.active_users) + '</td>' +
          '<td data-num="' + (b.requests || 0) + '">' + fmt(b.requests) + '</td>' +
          '<td data-num="' + (b.cost_krw || 0) + '">' + money(b.cost_krw) + '</td>' +
          '<td data-num="' + (b.success_rate || 0) + '">' + Math.round((b.success_rate || 0) * 100) + '%</td>' +
          '<td data-num="' + (b.commits || 0) + '">' + fmt(b.commits) + '</td>' +
          '<td data-num="' + (b.merged_mrs || 0) + '">' + fmt(b.merged_mrs) + '</td>' +
          '<td data-num="' + (b.score || 0) + '">' + scoreBadge(b.score || 0) + '</td>' +
        '</tr>').join('') + '</tbody></table>' +
        '<div class="muted" style="font-size:12px; padding:8px 14px 12px">생산성 점수 = 요청량 30% + 활동일수 20% + 커밋 20% + 머지 MR 15% + 성공률 15% (최근 30일, 관측 기반 휴리스틱 — 코드 품질 평가 아님). 커밋·MR은 VCS 상관으로 연결된 것만 집계됩니다.</div>'
      ) : '<div class="empty">벤치마크 데이터 없음</div>';
      const html = section('팀 벤치마크 (월비용 × 생산성, 최근 30일)', benchTable) + section('팀별 사용량',
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
      const [r, br] = await Promise.all([
        api('/admin/quotas'),
        api('/admin/budgets').catch(() => ({ budgets: [] }))
      ]);
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

      const budgets = br.budgets || [];
      const budgetRow = (b) => {
        const q = b.budget;
        const burn = progressBar(b.burn_ratio);
        const projPct = (b.projected_ratio * 100);
        const projCls = b.on_track ? '' : (projPct >= 120 ? 'danger' : 'warn');
        const exhaust = b.exhaustion_date
          ? '<span class="status ' + (b.on_track ? 'warn' : 'error') + '">' + escapeHTML(b.exhaustion_date) + ' 소진 예상</span>'
          : '<span class="status">월말까지 여유</span>';
        const trackBadge = b.on_track
          ? '<span class="status">정상 추세</span>'
          : '<span class="status error">예산 초과 추세</span>';
        return '<tr>' +
          '<td>' + scopeLabel(q.scope) + '<div class="muted">' + escapeHTML(q.scope_value) + '</div></td>' +
          '<td>' + money(b.spent_krw) + ' / ' + money(q.monthly_krw) + burn +
            '<div class="muted">경과 ' + Math.round(b.days_elapsed) + '/' + Math.round(b.days_in_month) + '일</div></td>' +
          '<td><span class="' + projCls + '">' + money(b.projected_krw) + '</span>' +
            '<div class="muted">예산 대비 ' + projPct.toFixed(0) + '%</div></td>' +
          '<td>' + trackBadge + '<div style="margin-top:4px">' + exhaust + '</div></td>' +
          '<td>' + escapeHTML(q.note || '') + '</td>' +
          '<td><button class="danger" type="button" onclick="deleteBudget(\'' + q.id + '\')">삭제</button></td>' +
          '</tr>';
      };
      const budgetTable = budgets.length ? (
        '<table><thead><tr><th>대상</th><th>이번 달 누적 / 월 예산</th><th>월말 예상 지출</th><th>소진 예측</th><th>메모</th><th>동작</th></tr></thead><tbody>' +
        budgets.map(budgetRow).join('') + '</tbody></table>'
      ) : '<div class="empty">설정된 예산 없음</div>';

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
      ) + section('월 예산 소진 예측 (Budget Burn-down)',
        '<p class="muted" style="margin-top:0">월 예산 대비 이번 달 누적 지출과 현재 추세(일평균 소진율)를 월말까지 연장한 예상 지출을 보여줍니다. 추세가 예산을 초과하면 소진 예상일과 함께 경고합니다. 기준 시간대는 KST(월초~월말)입니다.</p>' +
        '<form class="inline-form" id="budget-form" style="grid-template-columns: 120px minmax(120px,1fr) minmax(120px,1fr) minmax(160px,1fr) 80px;">' +
          '<select id="b-scope">' +
            '<option value="global">전체</option>' +
            '<option value="team">팀</option>' +
            '<option value="api_key">API 키</option>' +
          '</select>' +
          '<input id="b-value" placeholder="대상 값 (전체는 자동)">' +
          '<input id="b-krw" type="number" min="0" step="1000" placeholder="월 예산(KRW)">' +
          '<input id="b-note" placeholder="메모">' +
          '<button type="submit">추가</button>' +
        '</form>' +
        budgetTable
      );
      document.getElementById('view').innerHTML = html;
      document.getElementById('quota-form').addEventListener('submit', addQuota);
      document.getElementById('budget-form').addEventListener('submit', addBudget);
    }
    async function addBudget(event) {
      event.preventDefault();
      const scope = document.getElementById('b-scope').value;
      const body = {
        scope,
        scope_value: scope === 'global' ? '*' : document.getElementById('b-value').value.trim(),
        monthly_krw: Number(document.getElementById('b-krw').value || 0),
        note: document.getElementById('b-note').value.trim()
      };
      await api('/admin/budgets', { method: 'POST', body: JSON.stringify(body) });
      route();
    }
    window.deleteBudget = async (id) => {
      if (!confirm('해당 예산을 삭제하시겠습니까?')) return;
      await api('/admin/budgets/' + encodeURIComponent(id), { method: 'DELETE' });
      route();
    };
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
      const toolFilter = initial ? (initial.get('tool') || '') : '';
      const riskFilter = initial ? (initial.get('risk_level') || '') : '';
      const actionFilter = initial ? (initial.get('action') || '') : '';
      const configuredFilter = initial ? (initial.get('configured') || '') : '';
      const mcpOnly = initial ? (initial.get('mcp_only') === '1') : false;
      const qs = new URLSearchParams();
      if (apiKeyId) qs.set('api_key_id', apiKeyId);
      if (serverFilter) qs.set('server', serverFilter);
      if (toolFilter) qs.set('tool', toolFilter);
      if (riskFilter) qs.set('risk_level', riskFilter);
      if (actionFilter) qs.set('action', actionFilter);
      if (configuredFilter) qs.set('configured', configuredFilter);
      if (mcpOnly) qs.set('mcp_only', '1');

      const [serversResp, toolsResp, policiesResp, loopsResp, catalogResp, upstreamsResp] = await Promise.all([
        api('/admin/mcp/servers' + (serverFilter || apiKeyId || mcpOnly ? '?' + new URLSearchParams([...qs].filter(([k]) => ['server','api_key_id','mcp_only'].includes(k))).toString() : '')),
        api('/admin/mcp/tools' + (qs.toString() ? '?' + qs.toString() : '')),
        api('/admin/mcp/policies').catch(() => ({ policies: [], allowlist_enabled: false })),
        api('/admin/mcp/loops?window=24h&threshold=10').catch(() => ({ loops: [], threshold: 10 })),
        api('/admin/mcp/catalog' + (serverFilter ? '?server=' + encodeURIComponent(serverFilter) : '')).catch(() => ({ catalog: [], new_count: 0 })),
        api('/admin/mcp/upstreams').catch(() => ({ upstreams: [], discovery_errors: {} })),
      ]);
      const servers = serversResp.servers || [];
      const summary = serversResp.summary || {};
      const tools = toolsResp.tools || [];
      const toolRisk = toolsResp.tool_risk || [];
      window.mcpToolRiskRows = toolRisk;
      const riskByTool = {};
      toolRisk.forEach((r, idx) => { riskByTool[(r.server_label || '') + '\u0000' + (r.tool_name || '')] = { ...r, idx }; });
      const policies = policiesResp.policies || [];
      const allowlistEnabled = !!policiesResp.allowlist_enabled;
      const loops = loopsResp.loops || [];
      const catalog = catalogResp.catalog || [];
      const newToolCount = catalogResp.new_count || 0;

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
          '<input id="mcp-tool" placeholder="tool 이름" value="' + escapeHTML(toolFilter) + '">' +
          '<select id="mcp-risk-filter">' +
            '<option value="">전체 risk</option>' +
            '<option value="low" ' + (riskFilter === 'low' ? 'selected' : '') + '>low</option>' +
            '<option value="medium" ' + (riskFilter === 'medium' ? 'selected' : '') + '>medium</option>' +
            '<option value="high" ' + (riskFilter === 'high' ? 'selected' : '') + '>high</option>' +
            '<option value="critical" ' + (riskFilter === 'critical' ? 'selected' : '') + '>critical</option>' +
          '</select>' +
          '<select id="mcp-action-filter">' +
            '<option value="">전체 action</option>' +
            '<option value="allow" ' + (actionFilter === 'allow' ? 'selected' : '') + '>allow</option>' +
            '<option value="require_approval" ' + (actionFilter === 'require_approval' ? 'selected' : '') + '>require_approval</option>' +
            '<option value="block" ' + (actionFilter === 'block' ? 'selected' : '') + '>block</option>' +
          '</select>' +
          '<select id="mcp-configured-filter">' +
            '<option value="">전체 설정</option>' +
            '<option value="true" ' + (configuredFilter === 'true' || configuredFilter === '1' ? 'selected' : '') + '>configured</option>' +
            '<option value="false" ' + (configuredFilter === 'false' || configuredFilter === '0' ? 'selected' : '') + '>inferred</option>' +
          '</select>' +
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
          '<td data-num="' + (s.distinct_ips || 0) + '">' + fmt(s.distinct_ips || 0) + (s.sample_ip ? ' <span class="muted">' + escapeHTML(s.sample_ip) + (s.distinct_ips > 1 ? ' 외' : '') + '</span>' : '') + '</td>' +
          '<td>' + ago(s.last_seen) + '</td>' +
        '</tr>').join('') : '';
      const serverTable = servers.length ?
        '<table><thead><tr><th data-sort="str">서버</th><th data-sort="num">tool 종류</th><th data-sort="num">호출</th><th data-sort="num">오류</th><th data-sort="num">오류율</th><th data-sort="num">고유 키</th><th data-sort="num">호출 IP</th><th data-sort="str">마지막</th></tr></thead><tbody>' + serverRows + '</tbody></table>'
        : '<div class="empty">MCP/tool 호출 기록 없음. 클라이언트가 tools/MCP 서버를 사용하면 여기에 집계됩니다.</div>';

      const toolRows = tools.map(t => {
        const sl = t.server_label || '(none)';
        const risk = riskByTool[sl + '\u0000' + (t.tool_name || '')] || { risk_level: 'low', action: 'allow', configured: false, idx: -1 };
        const idx = risk.idx;
        return '<tr>' +
          '<td>' + (t.is_mcp ? '<span class="pill">MCP</span> ' : '') + escapeHTML(t.tool_name) + '<div class="muted">' + escapeHTML(sl) + '</div></td>' +
          '<td><span class="status ' + governanceStatusClass(risk.risk_level) + '">' + escapeHTML(risk.risk_level || '') + '</span><div class="muted">' + (risk.configured ? 'configured' : 'inferred') + '</div></td>' +
          '<td><span class="status ' + governanceStatusClass(risk.action) + '">' + escapeHTML(risk.action || '') + '</span></td>' +
          '<td data-num="' + (t.definitions || 0) + '">' + fmt(t.definitions) + '</td>' +
          '<td data-num="' + (t.calls || 0) + '">' + fmt(t.calls) + '</td>' +
          '<td data-num="' + (t.results || 0) + '">' + fmt(t.results) + '</td>' +
          '<td data-num="' + (t.errors || 0) + '">' + fmt(t.errors) + '</td>' +
          '<td data-num="' + (t.error_rate || 0) + '">' + (Number(t.error_rate || 0) * 100).toFixed(1) + '%</td>' +
          '<td data-num="' + (t.distinct_keys || 0) + '">' + fmt(t.distinct_keys) + '</td>' +
          '<td data-num="' + (t.distinct_ips || 0) + '">' + fmt(t.distinct_ips || 0) + (t.sample_ip ? ' <span class="muted">' + escapeHTML(t.sample_ip) + (t.distinct_ips > 1 ? ' 외' : '') + '</span>' : '') + '</td>' +
          '<td>' + mcpToolRiskControls(idx) + '</td>' +
          '<td><button class="secondary" type="button" onclick="mcpToolRequests(\'' + escapeAttr(sl) + '\',\'' + escapeAttr(t.tool_name) + '\',false)">호출</button> ' +
          (t.errors > 0 ? '<button class="danger" type="button" onclick="mcpToolRequests(\'' + escapeAttr(sl) + '\',\'' + escapeAttr(t.tool_name) + '\',true)">오류</button>' : '') +
          '</td>' +
        '</tr>';
      }).join('');
      const toolTable = tools.length ?
        '<table><thead><tr><th data-sort="str">tool</th><th data-sort="str">risk</th><th data-sort="str">action</th><th data-sort="num">정의</th><th data-sort="num">호출</th><th data-sort="num">결과</th><th data-sort="num">오류</th><th data-sort="num">오류율</th><th data-sort="num">고유 키</th><th data-sort="num">호출 IP</th><th>정책</th><th>드릴다운</th></tr></thead><tbody>' + toolRows + '</tbody></table>'
        : '<div class="empty">tool 기록 없음</div>';

      // ---- policy section ----
      const modeLabel = (m) => ({ allow: '허용', block: '차단', warn: '경고' }[m] || m);
      const modeBadge = (m) => '<span class="status ' + (m === 'block' ? 'error' : (m === 'warn' ? 'warn' : '')) + '">' + modeLabel(m) + '</span>';
      const policyRows = policies.map(p =>
        '<tr><td>' + escapeHTML(p.server_label) + '</td><td>' + modeBadge(p.mode) + '</td>' +
        '<td>' + escapeHTML(p.note || '') + '</td>' +
        '<td><button class="danger" type="button" onclick="deleteMCPPolicy(\'' + escapeAttr(p.server_label) + '\')">삭제</button></td></tr>'
      ).join('');
      const policyTable = policies.length ?
        '<table><thead><tr><th data-sort="str">서버</th><th>모드</th><th>메모</th><th>동작</th></tr></thead><tbody>' + policyRows + '</tbody></table>'
        : '<div class="empty">정책 없음. allowlist 모드가 켜지면 허용 목록에 없는 MCP 서버는 모두 차단됩니다.</div>';
      const allowlistToggle =
        '<div class="toolbar" style="border-bottom:0">' +
          '<label style="display:flex; align-items:center; gap:6px; font-weight:700">' +
            '<input type="checkbox" id="mcp-allowlist" ' + (allowlistEnabled ? 'checked' : '') + ' style="width:auto; height:auto; min-width:0"> ' +
            'Allowlist 모드 (허용된 서버만 통과)' +
          '</label>' +
          '<span class="muted">' + (allowlistEnabled ? '켜짐 — 미등록 MCP 서버 차단' : '꺼짐 — block 지정 서버만 차단') + '</span>' +
        '</div>';
      const policyForm =
        '<form class="inline-form" id="mcp-policy-form" style="grid-template-columns: minmax(140px,1fr) 110px minmax(140px,1fr) 80px;">' +
          '<input id="mcp-policy-server" placeholder="서버 라벨 (예: github)" required>' +
          '<select id="mcp-policy-mode"><option value="allow">허용</option><option value="block">차단</option><option value="warn">경고</option></select>' +
          '<input id="mcp-policy-note" placeholder="메모">' +
          '<button type="submit">저장</button>' +
        '</form>';

      // ---- loop section ----
      const loopRows = loops.map(l =>
        '<tr class="' + (l.calls >= 30 ? '' : '') + '">' +
          '<td>' + escapeHTML(l.session_id) + '</td>' +
          '<td>' + (l.is_mcp ? '<span class="pill">MCP</span> ' : '') + escapeHTML((l.server_label && l.server_label !== '(none)') ? (l.server_label + ' · ' + l.tool_name) : l.tool_name) + '</td>' +
          '<td data-num="' + l.calls + '"><span class="status ' + (l.calls >= 30 ? 'error' : 'warn') + '">' + fmt(l.calls) + '회</span></td>' +
          '<td data-num="' + (l.errors || 0) + '">' + fmt(l.errors) + '</td>' +
          '<td>' + (l.api_key_id ? '<a href="#/users/' + encodeURIComponent(l.api_key_id) + '">' + escapeHTML(l.api_key_id) + '</a>' : '') + '</td>' +
          '<td>' + ago(l.last_seen) + '</td>' +
        '</tr>'
      ).join('');
      const loopTable = loops.length ?
        '<table><thead><tr><th data-sort="str">세션</th><th data-sort="str">도구</th><th data-sort="num">호출수</th><th data-sort="num">오류</th><th>API 키</th><th data-sort="str">마지막</th></tr></thead><tbody>' + loopRows + '</tbody></table>'
        : '<div class="empty">최근 24시간 내 반복 호출(≥10회) 의심 세션 없음.</div>';

      // ---- catalog (drift) section ----
      const catalogRows = catalog.map(c =>
        '<tr>' +
          '<td>' + escapeHTML(c.server_label) + '</td>' +
          '<td>' + (c.is_mcp ? '<span class="pill">MCP</span> ' : '') + escapeHTML(c.tool_name) +
            (c.is_new ? ' <span class="status warn">신규</span>' : '') +
            (c.is_stale ? ' <span class="status">미사용</span>' : '') + '</td>' +
          '<td>' + ago(c.first_seen) + '</td>' +
          '<td>' + ago(c.last_seen) + '</td>' +
        '</tr>'
      ).join('');
      const catalogTable = catalog.length ?
        '<table><thead><tr><th data-sort="str">서버</th><th data-sort="str">도구</th><th data-sort="str">최초 관측</th><th data-sort="str">최근 관측</th></tr></thead><tbody>' + catalogRows + '</tbody></table>'
        : '<div class="empty">관측된 도구 카탈로그 없음. 클라이언트가 tools[] 를 선언하면 서버별로 도구 목록이 누적됩니다.</div>';
      const catalogTitle = '도구 카탈로그 / 드리프트' + (newToolCount > 0 ? ' — 최근 24시간 신규 ' + newToolCount + '개' : '');

      // ---- MCP Gateway upstreams section ----
      const upstreams = upstreamsResp.upstreams || [];
      const discErrors = upstreamsResp.discovery_errors || {};
      const upstreamForm =
        '<form class="inline-form" id="mcp-upstream-form" autocomplete="off" style="grid-template-columns: minmax(120px,1fr) minmax(200px,2fr) minmax(120px,1fr) 70px;">' +
          '<input id="mcp-up-name" placeholder="이름 (네임스페이스)" required>' +
          '<input id="mcp-up-url" type="url" placeholder="Streamable HTTP MCP URL (https://…/mcp)" required>' +
          '<input id="mcp-up-auth" type="password" autocomplete="new-password" placeholder="Bearer 토큰(선택)">' +
          '<button type="submit">추가</button>' +
        '</form>';
      const upstreamRows = upstreams.map(u =>
        '<tr>' +
          '<td><strong>' + escapeHTML(u.name) + '</strong><div class="muted">' + escapeHTML(u.id) + ' · 도구 접두사 <code>' + escapeHTML(u.id) + '__</code></div>' +
            (discErrors[u.name] ? '<div class="status error" style="margin-top:4px" title="' + escapeAttr(discErrors[u.name]) + '">탐색 오류</div>' : '') + '</td>' +
          '<td class="muted">' + escapeHTML(u.url) + '</td>' +
          '<td>' + (u.has_auth ? '<span class="pill">인증</span>' : '<span class="muted">없음</span>') + '</td>' +
          '<td><span class="status ' + (u.enabled ? '' : 'error') + '">' + (u.enabled ? '사용' : '중지') + '</span></td>' +
          '<td><button class="secondary" type="button" onclick="testMCPUpstream(\'' + escapeAttr(u.id) + '\')">테스트/도구</button> ' +
          '<button class="secondary" type="button" onclick="toggleMCPUpstream(\'' + escapeAttr(u.id) + '\',' + (!u.enabled) + ')">' + (u.enabled ? '중지' : '사용') + '</button> ' +
          '<button class="danger" type="button" onclick="deleteMCPUpstream(\'' + escapeAttr(u.id) + '\')">삭제</button></td>' +
        '</tr>').join('');
      const upstreamTable = upstreams.length ?
        '<table><thead><tr><th>이름</th><th>URL</th><th>인증</th><th>상태</th><th>동작</th></tr></thead><tbody>' + upstreamRows + '</tbody></table>'
        : '<div class="empty">등록된 업스트림 MCP 서버 없음. 등록하면 게이트웨이 엔드포인트 <code>/mcp</code> 가 모든 서버의 도구를 <code>&lt;이름&gt;__&lt;도구&gt;</code> 로 합쳐 제공합니다.</div>';
      const gatewayHelp = '<div class="muted" style="font-size:12px; padding:0 14px 12px">' +
        '클라이언트(Claude Code·Cursor 등)를 게이트웨이 <code>/mcp</code> 한 곳에만 연결하면 등록된 모든 MCP 서버의 도구를 함께 사용합니다. 도구·프롬프트는 <code>&lt;업스트림ID&gt;__&lt;이름&gt;</code> 로 네임스페이스되고, 호출은 위 정책(allowlist/차단)과 사용자 귀속·관측에 통합됩니다. (Streamable HTTP 업스트림 지원)' +
        '<br><strong>등록 확인</strong>: 각 행의 <em>테스트/도구</em> 버튼으로 연결·노출 도구를 즉시 확인. ' +
        '<br><strong>호출 검증(curl)</strong>: <code>curl -s http://&lt;gateway&gt;:8080/mcp -H "Authorization: Bearer pcg_..." -H "Content-Type: application/json" -d \'{"jsonrpc":"2.0","id":1,"method":"tools/list"}\'</code> → 집약된 도구 목록 JSON. ' +
        '<code>tools/call</code> 은 <code>{"method":"tools/call","params":{"name":"&lt;업스트림ID&gt;__&lt;도구&gt;","arguments":{}}}</code>. ' +
        '<br><strong>클라이언트 설정</strong>: MCP 서버 URL 을 <code>http://&lt;gateway&gt;:8080/mcp</code>, 헤더 <code>Authorization: Bearer &lt;발급키&gt;</code>.' +
        '</div>';

      document.getElementById('view').innerHTML =
        section('MCP / Tool 요약', kpis + filterBar) +
        section('MCP Gateway — 업스트림 서버 (단일 /mcp 로 집약)', upstreamForm + upstreamTable + gatewayHelp) +
        section('MCP 서버별', serverTable) +
        section('Tool 리더보드', toolTable) +
        section('에이전트 루프 의심 (세션별 반복 호출 ≥ 10)', loopTable) +
        section(catalogTitle, catalogTable) +
        section('MCP 서버 정책', allowlistToggle + policyForm + policyTable);

      document.getElementById('mcp-upstream-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const body = {
          name: document.getElementById('mcp-up-name').value.trim(),
          url: document.getElementById('mcp-up-url').value.trim(),
          auth_token: document.getElementById('mcp-up-auth').value,
        };
        if (!body.name || !body.url) { alert('이름과 URL을 입력하세요'); return; }
        await api('/admin/mcp/upstreams', { method: 'POST', body: JSON.stringify(body) });
        route();
      });

      document.getElementById('mcp-filter').addEventListener('submit', (e) => {
        e.preventDefault();
        const p = new URLSearchParams();
        const k = document.getElementById('mcp-api-key').value.trim();
        const sv = document.getElementById('mcp-server').value.trim();
        const tv = document.getElementById('mcp-tool').value.trim();
        const rv = document.getElementById('mcp-risk-filter').value;
        const av = document.getElementById('mcp-action-filter').value;
        const cv = document.getElementById('mcp-configured-filter').value;
        if (k) p.set('api_key_id', k);
        if (sv) p.set('server', sv);
        if (tv) p.set('tool', tv);
        if (rv) p.set('risk_level', rv);
        if (av) p.set('action', av);
        if (cv) p.set('configured', cv);
        if (document.getElementById('mcp-only').checked) p.set('mcp_only', '1');
        location.hash = '#/mcp' + (p.toString() ? '?' + p.toString() : '');
      });
      document.getElementById('mcp-policy-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        await api('/admin/mcp/policies', { method: 'POST', body: JSON.stringify({
          server_label: document.getElementById('mcp-policy-server').value.trim(),
          mode: document.getElementById('mcp-policy-mode').value,
          note: document.getElementById('mcp-policy-note').value.trim(),
        }) });
        route();
      });
      document.getElementById('mcp-allowlist').addEventListener('change', async (e) => {
        await api('/admin/mcp/policies', { method: 'POST', body: JSON.stringify({ allowlist_enabled: e.target.checked }) });
        route();
      });
      makeSortable('#view', 'mcp');
    }
    function mcpRiskOption(value, current) {
      return '<option value="' + value + '" ' + (value === current ? 'selected' : '') + '>' + value + '</option>';
    }
    function mcpToolRiskControls(idx) {
      if (idx < 0) return '<span class="muted">risk 정보 없음</span>';
      const risk = (window.mcpToolRiskRows || [])[idx] || {};
      const level = risk.risk_level || 'low';
      const action = risk.action || 'allow';
      return '<div style="display:flex; gap:6px; align-items:center; flex-wrap:wrap">' +
        '<select id="mcp-risk-level-' + idx + '" style="width:100px">' +
          mcpRiskOption('low', level) +
          mcpRiskOption('medium', level) +
          mcpRiskOption('high', level) +
          mcpRiskOption('critical', level) +
        '</select>' +
        '<select id="mcp-risk-action-' + idx + '" style="width:138px">' +
          mcpRiskOption('allow', action) +
          mcpRiskOption('require_approval', action) +
          mcpRiskOption('block', action) +
        '</select>' +
        '<input id="mcp-risk-note-' + idx + '" placeholder="메모" value="' + escapeHTML(risk.note || '') + '" style="width:130px">' +
        '<button class="secondary" type="button" onclick="saveMCPToolRisk(' + idx + ')">저장</button>' +
      '</div>';
    }
    window.saveMCPToolRisk = async (idx) => {
      const risk = (window.mcpToolRiskRows || [])[idx];
      if (!risk) return;
      try {
        await api('/admin/mcp/tools', { method: 'POST', body: JSON.stringify({
          server_label: risk.server_label,
          tool_name: risk.tool_name,
          risk_level: document.getElementById('mcp-risk-level-' + idx).value,
          action: document.getElementById('mcp-risk-action-' + idx).value,
          note: document.getElementById('mcp-risk-note-' + idx).value.trim(),
        }) });
        route();
      } catch (err) {
        openModal('MCP Tool Risk 저장 오류', '<div class="error-line">' + escapeHTML(err.message) + '</div>');
      }
    };
    window.deleteMCPPolicy = async (server) => {
      if (!confirm('서버 정책 "' + server + '" 을(를) 삭제하시겠습니까?')) return;
      await api('/admin/mcp/policies/' + encodeURIComponent(server), { method: 'DELETE' });
      route();
    };
    window.toggleMCPUpstream = async (id, enabled) => {
      await api('/admin/mcp/upstreams/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify({ enabled }) });
      route();
    };
    window.deleteMCPUpstream = async (id) => {
      if (!confirm('업스트림 MCP 서버 "' + id + '" 을(를) 삭제하시겠습니까?')) return;
      await api('/admin/mcp/upstreams/' + encodeURIComponent(id), { method: 'DELETE' });
      route();
    };
    window.testMCPUpstream = async (id) => {
      openModal('업스트림 테스트 — ' + id, '<div class="muted" style="padding:14px">연결 중…</div>');
      try {
        const d = await api('/admin/mcp/upstreams/' + encodeURIComponent(id) + '/probe');
        const errs = d.errors || {};
        const status = d.ok
          ? '<span class="status">연결 성공</span> 도구 ' + fmt(d.tool_count || 0) + '개'
          : '<span class="status error">연결 실패</span> ' + escapeHTML(errs.tools || '도구 목록 조회 실패');
        const listBlock = (title, items, render) => items && items.length
          ? '<h4 style="margin:14px 0 6px; font-size:14px">' + title + ' (' + items.length + ')</h4><div class="kv">' + items.map(render).join('') + '</div>'
          : '';
        const toolBlock = listBlock('도구', d.tools, t =>
          '<div class="k"><code>' + escapeHTML(t.namespaced) + '</code></div><div class="v muted">' + escapeHTML(t.description || '') + '</div>');
        const resBlock = listBlock('리소스', d.resources, x =>
          '<div class="k"><code>' + escapeHTML(x.uri) + '</code></div><div class="v muted">' + escapeHTML(x.name || '') + '</div>');
        const promptBlock = listBlock('프롬프트', d.prompts, x =>
          '<div class="k"><code>' + escapeHTML(x.namespaced) + '</code></div><div class="v"></div>');
        const otherErrs = ['resources', 'prompts'].filter(k => errs[k]).map(k => '<div class="muted" style="font-size:12px">' + k + ': ' + escapeHTML(errs[k]) + '</div>').join('');
        openModal('업스트림 테스트 — ' + escapeHTML(d.name || id),
          '<div style="padding:14px">' +
            '<div style="margin-bottom:6px">' + status + '</div>' +
            '<div class="muted" style="font-size:12px; margin-bottom:8px">' + escapeHTML(d.url || '') + '</div>' +
            (d.tools && d.tools.length ? '<div class="muted" style="font-size:12px">게이트웨이에서 호출 시 위 <code>네임스페이스</code> 이름을 사용하세요.</div>' : '') +
            toolBlock + resBlock + promptBlock +
            (otherErrs ? '<h4 style="margin:14px 0 6px; font-size:14px">선택 기능 오류</h4>' + otherErrs : '') +
          '</div>');
      } catch (err) {
        openModal('업스트림 테스트 — ' + id, '<div class="error-line">' + escapeHTML(err.message) + '</div>');
      }
    };
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
    function incidentsTable(incidents) {
      if (!incidents.length) return '<div class="empty">최근 7일 내 감지된 프로바이더 장애 없음 (시간당 폴백/5xx ≥ 5건 기준)</div>';
      return '<table><thead><tr><th data-sort="str">프로바이더</th><th data-sort="str">시작</th><th data-sort="str">종료</th>' +
        '<th data-sort="num">폴백</th><th data-sort="num">5xx</th><th data-sort="num">영향 사용자</th><th data-sort="num">요청</th><th>상태</th></tr></thead><tbody>' +
        incidents.map(i => '<tr>' +
          '<td><strong>' + escapeHTML(i.provider) + '</strong></td>' +
          '<td>' + ago(i.started_at) + '</td>' +
          '<td>' + ago(i.ended_at) + '</td>' +
          '<td data-num="' + (i.failovers || 0) + '">' + fmt(i.failovers) + '</td>' +
          '<td data-num="' + (i.errors_5xx || 0) + '">' + fmt(i.errors_5xx) + '</td>' +
          '<td data-num="' + (i.affected_users || 0) + '">' + fmt(i.affected_users) + '명</td>' +
          '<td data-num="' + (i.requests || 0) + '">' + fmt(i.requests) + '</td>' +
          '<td>' + (i.ongoing ? '<span class="status error">진행 중</span>' : '<span class="status">종료</span>') + '</td>' +
        '</tr>').join('') + '</tbody></table>' +
        '<div class="muted" style="font-size:12px; padding:8px 14px 12px">폴백(자동 전환) 또는 5xx 가 시간당 ' + '5건 이상인 시간대를 프로바이더별로 묶어 장애로 추정합니다. 연속된 시간대는 한 건으로 병합. 예: "openai 응답 장애 → anthropic 자동 전환, 폴백 212회, 영향 사용자 18명". API: <code>GET /admin/incidents?window=7d&min_events=5</code></div>';
    }
    async function renderSafety() {
      const [kill, alerts, cost, policiesResp, secretResp, policyResp, approvalResp, incidentsResp] = await Promise.all([
        api('/admin/kill-switch'),
        api('/admin/alerts'),
        api('/admin/cost').catch(() => ({ enabled: false, threshold_krw: 0 })),
        api('/admin/policies').catch(() => ({ policies: [] })),
        api('/admin/security/secrets?window=24h&limit=80').catch(() => ({ secret_events: [], count: 0, filters: {} })),
        api('/admin/policies/decisions?window=24h&limit=80').catch(() => ({ policy_decisions: [], count: 0, filters: {} })),
        api('/admin/approvals?status=pending&window=24h&limit=50').catch(() => ({ approvals: [], count: 0, filters: {} })),
        api('/admin/incidents?window=7d').catch(() => ({ incidents: [] })),
      ]);
      const rules = alerts.rules || [];
      const events = alerts.events || [];
      const aiPolicies = policiesResp.policies || [];
      window.safetyPolicies = aiPolicies;
      const secretEvents = secretResp.secret_events || [];
      const policyDecisions = policyResp.policy_decisions || [];
      const approvals = approvalResp.approvals || [];
      const incidents = incidentsResp.incidents || [];

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

      const costCard = '<div style="padding:14px">' +
        '<div class="kv">' +
          row('상태', cost.enabled ? '<span class="status warn">가드 켜짐</span>' : '<span class="status">꺼짐</span>') +
          row('임계값', money(cost.threshold_krw || 0) + ' <span class="muted">(예상 비용이 이 값을 넘으면 차단)</span>') +
        '</div>' +
        '<div style="margin-top:12px; display:flex; gap:8px; align-items:center; flex-wrap:wrap">' +
          '<label style="display:flex; align-items:center; gap:6px; font-weight:700"><input type="checkbox" id="cost-enabled" ' + (cost.enabled ? 'checked' : '') + ' style="width:auto; height:auto; min-width:0"> 가드 사용</label>' +
          '<input id="cost-threshold" type="number" min="0" step="100" value="' + (cost.threshold_krw || 0) + '" placeholder="임계값(KRW)" style="width:160px">' +
          '<button id="cost-save" class="secondary" type="button">저장</button>' +
        '</div>' +
        '<div class="muted" style="margin-top:8px; font-size:12px">예상 비용이 임계값을 초과하면 HTTP 402 로 차단합니다. 클라이언트가 <code>X-Cost-Approve: 1</code> 헤더를 보내면 승인되어 통과합니다. 모든 chat 응답에는 <code>X-Estimated-Input-Tokens / X-Estimated-Output-Tokens / X-Estimated-Cost-KRW / X-Estimated-Latency-MS</code> 헤더가 붙습니다. 예상 출력 토큰은 모델별 최근 7일 평균(표본 부족 시 max_tokens 또는 기본 600).</div>' +
        '<div style="margin-top:12px; display:flex; gap:8px; align-items:flex-end; flex-wrap:wrap">' +
          '<label class="muted" style="font-size:12px">모델<br><input id="cp-model" placeholder="gpt-4.1" style="width:160px"></label>' +
          '<label class="muted" style="font-size:12px">입력 토큰<br><input id="cp-input" type="number" min="0" value="2000" style="width:110px"></label>' +
          '<label class="muted" style="font-size:12px">max_tokens<br><input id="cp-max" type="number" min="0" value="0" style="width:110px"></label>' +
          '<button id="cp-run" class="secondary" type="button">비용 예측</button>' +
          '<span id="cp-result" class="muted" style="font-size:13px"></span>' +
        '</div>' +
      '</div>';

      const policyDecisionCard =
        '<form class="inline-form" id="policy-decision-form" style="grid-template-columns: 120px repeat(6, minmax(110px, 1fr)) 90px;">' +
          '<select id="pd-window">' +
            '<option value="1h">1시간</option>' +
            '<option value="6h">6시간</option>' +
            '<option value="24h" selected>24시간</option>' +
            '<option value="7d">7일</option>' +
            '<option value="30d">30일</option>' +
          '</select>' +
          '<select id="pd-decision">' +
            '<option value="">전체 판단</option>' +
            '<option value="block">block</option>' +
            '<option value="require_approval">require_approval</option>' +
            '<option value="deny_model">deny_model</option>' +
            '<option value="deny_provider">deny_provider</option>' +
            '<option value="mask">mask</option>' +
            '<option value="detect">detect</option>' +
          '</select>' +
          '<input id="pd-request" placeholder="request_id">' +
          '<input id="pd-team" placeholder="team_id">' +
          '<input id="pd-key" placeholder="api_key_id">' +
          '<input id="pd-model" placeholder="model">' +
          '<input id="pd-policy" placeholder="policy_id">' +
          '<button type="submit">조회</button>' +
        '</form>' +
        '<div id="policy-decision-results">' + policyDecisionTable(policyDecisions, policyResp) + '</div>';

      const approvalCard =
        '<form class="inline-form" id="approval-form" style="grid-template-columns: 110px 120px repeat(7, minmax(110px, 1fr)) 80px;">' +
          '<select id="approval-window">' +
            '<option value="1h">1시간</option>' +
            '<option value="6h">6시간</option>' +
            '<option value="24h" selected>24시간</option>' +
            '<option value="7d">7일</option>' +
            '<option value="30d">30일</option>' +
            '<option value="">전체 기간</option>' +
          '</select>' +
          '<select id="approval-status">' +
            '<option value="pending" selected>pending</option>' +
            '<option value="approved">approved</option>' +
            '<option value="rejected">rejected</option>' +
            '<option value="expired">expired</option>' +
            '<option value="">전체</option>' +
          '</select>' +
          '<input id="approval-id" placeholder="approval_id">' +
          '<input id="approval-request" placeholder="request_id">' +
          '<input id="approval-team" placeholder="team_id">' +
          '<input id="approval-key" placeholder="api_key_id">' +
          '<input id="approval-user" placeholder="user_id">' +
          '<input id="approval-subject" placeholder="subject_type">' +
          '<input id="approval-subject-id" placeholder="subject_id">' +
          '<button type="submit">조회</button>' +
        '</form>' +
        '<div class="muted" style="padding:0 12px 10px; font-size:12px">승인/거절 후 클라이언트는 <code>X-Governance-Approval-ID</code>로 같은 요청을 재전송합니다.</div>' +
        '<div id="approval-results">' + approvalQueueTable(approvals, approvalResp) + '</div>';

      const policyCard =
        '<form class="inline-form" id="ai-policy-form" style="grid-template-columns: minmax(150px,1.2fr) 110px minmax(130px,1fr) minmax(140px,1fr) minmax(140px,1fr) minmax(140px,1fr) 80px;">' +
          '<input id="ai-pol-name" placeholder="정책 이름" required>' +
          '<input id="ai-pol-priority" type="number" value="100" min="1" max="999" title="낮을수록 먼저 평가">' +
          '<select id="ai-pol-condition">' +
            '<option value="contains_secret">contains_secret</option>' +
            '<option value="risk_score">risk_score</option>' +
            '<option value="complexity_score">complexity_score</option>' +
            '<option value="cost_krw">cost_krw</option>' +
            '<option value="team">team</option>' +
            '<option value="role">role</option>' +
            '<option value="model">model</option>' +
            '<option value="provider">provider</option>' +
            '<option value="mcp_tool">mcp_tool</option>' +
          '</select>' +
          '<input id="ai-pol-condition-value" placeholder="조건값 (예: >80, security, gpt-*)">' +
          '<select id="ai-pol-action">' +
            '<option value="block">block</option>' +
            '<option value="require_approval">require_approval</option>' +
            '<option value="secret_mask">secret_action=mask</option>' +
            '<option value="secret_block">secret_action=block</option>' +
            '<option value="deny_models">deny_models</option>' +
            '<option value="allow_models">allow_models</option>' +
            '<option value="deny_providers">deny_providers</option>' +
            '<option value="allow_providers">allow_providers</option>' +
          '</select>' +
          '<input id="ai-pol-action-value" placeholder="모델/provider 목록(선택)">' +
          '<button type="submit">추가</button>' +
        '</form>' +
        '<div class="muted" style="padding:0 12px 10px; font-size:12px">복잡한 정책은 API로도 등록할 수 있습니다. 이 폼은 자주 쓰는 단일 rule 정책을 빠르게 생성합니다.</div>' +
        '<div id="ai-policy-results">' + aiPolicyTable(aiPolicies) + '</div>';

      const secretFirewallCard =
        '<form class="inline-form" id="secret-event-form" style="grid-template-columns: 110px 120px 150px repeat(4, minmax(110px, 1fr)) 80px;">' +
          '<select id="se-window">' +
            '<option value="1h">1시간</option>' +
            '<option value="6h">6시간</option>' +
            '<option value="24h" selected>24시간</option>' +
            '<option value="7d">7일</option>' +
            '<option value="30d">30일</option>' +
          '</select>' +
          '<select id="se-action">' +
            '<option value="">전체 action</option>' +
            '<option value="detect">detect</option>' +
            '<option value="mask">mask</option>' +
            '<option value="block">block</option>' +
          '</select>' +
          '<input id="se-type" placeholder="secret_type">' +
          '<input id="se-request" placeholder="request_id">' +
          '<input id="se-team" placeholder="team_id">' +
          '<input id="se-key" placeholder="api_key_id">' +
          '<input id="se-user" placeholder="user_id">' +
          '<button type="submit">조회</button>' +
        '</form>' +
        '<div id="secret-event-results">' + secretEventTable(secretEvents, secretResp) + '</div>';

      const html =
        section('긴급 정지 (Kill Switch)', killCard) +
        section('AI Incident (프로바이더 장애 감지, 최근 7일)', incidentsTable(incidents)) +
        section('비용 가드 / 예측 (Cost Guard)', costCard) +
        section('AI 정책 엔진 (AI Policy Engine)', policyCard) +
        section('Secret Firewall 이벤트', secretFirewallCard) +
        section('승인 큐 (Approval Workflow)', approvalCard) +
        section('정책 판단 이벤트 (Policy Decision Audit)', policyDecisionCard) +
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
              '<option value="tool_loop">에이전트 루프(세션 최대 호출수)</option>' +
              '<option value="mcp_new_tools">MCP 신규 도구 수(드리프트)</option>' +
              '<option value="anomaly_zmax">이상 징후 z-score(최대)</option>' +
              '<option value="budget_burn_ratio">예산 소진 예측 비율(최대)</option>' +
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
      document.getElementById('ai-policy-form').addEventListener('submit', addAIPolicy);
      document.getElementById('secret-event-form').addEventListener('submit', refreshSecretEvents);
      document.getElementById('approval-form').addEventListener('submit', refreshApprovals);
      document.getElementById('approval-status').addEventListener('change', refreshApprovals);
      document.getElementById('policy-decision-form').addEventListener('submit', refreshPolicyDecisionEvents);
      document.getElementById('alert-form').addEventListener('submit', addAlert);
      document.getElementById('cost-save').addEventListener('click', async () => {
        await api('/admin/cost', { method: 'POST', body: JSON.stringify({
          enabled: document.getElementById('cost-enabled').checked,
          threshold_krw: Number(document.getElementById('cost-threshold').value || 0),
        }) });
        route();
      });
      document.getElementById('cp-run').addEventListener('click', async () => {
        const out = document.getElementById('cp-result');
        const model = document.getElementById('cp-model').value.trim();
        if (!model) { out.textContent = '모델을 입력하세요'; return; }
        try {
          const e = await api('/admin/cost/predict', { method: 'POST', body: JSON.stringify({
            model,
            input_tokens: Number(document.getElementById('cp-input').value || 0),
            max_tokens: Number(document.getElementById('cp-max').value || 0),
          }) });
          out.innerHTML = '입력 ' + fmt(e.input_tokens) + ' + 출력 ' + fmt(e.output_tokens) + ' tok → ' +
            (e.priced ? '<strong>' + money(e.cost_krw) + '</strong>' : '<span class="status error">가격표 없음</span>') +
            (e.latency_ms ? ' · 예상 지연 ' + Math.round(e.latency_ms) + 'ms' : '') +
            ' <span class="muted">(' + escapeHTML(e.basis) + ')</span>';
        } catch (err) { out.textContent = '오류: ' + err.message; }
      });
      makeSortable('#view', 'safety');
    }

    function approvalQueryFromForm() {
      const p = new URLSearchParams();
      const add = (id, name) => {
        const el = document.getElementById(id);
        const value = el ? el.value.trim() : '';
        if (value) p.set(name, value);
      };
      add('approval-window', 'window');
      add('approval-status', 'status');
      add('approval-id', 'id');
      add('approval-request', 'request_id');
      add('approval-team', 'team_id');
      add('approval-key', 'api_key_id');
      add('approval-user', 'user_id');
      add('approval-subject', 'subject_type');
      add('approval-subject-id', 'subject_id');
      p.set('limit', '120');
      return p;
    }
    async function refreshApprovals(event) {
      if (event && event.preventDefault) event.preventDefault();
      const host = document.getElementById('approval-results');
      host.innerHTML = '<div class="empty">조회 중...</div>';
      try {
        const data = await api('/admin/approvals?' + approvalQueryFromForm().toString());
        host.innerHTML = approvalQueueTable(data.approvals || [], data);
        makeSortable('#approval-results', 'approvals');
      } catch (err) {
        host.innerHTML = '<div class="error-line">' + escapeHTML(err.message) + '</div>';
      }
    }
    function approvalQueueTable(rows, payload) {
      const count = Number((payload || {}).count ?? rows.length);
      const filters = (payload || {}).filters || {};
      const since = filters.since || '';
      const meta = '<div class="muted" style="padding:10px 12px; font-size:12px">' +
        '조회 결과 ' + fmt(count) + '건' + (since ? ' · since ' + escapeHTML(since) : '') +
        ' · 승인 ID나 요청 ID로 좁힌 뒤 XView를 열 수 있습니다.' +
      '</div>';
      if (!rows.length) return meta + '<div class="empty">승인 항목 없음</div>';
      return meta + '<table><thead><tr>' +
        '<th data-sort="str">상태</th><th data-sort="str">승인 ID</th><th>대상</th><th data-sort="num">위험/비용</th><th>사유</th><th data-sort="str">만료</th><th>동작</th>' +
      '</tr></thead><tbody>' +
      rows.map(a => {
        const payload = approvalPayloadSummary(a.payload || '');
        return '<tr>' +
          '<td><span class="status ' + governanceStatusClass(a.status) + '">' + escapeHTML(a.status || '') + '</span></td>' +
          '<td>' + escapeHTML(a.id || '') + '<div class="muted">' + escapeHTML(a.subject_type || '') + '</div></td>' +
          '<td>' + escapeHTML(a.model || payload.model || '') +
            '<div class="muted">' + escapeHTML(a.team_id || a.user_id || a.api_key_id || '') + '</div>' +
            (a.request_id ? '<button class="secondary" type="button" onclick="openExplain(\'' + escapeAttr(a.request_id) + '\')">XView</button>' : '') +
          '</td>' +
          '<td data-num="' + (a.risk_score || 0) + '">risk ' + fmt(a.risk_score || 0) + '<div class="muted">' + money(a.cost_krw || 0) + '</div></td>' +
          '<td>' + escapeHTML(a.reason || '') + (payload.detail ? '<div class="muted">' + escapeHTML(payload.detail) + '</div>' : '') + '</td>' +
          '<td>' + (a.expires_at ? ago(a.expires_at) + '<div class="muted">' + escapeHTML(a.expires_at) + '</div>' : '<span class="muted">-</span>') + '</td>' +
          '<td>' + (a.status === 'pending'
            ? '<button type="button" onclick="decideApproval(\'' + escapeAttr(a.id) + '\',\'approve\')">승인</button> ' +
              '<button class="danger" type="button" onclick="decideApproval(\'' + escapeAttr(a.id) + '\',\'reject\')">거절</button>'
            : '<span class="muted">' + escapeHTML(a.decided_by || '') + '</span>') + '</td>' +
        '</tr>';
      }).join('') + '</tbody></table>';
    }
    function approvalPayloadSummary(raw) {
      if (!raw) return {};
      try {
        const p = JSON.parse(raw);
        const parts = [];
        if (p.provider) parts.push('provider ' + p.provider);
        if (p.endpoint) parts.push(p.endpoint);
        if (p.mcp_server || p.mcp_tool) parts.push([p.mcp_server, p.mcp_tool].filter(Boolean).join('/'));
        return { model: p.model || '', detail: parts.join(' · ') };
      } catch (e) {
        return { detail: raw.slice(0, 120) };
      }
    }
    window.decideApproval = async (id, action) => {
      if (!id) return;
      const label = action === 'approve' ? '승인' : '거절';
      if (!confirm('이 approval을 ' + label + '하시겠습니까?')) return;
      try {
        await api('/admin/approvals/' + encodeURIComponent(id) + '/' + action, { method: 'POST', body: JSON.stringify({}) });
        await refreshApprovals();
      } catch (err) {
        openModal('승인 처리 오류', '<div class="error-line">' + escapeHTML(err.message) + '</div>');
      }
    };

    function aiPolicyTable(rows) {
      if (!rows.length) return '<div class="empty">등록된 AI 정책 없음</div>';
      return '<table><thead><tr>' +
        '<th data-sort="num">우선순위</th><th data-sort="str">정책</th><th>Rules</th><th data-sort="str">상태</th><th>동작</th>' +
      '</tr></thead><tbody>' +
      rows.map((p, idx) => '<tr>' +
        '<td data-num="' + (p.priority || 100) + '">' + fmt(p.priority || 100) + '</td>' +
        '<td>' + escapeHTML(p.name || p.id || '') + '<div class="muted">' + escapeHTML(p.id || '') + '</div>' +
          (p.description ? '<div class="muted">' + escapeHTML(p.description) + '</div>' : '') + '</td>' +
        '<td>' + policyRuleSummary(p.rules || []) + '</td>' +
        '<td><span class="status ' + (p.enabled ? '' : 'error') + '">' + (p.enabled ? 'enabled' : 'disabled') + '</span></td>' +
        '<td><button class="secondary" type="button" onclick="toggleAIPolicy(' + idx + ')">' + (p.enabled ? '중지' : '사용') + '</button></td>' +
      '</tr>').join('') + '</tbody></table>';
    }
    function policyRuleSummary(rules) {
      if (!rules.length) return '<span class="muted">rule 없음</span>';
      return rules.slice(0, 4).map(r => {
        const cond = compactJSON(r.conditions || {});
        const act = compactJSON(r.actions || {});
        return '<div style="margin-bottom:6px"><strong>' + escapeHTML(r.name || r.id || 'rule') + '</strong>' +
          '<div class="muted">if ' + escapeHTML(cond || '{}') + '</div>' +
          '<div class="muted">then ' + escapeHTML(act || '{}') + '</div></div>';
      }).join('') + (rules.length > 4 ? '<div class="muted">+' + fmt(rules.length - 4) + ' rules</div>' : '');
    }
    function compactJSON(value) {
      try { return JSON.stringify(value); } catch (e) { return ''; }
    }
    function splitCSV(value) {
      return String(value || '').split(',').map(v => v.trim()).filter(Boolean);
    }
    function aiPolicyPayloadFromForm() {
      const name = document.getElementById('ai-pol-name').value.trim();
      const priority = Number(document.getElementById('ai-pol-priority').value || 100);
      const conditionKey = document.getElementById('ai-pol-condition').value;
      const conditionValue = document.getElementById('ai-pol-condition-value').value.trim();
      const action = document.getElementById('ai-pol-action').value;
      const actionValue = document.getElementById('ai-pol-action-value').value.trim();
      const conditions = {};
      if (conditionKey === 'contains_secret') {
        conditions.contains_secret = true;
      } else if (conditionKey === 'risk_score' || conditionKey === 'complexity_score' || conditionKey === 'cost_krw') {
        conditions[conditionKey] = conditionValue || '>80';
      } else {
        conditions[conditionKey] = conditionValue || '*';
      }
      const actions = {};
      if (action === 'block') actions.block = true;
      if (action === 'require_approval') actions.require_approval = true;
      if (action === 'secret_mask') actions.secret_action = 'mask';
      if (action === 'secret_block') actions.secret_action = 'block';
      if (action === 'deny_models') actions.deny_models = splitCSV(actionValue || '*');
      if (action === 'allow_models') actions.allow_models = splitCSV(actionValue || '*');
      if (action === 'deny_providers') actions.deny_providers = splitCSV(actionValue || '*');
      if (action === 'allow_providers') actions.allow_providers = splitCSV(actionValue || '*');
      return {
        name,
        description: 'created from Safety tab quick policy form',
        enabled: true,
        priority,
        rules: [{
          name: conditionKey + ' -> ' + action,
          enabled: true,
          priority: 100,
          conditions,
          actions,
        }],
      };
    }
    async function addAIPolicy(event) {
      event.preventDefault();
      const payload = aiPolicyPayloadFromForm();
      if (!payload.name) return;
      try {
        await api('/admin/policies', { method: 'POST', body: JSON.stringify(payload) });
        route();
      } catch (err) {
        openModal('정책 저장 오류', '<div class="error-line">' + escapeHTML(err.message) + '</div>');
      }
    }
    window.toggleAIPolicy = async (idx) => {
      const p = (window.safetyPolicies || [])[idx];
      if (!p) return;
      const next = { ...p, enabled: !p.enabled, rules: p.rules || [] };
      try {
        await api('/admin/policies', { method: 'POST', body: JSON.stringify(next) });
        route();
      } catch (err) {
        openModal('정책 변경 오류', '<div class="error-line">' + escapeHTML(err.message) + '</div>');
      }
    };

    function secretEventQueryFromForm() {
      const p = new URLSearchParams();
      const add = (id, name) => {
        const el = document.getElementById(id);
        const value = el ? el.value.trim() : '';
        if (value) p.set(name, value);
      };
      add('se-window', 'window');
      add('se-action', 'action');
      add('se-type', 'secret_type');
      add('se-request', 'request_id');
      add('se-team', 'team_id');
      add('se-key', 'api_key_id');
      add('se-user', 'user_id');
      p.set('limit', '120');
      return p;
    }
    async function refreshSecretEvents(event) {
      event.preventDefault();
      const host = document.getElementById('secret-event-results');
      host.innerHTML = '<div class="empty">조회 중...</div>';
      try {
        const data = await api('/admin/security/secrets?' + secretEventQueryFromForm().toString());
        host.innerHTML = secretEventTable(data.secret_events || [], data);
        makeSortable('#secret-event-results', 'secret-events');
      } catch (err) {
        host.innerHTML = '<div class="error-line">' + escapeHTML(err.message) + '</div>';
      }
    }
    function secretEventTable(rows, payload) {
      const count = Number((payload || {}).count ?? rows.length);
      const filters = (payload || {}).filters || {};
      const since = filters.since || '';
      const meta = '<div class="muted" style="padding:10px 12px; font-size:12px">' +
        '조회 결과 ' + fmt(count) + '건' + (since ? ' · since ' + escapeHTML(since) : '') +
        ' · Secret 값은 저장하지 않고 hash와 유형만 기록합니다.' +
      '</div>';
      if (!rows.length) return meta + '<div class="empty">Secret Firewall 이벤트 없음</div>';
      return meta +
        '<table><thead><tr>' +
          '<th data-sort="str">시각</th><th data-sort="str">Action</th><th data-sort="str">유형</th><th>대상</th><th>위치 / Hash</th><th>요청</th>' +
        '</tr></thead><tbody>' +
        rows.map(e => {
          const hash = e.matched_hash ? String(e.matched_hash).slice(0, 18) : '';
          return '<tr>' +
            '<td>' + (e.created_at ? ago(e.created_at) : '') + '</td>' +
            '<td><span class="status ' + governanceStatusClass(e.action) + '">' + escapeHTML(e.action || '') + '</span></td>' +
            '<td>' + escapeHTML(e.secret_type || '') + '</td>' +
            '<td>' + escapeHTML(e.team_id || '') +
              '<div class="muted">' + escapeHTML(e.user_id || e.api_key_id || '') + '</div></td>' +
            '<td>' + escapeHTML(e.location || '') +
              (hash ? '<div class="muted" title="' + escapeAttr(e.matched_hash || '') + '">' + escapeHTML(hash) + '</div>' : '') + '</td>' +
            '<td>' + (e.request_id ? '<button class="secondary" type="button" onclick="openExplain(\'' + escapeAttr(e.request_id) + '\')">XView</button><div class="muted">' + escapeHTML(e.request_id) + '</div>' : '<span class="muted">요청 없음</span>') + '</td>' +
          '</tr>';
        }).join('') + '</tbody></table>';
    }

    function policyDecisionQueryFromForm() {
      const p = new URLSearchParams();
      const add = (id, name) => {
        const el = document.getElementById(id);
        const value = el ? el.value.trim() : '';
        if (value) p.set(name, value);
      };
      add('pd-window', 'window');
      add('pd-decision', 'decision');
      add('pd-request', 'request_id');
      add('pd-team', 'team_id');
      add('pd-key', 'api_key_id');
      add('pd-model', 'model');
      add('pd-policy', 'policy_id');
      p.set('limit', '120');
      return p;
    }
    async function refreshPolicyDecisionEvents(event) {
      event.preventDefault();
      const host = document.getElementById('policy-decision-results');
      host.innerHTML = '<div class="empty">조회 중...</div>';
      try {
        const data = await api('/admin/policies/decisions?' + policyDecisionQueryFromForm().toString());
        host.innerHTML = policyDecisionTable(data.policy_decisions || [], data);
        makeSortable('#policy-decision-results', 'policy-decisions');
      } catch (err) {
        host.innerHTML = '<div class="error-line">' + escapeHTML(err.message) + '</div>';
      }
    }
    function policyDecisionTable(rows, payload) {
      const count = Number((payload || {}).count ?? rows.length);
      const since = ((payload || {}).filters || {}).since || '';
      const meta = '<div class="muted" style="padding:10px 12px; font-size:12px">' +
        '조회 결과 ' + fmt(count) + '건' + (since ? ' · since ' + escapeHTML(since) : '') +
        ' · 행의 요청 링크를 열면 XView 설명으로 이동합니다.' +
      '</div>';
      if (!rows.length) return meta + '<div class="empty">정책 판단 이벤트 없음</div>';
      return meta +
        '<table><thead><tr>' +
          '<th data-sort="str">시각</th><th data-sort="str">판단</th><th data-sort="str">정책 / 룰</th><th data-sort="str">대상</th><th data-sort="num">점수</th><th>근거</th><th>요청</th>' +
        '</tr></thead><tbody>' +
        rows.map(e => '<tr>' +
          '<td>' + (e.created_at ? ago(e.created_at) : '') + '<div class="muted">' + escapeHTML(e.phase || '') + '</div></td>' +
          '<td><span class="status ' + governanceStatusClass(e.decision) + '">' + escapeHTML(e.decision || '') + '</span></td>' +
          '<td>' + escapeHTML(e.policy_id || '') + '<div class="muted">' + escapeHTML(e.rule_name || e.rule_id || '') + '</div></td>' +
          '<td>' + escapeHTML(e.model || '') + '<div class="muted">' + escapeHTML(e.provider || e.endpoint || '') + '</div>' +
            '<div class="muted">' + escapeHTML(e.team_id || e.api_key_id || '') + '</div></td>' +
          '<td data-num="' + (e.risk_score || 0) + '">risk ' + fmt(e.risk_score || 0) + '<div class="muted">complexity ' + fmt(e.complexity_score || 0) + (e.cost_krw ? ' · ' + money(e.cost_krw) : '') + '</div></td>' +
          '<td>' + escapeHTML(e.reason || '') + '</td>' +
          '<td>' + (e.request_id ? '<button class="secondary" type="button" onclick="openExplain(\'' + escapeAttr(e.request_id) + '\')">XView</button><div class="muted">' + escapeHTML(e.request_id) + '</div>' : '<span class="muted">요청 없음</span>') + '</td>' +
        '</tr>').join('') + '</tbody></table>';
    }

    async function toggleKillSwitch(disable) {
      const reason = (document.getElementById('kill-reason') || {}).value || '';
      if (disable && !confirm('정말로 모든 /v1 호출을 즉시 차단하시겠습니까?')) return;
      await api('/admin/kill-switch', { method: 'POST', body: JSON.stringify({ disabled: disable, reason }) });
      route();
    }

    function metricLabel(metric) {
      return { requests: '요청 수', errors: '오류율', krw: 'KRW 비용', tokens: '토큰', latency_p95_ms: '전체 지연 P95', first_chunk_p95_ms: '첫 청크 P95', llm_eval_failures: 'LLM 평가 실패 수', llm_eval_failure_rate: 'LLM 평가 실패율', tool_errors: 'tool 오류 수', tool_error_rate: 'tool 오류율', tool_loop: '에이전트 루프', mcp_new_tools: 'MCP 신규 도구 수', anomaly_zmax: '이상 징후 z-score', budget_burn_ratio: '예산 소진 예측 비율' }[metric] || metric;
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
      const [keys, providers, retention, fallback, audit, routes, learning, knowledge, usersResp, teamsResp, authEvents] = await Promise.all([
        api('/admin/api-keys'),
        api('/admin/providers'),
        api('/admin/retention'),
        api('/admin/fallback'),
        api('/admin/audit-logs?limit=50'),
        api('/admin/routing-rules').catch(() => ({ rules: [] })),
        api('/admin/routing/learning?window=7d').catch(() => ({ recommendations: [], cells: [] })),
        api('/admin/knowledge').catch(() => ({ snippets: [] })),
        api('/admin/users').catch(() => ({ auth_users: [] })),
        api('/admin/teams').catch(() => ({ auth_teams: [] })),
        api('/admin/audit/auth-events?limit=30').catch(() => ({ events: [] })),
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
            '<div id="api-key-list">' + apiKeyTable(keys.api_keys || []) + '</div>'
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
        section('로그인 계정 · 팀 (RBAC)', authAccountsPanel(usersResp.auth_users || [], teamsResp.auth_teams || [], authEvents.events || [])) +
        section('복잡도 기반 비용 최적 라우팅 규칙', routingRulesPanel(routes.rules || [])) +
        section('라우팅 학습 추천 (Routing Learning)', routingLearningPanel(learning)) +
        section('Knowledge Cache (반복 규칙·시스템 프롬프트 중앙 등록)', knowledgePanel(knowledge.snippets || [])) +
        section('데이터 보존 정책', retentionPanel(retention)) +
        section('Fallback 로그 재처리', fallbackPanel(fallback)) +
        section('관리자 변경 이력', auditPanel(audit.audit_logs || []));

      document.getElementById('view').innerHTML = html;
      document.getElementById('key-form').addEventListener('submit', createProxyKey);
      document.getElementById('provider-form').addEventListener('submit', saveProvider);
      const auForm = document.getElementById('auth-user-form');
      if (auForm) auForm.addEventListener('submit', createAuthUser);
      const atForm = document.getElementById('auth-team-form');
      if (atForm) atForm.addEventListener('submit', createAuthTeam);
      const rrForm = document.getElementById('routing-rule-form');
      if (rrForm) rrForm.addEventListener('submit', addRoutingRule);
      const kbForm = document.getElementById('knowledge-form');
      if (kbForm) kbForm.addEventListener('submit', addKnowledge);
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
    const authRoleOptions = ['developer', 'viewer', 'team_admin', 'admin', 'super_admin', 'service_account'];
    function authAccountsPanel(users, teams, events) {
      const note = authState.enabled
        ? ''
        : '<div class="banner warn" style="margin:0 14px 12px">현재 <code>AUTH_ENABLED=false</code> — 계정을 만들어도 로그인 모드가 꺼져 있어 사용되지 않습니다. 켜려면 <code>AUTH_ENABLED=true</code> + <code>AUTH_JWT_SECRET</code> 설정 후 재기동하세요.</div>';
      const teamOptions = '<option value="">팀 없음</option>' +
        teams.map(t => '<option value="' + escapeAttr(t.id) + '">' + escapeHTML(t.name) + '</option>').join('');
      const userForm =
        '<form class="inline-form" id="auth-user-form" autocomplete="off" style="grid-template-columns: minmax(160px,1.4fr) minmax(120px,1fr) minmax(100px,1fr) 130px minmax(110px,1fr) 70px;">' +
          '<input id="au-email" type="email" placeholder="이메일" required>' +
          '<input id="au-password" type="password" autocomplete="new-password" placeholder="초기 비밀번호" required>' +
          '<input id="au-name" placeholder="이름">' +
          '<select id="au-role">' + authRoleOptions.map(r => '<option value="' + r + '"' + (r === 'developer' ? ' selected' : '') + '>' + r + '</option>').join('') + '</select>' +
          '<select id="au-team">' + teamOptions + '</select>' +
          '<button type="submit">생성</button>' +
        '</form>';
      const roleSelect = (u) => '<select onchange="applyAuthUserRole(\'' + escapeAttr(u.id) + '\', this.value)">' +
        authRoleOptions.map(r => '<option value="' + r + '"' + (r === u.role ? ' selected' : '') + '>' + r + '</option>').join('') + '</select>';
      const teamSelect = (u) => '<select onchange="applyAuthUserTeam(\'' + escapeAttr(u.id) + '\', this.value)">' +
        '<option value=""' + (!u.team_id ? ' selected' : '') + '>팀 없음</option>' +
        teams.map(t => '<option value="' + escapeAttr(t.id) + '"' + (t.id === u.team_id ? ' selected' : '') + '>' + escapeHTML(t.name) + '</option>').join('') + '</select>';
      const userTable = users.length ?
        '<table><thead><tr><th data-sort="str">이메일 / 이름</th><th>역할</th><th>팀</th><th data-sort="str">상태</th><th data-sort="str">생성</th><th>동작</th></tr></thead><tbody>' +
        users.map(u => '<tr>' +
          '<td><strong>' + escapeHTML(u.email) + '</strong><div class="muted">' + escapeHTML(u.name || '') + ' · ' + escapeHTML(u.id) + '</div></td>' +
          '<td>' + roleSelect(u) + '</td>' +
          '<td>' + teamSelect(u) + '</td>' +
          '<td><span class="status ' + (u.status === 'active' ? '' : 'error') + '">' + (u.status === 'active' ? '활성' : '비활성') + '</span></td>' +
          '<td>' + ago(u.created_at) + '</td>' +
          '<td><button class="' + (u.status === 'active' ? 'danger' : 'secondary') + '" type="button" onclick="toggleAuthUser(\'' + escapeAttr(u.id) + '\', \'' + (u.status === 'active' ? 'disabled' : 'active') + '\')">' + (u.status === 'active' ? '비활성화' : '활성화') + '</button></td>' +
        '</tr>').join('') + '</tbody></table>'
        : '<div class="empty">로그인 계정 없음. 부트스트랩 계정은 AUTH_ADMIN_BOOTSTRAP_EMAIL/PASSWORD 로 첫 기동 시 자동 생성됩니다.</div>';
      const teamForm =
        '<form class="inline-form" id="auth-team-form" autocomplete="off" style="grid-template-columns: minmax(160px,1fr) 70px;">' +
          '<input id="at-name" placeholder="팀 이름 (예: platform)" required>' +
          '<button type="submit">팀 생성</button>' +
        '</form>';
      const teamList = teams.length
        ? '<div style="padding:0 14px 12px; display:flex; gap:8px; flex-wrap:wrap">' + teams.map(t => '<span class="pill">' + escapeHTML(t.name) + ' <span class="muted">' + escapeHTML(t.id) + '</span></span>').join('') + '</div>'
        : '<div class="empty">인증 팀 없음</div>';
      const eventTable = events.length ?
        '<table><thead><tr><th data-sort="str">시각</th><th data-sort="str">이벤트</th><th>대상</th><th>IP</th><th>상세</th></tr></thead><tbody>' +
        events.map(e => {
          const bad = ['login_failed', 'api_key_denied', 'ip_denied', 'scope_denied', 'model_denied', 'budget_denied'].indexOf(e.event_type) >= 0;
          return '<tr>' +
            '<td>' + ago(e.created_at) + '</td>' +
            '<td><span class="status ' + (bad ? 'error' : '') + '">' + escapeHTML(e.event_type) + '</span></td>' +
            '<td>' + escapeHTML(e.actor_user_id || e.api_key_id || '') + '</td>' +
            '<td>' + escapeHTML(e.ip || '') + '</td>' +
            '<td>' + escapeHTML(e.detail || '') + '</td>' +
          '</tr>';
        }).join('') + '</tbody></table>'
        : '<div class="empty">인증 이벤트 없음</div>';
      return note +
        '<h3 style="margin:6px 14px 8px; font-size:14px">계정</h3>' + userForm + userTable +
        '<h3 style="margin:14px 14px 8px; font-size:14px">팀</h3>' + teamForm + teamList +
        '<h3 style="margin:14px 14px 8px; font-size:14px">최근 인증 이벤트</h3>' + eventTable +
        '<div class="muted" style="font-size:12px; padding:8px 14px 12px">역할 변경은 즉시 적용되며 <code>role_changed</code> 로 감사 기록됩니다. 비활성화하면 그 계정의 모든 세션·refresh token이 즉시 폐기됩니다. team_admin 은 자기 팀의 계정 생성만 가능하고 역할 변경/비활성화는 불가합니다.</div>';
    }
    async function createAuthUser(e) {
      e.preventDefault();
      const body = {
        email: document.getElementById('au-email').value.trim(),
        password: document.getElementById('au-password').value,
        name: document.getElementById('au-name').value.trim(),
        role: document.getElementById('au-role').value,
        team_id: document.getElementById('au-team').value,
      };
      if (!body.email || !body.password) { alert('이메일과 초기 비밀번호를 입력하세요'); return; }
      await api('/admin/users', { method: 'POST', body: JSON.stringify(body) });
      route();
    }
    window.applyAuthUserRole = async (id, role) => {
      if (!confirm('이 계정의 역할을 "' + role + '" 로 변경하시겠습니까?')) { route(); return; }
      await api('/admin/users/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify({ role }) });
      route();
    };
    window.applyAuthUserTeam = async (id, teamId) => {
      const label = teamId || '팀 없음';
      if (!confirm('이 계정의 팀을 "' + label + '" 로 변경하시겠습니까?')) { route(); return; }
      await api('/admin/users/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify({ team_id: teamId }) });
      route();
    };
    window.toggleAuthUser = async (id, status) => {
      const msg = status === 'disabled'
        ? '이 계정을 비활성화하시겠습니까? 모든 활성 세션과 refresh token이 즉시 폐기됩니다.'
        : '이 계정을 다시 활성화하시겠습니까?';
      if (!confirm(msg)) return;
      await api('/admin/users/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify({ status }) });
      route();
    };
    async function createAuthTeam(e) {
      e.preventDefault();
      const name = document.getElementById('at-name').value.trim();
      if (!name) return;
      await api('/admin/teams', { method: 'POST', body: JSON.stringify({ name }) });
      route();
    }
    const allApiScopes = ['chat:completion', 'embeddings:create', 'models:read', 'admin:read', 'admin:write', 'routing:read', 'routing:write', 'observability:read', 'costs:read', 'security:read', 'mcp:use', 'mcp:admin'];
    let apiKeysCache = {};
    function canHardDeleteKeys() {
      return !authState.enabled || (authState.user && authState.user.role === 'super_admin');
    }
    function apiKeyTable(rows) {
      if (!rows.length) return '<div class="empty">발급된 키 없음</div>';
      apiKeysCache = {};
      rows.forEach(r => { apiKeysCache[r.id] = r; });
      const scopesCell = (r) => {
        const sc = r.scopes || [];
        if (!sc.length) return '<span class="muted">전체(미지정)</span>';
        const shown = sc.slice(0, 3).map(s => '<span class="pill">' + escapeHTML(s) + '</span>').join(' ');
        return shown + (sc.length > 3 ? ' <span class="muted">+' + (sc.length - 3) + '</span>' : '');
      };
      return '<table><thead><tr>' +
        '<th data-sort="str">이름</th>' +
        '<th data-sort="str">소유자</th>' +
        '<th data-sort="str">팀</th>' +
        '<th>스코프</th>' +
        '<th data-sort="str">상태</th>' +
        '<th>동작</th></tr></thead><tbody>' +
        rows.map(r =>
          '<tr><td><a href="#/users/' + encodeURIComponent(r.id) + '">' + escapeHTML(r.name) + '</a><div class="muted">' + escapeHTML(r.id) + '</div></td>' +
          '<td>' + escapeHTML(r.owner || '') + '</td><td>' + escapeHTML(r.team || '') + '</td>' +
          '<td>' + scopesCell(r) + '</td>' +
          '<td><span class="status ' + (r.status === 'active' ? '' : 'error') + '">' + (r.status === 'active' ? '활성' : '비활성') + '</span></td>' +
          '<td><button class="ghost" type="button" onclick="openScopeEditor(\'' + r.id + '\')">스코프</button> ' +
          '<button class="secondary" type="button" onclick="setKeyStatus(\'' + r.id + '\', \'' + (r.status === 'active' ? 'disabled' : 'active') + '\')">' + (r.status === 'active' ? '비활성화' : '활성화') + '</button>' +
          (canHardDeleteKeys() ? ' <button class="danger" type="button" onclick="hardDeleteKey(\'' + r.id + '\', \'' + escapeAttr(r.name) + '\')">삭제</button>' : '') +
          '</td></tr>'
        ).join('') + '</tbody></table>' +
        '<div class="muted" style="font-size:12px; padding:8px 14px 0">스코프 미지정(전체) 키는 모든 API 사용이 가능합니다. "삭제"는 키 행을 영구 제거하며' + (authState.enabled ? ' super_admin 만 가능합니다' : ' 전권 관리자 토큰으로 가능합니다') + ' — 과거 사용 이력은 보존됩니다(이후 external로 표시).</div>';
    }
    window.hardDeleteKey = async (id, name) => {
      if (!confirm('프록시 API 키 "' + name + '" (' + id + ') 를 영구 삭제하시겠습니까?\n비활성화와 달리 되돌릴 수 없습니다. 과거 사용 이력 통계는 유지됩니다.')) return;
      await api('/admin/api-keys/' + encodeURIComponent(id) + '?hard=1', { method: 'DELETE' });
      route();
    };
    window.openScopeEditor = (id) => {
      const key = apiKeysCache[id];
      if (!key) return;
      const current = key.scopes || [];
      const boxes = allApiScopes.map(s =>
        '<label style="display:flex; align-items:center; gap:8px; padding:4px 0; font-size:13px">' +
          '<input type="checkbox" class="scope-box" value="' + s + '"' + (current.indexOf(s) >= 0 ? ' checked' : '') + ' style="width:auto; height:auto; min-width:0">' +
          '<code>' + s + '</code>' +
        '</label>').join('');
      openModal('스코프 편집 — ' + key.name,
        '<div class="muted" style="margin-bottom:10px">이 키로 호출할 수 있는 API 범위를 제한합니다. <strong>전부 해제하면 "전체(미지정)"</strong> 가 되어 모든 API를 허용합니다. 스코프 밖 호출은 403 + <code>scope_denied</code> 감사 기록.</div>' +
        '<div style="columns:2; gap:24px">' + boxes + '</div>' +
        '<div style="margin-top:14px; display:flex; gap:8px">' +
          '<button type="button" onclick="saveScopeEditor(\'' + escapeAttr(id) + '\')">저장</button>' +
          '<button type="button" class="secondary" onclick="closeModal()">취소</button>' +
        '</div>');
    };
    window.saveScopeEditor = async (id) => {
      const scopes = Array.from(document.querySelectorAll('#modal-body .scope-box:checked')).map(b => b.value);
      await api('/admin/api-keys/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify({ scopes }) });
      closeModal();
      route();
    };
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
    function routingRulesPanel(rules) {
      const form =
        '<form class="inline-form" id="routing-rule-form" style="grid-template-columns: 80px minmax(120px,1fr) 80px 80px minmax(140px,1fr) minmax(120px,1fr) minmax(120px,1fr) 70px;">' +
          '<input id="rr-priority" type="number" min="1" value="100" title="우선순위(낮을수록 먼저)">' +
          '<input id="rr-pattern" placeholder="모델 패턴 (예: gpt-*)" value="*">' +
          '<input id="rr-min" type="number" min="0" max="100" value="0" title="최소 복잡도">' +
          '<input id="rr-max" type="number" min="0" max="100" value="34" title="최대 복잡도">' +
          '<input id="rr-target" placeholder="대상 모델 (예: gpt-4.1-mini)" required>' +
          '<input id="rr-provider" placeholder="대상 provider(선택)">' +
          '<input id="rr-note" placeholder="메모">' +
          '<button type="submit">추가</button>' +
        '</form>';
      const tierBadge = (lo, hi) => {
        const mid = (lo + hi) / 2;
        const cls = mid >= 70 ? 'error' : (mid >= 35 ? 'warn' : '');
        return '<span class="status ' + cls + '">' + lo + '–' + hi + '</span>';
      };
      const table = rules.length ?
        '<table><thead><tr><th>우선순위</th><th>모델 패턴</th><th>복잡도</th><th>→ 대상 모델</th><th>대상 provider</th><th>상태</th><th>메모</th><th>동작</th></tr></thead><tbody>' +
        rules.map(r => '<tr>' +
          '<td>' + fmt(r.priority) + '</td>' +
          '<td><span class="pill">' + escapeHTML(r.match_pattern) + '</span></td>' +
          '<td>' + tierBadge(r.min_complexity, r.max_complexity) + '</td>' +
          '<td><strong>' + escapeHTML(r.target_model) + '</strong></td>' +
          '<td>' + (r.target_provider ? escapeHTML(r.target_provider) : '<span class="muted">자동</span>') + '</td>' +
          '<td><span class="status ' + (r.enabled ? '' : 'error') + '">' + (r.enabled ? '사용' : '중지') + '</span></td>' +
          '<td>' + escapeHTML(r.note || '') + '</td>' +
          '<td><button class="secondary" type="button" onclick="toggleRoutingRule(\'' + r.id + '\',' + (!r.enabled) + ')">' + (r.enabled ? '중지' : '사용') + '</button> ' +
          '<button class="danger" type="button" onclick="deleteRoutingRule(\'' + r.id + '\')">삭제</button></td>' +
        '</tr>').join('') + '</tbody></table>'
        : '<div class="empty">규칙 없음. 예: 모델 패턴 <code>*</code>, 복잡도 0–34 → 저가 모델로 자동 다운그레이드.</div>';
      return form + table +
        '<div class="muted" style="padding:0 14px 12px; font-size:12px">클라이언트가 X-Proxy-Provider를 지정하거나 <code>X-Proxy-No-Route: 1</code> 헤더를 보내면 규칙이 적용되지 않습니다. 우선순위가 낮은 규칙부터 첫 매칭을 적용합니다.</div>';
    }
    const wfTaskLabel = { refactor: '리팩토링', generate: '생성', debug: '디버그', explain: '설명/분석', test: '테스트', translate: '변환', docs: '문서', review: '리뷰', other: '기타' };
    const wfBucketLabel = { low: '낮음(0–33)', medium: '중간(34–66)', high: '높음(67–100)' };
    function routingLearningPanel(report) {
      const recs = (report && report.recommendations) || [];
      const cells = (report && report.cells) || [];
      const recTable = recs.length ? (
        '<table><thead><tr><th>작업유형</th><th>복잡도</th><th>추천 모델</th><th data-sort="num">성공률</th><th data-sort="num">평균 비용</th><th data-sort="num">표본</th><th>현재 최다 사용</th><th>동작</th></tr></thead><tbody>' +
        recs.map(r => '<tr>' +
          '<td>' + escapeHTML(wfTaskLabel[r.task_type] || r.task_type) + '</td>' +
          '<td>' + escapeHTML(wfBucketLabel[r.bucket] || r.bucket) + '</td>' +
          '<td><strong>' + escapeHTML(r.recommended_model) + '</strong>' + (r.confident ? '' : ' <span class="status warn" title="비교 모델 중 일부가 표본 부족">저신뢰</span>') + '</td>' +
          '<td data-num="' + r.success_rate + '">' + Math.round((r.success_rate || 0) * 100) + '%</td>' +
          '<td data-num="' + (r.avg_cost_krw || 0) + '">' + money(r.avg_cost_krw || 0) + '</td>' +
          '<td data-num="' + (r.samples || 0) + '">' + fmt(r.samples || 0) + '</td>' +
          '<td>' + (r.differs ? '<span class="status warn">' + escapeHTML(r.top_model) + ' ' + Math.round((r.top_success_rate || 0) * 100) + '%</span>' : '<span class="muted">동일</span>') + '</td>' +
          '<td><button class="secondary" type="button" onclick="applyLearnedRule(\'' + escapeAttr(r.bucket) + '\',\'' + escapeAttr(r.recommended_model) + '\',\'' + escapeAttr(r.task_type) + '\')">규칙으로 적용</button></td>' +
        '</tr>').join('') + '</tbody></table>'
      ) : '<div class="empty">추천할 만한 표본이 아직 부족합니다. 트래픽이 쌓이면 (작업유형 × 복잡도)별 최적 모델이 학습됩니다.</div>';
      const matrix = cells.length ? (
        '<details style="margin-top:8px"><summary style="cursor:pointer; padding:8px 14px; color:var(--muted); font-size:12px">상세 매트릭스 — 작업유형 × 복잡도 × 모델 (' + fmt(cells.length) + '셀)</summary>' +
        '<table><thead><tr><th>작업유형</th><th>복잡도</th><th>모델</th><th data-sort="num">요청</th><th data-sort="num">성공률</th><th data-sort="num">폴백률</th><th data-sort="num">평균 비용</th><th data-sort="num">평균 지연</th><th>피드백</th></tr></thead><tbody>' +
        cells.map(c => '<tr>' +
          '<td>' + escapeHTML(wfTaskLabel[c.task_type] || c.task_type) + '</td>' +
          '<td>' + escapeHTML(wfBucketLabel[c.bucket] || c.bucket) + '</td>' +
          '<td>' + escapeHTML(c.model) + '</td>' +
          '<td data-num="' + c.requests + '">' + fmt(c.requests) + '</td>' +
          '<td data-num="' + c.success_rate + '">' + Math.round((c.success_rate || 0) * 100) + '%</td>' +
          '<td data-num="' + c.fallback_rate + '">' + Math.round((c.fallback_rate || 0) * 100) + '%</td>' +
          '<td data-num="' + (c.avg_cost_krw || 0) + '">' + money(c.avg_cost_krw || 0) + '</td>' +
          '<td data-num="' + (c.avg_latency_ms || 0) + '">' + Math.round(c.avg_latency_ms || 0) + ' ms</td>' +
          '<td>' + (c.thumbs_up ? '👍' + c.thumbs_up + ' ' : '') + (c.thumbs_down ? '👎' + c.thumbs_down : '') + '</td>' +
        '</tr>').join('') + '</tbody></table></details>'
      ) : '';
      return recTable + matrix +
        '<div class="muted" style="padding:0 14px 12px; font-size:12px">최근 7일 chat 호출의 (작업유형 × 복잡도 × 모델)별 성공률·비용·피드백을 학습한 결과입니다. 성공 = 2xx · 오류 없음 · 폴백 없음. 작업유형은 프롬프트 키워드 기반 추정치입니다. "규칙으로 적용"은 해당 <strong>복잡도 구간 전체</strong>를 추천 모델로 라우팅하는 규칙을 만듭니다(작업유형은 참고용).</div>';
    }
    window.applyLearnedRule = async (bucket, model, taskType) => {
      const range = { low: [0, 33], medium: [34, 66], high: [67, 100] }[bucket] || [0, 100];
      if (!confirm('복잡도 ' + range[0] + '–' + range[1] + ' 구간을 ' + model + ' 로 라우팅하는 규칙을 만듭니다.\n(작업유형 "' + (wfTaskLabel[taskType] || taskType) + '" 학습 추천 기반 · 구간 전체에 적용)')) return;
      await api('/admin/routing-rules', { method: 'POST', body: JSON.stringify({ match_pattern: '*', min_complexity: range[0], max_complexity: range[1], target_model: model, priority: 90, note: '학습추천: ' + taskType + '/' + bucket }) });
      route();
    };
    function knowledgePanel(snippets) {
      const form =
        '<form class="inline-form" id="knowledge-form" style="grid-template-columns: minmax(120px,1fr) 140px minmax(220px,2fr) 70px; align-items:start;">' +
          '<input id="kb-name" placeholder="이름 (예: 사내 코딩 규칙)" required>' +
          '<input id="kb-id" placeholder="ID(slug, 비우면 자동)">' +
          '<textarea id="kb-content" rows="3" placeholder="규칙/시스템 프롬프트 본문" required style="resize:vertical"></textarea>' +
          '<button type="submit">등록</button>' +
        '</form>';
      const table = snippets.length ?
        '<table><thead><tr><th>이름 / ID</th><th data-sort="num">토큰</th><th data-sort="num">사용 횟수</th><th data-sort="str">최근 사용</th><th>참조</th><th>상태</th><th>동작</th></tr></thead><tbody>' +
        snippets.map(k => '<tr>' +
          '<td><strong>' + escapeHTML(k.name) + '</strong><div class="muted">' + escapeHTML(k.id) + '</div></td>' +
          '<td data-num="' + (k.token_estimate || 0) + '">' + fmt(k.token_estimate || 0) + '</td>' +
          '<td data-num="' + (k.use_count || 0) + '">' + fmt(k.use_count || 0) + '</td>' +
          '<td>' + (k.last_used_at ? ago(k.last_used_at) : '<span class="muted">미사용</span>') + '</td>' +
          '<td><code>{{kb:' + escapeHTML(k.id) + '}}</code></td>' +
          '<td><span class="status ' + (k.enabled ? '' : 'error') + '">' + (k.enabled ? '사용' : '중지') + '</span></td>' +
          '<td><button class="secondary" type="button" onclick="toggleKnowledge(\'' + escapeAttr(k.id) + '\',' + (!k.enabled) + ')">' + (k.enabled ? '중지' : '사용') + '</button> ' +
          '<button class="danger" type="button" onclick="deleteKnowledge(\'' + escapeAttr(k.id) + '\')">삭제</button></td>' +
        '</tr>').join('') + '</tbody></table>'
        : '<div class="empty">등록된 지식 없음.</div>';
      return form + table +
        '<div class="muted" style="font-size:12px; padding:0 14px 12px">반복되는 규칙/시스템 프롬프트를 한 번 등록하면, 클라이언트는 본문 대신 <code>{{kb:ID}}</code> 참조만 보내거나 <code>X-Vibe-Knowledge: ID1,ID2</code> 헤더를 붙이면 됩니다. 게이트웨이가 업스트림 전송 시 전체 텍스트로 확장합니다(응답 헤더 <code>X-Knowledge-Expanded</code>로 확인). 규칙을 한 곳에서 고치면 모든 호출에 즉시 반영되고, 클라이언트 페이로드·로그 저장이 줄어듭니다. 업스트림 토큰 비용은 provider 프리픽스 캐싱(cached 토큰)과 결합될 때 절감됩니다.</div>';
    }
    async function addKnowledge(e) {
      e.preventDefault();
      const body = {
        name: document.getElementById('kb-name').value.trim(),
        id: document.getElementById('kb-id').value.trim(),
        content: document.getElementById('kb-content').value,
      };
      if (!body.name || !body.content.trim()) { alert('이름과 본문을 입력하세요'); return; }
      await api('/admin/knowledge', { method: 'POST', body: JSON.stringify(body) });
      route();
    }
    window.toggleKnowledge = async (id, enabled) => {
      await api('/admin/knowledge/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify({ enabled }) });
      route();
    };
    window.deleteKnowledge = async (id) => {
      if (!confirm('이 지식 항목을 삭제하시겠습니까? 이 ID를 참조하는 호출은 더 이상 확장되지 않습니다.')) return;
      await api('/admin/knowledge/' + encodeURIComponent(id), { method: 'DELETE' });
      route();
    };
    async function addRoutingRule(e) {
      e.preventDefault();
      const body = {
        priority: Number(document.getElementById('rr-priority').value || 100),
        match_pattern: document.getElementById('rr-pattern').value.trim() || '*',
        min_complexity: Number(document.getElementById('rr-min').value || 0),
        max_complexity: Number(document.getElementById('rr-max').value || 100),
        target_model: document.getElementById('rr-target').value.trim(),
        target_provider: document.getElementById('rr-provider').value.trim(),
        note: document.getElementById('rr-note').value.trim(),
        enabled: true,
      };
      await api('/admin/routing-rules', { method: 'POST', body: JSON.stringify(body) });
      route();
    }
    window.toggleRoutingRule = async (id, enabled) => {
      await api('/admin/routing-rules/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify({ enabled }) });
      route();
    };
    window.deleteRoutingRule = async (id) => {
      if (!confirm('이 라우팅 규칙을 삭제하시겠습니까?')) return;
      await api('/admin/routing-rules/' + encodeURIComponent(id), { method: 'DELETE' });
      route();
    };

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
      document.getElementById('key-secret-input').value = '';
      const refreshed = await api('/admin/api-keys');
      const list = document.getElementById('api-key-list');
      if (list) {
        list.innerHTML = apiKeyTable(refreshed.api_keys || []);
        makeSortable('#api-key-list', 'settings-keys');
      }
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
    const tabMap = { d: 'dashboard', x: 'xview', w: 'waterfall', l: 'llm', c: 'mcp', e: 'agents', v: 'vcs', r: 'requests', p: 'prompts', u: 'users', m: 'teams', i: 'ips', q: 'quotas', a: 'safety', s: 'settings' };
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
        ['<kbd>g</kbd> <kbd>x</kbd>', 'XView (응답시간 분포)'],
        ['<kbd>g</kbd> <kbd>w</kbd>', 'Waterfall (트랜잭션 타임라인)'],
        ['<kbd>g</kbd> <kbd>l</kbd>', 'LLM 관측'],
        ['<kbd>g</kbd> <kbd>c</kbd>', 'MCP'],
        ['<kbd>g</kbd> <kbd>e</kbd>', '에이전트 성능'],
        ['<kbd>g</kbd> <kbd>v</kbd>', 'VCS 상관'],
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

    initAuth();
  </script>
</body>
</html>`
