const express = require('express');
const router = express.Router();
const ToolsController = require('../controllers/toolsController');

// NIK Check
router.get('/nik-check', ToolsController.nikCheck);

// Subdomain Finder
router.get('/subdomain-finder', ToolsController.subdomainFinder);

// ChatAI - Generate New Session
router.get('/chat/new-session', ToolsController.generateNewSession);

// ChatAI - Send Message
router.get('/chat/send', ToolsController.sendMessage);

// ChatAI - Get Chat History
router.get('/chat/history', ToolsController.getChatHistory);

// ChatAI - Delete Chat History
router.get('/chat/delete', ToolsController.deleteChatHistory);

// ChatAI - Get User Chat History List
router.get('/chat/list', ToolsController.getChatHistoryList);

// Telegram Login - Unified
router.get('/telegram/login', ToolsController.initiateUnifiedTelegramLogin);
router.get('/telegram/auth', ToolsController.submitTelegramAuth);
router.get('/telegram/status', ToolsController.checkLoginStatus);

// Telegram Sessions
router.get('/telegram/sessions', ToolsController.getTelegramSessions);
router.get('/telegram/remove-ses', ToolsController.removeTeleSes);
router.get('/telegram/refresh-sessions', ToolsController.refreshTelegramSessions);

// Telegram Session Password
router.post('/telegram/verify-session-password', ToolsController.verifySessionPassword);

// Spam Report
router.post('/telegram/spam-report', ToolsController.startSpamReport);
router.get('/telegram/report-status', ToolsController.getSpamReportStatus);
router.post('/telegram/send-report', ToolsController.sendReportToTelegram);

module.exports = router;