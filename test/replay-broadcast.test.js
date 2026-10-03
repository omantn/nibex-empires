import test from 'node:test'
import assert from 'node:assert/strict'
import { createReplayBroadcast, ceremonyActive, FRAME_MS, HOLD_MS, MAX_PLAYBACK_MS, MAX_REPLAY_BYTES } from '../src/replay-broadcast.js'

const replayFixture = (count = 3) => ({ available: true, totalTurns: count - 1,
  map: [{ q: 0, r: 0, terrain: 'plains', owner: null, capital: 0, warded: 0 }],
  players: [{ id: 1, empire: 'Alpha', abbr: 'AA', color: '#123456' }],
  frames: Array.from({ length: count }, (_, tick) => ({ tick, label: `Turn ${tick}`, changes: [{ index: 0, owner: 1 }] })),
})

function harness(replay = replayFixture()) {
  let time = 1700000000000, nextId = 0, reads = 0
  const settings = { phase: 'running' }, notifications = [], timers = new Set()
  const broadcast = createReplayBroadcast({
    readReplay() { reads++; return replay }, getSettings: () => settings,
    now: () => time, createId: () => `id-${++nextId}`, notify: packet => notifications.push(packet),
    setTimer(fn, ms) { const timer = { fn, ms, unref() {} }; timers.add(timer); return timer },
    clearTimer: timer => timers.delete(timer),
  })
  return { broadcast, settings, notifications, timers, replay,
    reads: () => reads, advance: ms => { time += ms }, now: () => time,
    fire(timer = timers.values().next().value) { timers.delete(timer); timer.fn() },
  }
}

test('shared playback has one fixed clock and snapshot; repeat start and stop are idempotent', () => {
  const h = harness(), before = h.broadcast.state()
  assert.deepEqual(before, { instance: 'id-1', revision: 0, serverNow: h.now(), playback: null })
  assert.deepEqual(h.broadcast.start(), { ok: true })
  const first = h.broadcast.state()
  assert.equal(first.revision, 1)
  assert.equal(first.playback.frameMs, FRAME_MS)
  assert.equal(first.playback.holdMs, HOLD_MS)
  assert.equal(first.playback.endsAt - first.playback.startedAt, 2 * FRAME_MS + HOLD_MS)
  assert.equal(h.timers.size, 1)
  assert.deepEqual(h.notifications, [first])
  h.replay.frames.push({ tick: 3, label: 'New turn', changes: [] })
  h.advance(1000)
  assert.deepEqual(h.broadcast.start(), { ok: true })
  assert.equal(h.reads(), 1)
  assert.equal(h.broadcast.state().playback.frames, undefined)
  assert.equal(h.broadcast.state().playback.replay.frames.length, 3)
  assert.equal(h.broadcast.state().playback.startedAt, first.playback.startedAt)
  assert.equal(h.broadcast.state().playback.id, first.playback.id)
  assert.equal(h.notifications.length, 1)
  h.broadcast.stop(); h.broadcast.stop()
  assert.equal(h.timers.size, 0)
  assert.equal(h.broadcast.state().playback, null)
  assert.equal(h.broadcast.state().revision, 2)
  assert.equal(h.notifications.length, 2)
  h.broadcast.start()
  assert.notEqual(h.broadcast.state().playback.id, first.playback.id)
  assert.equal(h.broadcast.state().playback.replay.frames.length, 4)
  assert.equal(h.broadcast.state().revision, 3)
})

test('authoritative expiry stops at the deadline and stale or early timers are harmless', () => {
  const h = harness(replayFixture(1))
  h.broadcast.start()
  assert.equal(h.broadcast.state().playback.endsAt - h.now(), HOLD_MS)
  const firstTimer = [...h.timers][0]
  h.advance(HOLD_MS - 1); h.fire(firstTimer)
  assert.ok(h.broadcast.state().playback)
  assert.equal(h.timers.size, 1)
  assert.equal([...h.timers][0].ms, 1)
  h.advance(1); h.fire()
  assert.equal(h.broadcast.state().playback, null)
  assert.equal(h.broadcast.state().revision, 2)
  assert.equal(h.notifications.at(-1).playback, null)
  assert.equal(h.timers.size, 0)
  h.broadcast.start()
  h.fire(firstTimer)
  assert.ok(h.broadcast.state().playback)
  assert.equal(h.timers.size, 1)
  h.advance(HOLD_MS)
  assert.equal(h.broadcast.state().playback, null, 'GET reconciles even before the timer runs')
  assert.equal(h.timers.size, 0)
})

test('long histories speed up to fit two minutes including a five-second final hold', () => {
  const h = harness(replayFixture(10001))
  assert.equal(h.broadcast.start().ok, true)
  const p = h.broadcast.state().playback
  assert.ok(p.frameMs > 0 && p.frameMs < FRAME_MS)
  assert.ok(p.endsAt - p.startedAt <= MAX_PLAYBACK_MS)
  assert.equal(p.endsAt - p.startedAt, 10000 * p.frameMs + HOLD_MS)
})

test('lobby, unavailable, malformed, huge and failed replay reads cannot start a broadcast', () => {
  for (const replay of [
    { available: false, reason: 'No history' }, { available: true, frames: [] },
    { ...replayFixture(), frames: Array(12001).fill({}) },
    { ...replayFixture(), map: Array(20001).fill({}) },
    { ...replayFixture(), players: Array(1001).fill({}) },
    { ...replayFixture(), note: 'x'.repeat(MAX_REPLAY_BYTES) },
  ]) {
    const h = harness(replay)
    assert.ok(h.broadcast.start().error)
    assert.equal(h.broadcast.state().playback, null)
    assert.equal(h.broadcast.state().revision, 0)
    assert.equal(h.timers.size, 0)
    assert.equal(h.notifications.length, 0)
  }
  const h = harness(); h.settings.phase = 'lobby'
  assert.match(h.broadcast.start().error, /after launch/)
  assert.equal(h.reads(), 0)
  const failed = createReplayBroadcast({ getSettings: () => ({ phase: 'running' }), readReplay() { throw Error('database failure') } })
  assert.match(failed.start().error, /could not be loaded/)
  assert.equal(failed.state().playback, null)
})

test('ended games can replay while awaiting the finale and once the ceremony completes', () => {
  const h = harness()
  h.settings.phase = 'finale'
  assert.equal(h.broadcast.start().ok, true)
  h.broadcast.stop()
  Object.assign(h.settings, { finale_started_at: new Date(h.now()).toISOString(), finale_data: JSON.stringify([{}, {}]) })
  assert.equal(h.broadcast.start().status, 409)
  h.advance(26999)
  assert.equal(h.broadcast.start().status, 409)
  h.advance(1)
  assert.equal(h.broadcast.start().ok, true)
  assert.equal(ceremonyActive({ ...h.settings, finale_data: 'bad' }, h.now()), true)
  assert.equal(ceremonyActive({ ...h.settings, finale_started_at: 'bad' }, h.now()), true)
  assert.equal(ceremonyActive({ ...h.settings, phase: 'running' }, h.now()), false)
})

test('a new server instance has no persisted playback and a new instance identifier', () => {
  const options = { getSettings: () => ({ phase: 'running' }), readReplay: replayFixture }
  const before = createReplayBroadcast(options), after = createReplayBroadcast(options)
  before.start()
  assert.notEqual(before.state().instance, after.state().instance)
  assert.equal(after.state().revision, 0)
  assert.equal(after.state().playback, null)
  before.stop()
})

test('real replay broadcasting never changes game, turn, score, orders or finale database state', async () => {
  process.env.NIBEX_DB = ':memory:'
  const { db, setSetting, getSetting, allSettings } = await import('../src/db.js')
  const game = await import('../src/game.js')
  const { readReplay } = await import('../src/replay.js')
  game.resetGame(); setSetting('bot_count', 0); setSetting('quests_per_day', 0)
  setSetting('nightfall_start', '00:00'); setSetting('nightfall_end', '00:00')
  const player = game.createPlayer({ name: 'PRIVATE PLAYER', empire: 'Alpha', abbr: 'AA', pin: '9271' })
  game.launchGame(new Date(Date.now() + 86400000)); game.resolveTurn()
  const broadcast = createReplayBroadcast({ readReplay, getSettings: allSettings })
  const before = db.serialize()
  assert.equal(broadcast.start().ok, true)
  assert.doesNotMatch(JSON.stringify(broadcast.state()), /PRIVATE PLAYER|"9271"|token|pin|orders|relics|score|strength/)
  assert.deepEqual(db.serialize(), before)
  const id = broadcast.state().playback.id
  game.resolveTurn()
  const afterTurn = db.serialize()
  assert.equal(broadcast.start().ok, true)
  assert.equal(broadcast.state().playback.id, id)
  assert.equal(broadcast.state().playback.replay.totalTurns, 1)
  assert.equal(Number(getSetting('tick_count')), 2)
  assert.equal(game.personalState(player.id).orders_left, 15)
  broadcast.stop()
  assert.deepEqual(db.serialize(), afterTurn)
  game.endGame()
  const ended = db.serialize(), standings = getSetting('finale_data')
  assert.equal(broadcast.start().ok, true)
  broadcast.stop()
  assert.deepEqual(db.serialize(), ended)
  assert.equal(getSetting('finale_data'), standings)
  game.startFinale()
  const ceremony = db.serialize()
  assert.equal(broadcast.start().status, 409)
  assert.deepEqual(db.serialize(), ceremony)
  db.close()
})
