// Squadcast (SolarWinds Incident Response): the hub for Azure Monitor alerts.
// Uses the API token from your Squadcast profile (a refresh token). mon.ai swaps it for a short-lived
// access token at auth.<region>.squadcast.com and calls the v3 REST API, GET only.
// A rejected token makes the tool error carry a marker the chat turns into a "Squadcast token" card.
import { config } from './config.js';

const hosts = () => {
  const region = String(config.get('secrets').squadcast?.region || 'eu').toLowerCase();
  return region === 'us'
    ? { api: 'https://api.squadcast.com', auth: 'https://auth.squadcast.com', app: 'https://incidents.na-01.cloud.solarwinds.com' }
    : { api: 'https://api.eu.squadcast.com', auth: 'https://auth.eu.squadcast.com', app: 'https://incidents.eu-01.cloud.solarwinds.com' };
};
const refreshToken = () => String(config.get('secrets').squadcast?.apiToken || '').trim();
export const isConfigured = () => !!refreshToken();
export const appUrl = (p = '') => `${hosts().app}${p}`;

let access = null; // { token, exp, key }

export const signInMark = () => `[[mon:service-signin ${JSON.stringify({ service: 'squadcast', label: 'Squadcast' })}]]`;
function tokenError(detail) {
  return new Error(`${detail}\nThe Squadcast API token is missing, expired or revoked. mon.ai now shows the user a "Squadcast token" card in the chat `
    + 'that opens Settings > General > Squadcast: tell them in one line to paste a new token there, and that you will retry afterwards. Do not keep retrying Squadcast calls in this turn.\n'
    + signInMark());
}

async function accessToken({ fresh = false } = {}) {
  const rt = refreshToken();
  if (!rt) throw tokenError('Squadcast: no API token configured.');
  const key = `${hosts().auth}|${rt.slice(-8)}`;
  if (!fresh && access?.key === key && access.exp - Date.now() > 2 * 60_000) return access.token;
  const res = await fetch(`${hosts().auth}/oauth/access-token`, { headers: { 'X-Refresh-Token': rt, Accept: 'application/json' } });
  const body = await res.json().catch(() => ({}));
  // A bad or revoked token: 401 / 403, or 404 "invalid refresh token" (what the EU auth server answers).
  if (res.status === 401 || res.status === 403 || (res.status === 404 && /token/i.test(body?.meta?.error_message || ''))) {
    throw tokenError(`Squadcast ${res.status}: the API token was rejected (${body?.meta?.error_message || 'unauthorized'}).`);
  }
  if (!res.ok || !body?.data?.access_token) throw new Error(`Squadcast token exchange failed: ${res.status} ${body?.meta?.error_message || res.statusText}`);
  const exp = Number(body.data.expires_at) ? Number(body.data.expires_at) * 1000 : Date.now() + 30 * 60_000;
  access = { token: body.data.access_token, exp, key };
  return access.token;
}

/** GET a Squadcast v3 path, e.g. "services" or "incidents/export?type=json&...". Returns the parsed body. */
export async function get(p) {
  let clean = String(p || '').trim().replace(/^https?:\/\/[^/]+/i, '').replace(/^\/+/, '').replace(/^v3\//, '');
  if (!clean || /\.\.|[\s#]/.test(clean)) throw new Error(`Not a Squadcast API path: ${p}`);
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await accessToken({ fresh: attempt > 0 });
    const res = await fetch(`${hosts().api}/v3/${clean}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
    if (res.status === 401 && attempt === 0) { access = null; continue; }
    const body = await res.json().catch(() => null);
    if (res.status === 401 || res.status === 403) throw tokenError(`Squadcast ${res.status}: ${body?.meta?.error_message || 'access denied'} (${clean.split('?')[0]})`);
    if (!res.ok) throw new Error(`Squadcast ${res.status}: ${body?.meta?.error_message || res.statusText} (${clean.split('?')[0]})`);
    return body;
  }
  throw tokenError('Squadcast: access token refused.');
}

/** Token works? Uses the organization (a token's role may not allow /me). Shows "org · team". */
export async function check() {
  if (!isConfigured()) return { configured: false, ok: false };
  try {
    const org = (await get('organization'))?.data || {};
    const t = await teams().catch(() => []);
    return { configured: true, ok: true, user: [org.name, t.map((x) => x.name).join(', ')].filter(Boolean).join(' · ') || null };
  } catch (e) { return { configured: true, ok: false, error: e.message.split('\n')[0] }; }
}

let teamCache = { at: 0, list: [] };
/** Teams the token sees: the incident export needs one as owner_id. */
export async function teams() {
  if (Date.now() - teamCache.at < 30 * 60_000 && teamCache.list.length) return teamCache.list;
  const list = ((await get('teams'))?.data || []).map((t) => ({ id: t.id, name: t.name, default: !!t.default }));
  teamCache = { at: Date.now(), list };
  return list;
}

let serviceCache = { at: 0, list: [] };
export async function services({ fresh = false } = {}) {
  if (!fresh && Date.now() - serviceCache.at < 30 * 60_000 && serviceCache.list.length) return serviceCache.list;
  const body = await get('services');
  const list = (body?.data || []).map((s) => ({ id: s.id, name: s.name, slug: s.slug || null, description: s.description || null }));
  serviceCache = { at: Date.now(), list };
  return list;
}

/** Services whose name matches any of the terms. */
export function matchServices(list, terms) {
  const t = terms.map((x) => String(x).toLowerCase()).filter((x) => x.length >= 2);
  if (!t.length) return list;
  return list.filter((s) => t.some((x) => `${s.name} ${s.slug || ''}`.toLowerCase().includes(x)));
}

const iso = (d) => new Date(d).toISOString();
/**
 * Incidents created between two times (optionally for some services), newest first, trimmed to
 * what matters for a timeline: when it triggered / was acknowledged / resolved, the alert source and
 * the alert's own text (Azure Monitor: rule, resource, condition).
 */
export async function incidents({ from, to, serviceIds = [], status = [] }) {
  const owners = await teams();
  if (!owners.length) throw new Error('Squadcast: the token sees no team (the incident export needs one).');
  const out = [];
  for (const team of owners) out.push(...await exportRange(team.id, new Date(from), new Date(to), serviceIds, status, 0));
  const seen = new Set();
  return out.map(trimIncident).filter((i) => !seen.has(i.id) && seen.add(i.id))
    .sort((a, b) => String(b.triggeredAt).localeCompare(String(a.triggeredAt)));
}

/** The export refuses more than 1000 incidents at once: split the window in halves until each part fits. */
async function exportRange(ownerId, from, to, serviceIds, status, depth) {
  const q = new URLSearchParams({ type: 'json', start_time: iso(from), end_time: iso(to), owner_id: ownerId });
  for (const s of serviceIds) q.append('services', s);
  for (const s of status) q.append('status', s);
  try {
    const body = await get(`incidents/export?${q}`);
    const raw = body?.incidents || body?.data?.incidents || body?.data || (Array.isArray(body) ? body : []);
    return Array.isArray(raw) ? raw : [];
  } catch (e) {
    if (!/maximum of 1000/i.test(e.message)) throw e;
    if (depth >= 4) throw new Error(`Squadcast: more than 1000 incidents even in ${Math.round((to - from) / 60_000)} minutes. Narrow it to a client (org) or a shorter window.`);
    const mid = new Date((from.getTime() + to.getTime()) / 2);
    return [...await exportRange(ownerId, from, mid, serviceIds, status, depth + 1), ...await exportRange(ownerId, mid, to, serviceIds, status, depth + 1)];
  }
}

// Squadcast writes "not yet" as the zero time 0001-01-01T00:00:00Z.
const pick = (o, ...keys) => { for (const k of keys) if (o?.[k] != null && o[k] !== '' && !/^0001-01-01/.test(String(o[k]))) return o[k]; return null; };
function trimIncident(i) {
  const desc = String(pick(i, 'description') || '');
  return {
    id: pick(i, 'id', 'incident_id'),
    title: pick(i, 'title', 'message'),
    status: pick(i, 'status'),
    priority: pick(i, 'priority'),
    service: pick(i, 'service', 'service_name') ?? i.service?.name ?? null,
    alertSource: pick(i, 'alert_source', 'alert_source_name') ?? i.alert_source?.name ?? null,
    triggeredAt: pick(i, 'created_at', 'triggered_at', 'start_time'),
    acknowledgedAt: pick(i, 'acknowledged_at', 'tta_at'),
    resolvedAt: pick(i, 'resolved_at', 'end_time'),
    assignee: (() => { const a = pick(i, 'assigned_to', 'assignee'); return a && typeof a === 'object' ? a.name || a.username || a.type || null : a; })(),
    events: i.event_count ?? null,
    // Tags come as { name: { value, color } }: keep the values (resource, severity, alert_type...).
    tags: i.tags && typeof i.tags === 'object' ? Object.fromEntries(Object.entries(i.tags).map(([k, v]) => [k, v && typeof v === 'object' ? v.value : v])) : null,
    description: desc.length > 1200 ? `${desc.slice(0, 1200)}…` : desc || null,
    url: pick(i, 'incident_url', 'url') || (pick(i, 'id', 'incident_id') ? appUrl(`/incident/${pick(i, 'id', 'incident_id')}`) : null),
  };
}
