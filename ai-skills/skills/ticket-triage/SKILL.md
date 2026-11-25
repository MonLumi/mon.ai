---
name: ticket-triage
description: Triage a Zendesk ticket: summarise where it stands, who it is waiting on and how urgent it is, then recommend the next actions (reply, or which investigation skill to run) as buttons. Summary only: no draft reply and no investigation. Use when asked to triage, review or catch up on a ticket (Ask AI).
mon-model: sonnet
mon-effort: medium
mon-category: Tickets & replies
---

# Ticket triage

Input: a ticket number (e.g. `/ticket-triage 25348`). If none is given, use the highest-scoring ticket from my_tickets.

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
   - `/customer-reply` when the customer is waiting on us for an answer, an update or a request for information.
   - `/cf-block-check` when Cloudflare blocks or challenges requests (403 / 1020 / challenge page / 429 from Cloudflare, a Ray ID, "CF is blocking", WAF). Add the hostname / Ray ID / path if known.
   - `/afd-block-check` when Azure Front Door or its WAF blocks requests ("The request is blocked", 403 from Front Door, an `x-azure-ref`). Add the reference / URL if known.
   - `/health-check` when a site is slow, down, timing out or returning 5xx, or there may be a traffic spike. Add the site and time window if known.
   - `/investigate` for any other technical fault (errors, caching, DNS, deployments, App Service, access or configuration), or when it's unclear which area is at fault.
   - `/deep-investigate` only when an earlier investigation did not explain the problem, the cause spans several systems, or production is affected with no clear lead.

   If nothing is needed from me (e.g. waiting on the customer and nothing is due), say so and give no Next line.

Example ending (plain lines, not inside a code block):

Next: /afd-block-check 25466 x-azure-ref 20261124T0510Z-17 — 403 "The request is blocked" from Front Door
Next: /customer-reply 25466 — customer asked for an update yesterday
