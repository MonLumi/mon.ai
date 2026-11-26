---
name: draft-internal-note
description: Draft an internal note on a Zendesk ticket for Dataweavers colleagues (engineers who know the platform): where it stands, the evidence, my reasoning and hypotheses, ideas and options with trade-offs, and the next step with an owner, so a colleague can pick it up or act on it. Use when asked to draft or write an internal note, a handover, an escalation or a note for a colleague / the team.
mon-model: sonnet
mon-effort: high
mon-category: Tickets & replies
---

# Internal note

Write an internal note I can paste into Zendesk. Do not post it anywhere. Put the note itself in a ```draft fenced block (plain text, no > quote markers) so I can copy it in one click.

Input: a ticket number and optionally what the note is for, e.g. `/draft-internal-note 25466 handover to @Minh, he's on it tomorrow`. In a ticket chat without a number, use that ticket.

## Who reads it
Dataweavers engineers who know our platform well (Azure / Front Door, Cloudflare, App Service, ADO pipelines, the clients' stacks). Don't explain basics or define common terms. What they don't have is **my head**: what I checked, what I think is going on and why, and what I'd do next. The note must let a colleague understand the situation and act on it without asking me.

## 1. Gather first
- Read the ticket and all comments, internal notes included (`zendesk_ticket`; skip if this chat loaded it recently and nothing new came in).
- Use what this chat already found (investigations, tool output, plans). Don't re-run checks that are already in the chat.
- If the note needs a fact that isn't in the ticket or chat (a rule ID, a resource name, a recent deploy), do a quick targeted read-only check. Don't start a full investigation; if one is needed, say so as the next step.
- Work out the purpose: **handover** (someone else continues), **escalation / ask for help** (I need someone's input or access), **status / FYI** (record where it stands), or **decision needed**. If I didn't say, infer it from the ticket and say which you chose after the draft.

## 2. Structure (plain text; include a section only when it has something real)

Short label lines, then `-` bullets. Start with the one-line point of the note so a skimmer gets it immediately.

- **TL;DR**: one or two lines: the situation and what's needed from whom.
- **Context**: client, environment (prod / non-prod), affected host / URL / resource, impact, and how long it's been going on. What the customer actually wants (it may differ from what they asked).
- **What we know (evidence)**: facts with their proof: Ray ID, `x-azure-ref`, rule name and ID, resource name, subscription, KQL / command used, log line, commit or PR, times in UTC and AEST/AEDT. Keep identifiers exact so they can be searched.
- **What I think (reasoning)**: the working hypothesis and why the evidence points there; what's been ruled out and how; confidence (high / medium / low) and the one check that would confirm or kill it. Separate fact from inference clearly ("confirmed", "likely", "guess").
- **Ideas / options**: possible fixes or approaches, each with its trade-off (risk, effort, prod impact, needs change approval or customer sign-off, side effects on other sites / rules). Say which one I'd pick and why. Include the less obvious angles too: a related past ticket, a pattern across clients, a gotcha in this client's setup, a longer-term fix worth raising.
- **Next steps**: concrete actions in order, each with an owner (`@Name` mentions a colleague and adds them as a follower) and a time frame if known. Exact commands or settings where useful.
- **Customer side**: what the customer has been told so far and what was promised (dates, follow-ups), so nobody contradicts it. Who the ticket is waiting on.
- **Open questions / risks**: what's still unknown, what could go wrong, what not to touch.
- **Refs**: related tickets as https://support.dataweavers.com/hc/en-us/requests/[ticket_number] (no self reference), ADO work items / PRs, past chats or docs.

## 3. Style
- Australian English. Direct, collegial, engineer to engineer. Technical detail and internal details (tenant IDs, rule IDs, internal tools) are fine here.
- Dense but scannable: short bullets, no filler, no restating the ticket history line by line; summarise it and point to the comment that matters.
- Never invent evidence. If something is assumed or unverified, label it as such. Don't name a colleague as owner unless I or the ticket did; otherwise write "Owner: TBC".
- No greeting and no sign-off.
- If something important is unclear, list the open questions for me after the draft instead of guessing.

## 4. After the draft
One line saying the purpose you chose (handover / escalation / FYI / decision). If posting the note should go with a ticket change (assign, add follower, status), end with this line on its own (the app shows it as a button):
`Next: /plan-ticket-change <ticket number> post this internal note[, other changes] — <why>`
