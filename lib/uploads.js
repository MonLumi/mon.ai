// Files and images attached to chat messages. Stored per chat under data/uploads/<chat id>/,
// shown inline in the conversation, and handed to the assistant as file paths it can Read.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const ROOT = path.resolve(process.env.MON_DATA_DIR || path.join(import.meta.dirname, '..', 'data'), 'uploads');
const SID = /^[0-9a-f-]{36}$/i;
const FILE = /^[0-9a-z]{8}-[\w.-]{1,120}$/i;
export const MAX_BYTES = 25 * 1024 * 1024;
// Shown inline in the page; everything else is offered as a download (never rendered as a page).
const INLINE_IMAGES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

export const dirFor = (sid) => {
  if (!SID.test(sid)) throw new Error('Bad chat id');
  return path.join(ROOT, sid);
};

function safeName(name) {
  const base = path.basename(String(name || 'file')).normalize('NFKD').replace(/[^\w.-]+/g, '_').replace(/^\.+/, '').slice(0, 100);
  return base || 'file';
}

/** Save an uploaded file; returns the attachment record stored with the message. */
export function save(sid, name, buffer) {
  if (!buffer?.length) throw new Error('Empty file');
  if (buffer.length > MAX_BYTES) throw new Error('File is larger than 25 MB');
  const dir = dirFor(sid);
  fs.mkdirSync(dir, { recursive: true });
  const file = `${randomBytes(4).toString('hex')}-${safeName(name)}`;
  fs.writeFileSync(path.join(dir, file), buffer);
  return describe(sid, file, name);
}

export function describe(sid, file, originalName) {
  if (!FILE.test(file)) throw new Error('Bad file name');
  const full = path.join(dirFor(sid), file);
  const st = fs.statSync(full);
  const ext = path.extname(file).toLowerCase();
  return {
    id: file,
    name: originalName ? String(originalName).slice(0, 200) : file.slice(9),
    size: st.size,
    image: !!INLINE_IMAGES[ext],
    url: `/api/uploads/${sid}/${encodeURIComponent(file)}`,
    path: full,
  };
}

/** Resolve a stored file for download, with safe headers. */
export function fileFor(sid, file) {
  if (!FILE.test(file)) throw new Error('Bad file name');
  const full = path.join(dirFor(sid), file);
  if (!fs.existsSync(full)) throw new Error('Not found');
  const ext = path.extname(file).toLowerCase();
  return { full, inlineType: INLINE_IMAGES[ext] || null };
}

export function removeChat(sid) {
  try { fs.rmSync(dirFor(sid), { recursive: true, force: true }); } catch { /* nothing stored */ }
}
