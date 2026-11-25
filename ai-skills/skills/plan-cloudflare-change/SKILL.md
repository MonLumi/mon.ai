---
name: plan-cloudflare-change
description: Plan Cloudflare changes on my behalf and show them as a plan card: add or change WAF custom rules, skip / exception rules, managed-rule overrides, rate limits, IP access rules, DNS records, cache purges and zone settings. Use when I ask you to allow, unblock, block, whitelist, purge or change something in Cloudflare. Not for Azure Front Door (plan-azure-change), code (plan-code-change) or tickets (plan-ticket-change).
mon-model: opus
mon-effort: medium
mon-category: Actions
---

# Cloudflare actions

Input: the client or zone and what I want changed, e.g. `/plan-cloudflare-change QBE allow Dynatrace to /api/health` or `/plan-cloudflare-change ACU purge cache for www.acu.edu.au/news`. Often follows `/check-cf-block`: reuse its findings from this chat (rule, ruleset, Ray IDs, IPs) instead of looking again.

mon.ai can't change Cloudflare yet: you **propose** a plan with the `mcp__mon__propose_plan` tool (called `propose_plan` below), I review it. Never say anything was changed.

## 1. Read the current state (read-only)
- **Zone**: use the client code as the zone (custom hostnames like `www.qbe.com` live in the client's `*.saas.dataweavers.io` zone). `cloudflare_zones` only if unclear.
- **Rules**: `cloudflare_get` `zones/{zoneId}/rulesets` → the entry-point ruleset for the phase (`http_request_firewall_custom`, `http_request_firewall_managed`, `http_ratelimit`), then `zones/{zoneId}/rulesets/{id}`. Note every rule's position, description, expression and action. A new rule's position matters: skip rules must come **before** the rule they bypass.
- **DNS**: `zones/{zoneId}/dns_records?name=<host>` (type, content, proxied, TTL).
- **Settings**: `zones/{zoneId}/settings/<name>`.
- **Impact**: for a rule change, `cloudflare_security_top` on the same rule/host for the last 7 days, so the plan says how much traffic it affects.
- `past_chats` for the same kind of change on this client.

## 2. Plan the steps
`action: cloudflare_change`, one change per step. `params`:
- `zone` (name and ID), `kind` (`custom_rule`, `skip_rule`, `managed_override`, `rate_limit`, `ip_access_rule`, `dns`, `purge`, `setting`)
- `api`: the exact call it maps to: `method`, `path` (e.g. `zones/{id}/rulesets/{rulesetId}/rules`), `body` (JSON), `position` (`{"before": "<ruleId>"}`) when order matters
- `from` / `to`: current and new expression, action, record or setting
- `rollback`: how to undo (delete the new rule ID, restore the old expression, previous DNS content)

Rules of thumb:
- **Narrowest scope first**: match exact host + path + IP / ASN / user agent; never a whole-zone skip. Skip rules skip only the products needed (e.g. `phases: ["http_request_firewall_managed"]`, or specific rule IDs), not "all remaining custom rules" unless I said so.
- **New block or challenge rules**: propose `log` first with a step to review events after 24h, unless this is an active attack (then say so and block straight away).
- **Malicious traffic** (high `wafAttackScore`, bad bot score): don't plan an allow rule; explain and propose keeping the block.
- **DNS**: TTL and proxied flag explicit; changing an apex/www record or turning proxy off is `risk: high`. Note propagation time.
- **Purge**: by URL or prefix, not "purge everything", unless I asked.
- Prod zones (everything customer-facing) are `risk: medium` or higher. Add a `manual` step if the client must approve.
- Finish with a **verify** step: the `cloudflare_security_events` query (Ray ID, host/path, IP) that should show the request now passes, or the DNS lookup.

## 3. Propose
Call `propose_plan` once: `title`, `goal`, `org`, `ticketId` if this is for a ticket, the steps, `checks` (current rules / records you read and the impact numbers) and `assumptions`. Then one or two sentences: what changes for which traffic, and what I must confirm.
