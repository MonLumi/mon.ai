// Zendesk near-real-time sync.
// Zendesk can't push webhooks to a localhost-only app, so we poll the Search API
// (tickets assigned to me, updated since the last run) every `pollSeconds`, with a
// full re-sync every 10 minutes to catch tickets reassigned away from me.
import { config, orgCode } from './config.js';
import { db, kv, bus } from './db.js';
import * as zdauth from './zdauth.js';

const FULL_SYNC_MS = 10 * 60 * 1000;
let timer = null;
let running = false;
export const state = { status: 'idle', lastSync: null, error: null, me: null };

// Two ways in: API token (email + token), or a browser sign-in session (no token needed).
function zd() {
  const c = config.get('secrets').zendesk;
  if (!c.subdomain) return null;
  const token = c.email && c.apiToken;
  if (!token && !zdauth.cookieHeader()) return null;
  return c;
}

export function isConfigured() { return !!zd(); }
export const auth = zdauth;

export async function request(pathAndQuery) {
  const c = zd();
  if (!c) throw new Error('Zendesk is not configured (Settings > Connections).');
  const sub = c.subdomain.replace(/\.zendesk\.com.*$/i, '').replace(/^https?:\/\//, '');
  const url = pathAndQuery.startsWith('http') ? pathAndQuery : `https://${sub}.zendesk.com/api/v2/${pathAndQuery.replace(/^\/+(api\/v2\/)?/, '')}`;
  const headers = { Accept: 'application/json' };
  const useToken = c.email && c.apiToken;
  if (useToken) headers.Authorization = `Basic ${Buffer.from(`${c.email}/token:${c.apiToken}`).toString('base64')}`;
  else headers.Cookie = zdauth.cookieHeader();
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, { headers, redirect: 'manual' });
    if (!useToken) zdauth.absorb(res);
    if (!useToken && [301, 302, 401, 403].includes(res.status)) {
      zdauth.clear();
      state.me = null;
      bus.emit('event', { type: 'zendesk:auth', data: zdauth.info() });
      zdauth.silentLogin(); // try to get a new session without a window; a success restarts the sync
      throw new Error('Zendesk browser session expired, reconnecting… (or use Sign in on the Dashboard).');
    }
    if (res.status === 429) {
      const wait = Number(res.headers.get('retry-after') || 10);
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    if (!res.ok) throw new Error(`Zendesk ${res.status} ${res.statusText} on ${url.split('?')[0]}`);
    return res.json();
  }
  throw new Error('Zendesk rate limit: gave up after 3 retries');
}

async function searchAll(query) {
  const out = [];
  let next = `search.json?query=${encodeURIComponent(query)}&sort_by=updated_at&sort_order=desc&per_page=100`;
  while (next && out.length < 1000) {
    const page = await request(next);
    out.push(...page.results.filter((r) => r.result_type === 'ticket'));
    next = page.next_page;
  }
  return out;
}

async function showMany(kind, ids) {
  const map = new Map();
  const unique = [...new Set(ids.filter(Boolean))];
  for (let i = 0; i < unique.length; i += 100) {
    const chunk = unique.slice(i, i + 100).join(',');
    const data = await request(`${kind}/show_many.json?ids=${chunk}`);
    for (const item of data[kind] || []) map.set(item.id, item);
  }
  return map;
}

/** Earliest active SLA breach time, via the `slas` sideload. Best effort. */
async function slaBreaches(ids) {
  const map = new Map();
  for (let i = 0; i < ids.length; i += 100) {
    try {
      const data = await request(`tickets/show_many.json?ids=${ids.slice(i, i + 100).join(',')}&include=slas`);
      for (const t of data.tickets || []) {
        const active = (t.slas?.policy_metrics || []).filter((m) => m.stage === 'active' && m.breach_at);
        if (active.length) map.set(t.id, active.map((m) => m.breach_at).sort()[0]);
      }
    } catch { /* SLA sideload is plan-dependent; scoring works without it */ }
  }
  return map;
}

export function scoreTicket(t, now = Date.now()) {
  let score = 0;
  const reasons = [];
  const add = (pts, text) => { score += pts; if (text) reasons.push({ pts, text }); };
  const hours = (iso) => (now - new Date(iso).getTime()) / 36e5;

  if (t.upvoted) add(20, 'You upvoted this ticket');
  add({ urgent: 40, high: 25, normal: 10, low: 3 }[t.priority] ?? 8, t.priority ? `Priority: ${t.priority}` : 'No priority set');
  const mine = !t.relation || t.relation === 'assigned';
  if (t.relation === 'unassigned') add(10, 'Unassigned, nobody has picked it up');
  else if (!mine) {
    add(-15, t.relation === 'cc' ? "You're CC'd, not assigned" : "You're following, not assigned");
    if (t.needs_me) add(35, t.needs_me_reason || 'Mentioned you, no reply from you yet');
  }
  if (t.status === 'new') add(20, 'New, not yet picked up');
  else if (t.status === 'open') add(12, mine ? 'Open, waiting on you' : 'Open');
  else if (t.status === 'pending') add(-15, 'Pending, waiting on customer');
  else if (t.status === 'hold') add(-10, 'On hold');

  if (t.sla_breach_at) {
    const left = -hours(t.sla_breach_at); // hours until breach
    if (left < 0) add(50, `SLA breached ${fmtH(-left)} ago`);
    else if (left < 1) add(35, `SLA breaches in ${fmtH(left)}`);
    else if (left < 4) add(20, `SLA breaches in ${fmtH(left)}`);
    else if (left < 24) add(8, `SLA breaches in ${fmtH(left)}`);
  }
  if (t.due_at) {
    const left = -hours(t.due_at);
    if (left < 0) add(30, `Overdue by ${fmtH(-left)}`);
    else if (left < 24) add(15, `Due in ${fmtH(left)}`);
  }
  if (['new', 'open'].includes(t.status)) {
    const idle = hours(t.updated_at);
    if (idle > 72) add(15, `No update for ${fmtH(idle)}`);
    else if (idle > 24) add(8, `No update for ${fmtH(idle)}`);
  }
  if (hours(t.created_at) > 24 * 14 && !['solved', 'closed'].includes(t.status)) add(5, `Open for ${Math.floor(hours(t.created_at) / 24)} days`);
  return { score, reasons };
}

function fmtH(h) {
  if (h < 1) return `${Math.max(1, Math.round(h * 60))}m`;
  if (h < 48) return `${Math.round(h)}h`;
  return `${Math.round(h / 24)}d`;
}

const upsert = db.prepare(`
  INSERT INTO tickets (id, subject, status, priority, type, org_id, org_name, org, requester, created_at, updated_at, due_at,
    sla_breach_at, score, reasons, url, raw, relation, assignee, assignee_id)
  VALUES (:id, :subject, :status, :priority, :type, :org_id, :org_name, :org, :requester, :created_at, :updated_at, :due_at,
    :sla_breach_at, :score, :reasons, :url, :raw, :relation, :assignee, :assignee_id)
  ON CONFLICT(id) DO UPDATE SET subject=excluded.subject, status=excluded.status, priority=excluded.priority, type=excluded.type,
    org_id=excluded.org_id, org_name=excluded.org_name, org=excluded.org, requester=excluded.requester,
    updated_at=excluded.updated_at, due_at=excluded.due_at, sla_breach_at=excluded.sla_breach_at,
    score=excluded.score, reasons=excluded.reasons, url=excluded.url, raw=excluded.raw, relation=excluded.relation,
    assignee=excluded.assignee, assignee_id=excluded.assignee_id`);

const dedupe = (list) => [...new Map(list.map((t) => [t.id, t])).values()];

/** How a ticket relates to me: my own, or one I follow / am CC'd on (e.g. @mentioned). */
function relationOf(t) {
  const me = state.me?.id;
  if (t.assignee_id === me) return 'assigned';
  if (!t.assignee_id && !['solved', 'closed'].includes(t.status)) return 'unassigned'; // waiting for someone to pick it up
  if ((t.follower_ids || []).includes(me)) return 'following';
  if ((t.collaborator_ids || []).includes(me) || (t.email_cc_ids || []).includes(me)) return 'cc';
  if (t._via === 'commenter') return 'updated'; // I commented on it, someone else's ticket
  return 'assigned'; // matched by assignee:me search
}

/**
 * A followed (not assigned) ticket needs me when someone mentioned me (by name or @mention) in a
 * comment or internal note and I haven't commented since. Otherwise a colleague is handling it.
 */
async function updateMentions(tickets) {
  const me = state.me;
  if (!me?.name) return;
  const names = [me.name, me.name.split(' ').slice(0, 2).join(' ')].filter((n, i, a) => n && n.length > 3 && a.indexOf(n) === i);
  const escapeRe = (n) => n.replace(/[.*+?^${}()|[\]\\]/g, (ch) => `\\${ch}`);
  const mentionRe = new RegExp(names.map((n) => escapeRe(n).replace(/\s+/g, '\\s+')).join('|'), 'i');
  const set = db.prepare('UPDATE tickets SET needs_me = ?, needs_me_reason = ?, needs_me_at = ? WHERE id = ?');
  for (const t of tickets) {
    if (relationOf(t) === 'assigned' || ['solved', 'closed'].includes(t.status)) { set.run(0, null, null, t.id); continue; }
    try {
      const d = await getTicketDetail(t.id); // oldest -> newest
      let hit = null;
      for (const c of [...d.comments].reverse()) {
        if (c.author_id === me.id) break;                     // I've replied since: not waiting on me
        if (mentionRe.test(c.body || '')) { hit = c; break; }  // newest mention after my last comment
      }
      set.run(hit ? 1 : 0, hit ? `${hit.author?.name || 'Someone'} mentioned you${hit.public ? '' : ' in an internal note'}, no reply from you yet` : null, hit ? hit.created_at : null, t.id);
    } catch (e) { console.error('[zendesk] mentions', t.id, e.message); }
  }
}

let myGroupsCache = { at: 0, ids: null };
/** Groups I'm a member of (cached 1 hour). */
async function myGroupIds() {
  if (myGroupsCache.ids && Date.now() - myGroupsCache.at < 3600_000) return myGroupsCache.ids;
  const ids = new Set();
  let next = `users/${state.me.id}/group_memberships.json?per_page=100`;
  while (next) { const p = await request(next); (p.group_memberships || []).forEach((m) => ids.add(m.group_id)); next = p.next_page; }
  myGroupsCache = { at: Date.now(), ids };
  return ids;
}
/** Open tickets nobody is assigned to, in my groups or with no group yet. */
async function unassignedTickets(extra = '') {
  const [list, groups] = await Promise.all([searchAll(`type:ticket assignee:none status<solved ${extra}`.trim()), myGroupIds().catch(() => new Set())]);
  return list.filter((t) => !t.group_id || !groups.size || groups.has(t.group_id));
}

/**
 * Who made the latest change to recently updated tickets (from the ticket audits; automations and
 * system changes are skipped). my_update_at is set when that was me, for the "My activity" tab.
 * Only re-checked when the ticket's updated_at moved.
 */
async function updateLastUpdater(tickets) {
  const me = state.me?.id;
  if (!me) return;
  const since = Date.now() - 26 * 36e5;
  const get = db.prepare('SELECT last_update_checked FROM tickets WHERE id = ?');
  const set = db.prepare('UPDATE tickets SET my_update_at = ?, last_update_checked = ? WHERE id = ?');
  for (const t of tickets) {
    if (new Date(t.updated_at).getTime() < since || get.get(t.id)?.last_update_checked === t.updated_at) continue;
    try {
      const page = await request(`tickets/${t.id}/audits.json?sort_order=desc&per_page=20`);
      const latest = (page.audits || []).filter((a) => a.author_id > 0).sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
      set.run(latest && latest.author_id === me ? latest.created_at : null, t.updated_at, t.id);
    } catch (e) { console.error('[zendesk] audits', t.id, e.message); }
  }
}

async function ingest(tickets) {
  if (!tickets.length) return;
  const c = zd();
  const ids = tickets.map((t) => t.id);
  const [orgs, users, slas] = await Promise.all([
    showMany('organizations', tickets.map((t) => t.organization_id)),
    showMany('users', tickets.flatMap((t) => [t.requester_id, t.assignee_id])),
    slaBreaches(ids),
  ]);
  const sub = c.subdomain.replace(/\.zendesk\.com.*$/i, '').replace(/^https?:\/\//, '');
  const reopened = []; // solved before, open / pending / new now (someone replied or reopened it)
  for (const t of tickets) {
    const prev = db.prepare('SELECT status FROM tickets WHERE id = ?').get(t.id)?.status;
    if (prev === 'solved' && !['solved', 'closed'].includes(t.status)) reopened.push({ id: t.id, status: t.status });
    const orgName = orgs.get(t.organization_id)?.name || null;
    const row = {
      id: t.id, subject: t.subject || '(no subject)', status: t.status, priority: t.priority, type: t.type,
      org_id: t.organization_id, org_name: orgName, org: orgCode(orgName), relation: relationOf(t),
      requester: users.get(t.requester_id)?.name || null,
      assignee_id: t.assignee_id || null, assignee: t.assignee_id ? users.get(t.assignee_id)?.name || null : null,
      created_at: t.created_at, updated_at: t.updated_at, due_at: t.due_at,
      sla_breach_at: slas.get(t.id) || null,
      url: `https://${sub}.zendesk.com/agent/tickets/${t.id}`,
      raw: JSON.stringify({ tags: t.tags, description: (t.description || '').slice(0, 2000) }),
    };
    const upvoted = db.prepare('SELECT COALESCE(upvoted, 0) AS upvoted FROM tickets WHERE id = ?').get(t.id)?.upvoted || 0;
    const { score, reasons } = scoreTicket({ ...row, upvoted });
    upsert.run({ ...row, score, reasons: JSON.stringify(reasons) });
  }
  // Reopened tickets: bring back the chat that was archived when they were solved (assistant.js listens).
  if (reopened.length) bus.emit('tickets:reopened', reopened);
}

export async function sync({ full = false } = {}) {
  if (running || !zd()) return;
  running = true;
  state.status = 'syncing';
  bus.emit('event', { type: 'zendesk:status', data: state });
  try {
    state.me ??= (await request('users/me.json')).user;
    if (!state.me?.id) throw new Error('Zendesk returned an anonymous user. Check the subdomain or sign in again.');
    const last = kv.get('zendesk.lastSync');
    const lastFull = kv.get('zendesk.lastFull', 0);
    const doFull = full || !last || Date.now() - lastFull > FULL_SYNC_MS;
    const startedAt = new Date();
    let tickets;
    if (doFull) {
      const week = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
      const lists = await Promise.all([
        searchAll('type:ticket assignee:me status<solved'),
        searchAll(`type:ticket assignee:me solved>=${week}`),
        // Not assigned to you but you follow them: @mentions and follow-up lists make you a follower.
        searchAll('type:ticket follower:me status<solved'),
        searchAll(`type:ticket follower:me solved>=${week}`),
        searchAll('type:ticket cc:me status<solved'),
      ]);
      // Others' tickets I commented on in the last day (first, so the lists above win in dedupe).
      lists.push(await unassignedTickets().catch((e) => { console.error('[zendesk] unassigned search', e.message); return []; }));
      const commented = await searchAll('type:ticket commenter:me updated>24hours').catch((e) => { console.error('[zendesk] commenter search', e.message); return []; });
      tickets = dedupe([...commented.map((t) => ({ ...t, _via: 'commenter' })), ...lists.flat()]);
      // Anything open locally that the full query no longer returns was reassigned or merged.
      const keep = new Set(tickets.map((t) => t.id));
      for (const row of db.prepare("SELECT id FROM tickets WHERE status NOT IN ('solved','closed')").all()) {
        if (!keep.has(row.id)) db.prepare('DELETE FROM tickets WHERE id = ?').run(row.id);
      }
      kv.set('zendesk.lastFull', Date.now());
    } else {
      const since = new Date(new Date(last).getTime() - 2 * 60 * 1000).toISOString().replace(/\.\d+Z$/, 'Z'); // overlap for index lag
      const lists = await Promise.all(['assignee:me', 'follower:me', 'cc:me'].map((who) => searchAll(`type:ticket ${who} updated>${since}`)));
      const commented = await searchAll(`type:ticket commenter:me updated>${since}`).catch(() => []);
      lists.push(await unassignedTickets(`updated>${since}`).catch(() => []));
      tickets = dedupe([...commented.map((t) => ({ ...t, _via: 'commenter' })), ...lists.flat()]);
    }
    await ingest(tickets);
    await updateMentions(tickets);
    await updateLastUpdater(tickets);
    await refreshTimeToday().catch((e) => console.error('[zendesk] time today', e.message));
    // Resolved tickets: archive their chats (assistant.js listens; avoids a circular import).
    const resolved = tickets.filter((t) => ['solved', 'closed'].includes(t.status)).map((t) => ({ id: t.id, status: t.status }));
    if (resolved.length) bus.emit('tickets:resolved', resolved);
    // Re-score everything so SLA countdowns / staleness move even without updates.
    for (const row of db.prepare("SELECT * FROM tickets WHERE status NOT IN ('solved','closed')").all()) {
      const { score, reasons } = scoreTicket(row);
      db.prepare('UPDATE tickets SET score = ?, reasons = ? WHERE id = ?').run(score, JSON.stringify(reasons), row.id);
    }
    await refreshDailyStats();
    kv.set('zendesk.lastSync', startedAt.toISOString());
    Object.assign(state, { status: 'ok', lastSync: startedAt.toISOString(), error: null });
    bus.emit('event', { type: 'tickets:updated', data: { count: tickets.length } });
    refreshNotifications().catch((e) => console.error('[zendesk] notifications', e.message));
    prefetchDetails().catch(() => {});
  } catch (err) {
    Object.assign(state, { status: 'error', error: err.message });
    console.error('[zendesk]', err.message);
  } finally {
    running = false;
    bus.emit('event', { type: 'zendesk:status', data: state });
  }
}

/** Local calendar date YYYY-MM-DD. */
const localDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
/** Monday 00:00 (local) of this week (Monday to Sunday). */
export function weekStart(now = new Date()) {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}
const searchCount = async (q) => { try { return (await request(`search/count.json?query=${encodeURIComponent(q)}`)).count; } catch { return null; } };

async function refreshDailyStats() {
  const today = localDay(new Date());
  const mon = weekStart();
  const days = Array.from({ length: 7 }, (_, i) => new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + i));
  const counts = await Promise.all(days.map((d) => {
    if (localDay(d) > today) return null; // later this week
    const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
    return searchCount(`type:ticket assignee:me solved>=${localDay(d)} solved<${localDay(next)}`);
  }));
  const week = days.map((d, i) => ({ date: localDay(d), solved: counts[i], future: localDay(d) > today }));
  kv.set('zendesk.solvedByDay', week);
  kv.set('zendesk.solvedToday', week.find((d) => d.date === today)?.solved ?? null);
  await refreshTeamWeek().catch((e) => console.error('[zendesk] team week', e.message));
}

// ---------- By assignee (this week, from Monday) ----------
// Agents in every Zendesk group (Agents, First responders, Light Agents…) who were active since Monday:
// time they logged (sum of "Time spent last update" in their audits), tickets assigned to them that were
// solved, and open tickets in their queue. Cost per refresh (at most every 10 minutes): one search for
// tickets updated this week (+ audits of the ones that changed since last time, cached), one search for
// tickets solved this week, and one count per active agent.
const TEAM_EVERY = 10 * 60_000;
const teamTimeCache = new Map(); // ticket id -> { updated_at, week, byAuthor: {id: seconds} }
let teamAt = 0;
async function refreshTeamWeek({ force = false } = {}) {
  const me = state.me?.id;
  if (!me || (!force && Date.now() - teamAt < TEAM_EVERY)) return kv.get('zendesk.teamWeek', null);
  teamAt = Date.now();
  const mon = weekStart(), week = localDay(mon);
  const agents = new Map();
  for (const g of await directory()) for (const a of g.agents) agents.set(a.id, a.name);
  agents.set(me, agents.get(me) || state.me.name);

  // Time logged: audits of tickets updated since Monday (any group).
  const f = await timeFields().catch(() => null);
  const seconds = new Map();
  if (f) {
    const touched = await searchAll(`type:ticket updated>=${week}`).catch(() => []);
    for (const t of touched) {
      let c = teamTimeCache.get(t.id);
      if (!c || c.updated_at !== t.updated_at || c.week !== week) {
        const byAuthor = {};
        try {
          let next = `tickets/${t.id}/audits.json?sort_order=desc&per_page=100`;
          outer: while (next) {
            const page = await request(next);
            for (const a of page.audits || []) {
              if (new Date(a.created_at) < mon) break outer;
              for (const e of a.events || []) {
                if (String(e.field_name) === String(f.last) && ['Change', 'Create'].includes(e.type) && Number(e.value) > 0) byAuthor[a.author_id] = (byAuthor[a.author_id] || 0) + Number(e.value);
              }
            }
            next = page.next_page;
          }
        } catch (e) { console.error('[zendesk] team audits', t.id, e.message); continue; }
        c = { updated_at: t.updated_at, week, byAuthor };
        teamTimeCache.set(t.id, c);
      }
      for (const [id, s] of Object.entries(c.byAuthor)) seconds.set(Number(id), (seconds.get(Number(id)) || 0) + s);
    }
  }

  // Resolved: one search for everything solved since Monday, counted by assignee.
  const resolved = new Map();
  for (const t of await searchAll(`type:ticket solved>=${week}`).catch(() => [])) if (t.assignee_id) resolved.set(t.assignee_id, (resolved.get(t.assignee_id) || 0) + 1);

  // Only agents with activity this week (time logged or a ticket resolved); queue size for those only.
  const active = [...agents].filter(([id]) => seconds.get(id) || resolved.get(id));
  const rows = await Promise.all(active.map(async ([id, name]) => ({
    id, name, me: id === me, seconds: seconds.get(id) || 0, resolved: resolved.get(id) || 0,
    open: await searchCount(`type:ticket assignee:${id} status<solved`),
  })));
  const data = { weekStart: week, agents: rows, checkedAt: new Date().toISOString(), timeTracked: !!f };
  kv.set('zendesk.teamWeek', data);
  return data;
}

export function dailyStats() {
  const solvedByDay = kv.get('zendesk.solvedByDay', []);
  const open = db.prepare("SELECT status, COUNT(*) n FROM tickets WHERE status NOT IN ('solved','closed') AND COALESCE(relation, 'assigned') = 'assigned' GROUP BY status").all();
  return {
    solvedToday: kv.get('zendesk.solvedToday', null) ?? solvedByDay.find((d) => d.date === localDay(new Date()))?.solved ?? null,
    loggedToday: kv.get('zendesk.loggedToday', null),
    weekStart: localDay(weekStart()),
    solvedByDay,
    openByStatus: Object.fromEntries(open.map((r) => [r.status, r.n])),
    byAssignee: kv.get('zendesk.teamWeek', null),
  };
}

/**
 * Zendesk's plain_body still carries HTML entities from the rich-text editor (&nbsp;, &amp;, &#39; …).
 * Decode them and tidy the whitespace they leave behind.
 */
const ENTITIES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', bull: '•', copy: '©', reg: '®', trade: '™' };
export function cleanText(s) {
  return String(s || '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] === '#') {
        const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/ /g, ' ')
    .replace(/[ \t]+$/gm, '')          // trailing spaces left by &nbsp;
    .replace(/\n{3,}/g, '\n\n')        // empty &nbsp; lines
    .trim();
}

// ---------- Ticket details (Zendesk panel), cached ----------
// Kept until the ticket changes (its updated_at moves in a sync) or 30 minutes pass; prefetched after
// each sync for tickets with an open chat and the ones in the focus queue, so the Zendesk panel opens at once.
const detailCache = new Map(); // id -> { at, updatedAt, data }
const DETAIL_TTL = 30 * 60_000;
function localFields(id) {
  const local = db.prepare('SELECT org, score, reasons, sla_breach_at, url, updated_at FROM tickets WHERE id = ?').get(Number(id));
  return {
    local,
    fields: { org: local?.org || null, score: local?.score ?? null, reasons: local ? JSON.parse(local.reasons) : [], slaBreachAt: local?.sla_breach_at || null, url: local?.url || null },
  };
}
export async function getTicketDetail(id, { fresh = false } = {}) {
  id = Number(id);
  const { local, fields } = localFields(id);
  const c = detailCache.get(id);
  if (!fresh && c && Date.now() - c.at < DETAIL_TTL && (!local || local.updated_at === c.updatedAt)) return { ...c.data, ...fields, cached: true };
  const data = await fetchTicketDetail(id);
  detailCache.set(id, { at: Date.now(), updatedAt: data.ticket.updated_at, data });
  if (detailCache.size > 300) detailCache.delete(detailCache.keys().next().value);
  return { ...data, ...localFields(id).fields };
}
export const forgetTicketDetail = (id) => detailCache.delete(Number(id));

/** Warm the cache: tickets with an open chat, then the focus queue. One at a time, after a sync. */
let prefetching = false;
async function prefetchDetails() {
  if (prefetching) return;
  prefetching = true;
  try {
    const ids = [
      ...db.prepare("SELECT DISTINCT ticket_id AS id FROM sessions WHERE ticket_id IS NOT NULL AND archived_at IS NULL").all(),
      ...db.prepare(`SELECT id FROM tickets WHERE status NOT IN ('solved','closed') AND (COALESCE(relation,'assigned') IN ('assigned','unassigned') OR needs_me = 1)
        ORDER BY score DESC LIMIT 25`).all(),
    ].map((r) => Number(r.id)).filter((x, i, a) => x && a.indexOf(x) === i);
    for (const id of ids) {
      const c = detailCache.get(id);
      const row = db.prepare('SELECT updated_at FROM tickets WHERE id = ?').get(id);
      if (c && Date.now() - c.at < DETAIL_TTL && (!row || row.updated_at === c.updatedAt)) continue;
      await getTicketDetail(id).catch(() => {});
    }
  } finally { prefetching = false; }
}

/**
 * A ticket's newest comments (oldest → newest), with who wrote them: Dataweavers (agent) or client.
 * Used for archived chats' resolution notes: the last messages on a solved ticket are its agreed outcome.
 */
export async function latestComments(id, n = 5) {
  const { comments = [] } = await request(`tickets/${Number(id)}/comments.json?sort_order=desc&per_page=${n}`);
  const list = comments.slice(0, n).reverse();
  const people = await showMany('users', list.map((c) => c.author_id)).catch(() => new Map());
  return list.map((c) => {
    const u = people.get(c.author_id);
    return {
      author: u?.name || `User ${c.author_id}`, agent: u ? u.role !== 'end-user' : false, me: c.author_id === state.me?.id,
      public: c.public, at: c.created_at, body: cleanText(c.plain_body), files: (c.attachments || []).filter((a) => !a.inline).length,
    };
  });
}

async function fetchTicketDetail(id) {
  const [{ ticket }, comments] = await Promise.all([
    request(`tickets/${id}.json`),
    request(`tickets/${id}/comments.json?sort_order=desc&per_page=30`),
  ]);
  // Fetched newest-first so long tickets keep their latest 30 comments; shown oldest → newest like Zendesk.
  const list = (comments.comments || []).reverse();
  const people = await showMany('users', [ticket.requester_id, ticket.assignee_id, ...list.map((c) => c.author_id), ...(ticket.email_cc_ids || [])]).catch(() => new Map());
  const who = (uid) => {
    const u = people.get(uid);
    return u ? { name: u.name, agent: u.role !== 'end-user', me: uid === state.me?.id } : { name: `User ${uid}`, agent: false, me: false };
  };
  return {
    ticket,
    requester: who(ticket.requester_id),
    groupId: ticket.group_id || null,
    missingToSolve: await missingToSolve(ticket).catch(() => []),
    category: await categoryField(ticket).catch(() => null),
    assigneeId: ticket.assignee_id || null,
    followers: (ticket.follower_ids || []).map((uid) => ({ id: uid, ...who(uid) })),
    // Email CCs: copied on public replies (shown and edited in the Zendesk panel's reply box)
    ccs: (ticket.email_cc_ids || []).map((uid) => ({ id: uid, ...who(uid), email: people.get(uid)?.email || '' })),
    assignee: ticket.assignee_id ? who(ticket.assignee_id) : null,
    comments: list.map((c) => ({
      author_id: c.author_id, author: who(c.author_id), public: c.public, created_at: c.created_at,
      body: cleanText(c.plain_body).slice(0, 4000), attachments: (c.attachments || []).length,
      html: String(c.html_body || '').slice(0, 150_000), // formatted, as Zendesk shows it (sanitised in the browser)
      files: (c.attachments || []).map((a) => ({ name: a.file_name, type: a.content_type, size: a.size, url: a.content_url, inline: !!a.inline, thumb: a.thumbnails?.[0]?.content_url || null })),
    })),
  };
}

export function start() {
  stop();
  if (!zd()) {
    state.status = 'not-configured';
    bus.emit('event', { type: 'zendesk:status', data: state });
    // signed in through the browser before? reconnect without a window (once; the Dashboard offers Sign in after that)
    if (zdauth.login.status !== 'needs-login') zdauth.silentLogin();
    return;
  }
  const every = Math.max(30, Number(config.get('secrets').zendesk.pollSeconds) || 60) * 1000;
  sync();
  timer = setInterval(() => sync(), every);
}
export function stop() { clearInterval(timer); timer = null; }

// Hot reload: new credentials/interval take effect immediately.
config.on('change', (name) => {
  if (name === 'secrets') { state.me = null; start(); }
  if (name === 'workspace') { remapOrgs(); bus.emit('event', { type: 'tickets:updated', data: {} }); } // org aliases changed
});

/** Re-derive each ticket's sidebar org from its Zendesk organization name, and move chats
 *  saved under an old client code (now an alias, e.g. EE -> Essential Energy) to the new one. */
export function remapOrgs() {
  for (const r of db.prepare('SELECT id, org_name FROM tickets').all()) db.prepare('UPDATE tickets SET org = ? WHERE id = ?').run(orgCode(r.org_name), r.id);
  for (const r of db.prepare("SELECT id, org FROM sessions WHERE org IS NOT NULL AND org <> 'All'").all()) {
    const code = orgCode(r.org);
    if (code !== r.org) db.prepare('UPDATE sessions SET org = ? WHERE id = ?').run(code, r.id);
  }
}
remapOrgs();

// A finished browser sign-in starts syncing right away.
// (also after a silent reconnect, while the old poll timer is still running)
bus.on('event', (e) => { if (e.type === 'zendesk:auth' && e.data?.login?.status === 'ok' && e.data?.signedIn) { state.me = null; state.error = null; start(); } });

/** Start-up: check the saved browser session first (reconnecting silently if needed), then sync. */
export async function boot() {
  const c = config.get('secrets').zendesk;
  if (c.subdomain && !(c.email && c.apiToken)) {
    await zdauth.ensure().catch(() => false); // a silent sign-in's 'ok' event already started the sync
    if (timer) return;
    if (!zd()) { state.status = 'not-configured'; bus.emit('event', { type: 'zendesk:status', data: state }); return; }
  }
  start();
}

// ---------- Changes made by YOU from mon.ai (status, internal note) ----------
// Only the Zendesk panel calls this, through POST /api/tickets/:id/update. It is deliberately not
// exposed as an assistant tool: the AI can read tickets but never change them.
const EDITABLE_STATUS = new Set(['open', 'pending', 'solved']);

// ---------- Macros (used from the Zendesk panel's reply box) ----------
let macroCache = { at: 0, data: null };
/** Macros you can use (personal, group and shared), like Zendesk's Apply macro list. Cached 10 min. */
export async function macros({ fresh = false } = {}) {
  if (!fresh && macroCache.data && Date.now() - macroCache.at < 600_000) return macroCache.data;
  const out = [];
  let next = 'macros/active.json?per_page=100&sort_by=alphabetical';
  for (let page = 0; next && page < 20; page++) {
    const data = await request(next);
    for (const m of data.macros || []) out.push({ id: m.id, title: m.title, description: m.description || '', restricted: !!m.restriction });
    next = data.next_page;
  }
  macroCache = { at: Date.now(), data: out };
  return out;
}

/**
 * What a macro would do to a ticket, without changing it: Zendesk's "apply" endpoint only returns
 * the result. The Zendesk panel fills the reply box and the fields from it; you still review and Submit.
 */
export async function macroPreview(ticketId, macroId) {
  if (!Number.isInteger(ticketId) || !Number.isInteger(macroId)) throw new Error('Bad id');
  const [{ result }, { ticket: cur }] = await Promise.all([
    request(`tickets/${ticketId}/macros/${macroId}/apply.json`),
    request(`tickets/${ticketId}.json`),
  ]);
  const t = result?.ticket || {};
  const c = result?.comment || t.comment || null; // Zendesk returns it on the ticket
  const before = new Set(cur.tags || []), after = new Set(t.tags || cur.tags || []);
  const curFields = new Map((cur.custom_fields || []).map((f) => [f.id, f.value]));
  const defs = await fieldDefs().catch(() => []);
  const fields = (t.custom_fields || []).filter((f) => f.value != null && f.value !== '' && String(f.value) !== String(curFields.get(f.id) ?? ''))
    .map((f) => {
      const def = defs.find((x) => x.id === f.id);
      return { id: f.id, value: f.value, title: def?.title || `Field ${f.id}`, label: def?.custom_field_options?.find((o) => o.value === f.value)?.name || String(f.value) };
    })
    .filter((f) => defs.some((x) => x.id === f.id && x.active && !SYSTEM_FIELDS.has(x.type)));
  return {
    comment: c && (c.html_body || c.body) ? { html: c.html_body || htmlEscape(c.body).replace(/\n/g, '<br>'), public: c.public !== false } : null,
    status: t.status && t.status !== cur.status ? t.status : null,
    groupId: t.group_id !== undefined && t.group_id !== cur.group_id ? t.group_id : undefined,
    assigneeId: t.assignee_id !== undefined && t.assignee_id !== cur.assignee_id ? t.assignee_id : undefined,
    addTags: [...after].filter((x) => !before.has(x)),
    removeTags: [...before].filter((x) => !after.has(x)),
    fields,
  };
}

let dirCache = { at: 0, data: null };
/** Groups and the agents you can assign tickets to (Zendesk "assignable" memberships). Cached 1 hour. */
export async function directory() {
  if (dirCache.data && Date.now() - dirCache.at < 3600_000) return dirCache.data;
  const groups = new Map(); const users = new Map(); const members = [];
  let next = 'group_memberships/assignable.json?include=users,groups&per_page=100';
  while (next) {
    const page = await request(next);
    (page.groups || []).forEach((g) => groups.set(g.id, g.name));
    (page.users || []).forEach((u) => users.set(u.id, u.name));
    members.push(...(page.group_memberships || []));
    next = page.next_page;
  }
  const data = [...groups].map(([id, name]) => ({
    id, name,
    agents: members.filter((m) => m.group_id === id).map((m) => ({ id: m.user_id, name: users.get(m.user_id) || `User ${m.user_id}` })).sort((a, b) => a.name.localeCompare(b.name)),
  })).sort((a, b) => a.name.localeCompare(b.name));
  dirCache = { at: Date.now(), data };
  return data;
}

let tagCache = { at: 0, data: null };
/** Tags used in your Zendesk (most used first), for suggestions. Cached 1 hour. */
export async function tagList() {
  if (tagCache.data && Date.now() - tagCache.at < 3600_000) return tagCache.data;
  const out = [];
  let next = 'tags.json?per_page=100';
  for (let i = 0; next && i < 5; i++) { const page = await request(next); out.push(...(page.tags || []).map((t) => t.name)); next = page.next_page; }
  tagCache = { at: Date.now(), data: out };
  return out;
}
const TAG = /^[\w:./-]{1,80}$/;

/** CSRF token that Zendesk requires for changes made with a browser session (not needed with an API token). */
async function csrfToken() {
  const me = await request('users/me.json');
  if (!me.user?.authenticity_token) throw new Error('Zendesk did not return a CSRF token; sign in again in Settings.');
  return me.user.authenticity_token;
}

let fieldDefsCache = { at: 0, data: null };
/** All ticket field definitions (cached 1 hour). */
async function fieldDefs() {
  if (fieldDefsCache.data && Date.now() - fieldDefsCache.at < 3600_000) return fieldDefsCache.data;
  const all = [];
  let next = 'ticket_fields.json?per_page=100';
  while (next) { const p = await request(next); all.push(...p.ticket_fields); next = p.next_page; }
  fieldDefsCache = { at: Date.now(), data: all };
  return all;
}
const SYSTEM_FIELDS = new Set(['subject', 'description', 'status', 'tickettype', 'priority', 'group', 'assignee']);

/** Custom fields Zendesk requires before solving that this ticket hasn't filled in (e.g. Category). */
export async function missingToSolve(ticket) {
  const defs = await fieldDefs();
  return defs
    .filter((d) => d.active && d.required && !SYSTEM_FIELDS.has(d.type))
    .filter((d) => { const v = ticket.custom_fields?.find((c) => c.id === d.id)?.value; return v === null || v === undefined || v === ''; })
    .map((d) => ({ id: d.id, title: d.title, type: d.type, options: (d.custom_field_options || []).map((o) => ({ name: o.name, value: o.value })) }));
}

/** The ticket's Category field (options from Zendesk) and its current value, for the status row of the Zendesk panel. */
export async function categoryField(ticket) {
  const def = (await fieldDefs()).find((d) => d.active && /^category$/i.test(d.title) && d.custom_field_options?.length);
  if (!def) return null;
  return {
    id: def.id, title: def.title, required: !!def.required,
    value: ticket.custom_fields?.find((c) => c.id === def.id)?.value || '',
    options: def.custom_field_options.map((o) => ({ name: o.name, value: o.value })),
  };
}

let timeFieldCache = null;
/** The Zendesk Time Tracking app's fields, found by name: "Total time spent (sec)", "Time spent last update (sec)". */
async function timeFields() {
  if (timeFieldCache) return timeFieldCache;
  const all = await fieldDefs();
  const find = (re) => all.find((f) => f.active && re.test(f.title))?.id || null;
  timeFieldCache = { total: find(/^total time spent/i), last: find(/^time spent last update/i) };
  if (!timeFieldCache.total || !timeFieldCache.last) { timeFieldCache = null; throw new Error('Time Tracking fields not found in Zendesk'); }
  return timeFieldCache;
}

/**
 * Formatted comment from mon.ai's rich editor. Zendesk sanitises html_body itself; this also drops
 * anything active (scripts, styles, event handlers, javascript: links) before it leaves the machine.
 */
const BLANK_INSIDE = '(?:\\s|&nbsp;|\\u00a0|<br\\s*\\/?>)*';
const EMPTY_BLOCK = `(?:<p\\b[^>]*>${BLANK_INSIDE}<\\/p>|<div\\b[^>]*>${BLANK_INSIDE}<\\/div>)`;
function cleanCommentHtml(html) {
  const ACTIVE = 'script|style|iframe|object|embed|form|input|button|textarea|select|meta|link|svg|math';
  return `<div class="zd-comment" dir="auto">${String(html)
    .replace(new RegExp(`<(${ACTIVE})\\b[^>]*>[\\s\\S]*?<\\/\\1\\s*>`, 'gi'), '') // element and its content
    .replace(new RegExp(`<\\/?(${ACTIVE})\\b[^>]*>`, 'gi'), '')                  // any stray open/close tag
    .replace(/\s(on\w+|srcdoc|formaction)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s(href|src)\s*=\s*("\s*(javascript|data|vbscript):[^"]*"|'\s*(javascript|data|vbscript):[^']*')/gi, '')
    // blank rows (empty paragraphs): keep one between paragraphs, collapse runs to one and drop them at the
    // very start or end
    .replace(new RegExp(`${EMPTY_BLOCK}(?:\\s*${EMPTY_BLOCK})+`, 'gi'), '<p><br></p>')
    .replace(new RegExp(`^(?:\\s*${EMPTY_BLOCK})+`, 'i'), '')
    .replace(new RegExp(`(?:${EMPTY_BLOCK}\\s*)+$`, 'i'), '')
    // paragraphs as plain lines: Zendesk puts a gap after every <p>, so a blank row between two looked like two
    .replace(/<p\b([^>]*)>/gi, '<div$1>').replace(/<\/p\s*>/gi, '</div>')}</div>`;
}
const EMAIL = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[a-z]{2,}$/i;

/** People search for the CC field (agents and end users, like Zendesk's CC box). */
export async function searchUsers(q) {
  q = String(q || '').trim();
  if (q.length < 2) return [];
  const { users = [] } = await request(`users/autocomplete.json?name=${encodeURIComponent(q.slice(0, 60))}&per_page=10`);
  return users.filter((u) => u.active !== false && u.email).slice(0, 10).map((u) => ({ id: u.id, name: u.name, email: u.email, agent: u.role !== 'end-user' }));
}

export async function updateTicketAsMe(id, { status, note, html, isPublic = false, ccs, addTags = [], removeTags = [], groupId, assigneeId, addFollowers = [], timeSpent = 0, fields = {}, uploads = [] } = {}) {
  const c = zd();
  if (!c) throw new Error('Zendesk is not configured.');
  if (!Number.isInteger(id) || id <= 0) throw new Error('Bad ticket id');
  const ticket = {};
  if (status) {
    if (!EDITABLE_STATUS.has(status)) throw new Error('Status must be open, pending or solved');
    ticket.status = status;
  }
  const rich = String(html || '').trim();
  const body = String(note || '').trim();
  if (rich) {
    // From the rich editor (formatting, and @mentions already made into Zendesk mention links).
    // Public reply only when you chose it in the Zendesk panel; the assistant never posts anything.
    if (rich.length > 200_000) throw new Error('Comment is too long');
    ticket.comment = { html_body: cleanCommentHtml(rich), public: !!isPublic };
  } else if (body) {
    if (body.length > 20_000) throw new Error('Note is too long (20,000 characters max)');
    // Plain-text internal note. Sent as HTML so "@Name" of a colleague becomes a real
    // Zendesk mention (the same link Zendesk's editor makes), which notifies them.
    ticket.comment = { html_body: await noteHtml(body), public: false };
  }
  // Images pasted into the editor were uploaded first (uploadFile); their tokens attach them to this comment,
  // and the <img> tags pointing at the upload's content_url make them show inline.
  const tokens = [...new Set((Array.isArray(uploads) ? uploads : []).map(String).filter((t) => /^[A-Za-z0-9]{8,64}$/.test(t)))].slice(0, 20);
  if (tokens.length) {
    if (!ticket.comment) throw new Error('Images are sent with a reply or note');
    ticket.comment.uploads = tokens;
  }
  // Email CCs go with a public reply: { add: [{ id } | { email, name }], remove: [userId] }
  if (ccs && (ccs.add?.length || ccs.remove?.length)) {
    if (!ticket.comment?.public) throw new Error('CCs can only be changed with a public reply');
    const list = [];
    for (const x of (Array.isArray(ccs.add) ? ccs.add : []).slice(0, 48)) {
      if (Number.isInteger(Number(x?.id)) && Number(x.id) > 0) list.push({ user_id: Number(x.id), action: 'put' });
      else if (EMAIL.test(String(x?.email || '').trim())) list.push({ user_email: String(x.email).trim(), ...(x.name ? { user_name: String(x.name).slice(0, 100) } : {}), action: 'put' });
      else throw new Error(`Not a valid CC: ${x?.email || JSON.stringify(x)}`);
    }
    for (const uid of (Array.isArray(ccs.remove) ? ccs.remove : []).map(Number).filter((n) => Number.isInteger(n) && n > 0)) list.push({ user_id: uid, action: 'delete' });
    if (list.length) ticket.email_ccs = list;
  }
  const tags = (list) => [...new Set((Array.isArray(list) ? list : []).map((t) => String(t).trim().toLowerCase().replace(/\s+/g, '_')).filter(Boolean))];
  const add = tags(addTags), remove = tags(removeTags);
  for (const t of [...add, ...remove]) if (!TAG.test(t)) throw new Error(`Invalid tag "${t}" (letters, digits, _ - : . / only)`);
  if (add.length) ticket.additional_tags = add;      // merge, so tags added by others meanwhile are kept
  if (remove.length) ticket.remove_tags = remove;
  if (groupId !== undefined || assigneeId !== undefined) {
    const dir = await directory();
    const g = dir.find((x) => x.id === Number(groupId));
    if (groupId !== undefined && !g) throw new Error('Unknown group');
    if (assigneeId && !(g || { agents: dir.flatMap((x) => x.agents) }).agents.some((a) => a.id === Number(assigneeId))) throw new Error('That agent is not in the chosen group');
    if (g) ticket.group_id = g.id;
    ticket.assignee_id = assigneeId ? Number(assigneeId) : null; // group only = unassigned within the group
  }
  const followers = [...new Set((Array.isArray(addFollowers) ? addFollowers : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (followers.length) {
    const known = new Set((await directory()).flatMap((x) => x.agents.map((a) => a.id)));
    if (followers.some((u) => !known.has(u))) throw new Error('Unknown follower');
    ticket.followers = followers.map((user_id) => ({ user_id, action: 'put' }));
  }
  // Values for required fields (e.g. Category before solving), checked against the field's options.
  const customFields = [];
  const entries = Object.entries(fields && typeof fields === 'object' ? fields : {}).filter(([, v]) => v !== '' && v != null);
  if (entries.length) {
    const defs = await fieldDefs();
    for (const [fid, value] of entries) {
      const def = defs.find((d) => d.id === Number(fid) && d.active && !SYSTEM_FIELDS.has(d.type));
      if (!def) throw new Error(`Unknown field ${fid}`);
      if (def.custom_field_options?.length && !def.custom_field_options.some((o) => o.value === value)) throw new Error(`"${value}" is not an option of ${def.title}`);
      customFields.push({ id: def.id, value: String(value).slice(0, 1000) });
    }
  }
  // Time spent on this update, logged like the Zendesk Time Tracking app: "last update" gets this
  // session's seconds and "total" gets them added to what the ticket already has.
  const secs = Math.round(Number(timeSpent) || 0);
  if (secs < 0 || secs > 24 * 3600) throw new Error('Time spent must be between 0 and 24 hours');
  if (secs > 0) {
    const f = await timeFields();
    const cur = (await request(`tickets/${id}.json`)).ticket;
    const total = Number(cur.custom_fields?.find((c) => c.id === f.total)?.value || 0);
    customFields.push({ id: f.last, value: secs }, { id: f.total, value: total + secs });
  }
  if (customFields.length) ticket.custom_fields = customFields;
  if (!Object.keys(ticket).length) throw new Error('Nothing to update');

  const sub = c.subdomain.replace(/\.zendesk\.com.*$/i, '').replace(/^https?:\/\//, '');
  const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
  const useToken = c.email && c.apiToken;
  if (useToken) headers.Authorization = `Basic ${Buffer.from(`${c.email}/token:${c.apiToken}`).toString('base64')}`;
  else { headers.Cookie = zdauth.cookieHeader(); headers['X-CSRF-Token'] = await csrfToken(); }
  const res = await fetch(`https://${sub}.zendesk.com/api/v2/tickets/${id}.json`, { method: 'PUT', headers, body: JSON.stringify({ ticket }), redirect: 'manual' });
  if (!useToken) zdauth.absorb(res);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const reasons = Object.values(data.details || {}).flat().map((x) => x?.description).filter(Boolean);
    const detail = reasons.length ? reasons.join('; ') : (data.description || data.error?.message || data.error || res.statusText);
    throw new Error(`Zendesk refused the update (${res.status}): ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
  }
  // Reflect the change locally right away (dashboard, archive on solve) instead of waiting for the next sync.
  state.me ??= (await request('users/me.json')).user;
  forgetTicketDetail(id);
  const rel = relationOf(data.ticket);
  await ingest([rel === 'assigned' && data.ticket.assignee_id !== state.me.id ? { ...data.ticket, _via: 'commenter' } : data.ticket]);
  db.prepare('UPDATE tickets SET my_update_at = ?, last_update_checked = ? WHERE id = ?').run(data.ticket.updated_at, data.ticket.updated_at, data.ticket.id);
  if (secs) await refreshTimeToday().catch(() => {});
  if (['solved', 'closed'].includes(data.ticket.status)) bus.emit('tickets:resolved', [{ id: data.ticket.id, status: data.ticket.status }]);
  bus.emit('event', { type: 'tickets:updated', data: { id } });
  console.log(`[zendesk] you updated #${id}: ${Object.keys(ticket).join(', ')}`);
  return { id, status: data.ticket.status, noted: !!body, changed: Object.keys(ticket) };
}

const htmlEscape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * Plain note text -> Zendesk HTML. "@Full Name" of anyone in the Dataweavers directory becomes
 * <a href="/users/ID" class="atmention">Full Name</a>, exactly as Zendesk's own editor stores a mention.
 */
export async function noteHtml(text) {
  const people = [...new Map((await directory().catch(() => [])).flatMap((g) => g.agents).map((a) => [a.id, a])).values()]
    .sort((a, b) => b.name.length - a.name.length); // longest names first ("Viet Anh Nguyen" before "Viet Anh")
  let html = htmlEscape(text);
  const links = [];
  for (const p of people) {
    const name = htmlEscape(p.name);
    const at = `@${name}`;
    let i;
    while ((i = html.indexOf(at)) !== -1) {
      const token = `\u0000${links.length}\u0000`; // placeholder so shorter names don't match inside this link
      links.push(`<a href="/users/${p.id}" class="atmention">${name}</a>`);
      html = html.slice(0, i) + token + html.slice(i + at.length);
    }
  }
  html = html.replace(/\u0000(\d+)\u0000/g, (_, n) => links[Number(n)]);
  const paragraphs = html.split(/\n{2,}/).map((p) => `<p dir="auto">${p.replace(/\n/g, '<br>')}</p>`).join('');
  return `<div class="zd-comment" dir="auto">${paragraphs}</div>`;
}

/**
 * Ignore a mention: the ticket leaves "Needs you" until there's a newer mention of you (its time
 * changes) or you comment (then it no longer needs you at all).
 */
export async function setIgnored(id, ignore) {
  if (ignore) assertCanCool(id);
  // make sure we know which mention is being ignored (older rows may not have its time yet)
  const row = db.prepare('SELECT needs_me, needs_me_at FROM tickets WHERE id = ?').get(id);
  if (ignore && row?.needs_me && !row.needs_me_at) {
    state.me ??= (await request('users/me.json')).user;
    await updateMentions([(await request(`tickets/${id}.json`)).ticket]);
  }
  // The marker is what we cooled down: the mention (back when you're mentioned again), or for an unassigned
  // ticket its last update (back when anything new happens on it).
  db.prepare(`UPDATE tickets SET ignored_mention_at = CASE WHEN ? THEN (CASE WHEN needs_me = 1 AND needs_me_at IS NOT NULL THEN needs_me_at ELSE updated_at END) ELSE NULL END WHERE id = ?`).run(ignore ? 1 : 0, id);
  // Any other ticket (e.g. assigned to you, no mention): cooling down until someone else updates it.
  const plain = ignore && row && !row.needs_me && db.prepare("SELECT COALESCE(relation, 'assigned') <> 'unassigned' AS p FROM tickets WHERE id = ?").get(id)?.p;
  db.prepare('UPDATE tickets SET cooled_at = ? WHERE id = ?').run(plain ? new Date().toISOString() : null, id);
  // the ticket's chat follows (dimmed in the sidebar while cooling down, back to normal on Warm up)
  const chats = db.prepare(`UPDATE sessions SET cooled_at = ${ignore ? 'COALESCE(cooled_at, ?)' : 'NULL'} WHERE ticket_id = ? AND archived_at IS NULL`).run(...(ignore ? [new Date().toISOString(), id] : [id]));
  bus.emit('event', { type: 'tickets:updated', data: { id } });
  if (chats.changes) bus.emit('event', { type: 'sessions:updated', data: { ticketId: id } });
  return { id, ignored: !!ignore };
}

// A ticket whose chat you cooled down (chat ⋯ menu) counts as cooling down until someone else updates it after that.
export const CHAT_COOLED = "EXISTS (SELECT 1 FROM sessions s WHERE s.ticket_id = tickets.id AND s.archived_at IS NULL AND s.cooled_at IS NOT NULL AND NOT (tickets.updated_at > s.cooled_at AND tickets.updated_at IS NOT COALESCE(tickets.my_update_at, '')))";
// …and so does a ticket you cooled down from its ticket workspace (⋯ menu) before it had a chat.
export const TICKET_COOLED = "(tickets.cooled_at IS NOT NULL AND NOT (tickets.updated_at > tickets.cooled_at AND tickets.updated_at IS NOT COALESCE(tickets.my_update_at, '')))";
// Cooling down (the Dashboard's Cooled tab): an ignored mention, a cooled ticket, or a cooled ticket chat.
export const COOLED = `((ignored_mention_at IS NOT NULL AND ((needs_me = 1 AND ignored_mention_at = needs_me_at) OR (COALESCE(relation, 'assigned') = 'unassigned' AND ignored_mention_at = updated_at))) OR ${CHAT_COOLED} OR ${TICKET_COOLED})`;

/** Is the ticket in the Cooled tab right now? */
export function isCooled(id) {
  return !!db.prepare(`SELECT ${COOLED} AS c FROM tickets WHERE id = ?`).get(id)?.c;
}
/** Priority is a ladder, Upvoted > Normal > Cooled, moved one step at a time: no cooling down an upvoted ticket. */
export function assertCanCool(id) {
  if (db.prepare('SELECT COALESCE(upvoted, 0) AS u FROM tickets WHERE id = ?').get(id)?.u) throw new Error(`#${id} is upvoted: remove the upvote before cooling it down`);
}

/** Upvote (👀): your focus list. A cooled-down ticket has to be warmed up first (the ladder above). */
export function setUpvote(id, upvoted) {
  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(id);
  if (!ticket) throw new Error(`Ticket #${id} not found`);
  if (upvoted && isCooled(id)) throw new Error(`#${id} is cooling down: warm it up before upvoting it`);
  db.prepare('UPDATE tickets SET upvoted = ?, upvoted_at = ? WHERE id = ?').run(upvoted ? 1 : 0, upvoted ? new Date().toISOString() : null, id);
  const { score, reasons } = scoreTicket({ ...ticket, upvoted: upvoted ? 1 : 0 });
  db.prepare('UPDATE tickets SET score = ?, reasons = ? WHERE id = ?').run(score, JSON.stringify(reasons), id);
  bus.emit('event', { type: 'tickets:updated', data: { id } });
  return { id, upvoted: !!upvoted, score };
}

// ---------- Notifications (the bell in Zendesk's agent workspace) ----------
// Zendesk keeps these in its GraphQL API (no REST endpoint). Polled with each sync; marking one as
// read only happens when you open it in mon.ai, like clicking it in Zendesk.
async function graphql(query, variables = {}) {
  const c = zd();
  if (!c) throw new Error('Zendesk is not configured (Settings > Connections).');
  const sub = c.subdomain.replace(/\.zendesk\.com.*$/i, '').replace(/^https?:\/\//, '');
  const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
  const useToken = c.email && c.apiToken;
  if (useToken) headers.Authorization = `Basic ${Buffer.from(`${c.email}/token:${c.apiToken}`).toString('base64')}`;
  else { headers.Cookie = zdauth.cookieHeader(); headers['X-CSRF-Token'] = await csrfToken(); }
  const res = await fetch(`https://${sub}.zendesk.com/api/graphql`, { method: 'POST', headers, body: JSON.stringify({ query, variables }), redirect: 'manual' });
  if (!useToken) zdauth.absorb(res);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || (data.errors?.length && !data.data)) throw new Error(`Zendesk notifications: ${data.errors?.[0]?.message || res.status}`);
  return data.data;
}

const NOTIF_QUERY = `query MonNotifications {
  notificationGroup { edges { node { id notifications {
    id entity groupId read readAt timestamp icon source
    title { key protectableContext { ... on UnmaskedStringMappedField { key value } } }
    text { key protectableContext { ... on UnmaskedStringMappedField { key value } } }
    actions { actions { __typename ... on ZrnNotificationAction { zrn } } }
    requester { id name }
  } } } }
  notificationCount(filter: { read: false }) { count }
}`;

const ctx = (part) => Object.fromEntries((part?.protectableContext || []).filter((c) => c?.key).map((c) => [c.key, c.value]));
function shapeNotification(n) {
  const [, kind = '', entityId = ''] = String(n.entity || '').match(/^zen:([^:]+):(.+)$/) || [];
  const zrn = (n.actions?.actions || []).map((a) => a.zrn).filter(Boolean).join(' ');
  const ticketId = kind === 'ticket' ? Number(entityId) : Number((zrn.match(/ticket[:/](\d+)/) || [])[1]) || null;
  const t = ctx(n.title), x = ctx(n.text);
  return {
    id: n.id, groupId: n.groupId, read: !!n.read, readAt: n.readAt, at: n.timestamp, icon: n.icon, kind: n.title?.key || '',
    entityType: kind === 'side_conversation' ? 'side_conversation' : 'ticket', entityId: kind === 'side_conversation' ? entityId : String(ticketId || entityId),
    ticketId, actor: t.agent_name || null, subject: t.ticket_subject || null, message: (x.message || '').slice(0, 600), requester: n.requester?.name || null,
  };
}

let notifCache = { at: 0, data: null };
/** Latest notifications, newest first, plus the unread count. */
export async function notifications({ fresh = false } = {}) {
  if (!fresh && notifCache.data && Date.now() - notifCache.at < 30_000) return notifCache.data;
  const d = await graphql(NOTIF_QUERY);
  const list = (d.notificationGroup?.edges || []).flatMap((e) => e.node?.notifications || []).map(shapeNotification)
    .sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const org = db.prepare('SELECT org FROM tickets WHERE id = ?');
  for (const n of list) n.org = n.ticketId ? org.get(n.ticketId)?.org || null : null;
  notifCache = { at: Date.now(), data: { unread: d.notificationCount?.count ?? list.filter((n) => !n.read).length, items: list } };
  return notifCache.data;
}

let lastNotifSig = null;
/** Called after each sync: tells the browser when something changed, and which notifications are new. */
export async function refreshNotifications() {
  const prev = new Set((notifCache.data?.items || []).map((n) => n.id));
  const first = notifCache.data === null;
  const d = await notifications({ fresh: true });
  const sig = `${d.unread}|${d.items.map((n) => n.id + (n.read ? 'r' : 'u')).join(',')}`;
  if (sig === lastNotifSig) return;
  lastNotifSig = sig;
  const fresh = first ? [] : d.items.filter((n) => !n.read && !prev.has(n.id));
  bus.emit('event', { type: 'notifications:updated', data: { unread: d.unread, fresh } });
}

/** Mark one ticket's (or side conversation's) notifications as read in Zendesk; you opened it in mon.ai. */
export async function markNotificationRead(entityType, entityId) {
  if (!['ticket', 'side_conversation'].includes(entityType) || !/^[\w-]{1,80}$/.test(String(entityId))) throw new Error('Bad notification');
  const d = await graphql(`mutation MonMarkRead($entityId: String, $entityType: String!) { notificationMarkAsRead(entityId: $entityId, entityType: $entityType) { __typename ... on NotificationMarkAsReadFailure { causes { message } } } }`, { entityId: String(entityId), entityType });
  const r = d.notificationMarkAsRead;
  if (r?.__typename?.endsWith('Failure')) throw new Error(r.causes?.[0]?.message || 'Zendesk could not mark it as read');
  await refreshNotifications().catch(() => {});
  return notifCache.data;
}

export async function markAllNotificationsRead() {
  const d = await graphql('mutation MonMarkAllRead { notificationMarkAllAsRead { __typename ... on NotificationMarkAllAsReadFailure { causes { message } } } }');
  const r = d.notificationMarkAllAsRead;
  if (r?.__typename?.endsWith('Failure')) throw new Error(r.causes?.[0]?.message || 'Zendesk could not mark them as read');
  await refreshNotifications().catch(() => {});
  return notifCache.data;
}

// ---------- Time logged today ----------
// Each update with time (from mon.ai or Zendesk's Time Tracking app) sets "Time spent last update".
// Today's total = those values in today's audits written by me, on tickets updated today.
const timeCache = new Map(); // ticket id -> { updated_at, day, seconds }
export async function refreshTimeToday() {
  const me = state.me?.id;
  if (!me) return null;
  const f = await timeFields();
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const day = start.toISOString();
  const rows = db.prepare('SELECT id, subject, org, updated_at FROM tickets WHERE updated_at >= ? ORDER BY updated_at DESC').all(day.replace(/\.\d+Z$/, 'Z'));
  const tickets = [];
  for (const r of rows) {
    let c = timeCache.get(r.id);
    if (!c || c.updated_at !== r.updated_at || c.day !== day) {
      let seconds = 0;
      try {
        const page = await request(`tickets/${r.id}/audits.json?sort_order=desc&per_page=100`);
        for (const a of page.audits || []) {
          if (new Date(a.created_at) < start || a.author_id !== me) continue;
          for (const e of a.events || []) {
            if (String(e.field_name) === String(f.last) && ['Change', 'Create'].includes(e.type) && Number(e.value) > 0) seconds += Number(e.value);
          }
        }
      } catch (e) { console.error('[zendesk] time audits', r.id, e.message); continue; }
      c = { updated_at: r.updated_at, day, seconds };
      timeCache.set(r.id, c);
    }
    if (c.seconds) tickets.push({ id: r.id, subject: r.subject, org: r.org, seconds: c.seconds });
  }
  const data = { day: `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`, seconds: tickets.reduce((n, t) => n + t.seconds, 0), tickets, checkedAt: new Date().toISOString() };
  kv.set('zendesk.loggedToday', data);
  return data;
}

// ---------- Attachments and inline images (Zendesk panel) ----------
// Zendesk attachments need your Zendesk sign-in, which the browser on mon.ai doesn't have, so mon.ai
// fetches them for the page. Only Zendesk attachment URLs are allowed (no other hosts).
const fileCache = new Map(); // url -> { at, type, buf }
function allowedFileUrl(u, sub) {
  let url;
  try { url = new URL(u); } catch { return null; }
  if (url.protocol !== 'https:') return null;
  if (url.hostname === `${sub}.zendesk.com` && url.pathname.startsWith('/attachments/')) return url;
  if (/(^|\.)zdusercontent\.com$/.test(url.hostname)) return url;
  return null;
}
export async function fetchFile(u) {
  const c = zd();
  if (!c) throw new Error('Zendesk is not configured');
  const sub = c.subdomain.replace(/\.zendesk\.com.*$/i, '').replace(/^https?:\/\//, '');
  const hit = fileCache.get(u);
  if (hit) return hit;
  let url = allowedFileUrl(u, sub);
  if (!url) throw Object.assign(new Error('Not a Zendesk attachment'), { status: 400 });
  for (let hop = 0; hop < 4; hop++) {
    const headers = {};
    if (url.hostname.endsWith('.zendesk.com')) {
      if (c.email && c.apiToken) headers.Authorization = `Basic ${Buffer.from(`${c.email}/token:${c.apiToken}`).toString('base64')}`;
      else headers.Cookie = zdauth.cookieHeader();
    }
    const res = await fetch(url, { headers, redirect: 'manual' });
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      url = allowedFileUrl(new URL(res.headers.get('location'), url).toString(), sub);
      if (!url) throw Object.assign(new Error('Attachment redirected outside Zendesk'), { status: 502 });
      continue;
    }
    if (!res.ok) throw Object.assign(new Error(`Zendesk ${res.status}`), { status: res.status === 404 ? 404 : 502 });
    const len = Number(res.headers.get('content-length') || 0);
    if (len > 25 * 1024 * 1024) throw Object.assign(new Error('Attachment too large to preview'), { status: 413 });
    const buf = Buffer.from(await res.arrayBuffer());
    const out = { at: Date.now(), type: (res.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim(), buf };
    if (buf.length < 5 * 1024 * 1024) {
      fileCache.set(u, out);
      let total = 0;
      for (const [k, v] of [...fileCache].reverse()) { total += v.buf.length; if (total > 120 * 1024 * 1024) fileCache.delete(k); }
    }
    return out;
  }
  throw Object.assign(new Error('Too many redirects'), { status: 502 });
}

// ---------- Uploads (images pasted into the Zendesk panel's reply / note editor) ----------
// Zendesk keeps an upload for 60 minutes; sending it with a comment (its token) attaches it to the ticket.
const UPLOAD_TYPES = /^image\/(png|jpeg|gif|webp|bmp)$/;
export async function uploadFile(name, type, buf) {
  const c = zd();
  if (!c) throw new Error('Zendesk is not configured.');
  if (!UPLOAD_TYPES.test(type)) throw new Error('Only images (PNG, JPEG, GIF, WebP, BMP) can be pasted');
  if (!buf?.length) throw new Error('Empty image');
  if (buf.length > 20 * 1024 * 1024) throw new Error('Image is larger than 20 MB');
  const sub = c.subdomain.replace(/\.zendesk\.com.*$/i, '').replace(/^https?:\/\//, '');
  const file = String(name || 'image.png').replace(/[^\w .()-]+/g, '_').slice(0, 120) || 'image.png';
  const headers = { Accept: 'application/json', 'Content-Type': type };
  const useToken = c.email && c.apiToken;
  if (useToken) headers.Authorization = `Basic ${Buffer.from(`${c.email}/token:${c.apiToken}`).toString('base64')}`;
  else { headers.Cookie = zdauth.cookieHeader(); headers['X-CSRF-Token'] = await csrfToken(); }
  const res = await fetch(`https://${sub}.zendesk.com/api/v2/uploads.json?filename=${encodeURIComponent(file)}&inline=true`, { method: 'POST', headers, body: buf, redirect: 'manual' });
  if (!useToken) zdauth.absorb(res);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.upload?.token) throw new Error(`Zendesk refused the image (${res.status}): ${data.description || data.error?.message || data.error || res.statusText}`);
  const a = data.upload.attachment || data.upload.attachments?.[0] || {};
  return { token: data.upload.token, url: a.content_url || null, name: a.file_name || file, type: a.content_type || type, size: a.size || buf.length, inline: !!a.inline };
}
