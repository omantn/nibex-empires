import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

test('upgrading and restarting a running game grants nothing until its next turn', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nibex-order-upgrade-'))
  const database=path.join(dir,'game.db')
  const prelude=`import * as g from './src/game.js'; import {db,setSetting,getSetting} from './src/db.js';`
  const snapshot=`const snapshot=()=>Object.fromEntries(['players','tiles','orders','settings'].map(t=>[t,db.prepare('SELECT * FROM '+t+' ORDER BY rowid').all()]));`
  const run=code=>JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',prelude+snapshot+code],{
    cwd:new URL('..',import.meta.url),env:{...process.env,NIBEX_DB:database},encoding:'utf8',
  }))
  try {
    const original=run(`
      setSetting('quests_per_day',0);setSetting('bot_count',0);setSetting('nightfall_start','00:00');setSetting('nightfall_end','00:00');
      const player=g.createPlayer({name:'Upgrade Player',empire:'Legacy Empire',abbr:'UP',pin:'1234'});
      g.launchGame(new Date(Date.now()+86400000));
      db.prepare('DELETE FROM tiles').run();
      for(const q of [0,1,2])db.prepare("INSERT INTO tiles(q,r,terrain,owner_id,strength) VALUES (?,0,'plains',?,0)").run(q,q===0?player.id:null);
      g.queueOrder(player.id,'expand',1,0);g.queueOrder(player.id,'expand',2,0);
      db.prepare('UPDATE players SET orders_left=0').run();
      setSetting('orders_per_day',20);setSetting('orders_per_turn',99);
      console.log(JSON.stringify(snapshot()));db.close();`)
    for(let restart=0;restart<2;restart++)assert.deepEqual(run('console.log(JSON.stringify(snapshot()));db.close();'),original)
    const after=run(`g.resolveTurn();console.log(JSON.stringify({balance:g.personalState(g.listPlayers()[0].id).orders_left,orders:db.prepare("SELECT * FROM orders WHERE status='queued'").all(),next:getSetting('next_tick_at'),tick:getSetting('tick_count')}));db.close();`)
    assert.equal(after.balance,5,'legacy saved allowance cannot override the approved five')
    assert.equal(after.orders.length,1,'the later expansion stays queued')
    assert.equal(after.orders[0].q,2)
    assert.equal(after.next,original.settings.find(s=>s.key==='next_tick_at').value)
    assert.equal(after.tick,'1')
  } finally {fs.rmSync(dir,{recursive:true,force:true})}
})
