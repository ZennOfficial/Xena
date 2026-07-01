const express = require('express');
const router = express.Router();
const chatController = require('../controllers/chatController');

router.post('/get-public-chat', chatController.getChat);

router.post('/send-public-chat', chatController.sendChat);

module.exports = router;