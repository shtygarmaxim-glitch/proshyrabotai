const { InlineKeyboard } = require('grammy');
const db = require('./db');

// Модуль отвечает за "живое" сообщение боя в чате: бот публикует одно
// сообщение, закрепляет его и дальше только редактирует (editMessageText) —
// сверху "жирным" текущее событие, ниже, в раскрывающейся "цитате"
// (<blockquote expandable>), — предыдущий лог. Инициализируется один раз из
// index.js после создания бота — до этого все функции молча ничего не делают.

let botRef = null;
let publicUrlRef = null;

function init(bot, publicUrl) {
  botRef = bot;
  publicUrlRef = publicUrl;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const STATUS_LABEL = {
  lobby: '🕓 Идёт набор',
  playing: '🔫 Бой идёт',
  finished: '🏁 Бой завершён',
  cancelled: '❌ Битва отменена',
};

// Сколько строк предыдущего лога показывать под "цитатой" (последняя строка
// уходит отдельно, жирным, как текущее событие — в цитату не попадает).
const QUOTE_LINES = 10;

// "Старт через" — красиво форматируем остаток времени: пока больше минуты —
// в минутах, а в последнюю минуту — уже в секундах (обновляется тиком раз в
// 5 секунд из game.js, так и получается 20 секунд / 15 секунд / 10 секунд...).
function formatCountdown(msLeft) {
  if (msLeft <= 0) return 'вот-вот стартует…';
  const totalSec = Math.ceil(msLeft / 1000);
  if (totalSec >= 60) {
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return s ? `${m} мин ${s} сек` : `${m} мин`;
  }
  return `${totalSec} сек`;
}

function renderMessage(battle) {
  const lines = [];
  lines.push('🔫 <b>ПРОТОКОЛ: БАРАБАН</b>');
  lines.push(STATUS_LABEL[battle.status] || '');
  lines.push('');
  lines.push(`Приз — <b>${escapeHtml(battle.prize)}</b>`);
  if (battle.chatTitle) lines.push(`Чат — ${escapeHtml(battle.chatTitle)}`);
  if (battle.status === 'lobby') {
    lines.push(`Старт через — <b>${formatCountdown(battle.endsAt - Date.now())}</b>`);
  }
  lines.push(`Кол-во победителей — ${battle.winnersCount}`);
  if (battle.status !== 'lobby') {
    lines.push(`Патроны — 🔴 ${battle.liveLeft} боевых / ⚪ ${battle.blankLeft} холостых осталось`);
  }
  lines.push(`Игроки — <b>${battle.players.length}/${battle.maxPlayers}</b>`);

  if (battle.status === 'lobby') {
    const names = battle.players.map((p) => escapeHtml(p.name)).join(', ');
    lines.push(`За столом: ${names || '—'}`);
  }

  if (battle.status === 'playing' && battle.turnUserId) {
    const turnPlayer = battle.players.find((p) => p.user_id === battle.turnUserId);
    if (turnPlayer) lines.push(`Ход — <b>${escapeHtml(turnPlayer.name)}</b>`);
  }

  const logs = battle.log || [];
  if (logs.length) {
    lines.push('');
    const last = logs[logs.length - 1];
    const prev = logs.slice(0, -1).slice(-QUOTE_LINES);
    if (prev.length) {
      // Пустая строка между записями — иначе весь лог сливается в одну кашу.
      lines.push(`<blockquote expandable>${prev.map((l) => escapeHtml(l.text)).join('\n\n')}</blockquote>`);
    }
    lines.push(`<b>${escapeHtml(last.text)}</b>`);
  }

  if (battle.status === 'finished') {
    const winners = battle.players
      .filter((p) => p.place && p.place <= battle.winnersCount)
      .sort((a, b) => a.place - b.place)
      .map((p) => escapeHtml(p.name));
    if (winners.length) lines.push(`\n🏆 Приз забирает: ${winners.join(', ')}`);
  }

  return lines.filter((l) => l !== undefined).join('\n');
}

function buildKeyboard(battle) {
  if (battle.status === 'lobby') {
    const full = battle.players.length >= battle.maxPlayers;
    if (full) return undefined;
    const kb = new InlineKeyboard();
    if (battle.hasPassword) {
      if (publicUrlRef) kb.webApp('🔒 Вступить (по паролю, в приложении)', publicUrlRef);
    } else {
      kb.text('🔫 Вступить', `join:${battle.id}`);
    }
    return kb.inline_keyboard.length ? kb : undefined;
  }
  // В финальной дуэли (живых <= finalDuelSize) решение "в себя / в другого"
  // принимает сам игрок — кнопки прямо под сообщением в чате. Нажать по-настоящему
  // сможет только тот, чей сейчас ход: game.shootSelf/shootOther в bot.js
  // отклонит нажатие любого другого игрока с алертом "Сейчас не твой ход."
  if (battle.status === 'playing' && battle.turnUserId && battle.aliveCount <= battle.finalDuelSize) {
    return new InlineKeyboard()
      .text('🔫 В себя', `shoot:self:${battle.id}`)
      .text('🎯 В другого', `shoot:other:${battle.id}`);
  }
  return undefined;
}

// Простая очередь на битву, чтобы редактирования одного и того же сообщения
// применялись строго по порядку, даже если несколько событий боя (авто-выстрел,
// таймаут хода, чей-то join) прилетели почти одновременно.
const chains = new Map();

function sync(battle) {
  if (!botRef || !battle || !battle.chatId) return Promise.resolve();
  const prevChain = chains.get(battle.id) || Promise.resolve();
  const nextChain = prevChain.then(() => doSync(battle)).catch(() => {});
  chains.set(battle.id, nextChain);
  return nextChain;
}

async function doSync(battle) {
  const text = renderMessage(battle);
  // editMessageText НЕ убирает старую клавиатуру, если reply_markup не передан —
  // поэтому всегда передаём явную клавиатуру, а без кнопок — пустую (это её и снимает).
  const keyboard = buildKeyboard(battle) || new InlineKeyboard();
  try {
    if (!battle.chatMessageId) {
      const msg = await botRef.api.sendMessage(battle.chatId, text, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      });
      db.prepare('UPDATE battles SET chat_message_id=? WHERE id=?').run(String(msg.message_id), battle.id);
      try {
        await botRef.api.pinChatMessage(battle.chatId, msg.message_id, { disable_notification: true });
      } catch (err) {
        console.error(`broadcast: не удалось закрепить сообщение битвы ${battle.id}:`, err.message);
      }
    } else {
      await botRef.api.editMessageText(battle.chatId, Number(battle.chatMessageId), text, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      });
      if (battle.status === 'finished' || battle.status === 'cancelled') {
        try {
          await botRef.api.unpinChatMessage(battle.chatId, Number(battle.chatMessageId));
        } catch (err) { /* не критично, если уже откреплено */ }
      }
    }
  } catch (err) {
    if (!/message is not modified/i.test(err.message)) {
      console.error(`broadcast: не удалось обновить сообщение битвы ${battle.id}:`, err.message);
    }
  }
}

// Проверяет перед созданием битвы, что чат существует, бот в нём состоит и
// имеет права публиковать и закреплять сообщения. Бросает понятную ошибку
// на русском, если что-то не так — её и увидит человек в форме создания.
async function assertUsableChat(chatId) {
  if (!botRef) throw new Error('Бот сейчас не запущен — попробуй позже.');
  let chat;
  try {
    chat = await botRef.api.getChat(chatId);
  } catch (err) {
    throw new Error('Не могу найти этот чат. Проверь ID/юзернейм и убедись, что бот в нём состоит.');
  }
  if (chat.type !== 'group' && chat.type !== 'supergroup') {
    throw new Error('Битву можно вести только в группе или супергруппе, не в личке и не в канале.');
  }
  let member;
  try {
    const me = await botRef.api.getMe();
    member = await botRef.api.getChatMember(chatId, me.id);
  } catch (err) {
    throw new Error('Не получилось проверить права бота в этом чате.');
  }
  if (member.status !== 'administrator' && member.status !== 'creator') {
    throw new Error('Добавь бота в администраторы этого чата (с правом закрепления сообщений).');
  }
  if (member.status === 'administrator' && member.can_pin_messages === false) {
    throw new Error('У бота нет права закреплять сообщения в этом чате — выдай его в настройках админов.');
  }
  return chat;
}

module.exports = { init, sync, assertUsableChat };
