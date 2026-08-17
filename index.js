const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

const client = new Client({
    authStrategy: new LocalAuth({ dataPath: './sessions' }),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

client.on('qr', (qr) => {
    console.log('Scan Kode QR ini menggunakan WhatsApp di HP kamu:');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('Robot WhatsApp Berhasil Terhubung dan Siap!');
});

// FITUR BARU: Menerima dan membalas pesan masuk
client.on('message', async (msg) => {
    // Cetak isi pesan ke terminal
    console.log(`Pesan dari ${msg.from}: ${msg.body}`);

    // Logika dasar CS otomatis
    const pesan = msg.body.toLowerCase();

    if (pesan === 'ping') {
        await msg.reply('pong!');
    } else if (pesan === 'halo' || pesan === 'hai') {
        await msg.reply('Halo! Selamat datang di layanan Customer Service kami. Ada yang bisa dibantu?');
    }
});

client.initialize();