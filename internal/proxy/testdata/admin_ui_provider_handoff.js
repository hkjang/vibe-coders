'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {test}=require('node:test');
const source=fs.readFileSync(path.join(__dirname,'..','admin_ui.go'),'utf8');
const script=/<script>([\s\S]*?)<\/script>/.exec(source)[1];
function grab(name){
 let start=script.indexOf('function '+name+'(');assert.ok(start>=0,name);
 if(script.slice(start-6,start)==='async ')start-=6;
 let depth=0;for(let i=script.indexOf('{',start);i<script.length;i++){
  if(script[i]==='{')depth++;if(script[i]==='}'&&--depth===0)return script.slice(start,i+1);
 }throw Error('unbalanced '+name);
}
const a='prv_'+'a'.repeat(43),b='prv_'+'b'.repeat(43);
const provider=(ref,url)=>({provider_ref:ref,name:'[provider-name-omitted]',base_url:url,enabled:true,api_key_configured:true,timeout_ms:1000,model_patterns:'public-*',failover_group:'public',priority:10,api_key:'SYNTHETIC_PRIVATE_KEY'});
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}}
function harness(ref=a){
 const nodes={},calls=[],focus=[];
 const node=id=>nodes[id]??(nodes[id]={innerHTML:'',textContent:'',listeners:{},focus(){focus.push(id)},addEventListener(type,fn){this.listeners[type]=fn}});
 const ctx={URLSearchParams,location:{hash:'#/settings?provider_ref='+ref},document:{getElementById:node},calls,focus,nodes,
  response:async()=>({providers:[provider(a,'https://a.invalid'),provider(b,'https://b.invalid')]}),
  section:(title,body)=>title+body,escapeHTML:value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;')};
 vm.createContext(ctx);
 vm.runInContext('let legacyRouteGeneration=1,authEpoch=1;function authCurrent(epoch){return epoch===authEpoch;}'+
  'async function api(url,options){calls.push({url,options});return response(url,options)}'+
  'function route(){legacyRouteGeneration++;return renderLegacyProviderDetail(new URLSearchParams(location.hash.split("?")[1]))}'+
  'globalThis.move=(hash)=>{legacyRouteGeneration++;location.hash=hash;document.getElementById("view").innerHTML="NEW_SCREEN"};'+
  'globalThis.retire=()=>{authEpoch++;document.getElementById("view").innerHTML="SIGNED_OUT"};'+
  grab('legacyProviderRefValid')+'\n'+grab('renderLegacyProviderDetail'),ctx);
 ctx.run=params=>ctx.renderLegacyProviderDetail(params??new URLSearchParams({provider_ref:ref}));
 return ctx;
}
test('exact opaque selection separates identical labels and uses only existing safe projection',async()=>{
 const h=harness(b);await h.run();
 assert.equal(h.calls.length,1);assert.equal(h.calls[0].url,'/admin/providers');
 assert.equal(h.calls[0].options.appProjection,true);assert.equal(h.calls[0].options.cache,'no-store');assert.equal(h.calls[0].options.method,undefined);
 assert.match(h.nodes.view.innerHTML,/https:\/\/b.invalid/);assert.ok(!h.nodes.view.innerHTML.includes('https://a.invalid'));
 assert.ok(h.nodes.view.innerHTML.includes(b));assert.ok(!h.nodes.view.innerHTML.includes('SYNTHETIC_PRIVATE_KEY'));
 assert.deepEqual(h.focus,['legacy-provider-detail','legacy-provider-detail']);
 assert.ok(!h.nodes.view.innerHTML.includes('<form'));
});
for(const ref of ['',a+'\n',a+'x','public-name','//example.invalid',a.slice(0,-1),'prv_'+'/'.repeat(43)]){
 test('invalid reference never dispatches HTTP '+JSON.stringify(ref),async()=>{
  const h=harness();await h.run(new URLSearchParams({provider_ref:ref}));
  assert.equal(h.calls.length,0);assert.match(h.nodes.view.innerHTML,/주소가 올바르지/);
 });
}
test('duplicate query values are not silently resolved',async()=>{
 const h=harness();await h.run(new URLSearchParams([['provider_ref',a],['provider_ref',b]]));assert.equal(h.calls.length,0);
});
test('unknown or rotated references do not fall back to another provider',async()=>{
 const h=harness('prv_'+'c'.repeat(43));await h.run();assert.match(h.nodes.view.innerHTML,/찾을 수 없습니다/);assert.ok(!h.nodes.view.innerHTML.includes('https://a.invalid'));
});
test('ambiguous response identity fails closed',async()=>{
 const h=harness();h.response=async()=>({providers:[provider(a,'https://a.invalid'),provider(a,'https://b.invalid')]});await h.run();assert.match(h.nodes.view.innerHTML,/찾을 수 없습니다/);
});
test('provider metadata is escaped',async()=>{
 const h=harness();h.response=async()=>({providers:[{...provider(a,'https://a.invalid'),name:'<img onerror=attack>'}]});await h.run();
 assert.ok(!h.nodes.view.innerHTML.includes('<img'));assert.ok(h.nodes.view.innerHTML.includes('&lt;img'));
});
for(const kind of ['route','same-hash-generation','logout']){
 test('late successful response does not repaint after '+kind,async()=>{
  const h=harness(),gate=deferred();h.response=()=>gate.promise;
  const pending=h.run();if(kind==='logout')h.retire();else h.move(kind==='route'?'#/requests':h.location.hash);
  const expected=h.nodes.view.innerHTML;gate.resolve({providers:[provider(a,'https://a.invalid')]});await pending;assert.equal(h.nodes.view.innerHTML,expected);
 });
}
test('a newer resource selection wins when responses finish in reverse order',async()=>{
 const h=harness(),old=deferred();h.response=()=>old.promise;const first=h.run();
 h.move('#/settings?provider_ref='+b);h.response=async()=>({providers:[provider(b,'https://b.invalid')]});await h.run(new URLSearchParams({provider_ref:b}));
 old.resolve({providers:[provider(a,'https://a.invalid')]});await first;assert.match(h.nodes.view.innerHTML,/https:\/\/b.invalid/);assert.ok(!h.nodes.view.innerHTML.includes('https://a.invalid'));
});
for(const malformed of [null,{}, {providers:{}}]){
 test('malformed provider response does not display private error details '+JSON.stringify(malformed),async()=>{
  const h=harness();h.response=async()=>malformed;await h.run();assert.match(h.nodes.view.innerHTML,/확인하지 못했습니다/);
 });
}
test('an explicit retry rechecks current data without retaining a failed payload',async()=>{
 const h=harness();h.response=async()=>{throw Error('SYNTHETIC_PRIVATE_PAYLOAD')};await h.run();
 assert.ok(!h.nodes.view.innerHTML.includes('SYNTHETIC_PRIVATE'));h.response=async()=>({providers:[provider(a,'https://recovered.invalid')]});
 h.nodes['legacy-provider-retry'].listeners.click();
 await new Promise(resolve=>setImmediate(resolve));assert.match(h.nodes.view.innerHTML,/https:\/\/recovered.invalid/);assert.equal(h.calls.length,2);
});
