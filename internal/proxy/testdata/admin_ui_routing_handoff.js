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
const id="분기 +%2F?&#/정산";
const target=value=>new URLSearchParams({rule_id:value??id});
const row=(changes={})=>({id,enabled:false,priority:17,match_pattern:"billing-*",min_complexity:10,max_complexity:90,target_model:"selected model",target_provider:"selected provider",note:"selected note",created_at:"2026-11-18T01:02:03.456Z",...changes});
function harness(){
 const nodes={},calls=[];
 const node=id=>nodes[id]??(nodes[id]={innerHTML:"",textContent:"",listeners:{},focus(){},addEventListener(k,fn){this.listeners[k]=fn}});
 const h={URLSearchParams,document:{getElementById:node},location:{hash:"#/routing?"+target()},calls,nodes,reply:async()=>({rules:[row()]}),section:(title,html)=>title+html};
 h.window=h;vm.createContext(h);
 vm.runInContext('let legacyRouteGeneration=1,authEpoch=1;function authCurrent(epoch){return epoch===authEpoch}async function api(url,opts){calls.push({url,opts});return reply(url,opts)}function route(){globalThis.retries=(globalThis.retries||0)+1}'+
 ['legacyRoutingRuleTarget','escapeHTML','renderLegacyRoutingRuleDetail'].map(grab).join("\n")+
 'globalThis.retire=kind=>{if(kind==="auth")authEpoch++;else if(kind==="route")legacyRouteGeneration++;else location.hash="#/other";document.getElementById("view").innerHTML="NEW";};',h);
 h.open=params=>{h.location.hash="#/routing?"+params;return h.renderLegacyRoutingRuleDetail(params);};
 return h;
}
test("exact rule GET preserves all stored configuration without mutation or list read",async()=>{
 const h=harness();await h.open(target());
 assert.equal(h.calls.length,1);assert.equal(h.calls[0].url,"/admin/routing-rules?"+new URLSearchParams({id}));
 assert.equal(h.calls[0].opts.method,undefined);assert.equal(h.calls[0].opts.cache,"no-store");
 const html=h.nodes.view.innerHTML;
 for(const value of ["분기 +%2F?&amp;#/정산","중지됨","17","billing-*","10–90","selected model","selected provider","selected note","2026-11-18T01:02:03.456Z"])assert.ok(html.includes(value),value);
 assert.ok(!html.includes("onclick="));assert.ok(!html.includes("<input"));assert.ok(!html.includes("<form"));
});
for(const params of [target(""),target(" padded "),target("a\nb"),target("\u200b"),target("x".repeat(513)),new URLSearchParams(),new URLSearchParams(target()+"&rule_id=other"),new URLSearchParams(target()+"&run=true")]){
 test("invalid or ambiguous target sends no HTTP "+params.toString().slice(0,50),async()=>{
  const h=harness();await h.open(params);assert.equal(h.calls.length,0);assert.match(h.nodes.view.innerHTML,/올바르지 않습니다/);
 });
}
for(const rules of [[row({id:"different"})],[row(),row()],[row({enabled:"true"})],[row({priority:NaN})],[row({note:null})],null]){
 test("invalid selected response never substitutes or widens "+JSON.stringify(rules),async()=>{
  const h=harness();h.reply=async()=>({rules});await h.open(target());
  assert.match(h.nodes.view.innerHTML,/확인하지 못했습니다/);assert.ok(!h.nodes.view.innerHTML.includes("selected note"));
 });
}
test("a deleted selected rule stays missing",async()=>{
 const h=harness();h.reply=async()=>({rules:[]});await h.open(target());
 assert.match(h.nodes.view.innerHTML,/해당 라우팅 규칙이 없습니다/);assert.equal(h.calls.length,1);
});
for(const kind of ["route","hash","auth"]){
 test("late detail response cannot repaint after "+kind,async()=>{
  const h=harness();let resolve;h.reply=()=>new Promise(r=>resolve=r);
  const pending=h.open(target());h.retire(kind);resolve({rules:[row()]});await pending;
  assert.equal(h.nodes.view.innerHTML,"NEW");
 });
}
test("errors are generic and only the current view owns retry",async()=>{
 const h=harness();h.reply=async()=>{throw Error("PRIVATE_BACKEND_ERROR")};await h.open(target());
 assert.ok(!h.nodes.view.innerHTML.includes("PRIVATE_BACKEND_ERROR"));h.nodes["legacy-routing-rule-retry"].listeners.click();assert.equal(h.retries,1);
 h.retire("auth");h.nodes["legacy-routing-rule-retry"].listeners.click();assert.equal(h.retries,1);
});
test("raw authorized text is escaped and long notes explicitly bounded",async()=>{
 const h=harness();h.reply=async()=>({rules:[row({target_model:"<script>evil</script>",note:"x".repeat(10001)})]});
 await h.open(target());const html=h.nodes.view.innerHTML;
 assert.ok(html.includes("&lt;script&gt;evil&lt;/script&gt;"));assert.ok(!html.includes("<script>"));assert.match(html,/10,000자/);
 assert.ok(!html.includes("x".repeat(10001)));
});

for(const raw of ["#/routing?rule_id=%ED%A0%80","#/routing?rule_id=%zz","#/routing?rule_id=%E0%A4%A"]){
 test("malformed raw query never becomes another ID "+raw,async()=>{
  const h=harness();h.location.hash=raw;
  await h.renderLegacyRoutingRuleDetail(new URLSearchParams(raw.split("?")[1]));
  assert.equal(h.calls.length,0);assert.match(h.nodes.view.innerHTML,/올바르지 않습니다/);
 });
}
for(const [raw,exact] of [["#/routing?rule_id=rule?tail","rule?tail"],["#/routing?rule_id=%EF%BF%BD","�"]]){
 test("valid raw query preserves full exact ID "+raw,async()=>{
  const h=harness();h.location.hash=raw;h.reply=async()=>({rules:[row({id:exact})]});
  await h.renderLegacyRoutingRuleDetail(new URLSearchParams(raw.split("?")[1]));
  assert.equal(h.calls.length,1);assert.equal(h.calls[0].url,"/admin/routing-rules?"+new URLSearchParams({id:exact}));
  assert.match(h.nodes.view.innerHTML,/selected note/);
 });
}
