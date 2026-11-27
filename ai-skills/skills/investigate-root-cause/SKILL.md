---
name: investigate-root-cause
description: Deep root-cause analysis for a complex or unresolved ticket where a first investigation did not explain the problem, the cause spans several systems (Cloudflare, Front Door, App Service, code, deployments) or production is affected. Use only when asked to dig deeper, do a deep investigation or a root-cause analysis.
mon-model: opus
mon-effort: high
mon-category: Investigation
---

# Deep investigate

Input: a ticket number (e.g. `/investigate-root-cause 25134`). If none is given, use this chat's ticket.

1. **Restate the problem precisely**: symptom, affected hosts / paths / users, environment, when it started, what changed around then, and what earlier checks ruled out.
2. **Check history**: `past_chats` with several phrasings, plus `zendesk_search` for related tickets from the same client in the last few months. Note recurring patterns.
3. **Map the request path** for the affected URL: client → Cloudflare zone (DNS, proxy, WAF, cache, rules) → Azure Front Door (endpoint, route, origin group, WAF policy) → origin (App Service / slot / container) → app code and config. Identify which hop the symptom can come from.
4. **Form 2–3 competing hypotheses** and, for each, the cheapest read-only check that would confirm or rule it out. Run them in order of likelihood × cost, and update the hypotheses as evidence arrives. Use the same tools as the `investigate-ticket` skill (Cloudflare `cloudflare_security_events` / `cloudflare_security_top` for blocks and challenges, `cloudflare_get` for rules and settings, `azure_cli`, Log Analytics KQL for AFD / App Service logs, `ado_query`, `git_log`, Read / Grep on the repo).
5. **Correlate in time**: line up the incident window with deployments (git / ADO), configuration changes and log spikes.
   - If the window isn't pinned yet, `incident_timeline` with the ticket and `host` = the affected site gives when users saw it down (Site24x7) and which Azure Monitor alerts fired for the client (Squadcast).
   - `site24x7_poll_log` for that monitor and date: first / last failed check per location, status codes, resolved IP. All locations vs some tells origin / edge from regional network; a changed resolved IP points at DNS or a Front Door / Cloudflare change.
   - For a Squadcast alert that fired first, `squadcast_get` `incidents/{id}` gives the full Azure Monitor payload (rule, condition, threshold, resource ID): query that resource's metrics for the same window.
   - Put this in the root-cause chain: first signal → what users saw → what fixed it.
6. **Read the code** when the evidence points at the app: routing, middleware, headers, caching, auth, API handlers.
7. If a needed piece of evidence is out of reach (portal-only data, logs older than Cloudflare's ~30-day retention, an action needing write access), say exactly what to fetch and how, then continue with what is available.

## Answer format

- **Root cause**: what happens, at which hop, and why — with the evidence for each link in the chain.
- **Ruled out**: the hypotheses that were eliminated and how.
- **Confidence** and the one check that would confirm it.
- **Fix**: exact steps or commands for me to run, in order.
- **Prevention**: one or two follow-ups (monitoring, rule, code change, documentation) if worthwhile.
- **Customer summary**: two or three plain-language sentences I can adapt for the client.
- If the customer needs a reply, end the answer with this line on its own (the app shows it as a button): `Next: /draft-customer-reply <ticket number>`
