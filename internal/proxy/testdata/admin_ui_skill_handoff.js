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


const id='/스킬 +%2F?&#/';
const hash=value=>'#/skills?'+new URLSearchParams({skill_name:value??id});
const row=(changes={})=>({name:id,description:'selected description',version:'selected-version',owner:'selected owner',
 status:'deprecated',risk_level:'high',allowed_models:'selected-model',allowed_tools:'selected-tool',allowed_teams:'restricted-team',daily_limit:7,
 instructions:'selected instructions',metadata:'{"selected":"metadata"}',created_at:'2026-11-18T01:00:00Z',updated_at:'2026-11-18T02:00:00Z',updated_by:'selected-editor',...changes});
function harness(){
 const nodes={},calls=[];
 const node=id=>nodes[id]??(nodes[id]={innerHTML:'',textContent:'',listeners:{},focus(){},addEventListener(k,fn){this.listeners[k]=fn}});
 const h={sessionStorage:{getItem:()=>""},URLSearchParams,TextEncoder,document:{getElementById:node},location:{hash:hash()},calls,nodes,reply:async()=>({skill:row()}),section:(title,html)=>title+html};
 h.window=h;vm.createContext(h);
 vm.runInContext('let legacyRouteGeneration=1,authEpoch=1;function authCurrent(epoch){return epoch===authEpoch}async function api(url,opts){calls.push({url,opts});return reply(url,opts)}function route(){globalThis.retries=(globalThis.retries||0)+1}'+
 ['legacySkillTarget','legacyDetailTextPages','escapeHTML','renderLegacySkillDetail','renderSkills'].map(grab).join('\n')+
 'globalThis.retire=kind=>{if(kind==="auth")authEpoch++;else if(kind==="route")legacyRouteGeneration++;else location.hash="#/other";document.getElementById("view").innerHTML="NEW";};',h);
 h.open=async(value=id)=>{h.location.hash=hash(value);await h.renderLegacySkillDetail();};
 h.click=id=>h.nodes[id].listeners.click();
 return h;
}


test('exact GET preserves all fifteen stored fields and never runs skill actions',async()=>{
 const h=harness();await h.open();
 assert.equal(h.calls.length,1);assert.equal(h.calls[0].url,'/admin/skills?'+new URLSearchParams({view:'detail',name:id}));
 assert.equal(h.calls[0].opts.method,undefined);assert.equal(h.calls[0].opts.cache,'no-store');
 for(const value of ['selected description','selected-version','selected owner','지원 중단','높음','selected-model','selected-tool','restricted-team','7','selected instructions','metadata','selected-editor','2026-11-18'])assert.ok(h.nodes.view.innerHTML.includes(value),value);
 assert.ok(!/<input|<form|onclick=|skillEdit\(|skillPromote\(|skillSave\(/.test(h.nodes.view.innerHTML));
});
for(const invalid of ['other-name','null','missing-instructions','bad-metadata','unsafe-limit']){
 test('invalid result cannot replace the chosen skill '+invalid,async()=>{
  const h=harness();h.reply=async()=>{
   const skill=row();if(invalid==='other-name')skill.name='other';if(invalid==='null')return {skill:null};
   if(invalid==='missing-instructions')delete skill.instructions;
   if(invalid==='bad-metadata')skill.metadata={private:'hidden'};
   if(invalid==='unsafe-limit')skill.daily_limit=Number.MAX_SAFE_INTEGER+1;
   return {skill};
  };await h.open();assert.match(h.nodes.view.innerHTML,/불러오지 못했습니다/);assert.ok(!h.nodes.view.innerHTML.includes('selected'));
 });
}
for(const raw of [hash(''),hash('a\u200bb'),hash('a\nb'),hash('a'.repeat(4097)),hash()+'&skill_name=other',hash()+'&run=true',
 '#/skills?skill_name=%zz','#/skills?skill_name=%ED%A0%80','#/skills?skill_name=%E0%A4%A','#/skills?name=wrong']){
 test('invalid raw selection performs no read '+raw.slice(0,65),async()=>{
  const h=harness();h.location.hash=raw;await h.renderLegacySkillDetail();assert.equal(h.calls.length,0);assert.match(h.nodes.view.innerHTML,/올바르지 않습니다/);
 });
}
for(const name of [' exact?tail ','/스킬/','__proto__','😀'.repeat(1024)]){
 test('exact name survives '+name.slice(0,15),async()=>{
  const h=harness();h.reply=async()=>({skill:row({name})});await h.open(name);assert.equal(new URL(h.calls[0].url,'https://local.invalid').searchParams.get('name'),name);assert.match(h.nodes.view.innerHTML,/selected instructions/);
 });
}
test('all full text sections remain reachable without surrogate loss',async()=>{
 const h=harness(),text='가'.repeat(16383)+'😀tail'+ '나'.repeat(20000);
 h.reply=async()=>({skill:row({description:text,instructions:text,metadata:text})});await h.open();
 for(const key of ['description','instructions','metadata']){
  let shown='';const pages=h.legacyDetailTextPages(text);
  for(let i=0;i<pages.length;i++){
   const part=new RegExp('<pre id="legacy-skill-'+key+'"[^>]*>([\\s\\S]*?)</pre>').exec(h.nodes.view.innerHTML)[1];
   shown+=part;if(i+1<pages.length)h.click('legacy-skill-'+key+'-next');
  }
  assert.equal(shown,text);assert.doesNotThrow(()=>encodeURI(shown));
 }
 assert.equal(h.calls.length,1);
});
for(const kind of ['auth','route','hash']){
 test('late skill detail cannot repaint after '+kind,async()=>{
  const h=harness();let done;h.reply=()=>new Promise(r=>done=r);const old=h.open();h.retire(kind);done({skill:row()});await old;assert.equal(h.nodes.view.innerHTML,'NEW');
 });
 test('retired controls cannot retry after '+kind,async()=>{
  const h=harness();await h.open();h.retire(kind);h.click('legacy-skill-retry');assert.equal(h.retries,undefined);
 });
 for(const stage of ['list','stats'])for(const failed of [false,true]){
  test('late broad skill '+stage+' response cannot repaint after '+kind+' failed='+failed,async()=>{
   const h=harness();let finish,calls=0;
   h.reply=()=>{calls++;if(stage==='stats'&&calls===1)return Promise.resolve({skills:[]});
    return new Promise((resolve,reject)=>finish=failed?reject:resolve)};
   const old=h.renderSkills();for(let i=0;!finish&&i<10;i++)await Promise.resolve();assert.ok(finish);h.retire(kind);
   finish(failed?Error('old private'):{skills:[],stats:[]});await old;assert.equal(h.nodes.view.innerHTML,'NEW');
  });
 }
}
test('failed read shows generic recovery without server details',async()=>{
 const h=harness();h.reply=async()=>{throw Error('PRIVATE_ERROR_BODY')};await h.open();
 assert.ok(!h.nodes.view.innerHTML.includes('PRIVATE_ERROR_BODY'));h.click('legacy-skill-retry');assert.equal(h.retries,1);
});
test('unknown response fields are omitted and stored text is never markup',async()=>{
 const h=harness();h.reply=async()=>({skill:row({description:'<script>bad</script>',instructions:'<img src=x>',metadata:'<svg>',status:'__proto__',risk_level:'__proto__',unknown:'HIDDEN'}),unknown:'HIDDEN'});
 await h.open();const html=h.nodes.view.innerHTML;
 for(const text of ['&lt;script&gt;bad&lt;/script&gt;','&lt;img src=x&gt;','&lt;svg&gt;','__proto__'])assert.ok(html.includes(text),text);
 assert.ok(!/<script>|<img|<svg>|HIDDEN/.test(html));
});

const ref='skl_'+'A'.repeat(43);
for(const name of ['a'.repeat(4097),'sk-ant-private-name-fixture',' exact ','/with/slash/','literal\u0000control']){
 test('opaque reference opens exact full stored identity '+name.slice(0,20),async()=>{
  const h=harness();h.location.hash='#/skills?'+new URLSearchParams({skill_ref:ref});
  h.reply=async()=>({skill:row({name,skill_ref:ref})});
  await h.renderLegacySkillDetail();
  assert.equal(h.calls.length,1);
  assert.equal(h.calls[0].url,'/admin/skills?'+new URLSearchParams({view:'detail',skill_ref:ref}));
  assert.equal(new URL(h.calls[0].url,'https://local.invalid').searchParams.has('name'),false);
  assert.match(h.nodes.view.innerHTML,/selected instructions/);
  assert.ok(!/<input|<form|onclick=|skillPromote\(|skillSave\(/.test(h.nodes.view.innerHTML));
 });
}
for(const query of ['skill_ref=','skill_ref=bad','skill_ref='+ref+'&skill_name='+encodeURIComponent(id),
 'skill_ref='+ref+'&skill_ref='+ref,'skill_ref='+ref+'&run=true','skill_ref=skl_'+'A'.repeat(42)+'B','skill_ref=%zz']){
 test('invalid reference selector never falls back '+query.slice(0,70),async()=>{
  const h=harness();h.location.hash='#/skills?'+query;await h.renderLegacySkillDetail();
  assert.equal(h.calls.length,0);assert.match(h.nodes.view.innerHTML,/올바르지 않습니다/);
 });
}
for(const reference of [undefined,'skl_'+'E'.repeat(43)]){
 test('reference response must match requested reference '+reference,async()=>{
  const h=harness();h.location.hash='#/skills?skill_ref='+ref;
  h.reply=async()=>({skill:row({skill_ref:reference})});await h.renderLegacySkillDetail();
  assert.match(h.nodes.view.innerHTML,/불러오지 못했습니다/);assert.ok(!h.nodes.view.innerHTML.includes('selected instructions'));
 });
}
for(const kind of ['auth','route','hash']){
 test('late reference response retires after '+kind,async()=>{
  const h=harness();h.location.hash='#/skills?skill_ref='+ref;let finish;
  h.reply=()=>new Promise(resolve=>finish=resolve);const flight=h.renderLegacySkillDetail();
  h.retire(kind);finish({skill:row({skill_ref:ref})});await flight;
  assert.equal(h.nodes.view.innerHTML,'NEW');
 });
}
