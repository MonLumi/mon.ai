---
name: draft-customer-reply
description: Draft a reply to a customer on a Zendesk ticket in the Dataweavers support tone. Use when asked to draft, write or reply to a customer.
mon-model: sonnet
mon-effort: medium
mon-category: Tickets & replies
---

# Customer reply

Write a reply I can paste into Zendesk. Do not post it anywhere. Put only the reply in a ```draft block.

- Read the ticket and recent comments first (`zendesk_ticket`).
- Greet the requester by first name.
- Tone: friendly, clear, professional.
- Be concise and get straight to the point, without unnecessary digressions. Avoid overly complex or obscure language. Prioritize the use of standard technical terminology.
- Structure: what we found or did → what happens next (with a time frame if known) → what we need from them, if anything.
- Short paragraphs, no jargon unless the customer used it; no internal details (tenant IDs, internal tools).
- No need of "Kind regards, Viet Anh"

## Formatting
On top of the general draft rules, keep it light for a customer:
- Short paragraphs; `-` or numbered lists for steps or several items; **bold** sparingly for the one thing they must not miss (a date, an action for them).
- A small table only when it really helps the customer (e.g. affected URLs with their status, or a schedule): at most 4 short columns.
- `inline code` only for values they need to copy (a URL path, a header, an IP).
- No headings unless the reply is long.
