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
 }throw Error("missing function "+name);
}
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};}
const asset=(id="opaque-id")=>({id,name:"unrelated display name",body:"public <body>",status:"draft",tags:[]});
function harness(hash="#/prompt-assets"){
 const nodes={},calls=[];
 const node=id=>nodes[id]??(nodes[id]={innerHTML:"",textContent:"",value:id==="p-limit"?"100":id==="pf-window"?"7d":"",hidden:true,listeners:{},addEventListener(type,fn){this.listeners[type]=fn},focus(){},classList:{contains:()=>true,add(){},remove(){}}});
 const ctx={URLSearchParams,location:{hash},document:{getElementById:node,querySelectorAll:()=>[]},calls,nodes,
  response:async(url)=>url.startsWith("/admin/prompt-assets")?{assets:[asset()],stats:{},known_tags:[],categories:[]}:url.includes("/history")?{history:[]}:url.includes("/usage")?{usage:[]}:{items:[],requests:[],fingerprints:[]},
  section:(title,body)=>title+body,card:(title,body)=>title+body,kpi:()=>"",fmt:String,ago:()=>"",row:(key,val)=>key+val,
  makeSortable(){},attachRequestRowHandlers(){},requestsTable:rows=>JSON.stringify(rows),promptFingerprintTable:rows=>JSON.stringify(rows),
 };
 ctx.authState={nav:{scopes:["admin:read","admin:write"]}};ctx.window=ctx;vm.createContext(ctx);
 vm.runInContext('let legacyRouteGeneration=1,authEpoch=1,modalGeneration=0,assetDetailGeneration=0;function authCurrent(e){return e===authEpoch;}'+
  'async function api(url,options){calls.push({url,options});return response(url,options);}'+
  'function openModal(title,html){modalGeneration++;document.getElementById("modal-body").innerHTML=html;}'+
  'function _applyModalState(state){document.getElementById("modal-body").innerHTML=state.html;}'+
  'function parseHash(){const [part,q]=location.hash.slice(2).split("?");return{parts:part.split("/"),params:new URLSearchParams(q)};}'+
  'function updateHashParams(p){location.hash="#/"+parseHash().parts.join("/")+"?"+p;}'+
  'globalThis.retire=(kind)=>{if(kind==="route"){legacyRouteGeneration++;location.hash="#/other"}else if(kind==="auth")authEpoch++;else modalGeneration++;document.getElementById("modal-body").innerHTML="NEW_STATE";document.getElementById("view").innerHTML="NEW_STATE";};'+
  ['escapeHTML','escapeAttr','legacyPromptAssetIDValid','restoreRequestTimeInput','applyPromptParams','renderPromptAssets','renderPromptsView','renderPromptDebt'].map(grab).join("\n")+
  script.slice(script.indexOf("window.openAssetDetail ="),script.indexOf("window.addTagToEditInput =")),ctx);
 return ctx;
}
test("selected asset lookup ignores list search and requires exact unique identity",async()=>{
 const h=harness();await h.openAssetDetail("opaque-id");
 assert.equal(h.calls[0].url,"/admin/prompt-assets");assert.ok(h.calls.every(c=>!c.options?.method));
 assert.match(h.nodes["modal-body"].innerHTML,/unrelated display name/);assert.match(h.nodes["modal-body"].innerHTML,/public &lt;body&gt;/);
});
test("deep link opens the selected asset even when filtered list omits it",async()=>{
 const h=harness("#/prompt-assets?asset=opaque-id&q=no-match");
 h.response=async url=>url==="/admin/prompt-assets?q=no-match"?{assets:[]}:url==="/admin/prompt-assets"?{assets:[asset()]}:{history:[],usage:[]};
 await h.renderPromptAssets(new URLSearchParams("asset=opaque-id&q=no-match"));
 assert.match(h.nodes["modal-body"].innerHTML,/unrelated display name/);
 assert.ok(h.calls.some(c=>c.url==="/admin/prompt-assets?q=no-match"));
});
for(const rows of [[],[asset(),asset()]]){
 test("missing or ambiguous asset never opens an empty editor "+rows.length,async()=>{
  const h=harness();h.response=async()=>({assets:rows,history:[],usage:[]});await h.openAssetDetail("opaque-id");
  assert.match(h.nodes["modal-body"].innerHTML,/찾을 수 없습니다/);assert.ok(!h.nodes["modal-body"].innerHTML.includes("pa-edit-body"));
 });
}
for(const kind of ["route","auth","close"]){
 test("late asset response cannot replace a newer "+kind,async()=>{
  const h=harness(),gate=deferred();h.response=()=>gate.promise;const pending=h.openAssetDetail("opaque-id");h.retire(kind);
  gate.resolve({assets:[asset()],history:[],usage:[]});await pending;assert.equal(h.nodes["modal-body"].innerHTML,"NEW_STATE");
 });
 test("late asset list cannot open a detail after "+kind,async()=>{
  const h=harness(),gate=deferred();h.response=()=>gate.promise;const pending=h.renderPromptAssets(new URLSearchParams("asset=opaque-id"));h.retire(kind);
  gate.resolve({assets:[asset()]});await pending;assert.equal(h.nodes["modal-body"].innerHTML,"NEW_STATE");
 });
}
test("later asset selection wins out-of-order responses",async()=>{
 const h=harness(),gate=deferred();h.response=()=>gate.promise;const first=h.openAssetDetail("first");
 h.response=async()=>({assets:[asset("second")],history:[],usage:[]});await h.openAssetDetail("second");
 gate.resolve({assets:[asset("first")],history:[],usage:[]});await first;
 assert.ok(h.nodes["modal-body"].innerHTML.includes("second"));assert.ok(!h.nodes["modal-body"].innerHTML.includes("first"));
});
test("unsafe and duplicate asset addresses issue no read",async()=>{
 for(const params of ["asset=a&asset=b","asset=%0A","asset="]){
  const h=harness();await h.renderPromptAssets(new URLSearchParams(params));assert.equal(h.calls.length,0);
 }
});
test("asset errors never expose backend payloads",async()=>{
 const h=harness();h.response=async()=>{throw Error("PRIVATE_ERROR")};await h.openAssetDetail("opaque-id");
 assert.ok(!h.nodes["modal-body"].innerHTML.includes("PRIVATE_ERROR"));assert.match(h.nodes["modal-body"].innerHTML,/불러오지 못했습니다/);
});
test("search preserves the effective precise UTC instant and fingerprint window",async()=>{
 const h=harness("#/prompts");h.response=async url=>url==="/admin/saved-filters"?{filters:[]}:{requests:[],fingerprints:[]};
 await h.renderPromptsView(new URLSearchParams("q=public&since=2026-11-20T03%3A04%3A05.123%2B09%3A00&limit=37&fp_window=90d"));
 await new Promise(setImmediate);
 const request=h.calls.find(c=>c.url.startsWith("/admin/prompts?"));
 assert.equal(new URLSearchParams(request.url.split("?")[1]).get("since"),"2026-11-19T18:04:05.123Z");
 assert.equal(new URLSearchParams(request.url.split("?")[1]).get("limit"),"37");
 assert.ok(h.calls.some(c=>c.url==="/admin/prompts/fingerprints?window=90d&limit=100"));
});
test("invalid search time is visible and never dispatched",async()=>{
 const h=harness("#/prompts");h.response=async()=>({filters:[],fingerprints:[]});
 await h.renderPromptsView(new URLSearchParams("since=invalid"));await new Promise(setImmediate);
 assert.equal(h.nodes["p-filter-error"].hidden,false);assert.ok(!h.calls.some(c=>c.url.startsWith("/admin/prompts?")));
});
test("late search cannot repaint a retired route",async()=>{
 const h=harness("#/prompts"),gate=deferred();h.response=async url=>url==="/admin/saved-filters"?{filters:[]}:url.startsWith("/admin/prompts?")?gate.promise:{fingerprints:[]};
 await h.renderPromptsView(new URLSearchParams("q=public"));h.retire("route");h.nodes["prompt-results"].innerHTML="NEW_STATE";
 gate.resolve({requests:[{id:"late"}]});await new Promise(setImmediate);assert.equal(h.nodes["prompt-results"].innerHTML,"NEW_STATE");
});
for(const period of ["7d","30d","90d"]){
 test("debt uses selected "+period+" with App limit",async()=>{
  const h=harness("#/prompt-debt");await h.renderPromptDebt(new URLSearchParams({window:period}));
  assert.equal(h.calls[0].url,"/admin/prompts/debt?window="+period+"&limit=50");assert.match(h.nodes.view.innerHTML,new RegExp("최근 "+period.slice(0,-1)+"일"));
 });
}

test("quoted and backslashed asset IDs stay exact in explicit edit actions",async()=>{
 const id="한글 +%2F?&# ' \" \\test";const h=harness();
 h.response=async()=>({assets:[asset(id)],history:[],usage:[]});await h.openAssetDetail(id);
 const encoded=/onclick="(saveAssetEdit\([^"]+\))"/.exec(h.nodes["modal-body"].innerHTML)[1];
 const handler=encoded.replaceAll("&quot;",'"').replaceAll("&#39;","'").replaceAll("&lt;","<").replaceAll("&gt;",">").replaceAll("&amp;","&");
 let called;h.saveAssetEdit=value=>{called=value};vm.runInContext(handler,h);assert.equal(called,id);
});

test("readonly asset body remains selectable while mutation controls are disabled",async()=>{
 const h=harness(),body={},name={},category={},save={getAttribute:()=>"saveAssetEdit('opaque-id')"},close={getAttribute:()=>"closeModal()"};
 h.authState.nav.scopes=["admin:read"];
 h.document.querySelectorAll=selector=>selector.includes("button")?[save,close]:selector.includes("textarea")?[body,name]:[category];
 await h.openAssetDetail("opaque-id");
 assert.equal(body.readOnly,true);assert.equal(name.readOnly,true);assert.notEqual(body.disabled,true);
 assert.equal(category.disabled,true);assert.equal(save.disabled,true);assert.notEqual(close.disabled,true);
});
for(const transition of ["auth","route","close"]){
 test("hidden asset modal snapshots and history are discarded on "+transition,async()=>{
  const h=harness();const body=h.document.getElementById("modal-body");
  Object.defineProperty(body,"textContent",{get(){return this.innerHTML},set(value){this.innerHTML=value}});
  vm.runInContext(
   'let modalStack=[],currentModalState=null,navigationRevision=0,navigationReady=true,authChanging=false,authRefreshFlight=null;'+
   'function updateModalBack(){} function captureFocusOrigin(){} function restoreFocusOrigin(){} function setLegacyAppEntry(){}'+
   'function _applyModalState(state){currentModalState=state;document.getElementById("modal-body").innerHTML=state.html;document.getElementById("modal-title").textContent=state.title;}'+
   ["openModal","modalBack","retireAssetDetailModal","closeModal","retireAuth"].map(grab).join("\n")+
   'globalThis.modalSnapshot=()=>({depth:modalStack.length,current:currentModalState});',h);
  await h.openAssetDetail("opaque-id");h.__assetHistory=[{body:"PRIVATE_HISTORY"}];
  h.openModal("public overlay","<p>public help</p>");assert.equal(h.modalSnapshot().depth,1);
  h.modalBack();assert.match(body.innerHTML,/public &lt;body&gt;/);
  h.openModal("public overlay","<p>public help</p>");
  if(transition==="auth")h.retireAuth();else if(transition==="route")h.retireAssetDetailModal();else h.closeModal();
  assert.equal(body.innerHTML,"");assert.equal(h.nodes["modal-title"].textContent,"");assert.equal(h.modalSnapshot().depth,0);assert.equal(h.modalSnapshot().current,null);
  assert.equal(h.__assetHistory.length,0);
  h.openModal("new public overlay","<p>new public help</p>");h.modalBack();
  assert.equal(body.innerHTML,"<p>new public help</p>");assert.equal(h.modalSnapshot().depth,0);
 });
}

test("submitting unchanged asset filters still refreshes the current list",async()=>{
 const h=harness();let refreshes=0;h.route=()=>{refreshes++};
 await h.renderPromptAssets(new URLSearchParams());
 h.nodes["pa-filter"].listeners.submit({preventDefault(){}});
 assert.equal(h.location.hash,"#/prompt-assets");assert.equal(refreshes,1);
});
