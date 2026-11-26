// mon.ai: local-only AI ops assistant.
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { config, orgCode, zoneClient } from './lib/config.js';
import { db, bus, kv } from './lib/db.js';
import * as zendesk from './lib/zendesk.js';
import * as cloudflare from './lib/cloudflare.js';
import * as azure from './lib/azure.js';
import * as git from './lib/git.js';
import * as assistant from './lib/assistant.js';
import * as usage from './lib/usage.js';
import * as skills from './lib/skills.js';
import * as uploads from './lib/uploads.js';
import * as notify from './lib/notify.js';

const PORT = Number(process.env.PORT || 80);
const HOST = process.env.HOST || '127.0.0.1'; // loopback only, never exposed to the network
const ALLOWED_HOSTS = new Set(['mon.ai', 'localhost', '127.0.0.1', ...(process.env.EXTRA_HOSTS || '').split(',').filter(Boolean)]);

const app = express();
app.disable('x-powered-by');

// DNS-rebinding / cross-site protection: only answer to our own host names,
// and require JSON for anything that changes state (blocks simple-form CSRF).
app.use((req, res, next) => {
  const host = (req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
  if (!ALLOWED_HOSTS.has(host)) return res.status(421).send('Unknown host');
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    // Cross-site requests are refused outright; browsers send Origin / Sec-Fetch-Site on these.
    const origin = req.headers.origin;
    if (origin && !ALLOWED_HOSTS.has(origin.replace(/^https?:\/\//, '').replace(/:\d+$/, '').toLowerCase())) return res.status(403).json({ error: 'Cross-site request refused' });
    if (req.headers['sec-fetch-site'] === 'cross-site') return res.status(403).json({ error: 'Cross-site request refused' });
    // POST/PUT must be JSON (an HTML form can't send that). DELETE has no body and forms can't send it.
    // Uploads are raw bytes (application/octet-stream, which a cross-site form can't send either).
    const upload = /^\/api\/(sessions\/[^/]+\/uploads|zendesk\/uploads)$/.test(req.path) && req.is('application/octet-stream');
    if (req.method !== 'DELETE' && !upload && !req.is('application/json')) return res.status(415).json({ error: 'JSON only' });
  }
  next();
});
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(import.meta.dirname, 'public')));
// Browser builds of the Markdown renderer and HTML sanitizer, served locally (no CDN).
const vendor = { 'marked.js': 'marked/lib/marked.esm.js', 'purify.js': 'dompurify/dist/purify.es.mjs' };
app.get('/vendor/:file', (req, res) => {
  const rel = vendor[req.params.file];
  if (!rel) return res.status(404).end();
  res.type('application/javascript').sendFile(path.join(import.meta.dirname, 'node_modules', rel));
});

const wrap = (fn) => (req, res) => Promise.resolve().then(() => fn(req, res)).then((r) => { if (!res.headersSent) res.json(r ?? { ok: true }); })
  .catch((e) => res.status(400).json({ error: e.message }));

// ---------- live updates ----------
app.get('/api/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  const send = (e) => res.write(`event: ${e.type}\ndata: ${JSON.stringify(e.data ?? {})}\n\n`);
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  bus.on('event', send);
  req.on('close', () => { clearInterval(ping); bus.off('event', send); });
});
config.on('change', (name) => bus.emit('event', { type: 'config:changed', data: { name } }));

// ---------- overview ----------
app.get('/api/status', wrap(async () => ({
  zendesk: { configured: zendesk.isConfigured(), ...zendesk.state, me: zendesk.state.me ? { id: zendesk.state.me.id, name: zendesk.state.me.name } : null, auth: zendesk.auth.info(), hasSubdomain: !!zendesk.auth.subdomain() },
  cloudflare: { configured: cloudflare.isConfigured() },
  azureProfiles: azure.profiles().length,
  repos: git.list().repos.length,
})));

app.get('/api/orgs', wrap(() => {
  const orgs = new Map();
  const bump = (name, key, n = 1) => {
    if (!orgs.has(name)) orgs.set(name, { org: name, open: 0, attention: 0, sessions: 0, repos: 0, azure: false });
    orgs.get(name)[key] += n;
  };
  for (const r of db.prepare("SELECT org, COUNT(*) n, SUM(CASE WHEN score >= 40 THEN 1 ELSE 0 END) hot FROM tickets WHERE status NOT IN ('solved','closed') AND COALESCE(relation, 'assigned') = 'assigned' GROUP BY org").all()) {
    bump(r.org, 'open', r.n); bump(r.org, 'attention', r.hot);
  }
  for (const r of db.prepare("SELECT org, COUNT(*) n FROM sessions WHERE org != 'All' GROUP BY org").all()) bump(r.org, 'sessions', r.n);
  for (const r of git.list().repos) bump(r.org, 'repos');
  for (const p of azure.profiles()) { bump(p.org, 'open', 0); orgs.get(p.org).azure = true; }
  return [...orgs.values()].sort((a, b) => b.attention - a.attention || b.open - a.open || a.org.localeCompare(b.org));
}));

// ---------- Zendesk ----------
// A ticket whose chat you cooled down (chat ⋯ menu) counts as cooling down until someone else updates it after that.
const CHAT_COOLED = "EXISTS (SELECT 1 FROM sessions s WHERE s.ticket_id = tickets.id AND s.archived_at IS NULL AND s.cooled_at IS NOT NULL AND NOT (tickets.updated_at > s.cooled_at AND tickets.updated_at IS NOT COALESCE(tickets.my_update_at, '')))";
// …and so does a ticket you cooled down from its ticket workspace (⋯ menu) before it had a chat.
const TICKET_COOLED = "(tickets.cooled_at IS NOT NULL AND NOT (tickets.updated_at > tickets.cooled_at AND tickets.updated_at IS NOT COALESCE(tickets.my_update_at, '')))";
app.get('/api/tickets', wrap((req) => {
  const { org, scope = 'open' } = req.query;
  const resolved = scope === 'resolved';
  const where = [scope === 'open' ? "status NOT IN ('solved','closed')" : resolved ? "status IN ('solved','closed')" : '1=1'];
  const args = [];
  if (org) { where.push('org = ?'); args.push(org); }
  return db.prepare(`SELECT id, subject, status, priority, org, org_name, requester, assignee, assignee_id, created_at, updated_at, due_at, sla_breach_at, COALESCE(relation, 'assigned') AS relation, needs_me, needs_me_reason, COALESCE(upvoted, 0) AS upvoted, upvoted_at, ((ignored_mention_at IS NOT NULL AND ((needs_me = 1 AND ignored_mention_at = needs_me_at) OR (COALESCE(relation, 'assigned') = 'unassigned' AND ignored_mention_at = updated_at))) OR ${CHAT_COOLED} OR ${TICKET_COOLED}) AS ignored, (${CHAT_COOLED} OR ${TICKET_COOLED}) AS chat_cooled, score, reasons, url, my_update_at
    FROM tickets WHERE ${where.join(' AND ')} ORDER BY ${resolved ? 'updated_at DESC' : 'COALESCE(upvoted, 0) DESC, score DESC, updated_at DESC'} LIMIT ${resolved ? 200 : 500}`).all(...args)
    .map((t) => ({ ...t, reasons: JSON.parse(t.reasons) }));
}));
// Tickets whose latest change was made by me in the last 24 hours (any status, any relation).
app.get('/api/tickets/updated-by-me', wrap(() => db.prepare(`SELECT id, subject, status, priority, org, org_name, requester, assignee, assignee_id, created_at, updated_at, due_at, sla_breach_at, COALESCE(relation, 'assigned') AS relation, needs_me, needs_me_reason, COALESCE(upvoted, 0) AS upvoted, upvoted_at, 0 AS ignored, score, reasons, url, my_update_at
    FROM tickets WHERE my_update_at IS NOT NULL AND my_update_at > ? ORDER BY my_update_at DESC LIMIT 200`).all(new Date(Date.now() - 864e5).toISOString().replace(/\.\d+Z$/, 'Z'))
  .map((t) => ({ ...t, reasons: JSON.parse(t.reasons) }))));
app.get('/api/tickets/:id', wrap((req) => zendesk.getTicketDetail(Number(req.params.id), { fresh: req.query.fresh === '1' })));
// Zendesk attachment / inline image, fetched with your Zendesk sign-in (Zendesk URLs only).
// Raster images show inline; anything else (SVG, PDF, docs) downloads and never renders on mon.ai.
app.get('/api/zendesk/file', async (req, res) => {
  try {
    const f = await zendesk.fetchFile(String(req.query.u || ''));
    const name = String(req.query.name || 'attachment').replace(/[^\w .()-]+/g, '_').slice(0, 120);
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Cache-Control': 'private, max-age=86400' });
    if (/^image\/(png|jpe?g|gif|webp|bmp)$/i.test(f.type)) res.type(f.type).send(f.buf);
    else res.type('application/octet-stream').attachment(name).send(f.buf);
  } catch (e) { res.status(e.status || 500).type('text/plain').send(e.message); }
});
// Status change / internal note, made by you from the Zendesk panel (never by the assistant).
app.post('/api/tickets/:id/update', wrap((req) => {
  const b = req.body || {};
  return zendesk.updateTicketAsMe(Number(req.params.id), {
    status: b.status ? String(b.status) : undefined,
    note: b.note ? String(b.note) : undefined,
    html: b.html ? String(b.html) : undefined,
    isPublic: b.public === true,
    ccs: b.ccs && typeof b.ccs === 'object' ? b.ccs : undefined,
    addTags: b.addTags, removeTags: b.removeTags,
    groupId: b.groupId === undefined ? undefined : Number(b.groupId),
    assigneeId: b.assigneeId === undefined ? undefined : (b.assigneeId ? Number(b.assigneeId) : null),
    addFollowers: b.addFollowers,
    timeSpent: b.timeSpent,
    fields: b.fields,
    uploads: b.uploads,
  });
}));
// An image pasted into the Zendesk panel's editor goes to Zendesk's Uploads API; Submit attaches it by its token.
app.post('/api/zendesk/uploads', express.raw({ type: 'application/octet-stream', limit: '20mb' }), wrap((req) => zendesk.uploadFile(String(req.query.name || 'image.png'), String(req.query.type || ''), req.body)));
app.post('/api/tickets/:id/ignore', wrap((req) => zendesk.setIgnored(Number(req.params.id), !!req.body.ignore)));
app.post('/api/tickets/:id/upvote', wrap((req) => {
  const id = Number(req.params.id);
  const upvoted = req.body.upvoted === true ? 1 : 0;
  const at = upvoted ? new Date().toISOString() : null;
  db.prepare('UPDATE tickets SET upvoted = ?, upvoted_at = ? WHERE id = ?').run(upvoted, at, id);
  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(id);
  if (!ticket) throw new Error(`Ticket #${id} not found`);
  const { score, reasons } = zendesk.scoreTicket(ticket);
  db.prepare('UPDATE tickets SET score = ?, reasons = ? WHERE id = ?').run(score, JSON.stringify(reasons), id);
  bus.emit('event', { type: 'tickets:updated', data: { id } });
  return { id, upvoted: !!upvoted, score };
}));
app.get('/api/zendesk/directory', wrap(() => zendesk.directory()));
app.get('/api/zendesk/users', wrap((req) => zendesk.searchUsers(req.query.q)));
app.get('/api/zendesk/macros', wrap((req) => zendesk.macros({ fresh: req.query.fresh === '1' })));
app.get('/api/tickets/:id/macros/:mid', wrap((req) => zendesk.macroPreview(Number(req.params.id), Number(req.params.mid))));
// Zendesk notifications (the bell): read them; mark read when you open one / all.
app.get('/api/notifications', wrap((req) => zendesk.notifications({ fresh: req.query.fresh === '1' })));
app.post('/api/notifications/read', wrap((req) => zendesk.markNotificationRead(String(req.body.entityType || ''), String(req.body.entityId || ''))));
app.post('/api/notifications/read-all', wrap(() => zendesk.markAllNotificationsRead()));
app.get('/api/zendesk/tags', wrap(() => zendesk.tagList()));
app.get('/api/performance', wrap(() => zendesk.dailyStats()));
app.get('/api/zendesk/auth', wrap(() => zendesk.auth.info()));
app.post('/api/zendesk/login', wrap(() => zendesk.auth.start()));
app.post('/api/zendesk/logout', wrap(() => { zendesk.auth.clear(); zendesk.start(); return zendesk.auth.info(); }));
app.post('/api/zendesk/sync', wrap(async () => { await zendesk.sync({ full: true }); return zendesk.state; }));

// ---------- Windows notification (fallback when the browser can't show one) ----------
app.post('/api/notify', wrap((req) => {
  const chatId = /^[\w-]{1,64}$/.test(req.body.chatId || '') ? req.body.chatId : null;
  const origin = `${req.protocol}://${req.headers.host}`; // an allowed host, checked above
  return notify.toast({ title: String(req.body.title || 'mon.ai'), body: String(req.body.body || ''), url: chatId ? `${origin}/#/chat/${chatId}` : origin });
}));

// ---------- Cloudflare ----------
app.get('/api/cloudflare/zones', wrap(async (req) => {
  const fresh = req.query.fresh === '1';
  const token = await cloudflare.verify({ fresh });
  let zones;
  try { zones = await cloudflare.zones({ fresh }); } catch (e) { throw new Error(e.message + cloudflare.hint(e.message)); }
  // Most recently opened from mon.ai first, then alphabetical.
  const opened = kv.get('cloudflare.lastOpened', {});
  zones = zones.map((z) => ({ ...z, client: zoneClient(z.name), lastOpened: opened[z.id] || null, dashUrl: `https://dash.cloudflare.com/${z.accountId}/${z.name}` }))
    .sort((a, b) => (b.lastOpened || '').localeCompare(a.lastOpened || '') || a.name.localeCompare(b.name));
  return { token, zones, cachedAt: cloudflare.cachedAt() };
}));
app.post('/api/cloudflare/zones/:id/opened', wrap((req) => {
  const opened = kv.get('cloudflare.lastOpened', {});
  opened[req.params.id] = new Date().toISOString();
  kv.set('cloudflare.lastOpened', opened);
  return { ok: true };
}));

// ---------- Azure / ADO ----------
app.get('/api/azure/status', wrap((req) => azure.status({ revalidate: req.query.revalidate === '1' })));
app.get('/api/azure/:org/check', wrap((req) => azure.checkSignIn(req.params.org, req.query.tool === 'ps' ? 'ps' : 'cli')));
app.post('/api/azure/:org/login', wrap((req) => azure.login(req.params.org, req.body.env || 'prod', req.body.tool || 'cli')));
app.post('/api/azure/:org/switch', wrap((req) => azure.switchSubscription(req.params.org, req.body.env || 'prod', req.body.tool || 'cli')));
app.post('/api/azure/:org/open', wrap((req) => azure.openInEdge(req.params.org, req.body.target)));
app.get('/api/azure/:org/groups', wrap((req) => azure.resourceGroups(req.params.org, req.query.env || 'prod')));
app.get('/api/azure/:org/ado', wrap(async (req) => {
  const [workItems, pullRequests] = await Promise.allSettled([azure.adoMyWorkItems(req.params.org), azure.adoMyPullRequests(req.params.org)]);
  return {
    workItems: workItems.value || [], pullRequests: pullRequests.value || [],
    errors: [workItems.reason?.message, pullRequests.reason?.message].filter(Boolean),
  };
}));

// ---------- Git ----------
app.get('/api/repos', wrap(() => git.list()));
app.post('/api/repos/scan', wrap(() => git.scan()));
app.post('/api/repos/pull', wrap((req) => git.pull(String(req.body.path || ''))));
app.post('/api/repos/check', wrap((req) => git.checkBehind(String(req.body.path || ''))));
app.post('/api/repos/open', wrap((req) => git.openInVSCode(String(req.body.path || ''))));

// ---------- Settings (hot-reloaded) ----------
const EDITABLE = ['azure', 'workspace', 'secrets'];
app.get('/api/config/:name', wrap((req) => {
  if (!EDITABLE.includes(req.params.name)) throw new Error('Unknown config');
  return { value: config.getPublic(req.params.name), file: config.file(req.params.name) };
}));
app.put('/api/config/:name', wrap((req) => {
  if (!EDITABLE.includes(req.params.name)) throw new Error('Unknown config');
  return { value: config.save(req.params.name, req.body) };
}));

// ---------- Claude (subscription login) ----------
app.get('/api/claude/auth', wrap(() => assistant.authStatus()));
// Token usage analysis (Usage page): by skill, ticket, client, chat, model, day.
// 5-hour plan sessions with what mon.ai used in each (the plan only tells us when the current one resets)
app.get('/api/usage/sessions', wrap(async () => {
  const plan = await assistant.planUsage().catch(() => null);
  return { sessions: usage.sessions({ resetsAt: plan?.session?.resetsAt || null }), plan: plan?.session || null };
}));
app.get('/api/usage', wrap((req) => usage.analysis({ days: Math.max(0, Math.min(365, Number(req.query.days ?? 7) || 0)), from: req.query.from ? String(req.query.from) : null, to: req.query.to ? String(req.query.to) : null, source: req.query.source ? String(req.query.source).slice(0, 60) : null })));
app.post('/api/usage/refresh', wrap(() => ({ calls: usage.ingestAll() })));
app.get('/api/usage/chat/:id', wrap((req) => usage.chatSummary(req.params.id)));
app.get('/api/claude/usage', wrap((req) => assistant.planUsage({ fresh: req.query.fresh === '1' })));
app.get('/api/claude/models', wrap((req) => assistant.listModels({ fresh: req.query.fresh === '1' })));
app.post('/api/claude/login', wrap(() => assistant.login()));
app.post('/api/claude/logout', wrap(() => assistant.logout()));

// ---------- Assistant harness overview (Settings → Advanced, read-only) ----------
app.get('/api/assistant/harness', wrap((req) => assistant.harnessInfo(req.query.org && req.query.org !== 'All' ? orgCode(String(req.query.org)) : 'All')));

// ---------- AI skills ----------
app.get('/api/skills', wrap(() => skills.list()));
app.get('/api/skills/:name', wrap((req) => skills.get(req.params.name) || Promise.reject(new Error('Skill not found'))));
app.put('/api/skills/:name', wrap((req) => skills.save({ ...req.body, previousName: req.params.name === '_new' ? null : req.params.name })));
app.delete('/api/skills/:name', wrap((req) => skills.remove(req.params.name)));

// ---------- Assistant sessions ----------
app.get('/api/sessions', wrap((req) => assistant.listSessions(req.query.org, { archived: req.query.archived === '1' })));
app.post('/api/sessions/:id/archive', wrap((req) => ({ archived: assistant.archiveSession(req.params.id, 'Archived by you') })));
app.post('/api/sessions/:id/unarchive', wrap((req) => assistant.unarchiveSession(req.params.id)));
app.post('/api/sessions/:id/cooldown', wrap((req) => assistant.setCooldown(req.params.id, req.body.on !== false)));
app.post('/api/sessions', wrap((req) => assistant.createSession({ org: req.body.org ? orgCode(req.body.org) : 'All', title: req.body.title, ticketId: req.body.ticketId })));
app.get('/api/sessions/:id', wrap((req) => assistant.getSession(req.params.id) || Promise.reject(new Error('Not found'))));
// Delete = move to the Archive (recycle bin). ?forever=1 deletes an archived chat for good.
app.delete('/api/sessions/:id', wrap((req) => (req.query.forever === '1' ? assistant.deleteForever(req.params.id) : assistant.trashSession(req.params.id))));
app.post('/api/sessions/:id/stop', wrap((req) => assistant.stop(req.params.id)));
app.get('/api/sessions/:id/ticket-updates', wrap((req) => assistant.ticketUpdates(req.params.id)));
app.post('/api/sessions/:id/ticket-seen', wrap((req) => assistant.markTicketSeen(req.params.id, typeof req.body.at === 'string' ? req.body.at : undefined)));
app.put('/api/sessions/:id/model', wrap((req) => assistant.setSessionModel(req.params.id, req.body.model ? String(req.body.model).slice(0, 80) : null)));
// Attach a file or image to a chat (raw bytes; ?name= gives the original file name).
app.post('/api/sessions/:id/uploads', express.raw({ type: 'application/octet-stream', limit: uploads.MAX_BYTES }), wrap((req) => {
  if (!assistant.getSession(req.params.id)) throw new Error('Chat not found');
  const { path: _p, ...info } = uploads.save(req.params.id, String(req.query.name || 'file'), req.body);
  return info;
}));
app.get('/api/uploads/:sid/:file', (req, res) => {
  try {
    const { full, inlineType } = uploads.fileFor(req.params.sid, req.params.file);
    res.set('X-Content-Type-Options', 'nosniff');
    if (inlineType) res.type(inlineType).sendFile(full);
    else res.download(full, req.params.file.slice(9)); // anything else downloads, never renders
  } catch { res.status(404).end(); }
});

app.post('/api/sessions/:id/compact', wrap((req) => assistant.compact(req.params.id)));
app.post('/api/sessions/:id/skill-draft', wrap((req) => assistant.draftSkillFromChat(req.params.id)));
app.post('/api/sessions/:id/messages', async (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  res.flushHeaders();
  const emit = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  const files = Array.isArray(req.body.attachments) ? req.body.attachments.slice(0, 20).map(String) : [];
  const rewindFrom = Number.isInteger(req.body.rewindFrom) ? req.body.rewindFrom : null; // editing an earlier message
  const skill = /^[a-z0-9][a-z0-9-]{0,62}$/.test(req.body.skill || '') ? req.body.skill : null; // e.g. Ask AI runs with /triage-ticket's model
  try { await assistant.send(req.params.id, String(req.body.text || '').slice(0, 20_000), emit, files, { rewindFrom, skill }); } catch (e) { emit('error', { message: e.message }); }
  res.end();
});

app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(import.meta.dirname, 'public', 'index.html')));

const startJobs = () => {
  skills.seed();
  setTimeout(() => { try { console.log(`[usage] read ${usage.ingestAll()} model calls from chat transcripts`); } catch (e) { console.error('[usage]', e.message); } }, 2000);
  // Claude Desktop / VS Code / CLI sessions: pick up new activity every 2 minutes (unchanged files are skipped)
  setInterval(() => { try { if (usage.ingestExternal()) bus.emit('event', { type: 'usage:updated', data: {} }); } catch (e) { console.error('[usage]', e.message); } }, 120_000);
  zendesk.boot();
  git.scan().catch((e) => console.error('[git]', e.message));
};

// HTTPS when the local certificate exists (npm run cert); plain HTTP otherwise.
// With HTTPS on, the HTTP port only redirects to https://, so old bookmarks keep working.
const TLS_DIR = process.env.MON_TLS_DIR || path.join(import.meta.dirname, 'data', 'tls');
const PFX = path.join(TLS_DIR, 'mon.ai.pfx');
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 443);
const useTls = process.env.MON_HTTPS !== '0' && fs.existsSync(PFX);
const portPart = (p, std) => (p === std ? '' : `:${p}`);

if (useTls) {
  const tls = { pfx: fs.readFileSync(PFX), passphrase: fs.readFileSync(path.join(TLS_DIR, 'pfx-pass.txt'), 'utf8').trim() };
  https.createServer(tls, app).listen(HTTPS_PORT, HOST, () => {
    console.log(`mon.ai listening on https://${HOST}:${HTTPS_PORT}  (open https://mon.ai${portPart(HTTPS_PORT, 443)})`);
    startJobs();
  });
  http.createServer((req, res) => {
    const host = (req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
    if (!ALLOWED_HOSTS.has(host)) { res.writeHead(421).end('Unknown host'); return; }
    res.writeHead(308, { Location: `https://${host}${portPart(HTTPS_PORT, 443)}${req.url}` }).end();
  }).listen(PORT, HOST, () => console.log(`http://${HOST}:${PORT} redirects to HTTPS`));
} else {
  app.listen(PORT, HOST, () => {
    console.log(`mon.ai listening on http://${HOST}:${PORT}  (open http://mon.ai${portPart(PORT, 80)}). Run "npm run cert" to switch to HTTPS.`);
    startJobs();
  });
}
