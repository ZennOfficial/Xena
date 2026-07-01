const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { logger } = require('../utils/logger');
const { activeKeys } = require('../middleware/authMiddleware');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { Api } = require('telegram');
const crypto = require('crypto');

// Direktori utama untuk menyimpan data chat history
const CHAT_HISTORY_DIR = path.join(__dirname, '../data/chatHistory');
// Direktori untuk menyimpan sesi Telegram
const TELEGRAM_SESSIONS_DIR = path.join(__dirname, '../data/telegramSessions');
// Direktori untuk menyimpan laporan spam
const SPAM_REPORTS_DIR = path.join(__dirname, '../data/spamReports');

// Pastikan direktori utama ada
if (!fs.existsSync(CHAT_HISTORY_DIR)) {
  fs.mkdirSync(CHAT_HISTORY_DIR, { recursive: true });
}

if (!fs.existsSync(TELEGRAM_SESSIONS_DIR)) {
  fs.mkdirSync(TELEGRAM_SESSIONS_DIR, { recursive: true });
}

if (!fs.existsSync(SPAM_REPORTS_DIR)) {
  fs.mkdirSync(SPAM_REPORTS_DIR, { recursive: true });
}

// Konfigurasi API Telegram (sesuaikan dengan kebutuhan)
const TELEGRAM_API_ID = process.env.TELEGRAM_API_ID || 38406579; // Ganti dengan API ID Anda
const TELEGRAM_API_HASH = process.env.TELEGRAM_API_HASH || "b8f39893d25dc790f241e345d949129c"; // Ganti dengan API Hash Anda

// In-memory storage untuk login yang sedang berlangsung
const pendingLogins = new Map();
// In-memory storage untuk laporan spam yang sedang berjalan
const activeReports = new Map();
// In-memory storage untuk verifikasi password session yang sedang berlangsung
const sessionPasswordVerifications = new Map();

// Jalankan cleanup setiap 5 menit
setInterval(() => {
    ToolsController.cleanupExpiredLogins();
}, 300000);

class ToolsController {
  // Helper function untuk validasi key
  static validateKey(key) {
    const keyInfo = activeKeys[key];
    if (!keyInfo) {
      return { valid: false, message: "Invalid key." };
    }
    return { valid: true, keyInfo };
  }

  // Helper function untuk mendapatkan path direktori user
  static getUserDir(username) {
    const userDir = path.join(CHAT_HISTORY_DIR, username);
    if (!fs.existsSync(userDir)) {
      fs.mkdirSync(userDir, { recursive: true });
    }
    return userDir;
  }

  // Helper function untuk mendapatkan path direktori sesi Telegram user
  static getUserTelegramDir(username) {
    const userDir = path.join(TELEGRAM_SESSIONS_DIR, username);
    if (!fs.existsSync(userDir)) {
      fs.mkdirSync(userDir, { recursive: true });
    }
    return userDir;
  }

  // Helper function untuk menyimpan chat history
  static saveChatHistory(sessionId, username, message, isAI = false) {
    try {
      const userDir = ToolsController.getUserDir(username);
      const sessionFile = path.join(userDir, `${sessionId}.json`);
      let chatHistory = [];
      
      // Jika file sudah ada, baca kontennya
      if (fs.existsSync(sessionFile)) {
        const data = fs.readFileSync(sessionFile, 'utf-8');
        chatHistory = JSON.parse(data);
      }
      
      // Tambahkan pesan baru
      chatHistory.push({
        username,
        message,
        isAI, // Tambahkan flag untuk menandai pesan dari AI
        timestamp: new Date().toISOString()
      });
      
      // Simpan kembali ke file
      fs.writeFileSync(sessionFile, JSON.stringify(chatHistory, null, 2));
      return true;
    } catch (error) {
      logger.error(`Error saving chat history: ${error.message}`);
      return false;
    }
  }

  // Helper function untuk membaca chat history
  static getChatHistoryHelper(sessionId, username) {
    try {
      const userDir = ToolsController.getUserDir(username);
      const sessionFile = path.join(userDir, `${sessionId}.json`);
      if (!fs.existsSync(sessionFile)) {
        return [];
      }
      const data = fs.readFileSync(sessionFile, 'utf-8');
      return JSON.parse(data);
    } catch (error) {
      logger.error(`Error reading chat history: ${error.message}`);
      return [];
    }
  }

  // Helper function untuk menghapus chat history
  static deleteChatHistoryHelper(sessionId, username) {
    try {
      const userDir = ToolsController.getUserDir(username);
      const sessionFile = path.join(userDir, `${sessionId}.json`);
      if (fs.existsSync(sessionFile)) {
        fs.unlinkSync(sessionFile);
        return true;
      }
      return false;
    } catch (error) {
      logger.error(`Error deleting chat history: ${error.message}`);
      return false;
    }
  }

  // Helper function untuk mendapatkan daftar session chat history untuk user tertentu
  static getChatHistoryListHelper(username) {
    try {
      const userDir = ToolsController.getUserDir(username);
      const files = fs.readdirSync(userDir);
      const sessionList = [];
      
      files.forEach(file => {
        if (file.endsWith('.json')) {
          const sessionId = file.replace('.json', '');
          const sessionFile = path.join(userDir, file);
          const stats = fs.statSync(sessionFile);
          
          // Baca beberapa pesan pertama untuk preview
          const chatHistory = ToolsController.getChatHistoryHelper(sessionId, username);
          const preview = chatHistory.length > 0 ? chatHistory[0].message.substring(0, 50) + '...' : 'No messages';
          
          sessionList.push({
            sessionId,
            username,
            lastModified: stats.mtime,
            messageCount: chatHistory.length,
            preview
          });
        }
      });
      
      return sessionList.sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified));
    } catch (error) {
      logger.error(`Error getting chat history list: ${error.message}`);
      return [];
    }
  }

  // Helper function untuk menyimpan sesi Telegram
  static saveTelegramSession(username, phone, sessionString) {
    try {
      const userDir = ToolsController.getUserTelegramDir(username);
      const sessionFile = path.join(userDir, `${phone.replace('+', '')}.txt`);
      
      fs.writeFileSync(sessionFile, sessionString);
      return true;
    } catch (error) {
      logger.error(`Error saving Telegram session: ${error.message}`);
      return false;
    }
  }

  // Helper function untuk membaca sesi Telegram
  static getTelegramSession(username, phone) {
    try {
      const userDir = ToolsController.getUserTelegramDir(username);
      const sessionFile = path.join(userDir, `${phone.replace('+', '')}.txt`);
      
      if (!fs.existsSync(sessionFile)) {
        return null;
      }
      
      return fs.readFileSync(sessionFile, 'utf-8');
    } catch (error) {
      logger.error(`Error reading Telegram session: ${error.message}`);
      return null;
    }
  }

  // Helper function untuk menghapus sesi Telegram
  static deleteTelegramSession(username, phone) {
    try {
      const userDir = ToolsController.getUserTelegramDir(username);
const sessionFile = path.join(
  userDir,
  `${phone.replace(/\D/g, '')}.txt`
);
      console.log(sessionFile)
      if (fs.existsSync(sessionFile)) {
        fs.unlinkSync(sessionFile);
        return true;
      }
      return false;
    } catch (error) {
      logger.error(`Error deleting Telegram session: ${error.message}`);
      return false;
    }
  }

  // Helper function untuk mendapatkan daftar sesi Telegram user
  static getTelegramSessionsList(username) {
    try {
      const userDir = ToolsController.getUserTelegramDir(username);
      const files = fs.readdirSync(userDir);
      const sessionsList = [];
      
      files.forEach(file => {
        if (file.endsWith('.txt')) {
          const phone = `+${file.replace('.txt', '')}`;
          const sessionFile = path.join(userDir, file);
          const stats = fs.statSync(sessionFile);
          
          sessionsList.push({
            phone,
            username,
            lastModified: stats.mtime,
            filePath: sessionFile,
            isActive: true // Asumsikan aktif, akan diperiksa saat refresh
          });
        }
      });
      
      return sessionsList.sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified));
    } catch (error) {
      logger.error(`Error getting Telegram sessions list: ${error.message}`);
      return [];
    }
  }

  // Helper function untuk memeriksa apakah sesi Telegram masih aktif
  static async checkTelegramSession(username, phone) {
    try {
      const sessionString = ToolsController.getTelegramSession(username, phone);
      if (!sessionString) {
        return false;
      }
      
      const client = new TelegramClient(new StringSession(sessionString), TELEGRAM_API_ID, TELEGRAM_API_HASH, {
          connectionRetries: 5,
          timeout: 30000,
          floodSleepThreshold: 120,
          retryDelay: 2000,
          autoReconnect: true,
          // Disable update loop to prevent timeout errors
          updateWorkers: 0
      });
      
      await client.connect();
      await client.getMe();
      await client.disconnect();
      
      return true;
    } catch (error) {
      logger.error(`Error checking Telegram session ${phone}: ${error.message}`);
      return false;
    }
  }

  // Helper function untuk menyimpan laporan spam
  static saveSpamReport(reportId, reportData) {
    try {
      const reportFile = path.join(SPAM_REPORTS_DIR, `${reportId}.json`);
      fs.writeFileSync(reportFile, JSON.stringify(reportData, null, 2));
      return true;
    } catch (error) {
      logger.error(`Error saving spam report: ${error.message}`);
      return false;
    }
  }

  // Helper function untuk membaca laporan spam
  static getSpamReport(reportId) {
    try {
      const reportFile = path.join(SPAM_REPORTS_DIR, `${reportId}.json`);
      
      if (!fs.existsSync(reportFile)) {
        return null;
      }
      
      const data = fs.readFileSync(reportFile, 'utf-8');
      return JSON.parse(data);
    } catch (error) {
      logger.error(`Error reading spam report: ${error.message}`);
      return null;
    }
  }

  // Helper function untuk menghasilkan data pengguna acak
  static generateRandomUser() {
    const firstNames = ['John', 'Jane', 'Michael', 'Sarah', 'David', 'Emily', 'Robert', '...']; // Tambahkan lebih banyak nama
    const lastNames = ['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', '...']; // Tambahkan lebih banyak nama
    
    const firstName = firstNames[Math.floor(Math.random() * firstNames.length)];
    const lastName = lastNames[Math.floor(Math.random() * lastNames.length)];
    const legal_name = `${firstName} ${lastName}`;
    
    // Generate email based on name
    const domains = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com'];
    const domain = domains[Math.floor(Math.random() * domains.length)];
    const email = `${firstName.toLowerCase()}.${lastName.toLowerCase()}${Math.floor(Math.random() * 100)}@${domain}`;
    
    // Generate phone number (US format as example)
    const phone = `+1${Math.floor(Math.random() * 900) + 100}${Math.floor(Math.random() * 9000000) + 1000000}`;
    
    return { legal_name, email, phone };
  }

  // Helper untuk cleanup expired logins
  static cleanupExpiredLogins() {
    const now = Date.now();
    for (const [loginId, data] of pendingLogins.entries()) {
      // Jika login sudah lebih dari 5 menit, hapus
      if (now - data.createdAt > 300000) {
        logger.info(`[TELEGRAM LOGIN] Cleaning up expired loginId: ${loginId}`);
        
        // Disconnect client jika ada
        if (data.client) {
          try {
            data.client.disconnect();
          } catch (e) {}
        }
        
        pendingLogins.delete(loginId);
      }
    }
  }

  // 1. NIK Check
  static async nikCheck(req, res) {
    const { key, nik } = req.query;
    logger.info(`[NIK CHECK] Request NIK check by key '${key}'`);

    const validation = ToolsController.validateKey(key);
    if (!validation.valid) {
      logger.info("[❌ NIK CHECK] Key tidak valid.");
      return res.json({ valid: false, error: true, message: validation.message });
    }

    if (!nik) {
      logger.info("[❌ NIK CHECK] NIK tidak disediakan.");
      return res.json({ valid: false, error: true, message: "NIK parameter is required." });
    }

    try {
      const response = await axios.get(`https://api.siputzx.my.id/api/tools/nik-checker?nik=${nik}`);
      logger.info(`[✅ NIK CHECK] NIK check successful for ${nik}`);
      return res.json(response.data);
    } catch (error) {
      logger.error(`[❌ NIK CHECK] Error: ${error.message}`);
      return res.json({ 
        valid: false, 
        error: true, 
        message: "Failed to check NIK. Please try again later." 
      });
    }
  }

  // 2. Subdomain Finder
  static async subdomainFinder(req, res) {
    const { key, domain } = req.query;
    logger.info(`[SUBDOMAIN FINDER] Request subdomain finder for '${domain}' by key '${key}'`);

    const validation = ToolsController.validateKey(key);
    if (!validation.valid) {
      logger.info("[❌ SUBDOMAIN FINDER] Key tidak valid.");
      return res.json({ valid: false, error: true, message: validation.message });
    }

    if (!domain) {
      logger.info("[❌ SUBDOMAIN FINDER] Domain tidak disediakan.");
      return res.json({ valid: false, error: true, message: "Domain parameter is required." });
    }

    try {
      const response = await axios.get(`https://api.siputzx.my.id/api/tools/subdomains?domain=${domain}`);
      logger.info(`[✅ SUBDOMAIN FINDER] Subdomain finder successful for ${domain}`);
      return res.json(response.data);
    } catch (error) {
      logger.error(`[❌ SUBDOMAIN FINDER] Error: ${error.message}`);
      return res.json({ 
        valid: false, 
        error: true, 
        message: "Failed to find subdomains. Please try again later." 
      });
    }
  }

  // 3. ChatAI - Generate New Session
  static async generateNewSession(req, res) {
    const { key } = req.query;
    logger.info(`[CHAT AI] Generate new session by key '${key}'`);

    const validation = ToolsController.validateKey(key);
    if (!validation.valid) {
      logger.info("[❌ CHAT AI] Key tidak valid.");
      return res.json({ valid: false, error: true, message: validation.message });
    }

    try {
      // Generate session ID baru
      const sessionId = uuidv4();
      const username = validation.keyInfo.username;
      
      // Buat direktori user jika belum ada
      const userDir = ToolsController.getUserDir(username);
      
      // Buat file kosong untuk session baru di direktori user
      const sessionFile = path.join(userDir, `${sessionId}.json`);
      fs.writeFileSync(sessionFile, JSON.stringify([]));
      
      logger.info(`[✅ CHAT AI] New session generated: ${sessionId} for user ${username}`);
      return res.json({ 
        valid: true, 
        sessionId,
        username,
        message: "New session created successfully." 
      });
    } catch (error) {
      logger.error(`[❌ CHAT AI] Error generating new session: ${error.message}`);
      return res.json({ 
        valid: false, 
        error: true, 
        message: "Failed to generate new session." 
      });
    }
  }

  // 4. ChatAI - Send Message
  static async sendMessage(req, res) {
    const { key, session, message } = req.query;
    logger.info(`[CHAT AI] Send message to session '${session}' by key '${key}'`);

    const validation = ToolsController.validateKey(key);
    if (!validation.valid) {
      logger.info("[❌ CHAT AI] Key tidak valid.");
      return res.json({ valid: false, error: true, message: validation.message });
    }

    if (!session || !message) {
      logger.info("[❌ CHAT AI] Session atau message tidak disediakan.");
      return res.json({ 
        valid: false, 
        error: true, 
        message: "Session and message parameters are required." 
      });
    }

    try {
      // Simpan pesan user ke history
      const username = validation.keyInfo.username;
      ToolsController.saveChatHistory(session, username, message, false); // Pesan user dengan isAI = false
      
      // Kirim pesan ke API ChatAI
      const response = await axios.get(
        `https://api.neoxr.eu/api/gpt4-session?q=${encodeURIComponent(message)}&session=${session}&apikey=RadzzOffc_Gamteng`
      );
      
      // Simpan respons AI ke history dengan username yang sama dengan user, tapi dengan isAI = true
      if (response.data.status && response.data.data.message) {
        ToolsController.saveChatHistory(session, username, response.data.data.message, true);
      }
      
      logger.info(`[✅ CHAT AI] Message sent to session ${session}`);
      return res.json(response.data);
    } catch (error) {
      logger.error(`[❌ CHAT AI] Error sending message: ${error.message}`);
      return res.json({ 
        valid: false, 
        error: true, 
        message: "Failed to send message. Please try again later." 
      });
    }
  }

  // 5. ChatAI - Get Chat History (Express route handler)
  static async getChatHistory(req, res) {
    const { key, session } = req.query;
    logger.info(`[CHAT AI] Get chat history for session '${session}' by key '${key}'`);

    const validation = ToolsController.validateKey(key);
    if (!validation.valid) {
      logger.info("[❌ CHAT AI] Key tidak valid.");
      return res.json({ valid: false, error: true, message: validation.message });
    }

    if (!session) {
      logger.info("[❌ CHAT AI] Session tidak disediakan.");
      return res.json({ 
        valid: false, 
        error: true, 
        message: "Session parameter is required." 
      });
    }

    try {
      const username = validation.keyInfo.username;
      const chatHistory = ToolsController.getChatHistoryHelper(session, username);
      logger.info(`[✅ CHAT AI] Retrieved chat history for session ${session}`);
      return res.json({ 
        valid: true, 
        sessionId: session,
        chatHistory 
      });
    } catch (error) {
      logger.error(`[❌ CHAT AI] Error getting chat history: ${error.message}`);
      return res.json({ 
        valid: false, 
        error: true, 
        message: "Failed to get chat history." 
      });
    }
  }

  // 6. ChatAI - Delete Chat History (Express route handler)
  static async deleteChatHistory(req, res) {
    const { key, session } = req.query;
    logger.info(`[CHAT AI] Delete chat history for session '${session}' by key '${key}'`);

    const validation = ToolsController.validateKey(key);
    if (!validation.valid) {
      logger.info("[❌ CHAT AI] Key tidak valid.");
      return res.json({ valid: false, error: true, message: validation.message });
    }

    if (!session) {
      logger.info("[❌ CHAT AI] Session tidak disediakan.");
      return res.json({ 
        valid: false, 
        error: true, 
        message: "Session parameter is required." 
      });
    }

    try {
      const username = validation.keyInfo.username;
      const success = ToolsController.deleteChatHistoryHelper(session, username);
      if (success) {
        logger.info(`[✅ CHAT AI] Deleted chat history for session ${session}`);
        return res.json({ 
          valid: true, 
          sessionId: session,
          message: "Chat history deleted successfully." 
        });
      } else {
        logger.info(`[❌ CHAT AI] Session ${session} not found`);
        return res.json({ 
          valid: false, 
          error: true, 
          message: "Session not found." 
        });
      }
    } catch (error) {
      logger.error(`[❌ CHAT AI] Error deleting chat history: ${error.message}`);
      return res.json({ 
        valid: false, 
        error: true, 
        message: "Failed to delete chat history." 
      });
    }
  }

  // 7. ChatAI - Get User Chat History List (Express route handler)
  static async getChatHistoryList(req, res) {
    // Check if req.query exists
    if (!req || !req.query) {
      logger.error("[❌ CHAT AI] Request or query is undefined");
      return res.status(400).json({ 
        valid: false, 
        error: true, 
        message: "Invalid request" 
      });
    }

    const { key } = req.query;
    logger.info(`[CHAT AI] Get chat history list by key '${key}'`);

    const validation = ToolsController.validateKey(key);
    if (!validation.valid) {
      logger.info("[❌ CHAT AI] Key tidak valid.");
      return res.json({ valid: false, error: true, message: validation.message });
    }

    try {
      const username = validation.keyInfo.username;
      const chatHistoryList = ToolsController.getChatHistoryListHelper(username);
      logger.info(`[✅ CHAT AI] Retrieved chat history list for user ${username}`);
      return res.json({ 
        valid: true, 
        username,
        chatHistoryList 
      });
    } catch (error) {
      logger.error(`[❌ CHAT AI] Error getting chat history list: ${error.message}`);
      return res.json({ 
        valid: false, 
        error: true, 
        message: "Failed to get chat history list." 
      });
    }
  }

  // ==========================================
  // TELEGRAM SPAM REPORT FEATURES
  // ==========================================

  // 8. Initiate Unified Telegram Login
  static async initiateUnifiedTelegramLogin(req, res) {
    const { key, phone } = req.query;
    logger.info(`[TELEGRAM LOGIN] Initiate unified login for phone '${phone}' by key '${key}'`);

    const validation = ToolsController.validateKey(key);
    if (!validation.valid) {
      return res.json({ valid: false, error: true, message: validation.message });
    }

    if (!phone) {
      return res.json({ valid: false, error: true, message: "Phone number is required" });
    }

    const phoneFormatted = phone.startsWith('+') ? phone : `+${phone}`;
    const loginId = uuidv4();
    const username = validation.keyInfo.username;

    const client = new TelegramClient(
      new StringSession(""),
      TELEGRAM_API_ID,
      TELEGRAM_API_HASH,
      {
          connectionRetries: 5,
          timeout: 30000,
          floodSleepThreshold: 120,
          retryDelay: 2000,
          autoReconnect: true,
          // Disable update loop to prevent timeout errors
          updateWorkers: 0
 }
    );

    pendingLogins.set(loginId, {
      username,
      phone: phoneFormatted,
      client,
      step: 'wait_code',
      resolve: null,
      createdAt: Date.now()
    });

    (async () => {
      try {
        await client.start({
          phoneNumber: async () => phoneFormatted,

          phoneCode: async () => {
            return new Promise((resolve) => {
              const data = pendingLogins.get(loginId);
              if (!data) throw new Error("Login expired");

              data.step = 'wait_code';
              data.resolve = resolve;
              pendingLogins.set(loginId, data);
            });
          },

          password: async () => {
            return new Promise((resolve) => {
              const data = pendingLogins.get(loginId);
              if (!data) throw new Error("Login expired");

              data.step = 'wait_password';
              data.resolve = resolve;
              pendingLogins.set(loginId, data);
            });
          },

          onError: (err) => {
            logger.error(`[TELEGRAM LOGIN] Error: ${err.message}`);
          }
        });

        // Login berhasil
        const sessionString = client.session.save();
        ToolsController.saveTelegramSession(username, phoneFormatted, sessionString);
        pendingLogins.delete(loginId);

      } catch (err) {
        logger.error(`[TELEGRAM LOGIN] Login failed: ${err.message}`);
        pendingLogins.delete(loginId);
        try { await client.disconnect(); } catch {}
      }
    })();

    return res.json({
      valid: true,
      loginId,
      step: 'wait_code',
      message: "OTP sent, please submit code"
    });
  }

  // 9. Submit Telegram Auth (OTP atau password)
  static async submitTelegramAuth(req, res) {
    const { key, loginId, input } = req.query;
    logger.info(`[TELEGRAM LOGIN] Submit auth input for loginId '${loginId}' by key '${key}'`);

    const validation = ToolsController.validateKey(key);
    if (!validation.valid) {
      return res.json({ valid: false, error: true, message: validation.message });
    }

    const loginData = pendingLogins.get(loginId);
    if (!loginData) {
      return res.json({ valid: false, error: true, message: "Invalid or expired login" });
    }

    if (!loginData.resolve) {
      return res.json({ valid: false, error: true, message: "Not waiting for input" });
    }

    // Resolve input untuk melanjutkan proses login
    loginData.resolve(input);
    loginData.resolve = null;

    // Cek langkah selanjutnya
    if (loginData.step === 'wait_code') {
      return res.json({
        valid: true,
        step: 'wait_password',
        message: "OTP accepted. If 2FA is enabled, please submit password."
      });
    } else if (loginData.step === 'wait_password') {
      return res.json({
        valid: true,
        step: 'completed',
        message: "Password accepted. Login process completing..."
      });
    }

    return res.json({
      valid: true,
      step: loginData.step,
      message: "Authentication in progress..."
    });
  }

  // 10. Check Login Status
  static async checkLoginStatus(req, res) {
    const { key, loginId } = req.query;
    logger.info(`[TELEGRAM LOGIN] Check status for loginId '${loginId}' by key '${key}'`);

    const validation = ToolsController.validateKey(key);
    if (!validation.valid) {
      return res.json({ valid: false, error: true, message: validation.message });
    }

    const loginData = pendingLogins.get(loginId);
    if (!loginData) {
      // Cek apakah login sudah selesai dengan memeriksa sesi
      const username = validation.keyInfo.username;
      const sessions = ToolsController.getTelegramSessionsList(username);
      const recentSession = sessions.find(s => 
        new Date(s.lastModified) > new Date(Date.now() - 60000) // Sesi yang dibuat dalam 1 menit terakhir
      );
      
      if (recentSession) {
        return res.json({
          valid: true,
          completed: true,
          phone: recentSession.phone,
          message: "Login completed successfully"
        });
      }
      
      return res.json({ valid: false, error: true, message: "Invalid or expired login" });
    }

    return res.json({
      valid: true,
      completed: false,
      step: loginData.step,
      message: `Waiting for ${loginData.step.replace('wait_', '')}`
    });
  }

  // 11. Verify Session Password (Untuk session yang sudah ada)
  static async verifySessionPassword(req, res) {
    const { key, phone, password } = req.body;
    logger.info(`[TELEGRAM SESSION] Verify password for session '${phone}' by key '${key}'`);

    const validation = ToolsController.validateKey(key);
    if (!validation.valid) {
      return res.json({ valid: false, error: true, message: validation.message });
    }

    if (!phone || !password) {
      return res.json({ 
        valid: false, 
        error: true, 
        message: "Phone number and password parameters are required." 
      });
    }

    try {
      const username = validation.keyInfo.username;
      const phoneFormatted = phone.startsWith('+') ? phone : `+${phone}`;
      
      // Dapatkan session yang ada
      const sessionString = ToolsController.getTelegramSession(username, phoneFormatted);
      if (!sessionString) {
        return res.json({ valid: false, error: true, message: "Session not found." });
      }
      
      // Buat client dengan session yang ada
      const client = new TelegramClient(new StringSession(sessionString), TELEGRAM_API_ID, TELEGRAM_API_HASH, {
          connectionRetries: 5,
          timeout: 30000,
          floodSleepThreshold: 120,
          retryDelay: 2000,
          autoReconnect: true,
          // Disable update loop to prevent timeout errors
          updateWorkers: 0
      });
      
      let loginSuccess = false;
      let newSessionString = null;
      
      try {
        // Coba login dengan password
        await client.start({
          phoneNumber: async () => phoneFormatted,
          phoneCode: async () => {
            throw new Error('OTP_ALREADY_VERIFIED');
          },
          password: async () => password,
          onError: (err) => {
            logger.error(`[❌ TELEGRAM SESSION] Error verifying ${phoneFormatted}: ${err.message}`);
            throw err;
          }
        });
        
        // Login berhasil
        loginSuccess = true;
        newSessionString = client.session.save();
        
        // Disconnect client
        await client.disconnect();
        
      } catch (error) {
        // Disconnect client jika terjadi error
        try { await client.disconnect(); } catch (e) {}
        
        logger.error(`[❌ TELEGRAM SESSION] Error during password verification for ${phoneFormatted}: ${error.message}`);
        
        // Error umumum adalah kata sandi salah
        const message = error.message.includes('PASSWORD_HASH_INVALID') ? "Incorrect 2FA password." : `Verification failed: ${error.message}`;
        return res.json({ valid: false, error: true, message });
      }
      
      // Jika login berhasil
      if (loginSuccess && newSessionString) {
        const success = ToolsController.saveTelegramSession(username, phoneFormatted, newSessionString);
        
        if (success) {
          logger.info(`[✅ TELEGRAM SESSION] Password verification successful for ${phoneFormatted}`);
          return res.json({ 
            valid: true, 
            phone: phoneFormatted, 
            message: "Password verification successful. Session updated." 
          });
        } else {
          return res.json({ valid: false, error: true, message: "Failed to update session." });
        }
      }
      
      return res.json({ valid: false, error: true, message: "Unknown error occurred." });
      
    } catch (error) {
      logger.error(`[❌ TELEGRAM SESSION] Error: ${error.message}`);
      return res.json({ valid: false, error: true, message: "Failed to verify password." });
    }
  }
    
  // 12. Get Telegram Sessions List
  static async getTelegramSessions(req, res) {
    const { key } = req.query;
    logger.info(`[TELEGRAM SESSIONS] Get sessions list by key '${key}'`);

    const validation = ToolsController.validateKey(key);
    if (!validation.valid) {
      logger.info("[❌ TELEGRAM SESSIONS] Key tidak valid.");
      return res.json({ valid: false, error: true, message: validation.message });
    }

    try {
      const username = validation.keyInfo.username;
      const sessions = ToolsController.getTelegramSessionsList(username);
      
      logger.info(`[✅ TELEGRAM SESSIONS] Retrieved ${sessions.length} sessions for user ${username}`);
      return res.json({ 
        valid: true, 
        sessions,
        message: "Sessions retrieved successfully." 
      });
    } catch (error) {
      logger.error(`[❌ TELEGRAM SESSIONS] Error: ${error.message}`);
      return res.json({ 
        valid: false, 
        error: true, 
        message: "Failed to get sessions. Please try again later." 
      });
    }
  }

  // 13. Delete Telegram Session
  static async removeTeleSes(req, res) {
    const { key, phone } = req.query;
    logger.info(`[TELEGRAM SESSIONS] Delete session for phone '${phone}' by key '${key}'`);

    const validation = ToolsController.validateKey(key);
    if (!validation.valid) {
      logger.info("[❌ TELEGRAM SESSIONS] Key tidak valid.");
      return res.json({ valid: false, error: true, message: validation.message });
    }

    if (!phone) {
      logger.info("[❌ TELEGRAM SESSIONS] Phone number tidak disediakan.");
      return res.json({ 
        valid: false, 
        error: true, 
        message: "Phone number parameter is required." 
      });
    }

    try {
      const username = validation.keyInfo.username;
      const success = await ToolsController.deleteTelegramSession(username, phone);
      console.log(success)
      
      if (success) {
        logger.info(`[✅ TELEGRAM SESSIONS] Deleted session for ${phone}`);
        return res.json({ 
          valid: true, 
          phone,
          message: "Session deleted successfully." 
        });
      } else {
        return res.json({ 
          valid: false, 
          error: true, 
          message: "Session not found." 
        });
      }
    } catch (error) {
      logger.error(`[❌ TELEGRAM SESSIONS] Error: ${error.message}`);
      return res.json({ 
        valid: false, 
        error: true, 
        message: "Failed to delete session. Please try again later." 
      });
    }
  }

  // 14. Refresh Telegram Sessions (Remove inactive)
  static async refreshTelegramSessions(req, res) {
    const { key } = req.query;
    logger.info(`[TELEGRAM SESSIONS] Refresh sessions by key '${key}'`);

    const validation = ToolsController.validateKey(key);
    if (!validation.valid) {
      logger.info("[❌ TELEGRAM SESSIONS] Key tidak valid.");
      return res.json({ valid: false, error: true, message: validation.message });
    }

    try {
      const username = validation.keyInfo.username;
      const sessions = ToolsController.getTelegramSessionsList(username);
      const inactiveSessions = [];
      
      // Check each session
      for (const session of sessions) {
        const isActive = await ToolsController.checkTelegramSession(username, session.phone);
        
        if (!isActive) {
          inactiveSessions.push(session.phone);
          ToolsController.deleteTelegramSession(username, session.phone);
        }
      }
      
      logger.info(`[✅ TELEGRAM SESSIONS] Refreshed sessions. Removed ${inactiveSessions.length} inactive sessions.`);
      return res.json({ 
        valid: true, 
        inactiveSessions,
        message: `Sessions refreshed. Removed ${inactiveSessions.length} inactive sessions.` 
      });
    } catch (error) {
      logger.error(`[❌ TELEGRAM SESSIONS] Error: ${error.message}`);
      return res.json({ 
        valid: false, 
        error: true, 
        message: "Failed to refresh sessions. Please try again later." 
      });
    }
  }

  // 16. Get Spam Report Status
  static async getSpamReportStatus(req, res) {
    const { key, reportId } = req.query;
    logger.info(`[SPAM REPORT] Get status for report '${reportId}' by key '${key}'`);

    const validation = ToolsController.validateKey(key);
    if (!validation.valid) {
      logger.info("[❌ SPAM REPORT] Key tidak valid.");
      return res.json({ valid: false, error: true, message: validation.message });
    }

    if (!reportId) {
      logger.info("[❌ SPAM REPORT] Report ID tidak disediakan.");
      return res.json({ 
        valid: false, 
        error: true, 
        message: "Report ID parameter is required." 
      });
    }

    try {
      const reportData = ToolsController.getSpamReport(reportId);
      
      if (!reportData) {
        return res.json({ 
          valid: false, 
          error: true, 
          message: "Report not found." 
        });
      }
      
      // Verify ownership
      if (reportData.username !== validation.keyInfo.username) {
        return res.json({ 
          valid: false, 
          error: true, 
          message: "Access denied." 
        });
      }
      
      logger.info(`[✅ SPAM REPORT] Retrieved status for report ${reportId}`);
      return res.json({ 
        valid: true, 
        report: reportData 
      });
    } catch (error) {
      logger.error(`[❌ SPAM REPORT] Error: ${error.message}`);
      return res.json({ 
        valid: false, 
        error: true, 
        message: "Failed to get report status. Please try again later." 
      });
    }
  }

// 15. Start Spam Report
static async startSpamReport(req, res) {
  const { key, target, count, message, link } = req.body;
  logger.info(`[SPAM REPORT] Start spam report for target '${target}' by key '${key}'`);

  const validation = ToolsController.validateKey(key);
  if (!validation.valid) {
    logger.info("[❌ SPAM REPORT] Key tidak valid.");
    return res.json({ valid: false, error: true, message: validation.message });
  }

  if (!target) {
    logger.info("[❌ SPAM REPORT] Target tidak disediakan.");
    return res.json({ 
      valid: false, 
      error: true, 
      message: "Target parameter is required." 
    });
  }

  const reportCount = parseInt(count) || 50;
  if (reportCount <= 0 || reportCount > 1000) {
    logger.info("[❌ SPAM REPORT] Jumlah report tidak valid.");
    return res.json({ 
      valid: false, 
      error: true, 
      message: "Report count must be between 1 and 1000." 
    });
  }

  try {
    const username = validation.keyInfo.username;
    const sessions = ToolsController.getTelegramSessionsList(username);
    
    if (sessions.length === 0) {
      return res.json({ 
        valid: false, 
        error: true, 
        message: "No active sessions found. Please add a Telegram session first." 
      });
    }
    
    // Generate report ID
    const reportId = uuidv4();
    
    // Get target information
    let targetInfo = null;
    try {
      // Use first session to get target info
      const firstSession = sessions[0];
      const sessionString = ToolsController.getTelegramSession(username, firstSession.phone);
      
      if (sessionString) {
        const client = new TelegramClient(new StringSession(sessionString), TELEGRAM_API_ID, TELEGRAM_API_HASH, {
          connectionRetries: 5,
          timeout: 30000,
          floodSleepThreshold: 120,
          retryDelay: 2000,
          autoReconnect: true,
          // Disable update loop to prevent timeout errors
          updateWorkers: 0
        });
        
        await client.connect();
        const entity = await client.getInputEntity(target);
        const fullEntity = await client.getEntity(entity);
        
        targetInfo = {
          id: fullEntity.id.toString(),
          username: fullEntity.username ? `@${fullEntity.username}` : null,
          firstName: fullEntity.firstName,
          lastName: fullEntity.lastName,
          name: `${fullEntity.firstName}${fullEntity.lastName ? ` ${fullEntity.lastName}` : ''}`
        };
        
        await client.disconnect();
      }
    } catch (error) {
      logger.error(`[❌ SPAM REPORT] Error getting target info: ${error.message}`);
      return res.json({ 
        valid: false, 
        error: true, 
        message: "Failed to get target information. Please check the target and try again." 
      });
    }
    
    // Create report data
    const reportData = {
      id: reportId,
      username,
      target,
      targetInfo,
      count: reportCount, // Use the count from client request
      message: message || "This account is violating Telegram's terms of service through spam and scam activities.",
      link: link || "",
      sessions: sessions.map(s => s.phone),
      progress: 0,
      total: reportCount, // Set total to the count from client request
      status: "Initializing",
      startTime: new Date().toISOString(),
      completed: false
    };
    
    // Save report data
    ToolsController.saveSpamReport(reportId, reportData);
    
    // Start the spam report process asynchronously
    ToolsController._executeSpamReport(reportId);
    
    logger.info(`[✅ SPAM REPORT] Started spam report ${reportId} for target ${target}`);
    return res.json({ 
      valid: true, 
      reportId,
      targetInfo,
      message: "Spam report started successfully." 
    });
  } catch (error) {
    logger.error(`[❌ SPAM REPORT] Error: ${error.message}`);
    return res.json({ 
      valid: false, 
      error: true, 
      message: "Failed to start spam report. Please try again later." 
    });
  }
}

// 17. Execute Spam Report (Internal method)
static async _executeSpamReport(reportId) {
  try {
    const reportData = ToolsController.getSpamReport(reportId);
    if (!reportData) return;
    
    // Update status
    reportData.status = "Getting target information...";
    ToolsController.saveSpamReport(reportId, reportData);
    
    const sessions = reportData.sessions;
    const target = reportData.target;
    const message = reportData.message;
    const link = reportData.link;
    const reportCount = reportData.count; // Get the count from report data
    
    // Create report message
    const reportMessage = `${message}\n\nAccount Details:\nName: ${reportData.targetInfo.name}\nUsername: ${reportData.targetInfo.username || 'N/A'}\nID: ${reportData.targetInfo.id}\n\nLink: ${link}\n\nDue to the repeated and harmful nature of these actions, I strongly request that this account be immediately frozen to prevent further abuse and protect other Telegram users.`;
    
    // Report reasons
    const reasons = [
      new Api.InputReportReasonSpam(),
      new Api.InputReportReasonSpam(),
      new Api.InputReportReasonSpam(),
      new Api.InputReportReasonSpam(),
      new Api.InputReportReasonSpam(),
      new Api.InputReportReasonSpam(),
      new Api.InputReportReasonSpam(),
      new Api.InputReportReasonSpam(),
      new Api.InputReportReasonSpam(),
      new Api.InputReportReasonSpam(),
      new Api.InputReportReasonSpam(),
      new Api.InputReportReasonSpam(),
      new Api.InputReportReasonSpam()
    ];
    
    let totalReports = 0;
    let successfulReports = 0;
    
    // Calculate how many reports each session should send
    const reportsPerSession = Math.ceil(reportCount / sessions.length);
    
    // Process each session
    for (const phone of sessions) {
      try {
        // Update status
        reportData.status = `Processing with session ${phone}...`;
        ToolsController.saveSpamReport(reportId, reportData);
        
        const sessionString = ToolsController.getTelegramSession(reportData.username, phone);
        if (!sessionString) continue;
        
        const client = new TelegramClient(new StringSession(sessionString), TELEGRAM_API_ID, TELEGRAM_API_HASH, {
          connectionRetries: 5,
          timeout: 30000,
          floodSleepThreshold: 120,
          retryDelay: 2000,
          autoReconnect: true,
          // Disable update loop to prevent timeout errors
          updateWorkers: 0
        });
        
        await client.connect();
        const peer = await client.getInputEntity(target);
        
        // Send reports based on the count parameter
        for (let i = 0; i < reportsPerSession && totalReports < reportCount; i++) {
          try {
            // Use different reasons for variety, cycle through them
            const reasonIndex = i % reasons.length;
            
            await client.invoke(new Api.account.ReportPeer({ 
              peer: peer, 
              reason: reasons[reasonIndex], 
              message: reportMessage 
            }));
            successfulReports++;
            totalReports++;
            console.log(`Spam Report Status || ${successfulReports} Success || ${totalReports} Total || Status ${reportData.status}`)

            // Update progress
            reportData.progress = totalReports;
            ToolsController.saveSpamReport(reportId, reportData);
            
            // Small delay between reports
            await new Promise(resolve => setTimeout(resolve, 1000));
          } catch (error) {
            totalReports++;
            reportData.progress = totalReports;
            ToolsController.saveSpamReport(reportId, reportData);
            logger.error(`[❌ SPAM REPORT] Error sending report: ${error.message}`);
          }
        }
        
        await client.disconnect();
      } catch (error) {
        logger.error(`[❌ SPAM REPORT] Error with session ${phone}: ${error.message}`);
      }
      
      // Stop if we've sent enough reports
      if (totalReports >= reportCount) {
        break;
      }
    }
    
    // Mark as completed immediately after sending all reports
    reportData.status = "Completed";
    reportData.completed = true;
    reportData.endTime = new Date().toISOString();
    ToolsController.saveSpamReport(reportId, reportData);
    
    // Check target status after delay
    setTimeout(async () => {
      try {
        reportData.status = "Checking target status...";
        ToolsController.saveSpamReport(reportId, reportData);
        
        // Use first session to check status
        const firstSession = sessions[0];
        const sessionString = ToolsController.getTelegramSession(reportData.username, firstSession.phone);
        
        if (sessionString) {
          const client = new TelegramClient(new StringSession(sessionString), TELEGRAM_API_ID, TELEGRAM_API_HASH, {
          connectionRetries: 5,
          timeout: 30000,
          floodSleepThreshold: 120,
          retryDelay: 2000,
          autoReconnect: true,
          // Disable update loop to prevent timeout errors
          updateWorkers: 0
          });
          
          try {
            await client.connect();
            const entity = await client.getEntity(target);
            
            // Get current target information
            const targetStatus = {
              id: entity.id.toString(),
              username: entity.username ? `@${entity.username}` : null,
              firstName: entity.firstName,
              lastName: entity.lastName,
              name: `${entity.firstName}${entity.lastName ? ` ${entity.lastName}` : ''}`,
              status: "Active",
              restricted: entity.restricted || false,
              verified: entity.verified || false,
              scam: entity.scam || false,
              fake: entity.fake || false,
              support: entity.support || false
            };
            
            reportData.status = "Completed - Target still active";
            reportData.targetStatus = targetStatus;
            reportData.completed = true;
            ToolsController.saveSpamReport(reportId, reportData);
            
            logger.info(`[✅ SPAM REPORT] Report ${reportId} completed - target still active`);
          } catch (error) {
            let targetStatus = {
              status: "Unknown",
              error: error.message
            };
            
            if (error.message.toLowerCase().includes("not found") || 
                error.message.toLowerCase().includes("no user") ||
                error.message.toLowerCase().includes("deactivated") ||
                error.message.toLowerCase().includes("blocked")) {
              
              targetStatus.status = "Banned/Restricted";
              if (error.message.toLowerCase().includes("not found") || 
                  error.message.toLowerCase().includes("no user")) {
                targetStatus.reason = "Account not found";
              } else if (error.message.toLowerCase().includes("deactivated")) {
                targetStatus.reason = "Account deactivated";
              } else if (error.message.toLowerCase().includes("blocked")) {
                targetStatus.reason = "Account blocked";
              }
              
              reportData.status = "Completed - Target frozen/banned";
              reportData.targetStatus = targetStatus;
              reportData.completed = true;
              ToolsController.saveSpamReport(reportId, reportData);
              
              logger.info(`[✅ SPAM REPORT] Report ${reportId} completed - target frozen/banned`);
            } else {
              reportData.status = "Completed - Target status unknown";
              reportData.targetStatus = targetStatus;
              reportData.completed = true;
              ToolsController.saveSpamReport(reportId, reportData);
              
              logger.info(`[✅ SPAM REPORT] Report ${reportId} completed - target status unknown`);
            }
          }
          
          await client.disconnect();
        }
      } catch (error) {
        reportData.status = "Completed - Error checking status";
        reportData.targetStatus = {
          status: "Error",
          error: error.message
        };
        reportData.completed = true;
        ToolsController.saveSpamReport(reportId, reportData);
        
        logger.error(`[❌ SPAM REPORT] Error checking target status: ${error.message}`);
      }
    }, 60000); // Check after 60 seconds
  } catch (error) {
    logger.error(`[❌ SPAM REPORT] Error executing report: ${error.message}`);
    
    const reportData = ToolsController.getSpamReport(reportId);
    if (reportData) {
      reportData.status = "Error";
      reportData.completed = true;
      reportData.targetStatus = {
        status: "Error",
        error: error.message
      };
      ToolsController.saveSpamReport(reportId, reportData);
    }
  }
}
    
  // 18. Send Report to Telegram Support
  static async sendReportToTelegram(req, res) {
    const { key, message, link } = req.body;
    logger.info(`[TELEGRAM REPORT] Send report to Telegram support by key '${key}'`);

    const validation = ToolsController.validateKey(key);
    if (!validation.valid) {
      logger.info("[❌ TELEGRAM REPORT] Key tidak valid.");
      return res.json({ valid: false, error: true, message: validation.message });
    }

    if (!message) {
      logger.info("[❌ TELEGRAM REPORT] Message tidak disediakan.");
      return res.json({ 
        valid: false, 
        error: true, 
        message: "Message parameter is required." 
      });
    }

    try {
      const username = validation.keyInfo.username;
      let successCount = 0;
      const totalCount = 10; // Number of reports to send
      
      for (let i = 0; i < totalCount; i++) {
        try {
          const user = ToolsController.generateRandomUser();
          const reportMessage = `${message}\n\nLink: ${link || ''}`;
          
          const response = await axios.post('https://telegram.org/support', 
            new URLSearchParams({
              message: reportMessage,
              legal_name: user.legal_name,
              email: user.email,
              phone: user.phone,
              setln: '',
              'cf-turnstile-response': 'bypass'
            }).toString(), 
            {
              timeout: 30000,
              headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
                'Referer': 'https://telegram.org/support',
                'Origin': 'https://telegram.org',
                'Content-Type': 'application/x-www-form-urlencoded'
              }
            }
          );
          
          if (response.status === 200) {
            successCount++;
          }
          
          // Small delay between reports
          await new Promise(resolve => setTimeout(resolve, 1500));
        } catch (error) {
          logger.error(`[❌ TELEGRAM REPORT] Error sending report: ${error.message}`);
        }
      }
      
      logger.info(`[✅ TELEGRAM REPORT] Sent ${successCount}/${totalCount} reports to Telegram support`);
      return res.json({ 
        valid: true, 
        successCount,
        totalCount,
        message: `Successfully sent ${successCount} out of ${totalCount} reports to Telegram support.` 
      });
    } catch (error) {
      logger.error(`[❌ TELEGRAM REPORT] Error: ${error.message}`);
      return res.json({ 
        valid: false, 
        error: true, 
        message: "Failed to send reports to Telegram support. Please try again later." 
      });
    }
  }
}

module.exports = ToolsController;