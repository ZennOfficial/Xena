const { loadKeyList } = require('../services/databaseService');
const { logger } = require('../utils/logger');

// Store active keys in memory
const activeKeys = {};

function authMiddleware(req, res, next) {
  const key = (req.query && req.query.key) || (req.body && req.body.key) || null;
  
  if (!key) {
    return res.status(401).json({ error: "API key is required" });
  }

  // Check if key is in activeKeys
  if (!activeKeys[key]) {
    // Try to load from file
    const keyList = loadKeyList();
    const keyInfo = keyList.find(k => k.sessionKey === key);
    
    if (!keyInfo) {
      return res.status(401).json({ error: "Invalid API key" });
    }
    
    // Add to activeKeys
    activeKeys[key] = {
      username: keyInfo.username,
      created: Date.now(),
      expires: Date.now() + 10 * 60 * 1000, // 10 minutes
    };
  }
  
  // Check if key has expired
  if (Date.now() > activeKeys[key].expires) {
    delete activeKeys[key];
    return res.status(401).json({ error: "API key has expired" });
  }
  
  // Add user info to request
  req.user = {
    username: activeKeys[key].username,
    key: key
  };
  
  next();
}

function generateKey() {
  const crypto = require('crypto');
  const key = crypto.randomBytes(8).toString("hex");
  logger.info(`[🔑 GEN] Key baru dibuat: ${key}`);
  return key;
}

function recordKey({ username, key, role, ip, androidId }) {
  const { saveKeyList } = require('../services/databaseService');
  const list = loadKeyList();
  const stamp = new Date().toISOString();
  const idx = list.findIndex(e => e.username === username);

  if (idx !== -1) {
    list[idx] = { username, lastLogin: stamp, sessionKey: key, ipAddress: ip, androidId };
  } else {
    list.push({ username, lastLogin: stamp, sessionKey: key, ipAddress: ip, androidId });
  }

  saveKeyList(list);
}

module.exports = authMiddleware;
module.exports.generateKey = generateKey;
module.exports.recordKey = recordKey;
module.exports.activeKeys = activeKeys;