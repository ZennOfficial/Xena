const app = require('./src/app');
const { PORT } = require('./src/utils/constants');
const { startUserSessions } = require('./src/services/whatsappService');
const { startTelegramBot } = require('./src/services/telegramService');

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server aktif di http://localhost:${PORT}`);
  startUserSessions();
  startTelegramBot();
});