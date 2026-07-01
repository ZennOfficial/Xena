const UserModel = require('../models/userModel');
const SessionModel = require('../models/sessionModel');
const { BUGS, NEWS, DDOS, payload } = require('../utils/constants');
const { logger } = require('../utils/logger');

class AuthController {
  static async validate(req, res) {
    const { username, password, version, androidId } = req.body;

    if (!androidId) {
      return res.json({ valid: false, message: "androidId required" });
    }

    const user = UserModel.findByUsernameAndPassword(username, password);
    if (!user) return res.json({ valid: false });

    if (UserModel.isExpired(user)) {
      return res.json({ valid: true, expired: true });
    }

    // Check if device is different
    const existingSession = SessionModel.findByUsername(username);
    if (existingSession && existingSession.androidId !== androidId) {
      logger.info(`[📱] Device login baru, override session untuk ${username}`);
    }

    // Create new session
    const session = SessionModel.create({
      username,
      ipAddress: req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip,
      androidId
    });

    return res.json({
      valid: true,
      expired: false,
      key: session.sessionKey,
      expiredDate: user.expiredDate,
      role: user.role || "member",
      listBug: BUGS,
      listPayload: payload,
      listDDoS: DDOS,
      news: NEWS
    });
  }

  static async getMyInfo(req, res) {
    const { username, password, androidId, key } = req.query;
    logger.info(`[ℹ️ INFO] Fetching info for: ${username}`);

    const user = UserModel.findByUsernameAndPassword(username, password);
    const userSession = SessionModel.findByUsername(username);

    if (!userSession) {
      logger.info("[❌ KEY] Invalid or missing session key.");
      return res.json({ valid: false, reason: "session" });
    }

    if (userSession.androidId !== androidId) {
      logger.info(`[⚠️ DEVICE] Device mismatch: ${userSession.androidId} != ${androidId}`);
      return res.json({ valid: false, reason: "device" });
    }

    if (!user) {
      logger.info("[❌ INFO] User not found.");
      return res.json({ valid: false });
    }

    if (UserModel.isExpired(user)) {
      logger.info("[⚠️ INFO] User expired.");
      return res.json({ valid: true, expired: true });
    }

    // Update session
    SessionModel.updateByUsername(username, {
      lastLogin: new Date().toISOString(),
      ipAddress: req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip,
      androidId
    });

    logger.info(`[✅ INFO] Info dikirim untuk: ${username}`);

    return res.json({
      valid: true,
      expired: false,
      key,
      username: user.username,
      password: "******",
      expiredDate: user.expiredDate,
      role: user.role || "member",
      listBug: BUGS,
      listPayload: payload,
      listDDoS: DDOS,
      news: NEWS
    });
  }
}

module.exports = AuthController;