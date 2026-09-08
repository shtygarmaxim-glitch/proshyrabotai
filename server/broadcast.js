const { InlineKeyboard } = require('grammy');
const db = require('./db');

// Модуль отвечает за "живые" сообщения боя в чате.
//
// У битвы два разных сообщения (это специально: чтобы бой не "терялся" в
// истории редактирований лобби, и чтобы не закреплять то, что может ещё
// отмениться из-за нехватки игроков):
//
//  1) "Лобби"-сообщение (chat_message_id) — публикуется сразу при создании
//     битвы, редактируется, пока идёт набор игроков (статус 'lobby'). Никогда
//     не закрепляется. Как только бой стартует, это сообщение редактируется
//     ПОСЛЕДНИЙ раз ("бой начался, смотри ниже"), клавиатура снимается — и
//     больше это сообщение не трогаем. Если игроков не набралось — это же
//     сообщение просто редактируется на текст отмены, новое сообщение при
//     этом не публикуется вообще.
//  2) "Боевое" сообщение (chat_game_message_id) — публикуется НОВЫМ
//     сообщением в момент старта боя, и вот его уже закрепляем. Дальше именно
//     его редактируем всю игру: лог, текущий ход, патроны, результат.
//
// Инициализируется один раз из index.js после создания бота — до этого все
// функции молча ничего не делают.

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

// Отдельная экранизация для значений внутри HTML-атрибутов (href="...") —
// помимо &/</>, там ещё нужно экранировать кавычки.
function escapeAttr(s) {
  return escapeHtml(s).replace(/"/g, '&quot;');
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

// Точное время старта — чтобы человек сразу понимал, во сколько именно
// начнётся бой, а не только "через сколько". Часовой пояс берём фиксированный
// (МСК) — у бота нет данных о часовом поясе конкретного игрока в чате.
function formatAbsoluteStart(ts) {
  const d = new Date(ts);
  const date = d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', timeZone: 'Europe/Moscow' });
  const time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' });
  return `${date} ${time} МСК`;
}

// Кликабельное название чата, если есть ссылка (t.me/username или invite-ссылка).
function chatDisplay(battle) {
  const title = escapeHtml(battle.chatTitle);
  return battle.chatLink ? `<a href="${escapeAttr(battle.chatLink)}">${title}</a>` : title;
}

// ---------- Лобби-сообщение (набор игроков) ----------
// frozen=true — финальная версия после старта боя: без обратного отсчёта,
// списка игроков и клавиатуры, просто короткая пометка, что бой начался.
function renderLobbyMessage(battle, frozen) {
  const lines = [];
  lines.push('🔫 <b>ПРОТОКОЛ: БАРАБАН</b>');
  lines.push(frozen ? '🔫 Бой начался! Продолжение — новым сообщением ниже 👇' : (STATUS_LABEL[battle.status] || ''));
  lines.push('');

  const info = [];
  info.push(`<b>Приз — ${escapeHtml(battle.prize)}</b>`);
  if (battle.chatTitle) info.push(`<b>Чат — ${chatDisplay(battle)}</b>`);
  if (!frozen) {
    info.push(`<b>Старт через — ${formatCountdown(battle.endsAt - Date.now())} (${escapeHtml(formatAbsoluteStart(battle.endsAt))})</b>`);
  }
  info.push(`<b>Кол-во победителей — ${battle.winnersCount}</b>`);
  info.push(`<b>Игроки — ${battle.players.length}/${battle.maxPlayers}</b>`);
  lines.push(`<blockquote>${info.join('\n')}</blockquote>`);

  if (battle.createdByName) {
    lines.push('');
    lines.push(`<i>${escapeHtml(battle.createdByName)} Распорядитель битвы, все вопросы к нему.</i>`);
  }

  if (!frozen) {
    const names = battle.players.map((p) => escapeHtml(p.name)).join(', ');
    lines.push(`За столом: ${names || '—'}`);
  }

  return lines.filter((l) => l !== undefined).join('\n');
}

function buildLobbyKeyboard(battle) {
  const full = battle.players.length >= battle.maxPlayers;
  if (full) return undefined;
  const kb = new InlineKeyboard();
  if (battle.hasPassword) {
    // Ведём сразу на конкретную битву в мини-апе (через query-параметр
    // ?battle=<id>), а не просто на главный экран — там открывается
    // экран ввода пароля именно для этой битвы.
    if (publicUrlRef) {
      const sep = publicUrlRef.includes('?') ? '&' : '?';
      kb.webApp('🔒 Вступить (по паролю, в приложении)', `${publicUrlRef}${sep}battle=${battle.id}`);
    }
  } else {
    kb.text('🔫 Вступить', `join:${battle.id}`);
  }
  return kb.inline_keyboard.length ? kb : undefined;
}

// ---------- Боевое сообщение (сам бой) ----------
function renderGameMessage(battle) {
  const lines = [];
  lines.push('🔫 <b>ПРОТОКОЛ: БАРАБАН</b>');
  lines.push(STATUS_LABEL[battle.status] || '');
  lines.push('');

  const info = [];
  info.push(`<b>Приз — ${escapeHtml(battle.prize)}</b>`);
  if (battle.chatTitle) info.push(`<b>Чат — ${chatDisplay(battle)}</b>`);
  info.push(`<b>Кол-во победителей — ${battle.winnersCount}</b>`);
  info.push(`<b>Патроны — 🔴 ${battle.liveLeft} боевых / ⚪ ${battle.blankLeft} холостых осталось</b>`);
  info.push(`<b>Игроки — ${battle.players.length}/${battle.maxPlayers}</b>`);
  lines.push(`<blockquote>${info.join('\n')}</blockquote>`);

  if (battle.createdByName) {
    lines.push('');
    lines.push(`<i>${escapeHtml(battle.createdByName)} Распорядитель битвы, все вопросы к нему.</i>`);
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

function buildGameKeyboard(battle) {
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

async function syncLobby(battle, frozen) {
  const text = renderLobbyMessage(battle, frozen);
  const keyboard = frozen ? new InlineKeyboard() : (buildLobbyKeyboard(battle) || new InlineKeyboard());
  try {
    if (!battle.chatMessageId) {
      const msg = await botRef.api.sendMessage(battle.chatId, text, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      });
      db.prepare('UPDATE battles SET chat_message_id=? WHERE id=?').run(String(msg.message_id), battle.id);
    } else {
      await botRef.api.editMessageText(battle.chatId, Number(battle.chatMessageId), text, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      });
    }
  } catch (err) {
    if (!/message is not modified/i.test(err.message)) {
      console.error(`broadcast: не удалось обновить лобби-сообщение битвы ${battle.id}:`, err.message);
    }
  }
}

async function syncGame(battle) {
  const text = renderGameMessage(battle);
  const keyboard = buildGameKeyboard(battle) || new InlineKeyboard();
  let messageId = battle.chatGameMessageId ? Number(battle.chatGameMessageId) : null;
  try {
    if (!messageId) {
      const msg = await botRef.api.sendMessage(battle.chatId, text, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      });
      messageId = msg.message_id;
      db.prepare('UPDATE battles SET chat_game_message_id=? WHERE id=?').run(String(messageId), battle.id);
    } else {
      await botRef.api.editMessageText(battle.chatId, messageId, text, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      });
    }
  } catch (err) {
    if (!/message is not modified/i.test(err.message)) {
      console.error(`broadcast: не удалось обновить боевое сообщение битвы ${battle.id}:`, err.message);
    }
  }
  if (!messageId) return;

  // Закрепляем ровно один раз — в момент, когда бой реально стартовал.
  if (battle.status === 'playing' && !battle.chatPinned) {
    try {
      await botRef.api.pinChatMessage(battle.chatId, messageId, { disable_notification: true });
      db.prepare('UPDATE battles SET chat_pinned=1 WHERE id=?').run(battle.id);
    } catch (err) {
      console.error(`broadcast: не удалось закрепить сообщение битвы ${battle.id}:`, err.message);
    }
  }

  // Открепляем сами по завершении — но только если реально закрепляли.
  if ((battle.status === 'finished' || battle.status === 'cancelled') && battle.chatPinned) {
    try {
      await botRef.api.unpinChatMessage(battle.chatId, messageId);
      db.prepare('UPDATE battles SET chat_pinned=0 WHERE id=?').run(battle.id);
    } catch (err) { /* не критично, если уже откреплено */ }
  }
}

async function doSync(battle) {
  if (battle.status === 'lobby') {
    await syncLobby(battle, false);
    return;
  }
  if (battle.status === 'cancelled' && !battle.chatGameMessageId) {
    // Не набралось игроков — бой так и не стартовал: просто правим то же
    // лобби-сообщение на текст отмены, никакого нового сообщения не создаём.
    await syncLobby(battle, false);
    return;
  }
  // Бой стартовал: если ещё не публиковали боевое сообщение — это тот самый
  // момент перехода. "Замораживаем" лобби-сообщение (последний раз редактируем
  // его на "бой начался", снимаем клавиатуру) и публикуем НОВОЕ сообщение боя.
  if (!battle.chatGameMessageId) {
    await syncLobby(battle, true);
  }
  await syncGame(battle);
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
