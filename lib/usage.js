// Token usage analysis: what each skill / ticket / client / chat / model costs.
// Source: Claude Code's own transcripts (~/.claude/projects/<cwd>/<claude session id>.jsonl), which
// record every API call's model and tokens, plus a "cost-state" line with the exact API-equivalent
// cost per model for the session. Per-call cost = that session cost split by token weight.
// Read after each reply and once at start-up (so chats from before this existed are included).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { db, bus } from './db.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS usage_calls (
    msg_id TEXT PRIMARY KEY, session_id TEXT, claude_session_id TEXT, prompt_id TEXT, at TEXT, model TEXT,
    input INTEGER, output INTEGER, thinking INTEGER, cache_read INTEGER, cache_write INTEGER, sidechain INTEGER, cost REAL);
  CREATE INDEX IF NOT EXISTS usage_calls_at ON usage_calls(at);
  CREATE TABLE IF NOT EXISTS usage_turns (
    prompt_id TEXT PRIMARY KEY, session_id TEXT, at TEXT, text TEXT, skill TEXT, skills_used TEXT, tools INTEGER, kind TEXT);
  DELETE FROM usage_calls WHERE model = '<synthetic>';
`);

const PROJECTS = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
const fileCache = new Map(); // claude session id -> transcript path

function transcriptOf(claudeSessionId) {
  if (!/^[\w-]{8,80}$/.test(claudeSessionId || '')) return null;
  const known = fileCache.get(claudeSessionId);
  if (known && fs.existsSync(known)) return known;
  let dirs = [];
  try { dirs = fs.readdirSync(PROJECTS, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return null; }
  for (const d of dirs) {
    const f = path.join(PROJECTS, d.name, `${claudeSessionId}.jsonl`);
    if (fs.existsSync(f)) { fileCache.set(claudeSessionId, f); return f; }
  }
  return null;
}

// Relative token weights (output and cache writes cost more, cache reads much less), only used to split
// a session's exact cost across its calls.
const weight = (c) => c.input + 5 * c.output + 0.1 * c.cache_read + 1.6 * c.cache_write;
const family = (model) => (String(model).match(/opus|sonnet|haiku|fable/i)?.[0] || 'other').toLowerCase();

const upCall = db.prepare(`INSERT INTO usage_calls (msg_id, session_id, claude_session_id, prompt_id, at, model, input, output, thinking, cache_read, cache_write, sidechain, cost)
  VALUES (:msg_id, :session_id, :claude_session_id, :prompt_id, :at, :model, :input, :output, :thinking, :cache_read, :cache_write, :sidechain, :cost)
  ON CONFLICT(msg_id) DO UPDATE SET session_id=excluded.session_id, prompt_id=excluded.prompt_id, input=excluded.input, output=excluded.output,
    thinking=excluded.thinking, cache_read=excluded.cache_read, cache_write=excluded.cache_write, cost=excluded.cost`);
const upTurn = db.prepare(`INSERT INTO usage_turns (prompt_id, session_id, at, text, skill, skills_used, tools, kind)
  VALUES (:prompt_id, :session_id, :at, :text, :skill, :skills_used, :tools, :kind)
  ON CONFLICT(prompt_id) DO UPDATE SET session_id=excluded.session_id, text=excluded.text, skill=excluded.skill, skills_used=excluded.skills_used, tools=excluded.tools, kind=excluded.kind`);

const textOf = (content) => (typeof content === 'string' ? content : (content || []).filter((b) => b.type === 'text').map((b) => b.text).join(' '));

/** Read one transcript into usage_calls / usage_turns for a mon.ai chat. */
export function ingestTranscript(claudeSessionId, sessionId, { kind = 'chat', label = null } = {}) {
  const file = transcriptOf(claudeSessionId);
  if (!file) return 0;
  let lines;
  try { lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return 0; }
  const promptOf = new Map(); // entry uuid -> the user prompt (turn) it belongs to
  const calls = new Map();
  const turns = new Map();
  let costState = null;
  for (const e of lines) {
    if (e.type === 'cost-state') { costState = e; continue; }
    const pid = e.promptId || promptOf.get(e.parentUuid) || null;
    if (e.uuid) promptOf.set(e.uuid, pid);
    if (e.type === 'user' && e.promptId && !turns.has(e.promptId)) {
      const raw = textOf(e.message?.content);
      // a /skill run is stored as command markup: show it as "/name args"
      const cmd = raw.match(/<command-name>\s*\/?(?:mon:)?([^<]+?)\s*<\/command-name>/)?.[1];
      const args = raw.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1] || '';
      const text = (cmd ? `/${cmd} ${args}` : raw).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      if (text) {
        const slash = cmd || text.match(/^\/(?:mon:)?([a-z0-9][a-z0-9-]*)/)?.[1] || null;
        turns.set(e.promptId, { prompt_id: e.promptId, session_id: sessionId, at: e.timestamp, text: (label || text).slice(0, 200), skill: slash, used: new Set(), tools: 0, kind });
      }
    }
    if (e.type === 'assistant' && e.message?.usage && e.message.id && e.message.model !== '<synthetic>') {
      const u = e.message.usage;
      const prev = calls.get(e.message.id);
      const c = {
        msg_id: e.message.id, session_id: sessionId, claude_session_id: claudeSessionId, prompt_id: pid, at: prev?.at || e.timestamp,
        model: e.message.model || prev?.model || 'unknown',
        input: Math.max(prev?.input || 0, u.input_tokens || 0), output: Math.max(prev?.output || 0, u.output_tokens || 0),
        thinking: Math.max(prev?.thinking || 0, u.output_tokens_details?.thinking_tokens || 0),
        cache_read: Math.max(prev?.cache_read || 0, u.cache_read_input_tokens || 0), cache_write: Math.max(prev?.cache_write || 0, u.cache_creation_input_tokens || 0),
        sidechain: e.isSidechain ? 1 : 0, cost: null,
      };
      calls.set(e.message.id, c);
      const t = pid && turns.get(pid);
      if (t) for (const b of e.message.content || []) {
        if (b.type !== 'tool_use') continue;
        t.tools++;
        if (b.name === 'Skill') { const sk = String(b.input?.skill || b.input?.command || '').replace(/^\/?(mon:)?/, ''); if (sk) t.used.add(sk); }
      }
    }
  }
  // the session's exact cost per model, split over its calls by token weight
  const byModel = costState?.modelUsage || {};
  for (const [model, mu] of Object.entries(byModel)) {
    const list = [...calls.values()].filter((c) => c.model === model);
    const total = list.reduce((n, c) => n + weight(c), 0);
    if (total > 0 && Number.isFinite(mu.costUSD)) for (const c of list) c.cost = (mu.costUSD * weight(c)) / total;
  }
  for (const c of calls.values()) upCall.run(c);
  for (const t of turns.values()) {
    const used = [...t.used];
    upTurn.run({ prompt_id: t.prompt_id, session_id: t.session_id, at: t.at, text: t.text, skill: t.skill || used[0] || null, skills_used: JSON.stringify(used), tools: t.tools, kind: t.kind });
  }
  return calls.size;
}

/** All mon.ai chats (start-up backfill, and after each reply for that chat). */
export function ingestSession(sessionId) {
  const s = db.prepare('SELECT id, claude_session_id FROM sessions WHERE id = ?').get(sessionId);
  if (s?.claude_session_id) ingestTranscript(s.claude_session_id, s.id);
  bus.emit('event', { type: 'usage:updated', data: { sessionId } });
}
export function ingestAll() {
  let n = 0;
  for (const s of db.prepare('SELECT id, claude_session_id FROM sessions WHERE claude_session_id IS NOT NULL').all()) n += ingestTranscript(s.claude_session_id, s.id);
  return n;
}

// ---------------- Analysis ----------------
const sum = (rows, f) => rows.reduce((n, r) => n + (Number(r[f]) || 0), 0);

  const totals = (rows) => {
    const input = sum(rows, 'input'), output = sum(rows, 'output'), cacheRead = sum(rows, 'cache_read'), cacheWrite = sum(rows, 'cache_write');
    const turns = new Set(rows.map((r) => r.prompt_id).filter(Boolean)).size;
    return {
      calls: rows.length, turns, input, output, thinking: sum(rows, 'thinking'), cacheRead, cacheWrite,
      tokens: input + output + cacheRead + cacheWrite,
      cost: rows.some((r) => r.cost != null) ? sum(rows, 'cost') : null,
      cacheHit: input + cacheRead + cacheWrite ? cacheRead / (input + cacheRead + cacheWrite) : null,
      perTurn: turns ? (input + output + cacheRead + cacheWrite) / turns : null,
      costPerTurn: turns && rows.some((r) => r.cost != null) ? sum(rows, 'cost') / turns : null,
      models: [...new Set(rows.map((r) => family(r.model)))],
    };
  };
  const groupRows = (list, keyOf, labelOf = (k) => k, keep = false) => {
    const m = new Map();
    for (const r of list) { const k = keyOf(r); if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
    return [...m].map(([k, rows]) => ({ key: k, label: labelOf(k, rows), ...totals(rows), ...(keep ? { rows } : {}) })).sort((a, b) => (b.cost ?? b.tokens) - (a.cost ?? a.tokens));
  };
  const skillLabel = (k) => (k ? `/${k}` : 'No skill');

/** One chat: what its runs used (the "This chat" card in the chat's side panel). */
export function chatSummary(sessionId) {
  const calls = db.prepare(`SELECT c.*, t.skill, t.text, t.tools AS turn_tools, t.skills_used FROM usage_calls c
    LEFT JOIN usage_turns t ON t.prompt_id = c.prompt_id WHERE c.session_id = ? ORDER BY c.at`).all(sessionId);
  const slim = ({ rows: _r, ...x }) => x;
  const turns = groupRows(calls, (r) => r.prompt_id || r.msg_id, (k, rows) => rows[0].text || '(no prompt)', true).map(({ rows, ...t }) => ({
    ...t, at: rows[0].at, skill: rows[0].skill, tools: rows[0].turn_tools || 0,
    skillsUsed: (() => { try { return JSON.parse(rows[0].skills_used || '[]'); } catch { return []; } })(),
  }));
  return {
    totals: totals(calls),
    byModel: groupRows(calls, (r) => r.model).map(slim),
    bySkill: groupRows(calls, (r) => r.skill || '', skillLabel).map(slim),
    lastRuns: [...turns].sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 5),
  };
}

/**
 * Usage for a time range. Read from local transcripts and the database only: no model call, no tokens.
 * `from` / `to` (ISO times) pick any range (today, this work week, custom dates); otherwise the last `days` (0 = all).
 */
export function analysis({ days = 7, from = null, to = null } = {}) {
  const iso = (v) => (v && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);
  from = iso(from); to = iso(to);
  const since = from || (days > 0 ? new Date(Date.now() - days * 864e5).toISOString() : '0000');
  const until = to || '9999';
  const calls = db.prepare(`
    SELECT c.*, t.skill, t.text, t.kind, s.org, s.ticket_id, s.title AS chat_title, s.id AS chat_id
    FROM usage_calls c LEFT JOIN usage_turns t ON t.prompt_id = c.prompt_id LEFT JOIN sessions s ON s.id = c.session_id
    WHERE c.at >= ? AND c.at < ?`).all(since, until);
  const group = (keyOf, labelOf) => groupRows(calls, keyOf, labelOf);
  // per day x model family (local days)
  const dayKey = (iso) => { const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const byDay = new Map();
  for (const r of calls) {
    const k = dayKey(r.at);
    if (!byDay.has(k)) byDay.set(k, {});
    const fam = family(r.model);
    const d = byDay.get(k);
    d[fam] ??= { cost: 0, tokens: 0, output: 0 };
    d[fam].cost += r.cost || 0; d[fam].tokens += r.input + r.output + r.cache_read + r.cache_write; d[fam].output += r.output;
  }
  const dayList = [];
  // one bar per local day, from the start of the range to its end (today when open-ended), at most 90
  const end = Math.min(Date.now(), to ? Date.parse(to) - 1 : Date.now());
  const start = since !== '0000' ? Date.parse(since) : Date.parse(calls.reduce((m, r) => (r.at < m ? r.at : m), new Date().toISOString()));
  const first = new Date(start); first.setHours(0, 0, 0, 0);
  const n = Math.max(1, Math.round((new Date(end).setHours(0, 0, 0, 0) - first.getTime()) / 864e5) + 1);
  for (let i = Math.min(n, 90) - 1; i >= 0; i--) { const d = new Date(end); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - i); const k = dayKey(d.toISOString()); dayList.push({ day: k, models: byDay.get(k) || {} }); }

  const turnRows = group((r) => r.prompt_id || r.msg_id).map((t) => {
    const r = calls.find((c) => (c.prompt_id || c.msg_id) === t.key);
    return { ...t, at: r.at, text: r.text || '(no prompt)', skill: r.skill, chatId: r.chat_id, chatTitle: r.chat_title, org: r.org, ticketId: r.ticket_id };
  });
  const bySkill = group((r) => r.skill || '', skillLabel);
  const byModel = group((r) => r.model);
  const byClient = group((r) => (r.org && r.org !== 'All' ? r.org : ''), (k) => k || 'General');
  // every chat, with what it used: models, skills and its costliest messages (expand a row on the page)
  const slim = ({ rows: _r, models: _m, ...x }) => x;
  const byChat = groupRows(calls, (r) => r.chat_id || '', (k, rows) => rows[0].chat_title || '(deleted chat)', true).map(({ rows, ...c }) => ({
    ...c, chatId: c.key, org: rows[0].org && rows[0].org !== 'All' ? rows[0].org : null, ticketId: rows[0].ticket_id || null,
    byModel: groupRows(rows, (r) => r.model).map(slim),
    bySkill: groupRows(rows, (r) => r.skill || '', skillLabel).map(slim),
    messages: turnRows.filter((t) => t.chatId === c.key).slice(0, 8).map(({ key, text, skill, calls: n, tokens, cost, at }) => ({ key, text, skill, calls: n, tokens, cost, at })),
  }));

  return {
    days, since, until: to, totals: totals(calls), byDay: dayList,
    bySkill, byModel, byClient, byChat,
    topTurns: turnRows.slice(0, 12),
    hints: hints({ calls, bySkill, byChat, turnRows }),
  };
}

/** Plain suggestions to use less of the plan. */
function hints({ calls, bySkill, byChat, turnRows }) {
  const out = [];
  const tot = calls.reduce((n, r) => n + (r.cost || 0), 0);
  for (const s of bySkill) {
    if (!s.key || s.turns < 2) continue;
    const opus = calls.filter((r) => (r.skill || '') === s.key && family(r.model) === 'opus');
    if (opus.length && s.output / s.turns < 1500 && s.tools / Math.max(1, s.turns) < 6) {
      out.push({ level: 'save', text: `${s.label} runs on Opus but its answers are short (${Math.round(s.output / s.turns)} output tokens per run). Try Sonnet for it: set Model in the skill editor.`, link: `#/skills/${encodeURIComponent(s.key)}` });
    }
  }
  for (const c of byChat) {
    if (c.turns >= 4 && c.perTurn > 150_000) out.push({ level: 'save', text: `"${c.label}" is long: each message re-reads about ${Math.round(c.perTurn / 1000)}k tokens of history. Start a new chat for a new question.`, link: c.chatId ? `#/chat/${c.chatId}` : null });
  }
  const write = calls.reduce((n, r) => n + r.cache_write, 0), read = calls.reduce((n, r) => n + r.cache_read, 0);
  if (calls.length > 20 && write > read * 0.5) out.push({ level: 'info', text: `Lots of fresh context (cache writes ${Math.round(write / 1000)}k vs reads ${Math.round(read / 1000)}k): many new chats or long gaps between messages. Continuing a chat within the hour reuses its cache.` });
  const big = turnRows.filter((t) => t.cost && tot && t.cost / tot > 0.15);
  for (const t of big.slice(0, 2)) out.push({ level: 'info', text: `One message used ${Math.round((t.cost / tot) * 100)}% of this period: "${t.text.slice(0, 80)}". ${t.calls > 15 ? `It took ${t.calls} model calls; a skill with clear steps keeps runs like this shorter.` : ''}`, link: t.chatId ? `#/chat/${t.chatId}` : null });
  const unknown = calls.filter((r) => r.cost == null).length;
  if (unknown) out.push({ level: 'info', text: `${unknown} call${unknown > 1 ? 's have' : ' has'} no cost yet (the chat was still answering when read). Refresh in a moment.` });
  return out;
}
