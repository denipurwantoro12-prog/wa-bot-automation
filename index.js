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

// 1. Load Knowledge Base untuk RAG
let knowledgeData = '';
try { 
    knowledgeData = fs.readFileSync('./knowledge.json', 'utf8'); 
} catch (e) {
    console.log('File knowledge.json tidak ditemukan, berjalan tanpa data RAG.');
}

// 2. Generator Multimodal Dinamis (Failover, Custom Keys UI, & Fallback Message)
async function generateMultimodalDinamis(contents, customKeysStr = '', fallbackText = '') {
    // Utamakan key dari UI form expandable, jika kosong gunakan dari .env
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
            console.warn(`[API LIMIT/ERROR] Key index ${attempt} bermasalah. Mencoba failover ke key berikutnya...`);
        }
    }
    // Jika semua API Key bermasalah, kirimkan pesan fallback
    return defaultFallback;
}

// 3. Filter Kata Kasar (Toxic Filter)
const kataKasar = ['anjing', 'babi', 'bangsat', 'kontol', 'memek', 'goblok', 'tolol'];
function cekToxic(teks) {
    return kataKasar.some(kata => teks.toLowerCase().includes(kata));
}

// 4. Inisialisasi WhatsApp Client
const client = new Client({
    authStrategy: new LocalAuth({ dataPath: './sessions' }),
    puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] }
});

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Helper Jitter: Menghasilkan jeda acak (default 15 - 45 detik)
function getJitterDelay(minSeconds = 15, maxSeconds = 45) {
    const minMs = minSeconds * 1000;
    const maxMs = maxSeconds * 1000;
    return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
}

// 5. Socket.io Real-Time Events
io.on('connection', (socket) => {
    socket.on('get_contacts', () => socket.emit('contacts_list', db.getAllContacts()));
    socket.on('get_messages', (jid) => socket.emit('messages_list', { jid, messages: db.getMessages(jid) }));
    
    socket.on('send_manual_reply', async ({ jid, message }) => {
        try {
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

// 6. Endpoint Export Contacts to CSV
app.get('/api/export-contacts', (req, res) => {
    const contacts = db.getAllContacts();
    const json2csvParser = new Parser();
    const csv = json2csvParser.parse(contacts);
    res.header('Content-Type', 'text/csv');
    res.attachment('daftar_kontak_wa.csv');
    return res.send(csv);
});

// 7. Endpoint untuk Memulai Chat ke Nomor Baru
app.post('/api/new-chat', async (req, res) => {
    try {
        const { phone, message } = req.body;
        let formattedPhone = phone.trim().replace(/[^0-9]/g, '');
        
        if (formattedPhone.startsWith('0')) {
            formattedPhone = '62' + formattedPhone.slice(1);
        }
        
        const jid = `${formattedPhone}@c.us`;

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

// 8. API Broadcast Massal (Mendukung Custom API Keys, Fallback Message, & Anti-Banned Jitter)
app.post('/api/broadcast', async (req, res) => {
    const { draft, prompt, numbers, scheduledTime, customKeys, fallbackMsg } = req.body;
    
    if (scheduledTime) {
        db.saveScheduledBroadcast(draft, prompt, JSON.stringify(numbers), scheduledTime);
        return res.json({ message: 'Broadcast berhasil dijadwalkan!' });
    }
    
    res.json({ message: 'Proses broadcast dimulai!' });

    let counter = 0;
    for (let target of numbers) {
        let jid = target.trim();
        if (!jid.endsWith('@c.us')) jid = `${jid}@c.us`;
        
        const contact = db.getContact(jid);
        if (contact && contact.is_blacklisted) continue;

        const promptBroadcast = prompts.getBroadcastPrompt(draft, prompt);
        
        // Memakai generator dinamis (Teks pesan otomatis menggunakan fallbackMsg/draft jika AI limit total)
        const pesanUnik = await generateMultimodalDinamis(
            promptBroadcast, 
            customKeys || '', 
            fallbackMsg || draft
        );

        try {
            await client.sendMessage(jid, pesanUnik);
            db.saveContact(jid, target.trim());
            db.saveMessage(jid, 'Bot', pesanUnik);
            io.emit('new_message', { jid, sender: 'Bot', message: pesanUnik });
        } catch (e) {}

        counter++;
        // Setiap 10 pesan, beri waktu istirahat ekstra 2 - 5 menit (Micro-Break)
        if (counter % 10 === 0) {
            const istirahatMs = getJitterDelay(120, 300);
            console.log(`[MICRO-BREAK] Istirahat selama ${Math.round(istirahatMs / 1000 / 60)} menit...`);
            await delay(istirahatMs);
        } else {
            // Jeda Jitter acak 15 - 45 detik
            const jedaAman = getJitterDelay(15, 45);
            console.log(`[JITTER] Menunggu ${Math.round(jedaAman / 1000)} detik...`);
            await delay(jedaAman);
        }
    }
});

// 9. Cron Job Scheduler (Otomatis memproses broadcast terjadwal)
cron.schedule('* * * * *', async () => {
    const pending = db.getPendingBroadcasts();
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

// 10. Listener WhatsApp
client.on('qr', (qr) => qrcode.generate(qr, { small: true }));
client.on('ready', () => console.log('Robot WA Full Feature Ready!'));

client.on('message', async (msg) => {
    if (msg.from.includes('@g.us') || msg.isStatus) return;

    const jid = msg.from;
    const phone = jid.replace('@c.us', '').replace('@lid', '');
    let text = msg.body ? msg.body.trim() : '';

    db.saveContact(jid, phone);

    // 1. Filter Toxic
    if (cekToxic(text)) {
        db.setToxic(jid, 1);
        db.setHandover(jid, 1);
        await msg.reply('Mohon gunakan bahasa yang sopan ya Kak. Percakapan ini kami alihkan ke Admin.');
        io.emit('contacts_updated', db.getAllContacts());
        return;
    }

    // 2. Multimodal (Gambar / Voice Note)
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

    // 3. Opt-Out STOP / BERHENTI
    if (text.toUpperCase() === 'STOP' || text.toUpperCase() === 'BERHENTI') {
        db.setBlacklist(jid, true);
        await msg.reply('Nomor Anda berhasil dihapus dari daftar broadcast.');
        return;
    }

    // 4. Eskalasi Admin Manusia
    if (text.toLowerCase().includes('admin') || text.toLowerCase().includes('human')) {
        db.setHandover(jid, true);
        await msg.reply('Pesan diteruskan ke Admin Manusia.');
        io.emit('contacts_updated', db.getAllContacts());
        return;
    }

    const contact = db.getContact(jid);
    if (contact && contact.is_handover) return;

    // 5. Balasan AI
    try {
        try {
            const chat = await msg.getChat();
            if (chat) await chat.sendStateTyping();
        } catch (e) {}

        const riwayatChat = db.getMessages(jid).slice(-6);
        const csPromptText = prompts.getCsPrompt(knowledgeData, riwayatChat, text);
        promptContents.push(csPromptText);

        const [jawabanAI] = await Promise.all([
            generateMultimodalDinamis(promptContents),
            delay(3000)
        ]);

        await msg.reply(jawabanAI);
        db.saveMessage(jid, 'Bot', jawabanAI);
        io.emit('new_message', { jid, sender: 'Bot', message: jawabanAI });
    } catch (err) {}
});

server.listen(3000, () => console.log('Dashboard berjalan di http://localhost:3000'));
client.initialize();