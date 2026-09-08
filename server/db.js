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
if (!battleCols.includes('final_notified')) {
  // Флаг: уже отправили ЛС "начался финал" по этой битве (чтобы не слать повторно
  // на каждый переход хода, пока живых игроков остаётся FINAL_DUEL_SIZE).
  db.exec('ALTER TABLE battles ADD COLUMN final_notified INTEGER NOT NULL DEFAULT 0');
}
if (!battleCols.includes('chat_id')) {
  // Telegram-чат (ID или @username группы), в котором идёт эта битва:
  // туда бот публикует и закрепляет живое сообщение с ходом боя.
  db.exec('ALTER TABLE battles ADD COLUMN chat_id TEXT');
}
if (!battleCols.includes('chat_message_id')) {
  // ID закреплённого сообщения в chat_id, которое бот редактирует по ходу боя.
  db.exec('ALTER TABLE battles ADD COLUMN chat_message_id TEXT');
}
if (!battleCols.includes('chat_title')) {
  // Название чата (берём из Telegram при создании битвы) — чтобы показывать
  // строкой "Чат — ..." в самом живом сообщении.
  db.exec('ALTER TABLE battles ADD COLUMN chat_title TEXT');
}
if (!battleCols.includes('chat_pinned')) {
  // Закреплено ли сейчас живое сообщение битвы в чате. Закрепляем только в
  // момент реального старта боя (status='playing'), а не сразу при создании —
  // если битва отменится из-за нехватки игроков, закреплять было нечего.
  db.exec('ALTER TABLE battles ADD COLUMN chat_pinned INTEGER NOT NULL DEFAULT 0');
}
if (!battleCols.includes('chat_link')) {
  // Ссылка на сам чат (t.me/username либо invite-ссылка) — чтобы в сообщении
  // битвы название чата было кликабельным.
  db.exec('ALTER TABLE battles ADD COLUMN chat_link TEXT');
}
if (!battleCols.includes('chat_game_message_id')) {
  // ID отдельного "боевого" сообщения — публикуется НОВЫМ сообщением в момент
  // старта боя (в отличие от chat_message_id — это сообщение лобби, набора
  // игроков, которое после старта больше не редактируется).
  db.exec('ALTER TABLE battles ADD COLUMN chat_game_message_id TEXT');
}

module.exports = db;
