// AI skills: reusable instructions for relevant / repeated tasks.
// Stored as a local Claude Code plugin (ai-skills/), one SKILL.md per skill, so the
// assistant picks the right one by its description, or you run it with /skill-name.
// Files are read on every chat turn, so edits apply without a restart.
import fs from 'node:fs';
import path from 'node:path';
import { bus } from './db.js';

export const SKILLS_ROOT = path.resolve(process.env.MON_SKILLS_DIR || path.join(import.meta.dirname, '..', 'ai-skills'));
export const PLUGIN = 'mon';
const DIR = path.join(SKILLS_ROOT, 'skills');
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

function ensurePlugin() {
  fs.mkdirSync(path.join(SKILLS_ROOT, '.claude-plugin'), { recursive: true });
  fs.mkdirSync(DIR, { recursive: true });
  const manifest = path.join(SKILLS_ROOT, '.claude-plugin', 'plugin.json');
  if (!fs.existsSync(manifest)) {
    fs.writeFileSync(manifest, JSON.stringify({ name: PLUGIN, version: '0.1.0', description: 'mon.ai skills' }, null, 2));
  }
}

// Minimal frontmatter: single-line `key: value` pairs between --- fences.
function parse(text) {
  const m = text.replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
  return { meta, body: m[2].trim() };
}
const oneLine = (s) => String(s || '').replace(/\s+/g, ' ').trim();

export function list() {
  ensurePlugin();
  return fs.readdirSync(DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(DIR, d.name, 'SKILL.md')))
    .map((d) => get(d.name))
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function get(name) {
  if (!NAME_RE.test(name)) return null;
  const file = path.join(DIR, name, 'SKILL.md');
  if (!fs.existsSync(file)) return null;
  const { meta, body } = parse(fs.readFileSync(file, 'utf8'));
  return {
    name,
    description: meta.description || '',
    org: meta['mon-org'] || '',            // '' = every organization
    model: meta['mon-model'] || '',        // '' = the default model in Settings
    effort: meta['mon-effort'] || '',
    category: meta['mon-category'] || '',  // groups skills on the Skills page and in the / list ('' = Other)
    updatedAt: fs.statSync(file).mtime.toISOString(),
    instructions: body,
  };
}

export function save({ name, previousName, description, org = '', model = '', effort = '', category = '', instructions }) {
  ensurePlugin();
  name = String(name || '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!NAME_RE.test(name)) throw new Error('Skill name: lowercase letters, digits and dashes (e.g. ticket-triage).');
  if (!oneLine(description)) throw new Error('Add a description: it tells the assistant when to use this skill.');
  if (!String(instructions || '').trim()) throw new Error('Add the instructions the assistant should follow.');
  if (previousName && previousName !== name) {
    if (get(name)) throw new Error(`A skill named "${name}" already exists.`);
    if (NAME_RE.test(previousName)) fs.rmSync(path.join(DIR, previousName), { recursive: true, force: true });
  }
  const text = [
    '---',
    `name: ${name}`,
    `description: ${oneLine(description)}`,
    ...(oneLine(org) ? [`mon-org: ${oneLine(org)}`] : []),
    ...(/^[\w.:\[\]-]{1,80}$/.test(model) && model !== 'default' ? [`mon-model: ${model}`] : []),
    ...(['low', 'medium', 'high', 'xhigh', 'max'].includes(effort) ? [`mon-effort: ${effort}`] : []),
    ...(oneLine(category) ? [`mon-category: ${oneLine(category).slice(0, 40)}`] : []),
    '---',
    '',
    String(instructions).replace(/\r\n/g, '\n').trim(),
    '',
  ].join('\n');
  fs.mkdirSync(path.join(DIR, name), { recursive: true });
  fs.writeFileSync(path.join(DIR, name, 'SKILL.md'), text);
  bus.emit('event', { type: 'skills:updated', data: { name } });
  return get(name);
}

export function remove(name) {
  if (!NAME_RE.test(name)) throw new Error('Bad skill name');
  fs.rmSync(path.join(DIR, name), { recursive: true, force: true });
  bus.emit('event', { type: 'skills:updated', data: { name } });
}

/** Skill ids (plugin-qualified) available to a chat for this organization. */
export function enabledFor(org) {
  return list()
    .filter((s) => !s.org || !org || org === 'All' || s.org.toLowerCase() === String(org).toLowerCase())
    .map((s) => `${PLUGIN}:${s.name}`);
}

/** Turn "/ticket-triage 25348" into the plugin-qualified slash command the CLI understands. */
export function expandSlash(text, org) {
  const m = String(text).match(/^\/([a-z0-9][a-z0-9-]*)(\s[\s\S]*)?$/);
  if (!m || m[1].includes(':')) return text;
  return enabledFor(org).includes(`${PLUGIN}:${m[1]}`) ? `/${PLUGIN}:${m[1]}${m[2] || ''}` : text;
}

// ---------- starter skills (only written when the folder is empty) ----------
const STARTERS = [
  {
    name: 'ticket-triage',
    description: 'Triage a Zendesk ticket: summarise it, say who it is waiting on, rank urgency and propose the next step. Use when asked to triage, review or catch up on a ticket.',
    instructions: `# Ticket triage

Input: a ticket number (e.g. \`/ticket-triage 25348\`). If none is given, use the highest-scoring ticket from my_tickets.

1. Load the ticket with \`zendesk_ticket\` and read the latest comments.
2. Reply with:
   - **Summary**: two or three sentences, plain language.
   - **Waiting on**: me / customer / third party, and since when.
   - **Urgency**: SLA, priority and anything blocking production.
   - **Next step**: one concrete action for me.
3. If the client's Azure, Cloudflare or repos are relevant, check them with the read-only tools and say what you found.
4. If a reply to the customer is needed, add a short draft (see the customer-reply skill for tone).`,
  },
  {
    name: 'plan-my-day',
    description: 'Plan my working day from my open Zendesk tickets: order by urgency, group quick wins and give one next action each. Use when asked what to work on or to plan the day.',
    instructions: `# Plan my day

1. Get my open tickets with \`my_tickets\` and today's numbers with \`daily_performance\`.
2. Put tickets that need me (new/open) first, ordered by SLA risk, priority and how long the customer has waited. List pending/on-hold tickets separately, only if they need a nudge.
3. Group anything under ~15 minutes as **Quick wins**.
4. Output a numbered list: \`#id – client – subject – next action\`. Keep each line short.
5. End with one line on today's progress (tickets solved so far).`,
  },
  {
    name: 'customer-reply',
    description: 'Draft a reply to a customer on a Zendesk ticket in the Dataweavers support tone. Use when asked to draft, write or reply to a customer.',
    instructions: `# Customer reply

Write a reply I can paste into Zendesk. Do not post it anywhere.

- Read the ticket and recent comments first (\`zendesk_ticket\`).
- Greet the requester by first name.
- Tone: friendly, clear, professional; Australian English spelling.
- Structure: what we found or did → what happens next (with a time frame if known) → what we need from them, if anything.
- Short paragraphs, no jargon unless the customer used it; no internal details (tenant IDs, internal tools).
- Sign off with: "Kind regards,\\nViet Anh\\nDataweavers Support"
- If something is unclear, list the open questions for me after the draft instead of guessing.`,
  },
];

export function seed() {
  ensurePlugin();
  if (list().length) return;
  for (const s of STARTERS) save(s);
}
