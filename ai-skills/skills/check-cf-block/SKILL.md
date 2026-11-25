---
name: check-cf-block
description: Find out why Cloudflare blocks or challenges requests (403, 1020, captcha / managed challenge, rate limit, WAF) using Security Events: identify the rule, its expression, who and what is affected, and the safe fix. Use when asked why Cloudflare / CF / the WAF is blocking or challenging a request, a Ray ID, an IP, an API or a page.
mon-model: sonnet
mon-effort: medium
mon-category: Security & blocking
---

# Cloudflare block check

Input: a ticket number, Ray ID, URL, IP or client code (e.g. `/check-cf-block 25466`, `/check-cf-block a5f72d9b6cd26ba6-SYD`). If a ticket is given, read it with `zendesk_ticket` first and pull out the Ray ID(s), URL / host / path, client IP, method, error (403, 1020, challenge page, 429) and when it happened. If this chat already has the ticket, don't reload it.

## Steps

1. **Zone**: use the client code as `zone` (custom hostnames such as `www.qbe.com` live in the client's `*.saas.dataweavers.io` zone). Use `cloudflare_zones` only if the client is unclear.
2. **Find the events**
   - With a Ray ID: `cloudflare_security_events` with `rayId`. One request can match several rules (e.g. a skip, then a block); list them all in order of `matchIndex`.
   - Without one: `cloudflare_security_events` filtered by `host`, `path` and/or `clientIP`, limited to the reported time window (`since` / `until`, or `hours`). If nothing comes back, widen the time window, drop the path, or add `includeSkip: true`.
   - If still nothing: say the request probably never reached a Cloudflare security rule (look at origin, AFD WAF, or the app instead) and stop.
3. **Measure the impact** with `cloudflare_security_top` for the same rule (`ruleId`) and time window:
   - `by: ["clientRequestHTTPHost","clientRequestPath"]`: what is being hit
   - `by: ["clientIP","clientASNDescription","clientCountryName"]`: who: one tester, the customer's network, a vendor (e.g. Dynatrace, a payment provider), bots?
   - `by: ["datetimeHour"]`: when it started. A sudden start usually matches a rule or deployment change.
4. **Read the rule**: get `zones/{zoneId}/rulesets/{rulesetId}` with `cloudflare_get` and quote the matching rule's `description`, `expression`, `action` and `last_updated`. For managed rules (`source` firewallManaged / waf) give the rule ID and the category; for rate limits (`ratelimit`) give the threshold and period.
5. **Decide whether it's legitimate**: compare the blocked traffic with what the customer expects (their IP ranges, user agents, an API client, a monitoring tool). Check `botScore`, `verifiedBotCategory` and `wafAttackScore`: genuine attack traffic should stay blocked.
6. **Check history**: search `past_chats` with the client code and the rule's description; reuse an earlier fix if it matches.

## Answer format

- **Verdict**: blocked by *which rule* (description, ruleId, source, action), at what time, for which host / path, and whether that is correct or a false positive.
- **Evidence**: the event(s) (Ray ID, time UTC and local, IP / ASN / country, method + path, status) and the impact numbers from step 3 in a small table.
- **Rule**: the expression and why it matched this request.
- **Fix** (for me to apply; mon.ai is read-only), the narrowest safe option first: an exception / skip rule scoped to the exact host + path + IP or ASN, a corrected expression, or a managed-rule override for that rule ID only. Give the exact expression to paste, which ruleset or phase to put it in and its position, and note prod vs non-prod and whether the change needs the client's approval. If the traffic is malicious, recommend keeping the block and explain why.
- **Customer note**: one or two plain sentences for the reply.
- **Next step**: end the answer with exactly one line on its own (the app shows it as a button):
  - no matching events, or the block can't be explained by the Cloudflare rules (e.g. it may come from Front Door WAF, the origin or the app) → list what is still unknown, then `Next: /investigate-root-cause <ticket number>`
  - cause found and the customer needs a reply → `Next: /draft-customer-reply <ticket number>`
  - otherwise no Next line.
  If there is no ticket number, put the Ray ID or host after the skill name instead.
