const fs = require('fs');
const path = require('path');

// Import chalk dengan benar untuk v5+
let chalk;
try {
  // Coba import chalk v5+ (ESM)
  chalk = require('chalk');
} catch (err) {
  // Fallback ke chalk v4 atau tanpa warna
  try {
    const chalkV4 = require('chalk');
    chalk = chalkV4;
  } catch (err2) {
    // Jika chalk tidak tersedia, gunakan fungsi dummy
    chalk = {
      blue: (text) => text,
      red: (text) => text,
      yellow: (text) => text,
      cyan: (text) => text,
      green: (text) => text
    };
  }
}

// Create logs directory if it doesn't exist
const logsDir = path.join(__dirname, '../../logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// Fungsi untuk mendapatkan timestamp yang diformat
function getTimestamp() {
  const now = new Date();
  return now.toISOString();
}

// Fungsi untuk format log message
function formatLogMessage(level, message, meta = {}) {
  const timestamp = getTimestamp();
  let logMessage = `[${timestamp}] [${level}] ${message}`;
  
  // Tambahkan metadata jika ada
  if (Object.keys(meta).length > 0) {
    try {
      logMessage += ` | ${JSON.stringify(meta)}`;
    } catch (err) {
      logMessage += ` | [Circular Reference]`;
    }
  }
  
  return logMessage;
}

// Fungsi untuk menulis ke file dengan rotasi
function writeToFile(filename, message) {
  const filePath = path.join(logsDir, filename);
  
  try {
    // Buat file jika belum ada
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, '');
    }
    
    // Cek ukuran file, jika lebih dari 10MB, backup
    const stats = fs.statSync(filePath);
    if (stats.size > 10 * 1024 * 1024) { // 10MB
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupPath = filePath.replace('.log', `_${timestamp}.log`);
      fs.renameSync(filePath, backupPath);
      fs.writeFileSync(filePath, message + '\n');
    } else {
      fs.appendFileSync(filePath, message + '\n');
    }
  } catch (err) {
    console.error('Error writing to log file:', err.message);
  }
}

// Enhanced logger dengan lebih banyak fitur
const logger = {
  // Enhanced info method dengan warna dan metadata
  info: (message, meta = {}) => {
    const logMessage = formatLogMessage('INFO', message, meta);
    
    // Output ke console dengan warna biru
    if (chalk && typeof chalk.blue === 'function') {
      console.log(chalk.blue(logMessage));
    } else {
      console.log(logMessage);
    }
    
    // Tulis ke file app.log
    writeToFile('app.log', logMessage);
    
    // Jika ada error dalam meta, juga tulis ke error.log
    if (meta && meta.error) {
      writeToFile('error.log', logMessage);
    }
  },
  
  // Error method dengan warna merah
  error: (message, meta = {}) => {
    const logMessage = formatLogMessage('ERROR', message, meta);
    
    // Output ke console dengan warna merah
    if (chalk && typeof chalk.red === 'function') {
      console.error(chalk.red(logMessage));
    } else {
      console.error(logMessage);
    }
    
    // Tulis ke error.log
    writeToFile('error.log', logMessage);
    
    // Juga tulis ke app.log untuk tracking
    writeToFile('app.log', logMessage);
  },
  
  // Warning method dengan warna kuning
  warn: (message, meta = {}) => {
    const logMessage = formatLogMessage('WARN', message, meta);
    
    // Output ke console dengan warna kuning
    if (chalk && typeof chalk.yellow === 'function') {
      console.warn(chalk.yellow(logMessage));
    } else {
      console.warn(logMessage);
    }
    
    // Tulis ke app.log
    writeToFile('app.log', logMessage);
  },
  
  // Debug method dengan warna cyan
  debug: (message, meta = {}) => {
    const logMessage = formatLogMessage('DEBUG', message, meta);
    
    // Hanya tampilkan debug jika NODE_ENV=development
    if (process.env.NODE_ENV === 'development') {
      if (chalk && typeof chalk.cyan === 'function') {
        console.log(chalk.cyan(logMessage));
      } else {
        console.log(logMessage);
      }
    }
    
    // Tulis ke debug.log
    writeToFile('debug.log', logMessage);
  },
  
  // Success method dengan warna hijau
  success: (message, meta = {}) => {
    const logMessage = formatLogMessage('SUCCESS', message, meta);
    
    // Output ke console dengan warna hijau
    if (chalk && typeof chalk.green === 'function') {
      console.log(chalk.green(logMessage));
    } else {
      console.log(logMessage);
    }
    
    // Tulis ke app.log
    writeToFile('app.log', logMessage);
  },
  
  // HTTP request logger
  http: (req, res, responseTime) => {
    const message = `${req.method} ${req.originalUrl || req.url} - ${res.statusCode}`;
    const meta = {
      method: req.method,
      url: req.originalUrl || req.url,
      statusCode: res.statusCode,
      responseTime: `${responseTime}ms`,
      userAgent: req.get('User-Agent'),
      ip: req.ip || req.connection?.remoteAddress || req.socket?.remoteAddress
    };
    
    if (res.statusCode >= 400) {
      logger.error(message, meta);
    } else {
      logger.info(message, meta);
    }
  },
  
  // WebSocket logger
  ws: (event, data, meta = {}) => {
    const message = `WebSocket ${event}`;
    logger.info(message, { ...meta, wsEvent: event, wsData: data });
  },
  
  // Database operation logger
  db: (operation, table, meta = {}) => {
    const message = `DB ${operation} on ${table}`;
    logger.info(message, { ...meta, operation, table });
  },
  
  // Security event logger
  security: (event, details, meta = {}) => {
    const message = `SECURITY: ${event}`;
    logger.warn(message, { ...meta, securityEvent: event, details });
  },
  
  // Performance logger
  performance: (operation, duration, meta = {}) => {
    const message = `PERF: ${operation} took ${duration}ms`;
    if (duration > 1000) {
      logger.warn(message, { ...meta, performance: true, slow: true });
    } else {
      logger.info(message, { ...meta, performance: true });
    }
  },
  
  // API call logger
  api: (method, endpoint, statusCode, responseTime, meta = {}) => {
    const message = `API ${method} ${endpoint} - ${statusCode}`;
    const logMeta = {
      ...meta,
      method,
      endpoint,
      statusCode,
      responseTime: `${responseTime}ms`
    };
    
    if (statusCode >= 400) {
      logger.error(message, logMeta);
    } else {
      logger.info(message, logMeta);
    }
  },
  
  // Utility method untuk log objek besar
  logObject: (obj, label = 'Object') => {
    try {
      const message = `${label}: ${JSON.stringify(obj, null, 2)}`;
      logger.debug(message);
    } catch (err) {
      logger.error(`Failed to log object ${label}: ${err.message}`);
    }
  }
};

// Export logger dan juga fungsi helper
module.exports = {
  logger,
  getTimestamp,
  formatLogMessage,
  writeToFile
};

// Juga export default untuk kemudahan
module.exports.default = logger;