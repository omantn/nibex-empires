import test from 'node:test'
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import crypto from 'node:crypto'
const base='http://127.0.0.1:3187'
test('HTTP auth, settings validation, signup and event controls',async()=>{
  const password=crypto.randomUUID()
  const server=spawn(process.execPath,['server.js'],{cwd:new URL('..',import.meta.url),env:{...process.env,NIBEX_DB:':memory:',PORT:'3187',ADMIN_PASSWORD:password},stdio:['ignore','pipe','pipe']})
  try {
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Error('Server startup timeout')),10000)
      server.stdout.on('data',b=>{if(String(b).includes('running at')){clearTimeout(timer);resolve()}})
      server.on('error',reject)
      server.on('exit',c=>{clearTimeout(timer);reject(Error('Server exited '+c))})
    })
    const post=(url,body,cookie='')=>fetch(base+url,{method:'POST',redirect:'manual',headers:{'Content-Type':'application/x-www-form-urlencoded',Cookie:cookie},body:new URLSearchParams(body)})
    assert.equal((await fetch(base+'/admin')).status,401)
    assert.equal((await post('/admin/login',{password:'é'.repeat(password.length)})).status,401)
    const login=await post('/admin/login',{password})
    assert.equal(login.status,302)
    const admin=login.headers.get('set-cookie').split(';')[0]
    const settings={tick_interval_min:'180',orders_per_day:'20',nightfall_start:'00:00',nightfall_end:'00:00',quests_per_day:'0',bot_count:'0',end_at:new Date(Date.now()+86400000).toISOString()}
    assert.equal((await post('/admin/settings',{...settings,tick_interval_min:'0'},admin)).status,400)
    assert.equal((await post('/admin/settings',settings,admin)).status,302)
    const joined=await post('/join',{name:'Test Player',empire:'Test Empire',abbr:'TE',pin:'9182'})
    assert.equal(joined.status,302)
    const player=joined.headers.get('set-cookie').split(';')[0]
    assert.equal((await post('/join',{name:'Other',empire:'Other',abbr:'TE',pin:'1234'})).status,400)
    assert.equal((await post('/admin/launch',{},admin)).status,302)
    assert.equal((await post('/admin/tick',{},admin)).status,400)
    assert.equal((await post('/admin/settings',{...settings,tick_interval_min:'30'},admin)).status,400)
    assert.equal((await post('/admin/pause',{},admin)).status,302)
    assert.equal((await post('/api/trade',{dir:'ore2food',times:'1'},player)).status,400)
    assert.equal((await post('/admin/resume',{},admin)).status,302)
    assert.equal((await post('/api/trade',{dir:'ore2food',times:'1'},player)).status,200)
    assert.equal((await post('/admin/end',{},admin)).status,302)
    assert.equal((await post('/api/trade',{dir:'ore2food',times:'1'},player)).status,400)
  } finally {server.kill()}
})
