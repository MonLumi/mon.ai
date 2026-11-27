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

// The API answers 400 "Internal error." (error_code 1000) unless the request looks like the web app's:
// a browser User-Agent and a Referer on /app/client. The sign-in window's own User-Agent is kept.
const FALLBACK_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0';
function headers(cookies, userAgent) {
  return {
    Cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; '),
    'X-ZCSRF-TOKEN': `s247pname=${cookies[CSRF_COOKIE] || ''}`,
    Accept: 'application/json, text/plain, */*',
    'User-Agent': (userAgent || FALLBACK_UA).replace(/HeadlessChrome/g, 'Chrome'),
    Referer: `${base()}/app/client`,
    'Time-Zone': 'Australia/Queensland',
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

async function rawGet(p, cookies, userAgent = session?.userAgent) {
  const res = await fetch(base() + p, { headers: headers(cookies, userAgent), redirect: 'manual' });
  // Signed out: Zoho answers with a redirect to accounts.zoho.*, a 401/403, or an HTML sign-in page.
  if ((res.status >= 300 && res.status < 400) || res.status === 401 || res.status === 403) throw new AuthError(`Site24x7 ${res.status}: not signed in`);
  const type = res.headers.get('content-type') || '';
  const body = type.includes('json') ? await res.json().catch(() => null) : null;
  if (!body) {
    if (res.ok) throw new AuthError(`Site24x7 ${res.status}: not signed in (got ${type || 'no content type'})`);
    throw new Error(`Site24x7 ${res.status} ${res.statusText} for ${p}`);
  }
  // Errors come back as { error_code, message } (often with HTTP 400), not as { code, data }.
  if (body.error_code != null) throw new Error(`Site24x7 error ${body.error_code}: ${body.message || 'request failed'} (${p.split('?')[0]})`);
  return { res, body };
}

async function whoAmI(cookies, userAgent) {
  try {
    const { body } = await rawGet('/app/api/client_data/user', cookies, userAgent);
    if (body.code !== 0 && !body.data) return null;
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
  let userAgent = null;
  try {
    while (Date.now() < deadline) {
      if (!headless && login.status !== 'running') return false; // cancelled
      await new Promise((r) => setTimeout(r, headless ? 1500 : 2500));
      if (spawnError) throw new Error(spawnError);
      try {
        if (!browserWs) {
          const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
          browserWs = v.webSocketDebuggerUrl;
          userAgent = String(v['User-Agent'] || '').replace(/HeadlessChrome/g, 'Chrome') || null;
        }
        const { cookies } = await cdp(browserWs, 'Storage.getCookies');
        const jar = {};
        for (const c of cookies) {
          const d = c.domain.replace(/^\./, '');
          if (d === suffix || d.endsWith(`.${suffix}`)) jar[c.name] = c.value;
        }
        if (!jar[CSRF_COOKIE]) continue;
        const user = await whoAmI(jar, userAgent);
        if (!user) continue;
        session = { dc: dc(), cookies: jar, user, userAgent, createdAt: new Date().toISOString() };
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
  try { return { ...info(), ok: !!(await whoAmI(session.cookies, session.userAgent)) }; } catch (e) { return { ...info(), ok: false, error: e.message }; }
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
      if (body.code != null && body.code !== 0) throw new Error(`Site24x7 error ${body.code}: ${body.message || 'request failed'} (${url})`);
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

/**
 * Monitors for one site or search text (Site24x7 has 900+ monitors: never scan them all).
 * Matches the monitor name and group, e.g. "DW Site - www.x.com" for host www.x.com. A host is also
 * tried without "www." and with its path. Website-type monitors come first; certificate and domain
 * expiry monitors only when `all` is set or nothing else matches.
 */
export function findMonitors(monitors, search, { all = false } = {}) {
  const raw = String(search || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  if (raw.length < 3) return [];
  const terms = [...new Set([raw, raw.replace(/^www\./, ''), raw.split('/')[0], raw.split('/')[0].replace(/^www\./, '')])].filter((t) => t.length >= 3);
  const hit = (m) => terms.some((t) => String(m.name).toLowerCase().includes(t) || m.groups.some((g) => String(g).toLowerCase() === t));
  const found = monitors.filter(hit);
  const site = found.filter((m) => !/^(SSL_CERT|DOMAINEXPIRY|WEBSITEDEFACEMENT)$/.test(m.type));
  // Best first: the exact host / URL as a whole word in the name ("… www.qbe.com" or "… www.qbe.com (US)",
  // not "… www.qbe.com/au"), then failing monitors, then shorter names.
  const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const exact = (m) => terms.slice(0, 2).some((t) => new RegExp(`(^|[\\s/.-])${esc(t)}(?=$|[\\s(])`, 'i').test(String(m.name)));
  return (all || !site.length ? found : site)
    .sort((a, b) => Number(exact(b)) - Number(exact(a)) || Number(b.status !== 'up') - Number(a.status !== 'up') || String(a.name).length - String(b.name).length);
}

const pad = (n) => String(n).padStart(2, '0');
/** Site24x7 custom period: period=50 with start_date / end_date (yyyy-MM-ddTHH:mm:ss+0000; a trailing Z is refused). */
function periodQuery(from, to) {
  const f = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}+0000`;
  return `period=50&start_date=${encodeURIComponent(f(from))}&end_date=${encodeURIComponent(f(to))}`;
}

/**
 * Outages (down / trouble periods with the reason) of one monitor between two times, from the outage
 * report. `start` / `end` are clipped to the window; `startedAt` is when the outage really began
 * (it can be long before the window).
 */
export async function outages(monitorId, from, to) {
  if (!/^\d+$/.test(String(monitorId))) throw new Error(`Not a Site24x7 monitor ID: ${monitorId}`);
  const d = await get(`reports/outage/${monitorId}?${periodQuery(from, to)}`);
  const rows = [];
  for (const det of d.outage_details || []) {
    for (const o of det.outages || []) {
      rows.push({
        start: o.start_time || null, end: o.end_time || null,
        startedAt: o.actual_outage_time && o.actual_outage_time !== o.start_time ? o.actual_outage_time : null,
        duration: String(o.duration || '').trim() || null,
        reason: o.reason || null,
        type: o.type === 0 || o.type === '0' ? 'down' : o.type === 2 || o.type === '2' ? 'trouble' : o.type ?? null,
        comment: o.latest_comment && o.latest_comment !== '-' ? o.latest_comment : null,
      });
    }
  }
  return rows.sort((a, b) => String(a.start).localeCompare(String(b.start)));
}

let locationCache = { at: 0, map: {} };
async function locationNames() {
  if (Date.now() - locationCache.at < 24 * 3600_000 && Object.keys(locationCache.map).length) return locationCache.map;
  const d = await get('location_template');
  locationCache = { at: Date.now(), map: Object.fromEntries((d.locations || []).map((l) => [String(l.location_id), l.display_name || l.city_name])) };
  return locationCache.map;
}

/**
 * The checks of one monitor on one day (UTC date), summarised: per location how many checks failed and
 * the first / last failure, every status change (up → down and back) and the failed checks themselves
 * (at most 150), optionally limited to a from / to window. Minute-level detail for an outage.
 */
export async function pollLog(monitorId, date, { from = null, to = null } = {}) {
  if (!/^\d+$/.test(String(monitorId))) throw new Error(`Not a Site24x7 monitor ID: ${monitorId}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) throw new Error('date must be YYYY-MM-DD');
  const [d, names] = await Promise.all([get(`reports/log_reports/${monitorId}?date=${date}`), locationNames().catch(() => ({}))]);
  const t0 = from ? Date.parse(from) : -Infinity, t1 = to ? Date.parse(to) : Infinity;
  const num = (v) => (v == null || v === '-' || v === '' ? null : Number(v));
  const rows = (Array.isArray(d.report) ? d.report : [])
    .map((r) => ({
      at: r.collection_time, t: Date.parse(r.collection_time),
      location: names[String(r.location_id)] || `location ${r.location_id}`,
      up: String(r.availability) === '1', status: num(r.response_code), ms: num(r.response_time),
      firstByteMs: num(r.firstbyte_time), dnsMs: num(r.dns_time), reason: r.reason && r.reason !== '-' ? r.reason : null,
      ip: r.resolved_ip && r.resolved_ip !== '-' ? r.resolved_ip : null,
    }))
    .filter((r) => Number.isFinite(r.t) && r.t >= t0 && r.t <= t1)
    .sort((a, b) => a.t - b.t);
  const perLocation = {};
  const changes = [];
  const last = {};
  for (const r of rows) {
    const p = perLocation[r.location] ||= { checks: 0, failed: 0, firstFailure: null, lastFailure: null, slowestMs: null };
    p.checks++;
    if (!r.up) { p.failed++; p.firstFailure ||= r.at; p.lastFailure = r.at; }
    if (r.ms != null && (p.slowestMs == null || r.ms > p.slowestMs)) p.slowestMs = r.ms;
    if (last[r.location] !== undefined && last[r.location] !== r.up) changes.push({ at: r.at, location: r.location, to: r.up ? 'up' : 'down', status: r.status, reason: r.reason });
    last[r.location] = r.up;
  }
  const strip = ({ t, ...r }) => r;
  const failures = rows.filter((r) => !r.up);
  return {
    date, checks: rows.length, failed: failures.length, perLocation, statusChanges: changes.slice(0, 100),
    failures: failures.slice(0, 150).map(strip), ...(failures.length > 150 ? { moreFailures: failures.length - 150 } : {}),
  };
}
