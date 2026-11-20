// Execute the actual embedded Legacy functions against deferred HTTP and a small DOM.
// Real rendering/native navigation is additionally exercised in the isolated browser suite.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'admin_ui.go'), 'utf8');
const script = /<script>([\s\S]*?)<\/script>/.exec(source)[1];
function grab(name) {
  let start = script.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name);
  if (script.slice(start - 6, start) === 'async ') start -= 6;
  let depth = 0;
  for (let i = script.indexOf('{', start); i < script.length; i++) {
    if (script[i] === '{') depth++;
    if (script[i] === '}' && --depth === 0) return script.slice(start, i + 1);
  }
  throw Error('Unbalanced function: ' + name);
}
const detailStart = script.indexOf('    window.openRequestDetail =');
const detailEnd = script.indexOf('\n    function msLabel', detailStart);
assert.ok(detailStart >= 0 && detailEnd > detailStart);
const detailCode = script.slice(detailStart, detailEnd);
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function harness(hash = '#/requests') {
  const nodes = {};
  function node(id) {
    if (nodes[id]) return nodes[id];
    const classes = new Set();
    return nodes[id] = {
      innerHTML: '', textContent: '', value: id === 'f-limit' ? '100' : id === 'f-tz' ? 'Asia/Seoul' : '',
      options: [{value:'Asia/Seoul'}, {value:'UTC'}], appendChild(option) { this.options.push(option); },
      events: {}, classList: { contains: x => classes.has(x), add: x => classes.add(x), remove: x => classes.delete(x) },
      addEventListener(name, fn) { this.events[name] = fn; }, focus() {},
    };
  }
  const calls = [], opened = [], wired = [], feedback = [];
  const ctx = {
    URLSearchParams, TextEncoder, console, nodes, calls, opened, wired, feedback,
    document: { getElementById: node, querySelectorAll: () => ctx.rows || [], createElement: () => ({}) }, location: { hash },
    history: { replaceState(_state, _title, next) { ctx.location.hash = next; } },
    suggest: async () => [],
    request: async url => {
      if (url.startsWith('/admin/requests?')) return { requests: [] };
      const id = decodeURIComponent(url.slice('/admin/requests/'.length).split('/')[0]);
      return { request: { id, trace_id: id } };
    },
  };
  ctx.window = ctx;
  const prelude = [
    'let modalGeneration=0, legacyRouteGeneration=0, requestDetailGeneration=0, authEpoch=0;',
    'let modalStack=[], currentModalState=null;',
    'function authCurrent(epoch){ return authEpoch===epoch; }',
    'function api(url){ calls.push(url); return request(url); }',
    'function _applyModalState(state){ currentModalState=state; document.getElementById("modal-body").innerHTML=state.html; document.getElementById("modal-title").textContent=state.title; opened.push(state); }',
    'function updateModalBack(){} function captureFocusOrigin(){} function restoreFocusOrigin(){}',
    'function traceWaterfallHTML(){return "";} function requestDetailHTML(detail){return detail.request.id;}',
    'function wireFeedbackEditor(id){feedback.push(id);} function wireNoteEditor(id){wired.push(id);} function escapeHTML(value){return String(value);}',
    'function suggestList(field){return suggest(field);} function section(_title,html){return html;}',
    'function datalist(){return "";} function requestsTable(rows){return JSON.stringify(rows);}',
    'function openDiffModal(){} function updateDiffCount(){}',
    'function attachDiffSelectionHandlers(){} function makeSortable(){}',
    'globalThis.state={navigate(hash){legacyRouteGeneration++;location.hash=hash;document.getElementById("view").innerHTML="NEW_SCREEN";}, retire(){authEpoch++;}};',
  ].join('\n');
  vm.runInNewContext(prelude + '\n' + [
    'parseHash', 'updateHashParams', 'openModal', 'modalBack', 'closeModal',
    'restoreRequestTimeInput', 'legacyRequestTimeValid', 'legacyRequestTimeZoneValid', 'restoreRequestTimeZone',
    'legacyRequestDetailIDValid', 'renderRequestsView', 'attachRequestRowHandlers',
  ].map(grab).join('\n') + '\n' + detailCode, ctx);
  return ctx;
}
let count = 0;
async function test(name, fn) {
  await fn(); count++; console.log('ok ' + count + ' - ' + name);
}
async function main() {
  await test('a public Unicode/percent identifier reaches the unchanged endpoint exactly once', async () => {
    const h=harness(); const id='public 한글%2F+#?';
    await h.openRequestDetail(id);
    assert.equal(h.calls[0], '/admin/requests/' + encodeURIComponent(id));
    assert.equal(h.calls.length,4); assert.equal(h.opened.length,1);
    assert.equal(h.opened[0].html,id); assert.deepEqual(h.wired,[id]);
  });
  for (const id of ['', '.', '..', 'diff', 'io', 'a/b', 'a\nb', 'a\u0085b', '\ud800', 'a'.repeat(4097)]) {
    await test('an invalid/reserved detail ID does not issue HTTP ('+JSON.stringify(id.slice(0,16))+')', async()=>{
      const h=harness(); await h.openRequestDetail(id); assert.equal(h.calls.length,0); assert.equal(h.opened.length,1); assert.equal(h.opened[0].title,'오류'); assert.match(h.opened[0].html,/요청 상세 주소/);
    });
  }
  await test('newer detail selection wins when the first response completes last', async()=>{
    const h=harness(), a=deferred(), b=deferred(), original=h.request;
    h.request=url=>url==='/admin/requests/a'?a.promise:url==='/admin/requests/b'?b.promise:original(url);
    const first=h.openRequestDetail('a'), second=h.openRequestDetail('b');
    b.resolve({request:{id:'b',trace_id:'b'}}); await second;
    a.resolve({request:{id:'a',trace_id:'a'}}); await first;
    assert.deepEqual(h.opened.map(x=>x.html),['b']); assert.deepEqual(h.wired,['b']);
  });
  await test('ordinary row clicks share selection ownership and preserve note, feedback and analysis context', async()=>{
    const h=harness(), a=deferred(), b=deferred(), original=h.request;
    h.request=url=>url==='/admin/requests/a'?a.promise:url==='/admin/requests/b'?b.promise:original(url);
    const rowA=h.document.getElementById('row-a'),rowB=h.document.getElementById('row-b');
    rowA.dataset={requestId:'a'};rowB.dataset={requestId:'b'};h.rows=[rowA,rowB];h.attachRequestRowHandlers();
    const event={target:{closest:()=>null}};
    const first=rowA.events.click(event),second=rowB.events.click(event);
    b.resolve({request:{id:'b',trace_id:'b'}});await second;
    a.resolve({request:{id:'a',trace_id:'a'}});await first;
    assert.deepEqual(h.opened.map(x=>x.html),['b']);assert.equal(h.opened[0].requestId,'b');
    assert.deepEqual(h.feedback,['b']);assert.equal(h.calls.length,4);
    await rowA.events.click({target:{closest:()=>({})}});assert.equal(h.calls.length,4);
  });
  for (const transition of ['navigate','hash','close','other-modal','auth','away-and-back']) {
    await test('late detail success is suppressed after '+transition, async()=>{
      const h=harness(), gate=deferred(), original=h.request;
      h.request=url=>url==='/admin/requests/a'?gate.promise:original(url);
      const pending=h.openRequestDetail('a');
      if(transition==='navigate')h.state.navigate('#/settings');
      if(transition==='hash')h.location.hash='#/requests?model=public';
      if(transition==='close')h.closeModal();
      if(transition==='other-modal')h.openModal('other','OTHER');
      if(transition==='auth')h.state.retire();
      if(transition==='away-and-back'){h.state.navigate('#/settings');h.state.navigate('#/requests');}
      gate.resolve({request:{id:'a',trace_id:'a'}});await pending;
      assert.equal(h.opened.some(x=>x.html==='a'),false);assert.equal(h.wired.length,0);
    });
  }
  await test('late HTTP failure cannot reopen an error modal after navigation', async()=>{
    const h=harness(), gate=deferred(), original=h.request;
    h.request=url=>url==='/admin/requests/a'?gate.promise:original(url);
    const pending=h.openRequestDetail('a');h.state.navigate('#/settings');
    gate.reject(Error('public retired failure'));await pending;assert.equal(h.opened.length,0);
  });
  await test('current HTTP failure still shows an error, allowing recovery', async()=>{
    const h=harness();h.request=async()=>{throw Error('public current failure');};
    await h.openRequestDetail('a');assert.equal(h.opened.length,1);assert.equal(h.opened[0].title,'오류');
  });
  await test('Legacy hash request ID opens the exact detail after the list, without sending ID as a list filter', async()=>{
    const id='public 한글%2F+#?';const params=new URLSearchParams({request_id:id,model:'public-model'});
    const h=harness('#/requests?'+params);await h.renderRequestsView(params);
    assert.equal(h.opened[0].html,id);
    assert.equal(new URLSearchParams(h.calls[0].split('?')[1]).has('request_id'),false);
    assert.equal(new URLSearchParams(h.location.hash.split('?')[1]).get('request_id'),id);
    assert.equal(h.calls.filter(url=>url==='/admin/requests/'+encodeURIComponent(id)).length,1);
  });
  for (const query of ['request_id=', 'request_id=a&request_id=b', 'request_id=a%2Fb', 'request_id=diff']) {
    await test('invalid deep link is explained without list/detail calls: '+query, async()=>{
      const h=harness('#/requests?'+query);await h.renderRequestsView(new URLSearchParams(query));
      assert.equal(h.calls.length,0);assert.match(h.nodes.view.innerHTML,/요청 상세 주소/);
    });
  }
  await test('navigation while suggestions load cannot overwrite the new screen', async()=>{
    const h=harness(), gate=deferred();h.suggest=()=>gate.promise;
    const pending=h.renderRequestsView(new URLSearchParams({request_id:'a'}));
    h.state.navigate('#/settings');gate.resolve([]);await pending;
    assert.equal(h.nodes.view.innerHTML,'NEW_SCREEN');assert.equal(h.calls.length,0);
  });
  await test('navigation while list loads cannot open the old selected detail', async()=>{
    const h=harness(), gate=deferred();h.request=()=>gate.promise;
    const pending=h.renderRequestsView(new URLSearchParams({request_id:'a'}));
    while(!h.calls.length)await Promise.resolve();
    h.state.navigate('#/settings');gate.resolve({requests:[]});await pending;
    assert.equal(h.nodes.view.innerHTML,'NEW_SCREEN');assert.equal(h.opened.length,0);assert.equal(h.calls.length,1);
  });
  await test('opening another modal while the initial list loads retires automatic detail opening', async()=>{
    const h=harness(), gate=deferred();h.request=()=>gate.promise;
    const pending=h.renderRequestsView(new URLSearchParams({request_id:'a'}));
    while(!h.calls.length)await Promise.resolve();
    h.openModal('other','OTHER');gate.resolve({requests:[]});await pending;
    assert.deepEqual(h.opened.map(x=>x.html),['OTHER']);assert.equal(h.calls.length,1);
  });
  await test('a newer submitted filter retires the initial deep-link selection and list response', async()=>{
    const h=harness(), first=deferred(), second=deferred();let lists=0;
    h.request=()=>++lists===1?first.promise:second.promise;
    const pending=h.renderRequestsView(new URLSearchParams({request_id:'a'}));
    while(!h.calls.length)await Promise.resolve();
    h.nodes['f-model'].value='public-new';
    const submitted=h.nodes['req-filter'].events.submit({preventDefault(){}});
    first.resolve({requests:[{id:'old'}]});await pending;
    second.resolve({requests:[{id:'new'}]});await submitted;
    assert.equal(h.opened.length,0);assert.equal(h.calls.length,2);
    assert.match(h.nodes['req-results'].innerHTML,/new/);
    assert.equal(new URLSearchParams(h.location.hash.split('?')[1]).has('request_id'),false);
  });

  for (const from of ['2026-11-19', '2026-11-19 01:02:03', '2026-11-19T01:02:03.123456789+05:45']) {
    await test('handoff preserves exact time and an additional IANA zone: '+from, async()=>{
      const params=new URLSearchParams({from,to:'2026-11-20',tz:'Asia/Kathmandu',limit:'37',ip:'2001:0db8::1',model:'public %2F+#?',language:'한국어'});
      const h=harness('#/requests?'+params);await h.renderRequestsView(params);
      assert.equal(h.calls.length,1);
      assert.deepEqual([...new URLSearchParams(h.calls[0].split('?')[1])].sort(),[...params].sort());
      assert.equal(h.nodes['f-from'].value,from);assert.equal(h.nodes['f-tz'].value,'Asia/Kathmandu');
    });
  }
  for (const from of ['2026-02-30','2025-02-29','2026-01-01T24:00','2026-01-01T01:02:03+24:00','2026-01-01T01:02:03.1','2026-01-01T01:02Z']) {
    await test('invalid time does not silently remove the bound: '+from, async()=>{
      const h=harness();await h.renderRequestsView(new URLSearchParams({from,request_id:'a'}));
      assert.equal(h.calls.length,0);assert.equal(h.opened.length,0);
      assert.equal(h.nodes['req-filter-error'].hidden,false);assert.match(h.nodes['req-filter-error'].textContent,/날짜/);
      await h.nodes['req-reset'].events.click();assert.equal(h.calls.length,1);
      assert.equal(h.nodes['req-filter-error'].hidden,true);assert.equal(h.nodes['f-from'].type,'datetime-local');
    });
  }
  await test('invalid timezone blocks the list and initial detail until corrected', async()=>{
    const h=harness();await h.renderRequestsView(new URLSearchParams({from:'2026-11-19',tz:'Not/AZone',request_id:'a'}));
    assert.equal(h.calls.length,0);assert.equal(h.opened.length,0);
    h.nodes['f-tz'].value='UTC';await h.nodes['req-filter'].events.submit({preventDefault(){}});
    assert.equal(h.calls.length,1);assert.equal(h.nodes['req-filter-error'].hidden,true);
  });
  console.log('All '+count+' Legacy request handoff checks passed.');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
