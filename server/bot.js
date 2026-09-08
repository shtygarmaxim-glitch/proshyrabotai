const { Bot, InlineKeyboard } = require('grammy');
const admin = require('./admin');
const game = require('./game');

function createBot(botToken, publicUrl) {
  const bot = new Bot(botToken);

  const openKeyboard = () => new InlineKeyboard().webApp('🔫 Открыть барабан', publicUrl);

  bot.command('start', async (ctx) => {
    const user = { id: String(ctx.from.id), username: ctx.from.username || null };

    let text;
    if (admin.isOwner(user)) {
      text =
        '⚡ ПРОТОКОЛ: БАРАБАН ⚡\n\n' +
        'Ты владелец клуба. Тебе доступны создание битв без ограничений и вкладка ' +
        '«Админ» в приложении — там можно выдавать доступ на создание битв другим людям ' +
        'по их Telegram ID или @username.';
    } else if (admin.isAllowed(user)) {
      text =
        '⚡ ПРОТОКОЛ: БАРАБАН ⚡\n\n' +
        'У тебя есть доступ создавать битвы. Жми кнопку ниже, чтобы открыть барабан.';
    } else {
      text =
        '⚡ ПРОТОКОЛ: БАРАБАН ⚡\n\n' +
        'Один стол. Один барабан. Один приз.\n\n' +
        'Заходи в приложение, чтобы участвовать в битвах и следить за статистикой. ' +
        'Создавать свои битвы могут только доверенные участники клуба — если нужен доступ, ' +
        'напиши администратору.';
    }

    await ctx.reply(text, { reply_markup: openKeyboard() });
  });

  bot.command('help', async (ctx) => {
    await ctx.reply(
      'Как это работает:\n' +
      '1. Открой приложение кнопкой ниже.\n' +
      '2. Во вкладке «Пистолет» смотри текущие бои и присоединяйся.\n' +
      '3. Во вкладке «Профиль» — твоя статистика, аксессуары и достижения.\n\n' +
      'Команды: /start — открыть приложение, /help — эта подсказка.',
      { reply_markup: openKeyboard() }
    );
  });

  // Кнопка "Вступить" под живым сообщением битвы в чате — присоединяет к
  // битве прямо оттуда, без захода в Mini App.
  bot.callbackQuery(/^join:(\d+)$/, async (ctx) => {
    const battleId = Number(ctx.match[1]);
    const from = ctx.from;
    const user = {
      id: String(from.id),
      name: from.username ? `@${from.username}` : [from.first_name, from.last_name].filter(Boolean).join(' '),
    };
    try {
      game.joinBattle(user, battleId);
      await ctx.answerCallbackQuery({ text: '✅ Ты за столом.' });
    } catch (err) {
      await ctx.answerCallbackQuery({ text: err.message, show_alert: true });
    }
  });

  // Кнопки "В себя" / "В другого" из ЛС-уведомления о ходе в финале —
  // позволяют выстрелить прямо из чата, без захода в Mini App.
  bot.callbackQuery(/^shoot:(self|other):(\d+)$/, async (ctx) => {
    const [, mode, battleIdStr] = ctx.match;
    const battleId = Number(battleIdStr);
    const from = ctx.from;
    const user = {
      id: String(from.id),
      name: from.username ? `@${from.username}` : [from.first_name, from.last_name].filter(Boolean).join(' '),
    };
    try {
      if (mode === 'self') {
        game.shootSelf(user, battleId);
      } else {
        game.shootOther(user, battleId);
      }
      await ctx.answerCallbackQuery({ text: mode === 'self' ? '🔫 Выстрелил в себя.' : '🎯 Выстрелил в другого.' });
      // Само боевое сообщение (текст + клавиатура — новый ход/новые кнопки)
      // уже обновляется через game.shootSelf/shootOther -> broadcast.sync,
      // так что здесь больше НЕ трогаем клавиатуру вручную: раньше был
      // отдельный ctx.editMessageReplyMarkup() без аргументов, который снимал
      // клавиатуру целиком — он выполнялся асинхронно и мог обогнать/перебить
      // тот самый sync с уже правильными новыми кнопками, из-за чего кнопки
      // после выстрела иногда пропадали насовсем, до следующего события боя.
    } catch (err) {
      await ctx.answerCallbackQuery({ text: err.message, show_alert: true });
    }
  });

  // Любое другое сообщение (не команду) тоже не оставляем без ответа
  bot.on('message', async (ctx) => {
    await ctx.reply('Я живу внутри Mini App — жми кнопку 👇', { reply_markup: openKeyboard() });
  });

  bot.catch((err) => {
    console.error('Bot error:', err);
  });

  return bot;
}

module.exports = createBot;
