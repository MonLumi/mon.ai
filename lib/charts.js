// Azure Logs (KQL) and Metrics as charts and tables in the chat, instead of portal screenshots.
// The assistant calls azure_chart (or pastes a portal link); mon.ai runs the query itself with
// fixed read-only endpoints, saves the result under data/charts/<id>.json and shows it as a card
// (chart / table, Copy image, Copy CSV). The model only gets a compact summary of the numbers.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { randomBytes } from 'node:crypto';
import * as azure from './azure.js';

const DIR = path.resolve(process.env.MON_DATA_DIR || path.join(import.meta.dirname, '..', 'data'), 'charts');
const ID = /^[0-9a-f]{12}$/;
const LOGS = 'https://api.loganalytics.io';
const ARM = 'https://management.azure.com';
const MAX_ROWS = 5000;    // rows kept for the table view
const MAX_SERIES = 8;     // lines per chart = the 8 palette colours (the rest are dropped, largest kept)
export const MARK = /\[\[mon:chart ([0-9a-f]{12})\]\]/g;

// ---------- Time helpers ----------
const DUR = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i;
function durationMs(iso) {
  const m = String(iso || '').match(DUR);
  if (!m || iso === 'P' || iso === 'PT') return null;
  return ((+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0)) * 1000;
}
/** "P1D", "PT6H", or "<start>/<end>" (ISO dates) → { start, end, label }. */
export function parseTimespan(ts = 'P1D') {
  const s = String(ts).trim();
  if (s.includes('/')) {
    const [a, b] = s.split('/');
    const start = Date.parse(a); const end = DUR.test(b) ? start + durationMs(b) : Date.parse(b);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new Error(`Bad timespan "${s}"`);
    return { start, end, iso: `${new Date(start).toISOString()}/${new Date(end).toISOString()}`, label: null };
  }
  const ms = durationMs(s);
  if (!ms) throw new Error(`Bad timespan "${s}": use an ISO 8601 duration like PT6H, P1D, P7D or "<start>/<end>"`);
  const end = Date.now();
  return { start: end - ms, end, iso: s.toUpperCase(), label: `Last ${humanDur(ms)}` };
}
function humanDur(ms) {
  const h = ms / 3600_000;
  if (h < 1) return `${Math.round(ms / 60_000)} minutes`;
  if (h < 48 && h % 24) return `${+h.toFixed(1)} hours`;
  const d = h / 24;
  return d === 1 ? '24 hours' : `${+d.toFixed(1)} days`;
}
const GRAINS = [['PT1M', 60e3], ['PT5M', 300e3], ['PT15M', 900e3], ['PT30M', 1800e3], ['PT1H', 3600e3], ['PT6H', 21600e3], ['PT12H', 43200e3], ['P1D', 86400e3]];
/** Like the portal's "Automatic" grain: about 100–750 points. */
function autoInterval(spanMs) {
  return (GRAINS.find(([, ms]) => spanMs / ms <= 750) || GRAINS.at(-1))[0];
}
const grainLabel = (g) => ({ PT1M: '1 minute', PT5M: '5 minutes', PT15M: '15 minutes', PT30M: '30 minutes', PT1H: '1 hour', PT6H: '6 hours', PT12H: '12 hours', P1D: '1 day' })[g] || g;

// ---------- Which tenant signs the request ----------
function scope(resource, { org, env, tenant } = {}) {
  const sub = resource.match(/\/subscriptions\/([0-9a-f-]{36})/i)?.[1];
  if (!sub) throw new Error(`Not a full Azure resource ID: "${resource}". Use /subscriptions/<id>/resourceGroups/<rg>/providers/... (find it with azure_cli resource list).`);
  const owner = azure.profileForSubscription(sub) || (org ? azure.profile(org) : null);
  const ownerEnv = owner && Object.entries(owner.subscriptions || {}).find(([, s]) => s.toLowerCase() === sub.toLowerCase())?.[0];
  const tenantId = owner?.tenantId || tenant;
  if (!tenantId) throw new Error(`Subscription ${sub} doesn't belong to a configured client: pass org, or add it in Settings > Clients.`);
  return { tenantId, owner, env: ownerEnv || env || 'prod', sub };
}

async function call(sc, resource, url, init = {}) {
  let token;
  try { token = await azure.accessToken(sc.tenantId, resource); } catch (e) {
    if (azure.isAuthError(e.message) || /get-access-token/.test(e.message)) throw azure.chartSignInError(e.message, sc.owner, sc.env);
    throw e;
  }
  const res = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) }, signal: AbortSignal.timeout(120_000) });
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = { message: text.slice(0, 500) }; }
  if (!res.ok) {
    const err = body.error || body;
    const inner = err.innererror || err.details?.[0]?.innererror || err.details?.[0];
    const msg = [err.message, inner?.message, inner?.innererror?.message].filter(Boolean).join(' — ');
    if (res.status === 401) throw azure.chartSignInError(msg || 'Unauthorized', sc.owner, sc.env);
    throw new Error(`Azure ${res.status}: ${msg || res.statusText}`);
  }
  return body;
}

// ---------- Portal links ----------
const AGG_ENUM = { 1: 'Total', 2: 'Minimum', 3: 'Maximum', 4: 'Average', 7: 'Count' };
/** Read a portal Logs or Metrics link into azure_chart arguments. */
export function parsePortalUrl(url) {
  const u = String(url).trim();
  const hash = u.includes('#') ? u.slice(u.indexOf('#') + 1) : u;
  const segs = hash.split('/');
  const get = (k) => { const i = segs.findIndex((s) => s.toLowerCase() === k.toLowerCase()); return i >= 0 && segs[i + 1] != null ? decodeURIComponent(segs[i + 1]) : null; };
  const tenant = hash.match(/^@([0-9a-f-]{36})\b/i)?.[1] || null;
  const chartDef = get('ChartDefinition');
  if (chartDef) {
    const def = JSON.parse(chartDef);
    const chart = def.v2charts?.[0] || def.charts?.[0];
    if (!chart?.metrics?.length) throw new Error('The Metrics link has no metrics in it');
    const tc = JSON.parse(get('TimeContext') || '{}');
    let timespan = 'P1D';
    if (tc.relative?.duration) timespan = `PT${Math.round(tc.relative.duration / 60_000)}M`;
    else if (tc.absolute?.startTime) timespan = `${tc.absolute.startTime}/${tc.absolute.endTime}`;
    const filters = (chart.filterCollection?.filters || []).filter((f) => f.key && f.values?.length)
      .map((f) => `(${f.values.map((v) => `${f.key} ${f.operator === 1 ? 'ne' : 'eq'} '${String(v).replace(/'/g, "''")}'`).join(f.operator === 1 ? ' and ' : ' or ')})`);
    if (chart.grouping?.dimension) filters.push(`${chart.grouping.dimension} eq '*'`);
    return {
      kind: 'metrics', tenant, timespan,
      resource: chart.metrics[0].resourceMetadata?.id || get('ResourceId'),
      title: chart.title || null,
      metrics: chart.metrics.map((m) => ({ name: m.name, aggregation: AGG_ENUM[m.aggregationType] || 'Average', namespace: m.namespace, resource: m.resourceMetadata?.id, label: m.metricVisualization?.displayName })),
      filter: filters.join(' and ') || undefined,
      top: chart.grouping?.top || undefined,
    };
  }
  const rid = get('resourceId');
  if (!rid) throw new Error('Not a portal Logs or Metrics link (no resourceId / ChartDefinition in it)');
  let query = get('query');
  const q = get('q');
  if (!query && q) {
    const buf = Buffer.from(q, 'base64');
    try { query = zlib.gunzipSync(buf).toString('utf8'); } catch {
      // a link cut short or retyped: take what inflates
      query = zlib.gunzipSync(buf, { finishFlush: zlib.constants.Z_SYNC_FLUSH }).toString('utf8');
    }
  }
  if (!query) throw new Error('The Logs link has no query in it');
  return { kind: 'logs', tenant, resource: rid, query, timespan: get('timespan') || undefined };
}

// ---------- Logs (KQL) ----------
const NUMERIC = new Set(['int', 'long', 'real', 'decimal', 'double', 'timespan']);
async function runLogs(a, sc) {
  const ts = parseTimespan(a.timespan || 'P1D');
  const body = await call(sc, LOGS, `${LOGS}/v1${a.resource}/query`, { method: 'POST', body: JSON.stringify({ query: a.query, timespan: ts.iso }) });
  const t = body.tables?.find((x) => x.name === 'PrimaryResult') || body.tables?.[0];
  if (!t) throw new Error('The query returned no table');
  const columns = t.columns.map((c) => ({ name: c.name, type: c.type || c.columnType }));
  const total = t.rows.length;
  const rows = t.rows.slice(0, MAX_ROWS).map((r) => r.map((v, i) => (columns[i].type === 'timespan' && typeof v === 'string' ? tsToMs(v) : v)));
  for (const c of columns) if (c.type === 'timespan') { c.type = 'real'; c.unit = 'Milliseconds'; }
  const out = { kind: 'logs', query: a.query, timespan: ts, table: { columns, rows, total }, series: [] };
  // Chart: x = a datetime column, y = numeric columns, split by a string column (auto or as asked)
  const want = a.chart || 'auto';
  if (want !== 'table') {
    const idx = (n) => columns.findIndex((c) => c.name === n);
    const xi = a.x ? idx(a.x) : columns.findIndex((c) => c.type === 'datetime');
    let yi = (a.y?.length ? a.y.map(idx) : columns.map((c, i) => (NUMERIC.has(c.type) && i !== xi ? i : -1))).filter((i) => i >= 0);
    const si = a.split ? idx(a.split) : columns.findIndex((c, i) => c.type === 'string' && i !== xi);
    if (xi >= 0 && columns[xi].type === 'datetime' && yi.length && total <= MAX_ROWS) {
      const groups = new Map();
      for (const r of rows) {
        const t0 = Date.parse(r[xi]);
        if (!Number.isFinite(t0)) continue;
        for (const y of yi) {
          const name = si >= 0 && (a.split || yi.length === 1) ? `${r[si] ?? '(empty)'}${yi.length > 1 ? ` · ${columns[y].name}` : ''}` : columns[y].name;
          if (!groups.has(name)) groups.set(name, { name, unit: columns[y].unit || null, aggregation: null, points: [] });
          groups.get(name).points.push([t0, r[y] == null ? null : Number(r[y])]);
        }
      }
      out.series = [...groups.values()].map((s) => ({ ...s, points: s.points.sort((p, q) => p[0] - q[0]) }));
      out.view = 'line';
    } else if (xi < 0 && yi.length && si >= 0 && want !== 'line') {
      out.bars = rows.slice(0, 30).map((r) => ({ label: String(r[si] ?? '(empty)'), value: Number(r[yi[0]]) || 0 }));
      out.barLabel = columns[yi[0]].name;
      out.view = 'bar';
    }
  }
  out.view ||= 'table';
  return out;
}
function tsToMs(v) { // KQL timespan "1.02:03:04.5" → ms
  const m = String(v).match(/^(-)?(?:(\d+)\.)?(\d+):(\d+):(\d+(?:\.\d+)?)$/);
  if (!m) return v;
  return (m[1] ? -1 : 1) * (((+m[2] || 0) * 86400 + +m[3] * 3600 + +m[4] * 60 + +m[5]) * 1000);
}

// ---------- Metrics ----------
const AGG_FIELD = { Average: 'average', Total: 'total', Maximum: 'maximum', Minimum: 'minimum', Count: 'count' };
async function runMetrics(a, sc) {
  const ts = parseTimespan(a.timespan || 'P1D');
  const interval = !a.interval || a.interval === 'auto' ? autoInterval(ts.end - ts.start) : a.interval;
  const series = [];
  let resolved = null;
  for (const m of a.metrics) {
    const agg = Object.keys(AGG_FIELD).find((k) => k.toLowerCase() === String(m.aggregation || 'Average').toLowerCase().replace(/^avg$/, 'average').replace(/^sum$/, 'total').replace(/^max$/, 'maximum').replace(/^min$/, 'minimum')) || 'Average';
    const res = m.resource || a.resource;
    const qs = new URLSearchParams({ 'api-version': '2023-10-01', metricnames: m.name, aggregation: agg, timespan: ts.label ? `${new Date(ts.start).toISOString()}/${new Date(ts.end).toISOString()}` : ts.iso, interval });
    if (m.namespace) qs.set('metricnamespace', m.namespace);
    if (a.filter) { qs.set('$filter', a.filter); qs.set('top', String(a.top || 10)); }
    const url = `${ARM}${res}/providers/Microsoft.Insights/metrics?`;
    // The legend shows the value over the whole range, as the portal does (one "FULL" bucket):
    // an average of 15-minute averages is not the real average.
    const full = new URLSearchParams(qs); full.set('interval', 'FULL');
    const [body, whole] = await Promise.all([call(sc, ARM, url + qs), call(sc, ARM, url + full).catch(() => null)]);
    const overall = new Map((whole?.value || []).flatMap((v) => (v.timeseries || []).map((t) => [(t.metadatavalues || []).map((d) => d.value).join('|'), t.data?.[0]?.[AGG_FIELD[agg]] ?? null])));
    resolved = body.interval || interval;
    for (const v of body.value || []) {
      for (const tsr of v.timeseries || []) {
        const dims = (tsr.metadatavalues || []).map((d) => d.value).filter((x) => x !== '').join(', ');
        const base = m.label || v.name?.localizedValue || m.name;
        series.push({
          name: `${base}${dims ? ` (${dims})` : ''}`, unit: v.unit || null, aggregation: agg,
          resource: res === a.resource ? null : res.split('/').pop(),
          overall: overall.get((tsr.metadatavalues || []).map((d) => d.value).join('|')) ?? null,
          points: (tsr.data || []).map((d) => [Date.parse(d.timeStamp), d[AGG_FIELD[agg]] ?? (agg === 'Total' || agg === 'Count' ? 0 : null)]),
        });
      }
    }
  }
  const table = {
    columns: [{ name: 'timestamp', type: 'datetime' }, ...series.map((s) => ({ name: s.name, type: 'real', unit: s.unit }))],
    rows: [], total: 0,
  };
  const times = [...new Set(series.flatMap((s) => s.points.map((p) => p[0])))].sort((x, y) => x - y);
  const lookup = series.map((s) => new Map(s.points));
  table.rows = times.map((t) => [new Date(t).toISOString(), ...lookup.map((l) => l.get(t) ?? null)]);
  table.total = table.rows.length;
  return { kind: 'metrics', metrics: a.metrics, filter: a.filter || null, timespan: ts, interval: resolved, series, table, view: 'line' };
}

// ---------- Summary for the model (the card shows the full data) ----------
const round = (v) => (v == null ? v : Math.abs(v) >= 100 ? Math.round(v) : +v.toPrecision(4));
function seriesStats(s) {
  const pts = s.points.filter((p) => p[1] != null);
  if (!pts.length) return { name: s.name, points: 0 };
  let min = pts[0], max = pts[0], sum = 0;
  for (const p of pts) { if (p[1] < min[1]) min = p; if (p[1] > max[1]) max = p; sum += p[1]; }
  const avg = sum / pts.length;
  // spikes: points above avg + 3·stdev (top 5)
  const sd = Math.sqrt(pts.reduce((a, p) => a + (p[1] - avg) ** 2, 0) / pts.length);
  const spikes = sd ? pts.filter((p) => p[1] > avg + 3 * sd).sort((a, b) => b[1] - a[1]).slice(0, 5).map((p) => ({ at: new Date(p[0]).toISOString(), value: round(p[1]) })) : [];
  return {
    name: s.name, unit: s.unit || undefined, aggregation: s.aggregation || undefined, points: pts.length,
    ...(s.overall != null ? { overall: round(s.overall), overallNote: `${s.aggregation} over the whole range (the portal legend value)` } : {}),
    avg: round(avg), total: round(sum), min: { at: new Date(min[0]).toISOString(), value: round(min[1]) }, max: { at: new Date(max[0]).toISOString(), value: round(max[1]) },
    first: round(pts[0][1]), last: { at: new Date(pts.at(-1)[0]).toISOString(), value: round(pts.at(-1)[1]) }, spikes,
  };
}
function summary(c) {
  const head = { chartId: c.id, title: c.title, resource: c.resource, timespan: c.timespan.iso, from: new Date(c.timespan.start).toISOString(), to: new Date(c.timespan.end).toISOString(), view: c.view };
  if (c.interval) head.interval = c.interval;
  const t = c.table;
  const sample = t.rows.slice(0, c.view === 'table' ? 40 : 10).map((r) => r.map((v) => (typeof v === 'string' && v.length > 300 ? `${v.slice(0, 300)}…` : v)));
  return {
    ...head,
    ...(c.series.length ? { series: c.series.map(seriesStats), seriesDropped: c.seriesDropped || 0 } : {}),
    ...(c.bars ? { bars: c.bars } : {}),
    columns: t.columns.map((x) => `${x.name}:${x.type}`), rowCount: t.total, rowsShown: t.rows.length,
    firstRows: sample,
  };
}

// ---------- Entry point ----------
export async function run(input) {
  let a = { ...input };
  if (a.portalUrl) {
    const p = parsePortalUrl(a.portalUrl);
    a = { ...p, ...Object.fromEntries(Object.entries(a).filter(([, v]) => v != null && v !== '')), kind: a.kind || p.kind };
  }
  if (!a.resource) throw new Error('Pass resource (a full Azure resource ID) or portalUrl');
  a.resource = a.resource.replace(/\/+$/, '');
  if (a.kind === 'metrics' && !a.metrics?.length) throw new Error('Pass metrics: [{ name, aggregation }] (names as in az monitor metrics list-definitions)');
  if (a.kind !== 'metrics' && !a.query) throw new Error('Pass query (KQL) for a logs chart');
  const sc = scope(a.resource, a);
  const data = a.kind === 'metrics' ? await runMetrics(a, sc) : await runLogs(a, sc);
  // Keep the largest series when there are too many lines to read
  if (data.series.length > MAX_SERIES) {
    const size = (s) => s.points.reduce((x, p) => x + Math.abs(p[1] || 0), 0);
    const keep = [...data.series].sort((x, y) => size(y) - size(x)).slice(0, MAX_SERIES);
    data.seriesDropped = data.series.length - keep.length;
    data.series = data.series.filter((s) => keep.includes(s));
  }
  const name = a.resource.split('/').pop();
  const chart = {
    id: randomBytes(6).toString('hex'), createdAt: new Date().toISOString(),
    title: a.title || (a.kind === 'metrics' ? `${a.metrics.map((m) => `${m.aggregation || 'Avg'} ${m.label || m.name}`).join(' and ')} for ${name}` : `Logs: ${name}`),
    resource: a.resource, resourceName: name, portalUrl: a.portalUrl || null,
    ...data,
    intervalLabel: data.interval ? grainLabel(data.interval) : null,
    view: a.chart && a.chart !== 'auto' && (a.chart !== 'line' || data.series.length) ? a.chart : data.view,
  };
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, `${chart.id}.json`), JSON.stringify(chart));
  return { chart, summary: summary(chart) };
}

export function get(id) {
  if (!ID.test(id)) throw new Error('Bad chart id');
  try { return JSON.parse(fs.readFileSync(path.join(DIR, `${id}.json`), 'utf8')); } catch { const e = new Error('Chart not found'); e.status = 404; throw e; }
}
