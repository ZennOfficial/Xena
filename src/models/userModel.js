const { loadDatabase, saveDatabase } = require('../services/databaseService');

class UserModel {
  static findAll() {
    return loadDatabase();
  }

  static findByUsername(username) {
    const db = loadDatabase();
    return db.find(u => u.username === username);
  }

  static findByUsernameAndPassword(username, password) {
    const db = loadDatabase();
    return db.find(u => u.username === username && u.password === password);
  }

  static create(userData) {
    const db = loadDatabase();
    db.push(userData);
    saveDatabase(db);
    return userData;
  }

  static updateByUsername(username, updates) {
    const db = loadDatabase();
    const index = db.findIndex(u => u.username === username);
    if (index !== -1) {
      db[index] = { ...db[index], ...updates };
      saveDatabase(db);
      return db[index];
    }
    return null;
  }

  static deleteByUsername(username) {
    const db = loadDatabase();
    const index = db.findIndex(u => u.username === username);
    if (index !== -1) {
      const deleted = db.splice(index, 1)[0];
      saveDatabase(db);
      return deleted;
    }
    return null;
  }

  static isExpired(user) {
    return new Date(user.expiredDate) < new Date();
  }
}

module.exports = UserModel;