const db = require('./db');

// Твой Telegram ID. Можно переопределить переменной окружения OWNER_ID.
const OWNER_ID = String(process.env.OWNER_ID || '618124780');

function normalizeIdentifier(raw) {
  let s = String(raw).trim();
  if (s.startsWith('@')) s = s.slice(1);
  return s.toLowerCase();
}

function isOwner(user) {
  return String(user.id) === OWNER_ID;
}

function isAllowed(user) {
  if (isOwner(user)) return true;
  const byId = db.prepare('SELECT 1 FROM allowed_creators WHERE identifier=?').get(String(user.id));
  if (byId) return true;
  if (user.username) {
    const byUsername = db.prepare('SELECT 1 FROM allowed_creators WHERE identifier=?')
      .get(normalizeIdentifier(user.username));
    if (byUsername) return true;
  }
  return false;
}

function listAllowed() {
  return db.prepare('SELECT identifier, label, added_at FROM allowed_creators ORDER BY added_at DESC').all();
}

function addAllowed(rawIdentifier) {
  const label = String(rawIdentifier || '').trim();
  if (!label) throw new Error('Укажи Telegram ID или @username.');
  const identifier = normalizeIdentifier(label);
  db.prepare('INSERT OR IGNORE INTO allowed_creators (identifier, label, added_at) VALUES (?,?,?)')
    .run(identifier, label, Date.now());
  return listAllowed();
}

function removeAllowed(rawIdentifier) {
  db.prepare('DELETE FROM allowed_creators WHERE identifier=?').run(normalizeIdentifier(rawIdentifier));
  return listAllowed();
}

module.exports = { OWNER_ID, isOwner, isAllowed, listAllowed, addAllowed, removeAllowed };
