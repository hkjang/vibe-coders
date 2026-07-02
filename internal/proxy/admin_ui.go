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
    /* Grouped top-nav dropdowns. JS adds a small hover-intent delay; CSS keeps a fallback. */
    .nav-group { position: relative; }
    .nav-group::after {
      content: ""; display: none; position: absolute; left: -10px; right: -10px;
      top: 100%; height: 14px; z-index: 4;
    }
    .nav-group > .nav-group-toggle {
      color: var(--muted); padding: 8px 12px; border-radius: 6px; font-weight: 700;
      background: none; border: none; cursor: pointer; font: inherit;
    }
    .nav-group.active > .nav-group-toggle { background: var(--ink); color: var(--bg); }
    .nav-group-menu {
      display: none; position: absolute; top: 100%; left: 0; z-index: 5; min-width: 180px;
      background: var(--panel); border: 1px solid var(--line); border-radius: 8px;
      padding: 4px; margin-top: 6px; box-shadow: 0 6px 24px rgba(0,0,0,.18);
    }
    .nav-group:hover::after, .nav-group:focus-within::after, .nav-group.nav-open::after, .nav-group.nav-closing::after { display: block; }
    .nav-group:hover > .nav-group-menu,
    .nav-group:focus-within > .nav-group-menu,
    .nav-group.nav-open > .nav-group-menu,
    .nav-group.nav-closing > .nav-group-menu { display: block; }
    .nav-group-menu a { display: block; white-space: nowrap; }
    #subtabs:empty { display: none; }
    .subtabs {
      display: flex; gap: 4px; flex-wrap: wrap;
      margin: 4px 0 2px; padding-bottom: 8px;
      border-bottom: 1px solid var(--line);
    }
    .subtabs a {
      text-decoration: none; color: var(--muted);
      padding: 6px 14px; border-radius: 6px 6px 0 0; font-weight: 700; font-size: 14px;
    }
    .subtabs a:hover { background: var(--line); }
    .subtabs a.active { background: var(--ink); color: var(--bg); }
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
    /* Indented content body for panels whose content would otherwise sit flush to the section edge. */
    .card-body { padding: 14px; overflow-x: auto; }
    .card-body > table:first-child, .card-body > :first-child { margin-top: 0; }
    input, button, select, textarea {
      height: 34px; border: 1px solid var(--line); border-radius: 6px;
      background: var(--panel); color: var(--ink); padding: 0 10px; font: inherit;
    }
    input::placeholder, textarea::placeholder { color: var(--muted); }
    input { min-width: 140px; }
    input[type="checkbox"], input[type="radio"] {
      height: auto; width: auto; min-width: 0; padding: 0; margin: 0 4px 0 0;
      vertical-align: middle; accent-color: var(--accent);
    }
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
    .stepper { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 8px; padding: 12px; border-bottom: 1px solid var(--line); }
    .stepper .step { border: 1px solid var(--line); border-radius: 8px; padding: 10px; background: var(--panel-alt); min-height: 74px; }
    .stepper .step strong { display: block; font-size: 12px; margin-bottom: 4px; }
    .stepper .step .muted { font-size: 12px; line-height: 1.35; }
    .stepper .step.ready { border-color: var(--good-ink); background: var(--good-bg); }
    .stepper .step.warn { border-color: var(--warn); background: var(--warn-bg); }
    .stepper .step.blocked { border-color: var(--bad); background: var(--bad-bg); }
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
    .modal.modal-wide { width: min(1280px, 100%); }
    .modal header { position: sticky; top: 0; }
    .modal .body { padding: 18px; }
    .modal h3 { margin: 0 0 4px; }

    /* Chat-test result popup: conversation pane on the left, debug rail on the right. */
    .chat-pop { display: grid; grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr); gap: 0; }
    .chat-pop > .chat-stream { display: flex; flex-direction: column; border-right: 1px solid var(--line); min-height: 320px; }
    .chat-pop > .chat-debug { padding: 4px 0 4px 18px; }
    .chat-messages { flex: 1; overflow-y: auto; padding: 4px 18px 8px 0; }
    .ct-input-row { display: flex; gap: 8px; align-items: flex-end; padding: 10px 18px 10px 0; border-top: 1px solid var(--line); background: var(--panel-alt); flex-shrink: 0; }
    .ct-followup-ta { flex: 1; resize: none; min-width: 0; box-sizing: border-box; height: 58px; }
    .ct-input-row button { height: 58px; flex-shrink: 0; }
    .chat-debug h4 { margin: 16px 0 8px; font-size: 12px; color: var(--muted); font-weight: 800; text-transform: uppercase; letter-spacing: 0.04em; }
    .chat-debug h4:first-child { margin-top: 0; }
    .chat-msg { margin: 0 0 14px; }
    .chat-msg .who { font-size: 11px; font-weight: 800; color: var(--muted); margin-bottom: 5px; letter-spacing: 0.03em; }
    .chat-bubble {
      padding: 12px 14px; border-radius: 12px; border: 1px solid var(--line);
      background: var(--panel-alt); line-height: 1.6; overflow-wrap: anywhere;
    }
    .chat-msg.user .chat-bubble { background: rgba(110,168,254,0.10); border-color: rgba(110,168,254,0.4); border-top-left-radius: 4px; }
    .chat-msg.assistant .chat-bubble { background: var(--panel-alt); border-top-left-radius: 4px; }
    .chat-msg.assistant.error .chat-bubble { background: var(--bad-bg); border-color: var(--bad); }
    .chat-debug pre {
      white-space: pre-wrap; margin: 0; padding: 12px; border-radius: 6px;
      background: var(--panel-alt); border: 1px solid var(--line);
      font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12px;
      max-height: 320px; overflow: auto;
    }
    .ct-caret { display: inline-block; margin-left: 1px; color: var(--accent); animation: ct-blink 1s steps(2, start) infinite; }
    @keyframes ct-blink { to { visibility: hidden; } }
    /* Chat test input form */
    .ct-form { display: flex; flex-direction: column; }
    .ct-group { padding: 14px 16px; border-bottom: 1px solid var(--line); }
    .ct-glabel { font-size: 11px; font-weight: 800; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 10px; }
    .ct-glabel-note { font-weight: 400; text-transform: none; letter-spacing: 0; font-size: 11px; margin-left: 8px; opacity: 0.8; }
    .ct-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; }
    .ct-row + .ct-row { margin-top: 10px; }
    .ct-field { display: flex; flex-direction: column; gap: 5px; }
    .ct-field > span { font-size: 12px; font-weight: 700; }
    .ct-field input, .ct-field select, .ct-field textarea { width: 100%; box-sizing: border-box; min-width: 0; }
    .ct-field-wide { display: flex; flex-direction: column; gap: 5px; margin-bottom: 10px; }
    .ct-field-wide > span { font-size: 12px; font-weight: 700; }
    .ct-field-wide input { width: 100%; box-sizing: border-box; min-width: 0; }
    .ct-target-detail { margin-top: 10px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; background: rgba(148,163,184,.08); }
    .ct-target-detail .kv { grid-template-columns: 130px 1fr; }
    .ct-prompt { width: 100%; box-sizing: border-box; min-width: 0; min-height: 150px; height: auto; resize: vertical; }
    .ct-footer { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; padding: 12px 16px; background: var(--panel-alt); }
    .ct-options { display: flex; gap: 14px; align-items: center; flex-wrap: wrap; }
    .ct-check { display: flex; align-items: center; gap: 6px; font-size: 13px; cursor: pointer; user-select: none; white-space: nowrap; }
    .ct-check input[type="checkbox"] { width: auto; height: auto; min-width: 0; margin: 0; }
    .ct-btns { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
    .kv { display: grid; grid-template-columns: 160px 1fr; gap: 6px 16px; }
    .kv .k { color: var(--muted); font-size: 12px; font-weight: 700; }
    .kv .v { overflow-wrap: anywhere; }
    .prompt-block {
      padding: 10px 12px; border: 1px solid var(--line); border-radius: 6px;
      background: var(--panel-alt); white-space: pre-wrap; font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
      font-size: 13px; overflow-wrap: anywhere;
    }
    .markdown-view {
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      font-size: 14px;
      line-height: 1.6;
      color: var(--text);
      white-space: normal !important;
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

    .user-menu-wrap { position: relative; display: inline-block; }
    #auth-user { cursor: pointer; }
    .user-menu {
      position: absolute; right: 0; top: 130%; z-index: 60;
      background: var(--panel); border: 1px solid var(--accent); border-radius: 8px;
      padding: 10px; min-width: 200px; display: flex; flex-direction: column; gap: 8px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.25);
    }
    .user-menu a { padding: 6px 8px; border-radius: 4px; color: var(--ink); text-decoration: none; }
    .user-menu a:hover { background: var(--panel-alt); }
    .user-menu .user-menu-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 13px; color: var(--muted); }
    .user-menu .user-menu-sep { height: 1px; background: var(--accent); opacity: 0.3; margin: 2px 0; }
    .user-menu .user-menu-meta { font-size: 11px; color: var(--muted); padding: 2px 8px; line-height: 1.4; }
    .user-menu button { width: 100%; text-align: left; }

    @media (max-width: 960px) {
      header { flex-direction: column; align-items: flex-start; gap: 8px; }
      main { padding: 14px; }
      .kpis, .grid3, .grid2 { grid-template-columns: 1fr; }
      .chat-pop { grid-template-columns: 1fr; }
      .chat-pop > .chat-stream { border-right: none; border-bottom: 1px solid var(--line); }
      .chat-pop > .chat-debug { padding: 14px 0 0; }
      .chat-messages { padding: 0 0 8px; }
      .ct-input-row { padding: 10px 0; }
    }
    /* Red Team sub-tabs — clear contrast in both inactive and active states. */
    .rt-tabbar { border-bottom: 2px solid var(--line-strong); margin-bottom: -2px; }
    .rt-tabbtn {
      font-size: 12px; font-weight: 700; padding: 8px 16px; cursor: pointer;
      border: 1px solid var(--line-strong); border-bottom: none;
      border-radius: 8px 8px 0 0; background: var(--pill-bg); color: var(--muted);
      transition: background .12s, color .12s;
    }
    .rt-tabbtn:hover { background: var(--row-hover); color: var(--ink); }
    .rt-tabbtn.active {
      background: var(--accent); color: #fff; border-color: var(--accent);
      box-shadow: 0 -2px 0 var(--accent) inset;
    }
    .rt-panel { background: var(--panel); }
    /* Red Team tables: let content size columns sensibly — long ids/hashes wrap instead of
       stretching a column, and the action column stays compact on one line. */
    .rt-panel table { width: 100%; table-layout: auto; }
    .rt-panel td code { word-break: break-all; font-size: 11px; }
    .rt-panel th { white-space: nowrap; }
    /* Red Team form fields: label on top, full-width control below. */
    .rt-form { gap: 12px 16px; margin-top: 12px; }
    .rt-form label {
      display: flex; flex-direction: column; gap: 5px;
      font-size: 12px; font-weight: 700; color: var(--muted);
    }
    .rt-form label input, .rt-form label select { width: 100%; height: 36px; min-width: 0; color: var(--ink); }
    .rt-form label .rt-hint { font-weight: 500; color: var(--muted); font-size: 11px; }
    .rt-field { display: flex; flex-direction: column; gap: 5px; }
    .rt-field .rt-fieldcap { font-size: 12px; font-weight: 700; color: var(--muted); }
    .rt-field .rt-hint { font-weight: 500; color: var(--muted); font-size: 11px; }
    .rt-modelbox { max-height: 120px; overflow: auto; border: 1px solid var(--line-strong); border-radius: 6px; padding: 6px; }
    .rt-modelbox label { display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 500; color: var(--ink); margin: 2px 0; }
    .rt-modelbox input[type="checkbox"] { width: 13px; height: 13px; margin: 0; flex: 0 0 auto; }
    .rt-modelbox .muted { color: var(--muted); }
  </style>
</head>
<body>
  <header>
    <h1>AI 게이트웨이</h1>
    <nav id="tabs">
      <a href="#/me" data-tab="me">내 홈</a>
      <div class="nav-group" id="nav-dashboards">
        <button type="button" class="nav-group-toggle" aria-haspopup="true">대시보드 ▾</button>
        <div class="nav-group-menu">
          <a href="#/dashboard" data-tab="dashboard" class="active">종합 대시보드</a>
          <a href="#/team" data-tab="team">팀 대시보드</a>
          <a href="#/team-portal" data-tab="team-portal">팀 포털</a>
          <a href="#/security" data-tab="security">보안 대시보드</a>
          <a href="#/billing" data-tab="billing">비용 대시보드</a>
          <a href="#/chargeback" data-tab="chargeback">비용 배부 팩</a>
          <a href="#/dwdashboard" data-tab="dwdashboard">DW 대시보드</a>
        </div>
      </div>
      <div class="nav-group" id="nav-observe">
        <button type="button" class="nav-group-toggle" aria-haspopup="true">관측 ▾</button>
        <div class="nav-group-menu">
          <a href="#/requests" data-tab="requests">호출 이력</a>
          <a href="#/sessions" data-tab="sessions">세션 비행기록</a>
          <a href="#/prompts" data-tab="prompts">프롬프트 검색</a>
          <a href="#/productivity" data-tab="productivity">AI 업무성과</a>
          <a href="#/scorecard" data-tab="scorecard">팀 성숙도</a>
          <a href="#/data-products" data-tab="data-products">데이터 상품</a>
        </div>
      </div>
      <div class="nav-group" id="nav-ops">
        <button type="button" class="nav-group-toggle" aria-haspopup="true">운영 ▾</button>
        <div class="nav-group-menu">
          <a href="#/ops-home" data-tab="ops-home">운영 홈</a>
          <a href="#/capabilities" data-tab="capabilities">기능 맵</a>
          <a href="#/mcp" data-tab="mcp">MCP</a>
          <a href="#/gateway-mcp" data-tab="gateway-mcp">Gateway MCP</a>
          <a href="#/routing" data-tab="routing">라우팅</a>
          <a href="#/workflows" data-tab="workflows">워크플로</a>
          <a href="#/apps" data-tab="apps">AI 업무 앱</a>
          <a href="#/app-templates" data-tab="app-templates">앱 템플릿</a>
          <a href="#/pods" data-tab="pods">파드 운영 맵</a>
          <a href="#/journey-probe" data-tab="journey-probe">Journey Probe</a>
        </div>
      </div>
      <div class="nav-group" id="nav-governance">
        <button type="button" class="nav-group-toggle" aria-haspopup="true">거버넌스 ▾</button>
        <div class="nav-group-menu">
          <a href="#/safety" data-tab="safety">안전</a>
          <a href="#/redteam" data-tab="redteam">Red Team</a>
          <a href="#/sbom" data-tab="sbom">AI 자산 SBOM</a>
          <a href="#/privacy-ledger" data-tab="privacy-ledger">프라이버시 원장</a>
          <a href="#/prompt-assets" data-tab="prompt-assets">자산 관리소</a>
          <a href="#/model-contracts" data-tab="model-contracts">모델 계약</a>
          <a href="#/policy-advisor" data-tab="policy-advisor">정책 어드바이저</a>
          <a href="#/remediation" data-tab="remediation">자동 조치</a>
        </div>
      </div>
      <a href="#/chat-test" data-tab="chat-test">Chat 테스트</a>
      <a href="#/text2sql" data-tab="text2sql">Text2SQL</a>
      <a href="#/users" data-tab="users">사용자</a>
      <a href="#/settings" data-tab="settings">설정</a>
    </nav>
    <div class="header-tools">
      <div class="user-menu-wrap">
        <span id="auth-user" class="user-chip" title="개인 메뉴 열기"></span>
        <div id="user-menu" class="user-menu" style="display:none">
          <a href="#/personalization" data-tab="personalization">개인화</a>
          <a href="#/mykeys" data-tab="mykeys">내 키</a>
          <button id="auth-logout" class="ghost" type="button" style="display:none" title="로그아웃">로그아웃</button>
          <div id="session-expiry" class="user-menu-meta" style="display:none"></div>
          <div class="user-menu-sep"></div>
          <label class="user-menu-row">자동 새로고침
            <select id="refresh-interval" title="자동 새로고침 주기">
              <option value="0">끔</option>
              <option value="5">5초</option>
              <option value="10">10초</option>
              <option value="30">30초</option>
              <option value="60">60초</option>
            </select>
          </label>
          <button id="theme-toggle" class="ghost" type="button" title="라이트/다크 전환 (t)">🌓 테마 전환</button>
          <button id="help-toggle" class="ghost" type="button" title="단축키 도움말 (?)">? 단축키 도움말</button>
          <div id="app-version" class="user-menu-meta">앱 버전 __APP_VERSION__</div>
          <div class="user-menu-sep"></div>
          <a href="/swagger" target="_blank" rel="noopener">📘 API 문서 (Swagger)</a>
          <a href="/openapi.json" target="_blank" rel="noopener">openapi.json 내려받기</a>
        </div>
      </div>
      <span id="ro-indicator" class="status warn" style="display:none" title="쓰기 권한이 없습니다 — 저장/삭제/변경은 서버에서 차단됩니다">읽기 전용</span>
      <input id="token" type="password" autocomplete="off" placeholder="관리자 토큰">
    </div>
  </header>
  <main>
    <div id="subtabs"></div>
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
          <button id="modal-back" type="button" class="secondary" style="display: none; height: 34px;">← 뒤로</button>
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
          chip.textContent = '☰ ' + loginId + ' · ' + (authState.user.role || '');
          chip.title = (authState.user.email || '') + ' · 클릭하면 개인 메뉴';
          logoutBtn.style.display = 'inline-block';
        } else {
          chip.style.display = 'inline-flex';
          chip.textContent = '☰ 메뉴';
          chip.title = '개인 메뉴 열기';
          logoutBtn.style.display = 'none';
        }
      } else {
        tokenInput.style.display = '';
        // Token mode has no user, but the chip stays as the menu trigger so theme /
        // refresh / help / 개인화 / 내 키 remain reachable.
        chip.style.display = 'inline-flex';
        chip.textContent = '☰ 메뉴';
        chip.title = '개인 메뉴 열기';
        logoutBtn.style.display = 'none';
      }
    }
    // updateMenuMeta fills the session-expiry line (below 로그아웃) from /auth/me. The app
    // version is injected server-side, so only expiry needs runtime data.
    function updateMenuMeta(me) {
      const exp = document.getElementById('session-expiry');
      if (!exp) return;
      if (me && me.expires_at) {
        const d = new Date(me.expires_at * 1000);
        const mins = Math.max(0, Math.round((d.getTime() - Date.now()) / 60000));
        exp.textContent = '세션 만료 예정: ' + d.toLocaleString() + ' (약 ' + mins + '분 후)';
        exp.style.display = 'block';
      } else {
        exp.style.display = 'none';
      }
    }
    function showLogin(message) {
      renderAuthHeader();
      const err = document.getElementById('login-error');
      if (message) { err.textContent = message; err.style.display = 'block'; }
      else { err.style.display = 'none'; }
      document.getElementById('login-backdrop').classList.add('open');
      setTimeout(() => document.getElementById('login-email').focus(), 50);
      maybeShowSSOButton();
    }
    // maybeShowSSOButton adds an "SSO 로그인" button to the login card when Keycloak is on.
    async function maybeShowSSOButton() {
      if (document.getElementById('sso-login-btn')) return;
      let st;
      try { st = await (await fetch('/auth/sso/status')).json(); } catch { return; }
      if (!st || !st.keycloak_enabled) return;
      const form = document.getElementById('login-form');
      if (!form) return;
      const btn = document.createElement('button');
      btn.id = 'sso-login-btn'; btn.type = 'button'; btn.textContent = 'SSO 로그인 (Keycloak)';
      btn.style.cssText = 'margin-top:8px;width:100%';
      btn.onclick = () => { location.href = st.login_url || '/auth/keycloak/login'; };
      form.appendChild(btn);
      if (st.allow_local_login === false) {
        // SSO-only: hide local email/password inputs.
        ['login-email', 'login-password', 'login-submit'].forEach(id => {
          const el = document.getElementById(id);
          if (el) { const lbl = el.closest('label'); (lbl || el).style.display = 'none'; }
        });
      }
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
        location.hash = ''; // let bootAfterAuth route to the role's default home
        await bootAfterAuth(null);
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
    // loadNavigation fetches the server-computed accessible menu set and stores it. The
    // SPA renders only these menus and guards routes against allowed_tabs — the same
    // policy the server applies — so a hidden menu can never be reached by URL.
    async function loadNavigation() {
      try {
        authState.nav = await api('/me/navigation');
      } catch {
        authState.nav = null; // fall back to showing everything (legacy/no policy)
      }
      applyNavPermissions();
    }

    // applyNavPermissions hides nav anchors whose tab is not in the caller's allowed_tabs.
    function applyNavPermissions() {
      const nav = authState.nav;
      const allowed = nav && Array.isArray(nav.allowed_tabs) ? new Set(nav.allowed_tabs) : null;
      document.querySelectorAll('#tabs a[data-tab], #user-menu a[data-tab]').forEach(a => {
        const tab = a.getAttribute('data-tab');
        a.style.display = (!allowed || allowed.has(tab)) ? '' : 'none';
      });
      // Hide a grouped dropdown (e.g. 대시보드) entirely when the caller can see none of its children.
      document.querySelectorAll('#tabs .nav-group').forEach(g => {
        const anyVisible = Array.from(g.querySelectorAll('a[data-tab]')).some(a => a.style.display !== 'none');
        g.style.display = anyVisible ? '' : 'none';
      });
      // Read-only indicator: an operator (admin:read) without admin:write. Server enforces
      // the block; this is the visible signal so write actions are clearly unavailable.
      const ro = document.getElementById('ro-indicator');
      if (ro) {
        const scopes = (nav && Array.isArray(nav.scopes)) ? nav.scopes : null;
        const readonly = !!scopes && scopes.indexOf('admin:read') >= 0 && scopes.indexOf('admin:write') < 0;
        ro.style.display = readonly ? '' : 'none';
      }
    }

    // bootAfterAuth wires navigation + default-home routing once the session is known.
    async function bootAfterAuth(me) {
      renderAuthHeader();
      if (me) updateMenuMeta(me);
      await loadNavigation();
      // Default home: send the user to their role-appropriate landing if they arrived at
      // the app root (no explicit deep link).
      const atRoot = !location.hash || location.hash === '#' || location.hash === '#/';
      const home = (authState.nav && authState.nav.default_home) || '#/dashboard';
      if (atRoot && home !== '#/dashboard') {
        location.hash = home; // triggers hashchange → route()
        return;
      }
      route();
    }

    // captureSSOFragment reads tokens (or an error) left in the URL fragment by the Keycloak
    // callback redirect (#kc_access=…&kc_refresh=… or #kc_error=…), stores them, and cleans
    // the URL so tokens never linger in history.
    function captureSSOFragment() {
      const hash = location.hash || '';
      const m = hash.match(/[#&]kc_access=([^&]+).*?[#&]kc_refresh=([^&]+)/);
      const errM = hash.match(/[#&]kc_error=([^&]+)/);
      if (m) {
        saveAuth({ access_token: decodeURIComponent(m[1]), refresh_token: decodeURIComponent(m[2]) });
        authState.enabled = true;
        history.replaceState(null, '', location.pathname + location.search);
        return { ok: true };
      }
      if (errM) {
        history.replaceState(null, '', location.pathname + location.search);
        return { error: decodeURIComponent(errM[1]) };
      }
      return {};
    }

    async function initAuth() {
      const sso = captureSSOFragment();
      if (sso.error) { authState.enabled = true; renderAuthHeader(); showLogin('SSO 로그인 실패: ' + sso.error); return; }
      try {
        const h = authState.access ? { Authorization: 'Bearer ' + authState.access } : {};
        const res = await fetch('/auth/me', { headers: h });
        if (res.ok) {
          const me = await res.json();
          authState.enabled = !!me.auth_enabled;
          if (me.user) { authState.user = me.user; sessionStorage.setItem('authUser', JSON.stringify(me.user)); }
          await bootAfterAuth(me);
          return;
        }
        if (res.status === 401) { // 인증 모드인데 access 만료/없음 → 조용히 refresh 시도
          authState.enabled = true;
          if (await tryRefresh()) { await bootAfterAuth(null); return; }
          clearAuth();
          showLogin();
          return;
        }
      } catch {}
      // /auth/me 자체가 실패해도 화면은 띄움 (레거시 모드 가정)
      renderAuthHeader();
      await loadNavigation();
      route();
    }

    // ---------- modal ----------
    document.getElementById('modal-close').addEventListener('click', () => closeModal());
    document.getElementById('modal-back').addEventListener('click', () => modalBack());
    document.getElementById('modal-backdrop').addEventListener('click', (e) => {
      if (e.target.id === 'modal-backdrop') closeModal();
    });
    // Modal history stack: opening a modal while one is already open pushes the current
    // (possibly mutated) content so the "← 뒤로" button can return to it. Closing clears it.
    let modalStack = [];
    let currentModalState = null;

    function _applyModalState(state) {
      document.getElementById('modal-title').textContent = state.title;
      document.getElementById('modal-body').innerHTML = state.html;
      const modalEl = document.querySelector('#modal-backdrop .modal');
      if (modalEl) modalEl.classList.toggle('modal-wide', !!(state.opts && state.opts.wide));
      const btn = document.getElementById('modal-analyze');
      if (btn) {
        if (state.requestId) {
          btn.style.display = 'inline-block';
          const newBtn = btn.cloneNode(true);
          btn.parentNode.replaceChild(newBtn, btn);
          newBtn.addEventListener('click', () => runAIAnalysis(state.requestId));
        } else {
          btn.style.display = 'none';
        }
      }
      currentModalState = state;
      updateModalBack();
    }
    function updateModalBack() {
      const back = document.getElementById('modal-back');
      if (back) back.style.display = modalStack.length > 0 ? 'inline-block' : 'none';
    }
    function openModal(title, html, requestId, opts) {
      opts = opts || {};
      const backdrop = document.getElementById('modal-backdrop');
      // If a modal is already open, snapshot its live content (captures appended AI analysis, etc.)
      // onto the stack so we can restore it via the back button.
      if (backdrop.classList.contains('open') && currentModalState) {
        modalStack.push({
          title: document.getElementById('modal-title').textContent,
          html: document.getElementById('modal-body').innerHTML,
          requestId: currentModalState.requestId,
          opts: currentModalState.opts,
        });
      }
      _applyModalState({ title: title, html: html, requestId: requestId, opts: opts });
      backdrop.classList.add('open');
    }
    function modalBack() {
      if (modalStack.length === 0) return;
      _applyModalState(modalStack.pop());
    }
    function closeModal() {
      document.getElementById('modal-backdrop').classList.remove('open');
      modalStack = [];
      currentModalState = null;
      updateModalBack();
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
      const blocks = [];
      const bt = String.fromCharCode(96);
      const bt3 = bt + bt + bt;

      let html = escapeHTML(md);

      // 1. Code blocks
      const reBlock = new RegExp(bt3 + '([\\s\\S]*?)' + bt3, 'gm');
      html = html.replace(reBlock, (match, p1) => {
        const placeholder = '<!--CODEBLOCK_' + blocks.length + '-->';
        blocks.push('<pre class="prompt-block" style="background:var(--panel-alt); border:1px solid var(--line); font-family:ui-monospace, SFMono-Regular, Consolas, monospace; font-size:13px; padding:12px; margin:8px 0; overflow:auto; white-space:pre-wrap; border-radius:6px;">' + p1.trim() + '</pre>');
        return placeholder;
      });

      // 2. Inline code
      const reInline = new RegExp(bt + '([^' + bt + '\n]+)' + bt, 'g');
      html = html.replace(reInline, (match, p1) => {
        const placeholder = '<!--INLINECODE_' + blocks.length + '-->';
        blocks.push('<code style="background:var(--pill-bg); padding:2px 6px; border-radius:4px; font-family:ui-monospace, SFMono-Regular, Consolas, monospace; font-size:90%; font-weight:500;">' + p1 + '</code>');
        return placeholder;
      });

      // 2.5 Markdown Tables
      const lines = html.split('\n');
      const newLines = [];
      let i = 0;
      while (i < lines.length) {
        const line = lines[i];
        const nextLine = lines[i+1];

        const hasPipe = line.indexOf('|') !== -1;
        const nextHasPipe = nextLine && nextLine.indexOf('|') !== -1;

        if (hasPipe && nextHasPipe) {
          const sepLine = nextLine.trim();
          const isSeparator = /^\|?([\s:-]*\|)+[\s:-]*\|?$/.test(sepLine) && sepLine.indexOf('-') !== -1;

          if (isSeparator) {
            let headerLine = line;
            let sepParts = sepLine.split('|').map(s => s.trim());
            if (sepLine.startsWith('|')) sepParts.shift();
            if (sepLine.endsWith('|')) sepParts.pop();

            const aligns = sepParts.map(part => {
              const left = part.startsWith(':');
              const right = part.endsWith(':');
              if (left && right) return 'center';
              if (right) return 'right';
              return 'left';
            });

            let headerParts = headerLine.split('|').map(s => s.trim());
            if (headerLine.trim().startsWith('|')) headerParts.shift();
            if (headerLine.trim().endsWith('|')) headerParts.pop();

            let tableHtml = '<div style="overflow-x:auto; margin:16px 0;"><table style="border-collapse:collapse; width:100%; font-size:13.5px; border:1px solid var(--line);">';

            // headers rendering
            tableHtml += '<thead style="background:var(--panel-alt); font-weight:600;"><tr>';
            for (let c = 0; c < headerParts.length; c++) {
              const align = aligns[c] || 'left';
              tableHtml += '<th style="border:1px solid var(--line); padding:10px 12px; text-align:' + align + ';">' + headerParts[c] + '</th>';
            }
            tableHtml += '</tr></thead>';

            // body rendering
            tableHtml += '<tbody>';

            let j = i + 2;
            let rowIdx = 0;
            while (j < lines.length) {
              const rowLine = lines[j];
              if (!rowLine || rowLine.indexOf('|') === -1) {
                break;
              }

              let rowParts = rowLine.split('|').map(s => s.trim());
              if (rowLine.trim().startsWith('|')) rowParts.shift();
              if (rowLine.trim().endsWith('|')) rowParts.pop();

              const bgStyle = rowIdx % 2 === 1 ? 'background:var(--panel-alt);' : '';
              tableHtml += '<tr style="' + bgStyle + '">';
              for (let c = 0; c < headerParts.length; c++) {
                const align = aligns[c] || 'left';
                const cellVal = rowParts[c] !== undefined ? rowParts[c] : '';
                tableHtml += '<td style="border:1px solid var(--line); padding:8px 12px; text-align:' + align + ';">' + cellVal + '</td>';
              }
              tableHtml += '</tr>';

              j++;
              rowIdx++;
            }

            tableHtml += '</tbody></table></div>';

            const placeholder = '<!--TABLE_' + blocks.length + '-->';
            blocks.push(tableHtml);

            newLines.push(placeholder);
            i = j;
            continue;
          }
        }

        newLines.push(line);
        i++;
      }
      html = newLines.join('\n');

      // 3. Bold
      html = html.replace(/\*\*([^*]+)\*\*/g, '<strong style="font-weight:700;">$1</strong>');

      // 4. Italic
      html = html.replace(/\*([^*]+)\*/g, '<em style="font-style:italic;">$1</em>');

      // 5. Headings
      html = html.replace(/^### (.*?)$/gm, '<h5 style="margin:16px 0 8px; font-size:14px; font-weight:700;">$1</h5>');
      html = html.replace(/^## (.*?)$/gm, '<h4 style="margin:20px 0 10px; font-size:16px; font-weight:700; border-bottom:1px solid var(--line); padding-bottom:4px;">$1</h4>');
      html = html.replace(/^# (.*?)$/gm, '<h3 style="margin:24px 0 12px; font-size:18px; font-weight:800; border-bottom:2px solid var(--line); padding-bottom:6px;">$1</h3>');

      // 6. Bullet lists
      html = html.replace(/^\s*[-*]\s+(.*?)$/gm, '<li style="margin-left:20px; margin-top:6px; margin-bottom:6px; line-height:1.6; list-style-type:disc;">$1</li>');

      // 7. Blockquotes
      html = html.replace(/^\>\s+(.*?)$/gm, '<blockquote style="border-left:4px solid var(--primary, #0f766e); padding-left:12px; color:var(--muted); margin:8px 0; font-style:italic;">$1</blockquote>');

      // 8. Line breaks
      html = html.replace(/\n/g, '<br>');

      // 9. Restore code blocks
      for (let i = 0; i < blocks.length; i++) {
        html = html.replace('<!--CODEBLOCK_' + i + '-->', blocks[i]);
        html = html.replace('<!--INLINECODE_' + i + '-->', blocks[i]);
        html = html.replace('<!--TABLE_' + i + '-->', blocks[i]);
      }

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
      // Reflect active state on grouped dropdowns (e.g. 대시보드) when one of their children is active.
      document.querySelectorAll('#tabs .nav-group').forEach(g => {
        g.classList.toggle('active', !!g.querySelector('a.active'));
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
    // subNav renders a secondary tab bar (used for tabs that nest sub-views).
    function subNav(items) {
      return '<nav class="subtabs">' + items.map(it =>
        '<a href="' + it.href + '"' + (it.active ? ' class="active"' : '') + '>' + escapeHTML(it.label) + '</a>'
      ).join('') + '</nav>';
    }
    // renderSubTabs populates the #subtabs strip for tabs that have nested sub-views, and
    // clears it otherwise. navTab maps nested routes (clickhouse, runtimesettings) to their
    // parent so the top-level nav stays highlighted.
    function renderSubTabs(tab, rest) {
      const el = document.getElementById('subtabs');
      if (tab === 'dashboard' || tab === 'xview' || tab === 'waterfall' || tab === 'llm') {
        el.innerHTML = subNav([
          { label: '대시보드', href: '#/dashboard', active: tab === 'dashboard' },
          { label: 'XView', href: '#/xview', active: tab === 'xview' },
          { label: 'Waterfall', href: '#/waterfall', active: tab === 'waterfall' },
          { label: 'LLM 관측', href: '#/llm', active: tab === 'llm' },
        ]);
      } else if (tab === 'dwdashboard' || tab === 'clickhouse' || tab === 'dwmetrics') {
        const onCH = tab === 'clickhouse' || rest[0] === 'clickhouse';
        const onMetrics = tab === 'dwmetrics' || rest[0] === 'metrics';
        el.innerHTML = subNav([
          { label: 'DW 대시보드', href: '#/dwdashboard', active: !onCH && !onMetrics },
          { label: 'ClickHouse', href: '#/dwdashboard/clickhouse', active: onCH },
          { label: '지표 사전', href: '#/dwmetrics', active: onMetrics },
        ]);
      } else if (tab === 'settings' || tab === 'runtimesettings' || tab === 'changesets' || rest[0] === 'errors' || rest[0] === 'sso' || rest[0] === 'changesets') {
        const onRT = tab === 'runtimesettings' || rest[0] === 'runtime';
        const onErr = rest[0] === 'errors';
        const onSSO = rest[0] === 'sso';
        const onCS = tab === 'changesets' || rest[0] === 'changesets';
        el.innerHTML = subNav([
          { label: '설정', href: '#/settings', active: !onRT && !onErr && !onSSO && !onCS },
          { label: '런타임 설정', href: '#/settings/runtime', active: onRT },
          { label: '변경 세트', href: '#/changesets', active: onCS },
          { label: 'SSO', href: '#/settings/sso', active: onSSO },
          { label: '시스템 오류', href: '#/settings/errors', active: onErr },
        ]);
      } else if (tab === 'users' || tab === 'teams' || tab === 'ips' || tab === 'quotas') {
        el.innerHTML = subNav([
          { label: '사용자', href: '#/users', active: tab === 'users' },
          { label: '팀', href: '#/teams', active: tab === 'teams' },
          { label: 'IP', href: '#/ips', active: tab === 'ips' },
          { label: '사용 한도', href: '#/quotas', active: tab === 'quotas' },
        ]);
      } else if (tab === 'safety' || tab === 'skills' || tab === 'skill-studio' || tab === 'modeldeprecations') {
        el.innerHTML = subNav([
          { label: '안전', href: '#/safety', active: tab === 'safety' },
          { label: 'Skills', href: '#/skills', active: tab === 'skills' },
          { label: 'Skill Studio', href: '#/skill-studio', active: tab === 'skill-studio' },
          { label: '모델 일몰', href: '#/modeldeprecations', active: tab === 'modeldeprecations' },
        ]);
      } else if (tab === 'mcp' || tab === 'agents' || tab === 'vcs') {
        el.innerHTML = subNav([
          { label: 'MCP', href: '#/mcp', active: tab === 'mcp' },
          { label: '에이전트', href: '#/agents', active: tab === 'agents' },
          { label: 'VCS', href: '#/vcs', active: tab === 'vcs' },
        ]);
      } else if (tab === 'chat-test' || tab === 'prompt-lab') {
        el.innerHTML = subNav([
          { label: 'Chat 테스트', href: '#/chat-test', active: tab === 'chat-test' },
          { label: 'Prompt Lab', href: '#/prompt-lab', active: tab === 'prompt-lab' },
        ]);
      } else if (tab === 'routing') {
        const onHealth = rest[0] === 'health';
        el.innerHTML = subNav([
          { label: '라우팅 학습', href: '#/routing', active: !onHealth },
          { label: 'Provider Health', href: '#/routing/health', active: onHealth },
        ]);
      } else {
        el.innerHTML = '';
      }
    }

    async function route() {
      const { parts, params } = parseHash();
      const [tab, ...rest] = parts;
      // Nested sub-views keep their parent's top-level nav tab highlighted.
      const navParent = {
        xview: 'dashboard', waterfall: 'dashboard', llm: 'dashboard',
        teams: 'users', ips: 'users', quotas: 'users',
        skills: 'safety', 'skill-studio': 'safety', modeldeprecations: 'safety',
        agents: 'mcp', vcs: 'mcp',
        clickhouse: 'dwdashboard', dwmetrics: 'dwdashboard', runtimesettings: 'settings', changesets: 'settings',
        'prompt-lab': 'chat-test',
      };
      const navTab = navParent[tab] || tab;
      setActiveTab(navTab);
      renderSubTabs(tab, rest);
      // Route guard: the same allowed_tabs the server used to filter the menu also blocks
      // direct URL access. Resolve nested routes to their parent tab before checking.
      const navAllow = authState.nav && Array.isArray(authState.nav.allowed_tabs) ? new Set(authState.nav.allowed_tabs) : null;
      if (navAllow && tab && !navAllow.has(tab) && !navAllow.has(navTab)) {
        renderForbidden(tab);
        return;
      }
      try {
        switch (tab) {
          case 'me':        await renderMeHome(); break;
          case 'team':      await renderTeamHome(); break;
          case 'team-portal': await renderTeamPortal(); break;
          case 'data-products': await renderDataProducts(); break;
          case 'remediation': await renderRemediation(); break;
          case 'scorecard': await renderTeamScorecard(); break;
          case 'model-contracts': await renderModelContracts(); break;
          case 'policy-advisor': await renderPolicyAdvisor(); break;
          case 'narrative': await renderNarrativeReport(); break;
          case 'skill-graph': await renderSkillGraph(); break;
          case 'chargeback': await renderChargeback(); break;
          case 'prompt-debt': await renderPromptDebt(); break;
          case 'app-templates': await renderAppTemplates(); break;
          case 'gateway-mcp': await renderGatewayMCP(); break;
          case 'workflows': await renderWorkflows(); break;
          case 'sandbox': renderSandbox(); break;
          case 'security':  await renderSecurityHome(); break;
          case 'billing':   await renderBillingHome(); break;
          case 'ops-home': await renderOpsHome(); break;
          case 'capabilities': await renderCapabilities(); break;
          case 'dashboard': await renderDashboard(); break;
          case 'xview':     await renderXView(params); break;
          case 'waterfall': await renderWaterfall(params); break;
          case 'llm':       await renderLLMObservability(); break;
          case 'requests':  await renderRequestsView(params); break;
          case 'sessions':  await renderSessionsView(); break;
          case 'redteam':   await renderRedTeamView(); break;
          case 'sbom':      await renderSBOMView(); break;
          case 'journey-probe': await renderJourneyProbeView(); break;
          case 'pods':      await renderPodsView(); break;
          case 'privacy-ledger': await renderPrivacyLedgerView(); break;
          case 'productivity': await renderProductivityView(); break;
          case 'prompts':       await renderPromptsView(params); break;
          case 'prompt-assets': await renderPromptAssets(params); break;
          case 'apps': await renderWorkApps(params); break;
          case 'changesets': await renderChangeSets(params); break;
          case 'users':     rest.length ? await renderUserDetail(rest.join('/')) : await renderUsers(); break;
          case 'teams':     rest.length ? await renderTeamDetail(decodeURIComponent(rest.join('/'))) : await renderTeams(); break;
          case 'ips':       rest.length ? await renderIPDetail(decodeURIComponent(rest.join('/'))) : await renderIPs(); break;
          case 'quotas':    await renderQuotas(); break;
          case 'mcp':       await renderMCP(params); break;
          case 'routing':   rest[0] === 'health' ? await renderRoutingHealth(params) : await renderRoutingLearning(params); break;
          case 'chat-test': await renderChatTest(params); break;
          case 'prompt-lab': await renderPromptLab(params); break;
          case 'agents':    await renderAgents(params); break;
          case 'vcs':       await renderVCS(params); break;
          case 'safety':    await renderSafety(); break;
          case 'text2sql':  await renderText2SQL(); break;
          case 'skills':    await renderSkills(); break;
          case 'skill-studio': await renderSkillStudio(params); break;
          case 'modeldeprecations': await renderModelDeprecations(); break;
          case 'personalization': rest.length ? await renderPersonalProfileDetail(decodeURIComponent(rest.join('/'))) : await renderPersonalization(); break;
          case 'mykeys':    await renderMyKeys(); break;
          case 'dwdashboard': rest[0] === 'clickhouse' ? await renderClickHouse() : await renderDWDashboard(); break;
          case 'clickhouse': await renderClickHouse(); break; // legacy alias for #/dwdashboard/clickhouse
          case 'dwmetrics': await renderDWMetrics(); break;
          case 'runtimesettings': await renderRuntimeSettings(); break; // legacy alias for #/settings/runtime
          case 'settings':
            if (rest[0] === 'runtime') {
              await renderRuntimeSettings();
            } else if (rest[0] === 'errors') {
              await renderSystemErrors();
            } else if (rest[0] === 'sso') {
              await renderSSOSettings();
            } else {
              await renderSettings();
            }
            break;
          default: await renderDashboard();
        }
      } catch (err) {
        document.getElementById('view').innerHTML = '<div class="error-line">' + escapeHTML(err.message) + '</div>';
      }
    }
    window.addEventListener('hashchange', route);

    // ---------- nav dropdown hover intent ----------
    // Keep a grouped menu open briefly when the pointer crosses the gap between the parent
    // button and dropdown. This avoids accidental closes while preserving keyboard focus use.
    (function wireNavGroupHoverIntent() {
      const closeDelayMs = 350;
      const groups = Array.from(document.querySelectorAll('#tabs .nav-group'));
      const closeTimers = new WeakMap();

      function clearCloseTimer(g) {
        const t = closeTimers.get(g);
        if (t) clearTimeout(t);
        closeTimers.delete(g);
      }
      function blurFocusedDescendant(g) {
        const af = document.activeElement;
        if (af && g.contains(af) && typeof af.blur === 'function') af.blur();
      }
      function openGroup(g) {
        clearCloseTimer(g);
        g.classList.remove('nav-closing');
        g.classList.add('nav-open');
      }
      function closeGroup(g) {
        clearCloseTimer(g);
        g.classList.remove('nav-open', 'nav-closing');
        blurFocusedDescendant(g);
      }
      function scheduleClose(g) {
        clearCloseTimer(g);
        g.classList.remove('nav-open');
        g.classList.add('nav-closing');
        closeTimers.set(g, setTimeout(() => closeGroup(g), closeDelayMs));
      }
      function closeOtherGroups(active) {
        groups.forEach(g => { if (g !== active) closeGroup(g); });
      }

      groups.forEach(g => {
        g.addEventListener('mouseenter', () => {
          closeOtherGroups(g);
          openGroup(g);
        });
        g.addEventListener('focusin', () => {
          closeOtherGroups(g);
          openGroup(g);
        });
        g.addEventListener('mouseleave', () => {
          scheduleClose(g);
        });
        g.addEventListener('focusout', () => {
          setTimeout(() => {
            if (!g.contains(document.activeElement) && !g.matches(':hover')) scheduleClose(g);
          }, 0);
        });
        g.querySelectorAll('.nav-group-toggle').forEach(btn => {
          btn.addEventListener('click', () => {
            if (g.classList.contains('nav-open')) {
              closeGroup(g);
            } else {
              closeOtherGroups(g);
              openGroup(g);
            }
          });
        });
        g.querySelectorAll('a[data-tab]').forEach(a => {
          a.addEventListener('click', () => { setTimeout(() => closeGroup(g), 0); });
        });
      });
    })();

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

    // ---------- user menu (auth-user dropdown) ----------
    (function () {
      const chip = document.getElementById('auth-user');
      const menu = document.getElementById('user-menu');
      if (!chip || !menu) return;
      const closeMenu = () => { menu.style.display = 'none'; };
      chip.addEventListener('click', (e) => {
        e.stopPropagation();
        menu.style.display = (menu.style.display === 'none' || !menu.style.display) ? 'flex' : 'none';
      });
      // Clicking a nav link inside the menu navigates and closes it.
      menu.querySelectorAll('a').forEach(a => a.addEventListener('click', closeMenu));
      // Click outside or Esc closes the menu (theme/refresh/help controls keep it open).
      document.addEventListener('click', (e) => {
        if (menu.style.display !== 'none' && !menu.contains(e.target) && e.target !== chip) closeMenu();
      });
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
    })();

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
      window:   sessionStorage.getItem('xviewWindow')    || '1h',
      scale:    sessionStorage.getItem('xviewScale')     || 'log',
      metric:   sessionStorage.getItem('xviewMetric')    || 'latency',
      viewMode: sessionStorage.getItem('xviewViewMode')  || 'category', // 'category' | 'model'
    };
    // per-model palette — up to 10 distinct colors
    const MODEL_PALETTE = ['#3b82f6','#f97316','#22c55e','#a855f7','#eab308','#ec4899','#06b6d4','#ef4444','#84cc16','#8b5cf6'];
    function modelColor(model, modelIndex) {
      return MODEL_PALETTE[modelIndex % MODEL_PALETTE.length];
    }
    function xviewCategory(p) {
      // priority: error > governance > cache > failover > high-cost > normal
      if (p.status_code >= 400) return 'error';
      if (p.policy_decision_count || p.approval_count || p.secret_event_count) return 'governance';
      if (p.provider === 'cache') return 'cache';
      if (p.failover) return 'failover';
      if ((p.risk_score || 0) >= 60) return 'complex';
      if ((p.total_tokens || 0) >= xviewState.complexityTokens) return 'complex';
      return 'normal';
    }
    const xviewColors = {
      error:      { c: '#ef4444', label: '오류' },
      governance: { c: '#f97316', label: '거버넌스' },
      cache:      { c: '#22c55e', label: '캐시 히트' },
      failover:   { c: '#eab308', label: '폴백' },
      complex:    { c: '#a855f7', label: '고비용/복잡' },
      normal:     { c: '#3b82f6', label: '정상' },
    };
    // yField helper for metric switch (latency/first_chunk/tokens/cost/risk/health)
    function xviewYField(metric) {
      switch (metric) {
        case 'first_chunk': return 'first_chunk_ms';
        case 'tokens':      return 'total_tokens';
        case 'cost':        return 'cost_krw';
        case 'risk':        return 'risk_score';
        case 'health':      return 'health_score';
        default:            return 'latency_ms';
      }
    }
    function xviewYLabel(metric) {
      switch (metric) {
        case 'first_chunk': return '첫 청크 지연(ms)';
        case 'tokens':      return '토큰 수';
        case 'cost':        return '비용(KRW)';
        case 'risk':        return '위험 점수';
        case 'health':      return '헬스 점수';
        default:            return '응답시간(ms)';
      }
    }
    function xviewFmtY(metric, v) {
      switch (metric) {
        case 'first_chunk': return msLabel(v);
        case 'tokens':      return fmt(v);
        case 'cost':        return money(v);
        case 'risk':
        case 'health':      return String(v);
        default:            return msLabel(v);
      }
    }

    async function renderXView(initial) {
      if (initial) {
        if (initial.get('window'))   xviewState.window   = initial.get('window');
        if (initial.get('metric'))   xviewState.metric   = initial.get('metric');
        if (initial.get('viewMode')) xviewState.viewMode = initial.get('viewMode');
      }
      const params = new URLSearchParams();
      params.set('window', xviewState.window);
      // multi-model: ?models= takes precedence; fall back to legacy ?model=
      const modelsParam = initial ? (initial.get('models') || '') : '';
      const singleModel = initial ? (initial.get('model') || '') : '';
      const endpoint = initial ? (initial.get('endpoint') || '') : '';
      if (modelsParam)    params.set('models', modelsParam);
      else if (singleModel) params.set('model', singleModel);
      if (endpoint) params.set('endpoint', endpoint);
      params.set('include_summary', 'true');
      params.set('group_by', 'model');
      params.set('limit', '6000');

      const data = await api('/admin/scatter?' + params.toString());
      const points = data.points || [];
      const groups = data.groups || [];
      // complexity threshold = 90th percentile of tokens (so "high" is relative), min 4000
      const tokenVals = points.map(p => p.total_tokens || 0).filter(v => v > 0).sort((a, b) => a - b);
      xviewState.complexityTokens = Math.max(4000, tokenVals.length ? tokenVals[Math.floor(tokenVals.length * 0.9)] : 4000);

      // build model → index map for stable coloring
      const modelIndex = {};
      groups.forEach((g, i) => { modelIndex[g.model] = i; });

      const view = document.getElementById('view');
      view.innerHTML = section('XView — 모델별 호출 분석',
        '<div class="toolbar">' +
          '<select id="xv-window">' +
            ['5m','15m','1h','6h','24h'].map(wd => '<option value="' + wd + '"' + (xviewState.window === wd ? ' selected' : '') + '>' + wd + '</option>').join('') +
          '</select>' +
          '<select id="xv-metric">' +
            '<option value="latency"'     + (xviewState.metric === 'latency'      ? ' selected' : '') + '>응답시간</option>' +
            '<option value="first_chunk"' + (xviewState.metric === 'first_chunk'  ? ' selected' : '') + '>첫 청크 지연</option>' +
            '<option value="tokens"'      + (xviewState.metric === 'tokens'       ? ' selected' : '') + '>토큰 수</option>' +
            '<option value="cost"'        + (xviewState.metric === 'cost'         ? ' selected' : '') + '>비용</option>' +
            '<option value="risk"'        + (xviewState.metric === 'risk'         ? ' selected' : '') + '>위험 점수</option>' +
            '<option value="health"'      + (xviewState.metric === 'health'       ? ' selected' : '') + '>헬스 점수</option>' +
          '</select>' +
          '<select id="xv-scale">' +
            '<option value="log"'    + (xviewState.scale === 'log'    ? ' selected' : '') + '>로그 스케일</option>' +
            '<option value="linear"' + (xviewState.scale === 'linear' ? ' selected' : '') + '>선형 스케일</option>' +
          '</select>' +
          '<select id="xv-viewmode">' +
            '<option value="category"' + (xviewState.viewMode === 'category' ? ' selected' : '') + '>카테고리별 색상</option>' +
            '<option value="model"'    + (xviewState.viewMode === 'model'    ? ' selected' : '') + '>모델별 색상</option>' +
          '</select>' +
          '<input id="xv-models" placeholder="모델 필터 (콤마 구분)" style="min-width:180px" value="' + escapeHTML(modelsParam || singleModel) + '">' +
          '<input id="xv-endpoint" placeholder="endpoint 필터" value="' + escapeHTML(endpoint) + '">' +
          '<button id="xv-apply" type="submit">적용</button>' +
          '<span class="muted">' + fmt(points.length) + '건' + (data.truncated ? ' (최근 6000건으로 제한됨)' : '') + '</span>' +
        '</div>' +
        '<div id="xv-chart" style="padding:14px"></div>' +
        '<div id="xv-legend" style="padding:0 14px 14px"></div>' +
        '<div id="xv-model-table" style="padding:0 14px 14px"></div>'
      );
      drawScatter(points, groups, modelIndex);
      renderModelGroupTable(groups);

      const apply = () => {
        xviewState.window   = document.getElementById('xv-window').value;
        xviewState.metric   = document.getElementById('xv-metric').value;
        xviewState.scale    = document.getElementById('xv-scale').value;
        xviewState.viewMode = document.getElementById('xv-viewmode').value;
        sessionStorage.setItem('xviewWindow',   xviewState.window);
        sessionStorage.setItem('xviewMetric',   xviewState.metric);
        sessionStorage.setItem('xviewScale',    xviewState.scale);
        sessionStorage.setItem('xviewViewMode', xviewState.viewMode);
        const p = new URLSearchParams();
        p.set('window',   xviewState.window);
        p.set('metric',   xviewState.metric);
        p.set('viewMode', xviewState.viewMode);
        const ms = document.getElementById('xv-models').value.trim();
        const e  = document.getElementById('xv-endpoint').value.trim();
        if (ms) p.set('models', ms);
        if (e)  p.set('endpoint', e);
        location.hash = '#/xview?' + p.toString();
      };
      document.getElementById('xv-apply').addEventListener('click', apply);
      ['xv-window', 'xv-metric', 'xv-scale', 'xv-viewmode'].forEach(id =>
        document.getElementById(id).addEventListener('change', apply));
    }

    function drawScatter(points, groups, modelIndex) {
      const host = document.getElementById('xv-chart');
      if (!points.length) { host.innerHTML = '<div class="empty">해당 구간에 요청 없음</div>'; return; }
      const yField   = xviewYField(xviewState.metric);
      const useModelColor = xviewState.viewMode === 'model';
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

      // y gridlines
      const yTicks = logScale
        ? [1, 10, 100, 500, 1000, 2000, 5000, 10000, 30000].filter(v => v <= yMax * 1.2)
        : [0, yMax * 0.25, yMax * 0.5, yMax * 0.75, yMax];
      const grid = yTicks.map(v => {
        const y = yPos(v);
        return '<line x1="' + padL + '" y1="' + y.toFixed(1) + '" x2="' + (W - padR) + '" y2="' + y.toFixed(1) + '" stroke="var(--line)" stroke-dasharray="2 3"/>' +
          '<text x="' + (padL - 6) + '" y="' + (y + 3).toFixed(1) + '" text-anchor="end" font-size="10" fill="currentColor" opacity="0.6">' + xviewFmtY(xviewState.metric, v) + '</text>';
      }).join('');

      // x time labels
      const xLabels = [0, 0.25, 0.5, 0.75, 1].map(f => {
        const t = tMin + tSpan * f, x = xPos(t);
        const d = new Date(t);
        const hh = String(d.getHours()).padStart(2, '0'), mm = String(d.getMinutes()).padStart(2, '0'), ss = String(d.getSeconds()).padStart(2, '0');
        return '<text x="' + x.toFixed(1) + '" y="' + (H - 10) + '" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.6">' + hh + ':' + mm + ':' + ss + '</text>';
      }).join('');

      // percentile reference lines
      const sorted = points.map(p => p[yField] || 0).sort((a, b) => a - b);
      const pctAt = q => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q))];
      const p50 = pctAt(0.5), p95 = pctAt(0.95), p99 = pctAt(0.99);
      const pctLine = (v, label, color) => {
        const y = yPos(v);
        return '<line x1="' + padL + '" y1="' + y.toFixed(1) + '" x2="' + (W - padR) + '" y2="' + y.toFixed(1) + '" stroke="' + color + '" stroke-width="1" stroke-opacity="0.7"/>' +
          '<text x="' + (W - padR) + '" y="' + (y - 3).toFixed(1) + '" text-anchor="end" font-size="10" fill="' + color + '">' + label + ' ' + xviewFmtY(xviewState.metric, v) + '</text>';
      };

      // dots — colored by model or category, with outlier ring
      const dots = points.map(p => {
        const cat = xviewCategory(p);
        let col;
        if (useModelColor) {
          const idx = modelIndex != null ? (modelIndex[p.model] !== undefined ? modelIndex[p.model] : Object.keys(modelIndex).length) : 0;
          col = MODEL_PALETTE[idx % MODEL_PALETTE.length];
        } else {
          col = xviewColors[cat].c;
        }
        const t = Date.parse(p.created_at);
        if (isNaN(t)) return '';
        const cx = xPos(t).toFixed(1), cy = yPos(p[yField] || 0).toFixed(1);
        const isAnomaly = cat === 'error' || cat === 'failover' || p.policy_decision_count > 0;
        const gov = (p.policy_decision_count || p.approval_count || p.secret_event_count)
          ? ' · policy ' + fmt(p.policy_decision_count || 0) + (p.policy_decision ? '(' + p.policy_decision + ')' : '') +
            ' · approval ' + fmt(p.approval_count || 0) + (p.approval_status ? '(' + p.approval_status + ')' : '') +
            ' · secret ' + fmt(p.secret_event_count || 0) + (p.secret_action ? '(' + p.secret_action + ')' : '')
          : '';
        const tip = (p.model || '?') + ' · ' + (p.provider || '?') + ' · ' + xviewFmtY(xviewState.metric, p[yField] || 0) +
          ' · complexity ' + fmt(p.complexity || 0) + ' · risk ' + fmt(p.risk_score || 0) +
          ' · health ' + fmt(p.health_score || 0) + ' · ' + fmt(p.total_tokens) + 'tok · ' + money(p.cost_krw) + ' · HTTP ' + (p.status_code) +
          gov + ' · ' + new Date(t).toLocaleTimeString('ko-KR');
        // anomaly outer ring for errors/failovers/governance
        const ring = isAnomaly
          ? '<circle cx="' + cx + '" cy="' + cy + '" r="5.5" fill="none" stroke="' + col + '" stroke-width="1.5" stroke-opacity="0.55"/>'
          : '';
        return ring + '<circle class="xv-dot" data-rid="' + escapeHTML(p.request_id) + '" cx="' + cx + '" cy="' + cy + '" r="3.2" fill="' + col + '" fill-opacity="0.72" stroke="' + col + '" stroke-opacity="0.9"><title>' + escapeHTML(tip) + '</title></circle>';
      }).join('');

      host.innerHTML = '<svg id="xv-svg" viewBox="0 0 ' + W + ' ' + H + '" width="100%" height="' + H + '" style="color:var(--ink); cursor:crosshair; user-select:none">' +
        grid +
        '<line x1="' + padL + '" y1="' + (padT + innerH) + '" x2="' + (W - padR) + '" y2="' + (padT + innerH) + '" stroke="var(--line-strong)"/>' +
        '<line x1="' + padL + '" y1="' + padT + '" x2="' + padL + '" y2="' + (padT + innerH) + '" stroke="var(--line-strong)"/>' +
        pctLine(p99, 'P99', 'var(--bad)') + pctLine(p95, 'P95', 'var(--warn)') + pctLine(p50, 'P50', 'var(--muted)') +
        dots + xLabels +
        '<rect id="xv-sel-rect" x="0" y="0" width="0" height="0" fill="var(--accent)" fill-opacity="0.1" stroke="var(--accent)" stroke-width="1" stroke-dasharray="4 2" style="display:none" pointer-events="none"/>' +
        '</svg>';

      // legend — model-color mode or category mode
      const legendEl = document.getElementById('xv-legend');
      if (useModelColor && groups && groups.length) {
        legendEl.innerHTML =
          '<div style="display:flex; gap:14px; flex-wrap:wrap; align-items:center">' +
          groups.map((g, i) =>
            '<span style="display:inline-flex; align-items:center; gap:5px">' +
            '<span style="width:10px;height:10px;border-radius:50%;background:' + MODEL_PALETTE[i % MODEL_PALETTE.length] + '"></span>' +
            escapeHTML(g.model) + ' <span class="muted">' + fmt(g.count) + '건</span></span>'
          ).join('') +
          '<span class="muted" style="margin-left:auto">점을 클릭하면 요청 상세 · 가로=시간 / 세로=' + xviewYLabel(xviewState.metric) + ' · ○링=이상 항목</span>' +
          '</div>';
      } else {
        const counts = { error: 0, governance: 0, cache: 0, failover: 0, complex: 0, normal: 0 };
        points.forEach(p => counts[xviewCategory(p)]++);
        legendEl.innerHTML =
          '<div style="display:flex; gap:16px; flex-wrap:wrap; align-items:center">' +
          Object.keys(xviewColors).map(k =>
            '<span style="display:inline-flex; align-items:center; gap:6px">' +
            '<span style="width:10px;height:10px;border-radius:50%;background:' + xviewColors[k].c + '"></span>' +
            xviewColors[k].label + ' <span class="muted">' + fmt(counts[k]) + '</span></span>'
          ).join('') +
          '<span class="muted" style="margin-left:auto">점을 클릭하면 요청 상세 · 가로=시간 / 세로=' + xviewYLabel(xviewState.metric) + ' · ○링=이상 항목</span>' +
          '</div>';
      }

      // single-dot click → explainability panel
      host.querySelectorAll('.xv-dot').forEach(dot => {
        dot.addEventListener('click', () => {
          if (xvDragJustFired) return; // drag just ended on this dot — skip click
          openExplain(dot.getAttribute('data-rid'));
        });
      });
      // drag-to-select: starts on empty canvas space, not on a dot
      bindXVDragSelect(points);
    }

    // Per-model summary table (sortable) below scatter
    function renderModelGroupTable(groups) {
      const el = document.getElementById('xv-model-table');
      if (!groups || !groups.length) { el.innerHTML = ''; return; }
      let sortKey = 'count', sortDir = -1;
      const render = () => {
        const sorted = [...groups].sort((a, b) => {
          const va = a[sortKey] !== undefined ? a[sortKey] : 0;
          const vb = b[sortKey] !== undefined ? b[sortKey] : 0;
          return sortDir * (va < vb ? -1 : va > vb ? 1 : 0);
        });
        const cols = [
          { key: 'model',            label: '모델' },
          { key: 'count',            label: '건수' },
          { key: 'error_rate',       label: '오류율' },
          { key: 'p50',              label: 'P50(ms)' },
          { key: 'p95',              label: 'P95(ms)' },
          { key: 'p99',              label: 'P99(ms)' },
          { key: 'avg_first_chunk_ms', label: '첫청크(ms)' },
          { key: 'total_tokens',     label: '토큰합' },
          { key: 'total_cost_krw',   label: '비용합(KRW)' },
          { key: 'avg_cost_krw',     label: '평균비용' },
          { key: 'failover_count',   label: '폴백' },
          { key: 'governance_count', label: '거버넌스' },
          { key: 'risk_p95',         label: '위험P95' },
          { key: 'health_avg',       label: '헬스평균' },
        ];
        const thStyle = 'cursor:pointer; user-select:none; white-space:nowrap;';
        el.innerHTML = '<h3 style="margin:12px 0 8px">모델별 요약</h3>' +
          '<table id="xv-gtable"><thead><tr>' +
          cols.map(c => '<th style="' + thStyle + '" data-k="' + c.key + '">' + c.label + (sortKey === c.key ? (sortDir > 0 ? ' ▲' : ' ▼') : '') + '</th>').join('') +
          '</tr></thead><tbody>' +
          sorted.map((g, gi) => {
            const idx = groups.findIndex(x => x.model === g.model);
            const dot = '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + MODEL_PALETTE[(idx >= 0 ? idx : gi) % MODEL_PALETTE.length] + ';margin-right:6px"></span>';
            return '<tr>' +
              '<td>' + dot + escapeHTML(g.model) + '</td>' +
              '<td data-num="' + g.count + '">' + fmt(g.count) + '</td>' +
              '<td data-num="' + g.error_rate + '">' + pct(g.error_rate) + '</td>' +
              '<td data-num="' + g.p50 + '">' + msLabel(g.p50) + '</td>' +
              '<td data-num="' + g.p95 + '">' + msLabel(g.p95) + '</td>' +
              '<td data-num="' + g.p99 + '">' + msLabel(g.p99) + '</td>' +
              '<td data-num="' + g.avg_first_chunk_ms + '">' + msLabel(Math.round(g.avg_first_chunk_ms)) + '</td>' +
              '<td data-num="' + g.total_tokens + '">' + fmt(g.total_tokens) + '</td>' +
              '<td data-num="' + g.total_cost_krw + '">' + money(g.total_cost_krw) + '</td>' +
              '<td data-num="' + g.avg_cost_krw + '">' + money(g.avg_cost_krw) + '</td>' +
              '<td data-num="' + g.failover_count + '">' + fmt(g.failover_count) + '</td>' +
              '<td data-num="' + g.governance_count + '">' + fmt(g.governance_count) + '</td>' +
              '<td data-num="' + g.risk_p95 + '">' + fmt(Math.round(g.risk_p95)) + '</td>' +
              '<td data-num="' + g.health_avg + '">' + fmt(Math.round(g.health_avg)) + '</td>' +
            '</tr>';
          }).join('') +
          '</tbody></table>';
        el.querySelectorAll('#xv-gtable th').forEach(th => {
          th.addEventListener('click', () => {
            const k = th.getAttribute('data-k');
            if (sortKey === k) sortDir *= -1; else { sortKey = k; sortDir = -1; }
            render();
          });
        });
      };
      render();
    }

    // ---------- XView drag-to-select ----------
    // Flag to suppress a dot's click event if a drag just completed over it.
    let xvDragJustFired = false;

    function bindXVDragSelect(points) {
      const svg = document.getElementById('xv-svg');
      if (!svg) return;

      const ridMap = {};
      points.forEach(p => { ridMap[p.request_id] = p; });

      let dragStart = null, isDragging = false;
      const selRect = document.getElementById('xv-sel-rect');

      function toSVG(e) {
        const pt = svg.createSVGPoint();
        pt.x = e.clientX;
        pt.y = e.clientY;
        const svgPt = pt.matrixTransform(svg.getScreenCTM().inverse());
        return { x: svgPt.x, y: svgPt.y };
      }

      function onMove(e) {
        if (!dragStart) return;
        const cur = toSVG(e);
        if (!isDragging && Math.hypot(cur.x - dragStart.x, cur.y - dragStart.y) < 4) return;
        isDragging = true;
        const rx = Math.min(dragStart.x, cur.x), ry = Math.min(dragStart.y, cur.y);
        selRect.setAttribute('x', rx);
        selRect.setAttribute('y', ry);
        selRect.setAttribute('width',  Math.abs(cur.x - dragStart.x));
        selRect.setAttribute('height', Math.abs(cur.y - dragStart.y));
        selRect.style.display = '';
      }

      function onUp(e) {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup',   onUp);
        const end   = toSVG(e);
        const start = dragStart;
        dragStart = null;
        selRect.style.display = 'none';
        if (!isDragging) return;
        isDragging = false;

        const x1 = Math.min(start.x, end.x), x2 = Math.max(start.x, end.x);
        const y1 = Math.min(start.y, end.y), y2 = Math.max(start.y, end.y);
        if (x2 - x1 < 2 && y2 - y1 < 2) return;

        const selected = [];
        svg.querySelectorAll('.xv-dot').forEach(dot => {
          const cx = parseFloat(dot.getAttribute('cx'));
          const cy = parseFloat(dot.getAttribute('cy'));
          if (cx >= x1 && cx <= x2 && cy >= y1 && cy <= y2) {
            selected.push(dot.getAttribute('data-rid'));
          }
        });

        if (!selected.length) return;

        // Single point — open explain directly.
        if (selected.length === 1) {
          xvDragJustFired = true;
          setTimeout(() => { xvDragJustFired = false; }, 0);
          openExplain(selected[0]);
          return;
        }

        // Multiple points — open selection list in modal.
        openXVSelectionModal(selected, ridMap);
      }

      svg.addEventListener('mousedown', e => {
        if (e.button !== 0) return;
        if (e.target.classList.contains('xv-dot')) return;
        dragStart  = toSVG(e);
        isDragging = false;
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup',   onUp);
      });
    }

    async function openXVSelectionModal(rids, ridMap) {
      const title = '선택된 요청 ' + fmt(rids.length) + '개';
      openModal(title, '<div class="empty">요청 미리보기를 불러오는 중...</div>');
      let reqMap = {};
      try {
        const ids = rids.slice(0, 200);
        const data = await api('/admin/requests?ids=' + encodeURIComponent(ids.join(',')) + '&limit=' + ids.length);
        (data.requests || []).forEach(r => { reqMap[r.id] = r; });
      } catch (err) {
        reqMap = {};
      }
      openModal(title, buildXVSelectionHTML(rids, ridMap, reqMap));
    }

    function buildXVSelectionHTML(rids, ridMap, reqMap) {
      const yField = xviewYField(xviewState.metric);
      const rows = rids.slice(0, 200).map(rid => {
        const p  = ridMap[rid] || {};
        const rq = (reqMap && reqMap[rid]) || {};
        const lastUser = lastUserMessageSnippet(rq, 30);
        const t  = Date.parse(p.created_at);
        const ts = isNaN(t) ? '' : new Date(t).toLocaleTimeString('ko-KR');
        const sc = p.status_code || 0;
        const badges =
          (sc >= 400                          ? '<span class="badge bad"  style="margin-left:4px">' + sc + '</span>' : '') +
          (p.failover                         ? '<span class="badge warn" style="margin-left:4px">폴백</span>' : '') +
          ((p.policy_decision_count || 0) > 0 ? '<span class="badge"      style="margin-left:4px">거버넌스</span>' : '');
        return '<tr>' +
          '<td>' + escapeHTML(p.model || '?') + badges + '</td>' +
          '<td title="' + escapeAttr(lastUserMessageText(rq)) + '">' + (lastUser ? escapeHTML(lastUser) : '<span class="muted">-</span>') + '</td>' +
          '<td>' + xviewFmtY(xviewState.metric, p[yField] || 0) + '</td>' +
          '<td>' + escapeHTML(p.provider || '') + '</td>' +
          '<td class="muted">' + ts + '</td>' +
          '<td><button class="secondary" type="button" onclick="openRequestDetail(\'' + escapeAttr(rid) + '\')">요청 상세</button></td>' +
          '<td><button class="secondary" type="button" onclick="openExplain(\'' + escapeAttr(rid) + '\')">XView 설명</button></td>' +
        '</tr>';
      }).join('');
      const overflow = rids.length > 200
        ? '<div class="muted" style="margin-top:8px">+' + fmt(rids.length - 200) + '개 더 선택됨 (목록은 200개로 제한)</div>'
        : '';
      return '<p class="muted" style="margin:0 0 10px">각 항목의 XView 설명 버튼을 클릭하면 처리 근거를 확인합니다.</p>' +
        '<div style="overflow-x:auto">' +
        '<table style="font-size:13px"><thead><tr>' +
          '<th>모델</th>' +
          '<th>마지막 메시지</th>' +
          '<th>' + xviewYLabel(xviewState.metric) + '</th>' +
          '<th>provider</th>' +
          '<th>시간</th>' +
          '<th>요청 상세</th>' +
          '<th>설명</th>' +
        '</tr></thead><tbody>' + rows + '</tbody></table>' +
        '</div>' + overflow;
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
      const rt = x.routing || {}, fb = x.fallback || {}, ca = x.cache || {}, sf = x.safety || {}, gv = x.governance || {}, t2s = x.text2sql || {}, co = x.cost || {}, se = x.session || {};
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
      const text2sql = (t2s.spans || []).length ? (
        '<div class="kv">' +
          row('상태', '<span class="status ' + governanceStatusClass(t2s.status || '') + '">' + escapeHTML(t2s.status || '') + '</span>') +
          row('단계 수', fmt(t2s.span_count || (t2s.spans || []).length)) +
          row('Span latency 합계', fmt(t2s.total_latency_ms || 0) + ' ms') +
          row('Span cost 합계', money(t2s.total_cost_krw || 0)) +
        '</div>' + text2SQLSpanTable(t2s.spans || [])
      ) : '<div class="muted">Text2SQL span 없음. 일반 LLM 요청이거나 span 저장 전 로그입니다.</div>';

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
        explainPanel('Text2SQL Timeline', text2sql, 'var(--accent)') +
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
    function text2SQLSpanTable(spans) {
      spans = spans || [];
      if (!spans.length) return '<div class="muted">Text2SQL span 없음</div>';
      return '<table style="margin-top:12px"><thead><tr><th>#</th><th>Stage</th><th>Status</th><th>Latency</th><th>Cost</th><th>Hashes</th><th>Detail</th></tr></thead><tbody>' +
        spans.map((s, idx) => '<tr>' +
          '<td data-num="' + idx + '">' + (idx + 1) + '</td>' +
          '<td><strong>' + escapeHTML(s.stage || '') + '</strong><div class="muted">' + escapeHTML(s.model || '') + '</div></td>' +
          '<td><span class="status ' + governanceStatusClass(s.status || '') + '">' + escapeHTML(s.status || '') + '</span>' + (s.reject_reason ? '<div class="muted">' + escapeHTML(s.reject_reason) + '</div>' : '') + '</td>' +
          '<td data-num="' + Number(s.latency_ms || 0) + '">' + fmt(s.latency_ms || 0) + ' ms</td>' +
          '<td data-num="' + Number(s.cost_krw || 0) + '">' + money(s.cost_krw || 0) + '</td>' +
          '<td><code style="font-size:11px">' + escapeHTML(s.input_hash || '') + '</code><div class="muted"><code>' + escapeHTML(s.output_hash || '') + '</code></div></td>' +
          '<td><pre class="prompt-block" style="max-height:120px;overflow:auto;margin:0">' + escapeHTML(prettyJSON(s.detail || '')) + '</pre></td>' +
        '</tr>').join('') + '</tbody></table>';
    }
    function traceLinksHTML(requestID, links) {
      if (!links) return '';
      const c = links.counts || {};
      const hasMCP = !!((links.artifacts || {}).mcp_waterfall);
      const hasT2S = !!((links.artifacts || {}).text2sql_spans);
      const sessionID = links.session_id || '';
      const chip = (label, value, warn) => '<span class="pill' + (warn ? ' warn' : '') + '">' + escapeHTML(label) + ' ' + fmt(value || 0) + '</span>';
      const buttons = [
        '<button class="secondary" type="button" onclick="closeModal();openExplain(\'' + escapeAttr(requestID) + '\')">XView</button>'
      ];
      if (sessionID) buttons.push('<button class="secondary" type="button" onclick="closeModal();openWaterfall(\'' + escapeAttr(sessionID) + '\')">Waterfall</button>');
      if (hasMCP) buttons.push('<button class="secondary" type="button" onclick="closeModal();openMCPRequestWaterfall(\'' + escapeAttr(requestID) + '\')">MCP Waterfall</button>');
      if (hasT2S) buttons.push('<button class="secondary" type="button" onclick="openT2SSpans(\'' + escapeAttr(requestID) + '\')">Text2SQL Timeline</button>');
      return '<div style="border:1px solid var(--line);border-radius:8px;padding:10px 12px;margin-bottom:12px">' +
        '<div style="display:flex;justify-content:space-between;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px">' +
          '<strong>Trace Links</strong><div style="display:flex;gap:6px;flex-wrap:wrap">' + buttons.join('') + '</div>' +
        '</div>' +
        '<div style="display:flex;gap:6px;flex-wrap:wrap">' +
          chip('tools', c.tools) +
          chip('mcp', c.mcp_tools) +
          chip('text2sql', c.text2sql_spans) +
          chip('policy', c.policy_decisions, (c.policy_decisions || 0) > 0) +
          chip('secret', c.secret_events, (c.secret_events || 0) > 0) +
          chip('approval', c.approvals, (c.approvals || 0) > 0) +
        '</div>' +
      '</div>';
    }
    // Gateway Flow Map — 한 요청의 단계별 처리 흐름(인증→한도→Skill→거버넌스→라우팅→캐시→MCP→Text2SQL→업스트림→DW).
    window.showFlowMap = async (id) => {
      try {
        const d = await api('/admin/flow-map?request_id=' + encodeURIComponent(id));
        const cls = (st) => st === 'ok' ? '' : (st === 'blocked' || st === 'error' ? 'error' : (st === 'fallback' || st === 'warn' ? 'warn' : 'muted'));
        const icon = (st) => ({ ok: '✅', blocked: '⛔', error: '🔥', fallback: '↩️', warn: '⚠️', skip: '➖' })[st] || '•';
        const label = { auth: '인증', quota: '한도/쿼터', skill: 'Skill', governance: '거버넌스', routing: '라우팅', cache: '캐시', mcp: 'MCP', text2sql: 'Text2SQL', upstream: '업스트림', dw: 'DW 적재' };
        const rows = (d.stages || []).map(st => {
          const arts = st.linked_artifacts ? Object.entries(st.linked_artifacts).map(([k, v]) => '<span class="muted" style="font-size:10px;margin-right:8px">' + escapeHTML(k) + '=' + escapeHTML(String(v)) + '</span>').join('') : '';
          return '<div style="display:flex;gap:10px;align-items:flex-start;border-left:3px solid var(--line);padding:8px 10px;margin:4px 0">' +
            '<div style="font-size:16px">' + icon(st.status) + '</div>' +
            '<div style="flex:1"><div><strong>' + escapeHTML(label[st.stage] || st.stage) + '</strong> <span class="status ' + cls(st.status) + '" style="font-size:9px">' + escapeHTML(st.status) + '</span>' +
            (st.latency_ms ? ' <span class="muted" style="font-size:10px">' + fmt(st.latency_ms) + 'ms</span>' : '') + '</div>' +
            (st.decision ? '<div style="font-size:12px">' + escapeHTML(st.decision) + '</div>' : '') +
            (st.reason ? '<div class="muted" style="font-size:11px">' + escapeHTML(st.reason) + '</div>' : '') +
            (arts ? '<div style="margin-top:2px">' + arts + '</div>' : '') +
            '</div></div>';
        }).join('');
        const sm = d.summary || {};
        openModal('처리 흐름 - ' + escapeHTML(sm.trace_id || id),
          '<div class="card-body"><div class="muted" style="font-size:12px;margin-bottom:8px">' + escapeHTML(sm.model || '') + ' · ' + escapeHTML(sm.provider || '') + ' · ' + (sm.status_code || 0) + ' · ' + fmt(sm.latency_ms || 0) + 'ms</div>' +
          rows + '<p class="muted" style="font-size:10px;margin-top:8px">' + escapeHTML(d.note || '') + '</p></div>');
      } catch (e) { openModal('오류', '<div class="error-line">' + escapeHTML(e.message) + '</div>'); }
    };
    // MCP Agentic Loop Timeline — 후보 도구 점수, 증거, tool 호출, evidence gate.
    window.showAgenticRun = async (id) => {
      try {
        const d = await api('/admin/mcp/agentic-runs?request_id=' + encodeURIComponent(id));
        if (!d.agentic) { openModal('MCP Agentic', '<div class="card-body"><p class="muted">' + escapeHTML(d.note || 'MCP agentic 기록 없음') + '</p></div>'); return; }
        const dec = d.decision || {};
        const bar = (score) => '<span style="display:inline-block;height:6px;width:' + Math.max(2, Math.min(100, score)) + 'px;background:#6ea8fe;border-radius:3px;vertical-align:middle"></span>';
        const cand = (d.candidate_scores || []).map(c => '<div style="font-size:12px">' + escapeHTML(c.tool) + ' ' + bar(c.score) + ' <span class="muted">' + (c.score || 0).toFixed(0) + '</span></div>').join('') || '<span class="muted" style="font-size:11px">없음</span>';
        const ev = (d.evidence_scores || []).map(e => '<div style="font-size:12px">' + (e.error ? '⚠️ ' : '') + escapeHTML(e.tool) + ' ' + bar(e.score) + ' <span class="muted">' + (e.score || 0).toFixed(0) + '</span></div>').join('') || '<span class="muted" style="font-size:11px">없음</span>';
        const tools = (d.tool_events || []).map(t => '<tr><td>' + escapeHTML(t.server) + '/' + escapeHTML(t.tool) + '</td><td>' + escapeHTML(t.source) + '</td><td>' + (t.is_error ? '<span class="status error">error</span>' : '<span class="status">ok</span>') + '</td><td class="muted" style="font-size:10px">' + escapeHTML(t.arg_hash || '') + '</td></tr>').join('');
        const routes = (d.route_decisions || []).map(rd => '<tr><td>' + escapeHTML(rd.exposed_name || rd.target || '') + '</td><td>' + escapeHTML(rd.risk_level || '') + '</td><td>' + escapeHTML(rd.risk_action || '') + '</td><td>' + escapeHTML(rd.final_decision || '') + '</td></tr>').join('');
        const gate = d.evidence_gate || {};
        openModal('MCP Agentic Loop - ' + escapeHTML(id),
          '<div class="card-body">' +
          '<div style="margin-bottom:8px"><strong>라우팅 결정</strong> <span class="status">' + escapeHTML(dec.route || '') + '</span> ' +
            '<span class="muted" style="font-size:12px">신뢰도 ' + (dec.confidence || 0).toFixed(0) + ' · 증거 ' + (dec.evidence_count || 0) + '건 · gate ' + (gate.passed ? '<span class="status">통과</span>' : '<span class="status warn">미통과</span>') + '</span></div>' +
          (dec.reason ? '<div class="muted" style="font-size:11px;margin-bottom:8px">' + escapeHTML(dec.reason) + '</div>' : '') +
          '<div style="display:flex;gap:20px;flex-wrap:wrap"><div style="flex:1;min-width:220px"><strong style="font-size:12px">후보 도구 점수 (selector)</strong>' + cand + '</div>' +
          '<div style="flex:1;min-width:220px"><strong style="font-size:12px">증거 점수 (evidence)</strong>' + ev + '</div></div>' +
          (tools ? '<div style="margin-top:10px"><strong style="font-size:12px">Tool 호출</strong><table><thead><tr><th>도구</th><th>단계</th><th>결과</th><th>arg hash</th></tr></thead><tbody>' + tools + '</tbody></table></div>' : '') +
          (routes ? '<div style="margin-top:10px"><strong style="font-size:12px">Tool 정책/위험</strong><table><thead><tr><th>도구</th><th>위험</th><th>조치</th><th>결정</th></tr></thead><tbody>' + routes + '</tbody></table></div>' : '') +
          '<p class="muted" style="font-size:10px;margin-top:8px">' + escapeHTML(d.note || '') + '</p></div>');
      } catch (e) { openModal('오류', '<div class="error-line">' + escapeHTML(e.message) + '</div>'); }
    };
    // traceWaterfallHTML renders the unified request waterfall (root + MCP/tool + Text2SQL spans).
    function traceWaterfallHTML(trace) {
      if (!trace || !Array.isArray(trace.spans) || trace.spans.length === 0) return '';
      const total = Math.max(1, trace.total_ms || 0);
      const kindColor = { request: 'var(--accent)', text2sql: '#6a1b9a', mcp_tool: '#1565c0', tool: '#2e7d32', cache: '#ef6c00' };
      const rows = trace.spans.map(sp => {
        const left = Math.min(99, (sp.start_offset_ms / total) * 100);
        const width = Math.max(1.5, ((sp.duration_ms || 0) / total) * 100);
        const color = kindColor[sp.kind] || 'var(--muted)';
        const err = sp.status === 'error';
        const meta = [];
        if (sp.duration_ms) meta.push(msLabel(sp.duration_ms));
        if (sp.tokens) meta.push(fmt(sp.tokens) + ' tok');
        if (sp.cost_krw) meta.push('₩' + fmt(Math.round(sp.cost_krw)));
        if (sp.cache_hit) meta.push('cache');
        return '<div style="display:flex;align-items:center;gap:8px;margin:2px 0">' +
          '<div style="width:160px;flex:none;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis"' + (err ? ' class="error-line"' : '') + ' title="' + escapeAttr(sp.name) + '">' +
          (err ? '⚠ ' : '') + escapeHTML(sp.name) + '</div>' +
          '<div style="position:relative;flex:1;height:16px;background:var(--line);border-radius:3px">' +
          '<div style="position:absolute;left:' + left + '%;width:' + width + '%;height:100%;background:' + (err ? 'var(--err,#c00)' : color) + ';border-radius:3px"></div></div>' +
          '<div style="width:150px;flex:none;font-size:10px;color:var(--muted);text-align:right">' + escapeHTML(meta.join(' · ')) + '</div>' +
        '</div>';
      }).join('');
      return '<section style="margin-bottom:12px"><h3 style="margin:0 0 6px;font-size:14px">Trace 타임라인 <span class="muted" style="font-weight:400;font-size:11px">' + escapeHTML(trace.trace_id || '') + ' · ' + msLabel(total) + ' · ' + trace.spans.length + ' spans</span></h3>' +
        '<div style="border:1px solid var(--border);border-radius:6px;padding:8px">' + rows + '</div></section>';
    }

    window.openRequestDetail = async (id) => {
      try {
        const [detail, note, links, trace] = await Promise.all([
          api('/admin/requests/' + encodeURIComponent(id)),
          api('/admin/requests/' + encodeURIComponent(id) + '/note').catch(() => ({ tags: [], note: '' })),
          api('/admin/requests/' + encodeURIComponent(id) + '/links').catch(() => null),
          api('/admin/requests/' + encodeURIComponent(id) + '/trace').catch(() => null),
        ]);
        openModal('요청 상세 - ' + (detail.request.trace_id || id), traceWaterfallHTML(trace) + requestDetailHTML(detail, note, links));
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

    // Agent Session Flight Recorder — 한 세션의 게이트웨이 활동을 시간순으로 재구성.
    window.openFlightRecorder = async (sessionID) => {
      try {
        const d = await api('/admin/sessions/' + encodeURIComponent(sessionID) + '/flight-recorder');
        const ro = d.rollup || {};
        const sm = d.summary || {};
        const vcls = sm.verdict === '위험' ? 'error' : (sm.verdict === '주의' ? 'warn' : '');
        const rcaHtml = sm.verdict ? ('<div class="card" style="margin-bottom:10px"><div class="card-body">' +
          '<div><strong>RCA 요약</strong> <span class="status ' + vcls + '">' + escapeHTML(sm.verdict) + '</span> <span class="muted">' + escapeHTML(sm.headline || '') + '</span></div>' +
          '<ul style="margin:6px 0 0 16px;font-size:12px">' + (sm.findings || []).map(f => '<li>' + escapeHTML(f) + '</li>').join('') + '</ul>' +
          '</div></div>') : '';
        const kindBadges = Object.entries(ro.kinds || {}).map(([k, n]) => '<span class="status" style="font-size:9px">' + escapeHTML(k) + ' ' + n + '</span>').join(' ');
        const rk = ro.risk || {};
        const riskBadges = [];
        if (rk.secret_requests) riskBadges.push('<span class="status error" style="font-size:9px">시크릿 ' + rk.secret_requests + '</span>');
        if (rk.policy_block_requests) riskBadges.push('<span class="status error" style="font-size:9px">정책 차단 ' + rk.policy_block_requests + '</span>');
        if (rk.high_risk_code_requests) riskBadges.push('<span class="status warn" style="font-size:9px">위험 코드 ' + rk.high_risk_code_requests + '</span>');
        const summary = '<div class="kv">' +
          row('세션', escapeHTML(d.session_id)) +
          row('요청 수', fmt(ro.requests || 0) + (ro.errors ? ' · <span class="status error">오류 ' + ro.errors + '</span>' : '')) +
          row('위험 신호', riskBadges.length ? riskBadges.join(' ') : '<span class="muted">없음</span>') +
          row('기간', escapeHTML((ro.started_at || '') + ' → ' + (ro.ended_at || ''))) +
          row('종류', kindBadges || '-') +
          row('모델', escapeHTML((ro.models || []).join(', ') || '-')) +
          row('provider', escapeHTML((ro.providers || []).join(', ') || '-')) +
          row('trace 수', fmt((ro.trace_ids || []).length)) +
          row('토큰/비용', fmt(ro.total_tokens || 0) + ' tok · ' + money(ro.total_cost || 0)) +
          row('도구 호출', fmt(ro.tool_calls || 0)) +
        '</div>';
        const rows = (d.events || []).map((e, i) => {
          const flags = [];
          if (e.secret_events) flags.push('<span class="status error" style="font-size:9px" title="시크릿 이벤트">🔑' + e.secret_events + '</span>');
          if (e.policy_blocks) flags.push('<span class="status error" style="font-size:9px" title="정책 차단">⛔' + e.policy_blocks + '</span>');
          if (e.code_risk) flags.push('<span class="status ' + (e.code_risk === 'high' ? 'error' : (e.code_risk === 'medium' ? 'warn' : '')) + '" style="font-size:9px" title="코드 위험">⚠' + escapeHTML(e.code_risk) + '</span>');
          return '<tr>' +
          '<td>' + (i + 1) + '</td>' +
          '<td>' + escapeHTML(e.created_at || '') + '</td>' +
          '<td><span class="status" style="font-size:9px">' + escapeHTML(e.kind || '') + '</span></td>' +
          '<td>' + escapeHTML(e.model || '') + '<div class="muted" style="font-size:10px">' + escapeHTML(e.provider || '') + '</div></td>' +
          '<td><span class="status ' + (e.is_error ? 'error' : '') + '">' + (e.status_code || 0) + '</span></td>' +
          '<td>' + fmt(e.latency_ms || 0) + ' ms</td>' +
          '<td>' + fmt(e.total_tokens || 0) + '<div class="muted" style="font-size:10px">' + money(e.cost_krw || 0) + '</div></td>' +
          '<td>' + fmt(e.tool_count || 0) + '</td>' +
          '<td>' + (flags.join(' ') || '-') + '</td>' +
          '<td><a href="#" onclick="closeModal();openRequestDetail(\'' + escapeAttr(e.request_id) + '\');return false">상세</a></td>' +
        '</tr>';
        }).join('') || '<tr><td colspan="10" class="muted">이벤트 없음</td></tr>';
        openModal('세션 비행기록 - ' + escapeHTML(sessionID),
          rcaHtml + summary +
          '<h3 style="margin-top:14px">타임라인 (' + (d.events || []).length + ')</h3>' +
          '<table><thead><tr><th>#</th><th>시각</th><th>종류</th><th>모델</th><th>상태</th><th>지연</th><th>토큰/비용</th><th>도구</th><th>위험</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>' +
          '<p class="muted" style="font-size:10px;margin-top:6px">' + escapeHTML(d.note || '') + '</p>');
      } catch (err) {
        openModal('오류', '<div class="error-line">' + escapeHTML(err.message) + '</div>');
      }
    };

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
        api('/admin/ops/risk').catch(() => null),
      ]);
      const modelQuality = await api('/admin/models/quality?window=30d').catch(() => ({ models: [] }));
      const costAnomalies = await api('/admin/cost/anomalies?window=6h&min_repeats=5').catch(() => null);
      const anomalies = (anomalyResp && anomalyResp.anomalies) || [];

      const html =
        section('요약', kpiBlock(stats)) +
        (ops ? section('운영 리스크 스코어 · 운영 상태', opsRiskHTML(ops.risk) + opsStatusHTML(ops.status || {})) : '') +
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
        section('모델별 코딩 품질 점수 (최근 30일)', modelQualityHTML(modelQuality.models || [])) +
        section('프로젝트별 비용 (최근 30일)', costAllocationPanel()) +
        (costAnomalies ? section('비용 이상탐지 (월말 예상 초과 · 세션 루프)', costAnomalyHTML(costAnomalies)) : '') +
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
      loadAllocation(allocDim);
      document.querySelectorAll('[data-alloc]').forEach(btn => {
        btn.addEventListener('click', () => loadAllocation(btn.dataset.alloc));
      });
    }

    let allocDim = sessionStorage.getItem('allocDim') || 'project';
    function costAllocationPanel() {
      const dims = [['project', '프로젝트'], ['repo', '저장소'], ['branch', '브랜치'], ['cost_center', '예산코드'], ['service', '서비스'], ['model', '모델']];
      const btns = dims.map(d => '<button type="button" class="' + (d[0] === allocDim ? '' : 'secondary') + '" data-alloc="' + d[0] + '">' + d[1] + '</button>').join('');
      return '<div class="toolbar">' + btns + '</div><div id="allocBody"><div class="empty">불러오는 중…</div></div>';
    }
    function allocationTable(rows) {
      if (!rows.length) return '<div class="empty">데이터 없음 — 클라이언트가 X-Vibe-Repo / X-Vibe-Project / X-Vibe-Cost-Center 헤더를 보내면 집계됩니다.</div>';
      const totalCost = rows.reduce((a, r) => a + (r.cost_krw || 0), 0) || 1;
      return '<table><thead><tr>' +
        '<th data-sort="str">구분</th><th data-sort="num">요청</th><th data-sort="num">토큰</th>' +
        '<th data-sort="num">비용</th><th data-sort="num">비중</th><th data-sort="num">오류</th></tr></thead><tbody>' +
        rows.map(r => {
          const pct = ((r.cost_krw || 0) / totalCost) * 100;
          return '<tr>' +
            '<td>' + escapeHTML(r.key) + '</td>' +
            '<td data-num="' + (r.requests || 0) + '">' + fmt(r.requests) + '</td>' +
            '<td data-num="' + (r.tokens || 0) + '">' + fmt(r.tokens) + '</td>' +
            '<td data-num="' + (r.cost_krw || 0) + '">' + money(r.cost_krw) + '</td>' +
            '<td data-num="' + pct.toFixed(1) + '">' + pct.toFixed(1) + '%</td>' +
            '<td data-num="' + (r.error_requests || 0) + '">' + fmt(r.error_requests) + '</td>' +
          '</tr>';
        }).join('') +
        '</tbody></table>';
    }
    async function loadAllocation(dim) {
      allocDim = dim;
      sessionStorage.setItem('allocDim', dim);
      const body = document.getElementById('allocBody');
      if (!body) return;
      const data = await api('/admin/cost/allocation?dimension=' + encodeURIComponent(dim) + '&window=30d').catch(() => null);
      body.innerHTML = allocationTable((data && data.rows) || []);
      document.querySelectorAll('[data-alloc]').forEach(b => b.classList.toggle('secondary', b.dataset.alloc !== dim));
      makeSortable('#allocBody', 'alloc');
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
    function opsRiskHTML(risk) {
      if (!risk) return '';
      const score = risk.score || 0;
      const tierColor = { low: 'var(--accent)', medium: 'var(--warn)', high: '#e8590c', critical: 'var(--bad)' }[risk.tier] || 'var(--muted)';
      const tierLabel = { low: '양호', medium: '주의', high: '높음', critical: '심각' }[risk.tier] || risk.tier;
      const factors = (risk.factors || []).map(f => {
        const sevColor = f.severity === 'critical' ? 'var(--bad)' : (f.severity === 'warning' ? 'var(--warn)' : 'var(--muted)');
        return '<li style="margin:4px 0"><span style="display:inline-block; min-width:34px; font-weight:800; color:' + sevColor + '">+' + f.points + '</span> ' + escapeHTML(f.message) + '</li>';
      }).join('');
      return '<div style="display:flex; gap:18px; align-items:center; padding:14px; flex-wrap:wrap">' +
        '<div style="text-align:center; min-width:120px">' +
          '<div style="font-size:42px; font-weight:800; line-height:1; color:' + tierColor + '">' + score + '</div>' +
          '<div style="margin-top:4px"><span class="status" style="background:' + tierColor + '; color:#fff">' + escapeHTML(tierLabel) + '</span></div>' +
          '<div class="muted" style="font-size:11px; margin-top:4px">/ 100 (높을수록 위험)</div>' +
        '</div>' +
        '<div style="flex:1; min-width:260px">' +
          (factors ? '<ul style="margin:0; padding-left:4px; list-style:none; font-size:13px">' + factors + '</ul>' : '<div class="muted">감지된 운영 리스크 없음 — 양호합니다.</div>') +
        '</div>' +
      '</div>';
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

    function costAnomalyHTML(data) {
      const over = data.over_projected || [];
      const loops = data.session_loops || [];
      const overTable = over.length ?
        '<table><thead><tr><th>예산 범위</th><th data-sort="num">현재 지출</th><th data-sort="num">월말 예상</th><th data-sort="num">예산</th><th data-sort="num">예상 초과율</th><th>소진 예정</th></tr></thead><tbody>' +
        over.map(st => {
          const b = st.budget || {};
          const ratio = ((st.projected_ratio || 0) * 100).toFixed(0);
          return '<tr>' +
            '<td>' + escapeHTML((b.scope || '') + ':' + (b.scope_value || '')) + '</td>' +
            '<td data-num="' + (st.spent_krw || 0) + '">' + money(st.spent_krw) + '</td>' +
            '<td data-num="' + (st.projected_krw || 0) + '">' + money(st.projected_krw) + '</td>' +
            '<td data-num="' + (b.monthly_krw || 0) + '">' + money(b.monthly_krw) + '</td>' +
            '<td data-num="' + (st.projected_ratio || 0) + '"><span class="status error">' + ratio + '%</span></td>' +
            '<td>' + escapeHTML(st.exhaustion_date || '—') + '</td>' +
          '</tr>';
        }).join('') + '</tbody></table>'
        : '<div class="empty">월말 예산 초과가 예상되는 범위 없음.</div>';
      const loopTable = loops.length ?
        '<table><thead><tr><th>세션</th><th>사용자</th><th data-sort="num">반복</th><th data-sort="num">비용</th><th data-sort="num">토큰</th></tr></thead><tbody>' +
        loops.map(l => '<tr>' +
          '<td><code>' + escapeHTML(l.session_id) + '</code></td>' +
          '<td>' + escapeHTML(l.api_key_id || '') + '</td>' +
          '<td data-num="' + (l.repeats || 0) + '"><span class="status warn">' + fmt(l.repeats) + '회</span></td>' +
          '<td data-num="' + (l.cost_krw || 0) + '">' + money(l.cost_krw) + '</td>' +
          '<td data-num="' + (l.tokens || 0) + '">' + fmt(l.tokens) + '</td>' +
        '</tr>').join('') + '</tbody></table>'
        : '<div class="empty">최근 6시간 비정상 세션 루프 없음.</div>';
      return '<div class="grid2">' +
        card('팀·범위별 월말 예상 초과', overTable) +
        card('비정상 세션 루프 (동일 프롬프트 5회+)', loopTable) +
      '</div>';
    }
    function accessClassLabel(cls) {
      return ({ read: '읽기', write: '쓰기', execute: '실행', network: '네트워크', secret: '시크릿' }[cls]) || (cls || 'read');
    }
    function modelQualityHTML(models) {
      if (!models.length) return '<div class="empty">데이터 없음 — 요청·골든 프롬프트·평가 결과가 쌓이면 모델별 품질 점수가 계산됩니다.</div>';
      const pct = (v) => ((v || 0) * 100).toFixed(0) + '%';
      const cat = (m, key) => (m.categories && m.categories[key]) ? pct(m.categories[key].pass_rate) : '<span class="muted">—</span>';
      return '<table><thead><tr>' +
        '<th data-sort="str">모델</th><th data-sort="num">품질점수</th><th data-sort="num">요청</th>' +
        '<th data-sort="num">성공률</th><th data-sort="num">골든</th><th data-sort="num">평가</th>' +
        '<th data-sort="num">컴파일</th><th data-sort="num">테스트</th><th data-sort="num">보안</th><th data-sort="num">리뷰</th></tr></thead><tbody>' +
        models.map(m => {
          const score = Math.round(m.quality_score || 0);
          const color = score >= 80 ? 'var(--accent)' : (score >= 50 ? 'var(--warn)' : 'var(--bad)');
          return '<tr>' +
            '<td><strong>' + escapeHTML(m.model) + '</strong></td>' +
            '<td data-num="' + score + '"><b style="color:' + color + '">' + score + '</b></td>' +
            '<td data-num="' + (m.requests || 0) + '">' + fmt(m.requests) + '</td>' +
            '<td data-num="' + (m.success_rate || 0) + '">' + pct(m.success_rate) + '</td>' +
            '<td data-num="' + (m.golden_pass_rate || 0) + '">' + (m.golden_samples ? pct(m.golden_pass_rate) : '<span class="muted">—</span>') + '</td>' +
            '<td data-num="' + (m.eval_pass_rate || 0) + '">' + (m.eval_samples ? pct(m.eval_pass_rate) : '<span class="muted">—</span>') + '</td>' +
            '<td>' + cat(m, 'compile') + '</td><td>' + cat(m, 'tests') + '</td><td>' + cat(m, 'security') + '</td><td>' + cat(m, 'review') + '</td>' +
          '</tr>';
        }).join('') +
        '</tbody></table>' +
        '<div class="muted" style="font-size:12px; padding:0 14px 12px">품질점수 = 성공률·골든 회귀 통과·평가 통과율·코딩 카테고리(컴파일/테스트/보안/리뷰) 가중 평균. 외부 평가는 <code>POST /admin/llm/evaluations</code> 의 category 로 분류됩니다.</div>';
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
    function normalizePreviewText(value) {
      return String(value || '').replace(/\s+/g, ' ').trim();
    }
    function clipPreviewText(value, maxChars) {
      const chars = Array.from(normalizePreviewText(value));
      if (chars.length <= maxChars) return chars.join('');
      return chars.slice(0, maxChars).join('') + '…';
    }
    function lastUserMessageText(r) {
      const prompts = (r && r.prompts) || [];
      for (let i = prompts.length - 1; i >= 0; i--) {
        const p = prompts[i] || {};
        if (String(p.role || '').toLowerCase() === 'user') return normalizePreviewText(p.redacted_text || p.content_text || '');
      }
      return '';
    }
    function lastUserMessageSnippet(r, maxChars) {
      return clipPreviewText(lastUserMessageText(r), maxChars || 30);
    }
    function requestsTable(rows, opts) {
      if (!rows.length) return '<div class="empty">요청 없음</div>';
      const selectable = opts && opts.selectable;
      const mcpWaterfall = opts && opts.mcpWaterfall;
      const head =
        (selectable ? '<th style="width:32px"></th>' : '') +
        '<th data-sort="num">상태</th>' +
        '<th data-sort="str">시간</th>' +
        '<th data-sort="str">클라이언트</th>' +
        '<th data-sort="str">모델</th>' +
        '<th data-sort="num">첫 청크/전체</th>' +
        '<th data-sort="num">토큰/비용</th>' +
        '<th>프롬프트</th>' +
        (mcpWaterfall ? '<th>워터폴</th>' : '');
      return '<table><thead><tr>' + head + '</tr></thead><tbody>' +
        rows.map(r => {
          const langs = (r.languages || []).map(l => l.language).join(', ');
          const prompt = (r.prompts || []).map(p => p.role + ': ' + p.redacted_text).join('\n\n');
          const lastUser = lastUserMessageSnippet(r, 30);
          const lastUserLine = lastUser ? '<div class="muted" title="' + escapeAttr(lastUserMessageText(r)) + '"><strong>마지막 user</strong> ' + escapeHTML(lastUser) + '</div>' : '';
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
            '<td>' + lastUserLine + '<div class="prompt">' + escapeHTML(prompt) + '</div>' + note + '</td>' +
            (mcpWaterfall ? '<td><button class="secondary" type="button" onclick="event.stopPropagation();openMCPRequestWaterfall(\'' + escapeAttr(r.id) + '\')">MCP Waterfall</button></td>' : '') +
          '</tr>';
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
    function requestReadabilityHTML(d) {
      const r = d.request || {};
      const rd = d.readability || {};
      const basic = rd.basic || {};
      const model = rd.model || {};
      const params = rd.parameters || {};
      const routing = rd.routing || {};
      const policy = rd.policy || {};
      const badges = (rd.badges || []).map(b => '<span class="status ' + badgeClass(b.severity) + '" title="' + escapeAttr(b.reason || '') + '">' + escapeHTML(b.label || b.code || '') + '</span>').join(' ');
      const requested = model.requested_model || r.requested_model || r.model || '';
      const resolved = model.resolved_model || r.resolved_model || r.model || '';
      const upstream = model.upstream_model || r.upstream_model || r.model || '';
      const provider = model.provider || r.provider || '';
      const modelDiff = requested && upstream && requested !== upstream
        ? '<details style="margin-top:8px"><summary>모델 변경 사유</summary><div class="kv" style="margin-top:8px">' +
          row('Requested', '<code>' + escapeHTML(requested) + '</code>') +
          row('Resolved', '<code>' + escapeHTML(resolved) + '</code>') +
          row('Upstream', '<code>' + escapeHTML(upstream) + '</code>') +
          row('Reason', escapeHTML(model.route_reason || routing.decision_reason || routing.route_reason || '')) +
          '</div></details>' : '';
      const summary =
        '<div class="kpis">' +
          kpi('상태', statusBadge(r.status_code), escapeHTML(String(basic.status || ''))) +
          kpi('모델', '<strong>' + escapeHTML(requested || '-') + '</strong>', (requested !== upstream ? '→ ' + escapeHTML(upstream || '-') : escapeHTML(provider || '-'))) +
          kpi('Provider', escapeHTML(provider || '-'), escapeHTML(model.route_rule || routing.route_rule || '')) +
          kpi('Latency', fmt(r.latency_ms || basic.latency_ms || 0) + ' ms', '첫 청크 ' + fmt(r.first_chunk_ms || 0) + ' ms') +
          kpi('Cost', money(r.estimated_cost || 0), fmt(r.total_tokens || 0) + ' tok') +
        '</div>';
      const pinned =
        '<div class="kv" style="margin-top:12px">' +
          row('Request ID', copyableText(r.id || '')) +
          row('Session ID', r.session_id ? copyableText(r.session_id) : '<span class="muted">없음</span>') +
          row('Endpoint', '<code>' + escapeHTML(r.method || basic.method || 'POST') + ' ' + escapeHTML(r.endpoint || '') + '</code>') +
          row('Temperature', temperatureHTML(params.temperature, params.temperature_label)) +
          row('Route Rule', escapeHTML(model.route_rule || routing.route_rule || '-')) +
          row('Badges', badges || '<span class="muted">없음</span>') +
        '</div>' + modelDiff;
      return '<section style="margin-top:0"><h2>OpenAI Gateway 요청 요약</h2><div style="padding:14px">' + summary + pinned + '</div></section>' +
        '<div class="split" style="grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:14px; margin-top:14px">' +
          '<section><h2>요청 파라미터</h2><div style="padding:14px">' + parameterTable(params) + '</div></section>' +
          '<section><h2>라우팅 · 정책</h2><div style="padding:14px">' + routingPolicyHTML(routing, policy) + '</div></section>' +
        '</div>' +
        '<section style="margin-top:14px"><h2>헤더</h2><div style="padding:14px">' + headerGroupsHTML((rd.headers || {})) + '</div></section>';
    }
    function badgeClass(sev) {
      if (sev === 'error') return 'error';
      if (sev === 'warn') return 'warn';
      return '';
    }
    function copyableText(value) {
      const v = String(value || '');
      if (!v) return '<span class="muted">-</span>';
      return '<code>' + escapeHTML(v) + '</code> <button type="button" class="secondary" style="font-size:11px;padding:3px 7px" onclick="copyDetailValue(\'' + escapeAttr(v) + '\')">복사</button>';
    }
    window.copyDetailValue = (value) => { if (navigator.clipboard) navigator.clipboard.writeText(value || ''); };
    function temperatureHTML(value, label) {
      if (value === null || value === undefined || value === '') return '<span class="muted">미지정</span>';
      const n = Number(value);
      const cls = n > 0.8 ? 'warn' : '';
      return '<span class="status ' + cls + '">' + escapeHTML(String(value)) + ' ' + escapeHTML(label || temperatureLabelClient(n)) + '</span>';
    }
    function temperatureLabelClient(n) {
      if (n === 0) return '결정적';
      if (n <= 0.3) return '낮음';
      if (n <= 0.8) return '보통';
      return '높음';
    }
    function parameterTable(params) {
      const rows = [
        ['temperature', temperatureHTML(params.temperature, params.temperature_label)],
        ['top_p', scalarHTML(params.top_p)],
        ['max_tokens', scalarHTML(params.max_tokens)],
        ['max_completion_tokens', scalarHTML(params.max_completion_tokens)],
        ['n', scalarHTML(params.n)],
        ['presence_penalty', scalarHTML(params.presence_penalty)],
        ['frequency_penalty', scalarHTML(params.frequency_penalty)],
        ['stop', jsonInline(params.stop)],
        ['seed', scalarHTML(params.seed)],
        ['response_format', scalarHTML(params.response_format_type)],
        ['tools', fmt(params.tool_count || 0) + '개' + ((params.tool_names || []).length ? '<div class="muted">' + (params.tool_names || []).map(escapeHTML).join(', ') + '</div>' : '')],
        ['tool_choice', jsonInline(params.tool_choice)],
        ['stream', params.stream ? '<span class="status">true</span>' : '<span class="status">false</span>'],
        ['stream_options', jsonInline(params.stream_options)],
        ['user', scalarHTML(params.user)],
      ];
      const extra = params.additional_fields || [];
      if (extra.length) rows.push(['추가 파라미터', '<details><summary>' + fmt(extra.length) + '개</summary><pre class="prompt-block">' + escapeHTML(JSON.stringify(extra, null, 2)) + '</pre></details>']);
      return '<table><thead><tr><th>Parameter</th><th>Value</th></tr></thead><tbody>' +
        rows.map(x => '<tr><td><code>' + escapeHTML(x[0]) + '</code></td><td>' + x[1] + '</td></tr>').join('') +
        '</tbody></table>';
    }
    function routingPolicyHTML(routing, policy) {
      return '<div class="kv">' +
        row('Requested Model', '<code>' + escapeHTML(routing.requested_model || '-') + '</code>') +
        row('Resolved Model', '<code>' + escapeHTML(routing.resolved_model || '-') + '</code>') +
        row('Selected Provider', escapeHTML(routing.selected_provider || '-')) +
        row('Upstream Model', '<code>' + escapeHTML(routing.selected_upstream_model || '-') + '</code>') +
        row('Route Reason', escapeHTML(routing.decision_reason || routing.route_reason || '-')) +
        row('Fallback', routing.fallback ? '<span class="status warn">applied</span> ' + escapeHTML(routing.fallback_reason || '') : '<span class="status">none</span>') +
        row('Policy', '<span class="status ' + ((policy.decision === 'block') ? 'error' : (policy.decision === 'approval' ? 'warn' : '')) + '">' + escapeHTML(policy.decision || 'allow') + '</span>' + (policy.reason ? ' · ' + escapeHTML(policy.reason) : '')) +
        row('Cache', jsonInline(routing.cache)) +
        row('MCP / Text2SQL', (routing.mcp_used ? '<span class="status">MCP</span> ' : '') + (routing.text2sql_used ? '<span class="status">Text2SQL</span>' : (!routing.mcp_used ? '<span class="muted">없음</span>' : ''))) +
      '</div>';
    }
    function headerGroupsHTML(headers) {
      const order = [
        ['primary', '주요 헤더'],
        ['gateway', 'Gateway 헤더'],
        ['client', 'Client 헤더'],
        ['proxy', 'Proxy 헤더'],
        ['upstream_request', 'Upstream 요청 헤더'],
        ['upstream_response', 'Upstream 응답 헤더'],
        ['gateway_response', 'Gateway 응답 헤더'],
        ['request', '전체 원본 헤더(마스킹)']
      ];
      return order.map(([key, label], idx) => {
        const group = headers[key] || {};
        const open = idx < 2 ? ' open' : '';
        return '<details' + open + ' style="margin-bottom:8px"><summary>' + escapeHTML(label) + ' <span class="muted">(' + fmt(Object.keys(group).filter(k => !k.startsWith('_')).length) + ')</span></summary>' +
          headerTable(group) + '</details>';
      }).join('');
    }
    function headerTable(group) {
      const keys = Object.keys(group || {}).filter(k => !k.startsWith('_')).sort();
      if (!keys.length) return '<div class="empty">헤더 없음</div>';
      return '<table style="margin-top:8px"><thead><tr><th>Header</th><th>Value</th></tr></thead><tbody>' +
        keys.map(k => '<tr><td><code>' + escapeHTML(k) + '</code></td><td style="word-break:break-all">' + escapeHTML(String(group[k] || '')) + '</td></tr>').join('') +
        '</tbody></table>';
    }
    function scalarHTML(v) {
      if (v === null || v === undefined || v === '') return '<span class="muted">-</span>';
      if (typeof v === 'boolean') return '<span class="status">' + String(v) + '</span>';
      return escapeHTML(String(v));
    }
    function jsonInline(v) {
      if (v === null || v === undefined || v === '') return '<span class="muted">-</span>';
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return scalarHTML(v);
      return '<details><summary>JSON</summary><pre class="prompt-block">' + escapeHTML(JSON.stringify(v, null, 2)) + '</pre></details>';
    }
    function requestDetailHTML(d, note, links) {
      const r = d.request;
      // Surface the most recent user message at the very top of the modal (above 요청 ID),
      // rendered for maximum readability — it's the question the operator most wants to see.
      let lastUserText = '';
      for (const p of (d.prompts || [])) {
        if ((p.role || '').toLowerCase() === 'user') lastUserText = p.redacted_text || p.content_text || '';
      }
      const lastUserBlock = lastUserText.trim() ? (
        '<div style="border:1px solid var(--line); border-left:4px solid #6ea8fe; border-radius:8px; background:rgba(110,168,254,0.08); padding:12px 14px; margin-bottom:14px;">' +
          '<div style="font-weight:800; font-size:11px; letter-spacing:.05em; color:var(--muted); margin-bottom:6px;">💬 마지막 사용자 메시지</div>' +
          '<div style="white-space:normal; line-height:1.65; font-size:14.5px;">' + renderMarkdown(lastUserText) + '</div>' +
        '</div>'
      ) : '';
      const explainBtn = '<div style="margin-bottom:12px"><button class="secondary" type="button" onclick="closeModal();openExplain(\'' + escapeAttr(r.id) + '\')">🧭 XView 설명 (왜 이렇게 처리됐나)</button> ' +
        '<button class="secondary" type="button" onclick="showFlowMap(\'' + escapeAttr(r.id) + '\')">🗺️ 처리 흐름</button> ' +
        '<button class="secondary" type="button" onclick="showAgenticRun(\'' + escapeAttr(r.id) + '\')">🔧 MCP Agentic</button></div>';
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

        return '<div class="prompt-block markdown-view">' +
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
          '<div class="k">캡처된 응답</div><div class="v">' + (d.response.response_text_optional ? ('<div class="prompt-block markdown-view">' + renderMarkdown(d.response.response_text_optional) + '</div>') : '<span class="muted">없음 (LOG_RESPONSE_TEXT=false)</span>') + '</div>' +
        '</div>'
      ) : '<div class="muted">응답 메타 없음</div>';
      const cv = d.code_verify;
      const codeVerify = cv ? (() => {
        const rcls = cv.risk === 'high' ? 'error' : (cv.risk === 'medium' ? 'warn' : '');
        const fcls = (sev) => sev === 'high' ? 'error' : (sev === 'medium' ? 'warn' : '');
        const findings = Array.isArray(cv.findings) ? cv.findings : [];
        const list = findings.length ? ('<table><thead><tr><th>심각도</th><th>언어</th><th>줄</th><th>규칙</th><th>설명</th></tr></thead><tbody>' +
          findings.slice(0, 50).map(f => '<tr>' +
            '<td><span class="status ' + fcls(f.severity) + '">' + escapeHTML(f.severity || '') + '</span></td>' +
            '<td>' + escapeHTML(f.lang || '') + '</td>' +
            '<td>' + (f.line ? fmt(f.line) : '-') + '</td>' +
            '<td>' + escapeHTML(f.rule || '') + '</td>' +
            '<td>' + escapeHTML(f.detail || '') + '</td>' +
          '</tr>').join('') + '</tbody></table>') : '<div class="muted">발견 항목 없음</div>';
        return '<div class="kv">' +
          row('위험도', '<span class="status ' + rcls + '">' + escapeHTML(cv.risk || '') + '</span>') +
          row('코드블록', fmt(cv.block_count || 0) + (cv.languages ? ' (' + escapeHTML(cv.languages) + ')' : '')) +
          row('위험 발견', 'high ' + fmt(cv.high_count || 0) + ' / med ' + fmt(cv.medium_count || 0)) +
          row('시크릿/구문', fmt(cv.secret_count || 0) + ' / ' + fmt(cv.syntax_count || 0)) +
          row('테스트 가능 블록', fmt(cv.testable_count || 0)) +
        '</div>' + list;
      })() : '<div class="muted">코드 검증 기록 없음 (응답에 코드블록이 없거나 캡처 비활성)</div>';
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
      const text2sqlSpans = text2SQLSpanTable(d.text2sql_spans || []);

      return (
        lastUserBlock +
        explainBtn +
        traceLinksHTML(r.id, links) +
        requestReadabilityHTML(d) +
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
          row('Session', r.session_id ? (escapeHTML(r.session_id) + ' · <a href="#" onclick="openFlightRecorder(\'' + escapeAttr(r.session_id) + '\');return false">비행기록</a>') : '<span class="muted">없음</span>') +
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
        '<h3 style="margin-top:18px">코드 검증</h3>' + codeVerify +
        '<h3 style="margin-top:18px">LLM Spans</h3>' + spans +
        '<h3 style="margin-top:18px">Text2SQL Timeline</h3>' + text2sqlSpans +
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
    // 세션 비행기록 인덱스 — 최근 코딩 세션 목록, 각 세션의 비행기록 모달로 드릴인.
    async function renderSessionsView() {
      const view = document.getElementById('view');
      const days = sessionStorage.getItem('sessionsDays') || '7';
      view.innerHTML = section('세션 비행기록',
        '<div class="toolbar"><label class="muted">기간(일) <input id="sess-days" type="number" min="1" max="365" value="' + escapeAttr(days) + '" style="width:80px"></label>' +
        '<button type="button" id="sess-reload">조회</button></div>' +
        '<div id="sessions-results"><div class="empty">불러오는 중...</div></div>');
      const load = async () => {
        const d = document.getElementById('sess-days').value.trim() || '7';
        sessionStorage.setItem('sessionsDays', d);
        const host = document.getElementById('sessions-results');
        try {
          const data = await api('/admin/sessions?days=' + encodeURIComponent(d));
          const ss = data.sessions || [];
          if (!ss.length) { host.innerHTML = '<div class="empty">세션 없음 (클라이언트가 session_id를 보내야 집계됩니다)</div>'; return; }
          const rows = ss.map(s => '<tr>' +
            '<td><code>' + escapeHTML(s.session_id) + '</code></td>' +
            '<td>' + fmt(s.requests || 0) + (s.errors ? ' · <span class="status error">' + s.errors + '</span>' : '') + '</td>' +
            '<td>' + fmt(s.models || 0) + '</td>' +
            '<td>' + fmt(s.total_tokens || 0) + '</td>' +
            '<td>' + money(s.cost_krw || 0) + '</td>' +
            '<td>' + ago(s.last_seen) + '</td>' +
            '<td><button type="button" class="secondary" onclick="openFlightRecorder(\'' + escapeAttr(s.session_id) + '\')">비행기록</button></td>' +
          '</tr>').join('');
          host.innerHTML = card('최근 세션 (' + ss.length + ')',
            '<div class="card-body"><table><thead><tr><th>세션</th><th>요청</th><th>모델</th><th>토큰</th><th>비용</th><th>마지막 활동</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>' +
            '<p class="muted" style="font-size:10px;margin-top:6px">' + escapeHTML(data.note || '') + '</p></div>');
        } catch (e) { host.innerHTML = '<span class="status error">' + escapeHTML(e.message) + '</span>'; }
      };
      document.getElementById('sess-reload').addEventListener('click', load);
      await load();
    }

    // Red Team Automation — registered upstream targets only, safe probe packs, dry-run first.
    async function renderRedTeamView() {
      const view = document.getElementById('view');
      view.innerHTML = section('레드팀 자동화', '<div class="empty">불러오는 중...</div>');
      let targets = {}, packs = {}, campaigns = {}, runs = {}, baselines = {}, rems = {}, dash = {}, kill = {};
      try {
        [targets, packs, campaigns, runs, baselines, rems, dash, kill] = await Promise.all([
          api('/admin/redteam/targets'),
          api('/admin/redteam/probe-packs'),
          api('/admin/redteam/campaigns'),
          api('/admin/redteam/runs'),
          api('/admin/redteam/baselines'),
          api('/admin/redteam/remediations').catch(() => ({ remediations: [] })),
          api('/admin/redteam/dashboard').catch(() => ({ summary: {}, matrix: [], top_failing_targets: [], drift: [] })),
          api('/admin/redteam/kill-switch').catch(() => ({ enabled: false })),
        ]);
      } catch (e) {
        view.innerHTML = section('레드팀 자동화', '<div class="card-body" style="padding:16px"><p class="muted">' + escapeHTML(e.message) + '</p></div>');
        return;
      }
      const ts = targets.targets || [];
      const ps = packs.probe_packs || [];
      const cs = campaigns.campaigns || [];
      const rs = runs.runs || [];
      const bs = baselines.baselines || [];
      const remediationRows = (rems.remediations || []).slice(0, 20).map(r =>
        '<tr><td>' + escapeHTML(r.action_type || '') + '</td><td><code>' + escapeHTML(r.result_id || '') + '</code></td>' +
        '<td><span class="status ' + redTeamStatusClass(r.status) + '">' + escapeHTML(r.status || '') + '</span></td>' +
        '<td>' + escapeHTML(r.owner || '-') + '</td><td class="muted" style="font-size:11px">' + ago(r.created_at) + '</td></tr>'
      ).join('') || '<tr><td colspan="5" class="muted">조치 없음</td></tr>';
      const byType = {};
      ts.forEach(t => { byType[t.target_type] = (byType[t.target_type] || 0) + 1; });
      const highTargets = ts.filter(t => ['high', 'critical'].indexOf(t.risk_level) >= 0).length;
      const failedRuns = rs.filter(r => r.status === 'failed').length;
      const maxRisk = rs.reduce((m, r) => Math.max(m, Number(r.risk_score || 0)), 0);
      const targetRows = ts.slice(0, 80).map(t => {
        const meta = t.metadata || {};
        const label = meta.title || meta.name || meta.base_url || t.model || t.tool_name || t.target_ref;
        return '<tr>' +
          '<td><span class="status" style="font-size:9px">' + escapeHTML(t.target_type) + '</span></td>' +
          '<td><code>' + escapeHTML(t.target_ref) + '</code><div class="muted" style="font-size:10px">' + escapeHTML(label || '') + '</div></td>' +
          '<td><span class="status ' + redTeamRiskClass(t.risk_level) + '">' + escapeHTML(t.risk_level || 'low') + '</span></td>' +
          '<td>' + (t.enabled ? '<span class="status">활성</span>' : '<span class="status warn">비활성</span>') + '</td>' +
          '<td>' + escapeHTML(t.provider || t.mcp_upstream || '-') + '</td>' +
        '</tr>';
      }).join('') || '<tr><td colspan="5" class="muted">등록된 대상 없음</td></tr>';
      // 캠페인 빌더의 프로바이더/모델 선택용 데이터(대상 인벤토리에서 추출).
      const rtProviders = Array.from(new Set(ts.filter(t => t.target_type === 'provider' && t.provider).map(t => t.provider))).sort();
      const rtModels = ts.filter(t => t.target_type === 'model' && t.model).map(t => ({ provider: t.provider || '', model: t.model }));
      const rtProviderOpts = '<option value="">(전체 프로바이더)</option>' + rtProviders.map(p => '<option value="' + escapeAttr(p) + '">' + escapeHTML(p) + '</option>').join('');
      const rtModelChecks = rtModels.length
        ? rtModels.map(m => '<label><input type="checkbox" class="rt-model" value="' + escapeAttr(m.model) + '" data-provider="' + escapeAttr(m.provider) + '"> ' + escapeHTML(m.model) + (m.provider ? ' <span class="muted">(' + escapeHTML(m.provider) + ')</span>' : '') + '</label>').join('')
        : '<span class="muted" style="font-size:12px">등록된 모델 대상이 없습니다. 비워두면 실행 시 /v1/models에서 자동 선택합니다.</span>';
      const packChecks = ps.map(p =>
        '<label style="display:block;margin:4px 0"><input type="checkbox" class="rt-pack" value="' + escapeAttr(p.id) + '" checked onchange="rtPackCount()"> ' +
        '<strong>' + escapeHTML(p.name) + '</strong> <span class="status ' + redTeamRiskClass(p.severity) + '" style="font-size:9px">' + escapeHTML(p.severity) + '</span> ' +
        (p.requires_approval ? '<span class="status warn" style="font-size:9px">승인필요</span> ' : '') +
        '<span class="muted" style="font-size:11px">' + escapeHTML(p.category) + ' · 케이스 ' + ((p.cases || []).length) + '</span></label>'
      ).join('') || '<p class="muted">프로브 팩 없음</p>';
      const campaignRows = cs.map(c =>
        '<tr><td><strong>' + escapeHTML(c.name) + '</strong><div class="muted" style="font-size:10px"><code>' + escapeHTML(c.id) + '</code></div></td>' +
        '<td>' + escapeHTML(c.scope || 'all') + '</td>' +
        '<td><span class="status ' + redTeamStatusClass(c.status) + '">' + escapeHTML(c.status || '') + '</span></td>' +
        '<td>' + escapeHTML(c.execution_mode || '') + '</td>' +
        '<td>' + money(c.budget_limit_krw || 0) + '</td>' +
        '<td style="white-space:nowrap"><button type="button" class="secondary" style="font-size:11px" onclick="redTeamDryRun(\'' + escapeAttr(c.id) + '\')">드라이런</button> ' +
        '<button type="button" class="secondary" style="font-size:11px" onclick="redTeamApprove(\'' + escapeAttr(c.id) + '\')">승인</button> ' +
        '<button type="button" style="font-size:11px" onclick="redTeamRun(\'' + escapeAttr(c.id) + '\',\'' + escapeAttr(c.execution_mode || '') + '\')">' + (c.execution_mode === 'active-controlled' ? '실제 실행' : '시뮬레이션 실행') + '</button> ' +
        '<button type="button" class="secondary" style="font-size:11px" onclick="redTeamDeleteCampaign(\'' + escapeAttr(c.id) + '\',\'' + escapeAttr(c.name || '') + '\')">삭제</button></td></tr>'
      ).join('') || '<tr><td colspan="6" class="muted">아직 캠페인이 없습니다. 위 <b>캠페인 빌더</b>로 만들거나, 상단 <b>⚡ 빠른 시작</b>으로 안전 팩 드라이런을 바로 실행해 보세요.</td></tr>';
      const runRows = rs.slice(0, 30).map(r =>
        '<tr><td><code>' + escapeHTML(r.id) + '</code><div class="muted" style="font-size:10px">' + ago(r.created_at) + '</div></td>' +
        '<td><code>' + escapeHTML(r.campaign_id) + '</code></td><td><code>' + escapeHTML(r.target_id) + '</code></td>' +
        '<td><span class="status ' + redTeamStatusClass(r.status) + '">' + escapeHTML(r.status) + '</span></td>' +
        '<td>' + fmt(r.failed_cases || 0) + ' / ' + fmt(r.total_cases || 0) + '</td>' +
        '<td><span class="status ' + redTeamScoreClass(r.risk_score) + '">' + fmt(r.risk_score || 0) + '</span></td>' +
        '<td><button type="button" class="secondary" style="font-size:11px" onclick="redTeamShowRunResults(\'' + escapeAttr(r.id) + '\')">결과</button></td></tr>'
      ).join('') || '<tr><td colspan="7" class="muted">실행 이력 없음</td></tr>';
      const baselineRows = bs.slice(0, 20).map(b =>
        '<tr><td><code>' + escapeHTML(b.target_id) + '</code></td><td><code>' + escapeHTML(b.pack_id) + '</code></td>' +
        '<td>' + fmt(b.baseline_score || 0) + '</td><td>' + fmt(b.drift_threshold || 0) + '</td><td class="muted" style="font-size:11px">' + ago(b.last_passed_at || b.updated_at) + '</td></tr>'
      ).join('') || '<tr><td colspan="5" class="muted">기준선 없음</td></tr>';
      const dsum = dash.summary || {};
      const dec = dsum.by_decision || {};
      const matrixRows = (dash.matrix || []).map(m =>
        '<tr><td><span class="status" style="font-size:9px">' + escapeHTML(m.target_type) + '</span></td>' +
        '<td>' + escapeHTML(m.pack_category) + '</td>' +
        '<td>' + fmt(m.pass || 0) + '</td>' +
        '<td>' + (m.warning ? '<span class="status warn">' + fmt(m.warning) + '</span>' : '0') + '</td>' +
        '<td>' + (m.fail ? '<span class="status error">' + fmt(m.fail) + '</span>' : '0') + '</td>' +
        '<td>' + (m.critical ? '<span class="status error">' + fmt(m.critical) + '</span>' : '0') + '</td>' +
        '<td>' + fmt(m.total || 0) + '</td></tr>'
      ).join('') || '<tr><td colspan="7" class="muted">결과 매트릭스 데이터 없음 — 캠페인을 실행하면 채워집니다.</td></tr>';
      const failingRows = (dash.top_failing_targets || []).map(t =>
        '<tr><td><code>' + escapeHTML(t.target_ref || '') + '</code><div class="muted" style="font-size:10px">' + escapeHTML(t.target_type || '') + ' · ' + escapeHTML(t.owner_team || '-') + '</div></td>' +
        '<td>' + (t.critical ? '<span class="status error">' + fmt(t.critical) + '</span>' : '0') + '</td>' +
        '<td>' + (t.fail ? '<span class="status error">' + fmt(t.fail) + '</span>' : '0') + '</td>' +
        '<td>' + (t.warning ? '<span class="status warn">' + fmt(t.warning) + '</span>' : '0') + '</td>' +
        '<td><span class="status ' + redTeamScoreClass(t.max_risk) + '">' + fmt(t.max_risk || 0) + '</span></td></tr>'
      ).join('') || '<tr><td colspan="5" class="muted">실패 대상 없음</td></tr>';
      const driftRows = (dash.drift || []).map(d =>
        '<tr><td><code>' + escapeHTML(d.target_id || '') + '</code></td><td><code>' + escapeHTML(d.pack_id || '') + '</code></td>' +
        '<td>' + fmt(d.baseline_score || 0) + ' → ' + fmt(d.current_score || 0) + '</td>' +
        '<td><span class="status error">+' + fmt(d.delta || 0) + '</span> (임계 ' + fmt(d.threshold || 0) + ')</td>' +
        '<td class="muted" style="font-size:11px">' + ago(d.last_passed_at) + '</td></tr>'
      ).join('') || '<tr><td colspan="5" class="muted">기준선 드리프트 없음</td></tr>';
      const killOn = !!(kill && kill.enabled);
      const keySaved = !!localStorage.getItem('rt_proxy_key');

      // 탭별 패널 콘텐츠.
      const panelOverview =
        '<div class="kpis">' + kpi('대상', fmt(ts.length)) + kpi('고위험/치명', fmt(highTargets)) + kpi('프로브 팩', fmt(ps.length)) + kpi('최근 실행 위험', fmt(maxRisk)) + kpi('실패한 실행', fmt(failedRuns)) + '</div>' +
        '<div class="kpis">' + kpi('결과 수', fmt(dsum.total_results || 0)) + kpi('치명', fmt(dec.critical || 0)) + kpi('실패', fmt(dec.fail || 0)) + kpi('경고', fmt(dec.warning || 0)) + kpi('외부 대상', fmt(dsum.external_targets || 0)) + kpi('미조치', fmt(dsum.open_remediations || 0)) + '</div>' +
        '<div class="grid2">' +
          card('결과 매트릭스 (대상 × 프로브 팩)', '<div class="card-body"><table><thead><tr><th>유형</th><th>팩 분류</th><th>통과</th><th>경고</th><th>실패</th><th>치명</th><th>계</th></tr></thead><tbody>' + matrixRows + '</tbody></table></div>') +
          card('상위 실패 대상', '<div class="card-body"><table><thead><tr><th>대상</th><th>치명</th><th>실패</th><th>경고</th><th>최고 위험</th></tr></thead><tbody>' + failingRows + '</tbody></table></div>') +
        '</div>' +
        card('기준선 드리프트 (' + (dash.drift || []).length + ')', '<div class="card-body"><table><thead><tr><th>대상</th><th>팩</th><th>기준→현재</th><th>드리프트</th><th>최근 통과</th></tr></thead><tbody>' + driftRows + '</tbody></table></div>');

      const panelCampaigns =
        section('캠페인 빌더',
          '<div class="card-body">' +
          '<div class="grid2 rt-form"><label>캠페인 이름<input id="rt-name" placeholder="예: 주간-프로바이더-mcp-레드팀"></label>' +
          '<label>범위(scope)<select id="rt-scope"><option value="all">전체</option><option value="provider">프로바이더/모델</option><option value="mcp">MCP</option><option value="text2sql">Text2SQL</option><option value="ai_app">AI 앱</option><option value="workflow">워크플로</option></select><span class="rt-hint">테스트할 대상 유형</span></label>' +
          '<label>실행 모드<select id="rt-mode"><option value="dry-run">드라이런(호출 없음)</option><option value="shadow">섀도우</option><option value="active-controlled">실제 실행(통제)</option><option value="pre-release">릴리즈 전</option><option value="post-change">변경 후</option></select><span class="rt-hint">실제 호출은 “실제 실행(통제)”에서만</span></label>' +
          '<label>프로바이더(선택)<select id="rt-provider" onchange="rtProviderChange()">' + rtProviderOpts + '</select><span class="rt-hint">특정 업스트림만 대상으로 제한</span></label>' +
          '<div class="rt-field"><div class="rt-fieldcap">모델(다중 선택 가능)</div><div id="rt-model-box" class="rt-modelbox">' + rtModelChecks + '</div><span class="rt-hint">여러 개 선택 시 모델마다 각각 호출 · 비우면 /v1/models에서 자동 선택</span></div>' +
          '<label>예산 한도(KRW)<input id="rt-budget" type="number" min="0" value="1000"><span class="rt-hint">초과 시 실행 자동 중단</span></label>' +
          '<label>QPS 한도<input id="rt-qps" type="number" min="0" step="0.1" value="1"><span class="rt-hint">대상별 초당 요청 상한</span></label>' +
          '<label>파괴적 도구 정책<select id="rt-destructive"><option value="dry-run">드라이런</option><option value="mock">모의(mock)</option><option value="approval">승인 필요</option><option value="block">차단</option></select><span class="rt-hint">삭제/배포성 MCP 도구 처리 방식</span></label></div>' +
          '<div style="margin-top:10px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">' +
          '<strong>프로브 팩</strong> ' +
          '<button type="button" class="secondary" style="font-size:11px" onclick="rtPacksAll(true)">전체 선택</button> ' +
          '<button type="button" class="secondary" style="font-size:11px" onclick="rtPacksAll(false)">전체 해제</button> ' +
          '<button type="button" class="secondary" style="font-size:11px" onclick="rtPacksInvert()">선택 반전</button> ' +
          '<span id="rt-pack-count" class="muted" style="font-size:11px">' + ps.length + '개 중 ' + ps.length + '개 선택</span></div>' +
          '<div style="max-height:220px;overflow:auto;border:1px solid var(--line-strong);border-radius:6px;padding:8px;margin-top:4px">' + (ps.length ? packChecks : '<span class="muted" style="font-size:12px">프로브 팩이 없습니다.</span>') + '</div>' +
          '<button type="button" style="margin-top:10px" onclick="redTeamCreateCampaign()">캠페인 생성</button> ' +
          '<div class="muted" style="font-size:11px;margin-top:8px;line-height:1.7">' +
          '<b>실제로 대상을 호출하려면(실전 실행):</b><br>' +
          '① 위 <b>실행 모드</b>를 <b>「실제 실행(통제)」</b>로 선택해 캠페인을 생성 · ' +
          '② (고위험 팩이면) 목록에서 <b>승인</b> · ' +
          '③ <b>실제 실행</b> 버튼을 눌러 프롬프트에 <b>전용 레드팀 Proxy API Key</b> 입력.<br>' +
          '그 외 모드(드라이런/섀도우 등)나 키 미입력 시에는 실제 호출 없이 <b>시뮬레이션</b>으로 안전 실행됩니다. MCP 도구·파괴적·앱/워크플로 대상은 항상 시뮬레이션입니다.</div></div>') +
        card('캠페인', '<div class="card-body"><table><thead><tr><th>이름</th><th>범위</th><th>상태</th><th>모드</th><th>예산</th><th>작업</th></tr></thead><tbody>' + campaignRows + '</tbody></table></div>');

      const panelTargets =
        '<div class="grid2">' +
          card('대상 인벤토리 (' + ts.length + ')', '<div class="card-body"><table><thead><tr><th>유형</th><th>대상</th><th>위험</th><th>상태</th><th>프로바이더/업스트림</th></tr></thead><tbody>' + targetRows + '</tbody></table><p class="muted" style="font-size:10px;margin-top:6px">' + escapeHTML(targets.note || '') + '</p></div>') +
          card('프로브 팩 (' + ps.length + ')', '<div class="card-body">' + ps.map(p => '<div style="border-bottom:1px solid var(--line);padding:6px 0"><strong>' + escapeHTML(p.name) + '</strong> <span class="status ' + redTeamRiskClass(p.severity) + '" style="font-size:9px">' + escapeHTML(p.severity) + '</span> ' + (p.requires_approval ? '<span class="status warn" style="font-size:9px">승인필요</span>' : '') + ' <button type="button" class="secondary" style="font-size:10px" onclick="redTeamShowPackCases(\'' + escapeAttr(p.id) + '\')">케이스 보기</button><div class="muted" style="font-size:11px">' + escapeHTML(p.category) + ' · ' + escapeHTML(p.version) + ' · 케이스 ' + ((p.cases || []).length) + '</div></div>').join('') + '</div>') +
        '</div>';

      const panelRuns =
        card('실행 이력', '<div class="card-body"><table><thead><tr><th>실행</th><th>캠페인</th><th>대상</th><th>상태</th><th>실패/전체</th><th>위험</th><th></th></tr></thead><tbody>' + runRows + '</tbody></table></div>') +
        '<div class="grid2">' +
          card('기준선 앵커', '<div class="card-body"><table><thead><tr><th>대상</th><th>팩</th><th>기준 점수</th><th>드리프트 임계</th><th>최근 통과</th></tr></thead><tbody>' + baselineRows + '</tbody></table></div>') +
          card('조치 보드', '<div class="card-body"><table><thead><tr><th>조치 유형</th><th>결과 ID</th><th>상태</th><th>담당</th><th>생성</th></tr></thead><tbody>' + remediationRows + '</tbody></table></div>') +
        '</div>';

      const tab = (name, label) => '<button type="button" class="rt-tabbtn' + (name === rtActiveTab ? ' active' : '') + '" data-rt="' + name + '" onclick="rtTab(\'' + name + '\')">' + label + '</button>';
      const panel = (name, html) => '<div class="rt-panel" data-rt="' + name + '" style="display:' + (name === rtActiveTab ? 'block' : 'none') + ';border:1px solid var(--line-strong);border-radius:0 8px 8px 8px;padding:10px">' + html + '</div>';

      view.innerHTML = section('레드팀 자동화',
        '<p class="muted" style="font-size:12px;padding:0 14px">게이트웨이에 등록된 업스트림만 대상으로 하는 허가형 AI 보안 회귀 테스트입니다. 기본은 드라이런이며, 고위험 팩은 승인 없이는 실제 실행되지 않습니다. 실제 호출(Active Controlled Run)은 전용 레드팀 Proxy API Key(사용자·키 관리에서 발급한 Proxy API Key)로만 수행됩니다.</p>' +
        '<div style="padding:0 14px 6px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">' +
        '<button type="button" style="font-size:11px" onclick="redTeamQuickStart()">⚡ 빠른 시작(안전 팩 드라이런)</button> ' +
        '<span class="status ' + (killOn ? 'error' : '') + '">킬 스위치: ' + (killOn ? '켜짐(중지)' : '꺼짐') + '</span> ' +
        (killOn
          ? '<button type="button" class="secondary" style="font-size:11px" onclick="redTeamKillSwitch(false)">해제</button>'
          : '<button type="button" class="secondary" style="font-size:11px" onclick="redTeamKillSwitch(true)">전체 중지</button>') +
        (keySaved ? ' <span class="status" style="font-size:10px">실행 키 저장됨</span> <button type="button" class="secondary" style="font-size:10px" onclick="redTeamClearKey()">키 지우기</button>' : '') +
        '</div>') +
        '<div style="padding:0 14px">' +
        '<div class="rt-tabbar" style="display:flex;gap:4px;flex-wrap:wrap">' +
          tab('overview', '개요·지표') + tab('campaigns', '캠페인') + tab('targets', '대상·프로브 팩') + tab('runs', '실행·조치') +
        '</div>' +
        panel('overview', panelOverview) +
        panel('campaigns', panelCampaigns) +
        panel('targets', panelTargets) +
        panel('runs', panelRuns) +
        '</div>';
      window.__rtModels = rtModels; // 프로바이더별 모델 필터용
    }
    // 프로바이더 선택 시 모델 체크박스 목록을 해당 프로바이더 모델로 재구성.
    window.rtProviderChange = () => {
      const provEl = document.getElementById('rt-provider');
      const box = document.getElementById('rt-model-box');
      if (!provEl || !box) return;
      const prov = provEl.value;
      const models = (window.__rtModels || []).filter(m => !prov || m.provider === prov);
      box.innerHTML = models.length
        ? models.map(m => '<label><input type="checkbox" class="rt-model" value="' + escapeAttr(m.model) + '" data-provider="' + escapeAttr(m.provider) + '"> ' + escapeHTML(m.model) + (m.provider ? ' <span class="muted">(' + escapeHTML(m.provider) + ')</span>' : '') + '</label>').join('')
        : '<span class="muted" style="font-size:12px">이 프로바이더의 모델 대상이 없습니다. 비워두면 /v1/models에서 자동 선택합니다.</span>';
    };

    function redTeamRiskClass(v) {
      v = String(v || '').toLowerCase();
      return v === 'critical' || v === 'high' ? 'error' : (v === 'medium' ? 'warn' : '');
    }
    function redTeamStatusClass(v) {
      v = String(v || '').toLowerCase();
      if (['failed', 'critical', 'rejected', 'blocked'].indexOf(v) >= 0) return 'error';
      if (['warning', 'pending', 'draft', 'running'].indexOf(v) >= 0) return 'warn';
      return '';
    }
    function redTeamScoreClass(v) {
      const n = Number(v || 0);
      return n >= 65 ? 'error' : (n >= 25 ? 'warn' : '');
    }
    // 레드팀 내부 서브탭 상태(재렌더 후에도 유지).
    let rtActiveTab = 'overview';
    window.rtTab = (name) => {
      rtActiveTab = name;
      document.querySelectorAll('.rt-panel').forEach(p => { p.style.display = (p.dataset.rt === name) ? 'block' : 'none'; });
      document.querySelectorAll('.rt-tabbtn').forEach(b => b.classList.toggle('active', b.dataset.rt === name));
    };
    window.rtPackCount = () => {
      const boxes = Array.from(document.querySelectorAll('.rt-pack'));
      const sel = boxes.filter(b => b.checked).length;
      const el = document.getElementById('rt-pack-count');
      if (el) el.textContent = boxes.length + '개 중 ' + sel + '개 선택';
    };
    window.rtPacksAll = (on) => {
      document.querySelectorAll('.rt-pack').forEach(b => { b.checked = !!on; });
      rtPackCount();
    };
    window.rtPacksInvert = () => {
      document.querySelectorAll('.rt-pack').forEach(b => { b.checked = !b.checked; });
      rtPackCount();
    };
    window.redTeamDeleteCampaign = async (id, name) => {
      if (!window.confirm('캠페인 "' + (name || id) + '" 및 관련 실행·결과·증적을 모두 삭제할까요? 되돌릴 수 없습니다.')) return;
      try {
        await api('/admin/redteam/campaigns/' + encodeURIComponent(id), { method: 'DELETE' });
        await renderRedTeamView();
      } catch (e) { openModal('삭제 오류', '<div class="error-line">' + escapeHTML(e.message) + '</div>'); }
    };
    window.redTeamCreateCampaign = async () => {
      const packs = Array.from(document.querySelectorAll('.rt-pack:checked')).map(x => x.value);
      const provider = (document.getElementById('rt-provider') || {}).value || '';
      const models = Array.from(document.querySelectorAll('.rt-model:checked')).map(x => x.value);
      const targetFilter = {};
      if (provider) targetFilter.provider = provider;
      if (models.length) targetFilter.models = models;
      const body = {
        name: document.getElementById('rt-name').value.trim(),
        scope: document.getElementById('rt-scope').value,
        execution_mode: document.getElementById('rt-mode').value,
        budget_limit_krw: Number(document.getElementById('rt-budget').value || 0),
        qps_limit: Number(document.getElementById('rt-qps').value || 0),
        destructive_tool_policy: document.getElementById('rt-destructive').value,
        probe_pack_ids: packs,
        target_filter: targetFilter,
      };
      if (!body.name) { alert('캠페인 이름을 입력하세요.'); return; }
      try {
        const d = await api('/admin/redteam/campaigns', { method: 'POST', body: JSON.stringify(body) });
        const cc = d.campaign || d;
        openModal('캠페인 생성됨',
          '<p>캠페인 <strong>' + escapeHTML(cc.name || '') + '</strong> 이(가) 생성되었습니다.</p>' +
          '<table><tr><th style="text-align:left">ID</th><td><code>' + escapeHTML(cc.id || '') + '</code></td></tr>' +
          '<tr><th style="text-align:left">실행 모드</th><td>' + escapeHTML(cc.execution_mode || '') + '</td></tr></table>' +
          '<p class="muted" style="font-size:12px;margin-top:8px">다음 단계: 아래 <b>캠페인</b> 목록에서 <b>드라이런</b>으로 예상 규모·비용을 확인한 뒤, (고위험 팩이면 <b>승인</b> 후) <b>실행</b>하세요.</p>');
        await renderRedTeamView();
      } catch (e) { openModal('레드팀 오류', '<div class="error-line">' + escapeHTML(e.message) + '</div>'); }
    };
    window.redTeamDryRun = async (id) => {
      try {
        const d = await api('/admin/redteam/campaigns/' + encodeURIComponent(id) + '/dry-run', { method: 'POST' });
        const lim = d.limits || {};
        const html =
          '<p class="muted" style="font-size:12px">실제 호출 없이 이번 캠페인이 대상으로 삼을 범위와 예상 규모를 계산합니다.</p>' +
          '<div class="kpis">' + kpi('대상 수', fmt(d.targets || 0)) + kpi('프로브 팩', fmt(d.probe_packs || 0)) + kpi('실행 케이스', fmt(d.case_executions || 0)) + kpi('예상 비용(KRW)', money(d.estimated_cost_krw || 0)) + '</div>' +
          '<table>' +
          '<tr><th style="text-align:left">실호출 가능 대상</th><td>' + fmt(d.active_eligible_targets || 0) + '건 ' + ((d.active_eligible_targets || 0) > 0 ? '<span class="muted" style="font-size:11px">(active-controlled + 키 입력 시 실제 호출)</span>' : '<span class="status warn">0건 — 실행해도 시뮬레이션(구체 모델 대상 없음)</span>') + '</td></tr>' +
          '<tr><th style="text-align:left">외부 provider 대상</th><td>' + fmt(d.external_targets || 0) + '건' + ((d.external_targets || 0) > 0 ? ' <span class="status warn">egress 주의</span>' : '') + '</td></tr>' +
          '<tr><th style="text-align:left">파괴적 MCP 대상</th><td>' + fmt(d.destructive_tool_targets || 0) + '건</td></tr>' +
          '<tr><th style="text-align:left">승인 필요</th><td>' + (d.requires_approval ? (d.approved ? '<span class="status">예 — 승인 완료</span>' : '<span class="status warn">예 — 승인 필요(미승인)</span>') : '아니오') + '</td></tr>' +
          '<tr><th style="text-align:left">실행 가능</th><td>' + (d.can_run ? '<span class="status">예</span>' : '<span class="status error">아니오 — 승인 후 실행</span>') + '</td></tr>' +
          '<tr><th style="text-align:left">한도</th><td class="muted" style="font-size:12px">예산 ' + money(lim.budget_limit_krw || 0) + ' · QPS ' + fmt(lim.qps_limit || 0) + ' · 동시성 ' + fmt(lim.concurrency || 0) + '</td></tr>' +
          '</table>';
        openModal('드라이런 결과', html);
      } catch (e) { openModal('드라이런 오류', '<div class="error-line">' + escapeHTML(e.message) + '</div>'); }
    };
    window.redTeamApprove = async (id) => {
      try {
        const d = await api('/admin/redteam/campaigns/' + encodeURIComponent(id) + '/approve', { method: 'POST' });
        openModal('캠페인 승인됨', '<p>캠페인이 승인되었습니다. 이제 고위험 팩도 실행할 수 있습니다.</p><p class="muted" style="font-size:12px">상태: <span class="status">' + escapeHTML(d.status || 'approved') + '</span></p>');
        await renderRedTeamView();
      } catch (e) { openModal('승인 오류', '<div class="error-line">' + escapeHTML(e.message) + '</div>'); }
    };
    window.redTeamRun = async (id, mode) => {
      try {
        let body;
        // 실제 호출은 캠페인 모드가 active-controlled일 때만, 전용 레드팀 Proxy API Key로 수행됩니다.
        // 저장된 키가 있으면 프롬프트 없이 바로 사용하고, 없을 때만 1회 입력받아 저장합니다.
        if (mode === 'active-controlled') {
          let key = (localStorage.getItem('rt_proxy_key') || '').trim();
          if (!key) {
            key = (window.prompt('실제 실행: 전용 레드팀 Proxy API Key를 입력하세요.\n(비워두고 확인하면 실제 호출 없이 시뮬레이션으로 실행됩니다)') || '').trim();
            if (key) localStorage.setItem('rt_proxy_key', key);
          }
          if (key) body = JSON.stringify({ proxy_key: key });
        }
        const runURL = '/admin/redteam/campaigns/' + encodeURIComponent(id) + '/run';
        // 즉시 피드백: 실행·조치 탭으로 이동 + "실행 중" 모달 + 진행 상황 실시간 폴링.
        rtActiveTab = 'runs';
        let polling = false, progressTimer = null;
        const pollProgress = async () => {
          if (!polling) return;
          try {
            const rr = await api('/admin/redteam/runs');
            const mine = (rr.runs || []).filter(x => x.campaign_id === id);
            const done = mine.filter(x => x.status !== 'running').length;
            const maxR = mine.reduce((m, x) => Math.max(m, Number(x.risk_score || 0)), 0);
            const failedN = mine.filter(x => x.status === 'failed').length;
            const el = document.getElementById('rt-live');
            if (el) el.innerHTML = '<div class="kpis">' + kpi('실행(run)', fmt(mine.length)) + kpi('완료', fmt(done)) + kpi('진행 중', fmt(mine.length - done)) + kpi('실패 run', fmt(failedN)) + kpi('최고 위험', fmt(maxR)) + '</div>';
          } catch (e) {}
        };
        const startPoll = () => { polling = true; pollProgress(); progressTimer = setInterval(pollProgress, 1500); };
        const stopPoll = () => { polling = false; if (progressTimer) { clearInterval(progressTimer); progressTimer = null; } };
        openModal('캠페인 실행 중…', '<p class="muted" style="font-size:12px">대상에 프로브를 실행하고 있습니다. 완료되면 요약이 표시됩니다.</p><div id="rt-live"><div class="empty">집계 중…</div></div>');
        startPoll();
        let d;
        try {
          try {
            d = await api(runURL, { method: 'POST', body });
          } catch (err) {
            // 고위험 팩은 승인 필요 — 그 자리에서 승인 후 재실행을 제안.
            if (String(err.message || '').indexOf('requires approval') >= 0) {
              stopPoll();
              if (!window.confirm('이 캠페인은 고위험 팩을 포함해 승인이 필요합니다. 지금 승인하고 실행할까요?')) { await renderRedTeamView(); return; }
              openModal('캠페인 실행 중…', '<p class="muted" style="font-size:12px">승인 후 실행 중…</p><div id="rt-live"><div class="empty">집계 중…</div></div>');
              startPoll();
              await api('/admin/redteam/campaigns/' + encodeURIComponent(id) + '/approve', { method: 'POST' });
              d = await api(runURL, { method: 'POST', body });
            } else {
              throw err;
            }
          }
        } finally {
          stopPoll();
        }
        const s = d.summary || {};
        const live = Number(s.live_calls || 0);
        const html =
          '<div class="kpis">' + kpi('실행 수', fmt(s.runs || 0)) + kpi('케이스 결과', fmt(s.results || 0)) + kpi('치명', fmt(s.critical || 0)) + kpi('실패', fmt(s.failures || 0)) + kpi('경고', fmt(s.warnings || 0)) + '</div>' +
          '<table>' +
          '<tr><th style="text-align:left">실제 upstream 호출</th><td>' + (live > 0
            ? '<span class="status error">예 — ' + fmt(live) + '건 실제 호출됨</span>'
            : '<span class="status">아니오 — 시뮬레이션 (upstream 호출 없음)</span>') + '</td></tr>' +
          '<tr><th style="text-align:left">실행 모드</th><td>' + escapeHTML(s.mode || d.status || '') + '</td></tr>' +
          '<tr><th style="text-align:left">상태</th><td>' + escapeHTML(d.status || '') + (d.stopped ? ' <span class="status warn">' + escapeHTML(d.stopped) + ' 사유로 중단</span>' : '') + '</td></tr>' +
          (live > 0 ? '<tr><th style="text-align:left">실호출 누적 비용</th><td>' + money(s.live_cost_krw || 0) + '</td></tr>' : '') +
          '</table>' +
          '<p class="muted" style="font-size:12px;margin-top:8px">' + escapeHTML(d.note || '') + '</p>' +
          ((d.runs && d.runs.length) ? '<div style="margin-top:8px"><b style="font-size:12px">실행별 결과 바로 보기</b><div style="margin-top:4px">' + d.runs.map(r => '<button type="button" class="secondary" style="font-size:11px;margin:2px" onclick="redTeamShowRunResults(\'' + escapeAttr(r.id) + '\')">' + escapeHTML(r.target_id || r.id) + ' <span class="status ' + redTeamScoreClass(r.risk_score) + '">' + fmt(r.risk_score || 0) + '</span></button>').join('') + '</div></div>' : '') +
          '<p class="muted" style="font-size:11px;margin-top:6px">각 케이스의 실제 요청/응답은 결과 목록의 <b>증적</b> 버튼에서 확인하세요.</p>';
        openModal('캠페인 실행 결과', html);
        await renderRedTeamView();
      } catch (e) { openModal('실행 오류', '<div class="error-line">' + escapeHTML(e.message) + '</div>'); }
    };
    window.redTeamKillSwitch = async (enabled) => {
      try {
        const d = await api('/admin/redteam/kill-switch', { method: 'POST', body: JSON.stringify({ enabled: !!enabled }) });
        openModal('킬 스위치', '레드팀 실행 중지 상태: <strong>' + (d.enabled ? '켜짐 (모든 실제 실행 중단)' : '꺼짐') + '</strong>');
        await renderRedTeamView();
      } catch (e) { openModal('킬 스위치 오류', '<div class="error-line">' + escapeHTML(e.message) + '</div>'); }
    };
    window.redTeamClearKey = () => {
      localStorage.removeItem('rt_proxy_key');
      renderRedTeamView();
    };
    window.redTeamQuickStart = async () => {
      try {
        // 승인 불필요한 안전 팩만 골라 드라이런 캠페인을 만들고 바로 예상 규모를 보여줍니다.
        const pk = await api('/admin/redteam/probe-packs');
        const packIds = (pk.probe_packs || []).filter(p => !p.requires_approval).map(p => p.id);
        if (packIds.length === 0) {
          openModal('빠른 시작', '<p class="muted">승인 불필요한 안전 프로브 팩이 없습니다. 캠페인 빌더에서 직접 구성해 주세요.</p>');
          return;
        }
        const body = { name: '빠른시작 드라이런', scope: 'all', execution_mode: 'dry-run', probe_pack_ids: packIds, budget_limit_krw: 1000, qps_limit: 1 };
        const c = await api('/admin/redteam/campaigns', { method: 'POST', body: JSON.stringify(body) });
        const cc = c.campaign || c;
        await renderRedTeamView();
        // 생성된 캠페인의 드라이런을 즉시 실행해 결과를 보여줍니다(실제 호출 없음).
        redTeamDryRun(cc.id);
      } catch (e) { openModal('빠른 시작 오류', '<div class="error-line">' + escapeHTML(e.message) + '</div>'); }
    };
    window.redTeamShowPackCases = async (packId) => {
      try {
        const d = await api('/admin/redteam/probe-packs');
        const pack = (d.probe_packs || []).find(p => p.id === packId);
        if (!pack) { openModal('프로브 팩', '<p class="muted">팩을 찾을 수 없습니다.</p>'); return; }
        const rows = (pack.cases || []).map(c =>
          '<tr><td><code>' + escapeHTML(c.case_key || '') + '</code>' +
          ((c.risk_tags && c.risk_tags.indexOf('ko') >= 0) ? ' <span class="status" style="font-size:9px">KR</span>' : '') + '</td>' +
          '<td><span class="status ' + redTeamRiskClass(c.severity) + '">' + escapeHTML(c.severity || '') + '</span></td>' +
          '<td>' + escapeHTML(c.expected_policy || '') + '</td>' +
          '<td class="muted" style="font-size:11px">' + escapeHTML((c.target_types || []).join(', ')) + '</td>' +
          '<td><div style="white-space:pre-wrap;font-size:12px;max-width:380px">' + escapeHTML(c.input_template || '') + '</div></td></tr>'
        ).join('') || '<tr><td colspan="5" class="muted">케이스 없음</td></tr>';
        openModal(escapeHTML(pack.name) + ' — 시드 케이스',
          '<p class="muted" style="font-size:12px">각 케이스가 대상에 보내는 <b>요청 템플릿(시드)</b>과 기대 결과입니다. 실제 공격 문구가 아닌 변수형 안전 템플릿(<code>{{...}}</code>)으로 관리되며, 실행 시 <code>[REDTEAM_SAFE_TEMPLATE]</code> 표식으로 렌더링됩니다. 실제 요청/응답은 실행 후 결과의 <b>증적</b>에서 확인하세요.</p>' +
          '<table><thead><tr><th>케이스</th><th>심각도</th><th>기대 정책</th><th>대상 유형</th><th>요청 템플릿(시드)</th></tr></thead><tbody>' + rows + '</tbody></table>',
          null, { wide: true });
      } catch (e) { openModal('케이스 오류', '<div class="error-line">' + escapeHTML(e.message) + '</div>'); }
    };
    window.redTeamShowRunResults = async (id) => {
      try {
        const d = await api('/admin/redteam/runs/' + encodeURIComponent(id) + '/results');
        const rows = (d.results || []).map(r =>
          '<tr><td><code>' + escapeHTML(r.case_id) + '</code></td><td><span class="status ' + redTeamStatusClass(r.decision) + '">' + escapeHTML(r.decision) + '</span></td>' +
          '<td><span class="status ' + redTeamRiskClass(r.severity) + '">' + escapeHTML(r.severity) + '</span></td><td>' + escapeHTML(r.policy_decision || '') + '</td>' +
          '<td><button type="button" class="secondary" style="font-size:11px" onclick="redTeamShowEvidence(\'' + escapeAttr(r.id) + '\')">증적</button> ' +
          '<button type="button" class="secondary" style="font-size:11px" onclick="redTeamCreateRemediation(\'' + escapeAttr(r.id) + '\')">조치</button></td></tr>'
        ).join('') || '<tr><td colspan="5" class="muted">결과 없음</td></tr>';
        openModal('레드팀 결과', '<table><thead><tr><th>케이스</th><th>판정</th><th>심각도</th><th>정책</th><th>작업</th></tr></thead><tbody>' + rows + '</tbody></table>');
      } catch (e) { openModal('결과 오류', '<div class="error-line">' + escapeHTML(e.message) + '</div>'); }
    };
    window.redTeamShowEvidence = async (resultID) => {
      try {
        const d = await api('/admin/redteam/results/' + encodeURIComponent(resultID) + '/evidence');
        const ev = d.evidence || d || {};
        const pre = (s) => '<pre style="white-space:pre-wrap;background:rgba(127,127,127,0.08);padding:10px;border-radius:6px;max-height:38vh;overflow:auto;font-size:12px">' + escapeHTML((s === undefined || s === null || s === '') ? '(없음)' : s) + '</pre>';
        const sec = (title, body) => '<div style="margin:10px 0"><div style="font-weight:700;font-size:12px;margin-bottom:4px">' + title + '</div>' + body + '</div>';
        const toolCalls = (ev.tool_calls && ev.tool_calls.length) ? pre(JSON.stringify(ev.tool_calls, null, 2)) : '<span class="muted" style="font-size:12px">도구 호출 없음</span>';
        const headers = ev.headers_summary ? pre(JSON.stringify(ev.headers_summary, null, 2)) : '<span class="muted" style="font-size:12px">-</span>';
        const html =
          '<p class="muted" style="font-size:12px">레드팀 프로브가 대상에 보낸 <b>요청(마스킹)</b>과 대상의 <b>응답(마스킹)</b>입니다. 원문은 저장하지 않으며 민감정보는 마스킹됩니다. 드라이런/시뮬레이션에서는 안전 템플릿 표식이 표시됩니다.</p>' +
          sec('요청 프롬프트 예시 (마스킹)', pre(ev.masked_prompt)) +
          sec('대상 응답 (마스킹)', pre(ev.masked_response)) +
          sec('도구 호출', toolCalls) +
          sec('헤더 · 메타 요약', headers) +
          (ev.export_hash ? '<div class="muted" style="font-size:11px">증적 해시: <code>' + escapeHTML(ev.export_hash) + '</code></div>' : '');
        openModal('증적 상세', html);
      } catch (e) { openModal('증적 오류', '<div class="error-line">' + escapeHTML(e.message) + '</div>'); }
    };
    window.redTeamCreateRemediation = async (resultID) => {
      try {
        const d = await api('/admin/redteam/results/' + encodeURIComponent(resultID) + '/remediation', {
          method: 'POST',
          body: JSON.stringify({ action_type: 'owner_action', action_payload: { source: 'admin_ui' } }),
        });
        const rm = d.remediation || d;
        openModal('조치 생성됨',
          '<p>이 결과에 대한 조치(remediation)가 생성되었습니다.</p>' +
          '<table><tr><th style="text-align:left">조치 유형</th><td>' + escapeHTML(rm.action_type || 'owner_action') + '</td></tr>' +
          '<tr><th style="text-align:left">상태</th><td><span class="status ' + redTeamStatusClass(rm.status) + '">' + escapeHTML(rm.status || 'open') + '</span></td></tr></table>' +
          '<p class="muted" style="font-size:12px;margin-top:8px">담당자 조치 큐와 <b>조치 보드</b>에서 진행 상태를 관리하세요.</p>');
        await renderRedTeamView();
      } catch (e) { openModal('조치 오류', '<div class="error-line">' + escapeHTML(e.message) + '</div>'); }
    };

    // AI 자산 SBOM — 스킬·워크플로·앱·모델계약·프롬프트 자산의 소유권/의존성 명세 + 거버넌스 공백.
    async function renderSBOMView() {
      const view = document.getElementById('view');
      view.innerHTML = section('AI 자산 SBOM', '<div class="empty">불러오는 중...</div>');
      let d;
      try { d = await api('/admin/sbom'); }
      catch (e) { view.innerHTML = section('AI 자산 SBOM', '<div class="card-body" style="padding:16px"><p class="muted">' + escapeHTML(e.message) + '</p></div>'); return; }
      const bt = d.by_type || {};
      const typeLabel = { skill: '스킬', workflow: '워크플로', app: '앱', model_contract: '모델 계약', prompt_asset: '프롬프트 자산' };
      const rows = (d.entries || []).map(e => '<tr' + (e.gaps && e.gaps.length ? ' class="warn-row"' : '') + '>' +
        '<td><span class="status" style="font-size:9px">' + escapeHTML(typeLabel[e.type] || e.type) + '</span></td>' +
        '<td>' + escapeHTML(e.name || e.id) + '<div class="muted" style="font-size:10px">' + escapeHTML(e.id) + '</div></td>' +
        '<td>' + (e.owner === '(미지정)' ? '<span class="status warn">미지정</span>' : escapeHTML(e.owner)) + '</td>' +
        '<td>' + escapeHTML(e.status || '') + '</td>' +
        '<td class="muted" style="font-size:11px">' + escapeHTML(e.deps || '') + '</td>' +
        '<td>' + ((e.gaps || []).map(g => '<span class="status error" style="font-size:9px">' + escapeHTML(g) + '</span>').join(' ') || '-') + '</td>' +
      '</tr>').join('') || '<tr><td colspan="6" class="muted">자산 없음</td></tr>';
      const kpis = kpi('총 자산', fmt(d.total || 0)) +
        Object.entries(bt).map(([k, n]) => kpi(typeLabel[k] || k, fmt(n))).join('') +
        kpi('거버넌스 공백', fmt(d.gap_count || 0));
      view.innerHTML = section('AI 자산 SBOM (Software Bill of Materials)',
        '<div style="padding:8px 14px"><button type="button" class="secondary" onclick="sbomExport()">JSON 내보내기</button></div>') +
        '<div class="kpis">' + kpis + '</div>' +
        card('자산 명세 (' + (d.total || 0) + ')',
          '<div class="card-body"><table><thead><tr><th>유형</th><th>이름</th><th>소유자</th><th>상태</th><th>의존성</th><th>공백</th></tr></thead><tbody>' + rows + '</tbody></table>' +
          '<p class="muted" style="font-size:10px;margin-top:6px">' + escapeHTML(d.note || '') + '</p></div>');
    }
    window.sbomExport = async () => {
      try {
        const res = await fetch('/admin/sbom', { headers: headers() });
        const blob = await res.blob();
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'ai-asset-sbom.json';
        a.click();
        URL.revokeObjectURL(a.href);
      } catch (e) { openModal('내보내기 오류', '<div class="error-line">' + escapeHTML(e.message) + '</div>'); }
    };

    // AI 업무성과 — repo별 AI 사용량 vs 개발 산출(commit/MR) 상관.
    async function renderProductivityView() {
      const view = document.getElementById('view');
      view.innerHTML = section('AI 업무성과', '<div class="empty">불러오는 중...</div>');
      let d;
      try { d = await api('/admin/productivity?days=30'); }
      catch (e) { view.innerHTML = section('AI 업무성과', '<div class="card-body" style="padding:16px"><p class="muted">' + escapeHTML(e.message) + '</p></div>'); return; }
      const t = d.totals || {};
      const rows = (d.repos || []).map(r => '<tr>' +
        '<td>' + escapeHTML(r.repo) + '</td>' +
        '<td>' + fmt(r.ai_requests || 0) + '</td>' +
        '<td>' + money(r.ai_cost_krw || 0) + '</td>' +
        '<td>' + fmt(r.commits || 0) + '</td>' +
        '<td>' + fmt(r.merge_requests || 0) + '</td>' +
        '<td>' + fmt(r.merged || 0) + '</td>' +
        '<td>' + (r.merged ? money(r.cost_per_merged_krw || 0) : '<span class="muted">-</span>') + '</td>' +
      '</tr>').join('') || '<tr><td colspan="7" class="muted">repo 귀속 데이터 없음 (X-Vibe-Repo 헤더 필요)</td></tr>';
      view.innerHTML = section('AI 업무성과 (AI 사용 ↔ 개발 산출)',
        '<p class="muted" style="font-size:12px;padding:0 14px">X-Vibe-Repo로 귀속된 AI 사용량과 VCS commit/merge_request를 repo별로 비교합니다. "얼마나 썼나"가 아니라 "무엇이 머지됐나"의 관점입니다.</p>') +
        '<div class="kpis">' + kpi('AI 요청', fmt(t.ai_requests || 0)) + kpi('AI 비용', money(t.ai_cost_krw || 0)) + kpi('머지', fmt(t.merged || 0)) + '</div>' +
        card('repo별 (최근 ' + (d.days || 30) + '일)',
          '<div class="card-body"><table><thead><tr><th>repo</th><th>AI 요청</th><th>AI 비용</th><th>commit</th><th>MR</th><th>머지</th><th>머지당 비용</th></tr></thead><tbody>' + rows + '</tbody></table>' +
          '<p class="muted" style="font-size:10px;margin-top:6px">' + escapeHTML(d.note || '') + '</p></div>');
    }

    // 프라이버시 원장 — 민감정보 탐지/마스킹/차단 + 외부 provider 전송량(감사·PIA).
    async function renderPrivacyLedgerView() {
      const view = document.getElementById('view');
      const dim = sessionStorage.getItem('privacyDim') || 'team';
      const render = async (d) => {
        const t = d.totals || {};
        const rows = (d.rows || []).map(rw => '<tr>' +
          '<td>' + escapeHTML(rw.dim_value) + '</td>' +
          '<td>' + fmt(rw.detections || 0) + '</td>' +
          '<td>' + fmt(rw.masked || 0) + '</td>' +
          '<td>' + (rw.blocked ? '<span class="status error">' + fmt(rw.blocked) + '</span>' : '0') + '</td>' +
          '<td>' + fmt(rw.egress_requests || 0) + '</td>' +
          '<td>' + fmt(rw.egress_tokens || 0) + '</td>' +
        '</tr>').join('') || '<tr><td colspan="6" class="muted">데이터 없음</td></tr>';
        return '<div class="kpis">' + kpi('탐지', fmt(t.detections || 0)) + kpi('마스킹', fmt(t.masked || 0)) + kpi('차단', fmt(t.blocked || 0)) + kpi('전송 요청', fmt(t.egress_requests || 0)) + kpi('전송 토큰', fmt(t.egress_tokens || 0)) + '</div>' +
          card('프라이버시 원장 (최근 ' + (d.days || 30) + '일, ' + escapeHTML(d.dimension) + ')',
            '<div class="card-body"><table><thead><tr><th>' + escapeHTML(d.dimension) + '</th><th>탐지</th><th>마스킹</th><th>차단</th><th>전송 요청</th><th>전송 토큰</th></tr></thead><tbody>' + rows + '</tbody></table>' +
            '<p class="muted" style="font-size:10px;margin-top:6px">' + escapeHTML(d.note || '') + '</p></div>');
      };
      const load = async (dimension) => {
        sessionStorage.setItem('privacyDim', dimension);
        const host = document.getElementById('pl-results');
        host.innerHTML = '<div class="empty">불러오는 중...</div>';
        try { host.innerHTML = await render(await api('/admin/privacy-ledger?dimension=' + dimension + '&days=30')); }
        catch (e) { host.innerHTML = '<span class="status error">' + escapeHTML(e.message) + '</span>'; }
      };
      view.innerHTML = section('프라이버시 원장 (Data Egress Ledger)',
        '<div class="toolbar"><label class="muted">차원 <select id="pl-dim">' +
        ['team', 'model', 'provider'].map(x => '<option value="' + x + '"' + (x === dim ? ' selected' : '') + '>' + x + '</option>').join('') +
        '</select></label><button type="button" class="secondary" id="pl-csv">CSV 내보내기</button></div>') +
        '<div id="pl-results"></div>';
      document.getElementById('pl-dim').addEventListener('change', (e) => load(e.target.value));
      document.getElementById('pl-csv').addEventListener('click', async () => {
        const dimension = document.getElementById('pl-dim').value;
        try {
          const res = await fetch('/admin/privacy-ledger?dimension=' + dimension + '&days=30&format=csv', { headers: headers() });
          const blob = await res.blob();
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = 'privacy-ledger-' + dimension + '.csv';
          a.click();
          URL.revokeObjectURL(a.href);
        } catch (e) { openModal('내보내기 오류', '<div class="error-line">' + escapeHTML(e.message) + '</div>'); }
      });
      await load(dim);
    }

    // 파드 운영 맵 — 멀티 파드 하트비트·빌드·런타임 설정 수렴 상태.
    async function renderPodsView() {
      const view = document.getElementById('view');
      view.innerHTML = section('파드 운영 맵', '<div class="empty">불러오는 중...</div>');
      let d;
      try { d = await api('/admin/pods'); }
      catch (e) { view.innerHTML = section('파드 운영 맵', '<div class="card-body" style="padding:16px"><p class="muted">' + escapeHTML(e.message) + '</p></div>'); return; }
      const sm = d.summary || {};
      const rows = (d.pods || []).map(p => '<tr>' +
        '<td>' + (p.stale ? '<span class="status error">stale</span>' : '<span class="status">live</span>') + '</td>' +
        '<td><code>' + escapeHTML(p.hostname) + '</code></td>' +
        '<td>' + escapeHTML(p.build_version || '') + '</td>' +
        '<td>' + (p.up_to_date ? '<span class="status">최신</span>' : '<span class="status warn">동기화 대기</span>') + '</td>' +
        '<td class="muted" style="font-size:11px">' + ago(p.last_seen) + '</td>' +
        '<td class="muted" style="font-size:11px">' + (p.reload_interval_s ? (p.reload_interval_s + 's') : 'off') + '</td>' +
      '</tr>').join('') || '<tr><td colspan="6" class="muted">기록된 파드 없음</td></tr>';
      view.innerHTML = section('파드 운영 맵 (멀티 파드)',
        '<div style="padding:8px 14px"><button type="button" class="secondary" onclick="renderPodsView()">새로고침</button></div>') +
        '<div class="kpis">' + kpi('총 파드', fmt(sm.total || 0)) + kpi('live', fmt(sm.live || 0)) + kpi('stale', fmt(sm.stale || 0)) + kpi('설정 최신', fmt(sm.converged || 0)) + '</div>' +
        card('파드 (' + (sm.total || 0) + ')',
          '<div class="card-body"><table><thead><tr><th>상태</th><th>hostname</th><th>빌드</th><th>설정</th><th>마지막 하트비트</th><th>reload</th></tr></thead><tbody>' + rows + '</tbody></table>' +
          '<p class="muted" style="font-size:10px;margin-top:6px">' + escapeHTML(d.note || '') + '</p></div>');
    }

    // Journey Probe — 개발도구별 합성 연결 점검(모델 목록·MCP). probe key로 실행.
    async function renderJourneyProbeView() {
      const view = document.getElementById('view');
      view.innerHTML = section('Journey Probe (개발도구 연결 합성 점검)',
        '<div style="padding:8px 14px">' +
        '<p class="muted" style="font-size:12px">Proxy API Key를 입력하면 Cursor·Roo·Cline 등 각 개발도구가 실제로 수행하는 연결 journey(모델 목록·MCP initialize/tools-list)를 합성 점검합니다. 실제 chat 호출(비용)은 하지 않습니다.</p>' +
        '<div class="toolbar"><input id="jp-key" type="password" placeholder="Proxy API Key (vc_sk_...)" style="min-width:320px">' +
        '<button type="button" id="jp-run">점검 실행</button></div>' +
        '<div id="jp-results" style="margin-top:10px"></div></div>');
      document.getElementById('jp-run').addEventListener('click', async () => {
        const key = document.getElementById('jp-key').value.trim();
        const host = document.getElementById('jp-results');
        if (!key) { host.innerHTML = '<span class="status warn">Proxy API Key를 입력하세요.</span>'; return; }
        host.innerHTML = '<div class="empty">점검 중...</div>';
        try {
          const d = await api('/admin/journey-probe', { method: 'POST', body: JSON.stringify({ proxy_key: key }) });
          const sm = d.summary || {};
          const scls = (s) => s === 'fail' ? 'error' : (s === 'warn' ? 'warn' : '');
          const cards = (d.results || []).map(rs => {
            const steps = (rs.checks || []).map(c => '<div style="font-size:11px;margin:2px 0"><span class="status ' + scls(c.status) + '" style="font-size:9px">' + escapeHTML(c.status) + '</span> ' + escapeHTML(c.name) + ' — ' + escapeHTML(c.detail) + (c.fix ? ' <span class="muted">(' + escapeHTML(c.fix) + ')</span>' : '') + '</div>').join('');
            return '<div style="border:1px solid var(--border);border-radius:6px;padding:8px;margin:6px 0">' +
              '<strong>' + escapeHTML(rs.client) + '</strong> <span class="status ' + scls(rs.overall) + '">' + escapeHTML(rs.overall) + '</span>' + steps + '</div>';
          }).join('');
          host.innerHTML = '<div style="margin-bottom:6px"><span class="status">' + (sm.passing || 0) + ' 정상</span> ' +
            (sm.failing ? '<span class="status error">' + sm.failing + ' 실패</span>' : '') + ' / ' + (sm.clients || 0) + ' 도구</div>' +
            cards + '<p class="muted" style="font-size:10px;margin-top:4px">' + escapeHTML(d.note || '') + '</p>';
        } catch (e) { host.innerHTML = '<span class="status error">' + escapeHTML(e.message) + '</span>'; }
      });
    }

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
    // teamLabel renders a key's stored team identifier as its friendly auth-team name (with the
    // raw id as small sub-text); falls back to the raw value for free-form teams with no match.
    function teamLabel(team, names) {
      if (!team) return '';
      const nm = names && names[team];
      return nm
        ? escapeHTML(nm) + '<div class="muted" style="font-size:11px">' + escapeHTML(team) + '</div>'
        : escapeHTML(team);
    }
    // ── 프롬프트 자산 관리소 ──────────────────────────────────────────────
    async function renderPromptAssets(initial) {
      const statusFilter   = (initial && initial.get('status'))   || '';
      const tagFilter      = (initial && initial.get('tag'))      || '';
      const categoryFilter = (initial && initial.get('category')) || '';
      const q              = (initial && initial.get('q'))        || '';

      const qs = new URLSearchParams();
      if (statusFilter)   qs.set('status',   statusFilter);
      if (tagFilter)      qs.set('tag',      tagFilter);
      if (categoryFilter) qs.set('category', categoryFilter);
      if (q)              qs.set('q',        q);

      const d = await api('/admin/prompt-assets' + (qs.toString() ? '?' + qs.toString() : ''));
      const assets      = d.assets    || [];
      const stats       = d.stats     || {};
      const knownTags   = d.known_tags || [];
      const categories  = d.categories || [];

      const total = Object.values(stats).reduce((s, v) => s + Number(v), 0);
      const kpis = '<div class="kpis">' +
        kpi('전체 자산', fmt(total)) +
        kpi('조직 표준', fmt(stats.standard || 0), 'status') +
        kpi('승인됨', fmt(stats.approved || 0)) +
        kpi('검토 대기', fmt(stats.pending || 0)) +
        kpi('초안', fmt(stats.draft || 0)) +
      '</div>';

      // Status badge helper
      function statusBadge(st) {
        const map = { standard: ['status', '표준'], approved: ['', '승인'], pending: ['warn', '검토중'], draft: ['muted', '초안'] };
        const [cls, label] = map[st] || ['muted', st || 'draft'];
        return '<span class="status ' + cls + '">' + label + '</span>';
      }

      // Filter bar
      const filterBar =
        '<form class="toolbar" id="pa-filter" autocomplete="off">' +
          '<input id="pa-q" placeholder="검색 (이름·설명)" value="' + escapeHTML(q) + '" style="min-width:160px">' +
          '<select id="pa-status">' +
            '<option value="">전체 상태</option>' +
            ['draft','pending','approved','standard'].map(s => '<option value="' + s + '" ' + (statusFilter===s?'selected':'') + '>' + ({'draft':'초안','pending':'검토중','approved':'승인','standard':'조직표준'}[s]) + '</option>').join('') +
          '</select>' +
          '<select id="pa-category">' +
            '<option value="">전체 카테고리</option>' +
            categories.map(c => '<option value="' + escapeHTML(c.key) + '" ' + (categoryFilter===c.key?'selected':'') + '>' + escapeHTML(c.label) + '</option>').join('') +
          '</select>' +
          '<select id="pa-tag">' +
            '<option value="">전체 태그</option>' +
            knownTags.map(t => '<option value="' + escapeHTML(t.key) + '" ' + (tagFilter===t.key?'selected':'') + '>' + escapeHTML(t.label) + '</option>').join('') +
          '</select>' +
          '<button type="submit">적용</button>' +
          '<button type="button" class="secondary" onclick="openAddAssetModal()">+ 새 자산</button>' +
          '<button type="button" class="secondary" onclick="openAssetCompare()">A/B 비교</button>' +
        '</form>';

      // Asset table
      const tableRows = assets.length ? assets.map(a =>
        '<tr onclick="openAssetDetail(\'' + escapeAttr(a.id) + '\')" style="cursor:pointer">' +
        '<td><strong>' + escapeHTML(a.name) + '</strong><div class="muted" style="font-size:11px">' + escapeHTML(a.category) + ' · ' + escapeHTML(a.id) + '</div></td>' +
        '<td>' + (a.tags||[]).map(t => '<span class="pill">' + escapeHTML(t) + '</span>').join(' ') + '</td>' +
        '<td>' + statusBadge(a.status) + '</td>' +
        '<td data-num="' + (a.use_count||0) + '">' + fmt(a.use_count||0) + '</td>' +
        '<td data-num="' + (a.call_count||0) + '">' + fmt(a.call_count||0) + '<div class="muted" style="font-size:10px">90일</div></td>' +
        '<td data-num="' + ((a.success_rate||0)*100).toFixed(0) + '">' + (a.call_count ? ((a.success_rate||0)*100).toFixed(1)+'%' : '<span class="muted">-</span>') + '</td>' +
        '<td data-num="' + (a.avg_cost_krw||0) + '">' + (a.call_count ? '₩'+Number(a.avg_cost_krw||0).toFixed(1) : '<span class="muted">-</span>') + '</td>' +
        '<td data-num="' + (a.avg_latency_ms||0) + '">' + (a.call_count ? fmt(Math.round(a.avg_latency_ms||0))+'ms' : '<span class="muted">-</span>') + '</td>' +
        '<td>' + (a.approved_by ? escapeHTML(a.approved_by) + '<div class="muted" style="font-size:10px">' + ago(a.approved_at) + '</div>' : '<span class="muted">-</span>') + '</td>' +
        '<td onclick="event.stopPropagation()">' +
          (a.status === 'draft'    ? '<button class="secondary" type="button" style="font-size:11px" onclick="submitAsset(\'' + escapeAttr(a.id) + '\')">검토 제출</button> ' : '') +
          (a.status === 'pending'  ? '<button class="secondary" type="button" style="font-size:11px" onclick="approveAsset(\'' + escapeAttr(a.id) + '\',\'approved\')">승인</button> ' : '') +
          (a.status === 'approved' ? '<button class="secondary" type="button" style="font-size:11px" onclick="approveAsset(\'' + escapeAttr(a.id) + '\',\'standard\')">표준 승격</button> ' : '') +
          ((a.status === 'pending' || a.status === 'approved' || a.status === 'standard')
            ? '<button class="secondary" type="button" style="font-size:11px" onclick="approveAsset(\'' + escapeAttr(a.id) + '\',\'draft\')">반려</button> ' : '') +
          '<button class="danger" type="button" style="font-size:11px" onclick="deleteAsset(\'' + escapeAttr(a.id) + '\')">삭제</button>' +
        '</td>' +
        '</tr>'
      ).join('') : '<tr><td colspan="10"><div class="empty">자산이 없습니다. "+ 새 자산" 버튼으로 등록하세요.</div></td></tr>';

      const assetTable =
        '<table id="pa-table">' +
          '<thead><tr>' +
            '<th data-sort="str">이름</th>' +
            '<th>태그</th>' +
            '<th data-sort="str">상태</th>' +
            '<th data-sort="num">재사용</th>' +
            '<th data-sort="num">호출수</th>' +
            '<th data-sort="num">성공률</th>' +
            '<th data-sort="num">평균비용</th>' +
            '<th data-sort="num">평균지연</th>' +
            '<th data-sort="str">승인자</th>' +
            '<th>액션</th>' +
          '</tr></thead>' +
          '<tbody>' + tableRows + '</tbody>' +
        '</table>';

      document.getElementById('view').innerHTML =
        section('프롬프트 자산 관리소', kpis + filterBar) +
        section('자산 목록', assetTable);

      makeSortable('#pa-table', 'prompt-assets');

      document.getElementById('pa-filter').addEventListener('submit', e => {
        e.preventDefault();
        const p = new URLSearchParams();
        const qv = document.getElementById('pa-q').value.trim();
        const sv = document.getElementById('pa-status').value;
        const cv = document.getElementById('pa-category').value;
        const tv = document.getElementById('pa-tag').value;
        if (qv) p.set('q', qv);
        if (sv) p.set('status', sv);
        if (cv) p.set('category', cv);
        if (tv) p.set('tag', tv);
        location.hash = '#/prompt-assets' + (p.toString() ? '?' + p.toString() : '');
        route();
      });
    }

    window.openAddAssetModal = () => {
      const catOptions = [
        {key:'refactor',label:'리팩터링'},{key:'test',label:'테스트 생성'},{key:'security',label:'보안 점검'},
        {key:'docs',label:'문서화'},{key:'review',label:'코드 리뷰'},{key:'custom',label:'기타'},
      ];
      const tagPreset = ['java','go','python','javascript','typescript','sql','rust','security','test','docs','refactor','review','policy','legal','compliance','general'];
      openModal('새 프롬프트 자산 등록',
        '<form id="pa-add-form" autocomplete="off">' +
          '<div class="kv">' +
            row('이름 *', '<input id="pa-add-name" placeholder="예: Java 코드 리뷰 표준" style="width:100%">') +
            row('ID (slug)', '<input id="pa-add-id" placeholder="자동 생성 (비워두면 이름에서 생성)" style="width:100%">') +
            row('카테고리', '<select id="pa-add-cat">' + catOptions.map(c=>'<option value="'+c.key+'">'+c.label+'</option>').join('') + '</select>') +
            row('태그', '<input id="pa-add-tags" placeholder="쉼표 구분: java, security, review" style="width:100%"><div class="muted" style="font-size:11px;margin-top:4px">추천: ' + tagPreset.map(t=>'<span class="pill" style="cursor:pointer" onclick="addTagToInput(\''+t+'\')">'+t+'</span>').join(' ') + '</div>') +
            row('설명', '<input id="pa-add-desc" placeholder="한 줄 설명" style="width:100%">') +
            row('프롬프트 본문 *', '<textarea id="pa-add-body" style="width:100%;min-height:200px;resize:vertical" placeholder="프롬프트 내용을 입력하세요..."></textarea>') +
            row('초안으로 저장', '<label><input type="checkbox" id="pa-add-draft" checked style="width:auto"> 저장 후 검토 제출 필요</label>') +
          '</div>' +
          '<div style="margin-top:12px;display:flex;gap:8px">' +
            '<button type="submit" id="pa-add-btn">저장</button>' +
            '<button type="button" class="secondary" onclick="closeModal()">취소</button>' +
          '</div>' +
        '</form>'
      );
      document.getElementById('pa-add-form').addEventListener('submit', async e => {
        e.preventDefault();
        const btn = document.getElementById('pa-add-btn');
        btn.disabled = true; btn.textContent = '저장 중...';
        const tags = (document.getElementById('pa-add-tags').value||'').split(',').map(t=>t.trim()).filter(Boolean);
        const isDraft = document.getElementById('pa-add-draft').checked;
        try {
          const body = {
            id: document.getElementById('pa-add-id').value.trim(),
            name: document.getElementById('pa-add-name').value.trim(),
            category: document.getElementById('pa-add-cat').value,
            description: document.getElementById('pa-add-desc').value.trim(),
            body: document.getElementById('pa-add-body').value.trim(),
            tags,
            status: isDraft ? 'draft' : 'pending',
            enabled: true,
          };
          if (!body.name || !body.body) { alert('이름과 본문은 필수입니다.'); btn.disabled=false; btn.textContent='저장'; return; }
          await api('/admin/templates', { method: 'POST', body: JSON.stringify(body) });
          closeModal();
          route();
        } catch(err) {
          alert('오류: ' + err.message);
          btn.disabled=false; btn.textContent='저장';
        }
      });
    };

    window.addTagToInput = (tag) => {
      const el = document.getElementById('pa-add-tags');
      if (!el) return;
      const existing = el.value.split(',').map(t=>t.trim()).filter(Boolean);
      if (!existing.includes(tag)) { el.value = [...existing, tag].join(', '); }
    };

    window.openAssetDetail = async (id) => {
      openModal('자산 상세 — ' + id, '<div class="empty">불러오는 중...</div>');
      try {
        const [resp, histResp, usageResp] = await Promise.all([
          api('/admin/prompt-assets?q=' + encodeURIComponent(id)),
          api('/admin/templates/' + encodeURIComponent(id) + '/history').catch(() => ({ history: [] })),
          api('/admin/templates/' + encodeURIComponent(id) + '/usage').catch(() => ({ usage: [] })),
        ]);
        const a = (resp.assets || []).find(x => x.id === id) || {};
        const history = histResp.history || [];
        const usage = usageResp.usage || [];
        window.__assetHistory = history; // for diff lookup
        const tagPreset = ['java','go','python','javascript','typescript','sql','rust','security','test','docs','refactor','review','policy','legal','compliance','general'];
        const catOptions = [
          {key:'refactor',label:'리팩터링'},{key:'test',label:'테스트 생성'},{key:'security',label:'보안 점검'},
          {key:'docs',label:'문서화'},{key:'review',label:'코드 리뷰'},{key:'custom',label:'기타'},
        ];
        function statusBadge(st) {
          const map = {standard:['status','표준'],approved:['','승인'],pending:['warn','검토중'],draft:['muted','초안']};
          const [cls, label] = map[st] || ['muted', st||'draft'];
          return '<span class="status '+cls+'">'+label+'</span>';
        }
        const metricsBlock = a.call_count ? (
          '<div class="kpis" style="margin:0 0 12px">' +
          kpi('호출수 (90일)', fmt(a.call_count||0)) +
          kpi('성공률', ((a.success_rate||0)*100).toFixed(1)+'%') +
          kpi('평균비용', '₩'+Number(a.avg_cost_krw||0).toFixed(2)) +
          kpi('평균지연', fmt(Math.round(a.avg_latency_ms||0))+'ms') +
          '</div>'
        ) : '<div class="muted" style="margin-bottom:12px;font-size:12px">아직 수집된 성과 지표가 없습니다 (90일 내 요청 없음).</div>';
        // 사용처 역추적: per-team usage breakdown
        const usageBlock = usage.length ? (
          '<h4 style="margin:14px 0 6px">사용처 (팀별 · 90일)</h4>' +
          '<table style="width:100%"><thead><tr><th>팀</th><th>호출수</th><th>오류</th><th>비용</th></tr></thead><tbody>' +
          usage.map(u =>
            '<tr><td>' + escapeHTML(u.team) + '</td>' +
            '<td>' + fmt(u.calls||0) + '</td>' +
            '<td>' + (u.errors ? '<span class="status warn">'+fmt(u.errors)+'</span>' : '0') + '</td>' +
            '<td>₩' + Number(u.cost_krw||0).toFixed(1) + '</td></tr>'
          ).join('') +
          '</tbody></table>'
        ) : '';

        // 버전 이력 (스냅샷이 있는 항목만) — diff + rollback
        const versions = history.filter(h => h.has_snapshot);
        const actionLabel = { create:'생성', edit:'편집', rollback:'롤백', submit:'검토제출', approve:'승인', promote:'표준승격', reject:'반려' };
        const versionBlock = versions.length ? (
          '<h4 style="margin:14px 0 6px">버전 이력</h4>' +
          '<table style="width:100%"><thead><tr><th>버전</th><th>작업</th><th>작성자</th><th>시각</th><th>비교/복원</th></tr></thead><tbody>' +
          versions.map((v, i) => {
            const prev = versions[i+1]; // older
            const canDiff = !!prev;
            return '<tr><td><strong>v' + v.version_num + '</strong></td>' +
              '<td>' + (actionLabel[v.action]||v.action) + (v.note ? ' <span class="muted">('+escapeHTML(v.note)+')</span>' : '') + '</td>' +
              '<td>' + escapeHTML(v.actor||'-') + '</td>' +
              '<td class="muted">' + ago(v.created_at) + '</td>' +
              '<td>' +
                (canDiff ? '<button class="secondary" type="button" style="font-size:11px" onclick="diffAssetVersion('+v.version_num+','+prev.version_num+')">diff</button> ' : '') +
                (i!==0 ? '<button class="secondary" type="button" style="font-size:11px" onclick="rollbackAsset(\''+escapeAttr(id)+'\','+v.version_num+')">이 버전으로 복원</button>' : '<span class="muted" style="font-size:11px">현재</span>') +
              '</td></tr>';
          }).join('') +
          '</tbody></table>' +
          '<div id="pa-diff" style="margin-top:8px"></div>'
        ) : '';

        // 변경 감사 푸터 — 모든 이력 (상태 이벤트 포함) 시간순
        const auditBlock = history.length ? (
          '<h4 style="margin:14px 0 6px">변경 이력</h4>' +
          '<div style="border-left:2px solid var(--border);padding-left:10px">' +
          history.map(h => {
            const transition = (h.from_status || h.to_status) ? ' <span class="muted">'+escapeHTML(h.from_status||'-')+' → '+escapeHTML(h.to_status||'-')+'</span>' : '';
            return '<div style="margin-bottom:6px;font-size:12px">' +
              '<strong>' + (actionLabel[h.action]||h.action) + '</strong>' +
              (h.has_snapshot ? ' <span class="pill">v'+h.version_num+'</span>' : '') +
              transition +
              (h.note ? ' — ' + escapeHTML(h.note) : '') +
              '<div class="muted" style="font-size:11px">' + escapeHTML(h.actor||'system') + ' · ' + ago(h.created_at) + '</div>' +
            '</div>';
          }).join('') +
          '</div>'
        ) : '';

        openModal('자산 상세 — ' + escapeHTML(a.name || id),
          metricsBlock +
          '<div class="kv">' +
            row('상태', statusBadge(a.status)) +
            row('카테고리', escapeHTML(a.category||'')) +
            row('태그', (a.tags||[]).map(t=>'<span class="pill">'+escapeHTML(t)+'</span>').join(' ')||'<span class="muted">없음</span>') +
            row('재사용 횟수', fmt(a.use_count||0)) +
            row('승인자', escapeHTML(a.approved_by||'-')) +
            row('승인 시각', a.approved_at ? ago(a.approved_at) : '-') +
            row('노트', escapeHTML(a.note||'-')) +
            row('생성', ago(a.created_at)) +
            row('수정', ago(a.updated_at)) +
          '</div>' +
          usageBlock +
          versionBlock +
          auditBlock +
          '<h4 style="margin:12px 0 6px">편집</h4>' +
          '<div class="kv">' +
            row('이름', '<input id="pa-edit-name" value="' + escapeAttr(a.name||'') + '" style="width:100%">') +
            row('카테고리', '<select id="pa-edit-cat">' + catOptions.map(c=>'<option value="'+c.key+'"'+(a.category===c.key?' selected':'')+'>'+c.label+'</option>').join('') + '</select>') +
            row('태그', '<input id="pa-edit-tags" value="' + escapeAttr((a.tags||[]).join(', ')) + '" style="width:100%"><div class="muted" style="font-size:11px;margin-top:4px">추천: ' + tagPreset.map(t=>'<span class="pill" style="cursor:pointer" onclick="addTagToEditInput(\''+t+'\')">'+t+'</span>').join(' ') + '</div>') +
            row('설명', '<input id="pa-edit-desc" value="' + escapeAttr(a.description||'') + '" style="width:100%">') +
            row('본문', '<textarea id="pa-edit-body" style="width:100%;min-height:160px;resize:vertical">' + escapeHTML(a.body||'') + '</textarea>') +
            row('노트', '<input id="pa-edit-note" value="' + escapeAttr(a.note||'') + '" style="width:100%">') +
          '</div>' +
          '<div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">' +
            '<button type="button" onclick="saveAssetEdit(\'' + escapeAttr(id) + '\')">저장</button>' +
            (a.status==='draft' ? '<button type="button" class="secondary" onclick="submitAsset(\''+escapeAttr(id)+'\')">검토 제출</button>' : '') +
            (a.status==='pending' ? '<button type="button" class="secondary" onclick="approveAsset(\''+escapeAttr(id)+'\',\'approved\')">승인</button>' : '') +
            (a.status==='approved' ? '<button type="button" class="secondary" onclick="approveAsset(\''+escapeAttr(id)+'\',\'standard\')">표준 승격</button>' : '') +
            ((a.status==='pending'||a.status==='approved'||a.status==='standard') ? '<button type="button" class="secondary" onclick="approveAsset(\''+escapeAttr(id)+'\',\'draft\')">반려</button>' : '') +
            '<button type="button" class="secondary" onclick="closeModal()">닫기</button>' +
          '</div>'
        );
      } catch(err) {
        openModal('자산 상세 오류', '<div class="error-line">' + escapeHTML(err.message) + '</div>');
      }
    };

    window.addTagToEditInput = (tag) => {
      const el = document.getElementById('pa-edit-tags');
      if (!el) return;
      const existing = el.value.split(',').map(t=>t.trim()).filter(Boolean);
      if (!existing.includes(tag)) { el.value = [...existing, tag].join(', '); }
    };

    window.saveAssetEdit = async (id) => {
      try {
        const tags = (document.getElementById('pa-edit-tags').value||'').split(',').map(t=>t.trim()).filter(Boolean);
        await api('/admin/templates/' + encodeURIComponent(id), {
          method: 'PATCH',
          body: JSON.stringify({
            name: document.getElementById('pa-edit-name').value.trim(),
            category: document.getElementById('pa-edit-cat').value,
            description: document.getElementById('pa-edit-desc').value.trim(),
            body: document.getElementById('pa-edit-body').value.trim(),
            tags,
            note: document.getElementById('pa-edit-note').value.trim(),
          }),
        });
        closeModal();
        route();
      } catch(err) { alert('저장 오류: ' + err.message); }
    };

    window.submitAsset = async (id) => {
      try {
        await api('/admin/templates/' + encodeURIComponent(id) + '/submit', { method: 'POST', body: '{}' });
        route();
      } catch(err) { alert('제출 오류: ' + err.message); }
    };

    window.approveAsset = async (id, status) => {
      const labels = { approved: '승인', standard: '조직 표준으로 승격', draft: '반려 (초안으로 되돌리기)' };
      const note = prompt((labels[status] || status) + ' 메모 (선택):', '');
      if (note === null) return;
      try {
        await api('/admin/templates/' + encodeURIComponent(id) + '/approve', {
          method: 'POST',
          body: JSON.stringify({ status, note }),
        });
        closeModal();
        route();
      } catch(err) { alert('처리 오류: ' + err.message); }
    };

    window.deleteAsset = async (id) => {
      if (!confirm('"' + id + '" 자산을 삭제하시겠습니까? 되돌릴 수 없습니다.')) return;
      try {
        await api('/admin/templates/' + encodeURIComponent(id), { method: 'DELETE' });
        route();
      } catch(err) { alert('삭제 오류: ' + err.message); }
    };

    // Simple line-based diff between two snapshot versions, rendered into #pa-diff.
    window.diffAssetVersion = (newer, older) => {
      const hist = window.__assetHistory || [];
      const nv = hist.find(h => h.has_snapshot && h.version_num === newer);
      const ov = hist.find(h => h.has_snapshot && h.version_num === older);
      const el = document.getElementById('pa-diff');
      if (!el || !nv || !ov) return;
      const oldLines = (ov.body||'').split('\n');
      const newLines = (nv.body||'').split('\n');
      const oldSet = new Set(oldLines);
      const newSet = new Set(newLines);
      const rows = [];
      const max = Math.max(oldLines.length, newLines.length);
      for (let i = 0; i < max; i++) {
        const o = oldLines[i], n = newLines[i];
        if (o !== undefined && !newSet.has(o)) rows.push('<div style="background:rgba(220,38,38,0.12);color:#b91c1c">- ' + escapeHTML(o) + '</div>');
        if (n !== undefined && !oldSet.has(n)) rows.push('<div style="background:rgba(5,150,105,0.12);color:#047857">+ ' + escapeHTML(n) + '</div>');
      }
      el.innerHTML = '<div style="font-weight:600;margin-bottom:4px">v' + older + ' → v' + newer + ' diff</div>' +
        '<pre style="font-size:11px;white-space:pre-wrap;border:1px solid var(--border);border-radius:6px;padding:8px;max-height:240px;overflow:auto">' +
        (rows.length ? rows.join('') : '<span class="muted">본문 변경 없음</span>') + '</pre>';
    };

    // A/B 성과 비교: pick two assets, show success rate / cost / latency side-by-side.
    window.openAssetCompare = async () => {
      openModal('A/B 성과 비교', '<div class="empty">불러오는 중...</div>');
      const resp = await api('/admin/prompt-assets');
      const assets = (resp.assets || []).slice().sort((x,y)=> (x.name||'').localeCompare(y.name||''));
      if (assets.length < 2) { openModal('A/B 성과 비교', '<div class="empty">비교하려면 자산이 2개 이상 필요합니다.</div>'); return; }
      const opts = assets.map(a => '<option value="'+escapeAttr(a.id)+'">'+escapeHTML(a.name)+' ('+a.status+')</option>').join('');
      openModal('A/B 성과 비교',
        '<div class="toolbar">' +
          '<select id="pa-cmp-a">' + opts + '</select>' +
          '<span style="font-weight:600">vs</span>' +
          '<select id="pa-cmp-b">' + opts + '</select>' +
          '<button type="button" onclick="renderAssetCompare()">비교</button>' +
        '</div>' +
        '<div id="pa-cmp-result" style="margin-top:12px"></div>'
      );
      window.__cmpAssets = assets;
      if (assets[1]) document.getElementById('pa-cmp-b').selectedIndex = 1;
      renderAssetCompare();
    };

    window.renderAssetCompare = () => {
      const assets = window.__cmpAssets || [];
      const aId = document.getElementById('pa-cmp-a').value;
      const bId = document.getElementById('pa-cmp-b').value;
      const a = assets.find(x => x.id === aId) || {};
      const b = assets.find(x => x.id === bId) || {};
      const el = document.getElementById('pa-cmp-result');
      function cell(v, other, fmtFn, higherBetter) {
        const better = (v!=null && other!=null && v!==other) ? ((higherBetter ? v>other : v<other) ? ' style="font-weight:700;color:#047857"' : '') : '';
        return '<td'+better+'>' + fmtFn(v) + '</td>';
      }
      const pct = v => v!=null ? (v*100).toFixed(1)+'%' : '-';
      const won = v => v!=null ? '₩'+Number(v).toFixed(2) : '-';
      const ms  = v => v!=null ? fmt(Math.round(v))+'ms' : '-';
      const num = v => fmt(v||0);
      el.innerHTML =
        '<table style="width:100%"><thead><tr><th>지표</th><th>' + escapeHTML(a.name||'A') + '</th><th>' + escapeHTML(b.name||'B') + '</th></tr></thead><tbody>' +
        '<tr><td>호출수 (90일)</td>' + cell(a.call_count, b.call_count, num, true) + cell(b.call_count, a.call_count, num, true) + '</tr>' +
        '<tr><td>성공률</td>' + cell(a.success_rate, b.success_rate, pct, true) + cell(b.success_rate, a.success_rate, pct, true) + '</tr>' +
        '<tr><td>평균비용</td>' + cell(a.avg_cost_krw, b.avg_cost_krw, won, false) + cell(b.avg_cost_krw, a.avg_cost_krw, won, false) + '</tr>' +
        '<tr><td>평균지연</td>' + cell(a.avg_latency_ms, b.avg_latency_ms, ms, false) + cell(b.avg_latency_ms, a.avg_latency_ms, ms, false) + '</tr>' +
        '<tr><td>재사용 횟수</td>' + cell(a.use_count, b.use_count, num, true) + cell(b.use_count, a.use_count, num, true) + '</tr>' +
        '<tr><td>상태</td><td>'+escapeHTML(a.status||'-')+'</td><td>'+escapeHTML(b.status||'-')+'</td></tr>' +
        '</tbody></table>' +
        '<div class="muted" style="font-size:11px;margin-top:6px">굵게 표시된 값이 해당 지표에서 우세합니다. (성공률·호출·재사용 ↑ / 비용·지연 ↓)</div>';
    };

    window.rollbackAsset = async (id, version) => {
      if (!confirm('v' + version + ' 본문으로 복원하시겠습니까? 현재 본문은 새 버전으로 기록됩니다.')) return;
      try {
        await api('/admin/templates/' + encodeURIComponent(id) + '/rollback', {
          method: 'POST',
          body: JSON.stringify({ version }),
        });
        openAssetDetail(id);
      } catch(err) { alert('복원 오류: ' + err.message); }
    };
    // ── 프롬프트 자산 관리소 끝 ──────────────────────────────────────────

    async function renderUsers() {
      const [r, prod] = await Promise.all([
        api('/admin/users'),
        api('/admin/benchmark/users?window=30d&limit=50').catch(() => ({ users: [] })),
      ]);
      const rows = r.users || [];
      const prodRows = prod.users || [];
      const teamNames = r.team_names || {};
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
              '<td>' + (u.team ? '<a href="#/teams/' + encodeURIComponent(u.team) + '" onclick="event.stopPropagation()">' + teamLabel(u.team, teamNames) + '</a>' : '') + '</td>' +
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
      ) + section('AI 활용지수 (최근 30일)', productivityTable(prodRows, teamNames));
      document.getElementById('view').innerHTML = html;
      makeSortable('#view', 'users');
    }
    function productivityTable(rows, names) {
      if (!rows.length) return '<div class="empty">활동 데이터 없음 (chat 호출이 쌓이면 표시됩니다)</div>';
      const scoreBadge = (s) => '<span class="status ' + (s >= 70 ? '' : (s >= 40 ? 'warn' : 'error')) + '">' + fmt(s) + '점</span>';
      return '<table><thead><tr>' +
        '<th data-sort="str">사용자</th><th data-sort="str">팀</th><th data-sort="num">Prompt</th><th data-sort="num">세션</th><th data-sort="num">활동일</th>' +
        '<th data-sort="num">커밋</th><th data-sort="num">머지 MR</th><th data-sort="num">도구 호출</th><th data-sort="num">성공률</th><th data-sort="num">비용</th><th data-sort="num">활용지수</th></tr></thead><tbody>' +
        rows.map(u => '<tr class="row-link" onclick="location.hash=\'#/users/' + encodeURIComponent(u.api_key_id) + '\'">' +
          '<td>' + escapeHTML(u.name) + '<div class="muted">' + escapeHTML(u.api_key_id) + '</div></td>' +
          '<td>' + teamLabel(u.team || '', names || {}) + '</td>' +
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
            row('팀', k.team ? '<a href="#/teams/' + encodeURIComponent(k.team) + '">' + teamLabel(k.team, d.team_names || {}) + '</a>' : '') +
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
        '<div class="card-body">' +
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
        table + '</div>'
      ) + section('월 예산 소진 예측 (Budget Burn-down)',
        '<div class="card-body">' +
        '<p class="muted" style="margin-top:0">월 예산 대비 이번 달 누적 지출과 현재 추세(일평균 소진율)를 월말까지 연장한 예상 지출을 보여줍니다. 추세가 예산을 초과하면 소진 예상일과 함께 경고합니다. 기준 시간대는 KST(월초~월말)입니다.</p>' +
        '<div style="display:flex;gap:8px;align-items:center;margin-bottom:8px"><button class="secondary" type="button" onclick="checkBudgetAlerts(false)">예산 경보 확인</button><button class="secondary" type="button" onclick="checkBudgetAlerts(true)">경보 + Mattermost 알림</button><span id="budget-alert-result" class="muted"></span></div>' +
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
        budgetTable + '</div>'
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
    window.checkBudgetAlerts = async (notify) => {
      const out = document.getElementById('budget-alert-result');
      if (out) out.textContent = '확인 중…';
      try {
        const r = await api('/admin/budgets/alerts' + (notify ? '?notify=1' : ''));
        const msg = 'critical ' + (r.critical || 0) + ' · warn ' + (r.warn || 0) + (notify ? ' (Mattermost 전송됨)' : '');
        if (out) out.innerHTML = (r.critical || r.warn) ? '<span class="status ' + (r.critical ? 'error' : 'warn') + '">' + escapeHTML(msg) + '</span>' : '<span class="status">경보 없음</span>';
      } catch (e) {
        if (out) out.innerHTML = '<span class="status error">' + escapeHTML(e.message) + '</span>';
      }
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

    // ---------- routing learning ----------
    function routeStatusClass(score) {
      const n = Number(score || 0);
      return n >= 0.85 ? '' : (n >= 0.70 ? 'warn' : 'error');
    }
    function routePct(score) {
      return (Number(score || 0) * 100).toFixed(0) + '%';
    }
    function routeOptions(selected) {
      const routes = ['', 'grounded', 'research', 'company_policy', 'legal', 'compliance', 'all_mcp'];
      const labels = {
        '': '전체 route',
        grounded: 'grounded',
        research: 'research',
        company_policy: 'company_policy',
        legal: 'legal',
        compliance: 'compliance',
        all_mcp: 'all_mcp',
      };
      return routes.map(r => '<option value="' + escapeHTML(r) + '" ' + (r === selected ? 'selected' : '') + '>' + escapeHTML(labels[r]) + '</option>').join('');
    }
    function routeLearningQuery(initial, defaults) {
      const p = new URLSearchParams();
      const route = initial ? (initial.get('route') || '') : '';
      const windowValue = initial ? (initial.get('window') || defaults.window || '7d') : (defaults.window || '7d');
      const status = initial ? (initial.get('status') || defaults.status || 'pending') : (defaults.status || 'pending');
      if (route) p.set('route', route);
      if (windowValue) p.set('window', windowValue);
      if (status) p.set('status', status);
      p.set('limit', defaults.limit || '80');
      return p;
    }
    async function renderRoutingLearning(initial) {
      const route = initial ? (initial.get('route') || '') : '';
      const windowValue = initial ? (initial.get('window') || '7d') : '7d';
      const status = initial ? (initial.get('status') || 'pending') : 'pending';
      const decisionQ = routeLearningQuery(initial, { window: windowValue, limit: '80', status: '' });
      decisionQ.delete('status');
      const exampleQ = new URLSearchParams();
      if (route) exampleQ.set('route', route);
      exampleQ.set('limit', '80');
      const reviewQ = routeLearningQuery(initial, { window: windowValue, status, limit: '80' });
      const learningQ = new URLSearchParams();
      learningQ.set('window', windowValue);
      learningQ.set('min_samples', '20');

      const [decisionsResp, examplesResp, reviewResp, learningResp] = await Promise.all([
        api('/admin/routing/domain-decisions?' + decisionQ.toString()).catch(() => ({ decisions: [], signals: {} })),
        api('/admin/routing/domain-examples?' + exampleQ.toString()).catch(() => ({ examples: [] })),
        api('/admin/routing/domain-review?' + reviewQ.toString()).catch(() => ({ items: [] })),
        api('/admin/routing/learning?' + learningQ.toString()).catch(() => ({ recommendations: [] })),
      ]);
      const decisions = decisionsResp.decisions || [];
      const signals = decisionsResp.signals || {};
      const examples = examplesResp.examples || [];
      const reviews = reviewResp.items || [];
      const recommendations = learningResp.recommendations || learningResp.items || learningResp.learning || [];
      window.domainRoutingSignals = signals;

      const avgConfidence = decisions.length ? decisions.reduce((sum, d) => sum + Number(d.confidence || 0), 0) / decisions.length : 0;
      const avgEvidence = decisions.length ? decisions.reduce((sum, d) => sum + Number(d.evidence_score || 0), 0) / decisions.length : 0;
      const blocked = decisions.filter(d => d.blocked_by_governance).length;
      const pending = reviews.filter(r => (r.status || '') === 'pending').length;
      const kpis = '<div class="kpis">' +
        kpi('결정 로그', fmt(decisions.length)) +
        kpi('평균 신뢰도', routePct(avgConfidence) + '<div style="margin-top:8px">' + progressBar(avgConfidence) + '</div>') +
        kpi('평균 증거 점수', routePct(avgEvidence) + '<div style="margin-top:8px">' + progressBar(avgEvidence) + '</div>') +
        kpi('검토 대기', fmt(pending) + (blocked ? '<div class="muted" style="font-size:11px; font-weight:500; margin-top:6px">거버넌스 차단 ' + fmt(blocked) + '건</div>' : '')) +
      '</div>';

      const filters =
        '<form class="toolbar" id="routing-learning-filter" autocomplete="off">' +
          '<select id="routing-route">' + routeOptions(route) + '</select>' +
          '<select id="routing-window">' +
            '<option value="24h" ' + (windowValue === '24h' ? 'selected' : '') + '>24시간</option>' +
            '<option value="7d" ' + (windowValue === '7d' ? 'selected' : '') + '>7일</option>' +
            '<option value="30d" ' + (windowValue === '30d' ? 'selected' : '') + '>30일</option>' +
            '<option value="90d" ' + (windowValue === '90d' ? 'selected' : '') + '>90일</option>' +
          '</select>' +
          '<select id="routing-review-status">' +
            '<option value="pending" ' + (status === 'pending' ? 'selected' : '') + '>pending review</option>' +
            '<option value="approved" ' + (status === 'approved' ? 'selected' : '') + '>approved</option>' +
            '<option value="rejected" ' + (status === 'rejected' ? 'selected' : '') + '>rejected</option>' +
            '<option value="" ' + (status === '' ? 'selected' : '') + '>전체 review</option>' +
          '</select>' +
          '<button type="submit">적용</button>' +
        '</form>';

      const summary = '<div class="banner" style="margin:12px">' +
        'MCP discovery 요청의 선택 route, 후보 점수, evidence gate 결과를 저장하고 confidence가 높은 요청은 예시로 자동 승격합니다. 낮은 신뢰도나 후보 충돌은 검토 큐에 쌓아 운영자가 승인/거절만 하도록 줄였습니다.' +
      '</div>';

      document.getElementById('view').innerHTML =
        section('Intelligent Routing 학습 루프', kpis + filters + summary) +
        section('검토 큐', domainReviewTable(reviews)) +
        section('Domain Routing 결정 로그', domainDecisionTable(decisions, signals)) +
        section('자동 승격 예시', domainExampleTable(examples)) +
        section('모델 추천 학습', routingRecommendationTable(recommendations));

      document.getElementById('routing-learning-filter').addEventListener('submit', (e) => {
        e.preventDefault();
        const p = new URLSearchParams();
        const rv = document.getElementById('routing-route').value;
        const wv = document.getElementById('routing-window').value;
        const sv = document.getElementById('routing-review-status').value;
        if (rv) p.set('route', rv);
        if (wv) p.set('window', wv);
        if (sv) p.set('status', sv);
        location.hash = '#/routing' + (p.toString() ? '?' + p.toString() : '');
      });
      makeSortable('#view', 'routing-learning');
    }
    async function renderRoutingHealth(initial) {
      const windowValue = initial ? (initial.get('window') || '1h') : '1h';
      const threshold = Math.max(0, Math.min(100, Number(initial ? (initial.get('threshold') || 70) : 70)));
      const qs = new URLSearchParams();
      qs.set('window', windowValue);
      qs.set('threshold', String(threshold));
      const resp = await api('/admin/routing/health?' + qs.toString());
      const providers = resp.providers || [];
      const ranking = resp.ranking || [];
      const degraded = resp.degraded || [];
      const alerts = resp.alerts || [];
      const trend = resp.trend || [];
      const avgScore = providers.length ? providers.reduce((sum, p) => sum + Number(p.score || 0), 0) / providers.length : 0;
      const best = ranking[0] || {};
      const worst = ranking.length ? ranking[ranking.length - 1] : {};
      const kpis = '<div class="kpis">' +
        kpi('Provider', fmt(providers.length)) +
        kpi('평균 health', healthScoreCell(avgScore, threshold)) +
        kpi('최상위', best.provider ? '<strong>' + escapeHTML(best.provider) + '</strong><div class="muted" style="font-size:11px; font-weight:500; margin-top:6px">' + fmt(best.score) + '점 · ' + fmt(best.requests) + ' requests</div>' : '<span class="muted">-</span>') +
        kpi('Degraded', '<span class="status ' + (degraded.length ? 'warn' : '') + '">' + fmt(degraded.length) + '</span>' + (worst.provider ? '<div class="muted" style="font-size:11px; font-weight:500; margin-top:6px">최저 ' + escapeHTML(worst.provider) + ' ' + fmt(worst.score) + '점</div>' : '')) +
      '</div>';
      const filters =
        '<form class="toolbar" id="routing-health-filter" autocomplete="off">' +
          '<select id="routing-health-window">' +
            ['15m','1h','6h','24h','7d'].map(w => '<option value="' + w + '"' + (w === windowValue ? ' selected' : '') + '>' + w + '</option>').join('') +
          '</select>' +
          '<label class="muted" style="display:flex; align-items:center; gap:6px">threshold <input id="routing-health-threshold" type="number" min="0" max="100" value="' + threshold + '" style="width:86px"></label>' +
          '<button type="submit">적용</button>' +
          '<button type="button" class="secondary" onclick="route()">새로고침</button>' +
          '<span class="muted" style="margin-left:auto">since ' + escapeHTML(resp.since || '') + ' · until ' + escapeHTML(resp.until || '') + '</span>' +
        '</form>';
      document.getElementById('view').innerHTML =
        section('Provider Health', kpis + filters) +
        section('Provider ranking', providerHealthRankingTable(ranking, threshold)) +
        section('Degradation alerts', providerHealthAlertsTable(alerts)) +
        section('Health trend', providerHealthTrendTable(trend, threshold));
      document.getElementById('routing-health-filter').addEventListener('submit', (e) => {
        e.preventDefault();
        const p = new URLSearchParams();
        p.set('window', document.getElementById('routing-health-window').value);
        p.set('threshold', document.getElementById('routing-health-threshold').value || '70');
        location.hash = '#/routing/health?' + p.toString();
      });
      makeSortable('#view', 'routing-health');
    }
    function healthStatusClass(score, threshold) {
      const n = Number(score || 0);
      if (n < 40) return 'error';
      if (n < Number(threshold || 70)) return 'warn';
      return '';
    }
    function healthScoreCell(score, threshold) {
      const n = Math.round(Number(score || 0));
      return '<span class="status ' + healthStatusClass(n, threshold) + '">' + fmt(n) + ' / 100</span>' + progressBar(n / 100);
    }
    function providerHealthRankingTable(rows, threshold) {
      if (!rows.length) return '<div class="empty">선택한 기간의 provider health 데이터 없음</div>';
      return '<table><thead><tr>' +
        '<th data-sort="num">Rank</th><th data-sort="str">Provider</th><th data-sort="num">Health</th><th data-sort="num">Requests</th><th data-sort="num">P95</th><th data-sort="num">평균 지연</th><th data-sort="num">Fallback</th>' +
      '</tr></thead><tbody>' +
      rows.map(r => '<tr>' +
        '<td data-num="' + Number(r.rank || 0) + '">' + fmt(r.rank || 0) + '</td>' +
        '<td><strong>' + escapeHTML(r.provider || '') + '</strong></td>' +
        '<td data-num="' + Number(r.score || 0) + '">' + healthScoreCell(r.score || 0, threshold) + '</td>' +
        '<td data-num="' + Number(r.requests || 0) + '">' + fmt(r.requests || 0) + '</td>' +
        '<td data-num="' + Number(r.p95_latency_ms || 0) + '">' + fmt(r.p95_latency_ms || 0) + ' ms</td>' +
        '<td data-num="' + Number(r.average_latency_ms || 0) + '">' + fmt(Math.round(Number(r.average_latency_ms || 0))) + ' ms</td>' +
        '<td data-num="' + Number(r.fallback_rate || 0) + '">' + pct(r.fallback_rate || 0) + '</td>' +
      '</tr>').join('') + '</tbody></table>';
    }
    function providerHealthAlertsTable(rows) {
      if (!rows.length) return '<div class="empty">선택한 기간의 degradation alert 없음</div>';
      const cls = (s) => s === 'critical' ? 'error' : (s === 'warning' ? 'warn' : '');
      return '<table><thead><tr><th data-sort="str">Provider</th><th data-sort="str">Severity</th><th data-sort="str">Code</th><th>Message</th></tr></thead><tbody>' +
        rows.map(a => '<tr>' +
          '<td><strong>' + escapeHTML(a.provider || '') + '</strong></td>' +
          '<td><span class="status ' + cls(a.severity || '') + '">' + escapeHTML(a.severity || '') + '</span></td>' +
          '<td><code>' + escapeHTML(a.code || '') + '</code></td>' +
          '<td>' + escapeHTML(a.message || '') + '</td>' +
        '</tr>').join('') + '</tbody></table>';
    }
    function providerHealthTrendTable(rows, threshold) {
      if (!rows.length) return '<div class="empty">선택한 기간의 trend 데이터 없음</div>';
      return '<table><thead><tr><th>Bucket</th><th>Providers</th></tr></thead><tbody>' +
        rows.map(b => {
          const providers = b.providers || [];
          const cells = providers.length ? providers.map(p =>
            '<span class="pill" style="margin:0 6px 6px 0">' + escapeHTML(p.provider || '') + ' <span class="status ' + healthStatusClass(p.score || 0, threshold) + '" style="margin-left:4px">' + fmt(p.score || 0) + '</span></span>'
          ).join('') : '<span class="muted">no traffic</span>';
          return '<tr><td><strong>' + escapeHTML(bucketLabel(b.since, b.until)) + '</strong><div class="muted">' + escapeHTML((b.since || '').replace('T',' ').replace('Z','')) + ' ~ ' + escapeHTML((b.until || '').replace('T',' ').replace('Z','')) + '</div></td><td>' + cells + '</td></tr>';
        }).join('') + '</tbody></table>';
    }
    function bucketLabel(since, until) {
      const fmtTime = (v) => {
        const d = new Date(v);
        if (isNaN(d.getTime())) return String(v || '');
        return d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
      };
      return fmtTime(since) + ' - ' + fmtTime(until);
    }
    function domainDecisionTable(rows, signalMap) {
      if (!rows.length) return '<div class="empty">선택한 조건의 routing decision 없음</div>';
      return '<table><thead><tr>' +
        '<th data-sort="str">시각</th><th data-sort="str">Route</th><th data-sort="num">신뢰도</th><th data-sort="num">Evidence</th><th>Tools</th><th>대상</th><th>근거</th><th>신호</th>' +
      '</tr></thead><tbody>' +
      rows.map(d => {
        const sigs = (signalMap || {})[d.id] || [];
        return '<tr>' +
          '<td>' + ago(d.created_at) + '<div class="muted">' + escapeHTML(d.request_id || '') + '</div></td>' +
          '<td><span class="pill">' + escapeHTML(d.route || '') + '</span>' +
            (d.fallback_used ? '<div class="status warn" style="margin-top:4px">fallback</div>' : '') +
            (d.blocked_by_governance ? '<div class="status error" style="margin-top:4px">blocked</div>' : '') + '</td>' +
          '<td data-num="' + Number(d.confidence || 0) + '"><span class="status ' + routeStatusClass(d.confidence) + '">' + routePct(d.confidence) + '</span></td>' +
          '<td data-num="' + Number(d.evidence_score || 0) + '">' + routePct(d.evidence_score) + '<div class="muted">' + fmt(d.evidence_count || 0) + '개</div></td>' +
          '<td>' + listPills(d.tool_names || []) + '</td>' +
          '<td>' + escapeHTML(d.team_id || '') + '<div class="muted">' + escapeHTML(d.user_id || '') + '</div></td>' +
          '<td>' + escapeHTML(d.reason || '') + '</td>' +
          '<td><button class="secondary" type="button" onclick="openDomainSignals(\'' + escapeAttr(d.id) + '\')">신호 ' + fmt(sigs.length) + '</button></td>' +
        '</tr>';
      }).join('') + '</tbody></table>';
    }
    function domainReviewTable(rows) {
      if (!rows.length) return '<div class="empty">검토할 domain routing 항목 없음</div>';
      return '<table><thead><tr>' +
        '<th data-sort="str">시각</th><th data-sort="str">상태</th><th>Prompt</th><th data-sort="str">Route</th><th>사유</th><th>동작</th>' +
      '</tr></thead><tbody>' +
      rows.map(r => '<tr>' +
        '<td>' + ago(r.created_at) + '<div class="muted">' + escapeHTML(r.decision_id || '') + '</div></td>' +
        '<td><span class="status ' + governanceStatusClass(r.status) + '">' + escapeHTML(r.status || '') + '</span>' + (r.reviewed_at ? '<div class="muted">' + ago(r.reviewed_at) + '</div>' : '') + '</td>' +
        '<td><div class="prompt">' + escapeHTML(r.query_text || '') + '</div></td>' +
        '<td>' + escapeHTML(r.current_route || '') + '<div class="muted">suggested ' + escapeHTML(r.suggested_route || '') + '</div></td>' +
        '<td>' + escapeHTML(r.reason || '') + '</td>' +
        '<td>' + ((r.status || '') === 'pending'
          ? '<button type="button" onclick="decideDomainReview(\'' + escapeAttr(r.id) + '\',\'approve\')">승인</button> ' +
            '<button class="danger" type="button" onclick="decideDomainReview(\'' + escapeAttr(r.id) + '\',\'reject\')">거절</button>'
          : '<span class="muted">처리됨</span>') + '</td>' +
      '</tr>').join('') + '</tbody></table>';
    }
    function domainExampleTable(rows) {
      if (!rows.length) return '<div class="empty">자동 승격 또는 승인된 domain example 없음</div>';
      return '<table><thead><tr>' +
        '<th data-sort="str">Route</th><th>예시</th><th data-sort="num">신뢰도</th><th data-sort="str">Source</th><th data-sort="str">시각</th>' +
      '</tr></thead><tbody>' +
      rows.map(e => '<tr>' +
        '<td><span class="pill">' + escapeHTML(e.route || '') + '</span></td>' +
        '<td><div class="prompt">' + escapeHTML(e.text || '') + '</div><div class="muted">' + escapeHTML((e.text_hash || '').slice(0, 18)) + '</div></td>' +
        '<td data-num="' + Number(e.confidence || 0) + '"><span class="status ' + routeStatusClass(e.confidence) + '">' + routePct(e.confidence) + '</span></td>' +
        '<td>' + escapeHTML(e.source || '') + (e.auto_promoted ? '<div class="muted">auto promoted</div>' : '') + '</td>' +
        '<td>' + ago(e.created_at) + '</td>' +
      '</tr>').join('') + '</tbody></table>';
    }
    function routingRecommendationTable(rows) {
      if (!rows || !rows.length) return '<div class="empty">아직 추천 학습 표본이 부족합니다.</div>';
      return '<table><thead><tr><th>Segment</th><th>추천 모델</th><th data-sort="num">표본</th><th data-sort="num">성공률</th><th data-sort="num">평균 비용</th><th data-sort="num">평균 지연</th></tr></thead><tbody>' +
        rows.map(r => '<tr>' +
          '<td>' + escapeHTML([r.task_type, r.complexity_bucket || r.bucket].filter(Boolean).join(' / ') || r.segment || '') + '</td>' +
          '<td><strong>' + escapeHTML(r.model || r.recommended_model || '') + '</strong><div class="muted">' + escapeHTML(r.provider || '') + '</div></td>' +
          '<td data-num="' + Number(r.samples || r.requests || 0) + '">' + fmt(r.samples || r.requests || 0) + '</td>' +
          '<td data-num="' + Number(r.success_rate || 0) + '">' + routePct(r.success_rate || 0) + '</td>' +
          '<td data-num="' + Number(r.avg_cost_krw || r.cost_krw || 0) + '">' + money(r.avg_cost_krw || r.cost_krw || 0) + '</td>' +
          '<td data-num="' + Number(r.avg_latency_ms || r.latency_ms || 0) + '">' + fmt(Math.round(Number(r.avg_latency_ms || r.latency_ms || 0))) + ' ms</td>' +
        '</tr>').join('') + '</tbody></table>';
    }
    function listPills(items) {
      if (!items || !items.length) return '<span class="muted">-</span>';
      return items.slice(0, 5).map(x => '<span class="pill" style="margin:0 4px 4px 0">' + escapeHTML(x) + '</span>').join('') +
        (items.length > 5 ? '<span class="muted">+' + fmt(items.length - 5) + '</span>' : '');
    }
    window.openDomainSignals = (id) => {
      const sigs = (window.domainRoutingSignals || {})[id] || [];
      const body = sigs.length ? '<table><thead><tr><th>Source</th><th>Route</th><th>Score</th><th>Reason</th><th>시각</th></tr></thead><tbody>' +
        sigs.map(s => '<tr><td>' + escapeHTML(s.source || '') + '</td><td>' + escapeHTML(s.route || '') + '</td><td>' + routePct(s.score || 0) + '</td><td>' + escapeHTML(s.reason || '') + '</td><td>' + ago(s.created_at) + '</td></tr>').join('') +
        '</tbody></table>' : '<div class="empty">저장된 signal 없음</div>';
      openModal('Routing Signals - ' + id, body);
    };
    window.decideDomainReview = async (id, action) => {
      if (!id) return;
      const label = action === 'approve' ? '승인' : '거절';
      if (!confirm('이 routing review를 ' + label + '하시겠습니까?')) return;
      try {
        await api('/admin/routing/domain-review/' + encodeURIComponent(id) + '/' + action, { method: 'POST', body: JSON.stringify({}) });
        route();
      } catch (err) {
        openModal('Routing Review 처리 오류', '<div class="error-line">' + escapeHTML(err.message) + '</div>');
      }
    };

    // ---------- Capability Registry: 기능 맵 ----------
    async function renderCapabilities() {
      const view = document.getElementById('view');
      view.innerHTML = section('기능 맵', '<div class="empty">불러오는 중...</div>');
      let d;
      try { d = await api('/admin/capabilities'); }
      catch (e) { view.innerHTML = section('기능 맵', '<div class="card-body" style="padding:16px"><p class="muted">' + escapeHTML(e.message) + '</p></div>'); return; }
      const caps = d.capabilities || [];
      const groupLabel = { core: '핵심', data: '데이터', security: '보안', assets: '자산', users: '사용자', ops: '운영' };
      const byGroup = {};
      caps.forEach(c => { (byGroup[c.group] = byGroup[c.group] || []).push(c); });
      const chips = (arr, cls) => (arr || []).map(x => '<span class="status ' + (cls || '') + '" style="font-size:9px;margin:1px">' + escapeHTML(x) + '</span>').join('');
      let html = section('기능 맵', '<p class="muted" style="font-size:12px">' + (d.count || 0) + '개 기능 — 각 기능의 API·UI 탭·권한·설정키·DB 테이블·워커를 한눈에. ' + escapeHTML(d.note || '') + '</p>');
      Object.keys(byGroup).sort().forEach(g => {
        html += '<h3 style="margin:14px 0 4px;font-size:14px">' + escapeHTML(groupLabel[g] || g) + '</h3>';
        html += byGroup[g].map(c =>
          '<div style="border:1px solid var(--border);border-radius:8px;padding:10px;margin:6px 0">' +
          '<div style="display:flex;justify-content:space-between"><strong>' + escapeHTML(c.name) + ' <span class="muted" style="font-size:11px">(' + escapeHTML(c.key) + ')</span></strong></div>' +
          '<div class="muted" style="font-size:12px;margin:3px 0">' + escapeHTML(c.description) + '</div>' +
          (c.apis && c.apis.length ? '<div style="font-size:11px;margin-top:3px"><b>API</b> ' + (c.apis || []).map(a => '<code style="font-size:10px">' + escapeHTML(a) + '</code>').join(' · ') + '</div>' : '') +
          (c.ui_tabs && c.ui_tabs.length ? '<div style="margin-top:3px"><b style="font-size:11px">UI</b> ' + chips(c.ui_tabs) + '</div>' : '') +
          (c.scopes && c.scopes.length ? '<div style="margin-top:3px"><b style="font-size:11px">권한</b> ' + chips(c.scopes, 'warn') + '</div>' : '') +
          (c.setting_keys && c.setting_keys.length ? '<div style="margin-top:3px"><b style="font-size:11px">설정</b> ' + chips(c.setting_keys) + '</div>' : '') +
          (c.tables && c.tables.length ? '<div style="margin-top:3px"><b style="font-size:11px">테이블</b> <span class="muted" style="font-size:10px">' + (c.tables || []).map(escapeHTML).join(', ') + '</span></div>' : '') +
          (c.workers && c.workers.length ? '<div style="margin-top:3px"><b style="font-size:11px">워커</b> ' + chips(c.workers) + '</div>' : '') +
          '</div>'
        ).join('');
      });
      view.innerHTML = html;
    }

    // ---------- AI Gateway 운영 홈: 오늘 봐야 할 것 ----------
    async function renderOpsHome() {
      const view = document.getElementById('view');
      view.innerHTML = section('운영 홈', '<div class="empty">불러오는 중...</div>');
      let d;
      try { d = await api('/admin/ops/home'); }
      catch (e) { view.innerHTML = section('운영 홈', '<div class="card-body" style="padding:16px"><p class="muted">' + escapeHTML(e.message) + '</p></div>'); return; }
      const color = (st) => st === 'critical' ? '#ef5350' : (st === 'warn' ? '#ffa726' : (st === 'unknown' ? '#9e9e9e' : '#66bb6a'));
      const badge = (st) => st === 'critical' ? '<span class="status error">위험</span>' : (st === 'warn' ? '<span class="status warn">주의</span>' : (st === 'unknown' ? '<span class="status">미상</span>' : '<span class="status">정상</span>'));
      const cards = (d.cards || []).map(c =>
        '<a href="' + escapeAttr(c.link || '#/dashboard') + '" style="text-decoration:none;color:inherit">' +
        '<div style="border:1px solid var(--border);border-left:5px solid ' + color(c.status) + ';border-radius:10px;padding:14px;min-width:200px;flex:1">' +
        '<div style="display:flex;justify-content:space-between;align-items:center"><strong>' + escapeHTML(c.title) + '</strong>' + badge(c.status) + '</div>' +
        '<div style="font-size:22px;font-weight:800;margin:6px 0">' + escapeHTML(c.value || '-') + '</div>' +
        (c.detail ? '<div class="muted" style="font-size:12px">' + escapeHTML(c.detail) + '</div>' : '') +
        '</div></a>'
      ).join('');
      const overall = badge(d.overall);
      view.innerHTML = section('운영 홈 (최근 ' + (d.window_hours || 24) + 'h)',
        '<p class="muted" style="font-size:12px">전체 상태 ' + overall + ' · 생성 ' + ago(d.generated_at) + ' — 카드를 클릭하면 상세 화면으로 이동합니다.</p>') +
        '<div id="ops-incidents"></div>' +
        '<div style="display:flex;gap:12px;flex-wrap:wrap">' + cards + '</div>' +
        '<div id="ops-workers"></div>';
      opsLoadIncidents();
      opsLoadWorkers();
    }
    // Incident Copilot — 지금 확인할 이슈(장애 후보).
    window.opsLoadIncidents = async () => {
      const host = document.getElementById('ops-incidents');
      if (!host) return;
      let d;
      try { d = await api('/admin/incidents/candidates'); } catch (e) { host.innerHTML = ''; return; }
      const items = d.incidents || [];
      if (!items.length) { host.innerHTML = '<div class="card-body" style="padding:8px 0"><span class="status">지금 확인할 이슈 없음 ✅</span></div>'; return; }
      const sevBadge = (s) => s === 'critical' ? '<span class="status error">위험</span>' : (s === 'warning' ? '<span class="status warn">경고</span>' : '<span class="status">정보</span>');
      const rows = items.map(it =>
        '<div style="border:1px solid var(--border);border-left:4px solid ' + (it.severity === 'critical' ? '#ef5350' : (it.severity === 'warning' ? '#ffa726' : '#6ea8fe')) + ';border-radius:8px;padding:10px;margin:6px 0">' +
        '<div style="display:flex;gap:8px;align-items:center"><strong>' + escapeHTML(it.title) + '</strong> ' + sevBadge(it.severity) + ' <span class="muted" style="font-size:11px">' + escapeHTML(it.category) + '</span></div>' +
        '<div class="muted" style="font-size:12px;margin:3px 0">' + escapeHTML(it.summary) + '</div>' +
        (it.recommended_actions && it.recommended_actions.length ? '<div style="font-size:11px"><b>추천 조치</b><ul style="margin:2px 0;padding-left:18px">' + it.recommended_actions.map(a => '<li>' + escapeHTML(a) + '</li>').join('') + '</ul></div>' : '') +
        ((it.links || []).length ? '<div style="font-size:11px">' + (it.links || []).map(l => '<a href="' + escapeAttr(l) + '">' + escapeHTML(l) + '</a>').join(' · ') + '</div>' : '') +
        '</div>').join('');
      host.innerHTML = card('지금 확인할 이슈 (' + (d.counts.critical || 0) + ' 위험 · ' + (d.counts.warning || 0) + ' 경고)',
        '<div class="card-body">' + rows + '<p class="muted" style="font-size:10px;margin-top:4px">' + escapeHTML(d.note || '') + '</p></div>');
    }
    // 백그라운드 워커 상태판.
    window.opsLoadWorkers = async () => {
      const host = document.getElementById('ops-workers');
      if (!host) return;
      let d;
      try { d = await api('/admin/ops/workers'); } catch (e) { host.innerHTML = ''; return; }
      const sBadge = (st) => st === 'critical' ? '<span class="status error">위험</span>' : (st === 'warn' ? '<span class="status warn">주의</span>' : (st === 'idle' ? '<span class="status">유휴</span>' : '<span class="status">정상</span>'));
      const rows = (d.workers || []).map(wk =>
        '<tr><td>' + escapeHTML(wk.name) + '</td><td>' + sBadge(wk.status) + '</td>' +
        '<td>' + (wk.running ? '실행' : '중지') + '</td>' +
        '<td>' + (wk.capacity ? (wk.queue_depth + '/' + wk.capacity) : (wk.queue_depth || 0)) + '</td>' +
        '<td>' + (wk.dropped || 0) + '</td>' +
        '<td class="muted" style="font-size:11px">' + (wk.last_run ? ago(wk.last_run) + ' · ' : '') + escapeHTML(wk.detail || '') + '</td></tr>'
      ).join('');
      host.innerHTML = card('백그라운드 워커',
        '<div class="card-body"><table><thead><tr><th>워커</th><th>상태</th><th>실행</th><th>큐</th><th>유실</th><th>상세</th></tr></thead><tbody>' + rows + '</tbody></table>' +
        '<div style="margin-top:8px"><button type="button" class="secondary" onclick="opsPreflight()">배포 프리플라이트 점검</button></div>' +
        '<div id="ops-preflight"></div></div>');
    };
    // Upgrade Preflight — 배포 전/후 점검(DB·마이그레이션·OpenAPI·설정).
    window.opsPreflight = async () => {
      const host = document.getElementById('ops-preflight');
      if (host) host.innerHTML = '<div class="empty">점검 중...</div>';
      try {
        const d = await api('/admin/ops/preflight');
        const sBadge = (st) => st === 'fail' ? '<span class="status error">실패</span>' : (st === 'warn' ? '<span class="status warn">주의</span>' : '<span class="status">정상</span>');
        const rows = (d.checks || []).map(c => '<tr><td>' + escapeHTML(c.name) + '</td><td>' + sBadge(c.status) + '</td><td class="muted" style="font-size:11px">' + escapeHTML(c.detail || '') + '</td></tr>').join('');
        if (host) host.innerHTML = '<div style="border:1px solid var(--border);border-radius:6px;padding:8px;margin-top:6px">' +
          '<strong style="font-size:12px">프리플라이트 ' + escapeHTML(d.version || '') + ' · 종합 ' + sBadge(d.overall) + '</strong>' +
          '<table style="margin-top:4px"><thead><tr><th>점검</th><th>상태</th><th>상세</th></tr></thead><tbody>' + rows + '</tbody></table>' +
          '<p class="muted" style="font-size:10px;margin-top:4px">' + escapeHTML(d.note || '') + '</p></div>';
      } catch (e) { if (host) host.innerHTML = '<span class="status error">' + escapeHTML(e.message) + '</span>'; }
    };

    // ---------- DW Metric Catalog: 표준 지표 사전 ----------
    async function renderDWMetrics() {
      const view = document.getElementById('view');
      view.innerHTML = section('지표 사전', '<div class="empty">불러오는 중...</div>');
      let d;
      try { d = await api('/admin/dw/metrics'); }
      catch (e) { view.innerHTML = section('지표 사전', '<div class="card-body" style="padding:16px"><p class="muted">' + escapeHTML(e.message) + '</p></div>'); return; }
      const ms = d.metrics || [];
      const sens = (s) => s === 'restricted' ? '<span class="status error" style="font-size:9px">restricted</span>' : (s === 'public' ? '<span class="status" style="font-size:9px">public</span>' : '<span class="status warn" style="font-size:9px">internal</span>');
      const rows = ms.length ? ms.map(m => '<tr><td><strong>' + escapeHTML(m.metric_key) + '</strong>' + (m.name_ko ? '<div class="muted" style="font-size:11px">' + escapeHTML(m.name_ko) + '</div>' : '') + '</td>' +
        '<td>' + (m.enabled ? '<span class="status">on</span>' : '<span class="status warn">off</span>') + '</td>' +
        '<td>' + sens(m.sensitivity) + '</td>' +
        '<td class="muted" style="font-size:11px">' + escapeHTML((m.dimensions || []).join(', ')) + '</td>' +
        '<td class="muted" style="font-size:11px">' + escapeHTML(m.owner || '-') + ' · v' + (m.version || 1) + '</td>' +
        '<td><button type="button" class="secondary" style="font-size:11px" onclick="dwMetricValidate(\'' + escapeAttr(m.id) + '\')">검증</button> ' +
        '<button type="button" class="secondary" style="font-size:11px" onclick="dwMetricDelete(\'' + escapeAttr(m.id) + '\')">삭제</button></td></tr>' +
        '<tr><td colspan="6"><div id="dwm-' + escapeAttr(m.id) + '"></div></td></tr>').join('') : '<tr><td colspan="6" class="muted">표준 지표가 없습니다. ClickHouse fact 위에 표준 지표를 정의하세요.</td></tr>';
      view.innerHTML = section('지표 사전', '<p class="muted" style="font-size:12px">ClickHouse fact를 운영자가 이해 가능한 표준 지표로 관리합니다. 쿼리는 SELECT 전용·표준 fact 테이블·집계 컬럼만 허용(민감 원문 컬럼 금지).</p>') +
        card('표준 지표', '<div class="card-body"><table><thead><tr><th>지표</th><th>활성</th><th>민감도</th><th>차원</th><th>owner</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>') +
        card('새 지표 정의',
          '<div class="card-body">' +
          '<div style="display:flex;gap:6px;margin-bottom:6px"><input id="dwm-key" placeholder="metric_key (예: daily_cost_by_team)" style="flex:1"><input id="dwm-name" placeholder="한국어 이름" style="flex:1"></div>' +
          '<input id="dwm-desc" placeholder="설명" style="width:100%;margin-bottom:6px">' +
          '<div style="display:flex;gap:6px;margin-bottom:6px"><input id="dwm-dims" placeholder="차원(쉼표, 예: team,model,day)" style="flex:1"><input id="dwm-owner" placeholder="owner" style="width:140px">' +
          '<select id="dwm-sens"><option value="internal">internal</option><option value="public">public</option><option value="restricted">restricted</option></select>' +
          '<label style="font-size:11px"><input type="checkbox" id="dwm-enabled"> 활성</label></div>' +
          '<textarea id="dwm-query" placeholder="query_template (SELECT ... FROM ai_request_fact ...)" style="width:100%;height:72px"></textarea>' +
          '<div style="margin-top:6px"><button type="button" onclick="dwMetricSave()">저장</button></div>' +
          '<div id="dwm-save-out" style="margin-top:6px"></div>' +
          '</div>');
    }
    function dwRenderValidation(v) {
      if (!v) return '';
      const errs = (v.errors || []).map(e => '<div class="status error" style="font-size:10px">' + escapeHTML(e) + '</div>').join('');
      const warns = (v.warnings || []).map(wn => '<div class="status warn" style="font-size:10px">' + escapeHTML(wn) + '</div>').join('');
      return '<div style="border:1px solid var(--border);border-radius:6px;padding:6px;margin:4px 0">' +
        '<strong style="font-size:11px">검증: ' + (v.ok ? '<span class="status">통과</span>' : '<span class="status error">실패</span>') + '</strong>' +
        errs + warns +
        ((v.referenced_tables || []).length ? '<div class="muted" style="font-size:10px">참조 테이블: ' + escapeHTML(v.referenced_tables.join(', ')) + '</div>' : '') +
        '<div class="muted" style="font-size:10px">' + escapeHTML(v.note || '') + '</div></div>';
    }
    window.dwMetricSave = async () => {
      const out = document.getElementById('dwm-save-out');
      const key = (document.getElementById('dwm-key').value || '').trim();
      if (!key) { if (out) out.innerHTML = '<span class="status error">metric_key 필수</span>'; return; }
      const dims = (document.getElementById('dwm-dims').value || '').split(',').map(x => x.trim()).filter(Boolean);
      const body = { metric_key: key, name_ko: (document.getElementById('dwm-name').value || '').trim(), description: (document.getElementById('dwm-desc').value || '').trim(),
        query_template: document.getElementById('dwm-query').value, dimensions: dims, owner: (document.getElementById('dwm-owner').value || '').trim(),
        sensitivity: document.getElementById('dwm-sens').value, enabled: document.getElementById('dwm-enabled').checked };
      try { const r = await api('/admin/dw/metrics', { method: 'POST', body: JSON.stringify(body) }); if (out) out.innerHTML = dwRenderValidation(r.validation); await renderDWMetrics(); }
      catch (e) {
        let msg = e.message;
        try { const j = JSON.parse(e.body || '{}'); if (j.validation) { if (out) out.innerHTML = dwRenderValidation(j.validation); return; } } catch (_) {}
        if (out) out.innerHTML = '<span class="status error">' + escapeHTML(msg) + '</span>';
      }
    };
    window.dwMetricValidate = async (id) => {
      const host = document.getElementById('dwm-' + id);
      if (host) host.innerHTML = '<span class="muted">검증 중...</span>';
      try { const r = await api('/admin/dw/metrics/' + encodeURIComponent(id) + '/validate', { method: 'POST', body: '{}' }); if (host) host.innerHTML = dwRenderValidation(r.validation); }
      catch (e) { if (host) host.innerHTML = '<span class="status error">' + escapeHTML(e.message) + '</span>'; }
    };
    window.dwMetricDelete = async (id) => {
      if (!confirm('이 지표를 삭제할까요?')) return;
      try { await api('/admin/dw/metrics/' + encodeURIComponent(id), { method: 'DELETE' }); await renderDWMetrics(); }
      catch (e) { alert(e.message); }
    };

    // ---------- 운영 변경관리 센터: Change Set (dry-run/승인/적용/롤백) ----------
    const csStatusBadge = (st) => {
      const cls = st === 'applied' ? '' : (st === 'rolled_back' ? 'error' : (st === 'approved' ? '' : 'warn'));
      return '<span class="status ' + cls + '">' + escapeHTML(st || '') + '</span>';
    };
    async function renderChangeSets() {
      const view = document.getElementById('view');
      view.innerHTML = section('변경 세트', '<div class="empty">불러오는 중...</div>');
      let d;
      try { d = await api('/admin/change-sets'); }
      catch (e) { view.innerHTML = section('변경 세트', '<div class="card-body" style="padding:16px"><p class="muted">' + escapeHTML(e.message) + '</p></div>'); return; }
      const sets = d.change_sets || [];
      const rows = sets.length ? sets.map(cs =>
        '<tr><td><strong>' + escapeHTML(cs.title) + '</strong>' + (cs.description ? '<div class="muted" style="font-size:11px">' + escapeHTML(cs.description) + '</div>' : '') + '</td>' +
        '<td>' + csStatusBadge(cs.status) + '</td>' +
        '<td>' + (cs.items || []).length + '개</td>' +
        '<td class="muted">' + escapeHTML(cs.reviewer || '-') + '</td>' +
        '<td>' + csActions(cs) + '</td></tr>' +
        '<tr><td colspan="5"><div id="cs-detail-' + escapeAttr(cs.id) + '"></div></td></tr>'
      ).join('') : '<tr><td colspan="5" class="muted">변경 세트가 없습니다.</td></tr>';
      view.innerHTML = section('변경 세트', '<p class="muted" style="font-size:12px">설정 변경을 하나의 릴리즈로 묶어 dry-run → 승인 → 적용 → 롤백합니다. (현재 버전은 setting 항목 적용, policy/routing/skill은 참고 기록)</p>') +
        card('변경 세트 목록', '<div class="card-body"><table><thead><tr><th>제목</th><th>상태</th><th>항목</th><th>리뷰어</th><th>액션</th></tr></thead><tbody>' + rows + '</tbody></table></div>') +
        card('변경 영향도 시뮬레이터',
          '<div class="card-body">' +
          '<p class="muted" style="font-size:12px">변경을 과거 요청(모델 일별 집계)에 dry-run 적용해 영향을 추정합니다. 원문 미사용.</p>' +
          '<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:6px">' +
          '<select id="ci-type" onchange="ciSyncParams()"><option value="block_model">모델 차단</option><option value="model_price">모델 단가 변경</option><option value="route_remap">모델 재라우팅</option></select>' +
          '<input id="ci-days" type="number" value="7" title="기간(일)" style="width:70px">' +
          '<span id="ci-params"></span>' +
          '<button type="button" onclick="ciSimulate()">시뮬레이션</button></div>' +
          '<div id="ci-out"></div>' +
          '</div>') +
        card('새 변경 세트',
          '<div class="card-body">' +
          '<input id="cs-title" placeholder="제목" style="width:100%;margin-bottom:6px">' +
          '<input id="cs-desc" placeholder="설명" style="width:100%;margin-bottom:6px">' +
          '<input id="cs-canary" placeholder="canary 범위(팀/키, 메모용)" style="width:100%;margin-bottom:6px">' +
          '<textarea id="cs-items" placeholder=\'항목 JSON 배열, 예: [{"kind":"setting","key":"cache.chat_enabled","value":"true"}]\' style="width:100%;height:72px"></textarea>' +
          '<div style="margin-top:6px"><button type="button" onclick="csCreate()">변경 세트 생성</button></div>' +
          '<div id="cs-create-out" style="margin-top:6px"></div>' +
          '</div>');
    }
    function csActions(cs) {
      const b = (label, fn) => '<button type="button" class="secondary" style="font-size:11px" onclick="' + fn + '(\'' + escapeAttr(cs.id) + '\')">' + label + '</button> ';
      let out = b('Dry-run', 'csDryRun');
      if (cs.status === 'draft') out += b('제출', 'csSubmit') + b('삭제', 'csDelete');
      if (cs.status === 'pending') out += b('승인', 'csApprove');
      if (cs.status === 'approved') out += b('적용', 'csApply');
      if (cs.status === 'applied') out += b('롤백', 'csRollback');
      return out;
    }
    window.csCreate = async () => {
      const out = document.getElementById('cs-create-out');
      const title = (document.getElementById('cs-title').value || '').trim();
      if (!title) { if (out) out.innerHTML = '<span class="status error">제목 필수</span>'; return; }
      let items = [];
      const raw = (document.getElementById('cs-items').value || '').trim();
      if (raw) { try { items = JSON.parse(raw); } catch (e) { if (out) out.innerHTML = '<span class="status error">항목 JSON 파싱 오류</span>'; return; } }
      const body = { title, description: (document.getElementById('cs-desc').value || '').trim(), canary_scope: (document.getElementById('cs-canary').value || '').trim(), items };
      try { await api('/admin/change-sets', { method: 'POST', body: JSON.stringify(body) }); await renderChangeSets(); }
      catch (e) { if (out) out.innerHTML = '<span class="status error">' + escapeHTML(e.message) + '</span>'; }
    };
    window.ciSyncParams = () => {
      const t = document.getElementById('ci-type').value;
      const host = document.getElementById('ci-params');
      if (!host) return;
      if (t === 'block_model') host.innerHTML = '<input id="ci-pattern" placeholder="모델 패턴 (예: gpt-4*,claude-*)" style="width:260px">';
      else if (t === 'model_price') host.innerHTML = '<input id="ci-model" placeholder="모델" style="width:160px"><input id="ci-in" type="number" placeholder="입력 ₩/1M" style="width:110px"><input id="ci-out" type="number" placeholder="출력 ₩/1M" style="width:110px">';
      else host.innerHTML = '<input id="ci-from" placeholder="원본 모델" style="width:150px"><input id="ci-to" placeholder="대상 모델" style="width:150px">';
    };
    window.ciSimulate = async () => {
      const out = document.getElementById('ci-out');
      const t = document.getElementById('ci-type').value;
      const days = parseInt(document.getElementById('ci-days').value || '7', 10);
      const params = {};
      if (t === 'block_model') params.pattern = (document.getElementById('ci-pattern').value || '').trim();
      else if (t === 'model_price') { params.model = (document.getElementById('ci-model').value || '').trim(); params.input_krw_per_1m = parseFloat(document.getElementById('ci-in').value || '0'); params.output_krw_per_1m = parseFloat(document.getElementById('ci-out').value || '0'); }
      else { params.from = (document.getElementById('ci-from').value || '').trim(); params.to = (document.getElementById('ci-to').value || '').trim(); }
      out.innerHTML = '<div class="empty">시뮬레이션 중...</div>';
      try {
        const d = await api('/admin/change-impact/simulate', { method: 'POST', body: JSON.stringify({ change_type: t, days, params }) });
        const b = d.baseline || {}, im = d.impact || {};
        const won = (v) => '₩' + fmt(Math.round(v || 0));
        let rows = '<tr><td>기준(' + (d.window_days || 7) + '일)</td><td>요청 ' + fmt(b.requests || 0) + ' · ' + won(b.cost_krw) + ' · 모델 ' + (b.models || 0) + '</td></tr>';
        Object.keys(im).forEach(k => {
          if (k === 'matched_models') return;
          let v = im[k];
          if (typeof v === 'number' && /cost|krw/.test(k)) v = won(v);
          else if (typeof v === 'object') return;
          rows += '<tr><td>' + escapeHTML(k) + '</td><td>' + escapeHTML(String(v)) + '</td></tr>';
        });
        out.innerHTML = '<table>' + rows + '</table>' +
          (im.matched_models ? '<div class="muted" style="font-size:11px;margin-top:4px">매칭 모델: ' + (im.matched_models || []).map(m => escapeHTML(m.model) + '(' + fmt(m.requests) + ')').join(', ') + '</div>' : '') +
          '<p class="muted" style="font-size:10px;margin-top:4px">' + escapeHTML(d.note || '') + '</p>';
      } catch (e) { out.innerHTML = '<span class="status error">' + escapeHTML(e.message) + '</span>'; }
    };
    window.csDryRun = async (id) => {
      const host = document.getElementById('cs-detail-' + id);
      if (host) host.innerHTML = '<span class="muted">dry-run...</span>';
      try {
        const d = await api('/admin/change-sets/' + encodeURIComponent(id) + '/dryrun', { method: 'POST', body: '{}' });
        const rows = (d.checks || []).map(c => '<tr><td>' + escapeHTML(c.kind) + ':' + escapeHTML(c.key || '') + '</td>' +
          '<td class="muted">' + escapeHTML(c.current != null ? String(c.current) : '-') + '</td>' +
          '<td>' + escapeHTML(c.proposed != null ? String(c.proposed) : '-') + '</td>' +
          '<td>' + (c.changed ? '<span class="status warn">변경</span>' : '<span class="muted">동일</span>') + (c.valid === false ? ' <span class="status error">' + escapeHTML(c.detail || '무효') + '</span>' : '') + (c.restart_required ? ' <span class="status warn" style="font-size:9px">재시작</span>' : '') + '</td></tr>').join('');
        if (host) host.innerHTML = '<div style="border:1px solid var(--border);border-radius:6px;padding:8px;margin:4px 0">' +
          '<div style="font-size:12px">변경 ' + (d.changed_count || 0) + ' · 무효 ' + (d.invalid_count || 0) + (d.restart_required ? ' · <span class="status warn">재시작 필요</span>' : '') + '</div>' +
          '<table><thead><tr><th>항목</th><th>현재</th><th>제안</th><th>상태</th></tr></thead><tbody>' + rows + '</tbody></table>' +
          '<p class="muted" style="font-size:10px;margin-top:4px">' + escapeHTML(d.note || '') + '</p></div>';
      } catch (e) { if (host) host.innerHTML = '<span class="status error">' + escapeHTML(e.message) + '</span>'; }
    };
    const csDo = async (id, action, confirmMsg) => {
      if (confirmMsg && !confirm(confirmMsg)) return;
      let note = '';
      if (action === 'approve' || action === 'submit') { note = prompt('메모(선택):', '') || ''; }
      try { await api('/admin/change-sets/' + encodeURIComponent(id) + '/' + action, { method: 'POST', body: JSON.stringify({ note }) }); await renderChangeSets(); }
      catch (e) { alert(e.message); }
    };
    window.csSubmit = (id) => csDo(id, 'submit');
    window.csApprove = (id) => csDo(id, 'approve');
    window.csApply = (id) => csDo(id, 'apply', '이 변경 세트를 적용할까요? 설정이 즉시 반영됩니다.');
    window.csRollback = (id) => csDo(id, 'rollback', '적용 전 값으로 롤백할까요?');
    window.csDelete = async (id) => { if (!confirm('삭제할까요?')) return; try { await api('/admin/change-sets/' + encodeURIComponent(id), { method: 'DELETE' }); await renderChangeSets(); } catch (e) { alert(e.message); } };

    // ---------- AI 업무 앱: Skill/Prompt Product/Text2SQL/MCP/모델 묶음 ----------
    async function renderWorkApps() {
      const view = document.getElementById('view');
      view.innerHTML = section('AI 업무 앱', '<div class="empty">불러오는 중...</div>');
      let d;
      try { d = await api('/admin/apps'); }
      catch (e) { view.innerHTML = section('AI 업무 앱', '<div class="card-body" style="padding:16px"><p class="muted">' + escapeHTML(e.message) + '</p></div>'); return; }
      const apps = d.apps || [];
      const kindLabel = { skill: 'Skill', prompt_product: '프롬프트상품', text2sql_report: 'SQL리포트', mcp_tool: 'MCP', model: '모델' };
      const appCards = apps.length ? apps.map(a => {
        const comps = (a.components || []).map(c => '<span class="status" style="font-size:9px">' + escapeHTML(kindLabel[c.kind] || c.kind) + ': ' + escapeHTML(c.ref) + '</span>').join(' ');
        // Onboarding readiness (mirrors the server publish gate's required items).
        const gaps = [];
        if (!a.title) gaps.push('title');
        if (!a.owner) gaps.push('owner');
        if (!(a.components || []).length) gaps.push('components');
        const readyBadge = gaps.length
          ? '<span class="status warn" style="font-size:9px" title="발행 필수 미충족: ' + escapeAttr(gaps.join(', ')) + '">온보딩 ' + gaps.length + '건</span>'
          : '<span class="status" style="font-size:9px" title="발행 준비 완료">온보딩 ✓</span>';
        return '<div style="border:1px solid var(--border);border-radius:8px;padding:10px;margin-bottom:8px">' +
          '<div style="display:flex;justify-content:space-between;align-items:center"><strong>' + escapeHTML(a.icon || '🧩') + ' ' + escapeHTML(a.title) + '</strong>' +
          '<span>' + readyBadge + ' ' + (a.status === 'active' ? '<span class="status">active</span>' : '<span class="status warn">' + escapeHTML(a.status) + '</span>') + '</span></div>' +
          (a.description ? '<div class="muted" style="font-size:12px;margin:4px 0">' + escapeHTML(a.description) + '</div>' : '') +
          '<div style="margin:4px 0">' + (comps || '<span class="muted" style="font-size:11px">컴포넌트 없음</span>') + '</div>' +
          '<div class="muted" style="font-size:11px">팀: ' + escapeHTML(a.allowed_teams || '전체') + ' · 역할: ' + escapeHTML(a.allowed_roles || '전체') + '</div>' +
          '<div style="margin-top:6px;display:flex;gap:4px;flex-wrap:wrap"><button type="button" class="secondary" style="font-size:11px" onclick="appValidate(\'' + escapeAttr(a.id) + '\')">검증</button>' +
          '<button type="button" class="secondary" style="font-size:11px" onclick="appRun(\'' + escapeAttr(a.id) + '\')">실행(플랜)</button>' +
          '<button type="button" class="secondary" style="font-size:11px" onclick="appPublish(\'' + escapeAttr(a.id) + '\')">발행</button>' +
          (a.status === 'active' ? '<button type="button" class="secondary" style="font-size:11px" onclick="appDeprecate(\'' + escapeAttr(a.id) + '\')">지원중단</button>' : '') +
          '<button type="button" class="secondary" style="font-size:11px" onclick="appVersions(\'' + escapeAttr(a.id) + '\')">버전</button>' +
          '<button type="button" class="secondary" style="font-size:11px" onclick="appPermissions(\'' + escapeAttr(a.id) + '\')">권한</button>' +
          '<button type="button" class="secondary" style="font-size:11px" onclick="appDelete(\'' + escapeAttr(a.id) + '\')">삭제</button></div>' +
          '<div id="app-validate-' + escapeAttr(a.id) + '" style="margin-top:6px"></div>' +
          '</div>';
      }).join('') : '<p class="muted">앱이 없습니다. 아래에서 새 앱을 만들어 Skill·리포트·MCP·모델을 묶어보세요.</p>';
      view.innerHTML = section('AI 업무 앱', '<p class="muted" style="font-size:12px">Skill·프롬프트 상품·Text2SQL 리포트·MCP 도구·추천 모델을 하나의 업무 앱으로 묶어 권한 있는 사용자에게 노출합니다.</p>') +
        card('앱 목록', '<div class="card-body">' + appCards + '</div>') +
        card('새 앱 만들기',
          '<div class="card-body">' +
          '<div style="display:flex;gap:6px;margin-bottom:6px"><input id="app-icon" placeholder="아이콘(이모지)" style="width:120px"><input id="app-title" placeholder="앱 제목" style="flex:1"></div>' +
          '<input id="app-desc" placeholder="설명" style="width:100%;margin-bottom:6px">' +
          '<div style="display:flex;gap:6px;margin-bottom:6px"><input id="app-teams" placeholder="허용 팀(쉼표, 비우면 전체)" style="flex:1"><input id="app-roles" placeholder="허용 역할(쉼표, 비우면 전체)" style="flex:1"></div>' +
          '<textarea id="app-components" placeholder=\'컴포넌트 JSON 배열, 예: [{"kind":"skill","ref":"code-review"},{"kind":"model","ref":"claude-opus-4-8"}]\' style="width:100%;height:64px"></textarea>' +
          '<div style="margin-top:6px"><button type="button" onclick="appCreate()">앱 생성</button></div>' +
          '<div id="app-create-out" style="margin-top:6px"></div>' +
          '</div>');
    }
    window.appCreate = async () => {
      const out = document.getElementById('app-create-out');
      const title = (document.getElementById('app-title').value || '').trim();
      if (!title) { if (out) out.innerHTML = '<span class="status error">제목 필수</span>'; return; }
      let components = [];
      const raw = (document.getElementById('app-components').value || '').trim();
      if (raw) { try { components = JSON.parse(raw); } catch (e) { if (out) out.innerHTML = '<span class="status error">컴포넌트 JSON 파싱 오류</span>'; return; } }
      const body = {
        title, icon: (document.getElementById('app-icon').value || '').trim(),
        description: (document.getElementById('app-desc').value || '').trim(),
        allowed_teams: (document.getElementById('app-teams').value || '').trim(),
        allowed_roles: (document.getElementById('app-roles').value || '').trim(),
        components,
      };
      try { await api('/admin/apps', { method: 'POST', body: JSON.stringify(body) }); await renderWorkApps(); }
      catch (e) { if (out) out.innerHTML = '<span class="status error">' + escapeHTML(e.message) + '</span>'; }
    };
    window.appValidate = async (id) => {
      const host = document.getElementById('app-validate-' + id);
      if (host) host.innerHTML = '<span class="muted">검증 중...</span>';
      try {
        const d = await api('/admin/apps/' + encodeURIComponent(id) + '/validate', { method: 'POST', body: '{}' });
        const checks = (d.checks || []).map(c => '<div style="font-size:11px">' + (c.resolved ? '<span class="status" style="font-size:9px">OK</span>' : '<span class="status error" style="font-size:9px">미해결</span>') + ' ' + escapeHTML(c.kind) + ':' + escapeHTML(c.ref) + ' <span class="muted">' + escapeHTML(c.detail || '') + '</span></div>').join('');
        const warns = (d.warnings || []).map(w => '<div class="status warn" style="font-size:10px">' + escapeHTML(w) + '</div>').join('');
        if (host) host.innerHTML = '<div style="border:1px solid var(--border);border-radius:6px;padding:6px">' +
          '<strong style="font-size:11px">검증: ' + (d.ok ? '<span class="status">통과</span>' : '<span class="status error">실패</span>') + '</strong>' +
          checks + (d.allowed_models && d.allowed_models.length ? '<div class="muted" style="font-size:11px">허용 모델: ' + escapeHTML(d.allowed_models.join(', ')) + '</div>' : '') + warns +
          '</div>';
      } catch (e) { if (host) host.innerHTML = '<span class="status error">' + escapeHTML(e.message) + '</span>'; }
    };
    window.appRun = async (id) => {
      const host = document.getElementById('app-validate-' + id);
      if (host) host.innerHTML = '<span class="muted">실행 플랜 생성 중...</span>';
      try {
        const d = await api('/v1/apps/' + encodeURIComponent(id) + '/run', { method: 'POST', body: '{}' });
        const steps = (d.plan || []).map((p, i) => '<div style="font-size:11px">' + (i + 1) + '. ' + (p.resolved ? '' : '<span class="status error" style="font-size:9px">미해결</span> ') +
          '<strong>' + escapeHTML(p.kind) + '</strong> ' + escapeHTML(p.ref || '') + ' <span class="muted">' + escapeHTML(p.hint || '') + (p.endpoint ? ' → ' + escapeHTML(p.endpoint) : '') + '</span></div>').join('');
        if (host) host.innerHTML = '<div style="border:1px solid var(--border);border-radius:6px;padding:8px"><strong style="font-size:11px">실행 플랜</strong>' + steps +
          '<p class="muted" style="font-size:10px;margin-top:4px">' + escapeHTML(d.note || '') + '</p></div>';
      } catch (e) { if (host) host.innerHTML = '<span class="status error">' + escapeHTML(e.message) + '</span>'; }
    };
    window.appDelete = async (id) => {
      if (!confirm('이 앱을 삭제할까요?')) return;
      try { await api('/admin/apps/' + encodeURIComponent(id), { method: 'DELETE' }); await renderWorkApps(); }
      catch (e) { alert(e.message); }
    };
    window.appPublish = async (id, force) => {
      const note = force ? '' : prompt('발행 메모(선택). 발행하면 현재 정의가 새 버전으로 저장되고 앱이 활성화됩니다.');
      if (!force && note === null) return;
      try {
        const path = '/admin/apps/' + encodeURIComponent(id) + '/publish' + (force ? '?force=1' : '');
        const r = await api(path, { method: 'POST', body: JSON.stringify({ note: note || '' }) });
        alert('발행됨 — 버전 v' + r.version);
        await renderWorkApps();
      } catch (e) {
        // Onboarding gate (HTTP 422): show the failed required items and offer a forced publish.
        let parsed = null;
        try { parsed = JSON.parse(e.message); } catch (_) {}
        if (parsed && parsed.error && parsed.error.code === 'onboarding_incomplete') {
          const items = (parsed.failed || []).map(c => '• ' + c.key + ' — ' + c.detail).join('\n');
          if (confirm('온보딩 필수 항목 미충족으로 발행이 거부되었습니다:\n\n' + items + '\n\n그래도 강제로 발행할까요?')) {
            await window.appPublish(id, true);
          }
          return;
        }
        alert('발행 실패: ' + e.message);
      }
    };
    window.appDeprecate = async (id) => {
      if (!confirm('이 앱을 지원중단(숨김) 처리할까요? 사용자에게 더 이상 노출되지 않습니다.')) return;
      try { await api('/admin/apps/' + encodeURIComponent(id) + '/deprecate', { method: 'POST', body: '{}' }); await renderWorkApps(); }
      catch (e) { alert('지원중단 실패: ' + e.message); }
    };
    window.appVersions = async (id) => {
      try {
        const d = await api('/admin/apps/' + encodeURIComponent(id) + '/versions');
        const vs = d.versions || [];
        const rows = vs.length
          ? vs.map(v => '<tr><td>v' + v.version + '</td><td class="muted">' + escapeHTML(v.published_by || '') + '</td><td class="muted">' + ago(v.published_at) + '</td><td>' + (v.components || []).length + '개</td><td class="muted" style="font-size:11px">' + escapeHTML(v.note || '') + '</td></tr>').join('')
          : '<tr><td colspan="5" class="muted">발행된 버전이 없습니다.</td></tr>';
        openModal('버전 이력',
          '<table><thead><tr><th>버전</th><th>발행자</th><th>발행</th><th>컴포넌트</th><th>메모</th></tr></thead><tbody>' + rows + '</tbody></table>');
      } catch (e) { openModal('버전 조회 오류', '<div class="error-line">' + escapeHTML(e.message) + '</div>'); }
    };
    window.appPermissions = async (id) => {
      const render = (perms) => {
        const rows = (perms || []).length
          ? perms.map(p => '<tr><td>' + escapeHTML(p.subject_type) + '</td><td><code>' + escapeHTML(p.subject_id) + '</code></td><td class="muted">' + escapeHTML(p.granted_by || '') + '</td><td><button type="button" class="danger" style="font-size:11px" onclick="appPermRevoke(\'' + escapeAttr(id) + '\',\'' + escapeAttr(p.subject_type) + '\',\'' + escapeAttr(p.subject_id) + '\')">해제</button></td></tr>').join('')
          : '<tr><td colspan="4" class="muted">명시적 권한이 없습니다(팀/역할 규칙만 적용).</td></tr>';
        openModal('앱 명시 권한 — 특정 사용자/팀 공유',
          '<p class="muted" style="font-size:12px">팀/역할 규칙에 더해 특정 사용자(user) 또는 팀(team)에게 이 앱을 직접 허용합니다.</p>' +
          '<table><thead><tr><th>유형</th><th>대상</th><th>부여자</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>' +
          '<div style="margin-top:10px;display:flex;gap:6px;align-items:center">' +
          '<select id="app-perm-type"><option value="user">user</option><option value="team">team</option></select>' +
          '<input id="app-perm-id" placeholder="user_id 또는 team id" style="flex:1">' +
          '<button type="button" onclick="appPermGrant(\'' + escapeAttr(id) + '\')">추가</button></div>');
      };
      try { const d = await api('/admin/apps/' + encodeURIComponent(id) + '/permissions'); render(d.permissions || []); }
      catch (e) { openModal('권한 조회 오류', '<div class="error-line">' + escapeHTML(e.message) + '</div>'); }
    };
    window.appPermGrant = async (id) => {
      const t = (document.getElementById('app-perm-type') || {}).value || 'user';
      const sid = ((document.getElementById('app-perm-id') || {}).value || '').trim();
      if (!sid) { alert('대상 id를 입력하세요.'); return; }
      try { await api('/admin/apps/' + encodeURIComponent(id) + '/permissions', { method: 'POST', body: JSON.stringify({ subject_type: t, subject_id: sid }) }); appPermissions(id); }
      catch (e) { alert('권한 추가 실패: ' + e.message); }
    };
    window.appPermRevoke = async (id, t, sid) => {
      try { await api('/admin/apps/' + encodeURIComponent(id) + '/permissions?subject_type=' + encodeURIComponent(t) + '&subject_id=' + encodeURIComponent(sid), { method: 'DELETE' }); appPermissions(id); }
      catch (e) { alert('권한 해제 실패: ' + e.message); }
    };

    // ---------- Prompt Lab: experiments + test cases + rubrics/contracts ----------
    async function renderPromptLab(params) {
      const view = document.getElementById('view');
      view.innerHTML = section('Prompt Lab', '<div class="empty">불러오는 중...</div>');
      const expId = (params && params.get && params.get('exp')) || '';
      if (expId) { await plRenderExperiment(expId); return; }
      let d, contracts, rubrics;
      try {
        [d, contracts, rubrics] = await Promise.all([
          api('/admin/prompt-lab/experiments'),
          api('/admin/prompt-lab/contracts').catch(() => ({ contracts: [] })),
          api('/admin/prompt-lab/rubrics').catch(() => ({ rubrics: [] })),
        ]);
      } catch (e) {
        view.innerHTML = section('Prompt Lab', '<div class="card-body" style="padding:16px"><p class="muted">불러올 수 없습니다: ' + escapeHTML(e.message) + '</p></div>');
        return;
      }
      window.__plContracts = contracts.contracts || [];
      window.__plRubrics = rubrics.rubrics || [];
      const exps = d.experiments || [];
      const expRows = exps.length
        ? exps.map(e => '<tr>' +
            '<td><a href="#/prompt-lab?exp=' + encodeURIComponent(e.id) + '">' + escapeHTML(e.title) + '</a>' + (e.status === 'archived' ? ' <span class="status warn" style="font-size:9px">archived</span>' : '') + '</td>' +
            '<td class="muted">' + escapeHTML(e.team || '-') + '</td>' +
            '<td class="muted">' + escapeHTML(e.owner || '-') + '</td>' +
            '<td class="muted">' + ago(e.updated_at) + '</td>' +
            '</tr>').join('')
        : '<tr><td colspan="4" class="muted">실험이 없습니다. 새 실험을 만들어 테스트케이스를 모아보세요.</td></tr>';
      view.innerHTML = section('Prompt Lab', '<p class="muted" style="font-size:12px">프롬프트 테스트를 실험·테스트케이스로 저장하고, 여러 모델로 반복 실행해 품질·비용·지연·출력계약 통과를 비교합니다.</p>') +
        card('실험 (Experiments)',
          '<div class="card-body">' +
          '<div style="display:flex;gap:6px;margin-bottom:8px"><input id="pl-exp-title" placeholder="새 실험 제목" style="flex:1"><input id="pl-exp-team" placeholder="팀(선택)" style="width:120px"><button type="button" onclick="plCreateExperiment()">실험 생성</button></div>' +
          '<table><thead><tr><th>제목</th><th>팀</th><th>소유자</th><th>수정</th></tr></thead><tbody>' + expRows + '</tbody></table>' +
          '</div>') +
        card('평가 자산 (Rubric / 출력계약)',
          '<div class="card-body" style="display:flex;gap:24px;flex-wrap:wrap">' +
          '<div style="flex:1;min-width:280px"><strong>출력계약</strong>' +
            '<div style="display:flex;gap:4px;margin:6px 0"><input id="pl-ctr-name" placeholder="이름" style="flex:1">' +
            '<select id="pl-ctr-type"><option value="json">JSON</option><option value="json_schema">JSON Schema</option><option value="markdown_table">MD 표</option><option value="sql">SQL(읽기전용)</option><option value="regex">정규식</option></select></div>' +
            '<textarea id="pl-ctr-schema" placeholder="schema_json (json_schema: {&quot;required&quot;:[..],&quot;properties&quot;:{..}}, regex: 패턴)" style="width:100%;height:48px"></textarea>' +
            '<label style="font-size:11px"><input type="checkbox" id="pl-ctr-strict"> strict (위반 시 verdict 강등)</label>' +
            '<div style="margin-top:4px"><button type="button" onclick="plCreateContract()">계약 추가</button></div>' +
            '<div id="pl-ctr-list" style="margin-top:6px">' + plContractListHTML() + '</div>' +
          '</div>' +
          '<div style="flex:1;min-width:240px"><strong>Rubric</strong>' +
            '<div style="display:flex;gap:4px;margin:6px 0"><input id="pl-rub-name" placeholder="이름" style="flex:1"><button type="button" onclick="plCreateRubric()">추가</button></div>' +
            '<div id="pl-rub-list">' + (window.__plRubrics.length ? window.__plRubrics.map(rb => '<div style="font-size:12px">• ' + escapeHTML(rb.name) + '</div>').join('') : '<span class="muted" style="font-size:12px">없음</span>') + '</div>' +
          '</div>' +
          '</div>');
    }
    function plContractListHTML() {
      const cs = window.__plContracts || [];
      return cs.length ? cs.map(c => '<div style="font-size:12px">• ' + escapeHTML(c.name) + ' <span class="muted">(' + escapeHTML(c.type) + (c.strict ? ', strict' : '') + ')</span></div>').join('') : '<span class="muted" style="font-size:12px">없음</span>';
    }
    window.plCreateExperiment = async () => {
      const title = (document.getElementById('pl-exp-title').value || '').trim();
      if (!title) return;
      const team = (document.getElementById('pl-exp-team').value || '').trim();
      try { await api('/admin/prompt-lab/experiments', { method: 'POST', body: JSON.stringify({ title, team }) }); await renderPromptLab(); }
      catch (e) { alert(e.message); }
    };
    window.plCreateContract = async () => {
      const name = (document.getElementById('pl-ctr-name').value || '').trim();
      if (!name) return;
      const body = { name, type: document.getElementById('pl-ctr-type').value, schema_json: document.getElementById('pl-ctr-schema').value, strict: document.getElementById('pl-ctr-strict').checked };
      try { await api('/admin/prompt-lab/contracts', { method: 'POST', body: JSON.stringify(body) }); await renderPromptLab(); }
      catch (e) { alert(e.message); }
    };
    window.plCreateRubric = async () => {
      const name = (document.getElementById('pl-rub-name').value || '').trim();
      if (!name) return;
      try { await api('/admin/prompt-lab/rubrics', { method: 'POST', body: JSON.stringify({ name, criteria: {} }) }); await renderPromptLab(); }
      catch (e) { alert(e.message); }
    };

    async function plRenderExperiment(expId) {
      const view = document.getElementById('view');
      let d;
      try { d = await api('/admin/prompt-lab/experiments/' + encodeURIComponent(expId)); }
      catch (e) { view.innerHTML = section('Prompt Lab', '<div class="card-body"><p class="muted">' + escapeHTML(e.message) + '</p></div>'); return; }
      if (!window.__plContracts) { try { window.__plContracts = (await api('/admin/prompt-lab/contracts')).contracts || []; } catch (e) { window.__plContracts = []; } }
      const exp = d.experiment || {};
      const cases = d.test_cases || [];
      const ctrOpts = '<option value="">계약 없음</option>' + (window.__plContracts || []).map(c => '<option value="' + escapeAttr(c.id) + '">' + escapeHTML(c.name) + '</option>').join('');
      const caseRows = cases.length
        ? cases.map(tc => '<tr>' +
            '<td>' + escapeHTML(tc.name) + '</td>' +
            '<td class="muted" style="font-size:11px">' + escapeHTML((JSON.parse(tc.models_json || '[]') || []).join(', ') || '-') + '</td>' +
            '<td><button type="button" class="secondary" style="font-size:11px" onclick="plRunCase(\'' + escapeAttr(tc.id) + '\')">실행</button> ' +
            '<button type="button" class="secondary" style="font-size:11px" onclick="plDeleteCase(\'' + escapeAttr(tc.id) + '\',\'' + escapeAttr(expId) + '\')">삭제</button></td>' +
            '</tr><tr><td colspan="3"><div id="pl-run-' + escapeAttr(tc.id) + '"></div></td></tr>').join('')
        : '<tr><td colspan="3" class="muted">테스트케이스가 없습니다.</td></tr>';
      view.innerHTML = section('Prompt Lab · ' + escapeHTML(exp.title || ''), '<a href="#/prompt-lab" class="muted">← 실험 목록</a>') +
        card('테스트케이스',
          '<div class="card-body"><table><thead><tr><th>이름</th><th>모델</th><th>액션</th></tr></thead><tbody>' + caseRows + '</tbody></table></div>') +
        card('새 테스트케이스',
          '<div class="card-body">' +
          '<div style="display:flex;gap:6px;margin-bottom:6px"><input id="pl-tc-name" placeholder="이름" style="flex:1">' +
          '<input id="pl-tc-models" placeholder="모델 (쉼표 구분, 예: gpt-4o, claude-opus-4-8)" style="flex:2">' +
          '<select id="pl-tc-contract">' + ctrOpts + '</select></div>' +
          '<textarea id="pl-tc-system" placeholder="system 프롬프트(선택)" style="width:100%;height:48px"></textarea>' +
          '<textarea id="pl-tc-user" placeholder="user 프롬프트" style="width:100%;height:72px;margin-top:4px"></textarea>' +
          '<div style="margin-top:6px"><button type="button" onclick="plCreateCase(\'' + escapeAttr(expId) + '\')">테스트케이스 저장</button></div>' +
          '</div>');
    }
    window.plCreateCase = async (expId) => {
      const name = (document.getElementById('pl-tc-name').value || '').trim();
      const user = (document.getElementById('pl-tc-user').value || '').trim();
      if (!name || !user) { alert('이름과 user 프롬프트는 필수입니다.'); return; }
      const sys = (document.getElementById('pl-tc-system').value || '').trim();
      const messages = [];
      if (sys) messages.push({ role: 'system', content: sys });
      messages.push({ role: 'user', content: user });
      const models = (document.getElementById('pl-tc-models').value || '').split(',').map(x => x.trim()).filter(Boolean);
      const body = { experiment_id: expId, name, messages, models, contract_id: document.getElementById('pl-tc-contract').value };
      try { await api('/admin/prompt-lab/test-cases', { method: 'POST', body: JSON.stringify(body) }); await plRenderExperiment(expId); }
      catch (e) { alert(e.message); }
    };
    window.plDeleteCase = async (id, expId) => {
      if (!confirm('이 테스트케이스를 삭제할까요?')) return;
      try { await api('/admin/prompt-lab/test-cases/' + encodeURIComponent(id), { method: 'DELETE' }); await plRenderExperiment(expId); }
      catch (e) { alert(e.message); }
    };
    window.plRunCase = async (id) => {
      const host = document.getElementById('pl-run-' + id);
      if (host) host.innerHTML = '<div class="empty">실행 중...</div>';
      try {
        const d = await api('/admin/prompt-lab/test-cases/' + encodeURIComponent(id) + '/run', { method: 'POST', body: '{}' });
        const won = (v) => '₩' + fmt(Math.round(v || 0));
        const vcls = (v) => v === 'pass' ? '' : (v === 'warn' ? 'warn' : 'error');
        const rows = (d.results || []).map(x =>
          '<tr><td>' + escapeHTML(x.model) + (x.model === d.best_model ? ' <span class="status" style="font-size:9px">BEST</span>' : '') + '</td>' +
          '<td><span class="status ' + vcls(x.verdict) + '">' + (x.score||0).toFixed(1) + '</span></td>' +
          '<td>' + (x.contract_pass === true ? '<span class="status">통과</span>' : (x.contract_pass === false ? '<span class="status error">실패</span>' : '-')) + '</td>' +
          '<td>' + fmt(x.latency_ms) + 'ms</td><td>' + won(x.cost_krw) + '</td></tr>').join('');
        const hist = (d.history || []).slice(0, 8).map(h => '<span class="muted" style="font-size:11px">' + ago(h.created_at) + ': ' + (h.avg_score||0).toFixed(1) + '점' + (h.best_model ? ' · ' + escapeHTML(h.best_model) : '') + '</span>').join(' · ');
        if (host) host.innerHTML = '<div style="border:1px solid var(--border);border-radius:6px;padding:8px;margin:4px 0">' +
          '<div style="font-size:12px;margin-bottom:4px">평균 ' + (d.avg_score||0).toFixed(1) + '점 · best ' + escapeHTML(d.best_model||'-') + (d.contract_applied ? ' · 계약통과 ' + d.contract_pass + '/' + d.model_count : '') + ' · <a href="#/chat-test">run ' + escapeHTML(d.run_id) + '</a></div>' +
          '<table><thead><tr><th>모델</th><th>점수</th><th>계약</th><th>지연</th><th>비용</th></tr></thead><tbody>' + rows + '</tbody></table>' +
          (hist ? '<div style="margin-top:4px">회귀 이력: ' + hist + '</div>' : '') +
          '</div>';
      } catch (e) { if (host) host.innerHTML = '<span class="status error">' + escapeHTML(e.message) + '</span>'; }
    };

    // ---------- Chat completion test console ----------
    async function renderChatTest(initial) {
      const catalog = await api('/admin/chat-test/targets');
      const targets = catalog.targets || [];
      const defaults = catalog.defaults || {};
      window.chatTestTargets = targets;
      const selectedTarget = initial ? (initial.get('target') || '') : '';
      const selectedModel = initial ? (initial.get('model') || defaults.model || 'vibe/auto') : (defaults.model || 'vibe/auto');
      const targetOptions = chatTestTargetOptions(targets, selectedTarget);
      const providerOptions = chatTestProviderOptions(targets, initial ? (initial.get('provider') || '') : '');
      const kpis = '<div class="kpis">' +
        kpi('테스트 대상', fmt(targets.length)) +
        kpi('라우팅', fmt(targets.filter(t => String(t.kind || '').startsWith('routing')).length)) +
        kpi('Provider 패턴', fmt(targets.filter(t => String(t.kind || '').startsWith('provider')).length)) +
        kpi('MCP route', fmt(targets.filter(t => String(t.kind || '').startsWith('mcp_')).length)) +
      '</div>';
      const form =
        '<form id="chat-test-form" autocomplete="off" class="ct-form">' +
          '<div class="ct-group">' +
            '<div class="ct-glabel">연결 대상</div>' +
            '<div class="ct-row">' +
              '<label class="ct-field"><span>대상</span><select id="chat-target">' + targetOptions + '</select></label>' +
              '<label class="ct-field"><span>Provider</span><select id="chat-provider">' + providerOptions + '</select></label>' +
            '</div>' +
            '<div id="chat-target-detail" class="ct-target-detail"></div>' +
          '</div>' +
          '<div class="ct-group">' +
            '<div class="ct-glabel">모델 파라미터</div>' +
            '<div class="ct-field-wide"><span>Model</span><input id="chat-model" value="' + escapeHTML(selectedModel) + '" placeholder="vibe/auto"></div>' +
            '<div class="ct-row">' +
              '<label class="ct-field"><span>Max tokens</span><input id="chat-max-tokens" type="number" min="1" max="131072" value="' + Number(defaults.max_tokens || 4096) + '"></label>' +
              '<label class="ct-field"><span>Temperature</span><input id="chat-temperature" type="number" step="0.1" min="0" max="2" value="' + Number(defaults.temperature || 0) + '"></label>' +
            '</div>' +
          '</div>' +
          '<div class="ct-group">' +
            '<div class="ct-glabel">인증<span class="ct-glabel-note">실제 proxy key 검증 시만 입력</span></div>' +
            '<div class="ct-row">' +
              '<label class="ct-field"><span>API Key ID</span><input id="chat-api-key-id" value="' + escapeHTML(initial ? (initial.get('api_key_id') || '') : '') + '" placeholder="정책 시뮬레이션"></label>' +
              '<label class="ct-field"><span>Proxy Bearer 원문</span><input id="chat-bearer" type="password" placeholder="실제 proxy key 검증 시에만 입력"></label>' +
            '</div>' +
          '</div>' +
          '<div class="ct-group">' +
            '<div class="ct-glabel">Prompt</div>' +
            '<textarea id="chat-prompt" class="ct-prompt" rows="7">' + escapeHTML(defaults.prompt || 'Reply with pong in one short sentence.') + '</textarea>' +
          '</div>' +
          '<div class="ct-footer">' +
            '<div class="ct-options">' +
              '<label class="ct-check"><input type="checkbox" id="chat-no-route"> X-Proxy-No-Route</label>' +
              '<label class="ct-check"><input type="checkbox" id="chat-include-preview" checked> preview 포함</label>' +
            '</div>' +
            '<div class="ct-btns">' +
              '<button type="button" class="secondary" id="chat-preview">라우팅 미리보기</button>' +
              '<button type="button" class="secondary" id="chat-mcp-route" disabled title="MCP 대상을 선택하면 활성화됩니다">MCP 라우팅 테스트</button>' +
              '<button type="submit">Chat 호출</button>' +
            '</div>' +
          '</div>' +
        '</form>';
      const multiPanel =
        '<div class="ct-group">' +
          '<div class="ct-glabel">비교 모델 <span class="ct-glabel-note">한 줄에 하나, 형식: model 또는 model:provider (최대 5개)</span></div>' +
          '<textarea id="mm-models" class="ct-prompt" rows="4" placeholder="gpt-4.1-mini:openai\nclaude-sonnet:anthropic\ngemini-flash:google">' + escapeHTML((defaults.model && defaults.model !== 'vibe/auto') ? defaults.model : 'vibe/auto') + '</textarea>' +
        '</div>' +
        '<div class="ct-group">' +
          '<div class="ct-glabel">System / User Prompt</div>' +
          '<textarea id="mm-system" class="ct-prompt" rows="2" placeholder="공통 system 메시지 (선택)"></textarea>' +
          '<textarea id="mm-user" class="ct-prompt" rows="5" placeholder="비교할 user 프롬프트">' + escapeHTML(defaults.prompt || '아래 코드의 문제점과 개선 방향을 알려줘.') + '</textarea>' +
        '</div>' +
        '<div class="ct-footer"><div class="ct-row">' +
          '<label class="ct-field"><span>Max tokens</span><input id="mm-max-tokens" type="number" min="1" max="131072" value="' + Number(defaults.max_tokens || 4096) + '"></label>' +
          '<label class="ct-field"><span>Temperature</span><input id="mm-temperature" type="number" step="0.1" min="0" max="2" value="' + Number(defaults.temperature || 0.2) + '"></label>' +
          '</div><div class="ct-btns"><button type="button" class="secondary" id="mm-predict">예상 비용</button><button type="button" class="secondary" id="mm-stream">스트리밍 비교</button><button type="button" id="mm-run">멀티 실행</button></div>' +
        '</div>' +
        '<div id="mm-predict-out" class="muted" style="font-size:12px;margin-top:6px"></div>' +
        '<div id="mm-results" style="margin-top:10px"></div>';
      document.getElementById('view').innerHTML =
        section('Chat Completion 테스트', kpis + form) +
        section('멀티 모델 응답 비교', multiPanel) +
        '<div id="mm-leaderboard"></div><div id="mm-coderiskboard"></div><div id="mm-tags-panel"></div>' +
        section('대상 카탈로그', chatTestTargetTable(targets));

      mmLoadLeaderboard();
      mmLoadCodeRiskBoard();

      mmRenderTagEditor();
      document.getElementById('mm-run').addEventListener('click', runMultiModelCompare);
      document.getElementById('mm-predict').addEventListener('click', predictMultiModelCost);
      document.getElementById('mm-stream').addEventListener('click', runMultiModelStream);

      const targetSelect = document.getElementById('chat-target');
      const targetDetail = document.getElementById('chat-target-detail');
      const mcpRouteBtn = document.getElementById('chat-mcp-route');
      const applySelectedTarget = () => {
        const opt = targetSelect.selectedOptions[0];
        if (!opt) return;
        const model = opt.getAttribute('data-model') || '';
        const provider = opt.getAttribute('data-provider') || '';
        const kind = opt.getAttribute('data-kind') || '';
        const label = opt.getAttribute('data-label') || '';
        if (model) document.getElementById('chat-model').value = model;
        if (provider) document.getElementById('chat-provider').value = provider;
        const isMCP = kind.startsWith('mcp_');
        window.chatTestSelected = (window.chatTestTargets || []).find(t => t.id === targetSelect.value) || null;
        if (targetDetail) targetDetail.innerHTML = chatTestTargetDetail(window.chatTestSelected);
        if (mcpRouteBtn) mcpRouteBtn.disabled = !isMCP;
        if (isMCP) {
          document.getElementById('chat-prompt').value =
            'Test this MCP route through chat completion. Route: ' + label + '\\nReturn the selected route, whether a tool call would be appropriate, and one safe sample request.';
        }
      };
      targetSelect.addEventListener('change', applySelectedTarget);
      applySelectedTarget();

      document.querySelectorAll('[data-chat-target-id]').forEach(row => {
        row.addEventListener('click', () => {
          const id = row.getAttribute('data-chat-target-id');
          targetSelect.value = id;
          applySelectedTarget();
          document.getElementById('chat-test-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
      });

      document.getElementById('chat-preview').addEventListener('click', async () => {
        openModal('라우팅 미리보기', '<div class="empty">미리보기 중...</div>');
        try {
          const payload = chatTestPreviewPayload();
          const preview = await api('/admin/routing/preview', { method: 'POST', body: JSON.stringify(payload) });
          openModal('라우팅 미리보기 — ' + (payload.model || ''), '<div class="card-body">' + renderChatTestPreview(preview) + '</div>');
        } catch (err) {
          openModal('라우팅 미리보기 오류', '<div class="error-line">' + escapeHTML(err.message) + '</div>');
        }
      });

      if (mcpRouteBtn) {
        mcpRouteBtn.addEventListener('click', () => runMCPRoutingTestFromConsole(window.chatTestSelected));
      }

      document.getElementById('chat-test-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const payload = chatTestPayload(true);
        const submitBtn = e.submitter || document.querySelector('#chat-test-form button[type="submit"]');
        const prevLabel = submitBtn ? submitBtn.textContent : '';
        if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = '호출 중…'; }
        try {
          await streamChatTest(payload);
        } finally {
          if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = prevLabel; }
        }
      });
      makeSortable('#view', 'chat-test');
    }
    // ---------- Multi-turn chat popup (conversation + debug rail) ----------
    // window.chatSession = { messages, model, config, turn, streaming }

    function openChatStreamPopup(model) {
      window.chatSession = { messages: [], model: model || 'vibe/auto', config: {}, turn: -1, streaming: false };
      const inputRow =
        '<div class="ct-input-row">' +
          '<textarea id="ct-followup" class="ct-followup-ta" placeholder="후속 질문… (Enter 전송, Shift+Enter 줄바꿈)" disabled></textarea>' +
          '<button type="button" id="ct-send" onclick="sendChatFollowup()" disabled>전송</button>' +
        '</div>';
      openModal('Chat — ' + escapeHTML(model || 'vibe/auto'),
        '<div class="chat-pop">' +
          '<div class="chat-stream"><div class="chat-messages" id="ct-messages"></div>' + inputRow + '</div>' +
          '<div class="chat-debug"><div id="ct-debug"><div class="empty">스트리밍 중…</div></div></div>' +
        '</div>', null, { wide: true });
      setTimeout(() => {
        const ta = document.getElementById('ct-followup');
        if (ta) ta.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChatFollowup(); } });
      }, 0);
    }
    function appendChatUserBubble(text) {
      const msgs = document.getElementById('ct-messages');
      if (!msgs) return;
      const el = document.createElement('div');
      el.className = 'chat-msg user';
      el.innerHTML = '<div class="who">USER</div><div class="chat-bubble" style="white-space:pre-wrap">' + escapeHTML(text || '') + '</div>';
      msgs.appendChild(el);
      msgs.scrollTop = msgs.scrollHeight;
    }
    function appendChatAssistantBubble(turn) {
      const msgs = document.getElementById('ct-messages');
      if (!msgs) return;
      const r = document.createElement('div');
      r.className = 'chat-msg assistant'; r.id = 'ct-reasoning-msg-' + turn; r.style.display = 'none';
      r.innerHTML = '<div class="who">REASONING (추론)</div><div class="chat-bubble" id="ct-reasoning-' + turn + '" style="white-space:pre-wrap;opacity:.8;font-size:13px"></div>';
      msgs.appendChild(r);
      const a = document.createElement('div');
      a.className = 'chat-msg assistant';
      a.innerHTML = '<div class="who">ASSISTANT <span class="muted" id="ct-finish-' + turn + '"></span></div><div class="chat-bubble"><div id="ct-answer-' + turn + '" class="markdown-view"><span class="muted">호출 중…<span class="ct-caret">▋</span></span></div></div>';
      msgs.appendChild(a);
      msgs.scrollTop = msgs.scrollHeight;
    }
    function sendChatFollowup() {
      const sess = window.chatSession;
      if (!sess || sess.streaming) return;
      const ta = document.getElementById('ct-followup');
      const btn = document.getElementById('ct-send');
      if (!ta) return;
      const text = ta.value.trim();
      if (!text) return;
      ta.value = ''; ta.disabled = true;
      if (btn) btn.disabled = true;
      sess.messages.push({ role: 'user', content: text });
      sess.turn++;
      appendChatUserBubble(text);
      doStreamTurn(sess.turn, sess);
    }
    // Initial call: build session and open popup.
    async function streamChatTest(payload) {
      const initialText = (payload.prompt || '').trim() || 'Reply with pong in one short sentence.';
      openChatStreamPopup(payload.model);
      const sess = window.chatSession;
      sess.config = {
        max_tokens: payload.max_tokens,
        temperature: payload.temperature,
        api_key_id: payload.api_key_id,
        bearer_token: payload.bearer_token,
        provider: payload.provider,
        no_route: payload.no_route,
        target_id: payload.target_id,
        include_preview: payload.include_preview,
      };
      sess.messages = [{ role: 'user', content: initialText }];
      sess.turn = 0;
      appendChatUserBubble(initialText);
      await doStreamTurn(0, sess);
    }
    // Core streaming engine — reused for every turn including follow-ups.
    async function doStreamTurn(turn, sess) {
      sess.streaming = true;
      appendChatAssistantBubble(turn);
      const previewPayload = { model: sess.model, messages: sess.messages, provider: sess.config.provider || '', no_route: !!sess.config.no_route };
      const previewPromise = sess.config.include_preview
        ? api('/admin/routing/preview', { method: 'POST', body: JSON.stringify(previewPayload) }).catch(() => null)
        : Promise.resolve(null);
      const payload = { model: sess.model, messages: sess.messages, max_tokens: sess.config.max_tokens,
        temperature: sess.config.temperature, api_key_id: sess.config.api_key_id,
        bearer_token: sess.config.bearer_token, provider: sess.config.provider,
        no_route: sess.config.no_route, target_id: sess.config.target_id };
      const started = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      let answer = '', reasoning = '', finish = '', usage = null, raw = '', mcpStats = null;
      let renderQueued = false;
      const ansEl = () => document.getElementById('ct-answer-' + turn);
      const reasonEl = () => document.getElementById('ct-reasoning-' + turn);
      const reasonMsg = () => document.getElementById('ct-reasoning-msg-' + turn);
      const msgsEl = () => document.getElementById('ct-messages');
      const paint = () => {
        renderQueued = false;
        const a = ansEl();
        if (a) a.innerHTML = answer ? renderMarkdown(answer) + '<span class="ct-caret">▋</span>' : '<span class="muted">…<span class="ct-caret">▋</span></span>';
        if (reasoning) {
          const rm = reasonMsg(), re = reasonEl();
          if (rm) rm.style.display = '';
          if (re) re.textContent = reasoning;
        }
        const m = msgsEl(); if (m) m.scrollTop = m.scrollHeight;
      };
      const queuePaint = () => { if (!renderQueued) { renderQueued = true; requestAnimationFrame(paint); } };
      let res;
      try {
        const reqHeaders = headers();
        reqHeaders['Content-Type'] = 'application/json';
        reqHeaders['Accept'] = 'text/event-stream';
        res = await fetch('/admin/chat-test/stream', { method: 'POST', headers: reqHeaders, body: JSON.stringify(payload) });
      } catch (err) {
        finalizeChatStream({ error: err.message, payload, started, turn, answer, sess });
        return;
      }
      const ctype = res.headers.get('Content-Type') || '';
      // Pipeline blocked the request before streaming: body is a JSON error/result, not SSE.
      if (!res.body || ctype.indexOf('text/event-stream') < 0) {
        const text = await res.text();
        raw = text;
        let parsed = null;
        try { parsed = JSON.parse(text); } catch (e) {}
        if (parsed && parsed.choices && parsed.choices[0]) {
          const m = parsed.choices[0].message || {};
          answer = (typeof m.content === 'string') ? m.content : (parsed.choices[0].text || '');
          reasoning = m.reasoning_content || m.reasoning || '';
          finish = parsed.choices[0].finish_reason || '';
          usage = parsed.usage || null;
          paint();
          finalizeChatStream({ res, payload, started, finish, usage, raw, previewPromise, turn, answer, sess });
        } else {
          const msg = (parsed && parsed.error && parsed.error.message) ? parsed.error.message : (text || ('HTTP ' + res.status));
          finalizeChatStream({ res, payload, started, error: msg, raw, previewPromise, turn, answer, sess });
        }
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = decoder.decode(value, { stream: true });
          raw += text;
          buffer += text;
          let nl;
          while ((nl = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (!line || line.indexOf('data:') !== 0) continue;
            const data = line.slice(5).trim();
            if (data === '[DONE]') continue;
            let chunk;
            try { chunk = JSON.parse(data); } catch (e) { continue; }
            const choices = chunk.choices || [];
            for (const c of choices) {
              const d = c.delta || c.message || {};
              if (typeof d.content === 'string') answer += d.content;
              else if (Array.isArray(d.content)) answer += d.content.map(x => (x && x.text) || '').join('');
              const rc = d.reasoning_content || d.reasoning;
              if (typeof rc === 'string') reasoning += rc;
              if (c.finish_reason) finish = c.finish_reason;
            }
            if (chunk.usage) usage = chunk.usage;
            if (chunk.x_mcp) mcpStats = chunk.x_mcp;
            queuePaint();
          }
        }
      } catch (err) {
        finalizeChatStream({ res, payload, started, error: err.message, finish, usage, raw, previewPromise, turn, answer, sess, mcpStats });
        return;
      }
      paint();
      finalizeChatStream({ res, payload, started, finish, usage, raw, previewPromise, turn, answer, sess, mcpStats });
    }
    async function finalizeChatStream(s) {
      const turn = s.turn || 0;
      const latency = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - (s.started || 0));
      const a = document.getElementById('ct-answer-' + turn);
      if (a) {
        const hasText = a.textContent && a.textContent.replace('▋', '').trim();
        if (s.error && !hasText) {
          const msg = a.closest('.chat-msg');
          if (msg) msg.classList.add('error');
          a.innerHTML = '<span>' + escapeHTML(s.error) + '</span>';
        } else if (!hasText) {
          a.innerHTML = '<span class="muted">(빈 응답 — finish_reason=' + escapeHTML(s.finish || '') + ', max tokens를 늘려보세요)</span>';
        } else {
          a.innerHTML = a.innerHTML.replace(/<span class="ct-caret">▋<\/span>\s*$/, '');
        }
      }
      const fin = document.getElementById('ct-finish-' + turn);
      if (fin && s.finish) fin.textContent = '· ' + s.finish;
      const headersObj = {};
      if (s.res && s.res.headers) {
        s.res.headers.forEach((v, k) => {
          const lower = k.toLowerCase();
          if (lower.indexOf('x-') === 0 || lower === 'content-type') headersObj[k] = v;
        });
      }
      let preview = null;
      if (s.previewPromise) { try { preview = await s.previewPromise; } catch (e) {} }
      const debug = document.getElementById('ct-debug');
      if (debug) {
        debug.innerHTML = renderChatStreamDebug({
          status: s.res ? s.res.status : 0,
          ok: s.res ? s.res.ok : false,
          latency_ms: latency,
          model: s.payload ? s.payload.model : '',
          provider: s.payload ? s.payload.provider : '',
          headers: headersObj,
          preview: preview,
          usage: s.usage,
          mcp: s.mcpStats,
          raw: s.raw || '',
          error: s.error,
        });
        // 코드 검증 메타: 응답에 코드블록이 있으면 서버 게이트(/admin/code-verify)로 위험도·발견을 표시.
        if (s.answer && !s.error) renderChatCodeVerify(debug, s.answer);
      }
      // Append assistant answer to conversation history, then enable follow-up.
      const sess = s.sess || window.chatSession;
      if (sess) {
        if (s.answer && !s.error) sess.messages.push({ role: 'assistant', content: s.answer });
        sess.streaming = false;
      }
      const ta = document.getElementById('ct-followup');
      const btn = document.getElementById('ct-send');
      if (ta) { ta.disabled = false; ta.focus(); }
      if (btn) btn.disabled = false;
    }
    // 응답 코드블록을 서버 검증 게이트로 점검해 실행 요약 패널에 위험도·발견을 덧붙인다.
    // 원문 코드는 서버로만 전송돼 점검되고, 응답에는 규칙·줄번호 메타만 담겨 돌아온다.
    async function renderChatCodeVerify(debug, answer) {
      try {
        const d = await api('/admin/code-verify', { method: 'POST', body: JSON.stringify({ text: answer }) });
        if (!d || !d.has_code) return;
        const rcls = d.risk === 'high' ? 'error' : (d.risk === 'medium' ? 'warn' : '');
        const c = d.counts || {};
        let html = '<h4>코드 검증 <span class="status ' + rcls + '">' + escapeHTML(d.risk || '') + '</span></h4><div class="kv">' +
          row('코드블록', fmt(d.block_count || 0) + (d.languages && d.languages.length ? ' (' + escapeHTML(d.languages.join(', ')) + ')' : '')) +
          row('위험 발견', 'high ' + (c.high || 0) + ' / med ' + (c.medium || 0)) +
          row('시크릿/구문', (c.secret || 0) + ' / ' + (c.syntax || 0)) +
          row('테스트 가능 블록', fmt(c.testable || 0)) +
        '</div>';
        const fcls = (sev) => sev === 'high' ? 'error' : (sev === 'medium' ? 'warn' : '');
        const items = [];
        (d.blocks || []).forEach(b => (b.findings || []).forEach(f => {
          items.push('<div style="font-size:11px">• <span class="status ' + fcls(f.severity) + '" style="font-size:9px">' + escapeHTML(f.severity || '') + '</span> ' + escapeHTML(f.lang || '') + (f.line ? ' L' + f.line : '') + ' — ' + escapeHTML(f.detail || '') + '</div>');
        }));
        if (items.length) html += '<div style="margin-top:4px">' + items.slice(0, 30).join('') + '</div>';
        const sec = document.createElement('div');
        sec.innerHTML = html;
        debug.appendChild(sec);
      } catch (e) { /* 검증 실패는 무시(부가 정보) */ }
    }
    function renderChatStreamDebug(info) {
      const headers = info.headers || {};
      let html = '<h4>실행 요약</h4><div class="kv">' +
        row('Status', '<span class="status ' + (info.ok ? '' : 'error') + '">' + fmt(info.status || 0) + '</span>') +
        row('Latency', fmt(info.latency_ms || 0) + ' ms (브라우저 측정)') +
        row('Cache', escapeHTML(chatHeader(headers, 'x-cache') || 'MISS')) +
        row('Model', escapeHTML(info.model || '')) +
        row('Provider', escapeHTML(info.provider || '자동')) +
        (info.error ? row('Error', '<span class="status error">' + escapeHTML(info.error) + '</span>') : '') +
      '</div>';
      if (info.usage) {
        const u = info.usage;
        html += '<h4>토큰</h4><div class="kv">' +
          row('Prompt', fmt(u.prompt_tokens || 0)) +
          row('Completion', fmt(u.completion_tokens || 0)) +
          (u.completion_tokens_details && u.completion_tokens_details.reasoning_tokens ? row('추론', fmt(u.completion_tokens_details.reasoning_tokens)) : '') +
          row('Total', fmt(u.total_tokens || 0)) +
        '</div>';
      }
      const discoveryModel = chatHeader(headers, 'x-mcp-discovery-model');
      if (discoveryModel) {
        html += '<h4>MCP Discovery</h4><div class="kv">' +
          row('모델', escapeHTML(discoveryModel)) +
          row('모드', escapeHTML(chatHeader(headers, 'x-mcp-discovery-mode') || '-')) +
          row('후보/확인', fmt(Number(chatHeader(headers, 'x-mcp-candidates')) || 0) + ' / ' + fmt(Number(chatHeader(headers, 'x-mcp-checked')) || 0)) +
          (chatHeader(headers, 'x-mcp-score-filtered') ? row('관련성 gate', fmt(Number(chatHeader(headers, 'x-mcp-score-filtered')) || 0)) : '') +
          (chatHeader(headers, 'x-mcp-grounded') ? row('Grounded', escapeHTML(chatHeader(headers, 'x-mcp-grounded'))) : '') +
        '</div>';
      }
      // Agentic MCP loop stats: prefer the structured x_mcp chunk (streaming), fall back to
      // the X-MCP-* response headers (non-streaming).
      const agentic = info.mcp || (chatHeader(headers, 'x-mcp-agentic') ? {
        steps: chatHeader(headers, 'x-mcp-steps'),
        tool_calls: chatHeader(headers, 'x-mcp-tool-calls'),
        evidence: chatHeader(headers, 'x-mcp-evidence'),
        backing_model: chatHeader(headers, 'x-mcp-backing-model'),
      } : null);
      if (agentic) {
        html += '<h4>에이전틱 MCP</h4><div class="kv">' +
          (agentic.backing_model ? row('백킹 모델', escapeHTML(String(agentic.backing_model)) + (agentic.provider ? ' · ' + escapeHTML(String(agentic.provider)) : '')) : '') +
          row('턴', fmt(Number(agentic.steps) || 0)) +
          row('도구 호출', fmt(Number(agentic.tool_calls) || 0)) +
          row('근거 수', fmt(Number(agentic.evidence) || 0)) +
        '</div>';
      }
      if (info.preview) {
        html += '<h4>라우팅 결정</h4>' + renderChatTestPreviewCompact(info.preview);
      }
      html += '<h4>응답 헤더</h4>' + chatTestHeadersTable(headers);
      html += '<h4>Raw SSE</h4><pre>' + escapeHTML(info.raw || '') + '</pre>';
      return html;
    }
    function chatHeader(headers, name) {
      const want = String(name || '').toLowerCase();
      for (const k in (headers || {})) {
        if (String(k).toLowerCase() === want) return headers[k];
      }
      return '';
    }
    // ---------- MCP routing test (explain + upstream call) ----------
    async function runMCPRoutingTestFromConsole(target) {
      if (!target) { openModal('MCP 라우팅 테스트', '<div class="error-line">MCP 대상을 먼저 선택하세요.</div>'); return; }
      const meta = target.metadata || {};
      const kind = meta.kind || (String(target.kind || '').replace('mcp_', '')) || 'tool';
      const method = mcpMethodForKind(kind);
      const name = meta.exposed_name || target.label || '';
      const uri = meta.uri || '';
      const reqLabel = method + ' ' + (uri || name);
      openMCPRoutingPopup({ pending: true, request: reqLabel });
      try {
        const explain = await api('/admin/mcp/route/explain', { method: 'POST', body: JSON.stringify({ method, name, uri }) });
        const route = explain.route || {};
        const final = explain.final || {};
        let tested = null;
        let skipped = '';
        if (!route.found) {
          skipped = 'Route를 찾지 못해 업스트림 호출을 생략했습니다.';
        } else if (final.decision === 'block') {
          skipped = '최종 판단이 block이라 업스트림 호출을 생략했습니다.';
        } else {
          const testBody = { method: route.target_method || method, name, uri, upstream_id: route.upstream_id };
          tested = await api('/admin/mcp/test', { method: 'POST', body: JSON.stringify(testBody) });
        }
        openMCPRoutingPopup({ request: reqLabel, explain: explain, tested: tested, skipped: skipped });
      } catch (err) {
        openMCPRoutingPopup({ request: reqLabel, error: err.message });
      }
    }
    function openMCPRoutingPopup(state) {
      const title = 'MCP 라우팅 테스트 — ' + escapeHTML(state.request || '');
      let stream;
      let debug;
      if (state.pending) {
        stream = mcpReqBubble(state.request) + '<div class="chat-msg assistant"><div class="who">UPSTREAM</div><div class="chat-bubble"><span class="muted">라우팅 확인 중…</span></div></div>';
        debug = '<div class="empty">대기 중…</div>';
      } else if (state.error) {
        stream = mcpReqBubble(state.request) + '<div class="chat-msg assistant error"><div class="who">UPSTREAM</div><div class="chat-bubble">' + escapeHTML(state.error) + '</div></div>';
        debug = '<div class="empty">실패</div>';
      } else {
        const tested = state.tested;
        let respBubble;
        if (state.skipped) {
          respBubble = '<div class="chat-msg assistant error"><div class="who">UPSTREAM</div><div class="chat-bubble">' + escapeHTML(state.skipped) + '</div></div>';
        } else if (tested) {
          const body = tested.ok
            ? '<pre style="white-space:pre-wrap; margin:0">' + escapeHTML(formatTextIfJSON(tested.response_preview || '')) + '</pre>'
            : escapeHTML(tested.error || '(오류)');
          respBubble = '<div class="chat-msg assistant' + (tested.ok ? '' : ' error') + '"><div class="who">UPSTREAM · ' + escapeHTML(tested.upstream_name || '') + '</div><div class="chat-bubble">' + body + '</div></div>';
        } else {
          respBubble = '';
        }
        stream = mcpReqBubble(state.request) + respBubble;
        debug = renderMCPRoutingDebug(state.explain || {}, tested);
      }
      openModal(title, '<div class="chat-pop"><div class="chat-stream">' + stream + '</div><div class="chat-debug">' + debug + '</div></div>', null, { wide: true });
    }
    function mcpReqBubble(reqLabel) {
      return '<div class="chat-msg user"><div class="who">MCP REQUEST</div><div class="chat-bubble" style="font-family:ui-monospace,SFMono-Regular,Consolas,monospace">' + escapeHTML(reqLabel || '') + '</div></div>';
    }
    function renderMCPRoutingDebug(explain, tested) {
      let html = '<h4>라우트 / 정책</h4>' + mcpExplainHTML(explain);
      if (tested) {
        html += '<h4>업스트림 호출</h4><div class="kv">' +
          row('상태', tested.ok ? '<span class="status">ok</span>' : '<span class="status error">error</span>') +
          row('업스트림', escapeHTML((tested.upstream_name || '') + (tested.upstream_id ? ' / ' + tested.upstream_id : ''))) +
          row('Method', escapeHTML(tested.method || '')) +
          row('Latency', fmt(tested.latency_ms || 0) + ' ms') +
          (tested.error ? row('Error', escapeHTML(tested.error)) : '') +
        '</div>';
        if (tested.response_preview) {
          html += '<h4>Response preview</h4><pre>' + escapeHTML(formatTextIfJSON(tested.response_preview)) + '</pre>';
        }
      }
      return html;
    }
    function chatTestPayload(forRun) {
      const temperatureRaw = document.getElementById('chat-temperature').value;
      const payload = {
        target_id: document.getElementById('chat-target').value,
        model: document.getElementById('chat-model').value.trim() || 'vibe/auto',
        provider: document.getElementById('chat-provider').value.trim(),
        api_key_id: document.getElementById('chat-api-key-id').value.trim(),
        prompt: document.getElementById('chat-prompt').value,
        max_tokens: Number(document.getElementById('chat-max-tokens').value || 64),
        no_route: document.getElementById('chat-no-route').checked,
        include_preview: document.getElementById('chat-include-preview').checked,
      };
      if (temperatureRaw !== '') payload.temperature = Number(temperatureRaw);
      if (forRun) {
        const bearer = document.getElementById('chat-bearer').value.trim();
        if (bearer) payload.bearer_token = bearer;
      }
      return payload;
    }
    function chatTestPreviewPayload() {
      const payload = chatTestPayload(false);
      const out = {
        model: payload.model,
        messages: [{ role: 'user', content: payload.prompt || '' }],
        max_tokens: payload.max_tokens,
        stream: false,
      };
      if (payload.api_key_id) out.api_key_id = payload.api_key_id;
      if (payload.temperature !== undefined) out.temperature = payload.temperature;
      return out;
    }
    function chatTestTargetOptions(targets, selected) {
      if (!targets.length) return '<option value="">대상 없음</option>';
      const selectedID = selected || 'routing:vibe/auto';
      const groupLabel = {
        routing: 'Routing',
        routing_rule: 'Routing Rules',
        provider: 'Providers',
        provider_pattern: 'Provider Patterns',
        text2sql: 'Text2SQL',
        text2sql_profile: 'Text2SQL Profiles',
        mcp_tool: 'MCP Tools',
        mcp_prompt: 'MCP Prompts',
        mcp_resource: 'MCP Resources',
      };
      const order = ['routing', 'routing_rule', 'provider', 'provider_pattern', 'text2sql', 'text2sql_profile', 'mcp_tool', 'mcp_prompt', 'mcp_resource'];
      return order.map(kind => {
        const rows = targets.filter(t => (t.kind || '') === kind);
        if (!rows.length) return '';
        return '<optgroup label="' + escapeHTML(groupLabel[kind] || kind) + '">' + rows.map(t =>
          '<option value="' + escapeHTML(t.id) + '"' +
            (t.id === selectedID ? ' selected' : '') +
            ' data-model="' + escapeHTML(t.model || '') + '"' +
            ' data-provider="' + escapeHTML(t.provider || '') + '"' +
            ' data-kind="' + escapeHTML(t.kind || '') + '"' +
            ' data-label="' + escapeHTML(t.label || '') + '">' +
            escapeHTML((t.enabled === false ? '[off] ' : '') + (t.label || t.id)) +
          '</option>'
        ).join('') + '</optgroup>';
      }).join('');
    }
    function chatTestProviderOptions(targets, selected) {
      const names = [];
      const seen = {};
      targets.forEach(t => {
        const name = t.provider || '';
        if (name && !seen[name]) {
          seen[name] = true;
          names.push(name);
        }
      });
      names.sort();
      return '<option value="">자동</option>' + names.map(name => '<option value="' + escapeHTML(name) + '"' + (name === selected ? ' selected' : '') + '>' + escapeHTML(name) + '</option>').join('');
    }
    function chatTestTargetTable(targets) {
      if (!targets.length) return '<div class="empty">등록된 테스트 대상 없음</div>';
      return '<table><thead><tr><th data-sort="str">Kind</th><th data-sort="str">대상</th><th data-sort="str">Model</th><th data-sort="str">Provider</th><th data-sort="str">세부</th><th data-sort="str">상태</th></tr></thead><tbody>' +
        targets.map(t => '<tr class="row-link" data-chat-target-id="' + escapeHTML(t.id || '') + '">' +
          '<td><span class="pill">' + escapeHTML(t.kind || '') + '</span></td>' +
          '<td><strong>' + escapeHTML(t.label || t.id || '') + '</strong>' + (t.description ? '<div class="muted">' + escapeHTML(t.description) + '</div>' : '') + '</td>' +
          '<td><code>' + escapeHTML(t.model || t.pattern || '-') + '</code>' + (t.editable ? '<div class="muted">editable</div>' : '') + '</td>' +
          '<td>' + escapeHTML(t.provider || '-') + '</td>' +
          '<td>' + chatTestTargetMetaLine(t) + '</td>' +
          '<td><span class="status ' + (t.enabled === false ? 'warn' : '') + '">' + (t.enabled === false ? 'off' : 'ready') + '</span></td>' +
        '</tr>').join('') + '</tbody></table>';
    }
    function chatTestTargetMetaLine(t) {
      const m = (t && t.metadata) || {};
      if (m.route_family === 'mcp_discovery') {
        return '<span class="status">' + escapeHTML(m.mode || '') + '</span>' +
          '<div class="muted">MCP ' + fmt(Number(m.max_mcps) || 0) + ' · evidence ' + escapeHTML(String(m.min_evidence_score || '-')) + '</div>' +
          '<div class="muted">backing ' + escapeHTML(String(m.agentic_model || 'auto-router')) + '</div>';
      }
      if (String(t.kind || '').startsWith('mcp_')) {
        return '<span class="status">' + escapeHTML(m.upstream_name || '') + '</span>' +
          '<div class="muted">' + escapeHTML(m.target_method || m.kind || '') + '</div>';
      }
      if (t.provider || t.pattern) return '<span class="muted">' + escapeHTML(t.pattern || t.provider || '') + '</span>';
      return '<span class="muted">-</span>';
    }
    function chatTestTargetDetail(t) {
      if (!t) return '<div class="muted">대상 없음</div>';
      const m = t.metadata || {};
      if (m.route_family === 'mcp_discovery') {
        const selector = (m.selector_behavior === 'ranking_boost_agentic') ? 'agentic=ranking' : String(m.selector_behavior || '-');
        const fallback = m.static_fallback_selector_gate ? ('fallback gate ' + String(m.min_selector_score || '-')) : 'fallback open';
        return '<div class="kv">' +
          row('MCP Discovery', '<strong>' + escapeHTML(m.canonical_model || t.model || '') + '</strong> <span class="muted">' + escapeHTML(m.mode || '') + '</span>') +
          row('후보 정책', 'max ' + fmt(Number(m.max_mcps) || 0) + ' · evidence ' + escapeHTML(String(m.min_evidence_score || '-')) + ' · ' + escapeHTML(selector + ' / ' + fallback)) +
          row('백킹 모델', '<code>' + escapeHTML(String(m.agentic_model || 'auto-router')) + '</code> <span class="muted">' + escapeHTML(String(m.agentic_model_source || '')) + '</span>') +
          row('루프 설정', 'steps ' + fmt(Number(m.max_agent_steps) || 0) + ' · tokens ' + fmt(Number(m.mcp_max_tokens) || 0) + ' · tools ' + fmt(Number(m.max_tools) || 0) + ' · force first ' + escapeHTML(String(!!m.force_tool_first))) +
          row('설정', '<a href="#/settings/runtime"><code>mcp.agentic_model</code></a>') +
        '</div>';
      }
      if (String(t.kind || '').startsWith('mcp_')) {
        return '<div class="kv">' +
          row('MCP route', '<strong>' + escapeHTML(t.label || t.id || '') + '</strong>') +
          row('Upstream', escapeHTML((m.upstream_name || '-') + (m.upstream_id ? ' / ' + m.upstream_id : ''))) +
          row('Target', '<code>' + escapeHTML(m.target_method || m.kind || '') + '</code> ' + escapeHTML(m.target_name || m.uri || m.exposed_name || '')) +
          (m.discovery_error ? row('Discovery', '<span class="status error">' + escapeHTML(m.discovery_error) + '</span>') : row('Discovery', '<span class="status">ready</span>')) +
        '</div>';
      }
      return '<div class="kv">' +
        row('Target', '<strong>' + escapeHTML(t.label || t.id || '') + '</strong>') +
        row('Kind', escapeHTML(t.kind || '-')) +
        row('Model', '<code>' + escapeHTML(t.model || t.pattern || '-') + '</code>') +
        row('Provider', escapeHTML(t.provider || '자동')) +
      '</div>';
    }
    function mmReadModels() {
      return (document.getElementById('mm-models').value || '').split('\n').map(s => s.trim()).filter(Boolean).map(line => {
        const [model, provider] = line.split(':').map(x => (x || '').trim());
        return { model, provider: provider || '' };
      });
    }
    function mmReadMessages() {
      const messages = [];
      const sys = (document.getElementById('mm-system').value || '').trim();
      if (sys) messages.push({ role: 'system', content: sys });
      messages.push({ role: 'user', content: (document.getElementById('mm-user').value || '').trim() });
      return messages;
    }
    function mmReadParams() {
      return {
        temperature: parseFloat(document.getElementById('mm-temperature').value) || 0,
        max_tokens: parseInt(document.getElementById('mm-max-tokens').value, 10) || 1024,
        stream: false,
      };
    }

    async function predictMultiModelCost() {
      const out = document.getElementById('mm-predict-out');
      const models = mmReadModels();
      if (!models.length) { out.innerHTML = '<span class="status error">모델을 입력하세요.</span>'; return; }
      out.textContent = '예상 비용 계산 중...';
      try {
        const r = await api('/admin/chat-test/multi-run/predict', { method: 'POST', body: JSON.stringify({ models, messages: mmReadMessages(), params: mmReadParams() }) });
        const ests = r.estimates || [];
        out.innerHTML = '예상 입력 토큰 ~' + fmt(r.input_tokens) + ' · 합계 예상비용 <strong>₩' + fmt(Math.round(r.total_cost_krw || 0)) + '</strong> (' +
          ests.map(e => escapeHTML(e.model) + ' ₩' + fmt(Math.round(e.cost_krw || 0)) + (e.priced ? '' : '(미가격)')).join(', ') + ')';
      } catch (e) { out.innerHTML = '<span class="status error">' + escapeHTML(e.message) + '</span>'; }
    }

    // runMultiModelStream renders one streaming card per model and streams each model's SSE
    // (reusing /admin/chat-test/stream) into its card in parallel — live A/B/N comparison.
    async function runMultiModelStream() {
      const out = document.getElementById('mm-results');
      const btn = document.getElementById('mm-stream');
      const models = mmReadModels();
      if (!models.length) { out.innerHTML = '<span class="status error">비교할 모델을 1개 이상 입력하세요.</span>'; return; }
      if (models.length > 5) { out.innerHTML = '<span class="status error">한 번에 최대 5개 모델까지 비교할 수 있습니다.</span>'; return; }
      const messages = mmReadMessages(), params = mmReadParams();
      out.innerHTML = '<div class="muted" style="font-size:12px;margin-bottom:6px">스트리밍 비교 (' + models.length + '개 모델 동시)</div>' +
        models.map((m, i) =>
          '<div style="border:1px solid var(--border);border-radius:8px;padding:10px;margin-top:8px">' +
          '<div style="display:flex;justify-content:space-between"><strong>' + escapeHTML(m.model) + (m.provider ? ' <span class="muted">(' + escapeHTML(m.provider) + ')</span>' : '') + '</strong><span class="muted" id="mm-stream-lat-' + i + '">…</span></div>' +
          '<pre id="mm-stream-' + i + '" style="white-space:pre-wrap;font-size:12px;max-height:280px;overflow:auto;margin-top:6px">대기 중…</pre></div>'
        ).join('');
      btn.disabled = true; btn.textContent = '스트리밍 중...';
      await Promise.all(models.map((m, i) => mmStreamOne(m, i, messages, params)));
      btn.disabled = false; btn.textContent = '스트리밍 비교';
    }

    async function mmStreamOne(spec, idx, messages, params) {
      const pre = document.getElementById('mm-stream-' + idx);
      const start = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      let answer = '';
      try {
        const h = headers(); h['Content-Type'] = 'application/json'; h['Accept'] = 'text/event-stream';
        const res = await fetch('/admin/chat-test/stream', { method: 'POST', headers: h,
          body: JSON.stringify({ model: spec.model, provider: spec.provider, messages, max_tokens: params.max_tokens, temperature: params.temperature }) });
        const ctype = res.headers.get('content-type') || '';
        if (!res.body || ctype.indexOf('text/event-stream') < 0) {
          const t = await res.text(); pre.textContent = '(스트림 아님) ' + t.slice(0, 600); return;
        }
        const reader = res.body.getReader(), dec = new TextDecoder(); let buf = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let nl;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
            if (!line || line.indexOf('data:') !== 0) continue;
            const data = line.slice(5).trim();
            if (data === '[DONE]') continue;
            let chunk; try { chunk = JSON.parse(data); } catch (e) { continue; }
            for (const c of (chunk.choices || [])) {
              const d = c.delta || c.message || {};
              if (typeof d.content === 'string') answer += d.content;
              else if (Array.isArray(d.content)) answer += d.content.map(x => (x && x.text) || '').join('');
            }
            pre.textContent = answer + '▋';
          }
        }
        pre.textContent = answer || '(빈 응답)';
      } catch (e) { pre.textContent = '오류: ' + e.message; }
      const lbl = document.getElementById('mm-stream-lat-' + idx);
      if (lbl) lbl.textContent = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - start) + 'ms';
    }

    // mmLoadTags caches model usage tags (good_for/avoid_for/risk_note) for badge rendering.
    async function mmLoadTags() {
      if (window.__mmTags) return window.__mmTags;
      const map = {};
      try { const d = await api('/v1/model-tags'); (d.tags || []).forEach(t => { map[t.model] = t; }); } catch (e) {}
      window.__mmTags = map;
      return map;
    }
    function mmTagBadges(model) {
      const t = (window.__mmTags || {})[model];
      if (!t) return '';
      let out = '';
      if (t.good_for) out += ' <span class="status" style="font-size:9px" title="적합">👍 ' + escapeHTML(t.good_for) + '</span>';
      if (t.avoid_for) out += ' <span class="status warn" style="font-size:9px" title="지양">⚠ ' + escapeHTML(t.avoid_for) + '</span>';
      if (t.risk_note) out += ' <span class="status error" style="font-size:9px" title="위험">' + escapeHTML(t.risk_note) + '</span>';
      return out;
    }
    // 모델 리더보드 — 저장된 자동 평가 기준 "어떤 모델이 계속 이기는지".
    window.mmLoadLeaderboard = async () => {
      const host = document.getElementById('mm-leaderboard');
      if (!host) return;
      let d;
      try { d = await api('/admin/chat-test/multi-run/leaderboard?days=90'); } catch (e) { host.innerHTML = ''; return; }
      const lb = d.leaderboard || [];
      if (!lb.length) { host.innerHTML = ''; return; } // 평가 데이터 없으면 숨김
      const rows = lb.map((m, i) => '<tr><td>' + (i + 1) + '</td><td>' + escapeHTML(m.model) + (i === 0 ? ' <span class="status" style="font-size:9px">최다 우승</span>' : '') + '</td>' +
        '<td>' + m.wins + '</td><td>' + (m.avg_score || 0).toFixed(1) + '</td><td>' + (m.pass_rate || 0).toFixed(0) + '%</td><td>' + m.appearances + '</td></tr>').join('');
      host.innerHTML = section('모델 리더보드 (최근 90일)', card('자동 평가 누적 (' + (d.runs || 0) + ' runs)',
        '<div class="card-body"><table><thead><tr><th>#</th><th>모델</th><th>우승</th><th>평균점수</th><th>통과율</th><th>출전</th></tr></thead><tbody>' + rows + '</tbody></table>' +
        '<p class="muted" style="font-size:10px;margin-top:4px">' + escapeHTML(d.note || '') + '</p></div>'));
    };

    // 코드 위험 리더보드 — 영속된 코드 검증 verdict 기준 "어떤 모델이 위험한 코드를 내놓는지".
    window.mmLoadCodeRiskBoard = async () => {
      const host = document.getElementById('mm-coderiskboard');
      if (!host) return;
      let d;
      try { d = await api('/admin/code-verify/stats?days=30'); } catch (e) { host.innerHTML = ''; return; }
      const ms = d.models || [];
      if (!ms.length) { host.innerHTML = ''; return; } // 검증 기록 없으면 숨김
      const rows = ms.map((m, i) => {
        const rate = Math.round((m.high_risk_rate || 0) * 100);
        const rcls = rate >= 50 ? 'error' : (rate >= 20 ? 'warn' : '');
        return '<tr><td>' + (i + 1) + '</td><td>' + escapeHTML(m.model) + (i === 0 && (m.risk_high || 0) > 0 ? ' <span class="status error" style="font-size:9px">최다 위험</span>' : '') + '</td>' +
          '<td>' + fmt(m.verdicts || 0) + '</td>' +
          '<td><span class="status ' + rcls + '">' + rate + '%</span></td>' +
          '<td>' + fmt(m.risk_high || 0) + ' / ' + fmt(m.risk_medium || 0) + '</td>' +
          '<td>' + fmt(m.high_findings || 0) + '</td>' +
          '<td>' + fmt(m.secret_findings || 0) + '</td>' +
          '<td>' + fmt(m.testable || 0) + '</td></tr>';
      }).join('');
      const t = d.totals || {};
      host.innerHTML = section('코드 위험 리더보드 (최근 ' + (d.days || 30) + '일)', card('영속 코드 검증 누적 (high ' + (t.risk_high || 0) + ' · secret ' + (t.secret_findings || 0) + ')',
        '<div class="card-body"><table><thead><tr><th>#</th><th>모델</th><th>verdict</th><th>high 비율</th><th>high/med</th><th>high 발견</th><th>시크릿</th><th>테스트가능</th></tr></thead><tbody>' + rows + '</tbody></table>' +
        '<p class="muted" style="font-size:10px;margin-top:4px">' + escapeHTML(d.note || '') + '</p></div>'));
    };

    // 모델 용도 태그 관리(관리자) — good_for/avoid_for/risk_note.
    async function mmRenderTagEditor() {
      const host = document.getElementById('mm-tags-panel');
      if (!host) return;
      let tags = [];
      try { tags = (await api('/admin/model-tags')).tags || []; } catch (e) { return; }
      window.__mmTags = {}; tags.forEach(t => { window.__mmTags[t.model] = t; });
      const rows = tags.length ? tags.map(t => '<tr><td>' + escapeHTML(t.model) + '</td><td>' + escapeHTML(t.good_for || '-') + '</td><td>' + escapeHTML(t.avoid_for || '-') + '</td><td>' + escapeHTML(t.risk_note || '-') + '</td>' +
        '<td><button type="button" class="secondary" style="font-size:11px" onclick="mmDeleteTag(\'' + escapeAttr(t.model) + '\')">삭제</button></td></tr>').join('') : '<tr><td colspan="5" class="muted">태그 없음</td></tr>';
      host.innerHTML = section('모델 용도 태그', card('용도별 추천 (good_for / avoid_for / 위험)',
        '<div class="card-body"><table><thead><tr><th>모델</th><th>적합(good_for)</th><th>지양(avoid_for)</th><th>위험 메모</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>' +
        '<div style="display:flex;gap:4px;margin-top:6px;flex-wrap:wrap">' +
        '<input id="mt-model" placeholder="모델" style="width:160px"><input id="mt-good" placeholder="적합 (예: code_review,summary)" style="flex:1"><input id="mt-avoid" placeholder="지양" style="flex:1"><input id="mt-risk" placeholder="위험 메모" style="flex:1">' +
        '<button type="button" onclick="mmSaveTag()">저장</button></div>' +
        '<p class="muted" style="font-size:11px;margin-top:4px">멀티 비교 결과 카드에 모델별 용도 배지로 표시됩니다. 한 번 이긴 모델을 전체 기본값으로 착각하지 않도록 업무 유형별로 관리하세요.</p></div>'));
    }
    window.mmSaveTag = async () => {
      const model = (document.getElementById('mt-model').value || '').trim();
      if (!model) return;
      const body = { model, good_for: (document.getElementById('mt-good').value || '').trim(), avoid_for: (document.getElementById('mt-avoid').value || '').trim(), risk_note: (document.getElementById('mt-risk').value || '').trim() };
      try { await api('/admin/model-tags', { method: 'POST', body: JSON.stringify(body) }); await mmRenderTagEditor(); }
      catch (e) { alert(e.message); }
    };
    window.mmDeleteTag = async (model) => {
      if (!confirm(model + ' 태그를 삭제할까요?')) return;
      try { await api('/admin/model-tags/' + encodeURIComponent(model), { method: 'DELETE' }); await mmRenderTagEditor(); }
      catch (e) { alert(e.message); }
    };
    async function runMultiModelCompare() {
      const out = document.getElementById('mm-results');
      const btn = document.getElementById('mm-run');
      const models = mmReadModels();
      if (!models.length) { out.innerHTML = '<span class="status error">비교할 모델을 1개 이상 입력하세요.</span>'; return; }
      await mmLoadTags();
      if (models.length > 5) { out.innerHTML = '<span class="status error">한 번에 최대 5개 모델까지 비교할 수 있습니다.</span>'; return; }
      const messages = [];
      const sys = (document.getElementById('mm-system').value || '').trim();
      if (sys) messages.push({ role: 'system', content: sys });
      messages.push({ role: 'user', content: (document.getElementById('mm-user').value || '').trim() });
      const body = {
        title: '멀티 모델 비교',
        models,
        messages,
        params: {
          temperature: parseFloat(document.getElementById('mm-temperature').value) || 0,
          max_tokens: parseInt(document.getElementById('mm-max-tokens').value, 10) || 1024,
          stream: false,
        },
        save_prompt: false,
      };
      btn.disabled = true; btn.textContent = '실행 중...';
      out.innerHTML = '<div class="empty">' + models.length + '개 모델 병렬 호출 중...</div>';
      try {
        const r = await api('/admin/chat-test/multi-run', { method: 'POST', body: JSON.stringify(body) });
        const results = r.results || [], sum = r.summary || {};
        const runId = r.run_id || '';
        window.__mmRunId = runId;
        const won = (v) => '₩' + fmt(Math.round(v || 0));
        const badge = (name, label) => name ? '<span class="status">' + label + ': ' + escapeHTML(name) + '</span> ' : '';
        const table =
          '<table><thead><tr><th>모델</th><th>Provider</th><th>상태</th><th>지연</th><th>입력</th><th>출력</th><th>예상비용</th></tr></thead><tbody>' +
          results.map(x =>
            '<tr><td><strong>' + escapeHTML(x.model) + '</strong></td>' +
            '<td>' + escapeHTML(x.selected_provider || x.provider || '') + '</td>' +
            '<td><span class="status ' + (x.status === 'success' ? '' : 'error') + '">' + escapeHTML(x.status) + '</span></td>' +
            '<td data-num="' + x.latency_ms + '">' + fmt(x.latency_ms) + 'ms</td>' +
            '<td>' + fmt(x.input_tokens) + '</td><td>' + fmt(x.output_tokens) + '</td>' +
            '<td>' + (x.cost_krw_est ? won(x.cost_krw_est) : '-') + '</td></tr>'
          ).join('') + '</tbody></table>';
        const cards = results.map(x =>
          '<div style="border:1px solid var(--border);border-radius:8px;padding:10px;margin-top:8px">' +
          '<div style="display:flex;justify-content:space-between;align-items:center"><strong>' + escapeHTML(x.model) + '</strong>' + mmTagBadges(x.model) +
          '<span class="status ' + (x.status === 'success' ? '' : 'error') + '">' + escapeHTML(x.status) + ' · ' + fmt(x.latency_ms) + 'ms</span></div>' +
          (x.error ? '<div class="status error" style="margin-top:6px">' + escapeHTML(x.error) + '</div>' : '') +
          '<pre style="white-space:pre-wrap;font-size:12px;max-height:280px;overflow:auto;margin-top:6px">' + escapeHTML(x.content || '(빈 응답)') + '</pre>' +
          (runId ? '<div style="display:flex;gap:6px;margin-top:6px;align-items:center">' +
            '<select id="mm-rate-' + escapeAttr(x.model) + '" style="font-size:11px"><option value="">평가</option>' + [5,4,3,2,1].map(n => '<option value="' + n + '">' + n + '점</option>').join('') + '</select>' +
            '<input id="mm-comment-' + escapeAttr(x.model) + '" placeholder="코멘트" style="font-size:11px;flex:1">' +
            '<button type="button" class="secondary" style="font-size:11px" onclick="mmSaveFeedback(\'' + escapeAttr(x.model) + '\')">평가 저장</button>' +
            (x.status === 'success' ? '<button type="button" class="secondary" style="font-size:11px" onclick="mmPromote(\'' + escapeAttr(x.model) + '\')">라우팅 후보</button>' : '') +
            (x.status === 'success' ? '<button type="button" class="secondary" style="font-size:11px" onclick="mmGolden(\'' + escapeAttr(x.model) + '\')">Golden 저장</button>' : '') +
            '</div>' : '') +
          '</div>').join('');
        out.innerHTML =
          '<div style="margin-bottom:6px">' + badge(sum.best_latency_model, '최저 지연') + badge(sum.lowest_cost_success_model, '최저 비용') +
          '<span class="muted" style="font-size:12px">성공 ' + (sum.success||0) + ' / 실패 ' + (sum.failed||0) + (runId ? ' · run ' + escapeHTML(runId) : '') + '</span> ' +
          '<button type="button" class="secondary" style="font-size:11px" onclick="mmLoadHistory()">이력</button> ' +
          (runId ? '<button type="button" class="secondary" style="font-size:11px" onclick="mmShowDiff()">Diff 보기</button> ' : '') +
          (runId ? '<button type="button" class="secondary" style="font-size:11px" onclick="mmCodeVerify()">코드 검증</button> ' : '') +
          (runId ? '<button type="button" class="secondary" style="font-size:11px" onclick="mmJudge(\'rule\')">자동 평가</button> ' : '') +
          (runId ? '<button type="button" class="secondary" style="font-size:11px" onclick="mmExport(\'md\')">MD</button> <button type="button" class="secondary" style="font-size:11px" onclick="mmExport(\'csv\')">CSV</button> <button type="button" class="secondary" style="font-size:11px" onclick="mmExport(\'json\')">JSON</button>' : '') +
          '</div>' +
          table + '<div id="mm-diff"></div><div id="mm-codeverify"></div><div id="mm-judge"></div>' + cards + '<div id="mm-history"></div>';
      } catch (e) {
        out.innerHTML = '<span class="status error">' + escapeHTML(e.message) + '</span>';
      } finally {
        btn.disabled = false; btn.textContent = '멀티 실행';
      }
    }

    window.mmSaveFeedback = async (model) => {
      const runId = window.__mmRunId;
      if (!runId) return;
      const rating = parseInt((document.getElementById('mm-rate-' + model) || {}).value, 10) || 0;
      const comment = ((document.getElementById('mm-comment-' + model) || {}).value || '').trim();
      try {
        await api('/admin/chat-test/multi-run/runs/' + encodeURIComponent(runId) + '/feedback', {
          method: 'POST', body: JSON.stringify({ model, rating, comment }),
        });
        const sel = document.getElementById('mm-rate-' + model);
        if (sel) sel.insertAdjacentHTML('afterend', '<span class="status" style="font-size:11px">저장됨</span>');
      } catch (e) { alert('평가 저장 오류: ' + e.message); }
    };

    window.mmPromote = async (model) => {
      const runId = window.__mmRunId;
      if (!runId) return;
      const taskType = prompt('이 모델을 어떤 작업 유형(task_type)의 라우팅 후보로 저장할까요? (예: code_review)', '');
      if (taskType === null) return;
      try {
        await api('/admin/chat-test/multi-run/runs/' + encodeURIComponent(runId) + '/promote', {
          method: 'POST', body: JSON.stringify({ model, task_type: taskType.trim(), reason: '멀티 비교에서 우수 모델로 선택' }),
        });
        alert('라우팅 후보(draft)로 저장되었습니다. 실제 라우팅에는 검토 후 반영됩니다.');
      } catch (e) { alert('후보 저장 오류: ' + e.message); }
    };

    // 멀티 모델 결과를 Golden Workflow step으로 승격 — 모델 변경 회귀 테스트용.
    window.mmGolden = async (model) => {
      const runId = window.__mmRunId;
      if (!runId) return;
      const wfName = prompt('Golden Workflow 이름을 입력하세요 (새 워크플로 생성):', 'multimodel-regression');
      if (wfName === null || !wfName.trim()) return;
      const taskType = prompt('task_type (선택, 예: code_review):', '') || '';
      // 원문이 저장되지 않았을 수 있으므로 프롬프트를 직접 받는다(선택).
      const promptText = prompt('이 step의 프롬프트(원문 미저장 시 필수). 비우면 저장된 preview 사용:', '') || '';
      const body = { workflow_name: wfName.trim(), selected_model: model, task_type: taskType.trim() };
      if (promptText.trim()) body.prompt = promptText.trim();
      try {
        const d = await api('/admin/chat-test/multi-run/runs/' + encodeURIComponent(runId) + '/golden', { method: 'POST', body: JSON.stringify(body) });
        alert('Golden Workflow "' + (d.workflow_name || '') + '"에 step "' + (d.step_name || '') + '" 저장됨 (총 ' + (d.step_count || 0) + ' steps, baseline ' + (d.baseline_score || 0).toFixed(1) + '점).');
      } catch (e) { alert('Golden 저장 오류: ' + e.message); }
    };

    window.mmExport = async (format) => {
      const runId = window.__mmRunId;
      if (!runId) return;
      try {
        const res = await fetch('/admin/chat-test/multi-run/runs/' + encodeURIComponent(runId) + '/export?format=' + format, { headers: headers() });
        if (!res.ok) { alert('내보내기 실패 (' + res.status + ')'); return; }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = runId + '.' + format;
        document.body.appendChild(a); a.click(); a.remove();
        URL.revokeObjectURL(url);
      } catch (e) { alert('내보내기 오류: ' + e.message); }
    };

    // 모델별 응답 Diff: 공통 블록 / 모델별 누락·추가 블록 / 형식 차이.
    window.mmShowDiff = async () => {
      const runId = window.__mmRunId;
      const host = document.getElementById('mm-diff');
      if (!runId || !host) return;
      if (host.innerHTML.trim()) { host.innerHTML = ''; return; } // toggle off
      host.innerHTML = '<div class="empty">Diff 계산 중...</div>';
      try {
        const d = await api('/admin/chat-test/multi-run/runs/' + encodeURIComponent(runId) + '/diff');
        const blk = (b) => '<div style="font-size:11px;margin:2px 0"><span class="status" style="font-size:9px">' + escapeHTML(b.type) + '</span> ' + escapeHTML(b.preview) + '</div>';
        // 형식 차이 테이블.
        const models = d.models || [];
        const fmtRows = models.map(m => {
          const st = m.stats || {};
          if (!st.available) return '<tr><td>' + escapeHTML(m.model) + '</td><td colspan="5" class="muted">응답 없음</td></tr>';
          return '<tr><td>' + escapeHTML(m.model) + '</td><td>' + (st.paragraphs||0) + '</td><td>' + (st.list_items||0) + '</td><td>' + (st.code_blocks||0) + '</td><td>' + (st.has_table ? '✓' : '-') + '</td><td>' + fmt(st.chars||0) + '</td></tr>';
        }).join('');
        const common = d.common_blocks || [];
        const commonHTML = common.length
          ? '<div style="margin-top:6px"><strong>공통 블록 (' + common.length + ') — 모든 모델 공통</strong>' + common.slice(0,20).map(blk).join('') + '</div>'
          : '<p class="muted" style="font-size:11px">모든 모델에 공통인 블록이 없습니다.</p>';
        const per = (d.per_model || []).map(p => {
          if (!p.available) return '<div style="margin-top:6px"><strong>' + escapeHTML(p.model) + '</strong> <span class="muted">응답 없음</span></div>';
          const miss = (p.missing||[]).slice(0,10), extra = (p.extra||[]).slice(0,10);
          return '<div style="border:1px solid var(--border);border-radius:6px;padding:8px;margin-top:6px">' +
            '<strong>' + escapeHTML(p.model) + '</strong> <span class="muted" style="font-size:11px">블록 ' + (p.block_count||0) + '</span>' +
            '<div style="margin-top:4px"><span class="status warn" style="font-size:9px">누락 ' + (p.missing||[]).length + '</span> 다른 모델엔 있으나 이 모델엔 없음' + miss.map(blk).join('') + '</div>' +
            '<div style="margin-top:4px"><span class="status" style="font-size:9px">고유 ' + (p.extra||[]).length + '</span> 이 모델에만 있음' + extra.map(blk).join('') + '</div>' +
            '</div>';
        }).join('');
        host.innerHTML = card('모델별 응답 Diff (응답 모델 ' + (d.answered_models||0) + ')',
          '<div class="card-body">' +
          '<table><thead><tr><th>모델</th><th>문단</th><th>목록</th><th>코드</th><th>표</th><th>길이</th></tr></thead><tbody>' + fmtRows + '</tbody></table>' +
          commonHTML + per +
          '<p class="muted" style="font-size:10px;margin-top:6px">' + escapeHTML(d.note || '') + '</p>' +
          '</div>');
      } catch (e) { host.innerHTML = '<span class="status error">' + escapeHTML(e.message) + '</span>'; }
    };

    // 코드 검증 리더보드: 모델별 응답의 코드블록을 정적 점검해 위험도·테스트 가능성으로 순위.
    window.mmCodeVerify = async () => {
      const runId = window.__mmRunId;
      const host = document.getElementById('mm-codeverify');
      if (!runId || !host) return;
      if (host.innerHTML.trim()) { host.innerHTML = ''; return; } // toggle off
      host.innerHTML = '<div class="empty">코드 검증 중...</div>';
      try {
        const d = await api('/admin/chat-test/multi-run/runs/' + encodeURIComponent(runId) + '/code-verify');
        const rcls = (r) => r === 'high' ? 'error' : (r === 'medium' ? 'warn' : '');
        const rows = (d.leaderboard || []).map(m => {
          if (!m.available) return '<tr><td>' + (m.rank||'') + '</td><td>' + escapeHTML(m.model) + '</td><td colspan="6" class="muted">응답 없음</td></tr>';
          if (!m.has_code) return '<tr><td>' + m.rank + '</td><td>' + escapeHTML(m.model) + '</td><td>' + (m.score||0) + '</td><td class="muted" colspan="5">코드 없음</td></tr>';
          const c = m.counts || {};
          return '<tr><td>' + m.rank + '</td><td>' + escapeHTML(m.model) + '</td>' +
            '<td><strong>' + (m.score||0) + '</strong></td>' +
            '<td><span class="status ' + rcls(m.risk) + '">' + escapeHTML(m.risk||'') + '</span></td>' +
            '<td>' + (m.block_count||0) + '</td>' +
            '<td>' + escapeHTML((m.languages||[]).join(', ')) + '</td>' +
            '<td>' + (c.high||0) + ' / ' + (c.medium||0) + '</td>' +
            '<td>' + (c.secret||0) + ' / ' + (c.testable||0) + '</td></tr>';
        }).join('');
        host.innerHTML = card('코드 검증 리더보드 (코드 포함 모델 ' + (d.models_with_code||0) + ')',
          '<div class="card-body">' +
          '<table><thead><tr><th>#</th><th>모델</th><th>점수</th><th>위험</th><th>블록</th><th>언어</th><th>high/med</th><th>시크릿/테스트</th></tr></thead><tbody>' + rows + '</tbody></table>' +
          '<p class="muted" style="font-size:10px;margin-top:6px">' + escapeHTML(d.scoring_breakdown || '') + '</p>' +
          '<p class="muted" style="font-size:10px">' + escapeHTML(d.note || '') + '</p>' +
          '</div>');
      } catch (e) { host.innerHTML = '<span class="status error">' + escapeHTML(e.message) + '</span>'; }
    };

    // Rubric 기반 자동 평가 (rule 또는 judge model).
    window.mmJudge = async (method) => {
      const runId = window.__mmRunId;
      const host = document.getElementById('mm-judge');
      if (!runId || !host) return;
      const body = { run_id: runId, method: method || 'rule' };
      if (method === 'model') {
        const jm = prompt('평가(judge) 모델 이름을 입력하세요 (예: claude-opus-4-8):', '');
        if (!jm) return;
        body.judge_model = jm.trim();
      }
      host.innerHTML = '<div class="empty">평가 중...</div>';
      try {
        const d = await api('/admin/chat-test/multi-run/judge', { method: 'POST', body: JSON.stringify(body) });
        const js = d.judgements || [];
        const vcls = (v) => v === 'pass' ? '' : (v === 'warn' ? 'warn' : 'error');
        const rows = js.map(j =>
          '<tr>' +
          '<td>' + escapeHTML(j.model) + (j.model === d.best_model ? ' <span class="status" style="font-size:9px">BEST</span>' : '') + '</td>' +
          '<td><span class="status ' + vcls(j.verdict) + '">' + (j.total_score||0).toFixed(1) + '</span></td>' +
          '<td>' + (j.accuracy||0).toFixed(0) + '</td>' +
          '<td>' + (j.completeness||0).toFixed(0) + '</td>' +
          '<td>' + (j.format_score||0).toFixed(0) + '</td>' +
          '<td>' + (j.safety||0).toFixed(0) + '</td>' +
          '<td>' + (j.cost_efficiency||0).toFixed(0) + '</td>' +
          '<td class="muted" style="font-size:11px">' + escapeHTML(j.reason_summary||'') + '</td>' +
          '</tr>').join('');
        host.innerHTML = card('자동 평가 (' + escapeHTML(d.method) + (d.best_model ? ' · best ' + escapeHTML(d.best_model) : '') + ')',
          '<div class="card-body">' +
          '<table><thead><tr><th>모델</th><th>총점</th><th>정확성</th><th>완성도</th><th>형식</th><th>안전</th><th>비용효율</th><th>요약</th></tr></thead><tbody>' + rows + '</tbody></table>' +
          '<div style="margin-top:6px"><button type="button" class="secondary" style="font-size:11px" onclick="mmJudge(\'rule\')">규칙 평가</button> ' +
          '<button type="button" class="secondary" style="font-size:11px" onclick="mmJudge(\'model\')">모델 평가</button></div>' +
          '<p class="muted" style="font-size:10px;margin-top:6px">' + escapeHTML(d.note||'') + '</p>' +
          '</div>');
      } catch (e) { host.innerHTML = '<span class="status error">' + escapeHTML(e.message) + '</span>'; }
    };

    window.mmLoadHistory = async () => {
      const host = document.getElementById('mm-history');
      if (!host) return;
      host.innerHTML = '<div class="empty">불러오는 중...</div>';
      try {
        const r = await api('/admin/chat-test/multi-run/runs?limit=20');
        const runs = r.runs || [];
        host.innerHTML = '<h4 style="margin:10px 0 6px">최근 비교 이력</h4>' + (runs.length
          ? '<table><thead><tr><th>제목</th><th>모델수</th><th>성공/실패</th><th>작성자</th><th>시각</th></tr></thead><tbody>' +
            runs.map(x => '<tr><td>' + escapeHTML(x.title || '(제목 없음)') + '<div class="muted" style="font-size:10px">' + escapeHTML(x.id) + '</div></td><td>' + fmt(x.model_count) + '</td><td>' + fmt(x.success) + '/' + fmt(x.failed) + '</td><td class="muted">' + escapeHTML(x.created_by || '') + '</td><td class="muted">' + ago(x.created_at) + '</td></tr>').join('') + '</tbody></table>'
          : '<p class="muted">저장된 비교 이력이 없습니다.</p>');
      } catch (e) { host.innerHTML = '<span class="status error">' + escapeHTML(e.message) + '</span>'; }
    };

    function renderChatTestPreview(preview) {
      const complexity = preview.complexity || {};
      const risk = preview.risk || {};
      return '<div class="kpis">' +
        kpi('선택 모델', '<strong>' + escapeHTML(preview.selected_model || '-') + '</strong><div class="muted">' + escapeHTML(preview.selected_provider || 'provider 자동') + '</div>') +
        kpi('Complexity', fmt(complexity.score || 0) + '<div class="muted">' + escapeHTML(complexity.tier || '') + '</div>') +
        kpi('Risk', fmt(risk.score || 0) + '<div class="muted">' + escapeHTML((risk.categories || []).join(', ') || '-') + '</div>') +
        kpi('Rewrite', preview.would_rewrite ? '<span class="status warn">yes</span>' : '<span class="status">no</span>') +
      '</div>' +
      '<table><tbody>' +
        '<tr><th>Route reason</th><td>' + escapeHTML(preview.route_reason || '') + '</td></tr>' +
        '<tr><th>Decision reason</th><td>' + escapeHTML(preview.decision_reason || '') + '</td></tr>' +
        '<tr><th>Fallback path</th><td>' + escapeHTML((preview.fallback_path || []).join(' -> ') || '-') + '</td></tr>' +
      '</tbody></table>';
    }
    // Narrow-rail variant of the routing preview (kv rows, no wide kpi grid) for the debug pane.
    function renderChatTestPreviewCompact(preview) {
      const complexity = preview.complexity || {};
      const risk = preview.risk || {};
      return '<div class="kv">' +
        row('선택 모델', '<strong>' + escapeHTML(preview.selected_model || '-') + '</strong>' + (preview.selected_provider ? ' <span class="muted">/ ' + escapeHTML(preview.selected_provider) + '</span>' : '')) +
        row('Complexity', fmt(complexity.score || 0) + ' <span class="muted">' + escapeHTML(complexity.tier || '') + '</span>') +
        row('Risk', fmt(risk.score || 0) + ' <span class="muted">' + escapeHTML((risk.categories || []).join(', ') || '-') + '</span>') +
        row('Rewrite', preview.would_rewrite ? '<span class="status warn">yes</span>' : '<span class="status">no</span>') +
        row('Route reason', escapeHTML(preview.route_reason || '-')) +
        row('Decision reason', escapeHTML(preview.decision_reason || '-')) +
        row('Fallback', escapeHTML((preview.fallback_path || []).join(' → ') || '-')) +
      '</div>';
    }
    function chatTestHeadersTable(headers) {
      const entries = Object.entries(headers || {}).sort((a, b) => a[0].localeCompare(b[0]));
      if (!entries.length) return '<div class="empty">응답 헤더 없음</div>';
      return '<table><thead><tr><th data-sort="str">Header</th><th>Value</th></tr></thead><tbody>' +
        entries.map(([k, v]) => '<tr><td><code>' + escapeHTML(k) + '</code></td><td>' + escapeHTML(v) + '</td></tr>').join('') +
        '</tbody></table>';
    }

    // ---------- MCP / tool observability ----------
    // MCP Tool Trust Score — 도구별 신뢰 점수(오류율·위험도 기반).
    window.mcpLoadTrust = async () => {
      const host = document.getElementById('mcp-trust');
      if (!host) return;
      let d;
      try { d = await api('/admin/mcp/trust-scores?days=30'); } catch (e) { host.innerHTML = ''; return; }
      const tools = d.tools || [];
      if (!tools.length) { host.innerHTML = ''; return; }
      const gradeCls = (g) => g === 'A' ? '' : (g === 'B' ? '' : (g === 'C' ? 'warn' : 'error'));
      const rows = tools.map(t =>
        '<tr><td>' + escapeHTML(t.ref) + (t.confidence === 'low' ? ' <span class="muted" style="font-size:9px">표본부족</span>' : '') + '</td>' +
        '<td><span class="status ' + gradeCls(t.grade) + '">' + escapeHTML(t.grade) + ' ' + (t.trust_score||0).toFixed(0) + '</span></td>' +
        '<td>' + escapeHTML(t.risk_level) + '</td>' +
        '<td>' + fmt(t.calls) + '</td><td>' + (t.error_rate_pct||0).toFixed(1) + '%</td>' +
        '<td>' + fmt(t.distinct_users) + '</td></tr>').join('');
      host.innerHTML = section('MCP Tool 신뢰 점수 (최근 30일)', card('신뢰도 낮은 순',
        '<div class="card-body"><table><thead><tr><th>도구</th><th>점수</th><th>위험도</th><th>호출</th><th>오류율</th><th>사용자</th></tr></thead><tbody>' + rows + '</tbody></table>' +
        '<p class="muted" style="font-size:10px;margin-top:4px">' + escapeHTML(d.note || '') + '</p></div>'));
    };

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

      const [overviewResp, routesResp, topologyResp, serversResp, toolsResp, policiesResp, loopsResp, catalogResp, upstreamsResp] = await Promise.all([
        api('/admin/mcp/overview').catch(() => null),
        api('/admin/mcp/routes').catch(() => ({ routes: [], errors: {} })),
        api('/admin/mcp/topology').catch(() => ({ nodes: [], edges: [] })),
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
      const routeRows = routesResp.routes || [];
      window.mcpRouteRows = routeRows;
      window.mcpTopology = topologyResp || { nodes: [], edges: [] };

      const ov = overviewResp || {};
      const kpis = '<div class="kpis">' +
        kpi('업스트림 상태', fmt(ov.healthy_upstream_count ?? 0) + ' / ' + fmt(ov.enabled_upstream_count ?? 0) + '<div class="muted" style="font-size:11px; font-weight:500; margin-top:6px">등록 ' + fmt(ov.upstream_count ?? 0) + '개</div>') +
        kpi('노출 Route', fmt((ov.total_tools || 0) + (ov.total_prompts || 0) + (ov.total_resources || 0)) + '<div class="muted" style="font-size:11px; font-weight:500; margin-top:6px">tool ' + fmt(ov.total_tools || 0) + ' · prompt ' + fmt(ov.total_prompts || 0) + ' · resource ' + fmt(ov.total_resources || 0) + '</div>') +
        kpi('최근 MCP 호출', fmt(ov.recent_call_count ?? summary.total_calls) + '<div class="muted" style="font-size:11px; font-weight:500; margin-top:6px">오류율 ' + ((Number(ov.recent_error_rate || 0) * 100).toFixed(1)) + '%</div>') +
        kpi('운영 경고', fmt((ov.discovery_error_count || 0) + (ov.blocked_count || 0)) + '<div class="muted" style="font-size:11px; font-weight:500; margin-top:6px">탐색 오류 ' + fmt(ov.discovery_error_count || 0) + ' · 차단 정책 ' + fmt(ov.blocked_count || 0) + '</div>') +
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
          '<td><span class="pill">' + escapeHTML(accessClassLabel(risk.access_class)) + '</span>' + (risk.recommended_action && risk.recommended_action !== 'allow' ? '<div class="muted" style="font-size:11px">권장: ' + escapeHTML(risk.recommended_action) + '</div>' : '') + '</td>' +
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
        '<table><thead><tr><th data-sort="str">tool</th><th data-sort="str">접근등급</th><th data-sort="str">risk</th><th data-sort="str">action</th><th data-sort="num">정의</th><th data-sort="num">호출</th><th data-sort="num">결과</th><th data-sort="num">오류</th><th data-sort="num">오류율</th><th data-sort="num">고유 키</th><th data-sort="num">호출 IP</th><th>정책</th><th>드릴다운</th></tr></thead><tbody>' + toolRows + '</tbody></table>'
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
          '<td><button class="secondary" type="button" onclick="showMCPUpstreamFlow(\'' + escapeAttr(u.id) + '\')">Flow</button> ' +
          '<button class="secondary" type="button" onclick="testMCPUpstream(\'' + escapeAttr(u.id) + '\')">테스트/도구</button> ' +
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

      const routeMapTable = mcpRouteMapTable(routeRows);
      const effectivePolicyTable = mcpEffectivePolicyTable(routeRows, riskByTool, allowlistEnabled, policies);
      const topologyView = mcpTopologyView(topologyResp || {});
      const wizard = mcpWizardView(upstreams, routeRows, policies, allowlistEnabled, servers, serverFilter);
      const testConsole =
        '<form class="inline-form" id="mcp-route-explain-form" autocomplete="off" style="grid-template-columns: 150px minmax(180px,1fr) minmax(180px,1fr) 90px 90px;">' +
          '<select id="mcp-explain-method">' +
            '<option value="tools/call">tools/call</option>' +
            '<option value="prompts/get">prompts/get</option>' +
            '<option value="resources/read">resources/read</option>' +
            '<option value="tools/list">tools/list</option>' +
            '<option value="prompts/list">prompts/list</option>' +
            '<option value="resources/list">resources/list</option>' +
          '</select>' +
          '<input id="mcp-explain-name" placeholder="노출명 예: github__create_issue">' +
          '<input id="mcp-explain-uri" placeholder="resource URI 또는 비워둠">' +
          '<button type="submit">Explain</button>' +
          '<button type="button" class="secondary" id="mcp-test-run">Test</button>' +
        '</form>' +
        '<div id="mcp-route-explain-result" class="card-body"><span class="muted">Route Map 행의 Explain 버튼을 누르거나 method/name을 입력하세요.</span></div>';

      const agenticFlowPanel =
        '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:4px 0 12px">' +
          '<button class="secondary" type="button" onclick="loadMCPAgenticRequests()">최근 MCP 요청 조회</button>' +
          '<span class="muted" id="mcp-flow-hint" style="font-size:12px">버튼을 눌러 최근 MCP 요청을 불러옵니다. 요청을 선택하면 실행 흐름 그래프가 표시됩니다.</span>' +
        '</div>' +
        '<div id="mcp-flow-list" style="margin-bottom:8px"></div>' +
        '<div id="mcp-flow-graph"></div>';

      document.getElementById('view').innerHTML =
        section('MCP 운영 Overview', kpis + filterBar) +
        section('에이전틱 실행 흐름 — 질문에서 도구 실행까지', agenticFlowPanel) +
        section('MCP 연결 상태 Wizard', wizard) +
        section('MCP Route Explain / Test Console', testConsole) +
        section('MCP Gateway — 업스트림 등록과 연결 진단', upstreamForm + upstreamTable + gatewayHelp) +
        section('Route Map — 클라이언트 노출명 → 업스트림 원본', routeMapTable) +
        section('Effective Policy Matrix — 최종 호출 가능 여부', effectivePolicyTable) +
        section('Topology — Gateway / Upstream / Route 관계', topologyView) +
        section('MCP 서버별', serverTable) +
        section('Tool 리더보드', toolTable) +
        '<div id="mcp-trust"></div>' +
        section('에이전트 루프 의심 (세션별 반복 호출 ≥ 10)', loopTable) +
        section(catalogTitle, catalogTable) +
        section('MCP 서버 정책', allowlistToggle + policyForm + policyTable);

      mcpLoadTrust();

      const wizardSelect = document.getElementById('mcp-wizard-upstream');
      if (wizardSelect) {
        wizardSelect.addEventListener('change', () => {
          window.mcpWizardSelected = wizardSelect.value;
          refreshMCPWizardSelection(wizardSelect.value);
        });
      }
      const wizardRegister = document.getElementById('mcp-wizard-register');
      if (wizardRegister) {
        wizardRegister.addEventListener('click', async () => {
          const name = document.getElementById('mcp-wizard-name').value.trim();
          const url = document.getElementById('mcp-wizard-url').value.trim();
          const auth = document.getElementById('mcp-wizard-auth').value;
          if (!name || !url) { alert('Wizard 등록에는 이름과 URL이 필요합니다.'); return; }
          const created = await api('/admin/mcp/upstreams', { method: 'POST', body: JSON.stringify({ name, url, auth_token: auth }) });
          const up = (created && created.upstream) || {};
          window.mcpWizardSelected = up.id || name;
          location.hash = '#/mcp?server=' + encodeURIComponent(up.name || name);
          route();
        });
      }
      const wizardProbe = document.getElementById('mcp-wizard-probe');
      if (wizardProbe) {
        wizardProbe.addEventListener('click', async () => {
          const id = document.getElementById('mcp-wizard-upstream').value;
          if (!id) return;
          await window.testMCPUpstream(id);
        });
      }
      const wizardFlow = document.getElementById('mcp-wizard-flow');
      if (wizardFlow) {
        wizardFlow.addEventListener('click', async () => {
          const id = document.getElementById('mcp-wizard-upstream').value;
          if (!id) return;
          await window.showMCPUpstreamFlow(id);
        });
      }
      const wizardExplain = document.getElementById('mcp-wizard-explain');
      if (wizardExplain) {
        wizardExplain.addEventListener('click', async () => {
          const id = document.getElementById('mcp-wizard-upstream').value;
          const routeRows = window.mcpRouteRows || [];
          const routeRow = routeRows.find(r => (r.upstream_id || r.upstream_name) === id && r.kind === 'tool') || routeRows.find(r => r.upstream_id === id || r.upstream_name === id);
          if (!routeRow) { alert('이 업스트림의 노출 route가 아직 없습니다. 먼저 Probe를 실행하세요.'); return; }
          await window.explainMCPRouteFromRow(routeRow.kind || 'tool', routeRow.uri || routeRow.exposed_name || '');
        });
      }
      const wizardLogs = document.getElementById('mcp-wizard-logs');
      if (wizardLogs) {
        wizardLogs.addEventListener('click', async () => {
          const id = document.getElementById('mcp-wizard-upstream').value;
          const up = (window.mcpWizardUpstreams || []).find(x => x.id === id) || {};
          await window.mcpToolRequests(up.name || id, '', false);
        });
      }

      document.getElementById('mcp-upstream-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const body = {
          name: document.getElementById('mcp-up-name').value.trim(),
          url: document.getElementById('mcp-up-url').value.trim(),
          auth_token: document.getElementById('mcp-up-auth').value,
        };
        if (!body.name || !body.url) { alert('이름과 URL을 입력하세요'); return; }
        try {
          await api('/admin/mcp/upstreams', { method: 'POST', body: JSON.stringify(body) });
          route();
        } catch (err) {
          // Onboarding activation gate (HTTP 422): show failed required items and offer force.
          let parsed = null;
          try { parsed = JSON.parse(err.message); } catch (_) {}
          if (parsed && parsed.error && parsed.error.code === 'onboarding_incomplete') {
            const items = (parsed.failed || []).map(c => '• ' + c.key + ' — ' + c.detail).join('\n');
            if (confirm('활성화 온보딩 필수 항목 미충족:\n\n' + items + '\n\n그래도 강제로 등록·활성화할까요?')) {
              await api('/admin/mcp/upstreams?force=1', { method: 'POST', body: JSON.stringify(body) });
              route();
            }
            return;
          }
          alert('등록 실패: ' + err.message);
        }
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
      document.getElementById('mcp-route-explain-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        await runMCPRouteExplain(false);
      });
      document.getElementById('mcp-test-run').addEventListener('click', async () => {
        await runMCPRouteExplain(true);
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
    function mcpWizardView(upstreams, routes, policies, allowlistEnabled, servers, preferredSelection) {
      window.mcpWizardUpstreams = upstreams || [];
      window.mcpWizardRoutes = routes || [];
      window.mcpWizardPolicies = policies || [];
      window.mcpWizardServers = servers || [];
      const selected = mcpWizardSelectedID(upstreams, preferredSelection);
      window.mcpWizardSelected = selected;
      const options = (upstreams || []).map(u =>
        '<option value="' + escapeAttr(u.id) + '"' + (u.id === selected ? ' selected' : '') + '>' + escapeHTML(u.name || u.id) + '</option>'
      ).join('');
      const selectedState = mcpWizardState(selected, upstreams, routes, policies, allowlistEnabled, servers);
      const registerForm =
        '<div class="inline-form" style="grid-template-columns: minmax(120px,1fr) minmax(220px,2fr) minmax(120px,1fr) 90px; border-bottom:1px solid var(--line)">' +
          '<input id="mcp-wizard-name" placeholder="업스트림 이름">' +
          '<input id="mcp-wizard-url" type="url" placeholder="Streamable HTTP URL">' +
          '<input id="mcp-wizard-auth" type="password" autocomplete="new-password" placeholder="Bearer 토큰(선택)">' +
          '<button type="button" id="mcp-wizard-register">등록</button>' +
        '</div>';
      const selector =
        '<div class="toolbar" style="border-bottom:1px solid var(--line)">' +
          '<select id="mcp-wizard-upstream" ' + (options ? '' : 'disabled') + '>' + options + '</select>' +
          '<button type="button" class="secondary" id="mcp-wizard-probe" ' + (selected ? '' : 'disabled') + '>연결 테스트</button>' +
          '<button type="button" class="secondary" id="mcp-wizard-flow" ' + (selected ? '' : 'disabled') + '>Flow</button>' +
          '<button type="button" class="secondary" id="mcp-wizard-explain" ' + (selected ? '' : 'disabled') + '>정책/Route 확인</button>' +
          '<button type="button" class="secondary" id="mcp-wizard-logs" ' + (selected ? '' : 'disabled') + '>로그 확인</button>' +
        '</div>';
      return registerForm + selector + '<div id="mcp-wizard-steps">' + mcpWizardStepsHTML(selectedState) + '</div>';
    }
    function mcpWizardSelectedID(upstreams, preferredSelection) {
      const list = upstreams || [];
      if (!list.length) return '';
      const preferred = String(preferredSelection || '').trim();
      const remembered = String(window.mcpWizardSelected || '').trim();
      const match = (needle) => needle ? list.find(u => u.id === needle || u.name === needle) : null;
      const selected = match(preferred) || match(remembered) || list[0];
      return selected ? selected.id : '';
    }
    function mcpWizardState(id, upstreams, routes, policies, allowlistEnabled, servers) {
      const up = (upstreams || []).find(u => u.id === id) || {};
      const name = up.name || id || '';
      const routeMatches = (routes || []).filter(r => (r.upstream_id || '') === id || (r.upstream_name || '') === name);
      const server = (servers || []).find(s => (s.server_label || '') === name) || {};
      const policy = (policies || []).find(p => (p.server_label || '') === name) || {};
      const finalDecision = policy.mode === 'block' ? 'block' : (allowlistEnabled && policy.mode !== 'allow' ? 'block' : (policy.mode === 'warn' ? 'warn' : 'allow'));
      const firstTool = routeMatches.find(r => r.kind === 'tool') || routeMatches[0] || {};
      return {
        registered: !!id,
        enabled: !!up.enabled,
        name,
        routeCount: routeMatches.length,
        firstRoute: firstTool.exposed_name || firstTool.uri || '',
        policy: finalDecision,
        policyReason: policy.mode ? ('server policy: ' + policy.mode) : (allowlistEnabled ? 'allowlist 미등록이면 차단' : '기본 허용'),
        calls: Number(server.calls || 0),
        errors: Number(server.errors || 0),
      };
    }
    function mcpWizardStepsHTML(st) {
      const cls = (ok, warn) => ok ? 'ready' : (warn ? 'warn' : 'blocked');
      const routeReady = st.routeCount > 0;
      const allowed = st.policy !== 'block';
      const hasCalls = st.calls > 0;
      const errText = hasCalls ? errorRatePct(st.errors, st.calls) : '아직 호출 로그 없음';
      return '<div class="stepper">' +
        '<div class="step ' + cls(st.registered, false) + '"><strong>1. 등록</strong><div class="muted">' + (st.registered ? escapeHTML(st.name) : '업스트림 등록 필요') + '</div></div>' +
        '<div class="step ' + cls(st.enabled, st.registered) + '"><strong>2. 활성화</strong><div class="muted">' + (st.enabled ? 'enabled' : (st.registered ? 'disabled' : '대상 없음')) + '</div></div>' +
        '<div class="step ' + cls(routeReady, st.registered) + '"><strong>3. 도구 목록</strong><div class="muted">' + fmt(st.routeCount) + '개 route' + (st.firstRoute ? '<br><code>' + escapeHTML(st.firstRoute) + '</code>' : '') + '</div></div>' +
        '<div class="step ' + cls(allowed, st.policy === 'warn') + '"><strong>4. 정책</strong><div class="muted">' + escapeHTML(st.policy) + '<br>' + escapeHTML(st.policyReason) + '</div></div>' +
        '<div class="step ' + cls(routeReady && allowed, routeReady && !allowed) + '"><strong>5. 호출 준비</strong><div class="muted">' + (routeReady && allowed ? 'Explain/Test 가능' : 'route 또는 정책 확인 필요') + '</div></div>' +
        '<div class="step ' + cls(hasCalls, st.registered) + '"><strong>6. 관측 로그</strong><div class="muted">' + fmt(st.calls) + '건<br>' + escapeHTML(errText) + '</div></div>' +
      '</div>';
    }
    function refreshMCPWizardSelection(id) {
      const host = document.getElementById('mcp-wizard-steps');
      if (!host) return;
      const st = mcpWizardState(id, window.mcpWizardUpstreams || [], window.mcpWizardRoutes || [], window.mcpWizardPolicies || [], !!document.getElementById('mcp-allowlist')?.checked, window.mcpWizardServers || []);
      host.innerHTML = mcpWizardStepsHTML(st);
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
    function mcpRouteMapTable(routes) {
      if (!routes || !routes.length) return '<div class="empty">현재 노출된 MCP route 없음. 업스트림을 등록하고 probe 또는 route refresh를 실행하세요.</div>';
      return '<table><thead><tr>' +
        '<th data-sort="str">종류</th><th data-sort="str">클라이언트 노출명</th><th data-sort="str">업스트림</th><th data-sort="str">원본 대상</th><th>설명</th><th>상태</th><th>동작</th>' +
      '</tr></thead><tbody>' +
      routes.map(r => {
        const exposed = r.exposed_name || r.uri || '';
        return '<tr>' +
          '<td><span class="pill">' + escapeHTML(r.kind || '') + '</span></td>' +
          '<td><code>' + escapeHTML(exposed) + '</code></td>' +
          '<td>' + escapeHTML(r.upstream_name || '') + '<div class="muted">' + escapeHTML(r.upstream_id || '') + '</div></td>' +
          '<td>' + escapeHTML(r.target_method || '') + '<div class="muted">' + escapeHTML(r.target_name || '') + '</div></td>' +
          '<td class="muted">' + escapeHTML(r.description || '') + '</td>' +
          '<td>' + (r.discovery_error ? '<span class="status error" title="' + escapeAttr(r.discovery_error) + '">discovery error</span>' : '<span class="status">routable</span>') + '<div class="muted">' + ago(r.last_discovered_at) + '</div></td>' +
          '<td><button class="secondary" type="button" onclick="explainMCPRouteFromRow(\'' + escapeAttr(r.kind || '') + '\',\'' + escapeAttr(exposed) + '\')">Explain</button></td>' +
        '</tr>';
      }).join('') + '</tbody></table>';
    }
    function mcpEffectivePolicyTable(routes, riskByTool, allowlistEnabled, policies) {
      const policyByServer = {};
      (policies || []).forEach(p => { policyByServer[p.server_label || ''] = p.mode || 'allow'; });
      const rows = (routes || []).filter(r => r.kind === 'tool').map(r => {
        const server = r.upstream_name || '';
        const tool = r.target_name || '';
        const risk = (riskByTool || {})[server + '\u0000' + tool] || {};
        const serverPolicy = policyByServer[server] || (allowlistEnabled ? 'not_in_allowlist' : 'allow');
        const action = risk.action || 'allow';
        let decision = 'allow';
        let reason = '허용';
        if (serverPolicy === 'block' || serverPolicy === 'not_in_allowlist') {
          decision = 'block'; reason = serverPolicy;
        } else if (action === 'block') {
          decision = 'block'; reason = 'tool risk block';
        } else if (action === 'require_approval') {
          decision = 'approval_required'; reason = 'tool risk approval';
        } else if (serverPolicy === 'warn') {
          decision = 'warn'; reason = 'server warn';
        }
        return { route: r, risk, serverPolicy, decision, reason };
      });
      if (!rows.length) return '<div class="empty">정책을 계산할 tool route가 없습니다.</div>';
      return '<table><thead><tr>' +
        '<th data-sort="str">노출명</th><th data-sort="str">업스트림</th><th data-sort="str">서버 정책</th><th data-sort="str">Tool Risk</th><th data-sort="str">최종 상태</th><th>동작</th>' +
      '</tr></thead><tbody>' +
      rows.map(x => '<tr>' +
        '<td><code>' + escapeHTML(x.route.exposed_name || '') + '</code><div class="muted">' + escapeHTML(x.route.target_name || '') + '</div></td>' +
        '<td>' + escapeHTML(x.route.upstream_name || '') + '<div class="muted">' + escapeHTML(x.route.upstream_id || '') + '</div></td>' +
        '<td><span class="status ' + governanceStatusClass(x.serverPolicy) + '">' + escapeHTML(x.serverPolicy) + '</span></td>' +
        '<td><span class="status ' + governanceStatusClass(x.risk.risk_level || 'low') + '">' + escapeHTML(x.risk.risk_level || 'low') + '</span> ' +
          '<span class="status ' + governanceStatusClass(x.risk.action || 'allow') + '">' + escapeHTML(x.risk.action || 'allow') + '</span>' +
          (x.risk.configured ? '<div class="muted">configured</div>' : '<div class="muted">inferred</div>') + '</td>' +
        '<td><span class="status ' + governanceStatusClass(x.decision) + '">' + escapeHTML(x.decision) + '</span><div class="muted">' + escapeHTML(x.reason) + '</div></td>' +
        '<td><button class="secondary" type="button" onclick="showMCPEffectivePolicy(\'' + escapeAttr(x.route.upstream_name || '') + '\',\'' + escapeAttr(x.route.target_name || '') + '\')">API 확인</button></td>' +
      '</tr>').join('') + '</tbody></table>';
    }
    function mcpTopologyView(topology) {
      const nodes = (topology && topology.nodes) || [];
      const edges = (topology && topology.edges) || [];
      if (!nodes.length) return '<div class="empty">토폴로지 데이터 없음</div>';

      const upstreamNodes = nodes.filter(n => n.kind === 'upstream');
      const routeNodes   = nodes.filter(n => n.kind === 'tool' || n.kind === 'prompt' || n.kind === 'resource');

      const NW = 140, NH = 34, GAP_Y = 8, GAP_X = 72, PAD = 16, CAP = 40;
      const C0 = PAD, C1 = PAD + NW + GAP_X, C2 = PAD + 2*(NW + GAP_X);
      const capped = routeNodes.slice(0, CAP);
      const rows = Math.max(Math.max(upstreamNodes.length, capped.length), 1);
      const svgH = rows * (NH + GAP_Y) + PAD * 2 + 26;
      const svgW = C2 + NW + PAD;
      const gwY  = (svgH - NH) / 2;

      const nodePos = { __gw__: { x: C0, y: gwY } };
      upstreamNodes.forEach((n,i) => { nodePos[n.id] = { x: C1, y: PAD+22+i*(NH+GAP_Y) }; });
      capped.forEach((n,i)        => { nodePos[n.id] = { x: C2, y: PAD+22+i*(NH+GAP_Y) }; });

      const kindFill = { gateway:'#2563eb', upstream:'#7c3aed', tool:'#059669', prompt:'#d97706', resource:'#4f46e5' };
      function svgNode(id, kind, label) {
        const p = nodePos[id]; if (!p) return '';
        const fill = kindFill[kind] || '#6b7280';
        const hasKind = kind !== 'gateway';
        return '<rect x="'+p.x+'" y="'+p.y+'" width="'+NW+'" height="'+NH+'" rx="6" fill="'+fill+'"/>' +
          '<text x="'+(p.x+NW/2)+'" y="'+(p.y+NH/2+(hasKind?-5:4))+'" text-anchor="middle" font-size="11" fill="#fff" font-family="system-ui">'+escapeHTML(label.substring(0,20))+'</text>' +
          (hasKind ? '<text x="'+(p.x+NW/2)+'" y="'+(p.y+NH/2+9)+'" text-anchor="middle" font-size="8" fill="rgba(255,255,255,0.6)" font-family="system-ui">'+kind+'</text>' : '');
      }
      function svgEdge(fromId, toId) {
        const f = nodePos[fromId], t = nodePos[toId]; if (!f || !t) return '';
        const x1=f.x+NW, y1=f.y+NH/2, x2=t.x, y2=t.y+NH/2, cx=(x1+x2)/2;
        return '<path d="M'+x1+','+y1+' C'+cx+','+y1+' '+cx+','+y2+' '+x2+','+y2+'" fill="none" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#topo-arr)" opacity="0.7"/>';
      }

      const upEdgeByRoute = {};
      edges.forEach(e => { if (nodePos[e.from] && nodePos[e.to]) upEdgeByRoute[e.to] = e.from; });

      let svgE = '', svgN = '';
      svgN += svgNode('__gw__', 'gateway', 'Gateway');
      upstreamNodes.forEach(n => { svgE += svgEdge('__gw__', n.id); svgN += svgNode(n.id, 'upstream', n.label||n.id||''); });
      capped.forEach((n,i) => {
        const from = upEdgeByRoute[n.id] || ((upstreamNodes[i % Math.max(upstreamNodes.length,1)]||{}).id || '__gw__');
        svgE += svgEdge(from, n.id);
        svgN += svgNode(n.id, n.kind||'tool', n.label||n.id||'');
      });
      const overflow = routeNodes.length > CAP
        ? '<text x="'+(C2+NW/2)+'" y="'+(svgH-4)+'" text-anchor="middle" font-size="9" fill="#94a3b8" font-family="system-ui">+' + (routeNodes.length-CAP) + '개 더...</text>'
        : '';
      const colLbls = [
        '<text x="'+(C0+NW/2)+'" y="14" text-anchor="middle" font-size="9" fill="#94a3b8" font-family="system-ui">게이트웨이</text>',
        '<text x="'+(C1+NW/2)+'" y="14" text-anchor="middle" font-size="9" fill="#94a3b8" font-family="system-ui">업스트림 ('+upstreamNodes.length+')</text>',
        '<text x="'+(C2+NW/2)+'" y="14" text-anchor="middle" font-size="9" fill="#94a3b8" font-family="system-ui">Route ('+routeNodes.length+')</text>',
      ].join('');

      return '<div class="kpis">' +
          kpi('Gateway', '1') +
          kpi('Upstream', fmt(upstreamNodes.length)) +
          kpi('Route', fmt(routeNodes.length)) +
          kpi('Edge', fmt(edges.length)) +
        '</div>' +
        '<div style="overflow-x:auto;overflow-y:auto;max-height:540px">' +
        '<svg viewBox="0 0 '+svgW+' '+svgH+'" style="width:'+svgW+'px;display:block" xmlns="http://www.w3.org/2000/svg">' +
        '<defs><marker id="topo-arr" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto"><polygon points="0 0,8 3,0 6" fill="#94a3b8"/></marker></defs>' +
        colLbls + svgE + svgN + overflow +
        '</svg></div>';
    }

    function mcpAgenticFlowGraph(d) {
      const tools     = (d.tools || []).filter(t => t.server_label || t.is_mcp);
      const decisions = d.route_decisions || [];
      const latency   = d.latency_ms || 0;
      const ok        = Number(d.status || 200) < 400;

      const NW = 148, NH = 50, GAP_X = 54, PAD_X = 14, PAD_Y = 42;
      const TOOL_ROW = 64;
      const toolCount = Math.max(tools.length, 1);
      const svgH = toolCount * TOOL_ROW + PAD_Y * 2;
      const midY = svgH / 2;
      const C = [PAD_X, PAD_X+NW+GAP_X, PAD_X+2*(NW+GAP_X), PAD_X+3*(NW+GAP_X), PAD_X+4*(NW+GAP_X)];
      const svgW = C[4] + NW + PAD_X;
      const toolStartY = midY - (toolCount * TOOL_ROW)/2 + (TOOL_ROW-NH)/2;

      const decByTool = {};
      decisions.forEach(dec => {
        if (dec.target_name)  decByTool[dec.target_name]  = dec;
        if (dec.exposed_name) decByTool[dec.exposed_name] = dec;
        const bare = (dec.target_name||'').split('__').pop();
        if (bare) decByTool[bare] = dec;
      });

      function fnode(x, y, fill, stroke, l1, l2) {
        return '<rect x="'+x+'" y="'+y+'" width="'+NW+'" height="'+NH+'" rx="10" fill="'+fill+'" stroke="'+stroke+'" stroke-width="1.5"/>' +
          '<text x="'+(x+NW/2)+'" y="'+(y+NH/2+(l2?-7:0))+'" text-anchor="middle" dominant-baseline="middle" font-size="12" font-weight="700" fill="#fff" font-family="system-ui">'+escapeHTML(String(l1||''))+'</text>' +
          (l2 ? '<text x="'+(x+NW/2)+'" y="'+(y+NH/2+11)+'" text-anchor="middle" font-size="9" fill="rgba(255,255,255,0.78)" font-family="system-ui">'+escapeHTML(String(l2))+'</text>' : '');
      }
      function arc(x1, y1, x2, y2, col) {
        const mx = (x1+x2)/2;
        return '<path d="M'+x1+','+y1+' C'+mx+','+y1+' '+mx+','+y2+' '+x2+','+y2+'" stroke="'+col+'" stroke-width="2" fill="none" marker-end="url(#flow-arr)"/>';
      }

      const defs = '<defs><marker id="flow-arr" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto"><polygon points="0 0,8 3,0 6" fill="#94a3b8"/></marker></defs>';
      const lblY = PAD_Y - 24;
      const colTitles = ['질의','LLM','도구 실행','응답 합성','최종 응답'];
      const lbls = C.map((cx,i) => '<text x="'+(cx+NW/2)+'" y="'+lblY+'" text-anchor="middle" font-size="9" fill="#94a3b8" font-family="system-ui">'+colTitles[i]+'</text>').join('');

      let svgN = '', svgE = '', svgBadge = '';

      // Query node
      svgN += fnode(C[0], midY-NH/2, '#2563eb', '#1d4ed8', '사용자 질의', 'User Query');

      // LLM Turn 1
      svgN += fnode(C[1], midY-NH/2, '#7c3aed', '#5b21b6', 'LLM 에이전틱', tools.length + '개 도구 선택');
      svgE += arc(C[0]+NW, midY, C[1], midY, '#94a3b8');

      // Tool nodes
      tools.forEach(function(t, i) {
        const ty     = toolStartY + i * TOOL_ROW;
        const toolCY = ty + NH/2;
        const tname  = (t.tool_name||'').split('__').pop() || t.tool_name || 'tool';
        const dec    = decByTool[t.tool_name] || decByTool[tname] || {};
        const risk   = dec.tool_risk_level || '';
        const decision = dec.final_decision || 'allow';
        const isErr  = !!t.is_error;

        let fill, stroke;
        if (isErr || decision === 'block') { fill = '#dc2626'; stroke = '#991b1b'; }
        else if (risk === 'critical')      { fill = '#dc2626'; stroke = '#991b1b'; }
        else if (risk === 'high')          { fill = '#d97706'; stroke = '#b45309'; }
        else if (risk === 'medium')        { fill = '#0284c7'; stroke = '#0369a1'; }
        else                               { fill = '#059669'; stroke = '#047857'; }

        const server = (t.server_label||'').substring(0,16);
        svgN += fnode(C[2], ty, fill, stroke, tname.substring(0,16), server || (isErr ? 'error' : (risk || 'ok')));

        const bc = decision==='allow' ? '#16a34a' : decision==='block' ? '#dc2626' : '#d97706';
        svgBadge += '<rect x="'+(C[2]+NW-32)+'" y="'+(ty-1)+'" width="30" height="13" rx="4" fill="'+bc+'"/>';
        svgBadge += '<text x="'+(C[2]+NW-17)+'" y="'+(ty+9)+'" text-anchor="middle" font-size="7.5" fill="#fff" font-family="system-ui" font-weight="600">'+escapeHTML(decision)+'</text>';
        if (t.arg_hash) {
          svgBadge += '<text x="'+(C[2])+'" y="'+(ty+NH+11)+'" font-size="7" fill="#94a3b8" font-family="system-ui">args: '+escapeHTML(t.arg_hash.substring(0,20))+'</text>';
        }

        svgE += arc(C[1]+NW, midY, C[2], toolCY, '#a78bfa');
        svgE += arc(C[2]+NW, toolCY, C[3], midY, isErr ? '#fca5a5' : '#6ee7b7');
      });

      if (!tools.length) {
        svgN += fnode(C[2], midY-NH/2, '#6b7280', '#4b5563', '(직접 응답)', 'No MCP tool');
        svgE += arc(C[1]+NW, midY, C[2], midY, '#94a3b8');
        svgE += arc(C[2]+NW, midY, C[3], midY, '#94a3b8');
      }

      // LLM synthesis
      svgN += fnode(C[3], midY-NH/2, '#7c3aed', '#5b21b6', 'LLM 합성', '최종 답변 생성');

      // Answer
      const ac = ok ? '#059669' : '#dc2626', as_ = ok ? '#047857' : '#991b1b';
      svgN += fnode(C[4], midY-NH/2, ac, as_, '최종 응답', ok ? fmt(latency)+'ms' : 'HTTP '+d.status);
      svgE += arc(C[3]+NW, midY, C[4], midY, '#94a3b8');

      return '<div style="overflow-x:auto">' +
        '<svg viewBox="0 0 '+svgW+' '+svgH+'" style="min-width:'+svgW+'px;width:100%;display:block" xmlns="http://www.w3.org/2000/svg">' +
        defs + lbls + svgE + svgN + svgBadge +
        '</svg></div>';
    }
    function mcpMethodForKind(kind) {
      if (kind === 'prompt') return 'prompts/get';
      if (kind === 'resource') return 'resources/read';
      return 'tools/call';
    }
    function mcpExplainPayloadFromForm() {
      const method = document.getElementById('mcp-explain-method').value;
      const name = document.getElementById('mcp-explain-name').value.trim();
      const uri = document.getElementById('mcp-explain-uri').value.trim();
      return { method, name, uri };
    }
    function mcpExplainHTML(d) {
      const route = d.route || {};
      const pol = d.policy || {};
      const fin = d.final || {};
      const routeBlock = '<div class="kv">' +
        row('Route', route.found ? '<span class="status">found</span>' : '<span class="status error">missing</span>') +
        row('업스트림', escapeHTML((route.upstream_name || '') + (route.upstream_id ? ' / ' + route.upstream_id : ''))) +
        row('대상', escapeHTML((route.target_method || '') + ' ' + (route.target_name || ''))) +
        row('서버 정책', '<span class="status ' + governanceStatusClass(pol.server_policy) + '">' + escapeHTML(pol.server_policy || '-') + '</span>') +
        row('Tool Risk', '<span class="status ' + governanceStatusClass(pol.tool_risk_level) + '">' + escapeHTML(pol.tool_risk_level || '-') + '</span> · <span class="status ' + governanceStatusClass(pol.tool_risk_action) + '">' + escapeHTML(pol.tool_risk_action || '-') + '</span>' + (pol.tool_risk_configured ? ' <span class="pill">configured</span>' : '')) +
        row('최종 판단', '<span class="status ' + governanceStatusClass(fin.decision) + '">' + escapeHTML(fin.decision || '-') + '</span>') +
        row('근거', escapeHTML(fin.reason || '')) +
      '</div>';
      return routeBlock;
    }
    async function runMCPRouteExplain(runTest) {
      const host = document.getElementById('mcp-route-explain-result');
      const payload = mcpExplainPayloadFromForm();
      host.innerHTML = '<div class="empty">확인 중...</div>';
      try {
        const explain = await api('/admin/mcp/route/explain', { method: 'POST', body: JSON.stringify(payload) });
        let html = mcpExplainHTML(explain);
        if (runTest) {
          const route = explain.route || {};
          const final = explain.final || {};
          if (!route.found || final.decision === 'block') {
            html += '<div class="banner warn" style="margin-top:12px">Route가 없거나 최종 판단이 block이라 테스트 호출을 생략했습니다.</div>';
          } else {
            const testBody = { ...payload, upstream_id: route.upstream_id, method: route.target_method || payload.method };
            const tested = await api('/admin/mcp/test', { method: 'POST', body: JSON.stringify(testBody) });
            html += '<h4 style="margin:16px 0 6px">Test Result</h4><div class="kv">' +
              row('상태', tested.ok ? '<span class="status">ok</span>' : '<span class="status error">error</span>') +
              row('Latency', fmt(tested.latency_ms || 0) + ' ms') +
              row('Error', escapeHTML(tested.error || '')) +
              '</div><pre class="prompt-block" style="margin-top:10px">' + escapeHTML(tested.response_preview || '') + '</pre>';
          }
        }
        host.innerHTML = html;
      } catch (err) {
        host.innerHTML = '<div class="error-line">' + escapeHTML(err.message) + '</div>';
      }
    }
    window.explainMCPRouteFromRow = async (kind, exposed) => {
      const method = mcpMethodForKind(kind);
      document.getElementById('mcp-explain-method').value = method;
      if (kind === 'resource') {
        document.getElementById('mcp-explain-uri').value = exposed;
        document.getElementById('mcp-explain-name').value = '';
      } else {
        document.getElementById('mcp-explain-name').value = exposed;
        document.getElementById('mcp-explain-uri').value = '';
      }
      await runMCPRouteExplain(false);
    };
    window.showMCPEffectivePolicy = async (server, tool) => {
      try {
        const q = new URLSearchParams({ server, tool });
        const d = await api('/admin/mcp/effective-policy?' + q.toString());
        openModal('Effective MCP Policy — ' + server + '/' + tool, mcpExplainHTML({ route: { found: true, upstream_name: server, target_name: tool }, policy: d.policy || {}, final: d.final || {} }));
      } catch (err) {
        openModal('Effective Policy 오류', '<div class="error-line">' + escapeHTML(err.message) + '</div>');
      }
    };
    window.showMCPUpstreamFlow = async (id) => {
      openModal('MCP Upstream Flow — ' + id, '<div class="empty">조회 중...</div>');
      try {
        const d = await api('/admin/mcp/upstreams/' + encodeURIComponent(id) + '/flow');
        const steps = d.steps || [];
        const stepTable = '<table><thead><tr><th>Step</th><th>Status</th><th>Detail</th></tr></thead><tbody>' +
          steps.map(s => '<tr><td>' + escapeHTML(s.name || '') + '</td><td><span class="status ' + governanceStatusClass(s.status || '') + '">' + escapeHTML(String(s.status || '')) + '</span></td><td>' + escapeHTML(String(s.detail ?? '')) + '</td></tr>').join('') +
          '</tbody></table>';
        const runRows = (d.discovery_runs || []).map(x => '<tr>' +
          '<td>' + ago(x.created_at) + '</td>' +
          '<td><span class="status ' + governanceStatusClass(x.status || '') + '">' + escapeHTML(x.status || '') + '</span></td>' +
          '<td data-num="' + Number(x.tool_count || 0) + '">' + fmt(x.tool_count || 0) + '</td>' +
          '<td data-num="' + Number(x.prompt_count || 0) + '">' + fmt(x.prompt_count || 0) + '</td>' +
          '<td data-num="' + Number(x.resource_count || 0) + '">' + fmt(x.resource_count || 0) + '</td>' +
          '<td data-num="' + Number(x.latency_ms || 0) + '">' + fmt(x.latency_ms || 0) + ' ms</td>' +
          '<td>' + escapeHTML(x.error || '') + '</td>' +
        '</tr>').join('');
        const runTable = runRows
          ? '<table><thead><tr><th>시각</th><th>상태</th><th>Tools</th><th>Prompts</th><th>Resources</th><th>Latency</th><th>Error</th></tr></thead><tbody>' + runRows + '</tbody></table>'
          : '<div class="empty">저장된 discovery run 없음. 테스트/도구 버튼으로 probe를 실행하면 이력이 쌓입니다.</div>';
        const routes = mcpRouteMapTable(d.routes || []);
        const recent = requestsTable(d.recent_requests || [], { mcpWaterfall: true });
        openModal('MCP Upstream Flow — ' + escapeHTML((d.upstream || {}).name || id),
          '<div class="kv">' +
            row('URL', escapeHTML((d.upstream || {}).url || '')) +
            row('상태', ((d.upstream || {}).enabled ? '<span class="status">enabled</span>' : '<span class="status error">disabled</span>')) +
            row('정책', '<span class="status ' + governanceStatusClass(((d.final || {}).decision || '')) + '">' + escapeHTML((d.final || {}).decision || '') + '</span> ' + escapeHTML((d.final || {}).reason || '')) +
            row('Discovery Error', escapeHTML(d.discovery_error || '')) +
          '</div><h4>Flow</h4>' + stepTable + '<h4>Discovery Runs</h4>' + runTable + '<h4>Routes</h4>' + routes + '<h4>Recent Calls</h4>' + recent);
        attachRequestRowHandlers();
      } catch (err) {
        openModal('MCP Upstream Flow 오류', '<div class="error-line">' + escapeHTML(err.message) + '</div>');
      }
    };
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
        openModal(title, requestsTable(r.requests || [], { mcpWaterfall: true }));
        attachRequestRowHandlers();
      } catch (err) {
        openModal('오류', '<div class="error-line">' + escapeHTML(err.message) + '</div>');
      }
    };
    window.openMCPRequestWaterfall = async (id) => {
      openModal('MCP Waterfall — ' + id, '<div class="empty">조회 중...</div>');
      try {
        const d = await api('/admin/mcp/requests/' + encodeURIComponent(id) + '/waterfall');
        const steps = d.steps || [];
        const rows = steps.map((s, idx) => '<tr>' +
          '<td data-num="' + idx + '">' + (idx + 1) + '</td>' +
          '<td>' + escapeHTML(s.name || '') + '</td>' +
          '<td><span class="status ' + governanceStatusClass(String(s.status || '')) + '">' + escapeHTML(String(s.status || '')) + '</span></td>' +
          '<td>' + escapeHTML(typeof s.detail === 'string' ? s.detail : JSON.stringify(s.detail || {})) + '</td>' +
        '</tr>').join('');
        const toolRows = (d.tools || []).map(t => '<tr><td>' + escapeHTML(t.server_label || '') + '</td><td>' + escapeHTML(t.tool_name || '') + '</td><td>' + escapeHTML(t.source || '') + '</td><td>' + (t.is_error ? '<span class="status error">error</span>' : '<span class="status">ok</span>') + '</td><td>' + escapeHTML(t.arg_hash || '') + '</td></tr>').join('');
        const decisionRows = (d.route_decisions || []).map(x => '<tr>' +
          '<td>' + escapeHTML(x.method || '') + '<div class="muted">' + escapeHTML(x.exposed_name || '') + '</div></td>' +
          '<td>' + escapeHTML(x.upstream_name || '') + '<div class="muted">' + escapeHTML(x.target_name || '') + '</div></td>' +
          '<td><span class="status ' + governanceStatusClass(x.server_policy || '') + '">' + escapeHTML(x.server_policy || '') + '</span></td>' +
          '<td><span class="status ' + governanceStatusClass(x.tool_risk_level || '') + '">' + escapeHTML(x.tool_risk_level || '') + '</span> <span class="status ' + governanceStatusClass(x.tool_risk_action || '') + '">' + escapeHTML(x.tool_risk_action || '') + '</span></td>' +
          '<td><span class="status ' + governanceStatusClass(x.final_decision || '') + '">' + escapeHTML(x.final_decision || '') + '</span><div class="muted">' + escapeHTML(x.reason || '') + '</div></td>' +
          '<td data-num="' + Number(x.latency_ms || 0) + '">' + fmt(x.latency_ms || 0) + ' ms</td>' +
        '</tr>').join('');
        openModal('MCP Waterfall — ' + escapeHTML(d.trace_id || id),
          '<h4 style="margin:0 0 8px">실행 흐름 그래프</h4>' +
          mcpAgenticFlowGraph(d) +
          '<h4 style="margin:16px 0 6px">요청 정보</h4>' +
          '<div class="kv">' +
            row('Request', escapeHTML(d.request_id || id)) +
            row('Status / Latency', escapeHTML(String(d.status || '')) + ' · ' + fmt(d.latency_ms || 0) + ' ms') +
            row('API Key', escapeHTML(d.api_key_id || '')) +
          '</div>' +
          '<h4>Routing Waterfall</h4><table><thead><tr><th>#</th><th>Step</th><th>Status</th><th>Detail</th></tr></thead><tbody>' + rows + '</tbody></table>' +
          '<h4>Persisted Route Decisions</h4><table><thead><tr><th>Method</th><th>Route</th><th>Server Policy</th><th>Tool Risk</th><th>Final</th><th>Latency</th></tr></thead><tbody>' + decisionRows + '</tbody></table>' +
          '<h4>Tool Invocations</h4><table><thead><tr><th>Server</th><th>Tool</th><th>Source</th><th>Status</th><th>Arg Hash</th></tr></thead><tbody>' + toolRows + '</tbody></table>');
      } catch (err) {
        openModal('MCP Waterfall 오류', '<div class="error-line">' + escapeHTML(err.message) + '</div>');
      }
    };

    window.loadMCPAgenticRequests = async () => {
      const list = document.getElementById('mcp-flow-list');
      const hint = document.getElementById('mcp-flow-hint');
      const graph = document.getElementById('mcp-flow-graph');
      if (!list) return;
      if (hint) hint.textContent = '조회 중...';
      try {
        const d = await api('/admin/mcp/requests?limit=15');
        const reqs = (d.requests || []);
        if (!reqs.length) {
          if (hint) hint.textContent = 'MCP를 사용한 최근 요청이 없습니다.';
          return;
        }
        if (hint) hint.textContent = '요청을 선택하면 실행 흐름 그래프를 표시합니다.';
        list.innerHTML = reqs.map(r =>
          '<button class="secondary" type="button" style="margin:3px;font-size:11px" onclick="showMCPFlowForRequest(\'' + escapeAttr(r.id||r.request_id||'') + '\')">' +
          escapeHTML((r.id||r.request_id||'').substring(0,14)) + '… (' +
          (r.status_code||r.status||'') + ' · ' + fmt(r.latency_ms||0) + ' ms)</button>'
        ).join('');
        // Auto-load the most recent one
        const firstId = (reqs[0].id || reqs[0].request_id || '');
        if (firstId) await window.showMCPFlowForRequest(firstId);
      } catch(err) {
        if (hint) hint.textContent = '오류: ' + escapeHTML(err.message);
      }
    };

    window.showMCPFlowForRequest = async (id) => {
      const graph = document.getElementById('mcp-flow-graph');
      if (!graph) { await window.openMCPRequestWaterfall(id); return; }
      graph.innerHTML = '<div class="empty">흐름 분석 중...</div>';
      try {
        const d = await api('/admin/mcp/requests/' + encodeURIComponent(id) + '/waterfall');
        graph.innerHTML =
          '<div style="display:flex;gap:10px;align-items:center;margin-bottom:8px">' +
            '<strong style="font-size:12px">요청 ' + escapeHTML((id||'').substring(0,20)) + '</strong>' +
            '<span class="muted" style="font-size:11px">· ' + (d.status||'') + ' · ' + fmt(d.latency_ms||0) + ' ms</span>' +
            '<button class="secondary" type="button" style="font-size:11px;margin-left:auto" onclick="openMCPRequestWaterfall(\'' + escapeAttr(id) + '\')">상세 Waterfall</button>' +
          '</div>' +
          mcpAgenticFlowGraph(d);
      } catch(err) {
        graph.innerHTML = '<div class="error-line">' + escapeHTML(err.message) + '</div>';
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
        '<form class="inline-form" id="ai-policy-form" style="grid-template-columns: minmax(140px,1.2fr) 90px 90px minmax(120px,1fr) minmax(130px,1fr) minmax(130px,1fr) minmax(130px,1fr) 80px;">' +
          '<input id="ai-pol-name" placeholder="정책 이름" required>' +
          '<input id="ai-pol-priority" type="number" value="100" min="1" max="999" title="낮을수록 먼저 평가">' +
          '<input id="ai-pol-rollout" type="number" value="100" min="1" max="100" title="enforce 트래픽 비율(%) — canary 단계적 적용. 100=전체 적용">' +
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
        section('정책 회귀 테스트 (Policy Regression)',
          '<div class="card-body" style="padding:12px 14px">' +
            '<p class="muted" style="font-size:12px;margin:0 0 8px">고정 입력 시나리오의 기대 결과(allow/block/require_approval)를 저장해 두고, 현재 활성 정책에 재생하여 정책 변경이 의도치 않게 판단을 뒤집는지 확인합니다. 원문 prompt/SQL은 저장하지 않습니다.</p>' +
            '<form class="inline-form" id="preg-form" style="grid-template-columns: minmax(130px,1.2fr) minmax(110px,1fr) minmax(90px,1fr) 90px 90px 130px 70px;">' +
              '<input id="preg-name" placeholder="시나리오 이름" required>' +
              '<input id="preg-model" placeholder="model (예: gpt-4)">' +
              '<input id="preg-provider" placeholder="provider">' +
              '<input id="preg-risk" type="number" min="0" max="100" placeholder="risk">' +
              '<label style="display:flex;align-items:center;gap:4px;font-size:12px"><input id="preg-secret" type="checkbox">secret</label>' +
              '<select id="preg-expect"><option value="allow">allow</option><option value="block">block</option><option value="require_approval">require_approval</option></select>' +
              '<button type="submit">추가</button>' +
            '</form>' +
            '<div style="margin:8px 0"><button type="button" class="secondary" onclick="runPolicyRegression()">전체 회귀 실행 (활성 정책)</button></div>' +
            '<div id="preg-run-result"></div>' +
            '<div id="preg-cases"></div>' +
          '</div>') +
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
      const pregForm = document.getElementById('preg-form');
      if (pregForm) pregForm.addEventListener('submit', addPolicyRegressionCase);
      renderPolicyRegressionCases();
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
        '<th data-sort="num">우선순위</th><th data-sort="str">정책</th><th>Rules</th><th data-sort="str">상태</th><th>적용</th><th>동작</th>' +
      '</tr></thead><tbody>' +
      rows.map((p, idx) => '<tr>' +
        '<td data-num="' + (p.priority || 100) + '">' + fmt(p.priority || 100) + '</td>' +
        '<td>' + escapeHTML(p.name || p.id || '') + '<div class="muted">' + escapeHTML(p.id || '') + '</div>' +
          (p.description ? '<div class="muted">' + escapeHTML(p.description) + '</div>' : '') + '</td>' +
        '<td>' + policyRuleSummary(p.rules || []) + '</td>' +
        '<td><span class="status ' + (p.enabled ? '' : 'error') + '">' + (p.enabled ? 'enabled' : 'disabled') + '</span></td>' +
        '<td>' + ((p.rollout_percent && p.rollout_percent < 100) ? '<span class="status warn" title="canary 단계적 적용">canary ' + p.rollout_percent + '%</span>' : '<span class="muted">100%</span>') + '</td>' +
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
      const rollout = Math.min(100, Math.max(1, Number(document.getElementById('ai-pol-rollout').value || 100)));
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
        rollout_percent: rollout,
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

    // ---- Policy Regression Test ----
    async function addPolicyRegressionCase(event) {
      event.preventDefault();
      const name = document.getElementById('preg-name').value.trim();
      if (!name) return;
      const riskRaw = document.getElementById('preg-risk').value.trim();
      const payload = {
        name: name,
        model: document.getElementById('preg-model').value.trim(),
        provider: document.getElementById('preg-provider').value.trim(),
        risk_score: riskRaw ? Number(riskRaw) : 0,
        contains_secret: document.getElementById('preg-secret').checked,
        expect: document.getElementById('preg-expect').value,
      };
      try {
        await api('/admin/policies/regression/cases', { method: 'POST', body: JSON.stringify(payload) });
        document.getElementById('preg-form').reset();
        renderPolicyRegressionCases();
      } catch (err) {
        openModal('회귀 케이스 저장 오류', '<div class="error-line">' + escapeHTML(err.message) + '</div>');
      }
    }
    async function renderPolicyRegressionCases() {
      const host = document.getElementById('preg-cases');
      if (!host) return;
      let d;
      try { d = await api('/admin/policies/regression/cases'); }
      catch (e) { host.innerHTML = '<span class="status error">' + escapeHTML(e.message) + '</span>'; return; }
      const cases = d.cases || [];
      if (!cases.length) { host.innerHTML = '<div class="muted" style="font-size:12px;padding:6px 0">저장된 회귀 케이스가 없습니다.</div>'; return; }
      const expBadge = (e) => e === 'block' ? '<span class="status error">block</span>' : (e === 'require_approval' ? '<span class="status warn">approval</span>' : '<span class="status">allow</span>');
      host.innerHTML = '<table style="margin-top:6px"><thead><tr><th>이름</th><th>model</th><th>provider</th><th>risk</th><th>secret</th><th>기대</th><th></th></tr></thead><tbody>' +
        cases.map(c => '<tr>' +
          '<td>' + escapeHTML(c.name) + (c.enabled ? '' : ' <span class="muted">(중지)</span>') + '</td>' +
          '<td>' + escapeHTML(c.model || '-') + '</td>' +
          '<td>' + escapeHTML(c.provider || '-') + '</td>' +
          '<td data-num="' + (c.risk_score || 0) + '">' + fmt(c.risk_score) + '</td>' +
          '<td>' + (c.contains_secret ? 'Y' : '-') + '</td>' +
          '<td>' + expBadge(c.expect) + '</td>' +
          '<td><button type="button" class="danger" onclick="deletePolicyRegressionCase(\'' + escapeAttr(c.id) + '\')">삭제</button></td>' +
        '</tr>').join('') + '</tbody></table>';
    }
    window.deletePolicyRegressionCase = async (id) => {
      try {
        await api('/admin/policies/regression/cases?id=' + encodeURIComponent(id), { method: 'DELETE' });
        renderPolicyRegressionCases();
      } catch (e) { openModal('삭제 오류', '<div class="error-line">' + escapeHTML(e.message) + '</div>'); }
    };
    window.runPolicyRegression = async () => {
      const host = document.getElementById('preg-run-result');
      if (host) host.innerHTML = '<div class="empty">실행 중...</div>';
      try {
        const d = await api('/admin/policies/regression/run', { method: 'POST', body: '{}' });
        const results = d.results || [];
        const rows = results.map(r => '<tr>' +
          '<td>' + (r.pass ? '<span class="status">PASS</span>' : '<span class="status error">FAIL</span>') + '</td>' +
          '<td>' + escapeHTML(r.name) + '</td>' +
          '<td>' + escapeHTML(r.expect) + '</td>' +
          '<td>' + escapeHTML(r.actual) + '</td>' +
          '<td class="muted" style="font-size:11px">' + escapeHTML(r.reason || '') + '</td>' +
        '</tr>').join('');
        const overall = d.failed > 0 ? '<span class="status error">' + d.failed + '건 회귀 발생</span>' : '<span class="status">전체 통과</span>';
        if (host) host.innerHTML = '<div style="border:1px solid var(--border);border-radius:6px;padding:8px;margin:6px 0">' +
          '<strong style="font-size:12px">결과: ' + overall + ' · ' + (d.passed || 0) + '/' + (d.total || 0) + ' 통과 · 규칙 ' + (d.rule_count || 0) + '개(' + escapeHTML(d.rule_source || '') + ')</strong>' +
          (rows ? '<table style="margin-top:4px"><thead><tr><th>판정</th><th>이름</th><th>기대</th><th>실제</th><th>사유</th></tr></thead><tbody>' + rows + '</tbody></table>' : '<p class="muted" style="font-size:12px;margin:4px 0 0">실행할 케이스가 없습니다.</p>') +
          '</div>';
      } catch (e) { if (host) host.innerHTML = '<span class="status error">' + escapeHTML(e.message) + '</span>'; }
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

    // ---------- personalization (Personal AI Profile) ----------
    function pctText(x) { return (Number(x || 0) * 100).toFixed(0) + '%'; }
    function topKeyText(list) {
      if (!list || !list.length) return '<span class="muted">-</span>';
      return list.slice(0, 3).map(c => escapeHTML(c.key) + ' (' + fmt(c.requests) + ')').join(', ');
    }
    async function renderPersonalization() {
      const view = document.getElementById('view');
      const [d, coachingResp, modelAffinityResp, mcpAffinityResp, text2sqlHintsResp, adoptionResp] = await Promise.all([
        api('/admin/personalization/profiles?window=30d&limit=50').catch(() => ({ profiles: [] })),
        api('/admin/personalization/coaching?window=30d&limit=50').catch(() => ({ items: [] })),
        api('/admin/personalization/model-affinity?window=30d&limit=50').catch(() => ({ items: [] })),
        api('/admin/personalization/mcp-affinity?window=30d&limit=50').catch(() => ({ items: [] })),
        api('/admin/personalization/text2sql-hints?window=30d&limit=50&min_count=3').catch(() => ({ items: [] })),
        api('/admin/recommendations/adoption?window=30d').catch(() => ({ by_kind: [] }))
      ]);
      const profiles = d.profiles || [];
      const coaching = coachingResp.items || [];
      const modelAffinity = modelAffinityResp.items || [];
      const mcpAffinity = mcpAffinityResp.items || [];
      const text2sqlHints = text2sqlHintsResp.items || [];
      const adoption = adoptionResp.by_kind || [];
      let html = '<p class="muted">사용자별 AI 사용 프로필 (최근 30일). 모델·작업·언어 선호, 비용 성향, 신뢰도를 요약합니다. 사용자를 클릭하면 상세·스냅샷을 볼 수 있습니다.</p>';
      if (!profiles.length) {
        html += '<p class="muted">표시할 프로필이 없습니다 (사용자 매핑된 API Key 활동 필요).</p>';
      } else {
        html += '<table><thead><tr>' +
          '<th data-sort="str">사용자</th><th data-sort="str">팀</th><th data-sort="str">역할</th>' +
          '<th data-sort="num">요청</th><th data-sort="num">총비용(KRW)</th><th data-sort="num">성공률</th>' +
          '<th data-sort="num">캐시</th><th data-sort="num">T2SQL</th><th data-sort="num">MCP</th><th data-sort="num">위험</th>' +
          '<th>대표 모델</th><th>주요 작업</th><th>요약</th>' +
          '</tr></thead><tbody>' +
          profiles.map(p => {
            const topModel = (p.top_models && p.top_models.length) ? escapeHTML(p.top_models[0].key) : '-';
            return '<tr>' +
              '<td><a href="#/personalization/' + encodeURIComponent(p.user_id) + '">' + escapeHTML(p.user_id) + '</a></td>' +
              '<td>' + escapeHTML(p.team || '') + '</td>' +
              '<td>' + escapeHTML(p.role || '') + '</td>' +
              '<td data-num="' + (p.requests || 0) + '">' + fmt(p.requests || 0) + '</td>' +
              '<td data-num="' + (p.total_cost_krw || 0) + '">' + fmt(Math.round(p.total_cost_krw || 0)) + '</td>' +
              '<td data-num="' + (p.success_rate || 0) + '">' + pctText(p.success_rate) + '</td>' +
              '<td data-num="' + (p.cache_rate || 0) + '">' + pctText(p.cache_rate) + '</td>' +
              '<td data-num="' + (p.text2sql_usage_rate || 0) + '">' + pctText(p.text2sql_usage_rate) + '</td>' +
              '<td data-num="' + (p.mcp_usage_rate || 0) + '">' + pctText(p.mcp_usage_rate) + '</td>' +
              '<td data-num="' + (p.risk_score || 0) + '"><span class="status ' + governanceStatusClass((p.risk_score || 0) >= 70 ? 'high' : ((p.risk_score || 0) >= 35 ? 'medium' : 'low')) + '">' + fmt(p.risk_score || 0) + '</span></td>' +
              '<td>' + topModel + '</td>' +
              '<td>' + topKeyText(p.top_task_types) + '</td>' +
              '<td class="muted" style="max-width:360px">' + escapeHTML(p.summary || '') + '</td>' +
            '</tr>';
          }).join('') + '</tbody></table>';
      }
      let coachingHtml = '<p class="muted">프로필 지표만으로 산출한 read-only 코칭 후보입니다. 원문 프롬프트·SQL·응답은 사용하지 않습니다.</p>';
      if (!coaching.length) {
        coachingHtml += '<p class="muted">현재 코칭 후보가 없습니다.</p>';
      } else {
        coachingHtml += '<table><thead><tr>' +
          '<th data-sort="str">사용자</th><th data-sort="str">팀</th><th data-sort="str">분류</th>' +
          '<th data-sort="num">점수</th><th data-sort="str">심각도</th><th>제목</th><th>근거</th><th>권장 코칭</th>' +
          '</tr></thead><tbody>' +
          coaching.map(c => '<tr>' +
            '<td><a href="#/personalization/' + encodeURIComponent(c.user_id || '') + '">' + escapeHTML(c.user_id || '') + '</a></td>' +
            '<td>' + escapeHTML(c.team || '') + '</td>' +
            '<td>' + escapeHTML(c.category || '') + '</td>' +
            '<td data-num="' + (c.score || 0) + '">' + fmt(Math.round(c.score || 0)) + '</td>' +
            '<td><span class="status ' + governanceStatusClass(c.severity || 'low') + '">' + escapeHTML(c.severity || 'low') + '</span></td>' +
            '<td>' + escapeHTML(c.title || '') + '</td>' +
            '<td class="muted">' + escapeHTML(c.reason || '') + '</td>' +
            '<td class="muted" style="max-width:360px">' + escapeHTML(c.detail || '') + '</td>' +
          '</tr>').join('') + '</tbody></table>';
      }
      let text2sqlHintsHtml = '<p class="muted">사용자별 반복 Text2SQL 질문을 저장 리포트·대시보드·데이터마트 후보로 정리합니다. 원문 질문과 SQL은 표시하지 않습니다.</p>';
      if (!text2sqlHints.length) {
        text2sqlHintsHtml += '<p class="muted">표시할 Text2SQL 힌트가 없습니다.</p>';
      } else {
        text2sqlHintsHtml += '<table><thead><tr>' +
          '<th data-sort="str">사용자</th><th data-sort="str">팀</th><th data-sort="str">힌트</th><th data-sort="str">스키마</th>' +
          '<th data-sort="num">반복</th><th data-sort="num">성공률</th><th data-sort="num">평균비용</th><th data-sort="num">절감추정</th><th>지문/근거</th>' +
          '</tr></thead><tbody>' +
          text2sqlHints.map(h => '<tr>' +
            '<td><a href="#/personalization/' + encodeURIComponent(h.user_id || '') + '">' + escapeHTML(h.user_id || '') + '</a></td>' +
            '<td>' + escapeHTML(h.team || '') + '</td>' +
            '<td>' + escapeHTML(h.hint_type || h.recommended_product || '') + '</td>' +
            '<td>' + escapeHTML(h.schema_name || '') + '</td>' +
            '<td data-num="' + (h.count || 0) + '">' + fmt(h.count || 0) + '</td>' +
            '<td data-num="' + (h.success_rate || 0) + '">' + pctText(h.success_rate) + '</td>' +
            '<td data-num="' + (h.avg_cost_krw || 0) + '">' + (h.avg_cost_krw || 0).toFixed(2) + '</td>' +
            '<td data-num="' + (h.estimated_savings_krw || 0) + '">' + fmt(Math.round(h.estimated_savings_krw || 0)) + '</td>' +
            '<td class="muted">' + escapeHTML(h.fingerprint || '') + '<div>' + escapeHTML(h.reason || '') + '</div></td>' +
          '</tr>').join('') + '</tbody></table>';
      }
      let adoptionHtml = '<p class="muted">사용자가 추천을 채택·거절한 결과입니다. 추천 품질을 낮은 개입으로 점검할 때 사용합니다.</p>';
      if (!adoption.length) {
        adoptionHtml += '<p class="muted">아직 추천 피드백이 없습니다.</p>';
      } else {
        adoptionHtml += '<table><thead><tr>' +
          '<th data-sort="str">추천 종류</th><th data-sort="num">채택</th><th data-sort="num">거절</th><th data-sort="num">채택자</th><th data-sort="num">채택률</th>' +
          '</tr></thead><tbody>' +
          adoption.map(a => '<tr>' +
            '<td>' + escapeHTML(a.kind || '') + '</td>' +
            '<td data-num="' + (a.adopted || 0) + '">' + fmt(a.adopted || 0) + '</td>' +
            '<td data-num="' + (a.dismissed || 0) + '">' + fmt(a.dismissed || 0) + '</td>' +
            '<td data-num="' + (a.distinct_adopters || 0) + '">' + fmt(a.distinct_adopters || 0) + '</td>' +
            '<td data-num="' + (a.adoption_rate || 0) + '">' + pctText(a.adoption_rate) + '</td>' +
          '</tr>').join('') + '</tbody></table>';
      }
      let modelAffinityHtml = '<p class="muted">사용자별 모델 적합도입니다. 성공률·사용량·평균 비용으로 점수를 계산합니다.</p>';
      if (!modelAffinity.length) {
        modelAffinityHtml += '<p class="muted">표시할 모델 affinity가 없습니다.</p>';
      } else {
        modelAffinityHtml += '<table><thead><tr>' +
          '<th data-sort="str">사용자</th><th data-sort="str">팀</th><th data-sort="str">모델</th>' +
          '<th data-sort="num">점수</th><th data-sort="num">요청</th><th data-sort="num">성공률</th><th data-sort="num">평균비용</th><th>근거</th>' +
          '</tr></thead><tbody>' +
          modelAffinity.map(m => '<tr>' +
            '<td><a href="#/personalization/' + encodeURIComponent(m.user_id || '') + '">' + escapeHTML(m.user_id || '') + '</a></td>' +
            '<td>' + escapeHTML(m.team || '') + '</td>' +
            '<td>' + escapeHTML(m.model || '') + '</td>' +
            '<td data-num="' + (m.score || 0) + '">' + fmt(Math.round(m.score || 0)) + '</td>' +
            '<td data-num="' + (m.requests || 0) + '">' + fmt(m.requests || 0) + '</td>' +
            '<td data-num="' + (m.success_rate || 0) + '">' + pctText(m.success_rate) + '</td>' +
            '<td data-num="' + (m.avg_cost_krw || 0) + '">' + (m.avg_cost_krw || 0).toFixed(2) + '</td>' +
            '<td class="muted">' + escapeHTML(m.reason || '') + '</td>' +
          '</tr>').join('') + '</tbody></table>';
      }
      let mcpAffinityHtml = '<p class="muted">사용자별 MCP 도구 affinity입니다. 호출수·성공률·평균 요청 지연으로 점수를 계산합니다.</p>';
      if (!mcpAffinity.length) {
        mcpAffinityHtml += '<p class="muted">표시할 MCP affinity가 없습니다.</p>';
      } else {
        mcpAffinityHtml += '<table><thead><tr>' +
          '<th data-sort="str">사용자</th><th data-sort="str">팀</th><th data-sort="str">도구</th>' +
          '<th data-sort="num">점수</th><th data-sort="num">호출</th><th data-sort="num">오류</th><th data-sort="num">성공률</th><th data-sort="num">평균 지연</th><th>근거</th>' +
          '</tr></thead><tbody>' +
          mcpAffinity.map(m => '<tr>' +
            '<td><a href="#/personalization/' + encodeURIComponent(m.user_id || '') + '">' + escapeHTML(m.user_id || '') + '</a></td>' +
            '<td>' + escapeHTML(m.team || '') + '</td>' +
            '<td>' + escapeHTML(m.ref || '') + '</td>' +
            '<td data-num="' + (m.score || 0) + '">' + fmt(Math.round(m.score || 0)) + '</td>' +
            '<td data-num="' + (m.calls || 0) + '">' + fmt(m.calls || 0) + '</td>' +
            '<td data-num="' + (m.errors || 0) + '">' + fmt(m.errors || 0) + '</td>' +
            '<td data-num="' + (m.success_rate || 0) + '">' + pctText(m.success_rate) + '</td>' +
            '<td data-num="' + (m.avg_request_latency_ms || 0) + '">' + fmt(Math.round(m.avg_request_latency_ms || 0)) + ' ms</td>' +
            '<td class="muted">' + escapeHTML(m.reason || '') + '</td>' +
          '</tr>').join('') + '</tbody></table>';
      }
      view.innerHTML =
        card('개인 AI 프로필', '<div class="card-body">' + html + '</div>') +
        card('개인화 코칭 후보', '<div class="card-body">' + coachingHtml + '</div>') +
        card('Text2SQL 개인 힌트', '<div class="card-body">' + text2sqlHintsHtml + '</div>') +
        card('추천 채택률', '<div class="card-body">' + adoptionHtml + '</div>') +
        card('모델 Affinity', '<div class="card-body">' + modelAffinityHtml + '</div>') +
        card('MCP Affinity', '<div class="card-body">' + mcpAffinityHtml + '</div>');
      makeSortable('#view', 'personalization');
    }

    async function renderPersonalProfileDetail(userID) {
      const view = document.getElementById('view');
      const d = await api('/admin/personalization/profiles/' + encodeURIComponent(userID) + '?window=30d')
        .catch(() => ({ profile: null, snapshots: [] }));
      const p = d.profile || {};
      const snaps = d.snapshots || [];
      const back = '<p><a href="#/personalization">← 전체 프로필</a></p>';
      const kv = '<div class="kv">' +
        row('사용자', escapeHTML(p.user_id || userID)) +
        row('팀 / 역할', escapeHTML((p.team || '-') + ' / ' + (p.role || '-'))) +
        row('요청 수', fmt(p.requests || 0)) +
        row('총 비용', fmt(Math.round(p.total_cost_krw || 0)) + ' KRW') +
        row('요청당 평균', (p.avg_cost_per_request || 0).toFixed(2) + ' KRW') +
        row('평균 지연', fmt(Math.round(p.avg_latency_ms || 0)) + ' ms') +
        row('성공률 / 오류율', pctText(p.success_rate) + ' / ' + pctText(p.error_rate)) +
        row('캐시 / Text2SQL / MCP', pctText(p.cache_rate) + ' / ' + pctText(p.text2sql_usage_rate) + ' / ' + pctText(p.mcp_usage_rate)) +
        row('개인 위험 점수', '<span class="status ' + governanceStatusClass((p.risk_score || 0) >= 70 ? 'high' : ((p.risk_score || 0) >= 35 ? 'medium' : 'low')) + '">' + fmt(p.risk_score || 0) + '</span>') +
        row('distinct 모델 / 지문', fmt(p.distinct_models || 0) + ' / ' + fmt(p.distinct_prompt_fingerprints || 0)) +
        row('요약', escapeHTML(p.summary || '')) +
      '</div>';
      const prefs =
        '<div class="grid3" style="margin-top:12px">' +
          '<div><h3>선호 작업(task_type)</h3>' + topKeyText(p.top_task_types) + '</div>' +
          '<div><h3>선호 모델</h3>' + topKeyText(p.top_models) + '</div>' +
          '<div><h3>선호 언어</h3>' + topKeyText(p.top_languages) + '</div>' +
          '<div><h3>자주 쓰는 MCP 도구</h3>' + topKeyText(p.top_mcp_tools) + '</div>' +
        '</div>';
      const drift = d.drift || {};
      let driftCard = '';
      if (drift.has_baseline) {
        const sign = v => (v > 0 ? '+' : '') + v;
        const flags = (drift.flags || []).length ? (drift.flags || []).map(f => '<span class="pill">' + escapeHTML(f) + '</span>').join(' ') : '<span class="muted">변동 없음</span>';
        driftCard = '<div style="margin-top:16px"><h3>스냅샷 추세 (drift)</h3>' +
          '<div class="muted">' + escapeHTML(drift.from || '') + ' → ' + escapeHTML(drift.to || '') + '</div>' +
          '<div class="kv" style="margin-top:8px">' +
            row('요청 변화', sign(drift.requests_delta || 0)) +
            row('총비용 변화', sign(Math.round(drift.cost_delta_krw || 0)) + ' KRW') +
            row('요청당 평균 변화', (drift.avg_cost_delta_krw || 0).toFixed(2) + ' KRW') +
            row('성공률 변화', sign(((drift.success_rate_delta || 0) * 100).toFixed(1)) + '%p') +
            row('대표 모델', escapeHTML((drift.top_model_from || '-') + ' → ' + (drift.top_model_to || '-')) + (drift.top_model_changed ? ' <span class="pill">변경</span>' : '')) +
            row('주요 작업', escapeHTML((drift.top_task_from || '-') + ' → ' + (drift.top_task_to || '-')) + (drift.top_task_changed ? ' <span class="pill">변경</span>' : '')) +
            row('신호', flags) +
          '</div></div>';
      } else {
        driftCard = '<div style="margin-top:16px"><h3>스냅샷 추세 (drift)</h3><p class="muted">추세 계산에는 스냅샷이 2개 이상 필요합니다. 시점을 두고 스냅샷 생성을 여러 번 실행하세요.</p></div>';
      }
      const snapBtn = '<div style="margin-top:12px"><button type="button" onclick="snapshotProfile(\'' + userID.replace(/'/g, "\\'") + '\')">스냅샷 생성</button> ' +
        '<span class="muted">현재 프로필을 시점 기록으로 저장합니다.</span></div>';
      const snapTable = snaps.length ? (
        '<h3 style="margin-top:16px">스냅샷 이력</h3><table><thead><tr><th>생성 시각</th><th>요청</th><th>총비용</th><th>성공률</th></tr></thead><tbody>' +
        snaps.map(s => {
          let parsed = {};
          try { parsed = JSON.parse(s.profile || '{}'); } catch (e) { parsed = {}; }
          return '<tr><td>' + escapeHTML(s.created_at) + '</td><td>' + fmt(parsed.requests || 0) + '</td>' +
            '<td>' + fmt(Math.round(parsed.total_cost_krw || 0)) + '</td><td>' + pctText(parsed.success_rate) + '</td></tr>';
        }).join('') + '</tbody></table>'
      ) : '<p class="muted" style="margin-top:16px">스냅샷이 없습니다.</p>';
      view.innerHTML = back + card('프로필: ' + escapeHTML(userID), '<div class="card-body">' + kv + prefs + driftCard + snapBtn + snapTable + '</div>');
    }

    async function snapshotProfile(userID) {
      try {
        await api('/admin/personalization/profiles/' + encodeURIComponent(userID) + '?window=30d&snapshot=1');
        await renderPersonalProfileDetail(userID);
      } catch (err) {
        alert('스냅샷 생성 실패: ' + err.message);
      }
    }

    // ---------- my keys (self-service) ----------
    // renderForbidden is shown when a user routes (or deep-links) to a tab outside their
    // permissions — never a blank screen. Surfaces role, path, and how to get access.
    function renderForbidden(tab) {
      // Report the blocked attempt so operators can see it in the auth audit log.
      try { api('/me/access-denied', { method: 'POST', body: JSON.stringify({ tab, path: location.hash }) }).catch(() => {}); } catch {}
      const u = authState.user || {};
      const role = u.role || (authState.enabled ? '(알 수 없음)' : '레거시 토큰');
      document.getElementById('view').innerHTML = section('접근 권한이 필요합니다',
        '<div class="card-body" style="padding:16px">' +
          '<p style="font-size:15px">이 메뉴(<code>#/' + escapeHTML(tab) + '</code>)에 접근할 권한이 없습니다.</p>' +
          '<div class="kv" style="margin-top:10px">' +
            row('내 역할', escapeHTML(role)) +
            row('요청 경로', '<code>#/' + escapeHTML(tab) + '</code>') +
            row('보유 권한', escapeHTML(((authState.nav && authState.nav.scopes) || []).join(', ') || '(없음)')) +
          '</div>' +
          '<p class="muted" style="margin-top:12px">접근이 필요하면 관리자에게 역할 변경을 요청하세요. ' +
          '<a href="#/me">내 홈으로 이동</a></p>' +
        '</div>');
    }

    // renderSecurityHome is the security_admin landing: policy violations, Secret Firewall,
    // risky MCP tools, and pending approvals — no cost detail, no prompt originals.
    async function renderSecurityHome() {
      const view = document.getElementById('view');
      view.innerHTML = section('보안 대시보드', '<div class="empty">불러오는 중...</div>');
      let d;
      try { d = await api('/security/dashboard'); }
      catch (e) { view.innerHTML = section('보안 대시보드', '<div class="card-body" style="padding:16px"><p class="muted">불러올 수 없습니다(security:read 권한 필요). 상세: ' + escapeHTML(e.message) + '</p></div>'); return; }
      const pol = d.policy || {}, sec = d.secrets || {}, mcp = d.mcp_summary || {};
      const kpis = '<div class="kpis">' +
        kpi('차단(정책)', fmt(pol.blocked || 0)) +
        kpi('경고(정책)', fmt(pol.warned || 0)) +
        kpi('Secret 탐지', fmt(sec.total || 0)) +
        kpi('승인 대기', fmt(d.pending_count || 0)) +
        kpi('위험 도구', fmt((d.risky_tools || []).length)) +
        kpi('MCP 오류', fmt(mcp.total_errors || 0)) +
      '</div>';

      const recent = pol.recent || [];
      const polCard = card('최근 정책 위반',
        '<div class="card-body">' + (recent.length
          ? '<table><thead><tr><th>결정</th><th>사유</th><th>규칙</th><th>위험</th><th>시각</th></tr></thead><tbody>' +
            recent.map(x => '<tr><td><span class="status ' + (x.decision==='block'?'error':'warn') + '">' + escapeHTML(x.decision) + '</span></td><td>' + escapeHTML(x.reason||'') + '</td><td>' + escapeHTML(x.rule||'') + '</td><td>' + fmt(x.risk_score||0) + '</td><td class="muted">' + ago(x.created_at) + '</td></tr>').join('') + '</tbody></table>'
          : '<p class="muted">최근 위반이 없습니다.</p>') + '</div>');

      const byType = sec.by_type || {};
      const secCard = card('Secret Firewall',
        '<div class="card-body">' + (Object.keys(byType).length
          ? '<ul style="margin:0;padding-left:18px">' + Object.keys(byType).map(k => '<li>' + escapeHTML(k) + ': <strong>' + fmt(byType[k]) + '</strong></li>').join('') + '</ul>'
          : '<p class="muted">탐지된 Secret이 없습니다.</p>') + '</div>');

      const risky = d.risky_tools || [];
      const riskyCard = card('위험 MCP/도구',
        '<div class="card-body">' + (risky.length
          ? '<table><thead><tr><th>서버</th><th>도구</th><th>위험도</th><th>조치</th></tr></thead><tbody>' +
            risky.map(t => '<tr><td>' + escapeHTML(t.server_label||'') + '</td><td>' + escapeHTML(t.tool_name||'') + '</td><td><span class="status error">' + escapeHTML(t.risk_level) + '</span></td><td>' + escapeHTML(t.action||'') + '</td></tr>').join('') + '</tbody></table>'
          : '<p class="muted">high/critical 도구가 없습니다.</p>') + '</div>');

      const pending = d.pending_approvals || [];
      const apprCard = card('승인 대기 큐',
        '<div class="card-body">' + (pending.length
          ? '<table><thead><tr><th>대상</th><th>사유</th><th>위험</th><th>요청 시각</th></tr></thead><tbody>' +
            pending.map(a => '<tr><td>' + escapeHTML((a.subject_type||'') + ' ' + (a.subject_id||'')) + '</td><td>' + escapeHTML(a.reason||'') + '</td><td>' + fmt(a.risk_score||0) + '</td><td class="muted">' + ago(a.created_at) + '</td></tr>').join('') + '</tbody></table>'
          : '<p class="muted">대기 중인 승인이 없습니다.</p>') + '</div>');

      view.innerHTML = section('보안 대시보드', kpis) + polCard + secCard + riskyCard + apprCard;
    }

    // renderBillingHome is the billing_admin landing: cost-center spend, budget burn, and
    // model-migration savings — no prompt originals, no security policy editing.
    async function renderBillingHome() {
      const view = document.getElementById('view');
      view.innerHTML = section('비용 대시보드', '<div class="empty">불러오는 중...</div>');
      let d;
      try { d = await api('/billing/dashboard'); }
      catch (e) { view.innerHTML = section('비용 대시보드', '<div class="card-body" style="padding:16px"><p class="muted">불러올 수 없습니다(admin:read 권한 필요). 상세: ' + escapeHTML(e.message) + '</p></div>'); return; }
      const won = (v) => '₩' + fmt(Math.round(v || 0));
      const kpis = '<div class="kpis">' +
        kpi('총 비용 (30일)', won(d.total_cost_krw)) +
        kpi('총 요청', fmt(d.total_requests || 0)) +
        kpi('예상 절감', won(d.estimated_savings_krw)) +
        kpi('예산 항목', fmt((d.budgets || []).length)) +
      '</div>';

      const cc = d.by_cost_center || [];
      const ccCard = card('비용센터별 비용',
        '<div class="card-body">' + (cc.length
          ? '<table><thead><tr><th>비용센터</th><th>요청</th><th>비용</th></tr></thead><tbody>' +
            cc.map(x => '<tr><td>' + escapeHTML(x.key||'(미지정)') + '</td><td>' + fmt(x.requests) + '</td><td>' + won(x.cost_krw) + '</td></tr>').join('') + '</tbody></table>'
          : '<p class="muted">데이터가 없습니다.</p>') + '</div>');

      const budgets = d.budgets || [];
      const budgetCard = card('예산 소진율',
        '<div class="card-body">' + (budgets.length
          ? '<table><thead><tr><th>범위</th><th>월 예산</th><th>소진</th><th>소진율</th><th>예상</th></tr></thead><tbody>' +
            budgets.map(b => { const bg=b.budget||{}; const ratio=(b.burn_ratio||0)*100; const cls=ratio>=100?'error':(ratio>=80?'warn':''); return '<tr><td>' + escapeHTML((bg.scope||'')+':'+(bg.scope_value||'')) + '</td><td>' + won(bg.monthly_krw) + '</td><td>' + won(b.spent_krw) + '</td><td><span class="status '+cls+'">' + ratio.toFixed(0) + '%</span></td><td>' + won(b.projected_krw) + '</td></tr>'; }).join('') + '</tbody></table>'
          : '<p class="muted">설정된 예산이 없습니다.</p>') + '</div>');

      const mig = d.migration_candidates || [];
      const migCard = card('모델 전환 후보',
        '<div class="card-body">' + (mig.length
          ? '<table><thead><tr><th>현재 모델</th><th>추천 모델</th><th>요청</th><th>예상 절감</th></tr></thead><tbody>' +
            mig.map(m => '<tr><td>' + escapeHTML(m.current_model) + '</td><td><strong>' + escapeHTML(m.recommended_model) + '</strong></td><td>' + fmt(m.requests) + '</td><td>' + won(m.estimated_savings_krw) + '</td></tr>').join('') + '</tbody></table>'
          : '<p class="muted">전환 후보가 없습니다.</p>') + '</div>');

      view.innerHTML = section('비용 대시보드', kpis) + ccCard + budgetCard + migCard;
    }

    // renderTeamHome is the team_manager landing: their team's usage, cost, top members,
    // model mix, and recent failures — scoped to their team only.
    async function renderTeamHome() {
      const view = document.getElementById('view');
      view.innerHTML = section('팀 대시보드', '<div class="empty">불러오는 중...</div>');
      let resp;
      try { resp = await api('/team/dashboard'); }
      catch (e) {
        view.innerHTML = section('팀 대시보드', '<div class="card-body" style="padding:16px"><p class="muted">팀 대시보드를 불러올 수 없습니다(team:read 권한 + 소속 팀 필요). 상세: ' + escapeHTML(e.message) + '</p></div>');
        return;
      }
      const d = resp.dashboard || {}, tot = d.totals || {};
      const pctv = (v) => (v == null ? '-' : (v * 100).toFixed(1) + '%');
      const won = (v) => '₩' + fmt(Math.round(v || 0));
      const kpis = '<div class="kpis">' +
        kpi('팀 요청 (30일)', fmt(tot.requests || 0)) +
        kpi('성공률', pctv(tot.success_rate)) +
        kpi('오류', fmt(tot.errors || 0)) +
        kpi('비용', won(tot.cost_krw)) +
        kpi('평균 지연', fmt(Math.round(tot.avg_latency_ms || 0)) + 'ms') +
      '</div>';

      const users = d.top_users || [];
      const usersCard = card('팀원 사용량 Top',
        '<div class="card-body">' + (users.length
          ? '<table><thead><tr><th>사용자</th><th>요청</th><th>오류</th><th>비용</th></tr></thead><tbody>' +
            users.map(u => '<tr><td>' + escapeHTML(u.user_id) + '</td><td>' + fmt(u.requests) + '</td><td>' + fmt(u.errors) + '</td><td>' + won(u.cost_krw) + '</td></tr>').join('') + '</tbody></table>'
          : '<p class="muted">데이터가 없습니다.</p>') + '</div>');

      const models = d.models || [];
      const modelsCard = card('팀 모델 사용',
        '<div class="card-body">' + (models.length
          ? '<table><thead><tr><th>모델</th><th>요청</th><th>비용</th></tr></thead><tbody>' +
            models.map(m => '<tr><td>' + escapeHTML(m.model) + '</td><td>' + fmt(m.requests) + '</td><td>' + won(m.cost_krw) + '</td></tr>').join('') + '</tbody></table>'
          : '<p class="muted">데이터가 없습니다.</p>') + '</div>');

      const fails = d.recent_failures || [];
      const failCard = card('팀 최근 실패',
        '<div class="card-body">' + (fails.length
          ? '<table><thead><tr><th>모델</th><th>코드</th><th>유형</th><th>시각</th></tr></thead><tbody>' +
            fails.map(f => '<tr><td>' + escapeHTML(f.model) + '</td><td><span class="status error">' + f.status_code + '</span></td><td>' + escapeHTML(f.task_type || '') + '</td><td class="muted">' + ago(f.created_at) + '</td></tr>').join('') + '</tbody></table>'
          : '<p class="muted">최근 실패가 없습니다. 👍</p>') + '</div>');

      view.innerHTML = section('팀 대시보드 — ' + escapeHTML(resp.team_id || ''), kpis) + usersCard + modelsCard + failCard +
        '<div id="team-challenge"></div><div id="team-reports"></div><div id="team-risk"></div><div id="team-skills"></div><div id="team-templates"></div><div id="team-onboarding"></div>';

      // 팀 공용 리포트 (승인됨 + 승인 대기, team:read는 승인/반려 가능).
      window.teamReportDecide = async (id, action) => {
        try {
          await api('/team/reports', { method: 'POST', body: JSON.stringify({ report_id: id, action }) });
          renderTeamHome();
        } catch (e) { alert('처리 오류: ' + e.message); }
      };
      api('/team/reports').then(rp => {
        const host = document.getElementById('team-reports');
        if (!host || !rp) return;
        const reports = rp.reports || [];
        host.innerHTML = card('팀 공용 리포트',
          '<div class="card-body">' + (reports.length
            ? '<table><thead><tr><th>이름</th><th>상태</th><th>스키마</th><th>작성자</th><th>승인</th></tr></thead><tbody>' +
              reports.map(r => {
                const pending = r.approval_status === 'pending';
                const badge = pending ? '<span class="status warn">승인 대기</span>' : '<span class="status">팀 공용</span>';
                const actions = pending
                  ? '<button type="button" style="font-size:11px" onclick="teamReportDecide(\'' + escapeAttr(r.id) + '\',\'approve\')">승인</button> <button type="button" class="danger" style="font-size:11px" onclick="teamReportDecide(\'' + escapeAttr(r.id) + '\',\'reject\')">반려</button>'
                  : (r.approved_by ? '<span class="muted" style="font-size:11px">' + escapeHTML(r.approved_by) + ' · ' + ago(r.approved_at) + '</span>' : '');
                return '<tr><td>' + escapeHTML(r.name) + '</td><td>' + badge + '</td><td>' + escapeHTML(r.schema_name || '') + '</td><td class="muted">' + escapeHTML(r.created_by || '') + '</td><td>' + actions + '</td></tr>';
              }).join('') + '</tbody></table>'
            : '<p class="muted">팀 공용 리포트가 없습니다. 개인 저장 리포트를 <code>POST /me/reports/submit-to-team</code>으로 제출하면 승인 후 공유됩니다.</p>') + '</div>');
      }).catch(() => {});

      // 팀 비용 절감 챌린지 (월 추세 + 예상 절감).
      api('/team/savings-challenge').then(ch => {
        const host = document.getElementById('team-challenge');
        if (!host || !ch) return;
        const won = (v) => '₩' + fmt(Math.round(v || 0));
        const badge = ch.on_track ? '<span class="status">🟢 목표 달성 추세</span>' : '<span class="status error">🔴 전월 초과 예상</span>';
        host.innerHTML = card('팀 비용 절감 챌린지',
          '<div class="card-body"><div class="kpis">' +
            kpi('이번 달 누적', won(ch.month_to_date_krw)) +
            kpi('예상 월말', won(ch.projected_month_end_krw)) +
            kpi('전월 총액', won(ch.last_month_krw)) +
            kpi('예상 절감', won(ch.projected_savings_krw)) +
          '</div><p style="margin:8px 0">' + badge + ' <span class="muted" style="font-size:12px">(' + ch.days_elapsed + '/' + ch.days_in_month + '일 경과, 선형 추정)</span></p></div>');
      }).catch(() => {});

      // 팀 온보딩 팩 (추천 모델·Skill·MCP 묶음).
      api('/team/onboarding').then(ob => {
        const host = document.getElementById('team-onboarding');
        if (!host || !ob) return;
        const m = ob.recommended_models || [], sk = ob.recommended_skills || [], tl = ob.recommended_mcp || [];
        const pctv = (v) => (v == null ? '-' : (v * 100).toFixed(0) + '%');
        const list = (items, render) => items.length ? '<ul style="margin:4px 0;padding-left:18px">' + items.map(render).join('') + '</ul>' : '<p class="muted" style="font-size:12px">데이터 없음</p>';
        host.innerHTML = card('팀 온보딩 팩',
          '<div class="card-body" style="display:flex;gap:24px;flex-wrap:wrap">' +
            '<div><strong>추천 모델</strong>' + list(m, x => '<li>' + escapeHTML(x.model) + ' <span class="muted">(' + fmt(x.requests) + '회)</span></li>') + '</div>' +
            '<div><strong>추천 Skill</strong>' + list(sk, x => '<li>' + escapeHTML(x.skill_name) + ' <span class="muted">(성공률 ' + pctv(x.success_rate) + ')</span></li>') + '</div>' +
            '<div><strong>추천 MCP 도구</strong>' + list(tl, x => '<li>' + escapeHTML(x.ref) + ' <span class="muted">(' + fmt(x.calls) + '회)</span></li>') + '</div>' +
          '</div><div class="muted" style="font-size:11px;padding:0 16px 12px">' + escapeHTML(ob.note || '') + '</div>');
      }).catch(() => {});

      // 팀 위험 신호 (정책 위반·Secret·승인 대기 + 차단 추세).
      api('/team/risk').then(rk => {
        const host = document.getElementById('team-risk');
        if (!host || !rk) return;
        const trend = rk.blocked_trend || 0;
        const trendBadge = trend > 0 ? '<span class="status error">▲ ' + trend + ' 증가</span>' : (trend < 0 ? '<span class="status">▼ ' + Math.abs(trend) + ' 감소</span>' : '<span class="status">변동 없음</span>');
        const byType = rk.secrets_by_type || {};
        const recent = rk.recent_violations || [];
        host.innerHTML = card('팀 위험 신호',
          '<div class="card-body"><div class="kpis">' +
            kpi('차단(정책)', fmt(rk.blocked || 0)) +
            kpi('경고(정책)', fmt(rk.warned || 0)) +
            kpi('Secret 탐지', fmt(rk.secrets_total || 0)) +
            kpi('승인 대기', fmt(rk.pending_approvals || 0)) +
          '</div>' +
          '<p style="margin:8px 0">차단 추세(이전 구간 대비): ' + trendBadge + '</p>' +
          (Object.keys(byType).length ? '<div class="muted" style="font-size:12px">Secret 유형: ' + Object.keys(byType).map(k => escapeHTML(k) + '(' + byType[k] + ')').join(', ') + '</div>' : '') +
          (recent.length ? '<table style="margin-top:8px"><thead><tr><th>결정</th><th>사유</th><th>위험</th><th>시각</th></tr></thead><tbody>' +
            recent.map(x => '<tr><td><span class="status ' + (x.decision==='block'?'error':'warn') + '">' + escapeHTML(x.decision) + '</span></td><td>' + escapeHTML(x.reason||'') + '</td><td>' + fmt(x.risk_score||0) + '</td><td class="muted">' + ago(x.created_at) + '</td></tr>').join('') + '</tbody></table>' : '<p class="muted" style="margin-top:8px">최근 위반이 없습니다. 👍</p>') +
          '</div>');
      }).catch(() => {});

      // 팀 인기 Skill + 팀 추천 템플릿 후보 (병렬 로드, 실패해도 본문은 유지).
      api('/team/skills/popular').then(s => {
        const skills = (s && s.skills) || [];
        const host = document.getElementById('team-skills');
        if (!host) return;
        host.innerHTML = card('팀 인기 Skill',
          '<div class="card-body">' + (skills.length
            ? '<table><thead><tr><th>Skill</th><th>실행</th><th>성공률</th><th>비용</th><th>평균지연</th></tr></thead><tbody>' +
              skills.map(k => '<tr><td>' + escapeHTML(k.skill_name) + '</td><td>' + fmt(k.runs) + '</td><td>' + pctv(k.success_rate) + '</td><td>₩' + fmt(Math.round(k.total_cost_krw||0)) + '</td><td>' + fmt(Math.round(k.avg_latency_ms||0)) + 'ms</td></tr>').join('') + '</tbody></table>'
            : '<p class="muted">팀 내 Skill 사용 기록이 없습니다.</p>') + '</div>');
      }).catch(() => {});
      api('/team/templates/candidates').then(s => {
        const cands = (s && s.candidates) || [];
        const host = document.getElementById('team-templates');
        if (!host) return;
        host.innerHTML = card('팀 추천 템플릿 후보',
          '<div class="card-body">' + (cands.length
            ? '<table><thead><tr><th>작업 유형</th><th>반복</th><th>성공률</th><th>평균비용</th><th>상태</th></tr></thead><tbody>' +
              cands.map(c => '<tr><td>' + escapeHTML(c.task_type) + '<div class="muted" style="font-size:10px">' + escapeHTML((c.fingerprint||'').slice(0,12)) + '</div></td><td>' + fmt(c.requests) + '</td><td>' + pctv(c.success_rate) + '</td><td>₩' + fmt(Math.round(c.avg_cost_krw||0)) + '</td><td>' + (c.already_product ? '<span class="status">상품화됨</span>' : '<span class="status warn">후보</span>') + '</td></tr>').join('') + '</tbody></table>'
            : '<p class="muted">반복 프롬프트 패턴이 충분하지 않습니다.</p>') + '</div>');
      }).catch(() => {});
    }

    // renderTeamPortal is the consolidated team self-service portal: usage, budget burn, the
    // team's API keys (no secrets), accessible skills, pending skill access requests, members.
    async function renderTeamPortal() {
      const view = document.getElementById('view');
      view.innerHTML = section('팀 포털', '<div class="empty">불러오는 중...</div>');
      let d;
      try { d = await api('/team/portal'); }
      catch (e) {
        view.innerHTML = section('팀 포털', '<div class="card-body" style="padding:16px"><p class="muted">팀 포털을 불러올 수 없습니다(team:read 권한 + 소속 팀 필요). 상세: ' + escapeHTML(e.message) + '</p></div>');
        return;
      }
      const u = d.usage || {};
      const won = (v) => '₩' + fmt(Math.round(v || 0));
      const pctv = (v) => (v == null ? '-' : (v * 100).toFixed(1) + '%');
      const kpis = '<div class="kpis">' +
        kpi('팀 요청 (30일)', fmt(u.requests || 0)) +
        kpi('성공률', pctv(u.success_rate)) +
        kpi('비용', won(u.cost_krw)) +
        kpi('API 키', fmt(d.api_key_count || 0)) +
        kpi('팀원', fmt(d.member_count || 0)) +
        kpi('사용가능 Skill', fmt(d.skill_count || 0)) +
      '</div>';

      const budgets = d.budgets || [];
      const budgetCard = card('팀 예산 소진',
        '<div class="card-body">' + (budgets.length
          ? '<table><thead><tr><th>월 예산</th><th>사용</th><th>소진율</th><th>예상 월말</th><th>상태</th><th>소진 예정일</th></tr></thead><tbody>' +
            budgets.map(b => '<tr><td>' + won(b.monthly_krw) + '</td><td>' + won(b.spent_krw) + '</td><td>' + pctv(b.burn_ratio) + '</td><td>' + won(b.projected_krw) + '</td><td>' + (b.on_track ? '<span class="status">정상</span>' : '<span class="status error">초과 예상</span>') + '</td><td class="muted">' + escapeHTML(b.exhaustion_date || '-') + '</td></tr>').join('') + '</tbody></table>'
          : '<p class="muted">설정된 팀 예산이 없습니다. 관리자에게 팀 월 예산 설정을 요청하세요.</p>') + '</div>');

      const keys = d.api_keys || [];
      const keysCard = card('팀 API 키 (비밀값 비노출)',
        '<div class="card-body">' + (keys.length
          ? '<table><thead><tr><th>이름</th><th>소유자</th><th>역할</th><th>상태</th><th>만료</th></tr></thead><tbody>' +
            keys.map(k => '<tr><td>' + escapeHTML(k.name || k.id) + '</td><td class="muted">' + escapeHTML(k.user_id || k.owner || '') + '</td><td>' + escapeHTML(k.role || '') + '</td><td>' + (k.status === 'active' ? '<span class="status">active</span>' : '<span class="status error">' + escapeHTML(k.status || '') + '</span>') + '</td><td class="muted">' + (k.expires_at ? escapeHTML(k.expires_at) : '-') + '</td></tr>').join('') + '</tbody></table>'
          : '<p class="muted">팀에 등록된 API 키가 없습니다.</p>') + '</div>');

      const skills = d.accessible_skills || [];
      const skillsCard = card('사용 가능한 Skill',
        '<div class="card-body">' + (skills.length
          ? '<table><thead><tr><th>이름</th><th>버전</th><th>위험도</th><th>설명</th></tr></thead><tbody>' +
            skills.map(s => '<tr><td>' + escapeHTML(s.name) + '</td><td class="muted">' + escapeHTML(s.version || '') + '</td><td>' + escapeHTML(s.risk_level || '') + '</td><td class="muted">' + escapeHTML((s.description || '').slice(0, 80)) + '</td></tr>').join('') + '</tbody></table>'
          : '<p class="muted">사용 가능한 production Skill이 없습니다.</p>') + '</div>');

      const reqs = d.pending_skill_requests || [];
      const reqCard = card('대기 중인 Skill 접근 요청 (' + reqs.length + ')',
        '<div class="card-body">' + (reqs.length
          ? '<table><thead><tr><th>Skill</th><th>요청자</th><th>사유</th><th>요청 시각</th></tr></thead><tbody>' +
            reqs.map(r => '<tr><td>' + escapeHTML(r.skill_name) + '</td><td class="muted">' + escapeHTML(r.user_id || '') + '</td><td>' + escapeHTML((r.reason || '').slice(0, 80)) + '</td><td class="muted">' + ago(r.created_at) + '</td></tr>').join('') + '</tbody></table>'
          : '<p class="muted">대기 중인 접근 요청이 없습니다.</p>') + '</div>');

      const members = d.members || [];
      const memberCard = card('팀원 (' + members.length + ')',
        '<div class="card-body">' + (members.length
          ? '<div style="display:flex;flex-wrap:wrap;gap:6px">' + members.map(m => '<span class="pill">' + escapeHTML(m) + '</span>').join('') + '</div>'
          : '<p class="muted">식별된 팀원이 없습니다.</p>') + '</div>');

      view.innerHTML = section('팀 포털 — ' + escapeHTML(d.team_id || ''), kpis) +
        budgetCard + keysCard + skillsCard + reqCard + memberCard +
        '<p class="muted" style="font-size:12px;padding:8px 14px">' + escapeHTML(d.note || '') + ' <a href="#/team">팀 대시보드 →</a></p>';
    }

    // renderDataProducts is the admin Data Product Builder: curate/publish reusable data
    // products (from miner candidates or manually), and triage access requests.
    async function renderDataProducts() {
      const view = document.getElementById('view');
      view.innerHTML = section('데이터 상품', '<div class="empty">불러오는 중...</div>');
      let prods, cands, reqs;
      try {
        prods = await api('/admin/data-products');
        cands = await api('/admin/data-products/candidates').catch(() => ({ candidates: [] }));
        reqs = await api('/admin/data-products/requests').catch(() => ({ requests: [] }));
      } catch (e) {
        view.innerHTML = section('데이터 상품', '<div class="card-body" style="padding:16px"><p class="muted">' + escapeHTML(e.message) + '</p></div>');
        return;
      }
      window.dpRefresh = renderDataProducts;
      window.dpPublishToggle = async (key, status) => {
        const list = (prods.products || []).filter(p => p.product_key === key);
        if (!list.length) return;
        const p = list[0];
        try {
          await api('/admin/data-products', { method: 'POST', body: JSON.stringify({
            product_key: p.product_key, name_ko: p.name_ko, description: p.description,
            source_type: p.source_type, source_ref: p.source_ref, owner: p.owner,
            allowed_teams: p.allowed_teams || [], sensitivity: p.sensitivity, status: status,
          }) });
          renderDataProducts();
        } catch (e) { alert('변경 오류: ' + e.message); }
      };
      window.dpDelete = async (key) => {
        if (!confirm(key + ' 상품을 삭제할까요?')) return;
        try { await api('/admin/data-products?id=' + encodeURIComponent(key), { method: 'DELETE' }); renderDataProducts(); }
        catch (e) { alert('삭제 오류: ' + e.message); }
      };
      window.dpDecide = async (id, action) => {
        try { await api('/admin/data-products/requests', { method: 'POST', body: JSON.stringify({ id, action }) }); renderDataProducts(); }
        catch (e) { alert('처리 오류: ' + e.message); }
      };
      window.dpAdd = async (event) => {
        event.preventDefault();
        const key = document.getElementById('dp-key').value.trim();
        const name = document.getElementById('dp-name').value.trim();
        if (!key || !name) return;
        try {
          await api('/admin/data-products', { method: 'POST', body: JSON.stringify({
            product_key: key, name_ko: name,
            description: document.getElementById('dp-desc').value.trim(),
            source_type: document.getElementById('dp-source').value,
            source_ref: document.getElementById('dp-ref').value.trim(),
            allowed_teams: splitCSV(document.getElementById('dp-teams').value),
            status: document.getElementById('dp-status').value,
          }) });
          document.getElementById('dp-form').reset();
          renderDataProducts();
        } catch (e) { alert('저장 오류: ' + e.message); }
      };
      window.dpPublishCandidate = (question, rec) => {
        document.getElementById('dp-name').value = question.slice(0, 60);
        document.getElementById('dp-desc').value = '추천 상품 형태: ' + rec + ' · 반복 Text2SQL 질문에서 발행';
        document.getElementById('dp-source').value = 'saved_report';
        document.getElementById('dp-key').focus();
      };

      const products = prods.products || [];
      const statusBadge = (st) => st === 'published' ? '<span class="status">발행</span>' : (st === 'archived' ? '<span class="status warn">보관</span>' : '<span class="status warn">초안</span>');
      const prodCard = card('데이터 상품 카탈로그',
        '<div class="card-body">' +
        '<form class="inline-form" id="dp-form" style="grid-template-columns: minmax(110px,1fr) minmax(130px,1.2fr) minmax(150px,1.5fr) 120px minmax(110px,1fr) minmax(110px,1fr) 90px 70px;">' +
          '<input id="dp-key" placeholder="product_key" required>' +
          '<input id="dp-name" placeholder="상품 이름(한글)" required>' +
          '<input id="dp-desc" placeholder="설명">' +
          '<select id="dp-source"><option value="saved_report">saved_report</option><option value="metric">metric</option><option value="golden_query">golden_query</option><option value="custom">custom</option></select>' +
          '<input id="dp-ref" placeholder="source_ref(id/key)">' +
          '<input id="dp-teams" placeholder="허용 팀(쉼표, 빈칸=전체)">' +
          '<select id="dp-status"><option value="draft">draft</option><option value="published">published</option></select>' +
          '<button type="submit">추가</button>' +
        '</form>' +
        '<p class="muted" style="font-size:11px;padding:0 0 6px">상품은 원본(리포트/메트릭/골든쿼리)을 참조만 합니다. 원문 SQL은 저장하지 않습니다.</p>' +
        (products.length
          ? '<table><thead><tr><th>키</th><th>이름</th><th>소스</th><th>허용 팀</th><th>민감도</th><th>상태</th><th>동작</th></tr></thead><tbody>' +
            products.map(p => '<tr><td>' + escapeHTML(p.product_key) + '</td><td>' + escapeHTML(p.name_ko) + '</td><td class="muted">' + escapeHTML(p.source_type) + (p.source_ref ? ':' + escapeHTML(p.source_ref) : '') + '</td><td class="muted">' + escapeHTML((p.allowed_teams || []).join(', ') || '전체') + '</td><td>' + escapeHTML(p.sensitivity) + '</td><td>' + statusBadge(p.status) + '</td><td>' +
              (p.status === 'published'
                ? '<button type="button" style="font-size:11px" onclick="dpPublishToggle(\'' + escapeAttr(p.product_key) + '\',\'archived\')">보관</button>'
                : '<button type="button" style="font-size:11px" onclick="dpPublishToggle(\'' + escapeAttr(p.product_key) + '\',\'published\')">발행</button>') +
              ' <button type="button" class="danger" style="font-size:11px" onclick="dpDelete(\'' + escapeAttr(p.product_key) + '\')">삭제</button>' +
            '</td></tr>').join('') + '</tbody></table>'
          : '<p class="muted">아직 등록된 데이터 상품이 없습니다. 아래 추천 후보에서 발행하거나 위 폼으로 추가하세요.</p>') +
        '</div>');

      const candidates = cands.candidates || [];
      const candCard = card('상품 후보 (반복 Text2SQL 질문)',
        '<div class="card-body">' + (candidates.length
          ? '<table><thead><tr><th>질문</th><th>반복</th><th>추천 형태</th><th>최근</th><th></th></tr></thead><tbody>' +
            candidates.map(c => '<tr><td>' + escapeHTML((c.question || '').slice(0, 80)) + '</td><td>' + fmt(c.count) + '</td><td><span class="pill">' + escapeHTML(c.recommended_product) + '</span></td><td class="muted">' + ago(c.last_seen) + '</td><td><button type="button" style="font-size:11px" onclick="dpPublishCandidate(' + JSON.stringify(c.question).replace(/"/g, '&quot;') + ',\'' + escapeAttr(c.recommended_product) + '\')">폼 채우기</button></td></tr>').join('') + '</tbody></table>'
          : '<p class="muted">반복 질문 후보가 충분하지 않습니다.</p>') + '</div>');

      const requests = (reqs.requests || []).filter(r => r.status === 'pending');
      const reqCard = card('데이터 상품 접근 요청 (' + requests.length + ' 대기)',
        '<div class="card-body">' + (requests.length
          ? '<table><thead><tr><th>상품</th><th>요청자</th><th>팀</th><th>사유</th><th>승인</th></tr></thead><tbody>' +
            requests.map(r => '<tr><td>' + escapeHTML(r.product_key) + '</td><td class="muted">' + escapeHTML(r.user_id) + '</td><td>' + escapeHTML(r.team || '') + '</td><td>' + escapeHTML((r.reason || '').slice(0, 60)) + '</td><td><button type="button" style="font-size:11px" onclick="dpDecide(\'' + escapeAttr(r.id) + '\',\'approve\')">승인</button> <button type="button" class="danger" style="font-size:11px" onclick="dpDecide(\'' + escapeAttr(r.id) + '\',\'deny\')">거부</button></td></tr>').join('') + '</tbody></table>'
          : '<p class="muted">대기 중인 접근 요청이 없습니다.</p>') + '</div>');

      view.innerHTML = section('데이터 상품 (Data Product Builder)', '') + prodCard + candCard + reqCard;
      const form = document.getElementById('dp-form');
      if (form) form.addEventListener('submit', window.dpAdd);
    }

    // renderRemediation is the Auto Remediation Playbook: situation-driven, reversible action
    // candidates with dry-run/impact; admin can apply (approval) with audit + rollback.
    async function renderRemediation() {
      const view = document.getElementById('view');
      view.innerHTML = section('자동 조치', '<div class="empty">불러오는 중...</div>');
      let d;
      try { d = await api('/admin/remediation/playbooks'); }
      catch (e) { view.innerHTML = section('자동 조치', '<div class="card-body" style="padding:16px"><p class="muted">' + escapeHTML(e.message) + '</p></div>'); return; }
      window.remApply = async (type, paramsJson, dry) => {
        let params = {};
        try { params = JSON.parse(paramsJson || '{}'); } catch (e) {}
        if (!dry && !confirm('이 조치를 실제로 적용할까요?\n' + type)) return;
        let reason = '';
        if (!dry) { reason = prompt('적용 사유(감사 로그에 기록):', '') || ''; }
        try {
          const res = await api('/admin/remediation/apply', { method: 'POST', body: JSON.stringify({ action_type: type, params, dry_run: !!dry, reason }) });
          const rb = res.rollback ? ('\n되돌리기: ' + res.rollback.action_type) : '';
          openModal(dry ? 'Dry-run 결과' : '조치 적용됨',
            '<div class="kv">' +
            row('조치', escapeHTML(res.action_type)) +
            row('적용됨', res.applied ? '예' : '아니오 (dry-run)') +
            row('이전 상태', '<code>' + escapeHTML(JSON.stringify(res.before)) + '</code>') +
            row('이후 상태', '<code>' + escapeHTML(JSON.stringify(res.after)) + '</code>') +
            (res.rollback ? row('되돌리기', '<button type="button" class="secondary" onclick="remRollback(' + escapeAttr(JSON.stringify(res.rollback)) + ')">' + escapeHTML(res.rollback.action_type) + ' 실행</button>') : '') +
            '</div><p class="muted" style="font-size:11px;margin-top:6px">' + escapeHTML(res.note || '') + '</p>');
          if (!dry) renderRemediation();
        } catch (e) { openModal('조치 오류', '<div class="error-line">' + escapeHTML(e.message) + '</div>'); }
      };
      window.remRollback = async (rb) => {
        try {
          const res = await api('/admin/remediation/apply', { method: 'POST', body: JSON.stringify({ action_type: rb.action_type, params: rb.params || {}, reason: 'rollback' }) });
          closeModal();
          renderRemediation();
        } catch (e) { openModal('되돌리기 오류', '<div class="error-line">' + escapeHTML(e.message) + '</div>'); }
      };
      const sevBadge = (s) => s === 'critical' ? '<span class="status error">심각</span>' : (s === 'warning' ? '<span class="status warn">경고</span>' : '<span class="status">정보</span>');
      const books = d.playbooks || [];
      const cards = books.map(pb => {
        const actions = (pb.actions || []).map(a => {
          const params = JSON.stringify(a.params || {}).replace(/"/g, '&quot;');
          const btns = a.executable
            ? '<button type="button" class="secondary" style="font-size:11px" onclick="remApply(\'' + escapeAttr(a.type) + '\',\'' + params + '\',true)">Dry-run</button> ' +
              '<button type="button" style="font-size:11px" onclick="remApply(\'' + escapeAttr(a.type) + '\',\'' + params + '\',false)">적용</button>'
            : (a.link ? '<a href="' + escapeAttr(a.link) + '"><button type="button" class="secondary" style="font-size:11px">화면 이동</button></a>' : '<span class="muted" style="font-size:11px">수동 조치</span>');
          return '<div style="border:1px solid var(--border);border-radius:6px;padding:8px;margin:4px 0">' +
            '<div style="display:flex;justify-content:space-between;align-items:center"><strong>' + escapeHTML(a.title) + '</strong>' +
            '<span>' + (a.reversible ? '<span class="pill">가역</span> ' : '') + (a.executable ? '<span class="pill">실행가능</span>' : '<span class="muted" style="font-size:10px">권고</span>') + '</span></div>' +
            '<div class="muted" style="font-size:11px;margin:2px 0">' + escapeHTML(a.description) + '</div>' +
            '<div style="font-size:11px"><strong>Dry-run:</strong> <code>' + escapeHTML(a.dry_run) + '</code></div>' +
            '<div class="muted" style="font-size:11px"><strong>예상 영향:</strong> ' + escapeHTML(a.expected_impact) + '</div>' +
            '<div style="margin-top:4px">' + btns + '</div>' +
          '</div>';
        }).join('');
        return card(sevBadge(pb.severity) + ' ' + escapeHTML(situationLabel(pb.situation)),
          '<div class="card-body"><p class="muted" style="font-size:12px">' + escapeHTML(pb.summary) + '</p>' + actions + '</div>');
      }).join('');
      view.innerHTML = section('자동 조치 (Auto Remediation) — 종합 ' + (d.overall_severity || 'info'), '') +
        '<p class="muted" style="font-size:12px;padding:0 14px">' + escapeHTML(d.note || '') + '</p>' +
        (cards || '<div class="card-body" style="padding:16px"><p class="muted">현재 조치가 필요한 상황이 없습니다. 👍</p></div>');
    }
    function situationLabel(s) {
      return ({ provider_degraded: '프로바이더 장애', cost_spike: '비용 급증', mcp_error_spike: 'MCP 오류 급증', text2sql_risk_spike: 'Text2SQL 위험 급증', policy_violation_spike: '정책 위반 급증', break_glass: '비상 차단' })[s] || s;
    }

    // renderTeamScorecard shows per-team AI maturity scores (cost/quality/safety dimensions).
    async function renderTeamScorecard() {
      const view = document.getElementById('view');
      view.innerHTML = section('팀 성숙도', '<div class="empty">불러오는 중...</div>');
      let d;
      try { d = await api('/admin/teams/scorecard?window=30d'); }
      catch (e) { view.innerHTML = section('팀 성숙도', '<div class="card-body" style="padding:16px"><p class="muted">' + escapeHTML(e.message) + '</p></div>'); return; }
      const teams = d.teams || [];
      const cell = (v) => v < 0 ? '<span class="muted">-</span>' : fmt(Math.round(v));
      const gradeBadge = (g) => g === 'A' ? '<span class="status">A</span>' : (g === 'B' ? '<span class="status">B</span>' : (g === 'C' ? '<span class="status warn">C</span>' : (g === 'N/A' ? '<span class="muted">N/A</span>' : '<span class="status error">D</span>')));
      const won = (v) => '₩' + fmt(Math.round(v || 0));
      const rows = teams.map(t => '<tr>' +
        '<td>' + escapeHTML(t.team) + '</td>' +
        '<td>' + gradeBadge(t.grade) + ' <strong>' + fmt(Math.round(t.overall)) + '</strong></td>' +
        '<td data-num="' + t.requests + '">' + fmt(t.requests) + '</td>' +
        '<td>' + won(t.cost_krw) + '</td>' +
        '<td>' + cell(t.cost_efficiency) + '</td>' +
        '<td>' + cell(t.success_rate) + '</td>' +
        '<td>' + cell(t.cache_rate) + '</td>' +
        '<td>' + cell(t.skill_reuse) + '</td>' +
        '<td>' + cell(t.mcp_success) + '</td>' +
        '<td>' + cell(t.text2sql_success) + '</td>' +
        '<td>' + cell(t.policy_compliance) + '</td>' +
        '<td>' + cell(t.satisfaction) + '</td>' +
      '</tr>').join('');
      const table = teams.length
        ? '<table><thead><tr><th>팀</th><th>종합</th><th>요청</th><th>비용</th><th>비용효율</th><th>성공률</th><th>캐시율</th><th>Skill재사용</th><th>MCP성공</th><th>Text2SQL</th><th>정책준수</th><th>만족도</th></tr></thead><tbody>' + rows + '</tbody></table>'
        : '<p class="muted">표시할 팀 데이터가 없습니다.</p>';
      view.innerHTML = section('팀 성숙도 (AI Maturity Scorecard) — 최근 30일',
        '<div style="padding:8px 14px"><button type="button" class="secondary" onclick="scorecardCSV()">CSV 다운로드</button></div>') +
        card('팀별 AI 성숙도 점수 (0~100, -는 데이터 없음)',
          '<div class="card-body">' + table +
          '<p class="muted" style="font-size:11px;margin-top:6px">' + escapeHTML(d.note || '') + '</p></div>');
      makeSortable && makeSortable('#view table', 'scorecard');
    }
    window.scorecardCSV = async () => {
      try {
        const res = await fetch('/admin/teams/scorecard?window=30d&format=csv', { headers: headers() });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const blob = await res.blob();
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'team-scorecard-' + new Date().toISOString().slice(0, 10) + '.csv';
        a.click();
        URL.revokeObjectURL(a.href);
      } catch (e) { openModal('CSV 오류', '<div class="error-line">' + escapeHTML(e.message) + '</div>'); }
    };

    // renderModelContracts manages per-task-type model quality contracts and runs a model
    // against them before adoption (model swap / auto-routing / MCP agentic model).
    async function renderModelContracts() {
      const view = document.getElementById('view');
      view.innerHTML = section('모델 계약', '<div class="empty">불러오는 중...</div>');
      let d;
      try { d = await api('/admin/models/contracts'); }
      catch (e) { view.innerHTML = section('모델 계약', '<div class="card-body" style="padding:16px"><p class="muted">' + escapeHTML(e.message) + '</p></div>'); return; }
      window.mconAdd = async (event) => {
        event.preventDefault();
        const name = document.getElementById('mcon-name').value.trim();
        if (!name) return;
        const num = (id) => { const v = parseFloat(document.getElementById(id).value); return isNaN(v) ? 0 : v; };
        try {
          await api('/admin/models/contracts', { method: 'POST', body: JSON.stringify({
            name, task_type: document.getElementById('mcon-task').value.trim(),
            min_quality_score: num('mcon-q'), min_golden_pass_rate: num('mcon-g'),
            min_success_rate: num('mcon-s'), max_latency_ms: num('mcon-l'), max_avg_cost_krw: num('mcon-c'),
          }) });
          document.getElementById('mcon-form').reset();
          renderModelContracts();
        } catch (e) { alert('저장 오류: ' + e.message); }
      };
      window.mconDelete = async (id) => {
        if (!confirm('계약을 삭제할까요?')) return;
        try { await api('/admin/models/contracts?id=' + encodeURIComponent(id), { method: 'DELETE' }); renderModelContracts(); }
        catch (e) { alert('삭제 오류: ' + e.message); }
      };
      window.mconRun = async () => {
        const model = document.getElementById('mcon-run-model').value.trim();
        if (!model) { alert('검증할 모델명을 입력하세요.'); return; }
        const host = document.getElementById('mcon-run-result');
        host.innerHTML = '<div class="empty">검증 중...</div>';
        try {
          const r = await api('/admin/models/contracts/run', { method: 'POST', body: JSON.stringify({ model }) });
          const vBadge = (v) => v === 'pass' ? '<span class="status">PASS</span>' : (v === 'warn' ? '<span class="status warn">WARN</span>' : (v === 'fail' ? '<span class="status error">FAIL</span>' : '<span class="muted">데이터없음</span>'));
          const results = (r.results || []).map(res => {
            const checks = (res.checks || []).map(c => '<tr><td>' + escapeHTML(c.dimension) + '</td><td>' + vBadge(c.status) + '</td><td>' + (c.actual == null ? '-' : escapeHTML(String(c.actual))) + '</td><td class="muted">' + escapeHTML(String(c.threshold)) + '</td></tr>').join('');
            return '<div style="border:1px solid var(--border);border-radius:6px;padding:8px;margin:4px 0">' +
              '<strong>' + escapeHTML(res.contract_name) + '</strong> ' + vBadge(res.verdict) + (res.task_type ? ' <span class="muted">' + escapeHTML(res.task_type) + '</span>' : '') +
              '<table style="margin-top:4px"><thead><tr><th>차원</th><th>판정</th><th>실측</th><th>임계</th></tr></thead><tbody>' + checks + '</tbody></table></div>';
          }).join('');
          const samples = (r.failing_samples || []).map(s => '<li><code>' + escapeHTML(s.fingerprint) + '</code> — ' + escapeHTML(s.reason) + '</li>').join('');
          host.innerHTML = '<div style="border:1px solid var(--border);border-radius:6px;padding:8px;margin-top:6px">' +
            '<strong>' + escapeHTML(r.model) + ' · 교체 ' + (r.replaceable ? '<span class="status">가능</span>' : '<span class="status error">보류</span>') + '</strong>' +
            (results || '<p class="muted" style="font-size:12px">실행할 계약이 없습니다(계약을 먼저 추가하세요).</p>') +
            (samples ? '<div style="margin-top:6px"><strong style="font-size:12px">실패 골든 샘플(원문 미노출)</strong><ul style="margin:4px 0;padding-left:18px;font-size:11px">' + samples + '</ul></div>' : '') +
            '<p class="muted" style="font-size:11px;margin-top:4px">' + escapeHTML(r.note || '') + '</p></div>';
        } catch (e) { host.innerHTML = '<span class="status error">' + escapeHTML(e.message) + '</span>'; }
      };
      const contracts = d.contracts || [];
      const num = (v) => v > 0 ? fmt(v) : '<span class="muted">-</span>';
      const list = contracts.length
        ? '<table><thead><tr><th>이름</th><th>업무</th><th>최소품질</th><th>골든통과</th><th>성공률</th><th>최대지연</th><th>최대비용</th><th>사용</th><th></th></tr></thead><tbody>' +
          contracts.map(c => '<tr><td>' + escapeHTML(c.name) + '</td><td class="muted">' + escapeHTML(c.task_type || '') + '</td><td>' + num(c.min_quality_score) + '</td><td>' + num(c.min_golden_pass_rate) + '</td><td>' + num(c.min_success_rate) + '</td><td>' + num(c.max_latency_ms) + '</td><td>' + num(c.max_avg_cost_krw) + '</td><td>' + (c.enabled ? '✓' : '-') + '</td><td><button type="button" class="danger" style="font-size:11px" onclick="mconDelete(\'' + escapeAttr(c.id) + '\')">삭제</button></td></tr>').join('') + '</tbody></table>'
        : '<p class="muted">등록된 계약이 없습니다. 업무별 최소 품질 기준을 추가하세요.</p>';
      view.innerHTML = section('모델 계약 (Model Contract Test)', '') +
        card('계약 검증 실행',
          '<div class="card-body"><div style="display:flex;gap:8px;align-items:center"><input id="mcon-run-model" placeholder="검증할 모델명 (예: gpt-4.1)" style="min-width:240px"><button type="button" onclick="mconRun()">계약 검증</button></div>' +
          '<p class="muted" style="font-size:11px;margin-top:4px">관측된 모델 지표(최근 30일)를 활성 계약 임계값과 비교합니다. 모델 교체·자동 라우팅 변경 전에 실행하세요.</p>' +
          '<div id="mcon-run-result"></div></div>') +
        card('계약 목록 (임계값: 0 = 미적용)',
          '<div class="card-body">' +
          '<form class="inline-form" id="mcon-form" style="grid-template-columns: minmax(120px,1.2fr) minmax(100px,1fr) 90px 90px 90px 90px 90px 60px;">' +
            '<input id="mcon-name" placeholder="계약 이름" required>' +
            '<input id="mcon-task" placeholder="업무 유형">' +
            '<input id="mcon-q" type="number" step="1" placeholder="품질≥">' +
            '<input id="mcon-g" type="number" step="0.01" placeholder="골든≥(0-1)">' +
            '<input id="mcon-s" type="number" step="0.01" placeholder="성공≥(0-1)">' +
            '<input id="mcon-l" type="number" step="1" placeholder="지연≤ms">' +
            '<input id="mcon-c" type="number" step="0.01" placeholder="비용≤KRW">' +
            '<button type="submit">추가</button>' +
          '</form>' + list + '</div>');
      const form = document.getElementById('mcon-form');
      if (form) form.addEventListener('submit', window.mconAdd);
    }

    // renderPolicyAdvisor recommends governance rules from observed signals; applying one
    // creates a disabled draft policy for review in the policy screen.
    async function renderPolicyAdvisor() {
      const view = document.getElementById('view');
      view.innerHTML = section('정책 어드바이저', '<div class="empty">분석 중...</div>');
      let d;
      try { d = await api('/admin/policy-advisor/suggestions'); }
      catch (e) { view.innerHTML = section('정책 어드바이저', '<div class="card-body" style="padding:16px"><p class="muted">' + escapeHTML(e.message) + '</p></div>'); return; }
      window.policyAdvisorApply = async (idx) => {
        const sug = (window._advisorSuggestions || [])[idx];
        if (!sug) return;
        if (!confirm('이 추천을 비활성 draft 정책으로 생성할까요?\n' + sug.title)) return;
        try {
          const res = await api('/admin/policy-advisor/apply', { method: 'POST', body: JSON.stringify({ title: sug.title, conditions: sug.conditions, actions: sug.actions }) });
          openModal('draft 정책 생성됨', '<p>' + escapeHTML(res.note || '') + '</p><p class="muted" style="font-size:12px">정책 ID: ' + escapeHTML(res.policy_id || '') + '</p><div style="margin-top:8px"><a href="#/safety"><button type="button">정책 화면으로 이동</button></a></div>');
        } catch (e) { openModal('적용 오류', '<div class="error-line">' + escapeHTML(e.message) + '</div>'); }
      };
      // 섀도우 영향 미리보기 — 추천 규칙을 최근 트래픽에 적용했을 때의 예상 영향(차단·영향 사용자·오탐·비용).
      window.policyAdvisorShadow = async (idx) => {
        const sug = (window._advisorSuggestions || [])[idx];
        if (!sug) return;
        openModal('섀도우 영향 분석', '<div class="empty">최근 트래픽에 시뮬레이션 중...</div>');
        try {
          const d = await api('/admin/policies/simulate', { method: 'POST', body: JSON.stringify({ rules: [{ name: sug.title, conditions: sug.conditions, actions: sug.actions }], window: '7d' }) });
          const sh = d.shadow || {};
          const fpr = Math.round((sh.false_positive_rate || 0) * 100);
          const fpcls = fpr >= 30 ? 'error' : (fpr >= 10 ? 'warn' : '');
          const fpRows = (sh.false_positive_sample || []).slice(0, 20).map(s =>
            '<tr><td>' + escapeHTML(s.api_key_id || '') + '</td><td>' + escapeHTML(s.team_id || '') + '</td><td>' + escapeHTML(s.model || '') + '</td><td>' + (s.status_code || 0) + '</td><td>' + escapeHTML(s.reason || '') + '</td></tr>').join('');
          openModal('섀도우 영향 분석 — ' + escapeHTML(sug.title),
            '<div class="kv">' +
              row('평가 요청(최근 7일)', fmt(d.evaluated || 0)) +
              row('차단 예상', fmt(d.blocked || 0) + ' · ' + Math.round((d.block_rate || 0) * 100) + '%') +
              row('승인 필요', fmt(d.require_approval || 0)) +
              row('영향 사용자/팀', fmt(sh.affected_keys || 0) + ' 키 · ' + fmt(sh.affected_teams || 0) + ' 팀') +
              row('오탐 후보', '<span class="status ' + fpcls + '">' + fmt(sh.false_positive_candidates || 0) + ' (' + fpr + '%)</span> <span class="muted" style="font-size:11px">과거 정상(2xx)이었으나 차단될 요청</span>') +
              row('차단 비용(절감 추정)', money(sh.blocked_cost_krw || 0)) +
            '</div>' +
            (fpRows ? ('<h3 style="margin-top:14px">오탐 후보 표본</h3><table><thead><tr><th>API 키</th><th>팀</th><th>모델</th><th>상태</th><th>사유</th></tr></thead><tbody>' + fpRows + '</tbody></table>') : '') +
            '<p class="muted" style="font-size:10px;margin-top:6px">' + escapeHTML(d.note || '') + '</p>' +
            '<div style="margin-top:8px"><button type="button" onclick="policyAdvisorApply(' + idx + ')">이 규칙으로 draft 정책 생성</button></div>');
        } catch (e) { openModal('시뮬레이션 오류', '<div class="error-line">' + escapeHTML(e.message) + '</div>'); }
      };
      const sugs = d.suggestions || [];
      window._advisorSuggestions = sugs;
      const sevBadge = (s) => s === 'critical' ? '<span class="status error">심각</span>' : (s === 'warning' ? '<span class="status warn">경고</span>' : '<span class="status">정보</span>');
      const cards = sugs.map((sug, i) =>
        '<div style="border:1px solid var(--border);border-radius:6px;padding:10px;margin:6px 0">' +
        '<div style="display:flex;justify-content:space-between;align-items:center"><strong>' + sevBadge(sug.severity) + ' ' + escapeHTML(sug.title) + '</strong>' +
        '<span><button type="button" class="secondary" style="font-size:11px" onclick="policyAdvisorShadow(' + i + ')">섀도우 영향</button> ' +
        '<button type="button" style="font-size:11px" onclick="policyAdvisorApply(' + i + ')">draft 정책 생성</button></span></div>' +
        '<div class="muted" style="font-size:12px;margin:4px 0">' + escapeHTML(sug.rationale) + '</div>' +
        '<div style="font-size:11px"><strong>조건:</strong> <code>' + escapeHTML(JSON.stringify(sug.conditions)) + '</code> · <strong>액션:</strong> <code>' + escapeHTML(JSON.stringify(sug.actions)) + '</code></div>' +
        '<div class="muted" style="font-size:11px"><strong>근거:</strong> <code>' + escapeHTML(JSON.stringify(sug.evidence)) + '</code></div>' +
        '</div>').join('');
      // canary(rollout<100%) 정책의 실집행 vs 섀도우 현황 + 상향 추천.
      let canaryCard = '';
      try {
        const cs = await api('/admin/policies/canary-status?days=7');
        const cps = cs.policies || [];
        if (cps.length) {
          const crows = cps.map(c => '<tr>' +
            '<td>' + escapeHTML(c.name || c.policy_id) + '<div class="muted" style="font-size:10px">' + escapeHTML(c.policy_id) + '</div></td>' +
            '<td><span class="status warn">' + (c.rollout_percent || 0) + '%</span></td>' +
            '<td>' + fmt(c.enforced_acts || 0) + '</td>' +
            '<td>' + fmt(c.shadow_acts || 0) + '</td>' +
            '<td><button type="button" class="secondary" style="font-size:11px" onclick="canaryBump(\'' + escapeAttr(c.policy_id) + '\',' + (c.suggested_next || 100) + ')">' + (c.suggested_next || 100) + '%로 상향</button></td>' +
          '</tr>').join('');
          canaryCard = card('Canary 롤아웃 현황 (최근 7일)',
            '<div class="card-body"><table><thead><tr><th>정책</th><th>적용 비율</th><th>실집행</th><th>섀도우(미적용)</th><th>다음 단계</th></tr></thead><tbody>' + crows + '</tbody></table>' +
            '<p class="muted" style="font-size:10px;margin-top:4px">' + escapeHTML(cs.note || '') + '</p></div>');
        }
      } catch (e) { /* canary 현황 없으면 생략 */ }
      view.innerHTML = section('정책 어드바이저 (Gateway Policy Advisor)', '') +
        '<p class="muted" style="font-size:12px;padding:0 14px">' + escapeHTML(d.note || '') + '</p>' +
        canaryCard +
        card('추천 정책 (' + sugs.length + ')',
          '<div class="card-body">' + (cards || '<p class="muted">현재 추천할 정책이 없습니다. 운영 신호가 안정적입니다. 👍</p>') + '</div>');
    }
    // canary 정책의 rollout 비율을 상향(기존 정의 유지, rollout_percent만 변경 후 재저장).
    window.canaryBump = async (policyID, next) => {
      if (!confirm('이 정책의 적용 비율을 ' + next + '%로 상향할까요?')) return;
      try {
        const list = await api('/admin/policies');
        const p = (list.policies || []).find(x => x.id === policyID);
        if (!p) { openModal('오류', '<div class="error-line">정책을 찾을 수 없습니다.</div>'); return; }
        p.rollout_percent = next;
        await api('/admin/policies', { method: 'POST', body: JSON.stringify(p) });
        await renderPolicyAdvisor();
      } catch (e) { openModal('상향 오류', '<div class="error-line">' + escapeHTML(e.message) + '</div>'); }
    };

    // renderNarrativeReport shows the auto-generated monthly operations report (prose sections).
    async function renderNarrativeReport() {
      const view = document.getElementById('view');
      view.innerHTML = section('운영 보고서', '<div class="empty">생성 중...</div>');
      let d;
      try { d = await api('/admin/reports/narrative?window=30d'); }
      catch (e) { view.innerHTML = section('운영 보고서', '<div class="card-body" style="padding:16px"><p class="muted">' + escapeHTML(e.message) + '</p></div>'); return; }
      window.narrativeMD = async () => {
        try {
          const res = await fetch('/admin/reports/narrative?window=30d&format=md', { headers: headers() });
          if (!res.ok) throw new Error('HTTP ' + res.status);
          const blob = await res.blob();
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = 'ai-gateway-report-' + new Date().toISOString().slice(0, 10) + '.md';
          a.click();
          URL.revokeObjectURL(a.href);
        } catch (e) { openModal('다운로드 오류', '<div class="error-line">' + escapeHTML(e.message) + '</div>'); }
      };
      const secs = (d.sections || []).map(sec =>
        '<div style="border:1px solid var(--border);border-radius:6px;padding:10px;margin:6px 0">' +
        '<strong>' + escapeHTML(sec.title) + '</strong>' +
        '<p style="margin:6px 0 0;line-height:1.6">' + escapeHTML(sec.narrative) + '</p></div>').join('');
      const period = (d.period_start || '').slice(0, 10) + ' ~ ' + (d.period_end || '').slice(0, 10);
      view.innerHTML = section('운영 보고서 (AI Usage Narrative) — ' + escapeHTML(period),
        '<div style="padding:8px 14px"><button type="button" class="secondary" onclick="narrativeMD()">마크다운 다운로드</button></div>') +
        card('월간 운영 서술 보고서',
          '<div class="card-body">' + secs +
          '<p class="muted" style="font-size:11px;margin-top:6px">' + escapeHTML(d.note || '') + '</p></div>');
    }

    // renderSkillGraph shows each production skill's model/tool/team dependencies and the
    // policies that govern them — the change blast radius.
    async function renderSkillGraph() {
      const view = document.getElementById('view');
      view.innerHTML = section('Skill 의존성', '<div class="empty">불러오는 중...</div>');
      let d;
      try { d = await api('/admin/skills/dependency-graph'); }
      catch (e) { view.innerHTML = section('Skill 의존성', '<div class="card-body" style="padding:16px"><p class="muted">' + escapeHTML(e.message) + '</p></div>'); return; }
      const skills = d.skills || [];
      const chips = (arr, cls) => (arr && arr.length) ? arr.map(x => '<span class="pill ' + (cls || '') + '">' + escapeHTML(x) + '</span>').join(' ') : '<span class="muted">-</span>';
      const cards = skills.map(sk => {
        const pol = (sk.governing_policies || []).map(p => escapeHTML(p.name) + ' <span class="muted" style="font-size:10px">(' + escapeHTML(p.via) + ')</span>').join(', ') || '<span class="muted">관할 정책 없음</span>';
        const riskBadge = sk.risk_level === 'high' ? '<span class="status error">high</span>' : (sk.risk_level === 'medium' ? '<span class="status warn">medium</span>' : '<span class="status">' + escapeHTML(sk.risk_level || 'low') + '</span>');
        return '<div style="border:1px solid var(--border);border-radius:6px;padding:10px;margin:6px 0">' +
          '<div style="display:flex;justify-content:space-between;align-items:center"><strong>' + escapeHTML(sk.name) + '</strong> ' + riskBadge + '</div>' +
          '<div style="font-size:12px;margin-top:4px"><strong>모델:</strong> ' + chips(sk.models) + '</div>' +
          '<div style="font-size:12px;margin-top:2px"><strong>도구:</strong> ' + chips(sk.tools) + '</div>' +
          '<div style="font-size:12px;margin-top:2px"><strong>팀:</strong> ' + chips(sk.teams) + '</div>' +
          '<div style="font-size:12px;margin-top:2px"><strong>관할 정책:</strong> ' + pol + '</div>' +
        '</div>';
      }).join('');
      view.innerHTML = section('Skill 의존성 그래프 (Skill Dependency Graph)', '') +
        '<p class="muted" style="font-size:12px;padding:0 14px">' + escapeHTML(d.note || '') + ' · 노드 ' + (d.nodes || []).length + '개 · 엣지 ' + (d.edges || []).length + '개</p>' +
        card('production Skill 의존성 (' + skills.length + ')',
          '<div class="card-body">' + (cards || '<p class="muted">production Skill이 없습니다.</p>') + '</div>');
    }

    // renderChargeback shows the monthly multi-dimension cost-allocation pack with CSV export.
    async function renderChargeback() {
      const view = document.getElementById('view');
      const month = (window._chargebackMonth || '');
      view.innerHTML = section('비용 배부 팩', '<div class="empty">불러오는 중...</div>');
      let d;
      try { d = await api('/admin/cost/chargeback-pack' + (month ? '?month=' + encodeURIComponent(month) : '')); }
      catch (e) { view.innerHTML = section('비용 배부 팩', '<div class="card-body" style="padding:16px"><p class="muted">' + escapeHTML(e.message) + '</p></div>'); return; }
      window.chargebackReload = () => {
        const v = document.getElementById('cb-month').value.trim();
        window._chargebackMonth = v;
        renderChargeback();
      };
      window.chargebackCSV = async () => {
        try {
          const res = await fetch('/admin/cost/chargeback-pack?format=csv' + (d.month ? '&month=' + encodeURIComponent(d.month) : ''), { headers: headers() });
          if (!res.ok) throw new Error('HTTP ' + res.status);
          const blob = await res.blob();
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = 'chargeback-' + (d.month || 'month') + '.csv';
          a.click();
          URL.revokeObjectURL(a.href);
        } catch (e) { openModal('CSV 오류', '<div class="error-line">' + escapeHTML(e.message) + '</div>'); }
      };
      const won = (v) => '₩' + fmt(Math.round(v || 0));
      const labelOf = (dim) => ({ cost_center: '비용센터', project: '프로젝트', team: '팀', repo: '레포', branch: '브랜치', service: '서비스', model: '모델', provider: '프로바이더' })[dim] || dim;
      const dims = (d.dimensions || []).map(cd => {
        const rows = (cd.rows || []).map(r => '<tr><td>' + escapeHTML(r.key) + '</td><td data-num="' + r.requests + '">' + fmt(r.requests) + '</td><td>' + fmt(r.tokens) + '</td><td>' + won(r.cost_krw) + '</td><td>' + fmt(r.errors) + '</td></tr>').join('');
        return card(labelOf(cd.dimension) + ' 배부 — 합계 ' + won(cd.total_cost_krw) + ' / ' + fmt(cd.total_requests) + '건',
          '<div class="card-body">' + (rows
            ? '<table><thead><tr><th>' + labelOf(cd.dimension) + '</th><th>요청</th><th>토큰</th><th>비용</th><th>오류</th></tr></thead><tbody>' + rows + '</tbody></table>'
            : '<p class="muted">데이터가 없습니다.</p>') + '</div>');
      }).join('');
      view.innerHTML = section('비용 배부 팩 (Chargeback Pack) — ' + escapeHTML(d.month || ''),
        '<div style="padding:8px 14px;display:flex;gap:8px;align-items:center">' +
        '<input id="cb-month" placeholder="YYYY-MM (비우면 이번 달)" value="' + escapeAttr(d.month || '') + '" style="width:200px">' +
        '<button type="button" onclick="chargebackReload()">조회</button>' +
        '<button type="button" class="secondary" onclick="chargebackCSV()">CSV 다운로드</button></div>') +
        '<p class="muted" style="font-size:12px;padding:0 14px">' + escapeHTML(d.note || '') + '</p>' + dims;
    }

    // renderPromptDebt ranks recurring prompt clusters by accumulated "prompt debt".
    async function renderPromptDebt() {
      const view = document.getElementById('view');
      view.innerHTML = section('프롬프트 부채', '<div class="empty">분석 중...</div>');
      let d;
      try { d = await api('/admin/prompts/debt?window=30d'); }
      catch (e) { view.innerHTML = section('프롬프트 부채', '<div class="card-body" style="padding:16px"><p class="muted">' + escapeHTML(e.message) + '</p></div>'); return; }
      const items = d.items || [];
      const won = (v) => '₩' + fmt(Math.round(v || 0));
      const typeBadge = (t) => ({
        failing: '<span class="status error">실패</span>', model_waste: '<span class="status warn">모델낭비</span>',
        expensive: '<span class="status warn">고비용</span>', high_volume: '<span class="status">고볼륨</span>',
      })[t] || '<span class="muted">' + escapeHTML(t) + '</span>';
      const rows = items.map(it => '<tr>' +
        '<td data-num="' + it.debt_score + '"><strong>' + fmt(Math.round(it.debt_score)) + '</strong></td>' +
        '<td>' + typeBadge(it.debt_type) + '</td>' +
        '<td>' + escapeHTML(it.task_type || '') + '<div class="muted" style="font-size:10px">' + escapeHTML((it.fingerprint || '').slice(0, 12)) + '</div></td>' +
        '<td data-num="' + it.requests + '">' + fmt(it.requests) + '</td>' +
        '<td>' + (it.success_rate).toFixed(0) + '%</td>' +
        '<td>' + won(it.avg_cost_krw) + '</td>' +
        '<td>' + won(it.total_cost_krw) + '</td>' +
        '<td>' + escapeHTML(it.top_model || '') + (it.cheaper_model ? ' <span class="muted">→ ' + escapeHTML(it.cheaper_model) + '</span>' : '') + '</td>' +
        '<td class="muted" style="font-size:11px">' + escapeHTML(it.action || '') + '</td>' +
      '</tr>').join('');
      const table = items.length
        ? '<table><thead><tr><th>부채</th><th>유형</th><th>작업/지문</th><th>요청</th><th>성공률</th><th>평균비용</th><th>총비용</th><th>모델</th><th>권장 조치</th></tr></thead><tbody>' + rows + '</tbody></table>'
        : '<p class="muted">부채로 분류된 프롬프트가 없습니다. 👍</p>';
      view.innerHTML = section('프롬프트 부채 (Prompt Debt) — 최근 30일',
        '<div style="padding:8px 14px"><span class="muted" style="font-size:12px">부채 대상 ' + items.length + '건 · 누적 비용 ' + won(d.total_debt_cost_krw) + '</span></div>') +
        card('부채 우선순위 (점수 높은 순)',
          '<div class="card-body">' + table +
          '<p class="muted" style="font-size:11px;margin-top:6px">' + escapeHTML(d.note || '') + '</p></div>');
      makeSortable && makeSortable('#view table', 'prompt-debt');
    }

    // renderAppTemplates shows the built-in AI work-app starter catalog with one-click instantiate.
    async function renderAppTemplates() {
      const view = document.getElementById('view');
      view.innerHTML = section('앱 템플릿', '<div class="empty">불러오는 중...</div>');
      let d;
      try { d = await api('/admin/app-templates'); }
      catch (e) { view.innerHTML = section('앱 템플릿', '<div class="card-body" style="padding:16px"><p class="muted">' + escapeHTML(e.message) + '</p></div>'); return; }
      window.appTemplateInstantiate = async (key) => {
        try {
          const res = await api('/admin/app-templates/instantiate', { method: 'POST', body: JSON.stringify({ key }) });
          openModal('업무 앱 생성됨', '<p>' + escapeHTML(res.note || '') + '</p><div style="margin-top:8px"><a href="#/apps"><button type="button">AI 업무 앱으로 이동</button></a></div>');
        } catch (e) { openModal('생성 오류', '<div class="error-line">' + escapeHTML(e.message) + '</div>'); }
      };
      const tpls = d.templates || [];
      const cards = tpls.map(t => {
        const comps = (t.components || []).map(c => '<span class="pill">' + escapeHTML(c.label || c.kind) + '</span>').join(' ');
        return '<div style="border:1px solid var(--border);border-radius:6px;padding:12px;margin:6px 0">' +
          '<div style="display:flex;justify-content:space-between;align-items:center">' +
          '<strong style="font-size:14px">' + escapeHTML(t.icon || '') + ' ' + escapeHTML(t.title) + '</strong>' +
          '<span><span class="muted" style="font-size:11px">' + escapeHTML(t.category || '') + '</span> ' +
          '<button type="button" style="font-size:11px" onclick="appTemplateInstantiate(\'' + escapeAttr(t.key) + '\')">앱 생성</button></span></div>' +
          '<div class="muted" style="font-size:12px;margin:4px 0">' + escapeHTML(t.description) + '</div>' +
          '<div style="font-size:11px">' + comps + '</div>' +
        '</div>';
      }).join('');
      view.innerHTML = section('앱 템플릿 (AI App Template Catalog)', '') +
        '<p class="muted" style="font-size:12px;padding:0 14px">' + escapeHTML(d.note || '') + '</p>' +
        card('업무 앱 시작 템플릿 (' + tpls.length + ')', '<div class="card-body">' + (cards || '<p class="muted">템플릿이 없습니다.</p>') + '</div>');
    }

    // renderGatewayMCP shows the AI Gateway MCP Server catalog + a copyable client config.
    async function renderGatewayMCP() {
      const view = document.getElementById('view');
      view.innerHTML = section('Gateway MCP', '<div class="empty">불러오는 중...</div>');
      let d;
      try { d = await api('/admin/gateway-mcp/info'); }
      catch (e) { view.innerHTML = section('Gateway MCP', '<div class="card-body" style="padding:16px"><p class="muted">' + escapeHTML(e.message) + '</p></div>'); return; }
      const origin = window.location.origin;
      const cfg = JSON.stringify({ mcpServers: { 'vibe-gateway': { url: origin + (d.endpoint || '/mcp/gateway'), headers: { Authorization: 'Bearer <YOUR_API_KEY>' } } } }, null, 2);
      window.copyMCPConfig = () => { navigator.clipboard && navigator.clipboard.writeText(cfg); };
      const toolRows = (d.tools || []).map(t => '<tr><td><code>' + escapeHTML(t.name) + '</code></td><td class="muted">' + escapeHTML(t.description || '') + '</td></tr>').join('');
      const resRows = (d.resources || []).map(x => '<tr><td><code>' + escapeHTML(x.uri) + '</code></td><td class="muted">' + escapeHTML(x.description || '') + '</td></tr>').join('');
      const promptRows = (d.prompts || []).map(x => '<tr><td><code>' + escapeHTML(x.name) + '</code></td><td class="muted">' + escapeHTML(x.description || '') + '</td></tr>').join('');
      const riskBadge = (r) => r === 'high' ? '<span class="status error">high</span>' : (r === 'medium' ? '<span class="status warn">medium</span>' : '<span class="status">low</span>');
      const contractRows = (d.contracts || []).map(c => '<tr><td><code>' + escapeHTML(c.name) + '</code></td><td>' + riskBadge(c.risk_level) + '</td><td class="muted">' + escapeHTML(c.cost_policy) + '</td><td class="muted">' + (c.timeout_ms ? Math.round(c.timeout_ms / 1000) + 's' : '-') + '</td><td>' + (c.executes ? '실행' : '읽기') + '</td><td class="muted" style="font-size:11px">' + escapeHTML(c.output_schema || '') + '</td></tr>').join('');
      view.innerHTML = section('Gateway MCP Server', '') +
        card('연결 설정 (Claude / Cursor / Roo Code / Cline)',
          '<div class="card-body"><p class="muted" style="font-size:12px">엔드포인트 <code>' + escapeHTML(origin + (d.endpoint || '')) + '</code> · 프로토콜 ' + escapeHTML(d.protocol_version || '') + ' · 인증: Proxy API Key</p>' +
          '<pre style="background:var(--bg-alt,#f6f8fa);padding:10px;border-radius:6px;overflow:auto;font-size:11px">' + escapeHTML(cfg) + '</pre>' +
          '<button type="button" class="secondary" onclick="copyMCPConfig()">설정 복사</button>' +
          '<p class="muted" style="font-size:11px;margin-top:6px">' + escapeHTML(d.note || '') + '</p></div>') +
        card('Tools (' + (d.tools || []).length + ')', '<div class="card-body"><table><thead><tr><th>tool</th><th>설명</th></tr></thead><tbody>' + toolRows + '</tbody></table></div>') +
        card('Resources (' + (d.resources || []).length + ')', '<div class="card-body"><table><thead><tr><th>uri</th><th>설명</th></tr></thead><tbody>' + resRows + '</tbody></table></div>') +
        card('Prompts (' + (d.prompts || []).length + ')', '<div class="card-body"><table><thead><tr><th>prompt</th><th>설명</th></tr></thead><tbody>' + promptRows + '</tbody></table></div>') +
        card('Tool 계약 (Contract Pack)', '<div class="card-body"><p class="muted" style="font-size:12px">각 Gateway MCP tool의 위험도·비용 정책·timeout·실행 여부·출력 스키마 계약입니다.</p><table><thead><tr><th>tool</th><th>위험</th><th>비용</th><th>timeout</th><th>유형</th><th>출력</th></tr></thead><tbody>' + contractRows + '</tbody></table></div>') +
        '<div id="mcp-contracts"></div>';
      renderMCPContracts();
    }

    // renderMCPContracts shows the MCP Tool Contract Registry: list, create, delete, and drift validate.
    async function renderMCPContracts() {
      const host = document.getElementById('mcp-contracts');
      if (!host) return;
      let d;
      try { d = await api('/admin/mcp/contracts'); }
      catch (e) { host.innerHTML = card('MCP Tool Contract Registry', '<div class="card-body"><p class="muted">' + escapeHTML(e.message) + '</p></div>'); return; }
      window.mcpContractCreate = async (event) => {
        event.preventDefault();
        const body = {
          name: document.getElementById('mc-name').value.trim(),
          namespace: document.getElementById('mc-ns').value.trim() || 'gateway',
          risk_level: document.getElementById('mc-risk').value,
          owner: document.getElementById('mc-owner').value.trim(),
          allowed_roles: document.getElementById('mc-roles').value.trim(),
          cost_policy: document.getElementById('mc-cost').value.trim(),
          input_schema: document.getElementById('mc-schema').value.trim(),
        };
        if (!body.name) { alert('tool name이 필요합니다.'); return; }
        if (body.input_schema) { try { JSON.parse(body.input_schema); } catch (e) { alert('input_schema JSON 파싱 오류: ' + e.message); return; } }
        try { await api('/admin/mcp/contracts', { method: 'POST', body: JSON.stringify(body) }); document.getElementById('mc-form').reset(); renderMCPContracts(); }
        catch (e) { alert('저장 오류: ' + e.message); }
      };
      window.mcpContractDelete = async (id) => {
        if (!confirm('계약을 삭제할까요?')) return;
        try { await api('/admin/mcp/contracts?id=' + encodeURIComponent(id), { method: 'DELETE' }); renderMCPContracts(); }
        catch (e) { alert('삭제 오류: ' + e.message); }
      };
      window.mcpContractValidate = async () => {
        try {
          const r = await api('/admin/mcp/contracts/validate', { method: 'POST', body: '{}' });
          const badge = (s) => s === 'drift' ? '<span class="status warn">DRIFT</span>' : (s === 'missing' ? '<span class="status error">MISSING</span>' : (s === 'ok' ? '<span class="status">OK</span>' : '<span class="muted">N/A</span>'));
          const rows = (r.results || []).map(x => '<tr><td><code>' + escapeHTML(x.name) + '</code></td><td>' + badge(x.status) + '</td><td class="muted" style="font-size:11px">' + escapeHTML(x.detail || '') +
            ((x.declared_only || []).length ? '<br>계약에만: ' + escapeHTML((x.declared_only || []).join(', ')) : '') +
            ((x.live_only || []).length ? '<br>실제에만: ' + escapeHTML((x.live_only || []).join(', ')) : '') + '</td></tr>').join('');
          openModal('드리프트 검증 (' + (r.drift_count || 0) + ' drift · ' + (r.missing_count || 0) + ' missing / ' + (r.checked || 0) + ' 검사)',
            '<table><thead><tr><th>tool</th><th>상태</th><th>상세</th></tr></thead><tbody>' + rows + '</tbody></table>' +
            '<p class="muted" style="font-size:11px;margin-top:6px">' + escapeHTML(r.note || '') + '</p>');
        } catch (e) { openModal('검증 오류', '<div class="error-line">' + escapeHTML(e.message) + '</div>'); }
      };
      const cs = d.contracts || [];
      const riskBadge = (r) => r === 'high' ? '<span class="status error">high</span>' : (r === 'medium' ? '<span class="status warn">medium</span>' : '<span class="status">low</span>');
      const rows = cs.map(c => '<tr>' +
        '<td><code>' + escapeHTML(c.name) + '</code><div class="muted" style="font-size:10px">' + escapeHTML(c.namespace) + '</div></td>' +
        '<td>' + riskBadge(c.risk_level) + '</td>' +
        '<td class="muted">' + (c.timeout_ms ? escapeHTML(String(c.timeout_ms)) + 'ms' : '-') + '</td>' +
        '<td class="muted">' + escapeHTML(c.allowed_roles || '전체') + '</td>' +
        '<td class="muted">' + escapeHTML(c.owner || '-') + '</td>' +
        '<td>' + (c.enabled ? '✓' : '-') + '</td>' +
        '<td><button type="button" class="danger" style="font-size:11px" onclick="mcpContractDelete(\'' + escapeAttr(c.id) + '\')">삭제</button></td></tr>').join('');
      host.innerHTML = card('MCP Tool Contract Registry (' + cs.length + ')',
        '<div class="card-body"><p class="muted" style="font-size:12px">MCP tool의 입력/출력 스키마·위험등급·타임아웃·허용 역할·비용 정책·소유자를 계약으로 고정하고, 실제 게이트웨이 tool과의 스키마 드리프트를 탐지합니다.</p>' +
        '<button type="button" onclick="mcpContractValidate()">드리프트 검증</button>' +
        (cs.length ? '<table style="margin-top:8px"><thead><tr><th>tool</th><th>위험</th><th>timeout</th><th>역할</th><th>소유자</th><th>활성</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>' : '<p class="muted" style="margin-top:8px">등록된 계약이 없습니다.</p>') +
        '<form id="mc-form" onsubmit="mcpContractCreate(event)" style="margin-top:12px;border-top:1px solid var(--border);padding-top:10px;display:grid;grid-template-columns:repeat(3,1fr);gap:6px">' +
        '<input id="mc-name" placeholder="tool name (예: gateway_chat)" required>' +
        '<input id="mc-ns" placeholder="namespace (기본 gateway)">' +
        '<select id="mc-risk"><option value="low">low</option><option value="medium">medium</option><option value="high">high</option></select>' +
        '<input id="mc-owner" placeholder="소유자">' +
        '<input id="mc-roles" placeholder="허용 역할 CSV">' +
        '<input id="mc-cost" placeholder="비용 정책">' +
        '<textarea id="mc-schema" placeholder=\'input_schema JSON (예: {"type":"object","properties":{...}})\' style="grid-column:1/4;font-family:monospace;font-size:11px;min-height:48px"></textarea>' +
        '<button type="submit" style="grid-column:1/4">계약 저장</button></form></div>');
    }

    // renderWorkflows manages workflow chain definitions (list / create via JSON / dry-run / delete).
    async function renderWorkflows() {
      const view = document.getElementById('view');
      view.innerHTML = section('워크플로', '<div class="empty">불러오는 중...</div>');
      let d;
      try { d = await api('/admin/workflows'); }
      catch (e) { view.innerHTML = section('워크플로', '<div class="card-body" style="padding:16px"><p class="muted">' + escapeHTML(e.message) + '</p></div>'); return; }
      window.wfCreate = async (event) => {
        event.preventDefault();
        const name = document.getElementById('wf-name').value.trim();
        let steps;
        try { steps = JSON.parse(document.getElementById('wf-steps').value || '[]'); }
        catch (e) { alert('steps JSON 파싱 오류: ' + e.message); return; }
        if (!name || !Array.isArray(steps) || !steps.length) { alert('이름과 steps 배열이 필요합니다.'); return; }
        try {
          await api('/admin/workflows', { method: 'POST', body: JSON.stringify({ name, steps, allowed_teams: document.getElementById('wf-teams').value.trim() }) });
          document.getElementById('wf-form').reset();
          renderWorkflows();
        } catch (e) { alert('저장 오류: ' + e.message); }
      };
      window.wfDelete = async (id) => {
        if (!confirm('워크플로를 삭제할까요?')) return;
        try { await api('/admin/workflows?id=' + encodeURIComponent(id), { method: 'DELETE' }); renderWorkflows(); }
        catch (e) { alert('삭제 오류: ' + e.message); }
      };
      window.wfDryRun = async (id) => {
        try {
          const r = await api('/admin/workflows/' + encodeURIComponent(id) + '/dry-run', { method: 'POST', body: '{}' });
          const stepRows = (r.steps || []).map(st => '<tr><td>' + escapeHTML(st.name || '') + '</td><td>' + escapeHTML(st.type) + '</td><td>' + (st.resolved ? '<span class="status">OK</span>' : '<span class="status error">미해결</span>') + '</td><td class="muted">' + escapeHTML(st.detail || '') + '</td></tr>').join('');
          openModal('Dry-run: ' + escapeHTML(r.name || id),
            '<p>' + (r.ok ? '<span class="status">검증 통과</span>' : '<span class="status error">' + (r.issues || []).length + '개 이슈</span>') + '</p>' +
            '<table><thead><tr><th>step</th><th>유형</th><th>해결</th><th>상세</th></tr></thead><tbody>' + stepRows + '</tbody></table>' +
            ((r.issues || []).length ? '<ul style="font-size:12px;color:var(--err,#c00)">' + r.issues.map(x => '<li>' + escapeHTML(x) + '</li>').join('') + '</ul>' : ''));
        } catch (e) { openModal('Dry-run 오류', '<div class="error-line">' + escapeHTML(e.message) + '</div>'); }
      };
      window.wfPublish = async (id) => {
        const note = prompt('발행 메모(선택). 발행하면 현재 정의가 새 버전으로 저장되고 워크플로가 활성화됩니다. (검증 실패 시 발행 거부)');
        if (note === null) return;
        try {
          const r = await api('/admin/workflows/' + encodeURIComponent(id) + '/publish', { method: 'POST', body: JSON.stringify({ note: note }) });
          alert('발행됨 — 버전 v' + r.version);
          renderWorkflows();
        } catch (e) { alert('발행 실패: ' + e.message); }
      };
      window.wfVersions = async (id) => {
        try {
          const r = await api('/admin/workflows/' + encodeURIComponent(id) + '/versions');
          const vs = r.versions || [];
          const rows = vs.length
            ? vs.map(v => '<tr><td>v' + v.version + '</td><td class="muted">' + escapeHTML(v.published_by || '') + '</td><td class="muted">' + ago(v.published_at) + '</td><td>' + (v.steps || []).length + ' step</td><td class="muted" style="font-size:11px">' + escapeHTML(v.note || '') + '</td></tr>').join('')
            : '<tr><td colspan="5" class="muted">발행된 버전이 없습니다.</td></tr>';
          openModal('워크플로 버전 이력', '<table><thead><tr><th>버전</th><th>발행자</th><th>발행</th><th>steps</th><th>메모</th></tr></thead><tbody>' + rows + '</tbody></table>');
        } catch (e) { openModal('버전 조회 오류', '<div class="error-line">' + escapeHTML(e.message) + '</div>'); }
      };
      const wfs = d.workflows || [];
      const rows = wfs.map(wf => '<tr>' +
        '<td>' + escapeHTML(wf.name) + '<div class="muted" style="font-size:10px">' + escapeHTML(wf.id) + '</div></td>' +
        '<td>' + (wf.steps || []).length + '</td>' +
        '<td>' + (wf.enabled ? '✓' : '-') + '</td>' +
        '<td class="muted">' + escapeHTML((wf.allowed_teams || '') || '전체') + '</td>' +
        '<td><button type="button" class="secondary" style="font-size:11px" onclick="wfDryRun(\'' + escapeAttr(wf.id) + '\')">Dry-run</button> ' +
        '<button type="button" class="secondary" style="font-size:11px" onclick="wfPublish(\'' + escapeAttr(wf.id) + '\')">발행</button> ' +
        '<button type="button" class="secondary" style="font-size:11px" onclick="wfVersions(\'' + escapeAttr(wf.id) + '\')">버전</button> ' +
        '<button type="button" class="danger" style="font-size:11px" onclick="wfDelete(\'' + escapeAttr(wf.id) + '\')">삭제</button></td>' +
      '</tr>').join('');
      const sample = '[{"name":"리뷰","type":"chat","ref":"vibe/auto","max_tokens":500},{"name":"승인","type":"approval"}]';
      view.innerHTML = section('워크플로 (Workflow Chain)', '') +
        card('워크플로 생성',
          '<div class="card-body"><form id="wf-form" style="display:flex;flex-direction:column;gap:6px">' +
          '<div style="display:flex;gap:8px"><input id="wf-name" placeholder="워크플로 이름" required style="flex:1"><input id="wf-teams" placeholder="허용 팀(쉼표, 빈칸=전체)" style="flex:1"></div>' +
          '<textarea id="wf-steps" rows="4" placeholder=\'steps JSON: ' + escapeAttr(sample) + '\'></textarea>' +
          '<div class="muted" style="font-size:11px">step 유형: chat·text2sql·mcp_tool·skill·condition·approval·transform. 한도: timeout_ms·max_cost_krw·max_tokens·allowed_tools·allowed_tables.</div>' +
          '<div><button type="submit">추가</button></div>' +
          '</form></div>') +
        card('워크플로 목록 (' + wfs.length + ')',
          '<div class="card-body">' + (wfs.length
            ? '<table><thead><tr><th>이름</th><th>steps</th><th>사용</th><th>허용 팀</th><th>동작</th></tr></thead><tbody>' + rows + '</tbody></table>'
            : '<p class="muted">등록된 워크플로가 없습니다.</p>') +
          '<p class="muted" style="font-size:11px;margin-top:6px">실행: <code>POST /v1/workflows/{id}/run</code> 본문 <code>{"execute":true,"input":"..."}</code> (사용자 토큰).</p></div>');
      const form = document.getElementById('wf-form');
      if (form) form.addEventListener('submit', window.wfCreate);
    }

    // renderSandbox previews a candidate sensitive request through safety gates without executing.
    function renderSandbox() {
      const view = document.getElementById('view');
      window.sandboxRun = async () => {
        const body = {
          kind: document.getElementById('sb-kind').value,
          model: document.getElementById('sb-model').value.trim(),
          team: document.getElementById('sb-team').value.trim(),
          content: document.getElementById('sb-content').value,
          sql: document.getElementById('sb-sql').value.trim(),
          server: document.getElementById('sb-server').value.trim(),
          tool: document.getElementById('sb-tool').value.trim(),
        };
        const host = document.getElementById('sb-result');
        host.innerHTML = '<div class="empty">검증 중...</div>';
        try {
          const r = await api('/admin/sandbox/preview', { method: 'POST', body: JSON.stringify(body) });
          const verdict = r.would_block ? '<span class="status error">차단 예상</span>' : '<span class="status">통과 예상</span>';
          const c = r.checks || {};
          const lines = [];
          if (c.prompt_injection) lines.push(row('프롬프트 인젝션', '심각도 ' + (c.prompt_injection.severity || 0) + (c.prompt_injection.families && c.prompt_injection.families.length ? ' · ' + escapeHTML(c.prompt_injection.families.join(', ')) : '')));
          if (c.secrets) lines.push(row('Secret 탐지', (c.secrets.count || 0) + '건' + (c.secrets.types && c.secrets.types.length ? ' (' + escapeHTML(c.secrets.types.join(', ')) + ')' : '')));
          if (c.policy) lines.push(row('정책', escapeHTML(c.policy.outcome) + (c.policy.reason ? ' — ' + escapeHTML(c.policy.reason) : '')));
          if (c.text2sql_validation) lines.push(row('SQL 검증', (c.text2sql_validation.ok ? '통과' : '실패: ' + escapeHTML(c.text2sql_validation.reason || ''))));
          if (c.mcp_tool_risk) lines.push(row('MCP 도구 위험', escapeHTML(c.mcp_tool_risk.risk_level) + ' / ' + escapeHTML(c.mcp_tool_risk.action)));
          host.innerHTML = '<div style="border:1px solid var(--border);border-radius:6px;padding:10px;margin-top:8px">' +
            '<strong>결과: ' + verdict + '</strong>' +
            (r.reasons && r.reasons.length ? '<div class="muted" style="font-size:12px;margin:4px 0">' + escapeHTML(r.reasons.join(' · ')) + '</div>' : '') +
            '<div class="kv" style="margin-top:6px">' + lines.join('') + '</div>' +
            '<p class="muted" style="font-size:11px;margin-top:6px">' + escapeHTML(r.note || '') + '</p></div>';
        } catch (e) { host.innerHTML = '<span class="status error">' + escapeHTML(e.message) + '</span>'; }
      };
      view.innerHTML = section('민감 워크플로 샌드박스 (Sandbox Preview)',
        '<div class="card-body" style="padding:12px 14px">' +
        '<p class="muted" style="font-size:12px;margin:0 0 8px">고위험 요청(chat/Text2SQL/MCP)을 실제 실행 없이 안전 게이트(정책·인젝션·secret·SQL 검증·MCP 위험)에만 통과시켜 결과를 미리 봅니다. 입력 원문은 저장되지 않습니다.</p>' +
        '<div style="display:grid;grid-template-columns:repeat(2,1fr);gap:8px">' +
          '<label class="ct-field"><span>종류</span><select id="sb-kind"><option value="chat">chat</option><option value="text2sql">text2sql</option><option value="mcp">mcp</option></select></label>' +
          '<label class="ct-field"><span>모델</span><input id="sb-model" placeholder="gpt-4.1"></label>' +
          '<label class="ct-field"><span>팀</span><input id="sb-team" placeholder="team id (선택)"></label>' +
          '<label class="ct-field"><span>MCP server</span><input id="sb-server" placeholder="server (선택)"></label>' +
          '<label class="ct-field"><span>MCP tool</span><input id="sb-tool" placeholder="tool (선택)"></label>' +
        '</div>' +
        '<label class="ct-field" style="margin-top:6px"><span>프롬프트/질문 (선택)</span><textarea id="sb-content" rows="3" placeholder="검증할 프롬프트 텍스트"></textarea></label>' +
        '<label class="ct-field"><span>SQL (text2sql, 선택)</span><textarea id="sb-sql" rows="2" placeholder="SELECT ..."></textarea></label>' +
        '<div style="margin-top:8px"><button type="button" onclick="sandboxRun()">샌드박스 검증</button></div>' +
        '<div id="sb-result"></div></div>');
    }

    // renderMeHome is the personalized landing for non-operators: their own usage, cost,
    // models, failures, key alerts, risk, and recommendations — no operational metrics.
    async function renderMeHome() {
      const view = document.getElementById('view');
      view.innerHTML = section('내 홈', '<div class="empty">불러오는 중...</div>');
      let d;
      try { d = await api('/me/dashboard'); }
      catch (e) {
        view.innerHTML = section('내 홈', '<div class="card-body" style="padding:16px"><p class="muted">개인 대시보드를 불러올 수 없습니다(로그인 또는 user_id 매핑이 필요). 상세: ' + escapeHTML(e.message) + '</p></div>');
        return;
      }
      const today = d.today || {}, month = d.month || {}, prof = d.profile || {};
      const pctv = (v) => (v == null ? '-' : (v * 100).toFixed(1) + '%');
      const won = (v) => '₩' + fmt(Math.round(v || 0));
      const todaySuccess = today.requests ? (1 - (today.errors || 0) / today.requests) : (prof.success_rate || 0);

      const kpis = '<div class="kpis">' +
        kpi('오늘 요청', fmt(today.requests || 0)) +
        kpi('오늘 성공률', pctv(todaySuccess)) +
        kpi('오늘 오류', fmt(today.errors || 0)) +
        kpi('이번 달 비용', won(month.cost_krw)) +
        kpi('절감 가능', won(d.potential_savings_krw)) +
        kpi('개인 위험점수', fmt(prof.risk_score || 0)) +
      '</div>';

      // Profile rates card.
      const profCard = card('내 프로필 (최근 30일)',
        '<div class="card-body"><div class="kpis">' +
          kpi('성공률', pctv(prof.success_rate)) +
          kpi('평균 지연', fmt(Math.round(prof.avg_latency_ms || 0)) + 'ms') +
          kpi('캐시율', pctv(prof.cache_rate)) +
          kpi('Text2SQL 사용', pctv(prof.text2sql_usage_rate)) +
          kpi('MCP 사용', pctv(prof.mcp_usage_rate)) +
        '</div>' + (prof.summary ? '<p class="muted" style="margin-top:8px">' + escapeHTML(prof.summary) + '</p>' : '') + '</div>');

      // Frequent models.
      const models = d.frequent_models || [];
      const modelsCard = card('자주 쓰는 모델',
        '<div class="card-body">' + (models.length
          ? '<table><thead><tr><th>모델</th><th>요청</th><th>성공률</th><th>평균비용</th></tr></thead><tbody>' +
            models.map(m => '<tr><td>' + escapeHTML(m.model) + '</td><td>' + fmt(m.requests) + '</td><td>' + pctv(m.success_rate) + '</td><td>' + won(m.avg_cost_krw) + '</td></tr>').join('') + '</tbody></table>'
          : '<p class="muted">데이터가 없습니다.</p>') + '</div>');

      // Recent failures.
      const fails = d.recent_failures || [];
      const failCard = card('최근 실패',
        '<div class="card-body">' + (fails.length
          ? '<table><thead><tr><th>모델</th><th>코드</th><th>유형</th><th>시각</th></tr></thead><tbody>' +
            fails.map(f => '<tr><td>' + escapeHTML(f.model) + '</td><td><span class="status error">' + f.status_code + '</span></td><td>' + escapeHTML(f.task_type || '') + '</td><td class="muted">' + ago(f.created_at) + '</td></tr>').join('') + '</tbody></table>'
          : '<p class="muted">최근 실패가 없습니다. 👍</p>') + '</div>');

      // Key alerts.
      const alerts = d.key_alerts || [];
      const keyCard = card('내 키 상태',
        '<div class="card-body">' + (alerts.length
          ? '<ul style="margin:0;padding-left:18px">' + alerts.map(a => '<li>' + escapeHTML(a.name || a.id || '') + ' — <span class="status warn">' + escapeHTML(a.reason || a.alert || '') + '</span></li>').join('') + '</ul>'
          : '<p class="muted">주의가 필요한 키가 없습니다.</p>') +
          '<div style="margin-top:8px"><a href="#/mykeys">내 키 관리 →</a></div></div>');

      // Top MCP tools + task types from profile.
      const mcpTop = prof.top_mcp_tools || [], taskTop = prof.top_task_types || [];
      const usageCard = card('내 사용 패턴',
        '<div class="card-body" style="display:flex;gap:24px;flex-wrap:wrap">' +
          '<div><strong>작업 유형 Top</strong>' + (taskTop.length ? '<ul style="margin:4px 0;padding-left:18px">' + taskTop.map(x => '<li>' + escapeHTML(x.key) + ' (' + fmt(x.requests) + ')</li>').join('') + '</ul>' : '<p class="muted">-</p>') + '</div>' +
          '<div><strong>MCP 도구 Top</strong>' + (mcpTop.length ? '<ul style="margin:4px 0;padding-left:18px">' + mcpTop.map(x => '<li>' + escapeHTML(x.key) + ' (' + fmt(x.requests) + ')</li>').join('') + '</ul>' : '<p class="muted">-</p>') + '</div>' +
        '</div>');

      // Recent policy blocks — "왜 막혔나" (원문 미노출, 규칙·사유만).
      const blocks = d.recent_blocks || [];
      const blockCard = card('최근 차단 사유',
        '<div class="card-body">' + (blocks.length
          ? '<table><thead><tr><th>규칙</th><th>사유</th><th>모델</th><th>시각</th></tr></thead><tbody>' +
            blocks.map(b => '<tr><td>' + escapeHTML(b.rule || '') + '</td><td>' + escapeHTML(b.reason || '') + '</td><td class="muted">' + escapeHTML(b.model || '') + '</td><td class="muted">' + ago(b.created_at) + '</td></tr>').join('') + '</tbody></table>'
          : '<p class="muted">최근 차단된 요청이 없습니다. 👍</p>') + '</div>');

      // My saved Text2SQL reports (metadata only — no raw SQL).
      const myReports = d.my_saved_reports || [];
      const reportsCard = card('내 저장 리포트',
        '<div class="card-body">' + (myReports.length
          ? '<table><thead><tr><th>이름</th><th>스키마</th><th>유형</th><th>공개</th><th>승인</th><th>생성</th></tr></thead><tbody>' +
            myReports.map(r => '<tr><td>' + escapeHTML(r.name || '') + '</td><td class="muted">' + escapeHTML(r.schema_name || '') + '</td><td>' + escapeHTML(r.kind || '') + '</td><td>' + (r.visibility === 'team' ? '<span class="status">팀</span>' : '<span class="muted">개인</span>') + '</td><td class="muted">' + escapeHTML(r.approval_status || '') + '</td><td class="muted">' + ago(r.created_at) + '</td></tr>').join('') + '</tbody></table>'
          : '<p class="muted">저장한 리포트가 없습니다. Text2SQL 결과를 저장하면 여기 표시됩니다.</p>') + '</div>');

      // MCP 연결 설정 — 내 개발도구(Claude/Cursor/Roo/Cline)에서 Gateway를 MCP로 연결.
      window.meCopyMCP = () => {
        const cfg = JSON.stringify({ mcpServers: { 'vibe-gateway': { url: window.location.origin + '/mcp/gateway', headers: { Authorization: 'Bearer <YOUR_API_KEY>' } } } }, null, 2);
        navigator.clipboard && navigator.clipboard.writeText(cfg);
      };
      const mcpCfg = JSON.stringify({ mcpServers: { 'vibe-gateway': { url: window.location.origin + '/mcp/gateway', headers: { Authorization: 'Bearer <YOUR_API_KEY>' } } } }, null, 2);
      window.meRunDoctor = async () => {
        const host = document.getElementById('me-doctor-result');
        const client = (document.getElementById('me-doctor-client') || {}).value || 'openai-sdk';
        if (host) host.innerHTML = '<p class="muted">진단 중…</p>';
        let d;
        try { d = await api('/me/connection-doctor', { method: 'POST', body: JSON.stringify({ client }) }); }
        catch (e) { if (host) host.innerHTML = '<p class="muted">진단 실패: ' + escapeHTML(String(e)) + '</p>'; return; }
        if (!host || !d) return;
        const badge = (s) => s === 'fail' ? '<span class="status error">FAIL</span>' : (s === 'warn' ? '<span class="status warn">WARN</span>' : (s === 'skip' ? '<span class="muted">SKIP</span>' : '<span class="status">PASS</span>'));
        host.innerHTML = '<p style="font-size:12px;margin:6px 0">종합: ' + badge(d.overall) + ' <span class="muted">base ' + escapeHTML(d.base_url || '') + '</span></p>' +
          '<table><thead><tr><th>항목</th><th>상태</th><th>설명</th></tr></thead><tbody>' +
          (d.checks || []).map(c => '<tr><td>' + escapeHTML(c.name) + '</td><td>' + badge(c.status) + '</td><td class="muted" style="font-size:11px">' + escapeHTML(c.detail || '') + (c.fix && c.status !== 'pass' ? '<br><strong>조치:</strong> ' + escapeHTML(c.fix) : '') + '</td></tr>').join('') +
          '</tbody></table>';
      };
      const mcpCard = card('내 개발도구 연결하기 (MCP)',
        '<div class="card-body"><p class="muted" style="font-size:12px">Claude Desktop·Cursor·Roo Code·Cline에서 아래 설정으로 Gateway를 MCP 서버로 연결하면 모델 조회·라우팅 미리보기·사용량 확인 등을 도구로 쓸 수 있습니다. <code>&lt;YOUR_API_KEY&gt;</code>는 <a href="#/mykeys">내 키</a>에서 발급하세요.</p>' +
        '<pre style="background:var(--bg-alt,#f6f8fa);padding:10px;border-radius:6px;overflow:auto;font-size:11px">' + escapeHTML(mcpCfg) + '</pre>' +
        '<button type="button" class="secondary" onclick="meCopyMCP()">설정 복사</button>' +
        '<div style="margin-top:12px;border-top:1px solid var(--border);padding-top:10px">' +
        '<p class="muted" style="font-size:12px">연결이 잘 안 되면 클라이언트를 고르고 진단하세요. 인증·scope·모델 허용·쿼터·<code>/v1/models</code>·<code>/mcp/gateway</code>를 점검합니다.</p>' +
        '<select id="me-doctor-client" style="font-size:12px"><option value="openai-sdk">OpenAI SDK</option><option value="cursor">Cursor</option><option value="roo">Roo Code</option><option value="cline">Cline</option><option value="claude-desktop-mcp">Claude Desktop (MCP)</option></select> ' +
        '<button type="button" onclick="meRunDoctor()">연결 진단</button>' +
        '<div id="me-doctor-result" style="margin-top:8px"></div></div></div>');

      // Recommendations (load on demand).
      const recCard = card('내 추천',
        '<div class="card-body"><div id="me-recs"><button type="button" class="secondary" onclick="meLoadRecommendations()">추천 불러오기</button></div></div>');

      view.innerHTML = section('내 홈', kpis) +
        '<div id="me-actions"></div><div id="me-report"></div>' +
        profCard + usageCard + modelsCard + '<div id="me-failures">' + failCard + '</div>' + blockCard + '<div id="me-reports">' + reportsCard + '</div>' + keyCard + mcpCard + recCard +
        '<div id="me-requests"></div><div id="me-recmodels"></div><div id="me-skills"></div><div id="me-notifications"></div><div id="me-sessions"></div>';

      // 최근 요청 + 영수증.
      meLoadRequests();
      // 내 업무 추천 모델 — 최근 작업 유형 + 모델 용도 태그 결합.
      meLoadRecommendedModels();
      // Skill Marketplace — 사용 가능한/요청 가능한 Skill.
      meLoadSkills();
      // 로그인 세션 관리 — 활성 세션 목록 + 개별/타 세션 일괄 종료.
      meLoadSessions();

      // 개인 액션 큐 — 지금 바로 행동 가능한 카드.
      api('/me/actions').then(a => {
        const host = document.getElementById('me-actions');
        if (!host) return;
        const acts = (a && a.actions) || [];
        if (!acts.length) { host.innerHTML = ''; return; }
        const sev = (s) => s === 'high' ? 'error' : (s === 'medium' ? 'warn' : '');
        host.innerHTML = card('내 액션 큐 (' + acts.length + ')',
          '<div class="card-body">' + acts.map(c =>
            '<div style="display:flex;align-items:center;gap:10px;justify-content:space-between;border:1px solid var(--border);border-radius:6px;padding:8px 10px;margin-bottom:6px">' +
            '<span><span class="status ' + sev(c.severity) + '" style="font-size:11px">' + escapeHTML(c.severity) + '</span> ' + escapeHTML(c.message) + '</span>' +
            '<span style="display:flex;gap:6px"><button type="button" style="font-size:11px" onclick="meActionGo(\'' + escapeAttr(c.button_href || '#/me') + '\')">' + escapeHTML(c.button_label) + '</button>' +
            '<button type="button" class="secondary" style="font-size:11px" onclick="meSnoozeAction(\'' + escapeAttr(c.type) + '\')">나중에</button></span>' +
            '</div>').join('') + '</div>');
      }).catch(() => {});

      // 주간 사용 리포트.
      api('/me/report?window=weekly').then(rp => {
        const host = document.getElementById('me-report');
        if (!host || !rp) return;
        const won = (v) => '₩' + fmt(Math.round(v || 0));
        const delta = rp.cost_delta_ratio || 0;
        const deltaBadge = delta > 0.05 ? '<span class="status warn">▲ ' + (delta*100).toFixed(0) + '%</span>' : (delta < -0.05 ? '<span class="status">▼ ' + Math.abs(delta*100).toFixed(0) + '%</span>' : '<span class="status">유사</span>');
        host.innerHTML = card('주간 사용 리포트',
          '<div class="card-body"><div class="kpis">' +
            kpi('요청', fmt(rp.requests || 0)) +
            kpi('비용', won(rp.cost_krw)) +
            kpi('성공률', ((rp.success_rate||0)*100).toFixed(1)+'%') +
            kpi('평균 지연', fmt(Math.round(rp.avg_latency_ms||0)) + 'ms') +
          '</div><p style="margin:8px 0;font-size:12px">전주 대비 비용: ' + deltaBadge + ' <a href="#/me" onclick="meLoadReport(\'monthly\');return false" class="muted">월간 보기</a></p></div>');
      }).catch(() => {});

      // 개인 알림 센터.
      api('/me/notifications').then(n => {
        const host = document.getElementById('me-notifications');
        if (!host || !n) return;
        const items = (n.notifications || []).slice(0, 15);
        const lvl = (l) => l === 'critical' ? 'error' : (l === 'warning' ? 'warn' : '');
        host.innerHTML = card('알림 센터' + (n.critical_count ? ' (긴급 ' + n.critical_count + ')' : ''),
          '<div class="card-body">' + (items.length
            ? items.map(x => '<div style="margin:3px 0;font-size:12px"><span class="status ' + lvl(x.level) + '" style="font-size:10px">' + escapeHTML(x.category) + '</span> <strong>' + escapeHTML(x.title) + '</strong>' + (x.detail ? ' <span class="muted">— ' + escapeHTML(x.detail) + '</span>' : '') + '</div>').join('')
            : '<p class="muted">새 알림이 없습니다.</p>') + '</div>');
      }).catch(() => {});
    }

    // 내 업무 추천 모델: 최근 작업 유형 + 관리자 모델 용도 태그 결합.
    window.meLoadRecommendedModels = async () => {
      const host = document.getElementById('me-recmodels');
      if (!host) return;
      let d;
      try { d = await api('/me/recommended-models'); } catch (e) { host.innerHTML = ''; return; }
      const recs = d.task_recommendations || [];
      const winners = d.team_winners || [];
      if (!recs.length && !winners.length && !(d.your_models || []).some(m => m.tags)) { host.innerHTML = ''; return; } // 데이터 없으면 카드 숨김
      const taskRows = recs.map(t =>
        '<div style="font-size:12px;margin:3px 0"><strong>' + escapeHTML(t.task_type) + '</strong> <span class="muted">(' + fmt(t.requests) + '회)</span> ' +
        ((t.recommend || []).length ? '👍 ' + (t.recommend || []).map(escapeHTML).join(', ') : '') +
        ((t.avoid || []).length ? ' <span class="status warn" style="font-size:9px">지양: ' + (t.avoid || []).map(escapeHTML).join(', ') + '</span>' : '') +
        '</div>').join('');
      const mine = (d.your_models || []).filter(m => m.tags).slice(0, 6).map(m =>
        '<div style="font-size:11px" class="muted">' + escapeHTML(m.model) + ': ' + (m.tags.good_for ? '👍' + escapeHTML(m.tags.good_for) : '') + (m.tags.risk_note ? ' ⚠' + escapeHTML(m.tags.risk_note) : '') + '</div>').join('');
      const winnerRows = winners.length
        ? '<div style="margin-top:6px;border-top:1px solid var(--border);padding-top:6px"><strong style="font-size:11px">팀 멀티모델 우승 모델 (90일)</strong>' +
          winners.map(wm => '<div style="font-size:11px">🏆 ' + escapeHTML(wm.model) + ' <span class="muted">우승 ' + wm.wins + '회 · 평균 ' + (wm.avg_score || 0).toFixed(1) + '점</span></div>').join('') + '</div>'
        : '';
      host.innerHTML = card('내 업무 추천 모델',
        '<div class="card-body">' +
        (taskRows || '<p class="muted" style="font-size:12px">작업 유형에 매칭되는 추천 태그가 없습니다.</p>') +
        winnerRows +
        (mine ? '<div style="margin-top:6px;border-top:1px solid var(--border);padding-top:6px"><strong style="font-size:11px">내가 쓰는 모델 태그</strong>' + mine + '</div>' : '') +
        '<p class="muted" style="font-size:10px;margin-top:6px">' + escapeHTML(d.note || '') + '</p></div>');
    };

    // Skill Marketplace: 사용 가능한 Skill + 요청 가능한 Skill.
    window.meLoadRequests = async () => {
      const host = document.getElementById('me-requests');
      if (!host) return;
      let d;
      try { d = await api('/me/requests?limit=15'); } catch (e) { host.innerHTML = ''; return; }
      const reqs = d.requests || [];
      if (!reqs.length) { host.innerHTML = ''; return; }
      const won = (v) => '₩' + fmt(Math.round(v || 0));
      host.innerHTML = card('최근 요청 / 영수증',
        '<div class="card-body"><table><thead><tr><th>시각</th><th>모델</th><th>상태</th><th>토큰</th><th>비용</th><th>캐시</th><th></th></tr></thead><tbody>' +
        reqs.map(q => '<tr>' +
          '<td class="muted">' + ago(q.created_at) + '</td>' +
          '<td>' + escapeHTML(q.model || '') + '</td>' +
          '<td>' + (q.status_code >= 200 && q.status_code < 300 ? '<span class="status">' + q.status_code + '</span>' : '<span class="status error">' + q.status_code + '</span>') + '</td>' +
          '<td>' + fmt(q.total_tokens || 0) + '</td>' +
          '<td>' + won(q.cost_krw) + '</td>' +
          '<td>' + (q.cached ? '✓' : '-') + '</td>' +
          '<td><button type="button" class="secondary" style="font-size:11px" onclick="meShowReceipt(\'' + escapeAttr(q.id) + '\')">영수증 보기</button></td>' +
        '</tr>').join('') + '</tbody></table></div>');
    };
    window.meShowReceipt = async (id) => {
      openModal('요청 영수증', '<div class="empty">불러오는 중...</div>');
      let r;
      try { r = await api('/me/requests/' + encodeURIComponent(id) + '/receipt'); }
      catch (e) { openModal('요청 영수증', '<div class="error-line">' + escapeHTML(e.message) + '</div>'); return; }
      const won = (v) => '₩' + fmt(Math.round(v || 0));
      const t = r.tokens || {};
      const rt = r.routing;
      const rows = [
        ['요청 ID', escapeHTML(r.request_id || '')],
        ['시각', escapeHTML(r.created_at || '')],
        ['엔드포인트', escapeHTML(r.endpoint || '')],
        ['모델', escapeHTML(r.model || '') + (r.provider ? ' <span class="muted">(' + escapeHTML(r.provider) + ')</span>' : '')],
        ['상태', (r.status_code >= 200 && r.status_code < 300 ? '<span class="status">' + r.status_code + '</span>' : '<span class="status error">' + r.status_code + '</span>') + (r.blocked ? ' <span class="status error">정책 차단</span>' : '')],
        ['종료 사유', escapeHTML(r.finish_reason || '-')],
        ['지연', fmt(r.latency_ms || 0) + 'ms'],
        ['토큰', '입력 ' + fmt(t.prompt || 0) + ' · 출력 ' + fmt(t.completion || 0) + ' · 합계 ' + fmt(t.total || 0) + (t.cached ? ' · 캐시 ' + fmt(t.cached) : '')],
        ['캐시 적중', r.cache_hit ? '예' : '아니오'],
        ['비용', won(r.cost_krw)],
      ];
      if (rt) {
        rows.push(['라우팅', '요청 ' + escapeHTML(rt.requested_model || '-') + ' → 선택 ' + escapeHTML(rt.selected_model || '-') + (rt.selected_provider ? ' @ ' + escapeHTML(rt.selected_provider) : '')]);
        if (rt.reason) rows.push(['라우팅 이유', escapeHTML(rt.reason)]);
        if (rt.risk_tier || rt.complexity_tier) rows.push(['위험/복잡도', escapeHTML(rt.risk_tier || '-') + ' / ' + escapeHTML(rt.complexity_tier || '-')]);
        if ((rt.fallback_path || []).length) rows.push(['폴백 경로', escapeHTML(rt.fallback_path.join(' → '))]);
      }
      rows.push(['Skill 사용', r.skill_used ? escapeHTML((r.skills || []).join(', ')) : '아니오']);
      rows.push(['MCP 사용', r.mcp_used ? (r.mcp_tools || []).map(m => escapeHTML((m.server ? m.server + '/' : '') + m.tool) + (m.error ? ' <span class="status error">오류</span>' : '')).join(', ') : '아니오']);
      const policy = r.policy || [];
      let html = '<div class="kv">' + rows.map(kv => row(kv[0], kv[1])).join('') + '</div>';
      if (policy.length) {
        html += '<div style="margin-top:8px"><strong style="font-size:12px">정책 결과</strong>' +
          policy.map(p => '<div style="font-size:12px;margin:2px 0"><span class="status warn">' + escapeHTML(p.decision) + '</span> ' + escapeHTML(p.rule || '') + ' — ' + escapeHTML(p.reason || '') + '</div>').join('') + '</div>';
      }
      html += '<p class="muted" style="font-size:11px;margin-top:8px">' + escapeHTML(r.note || '') + '</p>';
      openModal('요청 영수증', html);
    };
    window.meLoadSkills = async () => {
      const host = document.getElementById('me-skills');
      if (!host) return;
      let d;
      try { d = await api('/me/skills'); } catch (e) { host.innerHTML = ''; return; }
      const avail = d.available || [], req = d.requestable || [];
      if (!avail.length && !req.length) { host.innerHTML = ''; return; }
      const stars = (v) => v > 0 ? '★' + v.toFixed(1) : '평가 없음';
      const availRows = avail.map(sk =>
        '<div style="border:1px solid var(--border);border-radius:6px;padding:8px;margin:4px 0">' +
        '<div style="display:flex;justify-content:space-between;align-items:center"><strong>' + escapeHTML(sk.name) + '</strong>' +
        '<span class="muted" style="font-size:11px">' + stars(sk.satisfaction) + ' · 30일 ' + fmt(sk.runs_30d) + '회 · 성공 ' + (sk.success_rate||0).toFixed(0) + '%</span></div>' +
        (sk.description ? '<div class="muted" style="font-size:11px;margin:2px 0">' + escapeHTML(sk.description) + '</div>' : '') +
        '<div style="margin-top:4px"><select id="skfb-' + escapeAttr(sk.name) + '" style="font-size:11px"><option value="">평가</option>' + [5,4,3,2,1].map(n => '<option value="' + n + '">' + n + '점</option>').join('') + '</select> ' +
        '<button type="button" class="secondary" style="font-size:11px" onclick="meSkillFeedback(\'' + escapeAttr(sk.name) + '\')">피드백</button></div>' +
        '</div>').join('') || '<span class="muted" style="font-size:12px">사용 가능한 Skill이 없습니다.</span>';
      const reqRows = req.length ? req.map(sk =>
        '<div style="font-size:12px;margin:3px 0">' + escapeHTML(sk.name) + ' <span class="muted">' + stars(sk.satisfaction) + '</span> ' +
        '<button type="button" class="secondary" style="font-size:10px" onclick="meSkillRequest(\'' + escapeAttr(sk.name) + '\')">접근 요청</button></div>').join('') : '';
      host.innerHTML = card('내가 사용 가능한 Skill (' + avail.length + ')',
        '<div class="card-body">' + availRows +
        (reqRows ? '<div style="margin-top:8px;border-top:1px solid var(--border);padding-top:6px"><strong style="font-size:11px">요청 가능한 Skill (다른 팀 전용)</strong>' + reqRows + '</div>' : '') +
        '</div>');
    };
    window.meSkillFeedback = async (name) => {
      const sel = document.getElementById('skfb-' + name);
      const rating = parseInt((sel && sel.value) || '0', 10);
      if (!rating) { alert('평가 점수를 선택하세요.'); return; }
      const comment = prompt('코멘트(선택):', '') || '';
      try { await api('/me/skills/' + encodeURIComponent(name) + '/feedback', { method: 'POST', body: JSON.stringify({ rating, comment }) }); alert('피드백 감사합니다.'); await meLoadSkills(); }
      catch (e) { alert(e.message); }
    };
    window.meSkillRequest = async (name) => {
      const reason = prompt(name + ' Skill 접근을 요청합니다. 사유(선택):', '') || '';
      try { await api('/me/skills/' + encodeURIComponent(name) + '/request-access', { method: 'POST', body: JSON.stringify({ reason }) }); alert('접근 요청이 접수되었습니다.'); }
      catch (e) { alert(e.message); }
    };

    // 로그인 세션 관리: 활성 세션 목록(현재 세션 표시) + 개별/타 세션 종료.
    window.meLoadSessions = async () => {
      const host = document.getElementById('me-sessions');
      if (!host) return;
      let r;
      try { r = await api('/me/sessions'); }
      catch (e) { host.innerHTML = ''; return; }
      const sessions = (r && r.sessions) || [];
      const deviceOf = (ua) => {
        ua = ua || '';
        let os = 'Unknown', br = '';
        if (/Windows/.test(ua)) os = 'Windows'; else if (/Mac OS X|Macintosh/.test(ua)) os = 'macOS';
        else if (/Android/.test(ua)) os = 'Android'; else if (/iPhone|iPad|iOS/.test(ua)) os = 'iOS'; else if (/Linux/.test(ua)) os = 'Linux';
        if (/Edg\//.test(ua)) br = 'Edge'; else if (/Chrome\//.test(ua)) br = 'Chrome'; else if (/Firefox\//.test(ua)) br = 'Firefox'; else if (/Safari\//.test(ua)) br = 'Safari'; else if (/curl|Go-http|python/i.test(ua)) br = 'API';
        return (os + (br ? ' · ' + br : '')) || 'Unknown';
      };
      const rows = sessions.map(sx =>
        '<tr>' +
        '<td>' + escapeHTML(deviceOf(sx.user_agent)) + (sx.current ? ' <span class="status" style="font-size:10px">현재 세션</span>' : '') + (sx.sso_linked ? ' <span class="status warn" style="font-size:10px">SSO</span>' : '') + '</td>' +
        '<td class="muted">' + escapeHTML(sx.ip || '-') + '</td>' +
        '<td class="muted">' + ago(sx.created_at) + '</td>' +
        '<td>' + (sx.current ? '<span class="muted">-</span>' : '<button type="button" class="secondary" style="font-size:11px" onclick="meRevokeSession(\'' + escapeAttr(sx.id) + '\')">종료</button>') + '</td>' +
        '</tr>').join('');
      const others = sessions.filter(sx => !sx.current).length;
      host.innerHTML = card('로그인 세션 (' + sessions.length + ')',
        '<div class="card-body">' +
        (sessions.length
          ? '<table><thead><tr><th>기기</th><th>IP</th><th>로그인</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>'
          : '<p class="muted">활성 세션이 없습니다.</p>') +
        (others > 0 ? '<div style="margin-top:8px"><button type="button" onclick="meRevokeOtherSessions()">다른 모든 세션 로그아웃 (' + others + ')</button></div>' : '') +
        '<div id="me-sessions-out" style="margin-top:6px"></div>' +
        '</div>');
    };
    window.meRevokeSession = async (id) => {
      if (!confirm('이 세션을 종료할까요? 해당 기기는 다시 로그인해야 합니다.')) return;
      const out = document.getElementById('me-sessions-out');
      try { await api('/me/sessions/' + encodeURIComponent(id), { method: 'DELETE' }); if (out) out.innerHTML = '<span class="status">세션을 종료했습니다.</span>'; await meLoadSessions(); }
      catch (e) { if (out) out.innerHTML = '<span class="status error">' + escapeHTML(e.message) + '</span>'; }
    };
    window.meRevokeOtherSessions = async () => {
      if (!confirm('현재 세션을 제외한 모든 세션을 로그아웃할까요?')) return;
      const out = document.getElementById('me-sessions-out');
      try { const r = await api('/me/sessions/revoke-others', { method: 'POST', body: '{}' }); if (out) out.innerHTML = '<span class="status">' + (r.revoked_count || 0) + '개 세션을 로그아웃했습니다.</span>'; await meLoadSessions(); }
      catch (e) { if (out) out.innerHTML = '<span class="status error">' + escapeHTML(e.message) + '</span>'; }
    };

    window.meLoadReport = async (win) => {
      const host = document.getElementById('me-report');
      if (!host) return;
      try {
        const rp = await api('/me/report?window=' + encodeURIComponent(win));
        const won = (v) => '₩' + fmt(Math.round(v || 0));
        host.innerHTML = card((win === 'monthly' ? '월간' : '주간') + ' 사용 리포트',
          '<div class="card-body"><div class="kpis">' +
            kpi('요청', fmt(rp.requests || 0)) +
            kpi('비용', won(rp.cost_krw)) +
            kpi('성공률', ((rp.success_rate||0)*100).toFixed(1)+'%') +
            kpi('예상 절감', won(rp.potential_savings_krw)) +
          '</div><p style="margin:8px 0;font-size:12px"><a href="#/me" onclick="meLoadReport(\'' + (win==='monthly'?'weekly':'monthly') + '\');return false" class="muted">' + (win==='monthly'?'주간':'월간') + ' 보기</a></p></div>');
      } catch (e) { /* ignore */ }
    };

    window.meSnoozeAction = async (type) => {
      try {
        await api('/me/actions/snooze', { method: 'POST', body: JSON.stringify({ type, days: 7 }) });
        renderMeHome();
      } catch (e) { alert('보류 오류: ' + e.message); }
    };

    // meActionGo handles an action-queue button. "modal:<key>" opens inline guidance; a hash that
    // equals the current route re-renders in place (so the click always gives feedback) — otherwise
    // it navigates.
    window.meActionGo = (href) => {
      href = href || '#/me';
      if (href.indexOf('modal:') === 0) { meActionModal(href.slice(6)); return; }
      if (href.indexOf('scroll:') === 0) { meScrollToSection(href.slice(7)); return; }
      if (location.hash === href || (href === '#/me' && (location.hash === '' || location.hash === '#/me'))) {
        renderMeHome();
      } else {
        location.hash = href;
      }
    };

    // meScrollToSection scrolls to and briefly highlights a section on the My Home page (loading
    // on-demand content first where applicable), so "view"-type action buttons land on real content.
    window.meScrollToSection = (id) => {
      if (id === 'me-recs' && typeof meLoadRecommendations === 'function') { try { meLoadRecommendations(); } catch (e) {} }
      const el = document.getElementById(id);
      if (!el) { renderMeHome(); return; }
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      const prev = el.style.boxShadow;
      el.style.transition = 'box-shadow .4s';
      el.style.boxShadow = '0 0 0 2px var(--accent)';
      setTimeout(() => { el.style.boxShadow = prev; }, 1400);
    };

    // meActionModal shows inline guidance for actions that have no dedicated page.
    window.meActionModal = (key) => {
      if (key === 'safety') {
        openModal('안전 가이드 — 민감정보 다루기',
          '<div style="font-size:13px;line-height:1.7">' +
          '<p>최근 요청에서 민감정보 포함 가능성이 감지되었습니다. 아래 수칙을 지켜 주세요.</p>' +
          '<ul style="margin:8px 0 8px 18px">' +
          '<li>실제 <strong>비밀번호·API 키·토큰·주민번호·카드번호</strong> 등은 프롬프트에 넣지 마세요.</li>' +
          '<li>고객/직원 <strong>개인정보(PII)</strong>는 가명·예시값으로 대체하세요.</li>' +
          '<li>운영 DB 자격증명이나 내부 시크릿을 붙여넣지 마세요. 게이트웨이가 시크릿을 탐지·마스킹하지만, 입력하지 않는 것이 가장 안전합니다.</li>' +
          '<li>꼭 필요한 최소한의 맥락만 제공하고, 외부로 나가면 안 되는 자료는 사내 승인 경로를 따르세요.</li>' +
          '</ul>' +
          '<p class="muted" style="font-size:12px">이 게이트웨이는 Secret Firewall로 민감 패턴을 탐지/마스킹/차단하며, 위반 요청은 감사 로그에 기록됩니다.</p>' +
          '<div style="margin-top:12px"><button type="button" class="secondary" onclick="closeModal()">확인</button></div></div>');
        return;
      }
      if (key === 'model_switch') {
        openModal('전환 가이드 — 더 저렴한 모델로',
          '<div style="font-size:13px;line-height:1.7">' +
          '<p>최근 작업은 더 저렴한 모델로도 충분히 처리될 가능성이 높습니다. 아래 방법으로 전환해 비용을 줄일 수 있습니다.</p>' +
          '<ul style="margin:8px 0 8px 18px">' +
          '<li><strong>자동 라우팅 사용</strong>: 모델명을 <code>vibe/auto</code>로 지정하면 게이트웨이가 작업 난이도에 맞춰 비용·품질 균형 모델을 선택합니다.</li>' +
          '<li><strong>직접 지정</strong>: 간단한 작업은 더 작은 모델(예: mini/lite 계열)로 <code>model</code> 값을 바꿔 호출하세요.</li>' +
          '<li><strong>근거 확인</strong>: 주간 사용 리포트의 "절감 추천"에서 어떤 모델로 얼마나 절감되는지 확인할 수 있습니다.</li>' +
          '<li>품질이 충분한지 비교한 뒤, 반복 작업이라면 해당 모델을 기본값으로 고정하세요.</li>' +
          '</ul>' +
          '<p class="muted" style="font-size:12px">전환 후에도 품질이 유지되는지 응답을 확인하세요. 복잡한 작업은 기존 모델을 유지하는 것이 안전합니다.</p>' +
          '<div style="margin-top:12px"><button type="button" class="secondary" onclick="closeModal()">확인</button></div></div>');
        return;
      }
      if (key === 'repeat_question') {
        openModal('리포트 만들기 — 반복 질문을 저장 리포트로',
          '<div style="font-size:13px;line-height:1.7">' +
          '<p>같은 질문을 반복하고 있다면 저장 리포트로 만들어 한 번에 실행·공유할 수 있습니다.</p>' +
          '<ol style="margin:8px 0 8px 18px">' +
          '<li>Text2SQL(자연어 질문)으로 원하는 결과를 한 번 생성합니다.</li>' +
          '<li>결과 화면에서 <strong>"리포트로 저장"</strong>을 선택해 이름·공개 범위(개인/팀)를 지정합니다.</li>' +
          '<li>저장한 리포트는 아래 <strong>"내 저장 리포트"</strong>에서 다시 실행하거나 팀과 공유할 수 있습니다.</li>' +
          '</ol>' +
          '<p class="muted" style="font-size:12px">팀 공개 리포트는 승인 절차를 거칠 수 있습니다. 민감 데이터는 마스킹·권한 정책이 그대로 적용됩니다.</p>' +
          '<div style="margin-top:12px"><button type="button" onclick="closeModal();meScrollToSection(\'me-reports\')">내 저장 리포트 보기</button> ' +
          '<button type="button" class="secondary" onclick="closeModal()">확인</button></div></div>');
        return;
      }
      if (key === 'cache_improve') {
        openModal('템플릿 만들기 — 유사 질문 재사용',
          '<div style="font-size:13px;line-height:1.7">' +
          '<p>비슷한 질문을 자주 한다면 템플릿/저장 리포트로 재사용해 응답 속도와 일관성을 높일 수 있습니다.</p>' +
          '<ul style="margin:8px 0 8px 18px">' +
          '<li>자주 쓰는 프롬프트를 <strong>프롬프트 템플릿</strong>으로 저장해 매번 새로 작성하지 않도록 합니다.</li>' +
          '<li>표현이 조금씩 다른 질문은 핵심 문구를 통일하면 <strong>시맨틱 캐시</strong> 적중률이 올라가 더 빠르고 저렴하게 응답됩니다.</li>' +
          '<li>반복 데이터 질의는 저장 리포트로 만들어 재실행하세요.</li>' +
          '</ul>' +
          '<div style="margin-top:12px"><button type="button" class="secondary" onclick="closeModal()">확인</button></div></div>');
        return;
      }
      renderMeHome();
    };

    window.meLoadRecommendations = async () => {
      const host = document.getElementById('me-recs');
      if (!host) return;
      host.innerHTML = '<span class="muted">불러오는 중...</span>';
      try {
        const d = await api('/me/recommendations');
        const recs = d.recommendations || [];
        if (!recs.length) { host.innerHTML = '<p class="muted">현재 추천이 없습니다.</p>'; return; }
        host.innerHTML = recs.map(r =>
          '<div style="border:1px solid var(--border);border-radius:6px;padding:10px;margin-bottom:8px">' +
          '<div><strong>' + escapeHTML(r.title) + '</strong> <span class="status">' + escapeHTML(r.kind) + '</span>' +
          (r.est_savings_krw ? ' <span class="muted">~₩' + fmt(Math.round(r.est_savings_krw)) + ' 절감</span>' : '') + '</div>' +
          (r.detail ? '<p class="muted" style="margin:4px 0;font-size:12px">' + escapeHTML(r.detail) + '</p>' : '') +
          '<div style="display:flex;gap:6px;margin-top:4px">' +
            '<button type="button" style="font-size:11px" onclick="meRecFeedback(\'' + escapeAttr(r.id) + '\',\'accepted\')">수락</button>' +
            '<button type="button" class="secondary" style="font-size:11px" onclick="meRecFeedback(\'' + escapeAttr(r.id) + '\',\'later\')">나중에</button>' +
            '<button type="button" class="danger" style="font-size:11px" onclick="meRecFeedback(\'' + escapeAttr(r.id) + '\',\'rejected\')">거절</button>' +
          '</div></div>'
        ).join('');
      } catch (e) { host.innerHTML = '<span class="status error">' + escapeHTML(e.message) + '</span>'; }
    };

    window.meRecFeedback = async (id, action) => {
      try {
        await api('/me/recommendations/' + encodeURIComponent(id) + '/feedback', { method: 'POST', body: JSON.stringify({ action }) });
        meLoadRecommendations();
      } catch (e) { alert('피드백 오류: ' + e.message); }
    };

    async function renderMyKeys() {
      const view = document.getElementById('view');
      let data;
      try {
        data = await api('/me/keys');
      } catch (err) {
        const msg = String(err.message || '');
        if (msg.indexOf('disabled') >= 0) {
          view.innerHTML = card('내 키', '<div class="card-body"><p class="muted">셀프서비스 키 관리가 비활성화되어 있습니다. 관리자가 <code>SELF_SERVICE_KEYS_ENABLED=true</code>로 활성화해야 합니다.</p></div>');
        } else {
          view.innerHTML = card('내 키', '<div class="card-body"><p class="muted">현재 로그인 주체를 사용자로 식별할 수 없습니다(JWT 로그인 또는 user_id가 매핑된 API Key 필요). 상세: ' + escapeHTML(msg) + '</p></div>');
        }
        return;
      }
      const keys = data.api_keys || [];
      const secretBanner = window.mykeysSecret
        ? '<div class="status" style="padding:10px; margin-bottom:12px">새 키 시크릿 (한 번만 표시됩니다. 안전하게 보관하세요):<br><code style="user-select:all">' + escapeHTML(window.mykeysSecret) + '</code> <button class="secondary" type="button" onclick="window.mykeysSecret=null; renderMyKeys()">숨기기</button></div>'
        : '';
      // Grantable scopes (caller's role scopes) shared with the scope modal; new-key selection
      // starts empty (= inherit all caller scopes).
      window.mkGrantable = data.grantable_scopes || [];
      window.mkNewScopes = window.mkNewScopes || [];
      const newScopeLabel = window.mkNewScopes.length ? ('스코프 ' + window.mkNewScopes.length + '개 선택됨') : '스코프: 전체 상속';
      const pickerBtn = window.mkGrantable.length
        ? '<button type="button" class="secondary" onclick="openMyKeyScopeModal()">' + newScopeLabel + '</button>'
        : '';
      const form = '<div style="margin:8px 0 8px; display:flex; gap:8px; flex-wrap:wrap; align-items:center">' +
        '<input id="mk-name" placeholder="키 이름 (예: my-cli)" style="min-width:180px">' +
        '<input id="mk-expires" placeholder="만료 (RFC3339, 선택)" style="min-width:180px">' +
        pickerBtn +
        '<button type="button" onclick="createMyKey()">키 발급</button>' +
        '</div>' +
        '<div class="muted" style="font-size:12px; margin-bottom:8px">내 역할: <code>' + escapeHTML(data.role || '-') + '</code> · 발급 키는 본인 권한(역할) 범위 내에서만 생성됩니다(권한 상승 불가). 스코프를 비우면 내 권한을 전체 상속합니다.</div>';
      const tableRows = keys.map(k => {
        const expired = k.revoked_at || k.status !== 'active';
        const scopes = k.scopes || [];
        const scopeText = scopes.length ? escapeHTML(scopes.join(', ')) : '<span class="muted">전체(미지정)</span>';
        const canEdit = window.mkGrantable.length && !expired;
        return '<tr>' +
          '<td>' + escapeHTML(k.name) + '<div class="muted">' + escapeHTML(k.id) + '</div></td>' +
          '<td>' + escapeHTML(k.role || '') + '</td>' +
          '<td class="muted" style="max-width:260px">' + scopeText + '</td>' +
          '<td><span class="status ' + (expired ? 'error' : '') + '">' + escapeHTML(k.status) + '</span></td>' +
          '<td>' + escapeHTML(k.expires_at || '-') + '</td>' +
          '<td style="white-space:nowrap">' +
            (canEdit ? '<button class="ghost" type="button" onclick="editMyKeyScopes(\'' + k.id + '\')">스코프</button> ' : '') +
            '<button class="secondary" type="button" onclick="rotateMyKey(\'' + k.id + '\')">회전</button> ' +
            '<button class="danger" type="button" onclick="revokeMyKey(\'' + k.id + '\')">폐기</button>' +
          '</td></tr>';
      }).join('');
      const table = keys.length
        ? '<table><thead><tr><th>이름</th><th>역할</th><th>스코프</th><th>상태</th><th>만료</th><th>동작</th></tr></thead><tbody>' + tableRows + '</tbody></table>'
        : '<p class="muted">발급된 키가 없습니다.</p>';
      // Cache key scopes for the edit modal.
      window.myKeysCache = {};
      keys.forEach(k => { window.myKeysCache[k.id] = k; });
      view.innerHTML = card('내 키', '<div class="card-body">' + secretBanner + form + table + '</div>');
    }

    // mkScopeBoxes renders the grantable-scope checkboxes for the My Keys scope modal.
    function mkScopeBoxes(selected) {
      const sel = selected || [];
      return (window.mkGrantable || []).map(sc =>
        '<label style="display:flex; align-items:center; gap:8px; padding:4px 0; font-size:13px">' +
          '<input type="checkbox" class="mk-scope-box" value="' + escapeAttr(sc) + '"' + (sel.indexOf(sc) >= 0 ? ' checked' : '') + ' style="width:auto; height:auto; min-width:0">' +
          '<span>' + escapeHTML(mkScopeLabel(sc)) + '</span> <code style="font-size:11px">' + escapeHTML(sc) + '</code>' +
        '</label>').join('');
    }

    // openMyKeyScopeModal picks scopes for a NEW key (stored until 발급).
    window.openMyKeyScopeModal = () => {
      openModal('새 키 스코프 선택',
        '<div class="muted" style="margin-bottom:10px">발급할 키에 부여할 스코프를 선택합니다. <strong>전부 해제하면 내 권한 전체 상속</strong>. 역할 범위를 벗어난 스코프는 발급할 수 없습니다.</div>' +
        '<div style="columns:2; gap:24px">' + mkScopeBoxes(window.mkNewScopes) + '</div>' +
        '<div style="margin-top:14px; display:flex; gap:8px">' +
          '<button type="button" onclick="saveMyNewScopes()">확인</button>' +
          '<button type="button" class="secondary" onclick="closeModal()">취소</button>' +
        '</div>');
    };
    window.saveMyNewScopes = () => {
      window.mkNewScopes = Array.from(document.querySelectorAll('#modal-body .mk-scope-box:checked')).map(b => b.value);
      closeModal();
      renderMyKeys();
    };

    // editMyKeyScopes edits scopes of an EXISTING key (PATCH /me/keys/{id}).
    window.editMyKeyScopes = (id) => {
      const key = (window.myKeysCache || {})[id];
      if (!key) return;
      openModal('스코프 편집 — ' + escapeHTML(key.name),
        '<div class="muted" style="margin-bottom:10px">이 키로 호출할 수 있는 API 범위를 제한합니다. <strong>전부 해제하면 전체(미지정)</strong> 가 되어 내 권한 전체를 사용합니다. 역할 범위 밖 스코프는 거부됩니다(403).</div>' +
        '<div style="columns:2; gap:24px">' + mkScopeBoxes(key.scopes || []) + '</div>' +
        '<div style="margin-top:14px; display:flex; gap:8px">' +
          '<button type="button" onclick="saveMyKeyScopes(\'' + escapeAttr(id) + '\')">저장</button>' +
          '<button type="button" class="secondary" onclick="closeModal()">취소</button>' +
        '</div>');
    };
    window.saveMyKeyScopes = async (id) => {
      const scopes = Array.from(document.querySelectorAll('#modal-body .mk-scope-box:checked')).map(b => b.value);
      try {
        await api('/me/keys/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify({ scopes }) });
        closeModal();
        await renderMyKeys();
      } catch (err) { alert('스코프 저장 실패: ' + err.message); }
    };

    // mkScopeLabel maps an API-key scope to a short Korean label for the My Keys picker.
    function mkScopeLabel(scope) {
      return {
        'chat:completion': '채팅 완성', 'embeddings:create': '임베딩', 'models:read': '모델 조회',
        'admin:read': '관리 조회', 'admin:write': '관리 변경', 'routing:read': '라우팅 조회',
        'routing:write': '라우팅 변경', 'observability:read': '관측 조회', 'costs:read': '비용 조회',
        'security:read': '보안 조회', 'mcp:use': 'MCP 사용', 'mcp:admin': 'MCP 관리', 'team:read': '팀 조회',
      }[scope] || scope;
    }

    async function createMyKey() {
      const name = (document.getElementById('mk-name').value || '').trim();
      if (!name) { alert('키 이름을 입력하세요.'); return; }
      const scopes = window.mkNewScopes || [];
      const expires = (document.getElementById('mk-expires').value || '').trim();
      const body = { name };
      if (scopes.length) body.scopes = scopes;
      if (expires) body.expires_at = expires;
      try {
        const res = await api('/me/keys', { method: 'POST', body: JSON.stringify(body) });
        window.mykeysSecret = res.secret || null;
        window.mkNewScopes = [];
        await renderMyKeys();
      } catch (err) { alert('발급 실패: ' + err.message); }
    }

    async function rotateMyKey(id) {
      if (!confirm('이 키를 회전하시겠습니까? 기존 키는 즉시 폐기됩니다.')) return;
      try {
        const res = await api('/me/keys/' + encodeURIComponent(id) + '/rotate', { method: 'POST', body: '{}' });
        window.mykeysSecret = res.secret || null;
        await renderMyKeys();
      } catch (err) { alert('회전 실패: ' + err.message); }
    }

    async function revokeMyKey(id) {
      if (!confirm('이 키를 폐기하시겠습니까?')) return;
      try {
        await api('/me/keys/' + encodeURIComponent(id), { method: 'DELETE' });
        await renderMyKeys();
      } catch (err) { alert('폐기 실패: ' + err.message); }
    }

    // ---------- ClickHouse DW (setup + monitoring) ----------
    function chBadge(ok, okText, badText) {
      return '<span class="status ' + (ok ? '' : 'error') + '">' + escapeHTML(ok ? okText : badText) + '</span>';
    }
    async function renderModelDeprecations() {
      const view = document.getElementById('view');
      const d = await api('/admin/model-deprecations').catch(e => ({ deprecations: [], _err: e.message }));
      const items = d.deprecations || [];
      const today = new Date().toISOString().slice(0, 10);
      const phase = (dep) => {
        if (!dep.sunset_date) return '<span class="status warn">경고만</span>';
        if (dep.sunset_date <= today) return dep.replacement ? '<span class="status">자동 재작성</span>' : '<span class="status error">차단</span>';
        return '<span class="status warn">' + escapeHTML(dep.sunset_date) + ' 일몰 예정</span>';
      };
      let html = '<div class="card-body"><p class="muted">구형 모델을 단계적으로 은퇴시킵니다. 요청 모델이 <code>model_glob</code>에 매칭되면 일몰일 전에는 응답 헤더로 경고만 하고, 일몰일(UTC) 도달 후에는 대체 모델로 자동 재작성하거나(없으면) 400으로 차단합니다.</p>' +
        '<form class="inline-form" id="dep-form" style="grid-template-columns: minmax(120px,1fr) minmax(120px,1fr) 130px minmax(140px,1fr) 80px;">' +
          '<input id="dep-glob" placeholder="model_glob (예: gpt-4-0314, old-*)">' +
          '<input id="dep-replacement" placeholder="대체 모델 (선택)">' +
          '<input id="dep-sunset" type="date" placeholder="일몰일">' +
          '<input id="dep-message" placeholder="안내 메시지 (선택)">' +
          '<button type="submit">추가</button>' +
        '</form>' +
        '<span id="dep-result" class="muted"></span></div>';

      html += '<section><h2>폐기 정책 ' + (items.length ? '(' + items.length + ')' : '') + '</h2><div class="card-body">' +
        (items.length ? '<table><thead><tr><th>model_glob</th><th>대체 모델</th><th>일몰일</th><th>현재 단계</th><th>메시지</th><th></th></tr></thead><tbody>' +
          items.map(dep => '<tr><td><code>' + escapeHTML(dep.model_glob) + '</code></td>' +
            '<td>' + (dep.replacement ? escapeHTML(dep.replacement) : '<span class="muted">없음(차단)</span>') + '</td>' +
            '<td>' + (dep.sunset_date ? escapeHTML(dep.sunset_date) : '<span class="muted">-</span>') + '</td>' +
            '<td>' + phase(dep) + '</td>' +
            '<td class="muted">' + escapeHTML(dep.message || '') + '</td>' +
            '<td><button class="danger" type="button" onclick="deleteModelDeprecation(\'' + escapeAttr(dep.id) + '\')">삭제</button></td></tr>').join('') + '</tbody></table>'
          : '<div class="empty">등록된 폐기 정책이 없습니다.' + (d._err ? '<div class="muted">' + escapeHTML(d._err) + '</div>' : '') + '</div>') +
        '</div></section>';
      view.innerHTML = card('모델 일몰 정책', html);
      const form = document.getElementById('dep-form');
      if (form) form.addEventListener('submit', saveModelDeprecation);
    }
    async function saveModelDeprecation(event) {
      event.preventDefault();
      const out = document.getElementById('dep-result');
      const body = {
        model_glob: document.getElementById('dep-glob').value.trim(),
        replacement: document.getElementById('dep-replacement').value.trim(),
        sunset_date: document.getElementById('dep-sunset').value.trim(),
        message: document.getElementById('dep-message').value.trim(),
      };
      if (!body.model_glob) { if (out) out.innerHTML = '<span class="status error">model_glob 필수</span>'; return; }
      try {
        await api('/admin/model-deprecations', { method: 'POST', body: JSON.stringify(body) });
        await renderModelDeprecations();
      } catch (e) {
        if (out) out.innerHTML = '<span class="status error">' + escapeHTML(e.message) + '</span>';
      }
    }
    window.deleteModelDeprecation = async (id) => {
      if (!confirm('해당 폐기 정책을 삭제할까요?')) return;
      await api('/admin/model-deprecations/' + encodeURIComponent(id), { method: 'DELETE' });
      await renderModelDeprecations();
    };
    // ── SSO (Keycloak) 설정/진단 ──────────────────────────────────────────
    async function renderSSOSettings() {
      const view = document.getElementById('view');
      view.innerHTML = section('SSO (Keycloak)', '<div class="empty">불러오는 중...</div>');
      let c;
      try { c = await api('/admin/sso/keycloak/config'); }
      catch (e) { view.innerHTML = section('SSO (Keycloak)', '<div class="card-body" style="padding:16px"><p class="muted">설정을 불러올 수 없습니다: ' + escapeHTML(e.message) + '</p></div>'); return; }
      const yn = (b) => b ? '<span class="status">사용</span>' : '<span class="status warn">미사용</span>';
      window.__ssoCfg = c;
      const sourceBadge = c.source === 'db'
        ? '<span class="status">DB 설정 (secret 암호화 저장)</span>'
        : '<span class="status warn">환경변수(SSO_KEYCLOAK_*)</span>';
      const updated = c.source === 'db' && c.updated_at
        ? '<p class="muted" style="font-size:11px;margin-top:4px">최종 수정: ' + escapeHTML(ago(c.updated_at)) + (c.updated_by ? ' · ' + escapeHTML(c.updated_by) : '') + '</p>'
        : '';
      const ti = (id, label, val, ph) => '<label style="display:block;margin:6px 0">' + escapeHTML(label) +
        '<input type="text" id="' + id + '" value="' + escapeAttr(val || '') + '"' + (ph ? ' placeholder="' + escapeAttr(ph) + '"' : '') + ' style="width:100%;box-sizing:border-box"></label>';
      const cfgCard = card('Keycloak 설정',
        '<div class="card-body">' +
        '<div style="margin-bottom:8px">현재 적용: ' + sourceBadge + ' · SSO ' + yn(c.enabled) + '</div>' + updated +
        '<label style="display:block;margin:6px 0"><input type="checkbox" id="sso-enabled"' + (c.enabled ? ' checked' : '') + '> SSO 활성화</label>' +
        ti('sso-issuer', 'Issuer URL', c.issuer_url, 'https://keycloak.example.com/realms/vibe') +
        ti('sso-client-id', 'Client ID', c.client_id) +
        '<label style="display:block;margin:6px 0">Client Secret ' +
          (c.client_secret_set ? '<span class="status" style="font-size:10px">설정됨</span>' : '<span class="status error" style="font-size:10px">없음</span>') +
          '<input type="password" id="sso-client-secret" value="" placeholder="변경 시에만 입력 (비우면 기존 값 유지)" style="width:100%;box-sizing:border-box"></label>' +
        '<label style="display:block;margin:2px 0 8px"><input type="checkbox" id="sso-secret-clear"> Client Secret 비우기(public client)</label>' +
        ti('sso-redirect', 'Redirect URI', c.redirect_uri, 'https://gateway.example.com/auth/keycloak/callback') +
        ti('sso-scopes', 'Scopes (공백 구분)', (c.scopes || []).join(' '), 'openid profile email') +
        ti('sso-default-role', '기본 Role (비우면 매핑 실패 시 로그인 차단)', c.default_role, 'developer') +
        ti('sso-role-claim', 'Role Claim', c.role_claim, 'realm_access.roles') +
        ti('sso-group-claim', 'Group Claim', c.group_claim, 'groups') +
        '<label style="display:block;margin:6px 0"><input type="checkbox" id="sso-allow-local"' + (c.allow_local_login ? ' checked' : '') + '> 로컬 로그인 허용 (fallback)</label>' +
        '<p class="muted" style="font-size:11px;margin-top:8px">' + escapeHTML(c.note || '') + '</p>' +
        '<div style="margin-top:10px"><button type="button" id="sso-save-btn">저장 (DB)</button> ' +
          '<button type="button" id="sso-test-btn">연결 테스트</button></div>' +
        '<div id="sso-save-out" style="margin-top:8px"></div>' +
        '<div id="sso-test-out" style="margin-top:8px"></div>' +
        '</div>');
      const rm = c.role_map || {};
      const rmRow = (k, v) => '<tr>' +
        '<td><input type="text" class="sso-rm-k" value="' + escapeAttr(k || '') + '" placeholder="vibe-admin" style="width:100%;box-sizing:border-box"></td>' +
        '<td><input type="text" class="sso-rm-v" value="' + escapeAttr(v || '') + '" placeholder="admin" style="width:100%;box-sizing:border-box"></td>' +
        '<td><button type="button" onclick="this.closest(\'tr\').remove()">삭제</button></td></tr>';
      const customBadge = c.role_map_custom ? '<span class="status">커스텀</span>' : '<span class="status warn">기본값</span>';
      const mapCard = card('Role 매핑 (Keycloak → 내부) ' + customBadge,
        '<div class="card-body"><table id="sso-rm-table"><thead><tr><th>Keycloak Role</th><th>내부 Role</th><th></th></tr></thead><tbody id="sso-rm-body">' +
          Object.keys(rm).map(k => rmRow(k, rm[k])).join('') +
        '</tbody></table>' +
        '<div style="margin-top:6px"><button type="button" id="sso-rm-add">행 추가</button> ' +
          '<button type="button" id="sso-rm-save">매핑 저장</button> ' +
          '<button type="button" id="sso-rm-reset">기본값으로 초기화</button></div>' +
        '<div id="sso-rm-out" style="margin-top:6px"></div>' +
        '<p class="muted" style="font-size:11px;margin-top:6px">/teams/&lt;name&gt; (group) → team:&lt;name&gt; 매핑은 고정. 매핑 실패 시 기본 Role(' + escapeHTML(c.default_role || '') + ')로 폴백, 기본 Role이 비어 있으면 로그인 차단. 가장 높은 권한의 매핑이 우선합니다.</p></div>');
      view.innerHTML = section('SSO (Keycloak)', '') + cfgCard + mapCard;
      const saveBtn = document.getElementById('sso-save-btn');
      if (saveBtn) saveBtn.addEventListener('click', async () => {
        const out = document.getElementById('sso-save-out');
        const v = (id) => (document.getElementById(id).value || '').trim();
        const chk = (id) => document.getElementById(id).checked;
        const body = {
          enabled: chk('sso-enabled'),
          issuer_url: v('sso-issuer'),
          client_id: v('sso-client-id'),
          redirect_uri: v('sso-redirect'),
          scopes: v('sso-scopes') ? v('sso-scopes').split(/\s+/) : [],
          default_role: v('sso-default-role'),
          role_claim: v('sso-role-claim'),
          group_claim: v('sso-group-claim'),
          allow_local_login: chk('sso-allow-local'),
        };
        // Only send client_secret when re-entered or explicitly clearing; otherwise keep existing.
        const sec = v('sso-client-secret');
        if (chk('sso-secret-clear')) body.client_secret = '';
        else if (sec) body.client_secret = sec;
        out.innerHTML = '<span class="muted">저장 중...</span>';
        try {
          await api('/admin/sso/keycloak/config', { method: 'PUT', body: JSON.stringify(body) });
          out.innerHTML = '<span class="status">저장됨 (DB 설정이 환경변수보다 우선 적용)</span>';
          await renderSSOSettings();
        } catch (e) { out.innerHTML = '<span class="status error">' + escapeHTML(e.message) + '</span>'; }
      });
      const rmAdd = document.getElementById('sso-rm-add');
      if (rmAdd) rmAdd.addEventListener('click', () => {
        const body = document.getElementById('sso-rm-body');
        const tr = document.createElement('tr');
        tr.innerHTML = '<td><input type="text" class="sso-rm-k" placeholder="vibe-admin" style="width:100%;box-sizing:border-box"></td>' +
          '<td><input type="text" class="sso-rm-v" placeholder="admin" style="width:100%;box-sizing:border-box"></td>' +
          '<td><button type="button" onclick="this.closest(\'tr\').remove()">삭제</button></td>';
        body.appendChild(tr);
      });
      const collectRoleMap = () => {
        const m = {};
        document.querySelectorAll('#sso-rm-body tr').forEach(tr => {
          const k = (tr.querySelector('.sso-rm-k').value || '').trim();
          const val = (tr.querySelector('.sso-rm-v').value || '').trim();
          if (k && val) m[k] = val;
        });
        return m;
      };
      const saveRoleMap = async (mapObj, msg) => {
        const out = document.getElementById('sso-rm-out');
        out.innerHTML = '<span class="muted">저장 중...</span>';
        try {
          await api('/admin/sso/keycloak/config', { method: 'PUT', body: JSON.stringify({ ...window.__ssoCfg, role_map: mapObj }) });
          out.innerHTML = '<span class="status">' + msg + '</span>';
          await renderSSOSettings();
        } catch (e) { out.innerHTML = '<span class="status error">' + escapeHTML(e.message) + '</span>'; }
      };
      const rmSave = document.getElementById('sso-rm-save');
      if (rmSave) rmSave.addEventListener('click', () => saveRoleMap(collectRoleMap(), '매핑 저장됨'));
      const rmReset = document.getElementById('sso-rm-reset');
      if (rmReset) rmReset.addEventListener('click', () => { if (confirm('Role 매핑을 기본값으로 초기화할까요?')) saveRoleMap({}, '기본값으로 초기화됨'); });
      const btn = document.getElementById('sso-test-btn');
      if (btn) btn.addEventListener('click', async () => {
        const out = document.getElementById('sso-test-out');
        out.innerHTML = '<span class="muted">테스트 중...</span>';
        try {
          const t = await api('/admin/sso/keycloak/test', { method: 'POST', body: '{}' });
          if (t.ok) {
            out.innerHTML = '<div class="status">정상</div><div class="kv" style="margin-top:6px">' +
              row('Issuer', escapeHTML(t.issuer || '')) +
              row('Authorization', escapeHTML(t.authorization_endpoint || '')) +
              row('Token', escapeHTML(t.token_endpoint || '')) +
              row('JWKS', escapeHTML(t.jwks_uri || '')) +
              row('End Session', escapeHTML(t.end_session_endpoint || '') || '<span class="muted">-</span>') +
              row('RSA 서명 키', fmt(t.rsa_signing_keys || 0)) +
            '</div>';
          } else {
            out.innerHTML = '<div class="status error">실패 (' + escapeHTML(t.stage || '') + '): ' + escapeHTML(t.reason || '') + '</div>';
          }
        } catch (e) { out.innerHTML = '<span class="status error">' + escapeHTML(e.message) + '</span>'; }
      });
    }

    // ── Skill Studio: 후보 추천 → 채택 → 평가 → Chat 테스트 → 스테이징 → 프로덕션 마법사 ──
    function studioStatusBadge(st) {
      const cls = st === 'production' ? '' : (st === 'deprecated' ? 'error' : 'warn');
      return '<span class="status ' + cls + '">' + escapeHTML(st || '') + '</span>';
    }
    const studioSourceLabel = { fingerprint: '프롬프트 클러스터', product: '프롬프트 상품', text2sql: 'Text2SQL 반복질문', recommendation: '개인화 추천', skill_gap: '스킬 갭' };

    async function renderSkillStudio() {
      const view = document.getElementById('view');
      view.innerHTML = section('Skill Studio', '<div class="empty">불러오는 중...</div>');
      const [cand, sk] = await Promise.all([
        api('/admin/skill-studio/candidates').catch(e => ({ candidates: [], _err: e.message })),
        api('/admin/skills').catch(() => ({ skills: [] })),
      ]);
      const candidates = cand.candidates || [];
      const skills = sk.skills || [];
      window.__studioSkills = {}; skills.forEach(s => { window.__studioSkills[s.name] = s; });
      window.__studioCands = {}; candidates.forEach(c => { window.__studioCands[c.id] = c; });

      const bySource = cand.by_source || {};
      const kpis = '<div class="kpis">' +
        kpi('후보 총계', fmt(candidates.length)) +
        Object.keys(bySource).map(s => kpi(studioSourceLabel[s] || s, fmt(bySource[s]))).join('') +
      '</div>';

      const candRows = candidates.length ? candidates.map(c =>
        '<tr>' +
        '<td><span class="status">' + escapeHTML(studioSourceLabel[c.source] || c.source) + '</span></td>' +
        '<td><strong>' + escapeHTML(c.title) + '</strong><div class="muted" style="font-size:11px">' + escapeHTML(c.suggested_name) + '</div></td>' +
        '<td class="muted" style="font-size:11px">' + escapeHTML(c.rationale || '') + '</td>' +
        '<td>' + (c.already_skill
            ? '<span class="status">이미 스킬</span> <button class="secondary" type="button" style="font-size:11px" onclick="studioOpenWizard(\'' + escapeAttr(c.suggested_name) + '\')">마법사</button>'
            : '<button type="button" style="font-size:11px" onclick="studioAdopt(\'' + escapeAttr(c.id) + '\')">draft로 채택</button>') +
        '</td>' +
        '</tr>'
      ).join('') : '<tr><td colspan="4"><div class="empty">추천 후보가 없습니다. 사용 데이터가 쌓이면 자동으로 나타납니다.</div></td></tr>';

      const candTable =
        '<table><thead><tr><th>출처</th><th>후보</th><th>근거 신호</th><th>액션</th></tr></thead><tbody>' + candRows + '</tbody></table>';

      // Wizard skill selector: drafts + staging are in-flight; production/deprecated shown for reference.
      const inflight = skills.filter(s => s.status === 'draft' || s.status === 'staging');
      const wizSelect =
        '<div class="toolbar">' +
          '<label>마법사 대상 스킬 <select id="studio-skill-select" onchange="studioOpenWizard(this.value)">' +
            '<option value="">— 선택 —</option>' +
            inflight.map(s => '<option value="' + escapeAttr(s.name) + '">' + escapeHTML(s.name) + ' (' + s.status + ')</option>').join('') +
          '</select></label>' +
          '<span class="muted" style="font-size:12px">draft·staging 스킬을 선택해 평가→테스트→승격을 진행합니다.</span>' +
        '</div>' +
        '<div id="studio-wizard"></div>';

      view.innerHTML =
        section('Skill Studio — 후보 추천', kpis + (cand._err ? '<div class="status error">' + escapeHTML(cand._err) + '</div>' : '') + candTable) +
        section('Skill Studio — 승격 마법사', wizSelect);
    }

    window.studioAdopt = (candID) => {
      const c = (window.__studioCands || {})[candID];
      if (!c) return;
      const sug = c.suggested || {};
      openModal('후보 채택 → draft 스킬',
        '<div class="kv">' +
          row('이름(slug)', '<input id="studio-ad-name" value="' + escapeAttr(c.suggested_name) + '" style="width:100%">') +
          row('설명', '<input id="studio-ad-desc" value="' + escapeAttr(c.description || '') + '" style="width:100%">') +
          row('위험도', '<select id="studio-ad-risk">' + ['low','medium','high'].map(x => '<option value="' + x + '"' + (x === (sug.risk_level||'low') ? ' selected' : '') + '>' + x + '</option>').join('') + '</select>') +
          row('허용 모델', '<input id="studio-ad-models" value="' + escapeAttr(sug.allowed_models || '') + '" placeholder="예: gpt-*, qwen-plus" style="width:100%">') +
          row('허용 도구', '<input id="studio-ad-tools" value="' + escapeAttr(sug.allowed_tools || '') + '" placeholder="예: sql-runner, search" style="width:100%">') +
          row('지침', '<textarea id="studio-ad-instr" style="width:100%;min-height:140px;resize:vertical">' + escapeHTML(sug.instructions || '') + '</textarea>') +
        '</div>' +
        '<div style="margin-top:10px;display:flex;gap:8px"><button type="button" id="studio-ad-btn">채택</button><button type="button" class="secondary" onclick="closeModal()">취소</button></div>' +
        '<div id="studio-ad-result" class="muted" style="margin-top:8px;font-size:12px"></div>'
      );
      document.getElementById('studio-ad-btn').onclick = async () => {
        const out = document.getElementById('studio-ad-result');
        try {
          const r = await api('/admin/skill-studio/adopt', { method: 'POST', body: JSON.stringify({
            name: document.getElementById('studio-ad-name').value.trim(),
            description: document.getElementById('studio-ad-desc').value.trim(),
            risk_level: document.getElementById('studio-ad-risk').value,
            allowed_models: document.getElementById('studio-ad-models').value.trim(),
            allowed_tools: document.getElementById('studio-ad-tools').value.trim(),
            instructions: document.getElementById('studio-ad-instr').value,
            source: c.source, signal: c.signal || {},
          }) });
          closeModal();
          await renderSkillStudio();
          studioOpenWizard((r.skill && r.skill.name) || '');
        } catch (e) { out.innerHTML = '<span class="status error">' + escapeHTML(e.message) + '</span>'; }
      };
    };

    window.studioOpenWizard = async (name) => {
      window.__studioWizardName = name;
      const sel = document.getElementById('studio-skill-select');
      if (sel && sel.value !== name) sel.value = name;
      await studioRenderWizard();
    };

    async function studioRenderWizard() {
      const host = document.getElementById('studio-wizard');
      if (!host) return;
      const name = window.__studioWizardName;
      if (!name) { host.innerHTML = ''; return; }
      host.innerHTML = '<div class="empty">불러오는 중...</div>';
      let rd, sk;
      try {
        [rd, sk] = await Promise.all([
          api('/admin/skill-studio/readiness?name=' + encodeURIComponent(name)),
          api('/admin/skills/by-name/' + encodeURIComponent(name)).then(r => r.skill),
        ]);
      } catch (e) { host.innerHTML = '<div class="status error">' + escapeHTML(e.message) + '</div>'; return; }
      window.__studioSkills[name] = sk;

      const steps = ['평가', 'Chat 테스트', '스테이징', '프로덕션'];
      const curStep = sk.status === 'staging' ? 3 : 1;
      const stepper = '<div style="display:flex;gap:6px;margin-bottom:12px">' + steps.map((s, i) =>
        '<span class="status ' + (i + 1 <= curStep ? '' : 'warn') + '" style="font-size:11px">' + (i + 1) + '. ' + s + '</span>'
      ).join('') + '</div>';

      // Step 1: 평가 (policy dry-run)
      const evalStep =
        '<h4 style="margin:10px 0 6px">1. 정책 평가 (dry-run)</h4>' +
        '<div class="toolbar">' +
          '<input id="studio-ev-model" placeholder="모델 (예: gpt-4o)" value="' + escapeAttr((sk.allowed_models||'').split(',')[0].trim()) + '">' +
          '<input id="studio-ev-tools" placeholder="도구 쉼표구분 (예: sql-runner)">' +
          '<input id="studio-ev-team" placeholder="팀 (예: team_data)">' +
          '<button type="button" onclick="studioEvaluate(\'' + escapeAttr(name) + '\')">평가</button>' +
        '</div><div id="studio-ev-result" style="margin-top:6px"></div>';

      // Step 2: Chat 테스트
      const chatStep =
        '<h4 style="margin:14px 0 6px">2. Chat 테스트 (스킬 지침 적용)</h4>' +
        '<div class="toolbar">' +
          '<input id="studio-ct-model" placeholder="모델 (기본 vibe/auto)" value="vibe/auto">' +
          '<input id="studio-ct-prompt" placeholder="테스트 프롬프트" style="min-width:240px">' +
          '<button type="button" onclick="studioChatTest(\'' + escapeAttr(name) + '\')">실행</button>' +
        '</div><div id="studio-ct-result" style="margin-top:6px"></div>';

      // Step 3: 스테이징
      const stageStep = '<h4 style="margin:14px 0 6px">3. 스테이징 승격</h4>' +
        (sk.status === 'draft'
          ? '<button type="button" onclick="studioPromote(\'' + escapeAttr(name) + '\',\'staging\')">draft → staging 승격</button>'
          : '<div class="muted" style="font-size:12px">현재 상태: ' + escapeHTML(sk.status) + ' (스테이징 완료)</div>');

      // Step 4: 프로덕션 (mandatory readiness checklist + required policy editor)
      const checklist = '<ul style="list-style:none;padding:0;margin:6px 0">' + (rd.checks || []).map(c =>
        '<li style="margin:3px 0">' + (c.ok ? '✅' : (c.required ? '❌' : '⚠️')) + ' ' + escapeHTML(c.label) +
        (c.ok ? '' : ' <span class="muted" style="font-size:11px">— ' + escapeHTML(c.detail) + '</span>') + '</li>'
      ).join('') + '</ul>';
      const policyEditor =
        '<div class="kv" style="margin-top:6px">' +
          row('허용 모델 *', '<input id="studio-pp-models" value="' + escapeAttr(sk.allowed_models || '') + '" placeholder="필수: gpt-*, qwen-plus" style="width:100%">') +
          row('허용 도구 *', '<input id="studio-pp-tools" value="' + escapeAttr(sk.allowed_tools || '') + '" placeholder="필수: sql-runner" style="width:100%">') +
          row('허용 팀 *', '<input id="studio-pp-teams" value="' + escapeAttr(sk.allowed_teams || '') + '" placeholder="필수: team_data, team_pay" style="width:100%">') +
          row('일일 한도 *', '<input id="studio-pp-limit" type="number" min="1" value="' + (sk.daily_limit || '') + '" placeholder="필수: >0" style="width:120px">') +
          row('승격 사유', '<input id="studio-pp-note" placeholder="high 위험도는 필수" style="width:100%">') +
        '</div>' +
        '<div style="margin-top:8px;display:flex;gap:8px">' +
          '<button type="button" class="secondary" onclick="studioSavePolicy(\'' + escapeAttr(name) + '\')">정책 저장</button>' +
          '<button type="button" onclick="studioPromote(\'' + escapeAttr(name) + '\',\'production\')"' + (rd.production_ready && sk.status === 'staging' ? '' : ' disabled title="스테이징 + 필수 항목 충족 시 활성화"') + '>프로덕션 승격</button>' +
        '</div>';
      const fitnessPanel = '<div id="studio-fitness-' + escapeAttr(name) + '" style="margin-top:10px"></div>';
      const prodStep = '<h4 style="margin:14px 0 6px">4. 프로덕션 승격 — 필수 검증</h4>' +
        '<div class="muted" style="font-size:12px;margin-bottom:4px">프로덕션 전환 전 allowed_models · allowed_tools · allowed_teams · daily_limit + 보안 스캔이 모두 통과해야 합니다. high 위험도(또는 require_model_fitness)는 모델 적합성 근거 ' + '2건 이상이 필요합니다.</div>' +
        checklist + policyEditor + fitnessPanel;
      setTimeout(() => studioLoadFitness(name), 0);

      host.innerHTML =
        '<div style="border:1px solid var(--border);border-radius:8px;padding:12px">' +
        '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px"><strong>' + escapeHTML(name) + '</strong> ' + studioStatusBadge(sk.status) +
          (rd.production_ready ? '<span class="status">프로덕션 준비완료</span>' : '<span class="status warn">미충족 항목 있음</span>') + '</div>' +
        stepper + evalStep + chatStep + stageStep + prodStep +
        '<div id="studio-wiz-result" style="margin-top:8px"></div>' +
        '</div>';
    }

    window.studioEvaluate = async (name) => {
      const out = document.getElementById('studio-ev-result');
      const tools = document.getElementById('studio-ev-tools').value.split(',').map(t => t.trim()).filter(Boolean);
      try {
        const r = await api('/admin/skills/evaluate', { method: 'POST', body: JSON.stringify({
          name, model: document.getElementById('studio-ev-model').value.trim(), tools, team: document.getElementById('studio-ev-team').value.trim(),
        }) });
        out.innerHTML = r.allowed
          ? '<span class="status">통과 — 위반 없음</span>'
          : '<span class="status error">위반 ' + (r.violations || []).length + '건</span><ul style="margin:4px 0">' + (r.violations || []).map(v => '<li class="muted" style="font-size:12px">' + escapeHTML(v) + '</li>').join('') + '</ul>';
      } catch (e) { out.innerHTML = '<span class="status error">' + escapeHTML(e.message) + '</span>'; }
    };

    window.studioChatTest = async (name) => {
      const out = document.getElementById('studio-ct-result');
      const sk = (window.__studioSkills || {})[name] || {};
      const prompt = document.getElementById('studio-ct-prompt').value.trim() || '이 스킬을 한 문장으로 설명해줘.';
      const messages = [];
      if (sk.instructions) messages.push({ role: 'system', content: sk.instructions });
      messages.push({ role: 'user', content: prompt });
      out.innerHTML = '<span class="muted">실행 중...</span>';
      try {
        const r = await api('/admin/chat-test/run', { method: 'POST', body: JSON.stringify({
          model: document.getElementById('studio-ct-model').value.trim() || 'vibe/auto',
          messages, max_tokens: 256, headers: { 'X-Vibe-Skill': name },
        }) });
        out.innerHTML = '<div class="status ' + (r.ok ? '' : 'error') + '">HTTP ' + r.status_code + ' · ' + (r.latency_ms || 0) + 'ms</div>' +
          '<pre style="white-space:pre-wrap;border:1px solid var(--border);border-radius:6px;padding:8px;font-size:12px;max-height:220px;overflow:auto">' + escapeHTML(r.content || r.raw || '(빈 응답)') + '</pre>';
      } catch (e) { out.innerHTML = '<span class="status error">' + escapeHTML(e.message) + '</span>'; }
    };

    window.studioSavePolicy = async (name) => {
      const out = document.getElementById('studio-wiz-result');
      const sk = (window.__studioSkills || {})[name] || {};
      try {
        await api('/admin/skills', { method: 'POST', body: JSON.stringify({
          name, description: sk.description, version: sk.version, owner: sk.owner,
          status: sk.status, risk_level: sk.risk_level, instructions: sk.instructions,
          allowed_models: document.getElementById('studio-pp-models').value.trim(),
          allowed_tools: document.getElementById('studio-pp-tools').value.trim(),
          allowed_teams: document.getElementById('studio-pp-teams').value.trim(),
          daily_limit: parseInt(document.getElementById('studio-pp-limit').value, 10) || 0,
        }) });
        out.innerHTML = '<span class="status">정책 저장됨 — 검증 갱신 중...</span>';
        await studioRenderWizard();
      } catch (e) { out.innerHTML = '<span class="status error">' + escapeHTML(e.message) + '</span>'; }
    };

    // 모델 적합성 근거: high 위험도(또는 require_model_fitness) 스킬의 프로덕션 게이트.
    window.studioLoadFitness = async (name) => {
      const host = document.getElementById('studio-fitness-' + name);
      if (!host) return;
      let d;
      try { d = await api('/admin/skills/fitness?skill=' + encodeURIComponent(name)); }
      catch (e) { host.innerHTML = ''; return; }
      const ev = d.evidence || [];
      const ok = (d.passing_count || 0) >= (d.required || 2);
      const rows = ev.length
        ? ev.map(e => '<div style="font-size:11px">• <span class="status ' + (e.passed ? '' : 'error') + '" style="font-size:9px">' + (e.passed ? 'pass' : 'fail') + '</span> ' + escapeHTML(e.kind) + (e.ref_id ? ' (' + escapeHTML(e.ref_id) + ')' : '') + (e.score ? ' · ' + e.score.toFixed(1) + '점' : '') + (e.note ? ' — ' + escapeHTML(e.note) : '') + '</div>').join('')
        : '<span class="muted" style="font-size:11px">근거 없음</span>';
      host.innerHTML = '<div style="border:1px solid var(--border);border-radius:6px;padding:8px">' +
        '<strong style="font-size:12px">모델 적합성 근거</strong> <span class="status ' + (ok ? '' : 'warn') + '" style="font-size:9px">' + (d.passing_count || 0) + '/' + (d.required || 2) + ' 통과</span>' +
        '<div style="margin:4px 0">' + rows + '</div>' +
        '<div style="display:flex;gap:4px;flex-wrap:wrap;align-items:center">' +
        '<select id="studio-fit-kind-' + name + '" style="font-size:11px"><option value="multimodel">멀티모델</option><option value="golden">Golden</option><option value="testcase">테스트케이스</option></select>' +
        '<input id="studio-fit-ref-' + name + '" placeholder="run/workflow/case id" style="font-size:11px;width:160px">' +
        '<input id="studio-fit-score-' + name + '" type="number" placeholder="점수" style="font-size:11px;width:64px">' +
        '<label style="font-size:11px"><input type="checkbox" id="studio-fit-pass-' + name + '" checked> 통과</label>' +
        '<button type="button" class="secondary" style="font-size:11px" onclick="studioAddFitness(\'' + escapeAttr(name) + '\')">근거 추가</button>' +
        '</div></div>';
    };
    window.studioAddFitness = async (name) => {
      const body = {
        skill: name,
        kind: (document.getElementById('studio-fit-kind-' + name) || {}).value || 'multimodel',
        ref_id: ((document.getElementById('studio-fit-ref-' + name) || {}).value || '').trim(),
        score: parseFloat((document.getElementById('studio-fit-score-' + name) || {}).value || '0') || 0,
        passed: (document.getElementById('studio-fit-pass-' + name) || {}).checked !== false,
      };
      try { await api('/admin/skills/fitness', { method: 'POST', body: JSON.stringify(body) }); await studioLoadFitness(name); }
      catch (e) { alert('근거 추가 오류: ' + e.message); }
    };

    window.studioPromote = async (name, to) => {
      const out = document.getElementById('studio-wiz-result');
      const note = (to === 'production') ? (document.getElementById('studio-pp-note') || {}).value || '' : '';
      try {
        await api('/admin/skills/promote', { method: 'POST', body: JSON.stringify({ name, to_status: to, note }) });
        if (out) out.innerHTML = '<span class="status">' + escapeHTML(to) + ' 승격 완료</span>';
        await renderSkillStudio();
        studioOpenWizard(name);
      } catch (e) {
        if (out) out.innerHTML = '<span class="status error">' + escapeHTML(e.message) + '</span>';
        else alert('승격 오류: ' + e.message);
      }
    };
    // ── Skill Studio 끝 ──────────────────────────────────────────────────

    async function renderSkills() {
      const view = document.getElementById('view');
      const statusFilter = sessionStorage.getItem('skillStatusFilter') || '';
      const d = await api('/admin/skills' + (statusFilter ? ('?status=' + encodeURIComponent(statusFilter)) : '')).catch(e => ({ skills: [], _err: e.message }));
      const skills = d.skills || [];
      const badge = (st) => '<span class="status ' + (st === 'production' ? '' : (st === 'deprecated' ? 'error' : 'warn')) + '">' + escapeHTML(st || '') + '</span>';
      const riskBadge = (rk) => '<span class="status ' + (rk === 'high' ? 'error' : (rk === 'medium' ? 'warn' : '')) + '">' + escapeHTML(rk || '') + '</span>';

      let html = '<div class="card-body"><p class="muted">Skill 레지스트리 — 재사용 가능한 AI 작업 매뉴얼(지침 + 정책 힌트)을 등록·승격하고 실행 로그를 점검합니다. <code>production</code> 상태만 <code>GET /v1/skills</code>로 호출자에게 노출됩니다. 요청이 <code>X-Vibe-Skill</code> 헤더로 Skill을 지정하면 <code>allowed_models</code>/<code>allowed_tools</code> 정책을 검사합니다 — 적용 모드는 <a href="#/settings/runtime">런타임 설정</a>의 <code>skills.enforcement</code>(off/warn/enforce)에서 변경하세요.</p>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:6px">' +
          '<label class="muted">상태 <select id="skill-status-filter" onchange="skillFilter(this.value)">' +
            ['', 'draft', 'staging', 'production', 'deprecated'].map(s => '<option value="' + s + '"' + (s === statusFilter ? ' selected' : '') + '>' + (s || '전체') + '</option>').join('') +
          '</select></label>' +
          '<button type="button" onclick="skillEdit()">새 Skill</button>' +
          '<button class="secondary" type="button" onclick="skillSeedRecommended()">추천 Skill 시드</button>' +
          '<button class="secondary" type="button" onclick="skillScanAll()">보안 스캔</button>' +
          '<button class="secondary" type="button" onclick="skillRecommend()">Skill 추천</button>' +
          '<button class="secondary" type="button" onclick="skillExport()">내보내기</button>' +
          '<button class="secondary" type="button" onclick="document.getElementById(\'skill-import-file\').click()">가져오기</button>' +
          '<input type="file" id="skill-import-file" accept="application/json" style="display:none" onchange="skillImport(this)">' +
          '<span id="skill-action-result" class="muted"></span>' +
        '</div></div>';

      // Observability/cost summary (last 30d by default).
      const stats = await api('/admin/skills/stats').catch(() => ({ stats: [] }));
      const srows = stats.stats || [];
      if (srows.length) {
        const pct = (v) => (v * 100).toFixed(1) + '%';
        html += '<section><h2>실행·비용 요약 <span class="muted" style="font-size:12px">최근 30일</span></h2><div class="card-body">' +
          '<table><thead><tr><th>Skill</th><th>실행</th><th>성공</th><th>오류</th><th>차단</th><th>차단율</th><th>비용(₩)</th><th>평균 지연(ms)</th><th>사용자</th><th>최근</th></tr></thead><tbody>' +
          srows.map(st => '<tr><td><strong>' + escapeHTML(st.skill_name) + '</strong></td>' +
            '<td data-num="' + st.runs + '">' + fmt(st.runs) + '</td>' +
            '<td data-num="' + st.ok + '">' + fmt(st.ok) + '</td>' +
            '<td data-num="' + st.errors + '">' + fmt(st.errors) + '</td>' +
            '<td data-num="' + st.blocked + '">' + fmt(st.blocked) + '</td>' +
            '<td>' + (st.blocked > 0 ? '<span class="status warn">' + pct(st.block_rate) + '</span>' : pct(st.block_rate)) + '</td>' +
            '<td data-num="' + st.total_cost_krw + '">' + fmt(Math.round(st.total_cost_krw)) + '</td>' +
            '<td data-num="' + st.avg_latency_ms + '">' + fmt(Math.round(st.avg_latency_ms)) + '</td>' +
            '<td data-num="' + st.actors + '">' + fmt(st.actors) + '</td>' +
            '<td>' + ago(st.last_run_at) + '</td></tr>').join('') +
          '</tbody></table></div></section>';
      }

      html += '<section><h2>Skill 목록 ' + (skills.length ? '(' + skills.length + ')' : '') + '</h2><div class="card-body">' +
        (skills.length ? '<table><thead><tr><th>이름</th><th>버전</th><th>상태</th><th>위험</th><th>허용 모델</th><th>허용 도구</th><th>수정</th><th></th></tr></thead><tbody>' +
          skills.map(sk => '<tr>' +
            '<td><strong>' + escapeHTML(sk.name) + '</strong><div class="muted" style="font-size:11px">' + escapeHTML(sk.description || '') + '</div></td>' +
            '<td><code>' + escapeHTML(sk.version || '') + '</code></td>' +
            '<td>' + badge(sk.status) + '</td>' +
            '<td>' + riskBadge(sk.risk_level) + '</td>' +
            '<td class="muted">' + escapeHTML(sk.allowed_models || '*') + '</td>' +
            '<td class="muted">' + escapeHTML(sk.allowed_tools || '*') + '</td>' +
            '<td>' + ago(sk.updated_at) + '<div class="muted" style="font-size:11px">' + escapeHTML(sk.updated_by || '') + '</div></td>' +
            '<td><button class="secondary" type="button" onclick="skillEdit(\'' + escapeAttr(sk.name) + '\')">편집</button> ' +
              '<button class="secondary" type="button" onclick="skillPromote(\'' + escapeAttr(sk.name) + '\',\'' + escapeAttr(sk.status) + '\')">승격</button> ' +
              '<button class="secondary" type="button" onclick="skillRuns(\'' + escapeAttr(sk.name) + '\')">실행로그</button> ' +
              '<button class="secondary" type="button" onclick="skillPromotions(\'' + escapeAttr(sk.name) + '\')">이력</button> ' +
              '<button class="secondary" type="button" onclick="skillDelete(\'' + escapeAttr(sk.name) + '\')">삭제</button></td>' +
          '</tr>').join('') + '</tbody></table>'
          : '<div class="empty">등록된 Skill이 없습니다. [새 Skill]로 추가하세요.' + (d._err ? '<div class="muted">' + escapeHTML(d._err) + '</div>' : '') + '</div>') +
        '</div></section>';

      html += '<section id="skill-editor" style="display:none"></section>';
      html += '<section id="skill-runs" style="display:none"></section>';
      view.innerHTML = card('Skills', html);
      window._skillsByName = {};
      skills.forEach(sk => { window._skillsByName[sk.name] = sk; });
    }
    window.skillFilter = (v) => { sessionStorage.setItem('skillStatusFilter', v || ''); renderSkills(); };
    window.skillEdit = (name) => {
      const ed = document.getElementById('skill-editor');
      if (!ed) return;
      const sk = (name && window._skillsByName && window._skillsByName[name]) || { name: '', description: '', version: '0.1.0', owner: '', status: 'draft', risk_level: 'low', allowed_models: '', allowed_tools: '', allowed_teams: '', instructions: '' };
      const sel = (id, val, opts) => '<label class="muted">' + id + ' <select id="sk-' + id + '">' + opts.map(o => '<option value="' + o + '"' + (o === val ? ' selected' : '') + '>' + o + '</option>').join('') + '</select></label>';
      ed.style.display = '';
      ed.innerHTML = '<h2>' + (name ? ('편집: ' + escapeHTML(name)) : '새 Skill') + '</h2><div class="card-body">' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px">' +
          '<label class="muted">name <input id="sk-name" value="' + escapeAttr(sk.name) + '"' + (name ? ' readonly' : '') + '></label>' +
          '<label class="muted">version <input id="sk-version" value="' + escapeAttr(sk.version || '') + '"></label>' +
          '<label class="muted">owner <input id="sk-owner" value="' + escapeAttr(sk.owner || '') + '"></label>' +
          sel('status', sk.status || 'draft', ['draft', 'staging', 'production', 'deprecated']) +
          sel('risk_level', sk.risk_level || 'low', ['low', 'medium', 'high']) +
        '</div>' +
        '<label class="muted" style="display:block;margin-bottom:6px">description <input id="sk-description" style="width:100%" value="' + escapeAttr(sk.description || '') + '"></label>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:6px">' +
          '<label class="muted" style="flex:1">allowed_models (glob, 콤마) <input id="sk-allowed_models" style="width:100%" value="' + escapeAttr(sk.allowed_models || '') + '"></label>' +
          '<label class="muted" style="flex:1">allowed_tools (콤마) <input id="sk-allowed_tools" style="width:100%" value="' + escapeAttr(sk.allowed_tools || '') + '"></label>' +
        '</div>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:6px">' +
          '<label class="muted" style="flex:2">allowed_teams (팀 glob, 콤마; 비우면 전체 허용) <input id="sk-allowed_teams" style="width:100%" value="' + escapeAttr(sk.allowed_teams || '') + '"></label>' +
          '<label class="muted" style="flex:1">daily_limit (0=무제한) <input id="sk-daily_limit" type="number" min="0" style="width:100%" value="' + (sk.daily_limit || 0) + '"></label>' +
        '</div>' +
        '<label class="muted" style="display:block">instructions <textarea id="sk-instructions" style="width:100%;min-height:120px">' + escapeHTML(sk.instructions || '') + '</textarea></label>' +
        '<div style="margin-top:8px"><button type="button" onclick="skillSave()">저장</button> <button class="secondary" type="button" onclick="document.getElementById(\'skill-editor\').style.display=\'none\'">닫기</button></div>' +
        '</div>';
      ed.scrollIntoView({ behavior: 'smooth' });
    };
    window.skillSave = async () => {
      const val = (id) => (document.getElementById('sk-' + id) || {}).value || '';
      const body = {
        name: val('name'), version: val('version'), owner: val('owner'), status: val('status'),
        risk_level: val('risk_level'), description: val('description'),
        allowed_models: val('allowed_models'), allowed_tools: val('allowed_tools'), allowed_teams: val('allowed_teams'), daily_limit: Number(val('daily_limit') || 0), instructions: val('instructions'),
      };
      const out = document.getElementById('skill-action-result');
      try {
        await api('/admin/skills', { method: 'POST', body: JSON.stringify(body) });
        if (out) out.innerHTML = '<span class="status">저장됨</span>';
        await renderSkills();
      } catch (e) {
        if (out) out.innerHTML = '<span class="status error">' + escapeHTML(e.message) + '</span>';
      }
    };
    window.skillDelete = async (name) => {
      if (!confirm('Skill "' + name + '"을 삭제할까요?')) return;
      try {
        await api('/admin/skills/by-name/' + encodeURIComponent(name), { method: 'DELETE' });
        await renderSkills();
      } catch (e) {
        const out = document.getElementById('skill-action-result');
        if (out) out.innerHTML = '<span class="status error">' + escapeHTML(e.message) + '</span>';
      }
    };
    window.skillPromote = async (name, from) => {
      const next = { draft: 'staging', staging: 'production', production: 'deprecated', deprecated: 'staging' };
      const suggested = next[from] || 'staging';
      const to = prompt('Skill "' + name + '" 승격 — 대상 상태 (draft/staging/production/deprecated)\n현재: ' + from, suggested);
      if (!to) return;
      const note = prompt('변경 사유(선택, high-risk → production 시 필수):', '') || '';
      const out = document.getElementById('skill-action-result');
      try {
        const r = await api('/admin/skills/promote', { method: 'POST', body: JSON.stringify({ name: name, to_status: to.trim(), note: note }) });
        if (out) out.innerHTML = '<span class="status">승격됨: ' + escapeHTML(name) + ' → ' + escapeHTML((r.skill || {}).status || to) + '</span>';
        await renderSkills();
      } catch (e) {
        if (out) out.innerHTML = '<span class="status error">' + escapeHTML(e.message) + '</span>';
      }
    };
    window.skillPromotions = async (name) => {
      const sec = document.getElementById('skill-runs');
      if (!sec) return;
      const d = await api('/admin/skills/promotions?skill=' + encodeURIComponent(name)).catch(e => ({ promotions: [], _err: e.message }));
      const proms = d.promotions || [];
      sec.style.display = '';
      sec.innerHTML = '<h2>승격 이력: ' + escapeHTML(name) + ' ' + (proms.length ? '(' + proms.length + ')' : '') + '</h2><div class="card-body">' +
        (proms.length ? '<table><thead><tr><th>시각</th><th>전이</th><th>버전</th><th>수행자</th><th>사유</th></tr></thead><tbody>' +
          proms.map(p => '<tr><td>' + ago(p.created_at) + '</td><td>' + escapeHTML(p.from_status) + ' → <strong>' + escapeHTML(p.to_status) + '</strong></td><td>' + escapeHTML(p.from_version) + ' → ' + escapeHTML(p.to_version) + '</td><td>' + escapeHTML(p.actor || '') + '</td><td class="muted">' + escapeHTML(p.note || '') + '</td></tr>').join('') + '</tbody></table>'
          : '<div class="empty">승격 이력이 없습니다.' + (d._err ? '<div class="muted">' + escapeHTML(d._err) + '</div>' : '') + '</div>') +
        '</div>';
      sec.scrollIntoView({ behavior: 'smooth' });
    };
    window.skillExport = async () => {
      const out = document.getElementById('skill-action-result');
      try {
        const data = await api('/admin/skills/export');
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = 'skills-bundle.json';
        document.body.appendChild(a); a.click(); a.remove();
        URL.revokeObjectURL(url);
        if (out) out.innerHTML = '<span class="status">내보냄: ' + (data.skills || []).length + '개</span>';
      } catch (e) {
        if (out) out.innerHTML = '<span class="status error">' + escapeHTML(e.message) + '</span>';
      }
    };
    window.skillImport = async (input) => {
      const out = document.getElementById('skill-action-result');
      const file = input.files && input.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const r = await api('/admin/skills/import', { method: 'POST', body: text });
        const skipped = (r.skipped || []).length;
        if (out) out.innerHTML = '<span class="status">가져옴: ' + (r.imported || []).length + '개' + (skipped ? (' · 건너뜀 ' + skipped) : '') + '</span>';
        input.value = '';
        await renderSkills();
      } catch (e) {
        if (out) out.innerHTML = '<span class="status error">' + escapeHTML(e.message) + '</span>';
      }
    };
    window.skillRecommend = async () => {
      const sec = document.getElementById('skill-runs');
      if (!sec) return;
      const d = await api('/admin/skills/recommend?min_count=3', { method: 'POST' }).catch(e => ({ recommendations: [], _err: e.message }));
      const recs = d.recommendations || [];
      sec.style.display = '';
      sec.innerHTML = '<h2>Skill 추천 ' + (recs.length ? '(' + recs.length + ')' : '') + '</h2><div class="card-body">' +
        '<p class="muted">반복되는 Text2SQL 질문 패턴에서 표준화 가능한 Skill 초안을 제안합니다. 적용하면 draft로 생성되며, 검토 후 승격(게이트·스캔)하세요.</p>' +
        (recs.length ? '<div style="margin-bottom:8px"><button type="button" onclick="skillRecommendApply()">draft로 적용</button></div>' +
          '<table><thead><tr><th>제안 이름</th><th>질문</th><th>빈도</th><th>데이터 상품</th></tr></thead><tbody>' +
          recs.map(rc => '<tr><td><code>' + escapeHTML(rc.name) + '</code></td><td>' + escapeHTML(rc.description || '') + '</td><td data-num="' + (rc.count || 0) + '">' + fmt(rc.count || 0) + '</td><td class="muted">' + escapeHTML(rc.recommended_product || '') + '</td></tr>').join('') + '</tbody></table>'
          : '<div class="empty">추천할 패턴이 없습니다(반복 질문 부족).' + (d._err ? '<div class="muted">' + escapeHTML(d._err) + '</div>' : '') + '</div>') +
        '</div>';
      sec.scrollIntoView({ behavior: 'smooth' });
    };
    window.skillRecommendApply = async () => {
      const out = document.getElementById('skill-action-result');
      try {
        const r = await api('/admin/skills/recommend?min_count=3&apply=1', { method: 'POST' });
        if (out) out.innerHTML = '<span class="status">draft ' + (r.count || 0) + '건 생성됨</span>';
        await renderSkills();
      } catch (e) {
        if (out) out.innerHTML = '<span class="status error">' + escapeHTML(e.message) + '</span>';
      }
    };
    window.skillScanAll = async () => {
      const sec = document.getElementById('skill-runs');
      if (!sec) return;
      const d = await api('/admin/skills/scan').catch(e => ({ scans: [], _err: e.message }));
      const scans = d.scans || [];
      const sev = (s) => s === 'high' ? '<span class="status error">high</span>' : (s === 'medium' ? '<span class="status warn">medium</span>' : (s === 'low' ? '<span class="status">low</span>' : '<span class="status">clean</span>'));
      sec.style.display = '';
      sec.innerHTML = '<h2>보안 스캔 ' + (scans.length ? '(' + scans.length + ')' : '') + '</h2><div class="card-body">' +
        '<p class="muted">instructions·metadata의 임베딩 시크릿·프롬프트 인젝션 문구·파괴적 명령, 정책 위생(무제한 모델/도구)을 점검합니다. high 발견 시 production 승격이 차단됩니다.</p>' +
        (scans.length ? '<table><thead><tr><th>Skill</th><th>상태</th><th>위험</th><th>최고 심각도</th><th>발견</th><th>상세</th></tr></thead><tbody>' +
          scans.map(s => '<tr><td><strong>' + escapeHTML(s.name) + '</strong></td><td>' + escapeHTML(s.status) + '</td><td>' + escapeHTML(s.risk_level) + '</td><td>' + sev(s.max_severity) + '</td>' +
            '<td>' + (s.clean ? '<span class="muted">없음</span>' : ('H' + s.high_count + ' / M' + s.medium_count + ' / L' + s.low_count)) + '</td>' +
            '<td class="muted" style="font-size:11px">' + (s.findings || []).map(f => escapeHTML(f.category)).join(', ') + '</td></tr>').join('') + '</tbody></table>'
          : '<div class="empty">스캔할 Skill이 없습니다.' + (d._err ? '<div class="muted">' + escapeHTML(d._err) + '</div>' : '') + '</div>') +
        '</div>';
      sec.scrollIntoView({ behavior: 'smooth' });
    };
    window.skillSeedRecommended = async () => {
      const out = document.getElementById('skill-action-result');
      try {
        const r = await api('/admin/skills/seed-recommended', { method: 'POST' });
        if (out) out.innerHTML = '<span class="status">시드됨: ' + escapeHTML((r.seeded || []).join(', ')) + '</span>';
        await renderSkills();
      } catch (e) {
        if (out) out.innerHTML = '<span class="status error">' + escapeHTML(e.message) + '</span>';
      }
    };
    window.skillRuns = async (name) => {
      const sec = document.getElementById('skill-runs');
      if (!sec) return;
      const d = await api('/admin/skills/runs?skill=' + encodeURIComponent(name)).catch(e => ({ runs: [], _err: e.message }));
      const runs = d.runs || [];
      sec.style.display = '';
      sec.innerHTML = '<h2>실행 로그: ' + escapeHTML(name) + ' ' + (runs.length ? '(' + runs.length + ')' : '') + '</h2><div class="card-body">' +
        (runs.length ? '<table><thead><tr><th>시각</th><th>버전</th><th>행위자</th><th>모델</th><th>상태</th><th>비용(₩)</th><th>지연(ms)</th><th>도구</th></tr></thead><tbody>' +
          runs.map(r => '<tr><td>' + ago(r.created_at) + '</td><td><code>' + escapeHTML(r.skill_version || '') + '</code></td><td>' + escapeHTML(r.actor || '') + '</td><td>' + escapeHTML(r.model || '') + '</td><td>' + escapeHTML(r.status || '') + '</td><td data-num="' + (r.cost_krw || 0) + '">' + fmt(r.cost_krw || 0) + '</td><td data-num="' + (r.latency_ms || 0) + '">' + fmt(r.latency_ms || 0) + '</td><td class="muted">' + escapeHTML(r.tools_used || '') + '</td></tr>').join('') + '</tbody></table>'
          : '<div class="empty">실행 이력이 없습니다.' + (d._err ? '<div class="muted">' + escapeHTML(d._err) + '</div>' : '') + '</div>') +
        '</div>';
      sec.scrollIntoView({ behavior: 'smooth' });
    };
    async function renderDWDashboard() {
      const view = document.getElementById('view');
      const win = sessionStorage.getItem('dwWindow') || '30d';
      const dim = sessionStorage.getItem('dwDim') || 'model';
      const order = sessionStorage.getItem('dwOrder') || 'cost';
      const bkt = sessionStorage.getItem('dwBucket') || 'day';
      const qs = '?window=' + encodeURIComponent(win);
      const [ov, ts, dims, health, t2s, cons, rout, lat, qual, sav, mig, miners] = await Promise.all([
        api('/admin/dw/dashboard/overview' + qs).catch(e => ({ _err: e.message })),
        api('/admin/dw/dashboard/timeseries' + qs + '&bucket=' + encodeURIComponent(bkt)).catch(() => ({ points: [] })),
        api('/admin/dw/dashboard/dimensions' + qs + '&dimension=' + encodeURIComponent(dim) + '&order_by=' + encodeURIComponent(order) + '&limit=10').catch(() => ({ rows: [] })),
        api('/admin/dw/sink-status').catch(() => null),
        api('/admin/dw/dashboard/text2sql' + qs).catch(() => null),
        api('/admin/dw/consistency?days=30').catch(() => null),
        api('/admin/dw/dashboard/routing' + qs).catch(() => null),
        api('/admin/dw/dashboard/latency' + qs).catch(() => null),
        api('/admin/dw/dashboard/quality' + qs).catch(() => null),
        api('/admin/savings' + qs + '&dimension=' + encodeURIComponent(dim === 'all' ? 'project' : dim)).catch(() => null),
        api('/admin/model-migration' + qs).catch(() => null),
        api('/admin/text2sql/miners' + qs).catch(() => null),
      ]);

      if (ov && ov.configured === false) {
        view.innerHTML = card('DW 대시보드', '<div class="card-body"><div class="empty">ClickHouse DW가 설정되지 않았습니다. <a href="#/dwdashboard/clickhouse">ClickHouse</a> 탭에서 연결·테이블 생성·적재를 먼저 구성하세요.</div></div>');
        return;
      }
      if (ov && ov._err) {
        view.innerHTML = card('DW 대시보드', '<div class="card-body"><div class="error-line">DW 조회 실패: ' + escapeHTML(ov._err) + '</div></div>');
        return;
      }

      const winSel = ['1d', '7d', '30d', '90d'].map(o => '<option value="' + o + '"' + (o === win ? ' selected' : '') + '>' + o + '</option>').join('');
      let html = '<div class="card-body"><p class="muted">ClickHouse 일별 rollup 기준 장기 추세·비용 분석. 모델/팀/비용센터 단위로 요청·토큰·비용·오류를 집계합니다. 요청 단위 실시간 상세는 <a href="#/requests">호출 이력</a>을 사용하세요.</p>' +
        '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">' +
          '<label class="muted">기간 <select onchange="dwSet(\'dwWindow\', this.value)">' + winSel + '</select></label>' +
          '<span class="muted">since ' + escapeHTML(ov.since || '') + '</span>' +
          '<button class="secondary" type="button" onclick="dwExportCSV()">CSV 내보내기</button>' +
          '<button class="secondary" type="button" onclick="dwRefresh()" title="대시보드 쿼리 캐시(약 45초)를 비우고 ClickHouse에서 최신 값을 다시 조회합니다">새로고침</button>' +
          '<span id="dw-action-result" class="muted"></span>' +
        '</div></div>';

      const card1 = (label, val, sub) => '<div style="flex:1;min-width:150px;border:1px solid var(--border,#333);border-radius:8px;padding:10px"><div class="muted" style="font-size:12px">' + label + '</div><div style="font-size:20px;font-weight:600">' + val + '</div>' + (sub ? '<div class="muted" style="font-size:11px">' + sub + '</div>' : '') + '</div>';
      html += '<section><h2>KPI <span class="muted" style="font-size:12px">(' + escapeHTML(win) + ')</span></h2><div class="card-body"><div style="display:flex;gap:10px;flex-wrap:wrap">' +
        card1('요청 수', fmt(Math.round(ov.requests || 0))) +
        card1('총 토큰', fmt(Math.round(ov.tokens || 0))) +
        card1('총 비용(₩)', fmt(Math.round(ov.cost_krw || 0))) +
        card1('오류율', ((ov.error_rate || 0) * 100).toFixed(2) + '%') +
        card1('요청당 비용(₩)', (ov.cost_per_request_krw || 0).toFixed(2)) +
        card1('1K토큰당(₩)', (ov.cost_per_1k_tokens_krw || 0).toFixed(2)) +
        '</div></div></section>';

      // 비용 추이 — 일/주 단위 inline bars (cost).
      const pts = (ts && ts.points) || [];
      const bktSel = [['day', '일별'], ['week', '주별']].map(o => '<option value="' + o[0] + '"' + (o[0] === bkt ? ' selected' : '') + '>' + o[1] + '</option>').join('');
      const bktLabel = bkt === 'week' ? '주' : '일';
      if (pts.length) {
        const maxCost = Math.max.apply(null, pts.map(p => p.cost_krw || 0).concat([1]));
        html += '<section><h2>비용 추이 <label class="muted" style="font-size:12px">단위 <select onchange="dwSet(\'dwBucket\', this.value)">' + bktSel + '</select></label></h2><div class="card-body"><table><thead><tr><th>' + bktLabel + '자</th><th>요청</th><th>토큰</th><th>비용(₩)</th><th style="width:40%"></th></tr></thead><tbody>' +
          pts.map(p => '<tr><td>' + escapeHTML(p.day) + '</td><td data-num="' + p.requests + '">' + fmt(Math.round(p.requests)) + '</td><td data-num="' + p.tokens + '">' + fmt(Math.round(p.tokens)) + '</td><td data-num="' + p.cost_krw + '">' + fmt(Math.round(p.cost_krw)) + '</td>' +
            '<td><div class="progress"><span style="width:' + Math.round((p.cost_krw || 0) / maxCost * 100) + '%"></span></div></td></tr>').join('') +
          '</tbody></table></div></section>';
      }

      // Top-N by dimension.
      const dimSel = ['model', 'provider', 'project', 'cost_center'].map(o => '<option value="' + o + '"' + (o === dim ? ' selected' : '') + '>' + o + '</option>').join('');
      const ordSel = ['cost', 'requests', 'tokens', 'errors'].map(o => '<option value="' + o + '"' + (o === order ? ' selected' : '') + '>' + o + '</option>').join('');
      const drows = (dims && dims.rows) || [];
      html += '<section><h2>Top N</h2><div class="card-body">' +
        '<div style="display:flex;gap:8px;margin-bottom:8px"><label class="muted">차원 <select onchange="dwSet(\'dwDim\', this.value)">' + dimSel + '</select></label>' +
        '<label class="muted">정렬 <select onchange="dwSet(\'dwOrder\', this.value)">' + ordSel + '</select></label></div>' +
        (drows.length ? '<table><thead><tr><th>' + escapeHTML(dim) + '</th><th>요청</th><th>토큰</th><th>비용(₩)</th><th>오류율</th></tr></thead><tbody>' +
          drows.map(rw => '<tr><td>' + escapeHTML(String(rw.value)) + '</td><td data-num="' + rw.requests + '">' + fmt(Math.round(rw.requests)) + '</td><td data-num="' + rw.tokens + '">' + fmt(Math.round(rw.tokens)) + '</td><td data-num="' + rw.cost_krw + '">' + fmt(Math.round(rw.cost_krw)) + '</td><td>' + ((rw.error_rate || 0) * 100).toFixed(1) + '%</td></tr>').join('') +
          '</tbody></table>' : '<div class="empty">데이터 없음</div>') +
        '</div></section>';

      // 비용 절감 / 모델 전환 — 운영 DB 실시간 계산(savings·migration advisor)을 DW 대시보드에 표면화.
      const savScopes = (sav && sav.scopes) || [];
      const migRecs = (mig && mig.recommendations) || [];
      if (savScopes.length || migRecs.length || (sav && sav.total_savings_krw)) {
        const scard = (label, val, sub) => '<div style="flex:1;min-width:150px;border:1px solid var(--border,#333);border-radius:8px;padding:10px"><div class="muted" style="font-size:12px">' + label + '</div><div style="font-size:18px;font-weight:600">' + val + '</div>' + (sub ? '<div class="muted" style="font-size:11px">' + sub + '</div>' : '') + '</div>';
        html += '<section><h2>비용 절감 / 모델 전환 <span class="muted" style="font-size:12px">(운영 DB 실시간)</span></h2><div class="card-body">' +
          '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:8px">' +
            scard('총 절감액(₩)', fmt(Math.round((sav && sav.total_savings_krw) || 0)), '다운시프트+캐시') +
            scard('다운시프트 절감(₩)', fmt(Math.round((sav && sav.total_downshift_savings_krw) || 0))) +
            scard('캐시 절감(₩)', fmt(Math.round((sav && sav.total_cache_savings_krw) || 0)), '추정') +
            scard('모델 전환 추천', fmt(Math.round((mig && mig.count) || 0)) + '건') +
            scard('전환 예상 절감(₩)', fmt(Math.round((mig && mig.total_estimated_savings_krw) || 0))) +
          '</div>' +
          (savScopes.length ? '<h3 style="margin-top:6px">절감 Top (' + escapeHTML(String((sav && sav.dimension) || 'project')) + ')</h3><table><thead><tr><th>scope</th><th>다운시프트 건수</th><th>다운시프트 절감(₩)</th><th>캐시 히트</th><th>총 절감(₩)</th></tr></thead><tbody>' +
            savScopes.map(sc => '<tr><td>' + escapeHTML(String(sc.scope || '')) + '</td><td data-num="' + sc.downshift_requests + '">' + fmt(Math.round(sc.downshift_requests || 0)) + '</td><td data-num="' + sc.downshift_savings_krw + '">' + fmt(Math.round(sc.downshift_savings_krw || 0)) + '</td><td data-num="' + sc.cache_hits + '">' + fmt(Math.round(sc.cache_hits || 0)) + '</td><td data-num="' + sc.total_savings_krw + '">' + fmt(Math.round(sc.total_savings_krw || 0)) + '</td></tr>').join('') + '</tbody></table>' : '') +
          (migRecs.length ? '<h3 style="margin-top:10px">모델 전환 추천 (현재 → 추천)</h3><table><thead><tr><th>task_type</th><th>요청</th><th>현재 모델</th><th>추천 모델</th><th>성공률(현재→추천)</th><th>예상 절감(₩)</th></tr></thead><tbody>' +
            migRecs.map(m => '<tr><td>' + escapeHTML(String(m.task_type || '')) + '</td><td data-num="' + m.requests + '">' + fmt(Math.round(m.requests || 0)) + '</td><td>' + escapeHTML(String(m.current_model || '')) + '</td><td>' + escapeHTML(String(m.recommended_model || '')) + '</td><td>' + ((m.current_success_rate || 0) * 100).toFixed(0) + '% → ' + ((m.recommended_success_rate || 0) * 100).toFixed(0) + '%</td><td data-num="' + m.estimated_savings_krw + '">' + fmt(Math.round(m.estimated_savings_krw || 0)) + '</td></tr>').join('') + '</tbody></table>' : '') +
          '<div class="muted" style="margin-top:8px;font-size:11px">상세 비용·절감 요약은 <a href="#/dashboard">대시보드</a>에서 확인하세요. 절감/전환 추천은 운영 DB의 정확한 모델별 단가 기준 실시간 계산입니다.</div>' +
          '</div></section>';
      }

      // Text2SQL 분석 (text2sql_fact 설정 시).
      if (t2s && t2s.configured) {
        const tcard = (label, val) => '<div style="flex:1;min-width:130px;border:1px solid var(--border,#333);border-radius:8px;padding:10px"><div class="muted" style="font-size:12px">' + label + '</div><div style="font-size:18px;font-weight:600">' + val + '</div></div>';
        html += '<section><h2>Text2SQL 분석</h2><div class="card-body">' +
          '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:8px">' +
            tcard('질의 수', fmt(Math.round(t2s.total || 0))) +
            tcard('유효(valid)', fmt(Math.round(t2s.valid || 0))) +
            tcard('실행(executed)', fmt(Math.round(t2s.executed || 0))) +
            tcard('차단', fmt(Math.round(t2s.blocked || 0))) +
            tcard('차단율', ((t2s.block_rate || 0) * 100).toFixed(1) + '%') +
            tcard('평균 EXPLAIN risk', (t2s.avg_explain_risk || 0).toFixed(1)) +
            tcard('비용(₩)', fmt(Math.round(t2s.cost_krw || 0))) +
          '</div>' +
          ((t2s.by_mode && t2s.by_mode.length) ? '<table><thead><tr><th>모드</th><th>질의 수</th><th>실행</th></tr></thead><tbody>' +
            t2s.by_mode.map(m => '<tr><td>' + escapeHTML(String(m.mode || '')) + '</td><td data-num="' + m.count + '">' + fmt(Math.round(m.count)) + '</td><td data-num="' + m.executed + '">' + fmt(Math.round(m.executed)) + '</td></tr>').join('') + '</tbody></table>' : '') +
          ((t2s.failures && t2s.failures.length) ? '<h3 style="margin-top:10px">실패 원인 Top</h3><table><thead><tr><th>failure_category</th><th>건수</th></tr></thead><tbody>' +
            t2s.failures.map(f => '<tr><td>' + escapeHTML(String(f.reason || '')) + '</td><td data-num="' + f.count + '">' + fmt(Math.round(f.count)) + '</td></tr>').join('') + '</tbody></table>' : '') +
          ((t2s.stage_metrics && t2s.stage_metrics.length) ? '<h3 style="margin-top:10px">단계별 비용·지연 병목 (운영 DB span)</h3><table><thead><tr><th>단계</th><th>상태</th><th>모델</th><th>횟수</th><th>오류율</th><th>평균지연</th><th>최대지연</th><th>총비용</th></tr></thead><tbody>' +
            t2s.stage_metrics.map(m => '<tr>' +
              '<td><strong>' + escapeHTML(String(m.stage || '')) + '</strong></td>' +
              '<td><span class="status ' + governanceStatusClass(m.status || '') + '">' + escapeHTML(String(m.status || '')) + '</span></td>' +
              '<td>' + escapeHTML(String(m.model || '-')) + '</td>' +
              '<td data-num="' + Number(m.count || 0) + '">' + fmt(Math.round(m.count || 0)) + '</td>' +
              '<td data-num="' + Number(m.error_rate || 0) + '">' + (Number(m.error_rate || 0) * 100).toFixed(1) + '%</td>' +
              '<td data-num="' + Number(m.avg_latency_ms || 0) + '">' + fmt(Math.round(m.avg_latency_ms || 0)) + 'ms</td>' +
              '<td data-num="' + Number(m.max_latency_ms || 0) + '">' + fmt(Math.round(m.max_latency_ms || 0)) + 'ms</td>' +
              '<td data-num="' + Number(m.total_cost_krw || 0) + '">' + money(m.total_cost_krw || 0) + '</td>' +
            '</tr>').join('') + '</tbody></table>' : '') +
          '<div class="muted" style="margin-top:8px;font-size:11px">위험 요청·골든·replay 상세는 <a href="#/text2sql">Text2SQL 탭</a>에서 확인하세요.</div>' +
          '</div></section>';
      }

      // 성능 분석 — 지연 P50/P95/P99 (request fact 설정 시).
      if (lat && lat.configured) {
        const lcard = (label, val, sub) => '<div style="flex:1;min-width:130px;border:1px solid var(--border,#333);border-radius:8px;padding:10px"><div class="muted" style="font-size:12px">' + label + '</div><div style="font-size:18px;font-weight:600">' + val + '</div>' + (sub ? '<div class="muted" style="font-size:11px">' + sub + '</div>' : '') + '</div>';
        const ms = v => fmt(Math.round(v || 0)) + 'ms';
        html += '<section><h2>성능 분석 <span class="muted" style="font-size:12px">(지연/오류)</span></h2><div class="card-body">' +
          '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:8px">' +
            lcard('요청 수', fmt(Math.round(lat.total || 0))) +
            lcard('P50', ms(lat.p50_ms)) +
            lcard('P95', ms(lat.p95_ms)) +
            lcard('P99', ms(lat.p99_ms)) +
            lcard('평균', ms(lat.avg_ms)) +
            lcard('최대', ms(lat.max_ms)) +
            lcard('TTFB P95', ms(lat.ttfb_p95_ms), '스트리밍 첫 청크') +
            lcard('스트리밍 비율', ((lat.stream_share || 0) * 100).toFixed(1) + '%') +
            lcard('오류율', ((lat.error_rate || 0) * 100).toFixed(2) + '%') +
          '</div>' +
          ((lat.by_model && lat.by_model.length) ? '<h3 style="margin-top:6px">모델별 지연 (P95) Top</h3><table><thead><tr><th>모델</th><th>요청</th><th>P95</th><th>오류율</th></tr></thead><tbody>' +
            lat.by_model.map(m => '<tr><td>' + escapeHTML(String(m.model || '')) + '</td><td data-num="' + m.requests + '">' + fmt(Math.round(m.requests)) + '</td><td data-num="' + m.p95_ms + '">' + ms(m.p95_ms) + '</td><td>' + ((m.error_rate || 0) * 100).toFixed(1) + '%</td></tr>').join('') + '</tbody></table>' : '') +
          '<div class="muted" style="margin-top:8px;font-size:11px">요청 단위 상세·트레이스는 <a href="#/requests">호출 이력</a>에서 확인하세요. (request fact: ai_request_fact)</div>' +
          '</div></section>';
      }

      // 품질 분석 — 자동 평가(eval) + 사용자 피드백(feedback).
      if (qual && qual.configured) {
        const qcard = (label, val, sub) => '<div style="flex:1;min-width:130px;border:1px solid var(--border,#333);border-radius:8px;padding:10px"><div class="muted" style="font-size:12px">' + label + '</div><div style="font-size:18px;font-weight:600">' + val + '</div>' + (sub ? '<div class="muted" style="font-size:11px">' + sub + '</div>' : '') + '</div>';
        const ev = qual.eval || {}, fb = qual.feedback || {};
        html += '<section><h2>품질 분석 <span class="muted" style="font-size:12px">(평가/피드백)</span></h2><div class="card-body">';
        if (ev.configured) {
          html += '<h3 style="margin-top:0">자동 평가 (LLM eval)</h3>' +
            '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:8px">' +
              qcard('평가 수', fmt(Math.round(ev.total || 0))) +
              qcard('평균 점수', (ev.avg_score || 0).toFixed(2)) +
              qcard('통과율', ((ev.pass_rate || 0) * 100).toFixed(1) + '%') +
            '</div>' +
            ((ev.by_category && ev.by_category.length) ? '<table><thead><tr><th>카테고리</th><th>건수</th><th>평균 점수</th><th>통과율</th></tr></thead><tbody>' +
              ev.by_category.map(c => '<tr><td>' + escapeHTML(String(c.category || '')) + '</td><td data-num="' + c.count + '">' + fmt(Math.round(c.count)) + '</td><td>' + (c.avg_score || 0).toFixed(2) + '</td><td>' + ((c.pass_rate || 0) * 100).toFixed(1) + '%</td></tr>').join('') + '</tbody></table>' : '');
        } else {
          html += '<div class="muted" style="font-size:12px">자동 평가 fact(ai_eval_fact) 미설정 — CLICKHOUSE_EVAL_FACT_TABLE 설정 시 표시됩니다.</div>';
        }
        if (fb.configured) {
          html += '<h3 style="margin-top:12px">사용자 피드백</h3>' +
            '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:8px">' +
              qcard('피드백 수', fmt(Math.round(fb.total || 0))) +
              qcard('평균 평점', (fb.avg_rating || 0).toFixed(2)) +
              qcard('긍정', fmt(Math.round(fb.positive || 0))) +
              qcard('부정', fmt(Math.round(fb.negative || 0))) +
              qcard('긍정 비율', ((fb.positive_rate || 0) * 100).toFixed(1) + '%') +
            '</div>' +
            ((fb.by_label && fb.by_label.length) ? '<table><thead><tr><th>label</th><th>건수</th></tr></thead><tbody>' +
              fb.by_label.map(l => '<tr><td>' + escapeHTML(String(l.label || '')) + '</td><td data-num="' + l.count + '">' + fmt(Math.round(l.count)) + '</td></tr>').join('') + '</tbody></table>' : '');
        } else {
          html += '<div class="muted" style="margin-top:8px;font-size:12px">피드백 fact(ai_feedback_fact) 미설정 — CLICKHOUSE_FEEDBACK_FACT_TABLE 설정 시 표시됩니다.</div>';
        }
        html += '</div></section>';
      }

      // 라우팅 분석 (routing fact 설정 시).
      if (rout && rout.configured) {
        const rcard = (label, val) => '<div style="flex:1;min-width:130px;border:1px solid var(--border,#333);border-radius:8px;padding:10px"><div class="muted" style="font-size:12px">' + label + '</div><div style="font-size:18px;font-weight:600">' + val + '</div></div>';
        html += '<section><h2>라우팅 분석</h2><div class="card-body">' +
          '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:8px">' +
            rcard('총 라우팅', fmt(Math.round(rout.total || 0))) +
            rcard('자동 재작성', fmt(Math.round(rout.auto_routed || 0))) +
            rcard('자동 재작성율', ((rout.auto_route_rate || 0) * 100).toFixed(1) + '%') +
            rcard('fallback', fmt(Math.round(rout.fallback_used || 0))) +
            rcard('평균 complexity', (rout.avg_complexity || 0).toFixed(1)) +
            rcard('평균 risk', (rout.avg_risk || 0).toFixed(1)) +
            rcard('평균 health', (rout.avg_health || 0).toFixed(0)) +
          '</div>' +
          ((rout.rewrites && rout.rewrites.length) ? '<h3 style="margin-top:6px">모델 재작성 Top (요청 → 선택)</h3><table><thead><tr><th>요청 모델</th><th>선택 모델</th><th>건수</th></tr></thead><tbody>' +
            rout.rewrites.map(rw => '<tr><td>' + escapeHTML(String(rw.from || '')) + '</td><td>' + escapeHTML(String(rw.to || '')) + '</td><td data-num="' + rw.count + '">' + fmt(Math.round(rw.count)) + '</td></tr>').join('') + '</tbody></table>' : '') +
          ((rout.reasons && rout.reasons.length) ? '<h3 style="margin-top:10px">결정 근거 Top</h3><table><thead><tr><th>decision_reason</th><th>건수</th></tr></thead><tbody>' +
            rout.reasons.map(rr => '<tr><td>' + escapeHTML(String(rr.reason || '')) + '</td><td data-num="' + rr.count + '">' + fmt(Math.round(rr.count)) + '</td></tr>').join('') + '</tbody></table>' : '') +
          '</div></section>';
      }

      // DW Health: 적재 워터마크 · 실패 재처리 큐 (기존 sink-status 재사용).
      if (health) {
        const states = health.state || [];
        const retries = health.retries || [];
        html += '<section><h2>DW 적재 상태 ' + (retries.length ? '<span class="status warn">실패 큐 ' + retries.length + '</span>' : '<span class="status">정상</span>') + '</h2><div class="card-body">' +
          '<div style="margin-bottom:8px"><button class="secondary" type="button" onclick="dwRetry()">실패분 재처리</button> <a href="#/dwdashboard/clickhouse" class="muted">상세(ClickHouse 탭) →</a></div>' +
          (states.length ? '<table><thead><tr><th>dimension</th><th>마지막 적재일</th><th>행수</th><th>갱신</th></tr></thead><tbody>' +
            states.map(st => '<tr><td><code>' + escapeHTML(st.dimension || '') + '</code></td><td>' + escapeHTML(st.last_synced_day || st.since_day || '') + '</td><td data-num="' + (st.rows_sent || 0) + '">' + fmt(st.rows_sent || 0) + '</td><td>' + ago(st.updated_at) + '</td></tr>').join('') + '</tbody></table>'
            : '<div class="empty">적재 이력이 없습니다.</div>') +
          (retries.length ? '<table style="margin-top:10px"><thead><tr><th>dimension</th><th>since</th><th>마지막 오류</th><th>시도</th></tr></thead><tbody>' +
            retries.map(rq => '<tr><td><code>' + escapeHTML(rq.dimension || '') + '</code></td><td>' + escapeHTML(rq.since_day || '') + '</td><td class="muted">' + escapeHTML((rq.error || '').slice(0, 80)) + '</td><td data-num="' + (rq.attempts || 0) + '">' + fmt(rq.attempts || 0) + '</td></tr>').join('') + '</tbody></table>' : '') +
          '</div></section>';
      }

      // DW 정합성: 운영 DB vs ClickHouse (기존 consistency 재사용, 최근 30일).
      if (cons && cons.dimensions) {
        const cdims = cons.dimensions || [];
        const badge = cons.consistent ? '<span class="status">일치</span>' : '<span class="status error">불일치</span>';
        html += '<section><h2>DW 정합성 ' + badge + ' <span class="muted" style="font-size:12px">(최근 30일)</span></h2><div class="card-body">' +
          '<p class="muted" style="margin-top:0">운영 DB rollup과 ClickHouse 적재량을 차원별로 비교합니다. 요청·토큰 수가 일치해야 정상입니다.</p>' +
          '<table><thead><tr><th>dimension</th><th>상태</th><th>요청(DB→CH)</th><th>토큰(DB→CH)</th><th>요청 차이</th><th>비용 차이(₩)</th></tr></thead><tbody>' +
          cdims.map(c => {
            const pg = c.postgres || {}, chv = c.clickhouse || {}, df = c.diff || {};
            return '<tr><td><code>' + escapeHTML(c.dimension || '') + '</code></td>' +
              '<td>' + (c.consistent ? '<span class="status">OK</span>' : '<span class="status error">mismatch</span>') + '</td>' +
              '<td>' + fmt(pg.requests || 0) + ' → ' + fmt(chv.requests || 0) + '</td>' +
              '<td>' + fmt(pg.tokens || 0) + ' → ' + fmt(chv.tokens || 0) + '</td>' +
              '<td>' + (df.requests ? '<span class="status warn">' + fmt(df.requests) + '</span>' : '0') + '</td>' +
              '<td data-num="' + (df.cost_krw || 0) + '">' + fmt(Math.round(df.cost_krw || 0)) + '</td></tr>';
          }).join('') + '</tbody></table>' +
          '<div class="muted" style="margin-top:8px;font-size:11px">불일치 시 <a href="#/dwdashboard/clickhouse">ClickHouse 탭</a>에서 재적재·테이블 점검(table-info)을 수행하세요.</div>' +
          '</div></section>';
      }

      // 데이터 상품 후보 — Text2SQL 반복 질의 패턴을 정형 리포트·데이터 상품 후보로 표면화.
      // 원문 SQL은 노출하지 않고, 추천 상품 유형·반복 횟수·요약만 표시한다.
      const reportCands = (miners && miners.report_candidates) || [];
      if (reportCands.length) {
        const typeLabel = { dashboard: '대시보드', data_mart: '데이터마트', api: 'API' };
        const byType = { dashboard: 0, data_mart: 0, api: 0 };
        reportCands.forEach(c => { if (byType[c.recommended_product] !== undefined) byType[c.recommended_product] += 1; });
        const pcard = (label, val) => '<div style="flex:1;min-width:130px;border:1px solid var(--border,#333);border-radius:8px;padding:10px"><div class="muted" style="font-size:12px">' + label + '</div><div style="font-size:18px;font-weight:600">' + val + '</div></div>';
        const clip = s => { s = String(s || ''); return s.length > 60 ? s.slice(0, 60) + '…' : s; };
        html += '<section><h2>데이터 상품 후보 <span class="muted" style="font-size:12px">(Text2SQL 반복 질의)</span></h2><div class="card-body">' +
          '<p class="muted" style="margin-top:0">반복되는 자연어 질의를 정형 리포트·데이터 상품 후보로 분류합니다. 원문 SQL은 노출하지 않으며, 승격·상세는 Text2SQL 탭에서 수행하세요.</p>' +
          '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:8px">' +
            pcard('후보 수', fmt(reportCands.length) + '건') +
            pcard('대시보드형', fmt(byType.dashboard) + '건') +
            pcard('데이터마트형', fmt(byType.data_mart) + '건') +
            pcard('API형', fmt(byType.api) + '건') +
          '</div>' +
          '<table><thead><tr><th>질의(요약)</th><th>반복</th><th>추천 상품</th><th>마지막 발생</th></tr></thead><tbody>' +
          reportCands.slice(0, 15).map(c => '<tr><td>' + escapeHTML(clip(c.question)) + '</td><td data-num="' + c.count + '">' + fmt(Math.round(c.count || 0)) + '</td><td><span class="status">' + escapeHTML(typeLabel[c.recommended_product] || c.recommended_product || '') + '</span></td><td>' + escapeHTML(String(c.last_seen || '').slice(0, 10)) + '</td></tr>').join('') +
          '</tbody></table>' +
          '<div class="muted" style="margin-top:8px;font-size:11px">정형 리포트 승격·골든 쿼리 등록은 <a href="#/text2sql">Text2SQL 탭</a>에서 수행하세요.</div>' +
          '</div></section>';
      }

      view.innerHTML = card('DW 대시보드', html);
    }
    window.dwSet = (key, val) => { sessionStorage.setItem(key, val); renderDWDashboard(); };
    window.dwRefresh = async () => {
      const out = document.getElementById('dw-action-result');
      if (out) out.textContent = '새로고침 중…';
      try {
        const res = await api('/admin/dw/dashboard/refresh', { method: 'POST' });
        if (out) out.textContent = '캐시 ' + ((res && res.cleared) || 0) + '건 비움';
      } catch (e) {
        if (out) out.textContent = '새로고침 실패: ' + e.message;
      }
      renderDWDashboard();
    };
    window.dwExportCSV = async () => {
      const win = sessionStorage.getItem('dwWindow') || '30d';
      const dim = sessionStorage.getItem('dwDim') || 'model';
      const order = sessionStorage.getItem('dwOrder') || 'cost';
      const out = document.getElementById('dw-action-result');
      try {
        const h = authState.access ? { Authorization: 'Bearer ' + authState.access } : {};
        const res = await fetch('/admin/dw/dashboard/export.csv?window=' + encodeURIComponent(win) + '&dimension=' + encodeURIComponent(dim) + '&order_by=' + encodeURIComponent(order) + '&limit=100', { headers: h });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const blob = await res.blob();
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob); a.download = 'dw-dashboard.csv';
        document.body.appendChild(a); a.click(); a.remove();
        if (out) out.textContent = '내보냄';
      } catch (e) {
        if (out) out.innerHTML = '<span class="status error">' + escapeHTML(e.message) + '</span>';
      }
    };
    window.dwRetry = async () => {
      const out = document.getElementById('dw-action-result');
      try {
        const r = await api('/admin/dw/sink-retry', { method: 'POST' });
        if (out) out.innerHTML = '<span class="status">재처리: ' + (r.recovered_dimensions || 0) + '개 dimension, ' + (r.sent_rows || 0) + '행</span>';
        setTimeout(renderDWDashboard, 600);
      } catch (e) {
        if (out) out.innerHTML = '<span class="status error">' + escapeHTML(e.message) + '</span>';
      }
    };
    async function renderClickHouse() {
      const view = document.getElementById('view');
      const d = await api('/admin/dw/clickhouse/overview').catch(e => ({ configured: false, _err: e.message }));
      let html = '<div class="card-body"><p class="muted">ClickHouse 장기 분석(DW) 적재 상태를 한 화면에서 점검하고, 테이블 생성·적재·정합성 확인을 실행합니다. 연결/테이블/계정 설정은 <a href="#/settings/runtime">런타임 설정</a>의 <code>clickhouse.*</code> 키에서 변경하세요.</p>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:6px">' +
          '<button class="secondary" type="button" onclick="chAction(\'test\')">연결 테스트</button>' +
          '<button type="button" onclick="chAction(\'bootstrap\')">테이블 생성</button>' +
          '<button class="secondary" type="button" onclick="chAction(\'sink\')">지금 적재</button>' +
          '<button class="secondary" type="button" onclick="chAction(\'retry\')">실패분 재처리</button>' +
          '<button class="secondary" type="button" onclick="chAction(\'consistency\')">정합성 확인</button>' +
          '<span id="ch-action-result" class="muted"></span>' +
        '</div></div>';

      if (!d.configured) {
        html += '<div class="card-body"><div class="empty">ClickHouse가 설정되지 않았습니다. <a href="#/settings/runtime">런타임 설정</a>에서 <code>clickhouse.url</code>(및 database/table/계정)을 먼저 지정하세요.' +
          (d._err ? '<div class="muted">' + escapeHTML(d._err) + '</div>' : '') + '</div></div>';
        view.innerHTML = card('ClickHouse', html);
        return;
      }

      const ping = d.ping || {};
      const rt = d.rollup_table || { exists: false };
      const sink = d.sink || {};
      const ft = d.fact_table || { configured: false };
      const dedupe = rt.exists && rt.replacing_merge_tree && rt.dedupe_ok;

      html += '<section><h2>상태</h2><div class="card-body"><div class="kv">' +
        row('연결(ping)', ping.ok ? chBadge(true, 'OK', '') + ' <span class="muted">' + (ping.latency_ms || 0) + ' ms</span>' : chBadge(false, '', '실패') + ' <span class="muted">' + escapeHTML(ping.message || '') + '</span>') +
        row('대상', escapeHTML((d.database ? d.database + '.' : '') + (d.table || ''))) +
        row('rollup 테이블', rt.exists
            ? chBadge(true, '존재', '') + ' <span class="muted">' + escapeHTML(rt.engine || '') + '</span>' + (dedupe ? '' : ' <span class="status warn">dedupe 키 확인 필요</span>')
            : chBadge(false, '', '없음') + ' <span class="muted">테이블 생성 버튼으로 만들 수 있습니다</span>') +
        row('정렬키', rt.exists ? '<code>' + escapeHTML(rt.sorting_key || '') + '</code>' : '—') +
        row('자동 적재', sink.auto_enabled
            ? chBadge(true, '켜짐', '') + ' <span class="muted">interval ' + escapeHTML(sink.interval || '') + ', 최근 ' + (sink.days || 0) + '일</span>'
            : '<span class="status warn">꺼짐</span> <span class="muted">런타임 설정의 <code>clickhouse.sink_interval</code>을 1h 등으로 설정하면 자동 적재됩니다</span>') +
        (ft.configured ? row('fact 테이블', escapeHTML(ft.name) + ' ' + (ft.exists ? chBadge(true, '존재', '') : chBadge(false, '', '없음'))) : '') +
        '</div></div></section>';

      const wm = d.watermarks || [];
      html += '<section><h2>적재 워터마크 (dimension별)</h2><div class="card-body">' +
        (wm.length ? '<table><thead><tr><th>dimension</th><th>마지막 적재 기준</th><th>행수</th><th>갱신</th></tr></thead><tbody>' +
          wm.map(s => '<tr><td><code>' + escapeHTML(s.dimension || '') + '</code></td><td>' + escapeHTML(s.last_synced_day || '') + '</td><td data-num="' + (s.rows_sent || 0) + '">' + fmt(s.rows_sent || 0) + '</td><td>' + ago(s.updated_at) + '</td></tr>').join('') + '</tbody></table>'
          : '<div class="empty">아직 적재 이력이 없습니다. [지금 적재]를 누르거나 자동 적재를 켜세요.</div>') +
        '</div></section>';

      // Fact 적재 상태 (ClickHouse row counts + queue lag).
      const lag = await api('/admin/dw/clickhouse/lag').catch(() => null);
      if (lag && lag.tables) {
        html += '<section><h2>Fact 적재 상태</h2><div class="card-body">' +
          '<div class="kv">' +
            row('큐 깊이', (lag.queue_depth || 0) + ' / ' + (lag.queue_cap || 0) + (lag.dropped ? (' · 드롭 ' + fmt(lag.dropped)) : '')) +
            (lag.request_fact_rows != null ? row('request_fact 적재', fmt(lag.request_fact_rows) + ' 행' + (lag.request_fact_lag > 0 ? (' · 로컬 대비 lag ' + fmt(lag.request_fact_lag)) : ' · 동기화됨')) : '') +
            row('로컬 요청 수', fmt(lag.local_requests || 0)) +
            (lag.retry_batches ? row('재처리 배치', fmt(lag.retry_batches)) : '') +
          '</div>' +
          '<table style="margin-top:10px"><thead><tr><th>테이블</th><th>이름</th><th>행수</th><th>최근 이벤트</th></tr></thead><tbody>' +
          lag.tables.map(t => '<tr><td><code>' + escapeHTML(t.key) + '</code></td><td>' + escapeHTML(t.table) + '</td>' +
            '<td data-num="' + (t.rows || 0) + '">' + (t.exists ? fmt(t.rows || 0) : '<span class="status warn">없음</span>') + '</td>' +
            '<td>' + (t.exists ? '<button class="secondary" type="button" onclick="chViewEvents(\'' + escapeAttr(t.table) + '\')">최근 보기</button>' : '') + '</td></tr>').join('') +
          '</tbody></table>' +
          '<pre id="ch-events" class="muted" style="display:none;white-space:pre-wrap;font-size:11px;max-height:280px;overflow:auto;margin-top:10px"></pre>' +
          '</div></section>';
      }

      const rq = d.retries || [];
      html += '<section><h2>재처리 대기열 ' + (rq.length ? '(' + rq.length + ')' : '') + '</h2><div class="card-body">' +
        (rq.length ? '<table><thead><tr><th>dimension</th><th>since</th><th>마지막 오류</th><th>시도</th></tr></thead><tbody>' +
          rq.map(s => '<tr><td><code>' + escapeHTML(s.dimension || '') + '</code></td><td>' + escapeHTML(s.since_day || '') + '</td><td class="muted">' + escapeHTML((s.error || '').slice(0, 80)) + '</td><td data-num="' + (s.attempts || 0) + '">' + fmt(s.attempts || 0) + '</td></tr>').join('') + '</tbody></table>'
          : '<div class="empty">대기 중인 실패 적재가 없습니다.</div>') +
        '</div></section>';

      view.innerHTML = card('ClickHouse', html);
    }
    window.chAction = async (kind) => {
      const out = document.getElementById('ch-action-result');
      const setMsg = (cls, msg) => { if (out) out.innerHTML = '<span class="status ' + cls + '">' + escapeHTML(msg) + '</span>'; };
      try {
        if (kind === 'test') {
          setMsg('', '테스트 중…');
          const r = await api('/admin/settings/test/clickhouse', { method: 'POST', body: '{}' });
          setMsg(r.ok ? '' : 'error', r.ok ? ('연결 OK (' + (r.latency_ms || 0) + ' ms)' + (r.table_ok === false ? ' · 테이블 없음' : '')) : ('실패: ' + (r.message || '')));
        } else if (kind === 'bootstrap') {
          if (!confirm('ClickHouse에 데이터베이스/테이블을 생성합니다 (IF NOT EXISTS). 진행할까요?')) return;
          setMsg('', '생성 중…');
          const r = await api('/admin/dw/clickhouse/bootstrap', { method: 'POST' });
          setMsg(r.ok ? '' : 'error', r.ok ? '테이블 생성 완료' : '일부 실패: ' + (r.steps || []).filter(s => !s.ok).map(s => s.object + '(' + s.error + ')').join(', '));
        } else if (kind === 'sink') {
          setMsg('', '적재 중…');
          const r = await api('/admin/dw/clickhouse?days=7', { method: 'POST' });
          setMsg('', '적재 완료: ' + (r.sent_rows || 0) + '행 (since ' + (r.since || '') + ')');
        } else if (kind === 'retry') {
          setMsg('', '재처리 중…');
          const r = await api('/admin/dw/sink-retry', { method: 'POST' });
          setMsg('', '재처리: ' + (r.recovered_dimensions || 0) + '개 dimension, ' + (r.sent_rows || 0) + '행');
        } else if (kind === 'consistency') {
          setMsg('', '확인 중…');
          const r = await api('/admin/dw/consistency?days=30');
          setMsg(r.consistent ? '' : 'warn', r.consistent ? '정합성 OK (최근 30일)' : '불일치 감지 — dimension별 차이 확인 필요');
        }
      } catch (e) {
        setMsg('error', '실패: ' + e.message);
      }
      if (kind === 'bootstrap' || kind === 'sink' || kind === 'retry') {
        setTimeout(renderClickHouse, 600);
      }
    };
    window.chViewEvents = async (table) => {
      const pre = document.getElementById('ch-events');
      if (!pre) return;
      pre.style.display = 'block';
      pre.textContent = table + ' 최근 행 불러오는 중…';
      try {
        const r = await api('/admin/dw/clickhouse/events?table=' + encodeURIComponent(table) + '&limit=20');
        const rows = r.data || r.raw || r;
        pre.textContent = table + '\n' + JSON.stringify(rows, null, 2);
      } catch (e) {
        pre.textContent = '조회 실패: ' + e.message;
      }
    };

    // ---------- runtime settings (admin-managed config) ----------
    function settingInputId(key) { return 'val-' + key.replace(/[^a-zA-Z0-9]/g, '-'); }
    function jsonShort(s) { if (!s) return ''; try { return String(JSON.parse(s)); } catch (e) { return s; } }
    function settingLayerBadges(s) {
      const layers = s.layers || [];
      if (!layers.length) return '';
      const labels = { bootstrap_env: 'env', db_setting: 'DB', runtime_flag: 'flag', request_override: 'request' };
      return '<div style="margin-top:5px;display:flex;gap:4px;flex-wrap:wrap">' + layers.map(l => {
        const state = l.active ? 'active' : (l.configured ? 'set' : 'off');
        const cls = l.active ? 'status' : 'pill';
        const title = (l.name || '') + ' · ' + state + (l.is_set ? ' · value set' : '');
        return '<span class="' + cls + '" title="' + escapeAttr(title) + '">' + escapeHTML(labels[l.name] || l.name || '') + ':' + state + '</span>';
      }).join('') + '</div>';
    }
    async function renderRuntimeSettings() {
      const view = document.getElementById('view');
      const d = await api('/admin/settings/effective').catch(() => ({ settings: [] }));
      const settings = d.settings || [];
      const pod = d.this_pod || {};
      const podBanner = pod.hostname
        ? '<div class="' + (pod.up_to_date ? 'status' : 'status warn') + '" style="padding:8px 10px;margin-bottom:10px;font-size:12px">' +
            '이 파드(<code>' + escapeHTML(pod.hostname) + '</code>) 런타임 설정 ' + (pod.up_to_date ? '최신 ✓' : '동기화 대기…') +
            ' · 마지막 적용 ' + (pod.last_reload_at ? ago(pod.last_reload_at) : '-') +
            ' · 폴링 주기 ' + escapeHTML(pod.reload_interval || '-') +
            '<span class="muted"> — 멀티 파드는 변경 후 한 주기 내 모든 파드에 자동 반영됩니다.</span></div>'
        : '';
      const groups = {};
      settings.forEach(s => { (groups[s.category] = groups[s.category] || []).push(s); });
      let html = '<div class="card-body">' + podBanner + '<p class="muted">환경변수 기본값 위에 관리자 설정을 오버레이합니다. 저장 시 즉시 런타임에 반영(민감값은 암호화·마스킹). 출처 계층은 env → DB → runtime flag → request override 순서로 표시합니다.</p>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">' +
          '<button class="secondary" type="button" onclick="testSettingConn(\'clickhouse\')">ClickHouse 연결 테스트</button>' +
          '<button class="secondary" type="button" onclick="testSettingConn(\'text2sql-exec\')">Text2SQL 실행 DB 테스트</button>' +
          '<button class="secondary" type="button" onclick="testSettingConn(\'text2sql-twin\')">Twin DB 테스트</button>' +
          '<span id="conn-test-result" class="muted"></span>' +
        '</div></div>';
      Object.keys(groups).sort().forEach(cat => {
        html += '<section style="margin-top:14px"><h2>' + escapeHTML(cat) + '</h2><div class="card-body"><table><thead><tr>' +
          '<th>키</th><th>값</th><th>출처</th><th>비고</th><th>동작</th></tr></thead><tbody>';
        groups[cat].forEach(s => {
          const id = settingInputId(s.key);
          const desc = s.description ? '<div class="muted" style="font-size:11px;margin-top:2px;max-width:320px;white-space:normal;line-height:1.4">' + escapeHTML(s.description) + '</div>' : '';
          if (s.read_only) {
            // Read-only env vars: show value as plain text, no editor/save/revert
            const displayVal = s.is_secret ? (s.is_set ? '********' : '<span class="muted">(미설정)</span>') : escapeHTML(String(s.value == null ? '' : s.value));
            html += '<tr style="opacity:.85"><td><code>' + escapeHTML(s.key) + '</code>' + desc + '</td>' +
              '<td><span style="font-family:ui-monospace,monospace;font-size:13px">' + displayVal + '</span></td>' +
              '<td><span class="pill" style="background:var(--surface2,#333);color:var(--muted)">환경변수</span>' + settingLayerBadges(s) + '</td>' +
              '<td></td><td><span class="muted" style="font-size:11px">변경 불가 (환경변수)</span></td></tr>';
            return;
          }
          let editor;
          if (s.type === 'bool') {
            editor = '<select id="' + id + '"><option value="true"' + (String(s.value) === 'true' ? ' selected' : '') + '>true</option>' +
              '<option value="false"' + (String(s.value) === 'false' ? ' selected' : '') + '>false</option></select>';
          } else if (s.is_secret) {
            editor = '<input id="' + id + '" type="password" placeholder="' + (s.is_set ? '******** (변경 시에만 입력)' : '(미설정)') + '">';
          } else {
            editor = '<input id="' + id + '" value="' + escapeHTML(String(s.value == null ? '' : s.value)) + '">';
          }
          const ver = s.version ? '<div class="muted">v' + s.version + ' · ' + escapeHTML(s.updated_by || '') + '</div>' : '';
          const restart = s.restart_required ? '<span class="pill">재연결/재시작</span>' : '';
          const activeSource = s.effective_source || (s.source === 'admin' ? 'db_setting' : 'bootstrap_env');
          const revertBtns = s.source === 'admin'
            ? '<button class="secondary" type="button" onclick="revertSetting(\'' + s.key + '\')">기본값</button> ' +
              (s.is_secret ? '' : '<button class="secondary" type="button" onclick="rollbackSetting(\'' + s.key + '\')">롤백</button> ')
            : '';
          html += '<tr><td><code>' + escapeHTML(s.key) + '</code>' + desc + '</td><td>' + editor + '</td>' +
            '<td><span class="status">' + escapeHTML(activeSource) + '</span>' + ver + settingLayerBadges(s) + '</td>' +
            '<td>' + restart + '</td><td>' +
              '<button type="button" onclick="saveSetting(\'' + s.key + '\',\'' + id + '\',' + (s.is_secret ? 'true' : 'false') + ')">저장</button> ' +
              revertBtns +
              '<button class="secondary" type="button" onclick="settingHistory(\'' + s.key + '\')">이력</button>' +
            '</td></tr>';
        });
        html += '</tbody></table></div></section>';
      });
      html += '<section style="margin-top:14px" id="setting-history-section" style="display:none"><h2>변경 이력</h2><div class="card-body" id="setting-history"></div></section>';
      view.innerHTML = card('런타임 설정', html);
    }

    async function saveSetting(key, inputId, secret) {
      const el = document.getElementById(inputId);
      const v = (el.value || '').trim();
      if (secret && v === '') { alert('변경할 값을 입력하세요(빈 값은 변경하지 않음).'); return; }
      try {
        await api('/admin/settings/by-key/' + encodeURIComponent(key), { method: 'PUT', body: JSON.stringify({ value: v }) });
        await renderRuntimeSettings();
      } catch (e) { alert('저장 실패: ' + e.message); }
    }
    async function revertSetting(key) {
      if (!confirm('이 설정을 환경변수 기본값으로 되돌릴까요?')) return;
      try { await api('/admin/settings/by-key/' + encodeURIComponent(key), { method: 'DELETE' }); await renderRuntimeSettings(); }
      catch (e) { alert('되돌리기 실패: ' + e.message); }
    }
    async function rollbackSetting(key) {
      try { await api('/admin/settings/rollback', { method: 'POST', body: JSON.stringify({ key }) }); await renderRuntimeSettings(); }
      catch (e) { alert('롤백 실패: ' + e.message); }
    }
    async function settingHistory(key) {
      const sec = document.getElementById('setting-history-section');
      const el = document.getElementById('setting-history');
      sec.style.display = '';
      el.innerHTML = '불러오는 중...';
      try {
        const d = await api('/admin/settings/history?key=' + encodeURIComponent(key));
        const h = d.history || [];
        el.innerHTML = '<div class="muted" style="margin-bottom:6px">' + escapeHTML(key) + '</div>' + (h.length
          ? '<table><thead><tr><th>시각</th><th>변경자</th><th>이전</th><th>이후</th><th>사유</th></tr></thead><tbody>' +
            h.map(r => '<tr><td>' + escapeHTML(r.changed_at) + '</td><td>' + escapeHTML(r.changed_by || '') + '</td>' +
              '<td>' + (r.is_secret ? '<span class="muted">(secret)</span>' : escapeHTML(jsonShort(r.old_value_json))) + '</td>' +
              '<td>' + (r.is_secret ? '<span class="muted">(secret)</span>' : escapeHTML(jsonShort(r.new_value_json))) + '</td>' +
              '<td>' + escapeHTML(r.reason || '') + '</td></tr>').join('') + '</tbody></table>'
          : '<p class="muted">이력이 없습니다.</p>');
      } catch (e) { el.innerHTML = '<p class="error-line">' + escapeHTML(e.message) + '</p>'; }
    }
    async function testSettingConn(kind) {
      const el = document.getElementById('conn-test-result');
      el.textContent = '테스트 중...';
      try {
        const d = await api('/admin/settings/test/' + kind, { method: 'POST', body: '{}' });
        el.textContent = (d.ok ? '✅ 성공' : '❌ 실패') +
          (d.message ? ' — ' + d.message : '') +
          (d.latency_ms != null ? ' (' + d.latency_ms + 'ms)' : '') +
          (d.table_ok != null ? ' · table_ok=' + d.table_ok : '') +
          (d.warning ? ' ⚠ ' + d.warning : '');
      } catch (e) { el.textContent = '오류: ' + e.message; }
    }

    // ---------- settings ----------
    async function renderText2SQL() {
      const d = await api('/admin/text2sql?window=7d').catch(() => ({ logs: [], profiles: [], stats: {} }));
      const st = d.stats || {};
      const enabled = d.enabled;
      const kpis = '<div class="kpis">' +
        kpi('상태', enabled ? '<span class="status">활성</span>' : '<span class="status error">비활성</span>') +
        kpi('질의 수(7d)', fmt(st.total || 0)) +
        kpi('유효 SQL', fmt(st.valid || 0) + '<div class="muted" style="font-size:11px;margin-top:6px">' + ((st.valid_rate || 0) * 100).toFixed(0) + '%</div>') +
        kpi('실행', fmt(st.executed || 0)) +
        kpi('오류', fmt(st.errors || 0)) +
        kpi('비용(7d)', money(st.cost_krw || 0)) +
      '</div>';
      const profileRows = (d.profiles || []).map(p =>
        '<tr><td><code>' + escapeHTML(p.model) + '</code></td><td>' + escapeHTML(p.mode) + '</td><td>' + escapeHTML(p.upstream) + '</td></tr>'
      ).join('');
      const profileTable = '<table><thead><tr><th>가상 모델</th><th>모드</th><th>업스트림 모델</th></tr></thead><tbody>' + profileRows + '</tbody></table>';
      const schemas = d.schemas || [];
      const schemaForm =
        '<form class="inline-form" id="t2s-schema-form" style="grid-template-columns: 130px 90px 90px minmax(200px,2fr) minmax(140px,1fr) 70px; align-items:start;">' +
          '<input id="t2s-name" placeholder="이름 (예: analytics)" required>' +
          '<input id="t2s-team" placeholder="팀(빈칸=전역)">' +
          '<input id="t2s-dialect" placeholder="PostgreSQL">' +
          '<textarea id="t2s-schema" rows="3" placeholder="테이블/컬럼 설명 (프롬프트 컨텍스트)" required style="resize:vertical"></textarea>' +
          '<input id="t2s-tables" placeholder="허용 테이블(콤마)">' +
          '<button type="submit">저장</button>' +
        '</form>';
      const schemaRows = schemas.map(sc =>
        '<tr>' +
          '<td><strong>' + escapeHTML(sc.name) + '</strong>' + (sc.is_default ? ' <span class="pill">기본</span>' : '') + (sc.enabled ? '' : ' <span class="status error">중지</span>') + '</td>' +
          '<td>' + escapeHTML(sc.team || '전역') + '</td>' +
          '<td>' + escapeHTML(sc.dialect || '') + '</td>' +
          '<td>' + ((sc.allowed_tables || []).length ? escapeHTML((sc.allowed_tables || []).join(', ')) : '<span class="muted">전체</span>') + '</td>' +
          '<td><button class="danger" type="button" onclick="deleteT2SSchema(\'' + escapeAttr(sc.name) + '\')">삭제</button></td>' +
        '</tr>'
      ).join('');
      const schemaTable = schemas.length ?
        '<table><thead><tr><th>이름</th><th>팀</th><th>Dialect</th><th>허용 테이블</th><th>동작</th></tr></thead><tbody>' + schemaRows + '</tbody></table>'
        : '<div class="empty">등록된 스키마 카탈로그 없음. 등록하면 프롬프트 컨텍스트와 테이블 허용목록(검증)에 사용됩니다. 클라이언트는 <code>X-Text2SQL-Schema-Name</code> 헤더로 선택할 수 있습니다.</div>';
      const logRows = (d.logs || []).map(l =>
        '<tr class="' + (l.valid ? '' : 'row-error') + '">' +
          '<td>' + ago(l.created_at) + '</td>' +
          '<td>' + escapeHTML(l.virtual_model) + '<div class="muted">→ ' + escapeHTML(l.upstream_model) + '</div></td>' +
          '<td>' + escapeHTML(l.mode) + '</td>' +
          '<td>' + escapeHTML((l.question || '').slice(0, 60)) + '</td>' +
          '<td>' + (l.valid ? '<span class="status">유효</span>' : '<span class="status error">' + escapeHTML(l.reject_reason || '거부') + '</span>') + (l.executed ? ' <span class="pill">실행 ' + fmt(l.row_count) + '행</span>' : '') + '</td>' +
          '<td><code style="font-size:11px">' + escapeHTML((l.generated_sql || '').slice(0, 120)) + '</code></td>' +
          '<td>' + money(l.cost_krw) + '</td>' +
          '<td><button class="secondary" type="button" onclick="openT2SSpans(\'' + escapeAttr(l.request_id || '') + '\')">Timeline</button></td>' +
        '</tr>'
      ).join('');
      const logTable = (d.logs || []).length ?
        '<table><thead><tr><th>시각</th><th>모델</th><th>모드</th><th>질문</th><th>검증</th><th>생성 SQL</th><th>비용</th><th>단계</th></tr></thead><tbody>' + logRows + '</tbody></table>'
        : '<div class="empty">Text2SQL 질의 기록 없음. 사용자가 <code>vibe/text2sql-preview</code> 모델로 <code>/v1/chat/completions</code> 를 호출하면 여기에 집계됩니다.</div>';
      const dbProfiles = d.db_profiles || [];
      const connsData = await api('/admin/text2sql/connections').catch(() => ({ connections: [] }));
      const conns = connsData.connections || [];
      const connOptHtml = '<option value="">(기본 ENV)</option>' + conns.map(c =>
        '<option value="' + escapeAttr(c.id) + '">' + escapeHTML(c.name) + (c.enabled ? '' : ' (중지)') + '</option>').join('');
      const dbpForm =
        '<form class="inline-form" id="t2s-profile-form" style="grid-template-columns: 170px 90px 130px 130px 110px 140px 70px; align-items:start;">' +
          '<input id="tp-model" placeholder="vibe/text2sql-finance" required>' +
          '<select id="tp-mode"><option value="preview">preview</option><option value="execute">execute</option></select>' +
          '<input id="tp-upstream" placeholder="업스트림 모델">' +
          '<input id="tp-summary" placeholder="요약 모델(선택)">' +
          '<input id="tp-schema" placeholder="스키마명(선택)">' +
          '<select id="tp-conn">' + connOptHtml + '</select>' +
          '<button type="submit">저장</button>' +
        '</form>';
      const dbpRows = dbProfiles.map(p =>
        '<tr><td><code>' + escapeHTML(p.virtual_model) + '</code>' + (p.enabled ? '' : ' <span class="status error">중지</span>') + '</td>' +
        '<td>' + escapeHTML(p.mode) + '</td><td>' + escapeHTML(p.upstream_model || '') + '</td>' +
        '<td>' + escapeHTML(p.summary_model || '') + '</td><td>' + escapeHTML(p.schema_name || '') + '</td>' +
        '<td>' + escapeHTML(p.exec_connection_id || '(기본)') + '</td>' +
        '<td><button class="danger" type="button" onclick="deleteT2SProfile(\'' + escapeAttr(p.virtual_model) + '\')">삭제</button></td></tr>'
      ).join('');
      const dbpTable = dbProfiles.length ?
        '<table><thead><tr><th>가상 모델</th><th>모드</th><th>업스트림</th><th>요약</th><th>스키마</th><th>실행DB</th><th>동작</th></tr></thead><tbody>' + dbpRows + '</tbody></table>'
        : '<div class="empty">런타임 프로필 없음. 등록하면 env 기본값을 오버라이드하거나 새 가상 모델(예: <code>vibe/text2sql-finance</code>)을 추가할 수 있습니다.</div>';
      const connsForm =
        '<form class="inline-form" id="t2s-conn-form" style="grid-template-columns: 120px 140px 90px minmax(200px,2fr) minmax(120px,1fr) 70px; align-items:start;">' +
          '<input id="tc-id" placeholder="ID (슬러그)" required>' +
          '<input id="tc-name" placeholder="표시 이름" required>' +
          '<select id="tc-driver" onchange="updateT2SDsnHint(this)"><option value="sqlite">SQLite</option><option value="postgres">PostgreSQL</option><option value="mysql">MySQL</option><option value="mariadb">MariaDB</option><option value="oracle">Oracle</option></select>' +
          '<input id="tc-dsn" type="password" placeholder="파일 경로 또는 :memory:" autocomplete="new-password">' +
          '<input id="tc-desc" placeholder="설명">' +
          '<button type="submit">저장</button>' +
        '</form>';
      const connsRows = conns.map(c =>
        '<tr><td><code>' + escapeHTML(c.id) + '</code>' + (c.enabled ? '' : ' <span class="status error">중지</span>') + '</td>' +
        '<td>' + escapeHTML(c.name) + '</td><td>' + escapeHTML(c.driver) + '</td>' +
        '<td>' + escapeHTML(c.description || '') + '</td>' +
        '<td><button type="button" onclick="t2sConnHealthcheck(\'' + escapeAttr(c.id) + '\')">헬스체크</button></td>' +
        '<td><button class="danger" type="button" onclick="deleteT2SConn(\'' + escapeAttr(c.id) + '\')">삭제</button></td></tr>'
      ).join('');
      const connsTable = conns.length
        ? '<table><thead><tr><th>ID</th><th>이름</th><th>드라이버</th><th>설명</th><th></th><th></th></tr></thead><tbody>' + connsRows + '</tbody></table>'
        : '<div class="empty">등록된 실행 DB 연결 없음. 추가하면 각 프로필이 특정 DB를 지정해 SQL을 실행할 수 있습니다. (미등록 시 env TEXT2SQL_EXEC_DSN 사용)</div>';
      const perms = d.permissions || [];
      const permForm =
        '<form class="inline-form" id="t2s-perm-form" style="grid-template-columns: 100px 130px 110px 110px 110px 90px 70px; align-items:start;">' +
          '<select id="tpm-subtype"><option value="team">team</option><option value="api_key">api_key</option><option value="user">user</option><option value="*">전체(*)</option></select>' +
          '<input id="tpm-subid" placeholder="subject id (* 가능)">' +
          '<input id="tpm-schema" placeholder="schema (*)">' +
          '<input id="tpm-table" placeholder="table (*)">' +
          '<input id="tpm-column" placeholder="column (*)">' +
          '<select id="tpm-action"><option value="deny">deny</option><option value="allow">allow</option></select>' +
          '<button type="submit">추가</button>' +
        '</form>';
      const permRows = perms.map(p =>
        '<tr><td>' + escapeHTML(p.subject_type) + '</td><td>' + escapeHTML(p.subject_id) + '</td>' +
        '<td>' + escapeHTML(p.schema_name) + '.' + escapeHTML(p.table_name) + '.' + escapeHTML(p.column_name) + '</td>' +
        '<td><span class="status ' + (p.action === 'deny' ? 'error' : '') + '">' + escapeHTML(p.action) + '</span></td>' +
        '<td><button class="danger" type="button" onclick="deleteT2SPermission(\'' + escapeAttr(p.id) + '\')">삭제</button></td></tr>'
      ).join('');
      const permTable = perms.length
        ? '<table><thead><tr><th>주체유형</th><th>주체ID</th><th>schema.table.column</th><th>동작</th><th></th></tr></thead><tbody>' + permRows + '</tbody></table>'
        : '<div class="empty">권한 규칙 없음. deny 규칙은 테이블/컬럼 접근을 제한하고, allow 규칙은 민감(exclude) 컬럼 접근을 특정 주체에 부여합니다.</div>';
      const failures = d.failures || [];
      const failTable = failures.length
        ? '<table><thead><tr><th>실패 분류</th><th data-sort="num">건수</th></tr></thead><tbody>' +
          failures.map(f => '<tr><td>' + escapeHTML(f.category) + '</td><td data-num="' + (f.count || 0) + '">' + fmt(f.count) + '</td></tr>').join('') + '</tbody></table>'
        : '<div class="empty">최근 7일 실패 없음.</div>';
      const mm = d.model_metrics || [];
      const mmTable = mm.length ?
        '<table><thead><tr><th>업스트림 모델</th><th data-sort="num">질의</th><th data-sort="num">유효율</th><th data-sort="num">실행</th><th data-sort="num">오류</th><th data-sort="num">평균비용</th><th data-sort="num">평균지연</th></tr></thead><tbody>' +
        mm.map(m => '<tr>' +
          '<td>' + escapeHTML(m.upstream_model) + '</td>' +
          '<td data-num="' + (m.total || 0) + '">' + fmt(m.total) + '</td>' +
          '<td data-num="' + (m.valid_rate || 0) + '">' + ((m.valid_rate || 0) * 100).toFixed(0) + '%</td>' +
          '<td data-num="' + (m.executed || 0) + '">' + fmt(m.executed) + '</td>' +
          '<td data-num="' + (m.errors || 0) + '">' + fmt(m.errors) + '</td>' +
          '<td data-num="' + (m.avg_cost_krw || 0) + '">' + money(m.avg_cost_krw) + '</td>' +
          '<td data-num="' + (m.avg_latency_ms || 0) + '">' + fmt(Math.round(m.avg_latency_ms || 0)) + 'ms</td>' +
        '</tr>').join('') + '</tbody></table>'
        : '<div class="empty">모델별 메트릭 없음.</div>';
      const stageMetrics = d.stage_metrics || [];
      const totalStageCost = stageMetrics.reduce((sum, m) => sum + Number(m.total_cost_krw || 0), 0) || 1;
      const stageTable = stageMetrics.length ?
        '<table><thead><tr><th>단계</th><th>상태</th><th>모델</th><th data-sort="num">횟수</th><th data-sort="num">오류율</th><th data-sort="num">평균지연</th><th data-sort="num">최대지연</th><th data-sort="num">총비용</th><th data-sort="num">비용비중</th></tr></thead><tbody>' +
        stageMetrics.map(m => {
          const pctCost = (Number(m.total_cost_krw || 0) / totalStageCost) * 100;
          return '<tr>' +
            '<td><strong>' + escapeHTML(m.stage || '') + '</strong></td>' +
            '<td><span class="status ' + governanceStatusClass(m.status || '') + '">' + escapeHTML(m.status || '') + '</span></td>' +
            '<td>' + escapeHTML(m.model || '-') + '</td>' +
            '<td data-num="' + Number(m.count || 0) + '">' + fmt(m.count || 0) + '</td>' +
            '<td data-num="' + Number(m.error_rate || 0) + '">' + (Number(m.error_rate || 0) * 100).toFixed(1) + '%</td>' +
            '<td data-num="' + Number(m.avg_latency_ms || 0) + '">' + fmt(Math.round(m.avg_latency_ms || 0)) + 'ms</td>' +
            '<td data-num="' + Number(m.max_latency_ms || 0) + '">' + fmt(m.max_latency_ms || 0) + 'ms</td>' +
            '<td data-num="' + Number(m.total_cost_krw || 0) + '">' + money(m.total_cost_krw || 0) + '</td>' +
            '<td data-num="' + pctCost.toFixed(2) + '">' + pctCost.toFixed(1) + '%</td>' +
          '</tr>';
        }).join('') + '</tbody></table>'
        : '<div class="empty">단계별 span 메트릭 없음. 신규 Text2SQL 요청부터 수집됩니다.</div>';
      const golden = d.golden || [];
      const goldenForm =
        '<form class="inline-form" id="t2s-golden-form" style="grid-template-columns: 130px minmax(160px,1fr) minmax(200px,2fr) 110px 70px; align-items:start;">' +
          '<input id="tg-name" placeholder="이름" required>' +
          '<textarea id="tg-question" rows="2" placeholder="자연어 질문" required style="resize:vertical"></textarea>' +
          '<textarea id="tg-sql" rows="2" placeholder="검증된 기대 SQL" required style="resize:vertical"></textarea>' +
          '<input id="tg-schema" placeholder="스키마명(선택)">' +
          '<button type="submit">저장</button>' +
        '</form>';
      const goldenRows = golden.map(g =>
        '<tr><td><strong>' + escapeHTML(g.name) + '</strong>' + (g.source === 'auto' ? ' <span class="pill">자동후보</span>' : '') + (g.enabled ? '' : ' <span class="status error">중지</span>') + '</td>' +
        '<td>' + escapeHTML((g.question || '').slice(0, 60)) + '</td>' +
        '<td><code style="font-size:11px">' + escapeHTML((g.expected_sql || '').slice(0, 80)) + '</code></td>' +
        '<td><button class="danger" type="button" onclick="deleteT2SGolden(\'' + escapeAttr(g.id) + '\')">삭제</button></td></tr>'
      ).join('');
      const goldenTable = golden.length ?
        '<table><thead><tr><th>이름</th><th>질문</th><th>기대 SQL</th><th>동작</th></tr></thead><tbody>' + goldenRows + '</tbody></table>'
        : '<div class="empty">Golden Query 없음. 등록하면 생성 프롬프트에 few-shot 예시로 주입되고, 회귀 검증에 사용됩니다.</div>';
      const goldenRun = '<div class="toolbar" style="border-bottom:0"><button type="button" id="t2s-golden-run">회귀 검증 실행</button><span class="muted" id="t2s-golden-run-result"></span></div>';
      const glossaryResp = await api('/admin/text2sql/glossary').catch(() => ({ terms: [], conflicts: [] }));
      const glossary = glossaryResp.terms || [];
      const glossConflicts = glossaryResp.conflicts || [];
      const glossConflictBanner = glossConflicts.length
        ? '<div class="status error" style="display:block;margin:0 14px 10px;padding:8px 10px">⚠ 용어 충돌 ' + glossConflicts.length + '건: ' +
          glossConflicts.map(c => escapeHTML(c.term) + ' (' + escapeHTML(c.kind) + ' → ' + escapeHTML((c.mappings || []).join(' | ')) + ')').join('; ') + '</div>'
        : '';
      const glossForm =
        '<form class="inline-form" id="t2s-gloss-form" style="grid-template-columns: 130px 150px minmax(200px,2fr) minmax(140px,1fr) 70px; align-items:start;">' +
          '<input id="tgl-schema" placeholder="스키마명(빈칸=전역)">' +
          '<input id="tgl-term" placeholder="업무 용어 (예: 활성 고객)" required>' +
          '<input id="tgl-mapping" placeholder="매핑 (예: users WHERE status=\'active\')" required>' +
          '<input id="tgl-desc" placeholder="설명(선택)">' +
          '<button type="submit">저장</button>' +
        '</form>';
      const glossRows = glossary.map(g =>
        '<tr><td><strong>' + escapeHTML(g.term) + '</strong></td>' +
        '<td><code style="font-size:11px">' + escapeHTML(g.mapping) + '</code></td>' +
        '<td>' + escapeHTML(g.description || '') + '</td>' +
        '<td>' + escapeHTML(g.schema_name === '*' ? '전역' : g.schema_name) + '</td>' +
        '<td><button class="danger" type="button" onclick="deleteT2SGloss(\'' + escapeAttr(g.id) + '\')">삭제</button></td></tr>'
      ).join('');
      const glossTable = glossary.length ?
        '<table><thead><tr><th>용어</th><th>매핑</th><th>설명</th><th>스키마</th><th></th></tr></thead><tbody>' + glossRows + '</tbody></table>'
        : '<div class="empty">업무 용어 사전 없음. 등록하면 사용자가 업무 언어로 질문할 때 매핑이 프롬프트에 주입됩니다.</div>';
      const featData = await api('/admin/text2sql/features').catch(() => ({ features: [] }));
      const killState = await api('/admin/text2sql/kill-switch').catch(() => ({ disabled: false }));
      const featRows = (featData.features || []).map(f =>
        '<tr><td><strong>' + escapeHTML(f.name) + '</strong><div class="muted">' + escapeHTML(f.description || '') + '</div></td>' +
        '<td><label class="switch"><input type="checkbox" onchange="toggleT2SFeature(\'' + escapeAttr(f.name) + '\', this.checked)"' + (f.enabled ? ' checked' : '') + '> ' + (f.enabled ? '<span class="status">ON</span>' : '<span class="muted">OFF</span>') + '</label></td></tr>'
      ).join('');
      const featTable = '<table><thead><tr><th>기능</th><th>상태</th></tr></thead><tbody>' +
        '<tr><td><strong>kill_switch</strong><div class="muted">Text2SQL 전체 즉시 중지 (장애·비용·보안 대응)</div></td>' +
        '<td><label class="switch"><input type="checkbox" onchange="toggleT2SKill(this.checked)"' + (killState.disabled ? ' checked' : '') + '> ' + (killState.disabled ? '<span class="status error">중지됨</span>' : '<span class="status">정상</span>') + '</label></td></tr>' +
        featRows + '</tbody></table>';
      const riskData = await api('/admin/text2sql/risk-queue?window=7d&min_risk=50').catch(() => ({ queue: [] }));
      const riskQ = riskData.queue || [];
      const riskRows = riskQ.map(e => {
        const l = e.log || e;
        const sugg = (e.suggestions || []);
        return '<tr class="' + (l.valid ? '' : 'row-error') + '">' +
          '<td>' + ago(l.created_at) + '</td>' +
          '<td>' + escapeHTML(l.team || '-') + '<div class="muted">' + escapeHTML(l.upstream_model || '') + '</div></td>' +
          '<td>' + escapeHTML(l.schema_name || '-') + (l.schema_version ? '<div class="muted">v' + l.schema_version + (l.permission_hash ? ' · perm ' + escapeHTML(l.permission_hash) : '') + '</div>' : '') + '</td>' +
          '<td>' + escapeHTML((l.question || '').slice(0, 50)) + '</td>' +
          '<td>' + (l.valid ? '<span class="status">유효</span>' : '<span class="status error">' + escapeHTML(l.reject_reason || '거부') + '</span>') + '</td>' +
          '<td>' + (l.failure_category ? '<span class="status error">' + escapeHTML(l.failure_category) + '</span>' : '-') + '</td>' +
          '<td data-num="' + (l.explain_risk || 0) + '">' + (l.explain_risk ? '<span class="status ' + (l.explain_risk >= 70 ? 'error' : 'warn') + '">' + l.explain_risk + '</span>' : '-') + '</td>' +
          '<td>' + (sugg.length ? '<ul style="margin:0;padding-left:16px">' + sugg.map(s => '<li>' + escapeHTML(s) + '</li>').join('') + '</ul>' : '<span class="muted">-</span>') + '</td>' +
        '</tr>';
      }).join('');
      const riskTable = riskQ.length ?
        '<table><thead><tr><th>시각</th><th>팀</th><th>스키마(버전)</th><th>질문</th><th>검증</th><th>실패분류</th><th data-sort="num">EXPLAIN 위험</th><th>개선 제안</th></tr></thead><tbody>' + riskRows + '</tbody></table>'
        : '<div class="empty">최근 7일 위험 요청 없음 (거부 · 고위험 EXPLAIN · 실패 분류 대상).</div>';
      const miners = await api('/admin/text2sql/miners?window=30d&min_count=3').catch(() => ({ report_candidates: [], glossary_candidates: [] }));
      const reportCand = (miners.report_candidates || []).slice(0, 15);
      const glossCand = (miners.glossary_candidates || []).slice(0, 20);
      const reportCandTable = reportCand.length
        ? '<table><thead><tr><th>반복 질문</th><th data-sort="num">횟수</th><th>추천 산출물</th><th></th></tr></thead><tbody>' +
          reportCand.map(c => '<tr><td>' + escapeHTML((c.question || '').slice(0, 70)) + '</td><td data-num="' + c.count + '">' + c.count + '</td>' +
          '<td><span class="pill">' + escapeHTML(c.recommended_product || 'report') + '</span></td>' +
          '<td><button type="button" onclick="promoteT2SReport(' + escapeAttr(JSON.stringify(c.question)) + ',' + escapeAttr(JSON.stringify(c.sample_sql || '')) + ')">리포트로 승격</button></td></tr>').join('') + '</tbody></table>'
        : '<div class="empty">반복 질문 후보 없음 (최근 30일, 3회 이상).</div>';
      const glossCandHTML = glossCand.length
        ? '<div style="padding:4px 14px 12px">' + glossCand.map(g => '<span class="pill">' + escapeHTML(g.term) + ' ×' + g.count + '</span> ').join('') + '</div>'
        : '<div class="empty">용어 후보 없음.</div>';
      const anomalies = await api('/admin/text2sql/anomalies?window=7d').catch(() => ({ usage_smells: [], risk_exposure: [], intent_drifts: [] }));
      const smells = anomalies.usage_smells || [];
      const smellTable = smells.length
        ? '<table><thead><tr><th>주체(api_key)</th><th>유형</th><th data-sort="num">횟수</th><th>예시</th></tr></thead><tbody>' +
          smells.map(s => '<tr><td><code>' + escapeHTML(s.subject) + '</code></td><td><span class="status warn">' + escapeHTML(s.category) + '</span></td><td data-num="' + s.count + '">' + s.count + '</td><td>' + escapeHTML((s.sample || '').slice(0, 50)) + '</td></tr>').join('') + '</tbody></table>'
        : '<div class="empty">이상 사용 신호 없음 (탐지 전용, 차단 안 함).</div>';
      const exposure = anomalies.risk_exposure || [];
      const exposureTable = exposure.length
        ? '<table><thead><tr><th>팀</th><th data-sort="num">총</th><th data-sort="num">거부</th><th data-sort="num">고위험</th><th data-sort="num">탐침</th><th data-sort="num">위험점수</th></tr></thead><tbody>' +
          exposure.map(e => '<tr><td>' + escapeHTML(e.team) + '</td><td data-num="' + e.total + '">' + e.total + '</td><td data-num="' + e.rejected + '">' + e.rejected + '</td><td data-num="' + e.high_risk + '">' + e.high_risk + '</td><td data-num="' + e.probes + '">' + e.probes + '</td><td data-num="' + e.risk_score + '"><strong>' + e.risk_score + '</strong></td></tr>').join('') + '</tbody></table>'
        : '';
      const drifts = anomalies.intent_drifts || [];
      const driftHTML = drifts.length
        ? '<div style="padding:4px 14px 12px" class="muted">의도 이동 감지: ' + drifts.map(d => escapeHTML(d.subject) + '(' + escapeHTML(d.reason) + ')').join(', ') + '</div>'
        : '';
      const repList = (await api('/admin/text2sql/reports').catch(() => ({ reports: [] }))).reports || [];
      const repRows = repList.map(r =>
        '<tr><td><strong>' + escapeHTML(r.name) + '</strong><div class="muted">' + escapeHTML((r.question || '').slice(0, 50)) + '</div></td>' +
        '<td>' + (r.schedule_enabled && r.schedule_interval ? '<span class="status">' + escapeHTML(r.schedule_interval) + '</span>' : '<span class="muted">수동</span>') + (r.deliver_mattermost ? ' <span class="pill">MM</span>' : '') + '</td>' +
        '<td>' + (r.last_run_at ? ago(r.last_run_at) : '-') + '</td>' +
        '<td><button class="danger" type="button" onclick="deleteT2SReport(\'' + escapeAttr(r.id) + '\')">삭제</button></td></tr>'
      ).join('');
      const repTable = repList.length
        ? '<table><thead><tr><th>리포트</th><th>스케줄</th><th>최근 실행</th><th></th></tr></thead><tbody>' + repRows + '</tbody></table>'
        : '<div class="empty">저장 리포트 없음. 반복 질문을 "리포트로 승격"하면 여기에 표시되고 스케줄 실행할 수 있습니다.</div>';
      document.getElementById('view').innerHTML =
        '<section><h2>Text2SQL</h2><div style="padding:0 14px 8px" class="muted">자연어 질문을 읽기 전용 SQL로 변환합니다. 사용자는 <code>vibe/text2sql-*</code> 가상 모델을 호출하고, 게이트웨이가 내부적으로 실제 업스트림 모델을 선택해 SQL을 생성·검증·(선택)실행합니다.</div></section>' +
        section('요약 (최근 7일)', kpis) +
        section('가상 모델 프로필 (기본)', profileTable) +
        section('런타임 프로필 (DB 오버라이드 · 신규 가상모델)', dbpForm + dbpTable) +
        section('실행 DB 연결 관리', connsForm + connsTable) +
        section('모델별 SQL 품질 (최근 7일)', mmTable) +
        section('단계별 비용·지연 분석 (최근 7일)', stageTable) +
        section('스키마 카탈로그 · 테이블 권한', schemaForm + schemaTable) +
        section('스키마 레지스트리 (테이블 · 컬럼 · 민감도)', registryHTML(conns)) +
        section('권한 매트릭스 (subject × schema/table/column)', permForm + permTable) +
        section('실패 원인 분류 (최근 7일)', failTable) +
        section('기능 토글 (런타임 온오프)', featTable) +
        section('관리자 위험 요청 큐 (거부 · 고위험 EXPLAIN · 실패)', riskTable) +
        section('업무 용어 사전 (자연어 → SQL 매핑)', glossConflictBanner + glossForm + glossTable) +
        section('저장 리포트 (스케줄 실행)', repTable) +
        section('인사이트 — 반복 질문 리포트 후보', reportCandTable) +
        section('인사이트 — 업무 용어 후보', glossCandHTML) +
        section('행동 이상 탐지 (탐지 전용)', smellTable + exposureTable + driftHTML) +
        section('Golden Query (few-shot · 회귀)', goldenRun + goldenForm + goldenTable) +
        section('최근 Text2SQL 질의', logTable);
      const sf = document.getElementById('t2s-schema-form');
      if (sf) sf.addEventListener('submit', addT2SSchema);
      const rtf = document.getElementById('t2s-table-form');
      if (rtf) rtf.addEventListener('submit', addT2STable);
      const rcf = document.getElementById('t2s-column-form');
      if (rcf) rcf.addEventListener('submit', addT2SColumn);
      const rlBtn = document.getElementById('t2s-registry-load');
      if (rlBtn) rlBtn.addEventListener('click', loadT2SRegistry);
      const rcBtn = document.getElementById('t2s-registry-collect');
      if (rcBtn) rcBtn.addEventListener('click', collectT2SRegistry);
      const reBtn = document.getElementById('t2s-registry-export');
      if (reBtn) reBtn.addEventListener('click', exportT2SRegistry);
      const riFile = document.getElementById('t2s-registry-import-file');
      if (riFile) riFile.addEventListener('change', importT2SRegistry);
      const cf2 = document.getElementById('t2s-conn-form');
      if (cf2) cf2.addEventListener('submit', addT2SConn);
      const pf = document.getElementById('t2s-profile-form');
      if (pf) pf.addEventListener('submit', addT2SProfile);
      const pmf = document.getElementById('t2s-perm-form');
      if (pmf) pmf.addEventListener('submit', addT2SPermission);
      const gf = document.getElementById('t2s-golden-form');
      if (gf) gf.addEventListener('submit', addT2SGolden);
      const gr = document.getElementById('t2s-golden-run');
      if (gr) gr.addEventListener('click', runT2SGolden);
      const glf = document.getElementById('t2s-gloss-form');
      if (glf) glf.addEventListener('submit', addT2SGloss);
      makeSortable('#view', 'text2sql');
    }
    window.promoteT2SReport = async (question, sql) => {
      const name = prompt('리포트 이름을 입력하세요', (question || '').slice(0, 40));
      if (!name) return;
      try {
        await api('/admin/text2sql/promote', { method: 'POST', body: JSON.stringify({ target: 'report', name, question, sql }) });
      } catch (err) { alert('승격 실패: ' + err.message); }
      route();
    };
    window.deleteT2SReport = async (id) => {
      if (!confirm('이 저장 리포트를 삭제하시겠습니까?')) return;
      await api('/admin/text2sql/reports?id=' + encodeURIComponent(id), { method: 'DELETE' });
      route();
    };
    window.openT2SSpans = async (requestID) => {
      if (!requestID) {
        openModal('Text2SQL Timeline', '<div class="empty">request_id가 없는 오래된 로그입니다.</div>');
        return;
      }
      openModal('Text2SQL Timeline — ' + requestID, '<div class="empty">조회 중...</div>');
      try {
        const d = await api('/admin/text2sql/spans?request_id=' + encodeURIComponent(requestID));
        const spans = d.spans || [];
        const rows = spans.map((s, idx) => '<tr>' +
          '<td data-num="' + idx + '">' + (idx + 1) + '</td>' +
          '<td><strong>' + escapeHTML(s.stage || '') + '</strong><div class="muted">' + escapeHTML(s.model || '') + '</div></td>' +
          '<td><span class="status ' + governanceStatusClass(s.status || '') + '">' + escapeHTML(s.status || '') + '</span>' + (s.reject_reason ? '<div class="muted">' + escapeHTML(s.reject_reason) + '</div>' : '') + '</td>' +
          '<td data-num="' + Number(s.latency_ms || 0) + '">' + fmt(s.latency_ms || 0) + ' ms</td>' +
          '<td data-num="' + Number(s.cost_krw || 0) + '">' + money(s.cost_krw || 0) + '</td>' +
          '<td><code style="font-size:11px">' + escapeHTML(s.input_hash || '') + '</code><div class="muted"><code>' + escapeHTML(s.output_hash || '') + '</code></div></td>' +
          '<td><pre class="prompt-block" style="max-height:120px;overflow:auto;margin:0">' + escapeHTML(prettyJSON(s.detail || '')) + '</pre></td>' +
        '</tr>').join('');
        const totalLatency = spans.reduce((sum, s) => sum + Number(s.latency_ms || 0), 0);
        const totalCost = spans.reduce((sum, s) => sum + Number(s.cost_krw || 0), 0);
        openModal('Text2SQL Timeline — ' + escapeHTML(requestID),
          '<div class="kv">' +
            row('Request', escapeHTML(requestID)) +
            row('Stages', fmt(spans.length)) +
            row('Span Latency Sum', fmt(totalLatency) + ' ms') +
            row('Span Cost Sum', money(totalCost)) +
          '</div>' +
          (spans.length ? '<table><thead><tr><th>#</th><th>Stage</th><th>Status</th><th>Latency</th><th>Cost</th><th>Hashes</th><th>Detail</th></tr></thead><tbody>' + rows + '</tbody></table>' : '<div class="empty">저장된 span 없음.</div>'));
      } catch (err) {
        openModal('Text2SQL Timeline 오류', '<div class="error-line">' + escapeHTML(err.message) + '</div>');
      }
    };
    function prettyJSON(raw) {
      if (!raw) return '';
      try { return JSON.stringify(JSON.parse(raw), null, 2); } catch (_) { return raw; }
    }
    window.toggleT2SFeature = async (name, enabled) => {
      try {
        await api('/admin/text2sql/features', { method: 'POST', body: JSON.stringify({ name, enabled }) });
      } catch (err) { alert('토글 실패: ' + err.message); }
      route();
    };
    window.toggleT2SKill = async (disabled) => {
      if (disabled && !confirm('Text2SQL 전체를 중지하시겠습니까? 모든 vibe/text2sql-* 요청이 안전 메시지를 반환합니다.')) { route(); return; }
      try {
        await api('/admin/text2sql/kill-switch', { method: 'POST', body: JSON.stringify({ disabled }) });
      } catch (err) { alert('변경 실패: ' + err.message); }
      route();
    };
    async function addT2SGloss(e) {
      e.preventDefault();
      const body = {
        schema_name: document.getElementById('tgl-schema').value.trim(),
        term: document.getElementById('tgl-term').value.trim(),
        mapping: document.getElementById('tgl-mapping').value.trim(),
        description: document.getElementById('tgl-desc').value.trim(),
      };
      if (!body.term || !body.mapping) { alert('용어와 매핑을 입력하세요'); return; }
      await api('/admin/text2sql/glossary', { method: 'POST', body: JSON.stringify(body) });
      route();
    }
    window.deleteT2SGloss = async (id) => {
      if (!confirm('이 업무 용어를 삭제하시겠습니까?')) return;
      await api('/admin/text2sql/glossary?id=' + encodeURIComponent(id), { method: 'DELETE' });
      route();
    };
    function registryHTML(conns) {
      const connOpts = '<option value="">(기본 ENV)</option>' + (conns || []).map(c =>
        '<option value="' + escapeAttr(c.id) + '">' + escapeHTML(c.name) + (c.enabled ? '' : ' (중지)') + '</option>').join('');
      return '<div class="muted" style="padding:10px 14px 6px;font-size:12px;line-height:1.5">' +
        '<strong>스키마 레지스트리란?</strong> 프록시 내부 DB에 저장된 테이블·컬럼 목록입니다. Text2SQL이 SQL 생성 시 이 목록을 참조합니다.<br>' +
        '<strong>레지스트리 불러오기</strong> — 내부 레지스트리(프록시 DB)에 등록된 테이블·컬럼을 화면에 표시합니다.<br>' +
        '<strong>실행DB에서 자동 수집</strong> — 아래 "수집 DB 선택"에서 고른 실행 DB의 <code>information_schema</code>를 읽어 테이블·컬럼을 자동으로 레지스트리에 추가합니다.<br>' +
        '<strong>JSON 내보내기</strong> — 현재 스키마(또는 전체)를 JSON 파일로 저장합니다. <strong>JSON 가져오기</strong> — JSON 파일로 일괄 등록합니다. <strong>샘플 JSON</strong> — 가져오기 형식 예시를 다운로드합니다.</div>' +
        '<div class="toolbar" style="border-bottom:0;flex-wrap:wrap;gap:6px">' +
        '<input id="t2s-reg-schema" placeholder="스키마명 (예: analytics, 비우면 전체)" style="max-width:220px">' +
        '<button type="button" id="t2s-registry-load">레지스트리 불러오기</button>' +
        '<select id="t2s-collect-conn" style="max-width:160px" title="자동 수집 시 사용할 실행 DB">' + connOpts + '</select>' +
        '<button type="button" class="secondary" id="t2s-registry-collect">실행DB에서 자동 수집</button>' +
        '<button type="button" class="secondary" id="t2s-registry-export">JSON 내보내기</button>' +
        '<label class="secondary" style="cursor:pointer;display:inline-flex;align-items:center;padding:0 10px;height:32px;border-radius:4px;border:1px solid var(--border);font-size:13px">' +
        'JSON 가져오기<input type="file" id="t2s-registry-import-file" accept=".json" style="display:none"></label>' +
        '<button type="button" class="secondary" onclick="downloadT2SSample()">샘플 JSON</button>' +
        '<span class="muted" id="t2s-collect-result"></span></div>' +
        '<form class="inline-form" id="t2s-table-form" style="grid-template-columns: 140px minmax(220px,2fr) 70px; align-items:start;">' +
          '<input id="rt-table" placeholder="테이블명" required>' +
          '<input id="rt-desc" placeholder="테이블 업무 설명">' +
          '<button type="submit">테이블 저장</button>' +
        '</form>' +
        '<form class="inline-form" id="t2s-column-form" style="grid-template-columns: 130px 130px 100px minmax(160px,2fr) 110px 70px; align-items:start;">' +
          '<input id="rc-table" placeholder="테이블명" required>' +
          '<input id="rc-column" placeholder="컬럼명" required>' +
          '<input id="rc-type" placeholder="타입">' +
          '<input id="rc-desc" placeholder="컬럼 업무 설명">' +
          '<select id="rc-sens"><option value="normal">일반</option><option value="mask">마스킹</option><option value="aggregate_only">집계만 허용</option><option value="approval_required">승인 필요</option><option value="exclude">제외(민감)</option></select>' +
          '<button type="submit">컬럼 저장</button>' +
        '</form>' +
        '<div id="t2s-registry-body"><div class="muted" style="padding:0 14px 12px">스키마명을 입력하고 "불러오기"를 누르면 등록된 테이블·컬럼이 표시됩니다. <code>exclude</code> 컬럼은 LLM 컨텍스트에서 제외되고 SQL에서 참조 시 차단됩니다.</div></div>';
    }
    function t2sRegSchema() { return (document.getElementById('t2s-reg-schema') || {}).value ? document.getElementById('t2s-reg-schema').value.trim() : ''; }
    async function loadT2SRegistry() {
      const schema = t2sRegSchema();
      const body = document.getElementById('t2s-registry-body');
      if (!schema) { alert('스키마명을 입력하세요'); return; }
      const d = await api('/admin/text2sql/tables?schema=' + encodeURIComponent(schema)).catch(() => ({ tables: [], columns: [] }));
      const colsByTable = {};
      (d.columns || []).forEach(c => { (colsByTable[c.table_name] = colsByTable[c.table_name] || []).push(c); });
      const sens = (s) => ({ normal: '일반', mask: '<span class="status warn">마스킹</span>', aggregate_only: '<span class="status warn">집계만</span>', approval_required: '<span class="status error">승인필요</span>', exclude: '<span class="status error">제외</span>' }[s] || s);
      const rows = (d.tables || []).map(t =>
        '<tr><td><strong>' + escapeHTML(t.table_name) + '</strong>' + (t.enabled ? '' : ' <span class="status error">중지</span>') + '<div class="muted">' + escapeHTML(t.description || '') + '</div></td>' +
        '<td>' + ((colsByTable[t.table_name] || []).map(c => escapeHTML(c.column_name) + (c.sensitivity !== 'normal' ? ' ' + sens(c.sensitivity) : '')).join(', ') || '<span class="muted">컬럼 없음</span>') + '</td>' +
        '<td><button class="danger" type="button" onclick="deleteT2STable(\'' + escapeAttr(schema) + '\',\'' + escapeAttr(t.table_name) + '\')">삭제</button></td></tr>'
      ).join('');
      body.innerHTML = (d.tables || []).length
        ? '<table><thead><tr><th>테이블</th><th>컬럼(민감도)</th><th>동작</th></tr></thead><tbody>' + rows + '</tbody></table>'
        : '<div class="empty">' + escapeHTML(schema) + ' 스키마에 등록된 테이블 없음.</div>';
    }
    async function collectT2SRegistry() {
      const schema = t2sRegSchema();
      const el = document.getElementById('t2s-collect-result');
      const connEl = document.getElementById('t2s-collect-conn');
      const connID = connEl ? connEl.value : '';
      if (!schema) { alert('스키마명을 입력하세요'); return; }
      if (el) el.textContent = ' 수집 중…';
      try {
        const payload = { schema_name: schema };
        if (connID) payload.connection_id = connID;
        const res = await api('/admin/text2sql/collect', { method: 'POST', body: JSON.stringify(payload) });
        if (el) el.textContent = ' 테이블 ' + res.added_tables + ' · 컬럼 ' + res.added_columns + ' 추가';
        loadT2SRegistry();
      } catch (err) {
        if (el) el.textContent = ' 실패: ' + err.message;
      }
    }
    async function exportT2SRegistry() {
      const schema = t2sRegSchema();
      const el = document.getElementById('t2s-collect-result');
      if (el) el.textContent = ' 내보내는 중…';
      try {
        const qs = schema ? '?schema=' + encodeURIComponent(schema) : '';
        const d = await api('/admin/text2sql/registry/export' + qs);
        const blob = new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 't2s-registry' + (schema ? '-' + schema : '') + '.json';
        a.click();
        URL.revokeObjectURL(url);
        if (el) el.textContent = ' 내보내기 완료 (테이블 ' + (d.tables || []).length + '개, 컬럼 ' + (d.columns || []).length + '개)';
      } catch (err) {
        if (el) el.textContent = ' 내보내기 실패: ' + err.message;
      }
    }
    async function importT2SRegistry(e) {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      const el = document.getElementById('t2s-collect-result');
      if (el) el.textContent = ' 가져오는 중…';
      try {
        const text = await file.text();
        const bundle = JSON.parse(text);
        const body = { tables: bundle.tables || [], columns: bundle.columns || [] };
        const res = await api('/admin/text2sql/registry/import', { method: 'POST', body: JSON.stringify(body) });
        if (el) el.textContent = ' 가져오기 완료 — 테이블 ' + res.tables_imported + '개, 컬럼 ' + res.columns_imported + '개 등록' +
          (res.table_errors + res.column_errors > 0 ? ' (오류 ' + (res.table_errors + res.column_errors) + '건)' : '');
        e.target.value = '';
        loadT2SRegistry();
      } catch (err) {
        if (el) el.textContent = ' 가져오기 실패: ' + err.message;
        e.target.value = '';
      }
    }
    async function addT2STable(e) {
      e.preventDefault();
      const schema = t2sRegSchema();
      if (!schema) { alert('스키마명을 먼저 입력하세요'); return; }
      await api('/admin/text2sql/tables', { method: 'POST', body: JSON.stringify({ schema_name: schema, table_name: document.getElementById('rt-table').value.trim(), description: document.getElementById('rt-desc').value.trim() }) });
      loadT2SRegistry();
    }
    async function addT2SColumn(e) {
      e.preventDefault();
      const schema = t2sRegSchema();
      if (!schema) { alert('스키마명을 먼저 입력하세요'); return; }
      await api('/admin/text2sql/columns', { method: 'POST', body: JSON.stringify({ schema_name: schema, table_name: document.getElementById('rc-table').value.trim(), column_name: document.getElementById('rc-column').value.trim(), data_type: document.getElementById('rc-type').value.trim(), description: document.getElementById('rc-desc').value.trim(), sensitivity: document.getElementById('rc-sens').value }) });
      loadT2SRegistry();
    }
    window.deleteT2STable = async (schema, table) => {
      if (!confirm(table + ' 테이블을 삭제하시겠습니까? (컬럼도 함께 삭제)')) return;
      await api('/admin/text2sql/tables?schema=' + encodeURIComponent(schema) + '&table=' + encodeURIComponent(table), { method: 'DELETE' });
      loadT2SRegistry();
    };
    async function addT2SPermission(e) {
      e.preventDefault();
      const body = {
        subject_type: document.getElementById('tpm-subtype').value,
        subject_id: document.getElementById('tpm-subid').value.trim(),
        schema_name: document.getElementById('tpm-schema').value.trim(),
        table_name: document.getElementById('tpm-table').value.trim(),
        column_name: document.getElementById('tpm-column').value.trim(),
        action: document.getElementById('tpm-action').value,
      };
      if (body.subject_type !== '*' && !body.subject_id) { alert('subject id를 입력하세요'); return; }
      await api('/admin/text2sql/permissions', { method: 'POST', body: JSON.stringify(body) });
      route();
    }
    window.deleteT2SPermission = async (id) => {
      if (!confirm('이 권한 규칙을 삭제하시겠습니까?')) return;
      await api('/admin/text2sql/permissions?id=' + encodeURIComponent(id), { method: 'DELETE' });
      route();
    };
    async function addT2SProfile(e) {
      e.preventDefault();
      const body = {
        virtual_model: document.getElementById('tp-model').value.trim(),
        mode: document.getElementById('tp-mode').value,
        upstream_model: document.getElementById('tp-upstream').value.trim(),
        summary_model: document.getElementById('tp-summary').value.trim(),
        schema_name: document.getElementById('tp-schema').value.trim(),
        exec_connection_id: document.getElementById('tp-conn').value,
      };
      if (!body.virtual_model) { alert('가상 모델명을 입력하세요'); return; }
      await api('/admin/text2sql/profiles', { method: 'POST', body: JSON.stringify(body) });
      route();
    }
    window.deleteT2SProfile = async (vm) => {
      if (!confirm(vm + ' 프로필을 삭제하시겠습니까?')) return;
      await api('/admin/text2sql/profiles?virtual_model=' + encodeURIComponent(vm), { method: 'DELETE' });
      route();
    };
    window.updateT2SDsnHint = (sel) => {
      const hints = {
        sqlite: '파일 경로 또는 :memory:',
        postgres: 'host=... user=... dbname=... password=... sslmode=disable',
        mysql: 'user:password@tcp(host:3306)/dbname',
        mariadb: 'user:password@tcp(host:3306)/dbname',
        oracle: 'oracle://user:password@host:1521/service',
      };
      const el = document.getElementById('tc-dsn');
      if (el) el.placeholder = hints[sel.value] || 'DSN';
    };
    async function addT2SConn(e) {
      e.preventDefault();
      const body = {
        id: document.getElementById('tc-id').value.trim(),
        name: document.getElementById('tc-name').value.trim(),
        driver: document.getElementById('tc-driver').value,
        dsn: document.getElementById('tc-dsn').value,
        description: document.getElementById('tc-desc').value.trim(),
        enabled: true,
      };
      if (!body.id || !body.name) { alert('ID와 이름을 입력하세요'); return; }
      try {
        await api('/admin/text2sql/connections', { method: 'POST', body: JSON.stringify(body) });
        route();
      } catch (err) { alert('저장 실패: ' + err.message); }
    }
    window.deleteT2SConn = async (id) => {
      if (!confirm(id + ' 연결을 삭제하시겠습니까?')) return;
      await api('/admin/text2sql/connections?id=' + encodeURIComponent(id), { method: 'DELETE' });
      route();
    };
    window.t2sConnHealthcheck = async (connID) => {
      const qs = connID ? '?connection_id=' + encodeURIComponent(connID) : '';
      try {
        const res = await api('/admin/text2sql/healthcheck' + qs);
        alert('헬스체크 결과 (' + escapeHTML(connID || '기본') + '):\n상태: ' + (res.status || '-') + '\n' + (res.detail || ''));
      } catch (err) { alert('헬스체크 실패: ' + err.message); }
    };
    function downloadT2SSample() {
      const sample = {
        version: 1,
        tables: [
          { schema_name: "analytics", table_name: "orders", description: "주문 테이블", enabled: true },
          { schema_name: "analytics", table_name: "customers", description: "고객 테이블", enabled: true }
        ],
        columns: [
          { schema_name: "analytics", table_name: "orders", column_name: "order_id", data_type: "bigint", description: "주문 고유 ID", sensitivity: "normal" },
          { schema_name: "analytics", table_name: "orders", column_name: "customer_id", data_type: "bigint", description: "고객 ID", sensitivity: "normal" },
          { schema_name: "analytics", table_name: "orders", column_name: "amount", data_type: "decimal", description: "주문 금액(원)", sensitivity: "normal" },
          { schema_name: "analytics", table_name: "orders", column_name: "phone", data_type: "text", description: "고객 전화번호", sensitivity: "mask" },
          { schema_name: "analytics", table_name: "customers", column_name: "id", data_type: "bigint", description: "고객 ID", sensitivity: "normal" },
          { schema_name: "analytics", table_name: "customers", column_name: "email", data_type: "text", description: "이메일 주소", sensitivity: "exclude" }
        ]
      };
      const blob = new Blob([JSON.stringify(sample, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 't2s-registry-sample.json'; a.click();
      URL.revokeObjectURL(url);
    }
    async function addT2SGolden(e) {
      e.preventDefault();
      const body = {
        name: document.getElementById('tg-name').value.trim(),
        question: document.getElementById('tg-question').value,
        expected_sql: document.getElementById('tg-sql').value,
        schema_name: document.getElementById('tg-schema').value.trim(),
      };
      if (!body.name || !body.question.trim() || !body.expected_sql.trim()) { alert('이름·질문·기대 SQL을 입력하세요'); return; }
      await api('/admin/text2sql/golden', { method: 'POST', body: JSON.stringify(body) });
      route();
    }
    window.deleteT2SGolden = async (id) => {
      if (!confirm('이 Golden Query를 삭제하시겠습니까?')) return;
      await api('/admin/text2sql/golden?id=' + encodeURIComponent(id), { method: 'DELETE' });
      route();
    };
    async function runT2SGolden() {
      const el = document.getElementById('t2s-golden-run-result');
      if (el) el.textContent = ' 실행 중…';
      try {
        const res = await api('/admin/text2sql/golden/run', { method: 'POST', body: JSON.stringify({}) });
        if (el) el.textContent = ' 통과 ' + res.passed + '/' + res.total + ' (' + Math.round((res.pass_rate || 0) * 100) + '%)';
      } catch (err) {
        if (el) el.textContent = ' 실패: ' + err.message;
      }
    }
    async function addT2SSchema(e) {
      e.preventDefault();
      const tables = document.getElementById('t2s-tables').value.split(',').map(x => x.trim()).filter(Boolean);
      const body = {
        name: document.getElementById('t2s-name').value.trim(),
        team: document.getElementById('t2s-team').value.trim(),
        dialect: document.getElementById('t2s-dialect').value.trim(),
        schema_text: document.getElementById('t2s-schema').value,
        allowed_tables: tables,
      };
      if (!body.name || !body.schema_text.trim()) { alert('이름과 스키마를 입력하세요'); return; }
      await api('/admin/text2sql/schemas', { method: 'POST', body: JSON.stringify(body) });
      route();
    }
    window.deleteT2SSchema = async (name) => {
      if (!confirm(name + ' 스키마를 삭제하시겠습니까?')) return;
      await api('/admin/text2sql/schemas?name=' + encodeURIComponent(name), { method: 'DELETE' });
      route();
    };

    async function renderSystemErrors() {
      const resp = await api('/admin/system-errors').catch(() => ({ errors: [] }));
      const list = resp.errors || [];
      let tableHtml = '';
      if (!list.length) {
        tableHtml = '<div class="empty">기록된 시스템 오류가 없습니다.</div>';
      } else {
        tableHtml =
          '<table>' +
            '<thead>' +
              '<tr>' +
                '<th style="width:180px;">발생 시간</th>' +
                '<th style="width:120px;">컴포넌트</th>' +
                '<th>에러 메시지</th>' +
              '</tr>' +
            '</thead>' +
            '<tbody>' +
              list.map(err =>
                '<tr>' +
                  '<td class="muted">' + escapeHTML(err.created_at) + '</td>' +
                  '<td><span class="badge" style="background:var(--pill-bg); padding:2px 6px; border-radius:4px; font-size:11px;">' + escapeHTML(err.component) + '</span></td>' +
                  '<td><pre style="white-space:pre-wrap; margin:0; font-family:ui-monospace,SFMono-Regular,Consolas,monospace; font-size:12px; color:var(--ink);">' + escapeHTML(err.error_message) + '</pre></td>' +
                '</tr>'
              ).join('') +
            '</tbody>' +
          '</table>';
      }
      const html =
        '<div class="grid1">' +
          card('시스템 오류 로그 (System Errors)',
            '<div style="display:flex; justify-content:space-between; align-items:center; margin-top:8px; margin-bottom:16px;">' +
              '<p class="muted" style="margin:0; padding-left:4px;">PostgreSQL/SQLite DB 적재 및 비동기 워커 실행 중 발생한 최신 시스템 오류 로그를 표시합니다.</p>' +
              (list.length ? '<button id="clear-errors-btn" class="error" style="background:#dc2626; color:#fff; border:none; padding:6px 12px; border-radius:4px; cursor:pointer;">전체 비우기</button>' : '') +
            '</div>' +
            tableHtml
          ) +
        '</div>';
      document.getElementById('view').innerHTML = html;
      const clearBtn = document.getElementById('clear-errors-btn');
      if (clearBtn) {
        clearBtn.addEventListener('click', async () => {
          if (confirm('모든 시스템 오류 로그를 삭제하시겠습니까?')) {
            await api('/admin/system-errors/clear', { method: 'POST' });
            route();
          }
        });
      }
    }

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
      const templates = await api('/admin/templates').catch(() => ({ templates: [], categories: [] }));
      const slo = await api('/admin/providers/slo').catch(() => ({ slos: [], evaluations: [] }));
      // Role dropdown options: all built-in + custom roles (kept in sync with the server role
      // catalog) so e.g. security_admin / readonly_admin / custom roles are assignable.
      const rolesResp = await api('/admin/roles').catch(() => ({ roles: [] }));
      const roleOptions = (rolesResp.roles || []).map(r => r.role).filter(Boolean);

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
        section('로그인 계정 · 팀 (RBAC)', authAccountsPanel(usersResp.auth_users || [], teamsResp.auth_teams || [], authEvents.events || [], roleOptions)) +
        section('복잡도 기반 비용 최적 라우팅 규칙', routingRulesPanel(routes.rules || [])) +
        section('라우팅 학습 추천 (Routing Learning)', routingLearningPanel(learning)) +
        section('Knowledge Cache (반복 규칙·시스템 프롬프트 중앙 등록)', knowledgePanel(knowledge.snippets || [])) +
        section('AI 코딩 작업 템플릿 (리팩터링·테스트·보안·문서화)', templatesPanel(templates.templates || [], templates.categories || [])) +
        section('Provider SLO 관리', providerSLOPanel(slo.slos || [], slo.evaluations || [])) +
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
      const tplForm = document.getElementById('template-form');
      if (tplForm) tplForm.addEventListener('submit', addTemplate);
      const sloForm = document.getElementById('slo-form');
      if (sloForm) sloForm.addEventListener('submit', addProviderSLO);
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
    const authRoleOptionsFallback = ['developer', 'viewer', 'team_admin', 'admin', 'super_admin', 'service_account'];
    function authAccountsPanel(users, teams, events, roleOptions) {
      const authRoleOptions = (roleOptions && roleOptions.length) ? roleOptions : authRoleOptionsFallback;
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
    function templatesPanel(templates, categories) {
      const cats = (categories && categories.length) ? categories : [{ key: 'custom', label: '기타' }];
      const catLabel = (key) => { const c = cats.find(x => x.key === key); return c ? c.label : key; };
      const options = cats.map(c => '<option value="' + escapeAttr(c.key) + '">' + escapeHTML(c.label) + '</option>').join('');
      const form =
        '<form class="inline-form" id="template-form" style="grid-template-columns: minmax(120px,1fr) 130px minmax(220px,2fr) 70px; align-items:start;">' +
          '<input id="tpl-name" placeholder="이름 (예: 보안 점검)" required>' +
          '<select id="tpl-category">' + options + '</select>' +
          '<textarea id="tpl-body" rows="3" placeholder="표준 프롬프트 본문" required style="resize:vertical"></textarea>' +
          '<button type="submit">등록</button>' +
        '</form>';
      const table = templates.length ?
        '<table><thead><tr><th>이름 / ID</th><th data-sort="str">분류</th><th data-sort="num">사용</th><th data-sort="str">최근</th><th>상태</th><th>동작</th></tr></thead><tbody>' +
        templates.map(t => '<tr>' +
          '<td><strong>' + escapeHTML(t.name) + '</strong><div class="muted">' + escapeHTML(t.id) + (t.description ? ' · ' + escapeHTML(t.description) : '') + '</div></td>' +
          '<td><span class="status">' + escapeHTML(catLabel(t.category)) + '</span></td>' +
          '<td data-num="' + (t.use_count || 0) + '">' + fmt(t.use_count || 0) + '</td>' +
          '<td>' + (t.last_used_at ? ago(t.last_used_at) : '<span class="muted">미사용</span>') + '</td>' +
          '<td><span class="status ' + (t.enabled ? '' : 'error') + '">' + (t.enabled ? '사용' : '중지') + '</span></td>' +
          '<td><button class="secondary" type="button" onclick="toggleTemplate(\'' + escapeAttr(t.id) + '\',' + (!t.enabled) + ')">' + (t.enabled ? '중지' : '사용') + '</button> ' +
          '<button class="danger" type="button" onclick="deleteTemplate(\'' + escapeAttr(t.id) + '\')">삭제</button></td>' +
        '</tr>').join('') + '</tbody></table>'
        : '<div class="empty">등록된 템플릿 없음.</div>';
      return form + table +
        '<div class="muted" style="font-size:12px; padding:0 14px 12px">리팩터링·테스트 생성·보안 점검·문서화 등 표준 프롬프트를 중앙에서 관리합니다. <code>GET /admin/templates</code> 로 조회해 코딩 도구·스니펫에 배포하세요.</div>';
    }
    function providerSLOPanel(slos, evaluations) {
      const evalByProvider = {};
      (evaluations || []).forEach(e => { evalByProvider[e.provider] = e; });
      const form =
        '<form class="inline-form" id="slo-form" style="grid-template-columns: minmax(110px,1fr) 100px 110px 100px 110px 70px; align-items:start;">' +
          '<input id="slo-provider" placeholder="provider (예: openai)" required>' +
          '<input id="slo-availability" type="number" step="0.001" min="0" max="1" placeholder="가용성 0.99">' +
          '<input id="slo-p95" type="number" min="0" placeholder="P95 ms">' +
          '<input id="slo-error" type="number" step="0.001" min="0" max="1" placeholder="오류율 0.02">' +
          '<input id="slo-fallback" type="number" step="0.001" min="0" max="1" placeholder="fallback 0.05">' +
          '<button type="submit">저장</button>' +
        '</form>';
      const metricCell = (m) => {
        if (!m || !m.enforced) return '<span class="muted">—</span>';
        const cls = m.breached ? 'error' : '';
        return '<span class="status ' + cls + '">' + (m.actual != null ? Number(m.actual).toFixed(3) : '?') + ' / ' + Number(m.target).toFixed(3) + '</span>';
      };
      const rows = slos.map(s => {
        const ev = evalByProvider[s.provider] || { metrics: {}, requests: 0, breached: false };
        const m = ev.metrics || {};
        return '<tr>' +
          '<td><strong>' + escapeHTML(s.provider) + '</strong>' + (ev.breached ? ' <span class="status error">SLO 위반</span>' : (s.enabled ? ' <span class="status">정상</span>' : ' <span class="muted">비활성</span>')) + '</td>' +
          '<td>' + metricCell(m.availability) + '</td>' +
          '<td>' + (m.p95_latency_ms && m.p95_latency_ms.enforced ? '<span class="status ' + (m.p95_latency_ms.breached ? 'error' : '') + '">' + fmt(m.p95_latency_ms.actual) + ' / ' + fmt(m.p95_latency_ms.target) + '</span>' : '<span class="muted">—</span>') + '</td>' +
          '<td>' + metricCell(m.error_rate) + '</td>' +
          '<td>' + metricCell(m.fallback_rate) + '</td>' +
          '<td data-num="' + (ev.requests || 0) + '">' + fmt(ev.requests) + '</td>' +
          '<td><button class="danger" type="button" onclick="deleteProviderSLO(\'' + escapeAttr(s.provider) + '\')">삭제</button></td>' +
        '</tr>';
      }).join('');
      const table = slos.length ?
        '<table><thead><tr><th>Provider</th><th>가용성(현재/목표)</th><th>P95(ms)</th><th>오류율</th><th>fallback율</th><th data-sort="num">요청(1h)</th><th>동작</th></tr></thead><tbody>' + rows + '</tbody></table>'
        : '<div class="empty">등록된 SLO 없음. provider별 가용성·P95·오류율·fallback 목표를 등록하면 최근 1시간 실측과 비교해 위반을 표시합니다.</div>';
      return form + table;
    }
    async function addProviderSLO(e) {
      e.preventDefault();
      const body = {
        provider: document.getElementById('slo-provider').value.trim(),
        availability_target: Number(document.getElementById('slo-availability').value || 0),
        p95_latency_target_ms: Number(document.getElementById('slo-p95').value || 0),
        error_rate_target: Number(document.getElementById('slo-error').value || 0),
        fallback_rate_target: Number(document.getElementById('slo-fallback').value || 0),
      };
      if (!body.provider) { alert('provider를 입력하세요'); return; }
      await api('/admin/providers/slo', { method: 'POST', body: JSON.stringify(body) });
      route();
    }
    window.deleteProviderSLO = async (provider) => {
      if (!confirm(provider + ' SLO를 삭제하시겠습니까?')) return;
      await api('/admin/providers/slo?provider=' + encodeURIComponent(provider), { method: 'DELETE' });
      route();
    };
    async function addTemplate(e) {
      e.preventDefault();
      const body = {
        name: document.getElementById('tpl-name').value.trim(),
        category: document.getElementById('tpl-category').value,
        body: document.getElementById('tpl-body').value,
      };
      if (!body.name || !body.body.trim()) { alert('이름과 본문을 입력하세요'); return; }
      await api('/admin/templates', { method: 'POST', body: JSON.stringify(body) });
      route();
    }
    window.toggleTemplate = async (id, enabled) => {
      await api('/admin/templates/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify({ enabled }) });
      route();
    };
    window.deleteTemplate = async (id) => {
      if (!confirm('이 작업 템플릿을 삭제하시겠습니까?')) return;
      await api('/admin/templates/' + encodeURIComponent(id), { method: 'DELETE' });
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
