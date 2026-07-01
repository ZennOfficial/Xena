const express = require('express');
const UserController = require('../controllers/userController');
const { logger } = require('../utils/logger');
const { activeKeys } = require('../middleware/authMiddleware');
const { loadDatabase, saveDatabase } = require('../services/databaseService');

const router = express.Router();
// Get user activity logs
router.get("/getActivityLogs", (req, res) => {
  const { key, limit = 50 } = req.query;
  
  const keyInfo = activeKeys[key];
  if (!keyInfo) {
    logger.info("[❌ ACTIVITY LOG] Key tidak valid.");
    return res.status(401).json({ error: "Invalid session key" });
  }

  const db = loadDatabase();
  const user = db.find(u => u.username === keyInfo.username);
  if (!user) {
    logger.info("[❌ ACTIVITY LOG] User tidak ditemukan.");
    return res.status(401).json({ error: "User not found" });
  }

  // Hanya moderator yang bisa melihat semua log
  if (user.role === "moderator") {
    const { getActivityLogs } = require('../services/activityLogService');
    const allLogs = getActivityLogs();
    
    return res.json({
      valid: true,
      logs: allLogs.slice(0, parseInt(limit))
    });
  } else {
    // User lain hanya bisa melihat lognya sendiri
    const { getUserActivityLogs } = require('../services/activityLogService');
    const userLogs = getUserActivityLogs(user.username, parseInt(limit));
    
    return res.json({
      valid: true,
      logs: userLogs
    });
  }
});
// Create account
router.get("/createAccount", UserController.createAccount);

// Delete user (admin only)
router.get("/deleteUser", UserController.deleteAccount);

// Show all users (admin only)
router.get("/listUsers", UserController.listUsers);

// Add user with role (moderator only)
router.get("/userAdd", UserController.userAdd);

// Edit user expiration date (partner or moderator)
router.get("/editUser", UserController.editUser);

// Change password
router.post("/changepass", UserController.changePassword);

// Get logs (moderator only)
router.get("/getLog", UserController.getLog);

module.exports = router;