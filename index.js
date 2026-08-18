require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { GoogleGenAI } = require('@google/genai');
const cron = require('node-cron');
const fs = require('fs');
const { Parser } = require('json2csv');

const db = require('./db');
const prompts = require('./prompts');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static('public'));

// MANAJEMEN MULTI SESI / AKUN
const sessions = {}; 
let activeSessionId = db.getSetting('active_session_id') || 'default';
let currentQrCode = '';

function initWhatsAppClient(sessionId) {
    if (sessions[sessionId]) {
        return sessions[sessionId];
    }

    console.log(`[SESSION] Menginisialisasi sesi WA: ${sessionId}`);

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
        if (sessionId === activeSessionId) {
            currentQrCode = qr;
            qrcode.generate(qr, { small: true });
            io.emit('qr_code', { sessionId, qr });
        }
    });

    client.on('ready', () => {
        console.log(`[SESSION READY] Akun WA '${sessionId}' Siap Digunakan!`);
        if (sessionId === activeSessionId) {
            currentQrCode = '';
            io.emit('session_ready', { sessionId });
        }
    });

    client.on('authenticated', () => {
        console.log(`[SESSION AUTH] Akun '${sessionId}' Berhasil Otentikasi.`);
    });

    client.on('auth_failure', () => {
        console.error(`[SESSION ERROR] Otentikasi '${sessionId}' Gagal!`);
        io.emit('session_error', { sessionId, message: 'Gagal otentikasi!' });
    });

    client.on('disconnected', (reason) => {
        console.warn(`[SESSION DISCONNECTED] '${sessionId}' terputus. Alasan:`, reason);
        delete sessions[sessionId];
        io.emit('session_disconnected', { sessionId, reason });
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
            await msg.reply('Mohon gunakan bahasa yang sopan ya Kak. Percakapan ini kami alihkan ke Admin.');
            io.emit('contacts_updated', db.getAllContacts());
            return;
        }

        let promptContents = [];
        if (msg.hasMedia) {
            const media = await msg.downloadMedia();
            if (media) {
                promptContents.push({
                    inlineData: { data: media.data, mimeType: media.mimetype }
                });
                text = text || '[Penerimaan Media/Gambar/Voice Note]';
            }
        }

        db.saveMessage(jid, 'User', text);
        io.emit('new_message', { jid, sender: 'User', message: text });
        io.emit('contacts_updated', db.getAllContacts());

        if (text.toUpperCase() === 'STOP' || text.toUpperCase() === 'BERHENTI') {
            db.setBlacklist(jid, true);
            await msg.reply('Nomor Anda berhasil dihapus dari daftar broadcast.');
            return;
        }

        if (text.toLowerCase().includes('admin') || text.toLowerCase().includes('human')) {
            db.setHandover(jid, true);
            await msg.reply('Pesan diteruskan ke Admin Manusia.');
            io.emit('contacts_updated', db.getAllContacts());
            return;
        }

        const contact = db.getContact(jid);
        if (contact && contact.is_handover) return;

        // CEK SAKELAR AI ADMIN GLOBAL (ON / OFF)
        const isAiOn = (db.getSetting('ai_status') || 'ON') === 'ON';
        if (!isAiOn) {
            console.log('[AI OFF] Sakelar AI Admin sedang OFF. Pesan disimpan tanpa balasan otomatis.');
            return; // Hentikan di sini, jangan balasan AI
        }

        try {
            try {
                const chat = await msg.getChat();
                if (chat) await chat.sendStateTyping();
            } catch (e) {}

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
        } catch (err) {}
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

// SOCKET.IO EVENTS
io.on('connection', (socket) => {
    socket.on('get_contacts', () => socket.emit('contacts_list', db.getAllContacts()));
    socket.on('get_messages', (jid) => socket.emit('messages_list', { jid, messages: db.getMessages(jid) }));
    
    socket.on('send_manual_reply', async ({ jid, message }) => {
        try {
            const client = getActiveClient();
            await client.sendMessage(jid, message);
            db.saveMessage(jid, 'Admin', message);
            io.emit('new_message', { jid, sender: 'Admin', message });
        } catch (err) {}
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

// ENDPOINT TOGGLE AI ADMIN GLOBAL (ON / OFF)
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
        sessions: availableSessions
    });
});

app.post('/api/sessions/switch', (req, res) => {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ success: false, message: 'Session ID wajib diisi' });

    activeSessionId = sessionId;
    db.saveSetting('active_session_id', sessionId);

    initWhatsAppClient(sessionId);

    res.json({ success: true, message: `Berhasil beralih ke akun '${sessionId}'`, activeSession: activeSessionId });
});

app.post('/api/sessions/create', (req, res) => {
    const { sessionId } = req.body;
    const cleanId = sessionId.trim().replace(/[^a-zA-Z0-9_-]/g, '');

    if (!cleanId) return res.status(400).json({ success: false, message: 'Nama Akun / Session ID tidak valid' });

    activeSessionId = cleanId;
    db.saveSetting('active_session_id', cleanId);

    initWhatsAppClient(cleanId);

    res.json({ success: true, message: `Akun baru '${cleanId}' dibuat. Silakan scan QR Code!`, activeSession: cleanId });
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
        const { phone, message } = req.body;
        let formattedPhone = phone.trim().replace(/[^0-9]/g, '');
        
        if (formattedPhone.startsWith('0')) {
            formattedPhone = '62' + formattedPhone.slice(1);
        }
        
        const jid = `${formattedPhone}@c.us`;
        const client = getActiveClient();

        const isRegistered = await client.isRegisteredUser(jid);
        if (!isRegistered) {
            return res.status(400).json({ success: false, message: 'Nomor tidak terdaftar di WhatsApp!' });
        }

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
const DEFAULT_PERSONA = `Kamu adalah Admin Toko yang ramah, sopan, dan sigap.
Tugasmu adalah membantu pembeli dengan memberikan informasi yang akurat berdasarkan data toko.
Jawab singkat (2-3 kalimat) dan gunakan bahasa yang mudah dipahami.`;

const DEFAULT_KNOWLEDGE = `Jam Operasional: Senin - Sabtu (08.00 - 17.00 WIB)
Metode Pembayaran: Transfer Bank, QRIS, COD`;

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
    const { draft, prompt, numbers, scheduledTime, customKeys, fallbackMsg } = req.body;
    
    if (scheduledTime) {
        db.saveScheduledBroadcast(draft, prompt, JSON.stringify(numbers), scheduledTime);
        return res.json({ message: 'Broadcast berhasil dijadwalkan!' });
    }
    
    res.json({ message: 'Proses broadcast dimulai!' });

    const client = getActiveClient();
    let counter = 0;
    for (let target of numbers) {
        let jid = target.trim();
        if (!jid.endsWith('@c.us')) jid = `${jid}@c.us`;
        
        const contact = db.getContact(jid);
        if (contact && contact.is_blacklisted) continue;

        const promptBroadcast = prompts.getBroadcastPrompt(draft, prompt);
        const pesanUnik = await generateMultimodalDinamis(promptBroadcast, customKeys || '', fallbackMsg || draft);

        try {
            await client.sendMessage(jid, pesanUnik);
            db.saveContact(jid, target.trim());
            db.saveMessage(jid, 'Bot', pesanUnik);
            io.emit('new_message', { jid, sender: 'Bot', message: pesanUnik });
        } catch (e) {}

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
    const pending = db.getPendingBroadcasts();
    if (pending.length === 0) return;

    const client = getActiveClient();
    for (let job of pending) {
        const numbers = JSON.parse(job.numbers);
        let counter = 0;
        for (let target of numbers) {
            let jid = target.trim();
            if (!jid.endsWith('@c.us')) jid = `${jid}@c.us`;

            const contact = db.getContact(jid);
            if (contact && contact.is_blacklisted) continue;

            const promptBroadcast = prompts.getBroadcastPrompt(job.draft, job.prompt);
            const pesanUnik = await generateMultimodalDinamis(promptBroadcast, '', job.draft);

            try {
                await client.sendMessage(jid, pesanUnik);
                db.saveContact(jid, target.trim());
                db.saveMessage(jid, 'Bot', pesanUnik);
                io.emit('new_message', { jid, sender: 'Bot', message: pesanUnik });
            } catch (e) {}

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