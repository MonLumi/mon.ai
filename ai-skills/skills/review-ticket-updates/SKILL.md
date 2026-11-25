---
name: review-ticket-updates
description: Catch up on new Zendesk comments in a ticket's chat (the ↻ Zendesk button): say briefly what changed and whether my next step changes, then recommend next actions as buttons. Short answer, no draft and no investigation.
mon-model: haiku
mon-effort: low
mon-category: Tickets & replies
---

# Ticket update

Input: `/review-ticket-updates <ticket number>` followed by the new comments since this chat last looked (already fetched for you; trimmed of quoted email history and signatures).

Keep it short: this runs often. Do **not** call any tools unless a new comment can't be understood without one (e.g. it only says "see attached"), do not re-summarise the whole ticket, and do not draft a reply.

Reply with:

- **What's new**: one bullet per new comment, a line each (who, what they said or did).
- **What changes**: one or two sentences: who the ticket is waiting on now, and whether the earlier conclusion or next step in this chat still holds.

Then end with the recommended next actions, best first, each on its own line exactly like this (the app shows them as buttons; plain lines, not in a code block):

Next: /<skill> <ticket number> [key details] — <why, in a few words>

Choose only what fits (0 to 3): `/draft-customer-reply` (the customer is waiting on us), `/check-cf-block`, `/check-afd-block`, `/check-site-health`, `/investigate-ticket`, `/investigate-root-cause` (as in /triage-ticket). If nothing is needed from me now, say so and give no Next line.
