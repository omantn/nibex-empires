import Database from 'better-sqlite3'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))
export const db = new Database(process.env.NIBEX_DB ?? path.join(dir, '..', 'nibex.db'))
db.pragma('journal_mode = WAL')
db.pragma('synchronous = FULL')

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS players (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  token      TEXT UNIQUE NOT NULL,
  name       TEXT NOT NULL,
  empire     TEXT NOT NULL,
  abbr       TEXT NOT NULL,
  color      TEXT NOT NULL,
  emblem     BLOB,
  emblem_mime TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS tiles (
  q        INTEGER NOT NULL,
  r        INTEGER NOT NULL,
  terrain  TEXT NOT NULL,
  owner_id INTEGER,
  capital  INTEGER NOT NULL DEFAULT 0,
  warded   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (q, r)
);
CREATE TABLE IF NOT EXISTS orders (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id  INTEGER NOT NULL,
  type       TEXT NOT NULL,
  q          INTEGER,
  r          INTEGER,
  status     TEXT NOT NULL DEFAULT 'queued',
  tick       INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  from_id    INTEGER NOT NULL,
  to_id      INTEGER NOT NULL,
  body       TEXT NOT NULL,
  read       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS pacts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  a_id        INTEGER NOT NULL,
  b_id        INTEGER NOT NULL,
  proposed_by INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'proposed',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS quests (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id    INTEGER NOT NULL,
  type         TEXT NOT NULL,
  params       TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'active',
  progress     INTEGER NOT NULL DEFAULT 0,
  assigned_day TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS relics (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id  INTEGER NOT NULL,
  quest_id   INTEGER,
  value      INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS spy_intel (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id INTEGER NOT NULL,
  q         INTEGER NOT NULL,
  r         INTEGER NOT NULL,
  strength  INTEGER NOT NULL,
  tick      INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS news (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id  INTEGER NOT NULL,
  tick       INTEGER NOT NULL,
  message    TEXT NOT NULL,
  q          INTEGER,
  r          INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  tick       INTEGER NOT NULL,
  type       TEXT NOT NULL,
  message    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`)

// CREATE TABLE IF NOT EXISTS won't add columns to an existing database, and a
// live game DB must never need wiping for a schema change — add new columns here.
function ensureColumn(table, column, ddl) {
  const cols = db.pragma(`table_info(${table})`).map((c) => c.name)
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`)
}
ensureColumn('players', 'emblem', 'BLOB')
ensureColumn('players', 'emblem_mime', 'TEXT')
ensureColumn('players', 'orders_left', 'INTEGER NOT NULL DEFAULT 0')
ensureColumn('players', 'ore', 'INTEGER NOT NULL DEFAULT 0')
ensureColumn('players', 'food', 'INTEGER NOT NULL DEFAULT 0')
ensureColumn('tiles', 'strength', 'INTEGER NOT NULL DEFAULT 0')
ensureColumn('orders', 'support_for', 'INTEGER')
ensureColumn('orders', 'src_q', 'INTEGER')
ensureColumn('orders', 'src_r', 'INTEGER')
ensureColumn('orders', 'amount', 'INTEGER')
ensureColumn('players', 'is_bot', 'INTEGER NOT NULL DEFAULT 0')
ensureColumn('players', 'ready', 'INTEGER NOT NULL DEFAULT 0')
ensureColumn('players', 'pin', 'TEXT')
ensureColumn('players', 'oathbreaker_until', 'INTEGER NOT NULL DEFAULT 0')
ensureColumn('pacts', 'duration', 'INTEGER')
ensureColumn('pacts', 'expires_tick', 'INTEGER')
ensureColumn('orders', 'target_player', 'INTEGER')
ensureColumn('events', 'data', 'TEXT')

ensureColumn('orders', 'budget_day', 'TEXT')

export const DEFAULTS = {
  orders_per_day: '20',
  allow_fast_forward: '0',
  paused_at: '',
  scheduler_error: '',
  phase: 'lobby',            // lobby | running | finale
  tick_interval_min: '180',
  orders_per_turn: '5',
  nightfall_start: '02:00',
  nightfall_end: '10:00',
  quests_per_day: '2',
  map_radius: '8',
  allow_late_join: '1',
  bot_count: '0',
  end_at: '',
  next_tick_at: '',
  launched_at: '',
  tick_count: '0',
  last_reset: '',
  finale_data: '',
  finale_started_at: '',
}

export function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key)
  return row ? row.value : DEFAULTS[key]
}

export function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value))
}

export function allSettings() {
  const out = { ...DEFAULTS }
  for (const r of db.prepare('SELECT key, value FROM settings').all()) out[r.key] = r.value
  return out
}
