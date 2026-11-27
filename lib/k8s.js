// Read-only access to the Dataweavers Solr SaaS clusters (AKS) through the user's own kubectl and
// ~/.kube/config (the same file Lens uses). One namespace per Solr instance, named with a hash; the
// customer is the namespace label dw-id = <client>-sc-<product>-<version>-<env>[-<suffix>].
// The assistant can only list, read status and read logs. Port-forwarding to the Solr dashboard is
// started only by the user, from a card (see the /api/k8s/forward routes).
import net from 'node:net';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { config, orgCode } from './config.js';
import { bus } from './db.js';

const exec = promisify(execFile);
const kubectlBin = () => config.get('workspace').kubectlPath || 'kubectl';
// The only kubectl verbs this module ever runs. port-forward only from startForward (user click).
const READ_VERBS = new Set(['get', 'logs', 'config', 'top']);

async function kubectl(args, { timeout = 30_000 } = {}) {
  // The verb is the first argument that is neither a flag nor the value of --context / -n.
  let verb = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--context' || args[i] === '-n') { i++; continue; }
    if (!args[i].startsWith('-')) { verb = args[i]; break; }
  }
  if (!READ_VERBS.has(verb)) throw new Error(`kubectl ${verb} is not allowed here (read-only).`);
  try {
    const { stdout } = await exec(kubectlBin(), args, { timeout, maxBuffer: 50 * 1024 * 1024, windowsHide: true });
    return stdout;
  } catch (e) {
    if (e.code === 'ENOENT') throw new Error('kubectl not found. Install it or set "kubectlPath" in config/workspace.json.');
    const msg = String(e.stderr || e.message).trim().split('\n').filter(Boolean).slice(-2).join(' ');
    if (/logged in|Unauthorized|certificate.*expired|x509/i.test(msg)) throw new Error(`${msg} (the cluster credentials in ~/.kube/config may have expired: refresh them with az aks get-credentials)`);
    throw new Error(msg || 'kubectl failed');
  }
}
const kjson = async (args, o) => JSON.parse(await kubectl([...args, '-o', 'json'], o));

// ---------- Clusters ----------
/** kubeconfig contexts of the Solr clusters: workspace.solrContexts if set, else every dw-aks-*solr* context. */
export async function contexts() {
  const own = config.get('workspace').solrContexts;
  const names = Array.isArray(own) && own.length ? own
    : (await kubectl(['config', 'get-contexts', '-o', 'name'])).split(/\r?\n/).map((s) => s.trim()).filter((n) => /^dw-aks-.*solr/i.test(n));
  return names.map(describeContext);
}

function describeContext(name) {
  const n = name.toLowerCase();
  const region = /australia|aueast|ause/.test(n) ? 'AU' : /eastus|useast|westus|uswest|centralus/.test(n) ? 'US' : /uk|europe|westeu|northeu/.test(n) ? 'UK/EU' : '?';
  // NonProd clusters carry -np-. A cluster without a NonProd twin in its region (UK today) holds both.
  const nonProd = /(^|-)np(-|$)/.test(n);
  return { context: name, region, cluster: nonProd ? 'NonProd' : 'Prod' };
}

// ---------- Instances (namespaces) ----------
/** dw-id → its parts, e.g. tmca-sc-xm-103-p-lex → { client: tmca, product: xm, version: 10.3, env: p, suffix: lex }. */
export function parseDwId(id) {
  const m = String(id || '').match(/^([a-z0-9]+)-sc-([a-z]+)-(\d+)-([a-z]+\d*)(?:-(.+))?$/i);
  if (!m) return { client: String(id || '').split('-')[0] || null };
  const v = m[3];
  return { client: m[1].toLowerCase(), product: m[2].toLowerCase(), version: v.length > 1 ? `${v.slice(0, -1)}.${v.slice(-1)}` : v, env: m[4].toLowerCase(), suffix: m[5] || null };
}

/** Prod / PreProd / NonProd: a p-code on a NonProd cluster is PreProd; on a mixed cluster (no -np-) only p-codes are Prod. */
function envType(ctx, env) {
  const isP = /^p\d*$/.test(env || '');
  if (ctx.cluster === 'NonProd') return isP ? 'PreProd' : 'NonProd';
  return isP ? 'Prod' : 'NonProd';
}

let cache = { at: 0, list: [], errors: [] };
const CACHE_MS = 5 * 60_000;

async function allInstances(fresh = false) {
  if (!fresh && Date.now() - cache.at < CACHE_MS && cache.list.length) return cache;
  const ctxs = await contexts();
  const list = [];
  const errors = [];
  await Promise.all(ctxs.map(async (c) => {
    try {
      const r = await kjson(['--context', c.context, 'get', 'namespaces', '-l', 'dw-id', '--request-timeout=20s']);
      for (const ns of r.items || []) {
        const dwId = ns.metadata.labels['dw-id'];
        const p = parseDwId(dwId);
        list.push({
          dwId, namespace: ns.metadata.name, context: c.context, region: c.region, cluster: c.cluster,
          environment: envType(c, p.env), org: p.client ? orgCode(p.client.toUpperCase()) : null,
          ...p, created: ns.metadata.creationTimestamp, phase: ns.status?.phase,
        });
      }
    } catch (e) { errors.push({ context: c.context, error: e.message }); }
  }));
  list.sort((a, b) => a.dwId.localeCompare(b.dwId));
  cache = { at: Date.now(), list, errors };
  return cache;
}

/** Customer Solr instances across every cluster. client: dw-id prefix (tmca) or mon.ai client code / alias (Toyota). */
export async function instances({ client, search, fresh } = {}) {
  const { list, errors } = await allInstances(fresh);
  let out = list;
  if (client) {
    const want = String(client).toLowerCase();
    const code = orgCode(client).toLowerCase();
    out = out.filter((i) => i.client === want || (i.org || '').toLowerCase() === code || (i.org || '').toLowerCase() === want);
  }
  if (search) { const q = String(search).toLowerCase(); out = out.filter((i) => `${i.dwId} ${i.namespace} ${i.context}`.toLowerCase().includes(q)); }
  return { count: out.length, instances: out, ...(errors.length ? { unreachableClusters: errors } : {}) };
}

/** One instance from a dw-id, a namespace, or "context/namespace". */
export async function resolve(ref) {
  const r = String(ref || '').trim();
  if (!r) throw new Error('Give the instance: its dw-id (e.g. acu-sc-xp-104-p1) or namespace.');
  const find = (list) => {
    if (r.includes('/')) { const [c, n] = r.split('/'); return list.filter((i) => i.context === c && i.namespace === n); }
    return list.filter((i) => i.dwId.toLowerCase() === r.toLowerCase() || i.namespace === r);
  };
  let hits = find((await allInstances()).list);
  if (!hits.length) hits = find((await allInstances(true)).list);
  if (!hits.length) throw new Error(`No Solr instance "${r}". List them with solr_instances.`);
  if (hits.length > 1) throw new Error(`"${r}" matches ${hits.length} instances (${hits.map((h) => `${h.context}/${h.namespace}`).join(', ')}): pass context/namespace.`);
  return hits[0];
}

// ---------- Health ----------
const age = (ts) => {
  if (!ts) return null;
  const m = Math.round((Date.now() - new Date(ts)) / 60_000);
  return m < 120 ? `${m}m` : m < 2880 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
};

function podSummary(p) {
  const cs = p.status?.containerStatuses || [];
  const restarts = cs.reduce((n, c) => n + (c.restartCount || 0), 0);
  const last = cs.map((c) => c.lastState?.terminated).filter(Boolean).sort((a, b) => new Date(b.finishedAt) - new Date(a.finishedAt))[0];
  const waiting = cs.map((c) => c.state?.waiting).find(Boolean);
  return {
    pod: p.metadata.name,
    role: /solrcloud-\d+$/.test(p.metadata.name) ? 'solr' : /zookeeper-\d+$/.test(p.metadata.name) ? 'zookeeper' : /solr-operator/.test(p.metadata.name) ? 'operator' : /ingress/.test(p.metadata.name) ? 'ingress' : 'other',
    phase: p.status?.phase,
    ready: `${cs.filter((c) => c.ready).length}/${cs.length}`,
    restarts,
    ...(waiting ? { waiting: `${waiting.reason}${waiting.message ? `: ${waiting.message.slice(0, 200)}` : ''}` } : {}),
    ...(last ? { lastRestart: { reason: last.reason, exitCode: last.exitCode, at: last.finishedAt, ago: age(last.finishedAt) } } : {}),
    started: p.status?.startTime, age: age(p.status?.startTime), node: p.spec?.nodeName,
  };
}

/** Pods, the SolrCloud resource, warning events and CPU/memory of one instance, plus a verdict. */
export async function health(ref) {
  const inst = await resolve(ref);
  const base = ['--context', inst.context, '-n', inst.namespace];
  const [pods, solr, events, top] = await Promise.all([
    kjson([...base, 'get', 'pods']),
    kjson([...base, 'get', 'solrclouds']).catch((e) => ({ error: e.message })),
    kjson([...base, 'get', 'events', '--field-selector', 'type=Warning']).catch(() => ({ items: [] })),
    kubectl([...base, 'top', 'pods', '--no-headers']).catch(() => ''),
  ]);
  const usage = Object.fromEntries(top.split(/\r?\n/).filter(Boolean).map((l) => { const [n, cpu, mem] = l.trim().split(/\s+/); return [n, { cpu, memory: mem }]; }));
  const podList = (pods.items || []).map((p) => ({ ...podSummary(p), ...(usage[p.metadata.name] || {}) }));
  const sc = (solr.items || []).map((s) => ({
    name: s.metadata.name, version: s.status?.version || s.spec?.solrImage?.tag, replicas: s.spec?.replicas,
    readyReplicas: s.status?.readyReplicas, upToDateNodes: s.status?.upToDateNodes,
    auth: s.spec?.solrSecurity?.authenticationType || 'none',
    heap: s.spec?.solrJavaMem, resources: s.spec?.customSolrKubeOptions?.podOptions?.resources,
    zookeeper: s.status?.zookeeperConnectionInfo?.internalConnectionString,
  }));
  const ev = (events.items || [])
    .sort((a, b) => new Date(b.lastTimestamp || b.eventTime || 0) - new Date(a.lastTimestamp || a.eventTime || 0))
    .slice(0, 25)
    .map((e) => ({ at: e.lastTimestamp || e.eventTime, ago: age(e.lastTimestamp || e.eventTime), object: `${e.involvedObject?.kind}/${e.involvedObject?.name}`, reason: e.reason, count: e.count, message: String(e.message || '').slice(0, 300) }));
  const bad = podList.filter((p) => p.phase !== 'Running' || p.ready.split('/')[0] !== p.ready.split('/')[1]);
  const recent = podList.filter((p) => p.lastRestart && Date.now() - new Date(p.lastRestart.at) < 24 * 3600_000);
  const solrDown = sc.some((s) => s.readyReplicas < s.replicas);
  const verdict = bad.length || solrDown ? 'unhealthy' : recent.length || ev.length ? 'check' : 'healthy';
  return {
    instance: inst, verdict,
    notes: [
      ...bad.map((p) => `${p.pod} is ${p.phase}, ready ${p.ready}${p.waiting ? ` (${p.waiting})` : ''}`),
      ...recent.map((p) => `${p.pod} restarted ${p.lastRestart.ago} ago (${p.lastRestart.reason}, exit ${p.lastRestart.exitCode})`),
      ...(solrDown ? sc.map((s) => `SolrCloud ${s.name}: ${s.readyReplicas}/${s.replicas} replicas ready`) : []),
      ...(ev.length ? [`${ev.length} warning event${ev.length === 1 ? '' : 's'} (Kubernetes keeps about 1 hour)`] : []),
    ],
    solrCloud: sc, pods: podList, warningEvents: ev,
    ...(top ? {} : { usageNote: 'kubectl top returned nothing (metrics-server unavailable or no access)' }),
  };
}

// ---------- Logs ----------
const LINE_START = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/;
const LEVEL = /^\S+ \S+ (ERROR|WARN|INFO|DEBUG|TRACE)\b/;
const TAGS = /\[c:(\S+?)\s+s:(\S+?)\s+r:(\S+?)\s+x:(\S+?)\]/;
/** Same message → same key: drop the timestamp, thread and numbers so repeats group together. */
const msgKey = (l) => l.replace(LINE_START, '').replace(/\([^)]*\)/, '').replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().slice(0, 220);

/**
 * Solr log entries of an instance's Solr pods (container solrcloud-node), ERROR and WARN by default,
 * with stack traces kept (first lines) and repeats grouped with a count, newest last.
 */
export async function logs(ref, { pod, hours = 24, levels = ['ERROR', 'WARN'], grep, limit = 150, previous = false } = {}) {
  const inst = await resolve(ref);
  const base = ['--context', inst.context, '-n', inst.namespace];
  const h = Math.min(Math.max(Number(hours) || 24, 0.25), 24 * 14);
  let pods = pod ? [pod] : (await kjson([...base, 'get', 'pods'])).items.map((p) => p.metadata.name).filter((n) => /solrcloud-\d+$/.test(n));
  if (!pods.length) throw new Error(`No Solr pods in ${inst.namespace}.`);
  pods = pods.slice(0, 6);
  const want = new Set((levels || []).map((x) => String(x).toUpperCase()));
  let re = null;
  if (grep) { try { re = new RegExp(grep, 'i'); } catch { re = new RegExp(String(grep).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); } }
  const max = Math.min(Math.max(Number(limit) || 150, 10), 500);

  const perPod = await Promise.all(pods.map(async (p) => {
    let raw;
    try {
      raw = await kubectl([...base, 'logs', p, '-c', 'solrcloud-node', `--since=${Math.round(h * 60)}m`, '--tail=200000', ...(previous ? ['--previous'] : [])], { timeout: 90_000 });
    } catch (e) { return { pod: p, error: e.message }; }
    // Entries: a dated line plus its continuation lines (stack trace, "Caused by").
    const entries = [];
    let total = 0;
    for (const line of raw.split(/\r?\n/)) {
      if (LINE_START.test(line)) { total++; entries.push({ head: line, more: [] }); }
      else if (line.trim() && entries.length) { const m = entries.at(-1).more; if (m.length < 12) m.push(line); }
    }
    const counts = {};
    const groups = new Map();
    const collections = {};
    for (const e of entries) {
      const lvl = e.head.match(LEVEL)?.[1] || 'OTHER';
      counts[lvl] = (counts[lvl] || 0) + 1;
      if (want.size && !want.has(lvl)) continue;
      const all = [e.head, ...e.more].join('\n');
      if (re && !re.test(all)) continue;
      const tags = e.head.match(TAGS);
      if (tags) collections[tags[1]] = (collections[tags[1]] || 0) + 1;
      const k = `${lvl} ${msgKey(e.head)}`;
      const g = groups.get(k);
      const at = e.head.slice(0, 23);
      if (g) { g.count++; g.last = at; } else {
        groups.set(k, {
          level: lvl, first: at, last: at, count: 1, collection: tags?.[1] || null, core: tags?.[4] || null,
          message: e.head.replace(LINE_START, '').replace(/^\.\d+\s+\S+\s+\([^)]*\)\s*/, '').replace(/^\s*\[[^\]]*\]\s*/, '').slice(0, 600),
          ...(e.more.length ? { detail: e.more.map((l) => l.slice(0, 300)).join('\n') } : {}),
        });
      }
    }
    const list = [...groups.values()].sort((a, b) => a.last.localeCompare(b.last));
    return { pod: p, linesRead: total, byLevel: counts, matching: list.reduce((n, g) => n + g.count, 0), byCollection: collections, entries: list.slice(-max), ...(list.length > max ? { omitted: `${list.length - max} older distinct messages not shown` } : {}) };
  }));
  return {
    instance: { dwId: inst.dwId, namespace: inst.namespace, context: inst.context, environment: inst.environment },
    window: `last ${h}h${previous ? ' (previous container, i.e. before the last restart)' : ''}`,
    filter: { levels: [...want], ...(grep ? { grep } : {}) },
    note: 'Times are UTC as Solr logs them. Logs only go back to the last pod restart (pass previous: true for the container before it).',
    pods: perPod,
  };
}

// ---------- Port-forward to the Solr dashboard (user-started only) ----------
const forwards = new Map(); // id -> { id, dwId, namespace, context, port, url, startedAt, child }
const FORWARD_MAX_MS = 4 * 3600_000;

function freePort(start = 8983) {
  return new Promise((resolveP, reject) => {
    const tryPort = (p) => {
      if (p > start + 200) return reject(new Error('No free local port found.'));
      const s = net.createServer();
      s.once('error', () => tryPort(p + 1));
      s.once('listening', () => s.close(() => resolveP(p)));
      s.listen(p, '127.0.0.1');
    };
    tryPort(start);
  });
}

const publicForward = (f) => ({ id: f.id, dwId: f.dwId, namespace: f.namespace, context: f.context, environment: f.environment, port: f.port, url: f.url, startedAt: f.startedAt, endsAt: f.endsAt });

export function listForwards() { return [...forwards.values()].map(publicForward); }

/** Starts kubectl port-forward to the instance's Solr service on 127.0.0.1. Called only from the user's click. */
export async function startForward(ref) {
  const inst = await resolve(ref);
  const existing = [...forwards.values()].find((f) => f.context === inst.context && f.namespace === inst.namespace);
  if (existing) return publicForward(existing);
  const base = ['--context', inst.context, '-n', inst.namespace];
  const svcs = (await kjson([...base, 'get', 'services'])).items.map((s) => s.metadata.name);
  const svc = svcs.find((s) => s === `${inst.namespace}-solrcloud-common`) || svcs.find((s) => /solrcloud-common$/.test(s));
  if (!svc) throw new Error(`No solrcloud-common service in ${inst.namespace}.`);
  const port = await freePort();
  const child = spawn(kubectlBin(), [...base, 'port-forward', `svc/${svc}`, `${port}:80`, '--address', '127.0.0.1'], { windowsHide: true });
  const id = randomUUID().slice(0, 8);
  const f = { id, dwId: inst.dwId, namespace: inst.namespace, context: inst.context, environment: inst.environment, port, url: `http://localhost:${port}/solr/`, startedAt: new Date().toISOString(), endsAt: new Date(Date.now() + FORWARD_MAX_MS).toISOString(), child };
  await new Promise((ok, fail) => {
    let err = '';
    const timer = setTimeout(() => { child.kill(); fail(new Error(`port-forward did not start within 20s${err ? `: ${err.trim()}` : ''}`)); }, 20_000);
    child.stdout.on('data', (d) => { if (/Forwarding from/.test(String(d))) { clearTimeout(timer); ok(); } });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); fail(e.code === 'ENOENT' ? new Error('kubectl not found.') : e); });
    child.on('exit', (code) => { clearTimeout(timer); fail(new Error(`port-forward exited (${code})${err ? `: ${err.trim().split('\n').at(-1)}` : ''}`)); });
  });
  child.removeAllListeners('exit');
  child.on('exit', () => { if (forwards.delete(id)) bus.emit('event', { type: 'k8s:forwards', data: listForwards() }); });
  f.timer = setTimeout(() => stopForward(id), FORWARD_MAX_MS);
  forwards.set(id, f);
  bus.emit('event', { type: 'k8s:forwards', data: listForwards() });
  return publicForward(f);
}

export function stopForward(id) {
  const f = forwards.get(id);
  if (!f) return { stopped: false };
  clearTimeout(f.timer);
  forwards.delete(id);
  try { f.child.kill(); } catch { /* already gone */ }
  bus.emit('event', { type: 'k8s:forwards', data: listForwards() });
  return { stopped: true, id };
}

export function stopAllForwards() { for (const id of [...forwards.keys()]) stopForward(id); }
process.on('exit', stopAllForwards);
