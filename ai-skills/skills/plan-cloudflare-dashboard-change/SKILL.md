---
name: plan-cloudflare-dashboard-change
description: Plan a Cloudflare change that I make myself in the Cloudflare dashboard and show it as a plan card: WAF custom rules, skip / exception rules, managed-rule overrides, rate limiting rules, IP access rules, DNS records, cache purges and zone settings. For each change it gives the rule type, rule name, expression, action(s), additional config, order and whether to deploy as draft or enable immediately. Use when I ask you to allow, unblock, block, whitelist, purge or change something in Cloudflare. Not for Azure Front Door (plan-azure-change), code (plan-code-change) or tickets (plan-ticket-change).
mon-model: opus
mon-effort: medium
mon-category: Actions
---

# Cloudflare change via the dashboard

Input: the client or zone and what I want changed, e.g. `/plan-cloudflare-dashboard-change QBE allow Dynatrace to /api/health` or `/plan-cloudflare-dashboard-change ACU purge cache for www.acu.edu.au/news`. Often follows `/check-cf-block`: reuse its findings from this chat (rule, ruleset, Ray IDs, IPs) instead of looking again.

**I** make the change by hand in the Cloudflare dashboard. You read the current state, then write a plan precise enough that I can copy each field straight into the dashboard form. Show it with the `mcp__mon__propose_plan` tool (called `propose_plan` below). Never say anything was changed.

## 1. Read the current state (read-only)
- **Zone**: use the client code as the zone (custom hostnames like `www.qbe.com` live in the client's `*.saas.dataweavers.io` zone). `cloudflare_zones` only if unclear.
- **Rules**: `cloudflare_get` `zones/{zoneId}/rulesets` → the entry-point ruleset for the phase (`http_request_firewall_custom`, `http_request_firewall_managed`, `http_ratelimit`), then `zones/{zoneId}/rulesets/{id}`. Note every rule's position, description (= name in the dashboard), expression, action and enabled flag.
- **DNS**: `zones/{zoneId}/dns_records?name=<host>` (type, content, proxied, TTL).
- **Settings**: `zones/{zoneId}/settings/<name>`.
- **Impact**: for a rule change, `cloudflare_security_top` on the same rule/host for the last 7 days, so the plan says how much traffic it affects.
- `past_chats` for the same kind of change on this client, and reuse its naming.

## 2. Write one step per dashboard change
`action: manual`, `target`: the zone name. `summary`: the dashboard path, e.g. "Security → WAF → Custom rules → Create rule" or "Edit rule *Block bad bots*". `params` holds these fields, **in this order and with these exact keys**, so the card reads like the dashboard form. Keep every value short and plain (one line where possible); the card shows long ones collapsed:

1. `ruleType`: where it lives in the dashboard: *Custom rule*, *Rate limiting rule*, *Managed rules (exception / skip)*, *Managed rules (override)*, *IP access rule*, *DNS record*, *Cache purge*, *Configuration rule*, *Zone setting*... Say whether it's **new** or **edit existing**.
2. `ruleName`: the exact name to type. Follow the zone's existing naming (look at the other rules); otherwise `<Client> - <what> - <why>`, e.g. `QBE - Allow Dynatrace /api/health - #25466`. Include the ticket number when there is one. For an edit, the current name.
3a. `expressionBuilder`: the **preferred** method: what to pick in the dashboard's interactive builder. Use it whenever the builder can express the rule (only fields, operators and And/Or the builder offers; no functions such as `starts_with` / `lower` and no nesting beyond "groups joined by Or, conditions in a group joined by And"). Give it as a **JSON object**, not text, so the card can show it as the builder's Field / Operator / Value rows:
    ```json
    {"join": "Or", "groups": [
      {"label": "Belgium", "conditions": [
        {"field": "Hostname", "operator": "equals", "value": "be.goodman.com"},
        {"field": "URI Path", "operator": "is in", "value": ["/about-goodman/careers", "/en/about-goodman/careers"]}
      ]}
    ]}
    ```
    Use the dashboard's own names for fields and operators (*Hostname*, *URI Path*, *URI Full*, *IP Source Address*, *AS Num*, *User Agent*, *Country*…; *equals*, *does not equal*, *contains*, *is in*, *is not in*, *starts with*…). `value` is a string, or a list for *is in* / *is not in* (one entry per value to type). `label` is optional, a few words on what the group covers. For an edit, also `currentExpressionBuilder` in the same shape.
3b. `expression`: always include it (the same rule as text, for **Edit expression**), even with a builder. Plain text, no code fences, **formatted for reading** with line breaks and 4-space indentation, so I can copy it and paste it into the expression editor as is. Each `and` / `or` operand of a long group on its own line with the operator at the end of the line, `) and (` / `) or (` on one line, nested groups indented, long `in { }` lists one value per line:
    ```
    (http.host eq "www.qbe.com") and (
        (
            starts_with(http.request.uri.path, "/assets") or
            (http.request.uri.path contains "/-/media/")
        ) and (
            (http.referer contains "https://www.qbe.com/au/claim/direct/motor") or
            (http.referer contains "https://www.qbe.com/au/pay-bills")
        )
    )
    ```
    For an edit, also `currentExpression`, formatted the same way. Builder or expression: the narrowest that works: exact host + path + IP / ASN / user agent; never a whole-zone match. Don't repeat the builder or the expression in other fields, and don't add notes inside them; put explanations in `why`.
4. `actions`: what to choose under *Then take action…*: Block / Managed Challenge / JS Challenge / Interactive Challenge / Skip / Log / Allow (IP access). For **Skip**, list each box to tick (*All remaining custom rules*, *All rate limiting rules*, *All managed rules*, *Bot Fight Mode*, specific managed rule IDs…) and only the ones needed. For an edit, also the current action.
5. `additionalConfig`: anything else on the form, or `none`: custom block response (status, content type, body), rate limit characteristics / requests / period / mitigation duration, *Log matching requests* on a skip rule, DNS type / content / proxied / TTL, purge URLs or prefixes, setting value.
6. `order`: where to place it: *First*, *Last*, or *Custom → after rule "<name>"* / *before rule "<name>"*, with why (a skip must sit **before** the rule it bypasses). Give the resulting position, e.g. "3 of 8". `n/a` for DNS, purge and settings.
7. `deploy`: `Save as Draft` or `Deploy` (enable immediately), with one line on why. Default: **Deploy** for a narrow allow / skip that fixes a reported block; **Save as Draft** when it needs the client's approval, is a wide change or a new block / challenge on prod (or Deploy with action *Log* first, then a later step to switch to Block after 24h of events). DNS, purge and settings have no draft: say `Immediate` and note propagation time.

Also set `why`, `risk` (prod zones, i.e. everything customer-facing, are `medium` or higher; an apex/www DNS change or turning the proxy off is `high`) and `reversible`, and add `rollback` to `params`: what to click to undo (disable / delete the rule *<name>*, restore the old expression, previous DNS value).

Rules of thumb:
- **Malicious traffic** (high `wafAttackScore`, bad bot score): don't plan an allow rule; explain and propose keeping the block.
- **Purge**: by URL or prefix, not *Purge Everything*, unless I asked.
- If the client must approve, add a `manual` step before the change for that approval.
- Finish with a **verify** step (`action: manual`): what to check after deploying, e.g. the `cloudflare_security_events` query (Ray ID, host/path, IP) that should show the request now passes, or the DNS lookup. Offer to run that check for me once I say it's done.

## 3. Propose
Call `propose_plan` once: `title`, `goal`, `org`, `ticketId` if this is for a ticket, the steps, `checks` (current rules / records you read, with their positions, and the impact numbers) and `assumptions`. Then one or two sentences: what changes for which traffic, and what I must confirm.
