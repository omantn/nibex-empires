import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
process.env.NIBEX_DB=':memory:'
const {db,setSetting,getSetting}=await import('../src/db.js')
const g=await import('../src/game.js')
const {readReplay,reconstructReplay}=await import('../src/replay.js')
const {replayPage}=await import('../src/replay-view.js')
function setup(){
  g.resetGame();setSetting('quests_per_day',0);setSetting('bot_count',0);setSetting('nightfall_start','00:00');setSetting('nightfall_end','00:00');
  const a=g.createPlayer({name:'PRIVATE NAME',empire:'Alpha',abbr:'AA',pin:'1234'});
  g.addEvent('join','🛡️ A new player has joined. (1 so far)');
  const b=g.createPlayer({name:'PRIVATE B',empire:'Beta',abbr:'BB'});
  g.launchGame(new Date(Date.now()+86400000));return {a,b};
}
const finalOwners = replay => {const result=replay.map.map(()=>null);for(const f of replay.frames)for(const c of f.changes)result[c.index]=c.owner;return result;};

test('launch, empty turns, expansion, capture and defence reconstruct exact ownership without private data or writes',()=>{
  const {a,b}=setup();g.resolveTurn();
  const t=db.prepare('SELECT q,r FROM tiles WHERE warded=0 LIMIT 1').get();
  setSetting('tick_count',2);g.addEvent('expand','public',{player:a.id,tiles:[t]});g.addEvent('battle','public',{player:b.id,tiles:[t]});g.addEvent('tick','turn');
  db.prepare('UPDATE tiles SET owner_id=? WHERE q=? AND r=?').run(b.id,t.q,t.r);
  setSetting('tick_count',3);g.addEvent('battle','held',{player:b.id,tiles:[t]});g.addEvent('tick','turn');
  const before=db.serialize();const r=readReplay();assert.equal(r.available,true);assert.equal(r.frames.length,4);
  assert.deepEqual(finalOwners(r),db.prepare('SELECT owner_id FROM tiles ORDER BY q,r').all().map(t=>t.owner_id));
  assert.deepEqual(db.serialize(),before);assert.doesNotMatch(JSON.stringify(r),/PRIVATE|token|pin|strength|orders|ore|food|relics|score/);
});
test('late join is placed between completed turns even when timestamps share a second',()=>{
  setup();g.resolveTurn();const p=g.createPlayer({name:'Hidden',empire:'Late',abbr:'LT'});g.assignSpawn(p.id);
  g.addEvent('join','🏰 Late [LT] has entered the world.');g.resolveTurn();
  const r=readReplay();assert.equal(r.available,true);assert.deepEqual(r.frames.map(f=>f.tick),[0,1,1,2]);
  assert.ok(!r.frames[0].changes.some(c=>c.owner===p.id));assert.ok(r.frames[2].changes.some(c=>c.owner===p.id));
});
test('missing markers, missing ownership, corrupt payloads and unknown joins fail closed',()=>{
  for(const bad of ['marker','ownership','json','unknown','coordinate','null-tile','join']){
    const {a}=setup();g.resolveTurn();const t=db.prepare('SELECT q,r FROM tiles WHERE warded=0 LIMIT 1').get();
    if(bad==='marker')db.prepare("DELETE FROM events WHERE type='tick'").run();
    else if(bad==='ownership')db.prepare('UPDATE tiles SET owner_id=? WHERE q=? AND r=?').run(a.id,t.q,t.r);
    else if(bad==='join')g.addEvent('join','Unidentifiable late join');
    else {setSetting('tick_count',2);g.addEvent('expand','',bad==='unknown'?{player:999,tiles:[t]}:{player:a.id,tiles:bad==='coordinate'?[{q:999,r:999}]:bad==='null-tile'?[null]:[t]});if(bad==='json')db.prepare("UPDATE events SET data='{' WHERE type='expand'").run();g.addEvent('tick','');}
    const before=db.serialize();assert.equal(readReplay().available,false,bad);assert.deepEqual(db.serialize(),before);
  }
});
test('unavailable replay never interferes with finish, frozen results or ceremony',()=>{
  setup();g.resolveTurn();db.prepare("DELETE FROM events WHERE type='tick'").run();
  assert.equal(readReplay().available,false);g.endGame();const frozen=getSetting('finale_data');
  assert.equal(getSetting('phase'),'finale');assert.equal(readReplay().available,false);assert.equal(getSetting('finale_data'),frozen);
  g.startFinale();const started=getSetting('finale_started_at');readReplay();assert.equal(getSetting('finale_started_at'),started);assert.equal(getSetting('finale_data'),frozen);
});
test('lobby and database read failures have safe independent fallbacks',()=>{
  g.resetGame();assert.equal(readReplay().available,false);assert.match(replayPage(readReplay()),/Back to Admin/);
  assert.equal(reconstructReplay({settings:{phase:'running',tick_count:'invalid'},tiles:[{}],players:[],events:[]}).available,false);
  db.exec('ALTER TABLE events RENAME TO temporarily_unavailable_events');
  try { assert.equal(readReplay().available,false);assert.match(readReplay().reason,/could not be loaded/); }
  finally { db.exec('ALTER TABLE temporarily_unavailable_events RENAME TO events'); }
});
test('playback controls do not accumulate timers, seek/restart stop playback, end never starts ceremony',()=>{
  setup();g.resolveTurn();g.resolveTurn();const r=readReplay();r.players[0].empire='</script><script>bad()</script>';
  const html=replayPage(r);assert.doesNotMatch(html,/<script>bad/);
  const source=html.match(/<script>([\s\S]*?)<\/script>/)[1];const elements=new Map();const timers=new Map();let next=0;
  const element=id=>{if(!elements.has(id))elements.set(id,{value:id==='speed'?'800':'0',setAttribute(){}});return elements.get(id);};
  const ctx={document:{getElementById:element,addEventListener(){}},addEventListener(){},setTimeout(fn){timers.set(++next,fn);return next;},clearTimeout(id){timers.delete(id);}};
  vm.createContext(ctx);vm.runInContext(source,ctx);
  const click=id=>element(id).onclick();
  click('play');assert.equal(timers.size,1);click('play');assert.equal(timers.size,0);
  click('play');element('speed').onchange();assert.equal(timers.size,1);
  click('restart');assert.equal(timers.size,0);assert.equal(element('seek').value,0);
  click('play');element('seek').value='1';element('seek').oninput();assert.equal(timers.size,0);
  click('previous');assert.equal(element('seek').value,0);click('next');click('next');assert.equal(element('next').disabled,true);
  click('play');assert.equal(element('seek').value,0);
  while(timers.size){const [id,fn]=timers.entries().next().value;timers.delete(id);fn();}
  assert.equal(element('play').textContent,'Play');assert.match(element('status').textContent,/game is unchanged/);
  vm.runInContext('renderMap = () => { throw new Error("render failure") }',ctx);click('play');assert.equal(timers.size,0);assert.equal(element('play').textContent,'Play');assert.match(element('status').textContent,/Playback failed/);
  assert.doesNotMatch(source,/fetch\(|io\(|admin\/finale|admin\/end/);
});

test('deleted transient capture is rejected even when later ownership agrees',()=>{
  const {a,b}=setup();const t=db.prepare('SELECT q,r FROM tiles WHERE warded=0 LIMIT 1').get();
  setSetting('tick_count',1);g.addEvent('expand','',{player:a.id,tiles:[t]});g.addEvent('tick','');
  setSetting('tick_count',2);const removed=g.addEvent('battle','',{player:b.id,tiles:[t]});g.addEvent('tick','');
  setSetting('tick_count',3);g.addEvent('battle','',{player:a.id,tiles:[t]});g.addEvent('tick','');
  db.prepare('UPDATE tiles SET owner_id=? WHERE q=? AND r=?').run(a.id,t.q,t.r);
  assert.equal(readReplay().available,true);db.prepare('DELETE FROM events WHERE id=?').run(removed.id);assert.equal(readReplay().available,false);
});

test('deleted tail join in the launch second cannot become an initial empire',()=>{
  setup();const p=g.createPlayer({name:'Hidden',empire:'Tail',abbr:'TL'});g.assignSpawn(p.id);
  const e=g.addEvent('join','🏰 Tail [TL] has entered the world.');
  assert.equal(readReplay().available,true);db.prepare('DELETE FROM events WHERE id=?').run(e.id);assert.equal(readReplay().available,false);
});
