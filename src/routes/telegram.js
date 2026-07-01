const express = require('express');
const router = express.Router();
const telegramController = require('../controllers/telegramController');

// Alamat API: domain.com/telegram/send-code
router.post('/send-code', telegramController.sendCode);

// Alamat API: domain.com/telegram/login
router.post('/login', telegramController.login);

// Alamat API: domain.com/telegram/sessions
router.get('/sessions', telegramController.getSessions);

// Alamat API: domain.com/telegram/report
router.post('/report', telegramController.report);

module.exports = router;