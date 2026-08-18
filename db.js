const Database = require('better-sqlite3');
const db = new Database('database.db');

// Inisialisasi Tabel Database
db.exec(`
    CREATE TABLE IF NOT EXISTS contacts (
        jid TEXT PRIMARY KEY,
        phone TEXT,
        name TEXT,
        label TEXT DEFAULT 'Prospek',
        is_handover INTEGER DEFAULT 0,
        is_toxic INTEGER DEFAULT 0,
        is_blacklisted INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        jid TEXT,
        sender TEXT,
        message TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
    );

    CREATE TABLE IF NOT EXISTS broadcasts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        draft TEXT,
        prompt TEXT,
        numbers TEXT,
        scheduled_time TEXT,
        status TEXT DEFAULT 'pending'
    );
`);

// PENGATURAN SETTINGS
function getSetting(key) {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : null;
}

function saveSetting(key, value) {
    const stmt = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
    stmt.run(key, value);
}

// MANAJEMEN KONTAK
function saveContact(jid, phone, name = '') {
    const existing = db.prepare('SELECT * FROM contacts WHERE jid = ?').get(jid);
    if (!existing) {
        const stmt = db.prepare('INSERT INTO contacts (jid, phone, name) VALUES (?, ?, ?)');
        stmt.run(jid, phone, name);
    } else if (name && !existing.name) {
        const stmt = db.prepare('UPDATE contacts SET name = ? WHERE jid = ?');
        stmt.run(name, jid);
    }
}

function getContact(jid) {
    return db.prepare('SELECT * FROM contacts WHERE jid = ?').get(jid);
}

function getAllContacts() {
    return db.prepare('SELECT * FROM contacts').all();
}

// MANAJEMEN PESAN
function saveMessage(jid, sender, message) {
    const stmt = db.prepare('INSERT INTO messages (jid, sender, message) VALUES (?, ?, ?)');
    stmt.run(jid, sender, message);
}

function getMessages(jid) {
    // FIX: Argumen jid ditambahkan di dalam .all(jid)
    return db.prepare('SELECT * FROM messages WHERE jid = ? ORDER BY id ASC').all(jid);
}

// UPDATE STATUS / LABEL
function setLabel(jid, label) {
    const stmt = db.prepare('UPDATE contacts SET label = ? WHERE jid = ?');
    stmt.run(label, jid);
}

function setHandover(jid, status) {
    const val = status ? 1 : 0;
    const stmt = db.prepare('UPDATE contacts SET is_handover = ? WHERE jid = ?');
    stmt.run(val, jid);
}

function setToxic(jid, status) {
    const val = status ? 1 : 0;
    const stmt = db.prepare('UPDATE contacts SET is_toxic = ? WHERE jid = ?');
    stmt.run(val, jid);
}

function setBlacklist(jid, status) {
    const val = status ? 1 : 0;
    const stmt = db.prepare('UPDATE contacts SET is_blacklisted = ? WHERE jid = ?');
    stmt.run(val, jid);
}

// HAPUS KONTAK & CHAT
function deleteContact(jid) {
    db.prepare('DELETE FROM messages WHERE jid = ?').run(jid);
    db.prepare('DELETE FROM contacts WHERE jid = ?').run(jid);
}

// BROADCAST TERJADWAL
function getPendingBroadcasts() {
    return db.prepare("SELECT * FROM broadcasts WHERE status = 'pending' AND scheduled_time <= datetime('now', 'localtime')").all();
}

function saveScheduledBroadcast(draft, prompt, numbers, scheduledTime) {
    const stmt = db.prepare('INSERT INTO broadcasts (draft, prompt, numbers, scheduled_time, status) VALUES (?, ?, ?, ?, ?)');
    stmt.run(draft, prompt, numbers, scheduledTime, 'pending');
}

function markBroadcastDone(id) {
    const stmt = db.prepare("UPDATE broadcasts SET status = 'completed' WHERE id = ?");
    stmt.run(id);
}

module.exports = {
    getSetting,
    saveSetting,
    saveContact,
    getContact,
    getAllContacts,
    saveMessage,
    getMessages,
    setLabel,
    setHandover,
    setToxic,
    setBlacklist,
    deleteContact,
    getPendingBroadcasts,
    saveScheduledBroadcast,
    markBroadcastDone
};