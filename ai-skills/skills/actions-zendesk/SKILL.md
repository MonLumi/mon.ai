---
name: actions-zendesk
description: Plan Zendesk ticket changes on my behalf and show them as a plan card: post a public reply or internal note, change status (open / pending / solved), re-assign (group / agent), add followers or CCs, set Category, fields or tags, log time. Use when I ask you to reply, note, update, assign, pend, solve or log time on a ticket. Only Zendesk; for Azure, Cloudflare or code changes use azure-actions, cf-actions or git-actions.
mon-model: sonnet
mon-effort: medium
mon-category: Actions
---

# Zendesk actions

Input: a ticket number and what I want done, e.g. `/zendesk-actions 25348 tell them the fix is live and set to pending, log 15m`. In a ticket chat without a number, use that ticket.

mon.ai can't change tickets yet: you **propose** a plan with the `mcp__mon__propose_plan` tool (called `propose_plan` below), I review it. Never say anything was posted or changed.

## 1. Read the ticket first
`zendesk_ticket` (skip if this chat loaded it in the last few messages and nothing new came in). Note: status, priority, group, assignee, requester (first name), CCs and followers, Category and other required fields, the latest comment and who it's waiting on. Put what you checked in `checks`.

Stop and tell me instead of planning if:
- the ticket is already solved/closed and I didn't say to reopen it;
- someone else replied after the point I'm reacting to and it changes what to say (quote it briefly);
- it's assigned to someone else and I didn't ask to take it over (say so, offer a plan anyway if I confirm).

## 2. Steps, in this order (one change per step, only what I asked)

| Order | action | params / content |
|---|---|---|
| 1 | `zendesk_public_reply` | `content`: full reply text. `params.ccs` only if I asked to add/remove CCs (CCs can only change with a public reply). `risk: high`, `reversible: false`. |
| 1 | `zendesk_internal_note` | `content`: full note. `@Name` mentions a colleague (it also adds them as a follower). `risk: low`. |
| 2 | `zendesk_set_fields` | `params`: `{ "Category": "<exact option>" }`, other fields or `addTags` / `removeTags`. |
| 3 | `zendesk_assign` | `params`: `group` and/or `assignee` by name, as they appear in Zendesk. |
| 4 | `zendesk_add_followers` | `params.followers`: names. |
| 5 | `zendesk_set_status` | `params.status`: `open`, `pending` or `solved` (only these three). |
| 6 | `zendesk_log_time` | `params.minutes`: a number. |

Rules:
- A reply and a status change go in **one Zendesk update** when run; still list them as separate steps so I can review each.
- **Solved** needs Category (and any field Zendesk requires to solve). If it's empty, add a `zendesk_set_fields` step; if you can't tell which Category fits, put your best guess in `assumptions`.
- **Pending** means we're waiting on the customer: the reply must actually ask them something or tell them what we need. Otherwise plan `open` and say why in `assumptions`.
- Time: use what I said. If I didn't say, don't add a time step.
- Re-assigning: use names exactly as they appear on the ticket or in earlier comments; if you can't find the person or group, ask me.

## 3. Writing the reply or note
- **Public reply**: same rules as `/customer-reply`: greet the requester by first name; friendly, clear, Australian English; what we found or did → what happens next (time frame if known) → what we need from them. Link any ticket you reference. No internal details (tenant IDs, rule IDs, internal tools, colleagues' chat). No sign-off.
- **Internal note**: short and factual for a colleague: what was checked, the finding with evidence (Ray ID, resource, time in UTC and AEST/AEDT), what's next and who owns it.
- Plain text, verbatim, ready to post. No placeholders; anything unknown goes in `assumptions`.

## 4. Propose
Call `propose_plan` once: `title` (e.g. "Reply and pend #25348"), `goal`, `ticketId`, `org`, the steps, `checks`, `assumptions`. Then one or two sentences: what it does and what I must confirm.
