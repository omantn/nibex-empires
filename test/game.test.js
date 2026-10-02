import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
process.env.NIBEX_DB=':memory:'
const g=await import('../src/game.js')
const {db,setSetting,getSetting}=await import('../src/db.js')
const views=await import('../src/views.js')
function setup() {
  g.resetGame();setSetting('quests_per_day','0');setSetting('bot_count','0');setSetting('orders_per_day','20');
  setSetting('nightfall_start','23:58');setSetting('nightfall_end','23:59');
  const a=g.createPlayer({name:'Secret Alice',empire:'Alpha',abbr:'AA',pin:'1234'})
  const b=g.createPlayer({name:'Secret Bob',empire:'Beta',abbr:'BB',pin:'4321'})
  g.launchGame(new Date(Date.now()+86400000));return {a,b}
}
const treasury=id=>db.prepare('SELECT ore,food,orders_left FROM players WHERE id=?').get(id)
const tile=(q,id,strength=0)=>db.prepare("INSERT INTO tiles(q,r,terrain,owner_id,strength) VALUES (?,0,'plains',?,?)").run(q,id,strength)

test('base production counts owned non-resource tiles, rounds down, caps at three and has no minimum',()=>{
 for(const count of [0,4,5,7,9,10,14,15,20,55]) {
  const {a,b}=setup();db.prepare('DELETE FROM tiles').run()
  for(let q=0;q<count;q++)tile(q,a.id)
  // Protected tiles count too; another empire's land must not count for us.
  db.prepare('UPDATE tiles SET warded=1 WHERE q<7').run()
  for(let q=100;q<110;q++)tile(q,b.id)
  const before=treasury(a.id);g.resolveTurn();const after=treasury(a.id)
  assert.equal(after.ore-before.ore,Math.min(3,Math.floor(count/5)),'ore for '+count+' tiles')
  assert.equal(after.food-before.food,Math.min(3,Math.floor(count/5)),'food for '+count+' tiles')
 }
})
test('ore and food tiles never count toward base income; their unwarded yields remain additive',()=>{
 for(const count of [0,4,5,7,9,10,14,15,20,55]) {
  const {a}=setup();db.prepare('DELETE FROM tiles').run()
  for(let q=0;q<count;q++)tile(q,a.id)
  db.prepare('UPDATE tiles SET warded=1 WHERE q<7').run()
  for(let q=100;q<105;q++)tile(q,a.id)
  db.prepare("UPDATE tiles SET terrain='ore' WHERE q IN (100,102,103)").run()
  db.prepare("UPDATE tiles SET terrain='food' WHERE q IN (101,104)").run()
  db.prepare('UPDATE tiles SET warded=1 WHERE q IN (100,101)').run()
  const before=treasury(a.id);g.resolveTurn();const after=treasury(a.id)
  const base=Math.min(3,Math.floor(count/5))
  assert.equal(after.ore-before.ore,base+2,'base plus2 unwarded ore tiles at '+count+' non-resource tiles')
  assert.equal(after.food-before.food,base+1,'base plus1 unwarded food tile at '+count+' non-resource tiles')
 }
})
test('starting plains and relic sites count toward base income',()=>{
 const {a}=setup()
 const starting=db.prepare('SELECT terrain,warded FROM tiles WHERE owner_id=?').all(a.id)
 assert.equal(starting.length,7)
 assert(starting.every(t=>t.terrain==='plains' && t.warded===1))
 const before=treasury(a.id);g.resolveTurn();const first=treasury(a.id)
 assert.equal(first.ore-before.ore,1);assert.equal(first.food-before.food,1)
 for(let q=100;q<103;q++)tile(q,a.id)
 db.prepare("UPDATE tiles SET terrain='relic' WHERE q>=100").run()
 g.resolveTurn();const second=treasury(a.id)
 assert.equal(second.ore-first.ore,2);assert.equal(second.food-first.food,2)
})
test('a newly expanded tile affects base income starting next turn',()=>{
 const {a}=setup();db.prepare('DELETE FROM tiles').run()
 for(let q=0;q<9;q++)tile(q,a.id)
 tile(9,null)
 assert(g.queueOrder(a.id,'expand',9,0).ok)
 const before=treasury(a.id);g.resolveTurn();const first=treasury(a.id)
 assert.equal(first.ore-before.ore,1);assert.equal(first.food-before.food,1)
 assert.equal(db.prepare('SELECT owner_id FROM tiles WHERE q=9').get().owner_id,a.id)
 g.resolveTurn();const second=treasury(a.id)
 assert.equal(second.ore-first.ore,2);assert.equal(second.food-first.food,2)
})

test('identities and join timestamps stay private; finale reveals fields only on cue',()=>{
 const {a}=setup();const state=g.publicState();assert.equal(state.players[0].name,undefined);assert.equal(state.players[0].created_at,undefined)
 g.endGame();assert.equal(g.publicState().finale,null);g.startFinale();assert.deepEqual(g.publicState().finale.data.map(p=>Object.keys(p)),[[],[]])
 setSetting('finale_started_at',new Date(Date.now()-60000).toISOString());assert(g.publicState().finale.data.some(p=>p.name==='Secret Alice'))
})
test('market conversion and resolved muster preserve score including fractional remainders',()=>{
 const {a}=setup();db.prepare('UPDATE players SET ore=11,food=4 WHERE id=?').run(a.id)
 const before=g.scores()[a.id];g.exchange(a.id,'ore2food',10);assert.equal(g.scores()[a.id],before)
 g.exchange(a.id,'food2ore',10);assert.equal(g.scores()[a.id],before)
 const home=db.prepare('SELECT q,r FROM tiles WHERE owner_id=? AND capital=1').get(a.id)
 g.queueOrder(a.id,'muster',home.q,home.r,{amount:6});assert.equal(g.scores()[a.id],before);g.resolveTurn()
 assert.equal(g.scores()[a.id],Math.floor((12*5+5)/25))
})
test('end refunds unresolved paid orders once, locks changes, and freezes replay score',()=>{
 const {a}=setup();const home=db.prepare('SELECT q,r FROM tiles WHERE owner_id=? AND capital=1').get(a.id)
 assert(g.queueOrder(a.id,'muster',home.q,home.r,{amount:5}).ok);const id=g.personalState(a.id).orders[0].id
 g.endGame();assert.equal(treasury(a.id).ore,5);assert(g.cancelOrder(a.id,id).error);assert(g.exchange(a.id,'ore2food',1).error)
 const frozen=getSetting('finale_data');g.startFinale();g.startFinale();assert.equal(getSetting('finale_data'),frozen)
})
test('launch grants five and ordinary turns bank five without a cap',()=>{
 const {a}=setup();assert.equal(treasury(a.id).orders_left,5)
 db.prepare('UPDATE players SET orders_left=3 WHERE id=?').run(a.id)
 g.resolveTurn();assert.equal(treasury(a.id).orders_left,8)
 g.resolveTurn();assert.equal(treasury(a.id).orders_left,13)
 db.prepare('UPDATE players SET orders_left=99 WHERE id=?').run(a.id)
 g.resolveTurn();assert.equal(treasury(a.id).orders_left,104)
})
test('Daybreak resets budget once and resolves a daytime heist plan only then',()=>{
 const {a,b}=setup();db.prepare('DELETE FROM tiles').run();tile(0,a.id);tile(1,b.id)
 db.prepare('INSERT INTO relics(player_id,value) VALUES (?,4)').run(b.id)
 assert(g.queueOrder(a.id,'heist',null,null,{targetPlayer:b.id}).ok)
 g.resolveTurn();assert.equal(g.personalState(a.id).orders.length,1)
 assert.equal(treasury(a.id).orders_left,9)
 setSetting('last_reset','yesterday');const oldRandom=Math.random;Math.random=()=>0.5
 try {g.resolveTurn()}finally{Math.random=oldRandom}
 assert.equal(treasury(a.id).orders_left,5)
 assert.equal(g.personalState(a.id).orders.length,0)
 assert.equal(db.prepare('SELECT player_id FROM relics').get().player_id,a.id)
 g.resolveTurn();assert.equal(treasury(a.id).orders_left,10)
})
test('planned expansions advance one frontier per turn',()=>{
 const {a}=setup();db.prepare('DELETE FROM tiles').run();tile(0,a.id);tile(1,null);tile(2,null);tile(3,null)
 for(const q of [1,2,3])assert(g.queueOrder(a.id,'expand',q,0).ok)
 g.resolveTurn();assert.equal(db.prepare('SELECT owner_id FROM tiles WHERE q=1').get().owner_id,a.id)
 assert.equal(db.prepare('SELECT owner_id FROM tiles WHERE q=2').get().owner_id,null)
 assert.equal(g.personalState(a.id).orders.length,2);g.resolveTurn();assert.equal(g.personalState(a.id).orders.length,1)
 g.resolveTurn();assert.equal(g.personalState(a.id).orders.length,0)
})
test('cancelling an old plan cannot bank expired daily orders',()=>{
 const {a}=setup();db.prepare('DELETE FROM tiles').run();tile(0,a.id);tile(1,null);g.queueOrder(a.id,'expand',1,0)
 const id=g.personalState(a.id).orders[0].id;db.prepare("UPDATE orders SET budget_day='old-day' WHERE id=?").run(id)
 const n=treasury(a.id).orders_left;g.cancelOrder(a.id,id);assert.equal(treasury(a.id).orders_left,n)
})
test('same-day carried plans refund a banked slot but Daybreak plans do not',()=>{
 const {a}=setup();db.prepare('DELETE FROM tiles').run();tile(0,a.id);tile(1,null);tile(2,null);tile(3,null)
 for(const q of [1,2,3])assert(g.queueOrder(a.id,'expand',q,0).ok)
 g.resolveTurn();assert.equal(treasury(a.id).orders_left,7)
 const tail=g.personalState(a.id).orders.find(o=>o.q===3)
 assert(g.cancelOrder(a.id,tail.id).ok);assert.equal(treasury(a.id).orders_left,8)
 assert(g.queueOrder(a.id,'expand',3,0).ok)
 db.prepare("UPDATE orders SET budget_day='yesterday' WHERE status='queued'").run()
 setSetting('last_reset','yesterday');g.resolveTurn();assert.equal(treasury(a.id).orders_left,5)
 const carried=g.personalState(a.id).orders[0];assert.equal(carried.q,3)
 assert(g.cancelOrder(a.id,carried.id).ok);assert.equal(treasury(a.id).orders_left,5)
})
test('cancelling a waiting heist returns food and its same-day banked slot',()=>{
 const {a,b}=setup();db.prepare('DELETE FROM tiles').run();tile(0,a.id);tile(1,b.id)
 assert(g.queueOrder(a.id,'heist',null,null,{targetPlayer:b.id}).ok)
 g.resolveTurn();const before=treasury(a.id),order=g.personalState(a.id).orders[0]
 assert(g.cancelOrder(a.id,order.id).ok)
 assert.equal(treasury(a.id).orders_left,before.orders_left+1)
 assert.equal(treasury(a.id).food,before.food+1)
})
test('new orders never restamp legacy untagged queued plans',()=>{
 const {a}=setup();db.prepare('DELETE FROM tiles').run();tile(0,a.id);tile(1,null);tile(2,null)
 assert(g.queueOrder(a.id,'expand',1,0).ok)
 const id=g.personalState(a.id).orders[0].id
 db.prepare('UPDATE orders SET budget_day=NULL WHERE id=?').run(id)
 assert(g.queueOrder(a.id,'expand',2,0).ok)
 assert.equal(db.prepare('SELECT budget_day FROM orders WHERE id=?').get(id).budget_day,null)
})
test('Nightfall blocks both resolution and order grants',()=>{
 const {a}=setup();db.prepare('UPDATE players SET orders_left=0').run()
 const now=new Date(),until=new Date(now.getTime()+60000)
 const hm=d=>String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0')
 setSetting('nightfall_start',hm(now));setSetting('nightfall_end',hm(until))
 const tick=getSetting('tick_count')
 g.fireTurn({emit(){},to(){return {emit(){}}}})
 assert.equal(getSetting('tick_count'),tick);assert.equal(treasury(a.id).orders_left,0)
})
test('attack outcomes do not depend on submission order',()=>{
 const {a,b}=setup();const oldRandom=Math.random;Math.random=()=>0.5
 function run(reverse) {
  db.prepare('DELETE FROM orders').run();db.prepare('DELETE FROM tiles').run();db.prepare('UPDATE players SET food=5,orders_left=20').run()
  tile(0,a.id,20);tile(1,b.id,10);tile(2,null)
  const qa=()=>g.queueOrder(a.id,'attack',1,0,{srcQ:0,srcR:0,amount:20})
  const qb=()=>g.queueOrder(b.id,'attack',2,0,{srcQ:1,srcR:0,amount:10})
  if(reverse){qb();qa()}else{qa();qb()}g.resolveTurn()
  return db.prepare('SELECT q,owner_id,strength FROM tiles ORDER BY q').all()
 }
 try {const result=run(false);assert.deepEqual(result,run(true));assert.equal(result[2].owner_id,b.id);assert.equal(result[1].strength,20)}finally{Math.random=oldRandom}
})
test('failed turn rolls back orders, production, counter, and next deadline',()=>{
 const {a}=setup();db.prepare("INSERT INTO quests(player_id,type,params) VALUES (?,'claim_tiles','broken')").run(a.id)
 const before={treasury:treasury(a.id),tick:getSetting('tick_count'),next:getSetting('next_tick_at')}
 assert.throws(()=>g.fireTurn({emit(){},to(){return {emit(){}}}}))
 assert.deepEqual({treasury:treasury(a.id),tick:getSetting('tick_count'),next:getSetting('next_tick_at')},before)
})
test('pause blocks mutations and resume preserves remaining turn time',()=>{
 const {a}=setup();g.pauseGame();assert(g.exchange(a.id,'ore2food',1).error);assert(g.abandonQuest(a.id).error)
 const balance=treasury(a.id).orders_left;assert.deepEqual(g.resolveTurn(),[]);assert.equal(treasury(a.id).orders_left,balance);g.resumeGame();assert.equal(getSetting('paused_at'),'');assert(g.exchange(a.id,'ore2food',1).ok)
})
test('PINs are hashed, duplicate abbreviations rejected, old PINs migrate on login',()=>{
 const {a}=setup();assert(a.pin.startsWith('scrypt:'));assert.equal(g.findPlayerByAbbrPin('aa','1234').id,a.id);assert.equal(g.findPlayerByAbbrPin('AA','9999'),null)
 assert.throws(()=>g.createPlayer({name:'x',empire:'x',abbr:'aa',pin:'0000'}))
 db.prepare("UPDATE players SET pin='1234' WHERE id=?").run(a.id);assert(g.findPlayerByAbbrPin('AA','1234'));assert(db.prepare('SELECT pin FROM players WHERE id=?').get(a.id).pin.startsWith('scrypt:'))
})
test('hostile names remain data; all generated page scripts compile',()=>{
 const {a}=setup();const bad='</script><script>window.bad=1</script>'
 db.prepare('UPDATE players SET empire=? WHERE id=?').run(bad,a.id)
 const state=g.publicState(), me=g.personalState(a.id)
 const pages=[views.dashboardPage(state,'http://localhost/join','',[]),views.playPage(a,state,me)]
 for(const page of pages){assert(!page.includes(bad));for(const match of page.matchAll(/<script>([\s\S]*?)<\/script>/g))new vm.Script(match[1])}
})
