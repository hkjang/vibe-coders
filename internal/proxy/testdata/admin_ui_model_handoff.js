"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
const {test}=require("node:test");
const source=fs.readFileSync(path.join(__dirname,"..","admin_ui.go"),"utf8");
const script=/<script>([\s\S]*?)<\/script>/.exec(source)[1];
function grab(name){
 let start=script.indexOf("function "+name+"(");assert.ok(start>=0,name);
 if(script.slice(start-6,start)==="async ")start-=6;
 let depth=0;for(let i=script.indexOf("{",start);i<script.length;i++){
  if(script[i]==="{")depth++;if(script[i]==="}"&&--depth===0)return script.slice(start,i+1);
 }throw Error(name);
}
const ref="prv_"+"A".repeat(43),otherRef="prv_"+"B".repeat(43),id="공개 +%2F?&#/model";
const target=(changes={})=>new URLSearchParams({model:id,provider_ref:ref,source:"live",...changes});
const model=(changes={})=>({id,provider_ref:ref,provider:"selected provider",source:"live",object:"model",owned_by:"selected owner",created:1700000000,fetched_at:"2026-11-20T00:00:00Z",stale:false,virtual:false,shadowed:false,shadowed_by:"",deprecation:null,...changes});
const data=(models=[model()])=>({models,providers:[{provider_ref:ref,source:"live",status:"ok"}],partial_failures:[]});
function harness(){
 const nodes={},calls=[];
 const node=id=>nodes[id]??(nodes[id]={innerHTML:"",textContent:"",listeners:{},focus(){},addEventListener(key,fn){this.listeners[key]=fn}});
 const h={URLSearchParams,document:{getElementById:node},location:{hash:"#/model-contracts?"+target()},calls,nodes,reply:async()=>data(),section:(title,html)=>title+html};
 h.window=h;vm.createContext(h);
 vm.runInContext('let legacyRouteGeneration=1,authEpoch=1;function authCurrent(epoch){return epoch===authEpoch}async function api(url,opts){calls.push({url,opts});return reply(url,opts)}function route(){globalThis.retries=(globalThis.retries||0)+1}'+
 ['legacyProviderRefValid','legacyModelTarget','escapeHTML','renderLegacyModelDetail'].map(grab).join("\n")+
 'globalThis.retire=kind=>{if(kind==="auth")authEpoch++;else if(kind==="route")legacyRouteGeneration++;else location.hash="#/other";document.getElementById("view").innerHTML="NEW";};',h);
 return h;
}
test("exact provider and source disambiguate duplicate names without mutations",async()=>{
 const h=harness();h.reply=async()=>data([model({provider_ref:otherRef,owned_by:"wrong provider"}),model({source:"agent_route",owned_by:"wrong source"}),model()]);
 await h.renderLegacyModelDetail(target());assert.equal(h.calls.length,1);
 assert.equal(h.calls[0].url,"/admin/models?"+new URLSearchParams({model:id}));
 assert.equal(h.calls[0].opts.appProjection,true);assert.equal(h.calls[0].opts.method,undefined);
 assert.match(h.nodes.view.innerHTML,/selected owner/);assert.ok(!h.nodes.view.innerHTML.includes("wrong provider"));assert.ok(!h.nodes.view.innerHTML.includes("wrong source"));
});
for(const invalid of [
 target({model:""}),target({model:" padded "}),target({model:"a\nb"}),target({model:"x".repeat(4097)}),
 target({provider_ref:"visible name"}),target({source:"unknown"}),new URLSearchParams("model=only"),new URLSearchParams(target()+"&model=duplicate"),new URLSearchParams(target()+"&run=true"),
]){
 test("invalid or ambiguous target sends no HTTP "+invalid.toString().slice(0,45),async()=>{
  const h=harness();await h.renderLegacyModelDetail(invalid);assert.equal(h.calls.length,0);assert.match(h.nodes.view.innerHTML,/올바르지 않습니다/);
 });
}
for(const rows of [[],[model(),model()],[model({source:"agent_route"})],[model({provider_ref:otherRef})]]){
 test("missing or changed identity is never substituted "+JSON.stringify(rows.map(x=>[x.provider_ref,x.source])),async()=>{
  const h=harness();h.reply=async()=>data(rows);await h.renderLegacyModelDetail(target());
  assert.match(h.nodes.view.innerHTML,/자동 선택하지 않습니다/);assert.ok(!h.nodes.view.innerHTML.includes("selected owner"));
 });
}
for(const kind of ["auth","route","hash"]){
 test("late response cannot repaint after "+kind,async()=>{
  const h=harness();let resolve;h.reply=()=>new Promise(r=>resolve=r);const pending=h.renderLegacyModelDetail(target());
  h.retire(kind);resolve(data());await pending;assert.equal(h.nodes.view.innerHTML,"NEW");
 });
}
test("partial/stale and lifecycle information is explicit and escaped",async()=>{
 const h=harness();h.reply=async()=>({...data([model({stale:true,shadowed:true,shadowed_by:"<path>",deprecation:{retired:true,action:"block",sunset_date:"2026-11-01",replacement:"<replacement>",message:"<script>secret</script>"}})]),partial_failures:[{provider_ref:ref,code:"unavailable",message:"PRIVATE_BACKEND_ERROR"}]});
 await h.renderLegacyModelDetail(target());const html=h.nodes.view.innerHTML;
 assert.match(html,/최신 카탈로그를 모두 확인하지 못했습니다/);assert.match(html,/지원 종료/);assert.match(html,/&lt;replacement&gt;/);assert.ok(!html.includes("<script>"));assert.ok(!html.includes("PRIVATE_BACKEND_ERROR"));
});
test("backend errors stay generic and retry is owned by the current route",async()=>{
 const h=harness();h.reply=async()=>{throw Error("PRIVATE_BACKEND_ERROR")};await h.renderLegacyModelDetail(target());
 assert.ok(!h.nodes.view.innerHTML.includes("PRIVATE_BACKEND_ERROR"));
 h.nodes["legacy-model-retry"].listeners.click();assert.equal(h.retries,1);
 h.retire("auth");h.nodes["legacy-model-retry"].listeners.click();assert.equal(h.retries,1);
});

for(const [requested,current] of [["live","cache"],["cache","live"]]){
 test("physical catalogue source transition stays on the same provider/model "+requested+" to "+current,async()=>{
  const h=harness();h.reply=async()=>({...data([model({source:current})]),providers:[
   {provider_ref:otherRef,source:current,status:"WRONG_PROVIDER_STATUS"},
   {provider_ref:ref,source:requested,status:"OLD_SOURCE_STATUS"},
   {provider_ref:ref,source:current,status:"current catalogue ready"},
  ]});
  await h.renderLegacyModelDetail(target({source:requested}));
  assert.match(h.nodes.view.innerHTML,/selected owner/);assert.match(h.nodes.view.innerHTML,/조회 출처가/);assert.equal(h.calls.length,1);
  const html=h.nodes.view.innerHTML;
  assert.match(html,/current catalogue ready/);assert.ok(!html.includes("OLD_SOURCE_STATUS"));assert.ok(!html.includes("WRONG_PROVIDER_STATUS"));
 });
}
test("an agent-route target never opens a physical model",async()=>{
 const h=harness();await h.renderLegacyModelDetail(target({source:"agent_route"}));
 assert.match(h.nodes.view.innerHTML,/자동 선택하지 않습니다/);assert.ok(!h.nodes.view.innerHTML.includes("selected owner"));
});
test("simultaneous live/cache duplicates for one physical identity are ambiguous",async()=>{
 const h=harness();h.reply=async()=>data([model(),model({source:"cache"})]);
 await h.renderLegacyModelDetail(target());assert.match(h.nodes.view.innerHTML,/자동 선택하지 않습니다/);
});
