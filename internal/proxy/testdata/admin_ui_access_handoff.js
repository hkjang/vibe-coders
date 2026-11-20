"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
const {test}=require("node:test");
const script=/<script>([\s\S]*?)<\/script>/.exec(fs.readFileSync(path.join(__dirname,"..","admin_ui.go"),"utf8"))[1];
function grab(name){
 let start=script.indexOf("function "+name+"(");assert.ok(start>=0,name);
 if(script.slice(start-6,start)==="async ")start-=6;
 let depth=0;for(let i=script.indexOf("{",start);i<script.length;i++){
  if(script[i]==="{")depth++;if(script[i]==="}"&&--depth===0)return script.slice(start,i+1);
 }throw Error(name);
}

const id='shared-id';
const hash=(resource='key',value=id)=>'#/users?'+new URLSearchParams({resource,id:value});
const row=(resource,changes={})=>({id,name:'Selected metadata',created_at:'2026-11-18T01:02:03.456Z',
 ...(resource==='key'?{owner:'selected-owner',team:'selected-team',user_id:'',service_account_id:'',role:'viewer',status:'active',
 expires_at:'',revoked_at:'',scopes:['admin:read'],allowed_ips:null,allowed_models:[],denied_models:[],allowed_providers:[],denied_providers:[],budget_limit_krw:1234}:
 resource==='account'?{email:'selected@example.invalid',role:'viewer',status:'disabled',team_id:'selected-team',team_name:'Selected team'}:{updated_at:'2026-11-18T01:02:03.456Z'}),...changes});
const reply=(resource,rows)=>({...{[resource==='key'?'api_keys':resource==='account'?'accounts':'auth_teams']:rows},total:rows.length,limit:1,offset:0});
function harness(){
 const nodes={},calls=[];
 const node=id=>nodes[id]??(nodes[id]={innerHTML:'',textContent:'',listeners:{},focus(){},addEventListener(k,fn){this.listeners[k]=fn}});
 const h={URLSearchParams,TextEncoder,document:{getElementById:node},location:{hash:hash()},calls,nodes,reply:async()=>reply('key',[row('key')]),section:(title,html)=>title+html};
 h.window=h;vm.createContext(h);
 vm.runInContext('let legacyRouteGeneration=1,authEpoch=1;function authCurrent(epoch){return epoch===authEpoch}async function api(url,opts){calls.push({url,opts});return reply(url,opts)}function route(){globalThis.retries=(globalThis.retries||0)+1}'+
 ['legacyAccessTarget','legacyAccessKeyLifecycle','escapeHTML','renderLegacyAccessDetail'].map(grab).join('\n')+
 'globalThis.retire=kind=>{if(kind==="auth")authEpoch++;else if(kind==="route")legacyRouteGeneration++;else location.hash="#/other";document.getElementById("view").innerHTML="NEW";};',h);
 h.open=async(resource='key',value=id)=>{h.location.hash=hash(resource,value);await h.renderLegacyAccessDetail();};
 return h;
}
for(const resource of ['key','account','team']){
 test('same ID across resource kinds reads exact endpoint and only public fields '+resource,async()=>{
  const h=harness();h.reply=async()=>reply(resource,[row(resource,{password_hash:'HIDDEN_HASH',key_hash:'HIDDEN_HASH',api_key:'HIDDEN_KEY',unknown:'HIDDEN_UNKNOWN'})]);await h.open(resource);
  assert.equal(h.calls.length,1);const url=new URL(h.calls[0].url,'https://local.invalid');
  assert.equal(url.pathname,resource==='key'?'/admin/api-keys':resource==='account'?'/admin/users':'/admin/teams');
  assert.equal(url.searchParams.get('id'),id);assert.equal(h.calls[0].opts.method,undefined);assert.equal(h.calls[0].opts.cache,'no-store');
  if(resource!=='key')assert.deepEqual(Object.fromEntries(url.searchParams),{view:resource==='account'?'accounts':'registered',id,limit:'1',offset:'0'});
  assert.match(h.nodes.view.innerHTML,/Selected metadata/);assert.ok(!/HIDDEN_|<input|<form|onclick=/.test(h.nodes.view.innerHTML));
 });
 test('missing scoped resource stays missing '+resource,async()=>{
  const h=harness();h.reply=async()=>reply(resource,[]);await h.open(resource);assert.match(h.nodes.view.innerHTML,/조회 가능한 항목이 없습니다/);assert.equal(h.calls.length,1);
 });
 for(const failure of ['identity','duplicate','shape','envelope']){
  test('mismatched result is never substituted '+resource+' '+failure,async()=>{
   const h=harness();h.reply=async()=>{const value=reply(resource,[row(resource,{id:failure==='identity'?'other':id,name:failure==='shape'?42:'PRIVATE_METADATA'})]);
    if(failure==='duplicate')value[resource==='key'?'api_keys':resource==='account'?'accounts':'auth_teams'].push(row(resource));
    if(failure==='envelope') {if(resource==='key')value.api_keys=null;else value.offset=1;}return value;
   };await h.open(resource);assert.match(h.nodes.view.innerHTML,/확인하지 못했습니다/);assert.ok(!h.nodes.view.innerHTML.includes('PRIVATE_METADATA'));
  });
 }
}
for(const resource of ['account','team']){
 test('long whitespace Unicode ID remains exact '+resource,async()=>{
  const exact=' 계정 +%2F?&#/ '+'가'.repeat(1300)+' ';
  const h=harness();h.reply=async()=>reply(resource,[row(resource,{id:exact})]);await h.open(resource,exact);
  assert.equal(new URL(h.calls[0].url,'https://local.invalid').searchParams.get('id'),exact);assert.match(h.nodes.view.innerHTML,/Selected metadata/);
 });
}
for(const raw of [hash('key','a/b'),hash('key','x'.repeat(513)),hash('account','x'.repeat(4097)),hash('team','\u200b'),
 '#/users?resource=account&id=%ED%A0%80','#/users?resource=team&id=%zz',hash()+'&id=other',hash()+'&resource=team',
 '#/users?resource=key',hash()+'&save=true',hash('unknown'),'#/users?resource=team&id=']){
 test('invalid destination sends no request '+raw.slice(0,80),async()=>{
  const h=harness();h.location.hash=raw;await h.renderLegacyAccessDetail();assert.equal(h.calls.length,0);assert.match(h.nodes.view.innerHTML,/올바르지 않습니다/);
 });
}
for(const kind of ['route','hash','auth']){
 test('retired response and retry cannot repaint '+kind,async()=>{
  const h=harness();let resolve;h.reply=()=>new Promise(r=>resolve=r);const pending=h.open();h.retire(kind);resolve(reply('key',[row('key')]));await pending;assert.equal(h.nodes.view.innerHTML,'NEW');
 });
}
test('errors stay generic and retry is owned by the current session',async()=>{
 const h=harness();h.reply=async()=>{throw Error('PRIVATE_ERROR')};await h.open();
 assert.ok(!h.nodes.view.innerHTML.includes('PRIVATE_ERROR'));h.nodes['legacy-access-retry'].listeners.click();assert.equal(h.retries,1);
 h.retire('auth');h.nodes['legacy-access-retry'].listeners.click();assert.equal(h.retries,1);
});
test('authorized metadata is escaped and literal query question marks survive',async()=>{
 const h=harness();h.location.hash='#/users?resource=account&id=public?tail';
 h.reply=async()=>reply('account',[row('account',{id:'public?tail',name:'<script>unsafe</script>'})]);await h.renderLegacyAccessDetail();
 assert.equal(new URL(h.calls[0].url,'https://local.invalid').searchParams.get('id'),'public?tail');
 assert.match(h.nodes.view.innerHTML,/&lt;script&gt;/);assert.ok(!h.nodes.view.innerHTML.includes('<script>'));
});
for(const [change,label] of [[{},'사용'],[{revoked_at:'2026-01-01'},'폐기'],[{status:'disabled'},'disabled'],[{expires_at:'2020-01-01'},'만료'],
 [{expires_at:'invalid'},'만료 시각 확인 필요'],[{replaced_by:'new'},'만료 시각 확인 필요'],[{replaced_by:'new',grace_ends_at:'2099-01-01'},'교체 유예 중'],
 [{replaced_by:'new',grace_ends_at:'2020-01-01'},'유예 종료']]){
 test('key lifecycle is a truthful query-time snapshot '+label,async()=>{
  const h=harness();h.reply=async()=>reply('key',[row('key',change)]);await h.open();
  assert.match(h.nodes.view.innerHTML,/수명 상태\(조회 시각 기준\)/);assert.ok(h.nodes.view.innerHTML.includes(label));assert.match(h.nodes.view.innerHTML,/조회 시각\(UTC\)/);
 });
}
