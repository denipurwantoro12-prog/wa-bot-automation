require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { GoogleGenAI } = require('@google/genai');
const cron = require('node-cron');
const fs = require('fs');
const { Parser } = require('json2csv');

const db = require('./db');
const prompts = require('./prompts');

const app = express();
const server = http.createServer(app);

// KONFIGURASI SOCKET.IO DENGAN BUFFER BESAR UNTUK UPLOAD MEDIA
const io = new Server(server, {
    maxHttpBufferSize: 1e8 // Limit buffer 100 MB untuk file/media
});

// INCREASE EXPRESS BODY LIMIT UNTUK UPLOAD BASE64 MEDIA
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static('public'));

// ===================================================
// DEKLARASI VARIABEL GLOBAL & STATE MANAGER
// ===================================================
const sessions = {}; 
const sessionStates = {}; // Track status: 'CONNECTED', 'NEED_QR', 'DISCONNECTED'
const currentQrCodes = {}; // Track QR Code terakhir per sessionId

let activeSessionId = db.getSetting('active_session_id') || 'default';
let currentQrCode = '';

const DEFAULT_PERSONA = `Kamu adalah Admin Toko yang ramah, sopan, dan sigap.
Tugasmu adalah membantu pembeli dengan memberikan informasi yang akurat berdasarkan data toko.
Jawab singkat (2-3 kalimat) dan gunakan bahasa yang mudah dipahami.`;

const DEFAULT_KNOWLEDGE = `Jam Operasional: Senin - Sabtu (08.00 - 17.00 WIB)
Metode Pembayaran: Transfer Bank, QRIS, COD`;

// FILTER TOXIC
const kataKasar = ['anjing', 'babi', 'bangsat', 'kontol', 'memek', 'goblok', 'tolol'];
function cekToxic(teks) {
    return kataKasar.some(kata => teks.toLowerCase().includes(kata));
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function getJitterDelay(minSeconds = 15, maxSeconds = 45) {
    const minMs = minSeconds * 1000;
    const maxMs = maxSeconds * 1000;
    return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
}

// GENERATOR AI GEMINI
async function generateMultimodalDinamis(contents, customKeysStr = '', fallbackText = '') {
    let keysToUse = customKeysStr.trim() 
        ? customKeysStr.split(',') 
        : (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '').split(',');

    const defaultFallback = fallbackText.trim() || 'Maaf Kak, CS kami sedang mengalami kendala teknis.';

    for (let attempt = 0; attempt < keysToUse.length; attempt++) {
        try {
            const activeKey = keysToUse[attempt].trim();
            if (!activeKey) continue;

            const ai = new GoogleGenAI({ apiKey: activeKey });
            const response = await ai.models.generateContent({
                model: 'gemini-3.1-flash-lite-preview',
                contents: contents
            });
            return response.text;
        } catch (err) {
            console.warn(`[API LIMIT] Key index ${attempt} limit/error. Mencoba key berikutnya...`);
        }
    }
    return defaultFallback;
}

// INISIALISASI WA CLIENT PER SESI
function initWhatsAppClient(sessionId) {
    if (sessions[sessionId]) {
        return sessions[sessionId];
    }

    console.log(`[SESSION] Menginisialisasi sesi WA: ${sessionId}`);
    sessionStates[sessionId] = 'CONNECTING';

    const client = new Client({
        authStrategy: new LocalAuth({ 
            clientId: sessionId,
            dataPath: './sessions' 
        }),
        puppeteer: { 
            headless: true, 
            args: ['--no-sandbox', '--disable-setuid-sandbox'] 
        }
    });

    client.on('qr', (qr) => {
        currentQrCodes[sessionId] = qr;
        sessionStates[sessionId] = 'NEED_QR';
        console.log(`[SESSION] Akun '${sessionId}' membutuhkan Scan QR!`);

        if (sessionId === activeSessionId) {
            currentQrCode = qr;
            qrcode.generate(qr, { small: true });
            io.emit('qr_code', { sessionId, qr });
        }

        io.emit('session_status_changed', { 
            sessionId, 
            status: 'NEED_QR', 
            qr,
            message: `Sesi '${sessionId}' terputus! Silakan Scan QR Code.` 
        });
    });

    client.on('ready', () => {
        console.log(`[SESSION READY] Akun WA '${sessionId}' Siap Digunakan!`);
        currentQrCodes[sessionId] = null;
        sessionStates[sessionId] = 'CONNECTED';

        if (sessionId === activeSessionId) {
            currentQrCode = '';
            io.emit('session_ready', { sessionId });
        }

        io.emit('session_status_changed', { sessionId, status: 'CONNECTED' });
    });

    client.on('authenticated', () => {
        console.log(`[SESSION AUTH] Akun '${sessionId}' Berhasil Otentikasi.`);
    });

    client.on('auth_failure', () => {
        console.error(`[SESSION ERROR] Otentikasi '${sessionId}' Gagal!`);
        sessionStates[sessionId] = 'DISCONNECTED';
        io.emit('session_error', { sessionId, message: 'Gagal otentikasi!' });
    });

    client.on('disconnected', async (reason) => {
        console.warn(`[SESSION DISCONNECTED] '${sessionId}' terputus. Alasan:`, reason);
        
        sessionStates[sessionId] = 'DISCONNECTED';
        currentQrCodes[sessionId] = null;
        const oldClient = sessions[sessionId];
        delete sessions[sessionId];

        // Hancurkan browser puppeteer lama agar tidak terjadi bentrokan binding pada re-initialization
        if (oldClient) {
            try {
                await oldClient.destroy();
            } catch (errDestroy) {
                console.error(`[DESTROY ERROR] ${sessionId}:`, errDestroy.message);
            }
        }

        io.emit('session_disconnected', { sessionId, reason });
        io.emit('session_status_changed', { 
            sessionId, 
            status: 'DISCONNECTED', 
            message: `Koneksi akun '${sessionId}' terputus!` 
        });
    });

    // LISTENER PESAN MASUK PER SESI
    client.on('message', async (msg) => {
        if (sessionId !== activeSessionId) return; 
        if (msg.from.includes('@g.us') || msg.isStatus) return;

        const jid = msg.from;
        const phone = jid.replace('@c.us', '').replace('@lid', '');
        let text = msg.body ? msg.body.trim() : '';

        db.saveContact(jid, phone);

        if (cekToxic(text)) {
            db.setToxic(jid, 1);
            db.setHandover(jid, 1);
            try {
                await msg.reply('Mohon gunakan bahasa yang sopan ya Kak. Percakapan ini kami alihkan ke Admin.');
            } catch (e) {}
            io.emit('contacts_updated', db.getAllContacts());
            return;
        }

        let promptContents = [];
        if (msg.hasMedia) {
            try {
                const media = await msg.downloadMedia();
                if (media) {
                    promptContents.push({
                        inlineData: { data: media.data, mimeType: media.mimetype }
                    });
                    text = text || '[Penerimaan Media/Gambar/Voice Note]';
                }
            } catch (e) {
                console.warn('Gagal mengunduh media dari pengguna:', e.message);
            }
        }

        db.saveMessage(jid, 'User', text);
        io.emit('new_message', { jid, sender: 'User', message: text });
        io.emit('contacts_updated', db.getAllContacts());

        if (text.toUpperCase() === 'STOP' || text.toUpperCase() === 'BERHENTI') {
            db.setBlacklist(jid, true);
            try { await msg.reply('Nomor Anda berhasil dihapus dari daftar broadcast.'); } catch (e) {}
            return;
        }

        if (text.toLowerCase().includes('admin') || text.toLowerCase().includes('human')) {
            db.setHandover(jid, true);
            try { await msg.reply('Pesan diteruskan ke Admin Manusia.'); } catch (e) {}
            io.emit('contacts_updated', db.getAllContacts());
            return;
        }

        const contact = db.getContact(jid);
        if (contact && contact.is_handover) return;

        // CEK SAKELAR AI ADMIN GLOBAL (ON / OFF)
        const isAiOn = (db.getSetting('ai_status') || 'ON') === 'ON';
        if (!isAiOn) {
            console.log('[AI OFF] Sakelar AI Admin sedang OFF. Pesan disimpan tanpa balasan otomatis.');
            return;
        }

        try {
            if (!msg.from.endsWith('@lid')) {
                try {
                    const chat = await msg.getChat();
                    if (chat) await chat.sendStateTyping();
                } catch (e) {}
            }

            const riwayatChat = db.getMessages(jid).slice(-6);
            const currentPersona = db.getSetting('persona_prompt') || DEFAULT_PERSONA;
            const currentKnowledge = db.getSetting('knowledge_base') || DEFAULT_KNOWLEDGE;

            const dynamicPrompt = `${currentPersona}

--- DATA KNOWLEDGE BASE TOKO ---
${currentKnowledge}
---------------------------------

Riwayat Chat Sebelumnya:
${riwayatChat.map(m => `${m.sender}: ${m.message}`).join('\n')}

Pembeli: ${text}`;

            promptContents.push(dynamicPrompt);

            const [jawabanAI] = await Promise.all([
                generateMultimodalDinamis(promptContents),
                delay(3000)
            ]);

            await msg.reply(jawabanAI);
            db.saveMessage(jid, 'Bot', jawabanAI);
            io.emit('new_message', { jid, sender: 'Bot', message: jawabanAI });
        } catch (err) {
            console.error('Error memproses jawaban AI:', err.message || err);
        }
    });

    client.initialize();
    sessions[sessionId] = client;
    return client;
}

// Inisialisasi Akun Pertama
initWhatsAppClient(activeSessionId);

function getActiveClient() {
    return sessions[activeSessionId] || initWhatsAppClient(activeSessionId);
}

// SOCKET.IO EVENTS
io.on('connection', (socket) => {
    socket.on('get_contacts', () => socket.emit('contacts_list', db.getAllContacts()));
    socket.on('get_messages', (jid) => socket.emit('messages_list', { jid, messages: db.getMessages(jid) }));
    
    socket.on('send_manual_reply', async ({ jid, message, media }) => {
        try {
            if (sessionStates[activeSessionId] !== 'CONNECTED') {
                console.warn('Gagal kirim balasan manual: Akun belum CONNECTED.');
                return;
            }
            const client = getActiveClient();
            if (media && media.data) {
                const mediaObj = new MessageMedia(media.mimetype, media.data, media.filename);
                await client.sendMessage(jid, mediaObj, { caption: message || '' });
                const logText = message ? `[Media: ${media.filename}] ${message}` : `[Media: ${media.filename}]`;
                db.saveMessage(jid, 'Admin', logText);
                io.emit('new_message', { jid, sender: 'Admin', message: logText });
            } else if (message) {
                await client.sendMessage(jid, message);
                db.saveMessage(jid, 'Admin', message);
                io.emit('new_message', { jid, sender: 'Admin', message });
            }
        } catch (err) {
            console.error('Error pengiriman balasan manual:', err.message || err);
        }
    });

    socket.on('update_label', ({ jid, label }) => {
        db.setLabel(jid, label);
        io.emit('contacts_updated', db.getAllContacts());
    });

    socket.on('toggle_handover', ({ jid, status }) => {
        db.setHandover(jid, status);
        io.emit('contacts_updated', db.getAllContacts());
    });
});

// ENDPOINT TOGGLE AI ADMIN GLOBAL
app.get('/api/ai-toggle', (req, res) => {
    const status = db.getSetting('ai_status') || 'ON';
    res.json({ aiStatus: status });
});

app.post('/api/ai-toggle', (req, res) => {
    const { status } = req.body;
    const newStatus = status === 'OFF' ? 'OFF' : 'ON';
    db.saveSetting('ai_status', newStatus);
    io.emit('ai_status_changed', { aiStatus: newStatus });
    res.json({ success: true, aiStatus: newStatus, message: `AI Admin sekarang ${newStatus}` });
});

// ENDPOINT MANAJEMEN AKUN
app.get('/api/sessions', (req, res) => {
    const sessionDir = './sessions';
    let availableSessions = ['default'];

    if (fs.existsSync(sessionDir)) {
        const files = fs.readdirSync(sessionDir);
        const folderSessions = files
            .filter(f => f.startsWith('session-'))
            .map(f => f.replace('session-', ''));
        availableSessions = Array.from(new Set(['default', ...folderSessions]));
    }

    res.json({
        activeSession: activeSessionId,
        activeState: sessionStates[activeSessionId] || 'UNKNOWN',
        activeQr: currentQrCodes[activeSessionId] || null,
        sessions: availableSessions
    });
});

app.post('/api/sessions/switch', async (req, res) => {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ success: false, message: 'Session ID wajib diisi' });

    activeSessionId = sessionId;
    db.saveSetting('active_session_id', sessionId);

    initWhatsAppClient(sessionId);

    res.json({ success: true, message: `Berhasil beralih ke akun '${sessionId}'`, activeSession: activeSessionId });
});

app.post('/api/sessions/create', async (req, res) => {
    const { sessionId } = req.body;
    const cleanId = sessionId.trim().replace(/[^a-zA-Z0-9_-]/g, '');

    if (!cleanId) return res.status(400).json({ success: false, message: 'Nama Akun / Session ID tidak valid' });

    activeSessionId = cleanId;
    db.saveSetting('active_session_id', cleanId);

    initWhatsAppClient(cleanId);

    res.json({ success: true, message: `Akun baru '${cleanId}' dibuat. Silakan scan QR Code!`, activeSession: cleanId });
});

// ENDPOINT RE-LOGIN / RECONNECT AKUN
app.post('/api/sessions/reconnect', async (req, res) => {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ success: false, message: 'Session ID wajib diisi' });

    console.log(`[RECONNECT] Memulai ulang sesi '${sessionId}'...`);

    // Hancurkan client lama jika masih menggantung
    if (sessions[sessionId]) {
        try {
            await sessions[sessionId].destroy();
        } catch (e) {
            console.error(`[DESTROY FAIL] ${sessionId}:`, e.message);
        }
        delete sessions[sessionId];
    }

    activeSessionId = sessionId;
    db.saveSetting('active_session_id', sessionId);
    sessionStates[sessionId] = 'CONNECTING';

    // Inisialisasi ulang client (akan memicu pendaftaran QR Code baru)
    initWhatsAppClient(sessionId);

    res.json({ 
        success: true, 
        message: `Menghubungkan ulang akun '${sessionId}'... Silakan scan QR Code yang muncul.` 
    });
});

// EXPORT CONTACTS CSV
app.get('/api/export-contacts', (req, res) => {
    const contacts = db.getAllContacts();
    const json2csvParser = new Parser();
    const csv = json2csvParser.parse(contacts);
    res.header('Content-Type', 'text/csv');
    res.attachment('daftar_kontak_wa.csv');
    return res.send(csv);
});

// MEMULAI CHAT BARU
app.post('/api/new-chat', async (req, res) => {
    try {
        if (sessionStates[activeSessionId] !== 'CONNECTED') {
            return res.status(400).json({ success: false, message: 'Akun WhatsApp belum terhubung/CONNECTED!' });
        }

        const { phone, message } = req.body;
        let formattedPhone = phone.trim().replace(/[^0-9]/g, '');
        
        if (formattedPhone.startsWith('0')) {
            formattedPhone = '62' + formattedPhone.slice(1);
        }
        
        const client = getActiveClient();
        const numberDetails = await client.getNumberId(formattedPhone);
        
        if (!numberDetails || !numberDetails._serialized) {
            return res.status(400).json({ success: false, message: 'Nomor tidak terdaftar di WhatsApp!' });
        }

        const jid = numberDetails._serialized;
        await client.sendMessage(jid, message);

        db.saveContact(jid, formattedPhone);
        db.saveMessage(jid, 'Admin', message);
        io.emit('contacts_updated', db.getAllContacts());
        io.emit('new_message', { jid, sender: 'Admin', message });

        res.json({ success: true, message: 'Berhasil mengirim pesan ke nomor baru!' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// SETTINGS PERSONA & KNOWLEDGE BASE
app.get('/api/settings', (req, res) => {
    const persona = db.getSetting('persona_prompt') || DEFAULT_PERSONA;
    const knowledge = db.getSetting('knowledge_base') || DEFAULT_KNOWLEDGE;
    res.json({ persona, knowledge });
});

app.post('/api/settings', (req, res) => {
    const { persona, knowledge } = req.body;
    if (persona !== undefined) db.saveSetting('persona_prompt', persona);
    if (knowledge !== undefined) db.saveSetting('knowledge_base', knowledge);
    res.json({ success: true, message: 'Pengaturan Persona & Knowledge Base berhasil disimpan!' });
});

// API BROADCAST MASSAL
app.post('/api/broadcast', async (req, res) => {
    if (sessionStates[activeSessionId] !== 'CONNECTED') {
        return res.status(400).json({ success: false, message: 'Akun WhatsApp belum terhubung/CONNECTED! Mohon scan QR atau tunggu hingga terhubung.' });
    }

    const { draft, prompt, targets, numbers, scheduledTime, customKeys, fallbackMsg, media } = req.body;
    
    let rawList = targets || numbers || [];
    let listTargets = rawList.map(item => {
        if (!item) return null;
        if (typeof item === 'string') {
            const parts = item.split(/[,|\t]/);
            return { phone: parts[0] ? parts[0].trim() : '', name: parts[1] ? parts[1].trim() : '' };
        }
        if (typeof item === 'object' && item !== null) {
            return { phone: item.phone ? String(item.phone).trim() : '', name: item.name ? String(item.name).trim() : '' };
        }
        return null;
    }).filter(item => item && item.phone);

    if (scheduledTime) {
        db.saveScheduledBroadcast(draft, prompt, JSON.stringify(listTargets), scheduledTime);
        return res.json({ message: 'Broadcast berhasil dijadwalkan!' });
    }
    
    res.json({ message: 'Proses broadcast dimulai!' });

    const client = getActiveClient();
    let counter = 0;

    let mediaObj = null;
    if (media && media.data) {
        mediaObj = new MessageMedia(media.mimetype, media.data, media.filename);
    }

    for (let targetObj of listTargets) {
        let phone = targetObj.phone;
        let name = targetObj.name;

        let cleaned = phone.replace(/[^0-9]/g, '');
        if (!cleaned) continue;

        if (cleaned.startsWith('0')) cleaned = '62' + cleaned.slice(1);

        let jid = `${cleaned}@c.us`;
        try {
            const numberDetails = await client.getNumberId(cleaned);
            if (numberDetails && numberDetails._serialized) {
                jid = numberDetails._serialized;
            } else {
                console.warn(`[BROADCAST SKIP] Nomor ${phone} (${cleaned}) tidak terdaftar di WA.`);
                continue;
            }
        } catch (errCheck) {
            console.warn(`[NUMBER CHECK NOTICE] ${cleaned}:`, errCheck.message || errCheck);
            if (cleaned.length >= 10) {
                jid = `${cleaned}@c.us`;
            } else {
                continue;
            }
        }

        const contact = db.getContact(jid);
        if (contact && contact.is_blacklisted) continue;

        const promptBroadcast = `Draf Utama: ${draft}
Gaya/Instruksi Tambahan: ${prompt || 'Buat ramah, bersahabat, dan selipkan emoticon.'}
Nama Penerima Pesan: ${name ? name : 'Pelanggan'}

Tugas AI: Tulis ulang Draf Utama menjadi pesan broadcast WhatsApp yang unik dan bervariasi. ${name ? `Sapa penerima secara personal dengan nama "${name}" secara alami di dalam kalimat.` : 'Gunakan sapaan umum yang ramah seperti Kak.'}`;

        const pesanUnik = await generateMultimodalDinamis(promptBroadcast, customKeys || '', fallbackMsg || draft);

        try {
            if (mediaObj) {
                await client.sendMessage(jid, mediaObj, { caption: pesanUnik });
            } else {
                await client.sendMessage(jid, pesanUnik);
            }
            const logText = mediaObj ? `[Media: ${media.filename}] ${pesanUnik}` : pesanUnik;
            db.saveContact(jid, phone, name);
            db.saveMessage(jid, 'Bot', pesanUnik);
            io.emit('new_message', { jid, sender: 'Bot', message: logText });
            console.log(`[BROADCAST SUCCESS] Terkirim ke ${jid}`);
        } catch (e) {
            console.error(`Error broadcast target (${phone}):`, e.message || e);
        }

        counter++;
        if (counter % 10 === 0) {
            const istirahatMs = getJitterDelay(120, 300);
            console.log(`[MICRO-BREAK] Istirahat selama ${Math.round(istirahatMs / 1000 / 60)} menit...`);
            await delay(istirahatMs);
        } else {
            const jedaAman = getJitterDelay(15, 45);
            console.log(`[JITTER] Menunggu ${Math.round(jedaAman / 1000)} detik...`);
            await delay(jedaAman);
        }
    }
});

// CRON SCHEDULER
cron.schedule('* * * * *', async () => {
    if (sessionStates[activeSessionId] !== 'CONNECTED') return;

    const pending = db.getPendingBroadcasts();
    if (pending.length === 0) return;

    const client = getActiveClient();
    for (let job of pending) {
        const rawTargets = JSON.parse(job.numbers);
        let listTargets = rawTargets.map(item => {
            if (!item) return null;
            if (typeof item === 'string') {
                const parts = item.split(/[,|\t]/);
                return { phone: parts[0] ? parts[0].trim() : '', name: parts[1] ? parts[1].trim() : '' };
            }
            if (typeof item === 'object' && item !== null) {
                return { phone: item.phone ? String(item.phone).trim() : '', name: item.name ? String(item.name).trim() : '' };
            }
            return null;
        }).filter(item => item && item.phone);

        let counter = 0;
        for (let targetObj of listTargets) {
            let phone = targetObj.phone;
            let name = targetObj.name;

            let cleaned = phone.replace(/[^0-9]/g, '');
            if (!cleaned) continue;

            if (cleaned.startsWith('0')) cleaned = '62' + cleaned.slice(1);

            let jid = `${cleaned}@c.us`;
            try {
                const numberDetails = await client.getNumberId(cleaned);
                if (numberDetails && numberDetails._serialized) {
                    jid = numberDetails._serialized;
                } else {
                    continue;
                }
            } catch (e) {}

            const contact = db.getContact(jid);
            if (contact && contact.is_blacklisted) continue;

            const promptBroadcast = `Draf Utama: ${job.draft}
Gaya/Instruksi Tambahan: ${job.prompt || 'Buat ramah, bersahabat, dan selipkan emoticon.'}
Nama Penerima Pesan: ${name ? name : 'Pelanggan'}

Tugas AI: Tulis ulang Draf Utama menjadi pesan broadcast WhatsApp yang unik dan bervariasi. ${name ? `Sapa penerima secara personal dengan nama "${name}" secara alami di dalam kalimat.` : 'Gunakan sapaan umum yang ramah seperti Kak.'}`;

            const pesanUnik = await generateMultimodalDinamis(promptBroadcast, '', job.draft);

            try {
                await client.sendMessage(jid, pesanUnik);
                db.saveContact(jid, phone, name);
                db.saveMessage(jid, 'Bot', pesanUnik);
                io.emit('new_message', { jid, sender: 'Bot', message: pesanUnik });
            } catch (e) {
                console.error(`Error cron broadcast (${phone}):`, e.message || e);
            }

            counter++;
            if (counter % 10 === 0) {
                await delay(getJitterDelay(120, 300));
            } else {
                await delay(getJitterDelay(15, 45));
            }
        }
        db.markBroadcastDone(job.id);
    }
});

server.listen(3000, () => console.log('Dashboard berjalan di http://localhost:3000'));