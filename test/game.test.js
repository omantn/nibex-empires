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
test('daily budget never grows from extra turns',()=>{
 const {a}=setup();for(let i=0;i<4;i++)g.resolveTurn();assert.equal(treasury(a.id).orders_left,20)
})
test('Daybreak resets budget once and resolves a daytime heist plan only then',()=>{
 const {a,b}=setup();db.prepare('DELETE FROM tiles').run();tile(0,a.id);tile(1,b.id)
 db.prepare('INSERT INTO relics(player_id,value) VALUES (?,4)').run(b.id)
 assert(g.queueOrder(a.id,'heist',null,null,{targetPlayer:b.id}).ok)
 g.resolveTurn();assert.equal(g.personalState(a.id).orders.length,1)
 assert.equal(treasury(a.id).orders_left,19)
 setSetting('last_reset','yesterday');const oldRandom=Math.random;Math.random=()=>0.5
 try {g.resolveTurn()}finally{Math.random=oldRandom}
 assert.equal(treasury(a.id).orders_left,20)
 assert.equal(g.personalState(a.id).orders.length,0)
 assert.equal(db.prepare('SELECT player_id FROM relics').get().player_id,a.id)
 g.resolveTurn();assert.equal(treasury(a.id).orders_left,20)
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
 assert.deepEqual(g.resolveTurn(),[]);g.resumeGame();assert.equal(getSetting('paused_at'),'');assert(g.exchange(a.id,'ore2food',1).ok)
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
