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
// (МСК, UTC+3 круглый год — в России нет перехода на летнее время с 2014
// года) — у бота нет данных о часовом поясе конкретного игрока в чате.
//
// Считаем смещение вручную, а не через toLocaleDateString('ru-RU', ...):
// Intl с локалью 'ru-RU' и IANA-таймзоной требует полных ICU-данных, которых
// на многих минимальных сборках Node просто нет — тогда форматирование молча
// не применяется (либо съезжает на дефолтную локаль). Ручной расчёт по UTC
// работает всегда, независимо от того, что зашито в конкретной сборке Node.
const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;
function pad2(n) { return String(n).padStart(2, '0'); }
function formatAbsoluteStart(ts) {
  const d = new Date(ts + MSK_OFFSET_MS);
  const day = pad2(d.getUTCDate());
  const month = pad2(d.getUTCMonth() + 1);
  const hours = pad2(d.getUTCHours());
  const minutes = pad2(d.getUTCMinutes());
  return `${day}.${month} ${hours}:${minutes} МСК`;
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
    lines.push(battle.players.length ? 'Все, кто вступил, уже сидят за столом.' : 'Стол пока пуст.');
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
// Пока идёт "обычная" фаза (живых больше finalDuelSize) — полная карточка боя.
// Как только наступает финал (живых <= finalDuelSize) ИЛИ бой уже завершён —
// карточка урезается до двух строк: патроны и кол-во победителей. Всё
// остальное (Приз/Чат/Игроки/Распорядитель) и "Ход —" в неё больше не пишем:
// сам ход теперь виден отдельными сообщениями в чате (см. announceTurn ниже).
function renderGameMessage(battle) {
  const lines = [];
  lines.push('🔫 <b>ПРОТОКОЛ: БАРАБАН</b>');
  lines.push(STATUS_LABEL[battle.status] || '');
  lines.push('');

  const isFinalPhase = battle.status === 'finished' || battle.aliveCount <= battle.finalDuelSize;

  const info = [];
  if (isFinalPhase) {
    info.push(`<b>Патроны — 🔴 ${battle.liveLeft} боевых / ⚪ ${battle.blankLeft} холостых осталось</b>`);
    info.push(`<b>Кол-во победителей — ${battle.winnersCount}</b>`);
  } else {
    info.push(`<b>Приз — ${escapeHtml(battle.prize)}</b>`);
    if (battle.chatTitle) info.push(`<b>Чат — ${chatDisplay(battle)}</b>`);
    info.push(`<b>Кол-во победителей — ${battle.winnersCount}</b>`);
    info.push(`<b>Патроны — 🔴 ${battle.liveLeft} боевых / ⚪ ${battle.blankLeft} холостых осталось</b>`);
    info.push(`<b>Игроки — ${battle.players.length}/${battle.maxPlayers}</b>`);
  }
  lines.push(`<blockquote>${info.join('\n')}</blockquote>`);

  if (!isFinalPhase && battle.createdByName) {
    lines.push('');
    lines.push(`<i>${escapeHtml(battle.createdByName)} Распорядитель битвы, все вопросы к нему.</i>`);
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
  // Кнопки "В себя"/"В другого" теперь живут на отдельном сообщении хода
  // (см. announceTurn) — на самой закреплённой карточке боя клавиатуры нет.
  const keyboard = new InlineKeyboard();
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

// ---------- Отдельные сообщения хода ("Право стрелять...") ----------
// Каждый переход хода — это НОВОЕ сообщение в чате (не правка карточки боя).
// Когда игрок, за которым сейчас ход, стреляет — это же сообщение
// РЕДАКТИРУЕТСЯ в результат выстрела (resolveTurn), а следующий ход уже
// публикует своё, новое сообщение. Так в чате остаётся читаемая лента "кто
// в кого стрелял", без дублирования одного и того же лога в другом месте.

function turnMessageText(name, mode) {
  const n = `<b>${escapeHtml(name)}</b>`;
  if (mode === 'first') return `🔫 Право стрелять получает ${n}.`;
  if (mode === 'same') return `🔫 Право стрелять остаётся у ${n}.`;
  return `🔫 Право стрелять переходит к ${n}.`;
}

// Кнопки "В себя"/"В другого" показываем на сообщении хода только в финале
// (живых <= finalDuelSize) — до этого барабан стреляет сам, кнопки не нужны.
function buildTurnKeyboard(battle) {
  if (battle.status === 'playing' && battle.turnUserId && battle.aliveCount <= battle.finalDuelSize) {
    return new InlineKeyboard()
      .text('🔫 В себя', `shoot:self:${battle.id}`)
      .text('🎯 В другого', `shoot:other:${battle.id}`);
  }
  return undefined;
}

// Публикует новое сообщение хода и запоминает его id как "открытый" ход.
// mode: 'first' (самый первый ход битвы) | 'transfer' (перешёл к другому) |
// 'same' (холостой в себя — патрон остаётся у того же игрока).
async function announceTurn(battle, name, mode) {
  if (!botRef || !battle || !battle.chatId) return;
  const text = turnMessageText(name, mode);
  const keyboard = buildTurnKeyboard(battle) || new InlineKeyboard();
  try {
    const msg = await botRef.api.sendMessage(battle.chatId, text, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    });
    db.prepare('UPDATE battles SET chat_turn_message_id=? WHERE id=?').run(String(msg.message_id), battle.id);
  } catch (err) {
    console.error(`broadcast: не удалось отправить сообщение хода битвы ${battle.id}:`, err.message);
  }
}

// Редактирует текущее "открытое" сообщение хода в результат выстрела и
// закрывает его (сбрасывает chat_turn_message_id) — следующий ход опубликует
// уже новое сообщение, это редактировать второй раз больше не будем.
async function resolveTurn(battle, resultText) {
  if (!botRef || !battle || !battle.chatId || !battle.chatTurnMessageId) return;
  try {
    await botRef.api.editMessageText(battle.chatId, Number(battle.chatTurnMessageId), `🔫 ${resultText}`, {
      parse_mode: 'HTML',
    });
  } catch (err) {
    if (!/message is not modified/i.test(err.message)) {
      console.error(`broadcast: не удалось отредактировать сообщение хода битвы ${battle.id}:`, err.message);
    }
  } finally {
    db.prepare('UPDATE battles SET chat_turn_message_id=NULL WHERE id=?').run(battle.id);
  }
}

// Простое одноразовое уведомление в чат в момент старта боя ("барабан
// заряжен, погнали") — отдельное новое сообщение, ничего дальше не правит.
async function announceLoaded(battle) {
  if (!botRef || !battle || !battle.chatId) return;
  const text = `🔫 Барабан заряжен: ${battle.players.length} боевых / ${battle.blanksCount} холостых. Погнали!`;
  try {
    await botRef.api.sendMessage(battle.chatId, text, { parse_mode: 'HTML' });
  } catch (err) {
    console.error(`broadcast: не удалось отправить стартовое уведомление битвы ${battle.id}:`, err.message);
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

module.exports = { init, sync, assertUsableChat, announceTurn, resolveTurn, announceLoaded };
