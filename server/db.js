const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, '..', 'data.sqlite'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS battles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  prize TEXT NOT NULL,
  minutes INTEGER NOT NULL,
  max_players INTEGER NOT NULL,
  winners_count INTEGER NOT NULL,
  blanks_count INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'lobby', -- lobby | playing | finished | cancelled
  created_by TEXT NOT NULL,
  created_by_name TEXT NOT NULL,
  turn_user_id TEXT,
  remaining_place INTEGER,
  chamber TEXT, -- JSON array: ["live","blank",...]
  ends_at INTEGER NOT NULL, -- когда лобби закрывается / когда стартует бой
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS players (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  battle_id INTEGER NOT NULL REFERENCES battles(id),
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  alive INTEGER NOT NULL DEFAULT 1,
  place INTEGER,
  join_order INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  battle_id INTEGER NOT NULL REFERENCES battles(id),
  text TEXT NOT NULL,
  cls TEXT DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  user_id TEXT PRIMARY KEY,
  name TEXT,
  avatar TEXT NOT NULL DEFAULT 'default'
);

CREATE TABLE IF NOT EXISTS allowed_creators (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  identifier TEXT NOT NULL UNIQUE, -- telegram id либо username (без @, в нижнем регистре)
  label TEXT NOT NULL,             -- как ввёл админ, для отображения в списке
  added_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_players_battle ON players(battle_id);
CREATE INDEX IF NOT EXISTS idx_logs_battle ON logs(battle_id);
`);

// Безопасная миграция для уже существующих баз (созданных до появления таймера хода):
// добавляем колонку, только если её ещё нет.
const battleCols = db.prepare("PRAGMA table_info(battles)").all().map(c => c.name);
if (!battleCols.includes('turn_started_at')) {
  db.exec('ALTER TABLE battles ADD COLUMN turn_started_at INTEGER');
}
if (!battleCols.includes('password')) {
  db.exec('ALTER TABLE battles ADD COLUMN password TEXT');
}

module.exports = db;
