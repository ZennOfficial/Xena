const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const DB_PATH = path.join(__dirname, '../../data/database.json');
const KEY_LIST_PATH = path.join(__dirname, '../../data/keyList.json');
const VPS_PATH = path.join(__dirname, '../../data/vps.json');

// Ensure data directory exists
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

function loadDatabase() {
  try {
    if (!fs.existsSync(DB_PATH)) {
      fs.writeFileSync(DB_PATH, JSON.stringify([]));
      logger.info("Database baru dibuat.");
    }
    return JSON.parse(fs.readFileSync(DB_PATH));
  } catch (err) {
    logger.error(`Error loading database: ${err.message}`);
    return [];
  }
}

function saveDatabase(data) {
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
    return true;
  } catch (err) {
    logger.error(`Error saving database: ${err.message}`);
    return false;
  }
}

function loadKeyList() {
  try {
    if (!fs.existsSync(KEY_LIST_PATH)) {
      fs.writeFileSync(KEY_LIST_PATH, JSON.stringify([]));
      logger.info("Key list baru dibuat.");
    }
    return JSON.parse(fs.readFileSync(KEY_LIST_PATH));
  } catch (err) {
    logger.error(`Error loading key list: ${err.message}`);
    return [];
  }
}

function saveKeyList(data) {
  try {
    fs.writeFileSync(KEY_LIST_PATH, JSON.stringify(data, null, 2));
    return true;
  } catch (err) {
    logger.error(`Error saving key list: ${err.message}`);
    return false;
  }
}

function loadVpsList() {
  try {
    if (!fs.existsSync(VPS_PATH)) {
      fs.writeFileSync(VPS_PATH, JSON.stringify([]));
      logger.info("VPS list baru dibuat.");
    }
    return JSON.parse(fs.readFileSync(VPS_PATH));
  } catch (err) {
    logger.error(`Error loading VPS list: ${err.message}`);
    return [];
  }
}

function saveVpsList(data) {
  try {
    fs.writeFileSync(VPS_PATH, JSON.stringify(data, null, 2));
    return true;
  } catch (err) {
    logger.error(`Error saving VPS list: ${err.message}`);
    return false;
  }
}

module.exports = {
  loadDatabase,
  saveDatabase,
  loadKeyList,
  saveKeyList,
  loadVpsList,
  saveVpsList
};