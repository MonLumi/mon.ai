// Zendesk sign-in through the browser, for accounts without an API token.
// Opens Edge with a dedicated mon.ai profile, you sign in as usual (SSO, MFA...),
// then the session cookies are read over the DevTools protocol and reused for
// read-only API calls. The profile is kept, so later sign-ins are usually one click.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { config } from './config.js';
import { bus } from './db.js';

const DATA_DIR = path.resolve(process.env.MON_DATA_DIR || path.join(import.meta.dirname, '..', 'data'));
const SESSION_FILE = path.join(DATA_DIR, 'zendesk-session.json');
const PROFILE_DIR = path.join(DATA_DIR, 'zendesk-browser');

let session = load();
export const login = { status: 'idle', error: null };

function load() {
  try { return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')); } catch { return null; }
}
function persist() {
  if (session) fs.writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2));
  else fs.rmSync(SESSION_FILE, { force: true });
}

export function subdomain() {
  return (config.get('secrets').zendesk.subdomain || '').replace(/^https?:\/\//, '').replace(/\.zendesk\.com.*$/i, '').trim();
}

/** Cookie header for the configured subdomain, or null when not signed in. */
export function cookieHeader() {
  if (!session || session.subdomain !== subdomain()) return null;
  return Object.entries(session.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
}

/** Keep cookies fresh: Zendesk rotates the session cookie on responses. */
export function absorb(res) {
  if (!session) return;
  const set = res.headers.getSetCookie?.() || [];
  let changed = false;
  for (const c of set) {
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

export function clear() { session = null; persist(); }
export function info() {
  return { signedIn: !!cookieHeader(), user: session?.user || null, since: session?.createdAt || null, login };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on('error', reject);
  });
}

async function cdp(wsUrl, method, params = {}) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('DevTools connection failed')); });
  try {
    return await new Promise((res, rej) => {
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id === 1) msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
      };
      ws.send(JSON.stringify({ id: 1, method, params }));
    });
  } finally { ws.close(); }
}

async function whoAmI(sub, cookies) {
  const res = await fetch(`https://${sub}.zendesk.com/api/v2/users/me.json`, {
    headers: { Cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; '), Accept: 'application/json' },
  });
  if (!res.ok) return null;
  const { user } = await res.json();
  return user?.id ? user : null; // anonymous sessions return id: null
}

/**
 * Run Edge on the mon.ai profile and wait until it holds a signed-in Zendesk session.
 * `headless`: no window, used for the silent sign-in at start-up / when the session expires
 * (works while the profile still has a valid Zendesk or SSO session). Resolves true on success.
 */
async function runBrowser({ headless, timeoutMs }) {
  const sub = subdomain();
  const edge = config.get('azure').edgePath;
  if (!fs.existsSync(edge)) throw new Error(`Edge not found at ${edge} (Settings > Azure & ADO > Edge executable).`);
  const port = await freePort();
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  const child = spawn(edge, [
    `--user-data-dir=${PROFILE_DIR}`, `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1',
    '--no-first-run', '--no-default-browser-check',
    ...(headless ? ['--headless=new', '--disable-gpu', '--window-size=1280,900'] : []),
    `https://${sub}.zendesk.com/agent/`,
  ], { stdio: 'ignore' });
  let spawnError = null;
  child.on('error', (e) => { spawnError = e.message; });
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
          if (d === `${sub}.zendesk.com` || d === 'zendesk.com') jar[c.name] = c.value;
        }
        if (!Object.keys(jar).length) continue;
        const user = await whoAmI(sub, jar);
        if (!user) continue;
        session = { subdomain: sub, cookies: jar, user: { id: user.id, name: user.name, email: user.email }, createdAt: new Date().toISOString() };
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
    throw new Error('Timed out waiting for Zendesk sign-in.');
  } finally {
    if (browserWs) await cdp(browserWs, 'Browser.close').catch(() => {});
    setTimeout(() => { if (child.exitCode === null) child.kill(); }, 3000);
  }
}

let silentJob = null;
/**
 * Sign in without any window, reusing the mon.ai Edge profile (its Zendesk / SSO cookies).
 * Only tried when the profile exists, i.e. you have signed in through the browser before.
 * Concurrent callers share one attempt. Resolves true when a session is ready.
 */
export function silentLogin() {
  if (silentJob) return silentJob;
  if (!subdomain() || !fs.existsSync(PROFILE_DIR) || login.status === 'running') return Promise.resolve(false);
  silentJob = (async () => {
    Object.assign(login, { status: 'refreshing', error: null });
    bus.emit('event', { type: 'zendesk:auth', data: info() });
    let ok = false;
    try { ok = await runBrowser({ headless: true, timeoutMs: 45_000 }); } catch (e) { console.error('[zendesk] silent sign-in:', e.message); }
    Object.assign(login, ok ? { status: 'ok', error: null } : { status: 'needs-login', error: null });
    console.log(`[zendesk] silent sign-in ${ok ? `ok (${session.user?.name})` : 'not possible, sign in from the Dashboard'}`);
    bus.emit('event', { type: 'zendesk:auth', data: info() });
    return ok;
  })().finally(() => { silentJob = null; });
  return silentJob;
}

/** Is the saved session still accepted by Zendesk? */
export async function verify() {
  if (!cookieHeader()) return false;
  try { return !!(await whoAmI(session.subdomain, session.cookies)); } catch { return true; } // offline: keep it, sync will tell
}

/** Start-up: keep a working saved session, otherwise sign in silently. Resolves true when signed in. */
export async function ensure() {
  if (!subdomain()) return false;
  if (await verify()) return true;
  if (session) clear();
  return silentLogin();
}

/** Launch the sign-in browser and wait (up to 10 min) until a signed-in session appears. */
export async function start() {
  if (!subdomain()) throw new Error('Set your Zendesk subdomain first (Settings > Zendesk & Cloudflare).');
  if (login.status === 'running') return info();
  if (silentJob && await silentJob) return info(); // the silent attempt already signed us in
  const edge = config.get('azure').edgePath;
  if (!fs.existsSync(edge)) throw new Error(`Edge not found at ${edge} (Settings > Azure & ADO > Edge executable).`);
  Object.assign(login, { status: 'running', error: null });
  bus.emit('event', { type: 'zendesk:auth', data: info() });
  runBrowser({ headless: false, timeoutMs: 10 * 60_000 })
    .then((ok) => { if (ok) Object.assign(login, { status: 'ok', error: null }); else if (login.status === 'running') Object.assign(login, { status: 'idle' }); })
    .catch((e) => Object.assign(login, { status: 'error', error: e.message }))
    .finally(() => bus.emit('event', { type: 'zendesk:auth', data: info() }));
  return info();
}
