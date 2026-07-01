// src/services/activityLogService.js
const fs = require('fs');
const path = require('path');
const { logger } = require('../utils/logger');

// Path ke file log aktivitas
const ACTIVITY_LOG_PATH = path.join(__dirname, '../../logs/userActivity.json');

// Fungsi untuk memastikan direktori logs ada
function ensureLogDirectory() {
  const logDir = path.dirname(ACTIVITY_LOG_PATH);
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }
}

// Fungsi untuk membaca log aktivitas
function getActivityLogs() {
  ensureLogDirectory();
  
  try {
    if (fs.existsSync(ACTIVITY_LOG_PATH)) {
      const data = fs.readFileSync(ACTIVITY_LOG_PATH, 'utf8');
      return JSON.parse(data);
    }
    return [];
  } catch (error) {
    logger.error(`Error reading activity log: ${error.message}`);
    return [];
  }
}

// Fungsi untuk menyimpan log aktivitas
function saveActivityLogs(logs) {
  ensureLogDirectory();
  
  try {
    fs.writeFileSync(ACTIVITY_LOG_PATH, JSON.stringify(logs, null, 2));
    return true;
  } catch (error) {
    logger.error(`Error saving activity log: ${error.message}`);
    return false;
  }
}

// Fungsi untuk menambahkan log aktivitas baru
function addActivityLog(username, activity, details = {}) {
  const logs = getActivityLogs();
  
  const newLog = {
    id: Date.now().toString(),
    username,
    activity,
    details,
    timestamp: new Date().toISOString()
  };
  
  logs.unshift(newLog); // Tambahkan di awal array (terbaru dulu)
  
  // Batasi jumlah log untuk menghindari file terlalu besar
  if (logs.length > 1000) {
    logs.splice(1000); // Hapus log paling lama jika lebih dari 1000
  }
  
  saveActivityLogs(logs);
  logger.info(`[📝 ACTIVITY] ${username}: ${activity}`);
  
  return newLog;
}

// Fungsi untuk mendapatkan log aktivitas pengguna tertentu
function getUserActivityLogs(username, limit = 50) {
  const logs = getActivityLogs();
  return logs
    .filter(log => log.username === username)
    .slice(0, limit);
}

// Fungsi untuk membersihkan log lama (opsional, bisa dipanggil oleh cron job)
function cleanOldLogs(daysToKeep = 30) {
  const logs = getActivityLogs();
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);
  
  const filteredLogs = logs.filter(log => 
    new Date(log.timestamp) > cutoffDate
  );
  
  if (filteredLogs.length !== logs.length) {
    saveActivityLogs(filteredLogs);
    logger.info(`[🧹 ACTIVITY] Cleaned ${logs.length - filteredLogs.length} old logs`);
  }
  
  return filteredLogs.length !== logs.length;
}

module.exports = {
  getActivityLogs,
  saveActivityLogs,
  addActivityLog,
  getUserActivityLogs,
  cleanOldLogs
};