// Local SQLite store (Node's built-in node:sqlite, no native build needed).
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';

const DATA_DIR = path.resolve(process.env.MON_DATA_DIR || path.join(import.meta.dirname, '..', 'data'));
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'mon.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS tickets (
    id INTEGER PRIMARY KEY,
    subject TEXT, status TEXT, priority TEXT, type TEXT,
    org_id INTEGER, org_name TEXT, org TEXT,
    requester TEXT, created_at TEXT, updated_at TEXT, due_at TEXT, solved_at TEXT,
    sla_breach_at TEXT, total_time_sec INTEGER DEFAULT 0,
    score REAL DEFAULT 0, reasons TEXT DEFAULT '[]',
    url TEXT, raw TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_tickets_org ON tickets(org);
  CREATE TABLE IF NOT EXISTS time_entries (
    audit_id INTEGER PRIMARY KEY, ticket_id INTEGER, seconds INTEGER, created_at TEXT
  );
  CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY, org TEXT, title TEXT, claude_session_id TEXT,
    ticket_id INTEGER, created_at TEXT, updated_at TEXT
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT, created_at TEXT
  );
`);

// Columns added after the first release.
for (const sql of ['ALTER TABLE sessions ADD COLUMN model TEXT', 'ALTER TABLE sessions ADD COLUMN ticket_seen_at TEXT', 'ALTER TABLE sessions ADD COLUMN archived_at TEXT', 'ALTER TABLE sessions ADD COLUMN archive_reason TEXT', 'ALTER TABLE sessions ADD COLUMN archive_summary TEXT', 'ALTER TABLE sessions ADD COLUMN cooled_at TEXT', "ALTER TABLE tickets ADD COLUMN relation TEXT DEFAULT 'assigned'", 'ALTER TABLE tickets ADD COLUMN needs_me INTEGER DEFAULT 0', 'ALTER TABLE tickets ADD COLUMN needs_me_reason TEXT', 'ALTER TABLE tickets ADD COLUMN needs_me_at TEXT', 'ALTER TABLE tickets ADD COLUMN ignored_mention_at TEXT', 'ALTER TABLE tickets ADD COLUMN my_update_at TEXT', 'ALTER TABLE tickets ADD COLUMN cooled_at TEXT', 'ALTER TABLE tickets ADD COLUMN last_update_checked TEXT', 'ALTER TABLE tickets ADD COLUMN assignee TEXT', 'ALTER TABLE tickets ADD COLUMN assignee_id INTEGER', 'ALTER TABLE tickets ADD COLUMN upvoted INTEGER DEFAULT 0', 'ALTER TABLE tickets ADD COLUMN upvoted_at TEXT']) {
  try { db.exec(sql); } catch { /* already there */ }
}

export const kv = {
  get(k, fallback = null) {
    const row = db.prepare('SELECT v FROM kv WHERE k = ?').get(k);
    return row ? JSON.parse(row.v) : fallback;
  },
  set(k, v) {
    db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, JSON.stringify(v));
  },
};

/** App-wide event bus; everything on it is pushed to browsers over Server-Sent Events. */
export const bus = new EventEmitter();
bus.setMaxListeners(100);
