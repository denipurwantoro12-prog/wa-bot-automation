require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { GoogleGenAI } = require('@google/genai');

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const client = new Client({
    authStrategy: new LocalAuth({ dataPath: './sessions' }),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Memori untuk menyimpan daftar nomor yang beralih ke CS Manusia
const handoverUsers = new Set();

async function jawabDenganAI(pesanUser) {
    try {
        const response = await ai.models.generateContent({
            model: 'gemini-3.1-flash-lite-preview', // Model Gemini pilihanmu!
            contents: `Kamu adalah Customer Service toko online yang sangat ramah, sopan, dan sigap. Jawab pertanyaan pembeli berikut dengan singkat dan jelas (maksimal 2-3 kalimat):\n\nPembeli: ${pesanUser}`
        });
        return response.text;
    } catch (err) {
        console.error('Error AI:', err.message);
        return 'Maaf Kak, sistem CS kami sedang mengalami kendala teknis singkat. Boleh tanyakan lagi nanti?';
    }
}

client.on('qr', (qr) => {
    console.log('Scan Kode QR ini menggunakan WhatsApp di HP kamu:');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('Robot WhatsApp + AI CS Berhasil Terhubung dan Siap!');
});

client.on('message', async (msg) => {
    console.log(`Pesan dari ${msg.from}: ${msg.body}`);

    if (msg.from.includes('@g.us') || msg.isStatus) return;

    const pesanTeks = msg.body.toLowerCase();

    // 1. Cek apakah pengguna minta bicara dengan admin manusia
    if (pesanTeks.includes('admin') || pesanTeks.includes('human') || pesanTeks.includes('operator')) {
        handoverUsers.add(msg.from);
        console.log(`[HANDOVER] Nomor ${msg.from} dialihkan ke Admin Manusia.`);
        await msg.reply('Baik Kak, pesan Kakak sudah kami teruskan ke Admin Manusia. Mohon tunggu sebentar ya, Admin akan segera membalas secara manual.');
        return;
    }

    // 2. Cek apakah nomor ini sedang ditangani Admin Manusia (jika ya, bot diam)
    if (handoverUsers.has(msg.from)) {
        console.log(`[IGNORED] Pesan dari ${msg.from} diabaikan karena sedang ditangani Admin Manusia.`);
        return;
    }

    // 3. Jika tidak, jawab menggunakan AI
    try {
        try {
            const chat = await msg.getChat();
            if (chat) await chat.sendStateTyping();
        } catch (e) {}

        const [jawabanAI] = await Promise.all([
            jawabDenganAI(msg.body),
            delay(3000)
        ]);

        await msg.reply(jawabanAI);
    } catch (err) {
        console.error('Gagal membalas pesan:', err.message);
    }
});

client.initialize();