require('dotenv').config();
const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { GoogleGenAI } = require('@google/genai');

const app = express();
app.use(express.json());
app.use(express.static('public')); // Membuka folder UI public

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const client = new Client({
    authStrategy: new LocalAuth({ dataPath: './sessions' }),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const handoverUsers = new Set();

// 1. Fungsi CS Otomatis
async function jawabDenganAI(pesanUser) {
    try {
        const response = await ai.models.generateContent({
            model: 'gemini-3.1-flash-lite-preview',
            contents: `Kamu adalah Customer Service toko online yang sangat ramah, sopan, dan sigap. Jawab pertanyaan pembeli berikut dengan singkat dan jelas (maksimal 2-3 kalimat):\n\nPembeli: ${pesanUser}`
        });
        return response.text;
    } catch (err) {
        return 'Maaf Kak, sistem CS kami sedang mengalami kendala teknis.';
    }
}

// 2. Fungsi Generator Variasi Broadcast AI
async function buatVariasiBroadcast(draft, instruksi) {
    try {
        const response = await ai.models.generateContent({
            model: 'gemini-3.1-flash-lite-preview',
            contents: `Ubah draf pesan berikut menjadi 1 variasi kalimat unik sesuai instruksi.\nInstruksi: ${instruksi}\nDraf Teks: ${draft}\n\nKeluarkan HANYA hasil teks pesan akhirnya saja tanpa kata pengantar.`
        });
        return response.text;
    } catch (err) {
        return draft; // Jika AI error, gunakan teks draf asli
    }
}

// 3. API Endpoint untuk Menerima Broadcast dari Web UI
app.post('/api/broadcast', async (req, res) => {
    const { draft, prompt, numbers } = req.body;
    console.log(`[BROADCAST] Memproses ${numbers.length} nomor tujuan...`);

    // Kirim respon cepat ke UI bahwa proses dimulai
    res.json({ message: `Proses broadcast ke ${numbers.length} nomor dimulai di latar belakang!` });

    for (let target of numbers) {
        let nomorFormatted = target.trim();
        if (!nomorFormatted.endsWith('@c.us')) {
            nomorFormatted = `${nomorFormatted}@c.us`;
        }

        // Bikin variasi teks unik via Gemini
        const pesanUnik = await buatVariasiBroadcast(draft, prompt);
        console.log(`[SENDING] Ke ${nomorFormatted}: "${pesanUnik}"`);

        try {
            await client.sendMessage(nomorFormatted, pesanUnik);
        } catch (err) {
            console.error(`Gagal kirim ke ${nomorFormatted}:`, err.message);
        }

        // Jeda stealth 5-10 detik antar pengiriman pesan broadcast
        const jedaBroadcast = Math.floor(Math.random() * 5000) + 5000;
        await delay(jedaBroadcast);
    }

    console.log('[BROADCAST] Semua pesan broadcast selesai dikirim!');
});

// Listener WhatsApp
client.on('qr', (qr) => qrcode.generate(qr, { small: true }));
client.on('ready', () => console.log('Robot WhatsApp + Web UI Siap!'));

client.on('message', async (msg) => {
    if (msg.from.includes('@g.us') || msg.isStatus) return;
    const pesanTeks = msg.body.toLowerCase();

    if (pesanTeks.includes('admin') || pesanTeks.includes('human')) {
        handoverUsers.add(msg.from);
        await msg.reply('Baik Kak, pesan diteruskan ke Admin Manusia.');
        return;
    }

    if (handoverUsers.has(msg.from)) return;

    try {
        const [jawabanAI] = await Promise.all([jawabDenganAI(msg.body), delay(3000)]);
        await msg.reply(jawabanAI);
    } catch (err) {}
});

// Jalankan Web Server di Port 3000 & WhatsApp Bot
app.listen(3000, () => console.log('Web UI Dashboard berjalan di http://localhost:3000'));
client.initialize();