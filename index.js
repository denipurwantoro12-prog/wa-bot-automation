require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { GoogleGenAI } = require('@google/genai');
const cron = require('node-cron');
const fs = require('fs');

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

// 2. Logika Rotasi API Key Gemini (Failover Handler)
const apiKeys = (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '').split(',');
let currentKeyIndex = 0;

async function generateWithFailover(promptText) {
    for (let attempt = 0; attempt < apiKeys.length; attempt++) {
        try {
            const activeKey = apiKeys[currentKeyIndex].trim();
            const ai = new GoogleGenAI({ apiKey: activeKey });
            
            const response = await ai.models.generateContent({
                model: 'gemini-3.1-flash-lite-preview',
                contents: promptText
            });
            return response.text;
        } catch (err) {
            console.warn(`[API LIMIT] Key index ${currentKeyIndex} bermasalah/limit. Pindah ke key berikutnya...`);
            currentKeyIndex = (currentKeyIndex + 1) % apiKeys.length;
        }
    }
    return 'Maaf Kak, sistem CS kami sedang mengalami kendala teknis singkat.';
}

// 3. Inisialisasi WhatsApp Client
const client = new Client({
    authStrategy: new LocalAuth({ dataPath: './sessions' }),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 4. Socket.io Real-Time Event Connections
io.on('connection', (socket) => {
    socket.on('get_contacts', () => socket.emit('contacts_list', db.getAllContacts()));
    
    socket.on('get_messages', (jid) => {
        socket.emit('messages_list', { jid, messages: db.getMessages(jid) });
    });

    socket.on('send_manual_reply', async ({ jid, message }) => {
        try {
            await client.sendMessage(jid, message);
            db.saveMessage(jid, 'Admin', message);
            io.emit('new_message', { jid, sender: 'Admin', message });
        } catch (err) {
            console.error('Gagal kirim pesan manual:', err.message);
        }
    });

    socket.on('toggle_handover', ({ jid, status }) => {
        db.setHandover(jid, status);
        io.emit('contacts_updated', db.getAllContacts());
    });

    socket.on('toggle_blacklist', ({ jid, status }) => {
        db.setBlacklist(jid, status);
        io.emit('contacts_updated', db.getAllContacts());
    });
});

// 5. API Endpoint Broadcast
app.post('/api/broadcast', async (req, res) => {
    const { draft, prompt, numbers, scheduledTime } = req.body;

    if (scheduledTime) {
        db.saveScheduledBroadcast(draft, prompt, JSON.stringify(numbers), scheduledTime);
        return res.json({ message: 'Broadcast berhasil dijadwalkan!' });
    }

    res.json({ message: 'Proses broadcast langsung dimulai!' });

    for (let target of numbers) {
        let jid = target.trim();
        if (!jid.endsWith('@c.us')) jid = `${jid}@c.us`;

        const contact = db.getContact(jid);
        if (contact && contact.is_blacklisted) {
            console.log(`[SKIPPED] ${jid} berada di daftar blacklist (Opt-Out).`);
            continue;
        }

        const promptBroadcast = prompts.getBroadcastPrompt(draft, prompt);
        const pesanUnik = await generateWithFailover(promptBroadcast);

        try {
            await client.sendMessage(jid, pesanUnik);
            db.saveContact(jid, target.trim());
            db.saveMessage(jid, 'Bot', pesanUnik);
            io.emit('new_message', { jid, sender: 'Bot', message: pesanUnik });
        } catch (e) {}

        await delay(Math.floor(Math.random() * 5000) + 5000);
    }
});

// 6. Scheduler Cron Job (Cek antrean setiap 1 menit)
cron.schedule('* * * * *', async () => {
    const pending = db.getPendingBroadcasts();
    for (let job of pending) {
        const numbers = JSON.parse(job.numbers);
        for (let target of numbers) {
            let jid = target.trim();
            if (!jid.endsWith('@c.us')) jid = `${jid}@c.us`;

            const contact = db.getContact(jid);
            if (contact && contact.is_blacklisted) continue;

            const promptBroadcast = prompts.getBroadcastPrompt(job.draft, job.prompt);
            const pesanUnik = await generateWithFailover(promptBroadcast);

            try {
                await client.sendMessage(jid, pesanUnik);
                db.saveContact(jid, target.trim());
                db.saveMessage(jid, 'Bot', pesanUnik);
                io.emit('new_message', { jid, sender: 'Bot', message: pesanUnik });
            } catch (e) {}

            await delay(5000);
        }
        db.markBroadcastDone(job.id);
    }
});

// 7. Event Listener WhatsApp
client.on('qr', (qr) => qrcode.generate(qr, { small: true }));
client.on('ready', () => console.log('Robot WA + Live Chat Panel + Rotasi Gemini AI Siap!'));

client.on('message', async (msg) => {
    if (msg.from.includes('@g.us') || msg.isStatus) return;

    const jid = msg.from;
    const text = msg.body.trim();
    const phone = jid.replace('@c.us', '').replace('@lid', '');

    db.saveContact(jid, phone);
    db.saveMessage(jid, 'User', text);
    io.emit('new_message', { jid, sender: 'User', message: text });
    io.emit('contacts_updated', db.getAllContacts());

    // Fitur Opt-Out / Blacklist otomatis
    if (text.toUpperCase() === 'STOP' || text.toUpperCase() === 'BERHENTI') {
        db.setBlacklist(jid, true);
        await msg.reply('Nomor Anda telah berhasil kami hapus dari daftar broadcast promosi.');
        return;
    }

    // Fitur Handover Minta Admin
    if (text.toLowerCase().includes('admin') || text.toLowerCase().includes('human')) {
        db.setHandover(jid, true);
        await msg.reply('Pesan Kakak diteruskan ke Admin Manusia. Mohon tunggu balasan Admin ya.');
        io.emit('contacts_updated', db.getAllContacts());
        return;
    }

    const contact = db.getContact(jid);
    if (contact && contact.is_handover) return; // Bot diam jika Handover Admin aktif

    // Respon AI dengan RAG & Chat Memory via Failover Key
    try {
        try {
            const chat = await msg.getChat();
            if (chat) await chat.sendStateTyping();
        } catch (e) {}

        const riwayatChat = db.getMessages(jid).slice(-6);
        const csPromptText = prompts.getCsPrompt(knowledgeData, riwayatChat, text);

        const [jawabanAI] = await Promise.all([
            generateWithFailover(csPromptText),
            delay(3000)
        ]);

        await msg.reply(jawabanAI);

        db.saveMessage(jid, 'Bot', jawabanAI);
        io.emit('new_message', { jid, sender: 'Bot', message: jawabanAI });
    } catch (err) {
        console.error('Gagal membalas pesan:', err.message);
    }
});

server.listen(3000, () => console.log('Dashboard berjalan di http://localhost:3000'));
client.initialize();