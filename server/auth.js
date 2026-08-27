const crypto = require('crypto');

/**
 * Проверяет initData, который Telegram Mini App передаёт на фронтенде
 * (window.Telegram.WebApp.initData), и достаёт из него данные пользователя.
 * Алгоритм — официальный, см. https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */
function validateInitData(initData, botToken) {
  if (!initData) return null;

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');

  const pairs = [];
  for (const [key, value] of params.entries()) pairs.push(`${key}=${value}`);
  pairs.sort();
  const dataCheckString = pairs.join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  if (computedHash !== hash) return null;

  const authDate = parseInt(params.get('auth_date') || '0', 10);
  const ageSeconds = Date.now() / 1000 - authDate;
  if (ageSeconds > 86400) return null; // старше суток — считаем протухшим

  const userRaw = params.get('user');
  if (!userRaw) return null;
  const user = JSON.parse(userRaw);

  return {
    id: String(user.id),
    username: user.username || null,
    name: user.username ? `@${user.username}` : [user.first_name, user.last_name].filter(Boolean).join(' '),
  };
}

// Express-мидлварь: требует заголовок X-Telegram-Init-Data, кладёт req.user
function authMiddleware(botToken, { allowDevFallback = false } = {}) {
  return (req, res, next) => {
    const initData = req.header('X-Telegram-Init-Data');
    const user = validateInitData(initData, botToken);
    if (user) {
      req.user = user;
      return next();
    }
    if (allowDevFallback) {
      // Только для локальной разработки без реального Telegram-клиента.
      // ID владельца — чтобы локально были видны и создание битв, и админка.
      req.user = { id: String(process.env.OWNER_ID || '618124780'), username: null, name: 'Тест-пилот (dev)' };
      return next();
    }
    return res.status(401).json({ error: 'Не удалось подтвердить пользователя Telegram.' });
  };
}

module.exports = { validateInitData, authMiddleware };
