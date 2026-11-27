// Client knowledge: one Markdown profile per client in config/clients/<CODE>.md (git-ignored, like the
// rest of config/). What makes each client different: projects, prod domains, hosting and edge set-up,
// access rules, gotchas. The assistant gets the chat's client profile in its system prompt and can read
// others with client_profile. It never writes them: it suggests facts (suggest_client_fact) and the app
// saves one only when you click Save on the card. Files are read on every use, so edits made by hand or
// from Claude Code apply from the next message.
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR, orgCode } from './config.js';

export const DIR = path.join(CONFIG_DIR, 'clients');
fs.mkdirSync(DIR, { recursive: true });

/** Headings a new profile starts with (free-form Markdown: any other heading works too). */
export const SECTIONS = ['Projects', 'Hosting & edge', 'Access', 'Gotchas'];
export const TEMPLATE = (code) => `# ${code}\n\n${SECTIONS.map((s) => `## ${s}\n`).join('\n')}`;

const safeCode = (code) => {
  const c = String(code || '').trim();
  if (!c || !/^[\w .&'-]{1,60}$/.test(c) || c.startsWith('.')) throw new Error(`Not a valid client code: ${c || '(empty)'}`);
  return c;
};

/** The profile file of a client (any alias works), matched without regard to case; null if none. */
function fileOf(code) {
  const want = [String(code || ''), orgCode(code)].map((x) => `${x.toLowerCase()}.md`);
  const f = fs.readdirSync(DIR).find((n) => want.includes(n.toLowerCase()));
  return f ? path.join(DIR, f) : null;
}

/** Profiles that exist: client code (from the file name), size, last change. */
export function list() {
  return fs.readdirSync(DIR).filter((n) => n.toLowerCase().endsWith('.md')).map((n) => {
    const st = fs.statSync(path.join(DIR, n));
    return { code: n.slice(0, -3), chars: st.size, updatedAt: st.mtime.toISOString() };
  }).sort((a, b) => a.code.localeCompare(b.code));
}

/** A client's profile text, or '' when it has none (or only empty headings). */
export function get(code) {
  const f = code && fileOf(code);
  if (!f) return '';
  try { return fs.readFileSync(f, 'utf8'); } catch { return ''; }
}

/** True when the profile holds more than its title and empty headings. */
export const hasContent = (text) => String(text || '').split('\n').some((l) => l.trim() && !/^#{1,6}\s/.test(l.trim()));

/** Every profile with content, for questions across clients. */
export function all() {
  return list().map((p) => ({ code: p.code, text: get(p.code) })).filter((p) => hasContent(p.text));
}

/** Save (or, with empty text, delete) a client's profile. Keeps an existing file's name. */
export function save(code, text) {
  const c = safeCode(code);
  const f = fileOf(c) || path.join(DIR, `${c}.md`);
  const body = String(text ?? '').replace(/\r\n/g, '\n').trim();
  if (!body) { fs.rmSync(f, { force: true }); return { code: c, deleted: true }; }
  fs.writeFileSync(f, `${body}\n`);
  return { code: path.basename(f, '.md'), chars: body.length + 1 };
}

/** A client was renamed in Settings → Clients: its profile follows. */
export function rename(from, to) {
  const f = fileOf(from);
  if (!f || String(from).toLowerCase() === String(to).toLowerCase()) return;
  const dest = path.join(DIR, `${safeCode(to)}.md`);
  if (fs.existsSync(dest)) return; // the new name already has one: keep both rather than overwrite
  fs.renameSync(f, dest);
}

/**
 * Add one fact (a bullet) under a section, creating the profile or the section when missing. With
 * `replaces`, the line containing that text is swapped for the fact instead (a fact that changed).
 */
export function addFact(code, section, fact, replaces) {
  const c = safeCode(orgCode(code));
  const line = `- ${String(fact || '').trim().replace(/^[-*]\s+/, '').replace(/\s*\n\s*/g, ' ')}`;
  if (!line.slice(2).trim()) throw new Error('The fact is empty.');
  const sec = String(section || 'Gotchas').trim().replace(/^#+\s*/, '') || 'Gotchas';
  const lines = (get(c) || TEMPLATE(c)).replace(/\r\n/g, '\n').split('\n');
  const old = String(replaces || '').trim().replace(/^[-*]\s+/, '');
  const at = old ? lines.findIndex((l) => l.includes(old)) : -1;
  if (at >= 0) lines[at] = line;
  else {
    const h = lines.findIndex((l) => /^##\s/.test(l) && l.replace(/^##\s+/, '').trim().toLowerCase() === sec.toLowerCase());
    if (h < 0) {
      while (lines.length && !lines.at(-1).trim()) lines.pop();
      lines.push('', `## ${sec}`, line);
    } else {
      let end = lines.findIndex((l, i) => i > h && /^#{1,2}\s/.test(l));
      if (end < 0) end = lines.length;
      let ins = end;
      while (ins > h + 1 && !lines[ins - 1].trim()) ins--; // after the section's last line, not its trailing blanks
      lines.splice(ins, 0, line);
    }
  }
  return { ...save(c, lines.join('\n')), replaced: at >= 0 };
}
