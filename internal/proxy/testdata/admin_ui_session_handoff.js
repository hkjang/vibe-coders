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
const id='세션 +%2F?&#';
const hash=value=>'#/sessions?'+new URLSearchParams({session_id:value??id});
const data=()=>({session_id:'[REDACTED_EMAIL]',events:[{request_id:'request-exact',trace_id:'trace-exact',kind:'chat',endpoint:'/v1/chat/completions',model:'model-exact',provider:'provider-exact',status_code:200,is_error:false,latency_ms:5,total_tokens:10,cost_krw:1,tool_count:0,created_at:'2026-11-18T00:00:00Z',last_message:'safe preview',detail:'/admin/requests/request-exact',trace:'/admin/requests/request-exact/trace'}],summary:{verdict:'정상',headline:'one request',findings:['safe finding']},rollup:{requests:1,started_at:'start',ended_at:'end',models:['model-exact'],providers:['provider-exact'],trace_ids:['trace-exact'],kinds:{chat:1},total_tokens:10,total_cost:1,errors:0,tool_calls:0,risk:{secret_requests:0,policy_block_requests:0,high_risk_code_requests:0}},note:'bounded history'});
function harness(){
 const nodes={},calls=[];
 const node=id=>nodes[id]??(nodes[id]={innerHTML:'',value:'7',listeners:{},focus(){},addEventListener(k,f){this.listeners[k]=f},querySelectorAll(){return []}});
 const h={URLSearchParams,TextEncoder,document:{getElementById:node},location:{hash:hash()},calls,nodes,reply:async()=>data(),sessionStorage:{getItem:()=>'',setItem(){}},section:(t,b)=>t+b,fmt:String,money:String,timeCell:String,sessionLastMessageCell:String,card:(t,b)=>t+b};
 h.window=h;vm.createContext(h);
 vm.runInContext('let legacyRouteGeneration=1,authEpoch=1,modalGeneration=1,flightRecorderGeneration=0;function authCurrent(epoch){return epoch===authEpoch}async function api(url,opts){calls.push({url,opts});return reply(url,opts)}function route(){globalThis.retries=(globalThis.retries||0)+1}function row(k,v){return k+v}function openModal(title){modalGeneration++;globalThis.modals=(globalThis.modals||0)+1;globalThis.modalTitle=title}'+
 ['legacySessionTarget','validLegacySessionRecorder','escapeHTML','escapeAttr','flightRecorderHTML','renderLegacySessionDetail','renderSessionsView'].map(grab).join('\n')+
 script.slice(script.indexOf('window.openFlightRecorder ='),script.indexOf('// ---------- dashboard ----------'))+
 'globalThis.retire=kind=>{if(kind==="auth")authEpoch++;else if(kind==="route")legacyRouteGeneration++;else if(kind==="modal")modalGeneration++;else location.hash="#/other";Object.values(nodes).forEach(node=>node.innerHTML="NEW");};',h);
 h.open=async(value=id)=>{h.location.hash=hash(value);await h.renderLegacySessionDetail();};
 return h;
}
test('exact read preserves projected identity and does not load broad sessions',async()=>{
 const h=harness();await h.open();assert.equal(h.calls.length,1);assert.equal(h.calls[0].url,'/admin/sessions/'+encodeURIComponent(id)+'/flight-recorder');assert.equal(h.calls[0].opts.cache,'no-store');
 for(const value of ['[REDACTED_EMAIL]','safe preview','model-exact','provider-exact','safe finding','bounded history'])assert.ok(h.nodes.view.innerHTML.includes(value),value);
 assert.ok(!h.nodes.view.innerHTML.includes('onclick='));
});
for(const raw of [hash(''),hash(' padded'),hash('.'),hash('..'),hash('a/b'),hash('a\\b'),hash('a\nb'),hash('a'.repeat(4097)),hash()+'&session_id=other',hash()+'&days=7','#/sessions?session_id=%zz','#/sessions?session_id=%ED%A0%80']){
 test('invalid selection does not read '+raw.slice(0,60),async()=>{const h=harness();h.location.hash=raw;await h.renderLegacySessionDetail();assert.equal(h.calls.length,0);assert.match(h.nodes.view.innerHTML,/올바르지 않습니다/);});
}
test('maximum supported UTF8 path survives without changing identity',async()=>{const h=harness(),value='😀'.repeat(1024);await h.open(value);assert.equal(h.calls[0].url,'/admin/sessions/'+encodeURIComponent(value)+'/flight-recorder');});
for(const kind of ['auth','route','hash']){
 test('late detail does not repaint after '+kind,async()=>{const h=harness();let done;h.reply=()=>new Promise(r=>done=r);const old=h.open();h.retire(kind);done(data());await old;assert.equal(h.nodes.view.innerHTML,'NEW');});
 test('retired retry cannot restart after '+kind,async()=>{const h=harness();await h.open();h.retire(kind);h.nodes['legacy-session-retry'].listeners.click();assert.equal(h.retries,undefined);});
 for(const failed of [false,true])test('late broad list ignored after '+kind+' error='+failed,async()=>{const h=harness();let done;h.reply=()=>new Promise((r,j)=>done=failed?j:r);const old=h.renderSessionsView();h.retire(kind);done(failed?Error('PRIVATE'):{sessions:[]});await old;assert.equal(h.nodes['sessions-results'].innerHTML,'NEW');});
}
for(const kind of ['auth','route','hash','modal'])test('old modal read cannot reopen after '+kind,async()=>{const h=harness();let done;h.reply=()=>new Promise(r=>done=r);const old=h.openFlightRecorder(id);h.retire(kind);done(data());await old;assert.equal(h.modals,undefined);});
test('invalid data and errors use generic recovery',async()=>{for(const reply of [async()=>({events:[]}),async()=>{throw Error('PRIVATE_BODY')}]){const h=harness();h.reply=reply;await h.open();assert.match(h.nodes.view.innerHTML,/불러오지 못했습니다/);assert.ok(!h.nodes.view.innerHTML.includes('PRIVATE'));}});

for(const olderFirst of [true,false])for(const olderFails of [true,false])test('latest modal selection owns success/error with olderFirst='+olderFirst+' olderFails='+olderFails,async()=>{
 const h=harness(),pending=[];
 h.reply=()=>new Promise((resolve,reject)=>pending.push({resolve,reject}));
 const first=h.openFlightRecorder('first-session'),second=h.openFlightRecorder('second-session');
 const finishOld=()=>olderFails?pending[0].reject(Error('PRIVATE_OLD_FAILURE')):pending[0].resolve(data());
 if(olderFirst){finishOld();await first;assert.equal(h.modals,undefined);pending[1].resolve(data());await second;}
 else{pending[1].resolve(data());await second;finishOld();await first;}
 assert.equal(h.modals,1);assert.match(h.modalTitle,/second-session/);assert.doesNotMatch(h.modalTitle,/first-session|PRIVATE/);
});
