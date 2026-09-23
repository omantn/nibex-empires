import crypto from 'node:crypto'
import { db, getSetting, setSetting, allSettings } from './db.js'

// 20 visually distinct empire colors, assigned in join order.
const COLORS = [
  '#e6194b', '#3cb44b', '#ffe119', '#4363d8', '#f58231',
  '#911eb4', '#46f0f0', '#f032e6', '#bcf60c', '#fabebe',
  '#008080', '#e6beff', '#9a6324', '#fffac8', '#800000',
  '#aaffc3', '#808000', '#ffd8b1', '#000075', '#808080',
]

export function listPlayers() {
  return db.prepare('SELECT id, name, empire, abbr, color, is_bot, created_at FROM players ORDER BY id').all()
}

export function toggleBot(id) {
  db.prepare('UPDATE players SET is_bot = 1 - is_bot WHERE id = ?').run(id)
}

export function findPlayerByToken(token) {
  if (!token) return null
  return db.prepare('SELECT * FROM players WHERE token = ?').get(token) ?? null
}

const STARTING_ORE = 5
const STARTING_FOOD = 5

function hslToHex(h, s, l) {
  s /= 100; l /= 100
  const f = (n) => {
    const k = (n + h / 30) % 12
    const c = l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1))
    return Math.round(255 * c).toString(16).padStart(2, '0')
  }
  return `#${f(0)}${f(8)}${f(4)}`
}

// Past the 20-color palette, sweep the hue wheel and take the color farthest
// (RGB distance) from every color already in use — a 21st empire never
// resembles an existing one.
export function pickOverflowColor() {
  const toRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
  const used = db.prepare('SELECT color FROM players').all().map((p) => toRgb(p.color))
  let best = COLORS[0], bestD = -1
  for (let h = 0; h < 360; h += 6) {
    for (const l of [42, 55, 68]) {
      const c = hslToHex(h, 72, l)
      const rgb = toRgb(c)
      const d = Math.min(...used.map((u) => Math.hypot(rgb[0] - u[0], rgb[1] - u[1], rgb[2] - u[2])), Infinity)
      if (d > bestD) { bestD = d; best = c }
    }
  }
  return best
}

function hashPin(pin) {
  if (pin == null) return null
  const salt=crypto.randomBytes(16).toString('hex')
  return 'scrypt:'+salt+':'+crypto.scryptSync(pin,salt,32).toString('hex')
}
export function createPlayer({ name, empire, abbr, pin = null, emblem = null, emblemMime = null }) {
  abbr = String(abbr).trim().toUpperCase()
  if (db.prepare('SELECT 1 FROM players WHERE UPPER(abbr) = ?').get(abbr)) throw new Error('That abbreviation is already taken.')
  const count = db.prepare('SELECT COUNT(*) AS c FROM players').get().c
  const token = crypto.randomUUID()
  const color = count < COLORS.length ? COLORS[count] : pickOverflowColor()
  db.prepare('INSERT INTO players (token, name, empire, abbr, color, pin, emblem, emblem_mime, orders_left, ore, food) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(token, name, empire, abbr, color, hashPin(pin), emblem, emblemMime, Number(getSetting('orders_per_day')), STARTING_ORE, STARTING_FOOD)
  return findPlayerByToken(token)
}

export function findPlayerByAbbrPin(abbr, pin) {
  if (!abbr || !/^\d{4}$/.test(pin)) return null
  const players = db.prepare('SELECT * FROM players WHERE UPPER(abbr)=?').all(abbr.toUpperCase())
  for (const p of players) {
    if (!p.pin) continue
    if (p.pin.startsWith('scrypt:')) {
      const [,salt,digest]=p.pin.split(':')
      const expected=Buffer.from(digest,'hex'), actual=crypto.scryptSync(pin,salt,32)
      if (expected.length === actual.length && crypto.timingSafeEqual(expected,actual)) return p
    } else if (p.pin === pin) {
      db.prepare('UPDATE players SET pin=? WHERE id=?').run(hashPin(pin),p.id)
      return p
    }
  }
  return null
}

export function getEmblem(playerId) {
  return db.prepare('SELECT abbr, color, emblem, emblem_mime FROM players WHERE id = ?').get(playerId) ?? null
}

// Fallback emblem: the empire abbreviation on its color. Dark text on light
// colors, light text on dark ones.
export function fallbackEmblemSvg({ abbr, color }) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16))
  const text = 0.299 * r + 0.587 * g + 0.114 * b > 150 ? '#111111' : '#ffffff'
  const size = abbr.length <= 2 ? 48 : abbr.length === 3 ? 38 : 30
  return `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120">
  <rect width="120" height="120" rx="18" fill="${color}"/>
  <text x="60" y="64" text-anchor="middle" dominant-baseline="middle"
    font-family="system-ui, sans-serif" font-weight="700" font-size="${size}" fill="${text}">${abbr}</text>
</svg>`
}

// data (optional): structured payload for dashboard visualization —
// { tiles: [{q,r}], player } lets the TV flash where the event happened.
export function addEvent(type, message, data = null) {
  const tick = Number(getSetting('tick_count'))
  const info = db.prepare('INSERT INTO events (tick, type, message, data) VALUES (?, ?, ?, ?)')
    .run(tick, type, message, data ? JSON.stringify(data) : null)
  return { id: Number(info.lastInsertRowid), tick, type, message, data, created_at: new Date().toISOString() }
}

export function recentEvents(limit = 30) {
  return db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit)
    .map((e) => ({ ...e, data: e.data ? JSON.parse(e.data) : null }))
}

function parseHM(s) {
  const [h, m] = s.split(':').map(Number)
  return h * 60 + m
}

// Nightfall window may cross midnight (e.g. 02:00-10:00 does not, 23:00-09:00 does).
export function inNightfall(d = new Date()) {
  const s = allSettings()
  const start = parseHM(s.nightfall_start)
  const end = parseHM(s.nightfall_end)
  const now = d.getHours() * 60 + d.getMinutes()
  return start <= end ? now >= start && now < end : now >= start || now < end
}

export function nextDaybreak(d = new Date()) {
  const [h, m] = allSettings().nightfall_end.split(':').map(Number)
  const t = new Date(d)
  t.setHours(h, m, 0, 0)
  if (t <= d) t.setDate(t.getDate() + 1)
  return t
}

// ---------------------------------------------------------------------------
// Map. Hex disc in axial coordinates, radius 8 = 217 tiles. Players spawn in a
// ring near the border; capital + its 6 neighbors are permanently warded.
// Relic sites concentrate toward the center to pull everyone inward.

// The map scales with the player count: the spawn ring (radius - 1) must hold
// every capital at least 4 tiles apart so ward clusters never touch and each
// empire has room to expand. 6 players → radius 8 (217 tiles); 20 → radius 15.
const mapRadiusFor = (n) => Math.max(8, Math.ceil((2 * n) / 3) + 1)
const mapRadius = () => Number(getSetting('map_radius'))
const DIRS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]]

const hexDist = (q1, r1, q2, r2) =>
  (Math.abs(q1 - q2) + Math.abs(r1 - r2) + Math.abs(q1 + r1 - q2 - r2)) / 2

// Pixel-space angle of a hex, for spacing spawns evenly around the ring.
const hexAngle = (q, r) => Math.atan2(1.5 * r, Math.sqrt(3) * (q + r / 2))

function rollTerrain(dist, radius) {
  const relicZone = Math.max(3, Math.round(radius * 0.4))
  const roll = Math.random()
  if (dist <= relicZone && roll < (dist <= relicZone / 2 ? 0.3 : 0.15)) return 'relic'
  if (roll < 0.45) return dist <= radius / 2 ? 'ore' : 'food'
  return 'plains'
}

// Never steals owned tiles: a late joiner squeezed between existing wards
// just gets a smaller ward footprint.
function claimCapital(playerId, q, r) {
  db.prepare("UPDATE tiles SET owner_id = ?, capital = 1, warded = 1, terrain = 'plains' WHERE q = ? AND r = ? AND owner_id IS NULL")
    .run(playerId, q, r)
  for (const [dq, dr] of DIRS) {
    db.prepare("UPDATE tiles SET owner_id = ?, warded = 1, terrain = 'plains' WHERE q = ? AND r = ? AND owner_id IS NULL")
      .run(playerId, q + dq, r + dr)
  }
}

export const generateMap = db.transaction(() => {
  const ps = listPlayers()
  const radius = mapRadiusFor(ps.length)
  setSetting('map_radius', radius)
  db.prepare('DELETE FROM tiles').run()
  const insert = db.prepare('INSERT INTO tiles (q, r, terrain) VALUES (?, ?, ?)')
  for (let q = -radius; q <= radius; q++) {
    for (let r = Math.max(-radius, -q - radius); r <= Math.min(radius, -q + radius); r++) {
      insert.run(q, r, rollTerrain(hexDist(q, r, 0, 0), radius))
    }
  }
  const ring = db.prepare('SELECT q, r FROM tiles').all()
    .filter((t) => hexDist(t.q, t.r, 0, 0) === radius - 1)
    .sort((a, b) => hexAngle(a.q, a.r) - hexAngle(b.q, b.r))
  ps.forEach((p, i) => {
    const spot = ring[Math.round((i * ring.length) / ps.length) % ring.length]
    claimCapital(p.id, spot.q, spot.r)
  })
})

// Late joiner after launch: spawn on the border stretch farthest from every
// existing capital. Stays in the border band even when it's crowded — the
// center must never become someone's ward.
export function assignSpawn(playerId) {
  const capitals = db.prepare('SELECT q, r FROM tiles WHERE capital = 1').all()
  const unowned = db.prepare('SELECT q, r FROM tiles WHERE owner_id IS NULL').all()
  const radius = mapRadius()
  const band = (min) => unowned.filter((t) => hexDist(t.q, t.r, 0, 0) >= min)
  const bandPool = band(radius - 2).length ? band(radius - 2)
    : band(Math.floor(radius / 2)).length ? band(Math.floor(radius / 2))
    : unowned
  if (!bandPool.length) return false
  // A spawn needs room for a real lifeboat: prefer spots where most of the
  // ward footprint is free (edge/corner tiles lose neighbors to the void).
  const unownedSet = new Set(unowned.map((t) => `${t.q},${t.r}`))
  const freeNeighbors = (t) => DIRS.filter(([dq, dr]) => unownedSet.has(`${t.q + dq},${t.r + dr}`)).length
  const maxFree = Math.max(...bandPool.map(freeNeighbors))
  const pool = bandPool.filter((t) => freeNeighbors(t) === maxFree)
  const minCapDist = (t) => Math.min(...capitals.map((c) => hexDist(t.q, t.r, c.q, c.r)), Infinity)
  const best = pool.reduce((a, b) => (minCapDist(b) > minCapDist(a) ? b : a))
  claimCapital(playerId, best.q, best.r)
  return true
}

export function mapTiles() {
  return db.prepare('SELECT q, r, terrain, owner_id AS owner, capital, warded FROM tiles').all()
}

// Public score (the leaderboard everyone sees — relics stay hidden until the
// finale): 1 point per owned non-warded tile, +1 if it's in the center zone.
// Wards score nothing: the lifeboat can't win the game.
export function scoreBreakdown(playerId) {
  const center = Math.max(3, Math.round(mapRadius() * 0.4))
  const territory = db.prepare('SELECT q,r FROM tiles WHERE owner_id = ? AND warded = 0').all(playerId)
    .reduce((sum,t) => sum + 1 + (hexDist(t.q,t.r,0,0) <= center ? 1 : 0),0)
  const p = db.prepare('SELECT ore,food FROM players WHERE id=?').get(playerId)
  // Escrow still belongs to the player until the order resolves. Queueing or
  // cancelling must not move the leaderboard or reveal a secret muster.
  const escrow = db.prepare("SELECT COALESCE(SUM(CASE WHEN type='muster' THEN amount ELSE 0 END),0) ore, COALESCE(SUM(type IN ('attack','spy','heist')),0) food FROM orders WHERE player_id=? AND status='queued'").get(playerId)
  p.ore += escrow.ore
  p.food += escrow.food
  const strength = db.prepare('SELECT COALESCE(SUM(strength),0) s FROM tiles WHERE owner_id=?').get(playerId).s
  const resources = Math.floor((p.ore * 5 + p.food) / 25)
  const economy = Math.floor((p.ore * 5 + p.food + strength * 5) / 25)
  return { territory, resources, army: economy - resources, public: territory + economy }
}

export function scores() {
  return Object.fromEntries(listPlayers().map(p => [p.id, scoreBreakdown(p.id).public]))
}

// Stamp of the most recent Daybreak, so the daily allotment resets exactly
// once per game day (robust across restarts and downtime).
function currentDaybreakStamp(d = new Date()) {
  const [h, m] = allSettings().nightfall_end.split(':').map(Number)
  const t = new Date(d)
  t.setHours(h, m, 0, 0)
  if (t > d) t.setDate(t.getDate() - 1)
  return t.toISOString()
}

// Playtest fuel: auto-create bot empires at launch (admin "bot_count" setting).
const BOT_NAMES = ['Crimson', 'Noodle', 'Obsidian', 'Verdant', 'Golden', 'Frost', 'Ember', 'Coral',
  'Umbral', 'Zephyr', 'Iron', 'Dawn', 'Storm', 'Thorn', 'Raven', 'Lotus', 'Onyx', 'Solar', 'Ashen', 'Briar']

function spawnBots(count) {
  const usedAbbrs = new Set(listPlayers().map((p) => p.abbr))
  const usedNames = new Set(listPlayers().map((p) => p.empire))
  let made = 0
  for (let i = 0; made < count && i < BOT_NAMES.length * 3; i++) {
    const base = BOT_NAMES[i % BOT_NAMES.length]
    const suffix = i >= BOT_NAMES.length ? ` ${Math.floor(i / BOT_NAMES.length) + 1}` : ''
    const empire = `${base} Empire${suffix}`
    let abbr = (base.slice(0, 3) + (suffix.trim() || '')).toUpperCase().slice(0, 4)
    if (usedNames.has(empire) || usedAbbrs.has(abbr)) continue
    const p = createPlayer({ name: `${base} (bot)`, empire, abbr })
    db.prepare('UPDATE players SET is_bot = 1 WHERE id = ?').run(p.id)
    usedAbbrs.add(abbr)
    usedNames.add(empire)
    made++
  }
  return made
}

function launchGameImpl(endAt) {
  const intervalMs = Number(getSetting('tick_interval_min')) * 60_000
  const bots = Number(getSetting('bot_count'))
  if (bots > 0) spawnBots(bots)
  generateMap()
  db.prepare('UPDATE players SET orders_left = ?, ore = ?, food = ?')
    .run(Number(getSetting('orders_per_day')), STARTING_ORE, STARTING_FOOD)
  setSetting('last_reset', currentDaybreakStamp())
  setSetting('phase', 'running')
  setSetting('end_at', endAt.toISOString())
  setSetting('launched_at', new Date().toISOString())
  setSetting('next_tick_at', new Date(Date.now() + intervalMs).toISOString())
  dealQuests()
  return addEvent('phase', '🚀 The game has begun — the empires are revealed. Make your moves.')
}

function endGameImpl() {
  if (getSetting('phase') === 'finale') return null
  // Refund paid resources for orders that will never resolve; do not alter the final turn.
  for (const o of db.prepare("SELECT * FROM orders WHERE status='queued'").all()) {
    if (o.type === 'muster') db.prepare('UPDATE players SET ore=ore+? WHERE id=?').run(o.amount ?? 1,o.player_id)
    if (['attack','spy','heist'].includes(o.type)) db.prepare('UPDATE players SET food=food+1 WHERE id=?').run(o.player_id)
  }
  db.prepare("UPDATE orders SET status='expired' WHERE status='queued'").run()
  setSetting('phase', 'finale')
  setSetting('paused_at', '')
  setSetting('finale_data', JSON.stringify(finalStandings()))
  return addEvent('phase', '🏁 The game has ended. The realm is locked — awaiting the Final Tally…')
}

// The Final Tally: frozen when the game ends. The
// dashboard plays it back on a shared clock (start timestamp), last place to
// champion, so every screen shows the same moment and refreshes rejoin live.
function finalStandings() {
  const relicSums = {}
  for (const r of db.prepare('SELECT player_id, SUM(value) s FROM relics GROUP BY player_id').all()) relicSums[r.player_id] = r.s
  const data = listPlayers().map((p) => {
    const { territory, resources, army } = scoreBreakdown(p.id)
    const relics = relicSums[p.id] ?? 0
    return { id: p.id, empire: p.empire, abbr: p.abbr, color: p.color, name: p.name, territory, resources, army, relics, total: territory + resources + army + relics }
  }).sort((a, b) => a.total - b.total || a.territory - b.territory || b.id - a.id)
  return data
}

function startFinaleImpl() {
  if (getSetting('phase') !== 'finale') return { error: 'The game has not ended yet.' }
  if (!getSetting('finale_data')) setSetting('finale_data', JSON.stringify(finalStandings()))
  setSetting('finale_started_at', new Date().toISOString())
  return { ok: true, event: addEvent('phase', '🏆 THE FINAL TALLY BEGINS — all eyes on the screen.') }
}

// Back to a fresh lobby: wipes players and events, keeps cadence settings
// (tick interval, orders/day, nightfall) as they carry over fine between games.
function resetGameImpl() {
  db.prepare('DELETE FROM players').run()
  db.prepare('DELETE FROM events').run()
  db.prepare('DELETE FROM tiles').run()
  db.prepare('DELETE FROM news').run()
  db.prepare('DELETE FROM orders').run()
  db.prepare('DELETE FROM quests').run()
  db.prepare('DELETE FROM relics').run()
  db.prepare('DELETE FROM messages').run()
  db.prepare('DELETE FROM pacts').run()
  db.prepare('DELETE FROM spy_intel').run()
  setSetting('paused_at', '')
  setSetting('scheduler_error', '')
  setSetting('phase', 'lobby')
  setSetting('tick_count', 0)
  setSetting('end_at', '')
  setSetting('next_tick_at', '')
  setSetting('launched_at', '')
  setSetting('finale_data', '')
  setSetting('finale_started_at', '')
  return addEvent('phase', '🌍 A new world awaits. Scan the QR code to join.')
}

// ---------------------------------------------------------------------------
// Orders. Queued any time, secret until they resolve simultaneously on the
// turn. Expand is free (an order slot); muster costs 1 ore, paid on queue and
// refunded on cancel. Production is automatic: +1 per owned resource tile per
// turn (warded tiles produce nothing).

const tileAt = (q, r) => db.prepare('SELECT * FROM tiles WHERE q = ? AND r = ?').get(q, r)

const isAdjacentToPlayer = (q, r, playerId) =>
  DIRS.some(([dq, dr]) => db.prepare('SELECT 1 FROM tiles WHERE q = ? AND r = ? AND owner_id = ?').get(q + dq, r + dr, playerId))

// Fog of war: you see your own garrisons everywhere; enemy garrisons only on
// unwarded tiles adjacent to your territory (border intel). Nobody ever sees
// into a ward but its owner. Everything deeper is fog — that's what spies
// will be for.
function visibleGarrisons(playerId) {
  const mine = db.prepare('SELECT q, r, strength FROM tiles WHERE owner_id = ?').all(playerId)
  const mineSet = new Set(mine.map((t) => `${t.q},${t.r}`))
  const out = mine.map((t) => ({ q: t.q, r: t.r, strength: t.strength, own: true }))
  const seen = new Set(mineSet)
  for (const t of db.prepare('SELECT q, r, strength FROM tiles WHERE owner_id IS NOT NULL AND owner_id != ? AND warded = 0').all(playerId)) {
    if (DIRS.some(([dq, dr]) => mineSet.has(`${t.q + dq},${t.r + dr}`))) {
      out.push({ q: t.q, r: t.r, strength: t.strength, own: false })
      seen.add(`${t.q},${t.r}`)
    }
  }
  // Fresh spy intel paints purple badges for one turn.
  const tick = Number(getSetting('tick_count'))
  for (const t of db.prepare('SELECT q, r, strength FROM spy_intel WHERE player_id = ? AND tick = ?').all(playerId, tick)) {
    if (!seen.has(`${t.q},${t.r}`)) out.push({ q: t.q, r: t.r, strength: t.strength, own: false, spy: true })
  }
  return out
}

export function personalState(playerId) {
  const p = db.prepare('SELECT id, empire, abbr, color, ore, food, orders_left FROM players WHERE id = ?').get(playerId)
  if (!p) return null
  p.orders = db.prepare("SELECT id, type, q, r, support_for, src_q, src_r, amount, target_player FROM orders WHERE player_id = ? AND status = 'queued' ORDER BY id").all(playerId)
  p.score = scoreBreakdown(playerId).public
  p.garrisons = visibleGarrisons(playerId)
  p.news = db.prepare('SELECT id, tick, message, q, r FROM news WHERE player_id = ? ORDER BY id DESC LIMIT 12').all(playerId)
  const qst = db.prepare("SELECT * FROM quests WHERE player_id = ? AND status = 'active'").get(playerId)
  p.quest = qst ? { desc: questDescription(qst), progress: qst.progress, goal: JSON.parse(qst.params).n ?? 1 } : null
  p.ready = db.prepare('SELECT ready FROM players WHERE id = ?').get(playerId)?.ready ?? 0
  p.unread = {}
  for (const row of db.prepare('SELECT from_id, COUNT(*) c FROM messages WHERE to_id = ? AND read = 0 GROUP BY from_id').all(playerId)) {
    p.unread[row.from_id] = row.c
  }
  p.pacts = db.prepare("SELECT id, a_id, b_id, proposed_by, status, duration, expires_tick FROM pacts WHERE (a_id = ? OR b_id = ?) AND status IN ('proposed', 'active')")
    .all(playerId, playerId)
    .map((x) => ({ id: x.id, with: x.a_id === playerId ? x.b_id : x.a_id, status: x.status, proposedBy: x.proposed_by, duration: x.duration, expiresTick: x.expires_tick }))
  const oathUntil = db.prepare('SELECT oathbreaker_until FROM players WHERE id = ?').get(playerId)?.oathbreaker_until ?? 0
  p.oathbreakerTurns = Math.max(0, oathUntil - Number(getSetting('tick_count')))
  p.relicCount = db.prepare('SELECT COUNT(*) c FROM relics WHERE player_id = ?').get(playerId).c
  return p
}

// Total garrison strength a player has on tiles adjacent to (q, r).
function adjacentStrength(playerId, q, r) {
  return DIRS.reduce((sum, [dq, dr]) => {
    const t = db.prepare('SELECT strength FROM tiles WHERE q = ? AND r = ? AND owner_id = ?').get(q + dq, r + dr, playerId)
    return sum + (t?.strength ?? 0)
  }, 0)
}

function gameOpen() {
  const s = allSettings()
  return s.phase === 'running' && !s.paused_at && (!s.end_at || Date.now() < Date.parse(s.end_at))
}

function queueOrderImpl(playerId, type, q, r, opts = {}) {
  const supportFor = opts.supportFor ?? null
  if (!gameOpen()) return { error: 'Orders are closed: the game is paused, ended, or not launched.' }
  const p = db.prepare('SELECT * FROM players WHERE id = ?').get(playerId)
  if (!p) return { error: 'Unknown player.' }
  if (p.orders_left < 1) return { error: 'No orders left today — more at Daybreak.' }
  // Heists target an EMPIRE, not a tile — handled before tile validation.
  if (type === 'heist') {
    const target = Number(opts.targetPlayer)
    if (!Number.isFinite(target) || target === playerId) return { error: 'Pick another empire to rob.' }
    const victim = db.prepare('SELECT id FROM players WHERE id = ?').get(target)
    if (!victim) return { error: 'Unknown empire.' }
    if (p.food < 1) return { error: 'Not enough food — a heist costs 1 🌾.' }
    if (db.prepare("SELECT 1 FROM orders WHERE player_id = ? AND type = 'heist' AND status = 'queued'").get(playerId)) {
      return { error: 'Your thieves are already committed for tonight.' }
    }
    const mine = db.prepare('SELECT q, r FROM tiles WHERE owner_id = ?').all(playerId)
    const reachable = db.prepare('SELECT q, r FROM tiles WHERE owner_id = ? AND warded = 0').all(target)
      .some((t) => mine.some((m) => hexDist(m.q, m.r, t.q, t.r) <= 2))
    if (!reachable) return { error: 'Too far — thieves need one of their unwarded tiles within 2 of your territory.' }
    db.prepare('INSERT INTO orders (player_id, type, target_player) VALUES (?, ?, ?)').run(playerId, type, target)
    db.prepare('UPDATE players SET orders_left = orders_left - 1, food = food - 1 WHERE id = ?').run(playerId)
    return { ok: true, me: personalState(playerId) }
  }
  const tile = tileAt(q, r)
  if (!tile) return { error: 'No such tile.' }
  if (type === 'move') {
    const amount = Math.floor(Number(opts.amount))
    if (!Number.isFinite(amount) || amount < 1) return { error: 'Move at least 1 strength.' }
    const src = tileAt(Number(opts.srcQ), Number(opts.srcR))
    if (!src || src.owner_id !== playerId) return { error: 'You can only move troops from your own tile.' }
    if (tile.owner_id !== playerId) return { error: 'You can only move troops onto your own tile — that march is called an attack.' }
    const dist = hexDist(src.q, src.r, q, r)
    if (dist < 1 || dist > 2) return { error: 'Troops can move up to 2 tiles through your own territory.' }
    if (dist === 2) {
      const friendlyPath = DIRS.some(([dq, dr]) => {
        const mid = tileAt(src.q + dq, src.r + dr)
        return mid && mid.owner_id === playerId && hexDist(mid.q, mid.r, q, r) === 1
      })
      if (!friendlyPath) return { error: 'No friendly path — 2-tile moves must pass through your own territory.' }
    }
    const queuedOut = db.prepare("SELECT COALESCE(SUM(amount), 0) s FROM orders WHERE player_id = ? AND type IN ('move', 'attack') AND src_q = ? AND src_r = ? AND status = 'queued'")
      .get(playerId, src.q, src.r).s
    if (src.strength - queuedOut < amount) {
      return { error: `Only ${src.strength - queuedOut} available there${queuedOut ? ` (${queuedOut} already ordered to march)` : ''}.` }
    }
    db.prepare('INSERT INTO orders (player_id, type, q, r, src_q, src_r, amount) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(playerId, type, q, r, src.q, src.r, amount)
    db.prepare('UPDATE players SET orders_left = orders_left - 1 WHERE id = ?').run(playerId)
    return { ok: true, me: personalState(playerId) }
  }
  if (type === 'attack') {
    // Source + amount model: you choose which tile marches and how many.
    // Only strength that exists NOW can be committed — fresh musters defend
    // the turn they're raised but march no earlier than next turn.
    const src = tileAt(Number(opts.srcQ), Number(opts.srcR))
    const amount = Math.floor(Number(opts.amount))
    if (!src || src.owner_id !== playerId) return { error: 'Attacks launch from your own tile.' }
    if (tile.owner_id === playerId) return { error: 'That land is already yours.' }
    if (tile.warded) return { error: 'The ward cannot be attacked — ever.' }
    if (hexDist(src.q, src.r, q, r) !== 1) return { error: 'The target must be adjacent to the launching tile.' }
    if (!Number.isFinite(amount) || amount < 1) return { error: 'Commit at least 1 strength.' }
    if (p.food < 1) return { error: 'Not enough food — a march costs 1 🌾.' }
    const reserved = db.prepare("SELECT COALESCE(SUM(amount), 0) s FROM orders WHERE player_id = ? AND type IN ('attack', 'move') AND src_q = ? AND src_r = ? AND status = 'queued'")
      .get(playerId, src.q, src.r).s
    if (src.strength - reserved < amount) {
      return { error: `Only ${Math.max(0, src.strength - reserved)} uncommitted strength there${reserved ? ` (${reserved} already tasked)` : ''}.` }
    }
    if (supportFor != null) {
      if (Number(supportFor) === playerId) return { error: 'You cannot support yourself.' }
      if (!db.prepare('SELECT 1 FROM players WHERE id = ?').get(supportFor)) return { error: 'Unknown empire to support.' }
    }
    db.prepare('INSERT INTO orders (player_id, type, q, r, src_q, src_r, amount, support_for) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(playerId, type, q, r, src.q, src.r, amount, supportFor)
    db.prepare('UPDATE players SET orders_left = orders_left - 1, food = food - 1 WHERE id = ?').run(playerId)
    return { ok: true, me: personalState(playerId) }
  }
  if (type === 'expand') {
    if (tile.owner_id === playerId) return { error: 'You already own that tile.' }
    if (tile.owner_id) return { error: 'That land is claimed — conquest arrives in a later build.' }
    if (!isAdjacentToPlayer(q, r, playerId)) {
      const planned = db.prepare("SELECT q,r FROM orders WHERE player_id=? AND type='expand' AND status='queued'").all(playerId)
      if (!planned.some(t => hexDist(q,r,t.q,t.r) === 1)) return { error: 'Plan expansion next to your land or an existing expansion plan.' }
    }
    if (db.prepare("SELECT 1 FROM orders WHERE player_id = ? AND type = 'expand' AND q = ? AND r = ? AND status = 'queued'").get(playerId, q, r)) {
      return { error: 'Already queued for that tile.' }
    }
  } else if (type === 'muster') {
    const amount = Math.floor(Number(opts.amount ?? 1))
    if (!Number.isFinite(amount) || amount < 1) return { error: 'Muster at least 1 strength.' }
    if (tile.owner_id !== playerId) return { error: 'You can only muster on your own tiles.' }
    if (p.ore < amount) return { error: `Not enough ore — mustering ${amount} costs ${amount} ⛏️.` }
    db.prepare('INSERT INTO orders (player_id, type, q, r, amount) VALUES (?, ?, ?, ?, ?)').run(playerId, type, q, r, amount)
    db.prepare('UPDATE players SET orders_left = orders_left - 1, ore = ore - ? WHERE id = ?').run(amount, playerId)
    return { ok: true, me: personalState(playerId) }
  } else if (type === 'raid') {
    const src = tileAt(Number(opts.srcQ), Number(opts.srcR))
    if (!src || src.owner_id !== playerId) return { error: 'Raids launch from your own tile.' }
    if (src.strength < 1) return { error: 'You need troops on the launching tile.' }
    if (!tile.owner_id || tile.owner_id === playerId) return { error: 'Raid enemy land.' }
    if (tile.warded) return { error: 'The ward cannot be raided.' }
    if (hexDist(src.q, src.r, q, r) !== 1) return { error: 'The target must be adjacent to your launching tile.' }
    if (tile.strength < 1) return { error: 'No supply line there — raids target garrisoned tiles.' }
    if (db.prepare("SELECT 1 FROM orders WHERE player_id = ? AND type = 'raid' AND q = ? AND r = ? AND status = 'queued'").get(playerId, q, r)) {
      return { error: 'Raiders are already tasked with that tile.' }
    }
    db.prepare('INSERT INTO orders (player_id, type, q, r, src_q, src_r) VALUES (?, ?, ?, ?, ?, ?)').run(playerId, type, q, r, src.q, src.r)
    db.prepare('UPDATE players SET orders_left = orders_left - 1 WHERE id = ?').run(playerId)
    return { ok: true, me: personalState(playerId) }
  } else if (type === 'spy') {
    if (!tile.owner_id || tile.owner_id === playerId) return { error: 'Spies scout enemy land.' }
    if (tile.warded) return { error: 'No spy can pierce a ward.' }
    if (p.food < 1) return { error: 'Not enough food — a spy costs 1 🌾.' }
    const inRange = db.prepare('SELECT q, r FROM tiles WHERE owner_id = ?').all(playerId)
      .some((t) => hexDist(t.q, t.r, q, r) <= 3)
    if (!inRange) return { error: 'Too far — spies operate within 3 tiles of your territory.' }
    if (db.prepare("SELECT 1 FROM orders WHERE player_id = ? AND type = 'spy' AND q = ? AND r = ? AND status = 'queued'").get(playerId, q, r)) {
      return { error: 'A spy is already en route there.' }
    }
    db.prepare('INSERT INTO orders (player_id, type, q, r) VALUES (?, ?, ?, ?)').run(playerId, type, q, r)
    db.prepare('UPDATE players SET orders_left = orders_left - 1, food = food - 1 WHERE id = ?').run(playerId)
    return { ok: true, me: personalState(playerId) }
  } else {
    return { error: 'Unknown order type.' }
  }
  db.prepare('INSERT INTO orders (player_id, type, q, r) VALUES (?, ?, ?, ?)').run(playerId, type, q, r)
  db.prepare('UPDATE players SET orders_left = orders_left - 1 WHERE id = ?').run(playerId)
  return { ok: true, me: personalState(playerId) }
}

function cancelOrderImpl(playerId, orderId) {
  if (!gameOpen()) return { error: 'Orders cannot be cancelled while the game is closed.' }
  const o = db.prepare("SELECT * FROM orders WHERE id = ? AND player_id = ? AND status = 'queued'").get(orderId, playerId)
  if (!o) return { error: 'That order is gone (already resolved or cancelled).' }
  db.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(o.id)
  const refund = o.type === 'muster' ? `, ore = ore + ${Number(o.amount ?? 1)}`
    : ['attack', 'spy', 'heist'].includes(o.type) ? ', food = food + 1' : ''
  db.prepare(`UPDATE players SET orders_left = orders_left + ${o.budget_day === getSetting('last_reset') ? 1 : 0}${refund} WHERE id = ?`).run(playerId)
  return { ok: true, me: personalState(playerId) }
}

// A fixed budget resets at Daybreak; queued plans survive the reset.
function maybeDailyReset(events) {
  const stamp = currentDaybreakStamp()
  if (getSetting('last_reset') === stamp) return false
  setSetting('last_reset', stamp)
  db.prepare('UPDATE players SET orders_left = ?').run(Number(getSetting('orders_per_day')))
  events.push(addEvent('daybreak', '🌅 Daybreak — unspent orders expire. A new day begins.'))
  return true
}

// Bot empires (admin-toggled, for testing and filling out a sparse game):
// each turn they queue a few sensible orders — expand toward the center with
// a taste for resource tiles, muster at the frontier, attack neighbors that
// look weak. They use the same queueOrder path as humans, so all rules hold.
function botPlay(events = []) {
  const center = (t) => hexDist(t.q, t.r, 0, 0)
  for (const bot of db.prepare('SELECT id FROM players WHERE is_bot = 1').all()) {
    // Bots are agreeable diplomats: they accept any pact proposed to them.
    for (const pt of db.prepare("SELECT id FROM pacts WHERE status = 'proposed' AND proposed_by != ? AND (a_id = ? OR b_id = ?)").all(bot.id, bot.id, bot.id)) {
      const r = respondPact(bot.id, pt.id, true)
      if (r.event) events.push(r.event)
    }
    for (let i = 0; i < 3; i++) {
      const p = db.prepare('SELECT orders_left, ore, food FROM players WHERE id = ?').get(bot.id)
      if (!p || p.orders_left < 1) break
      const mine = db.prepare('SELECT q, r, strength, warded FROM tiles WHERE owner_id = ?').all(bot.id)
      const mineSet = new Set(mine.map((t) => `${t.q},${t.r}`))
      const seen = new Set()
      const expandable = []
      const enemies = []
      for (const t of mine) {
        for (const [dq, dr] of DIRS) {
          const key = `${t.q + dq},${t.r + dr}`
          if (mineSet.has(key) || seen.has(key)) continue
          seen.add(key)
          const n2 = tileAt(t.q + dq, t.r + dr)
          if (!n2) continue
          if (!n2.owner_id) expandable.push(n2)
          else if (!n2.warded) enemies.push(n2)
        }
      }
      const roll = Math.random()
      let done = null
      if (roll < 0.6 && expandable.length) {
        expandable.sort((a, b) => (b.terrain !== 'plains') - (a.terrain !== 'plains') || center(a) - center(b))
        const pick = expandable[Math.floor(Math.random() * Math.min(3, expandable.length))]
        done = queueOrder(bot.id, 'expand', pick.q, pick.r)
      } else if (roll < 0.85 && p.ore > 0 && mine.length) {
        const frontier = mine.filter((t) => !t.warded &&
          DIRS.some(([dq, dr]) => { const n2 = tileAt(t.q + dq, t.r + dr); return n2 && n2.owner_id !== bot.id }))
        const pick = (frontier.length ? frontier : mine)[Math.floor(Math.random() * (frontier.length ? frontier.length : mine.length))]
        done = queueOrder(bot.id, 'muster', pick.q, pick.r)
      } else if (p.food > 0 && enemies.length) {
        const candidates = []
        for (const t of enemies) {
          let bestSrc = null
          for (const [dq, dr] of DIRS) {
            const s = tileAt(t.q + dq, t.r + dr)
            if (s && s.owner_id === bot.id && s.strength > (bestSrc?.strength ?? 0)) bestSrc = s
          }
          if (bestSrc && bestSrc.strength > t.strength) candidates.push({ t, src: bestSrc })
        }
        if (candidates.length) {
          const c = candidates[Math.floor(Math.random() * candidates.length)]
          done = queueOrder(bot.id, 'attack', c.t.q, c.t.r, { srcQ: c.src.q, srcR: c.src.r, amount: c.src.strength })
        }
      }
      if (!done?.ok) break
    }
  }
}

// ---------------------------------------------------------------------------
// Quests & relics: the hidden score layer. Completing a quest banks a relic
// with a SECRET point value — revealed only at the finale. Quest conditions
// are things you maneuver into, biased toward interaction.

const randInt = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1))
const ownedCount = (pid) => db.prepare('SELECT COUNT(*) c FROM tiles WHERE owner_id = ?').get(pid).c

const QUEST_DEFS = {
  hold_relic: {
    make: () => ({ n: 2 }),
    desc: (p) => `Hold a ✨ relic site for ${p.n} consecutive turns.`,
    value: [3, 6],
  },
  claim_tiles: {
    make: (pid) => ({ n: 4, base: ownedCount(pid) }),
    desc: (p) => `Grow your empire by ${p.n} tiles.`,
    value: [2, 4],
  },
  muster_total: {
    make: () => ({ n: 6 }),
    desc: (p) => `Field a total garrison strength of ${p.n} or more.`,
    value: [2, 4],
  },
  win_battle: {
    make: () => ({ n: 1 }),
    desc: () => 'Seize an enemy-held tile in battle.',
    value: [3, 6],
  },
  border_empire: {
    make: (pid) => {
      const others = listPlayers().filter((p) => p.id !== pid)
      if (!others.length) return null
      const t = others[Math.floor(Math.random() * others.length)]
      return { n: 2, target: t.id, targetName: `${t.empire} [${t.abbr}]` }
    },
    desc: (p) => `Hold a tile adjacent to ${p.targetName}'s land for ${p.n} consecutive turns.`,
    value: [3, 5],
  },
}

export function questDescription(qst) {
  const def = QUEST_DEFS[qst.type]
  return def ? def.desc(JSON.parse(qst.params)) : 'A mysterious task.'
}

function checkQuests(events, battleWinners) {
  for (const qst of db.prepare("SELECT * FROM quests WHERE status = 'active'").all()) {
    const p = JSON.parse(qst.params)
    let progress = qst.progress
    let done = false
    switch (qst.type) {
      case 'hold_relic': {
        const holds = db.prepare("SELECT 1 FROM tiles WHERE owner_id = ? AND terrain = 'relic' AND warded = 0 LIMIT 1").get(qst.player_id)
        progress = holds ? progress + 1 : 0
        done = progress >= p.n
        break
      }
      case 'claim_tiles': {
        progress = Math.max(0, ownedCount(qst.player_id) - p.base)
        done = progress >= p.n
        break
      }
      case 'muster_total': {
        progress = db.prepare('SELECT COALESCE(SUM(strength), 0) s FROM tiles WHERE owner_id = ?').get(qst.player_id).s
        done = progress >= p.n
        break
      }
      case 'win_battle': {
        if (battleWinners.has(qst.player_id)) { progress = 1; done = true }
        break
      }
      case 'border_empire': {
        const targetSet = new Set(db.prepare('SELECT q, r FROM tiles WHERE owner_id = ?').all(p.target).map((t) => `${t.q},${t.r}`))
        const mine = db.prepare('SELECT q, r FROM tiles WHERE owner_id = ?').all(qst.player_id)
        const adjacent = mine.some((t) => DIRS.some(([dq, dr]) => targetSet.has(`${t.q + dq},${t.r + dr}`)))
        progress = adjacent ? progress + 1 : 0
        done = progress >= p.n
        break
      }
    }
    if (done) {
      const [lo, hi] = QUEST_DEFS[qst.type].value
      db.prepare("UPDATE quests SET status = 'done', progress = ? WHERE id = ?").run(progress, qst.id)
      db.prepare('INSERT INTO relics (player_id, quest_id, value) VALUES (?, ?, ?)').run(qst.player_id, qst.id, randInt(lo, hi))
      addNews(qst.player_id, '📜 Quest complete! A relic rests in your vault — its worth stays secret until the finale.')
      events.push(addEvent('relic', '✨ Somewhere, a quest was completed… a relic has found a new keeper.'))
    } else if (progress !== qst.progress) {
      db.prepare('UPDATE quests SET progress = ? WHERE id = ?').run(progress, qst.id)
    }
  }
}

function dealQuests() {
  const day = getSetting('last_reset')
  const cap = Number(getSetting('quests_per_day'))
  const types = Object.keys(QUEST_DEFS)
  for (const player of listPlayers()) {
    if (db.prepare("SELECT 1 FROM quests WHERE player_id = ? AND status = 'active'").get(player.id)) continue
    const dealtToday = db.prepare('SELECT COUNT(*) c FROM quests WHERE player_id = ? AND assigned_day = ?').get(player.id, day).c
    if (dealtToday >= cap) continue
    let type = types[Math.floor(Math.random() * types.length)]
    let params = QUEST_DEFS[type].make(player.id)
    if (!params) { type = 'claim_tiles'; params = QUEST_DEFS.claim_tiles.make(player.id) }
    db.prepare('INSERT INTO quests (player_id, type, params, assigned_day) VALUES (?, ?, ?, ?)')
      .run(player.id, type, JSON.stringify(params), day)
    addNews(player.id, `📜 New quest: ${QUEST_DEFS[type].desc(params)}`)
  }
}

// ---------------------------------------------------------------------------
// Messaging & pacts. Messages are private empire-to-empire. Pacts are public
// and UNENFORCED: attacking a pact partner is legal, loud, and brands you
// OATHBREAKER — your attacks lose their good fortune for a while.

const OATHBREAKER_TURNS = 6

export function sendMessage(fromId, toId, body) {
  const phase = getSetting('phase')
  if (phase !== 'running' && phase !== 'finale') return { error: 'Messaging opens once the game launches.' }
  body = String(body ?? '').trim()
  if (!body) return { error: 'Say something.' }
  if (body.length > 500) return { error: 'Keep it under 500 characters.' }
  if (toId === fromId || !db.prepare('SELECT 1 FROM players WHERE id = ?').get(toId)) return { error: 'Unknown empire.' }
  const info = db.prepare('INSERT INTO messages (from_id, to_id, body) VALUES (?, ?, ?)').run(fromId, toId, body)
  return { ok: true, message: { id: Number(info.lastInsertRowid), from: fromId, to: toId, body, at: new Date().toISOString() } }
}

export function getThread(meId, otherId) {
  db.prepare('UPDATE messages SET read = 1 WHERE to_id = ? AND from_id = ?').run(meId, otherId)
  return db.prepare(`SELECT id, from_id AS "from", to_id AS "to", body, created_at AS at FROM messages
    WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?) ORDER BY id DESC LIMIT 40`)
    .all(meId, otherId, otherId, meId).reverse()
}

const pactPair = (a, b) => [Math.min(a, b), Math.max(a, b)]

export function activePact(x, y) {
  const [a, b] = pactPair(x, y)
  return db.prepare("SELECT * FROM pacts WHERE a_id = ? AND b_id = ? AND status = 'active'").get(a, b) ?? null
}

function proposePactImpl(fromId, toId, turns) {
  if (!gameOpen()) return { error: 'Pacts can only be sworn while the game runs.' }
  if (toId === fromId || !db.prepare('SELECT 1 FROM players WHERE id = ?').get(toId)) return { error: 'Unknown empire.' }
  turns = Math.floor(Number(turns))
  if (!Number.isFinite(turns) || turns < 1 || turns > 999) return { error: 'Pacts need a duration: 1–999 turns.' }
  const [a, b] = pactPair(fromId, toId)
  if (db.prepare("SELECT 1 FROM pacts WHERE a_id = ? AND b_id = ? AND status IN ('proposed', 'active')").get(a, b)) {
    return { error: 'There is already a pact or proposal between you.' }
  }
  db.prepare('INSERT INTO pacts (a_id, b_id, proposed_by, duration) VALUES (?, ?, ?, ?)').run(a, b, fromId, turns)
  addNews(toId, `🤝 ${playerName(fromId)} proposes a ${turns}-turn pact of non-aggression. Respond in Diplomacy.`)
  return { ok: true }
}

function respondPactImpl(playerId, pactId, accept) {
  if (!gameOpen()) return { error: 'The game is closed.' }
  const pact = db.prepare("SELECT * FROM pacts WHERE id = ? AND status = 'proposed'").get(pactId)
  if (!pact || pact.proposed_by === playerId || (pact.a_id !== playerId && pact.b_id !== playerId)) {
    return { error: 'No such proposal awaiting you.' }
  }
  const other = pact.a_id === playerId ? pact.b_id : pact.a_id
  if (accept) {
    const expires = Number(getSetting('tick_count')) + Number(pact.duration ?? 10)
    db.prepare("UPDATE pacts SET status = 'active', expires_tick = ? WHERE id = ?").run(expires, pact.id)
    addNews(other, `🤝 ${playerName(playerId)} accepted your pact of non-aggression (through turn ${expires}).`)
    const ev = addEvent('pact', `🤝 ${playerName(playerId)} and ${playerName(other)} have sworn a ${pact.duration}-turn pact of non-aggression.`)
    return { ok: true, event: ev }
  }
  db.prepare("UPDATE pacts SET status = 'declined' WHERE id = ?").run(pact.id)
  addNews(other, `🕊️ ${playerName(playerId)} declined your pact proposal.`)
  return { ok: true }
}

function withdrawPactImpl(playerId, pactId) {
  if (!gameOpen()) return { error: 'The game is closed.' }
  const pact = db.prepare("SELECT * FROM pacts WHERE id = ? AND status = 'active'").get(pactId)
  if (!pact || (pact.a_id !== playerId && pact.b_id !== playerId)) return { error: 'No such active pact.' }
  const other = pact.a_id === playerId ? pact.b_id : pact.a_id
  db.prepare("UPDATE pacts SET status = 'withdrawn' WHERE id = ?").run(pact.id)
  addNews(other, `📜 ${playerName(playerId)} has withdrawn from your pact — honorably, and in the open.`)
  const ev = addEvent('pact', `📜 ${playerName(playerId)} has withdrawn from their pact with ${playerName(other)}.`)
  return { ok: true, event: ev }
}

// Attacking (or getting caught robbing) a pact partner breaks the pact.
function breakPact(breakerId, victimId, events) {
  const pact = activePact(breakerId, victimId)
  if (!pact) return
  db.prepare("UPDATE pacts SET status = 'broken' WHERE id = ?").run(pact.id)
  const until = Number(getSetting('tick_count')) + OATHBREAKER_TURNS
  db.prepare('UPDATE players SET oathbreaker_until = ? WHERE id = ?').run(until, breakerId)
  addNews(victimId, `⚡ ${playerName(breakerId)} has BROKEN your pact!`)
  addNews(breakerId, `⚡ You are branded OATHBREAKER — fortune abandons your attacks for ${OATHBREAKER_TURNS} turns.`)
  events.push(addEvent('pact', `⚡ OATHBREAKER! ${playerName(breakerId)} has broken their pact with ${playerName(victimId)}!`))
}

// The Market: instant resource exchange at a fixed symmetric rate — no
// arbitrage loop, no order slot, no waiting. Dire situations muster NOW.
export function exchange(playerId, dir, times) {
  if (!gameOpen()) return { error: 'The market is closed.' }
  times = Math.floor(Number(times))
  if (!Number.isFinite(times) || times < 1 || times > 100) return { error: 'Trade 1–100 batches at a time.' }
  const p = db.prepare('SELECT ore, food FROM players WHERE id = ?').get(playerId)
  if (!p) return { error: 'Unknown player.' }
  if (dir === 'food2ore') {
    if (p.food < 5 * times) return { error: `Not enough food — that trade needs ${5 * times} 🌾.` }
    db.prepare('UPDATE players SET food = food - ?, ore = ore + ? WHERE id = ?').run(5 * times, times, playerId)
  } else if (dir === 'ore2food') {
    if (p.ore < times) return { error: `Not enough ore — that trade needs ${times} ⛏️.` }
    db.prepare('UPDATE players SET ore = ore - ?, food = food + ? WHERE id = ?').run(times, 5 * times, playerId)
  } else {
    return { error: 'Unknown trade.' }
  }
  return { ok: true, me: personalState(playerId) }
}

// "End turn" consensus: when every human player is ready, the turn fires
// early (never during Nightfall). Ready flags clear on every resolution.
export function setReady(playerId, val) {
  if (!gameOpen()) return { error: 'The game is closed.' }
  db.prepare('UPDATE players SET ready = ? WHERE id = ?').run(val ? 1 : 0, playerId)
  return { ok: true, me: personalState(playerId) }
}

export function readyStatus() {
  const r = db.prepare('SELECT COUNT(*) AS humans, COALESCE(SUM(ready), 0) AS ready FROM players WHERE is_bot = 0').get()
  return { humans: r.humans, ready: r.ready }
}

export function abandonQuest(playerId) {
  if (!gameOpen()) return { error: 'The game is closed.' }
  const qst = db.prepare("SELECT * FROM quests WHERE player_id = ? AND status = 'active'").get(playerId)
  if (!qst) return { error: 'No active quest to abandon.' }
  db.prepare("UPDATE quests SET status = 'abandoned' WHERE id = ?").run(qst.id)
  return { ok: true, me: personalState(playerId) }
}

function resolveTurnImpl() {
  if (!gameOpen()) return []
  const n = Number(getSetting('tick_count')) + 1
  setSetting('tick_count', n)
  const events = []
  const wasDaybreak = maybeDailyReset(events)
  // Orders are a fixed daily budget; extra turns never create extra orders.

  // Pacts expire peacefully once their agreed term has run.
  for (const pact of db.prepare("SELECT * FROM pacts WHERE status = 'active' AND expires_tick IS NOT NULL AND ? > expires_tick").all(n)) {
    db.prepare("UPDATE pacts SET status = 'expired' WHERE id = ?").run(pact.id)
    addNews(pact.a_id, `📜 Your pact with ${playerName(pact.b_id)} has run its course.`)
    addNews(pact.b_id, `📜 Your pact with ${playerName(pact.a_id)} has run its course.`)
    events.push(addEvent('pact', `📜 The pact between ${playerName(pact.a_id)} and ${playerName(pact.b_id)} has run its course.`))
  }

  botPlay(events)

  // Capital stipend: every empire's ward provides +1 ore and +1 food per
  // turn, always — a besieged empire can slowly build its breakout army,
  // but nobody wins from inside a lifeboat.
  db.prepare('UPDATE players SET ore = ore + 1, food = food + 1').run()

  // Production: +1 per owned, unwarded resource tile.
  for (const row of db.prepare(`
    SELECT owner_id AS id, SUM(terrain = 'ore') AS ore, SUM(terrain = 'food') AS food
    FROM tiles WHERE owner_id IS NOT NULL AND warded = 0 GROUP BY owner_id`).all()) {
    db.prepare('UPDATE players SET ore = ore + ?, food = food + ? WHERE id = ?').run(row.ore, row.food, row.id)
  }

  const setStatus = db.prepare('UPDATE orders SET status = ?, tick = ? WHERE id = ?')
  const orders = db.prepare(`
    SELECT o.*, p.empire, p.abbr FROM orders o JOIN players p ON p.id = o.player_id
    WHERE o.status = 'queued' ORDER BY o.id`).all()

  // Expansion, resolved simultaneously: several empires reaching for the same
  // tile is a standoff — nobody takes it (Diplomacy's "bounce").
  const eligibleExpansionIds = new Set(orders.filter(o => o.type === 'expand' && isAdjacentToPlayer(o.q,o.r,o.player_id)).map(o => o.id))
  const byTile = new Map()
  for (const o of orders.filter((o) => o.type === 'expand' && (eligibleExpansionIds.has(o.id) || tileAt(o.q,o.r)?.owner_id))) {
    const key = `${o.q},${o.r}`
    if (!byTile.has(key)) byTile.set(key, [])
    byTile.get(key).push(o)
  }
  const gained = new Map()
  for (const group of byTile.values()) {
    const tile = tileAt(group[0].q, group[0].r)
    if (!tile || tile.owner_id) {
      group.forEach((o) => setStatus.run('failed', n, o.id))
      continue
    }
    const claimants = [...new Map(group.map((o) => [o.player_id, o])).values()]
    if (claimants.length > 1) {
      group.forEach((o) => setStatus.run('standoff', n, o.id))
      claimants.forEach((o) => addNews(o.player_id, '🏳️ Your expansion hit a standoff — the land stays free.', tile.q, tile.r))
      events.push(addEvent('standoff',
        `🏳️ Standoff! ${claimants.map((o) => `${o.empire} [${o.abbr}]`).join(' and ')} reached the same land — none would yield.`,
        { tiles: [{ q: tile.q, r: tile.r }] }))
    } else {
      db.prepare('UPDATE tiles SET owner_id = ? WHERE q = ? AND r = ?').run(group[0].player_id, tile.q, tile.r)
      group.forEach((o) => setStatus.run('done', n, o.id))
      const g = gained.get(group[0].player_id) ?? { empire: group[0].empire, abbr: group[0].abbr, count: 0, tiles: [] }
      g.count += 1
      g.tiles.push({ q: tile.q, r: tile.r })
      gained.set(group[0].player_id, g)
    }
  }
  for (const [pid, g] of gained) {
    events.push(addEvent('expand', `🌍 ${g.empire} [${g.abbr}] expands (+${g.count} tile${g.count === 1 ? '' : 's'}).`,
      { player: pid, tiles: g.tiles }))
  }

  // Musters are silent — garrisons are hidden information. They resolve
  // before attacks, so a same-turn muster both reinforces a defense and
  // joins a march (blind commitments: nobody saw it coming).
  for (const o of orders.filter((o) => o.type === 'muster')) {
    const tile = tileAt(o.q, o.r)
    const amount = Number(o.amount ?? 1)
    if (tile && tile.owner_id === o.player_id) {
      db.prepare('UPDATE tiles SET strength = strength + ? WHERE q = ? AND r = ?').run(amount, o.q, o.r)
      setStatus.run('done', n, o.id)
    } else {
      db.prepare('UPDATE players SET ore = ore + ? WHERE id = ?').run(amount, o.player_id)
      setStatus.run('failed', n, o.id)
    }
  }

  const battleWinners = new Set()
  resolveBattles(orders.filter((o) => o.type === 'attack'), n, setStatus, events, battleWinners)

  // Moves resolve AFTER battles: repositioning is never swept into a march,
  // you can backfill a border your army just vacated — or garrison a tile you
  // captured this very turn. Silent: troop movements are nobody's business.
  for (const o of orders.filter((o) => o.type === 'move')) {
    const src = tileAt(o.src_q, o.src_r)
    const dst = tileAt(o.q, o.r)
    if (src?.owner_id === o.player_id && dst?.owner_id === o.player_id && src.strength > 0) {
      const amt = Math.min(o.amount, src.strength)
      db.prepare('UPDATE tiles SET strength = strength - ? WHERE q = ? AND r = ?').run(amt, src.q, src.r)
      db.prepare('UPDATE tiles SET strength = strength + ? WHERE q = ? AND r = ?').run(amt, dst.q, dst.r)
      setStatus.run('done', n, o.id)
    } else {
      setStatus.run('failed', n, o.id)
    }
  }

  // Raids: skirmishes on supply lines. Resolve after battles (the garrison
  // may have marched away) and before moves. Overt — the victim knows who.
  for (const o of orders.filter((o) => o.type === 'raid')) {
    const src = tileAt(o.src_q, o.src_r)
    const tgt = tileAt(o.q, o.r)
    const victim = tgt?.owner_id
    if (!src || src.owner_id !== o.player_id || src.strength < 1 ||
        !victim || victim === o.player_id || tgt.warded || tgt.strength < 1) {
      setStatus.run('failed', n, o.id)
      addNews(o.player_id, '🏇 Your raiders found nothing — the supply line had moved on.', o.q, o.r)
      continue
    }
    breakPact(o.player_id, victim, events)
    if (Math.random() < 0.5) {
      const v = db.prepare('SELECT ore, food FROM players WHERE id = ?').get(victim)
      const res = v.ore >= v.food ? 'ore' : 'food'
      const amt = Math.min(2, v[res])
      const icon = res === 'ore' ? '⛏️' : '🌾'
      db.prepare(`UPDATE players SET ${res} = ${res} - ? WHERE id = ?`).run(amt, victim)
      db.prepare(`UPDATE players SET ${res} = ${res} + ? WHERE id = ?`).run(amt, o.player_id)
      setStatus.run('done', n, o.id)
      addNews(o.player_id, `🏇 Raid! You plundered ${amt} ${icon} from ${playerName(victim)}'s supply lines.`, o.q, o.r)
      addNews(victim, `🏇 ${playerName(o.player_id)} raided your supply lines — you lost ${amt} ${icon}.`, o.q, o.r)
    } else {
      db.prepare('UPDATE tiles SET strength = strength - 1 WHERE q = ? AND r = ?').run(src.q, src.r)
      setStatus.run('failed', n, o.id)
      addNews(o.player_id, `🏇 Your raid on ${playerName(victim)} was driven off — you lost 1 strength.`, o.q, o.r)
      addNews(victim, `🏇 You drove off raiders from ${playerName(o.player_id)}!`, o.q, o.r)
    }
  }

  resolveSpies(orders.filter((o) => o.type === 'spy'), n, setStatus)
  if (wasDaybreak) resolveHeists(orders.filter((o) => o.type === 'heist'), n, setStatus, events)

  checkQuests(events, battleWinners)
  dealQuests()

  db.prepare('UPDATE players SET ready = 0').run()
  events.push(addEvent('tick', `⏱️ Turn ${n} resolved.`))
  return events
}

// Spies scout after the dust settles: report the target tile and its
// neighborhood. 25% chance the spy is caught — the victim learns who sent it.
function resolveSpies(spyOrders, n, setStatus) {
  for (const o of spyOrders) {
    const tile = tileAt(o.q, o.r)
    if (!tile || !tile.owner_id || tile.owner_id === o.player_id || tile.warded) {
      db.prepare('UPDATE players SET food = food + 1 WHERE id = ?').run(o.player_id)
      setStatus.run('failed', n, o.id)
      continue
    }
    if (Math.random() < 0.25) {
      setStatus.run('failed', n, o.id)
      addNews(tile.owner_id, `🕵️ You caught a spy from ${playerName(o.player_id)} snooping near your land!`, o.q, o.r)
      addNews(o.player_id, `🕵️ Your spy was caught by ${playerName(tile.owner_id)} — no report came back.`, o.q, o.r)
      continue
    }
    let found = 0
    for (const [dq, dr] of [[0, 0], ...DIRS]) {
      const t = tileAt(o.q + dq, o.r + dr)
      if (t && t.owner_id && t.owner_id !== o.player_id && !t.warded) {
        db.prepare('INSERT INTO spy_intel (player_id, q, r, strength, tick) VALUES (?, ?, ?, ?, ?)')
          .run(o.player_id, t.q, t.r, t.strength, n)
        found++
      }
    }
    setStatus.run('done', n, o.id)
    addNews(o.player_id, found
      ? `🕵️ Spy report from (${o.q},${o.r}) — ${found} garrison${found === 1 ? '' : 's'} marked on your map (purple, this turn only).`
      : `🕵️ Spy report from (${o.q},${o.r}) — nothing of note in the area.`, o.q, o.r)
  }
}

// Heists resolve only at Daybreak — skulduggery is nocturnal. One thief per
// vault per night; two thieves collide and both fail. 30% chance of getting
// caught loudly.
function resolveHeists(heistOrders, n, setStatus, events) {
  const byVictim = new Map()
  for (const o of heistOrders) {
    if (!byVictim.has(o.target_player)) byVictim.set(o.target_player, [])
    byVictim.get(o.target_player).push(o)
  }
  for (const [victimId, group] of byVictim) {
    if (group.length > 1) {
      group.forEach((o) => {
        setStatus.run('failed', n, o.id)
        addNews(o.player_id, '🗝️ Your thieves collided with another crew in the night — everyone fled empty-handed.')
      })
      events.push(addEvent('heist', `🗝️ Thieves collided in the night at the gates of ${playerName(victimId)}…`))
      continue
    }
    const o = group[0]
    if (Math.random() < 0.3) {
      setStatus.run('failed', n, o.id)
      addNews(victimId, `🚨 You caught a thief from ${playerName(o.player_id)} in your vault!`)
      addNews(o.player_id, `🚨 Your thief was caught in ${playerName(victimId)}'s vault — the whole world knows.`)
      events.push(addEvent('heist', `🚨 A thief from ${playerName(o.player_id)} was caught in ${playerName(victimId)}'s vault!`))
      breakPact(o.player_id, victimId, events)
      continue
    }
    const relic = db.prepare('SELECT id FROM relics WHERE player_id = ? ORDER BY RANDOM() LIMIT 1').get(victimId)
    setStatus.run('done', n, o.id)
    if (!relic) {
      addNews(o.player_id, `🗝️ Your thieves cracked ${playerName(victimId)}'s vault… and found it empty.`)
      continue
    }
    db.prepare('UPDATE relics SET player_id = ? WHERE id = ?').run(o.player_id, relic.id)
    addNews(o.player_id, `🗝️ Success! Your thieves lifted a relic from ${playerName(victimId)}'s vault.`)
    addNews(victimId, '🗝️ A relic was stolen from your vault in the night. The thief left no trace.')
    events.push(addEvent('heist', '🗝️ A relic changed hands in the night…'))
  }
}

const TERRAIN_PRIZE = { plains: 'land', ore: 'the ore fields', food: 'the farmlands', relic: 'a relic site' }

// Attacking commits ALL your garrisons adjacent to the target — they march
// out (and can't defend home this turn). Each side rolls a 0.8×–1.2× luck
// multiplier; defender wins ties; winner takes the tile with raw-difference
// survivors. "In support of" merges your force into your partner's attack —
// if the partner never shows, you fight as your own attack.
function resolveBattles(attackOrders, n, setStatus, events, battleWinners = new Set()) {
  const refundFood = (o) => db.prepare('UPDATE players SET food = food + 1 WHERE id = ?').run(o.player_id)
  const luck = () => 0.8 + Math.random() * 0.4
  attackOrders.sort((a,b) => a.q-b.q || a.r-b.r || a.player_id-b.player_id || a.src_q-b.src_q || a.src_r-b.src_r)
  const committedById = new Map()
  for (const o of attackOrders) {
    const target = tileAt(o.q,o.r), src = tileAt(o.src_q,o.src_r)
    if (!target || target.warded || target.owner_id === o.player_id || src?.owner_id !== o.player_id) continue
    const amt = Math.min(o.amount ?? 0,src.strength)
    if (amt < 1) continue
    db.prepare('UPDATE tiles SET strength=strength-? WHERE q=? AND r=?').run(amt,src.q,src.r)
    committedById.set(o.id,amt)
    if (target.owner_id) breakPact(o.player_id,target.owner_id,events)
  }
  const defenders = new Map(db.prepare('SELECT * FROM tiles').all().map(t => [t.q+','+t.r,t]))
  const byTarget = new Map()
  for (const o of attackOrders) {
    const key = `${o.q},${o.r}`
    if (!byTarget.has(key)) byTarget.set(key, [])
    byTarget.get(key).push(o)
  }
  for (const group of byTarget.values()) {
    const tile = defenders.get(group[0].q+','+group[0].r)
    if (!tile || tile.warded) {
      group.forEach((o) => { setStatus.run('failed', n, o.id); refundFood(o) })
      continue
    }
    // defenderId may be null: an armed claim of neutral land. Expands resolve
    // first, so soldiers arriving this turn take the tile from bare settlers.
    const defenderId = tile.owner_id
    // Commit forces: each order drains its chosen amount from its source tile.
    const committed = []
    for (const o of group) {
      if (o.player_id === defenderId) { setStatus.run('failed', n, o.id); refundFood(o); continue }
      const amt = committedById.get(o.id) ?? 0
      if (amt < 1) { setStatus.run('failed', n, o.id); refundFood(o); continue }
      committed.push({ order: o, amt })
      if (defenderId) breakPact(o.player_id, defenderId, events)
    }
    if (!committed.length) continue
    // Coalitions: supporters merge into their leader's attack if the leader marched too.
    const coalitions = new Map()
    const supportAnnounced = new Set()
    for (const c of committed) {
      const sf = c.order.support_for
      const leader = sf != null && sf !== c.order.player_id && committed.some((x) => x.order.player_id === sf) ? sf : c.order.player_id
      if (!coalitions.has(leader)) coalitions.set(leader, { raw: 0, members: [] })
      const co = coalitions.get(leader)
      co.raw += c.amt
      co.members.push(c.order)
      if (leader !== c.order.player_id && !supportAnnounced.has(`${c.order.player_id}:${leader}`)) {
        supportAnnounced.add(`${c.order.player_id}:${leader}`)
        events.push(addEvent('support', `🤝 ${c.order.empire} [${c.order.abbr}] marched in support of ${playerName(leader)}.`,
          { tiles: [{ q: tile.q, r: tile.r }] }))
      }
    }
    const defRaw = defenderId ? tile.strength : 0
    const defEff = defRaw * luck()
    const turnNow = Number(getSetting('tick_count'))
    let best = null
    for (const [leader, co] of coalitions) {
      // Oathbreakers roll with fortune capped at 1.0× — the gods remember.
      const oath = (db.prepare('SELECT oathbreaker_until FROM players WHERE id = ?').get(leader)?.oathbreaker_until ?? 0) > turnNow
      co.eff = co.raw * (0.8 + Math.random() * (oath ? 0.2 : 0.4))
      if (!best || co.eff > coalitions.get(best).eff) best = leader
    }
    const bestCo = coalitions.get(best)
    const prize = TERRAIN_PRIZE[tile.terrain] ?? 'land'
    if (bestCo.eff > defEff) {
      const survivors = Math.max(1, bestCo.raw - defRaw)
      db.prepare('UPDATE tiles SET owner_id = ?, strength = ? WHERE q = ? AND r = ?').run(best, survivors, tile.q, tile.r)
      for (const [leader, co] of coalitions) {
        co.members.forEach((o) => setStatus.run(leader === best ? 'done' : 'failed', n, o.id))
        for (const pid of new Set(co.members.map((o) => o.player_id))) {
          if (leader === best) {
            addNews(pid, pid === best
              ? `⚔️ You seized ${prize} from ${defenderId ? playerName(defenderId) : 'the wilds'} — ${survivors} troops garrison it.`
              : `🤝 Your support helped ${playerName(best)} seize ${prize}.`, tile.q, tile.r)
          } else {
            addNews(pid, `⚔️ Your march on ${prize} arrived to find ${playerName(best)} victorious — your force was lost.`, tile.q, tile.r)
          }
        }
      }
      if (defenderId) {
        battleWinners.add(best)
        addNews(defenderId, `⚔️ ${playerName(best)} seized your ${prize} — you lost ${defRaw} troop${defRaw === 1 ? '' : 's'}.`, tile.q, tile.r)
      }
      const odds = bestCo.raw < defRaw ? 'AGAINST ALL ODDS — ' : ''
      const message = defenderId
        ? `⚔️ ${odds}${playerName(best)} seized ${prize} from ${playerName(defenderId)}!`
        : `⚔️ ${playerName(best)} claimed ${prize} by force of arms!`
      events.push(addEvent('battle', message, { tiles: [{ q: tile.q, r: tile.r }], player: best }))
    } else {
      const defSurvivors = Math.max(0, defRaw - bestCo.raw)
      db.prepare('UPDATE tiles SET strength = ? WHERE q = ? AND r = ?').run(defSurvivors, tile.q, tile.r)
      for (const co of coalitions.values()) {
        co.members.forEach((o) => setStatus.run('failed', n, o.id))
        for (const pid of new Set(co.members.map((o) => o.player_id))) {
          addNews(pid, `🛡️ Your assault on ${playerName(defenderId)}'s ${prize} was repelled — your force was lost.`, tile.q, tile.r)
        }
      }
      addNews(defenderId, `🛡️ You repelled an assault on your ${prize} — ${defSurvivors} troop${defSurvivors === 1 ? '' : 's'} remain.`, tile.q, tile.r)
      const attackers = [...new Set([...coalitions.values()].flatMap((co) => co.members.map((o) => `${o.empire} [${o.abbr}]`)))].join(' and ')
      const odds = defRaw < bestCo.raw ? 'AGAINST ALL ODDS — ' : ''
      events.push(addEvent('battle', `🛡️ ${odds}${playerName(defenderId)} repelled ${attackers} and held ${prize}!`,
        { tiles: [{ q: tile.q, r: tile.r }], player: defenderId }))
    }
  }
}

// Names in public messages always carry the [ABR] tag — the client decorates
// those tags into colored chips matching the map.
function playerName(id) {
  const p = db.prepare('SELECT empire, abbr FROM players WHERE id = ?').get(id)
  return p ? `${p.empire} [${p.abbr}]` : 'an unknown empire'
}

// Personal news: what happened TO you this turn, with the tile so /play can
// flash it on your map.
function addNews(playerId, message, q = null, r = null) {
  db.prepare('INSERT INTO news (player_id, tick, message, q, r) VALUES (?, ?, ?, ?, ?)')
    .run(playerId, Number(getSetting('tick_count')), message, q, r)
}

function revealedStandings(s) {
  const elapsed = Date.now() - Date.parse(s.finale_started_at)
  const rows = JSON.parse(s.finale_data)
  return rows.map((p,i) => {
    const beat = elapsed - i * 13500
    if (beat >= 13500) return p
    const out = {}
    for (const [key,time] of Object.entries({territory:1500,resources:3000,army:4200,relics:5400,total:6400,id:7600,empire:7600,abbr:7600,color:7600,name:10000})) {
      if (beat > time) out[key] = p[key]
    }
    return out
  })
}

export function publicState() {
  const s = allSettings()
  const night = inNightfall()
  return {
    phase: s.phase,
    tick: Number(s.tick_count),
    endAt: s.end_at || null,
    nextTickAt: s.phase === 'running' ? s.next_tick_at || null : null,
    nightfall: { start: s.nightfall_start, end: s.nightfall_end, active: night },
    daybreakAt: night ? nextDaybreak().toISOString() : null,
    ordersPerTurn: Number(s.orders_per_turn),
    ordersPerDay: Number(s.orders_per_day),
    paused: !!s.paused_at,
    rehearsal: s.allow_fast_forward === '1',
    serverNow: new Date().toISOString(),
    tickIntervalMin: Number(s.tick_interval_min),
    // Pre-launch, empires stay hidden so nobody can associate a join with a
    // person — the dashboard gets a count only. Full reveal happens at Launch.
    players: s.phase === 'lobby' ? [] : (() => {
      const sc = scores()
      return listPlayers().map(({id,empire,abbr,color}) => ({ id,empire,abbr,color,score: sc[id] ?? 0 }))
    })(),
    endTurn: readyStatus(),
    finale: s.phase === 'finale' && s.finale_data && s.finale_started_at
      ? { startedAt: s.finale_started_at, data: revealedStandings(s) } : null,
    playerCount: listPlayers().length,
    map: s.phase === 'lobby' ? [] : mapTiles(),
  }
}

// Resolve a turn now and broadcast everything: public events + state to all,
// private state to each player's own socket room. Used by the scheduler and
// the admin "resolve now" button.
export function fireTurn(io) {
  const events = db.transaction(() => {
    if (!gameOpen() || inNightfall()) return []
    const events = resolveTurn()
    setSetting('next_tick_at',new Date(Date.now()+Number(getSetting('tick_interval_min'))*60000).toISOString())
    return events
  })()
  for (const e of events) io.emit('event', e)
  io.emit('state', publicState())
  for (const p of listPlayers()) io.to(`p${p.id}`).emit('me', personalState(p.id))
}

// Runs every second; fires turns, defers them during Nightfall, ends the game on time.
export function pauseGame() {
  if (getSetting('phase') === 'running' && !getSetting('paused_at')) setSetting('paused_at',new Date().toISOString())
}
export const resumeGame = db.transaction(() => {
  if (getSetting('phase') !== 'running' || !getSetting('paused_at')) return
  const remaining = Math.max(0,Date.parse(getSetting('next_tick_at'))-Date.parse(getSetting('paused_at')))
  setSetting('next_tick_at',new Date(Date.now()+remaining).toISOString())
  setSetting('paused_at','')
  setSetting('scheduler_error','')
})
export function startScheduler(io) {
  let lastNightfall
  return setInterval(() => {
    try {
      const s = allSettings()
      if (s.phase === 'finale' && s.finale_started_at) { io.emit('state',publicState()); return }
      if (s.phase !== 'running') return
      const now = new Date()
      if (s.end_at && now >= new Date(s.end_at)) {
        io.emit('event',endGame()); io.emit('state',publicState()); return
      }
      if (s.paused_at) return
      const night = inNightfall(now)
      if (night !== lastNightfall) { lastNightfall=night; io.emit('state',publicState()) }
      const r = readyStatus()
      const early = s.allow_fast_forward === '1' && r.humans > 0 && r.ready >= r.humans
      if ((early || (s.next_tick_at && now >= new Date(s.next_tick_at))) && !inNightfall(now)) fireTurn(io)
      else if (s.next_tick_at && now >= new Date(s.next_tick_at) && inNightfall(now)) {
        setSetting('next_tick_at',nextDaybreak(now).toISOString()); io.emit('state',publicState())
      }
    } catch (err) {
      console.error('Turn failed; game paused:',err)
      pauseGame(); setSetting('scheduler_error','A turn failed and was rolled back. Inspect the server log, then resume.')
      io.emit('state',publicState())
    }
  },1000)
}

export const queueOrder = db.transaction((...args) => {
  const result = queueOrderImpl(...args)
  if (result.ok) db.prepare("UPDATE orders SET budget_day=? WHERE player_id=? AND status='queued' AND budget_day IS NULL").run(getSetting('last_reset'),args[0])
  return result
})

export const cancelOrder = db.transaction((...args) => {
  const result = cancelOrderImpl(...args)
  return result
})

export const launchGame = db.transaction((...args) => {
  const result = launchGameImpl(...args)
  return result
})

export const endGame = db.transaction((...args) => {
  const result = endGameImpl(...args)
  return result
})

export const startFinale = db.transaction((...args) => {
  const result = startFinaleImpl(...args)
  return result
})

export const resetGame = db.transaction((...args) => {
  const result = resetGameImpl(...args)
  return result
})

export const resolveTurn = db.transaction((...args) => {
  const result = resolveTurnImpl(...args)
  return result
})

export const respondPact = db.transaction((...args) => {
  const result = respondPactImpl(...args)
  return result
})

export const withdrawPact = db.transaction((...args) => {
  const result = withdrawPactImpl(...args)
  return result
})

export const proposePact = db.transaction((...args) => {
  const result = proposePactImpl(...args)
  return result
})
