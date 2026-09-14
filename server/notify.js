const { InlineKeyboard } = require('grammy');

// Модуль отвечает за личные сообщения (ЛС) игрокам: старт битвы и финальные
// ходы. Инициализируется один раз из index.js после создания бота — до этого
// (например, если PUBLIC_URL не задан и бот не запущен) все функции просто
// молча ничего не делают.
let botRef = null;
let publicUrlRef = null;

function init(bot, publicUrl) {
  botRef = bot;
  publicUrlRef = publicUrl;
}

function openKeyboard() {
  if (!publicUrlRef) return undefined;
  return new InlineKeyboard().webApp('🔫 Открыть барабан', publicUrlRef);
}

function shootKeyboard(battleId) {
  return new InlineKeyboard()
    .text('🔫 В себя', `shoot:self:${battleId}`)
    .text('🎯 В другого', `shoot:other:${battleId}`);
}

async function send(userId, text, extra = {}) {
  if (!botRef) return;
  try {
    await botRef.api.sendMessage(userId, text, extra);
  } catch (err) {
    // Частая причина — юзер ни разу не писал боту, ЛС ему уходить не может.
    console.error(`notify: не удалось отправить ЛС ${userId}:`, err.message);
  }
}

// Уходит в ЛС каждому игроку в момент старта самой битвы.
async function battleStarted(battle, players, starterName) {
  const text =
    '⚡ БИТВА НАЧАЛАСЬ!\n\n' +
    `Приз: ${battle.prize}\n` +
    `В барабане: ${players.length} боевых, ${battle.blanks_count} холостых.\n` +
    `Первым стреляет: ${starterName}.\n\n` +
    'Следи за боем и своим ходом в приложении 👇';
  await Promise.all(players.map((p) => send(p.user_id, text, { reply_markup: openKeyboard() })));
}

// Красиво перечисляет имена через запятую, а перед последним — "и" (работает
// и для двух имён, и для финала с несколькими призовыми местами).
function joinNames(names) {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} и ${names[names.length - 1]}`;
}

// Уходит в ЛС всем финалистам ровно один раз — в момент, когда в живых
// остаётся finalSize(battle) игроков и барабан перестаёт стрелять сам.
async function finalStarted(finalists) {
  const names = joinNames(finalists.map((p) => p.name));
  const text =
    '☠️ ФИНАЛ!\n\n' +
    `В живых остались только: ${names}.\n` +
    'Барабан больше не стреляет сам — теперь каждый решает сам, в себя или в ' +
    'другого. На каждый ход — ровно 1 минута. Не успел выбрать — выбываешь.';
  await Promise.all(finalists.map((p) => send(p.user_id, text)));
}

// Уходит игроку в ЛС каждый раз, когда именно на него переходит ход в финале —
// с кнопками, чтобы можно было выстрелить прямо из чата, и с отсчётом 1 минута.
async function yourTurn(battleId, userId) {
  const text =
    '🔫 ТВОЙ ХОД.\n\n' +
    'У тебя 1 минута, чтобы выбрать — стрелять в себя или в другого. ' +
    'Не успеешь — выбываешь автоматически.';
  await send(userId, text, { reply_markup: shootKeyboard(battleId) });
}

module.exports = { init, battleStarted, finalStarted, yourTurn, send, joinNames };
