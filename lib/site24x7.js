// Site24x7 (external uptime checks) through a browser sign-in, like Zendesk: there is no API token.
// Edge opens Site24x7 on a dedicated mon.ai profile, you sign in with Zoho as usual (SSO/MFA), and the
// session cookies are read over the DevTools protocol. mon.ai then calls the same /app/api/... endpoints
// the Site24x7 web app uses (they mirror the public /api/... ones), GET only, with the Zoho CSRF header.
// When the session expires it first tries a silent sign-in (headless, same profile); if that fails the
// assistant's tool error carries a marker that the chat turns into a "Sign in to Site24x7" card.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config } from './config.js';
import { bus } from './db.js';
import { freePort, cdp } from './zdauth.js';

const DATA_DIR = path.resolve(process.env.MON_DATA_DIR || path.join(import.meta.dirname, '..', 'data'));
const SESSION_FILE = path.join(DATA_DIR, 'site24x7-session.json');
const PROFILE_DIR = path.join(DATA_DIR, 'site24x7-browser');
const CSRF_COOKIE = 's247cname'; // sent back as X-ZCSRF-TOKEN: s247pname=<value>

let session = load();
export const login = { status: 'idle', error: null };

function load() { try { return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')); } catch { return null; } }
function persist() {
  if (session) fs.writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2));
  else fs.rmSync(SESSION_FILE, { force: true });
}

/** Data centre suffix: com, eu, net.au, in, cn, jp, ca, uk (Settings > General > Site24x7). */
export function dc() {
  return String(config.get('secrets').site24x7?.dc || 'net.au').trim().replace(/^\.+/, '').toLowerCase() || 'net.au';
}
const base = () => `https://www.site24x7.${dc()}`;
export function isConfigured() { return !!config.get('secrets').site24x7?.enabled; }
export const appUrl = (hash = '') => `${base()}/app/client${hash ? `#${hash}` : ''}`;

function headers(cookies) {
  return {
    Cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; '),
    'X-ZCSRF-TOKEN': `s247pname=${cookies[CSRF_COOKIE] || ''}`,
    Accept: 'application/json',
  };
}
const signedIn = () => !!(session && session.dc === dc() && session.cookies?.[CSRF_COOKIE]);

export function clear() { session = null; persist(); }
export function info() {
  return { configured: isConfigured(), dc: dc(), signedIn: signedIn(), user: session?.user || null, since: session?.createdAt || null, login };
}

/** Keep cookies fresh: Zoho rotates some of them on responses. */
function absorb(res) {
  if (!session) return;
  let changed = false;
  for (const c of res.headers.getSetCookie?.() || []) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    const name = pair.slice(0, i).trim();
    const value = pair.slice(i + 1).trim();
    if (!name) continue;
    if (/max-age=0|expires=thu, 01 jan 1970/i.test(c) || value === '') { delete session.cookies[name]; changed = true; }
    else if (session.cookies[name] !== value) { session.cookies[name] = value; changed = true; }
  }
  if (changed) { session.updatedAt = new Date().toISOString(); persist(); }
}

class AuthError extends Error {}

async function rawGet(p, cookies) {
  const res = await fetch(base() + p, { headers: headers(cookies), redirect: 'manual' });
  // Signed out: Zoho answers with a redirect to accounts.zoho.*, a 401/403, or an HTML sign-in page.
  if ((res.status >= 300 && res.status < 400) || res.status === 401 || res.status === 403) throw new AuthError(`Site24x7 ${res.status}: not signed in`);
  const type = res.headers.get('content-type') || '';
  const body = type.includes('json') ? await res.json().catch(() => null) : null;
  if (!body) {
    if (res.ok) throw new AuthError(`Site24x7 ${res.status}: not signed in (got ${type || 'no content type'})`);
    throw new Error(`Site24x7 ${res.status} ${res.statusText} for ${p}`);
  }
  return { res, body };
}

async function whoAmI(cookies) {
  try {
    const { body } = await rawGet('/app/api/client_data/user', cookies);
    const d = body.data || body;
    const name = d.display_name || d.user_name || d.name || d.email_address || d.email || null;
    return { name: typeof name === 'string' ? name : null };
  } catch (e) {
    if (e instanceof AuthError) return null;
    throw e;
  }
}

async function runBrowser({ headless, timeoutMs }) {
  const edge = config.get('azure').edgePath;
  if (!fs.existsSync(edge)) throw new Error(`Edge not found at ${edge} (Settings > General > Edge executable).`);
  const port = await freePort();
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  const child = spawn(edge, [
    `--user-data-dir=${PROFILE_DIR}`, `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1',
    '--no-first-run', '--no-default-browser-check',
    ...(headless ? ['--headless=new', '--disable-gpu', '--window-size=1280,900'] : []),
    appUrl(),
  ], { stdio: 'ignore' });
  let spawnError = null;
  child.on('error', (e) => { spawnError = e.message; });
  const suffix = `site24x7.${dc()}`;
  const deadline = Date.now() + timeoutMs;
  let browserWs = null;
  try {
    while (Date.now() < deadline) {
      if (!headless && login.status !== 'running') return false; // cancelled
      await new Promise((r) => setTimeout(r, headless ? 1500 : 2500));
      if (spawnError) throw new Error(spawnError);
      try {
        browserWs ??= (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl;
        const { cookies } = await cdp(browserWs, 'Storage.getCookies');
        const jar = {};
        for (const c of cookies) {
          const d = c.domain.replace(/^\./, '');
          if (d === suffix || d.endsWith(`.${suffix}`)) jar[c.name] = c.value;
        }
        if (!jar[CSRF_COOKIE]) continue;
        const user = await whoAmI(jar);
        if (!user) continue;
        session = { dc: dc(), cookies: jar, user, createdAt: new Date().toISOString() };
        persist();
        return true;
      } catch (e) {
        if (child.exitCode !== null) {
          if (headless) return false;
          throw new Error('The sign-in window was closed before sign-in finished.');
        }
        if (browserWs && /DevTools/.test(e.message)) browserWs = null;
      }
    }
    if (headless) return false;
    throw new Error('Timed out waiting for Site24x7 sign-in.');
  } finally {
    if (browserWs) await cdp(browserWs, 'Browser.close').catch(() => {});
    setTimeout(() => { if (child.exitCode === null) child.kill(); }, 3000);
  }
}

const emit = () => bus.emit('event', { type: 'site24x7:auth', data: info() });

let silentJob = null;
/** Re-sign in without a window from the mon.ai Edge profile (works while its Zoho session is valid). */
export function silentLogin() {
  if (silentJob) return silentJob;
  if (!fs.existsSync(PROFILE_DIR) || login.status === 'running') return Promise.resolve(false);
  silentJob = (async () => {
    Object.assign(login, { status: 'refreshing', error: null });
    emit();
    let ok = false;
    try { ok = await runBrowser({ headless: true, timeoutMs: 45_000 }); } catch (e) { console.error('[site24x7] silent sign-in:', e.message); }
    Object.assign(login, ok ? { status: 'ok', error: null } : { status: 'needs-login', error: null });
    console.log(`[site24x7] silent sign-in ${ok ? 'ok' : 'not possible, sign in from a chat card or Settings'}`);
    emit();
    return ok;
  })().finally(() => { silentJob = null; });
  return silentJob;
}

/** Open the sign-in window and wait (up to 10 min) for a signed-in session. Returns at once. */
export async function start() {
  if (login.status === 'running') return info();
  if (silentJob && await silentJob) return info();
  const edge = config.get('azure').edgePath;
  if (!fs.existsSync(edge)) throw new Error(`Edge not found at ${edge} (Settings > General > Edge executable).`);
  Object.assign(login, { status: 'running', error: null });
  emit();
  runBrowser({ headless: false, timeoutMs: 10 * 60_000 })
    .then((ok) => { if (ok) Object.assign(login, { status: 'ok', error: null }); else if (login.status === 'running') Object.assign(login, { status: 'idle' }); })
    .catch((e) => Object.assign(login, { status: 'error', error: e.message }))
    .finally(emit);
  return info();
}

/** Is the saved session still accepted? (Settings and the sign-in card's "I've signed in".) */
export async function check() {
  if (!signedIn()) return { ...info(), ok: false };
  try { return { ...info(), ok: !!(await whoAmI(session.cookies)) }; } catch (e) { return { ...info(), ok: false, error: e.message }; }
}

/** Marker the chat turns into a sign-in card (stripped before the text is shown). */
export const signInMark = () => `[[mon:service-signin ${JSON.stringify({ service: 'site24x7', label: 'Site24x7', dc: dc() })}]]`;
function signInError(detail) {
  return new Error(`${detail}\nThe Site24x7 sign-in is missing or expired, and the silent re-sign-in did not work. `
    + 'mon.ai now shows the user a "Sign in to Site24x7" card in the chat: tell them in one line to use it, and that you will retry once they are signed in. Do not keep retrying Site24x7 calls in this turn.\n'
    + signInMark());
}

/**
 * GET a Site24x7 web-app API path ("/app/api/..." or a public-style "/api/..." / "current_status").
 * GET only. Retries once after a silent re-sign-in.
 */
export async function get(p) {
  if (!isConfigured()) throw new Error('Site24x7 is not set up (Settings > General > Site24x7: tick "Use Site24x7" and pick the data centre).');
  let clean = String(p || '').trim().replace(/^https?:\/\/[^/]+/i, '').replace(/^\/+/, '');
  clean = clean.replace(/^(app\/)?api\//, '');
  if (!clean || /\.\.|[\s#]/.test(clean)) throw new Error(`Not a Site24x7 API path: ${p}`);
  const url = `/app/api/${clean}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!signedIn()) {
      if (!(await silentLogin())) throw signInError('Site24x7: not signed in.');
    }
    try {
      const { res, body } = await rawGet(url, session.cookies);
      absorb(res);
      if (body.code && body.code !== 0) throw new Error(`Site24x7 error ${body.code}: ${body.message || 'request failed'} (${url})`);
      return body.data ?? body;
    } catch (e) {
      if (!(e instanceof AuthError)) throw e;
      clear();
      emit();
      if (attempt === 1) throw signInError(e.message);
    }
  }
  throw signInError('Site24x7: not signed in.');
}

// ---------- Monitors, status and outages ----------

export const STATUS = { 0: 'down', 1: 'up', 2: 'trouble', 3: 'critical', 5: 'suspended', 7: 'maintenance', 9: 'discovery', 10: 'configuration error' };

/** Flat list of monitors from current_status (monitors at the top level and inside groups). */
export async function currentStatus() {
  const d = await get('current_status');
  const seen = new Map();
  const add = (m, group) => {
    if (!m?.monitor_id) return;
    const prev = seen.get(m.monitor_id);
    if (prev) { if (group && !prev.groups.includes(group)) prev.groups.push(group); return; }
    seen.set(m.monitor_id, {
      id: m.monitor_id, name: m.name, type: m.monitor_type, status: STATUS[m.status] ?? m.status,
      groups: group ? [group] : [],
      lastPolled: m.last_polled_time || null, downReason: m.down_reason || null, since: m.duration || null,
      value: m.attribute_value != null ? `${m.attribute_value}${m.unit ? ` ${m.unit}` : ''}` : null,
      locations: (m.locations || []).map((l) => ({ location: l.location_name || l.name, status: STATUS[l.status] ?? l.status, reason: l.down_reason || null, lastPolled: l.last_polled_time || null })),
    });
  };
  for (const m of d.monitors || []) add(m, null);
  for (const g of d.monitor_groups || []) for (const m of g.monitors || []) add(m, g.group_name);
  return [...seen.values()];
}

/** Monitors whose name or group matches any of the terms (client code, monitoring names, zones). */
export function matchMonitors(monitors, terms) {
  const t = terms.map((x) => String(x).toLowerCase()).filter((x) => x.length >= 2);
  if (!t.length) return monitors;
  return monitors.filter((m) => t.some((x) => String(m.name).toLowerCase().includes(x) || m.groups.some((g) => String(g).toLowerCase().includes(x))));
}

const pad = (n) => String(n).padStart(2, '0');
/** Site24x7 custom period: period=50 with start_date / end_date (yyyy-MM-ddTHH:mm:ssZ, UTC). */
function periodQuery(from, to) {
  const f = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}Z`;
  return `period=50&start_date=${encodeURIComponent(f(from))}&end_date=${encodeURIComponent(f(to))}`;
}

/**
 * Outages (down / trouble periods with the reason) of one monitor between two times.
 * Tries the outage report first, then the alarm report the Outages tab uses.
 */
export async function outages(monitorId, from, to) {
  if (!/^\d+$/.test(String(monitorId))) throw new Error(`Not a Site24x7 monitor ID: ${monitorId}`);
  const q = periodQuery(from, to);
  let lastErr;
  for (const p of [`reports/outage/${monitorId}?${q}`, `reports/alarm/${monitorId}?${q}`]) {
    try { return normaliseOutages(await get(p), from, to); } catch (e) { if (/sign-in/i.test(e.message)) throw e; lastErr = e; }
  }
  throw lastErr;
}

const TIME_KEYS = { start: /^(start_?time|down_?time|from|start)$/i, end: /^(end_?time|up_?time|to|end)$/i };
/** Pull {start, end, duration, reason, type} rows out of whatever shape the report has. */
function normaliseOutages(d, from, to) {
  const rows = [];
  const walk = (o, depth = 0) => {
    if (!o || typeof o !== 'object' || depth > 5) return;
    if (Array.isArray(o)) { for (const x of o) walk(x, depth + 1); return; }
    const keys = Object.keys(o);
    const sk = keys.find((k) => TIME_KEYS.start.test(k));
    if (sk && typeof o[sk] === 'string') {
      const ek = keys.find((k) => TIME_KEYS.end.test(k));
      rows.push({
        start: o[sk], end: ek ? o[ek] || null : null,
        duration: o.duration ?? null, reason: o.reason ?? o.down_reason ?? o.message ?? null,
        type: o.type ?? o.status ?? null, location: o.location_name ?? o.location ?? null,
      });
      return;
    }
    for (const k of keys) walk(o[k], depth + 1);
  };
  walk(d);
  const t0 = from.getTime(), t1 = to.getTime();
  return rows
    .filter((r) => { const s = Date.parse(r.start), e = r.end ? Date.parse(r.end) : Date.now(); return !Number.isFinite(s) || (s <= t1 && e >= t0); })
    .sort((a, b) => String(a.start).localeCompare(String(b.start)));
}

/** Every check of one monitor on one day (per location, status, response time): minute-level detail. */
export async function pollLog(monitorId, date) {
  if (!/^\d+$/.test(String(monitorId))) throw new Error(`Not a Site24x7 monitor ID: ${monitorId}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) throw new Error('date must be YYYY-MM-DD');
  return get(`reports/log_reports/${monitorId}?date=${date}`);
}
