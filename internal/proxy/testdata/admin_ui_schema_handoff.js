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

const name='스키마 +%2F?&#/정확';
const hash=value=>'#/text2sql?'+new URLSearchParams({schema_name:value??name});
const row=(changes={})=>({name,team:'selected-team',dialect:'postgres',schema_text:'PRIVATE_SCHEMA_CONTEXT',allowed_tables:['PRIVATE_TABLE'],
 enabled:false,is_default:true,version:7,collected_at:'2026-11-18T01:00:00Z',source_fingerprint:'selected-fingerprint',updated_at:'2026-11-18T02:00:00Z',...changes});
const response=(changes={},raw=true)=>({schema:row(changes),raw_content_available:raw});
function harness(){
 const nodes={},calls=[];
 const node=id=>nodes[id]??(nodes[id]={innerHTML:'',textContent:'',listeners:{},focus(){},addEventListener(k,fn){this.listeners[k]=fn}});
 const h={URLSearchParams,TextEncoder,document:{getElementById:node},location:{hash:hash()},calls,nodes,reply:async()=>response(),section:(title,html)=>title+html};
 h.window=h;vm.createContext(h);
 vm.runInContext('let legacyRouteGeneration=1,authEpoch=1;function authCurrent(epoch){return epoch===authEpoch}async function api(url,opts){calls.push({url,opts});return reply(url,opts)}function route(){globalThis.retries=(globalThis.retries||0)+1}'+
 ['legacyText2SQLSchemaTarget','legacyDetailTextPages','escapeHTML','renderLegacyText2SQLSchemaDetail'].map(grab).join('\n')+
 'globalThis.retire=kind=>{if(kind==="auth")authEpoch++;else if(kind==="route")legacyRouteGeneration++;else location.hash="#/other";document.getElementById("view").innerHTML="NEW";};',h);
 h.open=async(value=name)=>{h.location.hash=hash(value);await h.renderLegacyText2SQLSchemaDetail();};
 h.click=id=>h.nodes[id].listeners.click();
 return h;
}
test('exact detail reads only selected schema and no editor/SQL execution',async()=>{
 const h=harness();await h.open();
 assert.equal(h.calls.length,1);assert.equal(h.calls[0].url,'/admin/text2sql?'+new URLSearchParams({view:'schema',name}));
 assert.equal(h.calls[0].opts.method,undefined);assert.equal(h.calls[0].opts.cache,'no-store');
 const html=h.nodes.view.innerHTML;
 for(const value of ['selected-team','postgres','중지됨','기본 스키마','selected-fingerprint','PRIVATE_TABLE'])assert.ok(html.includes(value),value);
 assert.ok(!html.includes('PRIVATE_SCHEMA_CONTEXT'));assert.ok(!/<input|<textarea|<form|onclick=/.test(html));
 h.click('legacy-schema-toggle');assert.match(h.nodes.view.innerHTML,/PRIVATE_SCHEMA_CONTEXT/);assert.match(h.nodes.view.innerHTML,/aria-expanded="true"/);
 h.click('legacy-schema-toggle');assert.ok(!h.nodes.view.innerHTML.includes('PRIVATE_SCHEMA_CONTEXT'));assert.equal(h.calls.length,1);
});
test('redacted schema never means unrestricted tables or exposes source',async()=>{
 const h=harness();h.reply=async()=>response({schema_text:'[sensitive-content-omitted]',allowed_tables:[]},false);await h.open();
 const html=h.nodes.view.innerHTML;assert.match(html,/스키마 설명과 허용 테이블은 비공개/);
 assert.ok(!/PRIVATE_|sensitive-content-omitted|설명 보기|별도 테이블 제한/.test(html));
});
for(const failure of ['name','raw-marker','raw-tables','flag','missing-row','table-type','version','enabled','text-type']){
 test('invalid identity or sensitive-content contract is rejected '+failure,async()=>{
  const h=harness();h.reply=async()=>{
   const data=response();
   if(failure==='name')data.schema.name='OTHER_PRIVATE_SCHEMA';
   if(failure==='raw-marker')data.raw_content_available=false;
   if(failure==='raw-tables'){data.raw_content_available=false;data.schema.schema_text='[sensitive-content-omitted]';}
   if(failure==='flag')delete data.raw_content_available;
   if(failure==='missing-row')delete data.schema;
   if(failure==='table-type')data.schema.allowed_tables=[42];
   if(failure==='version')data.schema.version=1.5;
   if(failure==='enabled')data.schema.enabled='true';
   if(failure==='text-type')data.schema.schema_text=null;
   return data;
  };await h.open();assert.match(h.nodes.view.innerHTML,/불러오지 못했습니다/);assert.ok(!/PRIVATE_|selected-team/.test(h.nodes.view.innerHTML));
 });
}
for(const raw of [hash(''),hash(' padded '),hash('a\u200bb'),hash('x'.repeat(513)),hash()+'&schema_name=other',hash()+'&run=true',
 '#/text2sql?schema_name=%zz','#/text2sql?schema_name=%ED%A0%80','#/text2sql?schema_name=%E0%A4%A','#/text2sql?name=wrong']){
 test('invalid raw address never turns into another selection or overview '+raw.slice(0,70),async()=>{
  const h=harness();h.location.hash=raw;await h.renderLegacyText2SQLSchemaDetail();assert.equal(h.calls.length,0);assert.match(h.nodes.view.innerHTML,/올바르지 않습니다/);
 });
}
for(const [raw,exact] of [['#/text2sql?schema_name=exact?tail','exact?tail'],[hash('😀'.repeat(512)),'😀'.repeat(512)]]){
 test('full raw identifier survives '+exact.slice(0,20),async()=>{
  const h=harness();h.reply=async()=>response({name:exact});h.location.hash=raw;await h.renderLegacyText2SQLSchemaDetail();
  assert.equal(new URL(h.calls[0].url,'https://local.invalid').searchParams.get('name'),exact);assert.match(h.nodes.view.innerHTML,/selected-team/);
 });
}
test('full text pagination never loses or splits surrogate pairs',async()=>{
 const h=harness();const text='a'.repeat(16383)+'😀'+'끝'.repeat(17000);
 const pages=h.legacyDetailTextPages(text);assert.equal(pages.map(([a,b])=>text.slice(a,b)).join(''),text);
 for(const [a,b] of pages){assert.ok(b-a<=16384);assert.doesNotThrow(()=>encodeURIComponent(text.slice(a,b)));}
 h.reply=async()=>response({schema_text:text});await h.open();h.click('legacy-schema-toggle');
 assert.ok(h.nodes.view.innerHTML.includes('a'.repeat(16383)));assert.ok(!h.nodes.view.innerHTML.includes('😀'));
 h.click('legacy-schema-text-next');assert.ok(h.nodes.view.innerHTML.includes('😀'));assert.match(h.nodes.view.innerHTML,/2 \/ 3페이지/);
 h.click('legacy-schema-text-next');assert.match(h.nodes.view.innerHTML,/3 \/ 3페이지/);
 h.click('legacy-schema-text-prev');assert.ok(h.nodes.view.innerHTML.includes('😀'));assert.equal(h.calls.length,1);
});
test('allowed tables page through every exact value without additional requests',async()=>{
 const h=harness();h.reply=async()=>response({allowed_tables:Array.from({length:101},(_,i)=>'table-'+i)});await h.open();
 assert.match(h.nodes.view.innerHTML,/table-49<\/li>/);assert.ok(!h.nodes.view.innerHTML.includes('table-50</li>'));
 h.click('legacy-schema-table-next');assert.match(h.nodes.view.innerHTML,/table-99<\/li>/);
 h.click('legacy-schema-table-next');assert.match(h.nodes.view.innerHTML,/table-100<\/li>/);assert.match(h.nodes.view.innerHTML,/3 \/ 3페이지/);
 h.click('legacy-schema-table-prev');assert.match(h.nodes.view.innerHTML,/table-50<\/li>/);assert.equal(h.calls.length,1);
});
for(const kind of ['auth','route','hash']){
 test('late response cannot repaint after '+kind,async()=>{
  const h=harness();let resolve;h.reply=()=>new Promise(r=>resolve=r);const pending=h.open();h.retire(kind);resolve(response());await pending;assert.equal(h.nodes.view.innerHTML,'NEW');
 });
 test('retired view controls cannot replay source or retry after '+kind,async()=>{
  const h=harness();await h.open();h.retire(kind);h.click('legacy-schema-toggle');h.click('legacy-schema-retry');assert.equal(h.nodes.view.innerHTML,'NEW');assert.equal(h.retries,undefined);
 });
}
test('missing or failed reads remain generic and do not fall back to the overview',async()=>{
 const h=harness();h.reply=async()=>{throw Error('PRIVATE_ERROR_BODY')};await h.open();assert.ok(!h.nodes.view.innerHTML.includes('PRIVATE_ERROR_BODY'));
 assert.match(h.nodes.view.innerHTML,/삭제되었거나 조회 범위 밖/);h.click('legacy-schema-retry');assert.equal(h.retries,1);assert.equal(h.calls.length,1);
});
test('authorized text is escaped and unknown response fields remain absent',async()=>{
 const h=harness();h.reply=async()=>({...response({schema_text:'<script>bad</script>',team:'<img src=x>',password:'HIDDEN_FIELD'}),unknown:'HIDDEN_FIELD'});
 await h.open();h.click('legacy-schema-toggle');const html=h.nodes.view.innerHTML;
 assert.match(html,/&lt;script&gt;bad&lt;\/script&gt;/);assert.match(html,/&lt;img src=x&gt;/);assert.ok(!/<script>|<img|HIDDEN_FIELD/.test(html));
});
