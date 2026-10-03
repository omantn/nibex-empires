// Optional, read-only reconstruction. Never imported by the turn/finish engine.
import { db, allSettings } from './db.js'

const unavailable = (reason) => ({ available: false, reason, frames: [], map: [], players: [] })
const key = (t) => `${t.q},${t.r}`

export function reconstructReplay({ settings, tiles, players, events, eventSequence }) {
  if (settings.phase === 'lobby' || !tiles.length) return unavailable('The map is available after launch.')
  const total = Number(settings.tick_count)
  if (!Number.isSafeInteger(total) || total < 0 || total > 10000) return unavailable('Turn history cannot be verified.')
  const fail = () => unavailable('The saved history is incomplete or inconsistent. Normal play and the finale are still available.')
  const launch = events.find(e => e.type === 'phase' && e.tick === 0 && e.message === '🚀 The game has begun — the empires are revealed. Make your moves.')
  const launchTime = Date.parse(settings.launched_at)
  if (!launch || !Number.isFinite(launchTime)) return fail()
  if (eventSequence != null && eventSequence !== events.at(-1)?.id) return fail()
  const publicPlayers = players.map(({ id, empire, abbr, color }) => ({ id, empire, abbr, color }))
  const ids = new Set(players.map(p => p.id))
  if (publicPlayers.some(p => !Number.isSafeInteger(p.id) || !/^#[0-9a-f]{6}$/i.test(p.color))) return fail()
  // Only territorial ownership is reconstructed. Late spawns overwrite terrain,
  // so showing today's resource icons on earlier frames would invent history.
  const map = tiles.map(t => ({ q:t.q, r:t.r, terrain:'plains', owner:null, capital:0, warded:0 }))
  const index = new Map(map.map((t,i) => [key(t),i]))
  const owners = map.map(() => null)
  const wards = new Map(players.map(p => [p.id, []]))
  for (const t of tiles) {
    if (!Number.isSafeInteger(t.q) || !Number.isSafeInteger(t.r) || (t.owner_id != null && !ids.has(t.owner_id))) return fail()
    if (t.warded) {
      if (!ids.has(t.owner_id)) return fail()
      wards.get(t.owner_id).push({ index:index.get(key(t)), owner:t.owner_id, capital:t.capital ? 1:0, warded:1 })
    }
  }
  const joins = new Map()
  for (const p of players) {
    const matches = events.filter(e => e.id > launch.id && e.type === 'join' && e.message === `🏰 ${p.empire} [${p.abbr}] has entered the world.`)
    if (matches.length > 1) return fail()
    if (matches.length) joins.set(matches[0].id, p.id)
    else {
      const created = Date.parse(p.created_at.replace(' ', 'T') + 'Z')
      if (!Number.isFinite(created) || created > launchTime) return fail()
    }
  }
  const lateIds = new Set(joins.values())
  const frames = [{ tick:0, label:'Launch', changes:players.filter(p => !lateIds.has(p.id)).flatMap(p => wards.get(p.id)) }]
  const apply = changes => changes.forEach(c => { owners[c.index] = c.owner })
  apply(frames[0].changes)
  let completed = 0, pending = [], previousId = launch.id
  for (const e of events.filter(e => e.id > launch.id)) {
    if (!Number.isSafeInteger(e.id) || e.id !== previousId + 1 || !Number.isSafeInteger(e.tick) || e.tick < completed || e.tick > total) return fail()
    previousId = e.id
    if (joins.has(e.id)) {
      if (e.tick !== completed || pending.length) return fail()
      const changes = wards.get(joins.get(e.id))
      if (changes.some(c => owners[c.index] != null)) return fail()
      apply(changes)
      frames.push({ tick:completed, label:`After turn ${completed} · empire joins`, changes })
    } else if (e.type === 'expand' || e.type === 'battle') {
      if (e.tick !== completed + 1) return fail()
      let data
      try { data = JSON.parse(e.data) } catch { return fail() }
      if (!data || !ids.has(data.player) || !Array.isArray(data.tiles) || !data.tiles.length) return fail()
      for (const t of data.tiles) {
        if (!t || typeof t !== 'object') return fail()
        const i = index.get(key(t))
        if (i == null || tiles[i].warded || !Number.isSafeInteger(t.q) || !Number.isSafeInteger(t.r)) return fail()
        // The event records the resulting owner, including a successful defence.
        pending.push({ index:i, owner:data.player })
      }
    } else if (e.type === 'tick') {
      if (e.tick !== completed + 1) return fail()
      completed = e.tick
      apply(pending)
      frames.push({ tick:completed, label:`Turn ${completed}`, changes:pending })
      pending = []
    } else if (e.type === 'join' && e.tick >= 0) return fail()
  }
  if (completed !== total || pending.length || tiles.some((t,i) => t.owner_id !== owners[i])) return fail()
  return { available:true, totalTurns:total, map, players:publicPlayers, frames,
    note:'Territory reconstructed from saved events, not map snapshots. Resource terrain and hidden game information are omitted. Playback is a fixed view through the latest completed turn; reopen to refresh.' }
}

export function readReplay() {
  // A consistent read transaction; no writes or dependency from normal finish.
  try {
    return db.transaction(() => reconstructReplay({ settings:allSettings(),
      tiles:db.prepare('SELECT q,r,terrain,owner_id,capital,warded FROM tiles ORDER BY q,r').all(),
      players:db.prepare('SELECT id,empire,abbr,color,created_at FROM players ORDER BY id').all(),
      events:db.prepare('SELECT id,tick,type,message,data FROM events ORDER BY id').all(),
      eventSequence:db.prepare("SELECT seq FROM sqlite_sequence WHERE name='events'").get()?.seq,
    }))()
  } catch {
    return unavailable('Replay could not be loaded. Normal play and the finale are still available.')
  }
}
