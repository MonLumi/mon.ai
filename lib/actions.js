// Running plans (stage 2): Azure CLI plan steps, one at a time, each only after the user clicks Run.
//
// The assistant never runs anything: it only proposes a plan (propose_plan), saved with its chat message.
// The app server runs a step when you click Run on that step, reading the step from the saved
// message (never from the browser), so a plan can't be changed between review and run.
// Every event (run, done, failed, skipped, marked as run by you) goes to the audit log
// data/logs/actions.jsonl and to the plan_runs / plan_steps tables (History page, past_runs).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { db, bus } from './db.js';
import { config } from './config.js';
import * as azure from './azure.js';

const DATA_DIR = path.resolve(process.env.MON_DATA_DIR || path.join(import.meta.dirname, '..', 'data'));
export const AUDIT_FILE = path.join(DATA_DIR, 'logs', 'actions.jsonl');

db.exec(`
  CREATE TABLE IF NOT EXISTS plan_runs (
    plan_id TEXT PRIMARY KEY, session_id TEXT, org TEXT, title TEXT, ticket_id INTEGER, plan TEXT,
    temp_rule TEXT, temp_ip TEXT, temp_open INTEGER DEFAULT 0, temp_target TEXT, temp_opened_at TEXT,
    outcome TEXT, lessons TEXT, created_at TEXT, updated_at TEXT
  );
  CREATE TABLE IF NOT EXISTS plan_steps (
    plan_id TEXT, step INTEGER, status TEXT, command TEXT, output TEXT, error TEXT, hint TEXT,
    attempts INTEGER DEFAULT 0, started_at TEXT, finished_at TEXT, PRIMARY KEY (plan_id, step)
  );
`);

const now = () => new Date().toISOString();
const PLAN_ID = /^[\w-]{6,80}$/;
const DONE = new Set(['done', 'manual_done', 'skipped']);
const RUNNABLE_ACTIONS = new Set(['azure_cli']);
// Over OpenVPN every az call is slow: long limits, and a slow step is shown as running, not failed.
const STEP_TIMEOUT_MS = 15 * 60_000;
const SIGNIN_WAIT_MS = 10 * 60_000;
const VERIFY_MAX_S = 900;

// ---------- audit log ----------
function audit(event, data) {
  try {
    fs.mkdirSync(path.dirname(AUDIT_FILE), { recursive: true });
    fs.appendFileSync(AUDIT_FILE, `${JSON.stringify({ at: now(), event, user: os.userInfo().username, ...data })}\n`);
  } catch (e) { console.error('[actions] audit log:', e.message); }
}

// ---------- the plan, as saved with its chat message ----------
/** The plan proposed in a chat message (tool_use id = plan id), with the chat it belongs to. */
function savedPlan(planId) {
  if (!PLAN_ID.test(planId || '')) throw new Error('Not a plan id');
  const rows = db.prepare("SELECT session_id, content FROM messages WHERE role = 'assistant' AND content LIKE ? ORDER BY id DESC LIMIT 5").all(`%${planId}%`);
  for (const r of rows) {
    const plan = JSON.parse(r.content)?.plan;
    if (plan?.id === planId) return { plan, sessionId: r.session_id };
  }
  throw new Error('Plan not found (was its chat deleted?)');
}

function runRow(planId) {
  let run = db.prepare('SELECT * FROM plan_runs WHERE plan_id = ?').get(planId);
  if (!run) {
    const { plan, sessionId } = savedPlan(planId);
    db.prepare('INSERT INTO plan_runs (plan_id, session_id, org, title, ticket_id, plan, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(planId, sessionId, plan.org || null, plan.title || '', plan.ticketId || null, JSON.stringify(plan), now(), now());
    audit('plan_opened', { planId, org: plan.org || null, title: plan.title, steps: plan.steps.length });
    run = db.prepare('SELECT * FROM plan_runs WHERE plan_id = ?').get(planId);
  }
  return { ...run, plan: JSON.parse(run.plan) };
}
const stepRows = (planId) => new Map(db.prepare('SELECT * FROM plan_steps WHERE plan_id = ?').all(planId).map((r) => [r.step, r]));
function setStep(planId, step, fields) {
  const cur = db.prepare('SELECT * FROM plan_steps WHERE plan_id = ? AND step = ?').get(planId, step);
  const row = { status: 'pending', command: null, output: null, error: null, hint: null, attempts: 0, started_at: null, finished_at: null, ...cur, ...fields };
  db.prepare(`INSERT INTO plan_steps (plan_id, step, status, command, output, error, hint, attempts, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(plan_id, step) DO UPDATE SET status = excluded.status, command = excluded.command, output = excluded.output, error = excluded.error,
      hint = excluded.hint, attempts = excluded.attempts, started_at = excluded.started_at, finished_at = excluded.finished_at`)
    .run(planId, step, row.status, row.command, row.output, row.error, row.hint, row.attempts, row.started_at, row.finished_at);
  db.prepare('UPDATE plan_runs SET updated_at = ? WHERE plan_id = ?').run(now(), planId);
  finishIfComplete(planId);
  bus.emit('event', { type: 'plan:update', data: { planId, step } });
}

// ---------- temporary IP access (open / close pair) ----------
/** Neutral name for a temporary rule: never mentions AI (not every client is happy with that). */
function tempRuleName() {
  const acct = config.get('azure').defaultAccount || os.userInfo().username || 'user';
  const who = String(acct).split('@')[0].toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 12) || 'user';
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `dw-temp-${who}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}
async function publicIp() {
  for (const url of ['https://api.ipify.org', 'https://checkip.amazonaws.com']) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      const ip = (await r.text()).trim();
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return ip;
    } catch { /* try the next one */ }
  }
  throw new Error('Could not find your public IP address');
}
const tempKind = (s) => (['open', 'close'].includes(s?.params?.tempAccess) ? s.params.tempAccess : null);

// ---------- commands ----------
// Write commands mon.ai will run: these command groups only, and never the words below.
const WRITE_GROUPS = new Set(['webapp', 'functionapp', 'appservice', 'afd', 'network', 'sql', 'storage', 'keyvault', 'monitor', 'redis', 'cdn', 'tag', 'resource', 'apim', 'containerapp', 'staticwebapp', 'cosmosdb', 'search', 'servicebus', 'eventhubs', 'signalr', 'vm', 'vmss', 'group', 'lock']);
const NEVER = /^(get-access-token|login|logout|account|ad|role|rest|ssh|run-command|invoke|invoke-action|exec|keys?|secrets?|credentials?|password|connection-string|generate-sas|list-keys|list-secrets|list-credentials|list-publishing-credentials|list-publishing-profiles|list-connection-strings|purge|extension|upload|upload-batch|download|download-batch|blob|file|queue|table|share|directory|config-zip|deployment-source|source|create-remote-connection|tunnel|connect|identity|assign|grant|revoke|policy-assignment)$/i;
// Deletes: only rules (IP / firewall / WAF), e.g. closing temporary access. Anything else you delete yourself.
const RULE_WORDS = /^(firewall-rule|access-restriction|network-rule|rule|custom-rule|match-condition|ip-rule|vnet-rule|exclusion|override)$/i;

/** Command words = everything before the first flag. */
const cmdWords = (args) => { const i = args.findIndex((a) => a.startsWith('-')); return i === -1 ? args : args.slice(0, i); };

export function checkCommand(args) {
  if (!Array.isArray(args) || !args.length || !args.every((a) => typeof a === 'string')) throw new Error('The step has no az arguments (params.args)');
  if (args[0] === 'az') args = args.slice(1);
  const words = cmdWords(args);
  if (!words.length) throw new Error('Empty az command');
  if (args.some((a) => a.startsWith('@'))) throw new Error('Arguments read from files (@file) are not run by mon.ai: run this step yourself');
  if (args.some((a) => /^--(template-file|template-uri)$/.test(a))) throw new Error('Template deployments are not run by mon.ai: run this step yourself');
  let readOnly = true;
  try { azure.assertReadOnly(args); } catch { readOnly = false; }
  if (readOnly) return { args, readOnly };
  const bad = words.find((w) => NEVER.test(w) || /secret|credential|password|(^|-)keys?$/i.test(w));
  if (bad) throw new Error(`"az ${words.join(' ')}" is never run by mon.ai ("${bad}"): run it yourself if it's really needed`);
  if (!WRITE_GROUPS.has(words[0])) throw new Error(`"az ${words[0]}" commands are not run by mon.ai yet: run this step yourself`);
  if (words.some((w) => /^(delete|remove)$/i.test(w)) && !words.some((w) => RULE_WORDS.test(w))) throw new Error(`Deletes are not run by mon.ai ("az ${words.join(' ')}"): run it yourself, then mark the step done`);
  return { args, readOnly };
}

const psArg = (a) => (/^[\w@%+=:,./\\-]+$/.test(a) ? a : `'${a.replace(/'/g, "''")}'`);
/** The step's command, resolved for this run: subscription pinned, placeholders filled when known. */
function resolveArgs(step, run, { ip } = {}) {
  const p = step.params || {};
  let args = (Array.isArray(p.args) ? p.args : []).map(String);
  if (args[0] === 'az') args = args.slice(1);
  args = args.map((a) => a.replaceAll('{tempRuleName}', run.temp_rule || '{tempRuleName}').replaceAll('{myIp}', ip || run.temp_ip || '{myIp}'));
  if (p.subscription && !args.some((a) => /^--subscriptions?(=|$)/.test(a))) args.push(args[0] === 'graph' ? '--subscriptions' : '--subscription', String(p.subscription));
  else if (!p.subscription) args = azure.withSubscription(args, { org: p.org || run.org, env: p.env || 'prod' }).args;
  return args;
}
const commandText = (args) => `az ${args.map(psArg).join(' ')}`;

// ---------- VPN (Settings → Clients → VPN required: Dataweavers OpenVPN) ----------
function vpnAdapters() {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "Get-NetAdapter | Where-Object Status -eq 'Up' | ForEach-Object { $_.InterfaceDescription }"],
      { windowsHide: true, timeout: 20_000 }, (err, out) => resolve(err ? null : String(out).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)));
  });
}
async function vpnState(org) {
  let p = null;
  try { p = org ? azure.profile(org) : null; } catch { /* no Azure profile */ }
  if (!p?.vpn?.required) return { required: false };
  const up = await vpnAdapters();
  if (!up) return { required: true, name: 'Dataweavers OpenVPN', connected: null };
  return { required: true, name: 'Dataweavers OpenVPN', connected: up.some((d) => /openvpn|tap-windows|wintun|data channel offload/i.test(d)) };
}

// ---------- state for the plan card ----------
/** Which steps can be run now: the next unfinished one, and a "close temporary access" step as soon as its "open" step is done. */
function gate(plan, rows) {
  const st = (i) => rows.get(i)?.status || 'pending';
  const next = plan.steps.findIndex((_, i) => !DONE.has(st(i)));
  const openDone = plan.steps.some((s, i) => tempKind(s) === 'open' && st(i) === 'done');
  return plan.steps.map((s, i) => {
    if (DONE.has(st(i)) || st(i) === 'running' || st(i) === 'waiting_signin') return false;
    if (i === next) return true;
    return tempKind(s) === 'close' && openDone;
  });
}

export function planState(planId) {
  const run = runRow(planId);
  const rows = stepRows(planId);
  const can = gate(run.plan, rows);
  return {
    planId, org: run.org, title: run.title, outcome: run.outcome,
    tempRule: run.temp_rule, tempIp: run.temp_ip, tempOpen: !!run.temp_open,
    auditFile: AUDIT_FILE,
    steps: run.plan.steps.map((s, i) => {
      const r = rows.get(i) || {};
      let command = r.command || null;
      let blocked = null;
      if (s.action === 'azure_cli') {
        try { command ??= commandText(resolveArgs(s, run)); checkCommand(resolveArgs(s, run)); } catch (e) { blocked = e.message; }
      }
      return {
        step: i, action: s.action, status: r.status || 'pending', canRun: can[i] && RUNNABLE_ACTIONS.has(s.action) && !blocked, canMark: can[i],
        runnable: RUNNABLE_ACTIONS.has(s.action), blocked, command, output: r.output, error: r.error, hint: r.hint,
        attempts: r.attempts || 0, startedAt: r.started_at, finishedAt: r.finished_at, temp: tempKind(s),
      };
    }),
  };
}

// ---------- running a step ----------
const active = new Map(); // `${planId}:${step}` → { cancelled }

/**
 * Run one step (after the user clicked Run and confirmed). Returns at once; progress arrives as
 * plan:update events. A missing sign-in opens the sign-in terminal and waits for it.
 */
export async function runStep(planId, step, { vpnConfirmed = false } = {}) {
  const run = runRow(planId);
  const s = run.plan.steps[step];
  if (!s) throw new Error('No such step');
  if (!RUNNABLE_ACTIONS.has(s.action)) throw new Error('mon.ai only runs Azure CLI steps: do this one yourself, then mark it done');
  if (!gate(run.plan, stepRows(planId))[step]) throw new Error('Finish the earlier steps first (run, mark done or skip them)');
  const key = `${planId}:${step}`;
  if (active.has(key)) throw new Error('This step is already running');
  const org = s.params?.org || run.org;
  const env = s.params?.env === 'nonprod' ? 'nonprod' : 'prod';
  checkCommand(resolveArgs(s, run)); // refuse before doing anything

  const vpn = await vpnState(org);
  if (vpn.required && vpn.connected !== true && !vpnConfirmed) return { needVpn: true, vpn };

  const job = { cancelled: false };
  active.set(key, job);
  const prev = stepRows(planId).get(step);
  setStep(planId, step, { status: 'running', error: null, hint: null, output: null, started_at: now(), finished_at: null, attempts: (prev?.attempts || 0) + 1 });
  execute(planId, step, s, org, env, job).finally(() => active.delete(key));
  return { started: true, vpn };
}

export function cancelStep(planId, step) {
  const job = active.get(`${planId}:${step}`);
  if (job) job.cancelled = true;
  return { cancelled: !!job };
}

async function waitForSignIn(planId, step, org, env, job) {
  if (!org) return; // no client: run as the CLI is signed in now
  const first = await azure.checkSignIn(org, 'cli', { timeoutMs: 120_000 }).catch((e) => ({ ok: false, error: e.message }));
  if (first.ok) return;
  setStep(planId, step, { status: 'waiting_signin', hint: 'signin', error: first.error || 'Not signed in' });
  audit('signin_wait', { planId, step, org, env });
  try { azure.login(org, env, 'cli'); } catch (e) { throw new Error(`Could not open the sign-in terminal: ${e.message}`); }
  const until = Date.now() + SIGNIN_WAIT_MS;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 8_000));
    if (job.cancelled) throw Object.assign(new Error('Cancelled while waiting for the sign-in'), { cancelled: true });
    const r = await azure.checkSignIn(org, 'cli', { timeoutMs: 120_000 }).catch(() => ({ ok: false }));
    if (r.ok) { setStep(planId, step, { status: 'running', hint: null, error: null }); return; }
  }
  throw Object.assign(new Error('No Azure sign-in after 10 minutes'), { hint: 'signin' });
}

const PIM_ERR = /AuthorizationFailed|does not have authorization|LinkedAuthorizationFailed|RoleAssignmentNotFound|not authorized to perform/i;
const shortOut = (r) => { const t = typeof r === 'string' ? r : JSON.stringify(r, null, 2); return t && t.length > 6000 ? `${t.slice(0, 6000)}\n… (cut)` : t; };
/** A verify step's value as text, to compare with params.expect. */
const valueText = (r) => (typeof r === 'string' ? r : JSON.stringify(r)).trim().replace(/^"|"$/g, '');

async function execute(planId, step, s, org, env, job) {
  const run = runRow(planId);
  let args = [];
  try {
    await waitForSignIn(planId, step, org, env, job);
    let ip = null;
    const tk = tempKind(s);
    if (tk === 'open' || (s.params.args || []).some((a) => String(a).includes('{myIp}'))) {
      ip = run.temp_ip && tk !== 'open' ? run.temp_ip : await publicIp();
    }
    if (tk === 'open' || (s.params.args || []).some((a) => String(a).includes('{tempRuleName}'))) {
      if (!run.temp_rule) db.prepare('UPDATE plan_runs SET temp_rule = ? WHERE plan_id = ?').run(tempRuleName(), planId);
    }
    if (ip && tk === 'open') db.prepare('UPDATE plan_runs SET temp_ip = ? WHERE plan_id = ?').run(ip, planId);
    const fresh = runRow(planId);
    args = resolveArgs(s, fresh, { ip });
    if (args.some((a) => /\{(myIp|tempRuleName)\}/.test(a))) throw new Error('The step still has a {placeholder} mon.ai could not fill');
    const { readOnly } = checkCommand(args);
    const command = commandText(args);
    setStep(planId, step, { command });
    audit('step_started', { planId, step, org, env, command, readOnly });

    let result;
    const expect = s.params?.expect != null ? String(s.params.expect).trim() : null;
    if (readOnly && expect != null) {
      // verify: poll until the value matches (e.g. state = Running after a restart)
      const until = Date.now() + Math.min(Number(s.params.waitSeconds) || 300, VERIFY_MAX_S) * 1000;
      for (;;) {
        result = await azure.az([...args, '-o', 'json'], { timeoutMs: 180_000 });
        if (valueText(result).toLowerCase() === expect.toLowerCase()) break;
        if (job.cancelled) throw Object.assign(new Error('Cancelled'), { cancelled: true });
        if (Date.now() > until) throw new Error(`Still "${valueText(result).slice(0, 200)}", expected "${expect}"`);
        setStep(planId, step, { output: `Now: ${valueText(result).slice(0, 300)} · waiting for "${expect}"…` });
        await new Promise((r) => setTimeout(r, 10_000));
      }
    } else {
      result = await azure.az([...args, '-o', 'json'], { timeoutMs: STEP_TIMEOUT_MS });
    }
    const output = shortOut(result) || '(no output)';
    // temporary access flags first: the plan can only finish once the rule is closed
    if (tk === 'open') db.prepare('UPDATE plan_runs SET temp_open = 1, temp_target = ?, temp_opened_at = ? WHERE plan_id = ?').run(s.target || s.params.resource || '', now(), planId);
    if (tk === 'close') db.prepare('UPDATE plan_runs SET temp_open = 0 WHERE plan_id = ?').run(planId);
    audit('step_done', { planId, step, org, command: commandText(args), output: output.slice(0, 2000) });
    setStep(planId, step, { status: 'done', output, finished_at: now(), error: null, hint: null });
  } catch (e) {
    const msg = String(e.message || e);
    const hint = e.cancelled ? 'cancelled' : e.hint || (PIM_ERR.test(msg) ? 'pim' : /timed out/i.test(msg) ? 'timeout' : azure.isAuthError(msg) ? 'signin' : null);
    setStep(planId, step, { status: e.cancelled ? 'pending' : 'failed', error: msg.slice(0, 3000), hint, finished_at: now() });
    audit(e.cancelled ? 'step_cancelled' : 'step_failed', { planId, step, org, command: args.length ? commandText(args) : null, error: msg.slice(0, 1000), hint });
  }
}

/** Mark a step as run by you (outside mon.ai), or skip it. */
export function markStep(planId, step, status, note = '') {
  if (!['manual_done', 'skipped'].includes(status)) throw new Error('status must be manual_done or skipped');
  const run = runRow(planId);
  const s = run.plan.steps[step];
  if (!s) throw new Error('No such step');
  if (active.has(`${planId}:${step}`)) throw new Error('The step is running: cancel it first');
  const rows = stepRows(planId);
  if (!gate(run.plan, rows)[step] && rows.get(step)?.status !== 'failed') throw new Error('Finish the earlier steps first');
  if (status === 'skipped' && tempKind(s) === 'close' && run.temp_open) throw new Error('The temporary rule is still open: close it, or mark this step done if you removed it yourself');
  if (tempKind(s) === 'close' && status === 'manual_done') db.prepare('UPDATE plan_runs SET temp_open = 0 WHERE plan_id = ?').run(planId);
  audit(status === 'skipped' ? 'step_skipped' : 'step_marked_done', { planId, step, org: run.org, summary: s.summary, note: note || undefined });
  setStep(planId, step, { status, finished_at: now(), output: note ? String(note).slice(0, 2000) : null });
  return planState(planId);
}

/** Once every step is finished, record the outcome and what was learned (past_runs reads it). */
function finishIfComplete(planId) {
  const run = db.prepare('SELECT * FROM plan_runs WHERE plan_id = ?').get(planId);
  if (!run || run.outcome) return;
  const plan = JSON.parse(run.plan);
  const rows = stepRows(planId);
  if (!plan.steps.every((_, i) => DONE.has(rows.get(i)?.status))) return;
  if (run.temp_open) return; // never "finished" while a temporary rule is open
  const statuses = plan.steps.map((_, i) => rows.get(i).status);
  const outcome = statuses.every((x) => x === 'done' || x === 'manual_done') ? 'done' : statuses.some((x) => x === 'done' || x === 'manual_done') ? 'partial' : 'skipped';
  const lessons = plan.steps.flatMap((s, i) => {
    const r = rows.get(i);
    const out = [];
    if (r.attempts > 1) out.push(`step ${i + 1} (${s.summary}) needed ${r.attempts} tries${r.hint ? ` (${r.hint})` : ''}`);
    if (r.status === 'manual_done') out.push(`step ${i + 1} (${s.summary}) was done by hand`);
    if (r.status === 'skipped') out.push(`step ${i + 1} (${s.summary}) was skipped`);
    return out;
  });
  db.prepare('UPDATE plan_runs SET outcome = ?, lessons = ? WHERE plan_id = ?').run(outcome, JSON.stringify(lessons), planId);
  audit('plan_finished', { planId, org: run.org, title: run.title, outcome, lessons });
}

// ---------- History page / reminders ----------
export function history({ limit = 100 } = {}) {
  const runs = db.prepare('SELECT * FROM plan_runs ORDER BY updated_at DESC LIMIT ?').all(Math.min(Number(limit) || 100, 500));
  return {
    auditFile: AUDIT_FILE,
    openTemp: openTemp(),
    runs: runs.map((r) => {
      const plan = JSON.parse(r.plan);
      const rows = stepRows(r.plan_id);
      return {
        planId: r.plan_id, sessionId: r.session_id, org: r.org, title: r.title, ticketId: r.ticket_id, outcome: r.outcome,
        createdAt: r.created_at, updatedAt: r.updated_at, tempOpen: !!r.temp_open, tempRule: r.temp_rule,
        steps: plan.steps.map((s, i) => ({ summary: s.summary, action: s.action, status: rows.get(i)?.status || 'pending', command: rows.get(i)?.command || null, error: rows.get(i)?.error || null, at: rows.get(i)?.finished_at || rows.get(i)?.started_at || null })),
      };
    }),
  };
}
export const openTemp = () => db.prepare('SELECT plan_id, session_id, org, title, temp_rule, temp_ip, temp_target, temp_opened_at FROM plan_runs WHERE temp_open = 1 ORDER BY temp_opened_at').all()
  .map((r) => ({ planId: r.plan_id, sessionId: r.session_id, org: r.org, title: r.title, rule: r.temp_rule, ip: r.temp_ip, target: r.temp_target, openedAt: r.temp_opened_at }));

// ---------- past_runs (the assistant's memory of earlier runs) ----------
/** Earlier plans that ran, ranked by shared words (any client): what was run, how it went, lessons. */
export function searchPastRuns(q, { limit = 5 } = {}) {
  const words = [...new Set(String(q || '').toLowerCase().split(/[^a-z0-9.\-_]+/).filter((w) => w.length > 2))].slice(0, 12);
  if (!words.length) return [];
  const rows = db.prepare("SELECT * FROM plan_runs WHERE EXISTS (SELECT 1 FROM plan_steps s WHERE s.plan_id = plan_runs.plan_id AND s.status IN ('done','manual_done','failed')) ORDER BY updated_at DESC LIMIT 500").all();
  return rows.map((r) => {
    const plan = JSON.parse(r.plan);
    const hay = `${r.title} ${plan.goal || ''} ${r.org || ''} ${plan.steps.map((s) => `${s.summary} ${(s.params?.args || []).join(' ')}`).join(' ')}`.toLowerCase();
    const matched = words.filter((w) => hay.includes(w));
    return { r, plan, matched };
  }).filter((x) => x.matched.length >= Math.min(2, words.length)).sort((a, b) => b.matched.length - a.matched.length).slice(0, limit).map(({ r, plan, matched }) => {
    const steps = stepRows(r.plan_id);
    return {
      title: r.title, client: r.org, date: r.updated_at.slice(0, 10), outcome: r.outcome || 'unfinished', matched: matched.join(', '),
      steps: plan.steps.map((s, i) => ({ summary: s.summary, status: steps.get(i)?.status || 'pending', command: steps.get(i)?.command || undefined, error: steps.get(i)?.error ? steps.get(i).error.split('\n')[0].slice(0, 200) : undefined })),
      lessons: r.lessons ? JSON.parse(r.lessons) : [],
    };
  });
}

// A server restart mid-step: those steps did not finish as far as mon.ai knows.
for (const r of db.prepare("SELECT plan_id, step FROM plan_steps WHERE status IN ('running','waiting_signin')").all()) {
  db.prepare("UPDATE plan_steps SET status = 'failed', error = 'mon.ai restarted while this step was running: check the resource before running it again', hint = 'restart' WHERE plan_id = ? AND step = ?").run(r.plan_id, r.step);
  audit('step_interrupted', { planId: r.plan_id, step: r.step });
}
