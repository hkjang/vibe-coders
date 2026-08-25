// Behavioural checks for the admin UI's client-side logic.
//
// The UI lives inside a Go raw string, so its JavaScript is never exercised by `go
// test`. This harness extracts individual functions from admin_ui.go and runs them
// against a minimal stub DOM, which keeps the assertions about behaviour rather than
// about the source text (admin_ui_static_test.go covers the textual invariants).
//
// Run via TestAdminUIBehaviour, or directly:  node testdata/admin_ui_behavior.js
'use strict';
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'admin_ui.go'), 'utf8');
const payload = source.slice(source.indexOf('`') + 1, source.lastIndexOf('`'));
const script = /<script>([\s\S]*?)<\/script>/.exec(payload)[1];

let failures = 0;
function check(name, ok) {
  if (!ok) failures++;
  console.log((ok ? '  ok   ' : '  FAIL ') + name);
}
function group(name) { console.log(name); }

// Extract one top-level function declaration by brace matching.
function grab(name) {
  const start = script.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('function not found: ' + name);
  let depth = 0;
  for (let i = script.indexOf('{', start); i < script.length; i++) {
    if (script[i] === '{') depth++;
    else if (script[i] === '}') { depth--; if (depth === 0) return script.slice(start, i + 1); }
  }
  throw new Error('unbalanced braces in ' + name);
}
function load(names, extra) {
  return new Function((extra || '') + names.map(grab).join('\n') +
    '\nreturn {' + names.join(',') + '};')();
}

// ---------- every <script> block parses ----------
group('parse');
{
  let ok = true, blocks = 0;
  for (const m of payload.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
    blocks++;
    try { new Function(m[1]); } catch (e) { ok = false; console.log('    ' + e.message); }
  }
  check('all ' + blocks + ' script block(s) parse', ok && blocks > 0);
}

// ---------- toast ----------
group('toast');
{
  const mk = (tag) => ({ tag, className: '', type: '', textContent: '', children: [], attrs: {},
    setAttribute(k, v) { this.attrs[k] = v; }, addEventListener() {},
    append(...c) { this.children.push(...c); }, remove() { host.children = host.children.filter((x) => x !== this); } });
  const host = { children: [], appendChild(el) { this.children.push(el); },
    removeChild(el) { this.children = this.children.filter((x) => x !== el); },
    get firstChild() { return this.children[0]; } };
  let timers = 0;
  const { toast } = load(['toast'], '');
  global.document = { getElementById: (id) => (id === 'toasts' ? host : null), createElement: mk };
  global.setTimeout = () => ++timers;
  global.clearTimeout = () => {};

  const ok = toast('저장되었습니다', 'ok');
  check('success uses the ok style', ok.className === 'toast ok');
  check('error is the default kind', toast('실패').className === 'toast error');
  check('message is not parsed as HTML',
    toast('<img src=x onerror=1>').children[1].textContent === '<img src=x onerror=1>');
  check('close button is labelled', toast('x').children[2].attrs['aria-label'] === '알림 닫기');
  for (let i = 0; i < 8; i++) toast('spam ' + i);
  check('stack is capped so failures cannot cover the page', host.children.length === 4);
  const before = timers; toast('err'); const afterErr = timers; toast('i', 'info');
  check('errors persist until dismissed', afterErr === before);
  check('non-errors auto-dismiss', timers === afterErr + 1);
}

// ---------- form validation ----------
group('form validation');
{
  const fields = {};
  const mk = (id, value) => {
    const el = { id, value, className: '', attrs: {}, focused: 0, listeners: [],
      classList: { s: new Set(), add(c) { this.s.add(c); }, remove(c) { this.s.delete(c); }, contains(c) { return this.s.has(c); } },
      setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; },
      focus() { this.focused++; },
      addEventListener(_, fn) { this.listeners.push(fn); } };
    fields[id] = el;
    return el;
  };
  mk('a', ''); mk('b', 'filled'); mk('c', '   ');
  // load() evaluates via new Function, which cannot close over locals here — the stub
  // has to reach the collector through the global scope.
  const toasted = [];
  global.__toasted = toasted;
  global.document = { getElementById: (id) => fields[id] || null };
  const F = load(['clearFieldErrors', 'requireFields'], 'function toast(m){ globalThis.__toasted.push(m); }\n');

  check('a fully filled form passes', F.requireFields([{ id: 'b', label: 'B' }]) === true);
  check('nothing is marked when valid', !fields.b.classList.contains('field-invalid'));

  toasted.length = 0;
  const ok = F.requireFields([{ id: 'b', label: 'B' }, { id: 'a', label: '이름' }, { id: 'c', label: 'URL' }]);
  check('an incomplete form fails', ok === false);
  check('the empty field is marked', fields.a.classList.contains('field-invalid'));
  check('whitespace counts as empty', fields.c.classList.contains('field-invalid'));
  check('the filled field is left alone', !fields.b.classList.contains('field-invalid'));
  check('marked fields are flagged for assistive tech', fields.a.attrs['aria-invalid'] === 'true');
  check('focus lands on the first offender', fields.a.focused === 1 && fields.c.focused === 0);
  check('one toast names every missing field', toasted.length === 1 && toasted[0].includes('이름') && toasted[0].includes('URL'));
  check('the filled field is not named', !toasted[0].includes('B'));

  // Typing into a marked field must clear the accusation.
  fields.a.listeners.forEach((fn) => fn());
  check('editing clears the mark', !fields.a.classList.contains('field-invalid'));

  // A field id that does not exist must fail loudly rather than pass silently.
  toasted.length = 0;
  check('a missing element is treated as empty', F.requireFields([{ id: 'nope', label: 'X' }]) === false);
}

// ---------- time formatting ----------
group('time formatting');
{
  // timeCell/timeExact escape their output; supply the escapers the real page has.
  const escapers = 'function escapeHTML(s){return String(s==null?"":s);}'
    + 'function escapeAttr(s){return String(s==null?"":s);}';
  const F = load(['parseTS', 'fmtAbsTime', 'fmtRelTime', 'timeCell', 'timeExact'], escapers + '\n');
  const now = Date.now();
  const ago = (ms) => new Date(now - ms).toISOString();
  const ahead = (ms) => new Date(now + ms).toISOString();

  check('seconds read as 방금', F.fmtRelTime(ago(5e3)) === '방금');
  check('minutes', F.fmtRelTime(ago(5 * 60e3)) === '5분 전');
  check('hours', F.fmtRelTime(ago(3 * 3600e3)) === '3시간 전');
  check('days', F.fmtRelTime(ago(2 * 86400e3)) === '2일 전');
  check('future reads as 후', F.fmtRelTime(ahead(3 * 3600e3)) === '3시간 후');
  check('imminent future', F.fmtRelTime(ahead(5e3)) === '곧');
  const old = F.fmtRelTime(ago(200 * 86400e3));
  check('beyond a month falls back to a date', /^\d/.test(old) && !old.includes('전'));
  check('empty input is safe', F.fmtRelTime('') === '-' && F.fmtRelTime(null) === '-');
  check('unparseable input is safe', F.fmtRelTime('not-a-date') === '-');
  check('absolute form omits the current year', /^\d{2}-\d{2} \d{2}:\d{2}$/.test(F.fmtAbsTime(ago(3600e3))));
  check('absolute form keeps another year', /^\d{4}-\d{2}-\d{2} /.test(F.fmtAbsTime('2001-03-04T05:06:07Z')));
  const cell = F.timeCell(ago(5 * 60e3));
  check('timeCell keeps the exact time in a title', cell.includes('title="') && cell.includes('5분 전'));
  check('timeCell renders nothing as muted', F.timeCell('').includes('muted'));
  check('timeExact stays absolute', /\d{2}-\d{2} \d{2}:\d{2}/.test(F.timeExact(ago(3600e3))));
}

// ---------- command palette ----------
group('command palette');
{
  const { paletteMatches } = load(['paletteMatches']);
  const e = { label: '라우팅', hash: '#/routing', kind: '운영' };
  check('matches a Korean label', paletteMatches('라우', e));
  check('matches the hash path', paletteMatches('rout', e));
  check('matches non-contiguous characters', paletteMatches('rtn', e));
  check('matches the owning menu', paletteMatches('운영', e));
  check('an empty query matches everything', paletteMatches('   ', e));
  check('does not match unrelated input', paletteMatches('zzzq', e) === false);

  const grp = { querySelector: (s) => (s === '.nav-group-toggle' ? { textContent: '대시보드 ▾' } : null) };
  const link = (href, label, group) => ({ getAttribute: () => href, textContent: label, closest: () => group || null });
  const links = [link('#/dashboard', '종합 대시보드', grp), link('#/settings', '설정', null),
    link('#/dashboard', '중복', grp), link('', '빈 링크', grp)];
  global.document = { querySelectorAll: () => links, getElementById: () => ({ click() {} }) };
  global.route = () => {}; global.openHelp = () => {}; global.openXViewLauncher = () => {};
  const { buildCommandIndex } = load(['buildCommandIndex']);
  const index = buildCommandIndex();
  const screens = index.filter((x) => x.kind !== '동작');
  check('entries are deduplicated by hash', screens.length === 2);
  check('links without a target are skipped', !screens.some((x) => x.hash === ''));
  check('the menu chevron is stripped from the group name', screens[0].kind === '대시보드');
  check('an ungrouped link gets a default group', screens[1].kind === '화면');
  check('global actions are appended', index.filter((x) => x.kind === '동작').length === 4);

  global.document.querySelector = (s) => (s.includes('routing') ? { textContent: ' 라우팅 ' } : null);
  const { tabLabelFor } = load(['tabLabelFor']);
  check('error boundary names the screen from the nav', tabLabelFor('routing') === '라우팅');
  check('unknown screens fall back to the tab id', tabLabelFor('nope') === 'nope');
  check('a missing tab still reads sensibly', tabLabelFor('') === '요청한');
}

// ---------- overlay focus ----------
group('overlay focus');
{
  const prelude = script.slice(script.indexOf('const focusableSelector'),
    script.indexOf('let focusReturn = null;') + 'let focusReturn = null;'.length);
  const el = (name) => ({ name, offsetParent: {}, focused: 0, focus() { this.focused++; doc.activeElement = this; } });
  const a = el('first'), b = el('middle'), c = el('last'), outside = el('page');
  const overlay = { els: [a, b, c], querySelectorAll() { return this.els; }, contains(x) { return this.els.includes(x); } };
  const doc = { activeElement: outside, contains: () => true };
  global.document = doc;
  const F = load(['focusablesIn', 'captureFocusOrigin', 'restoreFocusOrigin', 'trapFocusInside'], prelude + '\n');

  F.captureFocusOrigin();
  doc.activeElement = b;
  F.restoreFocusOrigin();
  check('closing returns focus to where it came from', doc.activeElement === outside && outside.focused === 1);
  F.restoreFocusOrigin();
  check('restoring twice is harmless', outside.focused === 1);

  const ev = (key, shift) => ({ key, shiftKey: !!shift, prevented: false, preventDefault() { this.prevented = true; } });
  doc.activeElement = c;
  let e1 = ev('Tab'); F.trapFocusInside(overlay, e1);
  check('Tab past the last element wraps to the first', e1.prevented && doc.activeElement === a);
  doc.activeElement = a;
  let e2 = ev('Tab', true); F.trapFocusInside(overlay, e2);
  check('Shift+Tab before the first wraps to the last', e2.prevented && doc.activeElement === c);
  doc.activeElement = b;
  let e3 = ev('Tab'); F.trapFocusInside(overlay, e3);
  check('Tab within the overlay is left alone', !e3.prevented);
  doc.activeElement = outside;
  let e4 = ev('Tab'); F.trapFocusInside(overlay, e4);
  check('focus that escaped is pulled back in', e4.prevented && doc.activeElement === a);
  let e5 = ev('Enter'); F.trapFocusInside(overlay, e5);
  check('keys other than Tab are untouched', !e5.prevented);
  let e6 = ev('Tab'); F.trapFocusInside({ querySelectorAll: () => [], contains: () => false }, e6);
  check('an overlay with nothing focusable is safe', e6.prevented);
  const hidden = Object.assign(el('hidden'), { offsetParent: null });
  check('hidden elements are not focus targets', F.focusablesIn({ querySelectorAll: () => [hidden, a] }).length === 1);
}

// ---------- table scroll wrapping ----------
group('table wrapping');
{
  const node = (tag, cls) => ({ tag, children: [], parentElement: null, className: cls || '',
    classList: { s: new Set(cls ? [cls] : []), contains(c) { return this.s.has(c); }, add(c) { this.s.add(c); } },
    insertBefore(n, ref) { n.parentElement = this; this.children.splice(this.children.indexOf(ref), 0, n); },
    appendChild(n) { if (n.parentElement) n.parentElement.children = n.parentElement.children.filter((x) => x !== n);
      n.parentElement = this; this.children.push(n); },
    querySelectorAll(sel) { const out = []; (function walk(x) { x.children.forEach((c) => { if (c.tag === sel) out.push(c); walk(c); }); })(this); return out; } });
  const attach = (p, c) => { c.parentElement = p; p.children.push(c); return c; };
  global.document = { getElementById: () => null, createElement: (t) => {
    const n = node(t);
    return new Proxy(n, { set(o, k, v) { if (k === 'className') String(v).split(' ').filter(Boolean).forEach((c) => o.classList.add(c)); o[k] = v; return true; } });
  } };
  const { wrapViewTables } = load(['wrapViewTables']);

  const host = node('div');
  const section = attach(host, node('section'));
  const table = attach(section, node('table'));
  wrapViewTables(host);
  check('a bare table gains a scroll box', table.parentElement.classList.contains('table-scroll'));
  check('the box stays inside the section', table.parentElement.parentElement === section);
  const wrapper = table.parentElement;
  wrapViewTables(host); wrapViewTables(host);
  check('re-rendering does not nest wrappers', table.parentElement === wrapper);

  const host2 = node('div');
  const existing = attach(host2, node('div', 'table-scroll'));
  const table2 = attach(existing, node('table'));
  wrapViewTables(host2);
  check('an existing wrapper is left alone', table2.parentElement === existing);

  const host3 = node('div');
  const t3 = attach(attach(host3, node('section')), node('table'));
  const t4 = attach(attach(host3, node('section')), node('table'));
  wrapViewTables(host3);
  check('every table on a screen is wrapped',
    t3.parentElement.classList.contains('table-scroll') && t4.parentElement.classList.contains('table-scroll'));
  wrapViewTables(node('div'));
  check('a screen with no tables is safe', true);
}

console.log(failures === 0 ? '\nall admin UI behaviour checks passed' : '\n' + failures + ' check(s) failed');
process.exit(failures === 0 ? 0 : 1);
