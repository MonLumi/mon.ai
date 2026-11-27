---
name: investigate-ticket
description: Investigate a Zendesk ticket's technical problem (errors, blocked requests, caching, DNS, outages, deployments): reuse past resolved cases, then run targeted read-only checks on Cloudflare, Azure / Front Door and ADO to find the root cause and the action to take. Use when asked to investigate, check, diagnose or find the cause of a ticket's issue.
mon-model: sonnet
mon-effort: high
mon-category: Investigation
---

# Investigate

Input: a ticket number (e.g. `/investigate-ticket 25466`). If none is given, use this chat's ticket.

Keep it targeted: a handful of checks that test a clear hypothesis, not a sweep of everything.

1. **Understand the ask.** Load the ticket with `zendesk_ticket` (skip if it is already in this chat). Note the client, environment (prod / non-prod), affected URL or host, error text, time window, and any Ray ID, request ID or screenshot.
2. **Look for a previous case first.** Search `past_chats` with the client code and 2–3 key words (e.g. `QBE waf block`, `CQU cache next`). Also try `zendesk_search` for similar tickets, e.g. `type:ticket organization:QBE "PERF"`. If a past case matches, say so, link it, and check whether the same cause and fix apply before going further.
   **Outage, slowness or errors at a point in time?** Run `incident_timeline` once, with the ticket number and `host` = the affected site, before anything else. It shows when Site24x7 saw that site down (and why), which Azure Monitor alerts fired for the client in Squadcast, and gives a `suggestedWindow`: use it for every log, metric and Cloudflare query below. An Azure alert that fired just before the outage is the first lead. For a fault that isn't time-bound (a config, a rule, one page always broken), skip this.
3. **State a hypothesis** in one line (e.g. "a Cloudflare custom WAF rule blocks POSTs to /api/perf").
4. **Check only the relevant systems** (always read-only):
   - **Cloudflare**: find the zone with `cloudflare_zones` (client code). Then, with `cloudflare_get`: `zones/{id}/dns_records`, `zones/{id}/settings`, `zones/{id}/rulesets` and phase entrypoints such as `zones/{id}/rulesets/phases/http_request_firewall_custom/entrypoint`, `.../http_request_firewall_managed/entrypoint`, `.../http_ratelimit/entrypoint`, `.../http_request_cache_settings/entrypoint`, and `zones/{id}/firewall/access_rules/rules`.
     For blocked or challenged requests, use Security Events: `cloudflare_security_events` with the Ray ID if there is one, otherwise with host / path / client IP and the ticket's time window; `cloudflare_security_top` grouped by `["action","description"]` (or `clientIP`, `clientRequestPath`, `datetimeHour`) to see which rule fires and since when. Then read that rule's expression from `zones/{id}/rulesets/{rulesetId}`. For a deeper WAF / block analysis, the `check-cf-block` skill has the full procedure.
   - **Azure / Front Door**: use `azure_profiles` for the client's subscription IDs and always pass `--subscription`. Useful reads: `afd profile list`, `afd endpoint list`, `afd route list`, `afd origin-group list`, `afd security-policy list`, `network front-door waf-policy list/show`, `webapp list/show`, `webapp config show`, `webapp deployment slot list`, `monitor diagnostic-settings list --resource <id>` (to find the Log Analytics workspace).
     For AFD access / WAF logs: `monitor log-analytics query -w <workspace-guid> --analytics-query "<KQL>"` against `AzureDiagnostics` (Category `FrontDoorAccessLog` or `FrontDoorWebApplicationFirewallLog`), limited to the ticket's time window and host, with `| take 50`. If the CLI says an extension is missing, tell me the `az extension add` command instead of retrying.
   - **ADO / code**: `ado_query` for related work items or recent changes, `git_repos` / `git_log` for recent commits in the client's repos, and Read / Grep for config (e.g. headers, cache rules, routes) when the cause may be in code.
5. **Stop when the evidence explains the symptom.** Don't keep checking once the cause is clear.

## Answer format

- **Finding**: the root cause (or the most likely one), with the evidence (rule name / ID, setting, log line, commit).
- **Confidence**: high / medium / low, and what would confirm it.
- **Action**: exact steps or commands for me to run (mon.ai is read-only), noting prod vs non-prod and any change approval needed.
- **Past case**: link it if one matched.
- **Next step**: end the answer with exactly one line on its own (the app shows it as a button):
  - cause still unclear after these checks, spans several systems, or production affected with no clear lead → list what is still unknown, then `Next: /investigate-root-cause <ticket number>`
  - cause found and the customer needs a reply → `Next: /draft-customer-reply <ticket number>`
  - otherwise no Next line.
