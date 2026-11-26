---
name: draft-customer-reply
description: Draft a reply to a customer on a Zendesk ticket in the Dataweavers support tone. Use when asked to draft, write or reply to a customer.
mon-model: sonnet
mon-effort: medium
mon-category: Tickets & replies
---

# Customer reply

Write a reply I can paste into Zendesk. Do not post it anywhere. Put the reply itself in a ```draft fenced block, written in Markdown (see Formatting), so I can copy it in one click.

- Read the ticket and recent comments first (`zendesk_ticket`).
- Greet the requester by first name.
- Tone: friendly, clear, professional; Australian English spelling.
- Be concise and get straight to the point, without unnecessary digressions. Avoid overly complex or obscure language. Prioritize the use of standard technical terminology.
- The reference ticket in the reply should include link https://support.dataweavers.com/hc/en-us/requests/[ticket_number] to it. The link text should be ticket title, not URL. No self ticket reference
- Structure: what we found or did → what happens next (with a time frame if known) → what we need from them, if anything.
- Short paragraphs, no jargon unless the customer used it; no internal details (tenant IDs, internal tools).
- If something is unclear, list the open questions for me after the draft instead of guessing.
- No need of "Kind regards, Viet Anh"

## Formatting
The draft is Markdown that the app shows and copies formatted, exactly as the Update ticket rich editor writes it, so pasting it there keeps the formatting. Use only what that editor has, and keep it light for a customer:
- Short paragraphs; `-` or numbered lists for steps or several items; **bold** sparingly for the one thing they must not miss (a date, an action for them).
- Links with display text, never a bare long URL: `[Login page returns 403](https://support.dataweavers.com/hc/en-us/requests/25466)`.
- A small table only when it really helps the customer (e.g. affected URLs with their status, or a schedule): a header row, at most 4 short columns.
- `inline code` only for values they need to copy (a URL path, a header, an IP). If the draft needs a code block, open the draft with four backticks (````draft … ````) so the inner ``` fence doesn't close it.
- No headings unless the reply is long, no HTML tags, no images, no `>` quotes.
