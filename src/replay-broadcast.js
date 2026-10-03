// Optional, in-memory presentation state. This module never writes game data or
// imports the turn/scoring engine; its only game input is the safe replay reader.
import { randomUUID } from 'node:crypto'

export const FRAME_MS = 800
export const HOLD_MS = 5000
export const MAX_PLAYBACK_MS = 120000
export const MAX_REPLAY_BYTES = 4 * 1024 * 1024
const PER_RANK_MS = 13500 // Keep aligned with the existing finale presentation.

export function ceremonyActive(settings, now = Date.now()) {
  if (settings.phase !== 'finale' || !settings.finale_started_at) return false
  const startedAt = Date.parse(settings.finale_started_at)
  try {
    const rows = JSON.parse(settings.finale_data)
    // An invalid ceremony must not accidentally disclose a replay over its reveal.
    if (!Number.isFinite(startedAt) || !Array.isArray(rows)) return true
    return now < startedAt + rows.length * PER_RANK_MS
  } catch { return true }
}

export function createReplayBroadcast({
  readReplay, getSettings, notify = () => {}, now = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout, createId = randomUUID,
}) {
  const instance = createId()
  let revision = 0, playback = null, timer = null
  const packet = () => ({ instance, revision, serverNow: now(), playback })

  function stop() {
    if (timer != null) clearTimer(timer)
    timer = null
    if (!playback) return { ok: true }
    playback = null
    revision++
    notify(packet())
    return { ok: true }
  }

  function scheduleEnd(id) {
    if (!playback || playback.id !== id) return
    const remaining = playback.endsAt - now()
    if (remaining <= 0) { stop(); return }
    timer = setTimer(() => {
      // A cancelled callback from a prior playback cannot stop a newer one.
      if (!playback || playback.id !== id) return
      timer = null
      scheduleEnd(id)
    }, remaining)
    timer?.unref?.()
  }

  function state() {
    // Reconciliation stays authoritative even if the expiry timer was delayed.
    if (playback && now() >= playback.endsAt) stop()
    return packet()
  }

  function start() {
    const settings = getSettings()
    if (settings.phase === 'lobby') return { error: 'The map is available after launch.', status: 400 }
    if (ceremonyActive(settings, now())) return { error: 'Wait for the Final Tally to finish before playing a timelapse.', status: 409 }
    state()
    if (playback) return { ok: true } // Repeated clicks join the current broadcast.
    let replay
    try { replay = readReplay() } catch {
      return { error: 'Replay could not be loaded. Normal play and the finale are still available.', status: 400 }
    }
    if (!replay?.available) return { error: replay?.reason || 'Replay is unavailable.', status: 400 }
    if (!Array.isArray(replay.frames) || !replay.frames.length || !Array.isArray(replay.map) || !Array.isArray(replay.players)) {
      return { error: 'Replay could not be loaded. Normal play and the finale are still available.', status: 400 }
    }
    const tooLarge = () => ({ error: 'This history is too large to broadcast safely. Use the separate replay preview instead.', status: 413 })
    if (replay.frames.length > 12000 || replay.map.length > 20000 || replay.players.length > 1000) return tooLarge()
    try {
      const serialized = JSON.stringify(replay)
      if (Buffer.byteLength(serialized) > MAX_REPLAY_BYTES) return tooLarge()
      replay = JSON.parse(serialized) // A fixed snapshot, independent of later turns.
    } catch { return { error: 'Replay could not be loaded. Normal play and the finale are still available.', status: 400 } }
    const intervals = replay.frames.length - 1
    const frameMs = intervals ? Math.min(FRAME_MS, Math.floor((MAX_PLAYBACK_MS - HOLD_MS) / intervals)) : FRAME_MS
    const startedAt = now()
    playback = { id: createId(), startedAt, endsAt: startedAt + intervals * frameMs + HOLD_MS, frameMs, holdMs: HOLD_MS, replay }
    revision++
    scheduleEnd(playback.id)
    notify(packet())
    return { ok: true }
  }

  return { start, stop, state }
}
