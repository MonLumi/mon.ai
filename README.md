# mon.ai

A personal AI ops assistant that runs on this machine only, at http://mon.ai.

- **Claude**: chat runs on your Claude subscription through the Claude Agent SDK. You sign in once in the browser (Settings → Claude account), and that login is shared with Claude Code. No API key.
- **Zendesk**: you sign in through the browser, so no API token is needed. Settings opens Zendesk in a separate Edge window with its own mon.ai profile. You sign in as usual (SSO/MFA), the window closes, and the session is reused for read-only API calls. It is saved in `data/zendesk-session.json` and refreshed automatically. An API token still works if you ever get one. The app syncs your assigned tickets every 60 s (polling the Search API, since a localhost app can't receive webhooks). The dashboard ranks open tickets by an attention score and also shows tickets solved per day.
- **Cloudflare**: uses a read-only API token. Zones are linked to clients in Settings → Clients and shown on the Clients page and in client panels. Zones and the token check are cached for an hour (also across restarts).
- **Filters**: the Cloudflare, Azure & ADO and Repositories pages each have a filter box. You can type several words. On Azure it also filters resource groups and ADO items you've loaded.
- **AI model**: set a default model and effort in Settings → Claude & model. You can also switch the model per chat from the chat header. The list comes from your Claude subscription, and each reply shows which model answered.
- **Assistant**: the tab lists your chats grouped by client. A client chat shows that client's panel on the right (open tickets, Azure sign-in and buttons, Cloudflare zones, repositories). Paste, drop or 📎-attach images and files right where the cursor is, between paragraphs; they stay in that position in the conversation, and the assistant sees them in context. Drag the bar above the message box to make it taller or shorter (double-click to reset). **Ctrl+Enter** sends; Enter and Shift+Enter add a new line. Hover one of your messages and click **✎ Edit** to change it: sending replaces that message and everything after it, and the conversation continues from just before it (the assistant forgets the replaced part).
- **Archive**: when a sync sees a ticket solved or closed, its chats are archived. They leave the sidebar and appear under Assistant → Archived, stay readable, and keep a short resolution note. The assistant searches these notes (past_chats) before investigating a similar problem. You can archive or unarchive a chat yourself; writing in an archived chat reopens it. **Delete** removes a chat completely, and it is never used as a reference.
- **Zendesk refresh**: a chat about a ticket has a **↻ Zendesk** button. It fetches comments added since the chat last looked and, if there are any, sends them to the assistant to update the summary, next step and draft. A banner appears when the background sync sees new activity on that ticket.
- **Chat**: answers render as full Markdown (tables, lists, code). The tools and progress notes fold into one "Worked through N steps" line you can expand. Drafts (customer replies, emails) appear in a card with **Copy draft**, code blocks have Copy, and each answer has **Copy answer**.
- **Client badge**: every ticket shows a coloured client tile next to its score (same colour per client); click it to open the client.
- **Following**: tickets assigned to others where you're a follower (for example @mentioned or on the follow-up list) or CC'd are synced too. They only join the Dashboard focus queue (tagged **@ Mentioned**) when someone mentioned you by name and you haven't commented since, and the score is 40+. Followed tickets a colleague is handling stay out of the queue; you'll still find them on the client's page, tagged Following/CC. They never count toward your own numbers.
- **Update from Preview**: from the bottom of the Preview panel, set the status (Open, Pending or Solved), add an internal note, re-assign the ticket (group + agent, or group only), and add colleagues as followers. In the internal note, type @ to mention a Dataweavers colleague (typing filters the list, e.g. @Truong): it writes @Name and adds them as a follower if they aren't one yet, as tagging does in Zendesk. A ⏱ timer starts when you open the Preview. You can pause it, reset it, or click it to type your own time (15m, 1h 20m, 90, 1:30); it keeps counting from the time you typed (unless you paused it). On Submit it's logged to the Time Tracking fields (Time spent last update / Total time spent), like Zendesk's Time Tracking app; untick ⏱ to skip logging. The **Category** drop-down sits next to the status buttons, with the options from Zendesk; changing it is sent with Submit, and it is required to solve. If Zendesk requires other fields before solving and the ticket has them empty, they appear when you pick Solved and must be set before Submit. All of it goes in one Submit, posted to Zendesk as you. Solving, re-assigning or logging time on its own shows a confirmation in the middle of the dimmed page, listing every change (status, Category, assignee, followers, note, time) with **OK** / **Cancel** (Esc or a click outside cancels). The assistant has no tool to change tickets.
- **Notifications**: the 🔔 next to the logo (or under » when the sidebar is hidden) shows the same notifications as Zendesk's bell, read from Zendesk's own notification feed with your browser sign-in: who mentioned you, on which ticket, and the message. The red badge and the tab title show the unread count. They are grouped Recent / Earlier today / Yesterday / by day, with an **Unreads** switch. A new one also pops up as a message. Clicking a notification opens the ticket and marks it read in Zendesk, as clicking it in Zendesk does; **Mark all read** does that for all. Checked with every sync.
- **Ticket screen**: clicking a ticket opens one page with three columns: **Ask AI** (the ticket's chat), the **Preview** (details, conversation, update form) and the **client** panel (open tickets, Azure, Cloudflare, repositories). Opening a ticket never asks the assistant anything. If the ticket has no chat yet, the Ask AI column stays empty until you click **Ask AI** or type your own question. **Ask AI** on the Dashboard opens this screen and asks the standard question, or reopens the ticket's chat if there is one. Ticket chats in the sidebar open here too. The client panel is docked as a column; **Hide »** tucks it away and the tab on the right edge brings it back (remembered). The left sidebar works the same way: **«** next to the logo hides it, **»** at the top left shows it.
- **Focus queue**: tickets are split into *Needs you* (new or open) and *Waiting* (pending on the customer, or on hold). Each ticket has a coloured status label and edge. A mentioned ticket has a **Cool down** button that moves it to the *Cooling down* tab. It returns to *Needs you* when someone mentions you again; once you comment it leaves the queue. **Warm up** brings it back straight away. **Updated by me** lists tickets where the latest change in the last 24 hours was yours (any status, including colleagues' tickets you commented on), from the ticket audits.
- **Azure / ADO**: the **Clients** page draws every client at once from your settings. Only the sign-in status (Azure CLI and Az PowerShell) is checked live, in the background. Each client has a **Login** panel (Azure CLI or Az PowerShell, Prod or NonProd) with two modes. **Open terminal** opens a Windows Terminal tab in the client's code folder, reusing your saved sign-in and only prompting when it has expired; for Az PowerShell the subscription applies to that tab only. **Switch only** changes the current subscription without a window: Azure CLI takes effect in every terminal (VS Code too) from the next command, and Az PowerShell in new sessions.
- **Local code**: each repository has a **VS Code** button next to its name. On the Repositories page, organizations are ordered by your most recent action: your latest git action (commit, pull, checkout… from the local reflog) in the org's DW-Pipelines repo, or opening any of its repos in VS Code from mon.ai. Orgs without a DW-Pipelines repo use their most recently touched repo. Repos are rescanned every 5 minutes. The app scans the repository roots configured on your machine. The folder name under a root becomes the organization: `C:\repos\ExampleOrg` → ExampleOrg.
- **By organization** (Dashboard): your own tickets per client: Open, Hot (score 40+), **Resolved** (solved or closed in the last 7 days) and the top score.
- **Claude usage** (bottom left, under your account): your plan's **Session** (current 5-hour window) and **Weekly** usage with when each resets, the same numbers as Claude Code's /usage. Asked from Claude Code without sending a prompt, so it uses no tokens. It refreshes after each chat reply and every 5 minutes (Claude Code elsewhere uses the same plan); click it to refresh now. The bar turns amber at 50% and red at 80%.
- **Models**: one default model and effort in Settings → Claude & model. A skill can set its own **Model** and **Effort** in the skill editor; it applies when you run it with /name (Ask AI runs with /ticket-triage's). A model picked in a chat's header overrides both for that chat. Each answer shows the skill and model it used.
- **Plans (acting on your behalf, stage 1)**: ask the assistant to *do* something (reply to a ticket, set it to pending, re-assign, log time, change an Azure / Cloudflare / ADO / git resource) and it checks the current state, then shows a **📝 Plan** card in the chat: numbered steps with the exact values and reply text, risk, what it checked and what you should confirm. **Copy plan** copies it, **✎ Revise** starts a message asking for changes. Nothing is run yet (**Approve & run** is disabled until stage 2). One skill per system writes the plan: `/zendesk-actions` (replies, notes, status, assignee, Category, time; Sonnet), `/azure-actions` (Azure, Front Door / WAF, ADO), `/cf-actions` (Cloudflare rules, DNS, cache) and `/git-actions` (branch, file diffs, commit, PR), the last three on Opus. `/plan-actions` handles requests across several systems: it uses those skills and merges their steps into one plan, ordered infra → code → verify → Zendesk last. The assistant picks the right one on its own for change requests; they're under **Actions** on the Skills page.
- **Skill from a chat**: **＋ Skill** in a chat header asks Claude to turn what the chat did into a reusable skill (name, when to use it, steps, client). It opens in the skill editor for you to review; nothing is saved until you press Save.
- **Logged today** (Dashboard): the time you logged today with Time Tracking (from mon.ai or Zendesk), summed from your updates in the ticket history, refreshed with each sync. The assistant can answer it too (daily_performance).
- **Unassigned tickets**: open tickets nobody has picked up, in your Zendesk groups (or with no group yet), are synced too and appear in the Focus queue's *Needs you* tab in their own **New · unassigned** section above *Your queue*, tagged **Unassigned**. **Cool down** parks one until something new happens on it, scored up so new ones stand out. Each ticket row shows its assignee in bold (or You / Unassigned).
- **Usage** (menu tab, or click the usage meter under your account): what mon.ai's chats use over 7 days / 30 days / all time. Shows plan limits; cost, messages, cost per message, tokens and cache re-use; cost per day by model (hover for details); and tables by skill, model and client, an expandable **By chat** table (Top 10 / 20 / 50 / 100 / All; click a chat to see the models and skills it used and its costliest messages), plus the most expensive messages. **Ways to use less** suggests savings, e.g. a skill on Opus with short answers could run on Sonnet, or a chat so long that each message re-reads a lot of history. Data comes from Claude Code's transcripts (every API call's model and tokens), read after each reply and at start-up, so earlier chats are included. Cost is the API-equivalent price Claude Code reports, split over a chat's calls by token weight: a measure of plan use, not a bill.
- **This chat** (side panel of a chat or ticket, below Repositories): the chat's cost, runs, tokens and cache re-use; the models and skills it used; and its last runs (skill, model calls, tools, tokens, cost). Updates after each reply.
- **Ticket preview**: comments are formatted as in Zendesk (tables, lists, links) with their images and attachments, loaded through mon.ai with your Zendesk sign-in (only Zendesk attachment links; other images become links). Previews are cached until the ticket changes and fetched ahead after each sync for tickets with an open chat and the focus queue, so they open instantly; ↻ in the preview reloads from Zendesk. The ticket header (number, subject, status, ↻, Open in Zendesk) stays at the top while you scroll. A long message has **Show all ▾** / **Collapse ▴**, and you can drag its bottom-right corner to make it taller or shorter.
- **Ask AI = /ticket-triage**: a summary only (where it stands, who it waits on, urgency, what's known / unknown), no draft reply and no investigation. It ends with recommended **Next actions** shown as buttons, best first, each with a reason: /customer-reply when the customer is waiting on an answer, /cf-block-check or /afd-block-check for Cloudflare / Front Door blocks, /health-check for slow or down sites, /investigate for other faults, /deep-investigate when an earlier investigation didn't explain it. Clicking one sends it as the next message, so it runs with that skill's own model. Any skill can offer next actions with lines like `Next: /skill <ticket> — why`.
- **↻ Zendesk in a ticket chat = /ticket-update**: sends only the new comments, with quoted email history, legal notices and very long text trimmed, to the /ticket-update skill (Sonnet, low effort). The skill answers briefly (what's new, what changes) and offers Next action buttons, with no draft and no tool calls unless needed, so a refresh costs a fraction of a full answer. On the ticket screen, one header spans the chat and the Preview: client, ticket number, status, priority and score, and the subject on the left; the chat's chips (AI chat, read-only, cost so far), model, ＋ Skill, Archive and Delete, then the Preview's ↻ and Open in Zendesk on the right. Drag the divider between the chat and the Preview to make either wider; the split is remembered per ticket (double-click the divider to reset). **↻ Zendesk** sits next to **Send**.
- **Sidebar**: groups tickets, chats and repos by organization. It lists only active clients (open tickets, or a chat in the last 14 days); **Show all clients** at the bottom lists the rest. Org aliases map Zendesk organization names to short codes.

All assistant tools are read-only. Azure CLI calls go through a list/show/query allow-list, and secret, key and token commands are blocked. File access is limited to your repo roots.

## Setup

1. Point `mon.ai` at your machine: run this in an **elevated** PowerShell (once):
   ```powershell
   Add-Content C:\Windows\System32\drivers\etc\hosts "`n127.0.0.1`tmon.ai"
   ```
2. Install and start the app:
   ```powershell
   npm install
   npm start          # serves http://mon.ai (port 80, bound to 127.0.0.1 only)
   ```
   If port 80 is taken (for example by IIS), use `$env:PORT=8787; npm start` and open http://mon.ai:8787.
3. (Recommended) Switch to HTTPS: run `npm run cert` once. It creates a certificate for mon.ai/localhost/127.0.0.1 that is valid for 2 years and is not a certificate authority. It trusts it for your Windows user only, and Windows asks you to confirm. Restart, and mon.ai serves https://mon.ai on port 443 while http:// redirects to it. Re-run it to renew.
4. Open http://mon.ai → **Settings**:
   - *Clients*: one card per client, with the other names it goes by (Zendesk organization / repo folder names), its **Cloudflare zones**, **VPN required**, and its Azure tenant, subscriptions and ADO organization. Every client is listed on the Azure & ADO page; one without a tenant ID yet shows a link to fill it in.
   - *General*: Edge executable and default login account, git repo roots, Zendesk (save the subdomain, then **Sign in with browser**) and Cloudflare (an **API Token** with Zone:Read; for an Account API Token also fill in the Account ID).
   - *Claude & model*: shows your login, signs you in through the browser, and sets the default model.

Settings are saved to `config/*.json` and apply immediately. Editing those files by hand also works: the app watches them and reloads without a restart.

## Skills

Skills are reusable instructions for repeated tasks, managed on the **Skills** page. Each skill is a `SKILL.md` under `ai-skills/skills/<name>/`, loaded as a local Claude Code plugin.

- **Run one directly:** type `/skill-name` in chat, optionally followed by details (e.g. `/ticket-triage 25348`). Typing `/` lists them.
- **Automatic:** the assistant also picks a skill on its own when your request matches the skill's "When to use it" description.
- **Per client:** a skill can apply to all clients or just one; a client-only skill shows up only in that client's chats.
- **Starters:** `ticket-triage`, `plan-my-day` and `customer-reply`. Edit or delete them freely; changes apply from the next message.

## Attention score

| Signal | Points |
|---|---|
| Priority urgent / high / normal / low | 40 / 25 / 10 / 3 |
| Status new / open / pending / hold | +20 / +12 / −15 / −10 |
| SLA breached / < 1 h / < 4 h / < 24 h | +50 / +35 / +20 / +8 |
| Due date overdue / < 24 h | +30 / +15 |
| No update > 3 d / > 1 d (new or open only) | +15 / +8 |
| Open for more than 14 days | +5 |

Tickets scoring 40 or more count as "needs attention". You can tune the weights in `scoreTicket()` in `lib/zendesk.js`.

## Files

### Configuration

Personal configuration files in `config/` are ignored by Git. To set up a local copy, copy the `config/*.example.json` templates to `config/*.json` and fill in your own values. For example, in PowerShell:

```powershell
Copy-Item config\azure.example.json config\azure.json
Copy-Item config\workspace.example.json config\workspace.json
Copy-Item config\secrets.example.json config\secrets.json
```

Only the example templates are included in Git. Do not remove the ignore rules for the local JSON files or add credentials to the examples.

```
server.js          HTTP API, SSE live updates, host-header guard
lib/config.js      hot-reloaded JSON config (azure.json, workspace.json, secrets.json)
lib/zendesk.js     sync, scoring, daily performance
lib/zdauth.js      Zendesk browser sign-in (Edge + DevTools protocol, session cookies)
lib/cloudflare.js  read-only API client
lib/azure.js       az CLI, Edge-profile login, ADO REST, read-only guard
lib/git.js         repo discovery and status
lib/assistant.js   Claude Agent SDK chat, tools, subscription login
public/            UI (no build step)
data/mon.db        local SQLite cache (tickets, chats)
```

Personal use only: the Claude subscription login belongs to you and should not be shared through this app.

## Starting mon.ai

- **Start menu / desktop**: the **mon.ai** shortcut starts the server in the background (no window) if it isn't running, and opens https://mon.ai. **mon.ai - restart** (Start menu) restarts it after an update; **mon.ai - stop** stops it. Pin **mon.ai** to the taskbar from the Start menu for one click.
- **From a terminal** in the mon-ai folder: `npm run bg` (start in background), `npm run restart`, `npm run stop`, `npm run status`. `npm start` still runs it in the terminal.
- **From any terminal, any folder**: `mon start`, `mon restart`, `mon stop`, `mon status` (add `-NoBrowser` to skip opening the browser). This is `bin\mon.cmd`; the `bin` folder must be on your user PATH:
  `[Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path','User') + ';D:\SmartOSC\Assistant\mon-ai\bin', 'User')`
- **Start at sign-in**: `pwsh scripts/install-shortcuts.ps1 -AutoStart` adds a shortcut to your Startup folder that starts mon.ai in the background when you sign in to Windows (no browser). `-Remove` removes all the shortcuts.
- The background server logs to `data/logs/mon.log` (errors in `mon.err.log`, launcher messages in `launcher.log`). The launcher finds the server by its port, so restart/stop also work on one you started with `npm start`.
