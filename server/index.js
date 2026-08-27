require('dotenv').config();
const path = require('path');
const express = require('express');
const { authMiddleware } = require('./auth');
const buildRouter = require('./routes');
const createBot = require('./bot');
const game = require('./game');

const BOT_TOKEN = process.env.BOT_TOKEN;
// Принимаем оба названия переменной — на случай если в хостинге она называется WEBAPP_URL
const PUBLIC_URL = process.env.PUBLIC_URL || process.env.WEBAPP_URL;
const PORT = process.env.PORT || 3000;
const isDev = process.env.NODE_ENV !== 'production';

if (!BOT_TOKEN) {
  console.error('Не задан BOT_TOKEN в .env — возьми его у @BotFather.');
  process.exit(1);
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// Все запросы к /api/* должны прийти из настоящего Telegram Mini App
app.use('/api', authMiddleware(BOT_TOKEN, { allowDevFallback: isDev }), buildRouter());

app.listen(PORT, () => {
  console.log(`Сервер и Mini App слушают порт ${PORT}`);
});

// Раз в 5 секунд закрываем лобби, у которых истёк таймер
setInterval(() => game.resolveExpiredLobbies(), 5000);

// Раз в 2 секунды проверяем, не завис ли кто-то с пистолетом дольше 15 секунд
setInterval(() => game.checkTurnTimeouts(), 2000);

// Бот работает в том же процессе через long polling
if (PUBLIC_URL) {
  const bot = createBot(BOT_TOKEN, PUBLIC_URL);
  bot.start();
  console.log('Бот запущен (long polling). Mini App URL:', PUBLIC_URL);
} else {
  console.warn('PUBLIC_URL не задан — бот не запущен, но сервер и API работают.');
}
