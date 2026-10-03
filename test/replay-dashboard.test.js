import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import {DASHBOARD_REPLAY} from '../src/replay-dashboard.js'
import {dashboardPage,adminPage} from '../src/views.js'
const replay={totalTurns:2,map:[{owner:null}],players:[{empire:'Safe <empire>',abbr:'SA'}],frames:[{label:'Launch',changes:[{index:0,owner:1}]},{label:'Turn 1',changes:[{index:0,owner:2}]},{label:'Turn 2',changes:[{index:0,owner:3}]}]}
const packet=(revision=1,playback={id:'run1',startedAt:1000,endsAt:7600,frameMs:800,holdMs:5000,replay})=>({instance:'server1',revision,serverNow:1000,playback})
function client(now=1000) {
  const elements=new Map(),handlers={},intervals=[],windowHandlers={};
  const el=id=>{if(!elements.has(id))elements.set(id,{style:{},textContent:'',setAttribute(){},clientHeight:360,scrollHeight:0,getBoundingClientRect:()=>({right:100})});return elements.get(id)};
  const ctx={Date:{now:()=>now,parse:Date.parse},Number,Math,AbortSignal,window:{addEventListener:(k,fn)=>windowHandlers[k]=fn},document:{getElementById:el},setInterval:(fn,ms)=>intervals.push({fn,ms}),socket:{connected:true,on:(name,fn)=>handlers[name]=fn},state:{phase:'running',map:[{owner:88}],finale:null},serverTime:()=>now,fetch:async()=>({ok:true,json:async()=>packet()}),renderMap:(e,map)=>{e.owner=map[0].owner},render:()=>{ctx.renderCalls++;ctx.showing=vm.runInContext('renderTimelapse()',ctx);if(!ctx.showing)el('live').style.display='flex'},renderCalls:0};
  vm.createContext(ctx);vm.runInContext(DASHBOARD_REPLAY,ctx);
  return {ctx,el,handlers,windowHandlers,advance:t=>{now=t;intervals.find(i=>i.ms===100).fn()},receive:p=>handlers.timelapse(p)};
}
test('shared clock advances frames, holds final five seconds, restores current dashboard',()=>{
  const c=client();c.receive(packet());assert.equal(c.el('timelapseMap').owner,1);assert.equal(c.el('live').style.display,'none');
  c.advance(1800);assert.equal(c.el('timelapseMap').owner,2);
  c.ctx.state.map=[{owner:99}];c.advance(2600);assert.equal(c.el('timelapseMap').owner,3);
  c.advance(7599);assert.equal(c.ctx.showing,true);assert.match(c.el('timelapseStatus').textContent,/returning/);
  c.advance(7600);assert.equal(c.ctx.showing,false);assert.equal(c.el('live').style.display,'flex');assert.equal(c.ctx.state.map[0].owner,99);
});
test('refresh/reconnect joins same frame; repeated event does not restart; stale start cannot undo stop',()=>{
  const c=client(3000);const p=packet();p.serverNow=3000;c.receive(p);assert.equal(c.el('timelapseMap').owner,3);
  c.receive(p);assert.equal(c.el('timelapseMap').owner,3);
  c.receive({...packet(2,null),serverNow:3000});assert.equal(c.ctx.showing,false);
  c.receive(p);assert.equal(c.ctx.showing,false);
  c.receive({...packet(3),instance:'old-server'});assert.equal(c.ctx.showing,false);
});
test('disconnect, failure, lobby and ceremony interrupt replay without changing game state',()=>{
  for(const reason of ['disconnect','failure','lobby','ceremony']){
    const c=client();c.receive(packet());
    if(reason==='disconnect')c.handlers.disconnect();
    if(reason==='failure'){c.ctx.renderMap=()=>{throw Error('broken')};c.advance(1800);c.receive({...packet(),serverNow:1800});}
    if(reason==='lobby'){c.ctx.state.phase='lobby';c.advance(1500);}
    if(reason==='ceremony'){c.ctx.state.phase='finale';c.ctx.state.finale={startedAt:new Date(1000).toISOString(),data:[{}]};c.advance(1500);}
    assert.equal(c.ctx.showing,false,reason);assert.equal(c.el('timelapseStage').style.display,'none');
  }
});
test('ended awaiting ceremony permits replay and completed ceremony does not mask later replay',()=>{
  const c=client();c.ctx.state.phase='finale';c.receive(packet());assert.equal(c.ctx.showing,true);
  c.ctx.state.finale={startedAt:new Date(-20000).toISOString(),data:[{}]};c.receive(packet());assert.equal(c.ctx.showing,true);
});
test('malformed payload safely returns to normal dashboard',()=>{
  const c=client();c.receive(packet());c.receive(packet(2,{id:'bad',replay:{}}));assert.equal(c.ctx.showing,false);
});
test('late HTTP responses cannot resurrect playback after disconnect or newer socket packet',async()=>{
  const c=client();let resolve;c.ctx.fetch=()=>new Promise(r=>resolve=r);
  const sync=vm.runInContext('syncTimelapse()',c.ctx);c.handlers.disconnect();resolve({ok:true,json:async()=>packet()});await sync;assert.equal(c.ctx.showing,false);
  c.receive(packet(2,null));let done;c.ctx.fetch=()=>new Promise(r=>done=r);const sync2=vm.runInContext('syncTimelapse()',c.ctx);
  c.receive(packet(3,null));done({ok:true,json:async()=>packet()});await sync2;assert.equal(c.ctx.showing,false);
});
test('sync fetch failure exits and a new server on reconnect is accepted',async()=>{
  const c=client();c.receive(packet());c.ctx.fetch=async()=>{throw Error('offline')};await vm.runInContext('syncTimelapse()',c.ctx);assert.equal(c.ctx.showing,false);
  c.ctx.fetch=async()=>({ok:true,json:async()=>({...packet(),instance:'server2'})});c.handlers.connect();await new Promise(r=>setImmediate(r));assert.equal(c.ctx.showing,true);
});
test('dashboard source compiles and admin has guarded broadcast forms plus private preview',()=>{
  const state={phase:'running',players:[],nightfall:{active:false},serverNow:new Date().toISOString()};
  const html=dashboardPage(state,'/join','data:',[]);const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];new vm.Script(script);
  assert.match(html,/id="timelapseStage"/);assert.match(html,/id="dashboardTicker"/);
  const admin=adminPage(state,{});assert.match(admin,/method="post" action="\/admin\/timelapse\/start"/);assert.match(admin,/\/admin\/timelapse\/stop/);assert.match(admin,/Private preview/);
});
test('complete dashboard client continues accepting live snapshots while replay owns the screen',()=>{
  let now=1000;const handlers={},intervals=[],elements=new Map();
  const el=id=>{if(!elements.has(id))elements.set(id,{style:{},clientHeight:360,scrollHeight:0,textContent:'',setAttribute(){},getBoundingClientRect:()=>({right:100})});return elements.get(id)};
  const initial={phase:'running',players:[],map:[],nightfall:{active:false},serverNow:new Date(now).toISOString(),playerCount:0,tick:0};
  const html=dashboardPage(initial,'/join','data:',[]);const source=html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const sock={connected:true,on:(n,f)=>(handlers[n]??=[]).push(f)};
  const ctx={Date:class extends Date {static now(){return now}},window:{addEventListener(){}},document:{getElementById:el,querySelectorAll:()=>[],querySelector:()=>el('dashboardTicker')},io:()=>sock,setInterval:fn=>intervals.push(fn),setTimeout(){},AbortSignal,fetch:async()=>({ok:true,json:async()=>packet()})};
  vm.createContext(ctx);vm.runInContext(source,ctx);
  handlers.timelapse[0](packet());assert.equal(el('timelapseStage').style.display,'flex');
  for(const fn of handlers.state)fn({...initial,tick:55,serverNow:new Date(now).toISOString()});assert.equal(el('phaseline').textContent,'MAP TIMELAPSE');
  now=7600;for(const fn of intervals)fn();assert.equal(el('live').style.display,'flex');assert.equal(el('phaseline').textContent,'Turn 55');assert.equal(el('dashboardTicker').style.display,'flex');
});
test('fresh broadcast clock wins over an older live-state clock at ceremony completion',()=>{
  const c=client(15000);c.ctx.serverTime=()=>14000;c.ctx.state.phase='finale';c.ctx.state.finale={startedAt:new Date(1000).toISOString(),data:[{}]};
  c.receive({...packet(),serverNow:15000,playback:{...packet().playback,startedAt:15000,endsAt:21600}});assert.equal(c.ctx.showing,true);
});
