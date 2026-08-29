const db = require('./db');

const MIN_PLAYERS = 2;
const MIN_BLANKS = 10;
const TURN_TIMEOUT_MS = 15000;
// Автоматическая стрельба: пока в живых больше 2 игроков, барабан стреляет сам
// раз в AUTO_SHOOT_INTERVAL_MS, с шансом SELF_SHOT_CHANCE выстрелить в себя
// (иначе — в случайного другого живого игрока).
const AUTO_SHOOT_INTERVAL_MS = 5000;
const SELF_SHOT_CHANCE = 0.10; // 10% в себя, 90% в другого
// Когда живых игроков остаётся FINAL_DUEL_SIZE (2) — барабан больше не стреляет
// сам, и решение "в себя / в другого" принимают сами игроки кнопками.
const FINAL_DUEL_SIZE = 2;

// Аватарки-аксессуары: ключ -> сколько сыгранных (завершённых) битв нужно, чтобы разблокировать.
// 'default' доступна всем сразу. Файлы лежат в public/avatars/<key>.png
const AVATARS = {
  default: { title: 'Стандартная Рей', required: 0 },
  glasses: { title: 'Очки крутые', required: 10 },
  card:    { title: 'Карточка-рей', required: 100 },
};

function now() { return Date.now(); }

function ensureUser(user) {
  db.prepare(`
    INSERT INTO users (user_id, name, avatar) VALUES (?, ?, 'default')
    ON CONFLICT(user_id) DO UPDATE SET name=excluded.name
  `).run(user.id, user.name);
}

function countFinishedGames(userId) {
  return db.prepare(`
    SELECT COUNT(*) c FROM players p JOIN battles b ON b.id = p.battle_id
    WHERE p.user_id = ? AND b.status = 'finished'
  `).get(userId).c;
}

function getUserAvatar(userId) {
  const row = db.prepare('SELECT avatar FROM users WHERE user_id=?').get(userId);
  return row ? row.avatar : 'default';
}

function setAvatar(user, avatarKey) {
  const meta = AVATARS[avatarKey];
  if (!meta) throw new Error('Такого аксессуара не существует.');
  if (meta.required > 0 && countFinishedGames(user.id) < meta.required) {
    throw new Error(`Сыграй ${meta.required} игр, чтобы получить приз!`);
  }
  ensureUser(user);
  db.prepare('UPDATE users SET avatar=? WHERE user_id=?').run(avatarKey, user.id);
  return { avatar: avatarKey };
}

function setTurn(battleId, userId) {
  db.prepare('UPDATE battles SET turn_user_id=?, turn_started_at=? WHERE id=?').run(userId, now(), battleId);
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function addLog(battleId, text, cls = '') {
  db.prepare('INSERT INTO logs (battle_id, text, cls, created_at) VALUES (?,?,?,?)')
    .run(battleId, text, cls, now());
}

function validateCreateInput({ prize, minutes, maxPlayers, winnersCount, blanksCount }) {
  if (!prize || !String(prize).trim()) return 'Укажи приз.';
  if (!Number.isFinite(minutes) || minutes < 1) return 'Минимум 1 минута до старта.';
  if (!Number.isFinite(maxPlayers) || maxPlayers < MIN_PLAYERS) return `Минимум ${MIN_PLAYERS} игрока.`;
  if (!Number.isFinite(winnersCount) || winnersCount < 1 || winnersCount >= maxPlayers)
    return 'Победителей должно быть меньше, чем макс. игроков.';
  if (!Number.isFinite(blanksCount) || blanksCount < MIN_BLANKS) return `Минимум ${MIN_BLANKS} холостых патронов.`;
  return null;
}

function createBattle(user, input) {
  const err = validateCreateInput(input);
  if (err) throw new Error(err);
  const endsAt = now() + input.minutes * 60000;
  const password = input.password ? String(input.password).trim() : '';
  const info = db.prepare(`
    INSERT INTO battles (prize, minutes, max_players, winners_count, blanks_count, status,
      created_by, created_by_name, ends_at, created_at, password)
    VALUES (?,?,?,?,?, 'lobby', ?,?,?,?,?)
  `).run(input.prize.trim(), input.minutes, input.maxPlayers, input.winnersCount, input.blanksCount,
    user.id, user.name, endsAt, now(), password || null);
  const battleId = info.lastInsertRowid;
  ensureUser(user);
  db.prepare('INSERT INTO players (battle_id, user_id, name, join_order) VALUES (?,?,?,0)')
    .run(battleId, user.id, user.name);
  addLog(battleId, `${user.name} создаёт битву и занимает место за столом.`, 'sys');
  return getBattle(battleId);
}

function joinBattle(user, battleId, password) {
  const battle = db.prepare('SELECT * FROM battles WHERE id=?').get(battleId);
  if (!battle) throw new Error('Битва не найдена.');
  if (battle.status !== 'lobby') throw new Error('В эту битву уже нельзя войти.');
  const already = db.prepare('SELECT * FROM players WHERE battle_id=? AND user_id=?').get(battleId, user.id);
  if (already) return getBattle(battleId);
  if (battle.password) {
    const given = password ? String(password).trim() : '';
    if (given !== battle.password) throw new Error('Неверный пароль.');
  }
  const count = db.prepare('SELECT COUNT(*) c FROM players WHERE battle_id=?').get(battleId).c;
  if (count >= battle.max_players) throw new Error('Свободных мест не осталось.');
  ensureUser(user);
  db.prepare('INSERT INTO players (battle_id, user_id, name, join_order) VALUES (?,?,?,?)')
    .run(battleId, user.id, user.name, count);
  addLog(battleId, `${user.name} садится за стол.`, 'sys');
  if (count + 1 >= battle.max_players) startBattle(battleId);
  return getBattle(battleId);
}

function startBattle(battleId) {
  const battle = db.prepare('SELECT * FROM battles WHERE id=?').get(battleId);
  if (!battle || battle.status !== 'lobby') return;
  const players = db.prepare('SELECT * FROM players WHERE battle_id=? ORDER BY join_order').all(battleId);
  if (players.length < MIN_PLAYERS) {
    db.prepare("UPDATE battles SET status='cancelled' WHERE id=?").run(battleId);
    addLog(battleId, 'Недостаточно игроков — битва отменена.', 'sys');
    return;
  }
  const live = players.length;
  const blanks = battle.blanks_count;
  const chamber = shuffle(Array(live).fill('live').concat(Array(blanks).fill('blank')));
  const starter = pick(players);
  db.prepare(`
    UPDATE battles SET status='playing', chamber=?, turn_user_id=?, turn_started_at=?, remaining_place=? WHERE id=?
  `).run(JSON.stringify(chamber), starter.user_id, now(), players.length, battleId);
  addLog(battleId, `Барабан заряжен: ${live} боевых / ${blanks} холостых.`, 'sys');
  addLog(battleId, `Право стрелять получает ${starter.name}.`, 'sys');
}

// Разрешает все просроченные лобби (вызывается по таймеру)
function resolveExpiredLobbies() {
  const expired = db.prepare("SELECT id FROM battles WHERE status='lobby' AND ends_at<=?").all(now());
  for (const row of expired) startBattle(row.id);
}

function getAlive(battleId) {
  return db.prepare('SELECT * FROM players WHERE battle_id=? AND alive=1').all(battleId);
}

function eliminate(battleId, userId, remainingPlace) {
  db.prepare('UPDATE players SET alive=0, place=? WHERE battle_id=? AND user_id=?')
    .run(remainingPlace, battleId, userId);
}

function drawRound(battle) {
  const chamber = JSON.parse(battle.chamber);
  const round = chamber.shift();
  db.prepare('UPDATE battles SET chamber=? WHERE id=?').run(JSON.stringify(chamber), battle.id);
  return round;
}

function finishIfOneLeft(battleId) {
  const alive = getAlive(battleId);
  if (alive.length <= 1) {
    if (alive.length === 1) db.prepare('UPDATE players SET place=1 WHERE battle_id=? AND user_id=?')
      .run(battleId, alive[0].user_id);
    db.prepare("UPDATE battles SET status='finished', turn_user_id=NULL WHERE id=?").run(battleId);
    addLog(battleId, 'Бой завершён.', 'sys');
    return true;
  }
  return false;
}

function nextRandomShooter(battleId) {
  if (finishIfOneLeft(battleId)) return;
  const alive = getAlive(battleId);
  const next = pick(alive);
  setTurn(battleId, next.user_id);
  addLog(battleId, `Право стрелять переходит к ${next.name}.`, 'sys');
}

// Вызывается по таймеру: работает ТОЛЬКО в финальной дуэли (когда живых <= FINAL_DUEL_SIZE).
// Если игрок держит пистолет дольше 15 секунд и не выбрал "в себя"/"в другого" — выбывает.
// Пока живых больше FINAL_DUEL_SIZE, барабан стреляет сам через autoShootTick(), и до
// этого таймаута дело не доходит (ход передаётся раньше).
function checkTurnTimeouts() {
  const cutoff = now() - TURN_TIMEOUT_MS;
  const stuck = db.prepare(`
    SELECT id, turn_user_id FROM battles
    WHERE status='playing' AND turn_user_id IS NOT NULL AND turn_started_at IS NOT NULL AND turn_started_at <= ?
  `).all(cutoff);
  for (const battle of stuck) {
    const alive = getAlive(battle.id);
    if (alive.length > FINAL_DUEL_SIZE) continue; // не финал — за этот ход отвечает автостельба
    const shooter = alive.find(p => p.user_id === battle.turn_user_id);
    if (!shooter) continue;
    addLog(battle.id, `${shooter.name} не успел выстрелить за 15 секунд — выбывает.`, 'hit');
    const fresh = db.prepare('SELECT remaining_place FROM battles WHERE id=?').get(battle.id).remaining_place;
    eliminate(battle.id, shooter.user_id, fresh);
    db.prepare('UPDATE battles SET remaining_place=? WHERE id=?').run(fresh - 1, battle.id);
    nextRandomShooter(battle.id);
  }
}

// Вызывается по таймеру раз в секунду: пока живых игроков больше FINAL_DUEL_SIZE (2),
// барабан сам решает за текущего игрока — с шансом SELF_SHOT_CHANCE стреляет в себя,
// иначе в случайного другого живого игрока. Интервал между авто-выстрелами — AUTO_SHOOT_INTERVAL_MS.
function autoShootTick() {
  const cutoff = now() - AUTO_SHOOT_INTERVAL_MS;
  const due = db.prepare(`
    SELECT id, turn_user_id FROM battles
    WHERE status='playing' AND turn_user_id IS NOT NULL AND turn_started_at IS NOT NULL AND turn_started_at <= ?
  `).all(cutoff);
  for (const battle of due) {
    const alive = getAlive(battle.id);
    if (alive.length <= FINAL_DUEL_SIZE) continue; // финал — решают сами игроки кнопками
    const shooter = alive.find(p => p.user_id === battle.turn_user_id);
    if (!shooter) continue;
    const isSelf = Math.random() < SELF_SHOT_CHANCE;
    performShot(battle.id, shooter.user_id, isSelf);
  }
}

function assertMyTurn(battle, user) {
  if (battle.status !== 'playing') throw new Error('Бой сейчас не идёт.');
  if (battle.turn_user_id !== user.id) throw new Error('Сейчас не твой ход.');
}

// Общая логика одного выстрела — используется и ручными кнопками (финал), и автострельбой.
function performShot(battleId, shooterUserId, isSelf) {
  const battle = db.prepare('SELECT * FROM battles WHERE id=?').get(battleId);
  if (!battle) return null;
  const shooter = db.prepare('SELECT * FROM players WHERE battle_id=? AND user_id=?').get(battleId, shooterUserId);
  if (!shooter) return getBattle(battleId);
  let target = shooter;
  if (!isSelf) {
    const others = getAlive(battleId).filter(p => p.user_id !== shooterUserId);
    if (others.length === 0) { finishIfOneLeft(battleId); return getBattle(battleId); }
    target = pick(others);
  }
  const round = drawRound(battle);
  if (round === 'blank') {
    if (isSelf) {
      addLog(battleId, `${shooter.name} стреляет в себя — холостой. Патрон передаётся снова ${shooter.name}.`);
      setTurn(battleId, shooterUserId);
    } else {
      addLog(battleId, `${shooter.name} стреляет в ${target.name} — холостой. Право стрелять переходит к ${target.name}.`);
      setTurn(battleId, target.user_id);
    }
  } else {
    if (isSelf) {
      addLog(battleId, `${shooter.name} стреляет в себя — боевой. ${shooter.name} выбывает.`, 'hit');
    } else {
      addLog(battleId, `${shooter.name} стреляет в ${target.name} — боевой. ${target.name} выбывает.`, 'hit');
    }
    const fresh = db.prepare('SELECT remaining_place FROM battles WHERE id=?').get(battleId).remaining_place;
    eliminate(battleId, target.user_id, fresh);
    db.prepare('UPDATE battles SET remaining_place=? WHERE id=?').run(fresh - 1, battleId);
    nextRandomShooter(battleId);
  }
  return getBattle(battleId);
}

function shootSelf(user, battleId) {
  const battle = db.prepare('SELECT * FROM battles WHERE id=?').get(battleId);
  if (!battle) throw new Error('Битва не найдена.');
  assertMyTurn(battle, user);
  if (getAlive(battleId).length > FINAL_DUEL_SIZE) throw new Error('Пока не финал — барабан стреляет сам.');
  return performShot(battleId, user.id, true);
}

function shootOther(user, battleId) {
  const battle = db.prepare('SELECT * FROM battles WHERE id=?').get(battleId);
  if (!battle) throw new Error('Битва не найдена.');
  assertMyTurn(battle, user);
  if (getAlive(battleId).length > FINAL_DUEL_SIZE) throw new Error('Пока не финал — барабан стреляет сам.');
  return performShot(battleId, user.id, false);
}

function getBattle(battleId) {
  const battle = db.prepare('SELECT * FROM battles WHERE id=?').get(battleId);
  if (!battle) return null;
  const players = db.prepare(`
    SELECT p.user_id, p.name, p.alive, p.place, COALESCE(u.avatar,'default') as avatar
    FROM players p LEFT JOIN users u ON u.user_id = p.user_id
    WHERE p.battle_id=? ORDER BY p.join_order
  `).all(battleId);
  const logs = db.prepare('SELECT text, cls FROM logs WHERE battle_id=? ORDER BY id ASC').all(battleId);
  const chamber = battle.chamber ? JSON.parse(battle.chamber) : [];
  return {
    id: battle.id,
    prize: battle.prize,
    minutes: battle.minutes,
    maxPlayers: battle.max_players,
    winnersCount: battle.winners_count,
    blanksCount: battle.blanks_count,
    status: battle.status,
    hasPassword: !!battle.password,
    createdBy: battle.created_by,
    createdByName: battle.created_by_name,
    turnUserId: battle.turn_user_id,
    turnStartedAt: battle.turn_started_at,
    turnTimeoutMs: TURN_TIMEOUT_MS,
    autoShootMs: AUTO_SHOOT_INTERVAL_MS,
    finalDuelSize: FINAL_DUEL_SIZE,
    aliveCount: db.prepare('SELECT COUNT(*) c FROM players WHERE battle_id=? AND alive=1').get(battleId).c,
    endsAt: battle.ends_at,
    liveLeft: chamber.filter(c => c === 'live').length,
    blankLeft: chamber.filter(c => c === 'blank').length,
    players,
    log: logs,
  };
}

function listBattles() {
  const rows = db.prepare("SELECT id, status FROM battles ORDER BY id DESC LIMIT 100").all();
  return rows.map(r => getBattle(r.id));
}

function getProfile(user) {
  const rows = db.prepare(`
    SELECT b.id, b.prize, b.winners_count, p.place
    FROM players p JOIN battles b ON b.id = p.battle_id
    WHERE p.user_id = ? AND b.status = 'finished'
    ORDER BY b.id DESC
  `).all(user.id);
  const wins = rows.filter(r => r.place <= r.winners_count).length;
  const total = rows.length;
  const achievements = Object.entries(AVATARS)
    .filter(([key, meta]) => meta.required > 0)
    .map(([key, meta]) => ({
      id: key, image: key, title: meta.title, required: meta.required, unlocked: total >= meta.required,
    }));
  return {
    name: user.name,
    avatar: getUserAvatar(user.id),
    wins,
    total,
    winRate: total ? Math.round((wins / total) * 100) : 0,
    history: rows.map(r => ({ prize: r.prize, place: r.place, win: r.place <= r.winners_count })),
    achievements,
  };
}

module.exports = {
  MIN_PLAYERS, MIN_BLANKS, AVATARS, FINAL_DUEL_SIZE, AUTO_SHOOT_INTERVAL_MS,
  createBattle, joinBattle, resolveExpiredLobbies, checkTurnTimeouts, autoShootTick,
  shootSelf, shootOther, getBattle, listBattles, getProfile, setAvatar,
};
