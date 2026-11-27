---
name: triage-ticket
description: Triage a Zendesk ticket: summarise where it stands, who it is waiting on and how urgent it is, then recommend the next actions (reply, or which investigation skill to run) as buttons. Summary only: no draft reply and no investigation. Use when asked to triage, review or catch up on a ticket (Ask AI).
mon-model: haiku
mon-effort: high
mon-category: Tickets & replies
---

# Ticket triage

Input: a ticket number (e.g. `/triage-ticket 25348`). If none is given, use the highest-scoring ticket from my_tickets.

This skill **only summarises and recommends**. Do not draft a reply, do not load other skills, and do not run Cloudflare / Azure / ADO checks: I choose the next step from the buttons, and each one runs its own skill.

1. Load the ticket with `zendesk_ticket` and read the comments (internal notes too). Use `past_chats` only if the ticket refers to earlier work you need to understand it.
2. Reply with:
   - **Summary**: two or three sentences in plain language: what the customer asked and where it stands now.
   - **Waiting on**: me / customer / third party / a colleague (name them), and since when.
   - **Urgency**: SLA, priority, production impact, dates promised or go-lives mentioned.
   - **Known / unknown** (only for technical problems): what the ticket already establishes (errors, URLs, times, references such as a Ray ID or `x-azure-ref`) and what is still missing.
3. End with the recommended next actions, best first, **one per line, each on its own line exactly like this** (the app turns them into buttons):
   `Next: /<skill> <ticket number> [key details] — <why, in a few words>`

   Pick from these (1 to 4 lines; only the ones that fit):
   - `/draft-customer-reply` when the customer is waiting on us for an answer, an update or a request for information.
   - `/draft-internal-note` when a colleague needs to pick it up, help, decide or be brought up to speed (handover, escalation, status for the team).
   - `/check-cf-block` when Cloudflare blocks or challenges requests (403 / 1020 / challenge page / 429 from Cloudflare, a Ray ID, "CF is blocking", WAF). Add the hostname / Ray ID / path if known.
   - `/check-afd-block` when Azure Front Door or its WAF blocks requests ("The request is blocked", 403 from Front Door, an `x-azure-ref`). Add the reference / URL if known.
   - `/check-site-health` when a site is slow, down, timing out or returning 5xx, or there may be a traffic spike. Add the site and time window if known. For these tickets only, first call `incident_timeline` once with the ticket number and `host` = the affected site: if Site24x7 saw that site down or Squadcast has an Azure alert for the client around then, say so in one line under "where it stands" (e.g. "Site24x7: www.x.com down 14:01–14:25 AEST, 'Too many redirects'; Squadcast: CD 5xx alert 13:58") and put the window in the Next action. Don't call it for other tickets.
   - `/investigate-ticket` for any other technical fault (errors, caching, DNS, deployments, App Service, access or configuration), or when it's unclear which area is at fault.
   - `/investigate-root-cause` only when an earlier investigation did not explain the problem, the cause spans several systems, or production is affected with no clear lead.

   If nothing is needed from me (e.g. waiting on the customer and nothing is due), say so and give no Next line.

Example ending (plain lines, not inside a code block):

Next: /check-afd-block 25466 x-azure-ref 20261124T0510Z-17 — 403 "The request is blocked" from Front Door
Next: /draft-customer-reply 25466 — customer asked for an update yesterday
