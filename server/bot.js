const { Bot, InlineKeyboard } = require('grammy');
const admin = require('./admin');

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
