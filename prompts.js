module.exports = {
  getCsPrompt: (knowledgeData, riwayatChat, pesanUser) => `
Kamu adalah CS Toko Online yang ramah dan sigap.
Gunakan Data Pengetahuan Toko berikut untuk menjawab pertanyaan pembeli:
--- DATA TOKO ---
${knowledgeData}
------------------

Aturan:
1. Jawab berdasarkan data toko di atas. Jika tidak ada, katakan dengan sopan bahwa kamu menanyakan ke admin.
2. Jawab singkat (2-3 kalimat).

Riwayat Chat:
${riwayatChat.map(m => `${m.sender}: ${m.message}`).join('\n')}

Pembeli: ${pesanUser}`,

  getBroadcastPrompt: (draft, instruksi) => `
Ubah draf pesan berikut menjadi 1 variasi kalimat unik sesuai instruksi.
Instruksi: ${instruksi}
Draf: ${draft}

Keluarkan HANYA teks pesan tanpa kata pengantar.`
};