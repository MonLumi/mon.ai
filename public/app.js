import { marked } from '/vendor/marked.js';
import DOMPurify from '/vendor/purify.js';
import { chartCards } from '/charts.js';
// mon.ai front end: vanilla JS, hash routing, live updates over SSE.
const $ = (sel, el = document) => el.querySelector(sel);
const view = $('#view');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: opts.body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 3200);
}

// ---- Windows notifications when an AI reply finishes while you are looking elsewhere ----
const notifyOn = () => { try { return localStorage.getItem('mon.notify') !== 'off'; } catch { return true; } };
const browserNotify = () => 'Notification' in window && window.isSecureContext;
/** Ask once for permission (from a click / send, so the browser shows its prompt). */
function askNotifyPermission() {
  if (notifyOn() && browserNotify() && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
}
const plainText = (md) => String(md || '').replace(/```[\s\S]*?```/g, ' [code] ').replace(/[#>*_`~|[\]]+/g, '').replace(/\(https?:[^)]+\)/g, '').replace(/\s+/g, ' ').trim();
/**
 * Show a Windows notification for a finished reply, unless you are already looking at that chat.
 * Uses the browser's notification (a Windows toast, click opens the chat); when that is not
 * available (plain http, permission blocked) mon.ai shows a native Windows toast instead.
 */
function notifyReply({ chatId, title, text, error, looking, force = false }) {
  if (!force && (!notifyOn() || (looking && document.visibilityState === 'visible' && document.hasFocus()))) return;
  const head = `${error ? '⚠ ' : ''}mon.ai · ${title || 'Chat'}`;
  const body = (plainText(text).slice(0, 180) || (error ? `Stopped: ${plainText(error).slice(0, 150)}` : 'The reply is ready.'));
  if (browserNotify() && Notification.permission === 'granted') {
    const n = new Notification(head, { body, tag: `mon-chat-${chatId}`, icon: document.querySelector('link[rel=icon]')?.href });
    n.onclick = () => { window.focus(); if (chatId) location.hash = `#/chat/${chatId}`; n.close(); };
    return;
  }
  api('/api/notify', { method: 'POST', body: { title: head, body, chatId } }).catch(() => {});
}
const ago = (iso) => {
  if (!iso) return '';
  const m = (Date.now() - new Date(iso)) / 60000;
  if (m < 1) return 'just now'; if (m < 60) return `${Math.round(m)}m ago`;
  if (m < 2880) return `${Math.round(m / 60)}h ago`; return `${Math.round(m / 1440)}d ago`;
};

// ---------------- state ----------------
const state = { orgs: [], sessions: [], expanded: new Set(JSON.parse(localStorage.getItem('mon.expanded') || '[]')), route: {}, showAllOrgs: localStorage.getItem('mon.showAllOrgs') === '1' };
const ACTIVE_CHAT_DAYS = 14;

// ---------------- sidebar ----------------
async function loadSidebar() {
  try { [state.orgs, state.sessions] = await Promise.all([api('/api/orgs'), api('/api/sessions')]); } catch { return; }
  const general = state.sessions.filter((s) => s.org === 'All');
  const orgNames = new Set(state.orgs.map((o) => o.org));
  for (const s of state.sessions) if (s.org !== 'All' && !orgNames.has(s.org)) state.orgs.push({ org: s.org, open: 0, attention: 0 });
  const r = state.route;
  trackCooldown(state.sessions);
  const isActive = (s) => (r.name === 'chat' && r.id === s.id) || (r.name === 'ticket' && (r.sub === s.id || (!r.sub && Number(r.id) === s.ticket_id)));
  // Chats whose ticket waits on the customer (Pending / On-hold) cool down: dimmed, at the bottom of
  // their client. When the customer replies, Zendesk reopens the ticket and the chat comes back, marked.
  const rank = (s) => (cooldown.back.has(s.id) ? -1 : isCool(s) ? 1 : 0); // back from cooldown first, cooled last
  const sessionLinks = (list) => [...list.slice(0, 15)].sort((a, b) => rank(a) - rank(b)).map((s) => {
    const cool = isCool(s), back = cooldown.back.has(s.id) && !isActive(s);
    const manual = cool && manualCool(s) && !['pending', 'hold'].includes(s.ticket_status);
    const tip = manual ? `${s.title}\nCooled down by you${s.ticket_id ? ': comes back when someone else updates the ticket' : ''}. End it from the chat's ⋯ menu.`
      : cool ? `${s.title}\nTicket is ${s.ticket_status === 'hold' ? 'on hold' : 'pending'}: waiting on the customer / third party. It comes back here when they reply.`
      : back ? `${s.title}\nBack from cooldown: the ticket has a new update` : s.title;
    const tag = manual ? '❄' : s.ticket_status === 'hold' ? 'hold' : 'pending';
    return `<div class="sess-row ${isActive(s) ? 'active' : ''} ${cool ? 'cool' : ''} ${back ? 'back' : ''}">${back ? '<span class="sess-dot" aria-label="New update"></span>' : ''}<a href="#/chat/${s.id}" title="${esc(tip)}">${esc(s.title)}</a>${cool ? `<span class="sess-cool" title="${esc(tip)}">${tag}</span>` : ''}
      <button class="sess-del" data-del-session="${s.id}" title="Delete (moves it to the Archive)" aria-label="Delete chat ${esc(s.title)}"><svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M9 3h6l1 2h4v2H4V5h4l1-2zm-3 6h12l-1 12H7L6 9zm4 2v8h2v-8h-2zm4 0v8h2v-8h-2z"/></svg></button></div>`;
  }).join('');
  $('#orgList').innerHTML = [
    general.length ? `<div class="org"><div class="org-row" data-toggle="All"><span class="caret">${state.expanded.has('All') ? '▾' : '▸'}</span><span class="name">General chats</span><span class="count">${general.length}</span></div>
      ${state.expanded.has('All') ? `<div class="org-sessions">${sessionLinks(general)}</div>` : ''}</div>` : '',
    ...visibleOrgs().map((o) => {
      const sess = state.sessions.filter((s) => s.org === o.org);
      const open = state.expanded.has(o.org);
      return `<div class="org">
        <div class="org-row ${r.name === 'org' && r.id === o.org ? 'active' : ''}" data-org="${esc(o.org)}">
          <span class="caret" data-toggle="${esc(o.org)}">${sess.length ? (open ? '▾' : '▸') : ''}</span>
          <span class="name">${esc(o.org)}</span>
          ${o.attention ? `<span class="count hot" title="Tickets needing attention">${o.attention}</span>` : ''}
          <span class="count" title="Open tickets">${o.open}</span>
        </div>
        ${open && sess.length ? `<div class="org-sessions">${sessionLinks(sess)}</div>` : ''}
      </div>`;
    }),
  ].join('') || '<div class="sub" style="padding:8px 12px">No active clients: nothing open and no recent chats.</div>';
  const hidden = state.orgs.length - visibleOrgs().length;
  if (state.showAllOrgs || hidden > 0) {
    $('#orgList').insertAdjacentHTML('beforeend', `<button class="org-more" id="orgMore">${state.showAllOrgs ? 'Show active clients only' : `Show all clients (${hidden} more)`}</button>`);
    $('#orgMore').onclick = () => {
      state.showAllOrgs = !state.showAllOrgs;
      try { localStorage.setItem('mon.showAllOrgs', state.showAllOrgs ? '1' : '0'); } catch { /* ignore */ }
      loadSidebar();
    };
  }
}

/** Ticket chat in cooldown: its ticket waits on someone else and nobody is waiting on me. */
// …or you cooled it down yourself (⋯ menu), until someone else updates the ticket after that.
const coolEnded = (s) => !!s.ticket_id && !!s.ticket_updated_at && s.ticket_updated_at > s.cooled_at && s.ticket_updated_at !== s.ticket_my_update_at;
const manualCool = (s) => !!s.cooled_at && !coolEnded(s);
const isCool = (s) => manualCool(s) || (!!s.ticket_id && ['pending', 'hold'].includes(s.ticket_status) && !s.ticket_needs_me);
/** Chat page: is this chat cooled down by you? (ticket details come from the sidebar's list) */
const chatCooled = (s) => manualCool({ ...(state.sessions.find((x) => x.id === s.id) || {}), ticket_id: s.ticket_id, cooled_at: s.cooled_at });
// Which chats were cooled down, and which came back since (shown with a dot until you open them).
const cooldown = (() => {
  const load = (k) => { try { return new Set(JSON.parse(localStorage.getItem(k) || '[]')); } catch { return new Set(); } };
  return { cooled: load('mon.cooled'), back: load('mon.back') };
})();
/** You ended the cooldown yourself (menu, or by sending a message): no "is back" marker. */
function forgetCooldown(id) {
  cooldown.cooled.delete(id); cooldown.back.delete(id);
  try { localStorage.setItem('mon.cooled', JSON.stringify([...cooldown.cooled])); localStorage.setItem('mon.back', JSON.stringify([...cooldown.back])); } catch { /* storage unavailable */ }
}
function trackCooldown(sessions) {
  const ids = new Set(sessions.map((s) => s.id));
  const r = state.route;
  for (const s of sessions) {
    if (!s.ticket_id || !s.ticket_status) continue;
    if (isCool(s)) { cooldown.cooled.add(s.id); cooldown.back.delete(s.id); }
    else if (cooldown.cooled.delete(s.id) && s.ticket_status !== 'solved' && s.ticket_status !== 'closed') {
      cooldown.back.add(s.id);
      toast(`#${s.ticket_id} is back: new update, needs you again`);
    }
  }
  // Opening the chat (or its ticket workspace) clears the marker; forget chats that are gone.
  for (const id of [...cooldown.back]) {
    const s = sessions.find((x) => x.id === id);
    if (!ids.has(id) || (r.name === 'chat' && r.id === id) || (r.name === 'ticket' && (r.sub === id || (!r.sub && s && Number(r.id) === s.ticket_id)))) cooldown.back.delete(id);
  }
  for (const id of [...cooldown.cooled]) if (!ids.has(id)) cooldown.cooled.delete(id);
  try { localStorage.setItem('mon.cooled', JSON.stringify([...cooldown.cooled])); localStorage.setItem('mon.back', JSON.stringify([...cooldown.back])); } catch { /* storage unavailable */ }
}

/** Active client = has open tickets, or a chat in the last two weeks (or is the page you're on). */
function visibleOrgs() {
  if (state.showAllOrgs) return state.orgs;
  const since = Date.now() - ACTIVE_CHAT_DAYS * 864e5;
  const recent = new Set(state.sessions.filter((x) => new Date(x.updated_at) >= since).map((x) => x.org));
  return state.orgs.filter((o) => o.open > 0 || recent.has(o.org) || (state.route.name === 'org' && state.route.id === o.org));
}
$('#orgList').addEventListener('click', async (e) => {
  // Delete a chat: moves it to the Archive (the recycle bin), where Restore brings it back.
  const del = e.target.closest('[data-del-session]');
  if (del) {
    e.preventDefault();
    e.stopPropagation();
    const id = del.dataset.delSession;
    try {
      await api(`/api/sessions/${id}`, { method: 'DELETE' });
      toast('Moved to the Archive (Assistant › Archive to restore)');
      if (state.route.name === 'chat' && state.route.id === id) location.hash = '#/chat';
      else if (state.route.name === 'ticket' && state.route.sub === id) location.hash = `#/ticket/${state.route.id}`;
      else loadSidebar();
    } catch (err) { toast(err.message); }
    return;
  }
  const toggle = e.target.closest('[data-toggle]');
  if (toggle) {
    const k = toggle.dataset.toggle;
    state.expanded.has(k) ? state.expanded.delete(k) : state.expanded.add(k);
    localStorage.setItem('mon.expanded', JSON.stringify([...state.expanded]));
    loadSidebar();
    return;
  }
  const row = e.target.closest('[data-org]');
  if (row) location.hash = `#/org/${encodeURIComponent(row.dataset.org)}`;
});
// Left sidebar: docked or hidden, remembered.
const setNav = (hidden) => {
  $('#layout').classList.toggle('nav-hidden', hidden);
  try { localStorage.setItem('mon.nav', hidden ? 'hide' : 'dock'); } catch { /* ignore */ }
};
try { if (localStorage.getItem('mon.nav') === 'hide') $('#layout').classList.add('nav-hidden'); } catch { /* ignore */ }
$('#navHide').onclick = () => setNav(true);
$('#navShow').onclick = () => setNav(false);
// Left sidebar width: drag its right edge (remembered); dragging it nearly shut hides it.
(() => {
  const layout = $('#layout'), grip = $('#navResize');
  const setW = (w) => { if (w) layout.style.setProperty('--nav-w', `${w}px`); else layout.style.removeProperty('--nav-w'); };
  try { setW(Number(localStorage.getItem('mon.navW')) || 0); } catch { /* ignore */ }
  if (!grip) return;
  grip.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    try { grip.setPointerCapture(e.pointerId); } catch { /* lost pointer */ }
    const left = layout.getBoundingClientRect().left;
    let w = null, raw = null;
    layout.classList.add('nav-resizing');
    const move = (ev) => { raw = ev.clientX - left; w = Math.round(Math.min(440, Math.max(170, raw))); setW(w); };
    const up = () => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      layout.classList.remove('nav-resizing');
      if (raw !== null && raw < 110) { setNav(true); return; }
      if (w) try { localStorage.setItem('mon.navW', String(w)); } catch { /* ignore */ }
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
  });
  grip.addEventListener('dblclick', () => { setW(0); try { localStorage.removeItem('mon.navW'); } catch { /* ignore */ } });
})();
$('#newChatBtn').onclick = () => newChat(state.route.name === 'org' ? state.route.id : null);

async function loadClaudeBadge() {
  const el = $('#claudeBadge');
  try {
    const a = await api('/api/claude/auth');
    el.innerHTML = a.loggedIn
      ? `Claude: <b>${esc(a.email || 'signed in')}</b><br>${esc(a.org || '')} ${a.plan ? `· ${esc(a.plan)}` : ''}<div class="usage" id="claudeUsage"></div>`
      : `Claude: <b>not signed in</b> · <a href="#/settings/claude">Sign in</a>`;
  } catch { el.textContent = 'Claude: status unavailable'; }
}

// ---- plan usage meter under the account: session (5-hour window) and weekly (7-day window)
let usageData = null;
const untilText = (iso) => {
  if (!iso) return '';
  const ms = new Date(iso) - Date.now();
  if (ms <= 0) return 'resetting';
  const h = Math.floor(ms / 36e5), m = Math.round((ms % 36e5) / 6e4);
  if (h >= 24) return `resets ${new Date(iso).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`;
  return `resets in ${h ? `${h}h ` : ''}${m}m`;
};
function drawUsage() {
  const el = $('#claudeUsage');
  if (!el || !usageData) return;
  if (!usageData.available) { el.innerHTML = '<div class="usage-note">Plan usage is not available for this sign-in.</div>'; return; }
  const bar = (label, w, tip) => {
    if (!w || w.pct === null || w.pct === undefined) return '';
    const pct = Math.max(0, Math.min(100, Math.round(w.pct)));
    return `<div class="usage-row" title="${esc(tip)}${w.resetsAt ? ` · ${esc(new Date(w.resetsAt).toLocaleString())}` : ''}">
      <span class="usage-label">${label}</span><span class="usage-bar"><i class="${pct >= 80 ? 'hi' : pct >= 50 ? 'mid' : ''}" style="width:${pct}%"></i></span><span class="usage-pct">${pct}%</span>
      <span class="usage-reset">${esc(untilText(w.resetsAt))}</span></div>`;
  };
  el.innerHTML = bar('Session', usageData.session, 'Current 5-hour session')
    + bar('Weekly', usageData.weekly, 'All models, this week')
    + usageData.models.map((m) => bar(esc(m.name), m, `${m.name} this week`)).join('');
  el.title = `Checked ${ago(usageData.checkedAt)} · click for the usage breakdown`;
  if (state.route.name === 'usage') drawPlanCard();
}
async function loadUsage(fresh = false) {
  try { usageData = await api(`/api/claude/usage${fresh ? '?fresh=1' : ''}`); drawUsage(); } catch { /* not signed in or Claude busy: keep the last numbers */ }
}
document.addEventListener('click', (e) => { if (e.target.closest('#claudeUsage')) location.hash = '#/usage'; });
setInterval(() => { if (!document.hidden) loadUsage(); }, 5 * 60_000); // Claude Code elsewhere uses the same plan
setInterval(drawUsage, 60_000); // keep "resets in" current

async function newChat(org, opts = {}) {
  const s = await api('/api/sessions', { method: 'POST', body: { org: org || undefined, ...opts } });
  if (org) state.expanded.add(s.org);
  location.hash = `#/chat/${s.id}`;
  return s;
}

// ---------------- confirm dialog (instead of the browser's confirm) ----------------
/**
 * Centered dialog over a dimmed page. rows: [[label, html]] listing what will happen.
 * Resolves true for OK, false for Cancel / Esc / clicking outside.
 */
function confirmDialog({ title, intro = '', rows = [], ok = 'OK', cancel = 'Cancel', danger = false, choices = null }) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'modal-wrap';
    wrap.innerHTML = `<div class="modal" role="alertdialog" aria-modal="true" aria-labelledby="mdTitle">
      <h2 id="mdTitle">${esc(title)}</h2>
      ${intro ? `<div class="modal-intro">${intro}</div>` : ''}
      ${rows.length ? `<dl class="modal-rows">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>` : ''}
      <div class="modal-actions"><button class="btn" data-md="0">${esc(cancel)}</button>${choices
        ? choices.map((c) => `<button class="btn ${c.cls || ''}" data-md="${esc(c.value)}" ${c.title ? `title="${esc(c.title)}"` : ''}>${esc(c.label)}</button>`).join('')
        : `<button class="btn ${danger ? 'danger-solid' : 'primary'}" data-md="1">${esc(ok)}</button>`}</div>
    </div>`;
    const prev = document.activeElement;
    const done = (v) => { document.removeEventListener('keydown', key, true); wrap.remove(); prev?.focus?.(); resolve(v); };
    const key = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); }
      else if (e.key === 'Tab') { // keep focus on the two buttons
        const b = [...wrap.querySelectorAll('button')];
        const i = b.indexOf(document.activeElement);
        e.preventDefault();
        b[(i + (e.shiftKey ? -1 : 1) + b.length) % b.length].focus();
      }
    };
    wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) done(false); });
    wrap.addEventListener('click', (e) => { const b = e.target.closest('[data-md]'); if (b) done(choices ? (b.dataset.md === '0' ? false : b.dataset.md) : b.dataset.md === '1'); });
    document.addEventListener('keydown', key, true);
    document.body.append(wrap);
    (choices ? wrap.querySelector('.modal-actions .btn:nth-child(2)') : wrap.querySelector('[data-md="1"]')).focus();
  });
}

// ---------------- rich text editor (Zendesk-style formatting for replies and notes) ----------------
// Tags Zendesk keeps in a comment; everything else is stripped on paste and before sending.
const RTE_TAGS = ['p', 'br', 'div', 'span', 'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'del', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li', 'a', 'h1', 'h2', 'h3', 'h4', 'hr', 'font', 'table', 'thead', 'tbody', 'tr', 'th', 'td'];
const RTE_ATTR = ['href', 'class', 'style', 'color', 'colspan', 'rowspan'];
const rteClean = (html) => DOMPurify.sanitize(html, { ALLOWED_TAGS: RTE_TAGS, ALLOWED_ATTR: RTE_ATTR, ALLOWED_URI_REGEXP: /^(https?:|mailto:|\/users\/\d+$)/i });
/** Text with a Markdown table in it (a | --- | --- | separator line), e.g. a draft copied as plain text. */
const MD_TABLE = /^ *\|?(?: *:?-{3,}:? *\|)+ *(?::?-{3,}:?)? *\|? *$/m;
const TABLE_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3.5" y="4.5" width="17" height="15" rx="1.5"/><path d="M3.5 9.5h17M3.5 14.5h17M9.5 9.5v10M15 9.5v10"/></svg>';

// ---- tables in the editor. Formatting is kept as inline styles and colspan / rowspan, which is what
// survives into Zendesk's html_body (no classes). Merged cells are handled through a grid of [row][col] → cell.
const TBL_HEAD_BG = '#f3f4f6';
const TBL_SHADES = [['#f3f4f6', 'Grey'], ['#dbeafe', 'Blue'], ['#dcfce7', 'Green'], ['#fef9c3', 'Yellow'], ['#ffedd5', 'Orange'], ['#fee2e2', 'Red'], ['#ede9fe', 'Purple']];
// Inline styles a table may keep (on paste, in drafts, in posted comments); everything else is dropped.
const TBL_STYLE = { TD: ['text-align', 'vertical-align', 'background-color', 'width', 'height'], TH: ['text-align', 'vertical-align', 'background-color', 'width', 'height'], TABLE: ['width'], SPAN: ['color'] };
function keepStyles(n) {
  const props = TBL_STYLE[n.nodeName] || [];
  const kept = props.map((k) => [k, n.style.getPropertyValue(k)]).filter(([, v]) => v);
  n.removeAttribute('style');
  for (const [k, v] of kept) n.style.setProperty(k, v);
  if (!n.getAttribute('style')) n.removeAttribute('style');
}
function tblStyle(el, prop, v) {
  if (v) el.style.setProperty(prop, v); else el.style.removeProperty(prop);
  if (!el.getAttribute('style')?.trim()) el.removeAttribute('style');
}
const sameColor = (a, b) => { const x = document.createElement('i'); x.style.color = a; const y = x.style.color; x.style.color = b; return !!y && y === x.style.color; };
/** grid[r][c] = the cell covering that slot (a merged cell appears in every slot it covers). */
function tblGrid(table) {
  const g = [], n = table.rows.length;
  [...table.rows].forEach((tr, r) => {
    g[r] = g[r] || [];
    let c = 0;
    for (const cell of tr.cells) {
      while (g[r][c]) c++;
      for (let i = 0; i < Math.max(1, cell.rowSpan) && r + i < n; i++) for (let j = 0; j < Math.max(1, cell.colSpan); j++) (g[r + i] = g[r + i] || [])[c + j] = cell;
      c += Math.max(1, cell.colSpan);
    }
  });
  return g;
}
function tblPos(g, cell) {
  for (let r = 0; r < g.length; r++) {
    const c = g[r].indexOf(cell);
    if (c !== -1) return { r, c, r1: r + Math.max(1, cell.rowSpan) - 1, c1: c + Math.max(1, cell.colSpan) - 1 };
  }
  return null;
}
const tblWidth = (g) => Math.max(0, ...g.map((row) => row.length));
function tblNewCell(tag) {
  const c = document.createElement(tag);
  c.append(document.createElement('br'));
  if (tag === 'th') c.style.backgroundColor = TBL_HEAD_BG;
  return c;
}
/** Put `cell` in row r at grid column x: before the first cell of that row that starts at or after x. */
function tblPlace(table, g, r, x, cell) {
  const tr = table.rows[r];
  tr.insertBefore(cell, [...tr.cells].find((c) => tblPos(g, c)?.c >= x) || null);
}
function tblRename(cell, tag) {
  if (cell.tagName.toLowerCase() === tag) return cell;
  const n = document.createElement(tag);
  for (const a of cell.attributes) n.setAttribute(a.name, a.value);
  n.append(...cell.childNodes);
  cell.replaceWith(n);
  return n;
}
function tblShadeHead(cell, on) {
  if (on && !cell.style.backgroundColor) cell.style.backgroundColor = TBL_HEAD_BG;
  else if (!on && sameColor(cell.style.backgroundColor, TBL_HEAD_BG)) tblStyle(cell, 'background-color', '');
}
const isHeadRow = (table) => !!table.rows[0]?.cells.length && [...table.rows[0].cells].every((c) => c.tagName === 'TH');
function isHeadCol(table) {
  const g = tblGrid(table), rows = isHeadRow(table) ? g.slice(1) : g;
  return rows.length > 0 && rows.every((row) => row[0]?.tagName === 'TH');
}
/** Drop empty rows and sections, and colspan / rowspan of 1. False when nothing is left. */
function tblTidy(table) {
  for (let i = table.rows.length - 1; i >= 0; i--) {
    if (table.rows[i].cells.length) continue;
    new Set(tblGrid(table)[i] || []).forEach((c) => { if (c && c.rowSpan > 1) c.rowSpan -= 1; });
    table.rows[i].remove();
  }
  for (const s of [table.tHead, ...table.tBodies]) if (s && !s.rows.length) s.remove();
  for (const c of table.querySelectorAll('th, td')) {
    if (c.colSpan <= 1) c.removeAttribute('colspan');
    if (c.rowSpan <= 1) c.removeAttribute('rowspan');
  }
  return table.rows.length > 0;
}
function tblInsertRow(table, y) {
  const g = tblGrid(table), tr = document.createElement('tr'), done = new Set();
  const head = y === 0 && isHeadRow(table), headCol = isHeadCol(table);
  for (let x = 0; x < tblWidth(g); x++) {
    const above = g[y - 1]?.[x], below = g[y]?.[x];
    if (above && above === below) { if (!done.has(above)) { above.rowSpan += 1; done.add(above); } continue; } // a merged cell spans the new row
    tr.append(tblNewCell(head || (headCol && x === 0) ? 'th' : 'td'));
  }
  const ref = table.rows[y], last = table.rows[y - 1];
  if (ref) ref.before(tr);
  else if (last?.parentElement.tagName === 'THEAD') (table.tBodies[0] || table.createTBody()).append(tr);
  else if (last) last.after(tr);
  else (table.tBodies[0] || table.createTBody()).append(tr);
}
function tblInsertCol(table, x) {
  const g = tblGrid(table), done = new Set();
  [...table.rows].forEach((tr, r) => {
    const left = g[r][x - 1], right = g[r][x];
    if (left && left === right) { if (!done.has(left)) { left.colSpan += 1; done.add(left); } return; }
    tblPlace(table, g, r, x, tblNewCell((right || left)?.tagName === 'TH' ? 'th' : 'td'));
  });
}
function tblDeleteRow(table, y) {
  const g = tblGrid(table), done = new Set(), tr = table.rows[y];
  for (const c of g[y] || []) {
    if (!c || done.has(c)) continue;
    done.add(c);
    if (c.rowSpan <= 1) continue; // goes with the row
    const p = tblPos(g, c);
    c.rowSpan -= 1;
    if (p.r === y) { // a merged cell that starts here moves down to the next row
      const next = table.rows[y + 1];
      next.insertBefore(c, [...next.cells].find((n) => tblPos(g, n).c > p.c) || null);
    }
  }
  tr.remove();
  return tblTidy(table);
}
function tblDeleteCol(table, x) {
  const g = tblGrid(table), done = new Set();
  for (const row of g) {
    const c = row[x];
    if (!c || done.has(c)) continue;
    done.add(c);
    if (c.colSpan > 1) c.colSpan -= 1; else c.remove();
  }
  return tblTidy(table);
}
/** Merge the cells into one (the smallest rectangle that holds them all); their contents are kept, one per line. */
function tblMerge(table, cells) {
  const g = tblGrid(table);
  let ps = cells.map((c) => tblPos(g, c)).filter(Boolean);
  let r0 = Math.min(...ps.map((p) => p.r)), r1 = Math.max(...ps.map((p) => p.r1)), c0 = Math.min(...ps.map((p) => p.c)), c1 = Math.max(...ps.map((p) => p.c1));
  for (let grew = true; grew;) { // grow the box until no merged cell sticks out of it
    grew = false;
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
      const p = g[r]?.[c] && tblPos(g, g[r][c]);
      if (!p) return null; // ragged table: nothing to merge with
      if (p.r < r0 || p.r1 > r1 || p.c < c0 || p.c1 > c1) { r0 = Math.min(r0, p.r); r1 = Math.max(r1, p.r1); c0 = Math.min(c0, p.c); c1 = Math.max(c1, p.c1); grew = true; }
    }
  }
  const all = [];
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) if (!all.includes(g[r][c])) all.push(g[r][c]);
  if (all.length < 2) return all[0] || null;
  const keep = all[0];
  const filled = all.filter((c) => c.textContent.trim() || c.querySelector('img')).map((c) => [...c.childNodes]);
  keep.replaceChildren();
  filled.forEach((nodes, i) => { if (i) keep.append(document.createElement('br')); keep.append(...nodes); });
  if (!filled.length) keep.append(document.createElement('br'));
  for (const c of all.slice(1)) c.remove();
  keep.colSpan = c1 - c0 + 1;
  keep.rowSpan = r1 - r0 + 1;
  tblTidy(table);
  return keep;
}
/** Split a merged cell back into single cells (the new ones take its alignment and shading). */
function tblSplit(table, cell) {
  const g = tblGrid(table), p = tblPos(g, cell);
  if (!p || (p.r === p.r1 && p.c === p.c1)) return;
  const tag = cell.tagName.toLowerCase(), style = cell.getAttribute('style');
  for (let r = p.r; r <= p.r1; r++) {
    const frag = document.createDocumentFragment();
    for (let c = p.c; c <= p.c1; c++) {
      if (r === p.r && c === p.c) continue;
      const n = tblNewCell(tag);
      if (style) n.setAttribute('style', style);
      tblStyle(n, 'width', '');
      frag.append(n);
    }
    if (r === p.r) cell.after(frag);
    else { const tr = table.rows[r]; tr.insertBefore(frag, [...tr.cells].find((n) => tblPos(g, n)?.c > p.c) || null); }
  }
  cell.removeAttribute('colspan');
  cell.removeAttribute('rowspan');
}
function tblHeadRow(table, on) {
  const first = table.rows[0];
  if (!first) return;
  const headCol = isHeadCol(table);
  if (on) {
    if (first.parentElement.tagName !== 'THEAD') (table.tHead || table.createTHead()).append(first);
    [...first.cells].forEach((c) => tblShadeHead(tblRename(c, 'th'), true));
  } else {
    if (first.parentElement.tagName === 'THEAD') (table.tBodies[0] || table.createTBody()).prepend(first);
    [...first.cells].forEach((c, i) => { if (!(headCol && i === 0)) tblShadeHead(tblRename(c, 'td'), false); });
  }
  tblTidy(table);
}
function tblHeadCol(table, on) {
  const g = tblGrid(table), headRow = isHeadRow(table), done = new Set();
  g.forEach((row, r) => {
    const c = row[0];
    if (!c || done.has(c)) return;
    done.add(c);
    if (r === 0 && headRow) return;
    tblShadeHead(tblRename(c, on ? 'th' : 'td'), on);
  });
}
/** Markdown tables (drafts): alignment as a style Zendesk keeps, header cells shaded, no stray whitespace. */
function tblDefaults(html) {
  const t = document.createElement('template');
  t.innerHTML = String(html).replace(/>\s+<(\/?)(table|thead|tbody|tr|th|td)\b/g, '><$1$2');
  for (const c of t.content.querySelectorAll('th, td')) {
    const a = c.getAttribute('align');
    if (a) { c.style.textAlign = a; c.removeAttribute('align'); }
    if (c.tagName === 'TH' && !c.style.backgroundColor) c.style.backgroundColor = TBL_HEAD_BG;
  }
  return t.innerHTML;
}
const RTE_COLORS = ['#1f2937', '#6b7280', '#dc2626', '#ea580c', '#ca8a04', '#16a34a', '#0891b2', '#2563eb', '#7c3aed', '#db2777'];
const ICON = (d) => `<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="${d}"/></svg>`;
function rteToolbar() {
  const b = (cmd, title, icon, extra = '') => `<button type="button" class="rte-btn" data-cmd="${cmd}" title="${title}" ${extra}>${icon}</button>`;
  const sep = '<span class="rte-sep"></span>';
  return `<div class="rte-bar" role="toolbar" aria-label="Formatting">
    <select class="rte-block" data-cmd="block" title="Text style"><option value="p">Normal text</option><option value="h1">Heading 1</option><option value="h2">Heading 2</option><option value="h3">Heading 3</option><option value="h4">Heading 4</option></select>
    ${sep}
    ${b('bold', 'Bold (Ctrl+B)', '<b>B</b>')}${b('italic', 'Italic (Ctrl+I)', '<i>I</i>')}${b('underline', 'Underline (Ctrl+U)', '<u>U</u>')}${b('strikeThrough', 'Strikethrough', '<s>S</s>')}
    <span class="rte-color-wrap">${b('color', 'Text color', '<span class="rte-a">A</span>')}<div class="rte-colors" hidden>${RTE_COLORS.map((c) => `<button type="button" data-color="${c}" style="background:${c}" title="${c}"></button>`).join('')}</div></span>
    ${sep}
    ${b('insertUnorderedList', 'Bulleted list', ICON('M4 6.5a1.5 1.5 0 1 1 0 .01zM8 6h13v2H8zm-4 5.5a1.5 1.5 0 1 1 0 .01zM8 11h13v2H8zm-4 5.5a1.5 1.5 0 1 1 0 .01zM8 16h13v2H8z'))}
    ${b('insertOrderedList', 'Numbered list', ICON('M3 5h2v4H4V6H3zm0 7h3v1H4.5L6 14.5V15H3v-1l1.6-1.5H3zm0 5h3v4H3v-1h2v-.5H4v-1h1V18H3zM8 6h13v2H8zm0 5h13v2H8zm0 5h13v2H8z'))}
    ${b('outdent', 'Decrease indent', ICON('M3 4h18v2H3zm8 4h10v2H11zm0 4h10v2H11zm0 4h10v2H11zM3 20h18v2H3zM7 9v6l-4-3z'))}
    ${b('indent', 'Increase indent', ICON('M3 4h18v2H3zm8 4h10v2H11zm0 4h10v2H11zm0 4h10v2H11zM3 20h18v2H3zM3 9l4 3-4 3z'))}
    ${sep}
    ${b('quote', 'Quote', ICON('M7 7h4v4H8.5c0 2 1 3 2.5 3.5V17c-3-.5-5-2.8-5-6.5V7zm8 0h4v4h-2.5c0 2 1 3 2.5 3.5V17c-3-.5-5-2.8-5-6.5V7z'))}
    ${b('code', 'Code span', ICON('M8.6 16.6 4 12l4.6-4.6L10 8.8 6.8 12l3.2 3.2zm6.8 0L14 15.2l3.2-3.2L14 8.8l1.4-1.4L20 12z'))}
    ${b('codeblock', 'Code block', ICON('M4 3h16a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zm1 2v14h14V5zm4.4 10.6L6.8 13l2.6-2.6 1.1 1.1L9 13l1.5 1.5zm5.2 0-1.1-1.1L15 13l-1.5-1.5 1.1-1.1L17.2 13z'))}
    <span class="rte-tbl-wrap">${b('table', 'Table (Tab moves between cells)', TABLE_ICON)}<div class="rte-tbl-pop" hidden></div></span>
    ${b('link', 'Link (Ctrl+K)', ICON('M10.6 13.4a1 1 0 0 1 0-1.4l3.5-3.5a1 1 0 1 1 1.4 1.4L12 13.4a1 1 0 0 1-1.4 0zM8.5 19a4.5 4.5 0 0 1-3.2-7.7l2-2 1.4 1.4-2 2a2.5 2.5 0 0 0 3.6 3.6l2-2 1.4 1.4-2 2A4.5 4.5 0 0 1 8.5 19zm8.2-6.3-1.4-1.4 2-2a2.5 2.5 0 0 0-3.6-3.6l-2 2-1.4-1.4 2-2a4.5 4.5 0 0 1 6.4 6.4z'))}
    ${b('insertHorizontalRule', 'Horizontal rule', ICON('M3 11h18v2H3z'))}
    ${sep}
    ${b('removeFormat', 'Clear formatting', ICON('M6 5h12v3h-2V7h-3.2l-1.6 4.6-1.6-1.6L10.6 7H8v1H6zm-2.3-.3 1.4-1.4 16 16-1.4 1.4-6.4-6.4L11.8 19H9.7l1.9-5.4z'))}
  </div>`;
}
const rteHasContent = (ed) => !!ed.textContent.replace(/ /g, ' ').trim() || !!ed.querySelector('hr, img[data-zd-token]');
/** Tokens of the images pasted into the editor (already uploaded to Zendesk); sent with the comment. */
const rteUploads = (ed) => [...ed.querySelectorAll('img[data-zd-token]')].map((i) => i.dataset.zdToken);
const rteUploading = (ed) => !!ed.querySelector('img.uploading');
/**
 * Blank rows. Zendesk shows paragraphs with no gap between them, so an empty paragraph
 * (<p><br></p>, <p>&nbsp;</p>, <div><br></div>) is how a blank row between paragraphs is written:
 * keep one. Two or more in a row become one (one blank row, never two), and blank rows at the very
 * start or end are dropped.
 */
const BLANK_INSIDE = '(?:\\s|&nbsp;|\\u00a0|<br\\s*\\/?>)*';
const EMPTY_BLOCK = `(?:<p\\b[^>]*>${BLANK_INSIDE}<\\/p>|<div\\b[^>]*>${BLANK_INSIDE}<\\/div>)`;
const tidyBlankRows = (html) => String(html)
  .replace(new RegExp(`${EMPTY_BLOCK}(?:\\s*${EMPTY_BLOCK})+`, 'gi'), '<p><br></p>')
  .replace(new RegExp(`^(?:\\s*${EMPTY_BLOCK})+`, 'i'), '')
  .replace(new RegExp(`(?:${EMPTY_BLOCK}\\s*)+$`, 'i'), '');
/** Markdown drafts: one blank row between paragraphs, as you write them. */
const spaceParas = (html) => String(html).replace(/<\/p>\s*<p\b/gi, '</p><p><br></p><p');
/**
 * The editor's content as clean Zendesk comment HTML. Pasted images become <img src="Zendesk content_url">
 * (shown inline once their upload token goes with the comment); `preview` keeps the local copy for mon.ai's
 * own confirm dialog, since Zendesk URLs need your Zendesk sign-in. Images not uploaded are left out.
 */
function rteHtml(ed, { preview = false } = {}) {
  const c = ed.cloneNode(true);
  c.querySelectorAll('[contenteditable]').forEach((n) => n.removeAttribute('contenteditable'));
  c.querySelectorAll('.rte-cell-sel').forEach((n) => { n.classList.remove('rte-cell-sel'); if (!n.className) n.removeAttribute('class'); });
  c.querySelectorAll('img').forEach((img) => {
    if (!img.dataset.zdUrl || !img.dataset.zdToken) { img.remove(); return; }
    const n = document.createElement('img');
    n.src = preview ? img.src : img.dataset.zdUrl;
    n.alt = img.alt || '';
    img.replaceWith(n);
  });
  return tidyBlankRows(DOMPurify.sanitize(c.innerHTML, {
    ALLOWED_TAGS: [...RTE_TAGS, 'img'], ALLOWED_ATTR: [...RTE_ATTR, 'src', 'alt'],
    ALLOWED_URI_REGEXP: preview ? /^(https?:|mailto:|blob:|\/users\/\d+$)/i : /^(https?:|mailto:|\/users\/\d+$)/i,
  })).trim();
}
const RTE_IMG = /^image\/(png|jpeg|gif|webp|bmp)$/;
// URLs written as plain text, without trailing punctuation such as the full stop of a sentence:
// http(s)://…, www.…, or a bare domain (support.example.com/agent/tickets/1). A bare domain counts when it
// has a common TLD or a path after it, so file names like readme.md or node.js are left alone.
const RTE_TLDS = 'com|net|org|io|co|dev|app|ai|au|uk|vn|nz|sg|us|ca|de|fr|nl|jp|in|eu|info|biz|edu|gov|cloud|site|tech|me|ly|gg|tv|xyz|online|store|page|zendesk';
const RTE_URL = new RegExp(`(?<![@\\w.\\/:-])(?:https?:\\/\\/[^\\s<>"'\`]+|www\\.[^\\s<>"'\`]+|(?:[a-z0-9-]+\\.)+(?:[a-z]{2,24}(?=[/?#])|(?:${RTE_TLDS})(?![\\w-]))[^\\s<>"'\`]*)`, 'gi');
const rteTrimUrl = (u) => { let s = u.replace(/[.,;:!?'"]+$/, ''); while (/[)\]}]$/.test(s) && (s.split(/[([{]/).length < s.split(/[)\]}]/).length)) s = s.slice(0, -1).replace(/[.,;:!?'"]+$/, ''); return s; };
/** The text is one URL (or mailto:) and nothing else. */
const rteIsUrl = (s) => /^mailto:\S+$/i.test(s) || (() => { const m = s.match(RTE_URL); return m?.length === 1 && rteTrimUrl(m[0]) === s; })();
/** Link address for a URL as written: https:// is added when it has no scheme (the text shown stays as written). */
const rteHref = (u) => (/^(https?:\/\/|mailto:)/i.test(u) ? u : `https://${u}`);
/** Plain-text URLs in the editor (not already in a link, code or code block): [{ node, start, end, url }]. */
function rteBareUrls(ed) {
  const out = [];
  const walk = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.parentElement?.closest('a, code, pre, .atmention') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) });
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    for (const m of n.data.matchAll(RTE_URL)) {
      const url = rteTrimUrl(m[0]);
      if (url.length >= 4 && url.includes('.')) out.push({ node: n, start: m.index, end: m.index + url.length, url });
    }
  }
  return out;
}
/**
 * Insert / edit link dialog (instead of the browser's prompt): the link address and the text shown.
 * Resolves { url, text } to set the link, { remove: true } to remove it, or null when cancelled.
 */
function linkDialog({ url = '', text = '', editing = false } = {}) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'modal-wrap';
    wrap.innerHTML = `<form class="modal link-modal" role="dialog" aria-modal="true" aria-labelledby="lkTitle" novalidate>
      <h2 id="lkTitle">${editing ? 'Edit link' : 'Insert link'}</h2>
      <label class="lk-field"><span>Link</span><input name="url" type="text" autocomplete="off" spellcheck="false" placeholder="https://… or mailto:…" value="${esc(url)}"></label>
      <label class="lk-field"><span>Display text</span><input name="text" type="text" autocomplete="off" placeholder="Shown instead of the address (optional)" value="${esc(text)}"></label>
      <div class="lk-err" hidden></div>
      <div class="modal-actions">${editing ? '<button type="button" class="btn lk-remove" data-lk="remove">Remove link</button><span style="flex:1"></span>' : ''}<button type="button" class="btn" data-lk="cancel">Cancel</button><button type="submit" class="btn primary">${editing ? 'Save' : 'Insert'}</button></div>
    </form>`;
    const form = wrap.querySelector('form');
    const [uIn, tIn] = [form.querySelector('[name="url"]'), form.querySelector('[name="text"]')];
    const err = wrap.querySelector('.lk-err');
    const done = (v) => { document.removeEventListener('keydown', key, true); wrap.remove(); resolve(v); };
    const key = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(null); } };
    wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) done(null); });
    wrap.addEventListener('click', (e) => {
      const b = e.target.closest('[data-lk]');
      if (b) done(b.dataset.lk === 'remove' ? { remove: true } : null);
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      let u = uIn.value.trim();
      if (!u) { err.textContent = 'Enter the link address.'; err.hidden = false; uIn.focus(); return; }
      if (/^www\./i.test(u)) u = `https://${u}`;
      else if (/^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/.test(u)) u = `mailto:${u}`;
      else if (!/^(https?:\/\/|mailto:)/i.test(u) && /^[\w-]+(\.[\w-]+)+([/?#].*)?$/.test(u)) u = `https://${u}`;
      if (!/^(https?:\/\/\S+|mailto:\S+)$/i.test(u)) { err.textContent = 'Links must start with https://, http:// or mailto:'; err.hidden = false; uIn.focus(); return; }
      done({ url: u, text: tIn.value.trim() || uIn.value.trim() }); // no display text: show the address as you typed it
    });
    uIn.addEventListener('input', () => { err.hidden = true; });
    document.addEventListener('keydown', key, true);
    document.body.append(wrap);
    (url ? tIn : uIn).focus();
    (url ? tIn : uIn).select();
  });
}
/** Wire a toolbar made by rteToolbar() to a contenteditable editor. `onChange` runs after edits. `images`: paste/drop images (uploaded to Zendesk). */
function wireRte(bar, ed, onChange = () => {}, { images = false } = {}) {
  let saved = null; // the editor's selection, kept while you use the toolbar
  const keep = () => { const s = getSelection(); if (s.rangeCount && ed.contains(s.anchorNode)) saved = s.getRangeAt(0).cloneRange(); };
  const restore = () => { ed.focus(); if (saved) { const s = getSelection(); s.removeAllRanges(); s.addRange(saved); } };
  const exec = (cmd, val = null) => { restore(); document.execCommand(cmd, false, val); keep(); onChange(); refresh(); };
  const inBlock = (tag) => { const s = getSelection(); let n = s.anchorNode; while (n && n !== ed) { if (n.nodeName === tag) return n; n = n.parentNode; } return null; };
  const refresh = () => {
    for (const cmd of ['bold', 'italic', 'underline', 'strikeThrough', 'insertUnorderedList', 'insertOrderedList']) {
      let on = false; try { on = document.queryCommandState(cmd); } catch { /* not supported */ }
      bar.querySelector(`[data-cmd="${cmd}"]`)?.classList.toggle('active', on);
    }
    bar.querySelector('[data-cmd="quote"]').classList.toggle('active', !!inBlock('BLOCKQUOTE'));
    bar.querySelector('[data-cmd="codeblock"]').classList.toggle('active', !!inBlock('PRE'));
    bar.querySelector('[data-cmd="code"]').classList.toggle('active', !!inBlock('CODE'));
    bar.querySelector('[data-cmd="table"]').classList.toggle('active', !!cellAt());
    const h = ['H1', 'H2', 'H3', 'H4'].find((x) => inBlock(x));
    bar.querySelector('.rte-block').value = h ? h.toLowerCase() : 'p';
  };
  // ---- tables: the Table button inserts one (size grid); with the caret in a table it opens row / column actions
  const cellAt = () => inBlock('TD') || inBlock('TH');
  const tblPop = bar.querySelector('.rte-tbl-pop');
  const caretIn = (cell, select = false) => {
    const r = document.createRange(); r.selectNodeContents(cell); if (!select) r.collapse(true);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r); keep();
  };
  /** The cells you selected: the rectangle between the cell you started dragging in and the one you ended in (like a spreadsheet), or the caret's cell. */
  const selCells = () => {
    const cell = cellAt();
    if (!cell) return [];
    const table = cell.closest('table'), s = getSelection();
    if (!s.rangeCount || s.isCollapsed) return [cell];
    const r = s.getRangeAt(0);
    const cellOf = (n) => { const c = (n.nodeType === 1 ? n : n.parentElement)?.closest('td, th'); return c?.closest('table') === table ? c : null; };
    const a = cellOf(r.startContainer) || cell, b = cellOf(r.endContainer) || cell;
    if (a === b) return [a];
    const g = tblGrid(table), pa = tblPos(g, a), pb = tblPos(g, b);
    const out = [];
    for (let y = Math.min(pa.r, pb.r); y <= Math.max(pa.r1, pb.r1); y++) for (let x = Math.min(pa.c, pb.c); x <= Math.max(pa.c1, pb.c1); x++) {
      const c = g[y]?.[x];
      if (c && !out.includes(c)) out.push(c);
    }
    return out;
  };
  const insertTable = (rows, cols) => {
    restore();
    const tr = (tag) => `<tr>${`<${tag}${tag === 'th' ? ` style="background-color:${TBL_HEAD_BG}"` : ''}><br></${tag}>`.repeat(cols)}</tr>`;
    const head = rows > 1 ? `<thead>${tr('th')}</thead>` : '';
    document.execCommand('insertHTML', false, `<table data-new="1">${head}<tbody>${tr('td').repeat(rows > 1 ? rows - 1 : 1)}</tbody></table><p><br></p>`);
    const t = ed.querySelector('table[data-new]');
    if (t) { t.removeAttribute('data-new'); caretIn(t.rows[0].cells[0]); }
    onChange(); refresh();
  };
  const tblEdit = (act, val = '', { first = false } = {}) => {
    restore();
    const cell = cellAt();
    if (!cell) return;
    const cells = selCells(), table = cell.closest('table');
    const g = tblGrid(table), p = tblPos(g, cell);
    let next = cell;
    const at = (r, c) => { const g2 = tblGrid(table); const row = g2[Math.max(0, Math.min(r, g2.length - 1))] || []; return row[Math.max(0, Math.min(c, row.length - 1))]; };
    const dropTable = () => { const para = document.createElement('p'); para.append(document.createElement('br')); table.replaceWith(para); next = para; };
    switch (act) {
      case 'rowAbove': tblInsertRow(table, p.r); next = at(p.r, p.c); break;
      case 'rowBelow': tblInsertRow(table, p.r1 + 1); next = at(p.r1 + 1, first ? 0 : p.c); break;
      case 'colLeft': tblInsertCol(table, p.c); next = at(p.r, p.c); break;
      case 'colRight': tblInsertCol(table, p.c1 + 1); next = at(p.r, p.c1 + 1); break;
      case 'delRow': if (g.length <= 1 || !tblDeleteRow(table, p.r)) dropTable(); else next = at(p.r, p.c); break;
      case 'delCol': if (tblWidth(g) <= 1 || !tblDeleteCol(table, p.c)) dropTable(); else next = at(p.r, p.c); break;
      case 'delTable': dropTable(); break;
      case 'merge': next = tblMerge(table, cells) || cell; break;
      case 'split': cells.forEach((c) => tblSplit(table, c)); break;
      case 'headRow': tblHeadRow(table, !isHeadRow(table)); next = at(p.r, p.c); break;
      case 'headCol': tblHeadCol(table, !isHeadCol(table)); next = at(p.r, p.c); break;
      case 'align': cells.forEach((c) => tblStyle(c, 'text-align', val === 'left' ? '' : val)); break;
      case 'valign': cells.forEach((c) => tblStyle(c, 'vertical-align', val)); break;
      case 'shade': cells.forEach((c) => tblStyle(c, 'background-color', val)); break;
      case 'fit': tblStyle(table, 'width', table.style.width === '100%' ? '' : '100%'); break;
      case 'equal': {
        const w = `${+(100 / tblWidth(g)).toFixed(2)}%`;
        tblStyle(table, 'width', '100%');
        for (const c of table.querySelectorAll('th, td')) tblStyle(c, 'width', c.colSpan > 1 ? '' : w);
        break;
      }
      case 'autoSize':
        tblStyle(table, 'width', '');
        for (const c of table.querySelectorAll('th, td')) { tblStyle(c, 'width', ''); tblStyle(c, 'height', ''); }
        break;
      default: return;
    }
    const styling = ['align', 'valign', 'shade', 'fit', 'equal', 'autoSize'].includes(act); // keep the selection to style more
    if (!styling) {
      if (!next?.isConnected) next = table.isConnected ? table.rows[0]?.cells[0] : null;
      if (next) caretIn(next);
    } else keep();
    onChange(); refresh();
  };
  const AL = {
    left: 'M3 5h18v2H3zm0 4h12v2H3zm0 4h18v2H3zm0 4h12v2H3z', center: 'M3 5h18v2H3zm3 4h12v2H6zm-3 4h18v2H3zm3 4h12v2H6z', right: 'M3 5h18v2H3zm6 4h12v2H9zm-6 4h18v2H3zm6 4h12v2H9z',
    top: 'M4 3h16v2H4zm4 4h8v7H8z', middle: 'M4 11h16v2H4zM8 5h8v4H8zm0 10h8v4H8z', bottom: 'M4 19h16v2H4zm4-9h8v7H8z',
  };
  const tblMenu = (table, cells) => {
    const one = cells[0], multi = cells.length > 1, spanned = cells.some((c) => c.colSpan > 1 || c.rowSpan > 1);
    const b = (act, label, { v = '', title = '', cls = '', on = false, dis = false } = {}) => `<button type="button" class="rte-tbl-b${cls ? ` ${cls}` : ''}${on ? ' on' : ''}" data-tbl="${act}" data-v="${esc(v)}" title="${esc(title || label)}"${dis ? ' disabled' : ''}>${label}</button>`;
    const row = (name, html) => `<div class="rte-tbl-row"><span class="rte-tbl-lbl">${name}</span><div class="rte-tbl-btns">${html}</div></div>`;
    const al = one.style.textAlign || 'left', va = one.style.verticalAlign || 'top', bg = one.style.backgroundColor;
    const n = multi ? `${cells.length} cells` : 'cell';
    return row('Row', b('rowAbove', '↑ Above', { title: 'Insert row above' }) + b('rowBelow', '↓ Below', { title: 'Insert row below (Tab in the last cell)' }) + b('delRow', 'Delete', { cls: 'danger', title: 'Delete row' }))
      + row('Column', b('colLeft', '← Left', { title: 'Insert column left' }) + b('colRight', 'Right →', { title: 'Insert column right' }) + b('delCol', 'Delete', { cls: 'danger', title: 'Delete column' }))
      + row('Cells', b('merge', 'Merge', { dis: !multi, title: multi ? `Merge the ${cells.length} selected cells into one` : 'Select two or more cells (drag across them), then Merge' }) + b('split', 'Split', { dis: !spanned, title: spanned ? 'Split the merged cell back into single cells' : 'Only a merged cell can be split' }))
      + row('Header', b('headRow', 'Top row', { on: isHeadRow(table), title: 'First row as a shaded header row' }) + b('headCol', 'First column', { on: isHeadCol(table), title: 'First column as shaded header cells' }))
      + row('Align', ['left', 'center', 'right'].map((a) => b('align', ICON(AL[a]), { v: a, on: al === a, title: `Align ${n} ${a}`, cls: 'ic' })).join('')
        + '<span class="rte-sep"></span>' + ['top', 'middle', 'bottom'].map((a) => b('valign', ICON(AL[a]), { v: a, on: va === a, title: `Align ${n} to the ${a}`, cls: 'ic' })).join(''))
      + row('Shading', `<button type="button" class="rte-tbl-sw none${bg ? '' : ' on'}" data-tbl="shade" data-v="" title="No shading">×</button>${TBL_SHADES.map(([c, name]) => `<button type="button" class="rte-tbl-sw${bg && sameColor(bg, c) ? ' on' : ''}" data-tbl="shade" data-v="${c}" style="background:${c}" title="${name} shading for ${n}"></button>`).join('')}`)
      + row('Size', b('fit', 'Full width', { on: table.style.width === '100%', title: 'Stretch the table to the full width' }) + b('equal', 'Equal columns', { title: 'Full width, all columns the same width' }) + b('autoSize', 'Auto', { title: 'Clear all widths and heights: fit the text' }))
      + `<div class="rte-tbl-foot">${b('delTable', 'Delete table', { cls: 'danger' })}<span>Drag a cell's edge to resize · select cells to merge or style them together</span></div>`;
  };
  const openTblPop = () => {
    keep();
    if (!tblPop.hidden) { tblPop.hidden = true; return; }
    const cell = cellAt();
    if (cell) {
      tblPop.className = 'rte-tbl-pop menu';
      tblPop.innerHTML = tblMenu(cell.closest('table'), selCells());
    } else {
      tblPop.className = 'rte-tbl-pop';
      tblPop.innerHTML = `<div class="rte-tbl-grid">${Array.from({ length: 64 }, (_, i) => `<i data-tr="${Math.floor(i / 8) + 1}" data-tc="${(i % 8) + 1}"></i>`).join('')}</div><div class="rte-tbl-size">Insert table</div>`;
    }
    // keep it on screen: shift left when it would overflow, open upwards when there's no room below
    tblPop.style.left = ''; tblPop.style.top = ''; tblPop.style.bottom = '';
    tblPop.hidden = false;
    const r = tblPop.getBoundingClientRect();
    if (r.right > innerWidth - 8) tblPop.style.left = `${Math.round(innerWidth - 8 - r.right)}px`;
    if (r.bottom > innerHeight - 8 && r.top - r.height - 34 > 8) { tblPop.style.top = 'auto'; tblPop.style.bottom = '30px'; }
  };
  // Drag a cell's right edge to resize its column, its bottom edge to resize its row.
  let edge = null, sizing = false;
  const EDGE = 5;
  const edgeAt = (e) => {
    const cell = e.target.closest?.('td, th');
    if (!cell || !ed.contains(cell)) return null;
    const bx = cell.getBoundingClientRect();
    if (bx.right - e.clientX <= EDGE) return { cell, kind: 'col' };
    if (bx.bottom - e.clientY <= EDGE) return { cell, kind: 'row' };
    if (e.clientX - bx.left <= EDGE && cell.previousElementSibling) return { cell: cell.previousElementSibling, kind: 'col' };
    return null;
  };
  const edgeCursor = (k) => { ed.classList.toggle('rte-col-resize', k === 'col'); ed.classList.toggle('rte-row-resize', k === 'row'); };
  ed.addEventListener('mousemove', (e) => { if (!sizing) { edge = edgeAt(e); edgeCursor(edge?.kind); } });
  ed.addEventListener('mouseleave', () => { if (!sizing) { edge = null; edgeCursor(null); } });
  ed.addEventListener('mousedown', (e) => {
    if (!edge || e.button !== 0) return;
    e.preventDefault();
    const { cell, kind } = edge, table = cell.closest('table'), g = tblGrid(table), p = tblPos(g, cell);
    const x0 = e.clientX, y0 = e.clientY;
    let targets, start;
    if (kind === 'col') { // every single-column cell whose right edge is this line
      targets = [...new Set(g.map((row) => row[p.c1]))].filter((c) => c && c.colSpan <= 1);
      if (!targets.length) targets = [cell];
      start = targets[0].getBoundingClientRect().width;
    } else {
      targets = [...table.rows[p.r1].cells];
      start = table.rows[p.r1].getBoundingClientRect().height;
    }
    sizing = true;
    document.body.classList.add(kind === 'col' ? 'rte-sizing-col' : 'rte-sizing-row');
    const move = (ev) => {
      if (kind === 'col') { const w = Math.max(24, Math.round(start + ev.clientX - x0)); targets.forEach((c) => tblStyle(c, 'width', `${w}px`)); }
      else { const h = Math.max(18, Math.round(start + ev.clientY - y0)); targets.forEach((c) => tblStyle(c, 'height', `${h}px`)); }
    };
    const up = () => {
      document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up);
      document.body.classList.remove('rte-sizing-col', 'rte-sizing-row');
      sizing = false; edge = null; edgeCursor(null);
      onChange();
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
  tblPop.addEventListener('mousedown', (e) => e.preventDefault()); // keep the editor's selection
  tblPop.addEventListener('mouseover', (e) => {
    const c = e.target.closest('[data-tr]');
    if (!c) return;
    const [R, C] = [+c.dataset.tr, +c.dataset.tc];
    tblPop.querySelectorAll('[data-tr]').forEach((x) => x.classList.toggle('on', +x.dataset.tr <= R && +x.dataset.tc <= C));
    tblPop.querySelector('.rte-tbl-size').textContent = `${C} × ${R}${R > 1 ? ' (first row is the header)' : ''}`;
  });
  tblPop.addEventListener('click', (e) => {
    const c = e.target.closest('[data-tr]'), a = e.target.closest('[data-tbl]');
    if ((!c && !a) || a?.disabled) return;
    tblPop.hidden = true;
    if (c) insertTable(+c.dataset.tr, +c.dataset.tc); else tblEdit(a.dataset.tbl, a.dataset.v);
  });
  const link = async () => {
    keep();
    hideSuggest();
    const cur = inBlock('A');
    const selText = cur ? cur.textContent : (saved ? saved.toString() : '');
    const selIsUrl = !cur && rteIsUrl(selText.trim());
    const r = await linkDialog({
      url: cur ? cur.getAttribute('href') || '' : selIsUrl ? rteHref(selText.trim()) : '',
      text: selText, // a selected URL stays as written; only the link address gets https://
      editing: !!cur,
    });
    restore();
    if (!r) return;
    if (r.remove) { if (cur) { cur.replaceWith(...cur.childNodes); onChange(); refresh(); } return; }
    const text = r.text || r.url;
    if (cur) {
      cur.setAttribute('href', r.url);
      if (text !== cur.textContent) cur.textContent = text;
    } else {
      document.execCommand('insertHTML', false, `<a href="${esc(r.url)}">${esc(text)}</a>${saved && saved.collapsed ? '&nbsp;' : ''}`);
    }
    keep(); onChange(); refresh();
  };
  // Bare URLs typed or pasted as text: a small chip under the URL offers to turn them into links.
  // Only the URL you just finished (or the ones you just pasted) are offered, not every old one in the text.
  const dismissed = new Set();
  let chip = null, offered = null; // offered: which bare URLs the chip stands for
  let justTyped = null; // { node, url } of a URL the caret sat right after when you pressed Space / Enter
  const hideSuggest = () => { chip?.remove(); chip = null; offered = null; };
  const pick = (only) => rteBareUrls(ed).filter((u) => !dismissed.has(u.url) && (!only || only(u)));
  const suggest = (only = null) => {
    hideSuggest();
    if (!bar.isConnected) return;
    const found = pick(only);
    if (!found.length) return;
    offered = only;
    const last = found[found.length - 1];
    const rg = document.createRange();
    rg.setStart(last.node, last.start); rg.setEnd(last.node, last.end);
    const rect = [...rg.getClientRects()].pop() || rg.getBoundingClientRect();
    chip = document.createElement('div');
    chip.className = 'rte-suggest';
    chip.innerHTML = `<button type="button" class="rte-suggest-go" title="Turn into a clickable link (Tab)">${ICON('M10.6 13.4a1 1 0 0 1 0-1.4l3.5-3.5a1 1 0 1 1 1.4 1.4L12 13.4a1 1 0 0 1-1.4 0zM8.5 19a4.5 4.5 0 0 1-3.2-7.7l2-2 1.4 1.4-2 2a2.5 2.5 0 0 0 3.6 3.6l2-2 1.4 1.4-2 2A4.5 4.5 0 0 1 8.5 19zm8.2-6.3-1.4-1.4 2-2a2.5 2.5 0 0 0-3.6-3.6l-2 2-1.4-1.4 2-2a4.5 4.5 0 0 1 6.4 6.4z')} ${found.length > 1 ? `Make ${found.length} links` : 'Make link'} <kbd>Tab</kbd></button><button type="button" class="rte-suggest-x" title="Keep as plain text (Esc)">×</button>`;
    chip.addEventListener('mousedown', (e) => e.preventDefault()); // keep the caret in the editor
    chip.querySelector('.rte-suggest-go').addEventListener('click', () => applySuggest());
    chip.querySelector('.rte-suggest-x').addEventListener('click', () => { found.forEach((u) => dismissed.add(u.url)); hideSuggest(); });
    document.body.append(chip);
    const w = chip.offsetWidth;
    chip.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - w - 8))}px`;
    chip.style.top = `${rect.bottom + 4 + chip.offsetHeight > innerHeight ? rect.top - chip.offsetHeight - 4 : rect.bottom + 4}px`;
  };
  const applySuggest = () => {
    const found = pick(offered);
    hideSuggest();
    if (!found.length) return;
    const s = getSelection();
    const caret = s.rangeCount ? s.getRangeAt(0) : null;
    const caretNode = caret?.startContainer, caretOff = caret?.startOffset;
    let back = null; // where the caret goes back to, when it sat in a text node that gets split
    for (const u of found.reverse()) { // last first, so earlier offsets in the same text node stay valid
      const rg = document.createRange();
      rg.setStart(u.node, u.start); rg.setEnd(u.node, u.end);
      const a = document.createElement('a');
      a.href = rteHref(u.url);
      rg.surroundContents(a);
      if (!back && caretNode === u.node && caretOff >= u.end) {
        const t = a.nextSibling;
        back = t?.nodeType === 3 ? [t, Math.min(caretOff - u.end, t.length)] : null;
        if (!back) { const r = document.createRange(); r.setStartAfter(a); back = [r.startContainer, r.startOffset]; }
      }
    }
    ed.focus();
    if (back) { const r = document.createRange(); r.setStart(...back); r.collapse(true); s.removeAllRanges(); s.addRange(r); }
    keep(); onChange(); refresh();
  };
  const colors = bar.querySelector('.rte-colors');
  bar.addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); }); // keep the editor's selection
  bar.addEventListener('click', (e) => {
    const sw = e.target.closest('[data-color]');
    if (sw) { colors.hidden = true; document.execCommand('styleWithCSS', false, true); exec('foreColor', sw.dataset.color); return; }
    const btn = e.target.closest('.rte-btn');
    if (!btn) return;
    const cmd = btn.dataset.cmd;
    if (cmd === 'color') { tblPop.hidden = true; colors.hidden = !colors.hidden; return; }
    colors.hidden = true;
    if (cmd === 'table') return openTblPop();
    tblPop.hidden = true;
    if (cmd === 'link') return link();
    if (cmd === 'quote') return exec('formatBlock', inBlock('BLOCKQUOTE') ? 'p' : 'blockquote');
    if (cmd === 'codeblock') return exec('formatBlock', inBlock('PRE') ? 'p' : 'pre');
    if (cmd === 'code') {
      restore();
      const c = inBlock('CODE');
      if (c) { c.replaceWith(...c.childNodes); onChange(); refresh(); return; }
      const text = getSelection().toString();
      document.execCommand('insertHTML', false, `<code>${esc(text || 'code')}</code>${text ? '' : '&nbsp;'}`);
      keep(); onChange(); refresh(); return;
    }
    exec(cmd);
  });
  bar.querySelector('.rte-block').addEventListener('change', (e) => exec('formatBlock', e.target.value));
  ed.addEventListener('keyup', (e) => {
    keep(); refresh();
    if (justTyped && (e.key === ' ' || e.key === 'Enter')) { const j = justTyped; justTyped = null; suggest((u) => u.node === j.node && u.url === j.url); }
    else if (chip && !['Shift', 'Control', 'Alt', 'Meta', 'Tab', 'Escape'].includes(e.key)) hideSuggest();
  });
  ed.addEventListener('mouseup', () => { keep(); refresh(); });
  ed.addEventListener('focus', refresh);
  ed.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== ed) hideSuggest(); }, 0));
  ed.addEventListener('scroll', hideSuggest);
  ed.addEventListener('keydown', (e) => {
    if (chip && e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); e.stopPropagation(); applySuggest(); return; }
    if (chip && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); pick(offered).forEach((u) => dismissed.add(u.url)); hideSuggest(); return; }
    if (!tblPop.hidden && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); tblPop.hidden = true; return; }
    // Tab / Shift+Tab move between table cells; Tab in the last cell adds a row (not while the @mention list is open)
    if (e.key === 'Tab' && !e.ctrlKey && !e.altKey && !e.metaKey && !ed.parentElement?.querySelector('.mention-pop:not([hidden])')) {
      const cell = cellAt();
      if (cell) {
        e.preventDefault();
        const cells = [...cell.closest('table').querySelectorAll('th, td')];
        const i = cells.indexOf(cell) + (e.shiftKey ? -1 : 1);
        if (i >= cells.length) { keep(); tblEdit('rowBelow', '', { first: true }); } else if (i >= 0) caretIn(cells[i], true);
        return;
      }
    }
    if ((e.key === ' ' || e.key === 'Enter') && !e.ctrlKey && !e.metaKey) { // remember a URL that ends right at the caret
      const s = getSelection();
      const n = s.anchorNode, off = s.anchorOffset;
      justTyped = null;
      if (s.isCollapsed && n?.nodeType === 3) {
        const u = rteBareUrls(ed).find((x) => x.node === n && x.end <= off && /^[.,;:!?'")\]}]*$/.test(n.data.slice(x.end, off)));
        if (u) justTyped = { node: n, url: u.url };
      }
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); link(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'u') { e.preventDefault(); exec('underline'); }
  });
  // Pasted / dropped images: shown right away from the local copy, uploaded to Zendesk meanwhile.
  // The upload's token goes with the comment on Submit (see rteUploads); a failed upload is removed.
  const imageFiles = (dt) => (images ? [...(dt?.files || [])].filter((f) => RTE_IMG.test(f.type)) : []);
  const addImages = async (files) => {
    for (const f of files) {
      const key = `up${Math.random().toString(36).slice(2, 10)}`;
      document.execCommand('insertHTML', false, `<img src="${URL.createObjectURL(f)}" class="rte-img uploading" data-up="${key}" alt="">`);
      onChange();
      try {
        const name = f.name && f.name !== 'image.png' ? f.name : `pasted-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}.${(f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`;
        const res = await fetch(`/api/zendesk/uploads?name=${encodeURIComponent(name)}&type=${encodeURIComponent(f.type)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: f });
        const r = await res.json().catch(() => ({}));
        if (!res.ok || !r.token) throw new Error(r.error || res.statusText);
        const img = ed.querySelector(`[data-up="${key}"]`);
        if (img) { img.dataset.zdToken = r.token; img.dataset.zdUrl = r.url || ''; img.alt = r.name || name; img.title = `${r.name || name} · uploaded to Zendesk, sent with this comment`; img.classList.remove('uploading'); }
      } catch (err) {
        ed.querySelector(`[data-up="${key}"]`)?.remove();
        toast(`Image not added: ${err.message}`);
      }
      onChange();
    }
  };
  ed.addEventListener('dragover', (e) => { if (images && [...(e.dataTransfer?.items || [])].some((i) => i.kind === 'file')) e.preventDefault(); });
  ed.addEventListener('drop', (e) => {
    const files = imageFiles(e.dataTransfer);
    if (!files.length) return;
    e.preventDefault();
    const at = document.caretRangeFromPoint?.(e.clientX, e.clientY);
    if (at && ed.contains(at.startContainer)) { const s = getSelection(); s.removeAllRanges(); s.addRange(at); } else ed.focus();
    addImages(files);
  });
  // Paste keeps formatting (bold, lists, links…) but nothing else: no fonts, sizes or scripts.
  // An image (a screenshot, or an image copied on its own) is uploaded to Zendesk and shown inline.
  ed.addEventListener('paste', (e) => {
    const html = e.clipboardData?.getData('text/html');
    const text = e.clipboardData?.getData('text/plain');
    const files = imageFiles(e.clipboardData);
    if (files.length && !text?.trim()) { e.preventDefault(); addImages(files); return; }
    if (!html && !text) { if (e.clipboardData?.files?.length) { e.preventDefault(); toast(images ? 'Only images (PNG, JPEG, GIF, WebP) can be pasted here' : 'Images can\'t be pasted here'); } return; }
    e.preventDefault();
    if (html) {
      const tmp = document.createElement('div');
      tmp.innerHTML = rteClean(html.replace(/<!--[\s\S]*?-->/g, ''));
      tmp.querySelectorAll('[style]').forEach(keepStyles); // text colour, and a table's alignment, shading and sizes
      tmp.querySelectorAll('[class]').forEach((n) => { if (!n.classList.contains('atmention')) n.removeAttribute('class'); });
      document.execCommand('insertHTML', false, tmp.innerHTML);
    } else if (MD_TABLE.test(text) && !cellAt()) {
      // Markdown pasted as text (a draft with a table): insert it formatted, the table as a real table
      document.execCommand('insertHTML', false, rteClean(tblDefaults(marked.parse(text))));
    } else document.execCommand('insertText', false, text);
    onChange();
    const pasted = text || '';
    if (pasted) suggest((u) => pasted.includes(u.url));
  });
  // Cells selected by dragging across them are outlined as a block (the browser only highlights text in order).
  const markCells = () => {
    const s = getSelection();
    const cells = document.activeElement === ed && s.rangeCount && !s.isCollapsed ? selCells() : [];
    for (const c of ed.querySelectorAll('.rte-cell-sel')) if (!cells.includes(c)) { c.classList.remove('rte-cell-sel'); if (!c.className) c.removeAttribute('class'); }
    if (cells.length > 1) cells.forEach((c) => c.classList.add('rte-cell-sel'));
  };
  const track = () => {
    if (!bar.isConnected) { document.removeEventListener('selectionchange', track); hideSuggest(); return; }
    if (document.activeElement === ed) keep();
    markCells();
  };
  document.addEventListener('selectionchange', track);
  const outside = (e) => {
    if (!bar.isConnected) { document.removeEventListener('mousedown', outside); return; } // Zendesk panel re-rendered
    if (!e.target.closest('.rte-color-wrap')) colors.hidden = true;
    if (!e.target.closest('.rte-tbl-wrap')) tblPop.hidden = true;
  };
  document.addEventListener('mousedown', outside);
}

// ---------------- ticket rendering ----------------
function scoreClass(s) { return s >= 60 ? 's3' : s >= 40 ? 's2' : s >= 20 ? 's1' : ''; }
function reasonPill(r) {
  const cls = r.pts >= 30 ? 'red' : r.pts >= 15 ? 'amber' : r.pts < 0 ? 'green' : '';
  return `<span class="pill ${cls}">${esc(r.text)}</span>`;
}
// Who the ticket is waiting on, which is what decides whether it is mine to act on.
const STATUS = {
  new: { label: 'New', who: 'Needs you', group: 'action' },
  open: { label: 'Open', who: 'Needs you', group: 'action' },
  pending: { label: 'Pending', who: 'Waiting on customer', group: 'waiting' },
  hold: { label: 'On hold', who: 'Waiting on third party', group: 'waiting' },
  solved: { label: 'Solved', who: 'Done', group: 'done' },
  closed: { label: 'Closed', who: 'Done', group: 'done' },
};
const statusOf = (t) => STATUS[t.status] || { label: t.status, who: '', group: 'action' };
/** Small coloured tile with the client code; the colour is fixed per client so you learn to spot it. */
function clientBadge(org, fullName) {
  const code = org || '?';
  let h = 0;
  for (const ch of code.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) % 360;
  const short = code;
  return `<a class="client-badge ${short.length > 6 ? 'long' : ''}" href="#/org/${encodeURIComponent(code)}" style="--h:${h}" title="${esc(fullName || code)}">${esc(short)}</a>`;
}
function ticketRow(t) {
  const st = statusOf(t);
  // The status pill already says pending/on hold, so drop the matching score reason.
  const reasons = (t.reasons || []).filter((r) => r.pts !== 0 && !/^(Pending|On hold|Open, waiting|New, not yet)/.test(r.text));
  return `<div class="ticket st-${esc(t.status)}" data-ticket-open="${t.id}" title="Open in the ticket workspace">
    <div class="score ${st.group === 'action' ? scoreClass(t.score) : ''}" title="Attention score">${Math.round(t.score)}</div>
    ${clientBadge(t.org, t.org_name)}
    <div style="min-width:0">
      <div class="title" data-ticket-open="${t.id}">${relPill(t)}<span class="status-pill st-${esc(t.status)}" title="${esc(st.who)}">${esc(st.label)}</span>#${t.id} ${esc(t.subject)}</div>
      <div class="meta"><b class="assignee" title="Assignee">👤 ${esc(t.assignee_id && t.assignee_id === state.meId ? 'You' : t.assignee || 'Unassigned')}</b> · ${esc(t.requester || 'unknown requester')} · ${t.my_update_at ? `<b>you updated ${ago(t.my_update_at)}</b>` : `updated ${ago(t.updated_at)}`}</div>
      <div class="reasons">${reasons.map(reasonPill).join('')}</div>
    </div>
    <div class="actions">
      ${t.ignored ? '' : `<button class="btn small upvote ${t.upvoted ? 'active' : ''}" data-upvote="${t.id}" data-on="${t.upvoted ? 0 : 1}" title="${t.upvoted ? 'Remove from your focus list' : 'Upvote to focus on this ticket'}">👀 ${t.upvoted ? 'Upvoted' : 'Upvote'}</button>`}
      ${(t.needs_me || t.relation === 'unassigned' || t.chat_cooled) && (t.ignored || !t.upvoted) ? `<button class="btn small" data-ignore="${t.id}" data-on="${t.ignored ? 0 : 1}" title="${t.ignored ? `Back to Open${t.chat_cooled ? ' (also ends the chat cooldown)' : ''}` : t.relation === 'unassigned' && !t.needs_me ? 'Park it in Cooled until something new happens on it' : 'Park it in Cooled until you are mentioned again or you comment'}">${t.ignored ? 'Warm up' : 'Cool down'}</button>` : ''}
    </div>
  </div>`;
}
// Runs the triage-ticket skill itself (not just its model), so its hand-off rules apply.
const ASK_PROMPT = (id) => `/triage-ticket ${id}`;
const onTicketAction = async (e) => {
  const uv = e.target.closest('[data-upvote]');
  if (uv) {
    const upvoted = uv.dataset.on === '1';
    uv.disabled = true;
    try {
      await api(`/api/tickets/${uv.dataset.upvote}/upvote`, { method: 'POST', body: { upvoted } });
      toast(upvoted ? `#${uv.dataset.upvote} upvoted — score increased` : `#${uv.dataset.upvote} upvote removed`);
      refreshDashboard().catch(() => {});
      if (state.route.name === 'org') refreshOrgLive(state.route.id);
    } catch (err) {
      uv.disabled = false;
      toast(err.message);
    }
    return;
  }
  const ig = e.target.closest('[data-ignore]');
  if (ig) {
    try {
      await api(`/api/tickets/${ig.dataset.ignore}/ignore`, { method: 'POST', body: { ignore: ig.dataset.on === '1' } });
      toast(ig.dataset.on === '1' ? `#${ig.dataset.ignore} cooling down` : `#${ig.dataset.ignore} back in Open`);
      refreshDashboard().catch(() => {});
      if (state.route.name === 'org') refreshOrgLive(state.route.id);
    } catch (err) { toast(err.message); }
    return;
  }
  if (e.target.closest('a, button, select, input, textarea')) return; // other links/buttons in a row do their own thing
  const p = e.target.closest('[data-ticket-open]'); // clicking anywhere else on a ticket opens the ticket workspace
  if (p) location.hash = `#/ticket/${p.dataset.ticketOpen}`;
};
view.addEventListener('click', onTicketAction);
view.addEventListener('click', (e) => {
  const a = e.target.closest('[data-cfopen]');
  if (a && !a.closest('#cfBody')) fetch(`/api/cloudflare/zones/${encodeURIComponent(a.dataset.cfopen)}/opened`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', keepalive: true });
});
let pendingPrompt = null;
let pendingSkill = null; // whose model pendingPrompt uses (Ask AI = triage-ticket)
let chatTicketWatch = null; // set by an open ticket chat; called when tickets sync
let chatCompact = null; // { sid, run } for the open chat, when it can be compacted (Usage card › Context)

// ---------------- Zendesk panel (middle column of the ticket workspace) ----------------
const when = (iso) => iso ? `${new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} · ${ago(iso)}` : '—';

const zdDirectory = () => cached('zdDirectory', () => api('/api/zendesk/directory'));
/** Category options, grouped by their "Group::Item" names like Zendesk's nested drop-down. */
function categoryOptions(cat) {
  const groups = new Map();
  for (const o of cat.options) {
    const [g, ...rest] = o.name.split('::');
    const key = rest.length ? g : '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ ...o, label: rest.length ? rest.join(' › ') : o.name });
  }
  const opt = (o) => `<option value="${esc(o.value)}" ${o.value === cat.value ? 'selected' : ''}>${esc(o.label)}</option>`;
  return `<option value="">${esc(cat.title)}…</option>` + [...groups].map(([g, list]) => (g ? `<optgroup label="${esc(g)}">${list.map(opt).join('')}</optgroup>` : list.map(opt).join(''))).join('');
}

// Zendesk comment HTML, made safe: no scripts/styles/forms, links open in a new tab, Zendesk images go
// through mon.ai (they need your Zendesk sign-in), other images become links (no tracking pixels).
const zdFileUrl = (u, name = '') => `/api/zendesk/file?u=${encodeURIComponent(u)}${name ? `&name=${encodeURIComponent(name)}` : ''}`;
const isZdFile = (url, origin) => { try { const x = new URL(url, origin); return (x.origin === origin && x.pathname.startsWith('/attachments/')) || /(^|\.)zdusercontent\.com$/.test(x.hostname); } catch { return false; } };
function commentHtml(c, origin) {
  if (!c.html) return `<div class="comment-body">${esc(c.body || '')}</div>`;
  const frag = DOMPurify.sanitize(c.html, {
    RETURN_DOM_FRAGMENT: true,
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'iframe', 'object', 'embed', 'svg', 'math', 'video', 'audio'],
    FORBID_ATTR: ['class', 'id', 'width', 'height', 'srcset'],
  });
  // Styles only where they carry meaning: a table's alignment, shading and sizes (not the email's fonts and colours).
  frag.querySelectorAll('[style]').forEach((n) => { if (/^(TD|TH|TABLE)$/.test(n.nodeName)) keepStyles(n); else n.removeAttribute('style'); });
  frag.querySelectorAll('img').forEach((img) => {
    const src = img.getAttribute('src') || '';
    if (origin && isZdFile(src, origin)) {
      const full = new URL(src, origin).toString();
      img.src = zdFileUrl(full);
      img.loading = 'lazy';
      img.className = 'zd-img';
      img.title = 'Click to open full size';
      img.dataset.full = zdFileUrl(full);
    } else {
      const a = document.createElement('a');
      a.textContent = `[image${img.alt ? `: ${img.alt}` : ''}]`;
      if (/^https?:/i.test(src)) { a.href = src; a.target = '_blank'; a.rel = 'noopener noreferrer'; }
      img.replaceWith(a);
    }
  });
  frag.querySelectorAll('a[href]').forEach((a) => {
    try { a.href = new URL(a.getAttribute('href'), origin || location.origin).toString(); } catch { a.removeAttribute('href'); }
    a.target = '_blank'; a.rel = 'noopener noreferrer';
  });
  const box = document.createElement('div');
  box.className = 'comment-body comment-html';
  box.append(frag);
  return box.outerHTML;
}
function commentFiles(c) {
  const files = (c.files || []).filter((f) => !f.inline);
  if (!files.length) return '';
  return `<div class="comment-files">${files.map((f) => (/^image\/(png|jpe?g|gif|webp|bmp)$/i.test(f.type || '')
    ? `<a href="${zdFileUrl(f.url)}" target="_blank" rel="noopener" class="zd-thumb" title="${esc(f.name)}"><img src="${zdFileUrl(f.thumb || f.url)}" alt="${esc(f.name)}" loading="lazy"></a>`
    : `<a href="${zdFileUrl(f.url, f.name)}" class="chip zd-file" title="Download">📎 ${esc(f.name)} <span class="sub">${f.size ? `${Math.max(1, Math.round(f.size / 1024))} KB` : ''}</span></a>`)).join('')}</div>`;
}
document.addEventListener('click', (e) => { const img = e.target.closest('img.zd-img'); if (img?.dataset.full) window.open(img.dataset.full, '_blank', 'noopener'); });

// Per-ticket time tracking (Update ticket box): kept in localStorage so switching tickets, reloading or
// restarting mon.ai keeps it. It goes back to 0 only when you Submit an update (or press ↺).
const tkTimerKey = (tid) => `mon.tkTimer.${tid}`;
const tkTimerLoad = (tid) => { try { return JSON.parse(localStorage.getItem(tkTimerKey(tid)) || 'null'); } catch { return null; } };
const tkTimerSave = (tid, v) => { try { if (v) localStorage.setItem(tkTimerKey(tid), JSON.stringify({ ...v, at: Date.now() })); else localStorage.removeItem(tkTimerKey(tid)); } catch { /* storage unavailable */ } };
// Per-ticket unsent draft (Update ticket box): the reply/note, mode, CCs, followers, assignee, status,
// fields and macro survive switching tickets, reloading or restarting; cleared when you Submit.
const tkDraftKey = (tid) => `mon.tkDraft.${tid}`;
const tkDraftLoad = (tid) => { try { return JSON.parse(localStorage.getItem(tkDraftKey(tid)) || 'null'); } catch { return null; } };
const tkDraftSave = (tid, v) => { try { if (v) localStorage.setItem(tkDraftKey(tid), JSON.stringify({ ...v, at: Date.now() })); else localStorage.removeItem(tkDraftKey(tid)); } catch { /* storage unavailable or full */ } };
// drafts nobody came back to for 30 days are dropped
try {
  for (const k of Object.keys(localStorage)) {
    if (!k.startsWith('mon.tkDraft.')) continue;
    const v = JSON.parse(localStorage.getItem(k) || 'null');
    if (!v?.at || Date.now() - v.at > 30 * 864e5) localStorage.removeItem(k);
  }
} catch { /* storage unavailable */ }

/** Ticket details and the update form, drawn into `body`. Resolves with the details (null on error). */
async function renderZendeskPanel(id, body, { fresh = false, head = null } = {}) {
  const seq = String(Math.random());
  body.dataset.seq = seq;
  const stale = () => body.dataset.seq !== seq || !body.isConnected; // reloaded, or you left the page
  body.classList.add('zd-pinned'); // details scroll; the Update ticket box stays pinned at the bottom
  body.innerHTML = `<div class="zd-scroll"><div class="drawer-head"><h2>#${esc(id)}</h2></div><div class="sub">Loading from Zendesk…</div></div>`;
  let d;
  try { d = await api(`/api/tickets/${encodeURIComponent(id)}${fresh ? '?fresh=1' : ''}`); } catch (err) {
    if (!stale()) body.innerHTML = `<div class="zd-scroll"><div class="drawer-head"><h2>#${esc(id)}</h2></div><div class="notice err">${esc(err.message)}</div></div>`;
    return null;
  }
  if (stale()) return null;
  const t = d.ticket;
  const st = statusOf(t);
  const url = d.url || '';
  const reasons = (d.reasons || []).filter((r) => r.pts !== 0);
  let zdOrigin = '';
  try { zdOrigin = new URL(url).origin; } catch { /* no link yet */ }
  const zendeskButtons = `<button class="icon-btn" id="zendeskReload" title="${d.cached ? 'Ticket shown from cache (kept until the ticket changes). Click to reload from Zendesk' : 'Reload the ticket from Zendesk'}">↻</button>${url ? `<a class="btn small primary" href="${esc(url)}" target="_blank" rel="noopener">Open in Zendesk</a>` : ''}`;
  const pills = `<span class="status-pill st-${esc(t.status)}">${esc(st.label)}</span>
      <span class="pill">${esc(t.priority || 'no priority')}</span>
      ${d.score != null ? `<span class="pill ${d.score >= 40 ? 'red' : ''}">score ${Math.round(d.score)}</span>` : ''}
      ${d.assignee
    ? `<span class="pill assignee ${d.assignee.me ? 'me' : ''}" title="Assigned to ${esc(d.assignee.name)}${d.assignee.me ? ' (you)' : ''}">👤 ${esc(d.assignee.me ? 'You' : d.assignee.name)}</span>`
    : '<span class="pill amber assignee" title="Nobody is assigned yet">👤 Unassigned</span>'}`;
  if (head) {
    // ticket workspace: one header for the ticket and its chat
    head.info.innerHTML = `<div class="tvh-line">${d.org ? clientBadge(d.org) : ''}<span class="tvh-id">#${t.id}</span>${pills}</div><h1 title="${esc(t.subject || '')}">${esc(t.subject || '(no subject)')}</h1>`;
    if (head.chips) head.info.querySelector('.tvh-line').append(head.chips); // the chat's chips sit on the same row
    head.actions.innerHTML = zendeskButtons;
  }
  body.innerHTML = `<div class="zd-scroll">
    ${head ? '' : `<div class="zendesk-sticky">
    <div class="drawer-head">
      <div style="min-width:0"><div class="sub">#${t.id} · ${esc(d.org || '')}</div><h2>${esc(t.subject || '(no subject)')}</h2></div>
      <div class="row" style="gap:6px;flex:none">${zendeskButtons}</div>
    </div>
    <div class="row" style="margin:8px 0 12px">${pills}<span class="sub">${esc(st.who)}</span></div>
    </div>`}
    <div class="zd-card">
    <dl class="facts">
      <dt>Requester</dt><dd>${esc(d.requester?.name || '—')}</dd>
      <dt>Assignee</dt><dd>${esc(d.assignee?.name || 'Unassigned')}</dd>
      <dt>Created</dt><dd>${when(t.created_at)}</dd>
      <dt>Updated</dt><dd>${when(t.updated_at)}</dd>
      ${d.slaBreachAt ? `<dt>SLA breach</dt><dd>${when(d.slaBreachAt)}</dd>` : ''}
      ${t.due_at ? `<dt>Due</dt><dd>${when(t.due_at)}</dd>` : ''}
      ${t.tags?.length ? `<dt>Tags</dt><dd>${t.tags.map((x) => `<span class="pill">${esc(x)}</span>`).join(' ')}</dd>` : ''}
    </dl>
    ${reasons.length ? `<div class="reasons" style="margin:10px 0 0">${reasons.map(reasonPill).join('')}</div>` : ''}
    </div>
    <h3 class="drawer-sec">Conversation <span class="sub">oldest first · ${d.comments.length} ${d.comments.length === 30 ? 'latest ' : ''}shown</span></h3>
    <div class="thread">${d.comments.map((c) => `
      <div class="comment ${c.public ? '' : 'internal'} ${c.author?.agent ? 'agent' : 'customer'}">
        <div class="comment-head"><b>${esc(c.author?.me ? 'You' : c.author?.name || 'Unknown')}</b>
          ${c.public ? '' : '<span class="pill amber">internal note</span>'}
          ${c.attachments ? `<span class="pill">📎 ${c.attachments}</span>` : ''}
          <span class="sub">${when(c.created_at)}</span></div>
        ${commentHtml(c, zdOrigin)}
        ${commentFiles(c)}
      </div>`).join('') || '<div class="sub">No comments.</div>'}</div></div>`;
  const scroller = $('.zd-scroll', body);
  $('#zendeskReload', head ? head.actions : body).onclick = () => renderZendeskPanel(id, body, { fresh: true, head });
  // Header stays at the top while the Zendesk panel scrolls; a shadow shows once content is underneath.
  const sticky = $('.zendesk-sticky', body);
  scroller.onscroll = () => sticky?.classList.toggle('stuck', scroller.scrollTop > 4);
  // ---- Update the ticket yourself: status, internal note (with @mentions), assignee, followers
  //      (posted to Zendesk as you; the assistant never does this)
  const editable = ['open', 'pending', 'solved'];
  const dir = await zdDirectory().catch(() => []);
  if (stale()) return d;
  const cat = d.category; // shown next to the status buttons
  const missing = (d.missingToSolve || []).filter((m) => m.id !== cat?.id);
  const members = [...new Map(dir.flatMap((g) => g.agents).map((a) => [a.id, a])).values()].sort((a, b) => a.name.localeCompare(b.name));
  const agentName = (uid) => members.find((a) => a.id === uid)?.name || `User ${uid}`;
  const curFollowers = (d.followers || []).map((f) => f.id);
  const assignValue = (gid, aid) => `${gid || ''}:${aid || ''}`;
  const current = assignValue(d.groupId, d.assigneeId);
  body.insertAdjacentHTML('beforeend', `<form class="tk-update" id="tkUpdate">
    <div class="tk-grip" id="tkGrip" title="Drag up or down to resize the editor · double-click to reset" role="separator" aria-orientation="horizontal"></div>
    <div class="tk-top">
      <h3 class="drawer-sec" style="margin:0">Update ticket <span class="sub">posted to Zendesk as you</span></h3>
      <span class="tk-top-tools">
      <span class="tk-macro-wrap" id="tkMacroWrap"><button type="button" class="btn small" id="tkMacroBtn" title="Apply a Zendesk macro: fills the reply and the changes it makes; nothing is sent until you Submit">⚡ Macros</button>
        <div class="macro-pop" id="tkMacroPop" hidden><input id="tkMacroQ" placeholder="Search macros…" autocomplete="off"><div class="macro-list" id="tkMacroList"></div></div></span>
      <button type="button" class="rte-btn rte-toggle" id="tkFmt" title="Formatting toolbar" aria-pressed="false">Aa</button>
      <div class="tk-timer" title="Time spent on this ticket, logged to Zendesk on Submit (like the Time Tracking app)">
        <label class="check"><input type="checkbox" name="logTime" checked> ⏱</label>
        <button type="button" class="tk-time" id="tkTime" title="Click to set the time yourself">0:00:00</button>
        <input class="tk-time-edit" id="tkTimeEdit" hidden placeholder="e.g. 15m, 1h 20m, 0:45:00">
        <button type="button" class="icon-btn" id="tkPause" title="Pause">⏸</button>
        <button type="button" class="icon-btn" id="tkReset" title="Reset to 0">↺</button>
      </div>
      </span>
    </div>
    <div class="tk-compose internal" id="tkCompose">
      <div class="tk-compose-head">
        <div class="seg tk-mode"><button type="button" data-mode="public">Public reply</button><button type="button" data-mode="internal" class="active">Internal note</button></div>
        <span class="sub" id="tkModeHint">Only your team sees it. Type @ to mention a colleague.</span>
        <div class="tk-cc" id="tkCc" hidden>
          <div class="tk-cc-box"><span class="chip tk-to" title="Requester${d.requester?.email ? `: ${esc(d.requester.email)}` : ''}">${esc(d.requester?.name || 'Requester')}</span><span id="tkCcChips"></span><input id="tkCcInput" placeholder="CC people or emails" autocomplete="off"></div>
          <div class="mention-pop" id="tkCcPop" hidden></div>
        </div>
      </div>
      <div class="macro-applied" id="tkMacroApplied" hidden></div>
      ${rteToolbar()}
      <div class="tk-note">
        <div class="rte" id="tkEditor" contenteditable="true" role="textbox" aria-multiline="true" title="Drag the lower-right corner to resize; double-click it to reset"></div>
        <button type="button" class="rte-size" id="tkGrow" title="Open a big editor (or drag the corner to resize here)">⤢</button>
        <div class="mention-pop" id="tkMention" hidden></div>
      </div>
    </div>
    <div class="tk-people">
      <label class="tk-label">Assignee</label>
      <select name="assign" class="tk-add select tk-assign" title="Assignee">
        ${dir.map((g) => `<optgroup label="${esc(g.name)}">
          <option value="${g.id}:">${esc(g.name)} (group only, unassigned)</option>
          ${g.agents.map((a) => `<option value="${g.id}:${a.id}">${esc(a.name)}${a.id === d.assigneeId ? ' (current)' : ''}</option>`).join('')}
        </optgroup>`).join('')}
        ${dir.some((g) => assignValue(g.id, '') === current || g.agents.some((a) => assignValue(g.id, a.id) === current)) ? '' : `<option value="${current}">${esc(d.assignee?.name || 'Unassigned')} (current)</option>`}
      </select>
      <label class="tk-label">Followers</label>
      <span class="tk-chips" id="tkFollowers"></span>
    </div>
    ${missing.length ? `<div class="tk-grid">
      ${missing.map((m) => `<label class="tk-label tk-req" hidden>${esc(m.title)} *</label>
      ${m.options.length
        ? `<select class="select tk-req" data-field="${m.id}" hidden><option value="">Required to solve: choose…</option>${m.options.map((o) => `<option value="${esc(o.value)}">${esc(o.name)}</option>`).join('')}</select>`
        : `<input class="tk-req" data-field="${m.id}" placeholder="Required to solve" hidden>`}`).join('')}
    </div>` : ''}
    <div class="tk-actions">
      <div class="seg tk-status">${editable.map((s2) => `<button type="button" data-st="${s2}" class="${t.status === s2 ? 'active' : ''}">${s2 === 'solved' ? 'Solved' : s2[0].toUpperCase() + s2.slice(1)}</button>`).join('')}</div>
      ${cat ? `<select class="select tk-cat" data-field="${cat.id}" title="${esc(cat.title)}${cat.required ? ' (required to solve)' : ''}">${categoryOptions(cat)}</select>` : ''}
      <button class="btn primary" id="tkSubmit">Submit</button>
    </div>
    <div class="sub" id="tkSummary">Now: <b>${esc(st.label)}</b>. Change anything above, then Submit.</div>
  </form>`);
  const form = $('#tkUpdate');
  form.assign.value = current;
  let chosen = editable.includes(t.status) ? t.status : null;
  const followersNow = new Set(curFollowers);

  // ---- composer: public reply (to the requester + CCs) or internal note, with Zendesk-style formatting
  const editor = $('#tkEditor');
  let mode = 'internal';
  const curCcs = d.ccs || [];
  const ccRemove = new Set();   // existing CCs you took off
  const ccAdd = [];             // { id?, email, name }
  const setMode = (m) => {
    mode = m;
    $('#tkCompose').classList.toggle('internal', m === 'internal');
    $('#tkCompose').classList.toggle('public', m === 'public');
    form.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('active', b.dataset.mode === m));
    $('#tkCc').hidden = m !== 'public';
    $('#tkModeHint').hidden = m === 'public'; // public: the requester and CCs are shown instead
    editor.dataset.ph = m === 'public' ? 'Public reply to the customer…' : 'Internal note…';
    closePop();
    summarize();
  };
  wireRte(form.querySelector('.rte-bar'), editor, () => summarize(), { images: true });
  // Bigger / smaller editing area; the size you drag to (or pick) is remembered.
  try { const h = localStorage.getItem('mon.rteHeight'); if (h) editor.style.height = h; } catch { /* storage unavailable */ }
  const saveHeight = () => { if (bigPop) return; try { localStorage.setItem('mon.rteHeight', editor.style.height || ''); } catch { /* ignore */ } };
  new ResizeObserver(() => { if (editor.isConnected && editor.style.height) saveHeight(); }).observe(editor);
  // Pinned at the bottom of the Zendesk panel: resize from the grip on top (drag up = taller, the box grows upwards)
  const grip = $('#tkGrip');
  grip.addEventListener('pointerdown', (e) => {
    if (bigPop) return;
    e.preventDefault();
    try { grip.setPointerCapture(e.pointerId); } catch { /* lost pointer */ }
    const y0 = e.clientY, h0 = editor.offsetHeight;
    // leave room for the conversation above
    const max = Math.max(120, body.clientHeight - (form.offsetHeight - h0) - 140);
    grip.classList.add('dragging');
    const move = (ev) => { editor.style.height = `${Math.round(Math.min(max, Math.max(70, h0 + y0 - ev.clientY)))}px`; };
    const up = () => { grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', up); grip.classList.remove('dragging'); saveHeight(); };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
  });
  grip.addEventListener('dblclick', () => { editor.style.height = ''; try { localStorage.removeItem('mon.rteHeight'); } catch { /* ignore */ } });

  // ---- ⤢ Big editor: the whole Update ticket box (timer, reply/note, CC, macros, formatting,
  //      assignee, followers, status, category, Submit) moves into a large popup and works as usual.
  //      Submit sends as usual · Cancel throws away what changed since it opened ·
  //      click outside (or Esc) brings everything back to the Zendesk panel to keep editing.
  let bigPop = null; // { wrap, home, snap }
  editor.addEventListener('dblclick', (e) => {
    const rect = editor.getBoundingClientRect();
    if (bigPop || e.clientX < rect.right - 24 || e.clientY < rect.bottom - 24) return;
    editor.style.height = '';
    try { localStorage.removeItem('mon.rteHeight'); } catch { /* ignore */ }
  });
  const closeBig = (how) => {
    if (!bigPop) return;
    const { wrap, home, snap } = bigPop;
    bigPop = null;
    document.removeEventListener('keydown', bigKey, true);
    if (!home.isConnected) { wrap.remove(); toast('The Zendesk panel reloaded meanwhile; your text was not kept'); return; }
    home.replaceWith(form);                          // back into the Zendesk panel, where it was
    wrap.remove();
    if (how === 'cancel') {
      editor.innerHTML = snap.html;
      ccAdd.splice(0, ccAdd.length, ...snap.ccAdd); ccRemove.clear(); snap.ccRemove.forEach((x) => ccRemove.add(x));
      followersNow.clear(); snap.followers.forEach((x) => followersNow.add(x));
      form.assign.value = snap.assign; setStatus(snap.chosen);
      form.querySelectorAll('[data-field]').forEach((el) => { if (el.dataset.field in snap.fields) el.value = snap.fields[el.dataset.field]; });
      macro = snap.macro; drawMacroApplied();
      drawCcs(); drawFollowers(); setMode(snap.mode);
    }
    summarize();
    if (how !== 'submit') editor.focus();
  };
  const bigKey = (e) => {
    if (e.key !== 'Escape' || document.querySelector('.modal-wrap')) return; // a confirm dialog handles its own Esc
    if (!$('#tkMacroPop').hidden || !$('#tkMention').hidden || !$('#tkCcPop').hidden) return; // close the picker first
    if (e.target.closest?.('#tkTimeEdit')) return; // Esc there cancels the time edit
    e.preventDefault(); e.stopPropagation(); closeBig('keep');
  };
  $('#tkGrow').onclick = () => {
    if (bigPop) { closeBig('keep'); return; }
    const home = document.createElement('div');
    home.className = 'tk-compose-home';
    home.style.height = `${form.offsetHeight}px`;   // keep the Zendesk panel from jumping while it's away
    form.replaceWith(home);
    const wrap = document.createElement('div');
    wrap.className = 'big-compose-wrap';
    wrap.innerHTML = `<div class="big-compose" role="dialog" aria-modal="true" aria-label="Update #${t.id}">
      <div class="big-compose-head"><b>#${t.id}</b> <span class="sub big-compose-subj">${esc(t.subject || '')}</span><span class="big-compose-hint sub">Click outside to keep editing in the Zendesk panel</span><button type="button" class="btn small" data-big="cancel" title="Close and discard what you changed here">Cancel</button></div>
      <div class="big-compose-body"></div>
    </div>`;
    wrap.querySelector('.big-compose-body').append(form);
    document.body.append(wrap);
    bigPop = { wrap, home, snap: {
      html: editor.innerHTML, mode, ccAdd: [...ccAdd], ccRemove: [...ccRemove], macro, assign: form.assign.value, chosen,
      followers: [...followersNow], fields: Object.fromEntries([...form.querySelectorAll('[data-field]')].map((el) => [el.dataset.field, el.value])),
    } };
    wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) closeBig('keep'); });
    wrap.querySelector('[data-big="cancel"]').onclick = () => closeBig('cancel');
    // Submit (the box's own button): put the box back in the Zendesk panel first, then it sends as usual
    wrap.addEventListener('submit', () => closeBig('submit'), true);
    document.addEventListener('keydown', bigKey, true);
    editor.focus();
    const sel = getSelection(); sel.selectAllChildren(editor); sel.collapseToEnd();
  };
  // Formatting toolbar only when you want it (Aa), like Zendesk; remembered. Shortcuts work either way.
  const fmtBar = form.querySelector('.rte-bar'), fmtBtn = $('#tkFmt');
  const showFmt = (on) => {
    fmtBar.hidden = !on; fmtBtn.classList.toggle('active', on); fmtBtn.setAttribute('aria-pressed', String(on));
    try { localStorage.setItem('mon.rteBar', on ? '1' : '0'); } catch { /* ignore */ }
  };
  showFmt((() => { try { return localStorage.getItem('mon.rteBar') === '1'; } catch { return false; } })());
  fmtBtn.onclick = () => { showFmt(fmtBar.hidden); editor.focus(); };

  // ---- Zendesk macros: fill the reply and the changes the macro makes (status, assignee, tags,
  //      fields). Nothing is sent until you Submit; Undo puts everything back.
  let macro = null;            // { title, addTags, removeTags, fields: { id: value }, info: { id: {title,label} }, snap }
  let macroList = null, macroSel = 0, macroShown = [];
  const macroPop = $('#tkMacroPop'), macroQ = $('#tkMacroQ');
  const macroTitle = (s) => s.replace(/::/g, ' › ');
  const drawMacros = () => {
    const q = macroQ.value.trim().toLowerCase();
    macroShown = (macroList || []).filter((m) => !q || q.split(/\s+/).every((w) => m.title.toLowerCase().includes(w))).slice(0, 60);
    macroSel = Math.min(macroSel, Math.max(0, macroShown.length - 1));
    $('#tkMacroList').innerHTML = macroList === null ? '<div class="sub" style="padding:8px">Loading macros…</div>'
      : macroShown.map((m, i) => `<div class="item ${i === macroSel ? 'sel' : ''}" data-mi="${i}" title="${esc(m.description || m.title)}">${esc(macroTitle(m.title))}</div>`).join('')
        || `<div class="sub" style="padding:8px">${macroList.length ? 'No macro matches.' : 'No macros available to you.'}</div>`;
  };
  const openMacros = async () => {
    macroPop.hidden = false; macroQ.value = ''; macroSel = 0; drawMacros(); macroQ.focus();
    if (macroList === null) {
      try { macroList = await api('/api/zendesk/macros'); } catch (err) { macroList = []; toast(err.message); }
      if (!macroPop.hidden) drawMacros();
    }
  };
  const setStatus = (s2) => {
    chosen = s2;
    form.querySelectorAll('[data-st]').forEach((x) => x.classList.toggle('active', x.dataset.st === s2));
    showRequired();
  };
  const drawMacroApplied = () => {
    const box = $('#tkMacroApplied');
    if (!macro) { box.hidden = true; box.innerHTML = ''; return; }
    box.innerHTML = `<span>⚡ <b>${esc(macroTitle(macro.title))}</b>${macro.notes.length ? ` · ${esc(macro.notes.join(' · '))}` : ''}</span><button type="button" class="link" id="tkMacroUndo">Undo</button>`;
    box.hidden = false;
    $('#tkMacroUndo').onclick = () => {
      const s0 = macro.snap;
      editor.innerHTML = s0.html; form.assign.value = s0.assign; setStatus(s0.chosen); setMode(s0.mode);
      macro = null; drawMacroApplied(); summarize();
    };
  };
  const applyMacro = async (m) => {
    macroPop.hidden = true;
    const btn = $('#tkMacroBtn'); btn.disabled = true; btn.textContent = '⚡ Applying…';
    try {
      const r = await api(`/api/tickets/${t.id}/macros/${m.id}`);
      const snap = macro?.snap || { html: editor.innerHTML, assign: form.assign.value, chosen, mode };
      if (macro) { editor.innerHTML = snap.html; form.assign.value = snap.assign; setStatus(snap.chosen); } // a second macro replaces the first
      const notes = [];
      if (r.comment) {
        const add = tidyBlankRows(rteClean(r.comment.html)); // the macro's blank rows, one at most between paragraphs
        editor.innerHTML = rteHasContent(editor) ? `${editor.innerHTML}${add}` : add;
        if (!r.comment.public) { setMode('internal'); notes.push('internal note'); }
      }
      if (r.status) {
        if (editable.includes(r.status)) { setStatus(r.status); notes.push(`status → ${r.status}`); } else notes.push(`status → ${r.status} (set it in Zendesk)`);
      }
      if (r.groupId !== undefined || r.assigneeId !== undefined) {
        const [g0, a0] = form.assign.value.split(':');
        const v = assignValue(r.groupId !== undefined ? r.groupId : g0, r.assigneeId !== undefined ? r.assigneeId : (r.groupId !== undefined ? '' : a0));
        if ([...form.assign.options].some((o) => o.value === v)) { form.assign.value = v; notes.push('assignee changed'); } else notes.push('assignee (set it in Zendesk)');
      }
      if (r.addTags.length) notes.push(`+tags ${r.addTags.join(', ')}`);
      if (r.removeTags.length) notes.push(`−tags ${r.removeTags.join(', ')}`);
      for (const f of r.fields) notes.push(`${f.title} → ${f.label}`);
      macro = { title: m.title, addTags: r.addTags, removeTags: r.removeTags, fields: Object.fromEntries(r.fields.map((f) => [f.id, f.value])), info: Object.fromEntries(r.fields.map((f) => [f.id, f])), notes, snap };
      drawMacroApplied(); summarize();
      editor.focus();
      const sel = getSelection(); sel.selectAllChildren(editor); sel.collapseToEnd();
    } catch (err) { toast(err.message); } finally { btn.disabled = false; btn.textContent = '⚡ Macros'; }
  };
  $('#tkMacroBtn').onclick = () => (macroPop.hidden ? openMacros() : (macroPop.hidden = true));
  macroQ.addEventListener('input', () => { macroSel = 0; drawMacros(); });
  macroQ.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (macroShown.length) { macroSel = (macroSel + (e.key === 'ArrowDown' ? 1 : -1) + macroShown.length) % macroShown.length; drawMacros(); } }
    else if (e.key === 'Enter') { e.preventDefault(); if (macroShown[macroSel]) applyMacro(macroShown[macroSel]); }
    else if (e.key === 'Escape') { e.stopPropagation(); macroPop.hidden = true; }
  });
  $('#tkMacroList').addEventListener('mousedown', (e) => { const it = e.target.closest('[data-mi]'); if (it) { e.preventDefault(); applyMacro(macroShown[Number(it.dataset.mi)]); } });
  const macroOutside = (e) => {
    if (!form.isConnected) { document.removeEventListener('mousedown', macroOutside); return; }
    if (!e.target.closest('#tkMacroWrap')) macroPop.hidden = true;
  };
  document.addEventListener('mousedown', macroOutside);
  const drawCcs = () => {
    $('#tkCcChips').innerHTML = curCcs.map((p) => `<span class="chip ${ccRemove.has(p.id) ? 'removed' : 'locked'}" title="${esc(p.email)}">${esc(p.name)}<button type="button" data-ccx="${p.id}" title="${ccRemove.has(p.id) ? 'Keep' : 'Remove'}">${ccRemove.has(p.id) ? '↺' : '✕'}</button></span>`).join('')
      + ccAdd.map((p, i) => `<span class="chip new" title="${esc(p.email)}">${esc(p.name || p.email)}<button type="button" data-ccdel="${i}" title="Don't add">✕</button></span>`).join('');
  };
  drawCcs();
  const ccInput = $('#tkCcInput'), ccPop = $('#tkCcPop');
  let ccMatches = [], ccSel = 0, ccTimer = null, ccSeq = 0;
  const same = (a, b) => (a.id && a.id === b.id) || (!!a.email && !!b.email && a.email.toLowerCase() === b.email.toLowerCase());
  const ccTaken = (p) => curCcs.some((c) => same(p, c) && !ccRemove.has(c.id)) || ccAdd.some((c) => same(p, c));
  const addCc = (p) => {
    if (!p) return;
    const gone = curCcs.find((c) => same(p, c) && ccRemove.has(c.id));
    if (gone) ccRemove.delete(gone.id);
    else if (!ccTaken(p)) ccAdd.push(p);
    ccInput.value = ''; ccPop.hidden = true; drawCcs(); setMode('public');
  };
  const drawCcPop = () => {
    if (!ccMatches.length) { ccPop.hidden = true; return; }
    ccSel = Math.min(ccSel, ccMatches.length - 1);
    ccPop.innerHTML = ccMatches.map((p, i) => `<div class="item ${i === ccSel ? 'sel' : ''}" data-i="${i}"><b>${esc(p.name || p.email)}</b><span class="sub">${esc(p.raw ? 'add this address' : p.email)}</span></div>`).join('');
    ccPop.hidden = false;
  };
  const ccSearch = () => {
    const q = ccInput.value.trim();
    const ql = q.toLowerCase();
    if (!q) { ccMatches = []; drawCcPop(); return; }
    const local = members.filter((a) => a.name.toLowerCase().includes(ql)).map((a) => ({ id: a.id, name: a.name, email: a.email || '' }));
    const raw = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[a-z]{2,}$/i.test(q) ? [{ email: q, name: q, raw: true }] : [];
    ccMatches = [...raw, ...local].filter((p) => !ccTaken(p)).slice(0, 8);
    drawCcPop();
    clearTimeout(ccTimer);
    if (q.length < 2) return;
    const seq = ++ccSeq;
    ccTimer = setTimeout(async () => {
      const found = await api(`/api/zendesk/users?q=${encodeURIComponent(q)}`).catch(() => []);
      if (seq !== ccSeq || ccInput.value.trim() !== q) return;
      const seen = new Set(ccMatches.map((p) => p.id).filter(Boolean));
      ccMatches = [...ccMatches, ...found.filter((p) => !seen.has(p.id) && !ccTaken(p))].slice(0, 10);
      drawCcPop();
    }, 250);
  };
  ccInput.addEventListener('input', () => { ccSel = 0; ccSearch(); });
  ccInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !ccInput.value.trim()) e.preventDefault(); // never submit the form from here
    else if ((e.key === 'Enter' || e.key === ',' || e.key === ';') && ccInput.value.trim()) {
      e.preventDefault();
      if (!ccPop.hidden && ccMatches[ccSel]) addCc(ccMatches[ccSel]);
      else toast('Pick a person, or type a full email address');
    } else if (e.key === 'Backspace' && !ccInput.value && ccAdd.length) { ccAdd.pop(); drawCcs(); summarize(); }
    else if (!ccPop.hidden && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); ccSel = (ccSel + (e.key === 'ArrowDown' ? 1 : -1) + ccMatches.length) % ccMatches.length; drawCcPop(); }
    else if (e.key === 'Escape') { e.stopPropagation(); ccPop.hidden = true; }
  });
  ccInput.addEventListener('blur', () => setTimeout(() => { ccPop.hidden = true; }, 150));
  ccPop.addEventListener('mousedown', (e) => { const it = e.target.closest('.item'); if (it) { e.preventDefault(); addCc(ccMatches[Number(it.dataset.i)]); } });
  $('#tkCc').addEventListener('click', (e) => {
    const x = e.target.closest('[data-ccx]'), del = e.target.closest('[data-ccdel]');
    if (x) { const uid = Number(x.dataset.ccx); ccRemove.has(uid) ? ccRemove.delete(uid) : ccRemove.add(uid); drawCcs(); summarize(); }
    else if (del) { ccAdd.splice(Number(del.dataset.ccdel), 1); drawCcs(); summarize(); }
    else if (!e.target.closest('.chip')) ccInput.focus();
  });

  // ---- timer: counts while this ticket is open, pauses while you're on another ticket or page and
  //      carries on when you come back (kept per ticket); pause, reset, or type your own time before Submit
  const saved = tkTimerLoad(t.id) || {};
  let elapsed = saved.ms || 0, running = !saved.paused, lastTick = Date.now();
  if (saved.off) { form.logTime.checked = false; form.querySelector('.tk-timer').classList.add('off'); }
  const saveTimer = () => tkTimerSave(t.id, { ms: elapsed, paused: !running, off: !form.logTime.checked });
  const fmtTime = (sec) => `${Math.floor(sec / 3600)}:${String(Math.floor(sec / 60) % 60).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
  const seconds = () => Math.floor(elapsed / 1000);
  const tick = () => {
    if (!form.isConnected) { clearInterval(timerId); return; }   // Zendesk panel closed or reloaded
    const now = Date.now();
    if (running) elapsed += now - lastTick;
    lastTick = now;
    $('#tkTime').textContent = fmtTime(seconds());
    saveTimer();
  };
  const timerId = setInterval(tick, 1000);
  const setRunning = (on) => { tick(); running = on; $('#tkPause').textContent = on ? '⏸' : '▶'; $('#tkPause').title = on ? 'Pause' : 'Resume'; form.querySelector('.tk-timer').classList.toggle('paused', !on); };
  if (!running) setRunning(false); else tick();
  $('#tkPause').onclick = () => { setRunning(!running); saveTimer(); };
  $('#tkReset').onclick = () => { elapsed = 0; tick(); summarize(); };
  // "15m", "1h 20m", "90" (minutes), "1:30" (h:mm), "0:45:00"
  const parseTime = (v) => {
    v = String(v).trim().toLowerCase();
    if (!v) return null;
    if (/^\d+(:\d{1,2}){1,2}$/.test(v)) { const p = v.split(':').map(Number); return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 3600 + p[1] * 60; }
    const m = v.match(/^(?:(\d+(?:\.\d+)?)\s*h)?\s*(?:(\d+)\s*m(?:in)?)?\s*(?:(\d+)\s*s)?$/);
    if (m && (m[1] || m[2] || m[3])) return Math.round((Number(m[1] || 0) * 3600) + Number(m[2] || 0) * 60 + Number(m[3] || 0));
    if (/^\d+$/.test(v)) return Number(v) * 60;
    return null;
  };
  $('#tkTime').onclick = () => {
    const ed = $('#tkTimeEdit');
    ed.value = fmtTime(seconds());
    ed.hidden = false; $('#tkTime').hidden = true;
    ed.focus(); ed.select();
  };
  const finishEdit = (save) => {
    const ed = $('#tkTimeEdit');
    if (ed.hidden) return;
    if (save) {
      const sec = parseTime(ed.value);
      if (sec === null || sec > 24 * 3600) { toast('Time format: 15m, 1h 20m, 90, 1:30 or 0:45:00 (max 24h)'); ed.focus(); return; }
      elapsed = sec * 1000;
      lastTick = Date.now(); // keep counting from the time you typed (still paused if you had paused it)
    }
    ed.hidden = true; $('#tkTime').hidden = false;
    tick(); summarize();
  };
  $('#tkTimeEdit').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); finishEdit(true); } else if (e.key === 'Escape') { e.stopPropagation(); finishEdit(false); } };
  $('#tkTimeEdit').onblur = () => finishEdit(true);
  form.logTime.onchange = () => { form.querySelector('.tk-timer').classList.toggle('off', !form.logTime.checked); saveTimer(); summarize(); };

  // what will change, shown before you submit
  const reqFields = () => Object.fromEntries([...form.querySelectorAll('.tk-req[data-field]')].filter((el) => el.value).map((el) => [el.dataset.field, el.value]));
  const catSel = form.querySelector('.tk-cat');
  const catChoice = () => (catSel && catSel.value && catSel.value !== (cat.value || '') ? catSel.value : null);
  const showRequired = () => {
    form.querySelectorAll('.tk-req').forEach((el) => { el.hidden = chosen !== 'solved'; });
    catSel?.classList.toggle('need', chosen === 'solved' && !!cat.required && !catSel.value);
  };
  const fieldLabel = (fid, v) => {
    if (cat && String(cat.id) === fid) return `${cat.title} → ${(cat.options.find((o) => o.value === v)?.name || v).replace(/::/g, ' › ')}`;
    const mf = macro?.info?.[fid];
    if (mf && String(mf.value) === String(v)) return `${mf.title} → ${String(mf.label).replace(/::/g, ' › ')}`;
    return `${missing.find((m) => String(m.id) === fid)?.title || 'field'} → ${form.querySelector(`[data-field="${fid}"] option[value="${CSS.escape(v)}"]`)?.textContent || v}`;
  };
  form.querySelectorAll('[data-field]').forEach((el) => { el.onchange = () => { showRequired(); summarize(); }; });
  const diff = () => {
    const addFollowers = [...followersNow].filter((x) => !curFollowers.includes(x));
    const [g, a] = form.assign.value.split(':');
    const assignChanged = form.assign.value !== current;
    return {
      status: chosen && chosen !== t.status ? chosen : undefined,
      html: rteHasContent(editor) ? rteHtml(editor) : '',
      uploads: rteUploads(editor),
      public: mode === 'public',
      ccs: mode === 'public' ? { add: ccAdd.map((p) => (p.id ? { id: p.id } : { email: p.email })), remove: [...ccRemove] } : { add: [], remove: [] },
      addFollowers,
      timeSpent: form.logTime.checked ? seconds() : 0,
      fields: { ...(macro?.fields || {}), ...(chosen === 'solved' ? reqFields() : {}), ...(catChoice() ? { [cat.id]: catChoice() } : {}) },
      ...(macro?.addTags.length ? { addTags: macro.addTags } : {}),
      ...(macro?.removeTags.length ? { removeTags: macro.removeTags } : {}),
      ...(assignChanged ? { groupId: Number(g), assigneeId: a ? Number(a) : null } : {}),
    };
  };
  const summarize = () => {
    const x = diff();
    const parts = [];
    if (x.status) parts.push(`status → ${x.status}`);
    if (x.groupId !== undefined) parts.push(`assign → ${x.assigneeId ? agentName(x.assigneeId) : `${dir.find((g) => g.id === x.groupId)?.name} (group)`}`);
    if (x.addFollowers.length) parts.push(`+followers ${x.addFollowers.map(agentName).join(', ')}`);
    if (x.html) parts.push(x.public ? 'public reply' : 'internal note');
    if (x.html && x.uploads.length) parts.push(`${x.uploads.length} image${x.uploads.length === 1 ? '' : 's'}`);
    if (x.ccs.add.length) parts.push(`+CC ${ccAdd.map((p) => p.name || p.email).join(', ')}`);
    if (x.ccs.remove.length) parts.push(`−CC ${curCcs.filter((c) => ccRemove.has(c.id)).map((c) => c.name).join(', ')}`);
    if (x.addTags) parts.push(`+tags ${x.addTags.join(', ')}`);
    if (x.removeTags) parts.push(`−tags ${x.removeTags.join(', ')}`);
    for (const [fid, v] of Object.entries(x.fields || {})) parts.push(fieldLabel(fid, v));
    if (parts.length && x.timeSpent) parts.push('log time');
    $('#tkSummary').innerHTML = parts.length ? `Will change: <b>${esc(parts.join(' · '))}</b>` : `Now: <b>${esc(st.label)}</b>. Change anything above, then Submit.`;
    saveDraft();
    return x;
  };
  // ---- unsent draft, kept per ticket (see tkDraftSave); written on every change once restored
  let draftReady = false;
  const fieldVals = () => Object.fromEntries([...form.querySelectorAll('[data-field]')].map((el) => [el.dataset.field, el.value]));
  const fields0 = fieldVals();
  const status0 = chosen;
  const saveDraft = () => {
    if (!draftReady || !form.isConnected && !bigPop) return;
    const fv = fieldVals();
    const fieldsChanged = Object.keys(fv).some((k) => fv[k] !== fields0[k]);
    const addFollowers = [...followersNow].filter((x) => !curFollowers.includes(x));
    const any = rteHasContent(editor) || ccAdd.length || ccRemove.size || addFollowers.length || form.assign.value !== current
      || chosen !== status0 || fieldsChanged || macro || mode !== 'internal';
    if (!any) { tkDraftSave(t.id, null); return; }
    const clone = editor.cloneNode(true);
    clone.querySelectorAll('img.uploading').forEach((i) => i.remove()); // not uploaded yet: can't be restored
    tkDraftSave(t.id, { html: clone.innerHTML, mode, ccAdd, ccRemove: [...ccRemove], addFollowers, assign: form.assign.value, chosen, fields: fv, macro });
  };
  const drawFollowers = () => {
    const pool = members.filter((a) => !followersNow.has(a.id));
    $('#tkFollowers').innerHTML = [...followersNow].map((uid) => `<span class="chip ${curFollowers.includes(uid) ? 'locked' : 'new'}">${esc(agentName(uid))}${curFollowers.includes(uid) ? '' : `<button type="button" data-unfollow="${uid}" title="Don't add">✕</button>`}</span>`).join('')
      + `<select class="tk-add select" id="tkAddFollower"><option value="">+ add colleague</option>${pool.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join('')}</select>`;
    $('#tkAddFollower').onchange = (e) => { if (e.target.value) { followersNow.add(Number(e.target.value)); drawFollowers(); summarize(); } };
  };
  drawFollowers();

  // ---- @mention in the note: "@Tru" lists matching colleagues; picking one writes "@Truong Bui"
  //      and adds them as a follower (as tagging someone does in Zendesk)
  //      (internal notes only; in the editor it becomes the same mention link Zendesk's editor makes)
  const pop = $('#tkMention');
  let matches = [], sel = 0, atStart = -1, atNode = null, atEnd = 0;
  const query = () => {
    if (mode !== 'internal') return null;
    const s = getSelection();
    if (!s.rangeCount || !s.isCollapsed || !editor.contains(s.anchorNode) || s.anchorNode.nodeType !== Node.TEXT_NODE) return null;
    const before = s.anchorNode.textContent.slice(0, s.anchorOffset);
    const m = before.match(/(^|[\s ])@([^\s@ ][^@\n]{0,30})?$/);
    if (!m) return null;
    atNode = s.anchorNode; atEnd = s.anchorOffset;
    atStart = before.length - (m[2] || '').length - 1;
    return (m[2] || '').toLowerCase();
  };
  const closePop = () => { pop.hidden = true; matches = []; };
  const drawPop = () => {
    const q = query();
    if (q === null) { closePop(); return; }
    const words = q.split(/\s+/).filter(Boolean);
    matches = members.filter((a) => words.every((w) => a.name.toLowerCase().split(/\s+/).some((part) => part.startsWith(w)) || a.name.toLowerCase().includes(w))).slice(0, 8);
    if (!matches.length) { closePop(); return; }
    sel = Math.min(sel, matches.length - 1);
    pop.innerHTML = matches.map((a, i) => `<div class="item ${i === sel ? 'sel' : ''}" data-i="${i}"><b>${esc(a.name)}</b>${followersNow.has(a.id) ? '<span class="sub">following</span>' : '<span class="sub">will be added as follower</span>'}</div>`).join('');
    pop.hidden = false;
  };
  const pick = (i) => {
    const a = matches[i];
    if (!a || !atNode) return;
    const r = document.createRange();
    r.setStart(atNode, atStart); r.setEnd(atNode, atEnd);
    r.deleteContents();
    const link = document.createElement('a');
    link.href = `/users/${a.id}`; link.className = 'atmention'; link.contentEditable = 'false'; link.textContent = a.name;
    const space = document.createTextNode(' ');
    r.insertNode(space); r.insertNode(link);
    const s = getSelection(); s.removeAllRanges();
    const after = document.createRange(); after.setStart(space, 1); after.collapse(true); s.addRange(after);
    editor.focus();
    if (!followersNow.has(a.id)) { followersNow.add(a.id); drawFollowers(); }
    closePop();
    summarize();
  };
  editor.addEventListener('input', () => {
    if (/^(<(p|div)>)?<br>(<\/(p|div)>)?$/.test(editor.innerHTML)) editor.innerHTML = ''; // empty again: show the placeholder
    sel = 0; drawPop(); summarize();
  });
  editor.addEventListener('click', drawPop);
  editor.addEventListener('keydown', (e) => {
    if (pop.hidden) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length; drawPop(); }
    else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pick(sel); }
    else if (e.key === 'Escape') { e.stopPropagation(); closePop(); }
  });
  pop.addEventListener('mousedown', (e) => { const it = e.target.closest('.item'); if (it) { e.preventDefault(); pick(Number(it.dataset.i)); } });
  editor.addEventListener('blur', () => setTimeout(closePop, 150));
  setMode('internal');
  // bring back the unsent draft for this ticket, if any
  const draft = tkDraftLoad(t.id);
  if (draft) {
    editor.innerHTML = draft.html || '';
    ccAdd.splice(0, ccAdd.length, ...(draft.ccAdd || []));
    (draft.ccRemove || []).forEach((x) => { if (curCcs.some((c) => c.id === x)) ccRemove.add(x); });
    (draft.addFollowers || []).forEach((x) => followersNow.add(x));
    if (draft.assign && [...form.assign.options].some((o) => o.value === draft.assign)) form.assign.value = draft.assign;
    if (draft.chosen && editable.includes(draft.chosen)) setStatus(draft.chosen);
    form.querySelectorAll('[data-field]').forEach((el) => { if (draft.fields && el.dataset.field in draft.fields) el.value = draft.fields[el.dataset.field]; });
    macro = draft.macro || null; drawMacroApplied();
    drawCcs(); drawFollowers(); showRequired();
    setMode(draft.mode === 'public' ? 'public' : 'internal');
  }
  draftReady = true;
  summarize();

  form.addEventListener('click', (e) => {
    const mb = e.target.closest('[data-mode]'); if (mb) { setMode(mb.dataset.mode); editor.focus(); return; }
    const uf = e.target.closest('[data-unfollow]'); if (uf) { followersNow.delete(Number(uf.dataset.unfollow)); drawFollowers(); summarize(); return; }
    const sb = e.target.closest('[data-st]');
    if (sb) { chosen = sb.dataset.st; form.querySelectorAll('[data-st]').forEach((x) => x.classList.toggle('active', x === sb)); showRequired(); summarize(); }
  });
  form.assign.onchange = summarize;
  form.onsubmit = async (e) => {
    e.preventDefault();
    const x = summarize();
    const changes = { ...x };
    if (rteUploading(editor)) { toast('An image is still uploading to Zendesk. Submit again in a moment.'); return; }
    if (!changes.html) { delete changes.html; delete changes.public; }
    if (!changes.html || !changes.uploads.length) delete changes.uploads;
    if (!x.ccs.add.length && !x.ccs.remove.length) delete changes.ccs;
    else if (!changes.html) { toast('CC changes are sent with a public reply: write the reply first'); editor.focus(); return; }
    if (!x.addFollowers.length) delete changes.addFollowers;
    if (!Object.keys(x.fields || {}).length) delete changes.fields;
    // Zendesk won't solve a ticket with required fields (e.g. Category) left empty
    const stillMissing = x.status === 'solved' ? missing.filter((m) => !(x.fields || {})[m.id]) : [];
    if (x.status === 'solved' && cat?.required && !(catSel.value || cat.value)) { toast(`To solve, set: ${cat.title}`); showRequired(); catSel.focus(); return; }
    if (stillMissing.length) { toast(`To solve, set: ${stillMissing.map((m) => m.title).join(', ')}`); form.querySelector(`[data-field="${stillMissing[0].id}"]`)?.focus(); return; }
    tick();
    changes.timeSpent = form.logTime.checked ? seconds() : 0;
    const hasChange = Object.keys(changes).some((k) => k !== 'timeSpent' && changes[k] !== undefined);
    if (!hasChange && !changes.timeSpent) { toast('Change something first'); return; }
    const solving = x.status === 'solved';
    const reassigning = x.groupId !== undefined && (x.assigneeId !== d.assigneeId || x.groupId !== d.groupId);
    const replying = !!changes.public; // goes to the customer by email: always confirm
    if (solving || reassigning || replying || !hasChange) {
      const pill = (stt) => `<span class="status-pill st-${esc(stt)}">${esc(statusOf({ status: stt }).label)}</span>`;
      const rows = [];
      if (x.status) rows.push(['Status', `${pill(t.status)} → ${pill(x.status)}`]);
      for (const [fid, v] of Object.entries(changes.fields || {})) { const [k, val] = fieldLabel(fid, v).split(' → '); rows.push([k, esc(val)]); }
      if (x.groupId !== undefined) {
        const groupName = dir.find((g) => g.id === x.groupId)?.name || 'group';
        rows.push(['Assignee', `${esc(d.assignee?.name || 'Unassigned')} → <b>${esc(x.assigneeId ? agentName(x.assigneeId) : `${groupName} (group, unassigned)`)}</b>`]);
      }
      if (x.addFollowers.length) rows.push(['Followers', `+ ${esc(x.addFollowers.map(agentName).join(', '))}`]);
      if (x.addTags || x.removeTags) rows.push(['Tags', esc([...(x.addTags || []).map((g) => `+${g}`), ...(x.removeTags || []).map((g) => `−${g}`)].join('  '))]);
      if (changes.html) {
        if (replying) {
          const to = [d.requester?.name || 'Requester', ...curCcs.filter((c) => !ccRemove.has(c.id)).map((c) => c.name), ...ccAdd.map((p) => p.name || p.email)];
          rows.push(['To', esc(to.join(', '))]);
          if (ccRemove.size) rows.push(['CC removed', esc(curCcs.filter((c) => ccRemove.has(c.id)).map((c) => c.name).join(', '))]);
        }
        rows.push([replying ? 'Public reply' : 'Internal note', `<div class="modal-note rte-view">${rteHtml(editor, { preview: true })}</div>`]);
      }
      if (changes.timeSpent) rows.push(['Time logged', `<span class="mono">${fmtTime(changes.timeSpent)}</span>`]);
      const extra = [solving && 'solve', reassigning && 're-assign'].filter(Boolean).join(' and ');
      const title = replying ? `Send public reply on #${t.id}${extra ? ` and ${extra}` : ''}?`
        : `${extra ? extra[0].toUpperCase() + extra.slice(1) : 'Log time on'} #${t.id}?`;
      const okd = await confirmDialog({
        title,
        intro: `<b>${esc(t.subject || '')}</b><div class="sub">${replying ? 'The reply is emailed to the customer from Zendesk, as you.' : 'These changes are posted to Zendesk as you.'}</div>`,
        rows,
        ok: replying ? 'Send reply' : 'OK',
        
      });
      if (!okd) return;
    }
    const btn = $('#tkSubmit');
    btn.disabled = true; btn.textContent = 'Submitting…';
    try {
      await api(`/api/tickets/${t.id}/update`, { method: 'POST', body: changes });
      toast(`#${t.id} updated${changes.timeSpent ? ` · ${fmtTime(changes.timeSpent)} logged` : ''}`);
      clearInterval(timerId); tkTimerSave(t.id, null); // you updated the ticket: the next stretch starts at 0
      draftReady = false; tkDraftSave(t.id, null);       // sent: nothing left to keep
      renderZendeskPanel(t.id, body, { head });
    } catch (err) {
      toast(err.message);
      btn.disabled = false; btn.textContent = 'Submit';
    }
  };
  // Jump to the newest comment at the bottom, like Zendesk.
  if (d.comments.length > 2) scroller.scrollTop = scroller.scrollHeight;
  return d;
}

// ---------------- pages ----------------
async function dashboard() {
  view.innerHTML = `<div class="page-head"><div><h1>Good ${greeting()}</h1><div class="sub" id="syncLine">Loading…</div></div>
    <div class="row"><span id="zdAuthSlot"></span><button class="btn" id="syncBtn">Sync now</button><button class="btn primary" id="planBtn">Plan my day with AI</button></div></div>
    <div id="notice"></div>
    <div class="grid kpis" id="kpis"></div>
    <div class="grid two">
      <div class="card"><div class="row queue-bar"><h2 style="margin:0">Focus queue</h2><div class="seg small" id="queueSort" title="Sort order"></div><div class="seg" id="queueTabs"></div></div><div class="queue" id="queue"></div></div>
      <div class="grid">
        <div class="card"><h2 id="barsTitle">Solved this week</h2><div class="bars" id="bars"></div></div>
        <div class="card"><h2>By organization <span class="sub" style="font-weight:400">· this week</span></h2><div id="byOrg"></div></div>
        <div class="card"><h2>By assignee <span class="sub" style="font-weight:400">· this week</span></h2><div id="byAssignee"></div></div>
      </div>
    </div>`;
  $('#syncBtn').onclick = async (e) => { e.target.disabled = true; try { await api('/api/zendesk/sync', { method: 'POST', body: {} }); toast('Zendesk synced'); } catch (err) { toast(err.message); } e.target.disabled = false; };
  $('#planBtn').onclick = async () => {
    pendingPrompt = 'Plan my day: rank my open tickets by urgency (SLA, priority, staleness, customer waiting), group quick wins, and give me an ordered list with a one-line next action for each. Include my performance so far today.';
    await newChat(null, { title: `Plan for ${new Date().toLocaleDateString()}` });
  };
  await refreshDashboard();
}
/** Focus queue split by who the ticket is waiting on: me (new/open) or someone else (pending/hold). */
const isMine = (t) => !t.relation || t.relation === 'assigned';
/** Focus queue: my own tickets, and followed ones only when someone is waiting on me and the score is 40+. */
const inFocus = (t) => isMine(t) || t.relation === 'unassigned' || (!!t.needs_me && (t.score >= 40 || !!t.ignored));
/** Tag for tickets I follow / am CC'd on but that are assigned to someone else. */
function relPill(t) {
  if (isMine(t)) return '';
  if (t.relation === 'unassigned') return '<span class="rel-pill unassigned" title="Nobody is assigned yet">Unassigned</span>';
  if (t.needs_me) return `<span class="rel-pill mention" title="${esc(t.needs_me_reason || 'Mentioned you')}">@ Mentioned</span>`;
  if (t.relation === 'updated') return '<span class="rel-pill" title="You commented; assigned to someone else">Commented</span>';
  const cc = t.relation === 'cc';
  const tip = cc ? 'You are CC on this ticket; assigned to someone else' : 'You follow this ticket; assigned to someone else';
  return `<span class="rel-pill" title="${tip}">${cc ? 'CC' : 'Following'}</span>`;
}
const lsGet = (k, d) => { try { return localStorage.getItem(k) || d; } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } };
/**
 * Ticket rows for one queue section. Sorted by score (the order the server sends), or by client:
 * clients A→Z, each under its own small heading, tickets keeping their score order within a client.
 */
function queueRows(list, sort, limit) {
  if (sort !== 'client') return list.slice(0, limit).map(ticketRow).join('');
  const byOrg = new Map();
  for (const t of list) {
    const k = t.org || '';
    if (!byOrg.has(k)) byOrg.set(k, []);
    byOrg.get(k).push(t);
  }
  return [...byOrg.entries()]
    .sort(([a], [b]) => (!a) - (!b) || a.localeCompare(b, undefined, { sensitivity: 'base' }))
    .map(([org, ts]) => `<div class="queue-client">${clientBadge(org, ts[0].org_name)}<span>${esc(ts[0].org_name && ts[0].org_name !== org ? ts[0].org_name : org ? '' : 'No client')}</span><span class="count">${ts.length}</span></div>${ts.map(ticketRow).join('')}`)
    .join('');
}
function drawQueue(tickets, byMe = [], resolved = []) {
  let tab = lsGet('mon.queueTab', 'action');
  const sort = lsGet('mon.queueSort', 'score');
  const inQueue = tickets.filter(inFocus);
  // Left to right: Open · Pending · Cooled · My activity · Solved · All. Keys stay as before so a remembered tab still works.
  const groups = {
    action: { label: 'Open', tip: 'New and open tickets waiting on you, plus unassigned ones and mentions', list: inQueue.filter((t) => !t.ignored && (!isMine(t) || statusOf(t).group === 'action')) },
    waiting: { label: 'Pending', tip: 'Your tickets waiting on the customer (pending) or a third party (on hold)', list: inQueue.filter((t) => isMine(t) && statusOf(t).group === 'waiting') },
    ignored: { label: 'Cooled', tip: 'Tickets you cooled down: back in Open when something new happens on them', list: tickets.filter((t) => t.ignored) },
    mine: { label: 'My activity', tip: 'Tickets where you made the latest update in the last 24 hours', list: byMe },
    done: { label: 'Solved', tip: 'Solved and closed tickets, newest first', list: resolved },
    all: { label: 'All', tip: 'Open, Pending, Cooled and Solved together', list: [] },
  };
  const allSections = [['Open', groups.action.list], ['Pending · waiting on customer / third party', groups.waiting.list], ['Cooled', groups.ignored.list], ['Solved / Closed', groups.done.list]];
  groups.all.list = [...new Map(allSections.flatMap(([, l]) => l).map((t) => [t.id, t])).values()];
  $('#queueTabs').innerHTML = Object.entries(groups).map(([k, g]) =>
    `<button class="${k === tab ? 'active' : ''}" data-qtab="${k}" title="${esc(g.tip)}">${g.label} <span class="count">${g.list.length}</span></button>`).join('');
  $('#queueTabs').onclick = (e) => {
    const b = e.target.closest('[data-qtab]');
    if (!b) return;
    lsSet('mon.queueTab', b.dataset.qtab);
    drawQueue(tickets, byMe, resolved);
  };
  const sortDefault = tab === 'done' ? 'Newest' : tab === 'mine' ? 'Latest' : 'Score';
  $('#queueSort').innerHTML = [['score', sortDefault], ['client', 'Client']].map(([k, l]) =>
    `<button class="${k === sort ? 'active' : ''}" data-qsort="${k}" title="${k === 'client' ? 'Group tickets by client' : `Sort by ${l.toLowerCase()}`}">${l}</button>`).join('');
  $('#queueSort').onclick = (e) => {
    const b = e.target.closest('[data-qsort]');
    if (!b) return;
    lsSet('mon.queueSort', b.dataset.qsort);
    drawQueue(tickets, byMe, resolved);
  };
  if (!groups[tab]) tab = 'action'; // e.g. the removed Following tab was remembered
  const list = groups[tab].list;
  const empty = { action: 'Nothing is waiting on you. 🎉', waiting: 'No tickets are waiting on customers.', ignored: 'Nothing cooling down. Cool down parks a mentioned ticket until you are mentioned again, or an unassigned one until something new happens on it. A ticket whose chat you cooled down (⋯ menu) waits here until someone else updates it.', mine: 'No tickets where you made the latest update in the last 24 hours.', all: 'No tickets.', done: 'No solved or closed tickets synced yet. Tickets you solve, or that you follow and get solved, show here.' }[tab];
  if (!list.length) { $('#queue').innerHTML = `<div class="empty">${empty}</div>`; return; }
  if (tab === 'action') {
    const fresh = list.filter((t) => t.relation === 'unassigned'), rest = list.filter((t) => t.relation !== 'unassigned');
    $('#queue').innerHTML = (fresh.length ? `<div class="queue-head">New · unassigned · ${fresh.length}</div>${queueRows(fresh, sort)}` : '')
      + (rest.length ? `${fresh.length ? `<div class="queue-head">Your queue · ${rest.length}</div>` : ''}${queueRows(rest, sort, 40)}` : '');
  } else if (tab === 'all') {
    // One section per tab, in tab order, so the kinds stay visually apart.
    $('#queue').innerHTML = allSections.filter(([, l]) => l.length).map(([h, l]) => `<div class="queue-head">${h} · ${l.length}</div>${queueRows(l, sort, 200)}`).join('');
  } else {
    $('#queue').innerHTML = queueRows(list, sort, tab === 'mine' || tab === 'done' ? 200 : 40);
  }
}
const fmtDuration = (sec) => { const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60); return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`; };
function greeting() { const h = new Date().getHours(); return h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening'; }

/** Dashboard: Zendesk sign-in state and a one-click (re)sign-in, so Settings is never needed for it. */
function drawZendeskAuth(z) {
  const a = z.auth || {}, st = a.login?.status;
  const busy = st === 'running' || st === 'refreshing';
  // Signed out of the browser session (API-token setups count as configured and never need this).
  const needs = z.hasSubdomain && !z.configured && !busy;
  const slot = $('#zdAuthSlot');
  if (slot) {
    slot.innerHTML = busy ? `<span class="pill">${st === 'refreshing' ? 'Reconnecting to Zendesk…' : 'Waiting for Zendesk sign-in…'}</span>`
      : needs ? '<button class="btn primary" id="zdQuickLogin" title="Opens Zendesk in the mon.ai Edge window; it closes by itself once you are in">Sign in to Zendesk</button>'
      : '';
    $('#zdQuickLogin')?.addEventListener('click', zendeskQuickLogin);
  }
  $('#notice').innerHTML = !z.hasSubdomain ? '<div class="notice">Set your Zendesk subdomain in <a href="#/settings/general">Settings</a> to start syncing your tickets.</div>'
    : st === 'refreshing' ? '<div class="notice">Reconnecting to Zendesk in the background (no window)…</div>'
    : st === 'running' ? '<div class="notice">Finish signing in to Zendesk in the Edge window that opened; it closes by itself.</div>'
    : needs ? `<div class="notice">Zendesk is signed out${st === 'needs-login' ? ' and could not reconnect on its own (the SSO sign-in in the mon.ai Edge profile has expired)' : ''}. Click <b>Sign in to Zendesk</b> above.${a.login?.error ? ` Last attempt: ${esc(a.login.error)}` : ''}</div>`
    : z.status === 'error' ? `<div class="notice err">${esc(z.error)}</div>` : '';
}
async function zendeskQuickLogin(e) {
  const b = e?.currentTarget;
  if (b) b.disabled = true;
  try { await api('/api/zendesk/login', { method: 'POST', body: {} }); } catch (err) { toast(err.message); if (b) b.disabled = false; }
  refreshDashboard().catch(() => {});
}

async function refreshDashboard() {
  if (state.route.name !== 'dashboard') return;
  const [status, tickets, perf, byMe, allTickets, resolved] = await Promise.all([api('/api/status'), api('/api/tickets'), api('/api/performance'), api('/api/tickets/updated-by-me').catch(() => []), api('/api/tickets?scope=all').catch(() => []), api('/api/tickets?scope=resolved').catch(() => [])]);
  const z = status.zendesk;
  state.meId = z.me?.id || null;
  $('#syncLine').textContent = !z.configured ? 'Zendesk not connected' :
    z.status === 'error' ? `Sync error: ${z.error}` : `Zendesk ${z.status === 'syncing' ? 'syncing…' : `synced ${ago(z.lastSync)}`}${z.me ? ` as ${z.me.name}` : ''} · auto-refresh every poll`;
  drawZendeskAuth(z);
  const hot = tickets.filter((t) => inFocus(t) && !t.ignored && t.score >= 40 && (!isMine(t) || statusOf(t).group === 'action')).length;
  const s = perf.openByStatus || {};
  $('#kpis').innerHTML = [
    ['Solved today', perf.solvedToday ?? '–', 'tickets'],
    ['Logged today', perf.loggedToday ? fmtDuration(perf.loggedToday.seconds) : '–', perf.loggedToday ? `on ${perf.loggedToday.tickets.length} ticket${perf.loggedToday.tickets.length === 1 ? '' : 's'} · Time Tracking` : 'after the next sync'],
    ['Needs attention', hot, 'score ≥ 40, needing you'],
    ['Needs you', (s.new || 0) + (s.open || 0), `${s.new || 0} new · ${s.open || 0} open`],
    ['Waiting', (s.pending || 0) + (s.hold || 0), `${s.pending || 0} pending (customer) · ${s.hold || 0} on hold`],
  ].map(([l, v, h]) => `<div class="card kpi"><div class="label">${l}</div><div class="value">${v}</div><div class="hint">${esc(h)}</div></div>`).join('');
  drawQueue(tickets, byMe, resolved);
  // This week, Monday to Sunday.
  const days = (perf.solvedByDay || []).filter((d) => !perf.weekStart || d.date >= perf.weekStart);
  const todayStr = localDate(new Date());
  const weekStart = new Date((perf.weekStart || days[0]?.date || todayStr) + 'T00:00');
  const weekLabel = `${weekStart.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} – ${new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + 6).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`;
  const weekTotal = days.reduce((n, d) => n + (d.solved || 0), 0);
  $('#barsTitle').innerHTML = `Solved this week <span class="sub" style="font-weight:400">· ${esc(weekLabel)} · ${weekTotal} total</span>`;
  const max = Math.max(1, ...days.map((d) => d.solved || 0));
  $('#bars').innerHTML = days.length ? days.map((d) => `<div class="bar${d.date === todayStr ? ' today' : ''}${d.future ? ' future' : ''}" title="${d.date}: ${d.future ? 'later this week' : `${d.solved ?? '?'} solved`}">
      <span class="v">${d.future ? '' : d.solved ?? '–'}</span><div class="fill" style="height:${((d.solved || 0) / max) * 90}px"></div>
      <span>${new Date(d.date + 'T00:00').toLocaleDateString(undefined, { weekday: 'short' })}</span></div>`).join('')
    : '<div class="sub" style="grid-column:1/-1">No data yet.</div>';
  // My own tickets per client: open ones, and the ones resolved (solved/closed) since Monday.
  const byOrg = {};
  const row = (o) => (byOrg[o] ??= { open: [], resolved: 0 });
  for (const t of tickets.filter(isMine)) row(t.org).open.push(t);
  for (const t of allTickets) if (isMine(t) && ['solved', 'closed'].includes(t.status) && new Date(t.updated_at).getTime() >= weekStart.getTime()) row(t.org).resolved++;
  const top = (r) => (r.open.length ? Math.max(...r.open.map((t) => t.score)) : -Infinity);
  $('#byOrg').innerHTML = Object.keys(byOrg).length ? `<table class="dash-table"><tr><th>Org</th><th>Open</th><th>Hot</th><th title="Your tickets solved or closed since Monday">Resolved</th><th>Top score</th></tr>${Object.entries(byOrg)
    .sort((a, b) => top(b[1]) - top(a[1]) || b[1].resolved - a[1].resolved)
    .map(([o, r]) => `<tr><td><a href="#/org/${encodeURIComponent(o)}">${esc(o)}</a></td><td>${r.open.length}</td><td>${r.open.filter((t) => t.score >= 40).length}</td><td>${r.resolved}</td><td>${r.open.length ? Math.round(top(r)) : '–'}</td></tr>`).join('')}</table>
    <div class="sub" style="margin-top:6px">Resolved: your tickets solved or closed since Monday.</div>`
    : '<div class="sub">—</div>';
  drawByAssignee(perf.byAssignee);
}
const localDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Dashboard: agents active this week (from Monday): time logged, open tickets in their queue, resolved. */
function drawByAssignee(team) {
  const el = $('#byAssignee');
  if (!el) return;
  if (!team?.agents?.length) { el.innerHTML = `<div class="sub">${team ? 'No time logged or tickets resolved yet this week.' : 'Loads after the next sync.'}</div>`; return; }
  // Sort: click a column header; click again to flip the direction. Remembered in this browser.
  let sort = { key: 'seconds', dir: -1 };
  try { sort = JSON.parse(localStorage.getItem('mon.assigneeSort')) || sort; } catch { /* storage unavailable */ }
  const val = (a, k) => (k === 'name' ? a.name.toLowerCase() : a[k] ?? -1);
  const cmp = (a, b, k) => { const x = val(a, k), y = val(b, k); return x < y ? -1 : x > y ? 1 : 0; };
  const list = [...team.agents].sort((a, b) => sort.dir * cmp(a, b, sort.key) || -cmp(a, b, 'seconds') || cmp(a, b, 'name'));
  const maxSec = Math.max(1, ...list.map((a) => a.seconds));
  const th = (key, label, tip, num) => `<th class="sortable${num ? ' num' : ''}${sort.key === key ? ' sorted' : ''}" data-sort="${key}" title="${tip}">${label}<span class="sort-ind">${sort.key === key ? (sort.dir < 0 ? '▼' : '▲') : ''}</span></th>`;
  el.innerHTML = `<div class="assignee-scroll"><table class="assignees dash-table"><tr>${th('name', 'Assignee', 'Sort by name', false)}${th('seconds', 'Time logged', 'Time Tracking: time logged since Monday', true)}${th('open', 'In queue', 'Open tickets in their queue (new, open, pending, on hold)', true)}${th('resolved', 'Resolved', 'Tickets assigned to them, solved since Monday', true)}</tr>${list.map((a) => `<tr class="${a.me ? 'me' : ''}">
      <td>${esc(a.name)}${a.me ? ' <span class="sub">(you)</span>' : ''}</td>
      <td class="num">${a.seconds ? fmtDuration(a.seconds) : '–'}<div class="logbar" style="width:${(a.seconds / maxSec) * 100}%;${a.seconds ? '' : 'visibility:hidden'}"></div></td>
      <td class="num">${a.open ?? '–'}</td><td class="num">${a.resolved ?? '–'}</td></tr>`).join('')}</table></div>
    <div class="sub" style="margin-top:6px">Everyone with time logged or a ticket resolved since Monday${team.timeTracked ? '' : ' (Time Tracking fields not found, so no time logged)'} · updated ${ago(team.checkedAt)}, every 10 min.</div>`;
  el.onclick = (e) => {
    const h = e.target.closest('th[data-sort]');
    if (!h) return;
    const key = h.dataset.sort;
    const next = { key, dir: sort.key === key ? -sort.dir : key === 'name' ? 1 : -1 }; // numbers start high→low, names A→Z
    try { localStorage.setItem('mon.assigneeSort', JSON.stringify(next)); } catch { /* ignore */ }
    const top = el.querySelector('.assignee-scroll')?.scrollTop || 0;
    drawByAssignee(team);
    const s = el.querySelector('.assignee-scroll'); if (s) s.scrollTop = top;
  };
  fitAssignees();
}
/**
 * Let the By assignee list use the screen height that's left below it, so tall monitors show more
 * people without the dashboard itself scrolling. If the card starts below the fold, it keeps about 8 rows.
 */
function fitAssignees() {
  const s = $('.assignee-scroll');
  if (!s) return;
  const main = view, card = s.closest('.card');
  s.style.maxHeight = 'none';
  const top = s.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop;
  const below = card.getBoundingClientRect().bottom - s.getBoundingClientRect().bottom; // footnote + card padding
  const pad = parseFloat(getComputedStyle(main).paddingBottom) || 0;
  // Grow down to the bottom of the screen, or of the Focus queue if that's longer (the page scrolls for it anyway).
  const queue = $('#queue')?.closest('.card');
  const queueBottom = queue ? queue.getBoundingClientRect().bottom - main.getBoundingClientRect().top + main.scrollTop : 0;
  const room = Math.max(main.clientHeight - pad, queueBottom) - top - below;
  // Enough room (3+ rows): fit exactly, no page scroll. Card already below the fold: keep ~8 rows.
  s.style.maxHeight = `${Math.floor(room >= 150 ? room : 360)}px`;
}
window.addEventListener('resize', () => { if (state.route?.name === 'dashboard') fitAssignees(); });

// ---------- static data cache (client settings, Cloudflare zones, repos) ----------
// These rarely change, so they're fetched once and reused on every page; they're dropped
// when the server says settings or repos changed. Tickets, chats and sign-in stay live.
const staticCache = new Map();
function cached(key, loader) {
  if (!staticCache.has(key)) staticCache.set(key, loader().catch((e) => { staticCache.delete(key); throw e; }));
  return staticCache.get(key);
}
const invalidate = (...keys) => keys.forEach((k) => staticCache.delete(k));
const getAzureConfig = () => cached('azure', () => api('/api/config/azure').then((r) => r.value));
const getZones = () => cached('zones', () => api('/api/cloudflare/zones').catch(() => ({ zones: [] })));
const getRepos = () => cached('repos', () => api('/api/repos'));

/** Everything static about one client: Azure profile, Cloudflare zones, repos. */
async function clientInfo(org) {
  const [az, cf, repos] = await Promise.all([getAzureConfig(), getZones(), getRepos().catch(() => ({ repos: [] }))]);
  const same = (x) => String(x || '').toLowerCase() === String(org).toLowerCase();
  return {
    profile: (az.profiles || []).find((p) => same(p.org)) || null,
    zones: (cf.zones || []).filter((z) => same(z.client)),
    repos: (repos.repos || []).filter((r) => same(r.org)),
  };
}

/** Side panel for a client (client page and chat): Azure, Cloudflare, repositories. */
function clientPanelHtml(org, info, { compact = false } = {}) {
  const { profile: p, zones, repos } = info;
  const st = azStatus?.profiles?.find((x) => x.org === p?.org);
  const azure = p
    ? `${p.vpn?.required ? '<div class="row" style="margin-bottom:8px"><span class="pill vpn">🔒 VPN</span></div>' : ''}
       ${p.tenantId ? `<div class="signin-row" data-signin-row="${esc(p.org)}" data-env="${defaultEnv(p)}" data-vpn="${p.vpn?.required ? 'Dataweavers OpenVPN' : ''}">${signinButtons({ org: p.org, env: defaultEnv(p), vpn: p.vpn?.required ? 'Dataweavers OpenVPN' : '' }, st)}</div>` : ''}
       ${compact ? '' : `<div class="az-subs" style="margin-bottom:8px"><span><b>Prod</b> ${esc(p.subscriptionNames?.prod || p.subscriptions?.prod || '—')}</span><span><b>NonProd</b> ${esc(p.subscriptionNames?.nonprod || p.subscriptions?.nonprod || '—')}</span></div>`}
       ${azureActions(p)}`
    : `<div class="sub">No Azure details. <a href="#/settings/clients">Add them in Settings → Clients</a>.</div>`;
  const zoneList = zones.length
    ? zones.map((z) => `<div class="repo-name" style="padding:3px 0"><a class="btn small cf-btn" href="${esc(z.dashUrl)}" target="_blank" rel="noopener" data-cfopen="${esc(z.id)}">${CF_ICON}<span>Dashboard</span></a><span class="mono" style="font-size:12px">${esc(z.name)}</span></div>`).join('')
    : '<div class="sub">No zones linked.</div>';
  const repoList = repos.length
    ? repos.map((r) => `<div style="padding:3px 0"><div class="repo-name">${vscodeBtn(r.path)}${pullBtn(r)}<b>${esc(r.name)}</b>${compact ? '' : ` <span class="pill">${esc(r.branch || '?')}</span>`} ${r.changes ? `<span class="pill amber">${r.changes} changed</span>` : ''}</div>${compact ? '' : `<div class="sub mono">${esc(r.path)}</div>`}</div>`).join('')
    : '<div class="sub">No repositories for this client.</div>';
  return `<div class="card infra-card"><h2>Infrastructure</h2>
      <h3 class="infra-sub">Azure &amp; DevOps</h3>${azure}
      <h3 class="infra-sub">Cloudflare</h3>${zoneList}</div>
    <div class="card"><h2>Repositories</h2>${repoList}</div>`;
}

/** Client panel: client chip (links to the client), open tickets (the current one highlighted), Azure, Cloudflare, repositories. */
function clientSideHtml(org, info, tickets, current) {
  return `<div class="side-title">${clientBadge(org)}</div>
    <div class="card"><h2>Open tickets</h2>${tickets.length ? tickets.slice(0, 8).map((t) => `<div class="side-ticket ${Number(current) === t.id ? 'current' : ''}"><a class="link" href="#/ticket/${t.id}">#${t.id}</a> <span class="status-pill st-${esc(t.status)}">${esc(statusOf(t).label)}</span><div class="sub">${esc(t.subject)}</div></div>`).join('') : '<div class="sub">None open.</div>'}</div>
    ${clientPanelHtml(org, info, { compact: true })}`;
}

async function orgPage(org) {
  view.innerHTML = `<div class="page-head"><div><h1>${esc(org)}</h1><div class="sub">Tickets, chats, Azure and repositories for this client</div></div>
    <div class="row"><button class="btn primary" id="orgChat">New ${esc(org)} chat</button></div></div>
    <div class="grid two">
      <div class="card"><h2>Open tickets</h2><div class="queue" id="orgTickets"><span class="sub">Loading…</span></div></div>
      <div class="grid">
        <div class="card"><h2>Chats</h2><div id="orgSessions"></div></div>
        <div class="grid" id="orgPanel"></div>
      </div>
    </div>`;
  $('#orgChat').onclick = () => newChat(org);
  // Static part first (cached, instant after the first visit), live parts alongside.
  clientInfo(org).then((info) => { if (state.route.name === 'org' && state.route.id === org) $('#orgPanel').innerHTML = clientPanelHtml(org, info); });
  const [tickets, sessions] = await Promise.all([api(`/api/tickets?org=${encodeURIComponent(org)}`), api(`/api/sessions?org=${encodeURIComponent(org)}`)]);
  if (state.route.name !== 'org' || state.route.id !== org) return;
  $('#orgTickets').innerHTML = tickets.length ? tickets.map(ticketRow).join('') : '<div class="empty">No open tickets.</div>';
  $('#orgSessions').innerHTML = sessions.length ? sessions.map((s) => `<div class="row" style="justify-content:space-between;padding:4px 0"><a href="#/chat/${s.id}">${esc(s.title)}</a><span class="sub">${ago(s.updated_at)}</span></div>`).join('') : '<div class="sub">No chats yet.</div>';
  if (!azStatus || Date.now() - new Date(azStatus.checkedAt) > 5 * 60_000) refreshAzureStatus();
}

/** Only the live parts of a client page (used when tickets sync in the background). */
async function refreshOrgLive(org) {
  const [tickets, sessions] = await Promise.all([api(`/api/tickets?org=${encodeURIComponent(org)}`), api(`/api/sessions?org=${encodeURIComponent(org)}`)]);
  if (state.route.name !== 'org' || state.route.id !== org) return;
  $('#orgTickets').innerHTML = tickets.length ? tickets.map(ticketRow).join('') : '<div class="empty">No open tickets.</div>';
  $('#orgSessions').innerHTML = sessions.length ? sessions.map((s) => `<div class="row" style="justify-content:space-between;padding:4px 0"><a href="#/chat/${s.id}">${esc(s.title)}</a><span class="sub">${ago(s.updated_at)}</span></div>`).join('') : '<div class="sub">No chats yet.</div>';
}

// ---------- Azure & ADO: static client cards + live sign-in status ----------
const LOGIN_OPTIONS = [['cli', 'prod', 'Azure CLI · Prod'], ['cli', 'nonprod', 'Azure CLI · NonProd'], ['ps', 'prod', 'Az PowerShell · Prod'], ['ps', 'nonprod', 'Az PowerShell · NonProd']];

/** Sign-in pills for one client (from /api/azure/status). */
function signInPills(st) {
  if (!st) return '<span class="pill">checking…</span>';
  // ✓ works · ⚠ saved but expired (or MFA needed again) · … being checked · – not signed in
  const pill = (label, s) => {
    const where = s?.signedIn ? [s.prod && 'Prod', s.nonprod && 'NonProd'].filter(Boolean).join(' + ') : '';
    const who = `${s?.user ? ` as ${esc(s.user)}` : ''}${where ? ` · ${where}` : ''}`;
    if (!s?.signedIn) return `<span class="pill" title="Not signed in">– ${label}</span>`;
    if (s.valid === true) return `<span class="pill green" title="Signed in and working${who}">✓ ${label}</span>`;
    if (s.valid === false) return `<span class="pill amber" title="Saved sign-in has expired${who}. Use Login to sign in again.">⚠ ${label}</span>`;
    return `<span class="pill checking" title="Saved sign-in${who}; checking whether it still works…">… ${label}</span>`;
  };
  return pill('CLI', st.cli) + pill('PowerShell', st.ps);
}

/**
 * Actions for a client: Login menu (CLI / PowerShell × Prod / NonProd), Azure Portal, Azure DevOps,
 * Cloudflare Dashboard. `p` is the client's Azure profile, `zones` its Cloudflare zones.
 */
function azureActions(p, zones = []) {
  const vpn = p.vpn?.required ? 'Dataweavers OpenVPN' : '';
  const hasSub = (env) => !!p.subscriptions?.[env] || !!p[env]?.id;
  const login = p.tenantId
    ? `<div class="menu"><button type="button" class="btn small primary" data-menu>Login ▾</button>
        <div class="menu-list login-panel" data-org="${esc(p.org)}" hidden>
          <div class="lp-mode" role="tablist"><button type="button" data-lpmode="terminal">Open terminal</button><button type="button" data-lpmode="switch">Switch only</button></div>
          ${[['cli', 'Azure CLI'], ['ps', 'Az PowerShell']].map(([tool, name]) => `<div class="lp-row"><span class="lp-label">${name}</span>${['prod', 'nonprod'].map((env) =>
            `<button type="button" class="lp-btn" data-az-login="${esc(p.org)}" data-tool="${tool}" data-env="${env}" data-vpn="${vpn}" ${hasSub(env) ? '' : 'disabled title="No subscription set"'}>${env === 'prod' ? 'Prod' : 'NonProd'}</button>`).join('')}</div>`).join('')}
          <div class="lp-foot" data-vpn-note="${vpn ? ' · needs VPN' : ''}"></div>
        </div></div>`
    : '<a class="btn small" href="#/settings/clients" title="Add the tenant ID to sign in">Set tenant ID</a>';
  const cf = zones.length === 1
    ? `<a class="btn small cf-btn" href="${esc(zones[0].dashUrl)}" target="_blank" rel="noopener" data-cfopen="${esc(zones[0].id)}" title="${esc(zones[0].name)}">${CF_ICON}<span>Cloudflare</span></a>`
    : zones.length > 1
      ? `<div class="menu"><button type="button" class="btn small cf-btn" data-menu>${CF_ICON}<span>Cloudflare ▾</span></button>
          <div class="menu-list" hidden>${zones.map((z) => `<a href="${esc(z.dashUrl)}" target="_blank" rel="noopener" data-cfopen="${esc(z.id)}">${esc(z.name)}</a>`).join('')}</div></div>`
      : '';
  return `<div class="row az-actions">
    ${login}
    <button type="button" class="btn small" data-az-open="${esc(p.org)}" data-target="portal" data-vpn="${vpn}" ${p.tenantId ? '' : 'disabled'}>Azure Portal</button>
    ${(p.ado?.orgUrl) ? `<button type="button" class="btn small" data-az-open="${esc(p.org)}" data-target="ado" data-vpn="${vpn}">Azure DevOps</button>` : ''}
    ${cf}
  </div>`;
}

// Dropdown menus (Login, Cloudflare): toggle on click, close on outside click or after choosing.
// The panel is positioned with position: fixed next to its button, so card scroll areas can't clip it,
// and it opens upwards when there's no room below.
function placeMenu(btn, list) {
  const r = btn.getBoundingClientRect();
  list.style.position = 'fixed';
  list.style.left = `${Math.max(8, Math.min(r.left, innerWidth - list.offsetWidth - 8))}px`;
  const below = r.bottom + 6;
  list.style.top = `${below + list.offsetHeight > innerHeight - 8 ? Math.max(8, r.top - list.offsetHeight - 6) : below}px`;
}
const LP_HELP = {
  terminal: 'Opens a Windows Terminal tab in the client folder. Signs in only if needed. PowerShell: subscription for that tab only; CLI: for all terminals.',
  switch: 'No window. CLI: every terminal (VS Code too) uses it from the next command. PowerShell: new terminals use it.',
};
const lpMode = () => { try { return localStorage.getItem('mon.lpMode') || 'terminal'; } catch { return 'terminal'; } };
function paintLoginPanel(list) {
  const mode = lpMode();
  list.querySelectorAll('[data-lpmode]').forEach((b) => b.classList.toggle('active', b.dataset.lpmode === mode));
  const foot = list.querySelector('.lp-foot');
  if (foot) foot.textContent = LP_HELP[mode] + (foot.dataset.vpnNote || '');
}
document.addEventListener('click', (e) => {
  const m = e.target.closest('[data-lpmode]');
  if (!m) return;
  e.stopPropagation();
  try { localStorage.setItem('mon.lpMode', m.dataset.lpmode); } catch { /* ignore */ }
  paintLoginPanel(m.closest('.login-panel'));
}, true);
const closeMenus = () => document.querySelectorAll('.menu-list').forEach((l) => { l.hidden = true; });
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-menu]');
  for (const list of document.querySelectorAll('.menu-list')) if (!btn || list !== btn.nextElementSibling) list.hidden = true;
  if (btn) {
    const list = btn.nextElementSibling;
    list.hidden = !list.hidden;
    if (!list.hidden) {
      // mark the combinations you're already signed in to
      const st = list.dataset.org && azStatus?.profiles?.find((x) => x.org === list.dataset.org);
      for (const b of list.querySelectorAll('.lp-btn')) {
        const t = st?.[b.dataset.tool];
        b.classList.toggle('signed', !!(t?.[b.dataset.env] && t.valid === true));
        b.classList.toggle('expired', !!(t?.[b.dataset.env] && t.valid === false));
      }
      if (list.classList.contains('login-panel')) paintLoginPanel(list);
      placeMenu(btn, list);
    }
  } else if (e.target.closest('.menu-list a, .menu-list button:not(:disabled)')) e.target.closest('.menu-list').hidden = true;
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenus(); });
window.addEventListener('resize', closeMenus);
document.addEventListener('scroll', (e) => { if (!e.target.closest?.('.menu-list')) closeMenus(); }, true);

view.addEventListener('click', async (e) => {
  const login = e.target.closest('[data-az-login]');
  const open = e.target.closest('[data-az-open]');
  if (!login && !open) return;
  const el = login || open;
  const org = el.dataset.azLogin || el.dataset.azOpen;
  try {
    if (el.dataset.vpn && !(login && lpMode() === 'switch') && !(await confirmDialog({ title: `${org} requires VPN`, intro: `Connect <b>${esc(el.dataset.vpn)}</b> first, then press OK.` }))) return;
    if (login) {
      const body = { tool: login.dataset.tool, env: login.dataset.env };
      if (lpMode() === 'switch') {
        const r = await api(`/api/azure/${encodeURIComponent(org)}/switch`, { method: 'POST', body });
        toast(`${r.label}: current subscription is now ${r.subscription}`);
        refreshAzureStatus();
      } else {
        const r = await api(`/api/azure/${encodeURIComponent(org)}/login`, { method: 'POST', body });
        toast(`${r.label}: opened in ${r.terminal} (${r.cwd})`);
        watchSignIn();
      }
    } else {
      await api(`/api/azure/${encodeURIComponent(org)}/open`, { method: 'POST', body: { target: open.dataset.target } });
    }
  } catch (err) { toast(err.message); }
});

let azStatus = (() => { try { return JSON.parse(sessionStorage.getItem('mon.azStatus') || 'null'); } catch { return null; } })();
let azWatch = null;

/** Re-check sign-in every 10 s for 3 minutes after a login window opens. */
function watchSignIn() {
  clearInterval(azWatch);
  let n = 0;
  azWatch = setInterval(() => {
    if (++n > 9) { clearInterval(azWatch); return; }
    refreshAzureStatus(true);
  }, 20_000);
}

async function refreshAzureStatus(revalidate = false) {
  const line = $('#azChecked');
  if (line) line.innerHTML = '<span class="spinner"></span> Checking sign-in…';
  try {
    azStatus = await api(`/api/azure/status${revalidate ? '?revalidate=1' : ''}`);
    try { sessionStorage.setItem('mon.azStatus', JSON.stringify(azStatus)); } catch { /* ignore */ }
  } catch (err) { if (line) line.textContent = err.message; return; }
  for (const card of view.querySelectorAll('.az-card')) {
    const st = azStatus.profiles.find((x) => x.org === card.dataset.org);
    card.querySelector('[data-status]').innerHTML = signInPills(st);
  }
  for (const el of document.querySelectorAll('[data-status-org]')) el.innerHTML = signInPills(azStatus.profiles.find((x) => x.org === el.dataset.statusOrg));
  paintSigninRows();
  if ($('#azChecked')) $('#azChecked').innerHTML = `${azStatus.error ? `<span class="pill red" title="${esc(azStatus.error)}">Azure CLI error</span> ` : ''}${azStatus.validating ? '<span class="spinner"></span> Testing each sign-in…' : `Sign-ins tested ${azStatus.validatedAt ? ago(azStatus.validatedAt) : '—'}`} · <a href="#" id="azRecheck">Check again</a>`;
  $('#azRecheck')?.addEventListener('click', (e) => { e.preventDefault(); refreshAzureStatus(true); });
}

async function azurePage() {
  view.innerHTML = `<div class="page-head"><div><h1>Clients</h1><div class="sub" id="azChecked">Loading…</div></div>
    <div class="row"><input class="search" id="azFilter" placeholder="Filter clients, tenants, subscriptions…"><a class="btn" href="#/settings/clients">Edit clients</a></div></div><div id="azBody"></div>`;
  // Static: the client list from config and (cached) Cloudflare zones, so the page draws at once.
  const [az, cf] = await Promise.all([getAzureConfig(), getZones()]);
  const zonesFor = (org) => (cf.zones || []).filter((z) => (z.client || '').toLowerCase() === org.toLowerCase());
  const profiles = [...(az.profiles || [])].sort((a, b) => a.org.localeCompare(b.org));
  $('#azBody').innerHTML = `<div class="az-grid">${profiles.map((p) => {
    const st = azStatus?.profiles?.find((x) => x.org === p.org);
    return `<div class="card az-card" data-org="${esc(p.org)}" data-text="${esc([p.org, p.tenantId, p.subscriptions?.prod, p.subscriptionNames?.prod, p.subscriptions?.nonprod, p.subscriptionNames?.nonprod, p.ado?.orgUrl, p.vpn?.required ? 'vpn' : '', ...zonesFor(p.org).map((z) => z.name)].filter(Boolean).join(' '))}">
      <div class="az-top"><h2><a href="#/org/${encodeURIComponent(p.org)}">${esc(p.org)}</a></h2>
        ${p.vpn?.required ? '<span class="pill vpn" title="Connect Dataweavers OpenVPN first">🔒 VPN</span>' : ''}
        <span class="az-status" data-status>${signInPills(st)}</span></div>
      <div class="sub mono az-tenant">${p.tenantId ? esc(p.tenantId) : '<span class="pill amber">Tenant ID not set</span>'}</div>
      <div class="az-subs"><span><b>Prod</b> ${esc(p.subscriptionNames?.prod || p.subscriptions?.prod || '—')}</span><span><b>NonProd</b> ${esc(p.subscriptionNames?.nonprod || p.subscriptions?.nonprod || '—')}</span></div>
      ${azureActions(p, zonesFor(p.org))}
    </div>`;
  }).join('') || '<div class="empty">No clients yet. <a href="#/settings/clients">Add them in Settings → Clients</a>.</div>'}</div><div class="empty" id="azNone" hidden></div>`;
  const input = $('#azFilter');
  try { input.value = sessionStorage.getItem('mon.filter.az') || ''; } catch { /* ignore */ }
  input.oninput = () => { try { sessionStorage.setItem('mon.filter.az', input.value); } catch { /* ignore */ } applyAzureFilter(); };
  applyAzureFilter();
  // Live: only the sign-in status needs the Azure CLI.
  refreshAzureStatus();
}

function applyAzureFilter() {
  const input = $('#azFilter');
  if (!input) return;
  const q = input.value.trim().toLowerCase();
  let shown = 0;
  for (const card of view.querySelectorAll('.az-card')) {
    card.hidden = !!q && !hit(q, card.dataset.text);
    if (!card.hidden) shown++;
  }
  const none = $('#azNone');
  if (none) { none.hidden = !q || shown > 0; none.textContent = `No client matches “${q}”.`; }
}
window.addEventListener('focus', () => { if (['azure', 'clients', 'org', 'chat', 'ticket'].includes(state.route.name)) refreshAzureStatus(); });

/** Live text filter for a list page. `match(item, q)` decides, `draw(items)` renders. */
function filterBox(id, placeholder, items, match, draw) {
  const input = $(id);
  const saved = sessionStorage.getItem(`mon.filter.${id}`) || '';
  input.value = saved;
  const apply = () => {
    const q = input.value.trim().toLowerCase();
    sessionStorage.setItem(`mon.filter.${id}`, input.value);
    draw(q ? items.filter((it) => match(it, q)) : items, q);
  };
  input.placeholder = placeholder;
  input.oninput = apply;
  apply();
}
const hit = (q, ...vals) => q.split(/\s+/).every((w) => vals.some((v) => v && String(v).toLowerCase().includes(w)));

const CF_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="#f38020" d="M16.5 15.9l.3-1c.3-1 .2-1.9-.3-2.5-.4-.6-1.2-.9-2-1L6.4 11.3c-.1 0-.1 0-.2-.1v-.1c0-.1.1-.1.2-.1l8.2-.1c1-.1 2-.9 2.4-1.8l.5-1.2v-.2C17 5.4 15 3.7 12.6 3.7c-2.2 0-4.1 1.4-4.8 3.4-.4-.3-1-.5-1.6-.4-1 .1-1.9.9-2 2-.1.3 0 .5 0 .8C2.6 9.5 1 11.2 1 13.2c0 .2 0 .4.1.6 0 .1.1.1.2.1h15c.1 0 .2-.1.2-.2z"/><path fill="#faae40" d="M19.2 10.3h-.2c-.1 0-.1.1-.2.1l-.3 1.1c-.3 1-.2 1.9.3 2.5.4.6 1.2.9 2 1l1.7.1c.1 0 .1 0 .2.1v.1c0 .1-.1.1-.2.1l-1.8.1c-1 .1-2 .9-2.4 1.8l-.1.4c0 .1 0 .1.1.1h6c.1 0 .1 0 .1-.1.1-.4.2-.8.2-1.2 0-2.4-2-4.3-4.4-4.3"/></svg>';

const VSCODE_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M17.6 2.3 9.4 9.7 4.6 6.1 2.5 7.2v9.6l2.1 1.1 4.8-3.6 8.2 7.4 3.9-1.9V4.2l-3.9-1.9zM4.6 14.6V9.4L7.3 12l-2.7 2.6zm13 1.8L12.7 12l4.9-4.4v8.8z"/></svg>';
const vscodeBtn =(p) => `<button class="btn small vscode-btn" data-vscode="${esc(p)}" title="Open in VS Code">${VSCODE_ICON}<span>VS Code</span></button>`;
view.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-vscode]');
  if (!b) return;
  try {
    await api('/api/repos/open', { method: 'POST', body: { path: b.dataset.vscode } });
    toast('Opening in VS Code…');
    if (state.route.name === 'repos') reposPage(); // that org moves to the top
  } catch (err) { toast(err.message); }
});

/**
 * When you last acted on each organization: your latest git action (reflog: commit, pull,
 * checkout...) in its DW-Pipelines repo, or opening any of its repos in VS Code from mon.ai.
 * Organizations without a DW-Pipelines repo use their most recently touched repo instead.
 */
function orgActivity(repos) {
  const out = {};
  const bump = (org, at, label) => { if (at && (!out[org] || at > out[org].at)) out[org] = { at, label }; };
  const hasAnchor = new Set(repos.filter((r) => r.anchor).map((r) => r.org));
  for (const r of repos) {
    if (r.lastOpened) bump(r.org, r.lastOpened, `opened ${r.name} in VS Code`);
    if (r.myLast && (r.anchor || !hasAnchor.has(r.org))) bump(r.org, r.myLast.at, `${r.myLast.what} in ${r.name}`);
  }
  return out;
}

async function reposPage() {
  view.innerHTML = `<div class="page-head"><div><h1>Repositories</h1><div class="sub" id="repoSub"></div></div>
    <div class="row"><input class="search" id="repoFilter"><button class="btn" id="rescan">Rescan</button></div></div><div id="repoBody">Loading…</div>`;
  let allRepos = [];
  const render = (d) => {
    allRepos = d.repos || [];
    if (!d.scannedAt) { $('#repoSub').textContent = 'Scanning…'; $('#repoBody').innerHTML = '<div class="empty">Scanning repositories…</div>'; return; }
    $('#repoSub').textContent = `${d.repos.length} repos under ${(d.roots || []).join(', ') || 'no roots'} · scanned ${ago(d.scannedAt)}`;
    filterBox('#repoFilter', 'Filter by name, org, branch, path…', d.repos,
      (r, q) => hit(q, r.name, r.org, r.branch, r.path, r.remote, r.last?.subject, r.changes ? 'changed dirty' : 'clean'),
      (repos, q) => drawRepos({ ...d, repos }, q));
  };
  const drawRepos = (d, q) => {
    const by = {};
    for (const r of d.repos) (by[r.org] ??= []).push(r);
    if (q && !d.repos.length) { $('#repoBody').innerHTML = `<div class="empty">No repositories match “${esc(q)}”.</div>`; return; }
    // Organizations ordered by your most recent action, measured on the full list so filtering doesn't reshuffle.
    const act = orgActivity(allRepos);
    const orgs = Object.entries(by).sort(([a], [b]) => (act[b]?.at || '').localeCompare(act[a]?.at || '') || a.localeCompare(b));
    $('#repoBody').innerHTML = `${(d.missingRoots || []).map((r) => `<div class="notice">Root not found: ${esc(r)}</div>`).join('')}` + (orgs.map(([org, list]) => `
      <div class="card" style="margin-bottom:14px"><div class="row" style="justify-content:space-between;margin-bottom:6px"><h2 style="margin:0">${esc(org)}</h2>
        <span class="sub" title="${act[org] ? esc(new Date(act[org].at).toLocaleString()) : ''}">${act[org] ? `Your last action ${ago(act[org].at)} · ${esc(act[org].label)}` : 'No activity from you yet'}</span></div><table><tr><th>Repo</th><th>Branch</th><th>State</th><th>Last commit</th></tr>
      ${list.map((r) => `<tr><td><div class="repo-name">${vscodeBtn(r.path)}${pullBtn(r)}<b>${esc(r.name)}</b></div><div class="sub mono">${esc(r.path)}</div></td><td><span class="pill blue">${esc(r.branch || '?')}</span></td>
        <td>${r.error ? `<span class="pill red">${esc(r.error)}</span>` : `${r.changes ? `<span class="pill amber">${r.changes} changed</span>` : '<span class="pill green">clean</span>'} ${r.ahead ? `<span class="pill">↑${r.ahead}</span>` : ''} ${r.behind ? `<span class="pill">↓${r.behind}</span>` : ''}`}</td>
        <td>${r.last ? `${esc(r.last.subject)}<div class="sub">${esc(r.last.author)} · ${ago(r.last.date)}</div>` : ''}</td></tr>`).join('')}</table></div>`).join('') || '<div class="empty">No repositories found. Set your repo roots in <a href="#/settings/general">Settings → General</a>.</div>');
  };
  render(await api('/api/repos'));
  $('#rescan').onclick = async () => { $('#rescan').disabled = true; render(await api('/api/repos/scan', { method: 'POST', body: {} })); $('#rescan').disabled = false; };
}

// ---------------- chat ----------------
let modelsPromise = null;
const getModels = () => (modelsPromise ??= api('/api/claude/models').catch(() => { modelsPromise = null; return []; }));
const modelLabel = (models, v) => models.find((m) => m.value === v || m.resolvedModel === v || (m.value.startsWith('claude-') && v.startsWith(m.value)))?.displayName || v;
/** <option>s for a model <select>; `inherit` adds a "use the default" entry for per-chat overrides. */
function modelOptions(models, selected, inherit) {
  const list = models.some((m) => m.value === selected) || !selected ? models : [...models, { value: selected, displayName: selected }];
  return (inherit ? [`<option value="">${esc(inherit === true ? 'Default model (Settings)' : `Default model (${modelLabel(models, inherit)})`)}</option>`] : [])
    .concat(list.map((m) => `<option value="${esc(m.value)}" ${m.value === selected ? 'selected' : ''} title="${esc(m.description || '')}">${esc(m.displayName)}${m.description && m.value !== 'default' ? ` · ${esc(m.description)}` : ''}</option>`)).join('');
}
const modelTag = (c, models) => c.model ? `<div class="model-tag">${c.skill ? `/${esc(c.skill)} · ` : ''}${esc(modelLabel(models, c.model) || c.model)}${c.effort ? ` · ${esc(c.effort)} effort` : ''}</div>` : '';

marked.setOptions({ gfm: true, breaks: true });

/** Copy that also works on http://mon.ai (the Clipboard API needs a secure context). */
async function copyText(text) {
  try { if (window.isSecureContext && navigator.clipboard) { await navigator.clipboard.writeText(text); return true; } } catch { /* fall back */ }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
  document.body.append(ta);
  ta.select();
  const ok = document.execCommand('copy');
  ta.remove();
  return ok;
}
const COPY_ICON = '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="M8 3h11a2 2 0 0 1 2 2v11h-2V5H8V3zM4 7h11a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2zm0 2v11h11V9H4z"/></svg>';
const copyBtn = (label = 'Copy') => `<button type="button" class="copy-btn" data-copy>${COPY_ICON}<span>${label}</span></button>`;

/**
 * Copy as formatted text (HTML) with a plain-text fallback, so pasting into the Update ticket editor,
 * Zendesk, Outlook or Teams keeps headings, lists, links and tables. Uses the copy event, which also works on http.
 */
function copyRich(html, text) {
  let set = false;
  const on = (e) => { e.clipboardData.setData('text/html', html); e.clipboardData.setData('text/plain', text); e.preventDefault(); set = true; };
  document.addEventListener('copy', on, true);
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { /* not allowed */ }
  document.removeEventListener('copy', on, true);
  return ok && set;
}
/** A draft is Markdown, shown and copied formatted the way the Update ticket editor writes it (same tags). */
const draftHtml = (raw) => tidyBlankRows(spaceParas(rteClean(tblDefaults(marked.parse(raw))))).trim();
function draftCard(text) {
  const raw = text.replace(/^\n+|\s+$/g, '');
  const card = document.createElement('div');
  card.className = 'draft-card';
  card.innerHTML = `<div class="draft-head"><span>✉️ Draft</span>${copyBtn('Copy draft')}</div><div class="draft-text rte-view"></div>`;
  card.dataset.raw = raw;
  card.querySelector('.draft-text').innerHTML = draftHtml(raw);
  return card;
}

/** Markdown → safe HTML: drafts become cards with Copy, code blocks get Copy, links open in a new tab. */
function md(src) {
  const html = DOMPurify.sanitize(marked.parse(String(src || '')));
  const t = document.createElement('template');
  t.innerHTML = html;
  const root = t.content;
  // ```draft blocks
  for (const code of root.querySelectorAll('pre > code.language-draft')) code.parentElement.replaceWith(draftCard(code.textContent));
  // Older replies quoted drafts with ">": show those as draft cards too.
  for (const bq of root.querySelectorAll('blockquote')) {
    for (const br of bq.querySelectorAll('br')) br.replaceWith('\n');
    const parts = [...bq.children].map((el) => el.textContent.trim()).filter(Boolean);
    bq.replaceWith(draftCard(parts.length ? parts.join('\n\n') : bq.textContent));
  }
  for (const pre of root.querySelectorAll('pre')) {
    const wrap = document.createElement('div');
    wrap.className = 'code-wrap';
    pre.replaceWith(wrap);
    wrap.append(pre);
    wrap.insertAdjacentHTML('afterbegin', copyBtn());
  }
  for (const table of root.querySelectorAll('table')) {
    if (table.closest('.draft-card')) continue; // copied as is; the draft text scrolls sideways instead
    const wrap = document.createElement('div');
    wrap.className = 'table-wrap';
    table.replaceWith(wrap);
    wrap.append(table);
  }
  for (const a of root.querySelectorAll('a[href]')) {
    if (/^https?:/i.test(a.getAttribute('href'))) { a.target = '_blank'; a.rel = 'noopener'; }
  }
  return t.innerHTML;
}

// Copy buttons anywhere in the page (drafts, code, whole answers).
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-copy]');
  if (!b) return;
  const box = b.closest('.draft-card, .code-wrap, .msg');
  const draft = b.dataset.copyText == null && b.dataset.copy !== 'answer' && box.classList.contains('draft-card');
  const text = b.dataset.copyText != null ? b.dataset.copyText : b.dataset.copy === 'answer'
    ? box.dataset.raw || box.querySelector('.body')?.innerText || ''
    : draft ? box.dataset.raw || box.querySelector('.draft-text').innerText : box.querySelector('pre')?.innerText || '';
  const ok = (draft && copyRich(draftHtml(text), text)) || await copyText(text);
  const label = b.querySelector('span');
  const old = label.textContent;
  label.textContent = ok ? 'Copied' : 'Copy failed';
  b.classList.toggle('done', ok);
  setTimeout(() => { label.textContent = old; b.classList.remove('done'); }, 1500);
});

/** Collapsible "what I did": progress notes and tool calls, grouped (Grep ×9). */
// ---------- Live activity (what the assistant is doing), like Claude Desktop's step list ----------
const short = (s, n = 80) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
const lastPart = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || p;
/** A tool call in plain words: { icon, label, detail }. */
function describeTool(t) {
  const i = t.input || {};
  const zone = i.zone ? ` · ${i.zone}` : '';
  if (t.name.startsWith('skill: ')) return { icon: '✦', label: `Using skill /${t.name.slice(7)}`, detail: '' };
  switch (t.name) {
    case 'my_tickets': return { icon: '🎫', label: 'Listing my tickets', detail: i.org || '' };
    case 'zendesk_ticket': return { icon: '🎫', label: `Reading ticket #${i.id ?? i.ticketId ?? ''}`, detail: '' };
    case 'zendesk_search': return { icon: '🔎', label: 'Searching Zendesk', detail: short(i.query) };
    case 'past_chats': return { icon: '🗂', label: 'Searching past chats', detail: short(i.query || i.org || '') };
    case 'daily_performance': return { icon: '📈', label: 'Checking performance', detail: '' };
    case 'cloudflare_zones': return { icon: '☁', label: 'Listing Cloudflare zones', detail: '' };
    case 'cloudflare_get': return { icon: '☁', label: 'Cloudflare API', detail: short(i.path) };
    case 'cloudflare_security_events': return { icon: '🛡', label: 'Cloudflare security events', detail: short(`${[i.action, i.clientRequestPath || i.path, i.since && `since ${i.since}`].filter(Boolean).join(' · ')}${zone}`) };
    case 'cloudflare_security_top': return { icon: '🛡', label: `Top Cloudflare events by ${(i.by || []).join(', ')}`, detail: short(zone.slice(3)) };
    case 'incident_timeline': return { icon: '⏱', label: 'Building the incident timeline', detail: short([i.ticket && `#${i.ticket}`, i.org, i.host, i.from && `${i.from} → ${i.to || 'now'}`].filter(Boolean).join(' · ')) };
    case 'site24x7_monitors': return { icon: '📡', label: 'Site24x7 monitor status', detail: short([i.search, (i.status || []).join(', ')].filter(Boolean).join(' · ')) };
    case 'site24x7_outages': return { icon: '📡', label: 'Site24x7 outages', detail: short([i.host || i.monitorId, i.from && `${i.from} → ${i.to || 'now'}`].filter(Boolean).join(' · ')) };
    case 'site24x7_poll_log': return { icon: '📡', label: 'Site24x7 check log', detail: short(`${i.monitorId} · ${i.date}`) };
    case 'site24x7_get': return { icon: '📡', label: 'Site24x7 API', detail: short(i.path) };
    case 'squadcast_incidents': return { icon: '🚨', label: 'Squadcast incidents', detail: short([i.org, i.search, i.from && `${i.from} → ${i.to || 'now'}`].filter(Boolean).join(' · ')) };
    case 'squadcast_get': return { icon: '🚨', label: 'Squadcast API', detail: short(i.path) };
    case 'azure_profiles': return { icon: '🔑', label: 'Checking Azure sign-ins', detail: '' };
    case 'azure_cli': {
      const a = i.args || [];
      const flag = a.findIndex((x) => x.startsWith('-'));
      const res = a[a.indexOf('--resource') + 1];
      const metrics = a[a.indexOf('--metrics') + 1];
      return { icon: '▣', label: `Azure CLI: az ${(flag === -1 ? a : a.slice(0, flag)).join(' ')}`, detail: short([i.org, res && a.includes('--resource') && lastPart(res), metrics && a.includes('--metrics') && metrics].filter(Boolean).join(' · ')) };
    }
    case 'azure_chart': return { icon: '📈', label: i.kind === 'metrics' || /ChartDefinition/i.test(i.portalUrl || '') ? 'Charting Azure metrics' : 'Running a KQL query', detail: short([i.title, i.resource && lastPart(i.resource), (i.metrics || []).map((m) => m.name).join(', '), i.timespan].filter(Boolean).join(' · ') || (i.query || i.portalUrl || '')) };
    case 'ado_query': return { icon: '📋', label: 'Azure DevOps query', detail: short(`${i.org || ''} ${i.wiql || ''}`) };
    case 'ado_my_work': return { icon: '📋', label: 'My Azure DevOps work', detail: i.org || '' };
    case 'git_repos': return { icon: '⎇', label: 'Listing repositories', detail: i.org || '' };
    case 'offer_git_pull': return { icon: '⎇', label: 'Checking for new commits', detail: short(lastPart(i.repo || '')) };
    case 'git_log': return { icon: '⎇', label: 'Reading git history', detail: short(lastPart(i.repo || i.path)) };
    case 'propose_plan': return { icon: '📝', label: 'Writing a plan', detail: short(i.title || '') };
    case 'Read': return { icon: '📄', label: `Reading ${lastPart(i.file_path)}`, detail: short(i.file_path, 90) };
    case 'Grep': return { icon: '🔎', label: `Searching code for “${short(i.pattern, 40)}”`, detail: short(i.path || i.glob || '') };
    case 'Glob': return { icon: '📁', label: 'Finding files', detail: short(i.pattern) };
    default: return { icon: '•', label: t.name, detail: short(JSON.stringify(i), 90) };
  }
}
const fmtSecs = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`; };
// Running clocks ("37s") tick once a second wherever they are on the page.
setInterval(() => document.querySelectorAll('[data-clock]').forEach((el) => { el.textContent = fmtSecs(Date.now() - Number(el.dataset.clock)); }), 1000);

/**
 * The steps of a reply: the assistant's notes and its tool calls in order, each tool with ✓ / ✕,
 * how long it took and a one-line result. Open while it runs (current step spinning, a clock in the
 * header); collapsed to "Worked through N steps · time" when done.
 */
function workLog(c, running = false) {
  const notes = c.notes || [], tools = c.tools || [];
  if (!notes.length && !tools.length && !running) return '';
  const skill = tools.find((t) => t.name.startsWith('skill: '))?.name.slice(7);
  const failed = tools.filter((t) => t.ok === false).length;
  const current = running ? [...tools].reverse().find((t) => t.ms == null) : null;
  const toolRow = (t) => {
    const d = describeTool(t);
    const state = t.ms == null ? (running ? 'run' : 'done') : t.ok === false ? 'err' : 'ok';
    const mark = state === 'run' ? '<span class="spinner"></span>' : state === 'err' ? '✕' : '✓';
    return `<li class="wl-step ${state}" title="${esc(JSON.stringify(t.input || {}).slice(0, 800))}">
      <span class="wl-mark">${mark}</span><span class="wl-icon">${d.icon}</span>
      <span class="wl-text"><span class="wl-label">${esc(d.label)}</span>${d.detail ? `<span class="wl-detail">${esc(d.detail)}</span>` : ''}${t.summary ? `<span class="wl-result">${esc(t.summary)}</span>` : ''}</span>
      <span class="wl-time">${t.ms != null ? fmtSecs(t.ms) : state === 'run' && t.at ? `<span data-clock="${t.at}">${fmtSecs(Date.now() - t.at)}</span>` : ''}</span></li>`;
  };
  // Interleave: tool t came after t.n notes. Older replies have no n: their tools go after the notes.
  const steps = [];
  const byN = (k) => tools.filter((t) => (t.n ?? notes.length) === k).map(toolRow);
  steps.push(...byN(0));
  notes.forEach((n, k) => { steps.push(`<li class="wl-note"><div class="md">${md(n)}</div></li>`); steps.push(...byN(k + 1)); });
  steps.push(...tools.filter((t) => (t.n ?? notes.length) > notes.length).map(toolRow));
  const doneLabel = `Worked through ${tools.length} step${tools.length === 1 ? '' : 's'}${c.durationMs ? ` · ${fmtSecs(c.durationMs)}` : ''}${failed ? ` · <span class="wl-fail">${failed} failed</span>` : ''}${skill ? ` · skill <b>${esc(skill)}</b>` : ''}`;
  const runLabel = current ? (() => { const d = describeTool(current); return `${esc(d.label)}${d.detail ? ` <span class="wl-detail">${esc(d.detail)}</span>` : ''}`; })()
    : esc(notes.at(-1)?.split('\n')[0].slice(0, 140) || (tools.length ? 'Thinking about the results…' : 'Thinking…'));
  const summary = running
    ? `<span class="spinner"></span><span class="wl-now">${runLabel}</span>${c.startedAt ? `<span class="wl-clock" data-clock="${c.startedAt}">${fmtSecs(Date.now() - c.startedAt)}</span>` : ''}`
    : doneLabel;
  return `<details class="worklog ${running ? 'running' : ''}" ${running ? 'open' : ''}><summary>${summary}</summary>
    ${steps.length ? `<ol class="wl-steps">${steps.join('')}</ol>` : ''}
  </details>`;
}

// Skills end with "Next: /skill-name args" when the next step needs its own message (for example
// to run on a stronger model). The line is shown as a button instead of text.
const NEXT_RE = /^[ \t]*(?:[-*][ \t]+)?(?:\*\*)?Next(?:\*\*)?[ \t]*:[ \t]*(?:\*\*)?[ \t]*`?(\/[a-z0-9][a-z0-9-]*(?:[ \t]+[^`\n*]*?)?)`?(?:[ \t]+[—–|-][ \t]+([^\n]*?))?(?:\*\*)?[ \t]*\.?[ \t]*$/gim;
// "Next: /skill args — why" : the part after " — " is the reason, shown on the button, not sent.
function splitNext(text = '') {
  const next = [];
  const body = String(text).replace(NEXT_RE, (_m, raw, reason) => {
    const [cmd, ...why] = raw.trim().split(/\s+[—–]\s+|\s+\|\s+|\s+-\s+(?=[A-Za-z])/);
    if (reason) why.push(reason.replace(/\*\*/g, ''));
    if (!next.some((n) => n.cmd === cmd.trim())) next.push({ cmd: cmd.trim(), why: why.join(' — ').trim() });
    return '';
  }).replace(/```\s*```/g, '').replace(/\n{3,}/g, '\n\n').trim();
  return { body, next: next.slice(0, 6) };
}

// ---------- Action plans (propose_plan): what mon.ai would do on my behalf. Stage 1: shown only. ----------
const PLAN_ICONS = {
  zendesk_public_reply: ['✉️', 'Public reply'], zendesk_internal_note: ['🗒', 'Internal note'], zendesk_set_status: ['🔁', 'Set status'],
  zendesk_assign: ['👤', 'Re-assign'], zendesk_add_followers: ['👥', 'Add followers'], zendesk_set_fields: ['🏷', 'Set fields'],
  zendesk_log_time: ['⏱', 'Log time'], azure_cli: ['▣', 'Azure CLI'], cloudflare_change: ['☁', 'Cloudflare'],
  ado_update: ['📋', 'Azure DevOps'], git: ['⎇', 'Git'], manual: ['✋', 'You do this'],
};
/** Plain-text version of a plan, for Copy plan. */
function planText(p) {
  const lines = [`Plan: ${p.title}`, p.goal ? `Goal: ${p.goal}` : '', ''];
  p.steps.forEach((s, i) => {
    lines.push(`${i + 1}. [${(PLAN_ICONS[s.action] || ['', s.action])[1]}] ${s.summary}${s.target ? ` (${s.target})` : ''}`);
    for (const [k, v] of Object.entries(s.params || {})) {
      const text = /expression$/i.test(k) && typeof v === 'string' ? formatCfExpression(stripFence(v))
        : /expressionbuilder$/i.test(k) ? builderText(v)
        : typeof v === 'string' ? v : JSON.stringify(v, null, 2);
      lines.push(`   ${paramLabel(k)}:${text.includes('\n') ? `\n${text.split('\n').map((l) => `      ${l}`).join('\n')}` : ` ${text}`}`);
    }
    if (s.content) lines.push(s.content.split('\n').map((l) => `   | ${l}`).join('\n'));
    if (s.why) lines.push(`   Why: ${s.why}`);
  });
  if (p.assumptions?.length) lines.push('', 'Assumptions:', ...p.assumptions.map((a) => `- ${a}`));
  return lines.filter((l, i) => l || i > 1).join('\n');
}
/**
 * Pretty-print a Cloudflare rules expression the way it reads best in the dashboard's expression editor:
 * each and/or operand of a long group on its own line, nested groups indented by 4, long `in { }` lists
 * one value per line. Expressions that already contain line breaks are kept as written.
 */
function formatCfExpression(src) {
  const s = String(src || '').trim();
  if (!s || s.includes('\n')) return s;
  // Tokens: strings, { sets }, function calls f(...), parentheses, operators and plain words.
  const toks = [];
  let i = 0;
  const readBalanced = (open, close) => {
    let depth = 0; const start = i;
    while (i < s.length) {
      const c = s[i];
      if (c === '"') { i++; while (i < s.length && s[i] !== '"') i += s[i] === '\\' ? 2 : 1; } else if (c === open) depth++;
      else if (c === close && --depth === 0) { i++; break; }
      i++;
    }
    return s.slice(start, i);
  };
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '(' || c === ')') { toks.push({ t: c }); i++; continue; }
    if (c === '"') { const st = i; i++; while (i < s.length && s[i] !== '"') i += s[i] === '\\' ? 2 : 1; i++; toks.push({ t: 'w', v: s.slice(st, i) }); continue; }
    if (c === '{') { toks.push({ t: 'set', v: readBalanced('{', '}') }); continue; }
    const m = s.slice(i).match(/^(&&|\|\||[A-Za-z_][\w.]*\(|[^\s(){}"]+)/);
    if (!m) { toks.push({ t: 'w', v: c }); i++; continue; }
    if (m[1].endsWith('(')) { toks.push({ t: 'w', v: readBalanced('(', ')') }); continue; }
    i += m[1].length;
    toks.push(/^(and|or|xor|&&|\|\|)$/i.test(m[1]) ? { t: 'op', v: m[1] } : { t: 'w', v: m[1] });
  }
  // Tree: a group is a list of operands (arrays of words / sub-groups) separated by operators.
  let k = 0;
  const parseGroup = () => {
    const items = []; let cur = [];
    while (k < toks.length) {
      const tk = toks[k++];
      if (tk.t === ')') break;
      if (tk.t === '(') cur.push({ group: parseGroup() });
      else if (tk.t === 'op') { items.push({ operand: cur }, { op: tk.v }); cur = []; } else cur.push(tk);
    }
    if (cur.length) items.push({ operand: cur });
    return items;
  };
  const tree = parseGroup();
  const IND = '    ';
  const flat = (items) => items.map((it) => (it.op ? it.op : it.operand.map((x) => (x.group ? `(${flat(x.group)})` : x.v)).join(' '))).join(' ');
  const setLines = (v, ind) => {
    const vals = v.slice(1, -1).match(/"(?:[^"\\]|\\.)*"|[^\s"]+/g) || [];
    return v.length + ind.length <= 100 ? `{${vals.join(' ')}}` : `{\n${vals.map((x) => ind + IND + x).join('\n')}\n${ind}}`;
  };
  const operand = (o, ind) => o.map((x) => (x.group ? render(x.group, ind, true) : x.t === 'set' ? setLines(x.v, ind) : x.v)).join(' ');
  function render(items, ind, paren) {
    const oneLine = flat(items);
    if (oneLine.length + ind.length <= 100 && !items.some((it) => it.operand?.some((x) => x.t === 'set' && x.v.length > 60))) return paren ? `(${oneLine})` : oneLine;
    const inner = paren ? ind + IND : ind;
    const lines = [];
    let afterOp = false;
    items.forEach((it) => {
      if (it.op) { lines[lines.length - 1] += ` ${it.op}`; afterOp = true; return; }
      const text = operand(it.operand, inner);
      // ") and (" style: a multi-line group continues the line of the operator before it
      if (afterOp && text.startsWith('(\n')) lines[lines.length - 1] += ` ${text}`;
      else lines.push(inner + text);
      afterOp = false;
    });
    return paren ? `(\n${lines.join('\n')}\n${ind})` : lines.join('\n').replace(/^\s+/, '');
  }
  return render(tree, '', false);
}

// Field labels and layout for plan step params (e.g. a Cloudflare dashboard change).
const PARAM_LABELS = {
  ruleType: 'Rule type', ruleName: 'Rule name', expressionBuilder: 'Expression builder', currentExpressionBuilder: 'Current builder',
  expression: 'Expression', currentExpression: 'Current expression', actions: 'Action', currentAction: 'Current action',
  additionalConfig: 'Additional config', order: 'Order', deploy: 'Draft / deploy', rollback: 'Rollback',
};
const PARAM_COPY = new Set(['ruleName', 'expression', 'currentExpression']);
const paramLabel = (k) => PARAM_LABELS[k] || k.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
const stripFence = (v) => String(v).trim().replace(/^```[\w-]*\n?/, '').replace(/\n?```$/, '').trim();
const smallCopy = (text, label = 'Copy') => `<button type="button" class="copy-btn" data-copy data-copy-text="${esc(text)}">${COPY_ICON}<span>${label}</span></button>`;

/** The dashboard's expression builder: groups (joined by OR) of Field / Operator / Value rows (joined by AND). */
function builderHtml(b) {
  const groups = Array.isArray(b) ? b : b?.groups;
  if (!Array.isArray(groups)) return null;
  const join = (b?.join || 'Or').replace(/^./, (c) => c.toUpperCase());
  const value = (v) => {
    const vals = Array.isArray(v) ? v : [v];
    return `<div class="pb-vals">${vals.map((x) => `<span class="pb-val"><code>${esc(String(x ?? ''))}</code>${smallCopy(String(x ?? ''), '')}</span>`).join('')}</div>`;
  };
  return `<div class="pb">${groups.map((g, gi) => {
    const conds = Array.isArray(g) ? g : g.conditions || [];
    const gJoin = (g.join || 'And').replace(/^./, (c) => c.toUpperCase());
    return `${gi ? `<div class="pb-join">${esc(join)}</div>` : ''}<div class="pb-group">${g.label ? `<div class="pb-label">${esc(g.label)}</div>` : ''}
      <table class="pb-table"><thead><tr><th></th><th>Field</th><th>Operator</th><th>Value</th></tr></thead><tbody>${conds.map((c, ci) => `<tr>
        <td class="pb-and">${ci ? esc(gJoin) : ''}</td><td>${esc(c.field || '')}</td><td>${esc(c.operator || '')}</td><td>${value(c.value)}</td></tr>`).join('')}</tbody></table></div>`;
  }).join('')}</div>`;
}

/** The builder as plain text (Copy plan): one line per condition, groups separated by Or. */
function builderText(b) {
  if (typeof b === 'string') { try { b = JSON.parse(stripFence(b)); } catch { return b; } }
  const groups = Array.isArray(b) ? b : b?.groups;
  if (!Array.isArray(groups)) return JSON.stringify(b, null, 2);
  return groups.map((g, gi) => {
    const conds = Array.isArray(g) ? g : g.conditions || [];
    return [gi ? (b.join || 'Or').toUpperCase() : null, g.label ? `[${g.label}]` : null,
      ...conds.map((c, ci) => `${ci ? `${(g.join || 'And').toUpperCase()} ` : ''}${c.field} | ${c.operator} | ${Array.isArray(c.value) ? c.value.join(', ') : c.value}`)].filter(Boolean).join('\n');
  }).join('\n');
}

/** One param of a plan step: short values inline, long ones (expressions, builders) as collapsible blocks. */
function paramHtml(k, v, params) {
  const label = paramLabel(k);
  if (/expressionbuilder$/i.test(k)) {
    if (typeof v === 'string' && /^\s*[[{]/.test(stripFence(v))) { try { v = JSON.parse(stripFence(v)); } catch { /* shown as text */ } }
    const html = builderHtml(v);
    if (html) return `<details class="pp-block" ${k === 'expressionBuilder' ? 'open' : ''}><summary>${esc(label)}${k === 'expressionBuilder' ? ' <span class="pill green">use this</span>' : ''}</summary>${html}</details>`;
  }
  if (/expression$/i.test(k) && typeof v === 'string') {
    const code = formatCfExpression(stripFence(v));
    const open = k === 'expression' && !params.expressionBuilder;
    return `<details class="pp-block" ${open ? 'open' : ''}><summary>${esc(label)}${k === 'expression' && params.expressionBuilder ? ' <span class="muted">same rule as text, for Edit expression</span>' : ''}</summary>
      <div class="pp-code"><pre>${esc(code)}</pre>${smallCopy(code)}</div></details>`;
  }
  let text = typeof v === 'string' ? v : Array.isArray(v) && v.every((x) => typeof x !== 'object') ? v.join('\n') : JSON.stringify(v, null, 2);
  text = stripFence(text);
  // The dashboard form's own fields always stay visible; other long values fold away.
  const core = ['ruleType', 'ruleName', 'actions', 'additionalConfig', 'order', 'deploy'].includes(k);
  const long = !core && (text.length > 160 || text.split('\n').length > 3);
  if (long) return `<details class="pp-block"><summary>${esc(label)} <span class="muted">${esc(text.split('\n')[0].slice(0, 80))}…</span></summary><div class="pp-text">${esc(text)}</div></details>`;
  return `<div class="pp-row"><span class="pp-k">${esc(label)}</span><span class="pp-v">${esc(text)}${PARAM_COPY.has(k) ? smallCopy(text, '') : ''}</span></div>`;
}
function paramsHtml(params) {
  const order = Object.keys(PARAM_LABELS);
  const keys = Object.keys(params).sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));
  return `<div class="plan-params">${keys.map((k) => paramHtml(k, params[k], params)).join('')}</div>`;
}

function planCard(p) {
  if (!p?.steps?.length) return '';
  const steps = p.steps.map((s, i) => {
    const [icon, kind] = PLAN_ICONS[s.action] || ['•', s.action];
    const risk = s.risk || (s.action === 'zendesk_public_reply' ? 'high' : '');
    return `<li class="plan-step">
      <span class="plan-num">${i + 1}</span>
      <div class="plan-main">
        <div class="plan-line"><span class="plan-kind">${icon} ${esc(kind)}</span>${s.target ? `<span class="pill">${esc(s.target)}</span>` : ''}${risk ? `<span class="pill ${risk === 'high' ? 'red' : risk === 'medium' ? 'amber' : 'green'}">${esc(risk)} risk</span>` : ''}${s.reversible === false ? '<span class="pill amber">can\'t undo</span>' : ''}</div>
        <div class="plan-summary">${esc(s.summary)}</div>
        ${s.params && Object.keys(s.params).length ? paramsHtml(s.params) : ''}
        ${s.content ? `<div class="plan-content">${esc(s.content)}</div>` : ''}
        ${s.why ? `<div class="plan-why">${esc(s.why)}</div>` : ''}
      </div></li>`;
  }).join('');
  const list = (title, xs) => (xs?.length ? `<div class="plan-extra"><b>${title}</b><ul>${xs.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : '');
  return `<div class="plan-card" data-plan="${esc(JSON.stringify(p))}">
    <div class="plan-head"><span>📝 Plan · ${p.steps.length} step${p.steps.length === 1 ? '' : 's'}</span><span class="pill">${p.org ? `${esc(p.org)} · ` : ''}${p.ticketId ? `#${esc(p.ticketId)} · ` : ''}not run</span></div>
    <div class="plan-title">${esc(p.title)}</div>
    ${p.goal ? `<div class="plan-goal">${esc(p.goal)}</div>` : ''}
    <ol class="plan-steps">${steps}</ol>
    ${list('Checked', p.checks)}${list('Assumptions to confirm', p.assumptions)}
    <div class="plan-foot">
      <span class="plan-note">Nothing has been run. mon.ai only proposes plans for now.</span>
      <span class="plan-actions">
        <button type="button" class="btn" data-plan-revise>✎ Revise</button>
        <button type="button" class="copy-btn" data-plan-copy>${COPY_ICON}<span>Copy plan</span></button>
        <button type="button" class="btn primary" disabled title="Running plans comes in the next stage">▶ Approve &amp; run</button>
      </span>
    </div>
  </div>`;
}
document.addEventListener('click', async (e) => {
  const copy = e.target.closest('[data-plan-copy]');
  const revise = e.target.closest('[data-plan-revise]');
  if (!copy && !revise) return;
  const card = e.target.closest('.plan-card');
  const p = JSON.parse(card.dataset.plan);
  if (copy) {
    const label = copy.querySelector('span');
    const ok = await copyText(planText(p));
    label.textContent = ok ? 'Copied' : 'Copy failed';
    setTimeout(() => { label.textContent = 'Copy plan'; }, 1500);
    return;
  }
  // Revise: put a starter in the message box; the next message asks for an updated plan.
  const box = document.querySelector('#input');
  if (!box) return;
  const t = `Revise the plan "${p.title}": `;
  if (box.isContentEditable) { box.textContent = t; placeCaretEnd(box); } else { box.value = t; box.focus(); }
});

// ---------- Azure sign-in buttons (CLI + PowerShell): chat card and client sidebar ----------
// Same buttons everywhere: [data-az-signin=org][data-tool=cli|ps]. A click opens the sign-in terminal,
// then mon.ai checks every 10 s (3 min) and repaints every button / card for that client and tool.
const SIGNIN_TOOLS = [['cli', 'Azure CLI'], ['ps', 'PowerShell']];

/** State of one tool's sign-in from /api/azure/status: ok · checking · expired · none · unknown. */
function signinState(st, tool) {
  const s = st?.[tool];
  if (!st) return 'unknown';
  if (!s?.signedIn) return 'none';
  return s.valid === true ? 'ok' : s.valid === false ? 'expired' : 'checking';
}

/** `t` = { org, env, vpn }; `force` = tool → state to show regardless of the cached status (e.g. the call that just failed). */
function signinButtons(t, st, force = {}) {
  return SIGNIN_TOOLS.map(([tool, name]) => {
    const state = force[tool] || signinState(st, tool);
    const user = st?.[tool]?.user;
    const label = state === 'ok' ? `✓ ${name}` : state === 'checking' ? `… ${name}` : `Sign in · ${name}`;
    const title = state === 'ok' ? `${name} is signed in${user ? ` as ${user}` : ''}. Click to sign in again.`
      : state === 'expired' ? `${name} sign-in has expired: sign in again`
        : state === 'checking' ? `Checking the saved ${name} sign-in… Click to sign in anyway.`
          : `Sign in to ${t.org} with ${name === 'PowerShell' ? 'Az PowerShell' : name}`;
    return `<button type="button" class="btn small signin-btn ${state}" data-az-signin="${esc(t.org)}" data-tool="${tool}" data-env="${esc(t.env || 'prod')}" data-vpn="${esc(t.vpn || '')}" title="${esc(title)}">${esc(label)}</button>`;
  }).join('');
}
const defaultEnv = (p) => (p?.subscriptions?.prod || p?.prod?.id ? 'prod' : 'nonprod');

/** Repaint the sidebar buttons from the latest status (called by refreshAzureStatus). */
function paintSigninRows() {
  for (const el of document.querySelectorAll('[data-signin-row]')) {
    const st = azStatus?.profiles?.find((x) => x.org === el.dataset.signinRow);
    if ([...signinPolls.keys()].some((k) => k.startsWith(`${el.dataset.signinRow}|`))) continue; // a sign-in is in progress: keep its spinner
    el.innerHTML = signinButtons({ org: el.dataset.signinRow, env: el.dataset.env, vpn: el.dataset.vpn }, st);
  }
}

/** Site24x7 (browser sign-in) or Squadcast (API token) card, shown when one of their tools was refused. */
function serviceSigninCard(si) {
  const s24 = si.service === 'site24x7';
  const busy = s24 && ['running', 'refreshing'].includes(site24x7Auth?.login?.status);
  return `<div class="signin-card" data-signin="${esc(JSON.stringify(si))}" data-service-signin="${esc(si.service)}">
    <div class="signin-main">
      <span class="signin-icon">🔑</span>
      <div><div class="signin-title">${s24 ? 'Site24x7 sign-in needed' : 'Squadcast token needed'}</div>
      <div class="signin-sub" data-signin-msg>${s24
        ? 'mon.ai reads Site24x7 with your browser sign-in, and it is missing or expired. Sign in opens a separate Edge window: sign in with Zoho as usual and it closes by itself.'
        : 'Squadcast refused the API token (missing, expired or revoked). Paste a new one from your Squadcast profile → API Token in Settings › General.'}</div></div>
    </div>
    <div class="signin-actions">
      ${s24
        ? `<button type="button" class="btn small signin-btn ${busy ? 'waiting' : ''}" data-service-login="site24x7">${busy ? '<span class="spinner"></span> Waiting for sign-in…' : 'Sign in to Site24x7'}</button>`
        : '<a class="btn small" href="#/settings/general">Open Settings</a>'}
      <button type="button" class="btn small" data-service-check="${esc(si.service)}" title="Check the sign-in now">${s24 ? "I've signed in" : "I've added it"}</button>
      <button type="button" class="btn small primary" data-signin-retry hidden>↻ Retry</button>
    </div>
  </div>`;
}

/** The service works now: flip its chat cards to "Retry". */
function markServiceOk(service, who) {
  const label = service === 'site24x7' ? 'Site24x7' : 'Squadcast';
  for (const card of document.querySelectorAll(`.signin-card[data-service-signin="${service}"]`)) {
    if (card.classList.contains('ok')) continue;
    card.classList.add('ok');
    card.querySelector('.signin-title').textContent = `${label} connected${who ? ` · ${who}` : ''}`;
    card.querySelector('[data-signin-msg]').textContent = `mon.ai can read ${label} again. Retry to let it continue.`;
    for (const b of card.querySelectorAll('[data-service-login], [data-service-check], a.btn')) b.hidden = true;
    card.querySelector('[data-signin-retry]').hidden = false;
  }
}

let site24x7Auth = null;
async function serviceCheck(service) {
  const r = await api(`/api/${service}/check`).catch((e) => ({ ok: false, error: e.message }));
  if (r.ok) markServiceOk(service, r.user?.name || r.user || '');
  return r;
}

document.addEventListener('click', async (e) => {
  const go = e.target.closest('[data-service-login]');
  const check = e.target.closest('[data-service-check]');
  if (!go && !check) return;
  if (go) {
    go.disabled = true;
    try {
      site24x7Auth = await api('/api/site24x7/login', { method: 'POST', body: {} });
      go.className = 'btn small signin-btn waiting';
      go.innerHTML = '<span class="spinner"></span> Waiting for sign-in…';
      toast('Site24x7: finish signing in in the Edge window that opened; it closes by itself.');
    } catch (err) { toast(err.message); } finally { go.disabled = false; }
    return;
  }
  check.disabled = true;
  try {
    const r = await serviceCheck(check.dataset.serviceCheck);
    if (!r.ok) check.closest('.signin-card').querySelector('[data-signin-msg]').textContent = `Still not working${r.error ? ` (${r.error})` : ''}.`;
  } finally { check.disabled = false; }
});

function signinCards(list = []) {
  return list.map((si) => si.service ? serviceSigninCard(si) : `<div class="signin-card" data-signin="${esc(JSON.stringify(si))}">
    <div class="signin-main">
      <span class="signin-icon">🔑</span>
      <div><div class="signin-title">Azure sign-in needed · ${esc(si.org)}</div>
      <div class="signin-sub" data-signin-msg>mon.ai reads Azure through the Azure CLI, and it isn't signed in to ${esc(si.org)}'s tenant (or the sign-in expired).${si.vpn ? ` Needs ${esc(si.vpn)}.` : ''}</div></div>
    </div>
    <div class="signin-actions">
      <span class="signin-tools" data-signin-tools>${signinButtons(si, azStatus?.profiles?.find((x) => x.org === si.org), { cli: 'none' })}</span>
      <button type="button" class="btn small" data-signin-check title="Check the Azure CLI sign-in now">I've signed in</button>
      <button type="button" class="btn small primary" data-signin-retry hidden>↻ Retry</button>
    </div>
  </div>`).join('');
}

/** A sign-in for org/tool works now: update every button and chat card for it. */
function markSignedIn(org, tool) {
  for (const b of document.querySelectorAll('[data-az-signin]')) {
    if (b.dataset.azSignin !== org || b.dataset.tool !== tool) continue;
    b.className = 'btn small signin-btn ok';
    b.textContent = `✓ ${SIGNIN_TOOLS.find(([x]) => x === tool)[1]}`;
  }
  if (tool !== 'cli') return; // the assistant only needs the CLI
  for (const card of document.querySelectorAll('.signin-card')) {
    const si = JSON.parse(card.dataset.signin);
    if (si.org !== org || card.classList.contains('ok')) continue;
    card.classList.add('ok');
    card.querySelector('.signin-title').textContent = `Azure signed in · ${org}`;
    card.querySelector('[data-signin-msg]').textContent = `The Azure CLI is signed in to ${org}. Retry to let mon.ai continue.`;
    card.querySelector('[data-signin-check]').hidden = true;
    card.querySelector('[data-signin-retry]').hidden = false;
  }
}

const signinPolls = new Map(); // "org|tool" → interval
async function signinCheck(org, tool) {
  const r = await api(`/api/azure/${encodeURIComponent(org)}/check?tool=${tool}`).catch((e) => ({ ok: false, error: e.message }));
  if (r.ok) {
    clearInterval(signinPolls.get(`${org}|${tool}`));
    signinPolls.delete(`${org}|${tool}`);
    markSignedIn(org, tool);
    refreshAzureStatus();
  }
  return r;
}

document.addEventListener('click', async (e) => {
  const go = e.target.closest('[data-az-signin]');
  const check = e.target.closest('[data-signin-check]');
  const retry = e.target.closest('[data-signin-retry]');
  if (!go && !check && !retry) return;
  if (retry || check) {
    const card = e.target.closest('.signin-card');
    const si = JSON.parse(card.dataset.signin);
    if (retry) {
      const box = document.querySelector('#input');
      if (!box || !document.querySelector('#composer')) return;
      edSet(box, si.service
        ? `${si.service === 'site24x7' ? "I've signed in to Site24x7" : "I've updated the Squadcast token"}. Please retry what you were doing.`
        : `I've signed in to Azure for ${si.org}. Please retry what you were doing.`);
      document.querySelector('#composer').requestSubmit();
      return;
    }
    check.disabled = true;
    try {
      const r = await signinCheck(si.org, 'cli');
      if (!r.ok) card.querySelector('[data-signin-msg]').textContent = `The Azure CLI still isn't signed in${r.error ? ` (${r.error})` : ''}. Finish the sign-in in the terminal / browser window, then check again.`;
    } finally { check.disabled = false; }
    return;
  }
  const org = go.dataset.azSignin, tool = go.dataset.tool, env = go.dataset.env || 'prod';
  try {
    if (go.dataset.vpn && !(await confirmDialog({ title: `${org} requires VPN`, intro: `Connect <b>${esc(go.dataset.vpn)}</b> first, then press OK.` }))) return;
    const r = await api(`/api/azure/${encodeURIComponent(org)}/login`, { method: 'POST', body: { tool, env } });
    toast(`${r.label}: opened in ${r.terminal}. Finish signing in there.`);
    for (const b of document.querySelectorAll(`[data-az-signin="${CSS.escape(org)}"][data-tool="${tool}"]`)) {
      b.className = 'btn small signin-btn waiting';
      b.innerHTML = `<span class="spinner"></span> ${esc(SIGNIN_TOOLS.find(([x]) => x === tool)[1])}`;
      b.title = 'Waiting for the sign-in to finish. Click to open it again.';
    }
    const key = `${org}|${tool}`;
    clearInterval(signinPolls.get(key));
    let n = 0;
    signinPolls.set(key, setInterval(async () => {
      if (++n > 18) { // gave up waiting: back to a plain Sign in button
        clearInterval(signinPolls.get(key)); signinPolls.delete(key);
        for (const b of document.querySelectorAll(`[data-az-signin="${CSS.escape(org)}"][data-tool="${tool}"]`)) { b.className = 'btn small signin-btn none'; b.textContent = `Sign in · ${SIGNIN_TOOLS.find(([x]) => x === tool)[1]}`; }
        refreshAzureStatus(true); return;
      }
      await signinCheck(org, tool);
    }, 10_000));
  } catch (err) { toast(err.message); }
});

// ---------- Git pull (fast-forward only): repo lists and chat cards ----------
// Same button everywhere: [data-git-pull=path]. The chat card (offer_git_pull) adds a Continue button.
function pullBtn(r) {
  if (!r?.path || r.error) return '';
  const behind = r.behind ? ` ↓${r.behind}` : '';
  return `<button type="button" class="btn small pull-btn${r.behind ? ' behind' : ''}" data-git-pull="${esc(r.path)}" title="git pull --ff-only on ${esc(r.branch || 'the current branch')}${r.behind ? ` (${r.behind} commit${r.behind === 1 ? '' : 's'} behind at the last fetch)` : ''}. Never merges or rebases.">↓ Pull${behind}</button>`;
}

function pullCards(list = []) {
  return list.map((pc) => {
    const state = pc.behind ? `${pc.behind} new commit${pc.behind === 1 ? '' : 's'} on ${esc(pc.upstream || 'the remote')}` : pc.upstream ? `Up to date with ${esc(pc.upstream)} at the last fetch` : 'No upstream branch to pull from';
    return `<div class="pull-card" data-pull="${esc(JSON.stringify(pc))}">
    <div class="signin-main">
      <span class="signin-icon">⎇</span>
      <div><div class="signin-title">Pull latest · ${esc(pc.name)} <span class="pill blue">${esc(pc.branch || '?')}</span></div>
      <div class="signin-sub" data-pull-msg>${state}.${pc.changes ? ` ${pc.changes} uncommitted change${pc.changes === 1 ? '' : 's'} (kept; the pull stops if they would be overwritten).` : ''}${pc.why ? `<br>${esc(pc.why)}` : ''}</div></div>
    </div>
    <div class="signin-actions">
      <button type="button" class="btn small pull-btn${pc.behind ? ' behind' : ''}" data-git-pull="${esc(pc.path)}" ${pc.upstream ? '' : 'disabled'} title="git pull --ff-only. Never merges or rebases.">↓ Pull${pc.behind ? ` ${pc.behind}` : ''}</button>
      <button type="button" class="btn small primary" data-pull-continue hidden>↻ Continue</button>
    </div>
  </div>`;
  }).join('');
}

document.addEventListener('click', async (e) => {
  const cont = e.target.closest('[data-pull-continue]');
  if (cont) {
    const pc = JSON.parse(cont.closest('.pull-card').dataset.pull);
    const box = document.querySelector('#input');
    if (!box || !document.querySelector('#composer')) return;
    edSet(box, `I've pulled the latest ${pc.name} (${pc.branch}). Please continue.`);
    document.querySelector('#composer').requestSubmit();
    return;
  }
  const btn = e.target.closest('[data-git-pull]');
  if (!btn || btn.disabled) return;
  const repo = btn.dataset.gitPull;
  const same = () => [...document.querySelectorAll('[data-git-pull]')].filter((b) => b.dataset.gitPull === repo);
  const label = new Map(same().map((b) => [b, b.innerHTML]));
  for (const b of same()) { b.disabled = true; b.innerHTML = '<span class="spinner"></span> Pulling…'; }
  try {
    const r = await api('/api/repos/pull', { method: 'POST', body: { path: repo } });
    const what = r.upToDate ? `${r.name}: already up to date` : `${r.name}: pulled ${r.count} commit${r.count === 1 ? '' : 's'} (${r.from} → ${r.to})`;
    toast(what);
    for (const b of same()) { b.className = 'btn small pull-btn done'; b.textContent = r.upToDate ? '✓ Up to date' : `✓ Pulled ${r.count}`; b.disabled = false; }
    for (const card of document.querySelectorAll('.pull-card')) {
      if (JSON.parse(card.dataset.pull).path !== repo) continue;
      card.classList.add('ok');
      card.querySelector('[data-pull-msg]').innerHTML = `${esc(what)}.${r.commits?.length ? `<ul class="pull-commits">${r.commits.slice(0, 8).map((c) => `<li class="mono">${esc(c)}</li>`).join('')}${r.count > 8 ? `<li class="sub">…and ${r.count - 8} more</li>` : ''}</ul>` : ''}`;
      card.querySelector('[data-pull-continue]').hidden = false;
    }
    invalidate('repos');
    if (state.route.name === 'repos') setTimeout(reposPage, 1500); // let the ✓ show first
  } catch (err) {
    toast(err.message);
    for (const b of same()) { b.disabled = false; b.innerHTML = label.get(b) || '↓ Pull'; }
    for (const card of document.querySelectorAll('.pull-card')) {
      if (JSON.parse(card.dataset.pull).path === repo) card.querySelector('[data-pull-msg]').textContent = err.message;
    }
  }
});

/** Divider where the conversation was compacted: the older part above it was replaced by a summary (expandable). */
function compactHtml(c, pending = false) {
  if (pending) return '<div class="msg-compact pending"><span>🗜 Compacting the conversation…</span></div>';
  if (c.trigger === 'rebuilt') return `<div class="msg-compact"><details><summary>♻ Conversation rebuilt from mon.ai's saved messages</summary>
    <div class="sub">Claude Code had cleaned up this chat's transcript, so the assistant continues from this recap. Tool results from before it are not included.</div>
    ${c.summary ? `<div class="md">${md(c.summary)}</div>` : ''}</details></div>`;
  const tok = c.preTokens ? ` · ${fmtTok(c.preTokens)} → ${fmtTok(c.postTokens)} tokens` : '';
  return `<div class="msg-compact"><details><summary>🗜 Conversation compacted${c.trigger === 'auto' ? ' automatically' : ''}${tok}</summary>
    <div class="sub">From here on the assistant works from this summary instead of the full history above.</div>
    ${c.summary ? `<div class="md">${md(c.summary)}</div>` : '<div class="sub">No summary was saved.</div>'}</details></div>`;
}

function assistantHtml(c, models, running = false) {
  const { body, next } = running ? { body: c.text, next: [] } : splitNext(c.text);
  return `${workLog(c, running)}
    <div class="body md">${body ? md(body) : running && !c.plan ? '<span class="typing"><span></span><span></span><span></span></span>' : ''}</div>
    ${signinCards(c.signins)}
    ${pullCards(c.pulls)}
    ${chartCards(c.charts)}
    ${planCard(c.plan)}
    ${next.length ? `<div class="next-steps"><div class="next-title">Next actions <span class="sub">pick one; it runs as the next message with that skill's model</span></div>${next.map((n, i) => `<button type="button" class="next-btn ${i === 0 ? 'primary' : ''}" data-next="${esc(n.cmd)}" title="Send ${esc(n.cmd)}">
        <span class="next-cmd">▶ ${esc(n.cmd.split(/\s+/)[0])}<span class="next-args">${esc(n.cmd.split(/\s+/).slice(1).join(' '))}</span></span>${n.why ? `<span class="next-why">${esc(n.why)}</span>` : ''}</button>`).join('')}</div>` : ''}
    ${running ? '' : `<div class="msg-foot">${modelTag(c, models)}${c.text ? copyBtn('Copy answer').replace('data-copy', 'data-copy="answer"') : ''}</div>`}`;
}

/** Attachments shown inside a message, like images in a Zendesk comment. */
function attachmentsHtml(list = []) {
  if (!list.length) return '';
  const imgs = list.filter((a) => a.image);
  const files = list.filter((a) => !a.image);
  const kb = (n) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
  return `<div class="msg-files">
    ${imgs.map((a) => `<a class="msg-img" href="${esc(a.url)}" target="_blank" rel="noopener" title="${esc(a.name)}"><img src="${esc(a.url)}" alt="${esc(a.name)}" loading="lazy"></a>`).join('')}
    ${files.map((a) => `<a class="msg-file" href="${esc(a.url)}" title="Download ${esc(a.name)}"><span class="fi">📄</span><span class="fn">${esc(a.name)}</span><span class="fs">${kb(a.size)}</span></a>`).join('')}
  </div>`;
}
const userMsgHtml = (c, mid) => `<div class="msg user"${mid ? ` data-mid="${mid}"` : ''}><button type="button" class="msg-edit" title="Edit this message (replaces it and everything after it)">✎ Edit</button>${userBodyHtml(c.text, c.attachments || [])}</div>`;

// ---------- rich message box helpers ----------
// The box is a contenteditable editor. Text is plain; images/files are inline elements.
// Serialised for sending as text with [[file:<id>]] markers where each attachment sits.
function serializeEditor(el) {
  let out = '';
  const walk = (node) => {
    for (const n of node.childNodes) {
      if (n.nodeType === 3) out += n.nodeValue.replace(/ /g, ' ');
      else if (n.nodeName === 'BR') out += '\n';
      else if (n.classList?.contains('ed-att')) { if (n.dataset.uploadId) out += `\n[[file:${n.dataset.uploadId}]]\n`; }
      else if (/^(DIV|P)$/.test(n.nodeName)) { if (out && !out.endsWith('\n')) out += '\n'; walk(n); }
      else walk(n);
    }
  };
  walk(el);
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
const edGet = (el) => (el.isContentEditable ? serializeEditor(el) : el.value);
function placeCaretEnd(el) {
  el.focus();
  const r = document.createRange();
  r.selectNodeContents(el);
  r.collapse(false);
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
}
function edSet(el, text) {
  if (!el.isContentEditable) { el.value = text; return; }
  el.textContent = text;
  placeCaretEnd(el);
}
/** Insert a node at the caret inside `el` (or at the end), and put the caret after it. */
function insertAtCursor(el, node) {
  const sel = getSelection();
  let range = sel.rangeCount ? sel.getRangeAt(0) : null;
  if (!range || !el.contains(range.commonAncestorContainer)) { placeCaretEnd(el); range = sel.getRangeAt(0); }
  range.deleteContents();
  range.insertNode(node);
  const after = document.createRange();
  after.setStartAfter(node);
  after.collapse(true);
  sel.removeAllRanges();
  sel.addRange(after);
  el.focus();
}

/** A user message: text with its images/files shown where they were placed. */
function userBodyHtml(text, atts = []) {
  const byId = new Map(atts.map((a) => [a.id, a]));
  const used = new Set();
  let html = '';
  String(text || '').split(/\[\[file:([^\]]+)\]\]/).forEach((part, i) => {
    if (i % 2 === 0) {
      const t = part.replace(/^\n+|\n+$/g, '');
      if (t) html += `<div class="msg-text">${userText(t)}</div>`;
    } else if (byId.has(part)) {
      used.add(part);
      html += attachmentsHtml([byId.get(part)]);
    }
  });
  const rest = atts.filter((a) => !used.has(a.id));
  return html + (rest.length ? attachmentsHtml(rest) : '');
}

/**
 * Assistant tab: chats grouped by client, newest first. Deleted and resolved chats go to the bin:
 * Archive (archived under 30 days ago), then Deep archive; deleted for good a year after archiving.
 * `folder`: null (active) · 'archive' · 'deep'.
 */
const BIN = {
  archive: { tab: 'Archive', route: 'archived', intro: 'Chats you deleted, and chats whose ticket was solved or closed, in the last 30 days. The assistant still searches them for similar past cases. Deleted chats can be restored; chats of solved tickets are kept as a reference only.', empty: 'The Archive is empty. Deleted chats, and chats whose ticket is solved or closed, land here.' },
  deep: { tab: 'Deep archive', route: 'deep', intro: 'Chats archived more than 30 days ago. Still searchable by the assistant; each is deleted for good one year after it was archived, unless you restore it.', empty: 'Nothing in the Deep archive. Chats move here 30 days after they are archived.' },
};
async function chatList(folder = null) {
  const [active, bin] = await Promise.all([api('/api/sessions'), api('/api/sessions?archived=1')]);
  const counts = { archive: bin.filter((x) => x.folder !== 'deep').length, deep: bin.filter((x) => x.folder === 'deep').length };
  const sessions = folder ? bin.filter((x) => (folder === 'deep' ? x.folder === 'deep' : x.folder !== 'deep')) : active;
  const archived = !!folder;
  const orgs = [...new Set(state.orgs.map((o) => o.org))].sort((x, y) => x.localeCompare(y));
  view.innerHTML = `<div class="page-head"><div><h1>Assistant</h1>
      <div class="sub">${archived ? BIN[folder].intro : 'Each client chat can see that client’s tickets, Azure, Cloudflare and repositories. Deleting a chat moves it to the Archive; so does solving its ticket.'}</div></div>
    <div class="row"><input class="search" id="chatFilter" placeholder="Filter chats…">
      ${archived ? '' : `<select id="newChatOrg" class="select"><option value="">General</option>${orgs.map((o) => `<option>${esc(o)}</option>`).join('')}</select>
      <button class="btn primary" id="newChatGo">New chat</button>`}</div></div>
    <div class="seg" style="margin-bottom:14px"><button class="${archived ? '' : 'active'}" onclick="location.hash='#/chat'">Active <span class="count">${active.length}</span></button>${Object.entries(BIN).map(([k, b]) => `<button class="${folder === k ? 'active' : ''}" onclick="location.hash='#/chat/${b.route}'">${k === 'deep' ? '🗃' : '🗑'} ${b.tab} <span class="count">${counts[k]}</span></button>`).join('')}</div>
    <div id="chatGroups"></div>`;
  $('#newChatGo')?.addEventListener('click', () => newChat($('#newChatOrg').value || null));
  filterBox('#chatFilter', 'Filter chats…', sessions, (x, q) => hit(q, x.title, x.org, x.archive_reason, x.ticket_id && `#${x.ticket_id}`), (list, q) => {
    const by = new Map();
    for (const x of list) { const k = x.org === 'All' ? 'General' : x.org; if (!by.has(k)) by.set(k, []); by.get(k).push(x); }
    $('#chatGroups').innerHTML = [...by].map(([org, items]) => `<div class="card chat-group"><div class="row" style="justify-content:space-between"><h2 style="margin:0">${org === 'General' ? 'General' : clientBadge(org)}</h2><span class="sub">${items.length}</span></div>
      ${items.map((x) => `<a class="chat-row${archived ? ' bin-row' : ''}" href="#/chat/${x.id}"><span class="t" title="${esc(x.title)}">${esc(x.title)}</span>${((sub) => `<span class="sub" title="${esc(sub)}">${esc(sub)}</span>`)(archived ? `${x.archive_reason || 'Archived'} · ${ago(x.archived_at)}${x.folder === 'deep' ? ` · deleted for good ${new Date(x.purge_at).toLocaleDateString()}` : ''}` : ago(x.updated_at))}${archived ? `<span class="bin-acts">${x.reference_only ? `<span class="pill" title="Ticket #${x.ticket_id} is ${esc(x.ticket_status)}: the chat is kept as a reference and can't be reopened">📌 Reference</span>` : `<button type="button" class="btn small" data-bin-restore="${x.id}" title="Move back to active chats">↩ Restore</button>`}<button type="button" class="btn small danger" data-bin-forever="${x.id}" title="Delete permanently: not kept as a reference">Delete forever</button></span>` : ''}</a>`).join('')}</div>`).join('')
      || `<div class="empty">${q ? `No chats match “${esc(q)}”.` : archived ? BIN[folder].empty : 'No chats yet. Start one above, or use Ask AI on a ticket.'}</div>`;
  });
  $('#chatGroups').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-bin-restore], [data-bin-forever]');
    if (!btn) return;
    e.preventDefault(); e.stopPropagation();
    const id = btn.dataset.binRestore || btn.dataset.binForever;
    const title = sessions.find((x) => x.id === id)?.title || 'this chat';
    try {
      if (btn.dataset.binRestore) { await api(`/api/sessions/${id}/unarchive`, { method: 'POST', body: {} }); toast(`Restored “${title}”`); }
      else {
        if (!(await confirmDialog({ title: 'Delete forever?', intro: `<b>${esc(title)}</b> is removed permanently with its attachments, and the assistant can no longer use it as a reference. This can't be undone.`, danger: true }))) return;
        await api(`/api/sessions/${id}?forever=1`, { method: 'DELETE' });
        toast('Deleted forever');
      }
      chatList(folder);
    } catch (err) { toast(err.message); }
  });
}

async function chatPage(id, opts = {}) {
  if (!id) return chatList();
  if (id === 'archived') return chatList('archive');
  if (id === 'deep') return chatList('deep');
  const host = opts.host || view;          // the ticket workspace draws the chat in its first column
  const embedded = !!opts.host;
  const alive = () => (embedded ? host.isConnected : state.route.name === 'chat' && state.route.id === id);
  const [s, models] = await Promise.all([api(`/api/sessions/${id}`).catch(() => null), getModels()]);
  if (!s) { host.innerHTML = '<div class="empty">Chat not found. <a href="#/chat">All chats</a></div>'; return; }
  if (!alive()) return; // navigated away meanwhile
  // A ticket's chat lives on the ticket workspace, next to its Zendesk panel and Client panel.
  if (!embedded && s.ticket_id) { location.replace(`#/ticket/${s.ticket_id}/${id}`); return; }
  const isClient = s.org && s.org !== 'All';
  const hasClient = !embedded && isClient;
  let sideOpen = true;
  try { sideOpen = localStorage.getItem('mon.chatSide') !== '0'; } catch { /* ignore */ }
  host.innerHTML = `<div class="chat-layout ${hasClient && sideOpen ? 'with-side' : ''}">
   <div class="chat">
    <div class="chat-head"><div style="min-width:0">${embedded
      // on the ticket workspace these go into the shared header (which already shows the client and ticket)
      ? `<div class="chat-chips"><span class="pill ai">✦ AI chat</span><span class="pill" title="The assistant can read Zendesk, Cloudflare, Azure/ADO and your local repos, never change them">🔒 read-only</span><span id="chatCostChip"></span>${s.archived_at ? '<span class="pill amber">archived</span>' : ''}</div>`
      : `<div class="sub"><a href="#/chat">← All chats</a></div><h1>${esc(s.title)}</h1><div class="sub">${isClient ? esc(s.org) : 'General'} · read-only tools: Zendesk, Cloudflare, Azure/ADO, Site24x7, Squadcast, local repos</div>`}</div>
      <div class="row"><label class="model-pick" title="Model for this chat">Model <select id="chatModel">${modelOptions(models, s.model || '', s.defaultModel)}</select></label>
        ${hasClient ? `<button class="btn small" id="sideToggle" title="Show or hide the ${esc(s.org)} panel">${esc(s.org)} panel</button>` : ''}
        <span class="menu-wrap"><button class="btn small" id="chatMenuBtn" aria-haspopup="menu" aria-expanded="false" title="More actions">⋯</button>
          <div class="menu" id="chatMenu" role="menu" hidden>
            ${s.ticket_id && !chatCooled(s) ? `<button role="menuitem" data-act="upvote" title="${s.ticket_upvoted ? 'Remove your upvote and score bonus' : 'Add your upvote and score bonus'}">👀 ${s.ticket_upvoted ? 'Remove upvote' : 'Upvote ticket'}</button>` : ''}
            ${s.ticket_upvoted && !chatCooled(s) ? '' : `<button role="menuitem" data-act="cooldown" title="${chatCooled(s) ? 'Bring this chat back to normal' : `Dim it in the sidebar and stop offering Zendesk refreshes${s.ticket_id ? ' until someone else updates the ticket' : ''}. Sending a message ends it.`}">${chatCooled(s) ? '☀ End cooldown' : '❄ Cooldown'}</button>`}
            <button role="menuitem" data-act="skill" title="Turn what this chat did into a reusable skill (you review it before saving)">＋ Create skill from chat</button>
            <hr>
            ${s.archived_at ? `${s.reference_only ? '' : '<button role="menuitem" data-act="restore" title="Move back to active chats">↩ Restore</button>'}
            <button role="menuitem" data-act="forever" class="danger" title="Delete permanently (not kept as a reference)">🗑 Delete forever</button>`
              : '<button role="menuitem" data-act="delete" class="danger" title="Move to the Archive: hidden from the sidebar, kept as a reference, restorable. Deleted for good after a year.">🗑 Delete</button>'}
          </div></span></div></div>
    ${s.archived_at ? `<div class="archived-banner">${Date.now() - Date.parse(s.archived_at) >= 30 * 864e5 ? '🗃 In the Deep archive' : '🗑 In the Archive'} since ${ago(s.archived_at)}${s.archive_reason ? ` · ${esc(s.archive_reason)}` : ''}. Kept as a reference the assistant can search; deleted for good on ${new Date(Date.parse(s.archived_at) + 365 * 864e5).toLocaleDateString()}. ${s.reference_only ? `📌 Ticket #${s.ticket_id} is ${esc(s.ticket_status)}, so this chat is reference only and can't be reopened. Ask AI on the ticket starts a new chat.` : 'Restore it from ⋯, or send a message to reopen it.'}</div>` : ''}
    <div class="zd-banner" id="zdBanner" hidden></div>
    <div class="msgs" id="msgs"><div class="msgs-inner">${s.messages.map((m) => m.role === 'user'
      ? userMsgHtml(m.content, m.id)
      : m.role === 'compact' ? compactHtml(m.content)
      : `<div class="msg assistant" data-raw="${esc(m.content.text || '')}">${assistantHtml(m.content, models)}</div>`).join('')
      || `<div class="empty">Ask about your tickets, Azure resources, Cloudflare zones or code. Try “What should I work on first?” or type / for skills. You can attach or paste images and files.</div>`}</div></div>
    <form class="composer" id="composer"${s.reference_only ? ' style="display:none"' : ''}>
      <div class="composer-grip" id="edGrip" title="Drag to resize · double-click to reset"></div>
      <div class="edit-bar" id="editBar" hidden><span>✎ Editing your message. <b>Ctrl+Enter</b> replaces it and everything after it.</span><button type="button" class="btn small" id="editCancel">Cancel</button></div>
      <div class="composer-row">
        <button type="button" class="icon-btn attach-btn" id="attachBtn" title="Attach images or files (or paste / drop them where the cursor is)">📎</button>
        <input type="file" id="fileInput" multiple hidden>
        <div id="input" class="editor" contenteditable="true" role="textbox" aria-multiline="true" data-placeholder="Message mon.ai…  Type / for skills. Paste or drop images and files where you want them. Ctrl+Enter to send."></div>
        ${s.ticket_id ? `<button type="button" class="btn zd-refresh" id="zdRefresh" title="Bring in new comments from ticket #${s.ticket_id} since this chat last looked (runs /review-ticket-updates)">↻ Zendesk</button>` : ''}
        <button class="btn primary" id="sendBtn" title="Send (Ctrl+Enter)">Send</button>
      </div>
    </form>
   </div>
   ${hasClient ? '<aside class="chat-side" id="chatSide"><div class="sub">Loading…</div></aside>' : ''}
  </div>`;
  if (embedded) api(`/api/usage/chat/${encodeURIComponent(id)}`).then(fillCostChip).catch(() => {});
  // ticket workspace: the chat's chips and controls live in the shared header above the Chat panel and Zendesk panel
  const headSlot = embedded ? $('#tvHeadChat') : null;
  if (headSlot) {
    // the chips (AI chat, read-only, cost) join the ticket's status row; the controls stay on the right
    const chips = $('.chat-head .chat-chips', host);
    if (chips) tvChips().replaceChildren(...chips.childNodes);
    chips?.closest('div[style]')?.remove();
    const ch = $('.chat-head', host);
    headSlot.replaceChildren(...ch.childNodes);
    ch.remove();
  }
  const msgs = $('#msgs');
  const inner = $('.msgs-inner', msgs);
  msgs.scrollTop = msgs.scrollHeight;

  // ---- Client panel (cached static data + live sign-in + open tickets)
  if (hasClient) {
    Promise.all([clientInfo(s.org), api(`/api/tickets?org=${encodeURIComponent(s.org)}`).catch(() => [])]).then(([info, tickets]) => {
      if (!$('#chatSide')) return;
      $('#chatSide').innerHTML = clientSideHtml(s.org, info, tickets) + CHAT_USAGE_SLOT;
      loadChatUsage(id);
      if (!azStatus || Date.now() - new Date(azStatus.checkedAt) > 5 * 60_000) refreshAzureStatus();
    });
    $('#sideToggle').onclick = () => {
      const on = !$('.chat-layout').classList.toggle('with-side') ? false : true;
      try { localStorage.setItem('mon.chatSide', on ? '1' : '0'); } catch { /* ignore */ }
    };
  }

  $('#chatModel').onchange = async (e) => {
    try {
      await api(`/api/sessions/${id}/model`, { method: 'PUT', body: { model: e.target.value || null } });
      toast(`Next replies use ${e.target.value ? modelLabel(models, e.target.value) : 'the default model'}`);
    } catch (err) { toast(err.message); }
  };
  // ---- Compact (button on the Usage card's Context row): the older part of the conversation becomes a summary
  chatCompact = s.claude_session_id && !s.reference_only ? { sid: id, run: async () => {
    if (busy) { toast('Wait for the current reply to finish'); return; }
    busy = true;
    $('#sendBtn').disabled = true;
    const btn = $('#chatUsage [data-compact]');
    if (btn) { btn.disabled = true; btn.textContent = 'Compacting…'; }
    inner.insertAdjacentHTML('beforeend', compactHtml(null, true));
    msgs.scrollTop = msgs.scrollHeight;
    try {
      const c = await api(`/api/sessions/${id}/compact`, { method: 'POST', body: {} });
      toast(c.preTokens ? `Compacted: ${fmtTok(c.preTokens)} → ${fmtTok(c.postTokens)} tokens` : 'Conversation compacted');
    } catch (err) { toast(err.message); } finally { busy = false; chatPage(id, opts); } // redraw either way (divider on success, back to normal on error)
  } } : null;
  if ($('#chatUsage')?.dataset.chat === id) loadChatUsage(id); // card drawn before this chat's controls were ready
  // ---- ⋯ menu: cooldown, skill, archive, delete
  const menuBtn = $('#chatMenuBtn');
  wireMenu(menuBtn, $('#chatMenu'), async (act) => {
    try {
      if (act === 'upvote' && s.ticket_id) {
        await api(`/api/tickets/${s.ticket_id}/upvote`, { method: 'POST', body: { upvoted: !s.ticket_upvoted } });
        toast(s.ticket_upvoted ? `#${s.ticket_id} upvote removed` : `#${s.ticket_id} upvoted — score increased`);
        chatPage(id, opts);
      } else if (act === 'cooldown') {
        const on = !chatCooled(s);
        if (!on) forgetCooldown(id);
        await api(`/api/sessions/${id}/cooldown`, { method: 'POST', body: { on } });
        toast(on ? `Cooled down${s.ticket_id ? `: back when someone else updates #${s.ticket_id}` : ''}` : 'Cooldown ended');
        chatPage(id, opts);
      } else if (act === 'skill') {
        menuBtn.disabled = true; menuBtn.textContent = 'Drafting skill…';
        pendingSkillDraft = await api(`/api/sessions/${id}/skill-draft`, { method: 'POST', body: {} });
        location.hash = '#/skills/new';
      } else if (act === 'restore') {
        await api(`/api/sessions/${id}/unarchive`, { method: 'POST', body: {} });
        toast('Chat restored');
        chatPage(id, opts);
      } else if (act === 'delete') {
        await api(`/api/sessions/${id}`, { method: 'DELETE' });
        toast('Moved to the Archive (Assistant › Archive to restore)');
        location.hash = embedded ? `#/ticket/${s.ticket_id}` : '#/chat';
      } else if (act === 'forever') {
        if (await confirmDialog({ title: 'Delete this chat forever?', intro: "It is removed permanently with its attachments, and the assistant can no longer use it as a reference. This can't be undone.", danger: true })) {
          await api(`/api/sessions/${id}?forever=1`, { method: 'DELETE' });
          toast('Deleted forever');
          location.hash = embedded ? `#/ticket/${s.ticket_id}` : '#/chat/archived';
        }
      }
    } catch (err) { toast(err.message); if (menuBtn.isConnected) { menuBtn.disabled = false; menuBtn.textContent = '⋯'; } }
  });
  if (embedded) setTicketModelPicker(null); // the chat's own model picker is in the header now

  // ---- message box: a rich editor; images and files go in at the cursor, between paragraphs
  const input = $('#input');
  const placeholder = () => { if (!input.querySelector('.ed-att') && !input.textContent.trim()) input.innerHTML = ''; };
  input.addEventListener('input', placeholder);
  async function addFiles(fileList) {
    for (const f of fileList) {
      if (f.size > 25 * 1024 * 1024) { toast(`${f.name}: larger than 25 MB`); continue; }
      const name = f.name && f.name !== 'image.png' ? f.name : `pasted-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}.png`;
      const isImg = f.type.startsWith('image/');
      const el = document.createElement('span');
      el.className = `ed-att ${isImg ? 'ed-img' : 'ed-file'} uploading`;
      el.contentEditable = 'false';
      el.dataset.up = '1';
      el.dataset.name = name;
      el.innerHTML = `${isImg ? `<img src="${URL.createObjectURL(f)}" alt="">` : `<span>📄 ${esc(name)}</span>`}<button type="button" class="ed-x" title="Remove">✕</button>`;
      insertAtCursor(input, el);
      try {
        const res = await fetch(`/api/sessions/${id}/uploads?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: f });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || res.statusText);
        el.dataset.uploadId = data.id;
        el.classList.remove('uploading');
      } catch (err) { el.classList.remove('uploading'); el.classList.add('err'); toast(`${name}: ${err.message}`); }
    }
  }
  input.addEventListener('click', (e) => { const x = e.target.closest('.ed-x'); if (x) { x.closest('.ed-att').remove(); placeholder(); } });
  $('#attachBtn').onclick = () => { input.focus(); $('#fileInput').click(); };
  $('#fileInput').onchange = (e) => { addFiles([...e.target.files]); e.target.value = ''; };
  input.addEventListener('paste', (e) => {
    e.preventDefault();
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) { addFiles(files); return; }
    // Plain text only, so pasted web pages don't bring their formatting along.
    document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
  });
  input.addEventListener('drop', (e) => {
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    // put the caret where the files were dropped
    const r = document.caretRangeFromPoint?.(e.clientX, e.clientY);
    if (r && input.contains(r.startContainer)) { const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); }
    addFiles([...e.dataTransfer.files]);
  });
  const chatEl = $('.chat');
  chatEl.addEventListener('dragover', (e) => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); chatEl.classList.add('dropping'); } });
  chatEl.addEventListener('dragleave', (e) => { if (!chatEl.contains(e.relatedTarget)) chatEl.classList.remove('dropping'); });
  chatEl.addEventListener('drop', (e) => { chatEl.classList.remove('dropping'); if (e.dataTransfer.files.length && !input.contains(e.target)) { e.preventDefault(); addFiles([...e.dataTransfer.files]); } });

  // ---- drag the bar above the box to make it taller or shorter (double-click: back to automatic)
  const applyHeight = (h) => { if (h) { input.style.height = `${h}px`; input.style.maxHeight = 'none'; } else { input.style.height = ''; input.style.maxHeight = ''; } };
  try { applyHeight(Number(localStorage.getItem('mon.edH')) || 0); } catch { /* ignore */ }
  const grip = $('#edGrip');
  grip.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    try { grip.setPointerCapture(e.pointerId); } catch { /* synthetic or lost pointer */ }
    const startY = e.clientY, startH = input.offsetHeight;
    const move = (ev) => applyHeight(Math.round(Math.max(44, Math.min(innerHeight * 0.75, startH + (startY - ev.clientY)))));
    const up = () => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      try { localStorage.setItem('mon.edH', String(input.offsetHeight)); } catch { /* ignore */ }
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
  });
  grip.addEventListener('dblclick', () => { applyHeight(0); try { localStorage.removeItem('mon.edH'); } catch { /* ignore */ } });

  attachSkillPicker(input, s.org);
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    // Ctrl+Enter (Cmd+Enter on a Mac) sends; Enter and Shift+Enter start a new line.
    if (e.ctrlKey || e.metaKey) $('#composer').requestSubmit();
    else document.execCommand('insertLineBreak');
  });

  let busy = false;
  let nextSkill = null; // set when Ask AI sends its prompt

  // "▶ Run /skill …" under an answer: send it as the next message.
  inner.addEventListener('click', (e) => {
    const b = e.target.closest('[data-next]');
    if (!b) return;
    if (busy) { toast('Wait for the current reply to finish'); return; }
    edSet(input, b.dataset.next);
    $('#composer').requestSubmit();
  });

  // ---- edit an earlier message of mine: load it into the box; sending replaces it and what follows
  const byId = new Map(s.messages.filter((m) => m.role === 'user').map((m) => [String(m.id), m.content]));
  let editingId = null;
  const following = (el) => { const out = []; for (let n = el; n; n = n.nextElementSibling) out.push(n); return out; };
  function stopEditing() {
    editingId = null;
    $('#editBar').hidden = true;
    inner.querySelectorAll('.superseded').forEach((n) => n.classList.remove('superseded'));
  }
  function loadIntoEditor(c) {
    input.innerHTML = '';
    const atts = new Map((c.attachments || []).map((a) => [a.id, a]));
    String(c.text || '').split(/\[\[file:([^\]]+)\]\]/).forEach((part, i) => {
      if (i % 2 === 0) { if (part) input.append(document.createTextNode(part)); return; }
      const a = atts.get(part);
      if (!a) return;
      const el = document.createElement('span');
      el.className = `ed-att ${a.image ? 'ed-img' : 'ed-file'}`;
      el.contentEditable = 'false';
      el.dataset.uploadId = a.id;
      el.dataset.name = a.name;
      el.innerHTML = `${a.image ? `<img src="${esc(a.url)}" alt="">` : `<span>📄 ${esc(a.name)}</span>`}<button type="button" class="ed-x" title="Remove">✕</button>`;
      input.append(el);
    });
    // attachments that weren't placed in the text go at the end
    for (const a of c.attachments || []) {
      if (input.querySelector(`[data-upload-id="${CSS.escape(a.id)}"]`)) continue;
      input.append(document.createTextNode(String.fromCharCode(10)));
      const el = document.createElement('span');
      el.className = `ed-att ${a.image ? 'ed-img' : 'ed-file'}`;
      el.contentEditable = 'false';
      el.dataset.uploadId = a.id;
      el.dataset.name = a.name;
      el.innerHTML = `${a.image ? `<img src="${esc(a.url)}" alt="">` : `<span>📄 ${esc(a.name)}</span>`}<button type="button" class="ed-x" title="Remove">✕</button>`;
      input.append(el);
    }
    placeCaretEnd(input);
  }
  inner.addEventListener('click', (e) => {
    const b = e.target.closest('.msg-edit');
    if (!b) return;
    if (busy) { toast('Wait for the current reply to finish (or Stop it) before editing'); return; }
    const bubble = b.closest('.msg.user');
    const mid = bubble.dataset.mid;
    if (!mid || !byId.has(mid)) { toast('This message can be edited after the reply finishes'); return; }
    stopEditing();
    editingId = Number(mid);
    following(bubble).forEach((n) => n.classList.add('superseded'));
    $('#editBar').hidden = false;
    loadIntoEditor(byId.get(mid));
  });
  $('#editCancel').onclick = () => { stopEditing(); input.innerHTML = ''; };
  // After a reply, learn the ids of messages sent in this page so they can be edited too.
  async function syncMessageIds() {
    const fresh = await api(`/api/sessions/${id}`).catch(() => null);
    if (!fresh) return;
    const users = fresh.messages.filter((m) => m.role === 'user');
    users.forEach((m) => byId.set(String(m.id), m.content));
    [...inner.querySelectorAll('.msg.user')].forEach((el, i) => { if (users[i]) el.dataset.mid = users[i].id; });
  }
  // A reply that started before this page was opened (e.g. Ask AI, or you came back mid-reply):
  // show that it's working and reload the chat when it finishes.
  if (s.running) {
    inner.querySelector('.empty')?.remove();
    inner.insertAdjacentHTML('beforeend', `<div class="msg assistant">${assistantHtml({ text: '', notes: [], tools: [] }, models, true)}</div>`);
    msgs.scrollTop = msgs.scrollHeight;
    busy = true; $('#sendBtn').textContent = 'Stop';
    const poll = setInterval(async () => {
      if (!alive()) { clearInterval(poll); return; }
      const now = await api(`/api/sessions/${id}`).catch(() => null);
      if (now && !now.running) { clearInterval(poll); chatPage(id, opts); }
    }, 2500);
  }

  $('#composer').onsubmit = async (e) => {
    e.preventDefault();
    if (busy) { await api(`/api/sessions/${id}/stop`, { method: 'POST', body: {} }); return; }
    if (input.querySelector('.ed-att.uploading')) { toast('Wait for the files to finish uploading'); return; }
    const text = serializeEditor(input);
    const atts = [...input.querySelectorAll('.ed-att[data-upload-id]')].map((el) => ({ id: el.dataset.uploadId, name: el.dataset.name, image: el.classList.contains('ed-img'), url: el.querySelector('img')?.src || '#', size: 0 }));
    const files = atts.map((x) => ({ id: x.id }));
    if (!text && !atts.length) return;
    askNotifyPermission();
    if (s.cooled_at) { forgetCooldown(id); s.cooled_at = null; } // sending ends a cooldown (server clears it too)
    input.innerHTML = '';
    inner.querySelector('.empty')?.remove();
    const rewindFrom = editingId;
    const sendSkill = nextSkill; nextSkill = null;
    if (rewindFrom) {
      const old = inner.querySelector(`.msg.user[data-mid="${rewindFrom}"]`);
      if (old) following(old).forEach((n) => n.remove());
      stopEditing();
    }
    inner.insertAdjacentHTML('beforeend', `${userMsgHtml({ text, attachments: atts })}<div class="msg assistant"></div>`);
    const box = inner.lastElementChild;
    const live = { segments: [''], tools: [], signins: [], pulls: [], charts: [], plan: null, model: null, effort: null, skill: null, errors: [], startedAt: Date.now() };
    const nearBottom = () => msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 120;
    const paint = (running) => {
      const stick = nearBottom();
      const parts = live.segments.map((x) => x.trim()).filter(Boolean);
      const lastOpen = live.segments.at(-1).trim();
      const c = running
        ? { text: lastOpen, notes: lastOpen ? parts.slice(0, -1) : parts, tools: live.tools, signins: live.signins, pulls: live.pulls, charts: live.charts, plan: live.plan, startedAt: live.startedAt }
        : { text: parts.at(-1) || '', notes: parts.slice(0, -1), tools: live.tools, signins: live.signins, pulls: live.pulls, charts: live.charts, plan: live.plan, model: live.model, effort: live.effort, skill: live.skill, durationMs: Date.now() - live.startedAt };
      // the step list stays as you left it (open or closed) while it runs, and folds up when done
      const was = box.querySelector('.worklog')?.open;
      box.innerHTML = assistantHtml(c, models, running) + live.errors.join('');
      if (running && was !== undefined && box.querySelector('.worklog')) box.querySelector('.worklog').open = was;
      box.dataset.raw = c.text;
      if (stick) msgs.scrollTop = msgs.scrollHeight;
    };
    busy = true; $('#sendBtn').textContent = 'Stop';
    paint(true);
    msgs.scrollTop = msgs.scrollHeight;
    let queued = false;
    let finished = false; // a repaint queued just before the end must not bring back the running view
    const schedule = () => { if (!queued) { queued = true; requestAnimationFrame(() => { queued = false; if (!finished) paint(true); }); } };
    try {
      const res = await fetch(`/api/sessions/${id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, attachments: files.map((f) => f.id), ...(rewindFrom ? { rewindFrom } : {}), ...(sendSkill ? { skill: sendSkill } : {}) }) });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
          const type = chunk.match(/^event: (.*)$/m)?.[1];
          const data = JSON.parse(chunk.match(/^data: (.*)$/m)?.[1] || '{}');
          if (type === 'delta') live.segments[live.segments.length - 1] += data.text;
          else if (type === 'segment') live.segments.push('');
          else if (type === 'tool') live.tools.push(data);
          else if (type === 'plan') live.plan = data;
          else if (type === 'signin') live.signins.push(data);
          else if (type === 'chart') { if (!live.charts.includes(data.id)) live.charts.push(data.id); }
          else if (type === 'pull') live.pulls = [...live.pulls.filter((x) => x.path !== data.path), data];
          else if (type === 'tool_result') Object.assign(live.tools.find((x) => x.id === data.id) || {}, data);
          else if (type === 'model') { live.model = data.model; live.effort = data.effort; live.skill = data.skill; }
          else if (type === 'compacting') { if (!inner.querySelector('.msg-compact.pending')) box.insertAdjacentHTML('beforebegin', compactHtml(null, true)); }
          else if (type === 'compacted') {
            const ph = inner.querySelector('.msg-compact.pending');
            if (ph) ph.outerHTML = compactHtml(data); else box.insertAdjacentHTML('beforebegin', compactHtml(data));
          }
          else if (type === 'error') live.errors.push(`<div class="notice err" style="margin-top:8px">${esc(data.message)}${/auth|login/i.test(data.message) ? ' · <a href="#/settings/claude">Sign in to Claude</a>' : ''}</div>`);
          schedule();
        }
      }
    } catch (err) { live.errors.push(`<div class="notice err">${esc(err.message)}</div>`); }
    busy = false; finished = true;
    if ($('#sendBtn')) $('#sendBtn').textContent = 'Send';
    paint(false);
    syncMessageIds();
    const finalText = live.segments.map((x) => x.trim()).filter(Boolean).at(-1) || '';
    notifyReply({ chatId: id, title: s.title, text: finalText, error: live.errors.length ? box.querySelector('.notice.err')?.textContent : null, looking: alive() });
  };
  // ---- Zendesk refresh: bring new ticket comments into the conversation
  if (s.ticket_id) {
    let seenAt = s.ticket_seen_at || s.created_at;
    const fmt = (iso) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    const checkZendesk = async () => {
      if (busy) { toast('Wait for the current reply to finish'); return; }
      const btn = $('#zdRefresh');
      btn.disabled = true; btn.textContent = '↻ Checking…';
      try {
        const u = await api(`/api/sessions/${id}/ticket-updates`);
        $('#zdBanner').hidden = true;
        if (!u.newComments.length) {
          toast(`No new comments on #${u.ticket.id} since ${fmt(u.since)} (status: ${u.ticket.status})`);
          return;
        }
        const NL = '\n';
        const lines = u.newComments.map((c) => `— ${c.author} · ${c.public ? (c.agent ? 'public reply' : 'customer reply') : 'internal note'} · ${fmt(c.created_at)}${c.attachments ? ` · ${c.attachments} attachment(s)` : ''}${NL}${c.body}`);
        // runs the /review-ticket-updates skill: short catch-up on its own (cheaper) model, no draft
        edSet(input, [
          `/review-ticket-updates ${u.ticket.id}`,
          `Now ${u.ticket.status}, ${u.ticket.priority || 'no priority'}. ${u.newComments.length} new comment${u.newComments.length > 1 ? 's' : ''} since ${fmt(u.since)}:`,
          '',
          lines.join(NL + NL),
        ].join(NL));
        const last = u.newComments.at(-1).created_at;
        await api(`/api/sessions/${id}/ticket-seen`, { method: 'POST', body: { at: last } });
        seenAt = last;
        $('#composer').requestSubmit();
      } catch (err) { toast(err.message); } finally {
        if ($('#zdRefresh')) { $('#zdRefresh').disabled = false; $('#zdRefresh').textContent = '↻ Zendesk'; }
      }
    };
    $('#zdRefresh').onclick = checkZendesk;
    // The background sync noticed activity on this ticket: offer a refresh.
    chatTicketWatch = async () => {
      if (!alive()) return;
      const t = (await api('/api/tickets?scope=all').catch(() => [])).find((x) => x.id === Number(s.ticket_id));
      // Pending / On-hold = waiting on the customer: no refresh offer (it would spend tokens on
      // e.g. your own status change). When they reply, Zendesk reopens it and the offer comes back,
      // covering everything since you last refreshed. A mention of you still shows it.
      if (t && ['pending', 'hold'].includes(t.status) && !t.needs_me) { $('#zdBanner').hidden = true; return; }
      // cooled down by you: quiet until someone else updates the ticket after that
      if (t && s.cooled_at && !coolEnded({ ticket_id: t.id, ticket_updated_at: t.updated_at, ticket_my_update_at: t.my_update_at, cooled_at: s.cooled_at })) { $('#zdBanner').hidden = true; return; }
      if (t && t.updated_at > seenAt) {
        $('#zdBanner').innerHTML = `<span>🔔 New activity on <b>#${t.id}</b> in Zendesk (updated ${ago(t.updated_at)}).</span><button class="btn small primary" id="zdBannerGo">Refresh</button><button class="icon-btn" id="zdBannerX" title="Dismiss">✕</button>`;
        $('#zdBanner').hidden = false;
        $('#zdBannerGo').onclick = checkZendesk;
        $('#zdBannerX').onclick = () => { $('#zdBanner').hidden = true; seenAt = t.updated_at; };
      }
    };
    chatTicketWatch();
  } else chatTicketWatch = null;

  if (pendingPrompt) { edSet(input, pendingPrompt); pendingPrompt = null; nextSkill = pendingSkill; pendingSkill = null; $('#composer').requestSubmit(); }
  else if (pendingDraft) { edSet(input, pendingDraft); pendingDraft = null; }
  else input.focus();
}

// ---------------- ticket workspace: Chat panel · Zendesk panel · Client panel ----------------
// The chat's chips live in the header's status row; this element survives the Zendesk panel re-rendering it.
let tvChipsEl = null;
function tvChips() {
  if (!tvChipsEl || (!tvChipsEl.isConnected && !document.getElementById('tvHeadInfo'))) { tvChipsEl = document.createElement('span'); tvChipsEl.className = 'tvh-chips'; }
  return tvChipsEl;
}
// The Client panel is docked or hidden; remembered.
const tvClientShown = () => { try { return localStorage.getItem('mon.tvSide') !== 'hide'; } catch { return true; } };

/** A ⋯ menu: open/close, Esc and arrow keys, click outside closes. `onAct(action, button)` runs the item. */
function wireMenu(btn, menu, onAct) {
  const setMenu = (open) => { menu.hidden = !open; btn.setAttribute('aria-expanded', String(open)); if (open) menu.querySelector('button:not(:disabled)')?.focus(); };
  btn.onclick = () => setMenu(menu.hidden);
  const outside = (e) => {
    if (!menu.isConnected) { document.removeEventListener('mousedown', outside); return; }
    if (!e.target.closest('.menu-wrap')) setMenu(false);
  };
  document.addEventListener('mousedown', outside);
  menu.addEventListener('keydown', (e) => {
    const items = [...menu.querySelectorAll('button:not(:disabled)')];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.stopPropagation(); setMenu(false); btn.focus(); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus(); }
  });
  menu.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b || b.disabled) return;
    setMenu(false);
    onAct(b.dataset.act, b);
  });
}

// Ticket workspace before a chat exists: the model you pick there is used by the chat Ask AI starts.
let ticketModel = '';
function setTicketModelPicker(v) { ticketModel = v || ''; }

/** Ticket workspace with no chat yet: model picker and ⋯ menu (Cooldown works on the ticket itself). */
async function drawNoChatHead(tid) {
  const slot = $('#tvHeadChat');
  const [models, tickets] = await Promise.all([getModels(), api('/api/tickets?scope=all').catch(() => [])]);
  if (!slot?.isConnected || slot.querySelector('#chatModel')) return; // a chat started meanwhile
  const tk = tickets.find((x) => x.id === tid);
  const cooled = !!tk?.ignored;
  const upvoted = !!tk?.upvoted;
  const noChat = 'title="Start a chat with Ask AI first"';
  slot.innerHTML = `<div class="row"><label class="model-pick" title="Model for the chat Ask AI starts">Model <select id="tvModel">${modelOptions(models, ticketModel, true)}</select></label>
    <span class="menu-wrap"><button class="btn small" id="chatMenuBtn" aria-haspopup="menu" aria-expanded="false" title="More actions">⋯</button>
      <div class="menu" id="chatMenu" role="menu" hidden>
        ${cooled ? '' : `<button role="menuitem" data-act="upvote" title="${upvoted ? 'Remove your upvote and score bonus' : 'Add your upvote and score bonus'}">👀 ${upvoted ? 'Remove upvote' : 'Upvote ticket'}</button>`}
        ${upvoted && !cooled ? '' : `<button role="menuitem" data-act="cooldown" title="${cooled ? 'Back to Open' : 'Park it in the Dashboard\'s Cooled tab until someone else updates it'}">${cooled ? '☀ End cooldown' : '❄ Cooldown'}</button>`}
        <button role="menuitem" data-act="skill" disabled ${noChat}>＋ Create skill from chat</button>
        <hr>
        <button role="menuitem" data-act="delete" class="danger" disabled ${noChat}>🗑 Delete</button>
      </div></span></div>`;
  $('#tvModel').onchange = (e) => { setTicketModelPicker(e.target.value); toast(e.target.value ? `Ask AI will use ${modelLabel(models, e.target.value)}` : 'Ask AI will use the default model'); };
  wireMenu($('#chatMenuBtn'), $('#chatMenu'), async (act) => {
    try {
      if (act === 'upvote') {
        await api(`/api/tickets/${tid}/upvote`, { method: 'POST', body: { upvoted: !upvoted } });
        toast(upvoted ? `#${tid} upvote removed` : `#${tid} upvoted — score increased`);
        drawNoChatHead(tid);
      } else if (act === 'cooldown') {
        await api(`/api/tickets/${tid}/ignore`, { method: 'POST', body: { ignore: !cooled } });
        toast(cooled ? `#${tid} back in Open` : `#${tid} cooling down: back when someone else updates it`);
        drawNoChatHead(tid);
      }
    } catch (err) { toast(err.message); }
  });
}

async function startTicketChat(tid, org, subject, host, prompt, skill = null) {
  const s = await api('/api/sessions', { method: 'POST', body: { org: org || undefined, title: `#${tid} ${subject || ''}`.trim().slice(0, 60), ticketId: tid } });
  if (ticketModel) await api(`/api/sessions/${s.id}/model`, { method: 'PUT', body: { model: ticketModel } }).catch(() => {}); // picked before the chat existed
  if (s.org && s.org !== 'All') state.expanded.add(s.org);
  history.replaceState(null, '', `#/ticket/${tid}/${s.id}`); // remember which chat (no reload)
  state.route = parseRoute();
  loadSidebar();
  pendingPrompt = prompt;
  pendingSkill = skill;
  await chatPage(s.id, { host });
}

// Client panel: a header (client name + controls) and a body of cards, so the same markup
// works as a right column or as a horizontal strip under the ticket header.
function shapeClient(side) {
  const head = document.createElement('div'); head.className = 'tv-client-head';
  const body = document.createElement('div'); body.className = 'tv-client-cards';
  [...side.children].forEach((el) => (el.matches('.tv-client-bar, .side-title') ? head : body).appendChild(el));
  const bar = head.querySelector('.tv-client-bar'); if (bar) head.appendChild(bar); // controls go last (right)
  side.replaceChildren(head, body);
}

async function ticketPage(id, chatId) {
  const tid = Number(id);
  if (!tid) { view.innerHTML = '<div class="empty">Not a ticket number.</div>'; return; }
  view.innerHTML = `<div class="tv ${tvClientShown() ? 'client-open' : ''}" id="tv">
    <header class="tv-head"><div class="tvh-info" id="tvHeadInfo"><h1>#${esc(tid)}</h1></div><div class="tvh-actions"><div class="tvh-chat" id="tvHeadChat"></div><div class="tvh-zendesk" id="tvHeadZendesk"></div></div></header>
    <section class="tv-col tv-chat" id="tvChat"><div class="sub">Loading…</div></section>
    <div class="tv-split" id="tvSplit" title="Drag to make the Chat panel or the Zendesk panel wider · double-click to reset" role="separator" aria-orientation="vertical"></div>
    <section class="tv-col tv-zendesk" id="tvZendesk"></section>
    <aside class="tv-col tv-client" id="tvClient" aria-label="Client panel"><div class="sub">Loading…</div></aside>
    <button class="tv-client-tab" id="tvClientTab" title="Show the Client panel">Client</button>
  </div>`;
  const tv = $('#tv');
  // ---- Chat panel | Zendesk panel split: drag the divider; remembered per ticket (double-click: back to default)
  const splitKey = `mon.split.${tid}`;
  const setSplit = (r) => { if (r) tv.style.setProperty('--chat-fr', `${(r / (1 - r)).toFixed(3)}fr`); else tv.style.removeProperty('--chat-fr'); };
  try { setSplit(Number(localStorage.getItem(splitKey)) || 0); } catch { /* ignore */ }
  const split = $('#tvSplit');
  split.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    try { split.setPointerCapture(e.pointerId); } catch { /* lost pointer */ }
    const left = $('#tvChat').getBoundingClientRect().left;
    const right = $('#tvZendesk').getBoundingClientRect().right;
    let ratio = null;
    tv.classList.add('resizing');
    const move = (ev) => { ratio = Math.min(0.8, Math.max(0.2, (ev.clientX - left) / (right - left))); setSplit(ratio); };
    const up = () => {
      split.removeEventListener('pointermove', move);
      split.removeEventListener('pointerup', up);
      tv.classList.remove('resizing');
      if (ratio) try { localStorage.setItem(splitKey, ratio.toFixed(3)); } catch { /* ignore */ }
    };
    split.addEventListener('pointermove', move);
    split.addEventListener('pointerup', up);
  });
  split.addEventListener('dblclick', () => { setSplit(0); try { localStorage.removeItem(splitKey); } catch { /* ignore */ } });
  // ---- Client panel: on the right, or as a strip under the header (Auto: top when the screen is narrow, e.g. portrait)
  const clientPos = () => { try { return localStorage.getItem('mon.tvSidePos') || 'auto'; } catch { return 'auto'; } };
  const placeClient = () => {
    const pos = clientPos();
    tv.classList.toggle('client-top', pos === 'top' || (pos === 'auto' && tv.clientWidth < 1400));
    tv.querySelectorAll('[data-client-pos]').forEach((b) => b.classList.toggle('active', b.dataset.clientPos === pos));
  };
  new ResizeObserver(() => { if (tv.isConnected) placeClient(); }).observe(tv);
  const clientBar = () => `<div class="tv-client-bar"><span class="seg small" title="Where the Client panel sits">${[['auto', 'Auto', 'Top on narrow screens, right on wide ones'], ['top', 'Top', 'Under the ticket header'], ['right', 'Right', 'Beside the Zendesk panel']].map(([k, l, t]) => `<button type="button" data-client-pos="${k}" title="${t}" class="${clientPos() === k ? 'active' : ''}">${l}</button>`).join('')}</span><button class="btn small" data-client-close title="Hide the Client panel">Hide »</button></div>`;
  const setClient = (on) => { tv.classList.toggle('client-open', on); try { localStorage.setItem('mon.tvSide', on ? 'dock' : 'hide'); } catch { /* ignore */ } };
  tv.addEventListener('click', (e) => {
    if (e.target.closest('#tvClientTab')) setClient(true);
    else if (e.target.closest('[data-client-close]')) setClient(false);
    else if (e.target.closest('[data-client-pos]')) { try { localStorage.setItem('mon.tvSidePos', e.target.closest('[data-client-pos]').dataset.clientPos); } catch { /* ignore */ } placeClient(); }
  });

  tvChipsEl = null; // a new ticket: no chips from the previous one
  setTicketModelPicker(null); // and no model picked for another ticket
  const zendeskP = renderZendeskPanel(tid, $('#tvZendesk'), { head: { info: $('#tvHeadInfo'), actions: $('#tvHeadZendesk'), chips: tvChips() } });

  // ---- column 1: the ticket's chat, or the Chat panel's Ask AI starter (nothing is asked until you click)
  const chatHost = $('#tvChat');
  const sessions = chatId ? [] : await api('/api/sessions').catch(() => []);
  if (!chatHost.isConnected) return;
  const sid = chatId || sessions.find((x) => Number(x.ticket_id) === tid)?.id;
  if (sid) {
    if (!chatId) { history.replaceState(null, '', `#/ticket/${tid}/${sid}`); state.route = parseRoute(); loadSidebar(); }
    chatPage(sid, { host: chatHost });
  } else {
    chatHost.innerHTML = `<div class="tv-empty">
      <h2>Ticket chat</h2>
      <div class="sub">No chat for #${tid} yet. Nothing goes to the assistant until you ask.</div>
      <button class="btn primary" id="tvAsk">Ask AI about #${tid}</button>
      <form class="tv-own" id="tvOwn"><textarea name="q" rows="3" placeholder="Or ask your own question about this ticket, or type / for skills… (Ctrl+Enter)"></textarea><button class="btn">Ask</button></form>
    </div>`;
    const go = async (prompt, skill = null) => {
      chatHost.querySelectorAll('button, textarea').forEach((x) => { x.disabled = true; });
      const enable = () => chatHost.querySelectorAll('button, textarea').forEach((x) => { x.disabled = false; });
      const d = await zendeskP;
      try {
        // An archived chat for this ticket (in the Archive or Deep archive): restore it, or start fresh and delete it.
        const old = (await api('/api/sessions?archived=1').catch(() => [])).filter((x) => Number(x.ticket_id) === tid);
        if (old.length) {
          const o = old[0]; // newest first
          const where = o.folder === 'deep' ? 'Deep archive' : 'Archive';
          const pick = await confirmDialog({
            title: `#${tid} already has an archived chat`,
            intro: `<b>${esc(o.title)}</b><div class="sub">In the ${where} since ${ago(o.archived_at)} · ${esc(o.archive_reason || 'Archived')}${old.length > 1 ? ` · and ${old.length - 1} older chat${old.length > 2 ? 's' : ''}` : ''}</div>
              <p>${o.reference_only ? `The ticket is ${esc(o.ticket_status)}, so the old chat is reference only: you can read it, not continue it.` : 'Continue where it left off, or start over with a fresh context.'} A new chat deletes the old one${old.length > 1 ? 's' : ''} for good: ${old.length > 1 ? 'they' : 'it'} can't be restored and the assistant can no longer use ${old.length > 1 ? 'them' : 'it'} as a reference.</p>`,
            choices: [
              o.reference_only ? { value: 'view', label: 'Open the old chat', cls: 'primary', title: 'Read it here (reference only)' } : { value: 'restore', label: '↩ Restore it', cls: 'primary', title: 'Move it back to active chats and continue there' },
              { value: 'fresh', label: 'New chat, delete old forever', cls: 'danger-solid' },
            ],
          });
          if (!pick) { enable(); return; }
          if (pick === 'restore' || pick === 'view') {
            if (pick === 'restore') { await api(`/api/sessions/${o.id}/unarchive`, { method: 'POST', body: {} }); toast('Chat restored'); }
            history.replaceState(null, '', `#/ticket/${tid}/${o.id}`);
            state.route = parseRoute();
            loadSidebar();
            await chatPage(o.id, { host: chatHost });
            const box = chatHost.querySelector('#input'); // your own question isn't lost: it waits in the chat box
            if (pick === 'restore' && box && prompt !== ASK_PROMPT(tid)) edSet(box, prompt);
            return;
          }
          for (const x of old) await api(`/api/sessions/${x.id}?forever=1`, { method: 'DELETE' });
          toast(`Deleted ${old.length} archived chat${old.length > 1 ? 's' : ''} for #${tid}`);
        }
        await startTicketChat(tid, d?.org, d?.ticket?.subject, chatHost, prompt, skill);
      } catch (err) { toast(err.message); enable(); }
    };
    drawNoChatHead(tid);
    const own = $('#tvOwn');
    // Ask AI doesn't send right away: it puts /triage-ticket <id> in the box so you can add instructions, then Ask.
    $('#tvAsk').onclick = () => {
      const extra = own.q.value.trim().replace(/^\/triage-ticket\b\s*(#?\d+\b\s*)?/, '');
      own.q.value = `${ASK_PROMPT(tid)} ${extra}`;
      own.q.focus();
      own.q.setSelectionRange(own.q.value.length, own.q.value.length);
    };
    own.q.onkeydown = (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); own.requestSubmit(); } };
    // "/" lists skills, like the chat box. A skill runs with the ticket number as its first argument
    // (and on that skill's model), e.g. "/check-site-health cqu.edu.au" → "/check-site-health 22925 cqu.edu.au".
    zendeskP.then((d) => { if (own.isConnected) attachSkillPicker(own.q, d?.org || null); }).catch(() => {});
    own.onsubmit = (e) => {
      e.preventDefault();
      const q = own.q.value.trim();
      if (!q) return;
      const sk = q.match(/^\/([a-z0-9][a-z0-9-]*)(?:\s+([\s\S]*))?$/);
      if (sk) go(`/${sk[1]} ${tid}${sk[2] ? ` ${sk[2].replace(new RegExp(`^#?${tid}\\b\\s*`), '')}` : ''}`.trim(), sk[1]);
      else go(`About Zendesk ticket #${tid}: ${q}`);
    };
  }

  // ---- column 3: the Client panel
  const d = await zendeskP;
  const side = $('#tvClient');
  if (!side) return;
  const org = d?.org;
  if (!org || org === 'All') { side.innerHTML = `${clientBar()}<div class="sub">No client linked to this ticket.</div>${CHAT_USAGE_SLOT}`; shapeClient(side); loadChatUsage(state.route.sub); return; }
  $('#tvClientTab').textContent = org;
  const [info, tickets] = await Promise.all([clientInfo(org), api(`/api/tickets?org=${encodeURIComponent(org)}`).catch(() => [])]);
  if (!side.isConnected) return;
  side.innerHTML = clientBar() + clientSideHtml(org, info, tickets, tid) + CHAT_USAGE_SLOT;
  shapeClient(side);
  loadChatUsage(state.route.sub);
  if (!azStatus || Date.now() - new Date(azStatus.checkedAt) > 5 * 60_000) refreshAzureStatus();
}

// ---------------- skills ----------------
let skillsCache = null;
const getSkills = async (fresh) => (skillsCache = (!fresh && skillsCache) || await api('/api/skills').catch(() => []));
const orgChoices = () => [...new Set([...state.orgs.map((o) => o.org)])].sort((a, b) => a.localeCompare(b));

/** Skills grouped by category (A–Z, uncategorised last as "Other"), names A–Z inside. */
function byCategory(list) {
  const groups = new Map();
  for (const s of list) { const c = s.category || 'Other'; if (!groups.has(c)) groups.set(c, []); groups.get(c).push(s); }
  return [...groups].sort(([a], [b]) => (a === 'Other') - (b === 'Other') || a.localeCompare(b))
    .map(([c, g]) => [c, g.sort((x, y) => x.name.localeCompare(y.name))]);
}

async function skillsPage(id) {
  if (id) return skillEditor(id);
  const list = await getSkills(true);
  view.innerHTML = `<div class="page-head"><div><h1>Skills</h1>
      <div class="sub">Reusable instructions for repeated tasks. The assistant uses a skill when your request matches its description, or run one directly in chat with <span class="mono">/skill-name</span>.</div></div>
    <div class="row"><input class="search" id="skFilter" placeholder="Filter skills…"><a class="btn primary" href="#/skills/new">New skill</a></div></div>
    <div id="skGrid"></div>`;
  filterBox('#skFilter', 'Filter skills…', list, (s, q) => hit(q, s.name, s.description, s.org, s.category, s.instructions), (items, q) => {
    $('#skGrid').innerHTML = byCategory(items).map(([cat, group]) => `<section class="skill-cat"><h2 class="skill-cat-head">${esc(cat)} <span class="count">${group.length}</span></h2><div class="skill-grid">${group.map((s) => `<div class="card skill-card">
        <div class="row" style="justify-content:space-between"><b class="mono">/${esc(s.name)}</b><span class="row" style="gap:4px">${s.model ? `<span class="pill" title="Runs with this model">${esc(s.model)}${s.effort ? ` · ${esc(s.effort)}` : ''}</span>` : ''}${s.org ? `<span class="pill blue">${esc(s.org)} only</span>` : '<span class="pill">All clients</span>'}</span></div>
        <p class="sub">${esc(s.description)}</p>
        <div class="row"><button class="btn small primary" data-try="${esc(s.name)}" data-org="${esc(s.org)}">Run in chat</button><a class="btn small" href="#/skills/${encodeURIComponent(s.name)}">Edit</a><span class="sub">updated ${ago(s.updatedAt)}</span></div>
      </div>`).join('')}</div></section>`).join('') || `<div class="empty">${q ? `No skills match “${esc(q)}”.` : 'No skills yet. Create one for a task you repeat.'}</div>`;
  });
}

async function skillEditor(id) {
  const isNew = id === 'new';
  const fromChat = isNew ? pendingSkillDraft : null;
  pendingSkillDraft = null;
  if (!skillsCache) await getSkills().catch(() => []); // for the Category suggestions
  const s = isNew ? (fromChat || { name: '', description: '', org: '', model: '', effort: '', category: '', instructions: '# Steps\n\n1. \n2. \n\n# Output\n\n' }) : await api(`/api/skills/${encodeURIComponent(id)}`).catch(() => null);
  if (!s) { view.innerHTML = '<div class="empty">Skill not found. <a href="#/skills">Back to skills</a></div>'; return; }
  view.innerHTML = `<div class="page-head settings-head"><div><h1>${isNew ? 'New skill' : `/${esc(s.name)}`}</h1><div class="sub"><a href="#/skills">← All skills</a>${fromChat ? ` · drafted from the chat <a href="#/chat/${esc(fromChat.fromChat.id)}">${esc(fromChat.fromChat.title)}</a>, review it and Save` : ''} · saved to <span class="mono">ai-skills/skills/&lt;name&gt;/SKILL.md</span>, used from the next message</div></div>
    <div class="row">${isNew ? '' : '<button class="btn danger" id="skDelete">Delete</button><button class="btn" id="skTry">Run in chat</button>'}<button class="btn primary" id="skSave">Save</button></div></div>
    <form class="form wide" id="skForm"><div class="fields">
      <label class="f">Name (what you type after /)<input name="name" value="${esc(s.name)}" placeholder="triage-ticket" pattern="[a-z0-9][a-z0-9-]*" required></label>
      <label class="f">Model<select name="model" title="The model this skill runs with when you type /name (Ask AI uses /triage-ticket's)"><option value="">Loading…</option></select></label>
      <label class="f">Effort<select name="effort"><option value="">Default</option>${['low', 'medium', 'high', 'xhigh', 'max'].map((e) => `<option ${s.effort === e ? 'selected' : ''}>${e}</option>`).join('')}</select></label>
      <label class="f">Category<input name="category" value="${esc(s.category || '')}" list="skCats" placeholder="e.g. Investigation" maxlength="40" title="Groups skills on this page and in the / list. Pick one or type a new one."><datalist id="skCats">${[...new Set((skillsCache || []).map((x) => x.category).filter(Boolean))].sort().map((c) => `<option value="${esc(c)}">`).join('')}</datalist></label>
      <label class="f">Clients<select name="org"><option value="">All clients</option>${orgChoices().map((o) => `<option ${o === s.org ? 'selected' : ''}>${esc(o)}</option>`).join('')}${s.org && !orgChoices().includes(s.org) ? `<option selected>${esc(s.org)}</option>` : ''}</select></label>
    </div>
    <label class="f">When to use it: the assistant reads this to decide when the skill applies, so describe the task and the words you'd use for it
      <textarea name="description" rows="2" placeholder="Check a client's Cloudflare DNS and WAF for a hostname. Use when asked about DNS, WAF, or why a site is blocked.">${esc(s.description)}</textarea></label>
    <label class="f">Instructions (Markdown): the steps, which tools to use, and what the answer should look like
      <textarea name="instructions" class="mono skill-body" rows="22">${esc(s.instructions)}</textarea></label>
    <div class="sub">Tip: tools the assistant can use include my_tickets, zendesk_ticket, zendesk_search, daily_performance, cloudflare_zones, cloudflare_get, azure_profiles, azure_cli, ado_query, ado_my_work, git_repos, git_log, and reading files under your repo roots. Everything stays read-only.</div>
    </form>`;
  const f = $('#skForm');
  f.onsubmit = async (e) => {
    e.preventDefault();
    try {
      const saved = await api(`/api/skills/${isNew ? '_new' : encodeURIComponent(s.name)}`, { method: 'PUT', body: { name: f.name.value, description: f.description.value, org: f.org.value, model: f.model.value, effort: f.effort.value, category: f.category.value, instructions: f.instructions.value } });
      skillsCache = null;
      toast(`Saved /${saved.name}`);
      if (saved.name !== id) location.hash = `#/skills/${encodeURIComponent(saved.name)}`;
    } catch (err) { toast(err.message); }
  };
  $('#skSave').onclick = () => f.requestSubmit();
  getModels().then((models) => { f.model.innerHTML = modelOptions(models, s.model || '', true); }).catch(() => { f.model.innerHTML = `<option value="">Default model (Settings)</option>${s.model ? `<option selected>${esc(s.model)}</option>` : ''}`; });
  $('#skDelete')?.addEventListener('click', async () => {
    if (!(await confirmDialog({ title: `Delete the skill /${s.name}?`, intro: 'Its SKILL.md file is removed.', danger: true }))) return;
    await api(`/api/skills/${encodeURIComponent(s.name)}`, { method: 'DELETE' });
    skillsCache = null;
    location.hash = '#/skills';
  });
  $('#skTry')?.addEventListener('click', () => runSkill(s.name, s.org));
}

async function runSkill(name, org) {
  pendingDraft = `/${name} `;
  await newChat(org || null, { title: `/${name}` });
}
view.addEventListener('click', (e) => {
  const b = e.target.closest('[data-try]');
  if (b) runSkill(b.dataset.try, b.dataset.org);
});
let pendingDraft = null;
let pendingSkillDraft = null; // from "＋ Skill" in a chat
// The leading /name always; a /name later in the text only when it's a known skill (not a path like /etc).
const userText = (t) => esc(t).replace(/(^|\s)\/([a-z0-9][a-z0-9-]*)(?=$|[\s.,;:!?)])/g, (all, pre, name, at) =>
  (at === 0 || (skillsCache || []).some((s) => s.name === name)) ? `${pre}<span class="skill-tag">/${name}</span>` : all);

/** The "/word" being typed right before the caret (at the start or after a space), or null.
 *  `replace(text)` swaps that token for `text` and leaves the caret after it. */
function slashAtCaret(input) {
  const re = /(^|\s)\/([a-z0-9-]*)$/;
  if (!input.isContentEditable) {
    const pos = input.selectionStart ?? input.value.length;
    if (input.selectionEnd !== pos) return null;
    const m = input.value.slice(0, pos).match(re);
    if (!m) return null;
    const start = pos - m[2].length - 1;
    return { query: m[2], replace: (text) => {
      input.value = input.value.slice(0, start) + text + input.value.slice(pos).replace(/^ /, '');
      input.selectionStart = input.selectionEnd = start + text.length;
    } };
  }
  const sel = getSelection();
  if (!sel.rangeCount || !sel.isCollapsed) return null;
  const node = sel.anchorNode, off = sel.anchorOffset;
  if (!node || node.nodeType !== 3 || !input.contains(node)) {
    // empty box, or the caret sits between elements: fall back to "whole message is /word"
    const m = edGet(input).match(/^\/([a-z0-9-]*)$/);
    return m ? { query: m[1], replace: (text) => edSet(input, text) } : null;
  }
  const m = node.nodeValue.slice(0, off).match(re);
  if (!m) return null;
  const start = off - m[2].length - 1;
  return { query: m[2], replace: (text) => {
    node.nodeValue = node.nodeValue.slice(0, start) + text + node.nodeValue.slice(off).replace(/^[  ]/, '');
    const r = document.createRange();
    r.setStart(node, start + text.length);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
  } };
}

/** "/" at the start of the message box, or after a space anywhere in it, lists skills; Tab/Enter picks one. */
async function attachSkillPicker(input, org) {
  const list = (await getSkills()).filter((s) => !s.org || !org || org === 'All' || s.org.toLowerCase() === org.toLowerCase());
  const pop = document.createElement('div');
  pop.className = 'skill-pop';
  pop.hidden = true;
  (input.closest('.composer') || input.closest('form') || input.parentElement).prepend(pop); // chat box, or the Ask AI starter
  let items = [], sel = 0, tok = null;
  const draw = () => {
    tok = slashAtCaret(input);
    const q = tok?.query;
    items = tok ? byCategory(list.filter((s) => s.name.startsWith(q) || (q && (s.category || '').toLowerCase().startsWith(q)))).flatMap(([, g]) => g) : [];
    pop.hidden = !items.length;
    sel = Math.min(sel, Math.max(0, items.length - 1));
    // a small heading wherever the category changes (headings can't be picked)
    pop.innerHTML = items.map((s, i) => `${i === 0 || (items[i - 1].category || 'Other') !== (s.category || 'Other') ? `<div class="skill-pop-cat">${esc(s.category || 'Other')}</div>` : ''}<div class="item ${i === sel ? 'sel' : ''}" data-i="${i}"><b class="mono">/${esc(s.name)}</b><span class="sub">${esc(s.description)}</span></div>`).join('');
    pop.querySelector('.item.sel')?.scrollIntoView({ block: 'nearest' });
  };
  const pick = (i) => {
    // a trailing normal space; a contenteditable would drop it at the end of a text node, so use nbsp there
    if (tok) tok.replace(`/${items[i].name}${input.isContentEditable ? ' ' : ' '}`); else edSet(input, `/${items[i].name} `);
    pop.hidden = true;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  input.addEventListener('input', draw);
  input.addEventListener('click', draw);
  input.addEventListener('keyup', (e) => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') draw(); });
  input.addEventListener('keydown', (e) => {
    if (pop.hidden) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length; draw(); }
    else if (e.key === 'Tab' || e.key === 'Enter') { e.preventDefault(); e.stopImmediatePropagation(); pick(sel); }
    else if (e.key === 'Escape') pop.hidden = true;
  }, true);
  pop.addEventListener('mousedown', (e) => { const it = e.target.closest('.item'); if (it) { e.preventDefault(); pick(Number(it.dataset.i)); } });
  return list;
}

// ---------------- settings ----------------
async function settingsPage(tab = 'clients') {
  // Old links (#/settings/clients, /workspace, /connections) land on the merged tabs.
  tab = { azure: 'clients', workspace: 'general', connections: 'general' }[tab] || tab;
  view.innerHTML = `<div class="page-head settings-head"><div><h1>Settings</h1><div class="sub">Saved to JSON files in /config and applied immediately, no restart needed.</div></div>
    <button class="btn primary" id="settingsSave">Save</button></div>
    <div class="tabs">${[['clients', 'Clients'], ['general', 'General'], ['claude', 'Claude & model'], ['advanced', 'Advanced']]
      .map(([k, l]) => `<button class="${k === tab ? 'active' : ''}" onclick="location.hash='#/settings/${k}'">${l}</button>`).join('')}</div>
    <div id="tab"></div>`;
  $('#settingsSave').onclick = () => {
    const form = $('#tab form');
    if (form) form.requestSubmit(); else toast('Nothing to save on this tab');
  };
  $('#settingsSave').hidden = tab === 'advanced'; // read-only tab
  ({ clients: clientSettings, general: generalSettings, claude: claudeSettings, advanced: advancedSettings })[tab]?.();
}
const DEFAULT_ACCOUNT = 'vietanh@dataweavers.com';
const field = (label, name, value, attrs = '') => `<label class="f">${label}<input name="${name}" value="${esc(value ?? '')}" ${attrs}></label>`;

/** One card per client: the names it goes by, VPN, Azure subscriptions and ADO. */
async function clientSettings() {
  const [{ value: az }, { value: ws }, cf] = await Promise.all([api('/api/config/azure'), api('/api/config/workspace'), api('/api/cloudflare/zones').catch(() => null)]);
  const allZones = (cf?.zones || []).map((z) => z.name).sort((a, b) => a.localeCompare(b));
  // Build the client list from Azure profiles, alias targets and Cloudflare zone owners.
  const byCode = new Map();
  const client = (code) => {
    const k = code.toLowerCase();
    if (!byCode.has(k)) byCode.set(k, { code, aliases: [], zones: [], profile: null });
    return byCode.get(k);
  };
  for (const p of az.profiles || []) client(p.org).profile = p;
  for (const [name, code] of Object.entries(ws.orgAliases || {})) { const cl = client(code); if (name !== code) cl.aliases.push(name); }
  for (const [code, zones] of Object.entries(ws.clientZones || {})) client(code).zones = [...(zones || [])];
  for (const [code, names] of Object.entries(ws.clientMonitoring || {})) client(code).monitoring = [...(names || [])];
  const clients = [...byCode.values()].sort((a, b) => a.code.localeCompare(b.code));
  const defaultAccount = az.defaultAccount || DEFAULT_ACCOUNT;

  const card = (cl) => {
    const p = cl.profile || { subscriptions: {}, subscriptionNames: {}, ado: {}, edgeProfile: 'Default' };
    const adoAdv = !!(p.ado?.project || p.ado?.tenantId);
    const customSignIn = !!((p.edgeProfile && p.edgeProfile !== 'Default') || p.account);
    return `<div class="card profile-card client-card ${p.vpn?.required ? 'needs-vpn' : ''}">
      <div class="profile-top">
        <input class="client-code" name="org" value="${esc(cl.code)}" data-orig="${esc(cl.code)}" placeholder="Client name" required>
        <label class="check" title="Connect Dataweavers OpenVPN before signing in to this client's Azure"><input type="checkbox" name="vpnRequired" ${p.vpn?.required ? 'checked' : ''}> VPN required</label>
        <label class="check" title="Use a specific Edge profile or login account for this client instead of the defaults (Default profile, ${esc(defaultAccount)})"><input type="checkbox" name="customSignIn" ${customSignIn ? 'checked' : ''}> Custom sign-in</label>
        <label class="check" title="Show the ADO project and ADO tenant fields"><input type="checkbox" name="adoAdvanced" ${adoAdv ? 'checked' : ''}> More ADO options</label>
        <button type="button" class="btn small danger" data-remove>Remove</button>
      </div>
      <label class="f">Aliases <span class="sub">Other names for this client, comma separated: its Zendesk organization name, repo folder name or a short code. Tickets, chats and repos under any of these names show up here.</span>
        <input name="aliases" value="${esc(cl.aliases.join(', '))}" placeholder="Zendesk organization, repo folder, short code"></label>
      <div class="f zone-field"><span>Cloudflare zones</span>
        <input type="hidden" name="zones" value="${esc((cl.zones || []).join(','))}">
        <div class="zone-chips"></div>
      </div>
      <label class="f">Monitoring names <span class="sub">Words that pick this client's Squadcast services, comma separated (part of the name is enough). Empty: the client name. Only needed when the service isn't named after the client.</span>
        <input name="monitoring" value="${esc((cl.monitoring || []).join(', '))}" placeholder="e.g. ACU, acu.edu.au"></label>
      <div class="azure-part">
        <!-- fixed two-column rows so each subscription's ID and name sit side by side -->
        <div class="grid2" style="margin-top:10px">
          ${field('Tenant ID', 'tenantId', p.tenantId, 'placeholder="00000000-0000-0000-0000-000000000000"')}
          ${field('ADO organization URL', 'adoOrgUrl', p.ado?.orgUrl, 'placeholder="https://dev.azure.com/acu"')}
          ${field('Prod subscription ID', 'prod', p.subscriptions?.prod)}
          ${field('Prod subscription name', 'prodName', p.subscriptionNames?.prod)}
          ${field('NonProd subscription ID', 'nonprod', p.subscriptions?.nonprod)}
          ${field('NonProd subscription name', 'nonprodName', p.subscriptionNames?.nonprod)}
        </div>
        <div class="grid2 sign-in" ${customSignIn ? '' : 'hidden'} style="margin-top:8px">
          ${field('Edge profile directory', 'edgeProfile', customSignIn ? p.edgeProfile : '', 'placeholder="Default, or e.g. Profile 7" list="edgeProfiles"')}
          ${field('Login account', 'account', p.account, `placeholder="${esc(defaultAccount)} (default)"`)}
        </div>
        <div class="grid2 ado-advanced" ${adoAdv ? '' : 'hidden'} style="margin-top:8px">
          ${field('ADO project', 'adoProject', p.ado?.project, 'placeholder="Default project for work-item queries"')}
          ${field('ADO tenant ID (only if different from the tenant above)', 'adoTenantId', p.ado?.tenantId)}
        </div>
      </div>
    </div>`;
  };

  $('#tab').innerHTML = `<form class="form wide" id="clForm">
    <div class="row"><input class="search" id="clFilter" placeholder="Filter clients…"><span class="sub" id="clCount">${clients.length} clients</span>
      <button type="button" class="btn" id="clAdd">+ Add client</button></div>
    <div class="sub">Edge profile directory names are shown at <span class="mono">edge://version</span> → Profile path (the last folder, e.g. “Profile 1”). Browser, default account, git, Zendesk and Cloudflare are under <a href="#/settings/general">General</a>.</div>
    <datalist id="edgeProfiles"><option value="Default"><option value="Profile 1"><option value="Profile 2"><option value="Profile 3"></datalist>
    <div class="profile-grid" id="clGrid">${clients.map(card).join('')}</div>
  </form>`;

  const wire = (c) => {
    const title = $('[name=org]', c);
    $('[name=vpnRequired]', c).onchange = (e) => c.classList.toggle('needs-vpn', e.target.checked);
    $('[name=adoAdvanced]', c).onchange = (e) => { $('.ado-advanced', c).hidden = !e.target.checked; };
    $('[name=customSignIn]', c).onchange = (e) => { $('.sign-in', c).hidden = !e.target.checked; };
    drawZones(c);
    $('[data-remove]', c).onclick = async () => {
      if (await confirmDialog({ title: `Remove ${title.value || 'this client'}?`, intro: 'Its Azure profile and names are deleted when you save.', danger: true })) { c.remove(); count(); }
    };
  };
  // Zone chips + an "Add zone" picker; a zone can belong to one client only.
  const zonesOf = (c) => $('[name=zones]', c).value.split(',').map((z) => z.trim()).filter(Boolean);
  const owner = (zone) => [...document.querySelectorAll('.client-card')].find((c) => zonesOf(c).includes(zone));
  function drawZones(c) {
    const mine = zonesOf(c);
    const free = allZones.filter((z) => !mine.includes(z));
    $('.zone-chips', c).innerHTML = mine.map((z) => `<span class="chip">${esc(z)}<button type="button" data-unzone="${esc(z)}" title="Remove">✕</button></span>`).join('')
      + (allZones.length
        ? `<select class="zone-add"><option value="">+ Add zone…</option>${free.map((z) => { const o = owner(z); const oc = o && $('[name=org]', o).value; return `<option value="${esc(z)}">${esc(z)}${oc ? ` (now ${esc(oc)})` : ''}</option>`; }).join('')}</select>`
        : '<input class="zone-add-text" placeholder="zone name, Enter to add">');
    $('.zone-chips', c).onclick = (e) => {
      const b = e.target.closest('[data-unzone]');
      if (b) { $('[name=zones]', c).value = zonesOf(c).filter((z) => z !== b.dataset.unzone).join(','); drawZones(c); }
    };
    const add = (z) => {
      if (!z) return;
      const prev = owner(z);
      if (prev && prev !== c) { $('[name=zones]', prev).value = zonesOf(prev).filter((x) => x !== z).join(','); drawZones(prev); }
      $('[name=zones]', c).value = [...zonesOf(c), z].join(',');
      drawZones(c);
    };
    const sel = $('.zone-add', c);
    if (sel) sel.onchange = () => add(sel.value);
    const txt = $('.zone-add-text', c);
    if (txt) txt.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); add(txt.value.trim().toLowerCase()); } };
  }
  const count = () => { $('#clCount').textContent = `${document.querySelectorAll('.client-card').length} clients`; };
  document.querySelectorAll('.client-card').forEach(wire);
  $('#clAdd').onclick = () => {
    $('#clGrid').insertAdjacentHTML('afterbegin', card({ code: '', aliases: [], zones: [], monitoring: [], profile: null, isNew: true }));
    const c = $('#clGrid .client-card');
    wire(c); count();
    $('[name=org]', c).focus();
  };
  $('#clFilter').oninput = (e) => {
    const q = e.target.value.trim().toLowerCase();
    for (const c of document.querySelectorAll('.client-card')) c.hidden = !!q && !hit(q, ...[...c.querySelectorAll('input')].map((i) => i.value.replace(/,/g, ' ')));
  };

  $('#clForm').onsubmit = async (e) => {
    e.preventDefault();
    const profiles = [];
    const orgAliases = {};
    const clientZones = {};
    const clientMonitoring = {};
    const seen = new Set();
    for (const c of document.querySelectorAll('.client-card')) {
      const g = (n) => $(`[name=${n}]`, c).value.trim();
      const code = g('org');
      if (!code) { toast('Every client needs a code'); $('[name=org]', c).focus(); return; }
      if (seen.has(code.toLowerCase())) { toast(`Client ${code} is listed twice`); return; }
      seen.add(code.toLowerCase());
      const names = g('aliases').split(',').map((s) => s.trim()).filter(Boolean);
      // Renamed client: keep the old code as an alias so its chats and repo folders follow it.
      const orig = $('[name=org]', c).dataset.orig;
      if (orig && orig !== code && !names.some((n) => n.toLowerCase() === orig.toLowerCase())) names.push(orig);
      for (const name of names) orgAliases[name] = code;
      const zones = zonesOf(c);
      if (zones.length) clientZones[code] = zones;
      const mon = g('monitoring').split(',').map((s) => s.trim()).filter(Boolean);
      if (mon.length) clientMonitoring[code] = mon;
      const adv = $('[name=adoAdvanced]', c).checked;
      const custom = $('[name=customSignIn]', c).checked;
      const p = {
        org: code, tenantId: g('tenantId'),
        subscriptions: { prod: g('prod'), nonprod: g('nonprod') },
        subscriptionNames: { prod: g('prodName'), nonprod: g('nonprodName') },
        // Unticked "Custom sign-in" = the defaults (Default Edge profile, default account).
        edgeProfile: (custom && g('edgeProfile')) || 'Default', account: custom ? g('account') : '',
        vpn: { required: $('[name=vpnRequired]', c).checked },
        ado: { orgUrl: g('adoOrgUrl'), project: adv ? g('adoProject') : '', tenantId: adv ? g('adoTenantId') : '' },
      };
      profiles.push(p); // every client has Azure, even before its tenant is filled in
    }
    try {
      // Re-read the files so fields edited on other tabs are kept.
      const [{ value: azNow }, { value: wsNow }] = await Promise.all([api('/api/config/azure'), api('/api/config/workspace')]);
      await api('/api/config/workspace', { method: 'PUT', body: { ...wsNow, orgAliases, clientZones, clientMonitoring } });
      await api('/api/config/azure', { method: 'PUT', body: { ...azNow, profiles } });
      toast(`Saved ${seen.size} clients`);
      loadSidebar();
    } catch (err) { toast(err.message); }
  };
}

/** Settings that aren't per client: browser and default account, git, Zendesk, Cloudflare. */
async function generalSettings() {
  const [{ value: az }, { value: ws }, { value: sec }, za] = await Promise.all([
    api('/api/config/azure'), api('/api/config/workspace'), api('/api/config/secrets'), api('/api/zendesk/auth'),
  ]);
  const z = sec.zendesk, c = sec.cloudflare;
  const s24 = sec.site24x7 || { enabled: false, dc: 'net.au' }, sq = sec.squadcast || { apiToken: '', region: 'eu' };
  const sa = site24x7Auth = await api('/api/site24x7/auth').catch(() => null);
  const sStatus = !s24.enabled ? '<span class="pill">Off</span>'
    : sa?.signedIn ? `<span class="pill green">Signed in${sa.user?.name ? ` as ${esc(sa.user.name)}` : ''}</span>`
    : sa?.login?.status === 'running' ? '<span class="pill amber">Waiting for sign-in in the Edge window…</span>'
    : sa?.login?.status === 'refreshing' ? '<span class="pill amber">Reconnecting in the background…</span>'
    : `<span class="pill red">Not signed in</span>${sa?.login?.error ? ` <span class="sub">${esc(sa.login.error)}</span>` : ''}`;
  const S24_DCS = [['net.au', 'Australia (site24x7.net.au)'], ['com', 'US (site24x7.com)'], ['eu', 'EU (site24x7.eu)'], ['in', 'India (site24x7.in)'], ['uk', 'UK (site24x7.uk)'], ['ca', 'Canada (site24x7.ca)'], ['jp', 'Japan (site24x7.jp)']];
  const zStatus = za.signedIn ? `<span class="pill green">Signed in as ${esc(za.user?.name || '')}</span>`
    : za.login?.status === 'running' ? '<span class="pill amber">Waiting for sign-in in the Edge window…</span>'
    : za.login?.status === 'refreshing' ? '<span class="pill amber">Reconnecting in the background…</span>'
    : `<span class="pill red">Not signed in</span>${za.login?.error ? ` <span class="sub">${esc(za.login.error)}</span>` : ''}`;
  $('#tab').innerHTML = `<form class="form" id="genForm">
    <fieldset><legend>Browser &amp; accounts</legend><div class="fields">
      ${field('Edge executable', 'edgePath', az.edgePath)}
      ${field('Default login account (used when a client has none)', 'defaultAccount', az.defaultAccount || DEFAULT_ACCOUNT, 'type="email"')}
    </div></fieldset>
    <fieldset><legend>Git repositories</legend>
      <label class="f">Repository roots, one per line. Each folder directly under a root is a client, e.g. D:\\Dataweavers\\ACU → ACU.
        <textarea name="roots" rows="3">${esc((ws.repoRoots || []).join('\n'))}</textarea></label>
      <div class="fields" style="margin-top:10px">${field('Scan depth', 'scanDepth', ws.scanDepth, 'type="number" min="1" max="6"')}${field('Ignore folders (comma separated)', 'ignore', (ws.ignore || []).join(', '))}</div>
    </fieldset>
    <fieldset><legend>Zendesk</legend>
      <div class="row" style="margin-bottom:10px">${zStatus}
        <button type="button" class="btn small primary" id="zdLogin" ${['running', 'refreshing'].includes(za.login?.status) ? 'disabled' : ''}>${za.signedIn ? 'Sign in again' : 'Sign in with browser'}</button>
        ${za.signedIn ? '<button type="button" class="btn small danger" id="zdLogout">Sign out</button>' : ''}</div>
      <div class="sub" style="margin-bottom:10px">A separate Edge window (a mon.ai profile) opens Zendesk; sign in as usual (SSO/MFA) and it closes by itself. No API token needed.</div>
      <div class="fields">
        ${field('Subdomain', 'zsub', z.subdomain, 'placeholder="dataweavers"')}
        ${field('Agent email (only with API token)', 'zemail', z.email)}
        ${field('API token (optional)', 'ztoken', z.apiToken, 'type="password" autocomplete="off"')}
        ${field('Poll every (seconds, min 30)', 'zpoll', z.pollSeconds, 'type="number" min="30"')}
      </div></fieldset>
    <fieldset><legend>Cloudflare</legend><div class="fields">
      ${field('API token (read-only)', 'cftoken', c.apiToken, 'type="password" autocomplete="off"')}
      ${field('Account ID (only zones in this account are shown)', 'cfacct', c.accountId, 'placeholder="Dataweavers Enterprise account ID"')}
    </div></fieldset>
    <fieldset><legend>Site24x7</legend>
      <div class="row" style="margin-bottom:10px">${sStatus}
        <button type="button" class="btn small primary" id="s24Login" ${['running', 'refreshing'].includes(sa?.login?.status) ? 'disabled' : ''}>${sa?.signedIn ? 'Sign in again' : 'Sign in with browser'}</button>
        ${sa?.signedIn ? '<button type="button" class="btn small danger" id="s24Logout">Sign out</button>' : ''}</div>
      <div class="sub" style="margin-bottom:10px">External uptime checks. No API token: a separate Edge window (a mon.ai profile) opens Site24x7; sign in with Zoho as usual (SSO/MFA) and it closes by itself. Read-only.</div>
      <div class="fields">
        <label class="f">Use Site24x7<span class="row" style="gap:6px"><input type="checkbox" name="s24on" ${s24.enabled ? 'checked' : ''}> Enabled</span></label>
        <label class="f">Data centre<select name="s24dc">${S24_DCS.map(([v, l]) => `<option value="${v}" ${s24.dc === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      </div></fieldset>
    <fieldset><legend>Squadcast</legend>
      <div class="row" style="margin-bottom:10px"><span id="sqStatus">${sq.apiToken ? '<span class="pill">Checking…</span>' : '<span class="pill">No token</span>'}</span>
        <button type="button" class="btn small" id="sqTest">Save &amp; test</button></div>
      <div class="sub" style="margin-bottom:10px">Incident hub for Azure Monitor alerts (SolarWinds Incident Response). Paste the API token from your Squadcast profile → API Token. Read-only calls.</div>
      <div class="fields">
        ${field('API token', 'sqtoken', sq.apiToken, 'type="password" autocomplete="off"')}
        <label class="f">Region<select name="sqregion"><option value="eu" ${sq.region !== 'us' ? 'selected' : ''}>EU (incidents.eu-01)</option><option value="us" ${sq.region === 'us' ? 'selected' : ''}>US (incidents.na-01)</option></select></label>
      </div></fieldset>
    <fieldset><legend>Notifications</legend>
      <div class="row">
        <label class="row" style="gap:6px"><input type="checkbox" id="notifyToggle" ${notifyOn() ? 'checked' : ''}> Windows notification when an AI reply finishes and you are not looking at that chat</label>
        <button type="button" class="btn small" id="notifyTest">Send a test</button>
      </div>
      <div class="sub" id="notifyHint" style="margin-top:6px">${!browserNotify() ? 'This page is not on HTTPS, so mon.ai shows a native Windows toast instead of a browser notification.'
        : Notification.permission === 'denied' ? 'Browser notifications are blocked for this site, so mon.ai shows a native Windows toast instead. Allow them from the lock icon in the address bar to get click-to-open.'
        : Notification.permission === 'default' ? 'The browser will ask for permission the first time.' : 'Browser notifications are allowed; clicking one opens the chat.'}</div>
    </fieldset>
    <div class="sub">Secrets stay on this machine and are masked here.</div>
  </form>`;
  const f = $('#genForm');
  $('#notifyToggle').onchange = (e) => {
    try { localStorage.setItem('mon.notify', e.target.checked ? 'on' : 'off'); } catch { /* storage unavailable */ }
    if (e.target.checked) askNotifyPermission();
  };
  $('#notifyTest').onclick = async () => {
    if (browserNotify() && Notification.permission === 'default') await Notification.requestPermission().catch(() => {});
    notifyReply({ chatId: null, title: 'Test', text: 'Notifications are working. You will get one like this when an AI reply finishes.', force: true });
  };
  const save = async () => {
    const [{ value: azNow }, { value: wsNow }] = await Promise.all([api('/api/config/azure'), api('/api/config/workspace')]);
    await api('/api/config/azure', { method: 'PUT', body: { ...azNow, edgePath: f.edgePath.value.trim(), defaultAccount: f.defaultAccount.value.trim() || DEFAULT_ACCOUNT } });
    await api('/api/config/workspace', { method: 'PUT', body: {
      ...wsNow,
      repoRoots: f.roots.value.split('\n').map((s) => s.trim()).filter(Boolean),
      scanDepth: Number(f.scanDepth.value) || 3,
      ignore: f.ignore.value.split(',').map((s) => s.trim()).filter(Boolean),
    } });
    await api('/api/config/secrets', { method: 'PUT', body: {
      zendesk: { subdomain: f.zsub.value.trim(), email: f.zemail.value.trim(), apiToken: f.ztoken.value, pollSeconds: Number(f.zpoll.value) || 60 },
      cloudflare: { apiToken: f.cftoken.value, accountId: f.cfacct.value.trim() },
      site24x7: { enabled: f.s24on.checked, dc: f.s24dc.value },
      squadcast: { apiToken: f.sqtoken.value, region: f.sqregion.value },
    } });
  };
  f.onsubmit = async (e) => {
    e.preventDefault();
    try { await save(); toast('General settings saved and applied'); } catch (err) { toast(err.message); }
  };
  $('#zdLogin').onclick = async () => {
    try {
      if (f.zsub.value.trim() !== (z.subdomain || '')) await save(); // the sign-in needs the subdomain
      await api('/api/zendesk/login', { method: 'POST', body: {} });
      generalSettings();
    } catch (err) { toast(err.message); }
  };
  $('#zdLogout')?.addEventListener('click', async () => { await api('/api/zendesk/logout', { method: 'POST', body: {} }); generalSettings(); });
  $('#s24Login').onclick = async () => {
    try {
      f.s24on.checked = true;
      if (!s24.enabled || f.s24dc.value !== s24.dc) await save(); // the sign-in needs the data centre
      await api('/api/site24x7/login', { method: 'POST', body: {} });
      generalSettings();
    } catch (err) { toast(err.message); }
  };
  $('#s24Logout')?.addEventListener('click', async () => { await api('/api/site24x7/logout', { method: 'POST', body: {} }); generalSettings(); });
  const sqCheck = async () => {
    const r = await api('/api/squadcast/check').catch((e) => ({ ok: false, configured: true, error: e.message }));
    $('#sqStatus').innerHTML = !r.configured ? '<span class="pill">No token</span>'
      : r.ok ? `<span class="pill green">Connected${r.user ? ` as ${esc(r.user)}` : ''}</span>`
      : `<span class="pill red">Not working</span> <span class="sub">${esc(r.error || '')}</span>`;
    if (r.ok) markServiceOk('squadcast', r.user || '');
  };
  $('#sqTest').onclick = async () => { try { await save(); await sqCheck(); } catch (err) { toast(err.message); } };
  if (sq.apiToken) sqCheck();
}

async function claudeSettings() {
  $('#tab').innerHTML = '<div class="card" id="cl">Checking…</div>';
  const a = await api('/api/claude/auth');
  $('#cl').innerHTML = `<h2>Claude subscription</h2>
    ${a.loggedIn ? `<p><span class="pill green">Signed in</span> ${esc(a.email || '')} · ${esc(a.org || '')} · plan: ${esc(a.plan || a.method || '')}</p>
      ${a.expiresAt ? `<p class="sub">Login valid until ${new Date(a.expiresAt).toLocaleString()} (renews automatically while in use).</p>` : ''}`
      : `<p><span class="pill red">Not signed in</span> ${esc(a.error || '')}</p>`}
    <p class="sub">The assistant uses the Claude Code login on this machine (shared with Claude Code). Signing in opens claude.ai in your browser.</p>
    <div class="row"><button class="btn primary" id="clLogin">${a.loggedIn ? 'Sign in again' : 'Sign in with browser'}</button>${a.loggedIn ? '<button class="btn danger" id="clLogout">Sign out</button>' : ''}</div>
    <div id="clMsg" class="sub" style="margin-top:10px"></div>`;
  $('#clLogin').onclick = async () => { const j = await api('/api/claude/login', { method: 'POST', body: {} }); $('#clMsg').innerHTML = 'Browser opened. Complete the sign-in there…' + (j.url ? ` If nothing opened: <a href="${esc(j.url)}" target="_blank">open sign-in page</a>` : ''); };
  $('#clLogout')?.addEventListener('click', async () => { if (await confirmDialog({ title: 'Sign out of Claude?', intro: 'This signs out Claude on this machine, including Claude Code.', danger: true })) { await api('/api/claude/logout', { method: 'POST', body: {} }); claudeSettings(); loadClaudeBadge(); } });

  // Default model + effort (stored in workspace.json under "assistant"; each chat can override the model).
  $('#tab').insertAdjacentHTML('beforeend', '<div class="card" id="mdl" style="margin-top:14px">Loading models…</div>');
  const [models, ws] = await Promise.all([getModels(), api('/api/config/workspace')]);
  const cur = ws.value.assistant || { model: 'default', effort: 'medium' };
  const effortsFor = (v) => models.find((m) => m.value === v)?.effortLevels ?? ['low', 'medium', 'high', 'xhigh', 'max'];
  const effortOptions = (v, sel) => {
    const lv = effortsFor(v);
    return lv.length ? lv.map((e) => `<option ${e === sel ? 'selected' : ''}>${e}</option>`).join('') : '<option value="">not supported by this model</option>';
  };
  $('#mdl').innerHTML = `<h2>AI model</h2>
    <p class="sub">The default for every chat. A skill can use its own model and effort (set it in the Skills tab); it applies when you run that skill with /name, and Ask AI uses /triage-ticket's. A model picked in a chat's header overrides both for that chat. The list comes from your Claude subscription.</p>
    <form class="form" id="mdlForm"><div class="fields">
      <label class="f">Default model<select name="model">${modelOptions(models, cur.model || 'default')}</select></label>
      <label class="f">Effort (thinking depth; higher is slower and uses more of your limits)<select name="effort">${effortOptions(cur.model, cur.effort)}</select></label>
    </div><div class="row"><button type="button" class="btn" id="mdlRefresh">Refresh model list</button><span class="sub">Save with the button at the top right.</span></div></form>`;
  const f = $('#mdlForm');
  f.model.onchange = () => { f.effort.innerHTML = effortOptions(f.model.value, f.effort.value || cur.effort); };
  f.onsubmit = async (e) => {
    e.preventDefault();
    try {
      const { tasks: _old, ...rest } = cur;
      await api('/api/config/workspace', { method: 'PUT', body: { ...ws.value, assistant: { ...rest, model: f.model.value, effort: f.effort.value || cur.effort } } });
      toast(`Default model: ${modelLabel(models, f.model.value)}`);
    } catch (err) { toast(err.message); }
  };
  $('#mdlRefresh').onclick = async () => { modelsPromise = api('/api/claude/models?fresh=1'); await modelsPromise; claudeSettings(); };
}

/**
 * Settings → Advanced: how the assistant's harness is wired (read-only). The server builds it from the
 * same options every chat turn uses, so it can't drift from the code. Org changes the prompt and skills.
 */
async function advancedSettings(org = 'All') {
  $('#tab').innerHTML = '<div class="card">Loading…</div>';
  let h, orgs;
  try {
    [h, orgs] = await Promise.all([api(`/api/assistant/harness?org=${encodeURIComponent(org)}`), api('/api/orgs').catch(() => [])]);
  } catch (e) { if ($('#tab')) $('#tab').innerHTML = `<div class="card"><span class="pill red">Error</span> ${esc(e.message)}</div>`; return; }
  if (!$('#tab')) return; // left the page while loading
  const code = (s) => `<code>${esc(s)}</code>`;
  const codes = (list) => (list.length ? list.map(code).join(' ') : '<span class="sub">none</span>');
  const kv = (rows) => `<table class="adv-kv">${rows.map(([k, v, hint]) => `<tr><th>${k}</th><td>${v}${hint ? `<div class="sub">${hint}</div>` : ''}</td></tr>`).join('')}</table>`;
  const scroll = (html) => `<div class="adv-scroll">${html}</div>`;
  const orgNames = ['All', ...orgs.map((o) => o.org).filter((o) => o && o !== 'All')];

  $('#tab').innerHTML = `<div class="adv">
    <div class="card"><div class="adv-head"><div><h2>Assistant harness</h2>
      <p class="sub">How mon.ai runs Claude: the agent loop, its tools and skills, the permission checks and the limits. Read-only, built from the same options every chat reply uses.</p></div>
      <label class="f adv-org">Chat organization<select id="advOrg">${orgNames.map((o) => `<option ${o === h.org ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></label></div>
      ${h.warnings.length ? `<div class="adv-warn">${h.warnings.map((w) => `<div><span class="pill ${w.level}">${w.level === 'red' ? 'Risk' : 'Check'}</span> ${esc(w.text)}</div>`).join('')}</div>`
        : '<p><span class="pill green">All checks pass</span> <span class="sub">Repo roots exist, mon.ai\'s own folder is outside them, and Cloudflare is limited to your account.</span></p>'}
    </div>

    <div class="card"><h2>Agent loop</h2>
      <p class="sub">Each message calls the Agent SDK's <code>query()</code>, which runs Claude Code: model → tool call → result → model, until Claude answers or a limit stops it.</p>
      ${kv([
        ['Agent SDK', code(h.sdk.version || 'unknown'), `Claude Code binary: ${esc(h.sdk.claudeBin)}`],
        ['Max turns', code(h.loop.maxTurns), 'Model ↔ tool round trips per reply. The Stop button also ends a reply.'],
        ['Budget cap', h.loop.budget == null ? '<span class="sub">none</span>' : code(`$${h.loop.budget}`), 'Replies use your Claude subscription, not API credit.'],
        ['Permission mode', code(h.loop.permissionMode), 'Tools not on the auto-approve list go to mon.ai\'s canUseTool check.'],
        ['Auto-approved', codes(h.allowedTools)],
        ['Setting sources', codes(h.loop.settingSources), 'Empty: nothing from CLAUDE.md or your Claude Code settings is loaded.'],
        ['Default model', `${code(h.model.model)} · effort ${code(h.model.effort)}`, 'A skill\'s model wins when the message runs it; a model picked in a chat header wins over both.'],
        ['Conversation memory', 'Resumed Claude session per chat', 'Editing a message forks the session; long chats are compacted into a summary.'],
      ])}
    </div>

    <div class="card"><h2>System prompt</h2>
      <p class="sub">Replaces Claude Code's own prompt. Shown for <b>${esc(h.org)}</b>, today.</p>
      <details><summary>Show the full prompt (${h.systemPrompt.length.toLocaleString()} characters)</summary><pre>${esc(h.systemPrompt)}</pre></details>
    </div>

    <div class="card"><h2>Built-in tools</h2>
      <p class="sub">The only Claude Code tools that exist in a chat. Bash, Write, Edit and web tools are not in the list, so Claude can't call them at all.</p>
      ${scroll(`<table><tr><th>Tool</th><th>Allowed on</th></tr>${h.builtins.map((b) => `<tr><td>${code(b.name)}</td><td>${esc(b.scope)}</td></tr>`).join('')}</table>`)}
      ${kv([
        ['Working folder', code(h.filesystem.cwd)],
        ['Also readable', h.filesystem.additionalDirectories.map(code).join('<br>') || '<span class="sub">none</span>'],
        ['Repo roots (config)', codes(h.filesystem.configuredRoots)],
      ])}
    </div>

    <div class="card"><h2>MCP tools</h2>
      <p class="sub">${h.mcpServers.map((s) => `Server ${code(s.name)} (${esc(s.type)}, in-process)`).join(', ')}: mon.ai's own code, called as <code>mcp__mon__&lt;name&gt;</code>. Hover a name for its description.</p>
      ${scroll(`<table><tr><th>Tool</th><th>Reads</th><th>Writes / side effects</th><th>Inputs</th></tr>${h.tools.map((t) => `<tr>
        <td title="${esc(t.description)}">${code(t.name)}</td><td>${esc(t.reads)}</td>
        <td>${t.writes ? `<span class="pill amber">effect</span> ${esc(t.writes)}` : '<span class="sub">none</span>'}</td>
        <td class="sub">${t.params.map(esc).join(', ') || '—'}</td></tr>`).join('')}</table>`)}
    </div>

    <div class="card"><h2>Skills</h2>
      <p class="sub">Instructions Claude loads into its own context when relevant, or when you type /name. Folder: ${code(h.skillsRoot)}. <a href="#/skills">Edit skills</a></p>
      ${scroll(`<table><tr><th>Skill</th><th>Org</th><th>Model</th><th>Effort</th><th>In ${esc(h.org)} chats</th></tr>${h.skills.map((s) => `<tr>
        <td title="${esc(s.description)}">${code(s.name)}</td><td>${esc(s.org || 'all')}</td>
        <td>${esc(s.model || 'default')}</td><td>${esc(s.effort || 'default')}</td>
        <td>${s.enabled ? '<span class="pill green">on</span>' : '<span class="pill">off</span>'}</td></tr>`).join('')}</table>`)}
    </div>

    <div class="card"><h2>Read-only guards</h2>
      ${kv([
        ['Azure CLI', `Allowed verbs: ${codes(h.guards.azure.readVerbs)}`, esc(h.guards.azure.extra)],
        ['Azure blocked words', `<div class="adv-chips">${codes(h.guards.azure.denyVerbs)}</div>`],
        ['Cloudflare', `Read-only API token${h.guards.cloudflare.zoneAllowList ? ' · zones limited to the configured account' : ' · <span class="pill amber">no zone limit</span>'}`],
        ['Zendesk', esc(h.guards.zendesk)],
        ['Files', esc(h.guards.files)],
      ])}
    </div>

    <div class="card"><h2>Not used</h2>
      ${kv(h.notUsed.map((n) => [esc(n.name), `<span class="sub">${esc(n.why)}</span>`]))}
    </div>
  </div>`;
  $('#advOrg').onchange = (e) => advancedSettings(e.target.value);
}

// ---------------- notifications (Zendesk's bell) ----------------
let notif = { unread: 0, items: [] };
let notifUnreadOnly = false;
try { notifUnreadOnly = localStorage.getItem('mon.notifUnread') === '1'; } catch { /* ignore */ }
const notifPanel = document.createElement('div');
notifPanel.className = 'notif-panel';
notifPanel.hidden = true;
notifPanel.setAttribute('role', 'dialog');
notifPanel.setAttribute('aria-label', 'Notifications');
document.body.append(notifPanel);

const notifVerb = (n) => {
  if (/mentioned/.test(n.kind)) return 'mentioned you in:';
  const m = n.kind.match(/notification\.([\w.]+?)\.title$/);
  return m ? `${m[1].replace(/[._]/g, ' ')}:` : 'updated:';
};
function drawBadge() {
  document.querySelectorAll('.notif-badge').forEach((b) => { b.hidden = !notif.unread; b.textContent = notif.unread > 9 ? '9+' : String(notif.unread); });
  document.title = notif.unread ? `(${notif.unread}) mon.ai` : 'mon.ai';
}
function drawNotifPanel() {
  if (notifPanel.hidden) return;
  const list = notif.items.filter((n) => !notifUnreadOnly || !n.read);
  const now = new Date();
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const bucket = (iso) => {
    const t = new Date(iso).getTime();
    if (now - t < 3600_000) return 'Recent';
    if (t >= dayStart) return 'Earlier today';
    if (t >= dayStart - 864e5) return 'Yesterday';
    return new Date(iso).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' });
  };
  const groups = new Map();
  for (const n of list) { const b = bucket(n.at); if (!groups.has(b)) groups.set(b, []); groups.get(b).push(n); }
  notifPanel.innerHTML = `<div class="np-head"><h2>Notifications</h2>
      <label class="np-switch" title="Only show unread"><input type="checkbox" id="npUnread" ${notifUnreadOnly ? 'checked' : ''}><span></span>Unreads</label>
      <span class="grow"></span>
      <button class="icon-btn" id="npRefresh" title="Refresh">↻</button>
      <button class="btn small" id="npAll" ${notif.unread ? '' : 'disabled'} title="Mark all as read in Zendesk">Mark all read</button></div>
    <div class="np-body">${[...groups].map(([g, items]) => `<div class="np-sec">${esc(g)}</div>${items.map((n) => `
      <button class="np-item ${n.read ? '' : 'unread'}" data-nid="${esc(n.id)}">
        <span class="np-dot"></span><span class="np-icon">${n.icon === 'MENTION' ? '@' : '🔔'}</span>
        <span class="np-main"><span class="np-title"><b>${esc(n.actor || 'Zendesk')}</b> ${esc(notifVerb(n))} <b>${esc(n.subject || (n.ticketId ? `#${n.ticketId}` : ''))}</b></span>
          ${n.message ? `<span class="np-msg">${esc(n.message)}</span>` : ''}
          <span class="np-meta">${n.ticketId ? `#${n.ticketId}` : ''}${n.org ? ` · ${esc(n.org)}` : ''}${n.requester ? ` · ${esc(n.requester)}` : ''}</span></span>
        <span class="np-time" title="${esc(new Date(n.at).toLocaleString())}">${ago(n.at)}</span>
      </button>`).join('')}`).join('') || `<div class="np-empty">${notifUnreadOnly ? "You're all caught up." : 'No notifications.'}</div>`}</div>`;
  $('#npUnread').onchange = (e) => { notifUnreadOnly = e.target.checked; try { localStorage.setItem('mon.notifUnread', notifUnreadOnly ? '1' : '0'); } catch { /* ignore */ } drawNotifPanel(); };
  $('#npRefresh').onclick = () => loadNotifs(true);
  $('#npAll').onclick = async () => {
    try { notif = await api('/api/notifications/read-all', { method: 'POST', body: {} }); drawBadge(); drawNotifPanel(); } catch (err) { toast(err.message); }
  };
}
async function loadNotifs(fresh = false) {
  try {
    notif = await api(`/api/notifications${fresh ? '?fresh=1' : ''}`);
    drawBadge(); drawNotifPanel();
  } catch (err) { if (!notifPanel.hidden) notifPanel.querySelector('.np-body')?.insertAdjacentHTML('afterbegin', `<div class="notice err">${esc(err.message)}</div>`); }
}
function toggleNotifPanel(btn) {
  if (!notifPanel.hidden) { notifPanel.hidden = true; return; }
  const r = btn.getBoundingClientRect();
  notifPanel.style.left = `${Math.min(r.right + 8, innerWidth - 436)}px`;
  notifPanel.style.top = `${Math.max(8, r.top)}px`;
  notifPanel.hidden = false;
  drawNotifPanel();
  loadNotifs(true);
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-notif]');
  if (b) { toggleNotifPanel(b); return; }
  const it = e.target.closest('.np-item');
  if (it) {
    const n = notif.items.find((x) => x.id === it.dataset.nid);
    notifPanel.hidden = true;
    if (!n) return;
    if (n.ticketId) location.hash = `#/ticket/${n.ticketId}`;
    if (!n.read) {
      n.read = true; notif.unread = Math.max(0, notif.unread - 1); drawBadge();
      api('/api/notifications/read', { method: 'POST', body: { entityType: n.entityType, entityId: n.entityId } }).then((d) => { notif = d; drawBadge(); }).catch((err) => toast(err.message));
    }
    return;
  }
  if (!notifPanel.hidden && !notifPanel.contains(e.target)) notifPanel.hidden = true;
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !notifPanel.hidden) notifPanel.hidden = true; });

// ---------------- Usage: tokens by skill / ticket / client / chat / model ----------------
const MODEL_FAMILIES = ['opus', 'sonnet', 'haiku', 'fable', 'other']; // fixed colour per model, never by rank
const USAGE_APPS = ['mon.ai', 'Claude Desktop', 'Others'];
const famOf = (m) => (String(m).match(/opus|sonnet|haiku|fable/i)?.[0] || 'other').toLowerCase();
const famLabel = (f) => f[0].toUpperCase() + f.slice(1);
const fmtTok = (n) => (n == null ? '–' : n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(Math.round(n)));
const fmtCost = (c) => (c == null ? '–' : '$' + (c >= 10 ? c.toFixed(1) : c.toFixed(2)));
// Usage range: today · this work week (from Monday) · last 7 / 30 days · custom dates · all.
// Changing it only re-reads local data (transcripts + database): no model call, no tokens.
const USAGE_RANGES = [['session', '5h session'], ['today', 'Today'], ['week', 'This week'], ['7', '7 days'], ['30', '30 days'], ['custom', 'Custom'], ['all', 'All']];
const usage$ = { range: '7', from: '', to: '', session: '', app: '' }; // app: '' = all apps, or one of USAGE_APPS; session: start time of the picked 5-hour session ('' = current)
const dimensionViews = { app: 'visual', model: 'visual' };
let usageSessions = null; // [{ start, end, current, cost, turns, ... }] newest first
try {
  Object.assign(usage$, JSON.parse(localStorage.getItem('mon.usageRange') || '{}'));
  if (!USAGE_RANGES.some(([k]) => k === usage$.range)) usage$.range = ({ 0: 'all', 30: '30' })[localStorage.getItem('mon.usageDays')] || '7'; // older setting
  if (usage$.app && !USAGE_APPS.includes(usage$.app)) usage$.app = 'Others';
} catch { /* ignore */ }
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const localMidnight = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
/** The API query and a label for the current range. */
function usageQuery() {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const fmtD = (d) => d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  switch (usage$.range) {
    case 'session': {
      const list = usageSessions || [];
      const w = list.find((x) => x.start === usage$.session) || list[0];
      if (!w) return { q: `from=${encodeURIComponent(new Date(Date.now() - 5 * 3600e3).toISOString())}`, label: 'last 5 hours' };
      return { q: `from=${encodeURIComponent(w.start)}&to=${encodeURIComponent(w.end)}`, label: sessionLabel(w) };
    }
    case 'today': return { q: `from=${encodeURIComponent(today.toISOString())}`, label: 'today' };
    case 'week': {
      const mon = new Date(today); mon.setDate(mon.getDate() - ((mon.getDay() + 6) % 7));
      return { q: `from=${encodeURIComponent(mon.toISOString())}`, label: `this week (since Mon ${fmtD(mon)})` };
    }
    case '30': return { q: 'days=30', label: 'last 30 days' };
    case 'all': return { q: 'days=0', label: 'all time' };
    case 'custom': {
      if (!usage$.from) return { q: `from=${encodeURIComponent(today.toISOString())}`, label: 'today (pick dates)' };
      const from = localMidnight(usage$.from);
      const toDay = usage$.to && usage$.to >= usage$.from ? localMidnight(usage$.to) : new Date(today);
      const end = new Date(toDay); end.setDate(end.getDate() + 1); // the "to" day is included
      return { q: `from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(end.toISOString())}`, label: `${fmtD(from)} – ${fmtD(toDay)}` };
    }
    default: return { q: 'days=7', label: 'last 7 days' };
  }
}
/** "Now · 15:30–20:30 (2h 10m left)" or "Tue 25 Nov · 10:00–15:00". */
function sessionLabel(w) {
  const t = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (w.current) { const left = Math.max(0, Date.parse(w.end) - Date.now()); return `current session · ${t(w.start)}–${t(w.end)} (${Math.floor(left / 3600e3)}h ${String(Math.floor(left / 60e3) % 60).padStart(2, '0')}m left)`; }
  return `${new Date(w.start).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })} · ${t(w.start)}–${t(w.end)}`;
}
async function loadUsageSessions() {
  const r = await api('/api/usage/sessions').catch(() => null);
  usageSessions = r?.sessions || [];
  if (usage$.session && !usageSessions.some((x) => x.start === usage$.session)) usage$.session = '';
  return usageSessions;
}
/** The session picker and session comparison list (Session range only). */
function drawSessionPicker() {
  const sel = $('#usSessionSel'), box = $('#usSessions');
  if (!sel || !box) return;
  const list = usageSessions || [];
  const cur = list.find((x) => x.start === usage$.session) || list[0];
  sel.innerHTML = list.map((w) => `<option value="${esc(w.start)}" ${w === cur ? 'selected' : ''}>${esc(sessionLabel(w))} · ${fmtCost(w.cost)}</option>`).join('') || '<option>No sessions yet</option>';
  const max = Math.max(0.01, ...list.map((w) => w.cost));
  box.innerHTML = list.length ? `<div class="card"><div class="row" style="justify-content:space-between"><h2 style="margin:0">Sessions</h2><span class="sub">mon.ai chats only · earlier windows are rebuilt from the call times, so their edges are approximate</span></div>
    <div class="us-sessions">${list.slice(0, 100).map((w) => `<button type="button" class="us-sess ${w === cur ? 'active' : ''} ${w.current ? 'now' : ''}" data-sess="${esc(w.start)}"><span class="us-sess-when">${esc(sessionLabel(w))}</span><span class="usage-bar"><i style="width:${Math.round((w.cost / max) * 100)}%"></i></span><b>${fmtCost(w.cost)}</b><span class="sub">${w.turns} msg${w.turns === 1 ? '' : 's'}</span></button>`).join('')}</div></div>` : '';
}
const saveUsageRange = () => { try { localStorage.setItem('mon.usageRange', JSON.stringify(usage$)); } catch { /* ignore */ } };

function drawPlanCard() {
  const el = $('#usPlan');
  if (!el) return;
  if (!usageData) { el.innerHTML = '<div class="sub">Checking your plan…</div>'; return; }
  if (!usageData.available) { el.innerHTML = '<div class="sub">Plan limits are not available for this sign-in.</div>'; return; }
  const row = (label, w) => {
    if (!w || w.pct == null) return '';
    const pct = Math.max(0, Math.min(100, Math.round(w.pct)));
    return `<div class="us-plan-row"><span>${label}</span><span class="usage-bar big"><i class="${pct >= 80 ? 'hi' : pct >= 50 ? 'mid' : ''}" style="width:${pct}%"></i></span><b>${pct}%</b><span class="sub">${esc(untilText(w.resetsAt))}</span></div>`;
  };
  el.innerHTML = row('Session (5 hours)', usageData.session) + row('Weekly (all models)', usageData.weekly) + usageData.models.map((m) => row(`Weekly · ${esc(m.name)}`, m)).join('')
    + `<div class="sub" style="margin-top:6px">${esc(usageData.plan || '')} plan · checked ${ago(usageData.checkedAt)}</div>`;
}

async function usagePage() {
  view.innerHTML = `<div class="page-head"><div><h1>Claude usage</h1>
      <div class="sub">What mon.ai, Claude Desktop and other Claude Code apps use on this machine, read from Claude Code's transcripts. <b>Cost</b> is the API-equivalent price Claude Code reports: a fair measure of how much of your plan something uses (the plan itself isn't billed per token).</div></div>
    <div class="row us-range-row"><div class="seg" id="usRange" title="Changing the range re-reads local data only: it uses no tokens">${USAGE_RANGES.map(([k, l]) => `<button data-range="${k}" class="${k === usage$.range ? 'active' : ''}">${l}</button>`).join('')}</div>
      <span class="us-custom" id="usSession" ${usage$.range === 'session' ? '' : 'hidden'}><select id="usSessionSel" class="select" title="Which 5-hour session"><option>Loading…</option></select></span>
      <span class="us-custom" id="usCustom" ${usage$.range === 'custom' ? '' : 'hidden'}><input type="date" id="usFrom" value="${esc(usage$.from)}" max="${ymd(new Date())}" title="From (included)"><span class="sub">to</span><input type="date" id="usTo" value="${esc(usage$.to)}" max="${ymd(new Date())}" title="To (included; empty = today)"></span>
      <button class="btn" id="usRefresh" title="Re-read the transcripts and the plan limits">↻ Refresh</button></div></div>
    <div class="grid us-top"><div class="card"><h2>Plan limits</h2><div id="usPlan"></div></div><div class="grid kpis us-kpis" id="usKpis"></div></div>
    <div class="us-apps" id="usApps"></div>
    <div id="usSessions" ${usage$.range === 'session' ? '' : 'hidden'}></div>
    <div id="usHints"></div>
    <div class="card"><div class="row" style="justify-content:space-between"><h2 style="margin:0">Cost per day, by model</h2><div class="us-legend" id="usLegend"></div></div><div class="us-chart" id="usChart"></div></div>
    <div class="grid us-tables" id="usTables"><div class="sub">Loading…</div></div>`;
  drawPlanCard();
  if (!usageData) loadUsage();
  $('#usRange').onclick = (e) => {
    const b = e.target.closest('[data-range]');
    if (!b) return;
    usage$.range = b.dataset.range;
    if (usage$.range === 'custom' && !usage$.from) { const wk = new Date(); wk.setDate(wk.getDate() - 6); usage$.from = ymd(wk); usage$.to = ymd(new Date()); }
    saveUsageRange();
    $('#usRange').querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
    $('#usCustom').hidden = usage$.range !== 'custom';
    $('#usSession').hidden = $('#usSessions').hidden = usage$.range !== 'session';
    $('#usFrom').value = usage$.from; $('#usTo').value = usage$.to;
    drawUsageData();
  };
  const onDates = () => {
    usage$.from = $('#usFrom').value; usage$.to = $('#usTo').value;
    if (usage$.from && usage$.to && usage$.to < usage$.from) { usage$.to = usage$.from; $('#usTo').value = usage$.to; }
    saveUsageRange(); drawUsageData();
  };
  $('#usFrom').onchange = onDates; $('#usTo').onchange = onDates;
  const pickSession = (start) => {
    usage$.session = (usageSessions || []).find((x) => x.start === start)?.current ? '' : start; // the current one follows into the next session
    saveUsageRange(); drawSessionPicker(); drawUsageData();
  };
  $('#usSessionSel').onchange = (e) => pickSession(e.target.value);
  const pickApp = (e) => { const b = e.target.closest('[data-app]'); if (!b) return; usage$.app = b.dataset.app; saveUsageRange(); drawUsageData(); };
  $('#usApps').onclick = pickApp;
  $('#usTables').addEventListener('click', (e) => {
    pickApp(e);
    const slice = e.target.closest('[data-pie-slice]');
    if (slice) {
      const card = slice.closest('.us-dimension');
      const target = card.querySelector(`[data-pie-info="${slice.dataset.pieSlice}"]`);
      const wasPinned = card.dataset.piePinned === slice.dataset.pieSlice;
      card.querySelectorAll('[data-pie-info]').forEach((el) => { el.hidden = true; });
      if (wasPinned) {
        delete card.dataset.piePinned;
      } else {
        card.dataset.piePinned = slice.dataset.pieSlice;
        target.hidden = false;
      }
      return;
    }
    const b = e.target.closest('[data-dimension-view]');
    if (!b) return;
    const card = b.closest('.us-dimension');
    const view = card.dataset.view === 'table' ? 'visual' : 'table';
    card.dataset.view = view;
    dimensionViews[b.dataset.dimensionView] = view;
    b.textContent = `Show ${view === 'table' ? 'visual' : 'table'}`;
    b.setAttribute('aria-label', `Show ${view === 'table' ? 'visual' : 'table'} view for ${b.dataset.dimensionView}`);
  });
  $('#usTables').addEventListener('pointerover', (e) => {
    const slice = e.target.closest('[data-pie-slice]');
    if (!slice) return;
    const card = slice.closest('.us-dimension');
    if (card.dataset.piePinned != null) return;
    card.querySelectorAll('[data-pie-info]').forEach((el) => { el.hidden = true; });
    card.querySelector(`[data-pie-info="${slice.dataset.pieSlice}"]`).hidden = false;
  });
  $('#usTables').addEventListener('pointerout', (e) => {
    const slice = e.target.closest('[data-pie-slice]');
    const detail = e.target.closest('.us-pie-detail');
    if (!slice && !detail) return;
    if (detail && e.relatedTarget && detail.contains(e.relatedTarget)) return;
    const card = (slice || detail).closest('.us-dimension');
    if (card.dataset.piePinned != null || e.relatedTarget?.closest?.('[data-pie-slice], .us-pie-detail')) return;
    card.querySelectorAll('[data-pie-info]').forEach((el) => { el.hidden = true; });
  });
  $('#usTables').addEventListener('focusin', (e) => {
    const slice = e.target.closest('[data-pie-slice]');
    if (!slice) return;
    const card = slice.closest('.us-dimension');
    card.querySelectorAll('[data-pie-info]').forEach((el) => { el.hidden = true; });
    card.querySelector(`[data-pie-info="${slice.dataset.pieSlice}"]`).hidden = false;
  });
  $('#usTables').addEventListener('focusout', (e) => {
    if (e.relatedTarget?.closest?.('[data-pie-slice], .us-pie-detail')) return;
    const card = e.target.closest('.us-dimension');
    if (card?.dataset.piePinned == null) card.querySelectorAll('[data-pie-info]').forEach((el) => { el.hidden = true; });
  });
  $('#usTables').addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-pie-slice]')) {
      e.preventDefault();
      e.target.click();
    }
  });
  $('#usSessions').onclick = (e) => { const b = e.target.closest('[data-sess]'); if (b) pickSession(b.dataset.sess); };
  $('#usRefresh').onclick = async (e) => {
    e.target.disabled = true;
    try { await api('/api/usage/refresh', { method: 'POST', body: {} }); await loadUsage(true); await drawUsageData(); } catch (err) { toast(err.message); }
    e.target.disabled = false;
  };
  await drawUsageData();
}

async function drawUsageData() {
  const seq = (drawUsageData.seq = (drawUsageData.seq || 0) + 1); // a quicker later click wins
  if (usage$.range === 'session') { await loadUsageSessions(); if (seq !== drawUsageData.seq) return; drawSessionPicker(); }
  const { q, label } = usageQuery();
  const d = await api(`/api/usage?${q}${usage$.app ? `&source=${encodeURIComponent(usage$.app)}` : ''}`);
  if (seq !== drawUsageData.seq || state.route.name !== 'usage' || !$('#usKpis')) return;
  $('#usApps').innerHTML = `<span class="sub">App</span><div class="seg">${[['', 'All Apps'], ...USAGE_APPS.map((a) => [a, a])].map(([k, l]) => `<button data-app="${esc(k)}" class="${k === usage$.app ? 'active' : ''}">${esc(l)}</button>`).join('')}</div><span class="sub">Claude Desktop, Claude Code, VS Code and the CLI are read from their local transcripts. claude.ai chats keep none, so they aren't counted.${d.estimated ? ' Some costs are estimated (sessions without a cost record).' : ''}</span>`;
  const t = d.totals;
  $('#usKpis').innerHTML = [
    ['Cost', fmtCost(t.cost), `${label} · API-equivalent`],
    ['Messages', t.turns, `${t.calls} model calls`],
    ['Per message', fmtCost(t.costPerTurn), `${fmtTok(t.perTurn)} tokens on average`],
    ['Tokens', fmtTok(t.tokens), `${fmtTok(t.output)} written · ${fmtTok(t.cacheRead)} re-read`],
    ['Cache re-use', t.cacheHit == null ? '–' : `${Math.round(t.cacheHit * 100)}%`, 'of input read from cache (cheaper)'],
  ].map(([l, v, h]) => `<div class="card kpi"><div class="label">${l}</div><div class="value">${v}</div><div class="hint">${esc(h)}</div></div>`).join('');

  $('#usHints').innerHTML = d.hints.length ? `<div class="card us-hints"><h2>Ways to use less</h2>${d.hints.map((h) => `<div class="us-hint ${h.level}"><span>${h.level === 'save' ? '💡' : 'ℹ️'}</span><span>${esc(h.text)}${h.link ? ` <a href="${esc(h.link)}">Open</a>` : ''}</span></div>`).join('')}</div>` : '';

  // ---- stacked bars: cost per day by model (fixed colour per model)
  const fams = MODEL_FAMILIES.filter((f) => d.byDay.some((x) => x.models[f]?.cost));
  const max = Math.max(0.01, ...d.byDay.map((x) => fams.reduce((n, f) => n + (x.models[f]?.cost || 0), 0)));
  $('#usLegend').innerHTML = fams.map((f) => `<span><i class="sw m-${f}"></i>${famLabel(f)}</span>`).join('');
  const many = d.byDay.length > 31;
  $('#usChart').innerHTML = `<div class="us-bars" style="grid-template-columns:repeat(${d.byDay.length}, minmax(0, 1fr))">${d.byDay.map((x, i) => {
    const total = fams.reduce((n, f) => n + (x.models[f]?.cost || 0), 0);
    const label = new Date(`${x.day}T00:00`).toLocaleDateString(undefined, many ? { day: 'numeric', month: 'short' } : { weekday: 'short', day: 'numeric' });
    const showLabel = !many || i % Math.ceil(d.byDay.length / 10) === 0 || i === d.byDay.length - 1;
    return `<div class="us-col" data-i="${i}"><span class="us-val">${total && (!many || total === max) ? fmtCost(total) : ''}</span>
      <div class="us-stack" style="height:${(total / max) * 86}%">${fams.filter((f) => x.models[f]?.cost).map((f) => `<i class="m-${f}" style="flex:${x.models[f].cost}"></i>`).join('')}</div>
      <span class="us-day">${showLabel ? esc(label) : ''}</span></div>`;
  }).join('')}</div><div class="us-tip" id="usTip" hidden></div>`;
  const tip = $('#usTip');
  $('#usChart').onmousemove = (e) => {
    const col = e.target.closest('.us-col');
    if (!col) { tip.hidden = true; return; }
    const x = d.byDay[Number(col.dataset.i)];
    const total = fams.reduce((n, f) => n + (x.models[f]?.cost || 0), 0);
    tip.innerHTML = `<b>${esc(new Date(`${x.day}T00:00`).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' }))}</b>
      ${fams.filter((f) => x.models[f]).map((f) => `<div><i class="sw m-${f}"></i>${famLabel(f)} <span>${fmtCost(x.models[f].cost)} · ${fmtTok(x.models[f].tokens)} tok</span></div>`).join('') || '<div class="sub">No usage</div>'}
      ${total ? `<div class="us-tip-total">Total <span>${fmtCost(total)}</span></div>` : ''}`;
    tip.hidden = false;
    const box = $('#usChart').getBoundingClientRect(), r = col.getBoundingClientRect();
    tip.style.left = `${Math.min(box.width - 200, Math.max(0, r.left - box.left + r.width / 2 - 100))}px`;
  };
  $('#usChart').onmouseleave = () => { tip.hidden = true; };

  // ---- breakdown tables
  const totalCost = t.cost || 0;
  const tableContent = (rows, { link, first = 'Name' } = {}) => rows.length ? `<table>
      <tr><th>${first}</th><th class="n">Msgs</th><th class="n" title="Tokens the model wrote">Output</th><th class="n" title="All tokens: input, output, cache read and write">Tokens</th><th class="n">Per msg</th><th class="n">Cost</th></tr>
      ${rows.map((r) => `<tr><td class="us-name">${link ? link(r) : esc(r.label)}${r.models?.length ? `<span class="us-models">${r.models.filter((f) => f !== 'other').map((f) => `<i class="sw m-${f}" title="${famLabel(f)}"></i>`).join('')}</span>` : ''}</td>
        <td class="n">${r.turns}</td><td class="n">${fmtTok(r.output)}</td><td class="n">${fmtTok(r.tokens)}</td><td class="n">${fmtCost(r.costPerTurn)}</td>
        <td class="n us-cost">${fmtCost(r.cost)}<span class="us-share"><i style="width:${totalCost && r.cost ? Math.max(2, (r.cost / totalCost) * 100) : 0}%"></i></span></td></tr>`).join('')}</table>` : '<div class="sub">Nothing in this period.</div>';
  const table = (title, rows, options = {}) => `<div class="card us-table"><h2>${title}${options.note ? ` <span class="sub">${options.note}</span>` : ''}</h2>${options.scroll ? `<div class="us-table-scroll">${tableContent(rows, options)}</div>` : tableContent(rows, options)}</div>`;
  const dimension = (key, title, rows, options = {}) => {
    const pieColors = key === 'model'
      ? rows.map((r) => `m-${famOf(r.label)}`)
      : rows.map((r) => `app-${Math.max(0, USAGE_APPS.indexOf(r.key))}`);
    const pieValues = {
      'm-opus': 'var(--m-opus)', 'm-sonnet': 'var(--m-sonnet)', 'm-haiku': 'var(--m-haiku)',
      'm-fable': 'var(--m-fable)', 'm-other': 'var(--m-other)',
      'app-0': 'var(--accent)', 'app-1': 'var(--m-sonnet)', 'app-2': 'var(--m-haiku)',
    };
    const pieTotal = rows.reduce((n, r) => n + (r.cost || 0), 0);
    let angle = -Math.PI / 2;
    const cx = 300, cy = 180, radius = 145;
    const slices = rows.map((r, i) => {
      const fraction = pieTotal ? Math.max(0, r.cost || 0) / pieTotal : 0;
      if (!fraction) {
        angle += fraction * Math.PI * 2;
        return { svg: '', detail: '' };
      }
      const end = angle + fraction * Math.PI * 2;
      const mid = (angle + end) / 2;
      const point = (a, rad) => [cx + Math.cos(a) * rad, cy + Math.sin(a) * rad];
      const [x1, y1] = point(angle, radius), [x2, y2] = point(end, radius);
      const large = end - angle > Math.PI ? 1 : 0;
      const path = fraction >= 1 ? `M ${cx} ${cy - radius} A ${radius} ${radius} 0 1 1 ${cx - 0.01} ${cy - radius} Z`
        : fraction > 0 ? `M ${cx} ${cy} L ${x1} ${y1} A ${radius} ${radius} 0 ${large} 1 ${x2} ${y2} Z` : '';
      const [lx, ly] = point(mid, radius * (fraction >= 0.13 ? 0.58 : 1.16));
      const small = fraction < 0.13;
      const anchor = Math.cos(mid) < -0.15 ? 'end' : Math.cos(mid) > 0.15 ? 'start' : 'middle';
      const [ex, ey] = small ? point(mid, radius + 12) : [lx, ly];
      const tx = small ? ex + (anchor === 'end' ? -7 : anchor === 'start' ? 7 : 0) : lx;
      const ty = small ? ey + (Math.sin(mid) < -0.55 ? -5 : Math.sin(mid) > 0.55 ? 12 : 4) : ly + 5;
      const displayLabel = key === 'model' ? r.label.replace(/^claude-/, '') : r.label;
      const detailsId = `us-${key}-${i}`;
      const titleText = `${r.label}: ${fmtCost(r.cost)} · ${r.turns} messages · ${fmtTok(r.output)} output · ${fmtTok(r.tokens)} tokens · ${fmtCost(r.costPerTurn)} per message`;
      angle = end;
      return {
        svg: `<g class="us-pie-slice ${small ? 'small' : ''}" tabindex="0" role="button" aria-label="${esc(titleText)}" aria-controls="${detailsId}" data-pie-slice="${i}">
          <path d="${path}" fill="${pieValues[pieColors[i]] || 'var(--m-other)'}"></path>
          ${small ? `<path class="us-pie-leader" d="M ${point(mid, radius - 1).join(' ')} L ${ex} ${ey} L ${tx} ${ey}"></path>` : ''}
          <text x="${tx}" y="${ty}" text-anchor="${small ? anchor : 'middle'}">${fmtCost(r.cost)}</text>
        </g>`,
        detail: `<div class="us-pie-detail" id="${detailsId}" data-pie-info="${i}" hidden>
        <b>${esc(displayLabel)}</b><span>${r.turns} msg${r.turns === 1 ? '' : 's'}</span>
        <span>${fmtTok(r.output)} output</span><span>${fmtTok(r.tokens)} tokens</span>
        <span>${fmtCost(r.costPerTurn)} per msg</span>
        ${key === 'app' ? `<button type="button" class="link" data-app="${esc(r.key)}" title="Show only ${esc(r.label)}">Filter app</button>` : ''}
      </div>`,
      };
    });
    const legend = rows.map((r, i) => {
      const displayLabel = key === 'model' ? r.label.replace(/^claude-/, '') : r.label;
      return `<span class="us-pie-legend-item"><i class="sw" style="background:${pieValues[pieColors[i]] || 'var(--m-other)'}"></i>${esc(displayLabel)}</span>`;
    }).join('');
    const visual = rows.length ? `<div class="us-visual">
      <svg class="us-pie" viewBox="${key === 'model' || key === 'app' ? '110 0 380 360' : '0 0 600 360'}" role="group" aria-label="${esc(title)} cost breakdown">${slices.map((s) => s.svg).join('')}</svg>
      <div class="us-pie-details">${slices.map((s) => s.detail).join('')}</div>
      <div class="us-pie-legend" aria-label="${esc(title)} legend">${legend}</div>
    </div>` : '<div class="sub">Nothing in this period.</div>';
    return `<div class="card us-table us-dimension" data-dimension="${key}" data-view="${dimensionViews[key]}">
      <div class="us-dimension-head"><h2>${title}</h2><button type="button" class="btn small" data-dimension-view="${key}" aria-label="Show ${dimensionViews[key] === 'table' ? 'visual' : 'table'} view for ${key}">Show ${dimensionViews[key] === 'table' ? 'visual' : 'table'}</button></div>
      ${visual}<div class="us-breakdown-table">${tableContent(rows, options)}</div>
    </div>`;
  };
  const skillLink = (r) => (r.key ? `<a href="#/skills/${encodeURIComponent(r.key)}">${esc(r.label)}</a>` : esc(r.label));
  const fill = (html) => html.replace('class="card us-table', 'class="card us-table us-fillcard');
  const skillCard = fill(table('By skill', d.bySkill, { first: 'Skill', link: skillLink, note: 'the /skill a message ran (or the first one it used)', scroll: true }));
  const appCard = usage$.app ? '' : dimension('app', 'By app', d.bySource, { first: 'App', link: (r) => `<button type="button" class="link" data-app="${esc(r.key)}" title="Show only ${esc(r.label)}">${esc(r.label)}</button>` });
  const folderCard = d.byProject.length ? fill(table('Other apps by folder', d.byProject, { first: 'App · folder', note: 'Claude Desktop, VS Code and CLI sessions, by the folder they ran in', scroll: true })) : '';
  const clientCard = usage$.app === 'mon.ai' ? fill(table('By client', d.byClient, { first: 'Client', note: 'mon.ai chats', link: (r) => (r.key ? `<a href="#/org/${encodeURIComponent(r.key)}">${esc(r.label)}</a>` : esc(r.label)), scroll: true })) : '';
  const right = [clientCard, appCard, folderCard].filter(Boolean);
  // Rows of equal-height cards: tables fill whatever height the row has and scroll inside.
  $('#usTables').innerHTML = `<div class="us-row us-row-top">
      <div class="card us-table us-wide us-fillcard" id="usChats"></div>
      ${dimension('model', 'By model', d.byModel.map((r) => ({ ...r, label: r.label.replace(/^claude-/, '') })), { first: 'Model' })}
    </div>
    <div class="us-row us-row-bottom">${skillCard}${right.length ? `<div class="us-colstack">${right.join('')}</div>` : ''}</div>`;
  drawChatUsage(d.byChat, totalCost);
}

// ---- By chat: pick how many, expand a chat to see its models, skills and costliest messages
const usExpanded = new Set();
function drawChatUsage(chats, totalCost) {
  const el = $('#usChats');
  if (!el) return;
  const dots = (models) => (models?.length ? `<span class="us-models">${models.filter((f) => f !== 'other').map((f) => `<i class="sw m-${f}" title="${famLabel(f)}"></i>`).join('')}</span>` : '');
  const share = (c, of) => `<span class="us-share"><i style="width:${of && c ? Math.max(2, (c / of) * 100) : 0}%"></i></span>`;
  const mini = (title, rows, label) => `<div class="us-mini"><h3>${title}</h3><table>${rows.map((r) => `<tr><td class="us-name">${label(r)}</td><td class="n">${r.turns} msg${r.turns === 1 ? '' : 's'}</td><td class="n">${fmtTok(r.tokens)}</td><td class="n us-cost">${fmtCost(r.cost)}</td></tr>`).join('')}</table></div>`;
  const detail = (c) => `<tr class="us-detail"><td colspan="6"><div class="us-detail-grid">
      ${mini('Models', c.byModel, (r) => `<i class="sw m-${famOf(r.label)}"></i> ${esc(r.label.replace(/^claude-/, ''))}`)}
      ${mini('Skills', c.bySkill, (r) => (r.key ? `<a href="#/skills/${encodeURIComponent(r.key)}">${esc(r.label)}</a>` : `<span class="sub">${esc(r.label)}</span>`))}
      <div class="us-mini us-mini-wide"><h3>Costliest messages</h3><table>${c.messages.map((m) => `<tr><td class="us-name">${esc(m.text.slice(0, 120))}${m.skill && !m.text.startsWith(`/${m.skill}`) ? ` <span class="pill">/${esc(m.skill)}</span>` : ''}</td><td class="n">${m.calls} call${m.calls === 1 ? '' : 's'}</td><td class="n">${fmtTok(m.tokens)}</td><td class="n us-cost">${fmtCost(m.cost)}</td><td class="n sub">${ago(m.at)}</td></tr>`).join('')}</table></div>
    </div></td></tr>`;
  el.innerHTML = `<div class="row" style="justify-content:space-between;margin-bottom:8px"><h2 style="margin:0">By chat / session <span class="sub">${chats.length} chat${chats.length === 1 ? '' : 's'} · click one to see its models, skills and messages</span></h2></div>
    ${chats.length ? `<div class="us-table-scroll us-chat-scroll"><table>
      <tr><th>Chat</th><th class="n">Msgs</th><th class="n" title="Tokens the model wrote">Output</th><th class="n" title="All tokens: input, output, cache read and write">Tokens</th><th class="n">Per msg</th><th class="n">Cost</th></tr>
      ${chats.map((c) => `<tr class="us-chat-row ${usExpanded.has(c.key) ? 'open' : ''}" data-chat="${esc(c.key)}">
          <td class="us-name"><span class="us-caret">${usExpanded.has(c.key) ? '▾' : '▸'}</span>${c.chatId ? `<a href="#/chat/${esc(c.chatId)}">${esc(c.label)}</a>` : esc(c.label)}${c.org ? ` <span class="sub">· ${esc(c.org)}</span>` : ''}${c.source !== 'mon.ai' ? ` <span class="pill us-app" title="${esc(c.project || '')}">${esc(c.source || 'Other app')}</span>` : ''}${dots(c.models)}</td>
          <td class="n">${c.turns}</td><td class="n">${fmtTok(c.output)}</td><td class="n">${fmtTok(c.tokens)}</td><td class="n">${fmtCost(c.costPerTurn)}</td><td class="n us-cost">${fmtCost(c.cost)}${share(c.cost, totalCost)}</td></tr>
        ${usExpanded.has(c.key) ? detail(c) : ''}`).join('')}</table></div>` : '<div class="sub">Nothing in this period.</div>'}`;
  el.onclick = (e) => {
    if (e.target.closest('a')) return;
    const row = e.target.closest('.us-chat-row');
    if (row) { const k = row.dataset.chat; usExpanded.has(k) ? usExpanded.delete(k) : usExpanded.add(k); drawChatUsage(chats, totalCost); }
  };
}

// header chip on a ticket's chat: what it has cost so far
function fillCostChip(u) {
  const el = $('#chatCostChip') || tvChipsEl?.querySelector('#chatCostChip'); // header chips may not be on the page yet
  if (!el || !u?.totals?.calls) return;
  el.innerHTML = `<span class="pill cost" title="${u.totals.turns} runs · ${fmtTok(u.totals.tokens)} tokens (API-equivalent cost; details in the side panel)">${fmtCost(u.totals.cost)} · ${u.totals.turns} run${u.totals.turns === 1 ? '' : 's'}</span>`;
}
// ---- This chat: skills, models, tokens and cost of its runs (side panel, below Repositories)
const CHAT_USAGE_SLOT = '<div class="card chat-usage" id="chatUsage" hidden></div>';
async function loadChatUsage(sid) {
  const el = $('#chatUsage');
  if (!el || !sid) return;
  el.dataset.chat = sid;
  let u;
  try { u = await api(`/api/usage/chat/${encodeURIComponent(sid)}`); } catch { return; }
  if (!el.isConnected || el.dataset.chat !== sid) return;
  const t = u.totals;
  fillCostChip(u);
  const dots = (models) => (models || []).filter((f) => f !== 'other').map((f) => `<i class="sw m-${f}" title="${famLabel(f)}"></i>`).join('');
  el.hidden = false;
  // Context size: how full the model's context window is after the last reply (what compaction acts on).
  const c = u.context;
  const ctxHtml = c ? (() => {
    const pct = Math.min(100, Math.round(c.pct * 100));
    const level = pct >= 80 ? 'hi' : pct >= 60 ? 'mid' : '';
    return `<div class="cu-ctx ${level}" title="Tokens the next turn sends: the last reply's prompt, cache and output (${c.tokens.toLocaleString()} of ${c.window.toLocaleString()}${c.estimatedWindow ? ', window size estimated' : ''})">
      <div class="cu-ctx-head"><span>Context${chatCompact?.sid === sid ? ' <button type="button" class="btn small cu-compact" data-compact title="Replace the older part of this conversation with a summary, so each new message re-reads less. Claude Code also does this on its own when the context fills up.">🗜 Compact</button>' : ''}</span><span><b>${fmtTok(c.tokens)}</b> / ${fmtTok(c.window)} · <b>${pct}%</b></span></div>
      <div class="cu-ctx-bar"><i style="width:${pct}%"></i></div></div>`;
  })() : '';
  el.innerHTML = `<h2>This chat <a class="sub" href="#/usage" style="float:right;font-weight:400">Usage →</a></h2>${ctxHtml}
    ${t.calls ? `<div class="cu-kpis"><div><b>${fmtCost(t.cost)}</b><span>cost</span></div><div><b>${t.turns}</b><span>runs</span></div><div><b>${fmtTok(t.tokens)}</b><span>tokens</span></div><div><b>${t.cacheHit == null ? '–' : `${Math.round(t.cacheHit * 100)}%`}</b><span>cache</span></div></div>
    <div class="cu-sec">Models</div>${u.byModel.map((m) => `<div class="cu-row"><span><i class="sw m-${famOf(m.label)}"></i> ${esc(m.label.replace(/^claude-/, ''))}</span><span>${fmtTok(m.tokens)} · <b>${fmtCost(m.cost)}</b></span></div>`).join('')}
    <div class="cu-sec">Skills</div>${u.bySkill.map((k) => `<div class="cu-row"><span>${dots(k.models)} ${k.key ? `<a href="#/skills/${encodeURIComponent(k.key)}">${esc(k.label)}</a>` : '<span class="sub">No skill</span>'} <span class="sub">×${k.turns}</span></span><span><b>${fmtCost(k.cost)}</b></span></div>`).join('')}
    <div class="cu-sec">Last runs</div>${u.lastRuns.map((r) => `<div class="cu-run"><div class="cu-run-text" title="${esc(r.label)}">${esc(r.label.slice(0, 90))}</div>
      <div class="sub">${dots(r.models)} ${r.skill ? `/${esc(r.skill)} · ` : ''}${r.skillsUsed?.length && r.skillsUsed[0] !== r.skill ? `used ${r.skillsUsed.map((x) => `/${esc(x)}`).join(', ')} · ` : ''}${r.calls} call${r.calls === 1 ? '' : 's'} · ${r.tools} tool${r.tools === 1 ? '' : 's'} · ${fmtTok(r.tokens)} · <b>${fmtCost(r.cost)}</b> · ${ago(r.at)}</div></div>`).join('')}`
    : '<div class="sub">No runs yet. Skills, models, tokens and cost show here after the first reply.</div>'}`;
  const cb = el.querySelector('[data-compact]');
  if (cb) cb.onclick = () => chatCompact?.sid === sid && chatCompact.run();
}

// ---------------- router ----------------
function parseRoute() {
  const [name = '', id, sub] = location.hash.replace(/^#\/?/, '').split('/');
  return { name: name || 'dashboard', id: id ? decodeURIComponent(id) : undefined, sub: sub ? decodeURIComponent(sub) : undefined };
}
async function route() {
  state.route = parseRoute();
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === state.route.name));
  loadSidebar();
  const { name, id } = state.route;
  try {
    if (name === 'dashboard') await dashboard();
    else if (name === 'org') await orgPage(id);
    else if (name === 'chat') await chatPage(id);
    else if (name === 'ticket') await ticketPage(id, state.route.sub);
    else if (name === 'usage') await usagePage();
    else if (name === 'clients' || name === 'azure') await azurePage();
    else if (name === 'cloudflare') location.hash = '#/clients';
    else if (name === 'repos') await reposPage();
    else if (name === 'skills') await skillsPage(id);
    else if (name === 'settings') await settingsPage(id);
    else view.innerHTML = '<div class="empty">Not found</div>';
  } catch (e) { view.innerHTML = `<div class="notice err">${esc(e.message)}</div>`; }
}
window.addEventListener('hashchange', route);

// ---------------- live updates ----------------
const es = new EventSource('/api/events');
es.addEventListener('tickets:updated', () => { chatTicketWatch?.(); loadSidebar(); refreshDashboard().catch(() => {}); if (state.route.name === 'org') refreshOrgLive(state.route.id); });
es.addEventListener('zendesk:auth', (e) => {
  const d = JSON.parse(e.data);
  if (d.login?.status === 'ok' && d.signedIn) toast(`Zendesk: signed in as ${d.user?.name || 'you'}, syncing…`);
  else if (d.login?.status === 'error') toast(`Zendesk sign-in: ${d.login.error}`);
  else if (!d.signedIn && d.login?.status === 'needs-login') toast('Zendesk is signed out: click Sign in to Zendesk on the Dashboard');
  if (state.route.name === 'settings' && state.route.id === 'general') generalSettings();
  refreshDashboard().catch(() => {});
});
es.addEventListener('site24x7:auth', (e) => {
  const d = JSON.parse(e.data);
  const was = site24x7Auth?.login?.status;
  site24x7Auth = d;
  if (d.signedIn && d.login?.status === 'ok') {
    markServiceOk('site24x7', d.user?.name || '');
    if (was === 'running') toast(`Site24x7: signed in${d.user?.name ? ` as ${d.user.name}` : ''}`);
  } else if (d.login?.status === 'error') toast(`Site24x7 sign-in: ${d.login.error}`);
  if (!['running', 'refreshing'].includes(d.login?.status)) {
    for (const b of document.querySelectorAll('[data-service-login].waiting')) { b.className = 'btn small signin-btn'; b.textContent = 'Sign in to Site24x7'; }
  }
  if (state.route.name === 'settings' && state.route.id === 'general') generalSettings();
});
es.addEventListener('claude:usage', (e) => { usageData = JSON.parse(e.data); drawUsage(); });
es.addEventListener('usage:updated', (e) => {
  if (state.route.name === 'usage') drawUsageData().catch(() => {});
  const sid = JSON.parse(e.data || '{}').sessionId;
  const card = $('#chatUsage');
  if (card && sid && (card.dataset.chat === sid || state.route.sub === sid || (state.route.name === 'chat' && state.route.id === sid))) loadChatUsage(sid);
});
es.addEventListener('notifications:updated', (e) => {
  const d = JSON.parse(e.data);
  for (const n of (d.fresh || []).slice(0, 3)) toast(`🔔 ${n.actor || 'Zendesk'} ${notifVerb(n)} ${n.ticketId ? `#${n.ticketId} ` : ''}${n.subject || ''}`);
  loadNotifs();
});
es.addEventListener('zendesk:status', () => refreshDashboard().catch(() => {}));
es.addEventListener('sessions:updated', () => loadSidebar());
// A solved ticket was reopened on Zendesk: its chat came back from the Archive.
es.addEventListener('chats:restored', (e) => {
  for (const c of JSON.parse(e.data || '[]')) toast(`#${c.ticketId} was reopened (now ${c.status}): its chat is back in the sidebar. Use ↻ Zendesk in it to catch up.`);
  if (state.route.name === 'chat' && !state.route.id) chatList();
});
es.addEventListener('skills:updated', () => { skillsCache = null; if (state.route.name === 'skills' && !state.route.id) skillsPage(); });
es.addEventListener('repos:updated', () => { invalidate('repos'); loadSidebar(); if (state.route.name === 'repos' && !$('#repoBody .card')) reposPage(); });
es.addEventListener('config:changed', (e) => { const { name } = JSON.parse(e.data); invalidate('azure', 'zones'); toast(`Config “${name}” reloaded`); loadSidebar(); });
// A terminal was opened or a subscription switched: the page that did it already showed a message.
es.addEventListener('azure:login', (e) => { const d = JSON.parse(e.data); if (d.switched) refreshAzureStatus(); });
// the background sign-in test finished: redraw the badges
es.addEventListener('azure:validity', () => { if (azStatus || ['azure', 'clients', 'org', 'chat'].includes(state.route.name)) refreshAzureStatus(); });
es.addEventListener('claude:login', (e) => { const d = JSON.parse(e.data); if (d.status !== 'running') { toast(d.status === 'ok' ? 'Signed in to Claude' : 'Claude sign-in did not complete'); loadClaudeBadge().then(() => loadUsage(true)); if (state.route.id === 'claude') claudeSettings(); } });

loadClaudeBadge().then(() => loadUsage());
loadNotifs();
route();
