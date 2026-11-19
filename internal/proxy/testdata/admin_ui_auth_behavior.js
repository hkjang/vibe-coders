'use strict';
// Execute the real inline authentication and HTTP blocks, not a replacement client.
// The transport records every call before returning synthetic responses. It does
// not enforce session ownership, deduplication or stale-response rejection.
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const source = readFileSync(join(__dirname, '..', 'admin_ui.go'), 'utf8');
function block(from, to) {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start, 'actual source block exists');
  return source.slice(start, end);
}
const auth = block('// ---------- auth (AUTH_ENABLED:', '// ---------- modal ----------');
const schemaTarget = block('function legacyText2SQLSchemaTarget(', 'function legacySchemaTextPages(');
const accessTarget = block('function legacyAccessTarget(', 'function legacyAccessKeyLifecycle(');
const routingTarget = block('function legacyRoutingRuleTarget(', 'async function renderLegacyRoutingRuleDetail(');
 const modelTarget = block('function legacyModelTarget(', 'async function renderLegacyModelDetail(') + block('function legacyProviderRefValid(', '// Reuse the safe app projection;');
const http = block('// ---------- HTTP ----------', '// ---------- formatting ----------');
const nav = (name) => ({ scopes: ['admin:read', 'admin:write'], allowed_tabs: ['settings'], default_home: '#/dashboard', marker: name });
const tokens = (name, access = name + '-access') => ({
  access_token: access, refresh_token: name + '-refresh', user: { id: 'same-subject', email: name, role: 'super_admin', team_id: '', scopes: ['admin:read', 'admin:write'] },
});
const response = (status, data = {}) => ({
  status, ok: status >= 200 && status < 300, statusText: 'synthetic',
  json: async () => data, text: async () => JSON.stringify(data),
});
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const turn = () => new Promise((resolve) => setImmediate(resolve));
async function until(check) {
  for (let i = 0; i < 40 && !check(); i++) await turn();
  assert.ok(check(), 'the intended actual request was dispatched');
}
const outcome = (promise) => promise.then(value => ({ ok: true, value }), () => ({ ok: false }));

function harness(transport, initialHash = '', initialStorage) {
  const nodes = new Map();
  const storage = initialStorage ?? new Map();
  const calls = [];
  const toasts = [];
  let routes = 0;
  let reloads = 0;
  const timers = new Map();
  const rootStyle = {};
  function node(id) {
    if (!nodes.has(id)) {
      const classes = new Set();
      nodes.set(id, {
        id, value: '', style: {}, textContent: '', title: '', disabled: false, listeners: {},
        classList: { add: x => classes.add(x), remove: x => classes.delete(x), contains: x => classes.has(x) },
        addEventListener(type, callback) { this.listeners[type] = callback; },
        focus() {}, appendChild(child) { nodes.set(child.id, child); }, attributes: {},
        setAttribute(key, value) { this.attributes[key] = String(value); },
        removeAttribute(key) { delete this.attributes[key]; },
        getAttribute(key) { return this.attributes[key] ?? null; },
      });
    }
    return nodes.get(id);
  }
  const location = { hash: initialHash, pathname: '/admin', search: '', reload() { reloads++; } };
  const context = vm.createContext({
    URLSearchParams, TextEncoder, AbortController,
    document: { documentElement: { style: { setProperty(k, v) { rootStyle[k] = v; } } }, getElementById: id => id === 'sso-login-btn' ? nodes.get(id) : node(id), querySelectorAll: () => [], createElement: () => node('created-button') },
    sessionStorage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)), removeItem: k => storage.delete(k) },
    location, history: { replaceState(_state, _title, url) { const next = new URL(url, 'https://gateway.invalid'); Object.assign(location, { pathname: next.pathname, search: next.search, hash: next.hash }); } },
    setTimeout: (fn, ms) => { const id = {}; timers.set(id, { fn, ms }); return id; },
    clearTimeout: id => timers.delete(id),
    route: () => { routes++; },
    toast: message => toasts.push(message),
    fetch: async (path, options = {}) => {
      const call = { path, ...options };
      calls.push(call);
      if (path === '/auth/sso/status') return response(200, transport.sso ?? { keycloak_enabled: false });
      if (path === '/me/navigation' && !transport.navigation) return response(200, nav('default'));
      return transport(call);
    },
  });
  vm.runInContext('globalThis.window = globalThis; const tokenInput = document.getElementById("token");\n' + schemaTarget + '\n' + accessTarget + '\n' + modelTarget + '\n' + routingTarget + '\n' + auth + '\n' + http +
    '\nglobalThis.client = { authState, saveAuth, clearAuth, tryRefresh, api, initAuth, bootAfterAuth, captureSSOFragment, loadNavigation, refreshLegacyAppEntry, maybeShowSSOButton };', context);
  const client = context.client;
  return {
    ...client, calls, storage, toasts, node, location, rootStyle,
    get reloads() { return reloads; },
    expireIdentity() { for (const t of timers.values()) if (t.ms === 5000) t.fn(); },
    get routes() { return routes; },
    seed(name = 'A') { client.authState.enabled = true; client.saveAuth(tokens(name)); },
    async login(name = 'B') {
      node('login-email').value = name; node('login-password').value = 'synthetic-password';
      await node('login-form').listeners.submit({ preventDefault() {} });
    },
    logout: () => node('auth-logout').listeners.click(),
    async startSSO() { await client.maybeShowSSOButton(); nodes.get('sso-login-btn').onclick(); },
    count: path => calls.filter(call => call.path === path).length,
    loginVisible: () => node('login-backdrop').classList.contains('open'),
  };
}

test('normal authenticated GET and a single 401 replay preserve options', async () => {
  let reads = 0;
  const h = harness(call => {
    if (call.path === '/auth/refresh') return response(200, tokens('rotated'));
    assert.equal(call.path, '/business');
    assert.equal(call.method, 'POST');
    assert.equal(call.body, '{"synthetic":true}');
    return response(++reads === 1 ? 401 : 200, { current: true });
  });
  h.seed();
  assert.equal((await h.api('/business', { method: 'POST', body: '{"synthetic":true}', success: 'saved' })).current, true);
  assert.equal(h.count('/auth/refresh'), 1);
  assert.equal(h.count('/business'), 2);
  assert.equal(h.toasts.length, 1);
  assert.equal(h.storage.get('authAccess'), 'rotated-access');
});

test('ADMIN_TOKEN mode and final 401 do not start refresh loops', async () => {
  const h = harness(() => response(401));
  h.node('token').value = 'synthetic-admin-token';
  assert.equal((await outcome(h.api('/business'))).ok, false);
  assert.equal(h.calls[0].headers.Authorization, 'Bearer synthetic-admin-token');
  assert.equal(h.count('/auth/refresh'), 0);
  assert.equal(h.loginVisible(), false);
  const jwt = harness(call => response(call.path === '/auth/refresh' ? 200 : 401, tokens('rotated')));
  jwt.seed();
  assert.equal((await outcome(jwt.api('/business'))).ok, false);
  assert.equal(jwt.count('/business'), 2);
  assert.equal(jwt.count('/auth/refresh'), 1);
});

test('current refresh failure still clears credentials and requests login', async () => {
  const h = harness(() => response(401)); h.seed();
  assert.equal((await outcome(h.api('/business'))).ok, false);
  assert.equal(h.count('/auth/refresh'), 1);
  assert.equal(h.storage.has('authAccess'), false);
  assert.equal(h.loginVisible(), true);
});

test('twelve simultaneous 401 responses share one refresh and all recover', async () => {
  const gate = deferred(); let refreshes = 0;
  const h = harness(call => {
    if (call.path === '/auth/refresh') return ++refreshes === 1 ? gate.promise : response(401);
    return response(call.headers.Authorization === 'Bearer A-access' ? 401 : 200, { current: true });
  }); h.seed();
  const reads = Array.from({ length: 12 }, (_, i) => outcome(h.api('/settings/' + i)));
  await until(() => refreshes > 0); await turn();
  const dispatchedRefreshes = refreshes;
  gate.resolve(response(200, tokens('rotated')));
  const results = await Promise.all(reads);
  assert.equal(dispatchedRefreshes, 1);
  assert.equal(results.filter(x => x.ok).length, 12);
  assert.equal(h.loginVisible(), false);
  assert.equal(h.storage.get('authRefresh'), 'rotated-refresh');
});

for (const sameAccess of [false, true]) test('late 401 reuses completed rotation, same access=' + sameAccess, async () => {
  const late = deferred(); let first = true; let lateFirst = true;
  const h = harness(call => {
    if (call.path === '/auth/refresh') return response(200, tokens('rotated', sameAccess ? 'A-access' : 'rotated-access'));
    if (call.path === '/late' && lateFirst) { lateFirst = false; return late.promise; }
    if (call.path === '/first' && first) { first = false; return response(401); }
    return response(200, { current: true });
  }); h.seed();
  const pending = outcome(h.api('/late'));
  assert.equal((await h.api('/first')).current, true);
  late.resolve(response(401));
  assert.equal((await pending).ok, true);
  assert.equal(h.count('/auth/refresh'), 1);
});

for (const status of [200, 401]) test('old refresh status ' + status + ' cannot alter a new login', async () => {
  const gate = deferred();
  const h = harness(call => {
    if (call.path === '/auth/refresh') return gate.promise;
    if (call.path === '/auth/login') return response(200, tokens('B'));
    return response(401);
  }); h.seed();
  const old = outcome(h.api('/business'));
  await until(() => h.count('/auth/refresh') === 1);
  await h.login(); const reads = h.count('/business');
  gate.resolve(response(status, tokens('old-rotated')));
  assert.equal((await old).ok, false);
  assert.equal(h.storage.get('authAccess'), 'B-access');
  assert.equal(h.count('/business'), reads);
  assert.equal(h.loginVisible(), false);
});

for (const status of [200, 401]) test('old business status ' + status + ' cannot replay or notify in a new login', async () => {
  const gate = deferred();
  const h = harness(call => {
    if (call.path === '/business') return gate.promise;
    if (call.path === '/auth/login') return response(200, tokens('B'));
    if (call.path === '/auth/refresh') return response(200, tokens('B-rotated'));
    throw new Error('unexpected synthetic endpoint');
  }); h.seed();
  const old = outcome(h.api('/business', { success: 'old saved' }));
  await h.login(); gate.resolve(response(status, { old: true }));
  assert.equal((await old).ok, false);
  assert.equal(h.count('/auth/refresh'), 0);
  assert.equal(h.count('/business'), 1);
  assert.equal(h.toasts.length, 0);
  assert.equal(h.storage.get('authAccess'), 'B-access');
});

test('logout retires a pending refresh before the logout response arrives', async () => {
  const refresh = deferred(); const logout = deferred();
  const h = harness(call => {
    if (call.path === '/auth/refresh') return refresh.promise;
    if (call.path === '/auth/logout') return logout.promise;
    return response(401);
  }); h.seed();
  const old = outcome(h.api('/business'));
  await until(() => h.count('/auth/refresh') === 1);
  const leaving = h.logout();
  refresh.resolve(response(200, tokens('old-rotated')));
  const oldResult = await old;
  const adopted = h.storage.get('authAccess') === 'old-rotated-access';
  logout.resolve(response(200)); await leaving;
  assert.equal(oldResult.ok, false);
  assert.equal(adopted, false);
  assert.equal(h.count('/business'), 1);
  assert.equal(h.storage.has('authAccess'), false);
  assert.equal(h.loginVisible(), true);
});

test('old logout completion cannot clear a subsequent login', async () => {
  const gate = deferred();
  const h = harness(call => call.path === '/auth/logout' ? gate.promise : response(200, tokens('B')));
  h.seed(); const leaving = h.logout(); await h.login();
  gate.resolve(response(200)); await leaving;
  assert.equal(h.storage.get('authAccess'), 'B-access');
  assert.equal(h.loginVisible(), false);
});

for (const status of [200, 401]) test('old initAuth status ' + status + ' cannot replace a new session or route', async () => {
  const gate = deferred();
  const h = harness(call => {
    if (call.path === '/auth/me') return gate.promise;
    if (call.path === '/auth/login') return response(200, tokens('B'));
    if (call.path === '/auth/refresh') return response(401);
    throw new Error('unexpected synthetic endpoint');
  }); h.seed(); const boot = h.initAuth();
  await until(() => h.count('/auth/me') === 1);
  await h.login(); const routes = h.routes;
  gate.resolve(response(status, { auth_enabled: true, user: tokens('A').user })); await boot;
  assert.equal(h.authState.user?.email, 'B');
  assert.equal(h.storage.get('authAccess'), 'B-access');
  assert.equal(h.count('/auth/refresh'), 0);
  assert.equal(h.routes, routes);
  assert.equal(h.loginVisible(), false);
});

for (const status of [200, 500]) test('old navigation status ' + status + ' cannot reset the new navigation or route', async () => {
  const gate = deferred(); let navigation = 0;
  const transport = call => {
    if (call.path === '/me/navigation') return ++navigation === 1 ? gate.promise : response(200, nav('B'));
    if (call.path === '/auth/login') return response(200, tokens('B'));
    throw new Error('unexpected synthetic endpoint');
  }; transport.navigation = true;
  const h = harness(transport); h.seed(); const boot = h.bootAfterAuth(null);
  await until(() => navigation === 1); await h.login(); const routes = h.routes;
  gate.resolve(response(status, nav('A'))); await boot;
  assert.equal(h.authState.nav?.marker, 'B');
  assert.equal(h.routes, routes);
});

test('a login response arriving after logout cannot revive credentials', async () => {
  const gate = deferred();
  const h = harness(call => call.path === '/auth/login' ? gate.promise : response(200));
  h.seed(); const signingIn = h.login(); await h.logout();
  gate.resolve(response(200, tokens('B'))); await signingIn;
  assert.equal(h.storage.has('authAccess'), false);
  assert.equal(h.loginVisible(), true);
});

test('an SSO exchange arriving after logout cannot revive credentials', async () => {
  const gate = deferred();
  const h = harness(call => call.path === '/auth/sso/exchange' ? gate.promise : response(200));
  h.seed(); h.location.hash = '#kc_code=synthetic-code';
  const boot = h.initAuth(); await until(() => h.count('/auth/sso/exchange') === 1);
  await h.logout(); gate.resolve(response(200, tokens('old-sso'))); await boot;
  assert.equal(h.storage.has('authAccess'), false);
  assert.equal(h.count('/auth/me'), 0);
  assert.equal(h.routes, 0);
  assert.equal(h.loginVisible(), true);
});

test('a rejected login restores its button without changing the existing credentials', async () => {
  const h = harness(() => response(401)); h.seed();
  await h.login();
  assert.equal(h.node('login-submit').disabled, false);
  assert.equal(h.node('login-error').style.display, 'block');
  assert.equal(h.storage.get('authAccess'), 'A-access');
});

test('stored JWT session resumes through refresh and navigation', async () => {
  const h = harness(call => call.path === '/auth/refresh' ? response(200, tokens('resumed')) : response(401));
  h.seed(); await h.initAuth();
  assert.equal(h.count('/auth/refresh'), 1);
  assert.equal(h.storage.get('authAccess'), 'resumed-access');
  assert.equal(h.routes, 1);
  assert.equal(h.loginVisible(), false);
});

test('ADMIN_TOKEN bootstrap and the original auth/me failure fallback remain usable', async () => {
  for (const networkFailure of [false, true]) {
    const h = harness(() => {
      if (networkFailure) throw new Error('synthetic unavailable');
      return response(200, { auth_enabled: false });
    });
    h.node('token').value = 'synthetic-admin-token'; await h.initAuth();
    assert.equal(h.authState.enabled, false);
    assert.equal(h.count('/auth/refresh'), 0);
    assert.equal(h.routes, 1);
    assert.equal(h.calls.find(x => x.path === '/me/navigation').headers.Authorization, 'Bearer synthetic-admin-token');
  }
});

test('current SSO exchange still boots the authenticated session', async () => {
  const h = harness(call => call.path === '/auth/sso/exchange'
    ? response(200, tokens('SSO')) : response(200, { auth_enabled: true, user: tokens('SSO').user }));
  h.location.hash = '#kc_code=synthetic-code'; await h.initAuth();
  assert.equal(h.storage.get('authAccess'), 'SSO-access');
  assert.equal(h.authState.user.email, 'SSO');
  assert.equal(h.routes, 1);
});

test('logout during login leaves the newly shown login button usable', async () => {
  const gate = deferred();
  const h = harness(call => call.path === '/auth/login' ? gate.promise : response(200));
  h.seed(); const signingIn = h.login();
  assert.equal(h.node('login-submit').disabled, true);
  await h.logout();
  const disabled = h.node('login-submit').disabled;
  gate.resolve(response(200, tokens('old-login'))); await signingIn;
  assert.equal(disabled, false);
  assert.equal(h.node('login-submit').disabled, false);
  assert.equal(h.loginVisible(), true);
});

test('login navigation auth failure leaves the retry login button usable', async () => {
  const transport = call => call.path === '/auth/login' ? response(200, tokens('B')) : response(401);
  transport.navigation = true;
  const h = harness(transport); h.seed(); await h.login();
  assert.equal(h.node('login-submit').disabled, false);
  assert.equal(h.loginVisible(), true);
  assert.equal(h.storage.has('authAccess'), false);
});

test('old refresh finally does not clear a new session refresh flight', async () => {
  const oldGate = deferred(); const newGate = deferred(); const attempts = new Map();
  const h = harness(call => {
    if (call.path === '/auth/login') return response(200, tokens('B'));
    if (call.path === '/auth/refresh') return JSON.parse(call.body).refresh_token === 'A-refresh' ? oldGate.promise : newGate.promise;
    const count = (attempts.get(call.path) || 0) + 1; attempts.set(call.path, count);
    return response(count === 1 && call.headers.Authorization !== 'Bearer B-rotated-access' ? 401 : 200, { current: true });
  }); h.seed();
  const old = outcome(h.api('/old')); await until(() => h.count('/auth/refresh') === 1);
  await h.login();
  const current = outcome(h.api('/current')); await until(() => h.count('/auth/refresh') === 2);
  oldGate.resolve(response(200, tokens('old-rotated'))); await old;
  const next = outcome(h.api('/next')); await turn();
  assert.equal(h.count('/next'), 0, 'new calls wait until refreshed grants are verified');
  const refreshCount = h.count('/auth/refresh');
  newGate.resolve(response(200, tokens('B-rotated')));
  assert.equal((await current).ok, true); assert.equal((await next).ok, true);
  assert.equal(refreshCount, 2);
  assert.equal(h.storage.get('authAccess'), 'B-rotated-access');
});

test('a response body completing in a new session cannot return old data or toast', async () => {
  const body = deferred();
  const h = harness(call => call.path === '/auth/login' ? response(200, tokens('B'))
    : { ...response(200), json: () => body.promise });
  h.seed(); const old = outcome(h.api('/business', { success: 'old saved' }));
  await turn(); await h.login(); body.resolve({ old: true });
  assert.equal((await old).ok, false);
  assert.equal(h.toasts.length, 0);
  assert.equal(h.storage.get('authAccess'), 'B-access');
});

test('SSO replacement retires an old business 401 without replaying under SSO', async () => {
  const oldGate = deferred(); let oldCalls = 0;
  const h = harness(call => {
    if (call.path === '/old') return ++oldCalls === 1 ? oldGate.promise : response(200);
    if (call.path === '/auth/sso/exchange') return response(200, tokens('SSO'));
    if (call.path === '/auth/me') return response(200, { auth_enabled: true, user: tokens('SSO').user });
    throw new Error('unexpected synthetic endpoint');
  }); h.seed(); const old = outcome(h.api('/old'));
  h.location.hash = '#kc_code=synthetic-code'; await h.initAuth();
  oldGate.resolve(response(401)); const result = await old;
  assert.equal(result.ok, false);
  assert.equal(oldCalls, 1);
  assert.equal(h.storage.get('authAccess'), 'SSO-access');
});
for (const status of [200, 401]) test('SSO replacement rejects old refresh status ' + status, async () => {
  const oldGate = deferred(); let oldCalls = 0;
  const h = harness(call => {
    if (call.path === '/old') return response(++oldCalls === 1 ? 401 : 200);
    if (call.path === '/auth/refresh') return oldGate.promise;
    if (call.path === '/auth/sso/exchange') return response(200, tokens('SSO'));
    if (call.path === '/auth/me') return response(200, { auth_enabled: true, user: tokens('SSO').user });
    throw new Error('unexpected synthetic endpoint');
  }); h.seed(); const old = outcome(h.api('/old'));
  await until(() => h.count('/auth/refresh') === 1);
  h.location.hash = '#kc_code=synthetic-code'; await h.initAuth();
  oldGate.resolve(response(status, tokens('old-rotated'))); const result = await old;
  assert.equal(h.storage.get('authAccess'), 'SSO-access');
  assert.equal(result.ok, false);
  assert.equal(oldCalls, 1);
  assert.equal(h.loginVisible(), false);
});
test('SSO exchange blocks new business calls until its own current success', async () => {
  const exchange = deferred();
  const h = harness(call => {
    if (call.path === '/auth/sso/exchange') return exchange.promise;
    if (call.path === '/auth/me') return response(200, { auth_enabled: true, user: tokens('SSO').user });
    if (call.path === '/during' || call.path === '/fresh') return response(200);
    throw new Error('unexpected synthetic endpoint');
  }); h.seed(); h.location.hash = '#kc_code=synthetic-code'; const boot = h.initAuth();
  await until(() => h.count('/auth/sso/exchange') === 1);
  const during = await outcome(h.api('/during'));
  exchange.resolve(response(200, tokens('SSO'))); await boot;
  assert.equal(during.ok, false);
  assert.equal(h.count('/during'), 0);
  assert.equal((await outcome(h.api('/fresh'))).ok, true);
  assert.equal(h.count('/fresh'), 1);
});
test('current SSO exchange failures still expose a usable login form', async () => {
  for (const networkFailure of [false, true]) {
    const h = harness(call => {
      assert.equal(call.path, '/auth/sso/exchange');
      if (networkFailure) throw new Error('synthetic unavailable');
      return response(401);
    });
    h.location.hash = '#kc_code=synthetic-code'; await h.initAuth();
    assert.equal(h.loginVisible(), true);
    assert.equal(h.node('login-submit').disabled, false);
    assert.equal(h.count('/auth/me'), 0);
  }
});

test('malformed SSO code returns to a usable login without dispatching exchange', async () => {
  const h = harness(call => {
    assert.equal(call.path, '/auth/login');
    return response(200, tokens('recovered'));
  });
  h.location.hash = '#kc_code=%E0%A4%A';
  assert.equal((await outcome(h.initAuth())).ok, true);
  assert.equal(h.count('/auth/sso/exchange'), 0);
  assert.equal(h.loginVisible(), true);
  assert.equal(h.node('login-submit').disabled, false);
  await h.login();
  assert.equal(h.storage.get('authAccess'), 'recovered-access');
  assert.equal(h.loginVisible(), false);
  assert.equal(h.routes, 1);
});


test('Legacy entry requires a strict current opt-in and always uses the fixed App root', async () => {
  let flag;
  const transport = () => response(200, { ...nav('current'), app_entry_enabled: flag, app_entry_url: 'https://untrusted.invalid/' });
  transport.navigation = true;
  const h = harness(transport);
  for (flag of [undefined, false, 'true', 1, true, null]) {
    await h.loadNavigation();
    assert.equal(h.node('legacy-app-entry').getAttribute('href'), flag === true ? '/app/' : null);
    assert.equal(h.node('legacy-app-entry').style.display, flag === true ? '' : 'none');
  }
});

test('a late opt-in cannot replace a newer disabled navigation response', async () => {
  const gate = deferred(); let calls = 0;
  const transport = () => ++calls === 1 ? gate.promise : response(200, { ...nav('new'), app_entry_enabled: false });
  transport.navigation = true;
  const h = harness(transport);
  const older = h.loadNavigation();
  await until(() => calls === 1);
  await h.loadNavigation();
  gate.resolve(response(200, { ...nav('old'), app_entry_enabled: true }));
  assert.equal(await older, false);
  assert.equal(h.authState.nav.marker, 'new');
  assert.equal(h.node('legacy-app-entry').getAttribute('href'), null);
});

test('logout immediately retires the entry and pending navigation cannot restore it', async () => {
  const navGate = deferred(), logoutGate = deferred(); let calls = 0;
  const transport = call => call.path === '/auth/logout' ? logoutGate.promise
    : ++calls === 1 ? response(200, { ...nav('initial'), app_entry_enabled: true }) : navGate.promise;
  transport.navigation = true;
  const h = harness(transport); h.seed();
  await h.loadNavigation();
  assert.equal(h.node('legacy-app-entry').getAttribute('href'), '/app/');
  const pending = h.loadNavigation();
  await until(() => calls === 2);
  const logout = h.logout();
  assert.equal(h.node('legacy-app-entry').getAttribute('href'), null);
  navGate.resolve(response(200, { ...nav('late'), app_entry_enabled: true }));
  assert.equal(await pending, false);
  assert.equal(h.node('legacy-app-entry').getAttribute('href'), null);
  logoutGate.resolve(response(200));
  await logout;
  assert.equal(h.node('legacy-app-entry').getAttribute('href'), null);
});

test('navigation failure hides the entry and a later focus refresh recovers', async () => {
  let failed = false;
  const transport = () => response(failed ? 503 : 200, { ...nav('current'), app_entry_enabled: true });
  transport.navigation = true;
  const h = harness(transport);
  await h.loadNavigation();
  assert.equal(h.node('legacy-app-entry').getAttribute('href'), '/app/');
  failed = true; await h.refreshLegacyAppEntry();
  assert.equal(h.node('legacy-app-entry').getAttribute('href'), null);
  failed = false; await h.refreshLegacyAppEntry();
  assert.equal(h.node('legacy-app-entry').getAttribute('href'), '/app/');
});

test('opt-in app projection preserves Legacy authentication and is not passed as a fetch option',async()=>{
 const h=harness(()=>response(200,{providers:[]}));h.seed();
 await h.api('/admin/providers',{appProjection:true,cache:'no-store',headers:{Authorization:'invalid-overwrite'}});
 assert.equal(h.calls[0].headers['X-Vibe-UI'],'app');assert.equal(h.calls[0].headers.Authorization,'Bearer A-access');
 assert.equal(h.calls[0].cache,'no-store');assert.equal(Object.hasOwn(h.calls[0],'appProjection'),false);
 await h.api('/admin/providers');assert.equal(h.calls[1].headers['X-Vibe-UI'],undefined);
});
test('session retirement clears a rendered provider detail immediately',()=>{
 const h=harness(()=>response(200));h.seed();h.node('legacy-provider-detail').textContent='SYNTHETIC_PRIVATE_DETAIL';
 h.clearAuth();assert.equal(h.node('legacy-provider-detail').textContent,'');
});

test('the initial explicit provider detail survives local login',async()=>{
 const target='#/settings?provider_ref=prv_'+'a'.repeat(43);
 const h=harness(()=>response(200,tokens('A')),target);
 await h.login('A');assert.equal(h.location.hash,target);assert.equal(h.routes,1);
});
test('the existing read-only request handoff also survives local login',async()=>{
 const target='#/requests?model=public&request_id=public%20%ED%95%9C%EA%B8%80';
 const h=harness(()=>response(200,tokens('A')),target);await h.login('A');assert.equal(h.location.hash,target);
});
for(const target of ['#/settings?provider_ref=unsafe','#/settings?provider_ref=prv_'+'a'.repeat(43)+'\n','#/redteam?run=1','#sso=private','//outside.invalid','#/requests-other']){
 test('login does not restore an unapproved initial target '+JSON.stringify(target.slice(0,50)),async()=>{
  const h=harness(()=>response(200,tokens('A')),target);await h.login('A');assert.equal(h.location.hash,'');
 });
}
test('a changed hash supersedes the original provider handoff',async()=>{
 const target='#/settings?provider_ref=prv_'+'a'.repeat(43);
 const h=harness(()=>response(200,tokens('A')),target);h.location.hash='#/settings';await h.login('A');assert.equal(h.location.hash,'');
});
test('explicit logout discards an initial read-only handoff before another login',async()=>{
 const target='#/settings?provider_ref=prv_'+'a'.repeat(43);
 const h=harness(()=>response(200,tokens('A')),target);h.seed();await h.logout();await h.login('B');assert.equal(h.location.hash,'');
});
test('failed credentials do not consume the initial handoff',async()=>{
 const target='#/settings?provider_ref=prv_'+'a'.repeat(43);let failed=true;
 const h=harness(()=>response(failed?401:200,tokens('A')),target);await h.login('A');assert.equal(h.location.hash,target);
 failed=false;await h.login('A');assert.equal(h.location.hash,target);
});

const ssoReturnKey = 'vibe.admin.auth.sso-return-to';
const providerHandoff = '#/settings?provider_ref=prv_' + 'a'.repeat(43);
const ssoTransport = call => response(200, call.path === '/auth/me' ? {auth_enabled:true,user:tokens('SSO').user} : tokens('SSO'));
ssoTransport.sso = {keycloak_enabled:true,allow_local_login:true,login_url:'/auth/keycloak/login'};
test('explicit Legacy SSO preserves the same provider through one-use tab storage',async()=>{
 const departure=harness(ssoTransport,providerHandoff);await departure.startSSO();
 assert.equal(departure.location.href,'/auth/keycloak/login');
 const callback=harness(ssoTransport,'#kc_code=synthetic-code',departure.storage);await callback.initAuth();
 assert.equal(callback.location.hash,providerHandoff);assert.equal(callback.storage.has(ssoReturnKey),false);
 assert.equal(callback.authState.user.email,'SSO');assert.equal(callback.routes,1);
});

test('request detail and filter bytes survive SSO without entering the IdP URL',async()=>{
 const target='#/requests?request_id=%ED%95%9C%EA%B8%80%20%2B%252F%3F%26%23&model=public%2B&limit=37';
 const d=harness(ssoTransport,target);await d.startSSO();assert.equal(d.location.href,'/auth/keycloak/login');
 const h=harness(ssoTransport,'#kc_code=synthetic',d.storage);await h.initAuth();assert.equal(h.location.hash,target);
});
for(const marker of ['#kc_error=access_denied','#kc_error=%E0%A4%A','#kc_code=%E0%A4%A']){
 test('SSO failure keeps a one-use safe target for explicit retry '+marker,async()=>{
  const d=harness(ssoTransport,providerHandoff);await d.startSSO();
  const h=harness(ssoTransport,marker,d.storage);await h.initAuth();
  assert.equal(h.location.hash,providerHandoff);assert.equal(h.loginVisible(),true);assert.equal(h.storage.has(ssoReturnKey),false);
  await h.login();assert.equal(h.location.hash,providerHandoff);
 });
}
for(const failure of ['401','network']){
 test('exchange failure restores destination but never credentials '+failure,async()=>{
  const d=harness(ssoTransport,providerHandoff);await d.startSSO();
  const h=harness(()=>{if(failure==='network')throw Error('private');return response(401)},'#kc_code=synthetic',d.storage);
  await h.initAuth();assert.equal(h.location.hash,providerHandoff);assert.equal(h.loginVisible(),true);assert.equal(h.storage.has('authAccess'),false);
 });
}
for(const value of ['broken',JSON.stringify({hash:providerHandoff,createdAt:Date.now()-600001}),JSON.stringify({hash:providerHandoff,createdAt:Date.now()+600000}),JSON.stringify({hash:providerHandoff,createdAt:'100'}),JSON.stringify({hash:'//outside.invalid',createdAt:Date.now()}),'x'.repeat(9001)]){
 test('invalid or stale staged intent is discarded '+value.slice(0,24),async()=>{
  const storage=new Map([[ssoReturnKey,value]]);const h=harness(ssoTransport,'#kc_code=synthetic',storage);
  await h.initAuth();assert.equal(h.location.hash,'');assert.equal(h.storage.has(ssoReturnKey),false);
 });
}
for(const change of ['route','logout','login']){
 test('in-flight SSO cannot restore retired intent after '+change,async()=>{
  const d=harness(ssoTransport,providerHandoff);await d.startSSO();const exchange=deferred();
  const h=harness(call=>call.path==='/auth/sso/exchange'?exchange.promise:ssoTransport(call),'#kc_code=synthetic',d.storage);
  const boot=h.initAuth();await until(()=>h.count('/auth/sso/exchange')===1);
  if(change==='route')h.location.hash='#/requests?model=new';
  else if(change==='logout')await h.logout();else await h.login();
  const current=h.location.hash;exchange.resolve(response(200,tokens('SSO')));await boot;
  assert.equal(h.location.hash,current);assert.notEqual(h.location.hash,providerHandoff);assert.equal(h.storage.has(ssoReturnKey),false);
 });
}
test('ordinary Legacy boot discards an abandoned SSO intent',async()=>{
 const d=harness(ssoTransport,providerHandoff);await d.startSSO();
 const h=harness(ssoTransport,'#/requests',d.storage);await h.initAuth();assert.equal(h.location.hash,'#/requests');assert.equal(h.storage.has(ssoReturnKey),false);
 h.location.hash='#kc_code=synthetic';await h.initAuth();assert.equal(h.location.hash,'');
});
test('explicit logout and local login each discard pending SSO intent',async()=>{
 for(const action of ['logout','login']){
  const h=harness(ssoTransport,providerHandoff);await h.startSSO();await h[action]();assert.equal(h.storage.has(ssoReturnKey),false);
 }
});
test('a new SSO selection supersedes an earlier staged target',async()=>{
 const h=harness(ssoTransport,providerHandoff);await h.startSSO();h.location.hash='#/requests?model=new';await h.startSSO();
 const c=harness(ssoTransport,'#kc_code=synthetic',h.storage);await c.initAuth();assert.equal(c.location.hash,'#/requests?model=new');
});
test('storage failure stops the redirect with a usable login error',async()=>{
 const storage=new Map();storage.set=()=>{throw Error('unavailable')};
 const h=harness(ssoTransport,providerHandoff,storage);await h.startSSO();assert.equal(h.location.href,undefined);assert.equal(h.loginVisible(),true);
 assert.match(h.node('login-error').textContent,/저장할 수 없습니다/);
});

for (const target of ['#/prompts?q=public&since=2026-11-20T00%3A00%3A00.123Z&fp_window=90d','#/prompt-assets?asset=opaque-id&q=no-match','#/prompt-debt?window=90d']) {
 test('prompt resource survives local login and SSO '+target, async()=>{
  const local=harness(ssoTransport,target);await local.login();assert.equal(local.location.hash,target);
  const departure=harness(ssoTransport,target);await departure.startSSO();
  const callback=harness(ssoTransport,'#kc_code=synthetic',departure.storage);await callback.initAuth();assert.equal(callback.location.hash,target);
 });
}


for(const source of ['live','cache','agent_route']){
 test('exact model resource survives local login and SSO '+source,async()=>{
  const hash='#/model-contracts?'+new URLSearchParams({model:'public +%2F?&#',provider_ref:'prv_'+'A'.repeat(43),source});
  const h=harness(ssoTransport,hash);await h.login();assert.equal(h.location.hash,hash);
  const departure=harness(ssoTransport,hash);await departure.startSSO();
  const callback=harness(ssoTransport,'#kc_code=synthetic',departure.storage);await callback.initAuth();
  assert.equal(callback.location.hash,hash);assert.equal(callback.count('/admin/models/contracts/run'),0);
 });
}
for(const hash of ['#/model-contracts','#/model-contracts?model=missing','#/model-contracts?'+new URLSearchParams({model:'public',provider_ref:'name',source:'live'}),'#/model-contracts?'+new URLSearchParams({model:'public',provider_ref:'prv_'+'A'.repeat(43),source:'live'})+'&run=true']){
 test('unvalidated model workflow is not staged across SSO '+hash,async()=>{
  const departure=harness(ssoTransport,hash);await departure.startSSO();
  const callback=harness(ssoTransport,'#kc_code=synthetic',departure.storage);await callback.initAuth();assert.equal(callback.location.hash,'');
 });
}
test('retiring auth clears the displayed model detail',async()=>{
 const h=harness(ssoTransport);h.seed();h.node('legacy-model-detail').textContent='PRIVATE_MODEL_DETAIL';
 await h.logout();assert.equal(h.node('legacy-model-detail').textContent,'');
});

test('exact routing rule survives local login and independent SSO',async()=>{
 const hash='#/routing?'+new URLSearchParams({rule_id:'규칙 +%2F?&#/exact'});
 const local=harness(ssoTransport,hash);await local.login();assert.equal(local.location.hash,hash);
 const departure=harness(ssoTransport,hash);await departure.startSSO();
 const callback=harness(ssoTransport,'#kc_code=synthetic',departure.storage);await callback.initAuth();
 assert.equal(callback.location.hash,hash);assert.equal(callback.count('/admin/routing/preview'),0);
});
for(const hash of ['#/routing','#/routing/health?rule_id=public','#/routing?rule_id=','#/routing?rule_id=a&rule_id=b','#/routing?rule_id=a&run=true','#/routing?rule_id=%E2%80%8B','#/routing?rule_id=%ED%A0%80','#/routing?rule_id=%zz']){
 test('unvalidated routing workflow is not staged across SSO '+hash,async()=>{
  const departure=harness(ssoTransport,hash);await departure.startSSO();
  const callback=harness(ssoTransport,'#kc_code=synthetic',departure.storage);await callback.initAuth();assert.equal(callback.location.hash,'');
 });
}
test('retiring auth clears displayed routing detail',async()=>{
 const h=harness(ssoTransport);h.seed();h.node('legacy-routing-rule-detail').textContent='PRIVATE_ROUTING_DETAIL';
 await h.logout();assert.equal(h.node('legacy-routing-rule-detail').textContent,'');
});

test('a literal question mark in an exact routing ID survives SSO',async()=>{
 const hash='#/routing?rule_id=public?tail';
 const departure=harness(ssoTransport,hash);await departure.startSSO();
 const callback=harness(ssoTransport,'#kc_code=synthetic',departure.storage);await callback.initAuth();assert.equal(callback.location.hash,hash);
});

for(const [resource,id] of [['key','shared-id'],['account',' 계정 +%2F?&#/ '+'가'.repeat(1300)],['team',' 팀 +%2F?&#/ '+'가'.repeat(1300)]]){
 test('exact access kind and long ID survive local login and SSO '+resource,async()=>{
  const hash='#/users?'+new URLSearchParams({resource,id});
  if(resource!=='key')assert.ok(hash.length>9000);
  const local=harness(ssoTransport,hash);await local.login();assert.equal(local.location.hash,hash);
  const departure=harness(ssoTransport,hash);await departure.startSSO();assert.equal(departure.location.href,'/auth/keycloak/login');
  const callback=harness(ssoTransport,'#kc_code=synthetic',departure.storage);await callback.initAuth();
  assert.equal(callback.location.hash,hash);assert.equal(callback.storage.has(ssoReturnKey),false);
 });
}
for(const hash of ['#/users?resource=team&id=%zz','#/users?resource=account&id=%ED%A0%80','#/users?resource=key&id=a&id=b',
 '#/users?resource=team&id=a&save=true','#/users?resource=account&id='+('a'.repeat(4097)), '#/requests?q='+('a'.repeat(8193)),
 '#/users?resource=unknown&id=a','#/users?resource=team&id='+('a'.repeat(16384))]){
 test('invalid access and overlong old target are not staged '+hash.slice(0,70),async()=>{
  const departure=harness(ssoTransport,hash);await departure.startSSO();
  const callback=harness(ssoTransport,'#kc_code=synthetic',departure.storage);await callback.initAuth();assert.equal(callback.location.hash,'');
 });
}
test('logout clears displayed access detail',async()=>{
 const h=harness(ssoTransport);h.seed();h.node('legacy-access-detail').textContent='PRIVATE_ACCESS_DETAIL';
 await h.logout();assert.equal(h.node('legacy-access-detail').textContent,'');
});

for(const name of ['스키마 +%2F?&#/정확','😀'.repeat(512)]){
 test('exact schema survives local login and independent SSO '+name.slice(0,20),async()=>{
  const hash='#/text2sql?'+new URLSearchParams({schema_name:name});
  const local=harness(ssoTransport,hash);await local.login();assert.equal(local.location.hash,hash);
  const departure=harness(ssoTransport,hash);await departure.startSSO();assert.equal(departure.location.href,'/auth/keycloak/login');
  const callback=harness(ssoTransport,'#kc_code=synthetic',departure.storage);await callback.initAuth();
  assert.equal(callback.location.hash,hash);assert.equal(callback.storage.has(ssoReturnKey),false);
 });
}
for(const hash of ['#/text2sql?schema_name=%zz','#/text2sql?schema_name=%ED%A0%80','#/text2sql?schema_name=a&schema_name=b',
 '#/text2sql?schema_name=a&run=true','#/text2sql?schema_name= padded ','#/text2sql?schema_name=',
 '#/text2sql?schema_name='+('x'.repeat(513)),'#/text2sql?schema_name=%E2%80%8B','#/text2sql?schema_name=x&window=7d']){
 test('invalid schema target is not staged '+hash.slice(0,80),async()=>{
  const departure=harness(ssoTransport,hash);await departure.startSSO();
  const callback=harness(ssoTransport,'#kc_code=synthetic',departure.storage);await callback.initAuth();assert.equal(callback.location.hash,'');
 });
}
test('logout clears displayed schema details including expanded source',async()=>{
 const h=harness(ssoTransport);h.seed();h.node('legacy-text2sql-schema-detail').textContent='PRIVATE_SCHEMA_CONTEXT';
 await h.logout();assert.equal(h.node('legacy-text2sql-schema-detail').textContent,'');
});

// Refresh rotates credentials, but role/team/scope changes retire the document.
// The fixture transports do not perform that retirement on behalf of the client.
for (const [field, value] of [
  ['role', 'readonly_admin'], ['team_id', 'other-team'],
  ['scopes', ['admin:read']], ['id', 'other-subject'],
]) test('changed refresh grant retires private views and prevents replay: ' + field, async () => {
  const rotated = tokens('rotated'); rotated.user[field] = value;
  const h = harness(call => call.path === '/auth/refresh' ? response(200, rotated) : response(401));
  h.seed(); h.node('legacy-text2sql-schema-detail').textContent = 'private old text';
  h.node('modal-body').textContent = 'private modal';
  const result = await outcome(h.api('/mutation', { method: 'POST', success: 'saved' }));
  assert.equal(result.ok, false);
  assert.equal(h.reloads, 1);
  assert.equal(h.rootStyle.visibility, 'hidden');
  assert.equal(h.node('legacy-text2sql-schema-detail').textContent, '');
  assert.equal(h.node('modal-body').textContent, '');
  assert.equal(h.count('/mutation'), 1);
  assert.equal(h.toasts.length, 0);
  assert.equal(h.storage.get('authAccess'), 'rotated-access');
  assert.equal(h.storage.get('authRefresh'), 'rotated-refresh');
  assert.equal(h.storage.has('authUser'), false);
  assert.equal(h.storage.get('vibe.admin.auth.grant-review'), '1');
  assert.equal(h.loginVisible(), false);
  assert.equal((await outcome(h.api('/after'))).ok, false);
  assert.equal(h.count('/after'), 0);
});

test('equal normalized scopes preserve the document and current form', async () => {
  const rotated = tokens('rotated');
  rotated.user.scopes = ['admin:write', 'admin:read', 'admin:read'];
  const h = harness(() => response(200, rotated)); h.seed();
  h.node('unsaved').value = 'work in progress';
  h.node('legacy-text2sql-schema-detail').textContent = 'authorized source';
  assert.equal(await h.tryRefresh(), true);
  assert.equal(h.reloads, 0);
  assert.equal(h.node('unsaved').value, 'work in progress');
  assert.equal(h.node('legacy-text2sql-schema-detail').textContent, 'authorized source');
  assert.equal(h.count('/auth/me'), 0);
});

for (const changed of [false, true]) test('older refresh wire verifies actual auth/me before replay, changed=' + changed, async () => {
  const identity = deferred();
  const pair = tokens('rotated'); delete pair.user;
  const h = harness(call => {
    if (call.path === '/auth/refresh') return response(200, pair);
    if (call.path === '/auth/me') return identity.promise;
    return response(call.headers.Authorization === 'Bearer A-access' ? 401 : 200, { current: true });
  }); h.seed();
  const pending = outcome(h.api('/business'));
  await until(() => h.count('/auth/me') === 1);
  const waiting = outcome(h.api('/during', { method: 'POST' }));
  await turn();
  assert.equal(h.count('/during'), 0);
  assert.equal(h.storage.get('authRefresh'), 'rotated-refresh');
  const user = tokens('rotated').user;
  if (changed) user.team_id = 'other-team';
  identity.resolve(response(200, { auth_enabled: true, user }));
  assert.equal((await pending).ok, !changed);
  assert.equal((await waiting).ok, !changed);
  assert.equal(h.count('/business'), changed ? 1 : 2);
  assert.equal(h.count('/during'), changed ? 0 : 1);
  assert.equal(h.reloads, changed ? 1 : 0);
});

for (const stage of ['headers', 'body']) test('older-wire verification timeout preserves rotation and retires views: ' + stage, async () => {
  const never = deferred();
  const pair = tokens('rotated'); delete pair.user;
  let bodyStarted = false;
  const h = harness(call => call.path === '/auth/refresh' ? response(200, pair)
    : stage === 'headers' ? never.promise : { ...response(200), json() { bodyStarted = true; return never.promise; } });
  h.seed(); const pending = h.tryRefresh();
  await until(() => h.count('/auth/me') === 1 && (stage === 'headers' || bodyStarted));
  h.expireIdentity();
  assert.equal(await pending, false);
  assert.equal(h.calls.find(c => c.path === '/auth/me').signal.aborted, true);
  assert.equal(h.reloads, 1);
  assert.equal(h.storage.get('authRefresh'), 'rotated-refresh');
  never.resolve(stage === 'headers' ? response(200) : { auth_enabled: true, user: tokens('late').user });
  await turn();
  assert.equal(h.storage.has('authUser'), false);
});

test('logout aborts pending identity lookup without reviving rotated credentials', async () => {
  const identity = deferred(); const pair = tokens('rotated'); delete pair.user;
  const h = harness(call => call.path === '/auth/refresh' ? response(200, pair)
    : call.path === '/auth/me' ? identity.promise : response(200));
  h.seed(); const pending = h.tryRefresh();
  await until(() => h.count('/auth/me') === 1);
  await h.logout();
  assert.equal(await pending, false);
  assert.equal(h.reloads, 0);
  assert.equal(h.storage.has('authAccess'), false);
  assert.equal(h.calls.find(c => c.path === '/auth/me').signal.aborted, true);
});

test('old response body completing after a grant transition cannot paint or toast', async () => {
  const body = deferred(); const rotated = tokens('rotated'); rotated.user.role = 'readonly_admin';
  const h = harness(call => call.path === '/auth/refresh' ? response(200, rotated)
    : { ...response(200), json: () => body.promise });
  h.seed(); const old = outcome(h.api('/old', { success: 'old saved' }));
  await turn(); assert.equal(await h.tryRefresh(), false);
  body.resolve({ private: 'old secret' });
  assert.equal((await old).ok, false);
  assert.equal(h.toasts.length, 0);
});

for (const status of [401, 503]) test('grant review boot fails closed and permits explicit recovery, status=' + status, async () => {
  let recovered = false;
  const h = harness(() => recovered ? response(200, { auth_enabled: true, user: tokens('rotated').user }) : response(status));
  h.seed('rotated'); h.storage.set('vibe.admin.auth.grant-review', '1');
  await h.initAuth();
  assert.equal(h.routes, 0);
  assert.equal(h.count('/auth/refresh'), 0);
  assert.match(h.node('view').innerHTML, /권한 다시 확인/);
  assert.equal(h.storage.get('authRefresh'), 'rotated-refresh');
  assert.equal(h.authState.nav.allowed_tabs.length, 0);
  recovered = true; h.node('legacy-auth-retry').listeners.click();
  await until(() => h.routes === 1);
  assert.equal(h.storage.has('vibe.admin.auth.grant-review'), false);
  assert.equal(h.authState.user.email, 'rotated');
});

for (const invalid of [false, true]) test('authenticated navigation outage cannot reopen all menus, invalid=' + invalid, async () => {
  const transport = call => call.path === '/auth/me' ? response(200, { auth_enabled: true, user: tokens('A').user })
    : invalid ? response(200, { allowed_tabs: ['settings'] }) : response(503);
  transport.navigation = true;
  const h = harness(transport); h.seed(); await h.initAuth();
  assert.equal(h.routes, 0);
  assert.equal(h.authState.nav.allowed_tabs.length, 0);
  assert.match(h.node('view').innerHTML, /권한 다시 확인/);
  assert.equal(h.storage.get('authRefresh'), 'A-refresh');
});
