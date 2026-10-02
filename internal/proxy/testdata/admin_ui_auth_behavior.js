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
const http = block('// ---------- HTTP ----------', '// ---------- formatting ----------');
const nav = (name) => ({ allowed_tabs: ['settings'], default_home: '#/dashboard', marker: name });
const tokens = (name, access = name + '-access') => ({
  access_token: access, refresh_token: name + '-refresh', user: { email: name, role: 'super_admin' },
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

function harness(transport) {
  const nodes = new Map();
  const storage = new Map();
  const calls = [];
  const toasts = [];
  let routes = 0;
  function node(id) {
    if (!nodes.has(id)) {
      const classes = new Set();
      nodes.set(id, {
        id, value: '', style: {}, textContent: '', title: '', disabled: false, listeners: {},
        classList: { add: x => classes.add(x), remove: x => classes.delete(x), contains: x => classes.has(x) },
        addEventListener(type, callback) { this.listeners[type] = callback; },
        focus() {}, appendChild() {}, getAttribute() { return null; },
      });
    }
    return nodes.get(id);
  }
  const location = { hash: '', pathname: '/admin', search: '' };
  const context = vm.createContext({
    document: { getElementById: node, querySelectorAll: () => [] },
    sessionStorage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)), removeItem: k => storage.delete(k) },
    location, history: { replaceState() {} },
    setTimeout: () => 0,
    route: () => { routes++; },
    toast: message => toasts.push(message),
    fetch: async (path, options = {}) => {
      const call = { path, ...options };
      calls.push(call);
      if (path === '/auth/sso/status') return response(200, { keycloak_enabled: false });
      if (path === '/me/navigation' && !transport.navigation) return response(200, nav('default'));
      return transport(call);
    },
  });
  vm.runInContext('const tokenInput = document.getElementById("token");\n' + auth + '\n' + http +
    '\nglobalThis.client = { authState, saveAuth, clearAuth, tryRefresh, api, initAuth, bootAfterAuth, captureSSOFragment };', context);
  const client = context.client;
  return {
    ...client, calls, storage, toasts, node, location,
    get routes() { return routes; },
    seed(name = 'A') { client.authState.enabled = true; client.saveAuth(tokens(name)); },
    async login(name = 'B') {
      node('login-email').value = name; node('login-password').value = 'synthetic-password';
      await node('login-form').listeners.submit({ preventDefault() {} });
    },
    logout: () => node('auth-logout').listeners.click(),
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
    return response(count === 1 ? 401 : 200, { current: true });
  }); h.seed();
  const old = outcome(h.api('/old')); await until(() => h.count('/auth/refresh') === 1);
  await h.login();
  const current = outcome(h.api('/current')); await until(() => h.count('/auth/refresh') === 2);
  oldGate.resolve(response(200, tokens('old-rotated'))); await old;
  const next = outcome(h.api('/next')); await until(() => h.count('/next') === 1); await turn();
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
