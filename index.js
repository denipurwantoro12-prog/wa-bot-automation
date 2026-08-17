const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

const client = new Client({
    authStrategy: new LocalAuth({ dataPath: './sessions' }),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

// Fungsi bantuan jeda acak
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

client.on('qr', (qr) => {
    console.log('Scan Kode QR ini menggunakan WhatsApp di HP kamu:');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('Robot WhatsApp Berhasil Terhubung dan Siap!');
});

client.on('message', async (msg) => {
    console.log(`Pesan dari ${msg.from}: ${msg.body}`);
    const pesan = msg.body.toLowerCase();

    if (pesan === 'ping' || pesan === 'halo' || pesan === 'hai') {
        try {
            // Coba pancing status typing
            try {
                const chat = await msg.getChat();
                if (chat) {
                    await chat.sendStateTyping();
                    console.log('Status typing berhasil dikirim!');
                }
            } catch (typingErr) {
                console.log('ID pengirim adalah @lid, status typing dilewati demi keamanan.');
            }

            // Jeda penyamaran 3–5 detik
            const waktuTunggu = Math.floor(Math.random() * 2000) + 3000;
            await delay(waktuTunggu);

            // Kirim balasan
            if (pesan === 'ping') {
                await msg.reply('pong!');
            } else {
                await msg.reply('Halo! Selamat datang di layanan Customer Service kami. Ada yang bisa dibantu?');
            }
        } catch (err) {
            console.error('Gagal mengirim balasan:', err.message);
        }
    }
});

client.initialize();