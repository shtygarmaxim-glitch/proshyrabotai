const express = require('express');
const game = require('./game');
const admin = require('./admin');

function requireOwner(req, res, next) {
  if (!admin.isOwner(req.user)) return res.status(403).json({ error: 'Доступно только владельцу.' });
  next();
}

function buildRouter() {
  const router = express.Router();

  router.get('/battles', (req, res) => {
    res.json(game.listBattles());
  });

  router.get('/battles/:id', (req, res) => {
    const battle = game.getBattle(Number(req.params.id));
    if (!battle) return res.status(404).json({ error: 'Не найдено.' });
    res.json(battle);
  });

  router.post('/battles', (req, res) => {
    if (!admin.isAllowed(req.user)) {
      return res.status(403).json({ error: 'У тебя нет прав создавать битвы. Обратись к администратору клуба.' });
    }
    try {
      const b = game.createBattle(req.user, {
        prize: req.body.prize,
        minutes: Number(req.body.minutes),
        maxPlayers: Number(req.body.maxPlayers),
        winnersCount: Number(req.body.winnersCount),
        blanksCount: Number(req.body.blanksCount),
        password: req.body.password,
      });
      res.json(b);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  router.post('/battles/:id/join', (req, res) => {
    try {
      res.json(game.joinBattle(req.user, Number(req.params.id), req.body.password));
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  router.post('/battles/:id/shoot-self', (req, res) => {
    try {
      res.json(game.shootSelf(req.user, Number(req.params.id)));
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  router.post('/battles/:id/shoot-other', (req, res) => {
    try {
      res.json(game.shootOther(req.user, Number(req.params.id)));
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  router.get('/me', (req, res) => {
    const profile = game.getProfile(req.user);
    res.json(Object.assign({
      isOwner: admin.isOwner(req.user),
      canCreate: admin.isAllowed(req.user),
    }, profile));
  });

  router.post('/avatar', (req, res) => {
    try {
      res.json(game.setAvatar(req.user, req.body.avatar));
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // ---- Админка (только владелец) ----
  router.get('/admin/allowed', requireOwner, (req, res) => {
    res.json(admin.listAllowed());
  });

  router.post('/admin/allowed', requireOwner, (req, res) => {
    try {
      res.json(admin.addAllowed(req.body.identifier));
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  router.delete('/admin/allowed/:identifier', requireOwner, (req, res) => {
    res.json(admin.removeAllowed(req.params.identifier));
  });

  return router;
}

module.exports = buildRouter;
