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

const id=' 워크플로 +%2F?&#/ ';
const hash=value=>'#/workflows?'+new URLSearchParams({workflow_id:value??id});
const row=(changes={})=>({id,name:'selected workflow',description:'selected description',allowed_teams:'restricted-team',
 enabled:false,created_by:'selected creator',created_at:'2026-11-18T01:00:00Z',updated_at:'2026-11-18T02:00:00Z',
 steps:[{name:'selected step',type:'chat',ref:'selected-model',timeout_ms:100,max_tokens:99,max_cost_krw:12,
 allowed_tools:['selected-tool'],allowed_tables:['selected-table'],note:'selected-note'}],...changes});
function harness(){
 const nodes={},calls=[];
 const node=id=>nodes[id]??(nodes[id]={innerHTML:'',textContent:'',listeners:{},focus(){},addEventListener(k,fn){this.listeners[k]=fn}});
 const h={URLSearchParams,TextEncoder,document:{getElementById:node},location:{hash:hash()},calls,nodes,reply:async()=>({workflow:row()}),section:(title,html)=>title+html};
 h.window=h;vm.createContext(h);
 vm.runInContext('let legacyRouteGeneration=1,authEpoch=1;function authCurrent(epoch){return epoch===authEpoch}async function api(url,opts){calls.push({url,opts});return reply(url,opts)}function route(){globalThis.retries=(globalThis.retries||0)+1}'+
 ['legacyWorkflowTarget','legacyWorkflowDefinition','legacyDetailTextPages','escapeHTML','renderLegacyWorkflowDetail','renderWorkflows'].map(grab).join('\n')+
 'globalThis.retire=kind=>{if(kind==="auth")authEpoch++;else if(kind==="route")legacyRouteGeneration++;else location.hash="#/other";document.getElementById("view").innerHTML="NEW";};',h);
 h.open=async(value=id)=>{h.location.hash=hash(value);await h.renderLegacyWorkflowDetail();};
 h.click=id=>h.nodes[id].listeners.click();
 return h;
}

test('exact read displays every stored sequential field without execution',async()=>{
 const h=harness();await h.open();
 assert.equal(h.calls.length,1);assert.equal(h.calls[0].url,'/admin/workflows?'+new URLSearchParams({view:'detail',id}));
 assert.equal(h.calls[0].opts.method,undefined);assert.equal(h.calls[0].opts.cache,'no-store');
 const html=h.nodes.view.innerHTML;
 for(const value of ['selected workflow','selected description','restricted-team','selected creator','selected-model','selected-tool','selected-table','selected-note','timeout_ms','max_cost_krw','max_tokens'])assert.ok(html.includes(value),value);
 assert.ok(!/<input|<form|onclick=|wfDryRun\(|wfPublish\(/.test(html));
});
test('graph conditions and every edge remain in the projected definition',async()=>{
 const h=harness();h.reply=async()=>({workflow:row({steps:[{id:'choose',name:'조건',type:'condition',condition:{operator:'equals',value:'matched-input'}},{id:'finish',name:'종료',type:'approval'}],
 flow:{version:1,entry:'choose',edges:[{from:'choose',to:'finish',when:'true'},{from:'choose',to:'$end',when:'false'},{from:'finish',to:'$end',when:'next'}]}})});
 await h.open();for(const text of ['matched-input','choose','finish','$end','true','false','next','분기 흐름 v1'])assert.ok(h.nodes.view.innerHTML.includes(text),text);
});
test('historical null steps is a valid empty sequential definition',async()=>{
 const h=harness();h.reply=async()=>({workflow:row({steps:null})});await h.open();
 assert.match(h.nodes.view.innerHTML,/등록된 단계 순서/);assert.match(h.nodes.view.innerHTML,/&quot;steps&quot;: \[\]/);
});
for(const invalid of ['other-id','null','missing-field','bad-step','bad-list','bad-limit','bad-tools','bad-condition','bad-edge']){
 test('malformed response cannot substitute a selection '+invalid,async()=>{
  const h=harness();h.reply=async()=>{
   const workflow=row();
   if(invalid==='other-id')workflow.id='other';
   if(invalid==='null')return {workflow:null};
   if(invalid==='missing-field')delete workflow.created_by;
   if(invalid==='bad-step')workflow.steps=[{name:'private',type:42}];
   if(invalid==='bad-list')workflow.steps={private:'hidden'};
   if(invalid==='bad-limit')workflow.steps[0].timeout_ms=Infinity;
   if(invalid==='bad-tools')workflow.steps[0].allowed_tools=[42];
   if(invalid==='bad-condition')workflow.steps[0].condition={operator:42};
   if(invalid==='bad-edge')workflow.flow={version:1,entry:'start',edges:[{from:'start',to:42,when:'next'}]};
   return {workflow};
  };await h.open();assert.match(h.nodes.view.innerHTML,/불러오지 못했습니다/);assert.ok(!h.nodes.view.innerHTML.includes('selected'));
 });
}
for(const raw of [hash(''),hash('a\u200bb'),hash('a\nb'),hash('a'.repeat(4097)),hash()+'&workflow_id=other',hash()+'&run=true',
 '#/workflows?workflow_id=%zz','#/workflows?workflow_id=%ED%A0%80','#/workflows?workflow_id=%E0%A4%A','#/workflows?id=wrong']){
 test('invalid raw query never performs a read '+raw.slice(0,65),async()=>{
  const h=harness();h.location.hash=raw;await h.renderLegacyWorkflowDetail();assert.equal(h.calls.length,0);assert.match(h.nodes.view.innerHTML,/올바르지 않습니다/);
 });
}
for(const value of [' exact?tail ',' 워크플로 '+'가'.repeat(1300)+' ','😀'.repeat(1024)]){
 test('exact identity survives '+value.slice(0,15),async()=>{
  const h=harness();h.reply=async()=>({workflow:row({id:value})});await h.open(value);
  assert.equal(new URL(h.calls[0].url,'https://local.invalid').searchParams.get('id'),value);assert.match(h.nodes.view.innerHTML,/selected workflow/);
 });
}
test('long text and every step are recoverable across surrogate-safe pages',async()=>{
 const h=harness(),description='가'.repeat(16383)+'😀description-tail';
 const workflow=row({description,steps:Array.from({length:128},(_,i)=>({name:'step-'+i,type:'approval',note:'note-'+i+'x'.repeat(400)}))});
 h.reply=async()=>({workflow});await h.open();h.click('legacy-workflow-description-next');
 assert.ok(h.nodes.view.innerHTML.includes('😀description-tail'));
 const definition=JSON.stringify(h.legacyWorkflowDefinition(workflow),null,2),pages=h.legacyDetailTextPages(definition);
 let shown='';for(let i=0;i<pages.length;i++){
  const html=h.nodes.view.innerHTML,part=/<pre id="legacy-workflow-definition"[^>]*>([\s\S]*?)<\/pre>/.exec(html)[1];
  shown+=part.replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
  if(i+1<pages.length)h.click('legacy-workflow-definition-next');
 }
 assert.equal(shown,definition);assert.equal(JSON.parse(shown).steps[127].name,'step-127');assert.equal(h.calls.length,1);
});
for(const kind of ['auth','route','hash']){
 test('late workflow result cannot repaint after '+kind,async()=>{
  const h=harness();let done;h.reply=()=>new Promise(r=>done=r);const pending=h.open();h.retire(kind);done({workflow:row()});await pending;assert.equal(h.nodes.view.innerHTML,'NEW');
 });
 test('retired controls cannot retry after '+kind,async()=>{
  const h=harness();await h.open();h.retire(kind);h.click('legacy-workflow-retry');assert.equal(h.retries,undefined);assert.equal(h.nodes.view.innerHTML,'NEW');
 });
 for(const failed of [false,true])test('old broad list cannot replace a new detail '+kind+' failed='+failed,async()=>{
  const h=harness();let finish;h.reply=()=>new Promise((resolve,reject)=>finish=failed?reject:resolve);
  const old=h.renderWorkflows();h.retire(kind);finish(failed?Error('old private'):{workflows:[]});await old;assert.equal(h.nodes.view.innerHTML,'NEW');
 });
}
test('failed read shows recovery without server details',async()=>{
 const h=harness();h.reply=async()=>{throw Error('PRIVATE_ERROR_BODY')};await h.open();
 assert.ok(!h.nodes.view.innerHTML.includes('PRIVATE_ERROR_BODY'));assert.match(h.nodes.view.innerHTML,/불러오지 못했습니다/);
 h.click('legacy-workflow-retry');assert.equal(h.retries,1);
});
test('all nested unknown fields are omitted and stored text is escaped',async()=>{
 const h=harness();h.reply=async()=>({workflow:row({name:'<script>bad</script>',description:'<img src=x>',unknown:'HIDDEN',
 steps:[{name:'<svg>',type:'condition',unknown:'HIDDEN',condition:{operator:'equals',value:'<b>',unknown:'HIDDEN'}}],
 flow:{version:1,entry:'<entry>',unknown:'HIDDEN',edges:[{from:'<from>',to:'<to>',when:'next',unknown:'HIDDEN'}]}}),unknown:'HIDDEN'});
 await h.open();const html=h.nodes.view.innerHTML;
 for(const text of ['&lt;script&gt;bad&lt;/script&gt;','&lt;img src=x&gt;','&lt;svg&gt;','&lt;b&gt;','&lt;entry&gt;','&lt;from&gt;','&lt;to&gt;'])assert.ok(html.includes(text),text);
 assert.ok(!/<script>|<img|<svg>|HIDDEN/.test(html));
});
