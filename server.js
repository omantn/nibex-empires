import crypto from 'node:crypto'
import http from 'node:http'
import os from 'node:os'
import { createSnapshot } from './src/backup.js'
import express from 'express'
import multer from 'multer'
import { Server } from 'socket.io'
import QRCode from 'qrcode'
import { db, allSettings, setSetting, getSetting } from './src/db.js'
import {
  addEvent, assignSpawn, createPlayer, findPlayerByToken, launchGame, endGame, resetGame,
  getEmblem, fallbackEmblemSvg, listPlayers, publicState, recentEvents, startScheduler,
  personalState, queueOrder, cancelOrder, fireTurn, toggleBot, abandonQuest, setReady,
  findPlayerByAbbrPin, sendMessage, getThread, proposePact, respondPact, withdrawPact, startFinale,
  exchange, pauseGame, resumeGame,
} from './src/game.js'
import { dashboardPage, joinPage, playPage, adminPage, adminLoginPage, parseInset } from './src/views.js'

const PORT = Number(process.env.PORT ?? 3000)
const app = express()
const server = http.createServer(app)
const io = new Server(server)

app.use(express.urlencoded({ extended: false }))
app.use(express.json())

function getCookie(req, name) {
  const m = (req.headers.cookie ?? '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`))
  try { return m ? decodeURIComponent(m[1]) : null } catch { return null }
}

function lanAddress() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces ?? []) {
      if (i.family === 'IPv4' && !i.internal) return i.address
    }
  }
  return 'localhost'
}
const joinUrl = process.env.PUBLIC_URL ? new URL('/join', process.env.PUBLIC_URL).href : `http://${lanAddress()}:${PORT}/join`

app.get('/', (_req, res) => res.redirect('/dashboard'))

// Safe-area inset for TVs whose bezel or a decorative frame hides the edges of the picture.
// DASHBOARD_INSET sets the default (e.g. "60" or "40,80"); ?inset= on the URL overrides it.
const DASHBOARD_INSET = parseInset(process.env.DASHBOARD_INSET)
app.get('/dashboard', async (req, res) => {
  const qr = await QRCode.toDataURL(joinUrl, { margin: 1, width: 440 })
  const inset = req.query.inset != null ? parseInset(req.query.inset) : DASHBOARD_INSET
  res.send(dashboardPage(publicState(), joinUrl, qr, recentEvents(), inset))
})

// Founding is open in the lobby; after launch it needs the admin toggle.
function joinAllowed() {
  const phase = getSetting('phase')
  return phase === 'lobby' || (phase === 'running' && getSetting('allow_late_join') === '1' && !getSetting('paused_at') && Date.now() < Date.parse(getSetting('end_at')))
}

app.get('/join', (req, res) => {
  if (findPlayerByToken(getCookie(req, 'nibex_token'))) return res.redirect('/play')
  res.send(joinPage({ canCreate: joinAllowed() }))
})

const setPlayerCookie = (res, token) => res.setHeader('Set-Cookie',
  `nibex_token=${encodeURIComponent(token)}; Path=/; Max-Age=${30 * 86400}; HttpOnly; SameSite=Lax`)

const attempts = new Map()
function loginLimit(req,res,next) {
  const key = req.ip + ':' + req.path
  const now = Date.now()
  let entry = attempts.get(key)
  if (!entry || now-entry.start > 600000) entry = {start:now,count:0}
  attempts.set(key,entry)
  if (++entry.count > 15) return res.status(429).send('Too many attempts. Try again in 10 minutes or ask the host.')
  next()
}
setInterval(() => { for (const [key,v] of attempts) if (Date.now()-v.start > 600000) attempts.delete(key) },600000).unref()

app.post('/login', loginLimit, (req, res) => {
  const player = findPlayerByAbbrPin(String(req.body.abbr ?? '').trim(), String(req.body.pin ?? '').trim())
  if (!player) {
    return res.status(401).send(joinPage({ loginError: 'No empire matches that abbreviation and PIN.', canCreate: joinAllowed() }))
  }
  setPlayerCookie(res, player.token)
  res.redirect('/play')
})

app.post('/logout', (_req, res) => {
  res.setHeader('Set-Cookie', 'nibex_token=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax')
  res.redirect('/join')
})

// Emblems are always generated (abbr on empire color) — uploads removed for
// visual consistency. multer().none() still parses multipart form posts.
const parseJoinForm = multer().none()

app.post('/join', (req, res) => parseJoinForm(req, res, (formErr) => { try {
  if (findPlayerByToken(getCookie(req, 'nibex_token'))) return res.redirect('/play')
  if (formErr) return res.status(400).send(joinPage({ error: 'Bad form submission — try again.' }))
  if (!joinAllowed()) {
    return res.status(403).send(joinPage({ error: 'The empire rolls are closed.', canCreate: false }))
  }
  const name = String(req.body.name ?? '').trim()
  const empire = String(req.body.empire ?? '').trim()
  const abbr = String(req.body.abbr ?? '').trim().toUpperCase()
  const pin = String(req.body.pin ?? '').trim()
  if (!name || !empire || !/^[A-Z0-9]{2,4}$/.test(abbr)) {
    return res.status(400).send(joinPage({ error: 'All fields are required; abbreviation is 2–4 letters/numbers.' }))
  }
  if (!/^\d{4}$/.test(pin)) {
    return res.status(400).send(joinPage({ error: 'The PIN must be exactly 4 digits.' }))
  }
  if (name.length > 60 || empire.length > 40) return res.status(400).send(joinPage({ error: 'Use at most 60 characters for your name and 40 for your empire.' }))
  if (listPlayers().some(p => p.abbr.toUpperCase() === abbr)) return res.status(400).send(joinPage({error:'That abbreviation is taken. Choose another.'}))
  const player = createPlayer({ name, empire, abbr, pin })
  // Long-lived secret token; maps to the empire server-side so the phone is remembered all weekend.
  setPlayerCookie(res, player.token)
  const phase = allSettings().phase
  if (phase === 'running') assignSpawn(player.id)
  const joinMsg = phase === 'lobby'
    ? `🛡️ A new player has joined. (${publicState().playerCount} so far)`
    : `🏰 ${player.empire} [${player.abbr}] has entered the world.`
  io.emit('event', addEvent('join', joinMsg))
  io.emit('state', publicState())
  res.redirect('/play')
} catch (err) {
  console.error('join failed:', err)
  res.status(500).send(joinPage({ error: 'Something went wrong — grab the admin.' }))
} }))

app.get('/emblem/:id', (req, res) => {
  // Pre-launch, only you can see your own emblem — guessable ids would let
  // people probe the roster and correlate joins with players.
  if (allSettings().phase === 'lobby') {
    const me = findPlayerByToken(getCookie(req, 'nibex_token'))
    if (!me || me.id !== Number(req.params.id)) return res.status(404).end()
  }
  const p = getEmblem(Number(req.params.id))
  if (!p) return res.status(404).end()
  res.setHeader('Cache-Control', 'public, max-age=300')
  res.type('image/svg+xml').send(fallbackEmblemSvg(p))
})

app.get('/play', (req, res) => {
  const player = findPlayerByToken(getCookie(req, 'nibex_token'))
  if (!player) return res.redirect('/join')
  res.send(playPage(player, publicState(), personalState(player.id)))
})

function apiPlayer(req, res) {
  const player = findPlayerByToken(getCookie(req, 'nibex_token'))
  if (!player) res.status(401).json({ error: 'Not joined — visit /join first.' })
  return player
}

app.post('/api/orders', (req, res) => {
  const player = apiPlayer(req, res)
  if (!player) return
  const sf = req.body.support_for == null || req.body.support_for === '' ? null : Number(req.body.support_for)
  const result = queueOrder(player.id, String(req.body.type ?? ''), Number(req.body.q), Number(req.body.r), {
    supportFor: sf, srcQ: req.body.src_q, srcR: req.body.src_r, amount: req.body.amount,
    targetPlayer: req.body.target_player,
  })
  res.status(result.error ? 400 : 200).json(result)
})

app.post('/api/trade', (req, res) => {
  const player = apiPlayer(req, res)
  if (!player) return
  const result = exchange(player.id, String(req.body.dir ?? ''), req.body.times)
  res.status(result.error ? 400 : 200).json(result)
})

app.post('/api/ready', (req, res) => {
  const player = apiPlayer(req, res)
  if (!player) return
  const result = setReady(player.id, !!req.body.ready)
  io.emit('state', publicState())
  res.json(result)
})

app.post('/api/messages', (req, res) => {
  const player = apiPlayer(req, res)
  if (!player) return
  const to = Number(req.body.to)
  const result = sendMessage(player.id, to, req.body.body)
  if (result.ok) {
    io.to(`p${to}`).emit('msg', result.message)
    io.to(`p${to}`).emit('me', personalState(to))
  }
  res.status(result.error ? 400 : 200).json({ ...result, me: personalState(player.id) })
})

app.get('/api/messages/:id', (req, res) => {
  const player = apiPlayer(req, res)
  if (!player) return
  res.json({ ok: true, messages: getThread(player.id, Number(req.params.id)), me: personalState(player.id) })
})

app.post('/api/pacts', (req, res) => {
  const player = apiPlayer(req, res)
  if (!player) return
  const to = Number(req.body.to)
  const result = proposePact(player.id, to, req.body.turns)
  if (result.ok) io.to(`p${to}`).emit('me', personalState(to))
  res.status(result.error ? 400 : 200).json({ ...result, me: personalState(player.id) })
})

app.post('/api/pacts/:id/respond', (req, res) => {
  const player = apiPlayer(req, res)
  if (!player) return
  const result = respondPact(player.id, Number(req.params.id), !!req.body.accept)
  if (result.event) io.emit('event', result.event)
  if (result.ok) for (const p of listPlayers()) io.to(`p${p.id}`).emit('me', personalState(p.id))
  res.status(result.error ? 400 : 200).json({ ...result, me: personalState(player.id) })
})

app.post('/api/pacts/:id/withdraw', (req, res) => {
  const player = apiPlayer(req, res)
  if (!player) return
  const result = withdrawPact(player.id, Number(req.params.id))
  if (result.event) io.emit('event', result.event)
  if (result.ok) for (const p of listPlayers()) io.to(`p${p.id}`).emit('me', personalState(p.id))
  res.status(result.error ? 400 : 200).json({ ...result, me: personalState(player.id) })
})

app.post('/api/quests/abandon', (req, res) => {
  const player = apiPlayer(req, res)
  if (!player) return
  const result = abandonQuest(player.id)
  res.status(result.error ? 400 : 200).json(result)
})

app.post('/api/orders/:id/cancel', (req, res) => {
  const player = apiPlayer(req, res)
  if (!player) return
  const result = cancelOrder(player.id, Number(req.params.id))
  res.status(result.error ? 400 : 200).json(result)
})

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? ''
// Session token rotates on every server restart; logging in again is the tradeoff.
const adminSession = crypto.randomUUID()

function isAdmin(req) {
  const cookie = getCookie(req, 'nibex_admin')
  return typeof cookie === 'string' &&
    Buffer.byteLength(cookie) === Buffer.byteLength(adminSession) &&
    crypto.timingSafeEqual(Buffer.from(cookie), Buffer.from(adminSession))
}

app.post('/admin/login', loginLimit, (req, res) => {
  if (!ADMIN_PASSWORD) return res.status(503).send(adminLoginPage('Set ADMIN_PASSWORD in the server environment, then restart. No default admin password is enabled.'))
  const given = String(req.body.password ?? '')
  const ok = ADMIN_PASSWORD.length > 0 && Buffer.byteLength(given) === Buffer.byteLength(ADMIN_PASSWORD) &&
    crypto.timingSafeEqual(Buffer.from(given), Buffer.from(ADMIN_PASSWORD))
  if (!ok) return res.status(401).send(adminLoginPage('Nice try, nibling.'))
  res.setHeader('Set-Cookie',
    `nibex_admin=${adminSession}; Path=/admin; Max-Age=${7 * 86400}; HttpOnly; SameSite=Lax`)
  res.redirect('/admin')
})

// Guards every /admin route below except the login POST above.
app.use('/admin', (req, res, next) => {
  if (isAdmin(req)) return next()
  res.status(401).send(adminLoginPage())
})

// Admin sees the full roster even during the anonymous lobby.
const adminState = () => ({ ...publicState(), players: listPlayers() })

app.get('/admin', (_req, res) => res.send(adminPage(adminState(), allSettings())))

app.post('/admin/settings', (req,res) => {
  const updates = {}
  const limits = {tick_interval_min:[1,720],orders_per_day:[1,100],quests_per_day:[0,10],bot_count:[0,40]}
  for (const [key,[min,max]] of Object.entries(limits)) {
    if (req.body[key] == null) continue
    const n = Number(req.body[key])
    if (!Number.isInteger(n) || n < min || n > max) return res.status(400).send(adminPage(adminState(),allSettings(),key+' must be '+min+'–'+max+'.'))
    updates[key] = String(n)
  }
  for (const key of ['nightfall_start','nightfall_end']) {
    if (!/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(req.body[key] ?? '')) return res.status(400).send(adminPage(adminState(),allSettings(),'Enter valid Nightfall times.'))
    updates[key] = req.body[key]
  }
  if (req.body.end_at) {
    const end = new Date(req.body.end_at)
    if (!Number.isFinite(end.getTime()) || end <= new Date()) return res.status(400).send(adminPage(adminState(),allSettings(),'Choose a future end time.'))
    updates.end_at = end.toISOString()
  }
  if (getSetting('phase') !== 'lobby') {
    for (const key of ['tick_interval_min','orders_per_day','quests_per_day','bot_count','nightfall_start','nightfall_end']) {
      if (updates[key] != null && updates[key] !== getSetting(key)) return res.status(400).send(adminPage(adminState(),allSettings(),'Cadence and scoring rules are locked after launch.'))
    }
  }
  updates.allow_late_join = req.body.allow_late_join ? '1' : '0'
  updates.allow_fast_forward = req.body.allow_fast_forward ? '1' : '0'
  if (getSetting('phase') !== 'lobby' && updates.allow_fast_forward !== getSetting('allow_fast_forward')) return res.status(400).send(adminPage(adminState(),allSettings(),'Rehearsal mode is locked after launch.'))
  db.transaction(() => { for (const [key,value] of Object.entries(updates)) setSetting(key,value) })()
  io.emit('state',publicState()); res.redirect('/admin')
})

app.post('/admin/pause', (_req,res) => { pauseGame(); io.emit('state',publicState()); res.redirect('/admin') })
app.post('/admin/resume', (_req,res) => { resumeGame(); io.emit('state',publicState()); res.redirect('/admin') })
app.post('/admin/backup', async (_req,res,next) => {
  try { const file=await createSnapshot('manual'); if (!file) return res.status(400).send('This is a disposable in-memory rehearsal.'); res.download(file) } catch(e) { next(e) }
})

app.post('/admin/launch', (req, res) => {
  const s = allSettings()
  if (s.phase !== 'lobby') return res.status(400).send(adminPage(adminState(), s, 'Game already launched.'))
  if (!listPlayers().length && Number(s.bot_count) < 1) return res.status(400).send(adminPage(adminState(),s,'Add at least one empire before launching.'))
  const endAt = s.end_at ? new Date(s.end_at) : null
  if (!endAt || endAt <= new Date()) {
    return res.status(400).send(adminPage(adminState(), s, 'Set a future end date/time before launching.'))
  }
  io.emit('event', launchGame(endAt))
  io.emit('state', publicState())
  res.redirect('/admin')
})

app.post('/admin/reset', async (_req, res, next) => {
  try { await createSnapshot('before-reset') } catch(e) { return next(e) }
  io.emit('event', resetGame())
  io.emit('state', publicState())
  res.redirect('/admin')
})

app.post('/admin/end', (_req, res) => {
  if (getSetting('phase') === 'running') {
    io.emit('event', endGame())
    io.emit('state', publicState())
  }
  res.redirect('/admin')
})

app.post('/admin/bot/:id', (req, res) => {
  toggleBot(Number(req.params.id))
  res.redirect('/admin')
})

app.post('/admin/finale', (_req, res) => {
  const result = startFinale()
  if (result.event) io.emit('event', result.event)
  if (result.ok) io.emit('state', publicState())
  res.redirect('/admin')
})

app.post('/admin/tick', (_req, res) => {
  if (getSetting('phase') === 'running') {
    if (getSetting('allow_fast_forward') !== '1') return res.status(400).send('Resolve now is only available in rehearsal mode.')
    fireTurn(io)
  }
  res.redirect('/admin')
})

// Each player's socket joins a private room so turn results can deliver their
// personal state (orders, resources) without leaking it to anyone else.
io.use((socket, next) => {
  const m = (socket.handshake.headers.cookie ?? '').match(/(?:^|;\s*)nibex_token=([^;]*)/)
  let player = null
  try { player = m ? findPlayerByToken(decodeURIComponent(m[1])) : null } catch {} 
  if (player) socket.join(`p${player.id}`)
  next()
})

io.on('connection', (socket) => {
  socket.emit('state',publicState())
  const player = findPlayerByToken(getCookie({headers:socket.handshake.headers},'nibex_token'))
  if (player) socket.emit('me',personalState(player.id))
})

startScheduler(io)
createSnapshot('startup').catch(err => {
  console.error('Startup backup failed:',err)
  setSetting('backup_error','Startup backup failed. Check disk space and the server log.')
})
setInterval(() => createSnapshot('auto').catch(err => {
  console.error('Backup failed:',err)
  setSetting('backup_error','Automatic backup failed. Check disk space and the server log.')
}),5*60000).unref()
app.use((err,req,res,_next) => {
  console.error(err)
  res.status(500).send(req.path.startsWith('/api/') ? {error:'The request failed. Refresh to check your saved state before retrying.'} : 'The request failed. Ask the host to check the server log.')
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Nibex: Empires running at http://localhost:${PORT}`)
  console.log(`LAN join URL (QR on dashboard): ${joinUrl}`)
})
