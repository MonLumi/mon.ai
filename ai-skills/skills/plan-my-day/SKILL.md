---
name: plan-my-day
description: Plan my working day from my open Zendesk tickets: order by urgency, group quick wins and give one next action each. Use when asked what to work on or to plan the day.
mon-model: haiku
mon-effort: medium
mon-category: Planning
---

# Plan my day

1. Get my open tickets with `my_tickets` and today's numbers with `daily_performance`.
2. Put tickets that need me (new/open) first, ordered by SLA risk, priority and how long the customer has waited. List pending/on-hold tickets separately, only if they need a nudge.
3. Group anything under ~15 minutes as **Quick wins**.
4. Output a numbered list: `#id – client – subject – next action`. Keep each line short.
5. End with one line on today's progress (tickets solved so far).
