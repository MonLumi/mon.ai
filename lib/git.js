// Local git & code access, limited to the configured repo roots.
import fs from 'node:fs';
import path from 'node:path';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { config, orgCode } from './config.js';
import { bus, kv } from './db.js';

const exec = promisify(execFile);
let cache = { scannedAt: null, repos: [] };
const RESCAN_MS = 5 * 60_000; // picks up new commits/pulls for the activity sort

/** The repo whose activity decides an organization's position (e.g. ACU_DW-Pipelines, DW-Pipelines). */
export const isAnchor = (name) => /DW-Pipelines$/i.test(name);

export function roots() {
  return (config.get('workspace').repoRoots || []).map((r) => path.resolve(r)).filter((r) => fs.existsSync(r));
}

/** Throws unless `p` is inside one of the repo roots. Returns the resolved path. */
export function confine(p) {
  const abs = path.resolve(p);
  const ok = roots().some((r) => abs.toLowerCase() === r.toLowerCase() || abs.toLowerCase().startsWith(r.toLowerCase() + path.sep));
  if (!ok) throw new Error(`Path is outside the configured repo roots: ${abs}`);
  return abs;
}

function findRepos(dir, depth, ignore, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  if (entries.some((e) => e.name === '.git')) { out.push(dir); return; }
  if (depth <= 0) return;
  for (const e of entries) {
    if (e.isDirectory() && !e.name.startsWith('.') && !ignore.includes(e.name)) findRepos(path.join(dir, e.name), depth - 1, ignore, out);
  }
}

async function git(cwd, args) {
  const { stdout } = await exec('git', ['-C', cwd, ...args], { maxBuffer: 10 * 1024 * 1024, windowsHide: true });
  return stdout;
}

async function repoInfo(dir, root) {
  const info = { path: dir, name: path.basename(dir), anchor: isAnchor(path.basename(dir)), org: orgCode(path.relative(root, dir).split(path.sep)[0] || path.basename(root)) };
  try {
    const st = await git(dir, ['status', '--porcelain=v2', '--branch']);
    const lines = st.split('\n');
    info.branch = lines.find((l) => l.startsWith('# branch.head'))?.split(' ')[2];
    const ab = lines.find((l) => l.startsWith('# branch.ab'))?.split(' ');
    info.ahead = ab ? Number(ab[2]) : 0;
    info.behind = ab ? Math.abs(Number(ab[3])) : 0;
    info.changes = lines.filter((l) => l && !l.startsWith('#')).length;
    const log = (await git(dir, ['log', '-1', '--format=%h%x09%an%x09%cI%x09%s'])).trim().split('\t');
    info.last = log[0] ? { hash: log[0], author: log[1], date: log[2], subject: log[3] } : null;
    info.remote = (await git(dir, ['remote', 'get-url', 'origin']).catch(() => '')).trim() || null;
    // The reflog only exists locally, so its newest entry is the last thing *you* did here
    // (commit, pull, checkout, merge, rebase...).
    const ref = (await git(dir, ['reflog', '-n1', '--date=iso-strict', '--format=%gd%x09%gs']).catch(() => '')).trim();
    const m = ref.match(/@\{([^}]+)\}\t(.*)$/);
    info.myLast = m ? { at: new Date(m[1]).toISOString(), what: m[2].split(':')[0] } : null;
  } catch (e) { info.error = e.message.split('\n')[0]; }
  return info;
}

export async function scan() {
  const ws = config.get('workspace');
  const found = [];
  for (const root of roots()) {
    const dirs = [];
    findRepos(root, Number(ws.scanDepth) || 3, ws.ignore || [], dirs);
    found.push(...dirs.map((d) => ({ d, root })));
  }
  const repos = [];
  for (let i = 0; i < found.length; i += 8) { // limited concurrency
    repos.push(...await Promise.all(found.slice(i, i + 8).map(({ d, root }) => repoInfo(d, root))));
  }
  cache = { scannedAt: new Date().toISOString(), repos, roots: roots(), missingRoots: (ws.repoRoots || []).filter((r) => !fs.existsSync(r)) };
  bus.emit('event', { type: 'repos:updated', data: { count: repos.length } });
  return cache;
}

/** Repos plus when you last opened each one in VS Code from mon.ai. */
export function list() {
  const opened = kv.get('repos.lastOpened', {});
  return { ...cache, repos: cache.repos.map((r) => ({ ...r, lastOpened: opened[r.path.toLowerCase()] || null })) };
}

export async function log(repo, n = 20) {
  return git(confine(repo), ['log', `-${Math.min(n, 100)}`, '--format=%h %cs %an: %s']);
}
export async function diffStat(repo) {
  return git(confine(repo), ['status', '--short']);
}

// ---------- Open in VS Code ----------
function resolveCode() {
  const custom = config.get('workspace').vscodePath;
  if (custom && fs.existsSync(custom)) return custom;
  const candidates = [
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'Code.exe'),
    'C:/Program Files/Microsoft VS Code/Code.exe',
  ];
  try {
    const cmd = execFileSync('where.exe', ['code.cmd'], { encoding: 'utf8' }).split('\n')[0].trim();
    candidates.unshift(path.resolve(path.dirname(cmd), '..', 'Code.exe'));
  } catch { /* not on PATH */ }
  return candidates.find((c) => fs.existsSync(c)) || null;
}

/** Opens a repo (or any folder/file inside the repo roots) in a VS Code window. */
export function openInVSCode(target) {
  const abs = confine(target);
  const exe = resolveCode();
  if (!exe) throw new Error('VS Code not found. Set "vscodePath" in Settings > Workspace.');
  const child = spawn(exe, [abs], { detached: true, stdio: 'ignore', windowsHide: false });
  child.on('error', (e) => console.error('[vscode]', e.message));
  child.unref();
  const opened = kv.get('repos.lastOpened', {});
  opened[abs.toLowerCase()] = new Date().toISOString();
  kv.set('repos.lastOpened', opened);
  return { opened: abs };
}

config.on('change', (name) => { if (name === 'workspace') scan().catch((e) => console.error('[git]', e.message)); });
setInterval(() => scan().catch((e) => console.error('[git]', e.message)), RESCAN_MS).unref();
