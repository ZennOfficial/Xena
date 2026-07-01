const rateLimit = require('express-rate-limit');
const { logger } = require('../utils/logger');

const rateLimitMap = {};

const rateLimiter = rateLimit({
  windowMs: 1000, // 1 second
  max: 20, // limit each IP to 20 requests per windowMs
  message: {
    valid: false,
    rateLimit: true,
    message: "Terlalu banyak permintaan! Maksimal 20 request per detik."
  },
  validate: { xForwardedForHeader: false },
  handler: (req, res) => {
    const key = (req.query && req.query.key) || (req.body && req.body.key) || null;
    
    if (key) {
      const { loadDatabase } = require('../services/databaseService');
      const db = loadDatabase();
      const user = db.find(u => u.username === (activeKeys[key]?.username || "unknown"));
      logger.warn(`[🚫 RATE LIMIT] Token '${key}' (${user?.username || 'unknown'}) melebihi batas 20 req/detik.`);
    }
    
    res.status(429).json({
      valid: false,
      rateLimit: true,
      message: "Terlalu banyak permintaan! Maksimal 20 request per detik."
    });
  },
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = rateLimiter;