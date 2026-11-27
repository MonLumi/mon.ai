// One ordered timeline of an incident across sources, to narrow down the window before digging into
// Azure / Cloudflare / Front Door data: Site24x7 (when users saw the site down), Squadcast (Azure Monitor
// alerts on the resources) and Zendesk (when the customer reported it). Each source fails on its own:
// a missing sign-in becomes a note (with the sign-in card marker), the others still come back.
import { db } from './db.js';
import { monitoringTerms } from './config.js';
import * as site24x7 from './site24x7.js';
import * as squadcast from './squadcast.js';

const H = 3600_000;
const TZ = 'Australia/Sydney';
const local = (ms) => new Intl.DateTimeFormat('en-AU', { timeZone: TZ, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms);
const utc = (ms) => new Date(ms).toISOString().replace(/:\d\d\.\d+Z$/, 'Z');
const toMs = (v) => {
  if (v == null || v === '') return NaN;
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  return Date.parse(String(v).replace(/([+-]\d\d)(\d\d)$/, '$1:$2')); // 2026-11-27T10:00:00+1000 → +10:00
};

export function parseWindow({ from, to, hours }, fallbackHours = 24) {
  const end = to ? new Date(toMs(to)) : new Date();
  const start = from ? new Date(toMs(from)) : new Date(end.getTime() - (hours || fallbackHours) * H);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) throw new Error('from / to must be ISO 8601 times, e.g. 2026-11-27T02:00:00Z');
  if (start >= end) throw new Error('from must be before to');
  return { from: start, to: end };
}

/** Outages of the monitor(s) for ONE site (host or search text), or one monitor ID. At most `max` monitors. */
export async function siteOutages({ host, monitorId, from, to, max = 3 }) {
  let monitors;
  if (monitorId) monitors = [{ id: String(monitorId), name: `monitor ${monitorId}`, groups: [] }];
  else {
    if (!host) throw new Error('Pass the affected host (e.g. www.example.com) or a monitorId: Site24x7 is checked for one site, never all monitors.');
    monitors = site24x7.findMonitors(await site24x7.currentStatus(), host);
  }
  const capped = monitors.slice(0, max);
  const results = await Promise.all(capped.map(async (m) => {
    try { return { monitor: m, outages: await site24x7.outages(m.id, from, to) }; } catch (e) {
      if (/sign-in/i.test(e.message)) throw e;
      return { monitor: m, error: e.message.split('\n')[0] };
    }
  }));
  return { monitors: monitors.length, checked: capped.length, others: monitors.slice(max, max + 10).map((m) => `${m.name} (${m.id})`), results };
}

export async function squadIncidents({ org, from, to, status }) {
  let serviceIds = [];
  let matched = null;
  if (org) {
    const all = await squadcast.services();
    matched = squadcast.matchServices(all, monitoringTerms(org));
    if (matched.length && matched.length < all.length) serviceIds = matched.map((s) => s.id);
  }
  let list = await squadcast.incidents({ from, to, serviceIds, status: status || [] });
  // No service named after the client: fall back to matching the incident text.
  if (org && !serviceIds.length) {
    const t = monitoringTerms(org).map((x) => String(x).toLowerCase()).filter((x) => x.length >= 2);
    list = list.filter((i) => t.some((x) => `${i.title} ${i.service} ${i.description}`.toLowerCase().includes(x)));
  }
  return { services: matched?.map((s) => s.name) ?? null, incidents: list };
}

/**
 * Build the timeline. `ticket` (a Zendesk ID) gives the client and an anchor: the window then defaults
 * to 24 h before the ticket was created up to 2 h after.
 */
export async function incidentTimeline({ org, host, ticket, from, to, hours }) {
  let anchor = null;
  if (ticket) {
    const row = db.prepare('SELECT id, org, subject, created_at FROM tickets WHERE id = ?').get(Number(ticket));
    if (!row) throw new Error(`Ticket #${ticket} is not in the local sync: pass org and from / to instead.`);
    org ||= row.org;
    anchor = { id: row.id, subject: row.subject, at: toMs(row.created_at) };
  }
  const win = anchor && !from && !to
    ? { from: new Date(anchor.at - 24 * H), to: new Date(Math.min(Date.now(), anchor.at + 2 * H)) }
    : parseWindow({ from, to, hours });

  const events = [];
  const notes = [];
  const fail = (src, e) => notes.push(e.message.startsWith(src) ? e.message : `${src}: ${e.message}`);

  const jobs = [];
  if (site24x7.isConfigured() && !host) notes.push('Site24x7: skipped, no host given. Pass host (the affected site, e.g. www.example.com) to include its external checks.');
  else if (site24x7.isConfigured()) {
    jobs.push(siteOutages({ host, from: win.from, to: win.to }).then((r) => {
      if (!r.monitors) notes.push(`Site24x7: no monitor is named after ${host}. Try site24x7_monitors with another part of the name (domain without www, client name).`);
      else notes.push(`Site24x7: checked ${r.results.map((x) => `${x.monitor.name} (${x.monitor.id}, now ${x.monitor.status})`).join('; ')}${r.others.length ? `. Also matching: ${r.others.join('; ')}` : ''}`);
      for (const x of r.results) {
        if (x.error) { notes.push(`Site24x7 ${x.monitor.name}: ${x.error}`); continue; }
        for (const o of x.outages) {
          // An outage that began before the window starts at its real start time.
          const s = toMs(o.startedAt || o.start), e = toMs(o.end);
          const ongoing = Number.isFinite(e) && Math.abs(e - win.to.getTime()) < 5 * 60_000 && x.monitor.status && x.monitor.status !== 'up';
          events.push({ at: s, end: Number.isFinite(e) && !ongoing ? e : null, source: 'Site24x7', kind: ongoing ? `${o.type || 'down'} (ongoing)` : String(o.type || 'down'),
            what: `${x.monitor.name}${o.reason ? `: ${o.reason}` : ''}`, monitorId: x.monitor.id });
        }
      }
    }).catch((e) => fail('Site24x7', e)));
  } else notes.push('Site24x7: not set up (Settings > General).');

  if (squadcast.isConfigured() && !org) notes.push('Squadcast: skipped, no client given. Pass org (or a ticket) to include its Azure Monitor alerts.');
  else if (squadcast.isConfigured()) {
    jobs.push(squadIncidents({ org, from: win.from, to: win.to }).then((r) => {
      // The same alert often fires again and again (flapping): one event per alert title, from its first
      // trigger to its last resolve (still open if any of them is), with how many times it fired.
      const groups = new Map();
      for (const i of r.incidents) {
        const s = toMs(i.triggeredAt);
        if (!Number.isFinite(s)) continue;
        const key = `${i.title}|${i.service}`;
        const g = groups.get(key) || { first: s, last: s, ends: [], open: false, count: 0, i };
        g.count++;
        if (s < g.first) { g.first = s; g.i = i; }
        g.last = Math.max(g.last, s);
        const e = toMs(i.resolvedAt);
        if (Number.isFinite(e)) g.ends.push(e); else g.open = true;
        groups.set(key, g);
      }
      for (const g of groups.values()) {
        const { i } = g;
        const resource = i.tags?.resource;
        events.push({ at: g.first, end: g.open || !g.ends.length ? null : Math.max(...g.ends), source: 'Squadcast', kind: g.open ? 'alert (open)' : 'alert',
          what: `${i.title || 'incident'}${i.service ? ` [${i.service}]` : ''}${resource && !String(i.title).includes(resource) ? ` on ${resource}` : ''}${i.alertSource ? ` via ${i.alertSource}` : ''}`
            + (g.count > 1 ? ` · fired ${g.count}×, last at ${utc(g.last)}` : ''),
          id: i.id, url: i.url, lastAt: g.last });
      }
    }).catch((e) => fail('Squadcast', e)));
  } else notes.push('Squadcast: no API token (Settings > General).');

  await Promise.all(jobs);

  if (org) {
    const rows = db.prepare('SELECT id, subject, created_at FROM tickets WHERE lower(org) = lower(?) AND created_at >= ? AND created_at <= ?')
      .all(org, win.from.toISOString(), win.to.toISOString());
    for (const r of rows) events.push({ at: toMs(r.created_at), end: null, source: 'Zendesk', kind: 'ticket', what: `#${r.id} ${r.subject}`, id: r.id });
    if (anchor && !rows.some((r) => r.id === anchor.id)) events.push({ at: anchor.at, end: null, source: 'Zendesk', kind: 'ticket', what: `#${anchor.id} ${anchor.subject}`, id: anchor.id });
  }

  const valid = events.filter((e) => Number.isFinite(e.at)).sort((a, b) => a.at - b.at);
  // Suggested window: 30 min before the first outage / alert, to 15 min after the last one ended.
  // Tickets only bound it when there is nothing else (customers report late).
  const signals = valid.filter((e) => e.source !== 'Zendesk');
  let suggested = null;
  if (signals.length) {
    const s = Math.min(...signals.map((e) => e.at)) - 30 * 60_000;
    // An event without an end is still open (or its end is unknown): count up to now, at most 2 h.
    const e = Math.max(...signals.map((x) => x.end ?? Math.min(Date.now(), (x.lastAt ?? x.at) + (x.lastAt ? 30 * 60_000 : 2 * H)))) + 15 * 60_000;
    suggested = { from: utc(s), to: utc(Math.min(e, Date.now())), local: `${local(s)} – ${local(Math.min(e, Date.now()))} (${TZ})`, basis: `${signals.length} outage/alert event(s)` };
  }
  return {
    org: org || null, ticket: anchor ? anchor.id : null,
    searched: { from: utc(win.from.getTime()), to: utc(win.to.getTime()), local: `${local(win.from.getTime())} – ${local(win.to.getTime())} (${TZ})` },
    suggestedWindow: suggested,
    events: valid.slice(0, 80).map((e) => ({
      at: utc(e.at), local: local(e.at), source: e.source, kind: e.kind, what: e.what,
      ...(e.end ? { until: utc(e.end), minutes: Math.round((e.end - e.at) / 60_000) } : {}),
      ...(e.acknowledged ? { acknowledged: e.acknowledged } : {}), ...(e.url ? { url: e.url } : {}), ...(e.monitorId ? { monitorId: e.monitorId } : {}),
    })),
    ...(valid.length > 80 ? { truncated: valid.length - 80 } : {}),
    notes,
  };
}
