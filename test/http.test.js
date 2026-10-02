import test from 'node:test'
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import crypto from 'node:crypto'
const base='http://127.0.0.1:3187'

// Use the normal Socket.IO polling handshake so this test needs no extra client dependency.
async function connectPlayer(cookie='') {
  const headers={Cookie:cookie}
  const endpoint=base+'/socket.io/?EIO=4&transport=polling'
  const handshake=await (await fetch(endpoint,{headers})).text()
  assert.equal(handshake[0],'0')
  const url=endpoint+'&sid='+encodeURIComponent(JSON.parse(handshake.slice(1)).sid)
  const connected=await fetch(url,{method:'POST',headers:{...headers,'Content-Type':'text/plain'},body:'40'})
  assert.equal(connected.status,200)
  const read=async predicate=>{
    const events=[]
    do {
      const response=await fetch(url,{headers,signal:AbortSignal.timeout(3000)})
      assert.equal(response.status,200)
      for(const packet of (await response.text()).split('\x1e')) {
        if(packet.startsWith('42')) events.push(JSON.parse(packet.slice(2)))
      }
    } while(!predicate(events))
    return events
  }
  const initial=await read(events=>events.some(([type])=>type===(cookie?'me':'state')))
  return {read,initial}
}

test('HTTP auth, settings validation, signup and event controls',async()=>{
  const password=crypto.randomUUID()
  const server=spawn(process.execPath,['server.js'],{cwd:new URL('..',import.meta.url),env:{...process.env,NIBEX_DB:':memory:',PORT:'3187',PUBLIC_URL:base,ADMIN_PASSWORD:password},stdio:['ignore','pipe','pipe']})
  let serverErrors=''
  server.stderr.on('data',b=>{serverErrors+=b})
  try {
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Error('Server startup timeout')),10000)
      server.stdout.on('data',b=>{if(String(b).includes('running at')){clearTimeout(timer);resolve()}})
      server.on('error',reject)
      server.on('exit',(code,signal)=>{clearTimeout(timer);reject(Error(`Server exited ${signal ?? code}: ${serverErrors}`))})
    })
    const post=(url,body,cookie='')=>fetch(base+url,{method:'POST',redirect:'manual',headers:{'Content-Type':'application/x-www-form-urlencoded',Cookie:cookie},body:new URLSearchParams(body)})
    const guide=await fetch(base+'/howtoplay',{redirect:'manual'})
    assert.equal(guide.status,200)
    assert.match(guide.headers.get('content-type'),/text\/html/)
    assert.equal(guide.headers.get('cache-control'),'no-store')
    assert.equal(guide.headers.get('set-cookie'),null)
    const defaultGuide=await guide.text()
    assert.match(defaultGuide,/every 180 minutes/)
    assert.match(defaultGuide,/receive 5 orders/)
    assert.match(defaultGuide,/per 5 non-resource tiles you own/)
    assert.match(defaultGuide,/ore and food tiles do not/)
    assert.match(defaultGuide,/At the deadline:/)
    assert.match(defaultGuide,/earlier registration/)
    assert.match(await (await fetch(base+'/join')).text(),/href="\/howtoplay"/)
    assert.equal((await fetch(base+'/admin')).status,401)
    assert.equal((await post('/admin/login',{password:'é'.repeat(password.length)})).status,401)
    const login=await post('/admin/login',{password})
    assert.equal(login.status,302)
    const admin=login.headers.get('set-cookie').split(';')[0]
    const settings={tick_interval_min:'180',orders_per_turn:'20',nightfall_start:'00:00',nightfall_end:'00:00',quests_per_day:'0',bot_count:'0',end_at:new Date(Date.now()+86400000).toISOString()}
    assert.equal((await post('/admin/settings',{...settings,tick_interval_min:'0'},admin)).status,400)
    assert.equal((await post('/admin/settings',{...settings,tick_interval_min:'90',orders_per_turn:'12'},admin)).status,302)
    const configuredGuide=await (await fetch(base+'/howtoplay')).text()
    assert.match(configuredGuide,/every 90 minutes/)
    assert.match(configuredGuide,/receive 5 orders/)
    assert.equal((await post('/admin/settings',settings,admin)).status,302)
    const joined=await post('/join',{name:'Test Player',empire:'Test Empire',abbr:'TE',pin:'9182'})
    assert.equal(joined.status,302)
    const player=joined.headers.get('set-cookie').split(';')[0]
    const publicGuide=await (await fetch(base+'/howtoplay')).text()
    assert.doesNotMatch(publicGuide,/Test Player|Test Empire|nibex_token|window\.__STATE__/)
    const playerPage=await (await fetch(base+'/play',{headers:{Cookie:player}})).text()
    assert.match(playerPage,/href="\/howtoplay"/)
    assert.match(playerPage,/At the deadline:/)
    assert.equal((await post('/join',{name:'Other',empire:'Other',abbr:'TE',pin:'1234'})).status,400)
    const form=new FormData()
    for(const [key,value] of Object.entries({name:'Zoë Player',empire:'Second Empire',abbr:'SE',pin:'4321'})) form.append(key,value)
    const secondJoined=await fetch(base+'/join',{method:'POST',body:form,redirect:'manual'})
    assert.equal(secondJoined.status,302, 'the regular multipart join form still works')
    const secondPlayer=secondJoined.headers.get('set-cookie').split(';')[0]
    const [firstPhone,secondPhone,spectator]=await Promise.all([connectPlayer(player),connectPlayer(secondPlayer),connectPlayer()])
    const firstId=firstPhone.initial.find(([type])=>type==='me')[1].id
    const secondId=secondPhone.initial.find(([type])=>type==='me')[1].id
    assert.notEqual(firstId,secondId)
    assert.equal(firstPhone.initial.find(([type])=>type==='me')[1].garrisons.length,0)
    assert.equal((await post('/admin/settings',{...settings,orders_per_turn:'17',quests_per_day:'2'},admin)).status,302)
    assert.equal((await post('/admin/launch',{},admin)).status,302)
    const launched=events=>events.some(([type,value])=>type==='state'&&value.phase==='running')
    const privateLaunch=events=>launched(events)&&events.some(([type])=>type==='me')
    const [firstUpdates,secondUpdates,publicUpdates]=await Promise.all([firstPhone.read(privateLaunch),secondPhone.read(privateLaunch),spectator.read(launched)])
    for(const [updates,id] of [[firstUpdates,firstId],[secondUpdates,secondId]]) {
      const snapshots=updates.filter(([type])=>type==='me').map(([,value])=>value)
      assert.equal(snapshots.length,1)
      assert.equal(snapshots[0].id,id, 'each phone receives only its own private state')
      assert.equal(snapshots[0].orders_left,5)
      assert.equal(snapshots[0].garrisons.length,7)
      assert.ok(snapshots[0].quest)
    }
    assert.ok(!publicUpdates.some(([type])=>type==='me'), 'spectators must not receive private snapshots')
    assert.equal((await post('/admin/tick',{},admin)).status,400)
    assert.equal((await post('/admin/settings',{...settings,tick_interval_min:'30'},admin)).status,400)
    assert.equal((await post('/admin/pause',{},admin)).status,302)
    assert.equal((await post('/api/trade',{dir:'ore2food',times:'1'},player)).status,400)
    assert.equal((await post('/admin/resume',{},admin)).status,302)
    assert.equal((await post('/api/trade',{dir:'ore2food',times:'1'},player)).status,200)
    assert.equal((await post('/admin/end',{},admin)).status,302)
    assert.equal((await fetch(base+'/howtoplay',{redirect:'manual'})).status,200)
    assert.equal((await post('/api/trade',{dir:'ore2food',times:'1'},player)).status,400)
  } finally {server.kill()}
})
