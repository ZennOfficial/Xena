const { loadKeyList, saveKeyList } = require('../services/databaseService');
const { generateKey } = require('../middleware/authMiddleware');

class SessionModel {
  static findAll() {
    return loadKeyList();
  }

  static findBySessionKey(sessionKey) {
    const keyList = loadKeyList();
    return keyList.find(k => k.sessionKey === sessionKey);
  }

  static findByUsername(username) {
    const keyList = loadKeyList();
    return keyList.find(k => k.username === username);
  }

  static create(sessionData) {
    const keyList = loadKeyList();
    const newSession = {
      ...sessionData,
      sessionKey: generateKey(),
      lastLogin: new Date().toISOString()
    };
    
    const existingIndex = keyList.findIndex(k => k.username === sessionData.username);
    if (existingIndex !== -1) {
      keyList[existingIndex] = newSession;
    } else {
      keyList.push(newSession);
    }
    
    saveKeyList(keyList);
    return newSession;
  }

  static updateByUsername(username, updates) {
    const keyList = loadKeyList();
    const index = keyList.findIndex(k => k.username === username);
    if (index !== -1) {
      keyList[index] = { ...keyList[index], ...updates };
      saveKeyList(keyList);
      return keyList[index];
    }
    return null;
  }

  static deleteByUsername(username) {
    const keyList = loadKeyList();
    const index = keyList.findIndex(k => k.username === username);
    if (index !== -1) {
      const deleted = keyList.splice(index, 1)[0];
      saveKeyList(keyList);
      return deleted;
    }
    return null;
  }

  static isExpired(session) {
    if (!session.lastLogin) return true;
    const sessionAge = Date.now() - new Date(session.lastLogin).getTime();
    return sessionAge > 10 * 60 * 1000; // 10 minutes
  }
}

module.exports = SessionModel;