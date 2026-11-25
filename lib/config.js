// Hot-reloadable JSON config store.
// Each file in /config is loaded on start, re-read whenever it changes on disk
// (edited by hand or saved from the Settings page), and every subscriber is
// notified, so nothing needs a restart.
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';

export const CONFIG_DIR = path.resolve(process.env.MON_CONFIG_DIR || path.join(import.meta.dirname, '..', 'config'));

const DEFAULTS = {
  // Point 3: Azure + ADO, one profile per organization.
  azure: {
    edgePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    defaultAccount: '',
    profiles: [],
  },
  workspace: {
    repoRoots: [],
    scanDepth: 3,
    // AI assistant defaults; each chat can override the model.
    assistant: { model: 'default', effort: 'medium' },
    clientZones: {},
    ignore: ['node_modules', 'bin', 'obj', '.vs', 'dist', 'build'],
    orgAliases: {},
  },
  // Secrets for Zendesk / Cloudflare. Never sent back to the browser in clear text.
  secrets: {
    zendesk: {
      subdomain: '',
      email: '',
      apiToken: '',
      pollSeconds: 60,
    },
    cloudflare: { apiToken: '', accountId: '' },
  },
};

const FILES = { azure: 'azure.json', workspace: 'workspace.json', secrets: 'secrets.json' };
const SECRET_KEYS = new Set(['apiToken']);
export const MASK = '••••••••';

class ConfigStore extends EventEmitter {
  constructor() {
    super();
    this.data = {};
    this.lastWrite = {};
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    for (const name of Object.keys(FILES)) this.#load(name, true);
    this.#watch();
  }

  file(name) { return path.join(CONFIG_DIR, FILES[name]); }

  #load(name, initial = false) {
    const file = this.file(name);
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, JSON.stringify(DEFAULTS[name], null, 2));
    }
    try {
      const raw = fs.readFileSync(file, 'utf8');
      if (!initial && raw === this.lastWrite[name]) return; // our own save, already applied
      this.lastWrite[name] = raw;
      const parsed = JSON.parse(raw);
      this.data[name] = deepMerge(structuredClone(DEFAULTS[name]), parsed);
      if (!initial) {
        console.log(`[config] reloaded ${FILES[name]}`);
        this.emit('change', name, this.data[name]);
      }
    } catch (err) {
      // Keep the last good config while the file is half-written or invalid.
      console.warn(`[config] ${FILES[name]} is not valid JSON, keeping previous values: ${err.message}`);
      this.data[name] ??= structuredClone(DEFAULTS[name]);
    }
  }

  #watch() {
    const timers = {};
    fs.watch(CONFIG_DIR, (_evt, filename) => {
      const name = Object.keys(FILES).find((k) => FILES[k] === filename);
      if (!name) return;
      clearTimeout(timers[name]);
      timers[name] = setTimeout(() => this.#load(name), 150); // debounce editor double-writes
    });
  }

  get(name) { return this.data[name]; }

  /** Version safe to send to the browser: secret values replaced by a mask. */
  getPublic(name) {
    return maskSecrets(structuredClone(this.data[name]));
  }

  /** Persist a new value. Masked secret values mean "unchanged". Watcher fires the change event. */
  save(name, value) {
    const merged = restoreSecrets(value, this.data[name]);
    const raw = JSON.stringify(merged, null, 2);
    this.lastWrite[name] = raw;
    fs.writeFileSync(this.file(name), raw);
    this.data[name] = deepMerge(structuredClone(DEFAULTS[name]), merged);
    this.emit('change', name, this.data[name]);
    return this.getPublic(name);
  }
}

// Maps the user owns completely: a saved value replaces the default instead of merging into it
// (otherwise a deleted default alias would come back on every load).
const REPLACE_KEYS = new Set(['orgAliases', 'clientZones']);

/** Client code a Cloudflare zone belongs to (from Settings > Clients), or null. */
export function zoneClient(zoneName) {
  for (const [code, zones] of Object.entries(config.get('workspace').clientZones || {})) {
    if ((zones || []).some((z) => z.toLowerCase() === String(zoneName).toLowerCase())) return code;
  }
  return null;
}

function deepMerge(base, over) {
  if (Array.isArray(over) || typeof over !== 'object' || over === null) return over ?? base;
  for (const [k, v] of Object.entries(over)) {
    base[k] = (!REPLACE_KEYS.has(k) && v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object')
      ? deepMerge(base[k], v) : v;
  }
  return base;
}

function maskSecrets(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  for (const [k, v] of Object.entries(obj)) {
    if (SECRET_KEYS.has(k) && typeof v === 'string') obj[k] = v ? MASK : '';
    else if (typeof v === 'object') maskSecrets(v);
  }
  return obj;
}

function restoreSecrets(next, prev) {
  if (!next || typeof next !== 'object' || Array.isArray(next)) return next;
  const out = {};
  for (const [k, v] of Object.entries(next)) {
    if (SECRET_KEYS.has(k) && v === MASK) out[k] = prev?.[k] ?? '';
    else out[k] = restoreSecrets(v, prev?.[k]);
  }
  return out;
}

export const config = new ConfigStore();

/** Resolve any org name (Zendesk org, folder name, alias) to its short sidebar code. */
export function orgCode(name) {
  if (!name) return 'Unassigned';
  const aliases = config.get('workspace').orgAliases || {};
  const hit = Object.entries(aliases).find(([k]) => k.toLowerCase() === String(name).toLowerCase());
  if (hit) return hit[1];
  // "ACU (Australian Catholic University)" -> "ACU", so tickets group with the ACU repo folder.
  const short = String(name).match(/^\s*([^()]{2,24}?)\s*\(.+\)\s*$/);
  return short ? short[1] : name;
}
