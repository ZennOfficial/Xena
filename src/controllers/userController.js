const express = require('express');
const fs = require('fs');
const { logger } = require('../utils/logger');
const { loadDatabase, saveDatabase } = require('../services/databaseService');
const { activeKeys } = require('../middleware/authMiddleware');
const { addActivityLog } = require('../services/activityLogService');

class UserController {

  // ==========================================
  // CREATE MEMBER BIASA (Via Link/Bot)
  // ==========================================
  static async createAccount(req, res) {
    const { key, newUser, pass, day } = req.query;
    logger.info(`[👤 CREATE] Request create user '${newUser}' dengan key '${key}'`);

    const keyInfo = activeKeys[key];
    if (!keyInfo) {
      logger.info("[❌ CREATE] Key tidak valid.");
      return res.json({ valid: false, error: true, message: "Invalid key." });
    }

    const db = loadDatabase();
    const creator = db.find(u => u.username === keyInfo.username);

    // List role yang diizinkan membuat member biasa (Update: tambah dev, owner, admin)
    const allowedCreators = ["founder", "tk", "owner", "moderator", "partner", "partner1"];

    if (!creator || !allowedCreators.includes(creator.role)) {
      logger.info(`[❌ CREATE] ${creator?.username || "Unknown"} tidak memiliki izin.`);
      return res.json({ valid: true, authorized: false, message: "Not authorized." });
    }

    // Batasan Partner (Maks 30 hari)
    if (creator.role.includes("partner") && parseInt(day) > 30) {
      logger.info("[❌ CREATE] Partner tidak boleh membuat akun lebih dari 30 hari.");
      return res.json({ valid: true, created: false, invalidDay: true, message: "Partner can only create accounts up to 30 days." });
    }

    if (db.find(u => u.username === newUser)) {
      logger.info("[❌ CREATE] Username sudah digunakan.");
      return res.json({ valid: true, created: false, message: "Username already exists." });
    }

    const expired = new Date();
    expired.setDate(expired.getDate() + parseInt(day));

    const newAccount = {
      username: newUser,
      password: pass,
      expiredDate: expired.toISOString().split("T")[0],
      role: "member", // Default createAccount selalu member
      parent: creator.username,
    };

    db.push(newAccount);
    saveDatabase(db);
    
    logger.info("[✅ CREATE] Akun berhasil dibuat:", newAccount);
    const logLine = `${creator.username} Created ${newUser} duration ${day}\n`;
    fs.appendFileSync('logUser.txt', logLine);
     
    addActivityLog(creator.username, 'Create Account', {
      newUsername: newUser,
      duration: day,
      newRole: "member"
    });

    return res.json({ valid: true, created: true, user: newAccount });
  }

  // ==========================================
  // DELETE USER
  // ==========================================
  static async deleteAccount(req, res) {
    const { key, username } = req.query;
    logger.info(`[🗑️ DELETE] Request hapus user '${username}' oleh key '${key}'`);

    const keyInfo = activeKeys[key];
    if (!keyInfo) {
      logger.info("[❌ DELETE] Key tidak valid.");
      return res.json({ valid: false, error: true, message: "Invalid key." });
    }

    const db = loadDatabase();
    const admin = db.find(u => u.username === keyInfo.username);

    // List role yang boleh menghapus (Update: tambah dev, owner, admin)
    const allowedDeleters = ["founder", "tk", "owner", "moderator"];

    if (!admin || !allowedDeleters.includes(admin.role)) {
      logger.info(`[❌ DELETE] ${admin?.username || "Unknown"} tidak memiliki izin.`);
      return res.json({ valid: true, authorized: false, message: "Unauthorized to delete users." });
    }

    const index = db.findIndex(u => u.username === username);
    if (index === -1) {
      logger.info("[❌ DELETE] User tidak ditemukan.");
      return res.json({ valid: true, deleted: false, message: "User not found." });
    }

    const targetUser = db[index];

    // ==========================================
    // PROTEKSI HIERARKI DELETE
    // ==========================================
    // Angka semakin tinggi = Jabatan semakin tinggi
    const roleLevels = {
        "founder": 100,
        "tk": 80,
        "owner": 70,
        "moderator": 60,
        "partner": 50,
        "reseller": 40,
        "member": 10
    };

    const adminLevel = roleLevels[admin.role] || 0;
    const targetLevel = roleLevels[targetUser.role] || 0;

    // Aturan: Admin tidak bisa hapus user yang levelnya lebih tinggi atau setara
    // Pengecualian: Dev bisa hapus sesama Dev jika diperlukan, tapi standarnya kita blokir setara
    if (admin.role !== "dev" && adminLevel <= targetLevel) {
        logger.info(`[❌ DELETE] ${admin.role} mencoba menghapus ${targetUser.role}, ditolak.`);
        return res.json({ 
            valid: true, 
            authorized: false, 
            message: `You cannot delete a user with role ${targetUser.role} (Hierarchy restriction).` 
        });
    }

    const deletedUser = db[index];
    db.splice(index, 1);
    saveDatabase(db);
    
    logger.info("[✅ DELETE] User berhasil dihapus:", deletedUser);
    const logLine = `${admin.username} Deleted ${deletedUser.username} (Parent: ${deletedUser.parent || 'SYSTEM'})\n`;
    fs.appendFileSync('logUser.txt', logLine);
     
    addActivityLog(admin.username, 'Delete Account', {
      deletedUsername: deletedUser.username,
      deletedRole: deletedUser.role,
      parent: deletedUser.parent || 'SYSTEM'
    });

    return res.json({ valid: true, deleted: true, user: deletedUser });
  }

  // ==========================================
  // EDIT USER (Tambah Masa Aktif)
  // ==========================================
  static async editUser(req, res) {
    const { key, username, addDays } = req.query;
    logger.info(`[🛠️ EDIT] Tambah masa aktif ${username} +${addDays} hari oleh key ${key}`);

    const keyInfo = activeKeys[key];
    if (!keyInfo) {
      logger.info("[❌ EDIT] Key tidak valid.");
      return res.json({ valid: false, error: true, message: "Invalid key." });
    }

    const db = loadDatabase();
    const editor = db.find(u => u.username === keyInfo.username);

    // Izin: Tambah Dev, Owner, Admin
    const allowedEditors = ["founder", "tk", "owner", "moderator", "partner"];
    if (!editor || !allowedEditors.includes(editor.role)) {
      logger.info(`[❌ EDIT] ${editor?.username || "Unknown"} tidak memiliki izin.`);
      return res.json({ valid: true, authorized: false, message: "Unauthorized role." });
    }

    // Batasan Partner
    if (editor.role === "partner" && parseInt(addDays) > 30) {
      logger.info("[❌ EDIT] Partner tidak boleh menambah lebih dari 30 hari.");
      return res.json({ valid: true, authorized: true, edited: false, invalidDay: true, message: "Partner can only add up to 30 days." });
    }

    const targetUser = db.find(u => u.username === username);
    if (!targetUser) {
      logger.info("[❌ EDIT] User tidak ditemukan.");
      return res.json({ valid: true, authorized: true, edited: false, message: "User not found." });
    }

    // Batasan Partner mengedit role diatasnya
    if (editor.role === "partner" && targetUser.role !== "member") {
      logger.info("[❌ EDIT] Partner hanya bisa mengedit user dengan role 'member'.");
      return res.json({ valid: true, authorized: true, edited: false, message: "Partner hanya bisa mengedit user dengan role 'member'." });
    }

    const currentDate = new Date(targetUser.expiredDate);
    currentDate.setDate(currentDate.getDate() + parseInt(addDays));
    targetUser.expiredDate = currentDate.toISOString().split("T")[0];

    saveDatabase(db);
    
    logger.info(`[✅ EDIT] Masa aktif ${username} diperbarui ke ${targetUser.expiredDate}`);
    const logLine = `${editor.username} Edited ${username} (Parent: ${targetUser.parent || 'SYSTEM'}) Add Days ${addDays}\n`;
    fs.appendFileSync('logUser.txt', logLine);
     
    addActivityLog(editor.username, 'Edit User', {
      targetUsername: username,
      addDays,
      newExpiryDate: targetUser.expiredDate,
      parent: targetUser.parent || 'SYSTEM'
    });

    return res.json({ valid: true, authorized: true, edited: true, user: targetUser });
  }

  // ==========================================
  // CHANGE PASSWORD (SELF)
  // ==========================================
  static async changePassword(req, res) {
    const { username, oldPass, newPass } = req.body;
     
    const db = loadDatabase();
    const idx = db.findIndex(u => u.username === username && u.password === oldPass);
     
    if (idx === -1) {
      logger.error(`[❌ PASSWORD] Invalid credentials for user: ${username}`);
      return res.json({ success: false, message: "Invalid credentials" });
    }

    db[idx].password = newPass;
    saveDatabase(db);
     
    logger.info(`[✅ PASSWORD] Password berhasil diubah untuk user: ${username}`);
     
    addActivityLog(username, 'Change Password', {
      success: true
    });
     
    return res.json({ success: true, message: "Password updated successfully" });
  }

  // ==========================================
  // LIST USERS
  // ==========================================
  static async listUsers(req, res) {
    const { key } = req.query;
    logger.info(`[📋 LIST] Request lihat semua user oleh key '${key}'`);

    const keyInfo = activeKeys[key];
    if (!keyInfo) {
      logger.info("[❌ LIST] Key tidak valid.");
      return res.json({ valid: false, error: true, message: "Invalid key." });
    }

    const db = loadDatabase();
    const admin = db.find(u => u.username === keyInfo.username);

    // Izin: Tambah Dev, Owner, Admin
    const allowedViewers = ["founder", "tk", "owner", "moderator"];

    if (!admin || !allowedViewers.includes(admin.role)) {
      logger.info(`[❌ LIST] ${admin?.username || "Unknown"} bukan admin.`);
      return res.json({ valid: true, authorized: false, message: "Unauthorized. Only Admins/Owners can view users." });
    }

    const users = db.map(u => ({
      username: u.username,
      expiredDate: u.expiredDate,
      role: u.role || "member",
      parent: u.parent || "SYSTEM",
    }));

    logger.info(`[✅ LIST] Menampilkan ${users.length} user`);
    return res.json({ valid: true, authorized: true, users });
  }

  // ==========================================
  // USER ADD (ADD SPECIFIC ROLE)
  // ==========================================
  static async userAdd(req, res) {
    const { key, username, password, role, day } = req.query;
    logger.info(`[➕ USERADD] ${username} dengan role ${role} oleh key ${key}`);

    const keyInfo = activeKeys[key];
    if (!keyInfo) {
      logger.info("[❌ USERADD] Key tidak valid.");
      return res.json({ valid: false, error: true, message: "Invalid key." });
    }

    const db = loadDatabase();
    const creator = db.find(u => u.username === keyInfo.username);

    if (!creator) {
        return res.json({ valid: true, authorized: false, message: "Creator not found." });
    }

    // ==========================================
    // LOGIC PERMISSION MAP (ATURAN PEMBUATAN ROLE)
    // ==========================================
    
    // Peta Role: [Role Pembuat] -> [Role yang diizinkan dibuat]
    const permissionMap = {
        // Dev: Bisa semua
        "founder": ["founder", "tk", "owner", "moderator", "partner", "reseller", "member"], 
        
        // Owner: Bisa semua TAPI tidak bisa buat Owner (dan Dev)
        "tk": ["owner", "moderator", "partner", "reseller", "member"], 
        
        // Admin: Bisa High Moderator, Moderator, Partner, Member (RESELLER TIDAK BISA)
        "owner": ["moderator", "partner", "reseller", "member"], 
        
        // High Moderator: Tidak bisa buat High Moderator, Tidak bisa buat RESELLER
        "moderator": ["reseller", "partner", "member"], 
        
        // Partner: Hanya Member (Default)
        "partner": ["member"] 
    };

    const creatorRole = creator.role;
    const targetRole = role || "member"; // Default role member jika tidak diisi

    // 1. Cek apakah role pembuat ada di permissionMap
    const allowedRoles = permissionMap[creatorRole];

    if (!allowedRoles) {
        logger.info(`[❌ USERADD] Role ${creatorRole} tidak memiliki izin add user khusus.`);
        return res.json({ valid: true, authorized: false, message: "Your role is not authorized to add users." });
    }

    // 2. Cek apakah role yang ingin dibuat ada di daftar izin role pembuat
    if (!allowedRoles.includes(targetRole)) {
        logger.info(`[❌ USERADD] ${creatorRole} mencoba membuat ${targetRole}, ditolak.`);
        return res.json({ 
            valid: true, 
            authorized: false, 
            message: `Role '${creatorRole}' cannot create role '${targetRole}'. Allowed: ${allowedRoles.join(", ")}` 
        });
    }

    // Cek Username Duplikat
    if (db.find(u => u.username === username)) {
      logger.info("[❌ USERADD] Username sudah ada.");
      return res.json({ valid: true, created: false, message: "Username already exists." });
    }

    const expired = new Date();
    expired.setDate(expired.getDate() + parseInt(day));

    const newUser = {
      username,
      password,
      role: targetRole,
      expiredDate: expired.toISOString().split("T")[0],
      parent: creator.username,
    };

    db.push(newUser);
    saveDatabase(db);

    logger.info(`[✅ USERADD] User ${username} dengan role ${targetRole} berhasil dibuat`);
    const logLine = `${creator.username} Created ${username} Role ${targetRole} Days ${day}\n`;
    fs.appendFileSync('logUser.txt', logLine);

    return res.json({ valid: true, authorized: true, created: true, user: newUser });
  }

  // ==========================================
  // GET LOGS
  // ==========================================
  static async getLog(req, res) {
    const { key } = req.query;
    logger.info(`[📄 LOG] Request log oleh key '${key}'`);

    const keyInfo = activeKeys[key];
    if (!keyInfo) {
      logger.info("[❌ LOG] Key tidak valid.");
      return res.json({ valid: false, error: true, message: "Invalid key." });
    }

    const db = loadDatabase();
    const admin = db.find(u => u.username === keyInfo.username);

    // Izin: Tambah Dev, Owner, Admin
    const allowedViewers = ["founder", "tk", "owner", "moderator"];

    if (!admin || !allowedViewers.includes(admin.role)) {
      logger.info(`[❌ LOG] ${admin?.username || "Unknown"} bukan admin.`);
      return res.json({ valid: true, authorized: false, message: "Only Admin levels can view logs." });
    }

    try {
      if (!fs.existsSync('logUser.txt')) {
          fs.writeFileSync('logUser.txt', '');
      }
      const logContent = fs.readFileSync('logUser.txt', 'utf-8');
      return res.json({ valid: true, authorized: true, logs: logContent });
    } catch (err) {
      logger.error(`[❌ LOG] Error reading log file: ${err.message}`);
      return res.json({ valid: true, authorized: true, logs: "", error: "Failed to read log file." });
    }
  }
}

module.exports = UserController;