const Database = require('better-sqlite3');
const db = new Database('database.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS contacts (
    jid TEXT PRIMARY KEY,
    phone TEXT,
    name TEXT,
    label TEXT DEFAULT 'Prospek',
    is_handover INTEGER DEFAULT 0,
    is_blacklisted INTEGER DEFAULT 0,
    is_toxic INTEGER DEFAULT 0,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    jid TEXT,
    sender TEXT,
    message TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS scheduled_broadcasts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    draft TEXT,
    prompt TEXT,
    numbers TEXT,
    scheduled_time DATETIME,
    status TEXT DEFAULT 'pending'
  );

  -- TABEL BARU UNTUK SETTINGS PERSONA & KNOWLEDGE
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

module.exports = {
  getContact: (jid) => db.prepare('SELECT * FROM contacts WHERE jid = ?').get(jid),
  saveContact: (jid, phone, name = 'Pelanggan') => {
    return db.prepare(`
      INSERT INTO contacts (jid, phone, name) VALUES (?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET updated_at = CURRENT_TIMESTAMP
    `).run(jid, phone, name);
  },
  getAllContacts: () => db.prepare('SELECT * FROM contacts ORDER BY updated_at DESC').all(),
  setHandover: (jid, status) => db.prepare('UPDATE contacts SET is_handover = ? WHERE jid = ?').run(status ? 1 : 0, jid),
  setBlacklist: (jid, status) => db.prepare('UPDATE contacts SET is_blacklisted = ? WHERE jid = ?').run(status ? 1 : 0, jid),
  setLabel: (jid, label) => db.prepare('UPDATE contacts SET label = ? WHERE jid = ?').run(label, jid),
  setToxic: (jid, status) => db.prepare('UPDATE contacts SET is_toxic = ? WHERE jid = ?').run(status ? 1 : 0, jid),
  saveMessage: (jid, sender, message) => db.prepare('INSERT INTO messages (jid, sender, message) VALUES (?, ?, ?)').run(jid, sender, message),
  getMessages: (jid) => db.prepare('SELECT * FROM messages WHERE jid = ? ORDER BY timestamp ASC').all(jid),
  saveScheduledBroadcast: (draft, prompt, numbers, time) => db.prepare('INSERT INTO scheduled_broadcasts (draft, prompt, numbers, scheduled_time) VALUES (?, ?, ?, ?)').run(draft, prompt, numbers, time),
  getPendingBroadcasts: () => db.prepare("SELECT * FROM scheduled_broadcasts WHERE status = 'pending' AND scheduled_time <= CURRENT_TIMESTAMP").all(),
  markBroadcastDone: (id) => db.prepare("UPDATE scheduled_broadcasts SET status = 'completed' WHERE id = ?").run(id),

  // FUNGSI PENGATURAN DINAMIS
  getSetting: (key) => {
    const res = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return res ? res.value : null;
  },
  saveSetting: (key, value) => {
    return db.prepare(`
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value);
  }
};