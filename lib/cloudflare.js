// Cloudflare via a read-only API token. REST calls are GET only; Security Events use the GraphQL
// Analytics API (POST, but read-only by design: it has no mutations, and the queries are fixed here).
import { config, zoneClient } from './config.js';
import { kv } from './db.js';

// Zones and the token check rarely change: cache them for an hour, and keep the cache
// in the local database so a restart still opens the Cloudflare page instantly.
const CACHE_MS = 60 * 60_000;

export function isConfigured() { return !!config.get('secrets').cloudflare.apiToken; }

export async function get(pathAndQuery) {
  const token = (config.get('secrets').cloudflare.apiToken || '').trim().replace(/^Bearer\s+/i, '');
  if (!token) throw new Error('Cloudflare API token is not configured (Settings > Connections).');
  const clean = pathAndQuery.replace(/^\/+(client\/v4\/)?/, '');
  const res = await fetch(`https://api.cloudflare.com/client/v4/${clean}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.success === false) {
    throw new Error(`Cloudflare ${res.status}: ${(body.errors || []).map((e) => e.message).join('; ') || res.statusText}`);
  }
  return body;
}

/**
 * User-owned tokens verify on /user/tokens/verify, account-owned tokens only on
 * /accounts/{id}/tokens/verify. Try both, and never let verification block the zone list.
 */
export async function verify({ fresh = false } = {}) {
  const hit = kv.get('cloudflare.verify');
  if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.result;
  const result = await verifyNow();
  if (result.status !== 'unverified') kv.set('cloudflare.verify', { at: Date.now(), result });
  return result;
}

async function verifyNow() {
  const accountId = (config.get('secrets').cloudflare.accountId || '').trim();
  const routes = ['user/tokens/verify', ...(accountId ? [`accounts/${accountId}/tokens/verify`] : [])];
  if (accountId) routes.reverse();
  let lastErr;
  for (const r of routes) {
    try { return { ...(await get(r)).result, owner: r.startsWith('accounts') ? 'account' : 'user' }; } catch (e) { lastErr = e; }
  }
  return { status: 'unverified', error: lastErr?.message };
}

export function hint(message) {
  if (!/401|403|Invalid API Token|Authentication error/i.test(message)) return '';
  return ' Check that you pasted an API Token (My Profile > API Tokens, or Manage Account > Account API Tokens), not the Global API Key or the token ID. For an Account API Token, also fill in the Account ID. The token needs Zone:Read.';
}

let zoneCache = kv.get('cloudflare.zones') || { at: 0, key: '', zones: [] };

/** Zones visible to the token, limited to the configured account (Account ID) when set. Cached for an hour. */
export async function zones({ fresh = false } = {}) {
  const accountId = (config.get('secrets').cloudflare.accountId || '').trim();
  if (!fresh && zoneCache.key === accountId && Date.now() - zoneCache.at < CACHE_MS) return zoneCache.zones;
  const all = [];
  const filter = accountId ? `&account.id=${encodeURIComponent(accountId)}` : '';
  for (let page = 1; page < 40; page++) {
    const body = await get(`zones?per_page=50&page=${page}${filter}`);
    all.push(...body.result.map((z) => ({
      id: z.id, name: z.name, status: z.status, paused: z.paused, plan: z.plan?.name, account: z.account?.name, accountId: z.account?.id,
    })));
    if (page >= (body.result_info?.total_pages || 1)) break;
  }
  zoneCache = { at: Date.now(), key: accountId, zones: all };
  kv.set('cloudflare.zones', zoneCache);
  return all;
}

export function cachedZones() { return zoneCache.zones; }
export function cachedAt() { return zoneCache.at ? new Date(zoneCache.at).toISOString() : null; }

// A new token or account means the cached data is for the wrong credentials.
config.on('change', (name) => { if (name === 'secrets') { zoneCache = { at: 0, key: '', zones: [] }; kv.set('cloudflare.zones', zoneCache); kv.set('cloudflare.verify', null); } });

/** Refuses zone-scoped paths for zones outside the configured account. */
export async function assertZoneAllowed(pathAndQuery) {
  const m = pathAndQuery.replace(/^\/+(client\/v4\/)?/, '').match(/^zones\/([0-9a-f]{32})/i);
  if (m) await assertZoneIdAllowed(m[1]);
}
async function assertZoneIdAllowed(id) {
  if (!(config.get('secrets').cloudflare.accountId || '').trim()) return;
  const list = await zones();
  if (!list.some((z) => z.id === id)) throw new Error('That zone is not in the configured Cloudflare account.');
}

// ---------------- Security Events (firewallEventsAdaptive) ----------------
// What the dashboard shows under Security > Events: every WAF / custom rule / rate limit / bot /
// managed-rule action, with the rule, request and client. Kept for about 30 days.

/** Zones for a zone ID, zone name or client code (a client may have several zones). */
export async function resolveZones(ref) {
  const r = String(ref || '').trim();
  if (!r) throw new Error('Give a zone ID, zone name or client code.');
  const list = await zones();
  const hit = list.filter((z) => z.id === r || z.name.toLowerCase() === r.toLowerCase());
  if (hit.length) return hit;
  const byClient = list.filter((z) => (zoneClient(z.name) || '').toLowerCase() === r.toLowerCase());
  if (byClient.length) return byClient;
  throw new Error(`No Cloudflare zone matches "${r}". Use cloudflare_zones to find it (custom hostnames like www.client.com usually live in the client's *.saas.dataweavers.io zone).`);
}

async function graphql(queryText, variables) {
  const token = (config.get('secrets').cloudflare.apiToken || '').trim().replace(/^Bearer\s+/i, '');
  if (!token) throw new Error('Cloudflare API token is not configured (Settings > Connections).');
  const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query: queryText, variables }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.errors?.length) {
    throw new Error(`Cloudflare GraphQL ${res.status}: ${(body.errors || []).map((e) => e.message).join('; ') || res.statusText}`);
  }
  return body.data;
}

const EVENT_FIELDS = [
  'datetime', 'action', 'source', 'kind', 'description', 'ruleId', 'rulesetId', 'rayName', 'matchIndex',
  'clientIP', 'clientCountryName', 'clientAsn', 'clientASNDescription', 'clientIPClass',
  'clientRequestHTTPMethodName', 'clientRequestScheme', 'clientRequestHTTPHost', 'clientRequestPath', 'clientRequestQuery',
  'clientRefererHost', 'userAgent', 'edgeResponseStatus', 'originResponseStatus', 'edgeColoName',
  'botScore', 'botScoreSrcName', 'verifiedBotCategory', 'wafAttackScore', 'wafAttackScoreClass', 'ja4',
];
/** Dimensions security_events_top can group by (a fixed list, since they go into the query text). */
export const EVENT_DIMENSIONS = [
  'action', 'source', 'ruleId', 'description', 'rulesetId', 'clientRequestHTTPHost', 'clientRequestPath',
  'clientRequestHTTPMethodName', 'clientIP', 'clientCountryName', 'clientAsn', 'clientASNDescription', 'userAgent',
  'edgeResponseStatus', 'originResponseStatus', 'botScore', 'verifiedBotCategory', 'wafAttackScoreClass', 'ja4',
  'datetimeHour', 'datetimeFifteenMinutes', 'edgeColoName',
];

const asList = (v) => (Array.isArray(v) ? v : String(v || '').split(',')).map((x) => String(x).trim()).filter(Boolean);

/**
 * GraphQL filter from friendly options. Time: since/until (ISO) or hours (default 24; 7 days when
 * looking up a Ray ID). "skip" events (allow rules that let a request through) are left out unless
 * asked for, since they usually outnumber everything else.
 */
export function eventFilter(o = {}) {
  const until = o.until ? new Date(o.until) : new Date();
  const hours = Number(o.hours) || (o.rayId ? 24 * 7 : 24);
  const since = o.since ? new Date(o.since) : new Date(until.getTime() - hours * 36e5);
  if (Number.isNaN(since.getTime()) || Number.isNaN(until.getTime())) throw new Error('since/until must be ISO dates, e.g. 2026-11-24T08:00:00Z');
  const oldest = Date.now() - 30 * 864e5 + 60_000; // retention is about 30 days
  const f = { datetime_geq: new Date(Math.max(since.getTime(), oldest)).toISOString(), datetime_leq: until.toISOString() };
  if (o.rayId) f.rayName = String(o.rayId).trim().toLowerCase().replace(/-[a-z]{3}$/, ''); // "a5f72b…-SYD" -> "a5f72b…"
  const actions = asList(o.action);
  if (actions.length) f.action_in = actions;
  else if (!o.includeSkip && !o.rayId) f.action_neq = 'skip';
  const sources = asList(o.source);
  if (sources.length) f.source_in = sources;
  if (o.ruleId) f.ruleId = String(o.ruleId).trim();
  if (o.host) f.clientRequestHTTPHost = String(o.host).trim().toLowerCase();
  if (o.path) {
    const p = String(o.path).trim();
    f.clientRequestPath_like = /[*%]/.test(p) ? p.replace(/\*/g, '%') : `%${p}%`;
  }
  if (o.query) f.clientRequestQuery_like = `%${String(o.query).trim()}%`;
  if (o.method) f.clientRequestHTTPMethodName = String(o.method).trim().toUpperCase();
  if (o.clientIP) f.clientIP = String(o.clientIP).trim();
  if (o.country) f.clientCountryName = String(o.country).trim().toUpperCase();
  if (o.asn) f.clientAsn = String(o.asn).replace(/^AS/i, '').trim();
  if (o.userAgent) f.userAgent_like = `%${String(o.userAgent).trim()}%`;
  return f;
}

/** Latest matching Security Events for one or more zones, newest first. */
export async function securityEvents(zoneRef, o = {}) {
  const zs = await resolveZones(zoneRef);
  for (const z of zs) await assertZoneIdAllowed(z.id);
  const filter = eventFilter(o);
  const limit = Math.min(Math.max(Number(o.limit) || 25, 1), 100);
  const data = await graphql(
    `query($zones:[String!], $f:ZoneFirewallEventsAdaptiveFilter_InputObject!, $n:uint64!) {
      viewer { zones(filter:{zoneTag_in:$zones}) { zoneTag
        firewallEventsAdaptive(limit:$n, filter:$f, orderBy:[datetime_DESC]) { ${EVENT_FIELDS.join(' ')} } } } }`,
    { zones: zs.map((z) => z.id), f: filter, n: limit },
  );
  const name = new Map(zs.map((z) => [z.id, z.name]));
  const events = data.viewer.zones
    // Drop empty fields: events are read by the assistant, and blanks only cost tokens.
    .flatMap((zn) => zn.firewallEventsAdaptive.map((e) => ({ zone: name.get(zn.zoneTag), ...Object.fromEntries(Object.entries(e).filter(([, v]) => v !== '' && v !== null)) })))
    .sort((a, b) => b.datetime.localeCompare(a.datetime))
    .slice(0, limit);
  return { zones: zs.map((z) => z.name), range: { since: filter.datetime_geq, until: filter.datetime_leq }, filter, count: events.length, events };
}

/** Event counts grouped by some dimensions (top N), plus the total, for one or more zones. */
export async function securityEventsTop(zoneRef, by = ['action', 'source', 'description'], o = {}) {
  const dims = asList(by);
  const bad = dims.filter((d) => !EVENT_DIMENSIONS.includes(d));
  if (!dims.length || bad.length) throw new Error(`group by must be one or more of: ${EVENT_DIMENSIONS.join(', ')}`);
  const zs = await resolveZones(zoneRef);
  for (const z of zs) await assertZoneIdAllowed(z.id);
  const filter = eventFilter(o);
  const limit = Math.min(Math.max(Number(o.limit) || 15, 1), 100);
  const data = await graphql(
    `query($zones:[String!], $f:ZoneFirewallEventsAdaptiveGroupsFilter_InputObject!, $n:uint64!) {
      viewer { zones(filter:{zoneTag_in:$zones}) { zoneTag
        total: firewallEventsAdaptiveGroups(limit:1, filter:$f) { count }
        top: firewallEventsAdaptiveGroups(limit:$n, filter:$f, orderBy:[count_DESC]) { count dimensions { ${dims.join(' ')} } } } } }`,
    { zones: zs.map((z) => z.id), f: filter, n: limit },
  );
  const name = new Map(zs.map((z) => [z.id, z.name]));
  const total = data.viewer.zones.reduce((n, zn) => n + (zn.total[0]?.count || 0), 0);
  const groups = data.viewer.zones
    .flatMap((zn) => zn.top.map((g) => ({ ...(zs.length > 1 ? { zone: name.get(zn.zoneTag) } : {}), count: g.count, ...g.dimensions })))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
  return { zones: zs.map((z) => z.name), range: { since: filter.datetime_geq, until: filter.datetime_leq }, filter, by: dims, total, groups };
}
