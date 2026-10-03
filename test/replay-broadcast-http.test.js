import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'

const base = 'http://127.0.0.1:3193'
const post = (url, body = {}, cookie = '') => fetch(base + url, {
  method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
  body: new URLSearchParams(body),
})
const current = async () => {
  const response = await fetch(base + '/api/timelapse')
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  return response.json()
}

// Exercise the actual Socket.IO protocol without adding a client dependency.
async function spectator() {
  const endpoint = base + '/socket.io/?EIO=4&transport=polling'
  const handshake = await (await fetch(endpoint)).text()
  assert.equal(handshake[0], '0')
  const url = endpoint + '&sid=' + encodeURIComponent(JSON.parse(handshake.slice(1)).sid)
  assert.equal((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '40' })).status, 200)
  const read = async predicate => {
    const events = [], deadline = Date.now() + 9000
    do {
      const response = await fetch(url, { signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) })
      assert.equal(response.status, 200)
      for (const packet of (await response.text()).split('\x1e')) if (packet.startsWith('42')) events.push(JSON.parse(packet.slice(2)))
    } while (!predicate(events))
    return events
  }
  return { read, initial: await read(events => events.some(([type]) => type === 'timelapse')) }
}

test('HTTP and sockets share an admin-controlled replay, expiry, reset and ceremony precedence', async () => {
  const password = crypto.randomUUID()
  const server = spawn(process.execPath, ['server.js'], { cwd: new URL('..', import.meta.url),
    env: { ...process.env, NIBEX_DB: ':memory:', PORT: '3193', PUBLIC_URL: base, ADMIN_PASSWORD: password },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let errors = ''
  server.stderr.on('data', chunk => { errors += chunk })
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Server startup timeout')), 10000)
      server.stdout.on('data', chunk => { if (String(chunk).includes('running at')) { clearTimeout(timer); resolve() } })
      server.on('error', reject)
      server.on('exit', (code, signal) => { clearTimeout(timer); reject(Error(`Server exited ${signal ?? code}: ${errors}`)) })
    })
    const empty = await current()
    assert.equal(empty.revision, 0)
    assert.equal(empty.playback, null)
    assert.match(empty.instance, /^[0-9a-f-]{36}$/)
    assert.equal(typeof empty.serverNow, 'number')
    assert.equal((await post('/admin/timelapse/start')).status, 401)
    assert.equal((await post('/admin/timelapse/stop')).status, 401)
    const login = await post('/admin/login', { password })
    const admin = login.headers.get('set-cookie').split(';')[0]
    assert.equal((await post('/admin/timelapse/start', {}, admin)).status, 400)
    const settings = { tick_interval_min: '180', nightfall_start: '00:00', nightfall_end: '00:00', quests_per_day: '0',
      bot_count: '0', allow_fast_forward: '1', end_at: new Date(Date.now() + 86400000).toISOString() }
    assert.equal((await post('/admin/settings', settings, admin)).status, 302)
    const joined = await post('/join', { name: 'PRIVATE REAL NAME', empire: 'Alpha', abbr: 'AA', pin: '8271' })
    const playerCookie = joined.headers.get('set-cookie').split(';')[0]
    assert.equal((await post('/admin/timelapse/start', {}, playerCookie)).status, 401)
    assert.equal((await post('/admin/launch', {}, admin)).status, 302)
    const first = await spectator()
    assert.equal(first.initial.find(([type]) => type === 'timelapse')[1].playback, null)
    assert.equal((await post('/admin/timelapse/start', {}, admin)).status, 302)
    const started = (await first.read(events => events.some(([type]) => type === 'timelapse'))).find(([type]) => type === 'timelapse')[1]
    assert.equal(started.instance, empty.instance)
    assert.equal(started.revision, 1)
    assert.equal(started.playback.replay.frames.length, 1)
    assert.equal(started.playback.endsAt - started.playback.startedAt, 5000)
    assert.doesNotMatch(JSON.stringify(started), /PRIVATE REAL NAME|"8271"|token|pin|orders|relics|score|strength/)
    assert.equal((await post('/admin/timelapse/start', {}, admin)).status, 302)
    assert.deepEqual((await current()).playback, started.playback)
    const expired = (await first.read(events => events.some(([type, value]) => type === 'timelapse' && !value.playback)))
      .find(([type, value]) => type === 'timelapse' && !value.playback)[1]
    assert.equal(expired.revision, 2)
    assert.ok(expired.serverNow >= started.playback.endsAt)
    assert.equal((await current()).playback, null)
    assert.equal((await post('/admin/timelapse/stop', {}, admin)).status, 302)
    assert.equal((await current()).revision, 2)

    assert.equal((await post('/admin/timelapse/start', {}, admin)).status, 302)
    const next = await current()
    assert.equal(next.revision, 3)
    assert.notEqual(next.playback.id, started.playback.id)
    const second = await spectator()
    const reconnect = second.initial.find(([type]) => type === 'timelapse')[1]
    assert.deepEqual(reconnect.playback, next.playback)
    assert.equal(reconnect.revision, next.revision)
    assert.equal((await post('/admin/tick', {}, admin)).status, 302)
    const turn = await second.read(events => events.some(([type, value]) => type === 'state' && value.tick === 1))
    assert.ok(!turn.some(([type]) => type === 'me'))
    assert.equal((await current()).playback.replay.totalTurns, 0, 'live turns continue without mutating the replay snapshot')
    assert.equal((await post('/admin/finale', {}, admin)).status, 302)
    assert.equal((await current()).playback.id, next.playback.id, 'invalid finale request cannot interrupt replay')
    assert.equal((await post('/admin/end', {}, admin)).status, 302)
    assert.equal((await current()).playback.id, next.playback.id, 'ending the game does not start the ceremony')
    assert.equal((await post('/admin/timelapse/start', {}, admin)).status, 302, 'ended and awaiting ceremony is allowed')
    assert.equal((await post('/admin/finale', {}, admin)).status, 302)
    const stopped = await second.read(events => events.some(([type, value]) => type === 'timelapse' && !value.playback))
    assert.equal(stopped.find(([type, value]) => type === 'timelapse' && !value.playback)[1].revision, 4)
    assert.equal((await current()).playback, null)
    assert.equal((await post('/admin/timelapse/start', {}, admin)).status, 409)

    assert.equal((await post('/admin/reset', {}, admin)).status, 302)
    assert.equal((await current()).playback, null)
    assert.equal((await post('/admin/timelapse/start', {}, admin)).status, 400)
    assert.equal((await post('/admin/settings', settings, admin)).status, 302)
    assert.equal((await post('/join', { name: 'NEXT PRIVATE NAME', empire: 'Beta', abbr: 'BB', pin: '3948' })).status, 302)
    assert.equal((await post('/admin/launch', {}, admin)).status, 302)
    assert.equal((await post('/admin/timelapse/start', {}, admin)).status, 302)
    assert.ok((await current()).playback)
    assert.equal((await post('/admin/reset', {}, admin)).status, 302)
    const reset = await current()
    assert.equal(reset.playback, null)
    assert.equal(reset.revision, 6)
    assert.doesNotMatch(JSON.stringify(reset), /Alpha|Beta|PRIVATE/)
    assert.doesNotMatch(errors, /TypeError|ReferenceError|SQLITE_ERROR|SyntaxError/)
  } finally {
    server.kill()
    if (server.exitCode == null && server.signalCode == null) await new Promise(resolve => server.once('exit', resolve))
  }
})
