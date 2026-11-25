// Azure Portal + Azure DevOps through the Azure CLI.
// Profiles (tenant, Prod/NonProd subscriptions, Edge profile, account, ADO org) live in config/azure.json.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config, orgCode } from './config.js';
import { bus } from './db.js';

const ADO_RESOURCE = '499b84ac-1321-427f-aa17-267ca6975798';

// Run the CLI's bundled python directly so arguments never go through a shell.
function resolveAz() {
  try {
    const cmd = execFileSync('where.exe', ['az.cmd'], { encoding: 'utf8' }).split(/\r?\n/)[0].trim();
    const py = path.resolve(path.dirname(cmd), '..', 'python.exe');
    if (fs.existsSync(py)) return { file: py, pre: ['-IBm', 'azure.cli'] };
  } catch { /* not on Windows or not installed via MSI */ }
  return { file: 'az', pre: [] };
}
const AZ = resolveAz();

export function profiles() { return config.get('azure').profiles || []; }
export function profile(org) {
  const p = profiles().find((x) => x.org.toLowerCase() === String(org).toLowerCase());
  if (!p) throw new Error(`No Azure profile for "${org}". Add one in Settings > Azure.`);
  return p;
}

function edgeCommand(p) {
  const edge = config.get('azure').edgePath.replace(/\\/g, '/');
  return `"${edge}" --profile-directory="${p.edgeProfile || 'Default'}" %s`;
}

export function az(args, { env = {}, timeoutMs = 90_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(AZ.file, [...AZ.pre, ...args, '--only-show-errors'], {
      env: { ...process.env, AZURE_CORE_NO_COLOR: '1', AZURE_CORE_COLLECT_TELEMETRY: '0', ...env },
      windowsHide: true,
    });
    let out = '', err = '';
    const t = setTimeout(() => { child.kill(); reject(new Error(`az ${args[0]} timed out`)); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(t); reject(e); });
    child.on('close', (code) => {
      clearTimeout(t);
      if (code !== 0) return reject(new Error(err.trim() || `az exited with ${code}`));
      try { resolve(out.trim() ? JSON.parse(out) : null); } catch { resolve(out.trim()); }
    });
  });
}

/** Az PowerShell keeps its sign-ins in ~/.Azure/AzureRmContext.json: read it (no PowerShell start-up needed). */
function psContexts() {
  try {
    const file = path.join(process.env.USERPROFILE || process.env.HOME || '', '.Azure', 'AzureRmContext.json');
    const json = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    return Object.values(json.Contexts || {}).map((c) => ({ tenantId: c.Tenant?.Id, subscriptionId: c.Subscription?.Id, user: c.Account?.Id }));
  } catch { return []; }
}

// ---------- Do the saved sign-ins still work? ----------
// A saved sign-in can be expired, or the tenant may demand MFA again. We ask each tool for a
// token silently (never a sign-in prompt) per client tenant, in the background, and cache the
// answers for 10 minutes. The page shows saved-vs-not instantly and fills in validity after.
const VALIDITY_TTL = 10 * 60_000;
const validity = { at: 0, cli: {}, ps: {}, running: null };

async function pool(items, size, fn) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

async function checkCli(tenants) {
  const result = {};
  await pool(tenants, 5, async (t) => {
    try { await az(['account', 'get-access-token', '--tenant', t, '-o', 'none'], { timeoutMs: 45_000 }); result[t] = true; } catch { result[t] = false; }
  });
  return result;
}

function checkPs(tenants) {
  if (!tenants.length) return Promise.resolve({});
  const list = tenants.filter((t) => GUID.test(t)).map((t) => `'${t}'`).join(',');
  const script = [
    "$ErrorActionPreference = 'Stop'",
    'Import-Module Az.Accounts',
    '$r = @{}',
    `foreach ($t in @(${list})) {`,
    '  $ctx = Get-AzContext -ListAvailable | Where-Object { $_.Tenant.Id -eq $t } | Select-Object -First 1',
    '  try { Select-AzContext -InputObject $ctx -Scope Process | Out-Null; Get-AzAccessToken -WarningAction SilentlyContinue | Out-Null; $r[$t] = $true } catch { $r[$t] = $false }',
    '}',
    "'MONJSON' + ($r | ConvertTo-Json -Compress)",
  ].join('\n');
  return new Promise((resolve) => {
    // -NonInteractive: Az never shows a sign-in prompt here; an expired sign-in just fails.
    const child = spawn(PWSH, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
    let out = '';
    const t = setTimeout(() => child.kill(), 120_000);
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => { clearTimeout(t); resolve({}); });
    child.on('close', () => {
      clearTimeout(t);
      const line = out.split(/\r?\n/).find((l) => l.startsWith('MONJSON'));
      try { resolve(JSON.parse(line.slice(7)) || {}); } catch { resolve({}); }
    });
  });
}

/** Start (or reuse) a background validity check for every tenant that has a saved sign-in. */
function refreshValidity(cliTenants, psTenants, { force = false } = {}) {
  if (validity.running) return validity.running;
  if (!force && Date.now() - validity.at < VALIDITY_TTL) return null;
  validity.running = (async () => {
    const [cli, ps] = await Promise.all([checkCli(cliTenants), checkPs(psTenants)]);
    validity.cli = cli;
    validity.ps = ps;
    validity.at = Date.now();
    bus.emit('event', { type: 'azure:validity', data: { at: new Date(validity.at).toISOString() } });
  })().catch((e) => console.error('[azure validity]', e.message)).finally(() => { validity.running = null; });
  return validity.running;
}

// `az account list` is slow (~5 s); reuse it briefly so status refreshes stay cheap.
let accountsCache = { at: 0, accounts: [], error: null };
async function cliAccounts(force) {
  if (!force && Date.now() - accountsCache.at < 30_000) return accountsCache;
  try { accountsCache = { at: Date.now(), accounts: await az(['account', 'list', '--all', '-o', 'json']), error: null }; } catch (e) { accountsCache = { at: Date.now(), accounts: [], error: e.message }; }
  return accountsCache;
}

/** Sign-in state per client for the Azure CLI and Az PowerShell. Everything else on the Azure page is static config. */
export async function status({ revalidate = false } = {}) {
  const { accounts, error } = await cliAccounts(revalidate);
  const ps = psContexts();
  const tenants = new Set(profiles().map((p) => p.tenantId).filter(Boolean));
  const cliTenants = [...new Set(accounts.map((a) => a.tenantId))].filter((t) => tenants.has(t));
  const psTenants = [...new Set(ps.map((c) => c.tenantId))].filter((t) => tenants.has(t));
  refreshValidity(cliTenants, psTenants, { force: revalidate });
  const valid = (map, t) => (t in map ? map[t] : null); // null = not checked yet
  const current = accounts.find((a) => a.isDefault);
  return {
    error,
    checkedAt: new Date().toISOString(),
    validating: !!validity.running,
    validatedAt: validity.at ? new Date(validity.at).toISOString() : null,
    current: current ? { name: current.name, id: current.id, tenantId: current.tenantId, user: current.user?.name } : null,
    profiles: profiles().map((p) => {
      const cli = accounts.filter((a) => p.tenantId && a.tenantId === p.tenantId);
      const pws = ps.filter((c) => p.tenantId && c.tenantId === p.tenantId);
      const subs = (list, key) => ({
        prod: !!p.subscriptions?.prod && list.some((a) => a[key] === p.subscriptions.prod),
        nonprod: !!p.subscriptions?.nonprod && list.some((a) => a[key] === p.subscriptions.nonprod),
      });
      return {
        org: p.org,
        cli: { signedIn: cli.length > 0, valid: cli.length ? valid(validity.cli, p.tenantId) : false, user: cli[0]?.user?.name || null, ...subs(cli, 'id') },
        ps: { signedIn: pws.length > 0, valid: pws.length ? valid(validity.ps, p.tenantId) : false, user: pws[0]?.user || null, ...subs(pws, 'subscriptionId') },
        // also used by the client page and the assistant
        tenantId: p.tenantId,
        account: p.account || config.get('azure').defaultAccount || '',
        vpn: p.vpn?.required ? { required: true } : null,
        signedIn: cli.length > 0,
        user: cli[0]?.user?.name || null,
        prod: p.subscriptions?.prod ? { id: p.subscriptions.prod, name: p.subscriptionNames?.prod || null } : null,
        nonprod: p.subscriptions?.nonprod ? { id: p.subscriptions.nonprod, name: p.subscriptionNames?.nonprod || null } : null,
        ado: p.ado?.orgUrl ? p.ado : null,
      };
    }),
  };
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s'"`$;]+@[^\s'"`$;]+$/;
const PROFILE_DIR = /^[\w .-]{1,64}$/;
const DATA_DIR = path.resolve(process.env.MON_DATA_DIR || path.join(import.meta.dirname, '..', 'data'));
const psq = (s) => `'${String(s).replace(/'/g, "''")}'`; // PowerShell single-quoted literal
const PWSH = ['C:/Program Files/PowerShell/7/pwsh.exe'].find((f) => fs.existsSync(f)) || 'powershell.exe';

const WT = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WindowsApps', 'wt.exe');

function loginTarget(org, env, tool) {
  const p = profile(org);
  if (!['prod', 'nonprod'].includes(env)) throw new Error('env must be prod or nonprod');
  if (!['cli', 'ps'].includes(tool)) throw new Error('tool must be cli or ps');
  if (!GUID.test(p.tenantId || '')) throw new Error(`${org} has no valid tenant ID yet (Settings > Clients)`);
  const sub = p.subscriptions?.[env];
  if (!sub) throw new Error(`${org} has no ${env === 'prod' ? 'Prod' : 'NonProd'} subscription set`);
  if (!GUID.test(sub)) throw new Error(`${org} ${env} subscription ID is not a GUID`);
  const account = p.account || config.get('azure').defaultAccount || '';
  return {
    p, sub,
    account: EMAIL.test(account) ? account : '',
    edgeProfile: PROFILE_DIR.test(p.edgeProfile || '') ? p.edgeProfile : 'Default',
    label: `${p.org} · ${env === 'prod' ? 'Prod' : 'NonProd'} · ${tool === 'cli' ? 'Azure CLI' : 'Az PowerShell'}`,
  };
}

/** The client's code folder (e.g. D:\Dataweavers\ACU), so the terminal opens where its repos are. */
function clientFolder(org) {
  for (const root of (config.get('workspace').repoRoots || [])) {
    try {
      const hit = fs.readdirSync(root, { withFileTypes: true })
        .find((d) => d.isDirectory() && orgCode(d.name).toLowerCase() === String(org).toLowerCase());
      if (hit) return path.resolve(root, hit.name);
    } catch { /* root missing */ }
  }
  return process.env.USERPROFILE || process.cwd();
}

/**
 * PowerShell script that gets a terminal ready for one client + subscription.
 * It signs in only when needed (no saved sign-in for the tenant, or it has expired).
 * Azure CLI: the subscription becomes the CLI default (shared by all terminals).
 * Az PowerShell: the subscription is selected for this tab only (-Scope Process).
 */
function terminalScript({ p, sub, account, edgeProfile, label }, tool) {
  const t = psq(p.tenantId), s = psq(sub);
  const lines = [
    `$Host.UI.RawUI.WindowTitle = ${psq(label)}`,
    `Write-Host ${psq(label)} -ForegroundColor Cyan`,
  ];
  if (tool === 'cli') {
    const edge = config.get('azure').edgePath.replace(/\\/g, '/');
    lines.push(
      `$env:BROWSER = ${psq(`"${edge}" --profile-directory="${edgeProfile}" %s`)}`,
      // Use the saved sign-in when it still works; otherwise sign in.
      `az account set --subscription ${s} --only-show-errors 2>$null`,
      'if ($LASTEXITCODE -eq 0) {',
      `  az account get-access-token --subscription ${s} -o none --only-show-errors 2>$null`,
      '}',
      'if ($LASTEXITCODE -ne 0) {',
      `  Write-Host 'Signing in…' -ForegroundColor Yellow`,
      `  az login --tenant ${t} --only-show-errors -o none`,
      `  if ($LASTEXITCODE -eq 0) { az account set --subscription ${s} }`,
      '}',
      'if ($LASTEXITCODE -eq 0) {',
      '  az account show --query "{subscription:name, id:id, user:user.name}" -o table',
      `  Write-Host 'Ready. Note: the Azure CLI subscription is shared by all terminals.' -ForegroundColor Green`,
      '}',
    );
  } else {
    lines.push(
      'Import-Module Az.Accounts -ErrorAction Stop',
      `$ctx = Get-AzContext -ListAvailable | Where-Object { $_.Tenant.Id -eq ${t} -and $_.Subscription.Id -eq ${s} } | Select-Object -First 1`,
      '$ok = $false',
      'if ($ctx) {',
      '  Select-AzContext -InputObject $ctx -Scope Process | Out-Null',
      '  try { Get-AzAccessToken -ErrorAction Stop -WarningAction SilentlyContinue | Out-Null; $ok = $true } catch { }',
      '}',
      'if (-not $ok) {',
      `  Write-Host 'Signing in…' -ForegroundColor Yellow`,
      `  Connect-AzAccount -Tenant ${t} -Subscription ${s}${account ? ` -AccountId ${psq(account)}` : ''} | Out-Null`,
      `  if ($?) { Set-AzContext -Tenant ${t} -Subscription ${s} -Scope Process | Out-Null; $ok = $true }`,
      '}',
      'if ($ok) {',
      '  Get-AzContext | Format-List Name, Account, Tenant, Subscription',
      `  Write-Host 'Ready. This subscription applies to this tab only.' -ForegroundColor Green`,
      '}',
    );
  }
  return lines;
}

/**
 * Get a terminal ready for a client: opens a Windows Terminal tab (or a PowerShell window)
 * in the client's code folder, signed in and on the chosen subscription.
 */
export function login(org, env = 'prod', tool = 'cli') {
  const target = loginTarget(org, env, tool);
  const dir = path.join(DATA_DIR, 'login');
  fs.mkdirSync(dir, { recursive: true });
  const script = path.join(dir, `${target.p.org.replace(/[^\w-]+/g, '_')}-${env}-${tool}.ps1`);
  fs.writeFileSync(script, '\uFEFF' + terminalScript(target, tool).join('\r\n') + '\r\n');
  const cwd = clientFolder(target.p.org);
  if (process.env.MON_LOGIN_DRYRUN) return { started: false, label: target.label, script, cwd }; // tests: write the script only
  const shell = [PWSH, '-NoLogo', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', script];
  // Windows Terminal: a new tab in the current window (-w 0); otherwise a plain console window.
  const [cmd, args] = fs.existsSync(WT)
    ? [WT, ['-w', '0', 'new-tab', '--title', target.label, '-d', cwd, ...shell]]
    : ['cmd.exe', ['/c', 'start', '""', '/D', cwd, ...shell]];
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', (e) => console.error('[azure terminal]', e.message));
  child.unref();
  bus.emit('event', { type: 'azure:login', data: { org: target.p.org, env, tool, started: true } });
  return { started: true, label: target.label, terminal: fs.existsSync(WT) ? 'Windows Terminal' : 'PowerShell', cwd };
}

/**
 * Switch the current subscription without opening a window. Needs an existing sign-in.
 * Azure CLI: every terminal (VS Code's too) uses it from the next command.
 * Az PowerShell: becomes the default context for new PowerShell sessions.
 */
export async function switchSubscription(org, env = 'prod', tool = 'cli') {
  const { p, sub, label } = loginTarget(org, env, tool);
  if (tool === 'cli') {
    try { await az(['account', 'set', '--subscription', sub]); } catch {
      throw new Error(`${label}: not signed in yet. Use Open terminal to sign in first.`);
    }
    const acct = await az(['account', 'show', '-o', 'json']).catch(() => null);
    bus.emit('event', { type: 'azure:login', data: { org: p.org, env, tool, switched: true } });
    return { switched: true, label, subscription: acct?.name || sub };
  }
  const has = psContexts().some((c) => c.tenantId === p.tenantId && c.subscriptionId === sub);
  if (!has) throw new Error(`${label}: not signed in yet. Use Open terminal to sign in first.`);
  await new Promise((resolve, reject) => {
    const child = spawn(PWSH, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      // Pick the saved context offline (no sign-in or network call), as the default for new sessions.
      `Import-Module Az.Accounts; $c = Get-AzContext -ListAvailable | Where-Object { $_.Tenant.Id -eq ${psq(p.tenantId)} -and $_.Subscription.Id -eq ${psq(sub)} } | Select-Object -First 1; if (-not $c) { throw 'No saved sign-in for this subscription' }; Select-AzContext -InputObject $c -Scope CurrentUser -ErrorAction Stop | Out-Null`], { windowsHide: true });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim().split('\n')[0] || `PowerShell exited with ${code}`))));
  });
  bus.emit('event', { type: 'azure:login', data: { org: p.org, env, tool, switched: true } });
  return { switched: true, label, subscription: p.subscriptionNames?.[env] || sub };
}

/** Open the client's Azure Portal directory, or its Azure DevOps org, in the client's Edge profile. */
export function openInEdge(org, target = 'portal') {
  const p = profile(org);
  const urls = {
    portal: p.tenantId ? `https://portal.azure.com/#@${p.tenantId}` : 'https://portal.azure.com/',
    ado: p.ado?.orgUrl ? `${p.ado.orgUrl.replace(/\/$/, '')}/${p.ado.project ? encodeURIComponent(p.ado.project) : ''}` : null,
  };
  const url = urls[target];
  if (!url) throw new Error(`No ${target} URL for ${org}`);
  const child = spawn(config.get('azure').edgePath, [`--profile-directory=${PROFILE_DIR.test(p.edgeProfile || '') ? p.edgeProfile : 'Default'}`, url], { detached: true, stdio: 'ignore' });
  child.on('error', (e) => console.error('[edge]', e.message));
  child.unref();
  return { url };
}

export async function resourceGroups(org, env = 'prod') {
  const p = profile(org);
  const sub = p.subscriptions?.[env];
  if (!sub) throw new Error(`${org} has no ${env} subscription configured`);
  return az(['group', 'list', '--subscription', sub, '--query', '[].{name:name, location:location, state:properties.provisioningState}', '-o', 'json']);
}

// ---------- Azure DevOps (REST with a CLI-issued token, no extension needed) ----------
async function adoFetch(p, apiPath, { method = 'GET', body } = {}) {
  if (!p.ado?.orgUrl) throw new Error(`${p.org} has no ADO organization URL configured`);
  const tok = await az(['account', 'get-access-token', '--resource', ADO_RESOURCE, '--tenant', p.ado?.tenantId || p.tenantId, '-o', 'json']);
  const url = `${p.ado.orgUrl.replace(/\/$/, '')}/${apiPath.replace(/^\//, '')}`;
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${tok.accessToken}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`ADO ${res.status} ${res.statusText}`);
  return res.json();
}

export async function adoWiql(org, wiql, top = 50) {
  const p = profile(org);
  const project = p.ado?.project ? `${encodeURIComponent(p.ado.project)}/` : '';
  // WIQL is a read-only query language, sent via POST by API design.
  const q = await adoFetch(p, `${project}_apis/wit/wiql?api-version=7.1&$top=${top}`, { method: 'POST', body: { query: wiql } });
  const ids = (q.workItems || []).slice(0, top).map((w) => w.id);
  if (!ids.length) return [];
  const items = await adoFetch(p, `_apis/wit/workitems?ids=${ids.join(',')}&fields=System.Id,System.Title,System.State,System.WorkItemType,System.ChangedDate,System.TeamProject&api-version=7.1`);
  const base = p.ado.orgUrl.replace(/\/$/, '');
  return items.value.map((w) => ({
    id: w.id, title: w.fields['System.Title'], state: w.fields['System.State'], type: w.fields['System.WorkItemType'],
    changed: w.fields['System.ChangedDate'], project: w.fields['System.TeamProject'],
    url: `${base}/${encodeURIComponent(w.fields['System.TeamProject'])}/_workitems/edit/${w.id}`,
  }));
}

export function adoMyWorkItems(org) {
  return adoWiql(org, "SELECT [System.Id] FROM WorkItems WHERE [System.AssignedTo] = @Me AND [System.State] NOT IN ('Closed','Done','Removed','Resolved') ORDER BY [System.ChangedDate] DESC");
}

export async function adoMyPullRequests(org) {
  const p = profile(org);
  const me = await adoFetch(p, '_apis/connectionData');
  const id = me.authenticatedUser.id;
  const [mine, review] = await Promise.all([
    adoFetch(p, `_apis/git/pullrequests?searchCriteria.status=active&searchCriteria.creatorId=${id}&api-version=7.1`),
    adoFetch(p, `_apis/git/pullrequests?searchCriteria.status=active&searchCriteria.reviewerId=${id}&api-version=7.1`),
  ]);
  const map = (pr, role) => ({
    id: pr.pullRequestId, title: pr.title, repo: pr.repository?.name, project: pr.repository?.project?.name, role,
    url: `${p.ado.orgUrl.replace(/\/$/, '')}/${encodeURIComponent(pr.repository?.project?.name)}/_git/${encodeURIComponent(pr.repository?.name)}/pullrequest/${pr.pullRequestId}`,
  });
  return [...mine.value.map((x) => map(x, 'author')), ...review.value.map((x) => map(x, 'reviewer'))];
}

// ---------- Read-only guard for CLI calls requested by the assistant ----------
const READ_VERBS = new Set(['list', 'show', 'query', 'version', 'list-locations', 'list-usage']);
const DENY = /^(get-access-token|keys?|secrets?|credentials?|password|connection-string|login|logout|set|create|delete|update|add|remove|start|stop|restart|deploy|invoke|import|export|purge|reset|assign|grant|revoke|upload|download|run|exec|ssh|generate-sas|list-keys|list-secrets|list-credentials|list-publishing-credentials|list-connection-strings)$/i;
/**
 * Point an az command at the right client subscription, so it runs with that client tenant's
 * sign-in instead of the CLI's current (default) account. Without it, a call such as
 * `monitor metrics list --resource /subscriptions/<client sub>/...` uses the default tenant's token
 * and Azure refuses it ("access token is from the wrong issuer").
 * Kept as given when the command already names a subscription; otherwise taken from a resource ID
 * in the arguments, else from the client's profile (`org`, prod or nonprod).
 */
export function withSubscription(args, { org, env = 'prod' } = {}) {
  const graph = args[0] === 'graph'; // az graph query takes --subscriptions (plural)
  if (args.some((a) => /^--subscriptions?(=|$)/.test(a))) return { args, subscription: null };
  const fromId = args.join(' ').match(/\/subscriptions\/([0-9a-f-]{36})/i)?.[1];
  let sub = fromId;
  if (!sub && org) {
    const p = profile(org);
    sub = p.subscriptions?.[env] || p.subscriptions?.prod || p.subscriptions?.nonprod;
    if (!sub) throw new Error(`${p.org} has no ${env} subscription configured (Settings > Clients)`);
  }
  if (!sub) return { args, subscription: null };
  return { args: [...args, graph ? '--subscriptions' : '--subscription', sub], subscription: sub };
}

/** Run a read-only az command for the assistant, in the right client tenant. */
export async function assistantAz(args, { org, env } = {}) {
  assertReadOnly(args);
  const scoped = withSubscription(args, { org, env });
  try {
    try {
      return await az([...scoped.args, '-o', 'json']);
    } catch (e) {
      // a few commands don't take --subscription: run them as given
      if (scoped.subscription && /unrecognized arguments:.*--subscriptions?/i.test(e.message)) return await az([...args, '-o', 'json']);
      throw e;
    }
  } catch (e) {
    if (!/wrong issuer|InvalidAuthenticationTokenTenant|AADSTS|no subscriptions? found|Please run 'az login'/i.test(e.message)) throw e;
    // Name the client and what to do, so the answer can say which sign-in to renew.
    const owner = profiles().find((p) => Object.values(p.subscriptions || {}).includes(scoped.subscription));
    throw new Error(`${e.message.split('\n')[0]}\nThe Azure CLI sign-in for ${owner ? `${owner.org} (tenant ${owner.tenantId})` : `subscription ${scoped.subscription || '(none given)'}`} is missing or expired. `
      + `Pass org (or --subscription <the client's subscription>) if you didn't; otherwise ask the user to sign in for that client from the Azure page (Login) and try again.`);
  }
}

export function assertReadOnly(args) {
  // Command words are everything before the first flag (values after flags are user data, not verbs).
  const firstFlag = args.findIndex((a) => a.startsWith('-'));
  const words = firstFlag === -1 ? args : args.slice(0, firstFlag);
  if (!words.length) throw new Error('Empty az command');
  if (words.some((w) => DENY.test(w)) || words.some((w) => /secret|credential|password|(^|-)keys?$/i.test(w))) throw new Error(`Blocked: "az ${words.join(' ')}" is not a read-only command`);
  if (!words.some((w) => READ_VERBS.has(w) || w.startsWith('list-') || w.startsWith('show-'))) {
    throw new Error(`Blocked: only list/show/query az commands are allowed (got "az ${words.join(' ')}")`);
  }
}
