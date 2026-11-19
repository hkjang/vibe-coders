'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {test}=require('node:test');
const script=/<script>([\s\S]*?)<\/script>/.exec(fs.readFileSync(path.join(__dirname,'..','admin_ui.go'),'utf8'))[1];
function grab(name){
 let start=script.indexOf('function '+name+'(');assert.ok(start>=0,name);
 if(script.slice(start-6,start)==='async ')start-=6;
 let depth=0;for(let i=script.indexOf('{',start);i<script.length;i++){
  if(script[i]==='{')depth++;if(script[i]==='}'&&--depth===0)return script.slice(start,i+1);
 }throw Error(name);
}
const id=' 업무 앱 +%2F?&#/ ';
const hash=value=>'#/apps?'+new URLSearchParams({app_id:value??id});
const row=(changes={})=>({id,title:'selected app',description:'selected description',icon:'🧩',allowed_teams:'restricted-team',
 allowed_roles:'developer',status:'archived',owner:'selected owner',created_at:'2026-11-18T01:00:00Z',updated_at:'2026-11-18T02:00:00Z',
 components:[{kind:'model',ref:'selected-model',label:'selected label'}],...changes});
function harness(){
 const nodes={},calls=[];
 const node=id=>nodes[id]??(nodes[id]={innerHTML:'',textContent:'',listeners:{},focus(){},addEventListener(k,fn){this.listeners[k]=fn}});
 const h={URLSearchParams,TextEncoder,document:{getElementById:node},location:{hash:hash()},calls,nodes,reply:async()=>({app:row()}),section:(title,html)=>title+html};
 h.window=h;vm.createContext(h);
 vm.runInContext('let legacyRouteGeneration=1,authEpoch=1;function authCurrent(epoch){return epoch===authEpoch}async function api(url,opts){calls.push({url,opts});return reply(url,opts)}function route(){globalThis.retries=(globalThis.retries||0)+1}'+
 ['legacyWorkAppTarget','legacyDetailTextPages','escapeHTML','renderLegacyWorkAppDetail','renderWorkApps'].map(grab).join('\n')+
 'globalThis.retire=kind=>{if(kind==="auth")authEpoch++;else if(kind==="route")legacyRouteGeneration++;else location.hash="#/other";document.getElementById("view").innerHTML="NEW";};',h);
 h.open=async(value=id)=>{h.location.hash=hash(value);await h.renderLegacyWorkAppDetail();};
 h.click=id=>h.nodes[id].listeners.click();
 return h;
}
test('only the selected exact GET is used, including archived/restricted metadata',async()=>{
 const h=harness();await h.open();
 assert.equal(h.calls.length,1);assert.equal(h.calls[0].url,'/admin/apps?'+new URLSearchParams({view:'detail',id}));
 assert.equal(h.calls[0].opts.method,undefined);assert.equal(h.calls[0].opts.cache,'no-store');
 const html=h.nodes.view.innerHTML;
 for(const value of ['selected app','selected description','restricted-team','developer','지원 중단','selected-model','selected label'])assert.ok(html.includes(value),value);
 assert.ok(!/<input|<form|onclick=|appRun\(|appValidate\(/.test(html));
});
for(const invalid of ['other-id','null','missing-field','bad-component','bad-list']){
 test('mismatched or malformed selection is never substituted '+invalid,async()=>{
  const h=harness();h.reply=async()=>{
   const app=row();
   if(invalid==='other-id')app.id='other';
   if(invalid==='null')return {app:null};
   if(invalid==='missing-field')delete app.owner;
   if(invalid==='bad-component')app.components=[{kind:'model',ref:'private',label:42}];
   if(invalid==='bad-list')app.components={private:'hidden'};
   return {app};
  };await h.open();assert.match(h.nodes.view.innerHTML,/불러오지 못했습니다/);assert.ok(!h.nodes.view.innerHTML.includes('selected'));
 });
}
for(const raw of [hash(''),hash('a\u200bb'),hash('a\nb'),hash('a'.repeat(4097)),hash()+'&app_id=other',hash()+'&run=true',
 '#/apps?app_id=%zz','#/apps?app_id=%ED%A0%80','#/apps?app_id=%E0%A4%A','#/apps?id=wrong']){
 test('invalid raw query never opens overview or another app '+raw.slice(0,65),async()=>{
  const h=harness();h.location.hash=raw;await h.renderLegacyWorkAppDetail();assert.equal(h.calls.length,0);assert.match(h.nodes.view.innerHTML,/올바르지 않습니다/);
 });
}
for(const value of [' exact?tail ',' 앱 '+'가'.repeat(1300)+' ','a'.repeat(4096)]){
 test('full exact ID survives '+value.slice(0,15),async()=>{
  const h=harness();h.reply=async()=>({app:row({id:value})});await h.open(value);
  assert.equal(new URL(h.calls[0].url,'https://local.invalid').searchParams.get('id'),value);
  assert.match(h.nodes.view.innerHTML,/selected owner/);
 });
}
test('every component and full Unicode description is paged without extra reads',async()=>{
 const h=harness();const description='a'.repeat(16383)+'😀'+'끝'.repeat(17000);
 h.reply=async()=>({app:row({description,components:Array.from({length:101},(_,i)=>({kind:'model',ref:'model-'+i,label:'label-'+i}))})});
 await h.open();assert.match(h.nodes.view.innerHTML,/model-49<\/dd>/);assert.ok(!h.nodes.view.innerHTML.includes('model-50</dd>'));
 h.click('legacy-work-app-components-next');assert.match(h.nodes.view.innerHTML,/model-99<\/dd>/);
 h.click('legacy-work-app-components-next');assert.match(h.nodes.view.innerHTML,/model-100<\/dd>/);
 h.click('legacy-work-app-components-prev');assert.match(h.nodes.view.innerHTML,/model-50<\/dd>/);
 h.click('legacy-work-app-description-next');assert.ok(h.nodes.view.innerHTML.includes('😀'));
 h.click('legacy-work-app-description-next');assert.match(h.nodes.view.innerHTML,/3 \/ 3페이지/);
 const pages=h.legacyDetailTextPages(description);
 assert.equal(pages.map(([a,b])=>description.slice(a,b)).join(''),description);
 for(const [a,b] of pages)assert.doesNotThrow(()=>encodeURIComponent(description.slice(a,b)));
 assert.equal(h.calls.length,1);
});
for(const kind of ['auth','route','hash']){
 test('late app result cannot repaint after '+kind,async()=>{
  const h=harness();let done;h.reply=()=>new Promise(r=>done=r);const pending=h.open();h.retire(kind);done({app:row()});await pending;assert.equal(h.nodes.view.innerHTML,'NEW');
 });
 test('retired component controls cannot repaint or retry after '+kind,async()=>{
  const h=harness();await h.open();h.retire(kind);h.click('legacy-work-app-components-next');h.click('legacy-work-app-retry');
  assert.equal(h.nodes.view.innerHTML,'NEW');assert.equal(h.retries,undefined);
 });
}
test('failed read shows generic recovery and never prints server details',async()=>{
 const h=harness();h.reply=async()=>{throw Error('PRIVATE_ERROR_BODY')};await h.open();
 assert.ok(!h.nodes.view.innerHTML.includes('PRIVATE_ERROR_BODY'));assert.match(h.nodes.view.innerHTML,/불러오지 못했습니다/);
 h.click('legacy-work-app-retry');assert.equal(h.retries,1);
});
test('only allowlisted values appear and all stored text is escaped',async()=>{
 const h=harness();h.reply=async()=>({app:row({title:'<script>bad</script>',description:'<img src=x>',unknown:'HIDDEN',
 components:[{kind:'__proto__',ref:'<svg>',label:'<b>',unknown:'HIDDEN'}]}),unknown:'HIDDEN'});
 await h.open();const html=h.nodes.view.innerHTML;
 for(const text of ['&lt;script&gt;bad&lt;/script&gt;','&lt;img src=x&gt;','&lt;svg&gt;','&lt;b&gt;','__proto__'])assert.ok(html.includes(text));
 assert.ok(!/<script>|<img|<svg>|HIDDEN/.test(html));
});

for(const kind of ['auth','route','hash']) for(const failed of [false,true]){
 test('old broad app list cannot replace new detail after '+kind+' failed='+failed,async()=>{
  const h=harness();let finish;
  h.reply=()=>new Promise((resolve,reject)=>finish=failed?reject:resolve);
  const old=h.renderWorkApps();h.retire(kind);
  finish(failed?Error('old unavailable'):{apps:[]});await old;
  assert.equal(h.nodes.view.innerHTML,'NEW');
 });
}
