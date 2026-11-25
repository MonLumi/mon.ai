---
name: plan-actions
description: Plan a request that needs changes in MORE THAN ONE system (e.g. fix a Cloudflare or Azure rule, commit the code, then reply on the ticket and set it to pending) and show it as ONE plan card. Use for multi-system changes on my behalf; for a change in one system use zendesk-actions, azure-actions, cf-actions or git-actions directly.
mon-model: opus
mon-effort: medium
mon-category: Actions
---

# Plan actions (coordinator)

Input: what I want done, e.g. `/plan-actions QBE: unblock Dynatrace on /api/health, then tell the customer on #25348 and set it to pending`. If no ticket is named and this is a ticket chat, use that ticket.

mon.ai can't run changes yet: you **propose** one plan with the `mcp__mon__propose_plan` tool (called `propose_plan` below), I review it. Never say something was done.

This skill holds no system details; the domain skills do. Your job is to split the request, follow each domain skill, and merge the result into **one** plan.

## Steps

1. **Split the ask** into outcomes and the system each belongs to:
   | System | Skill |
   |---|---|
   | Zendesk ticket (reply, note, status, assignee, fields, time) | `zendesk-actions` |
   | Azure resources, Front Door / WAF policy, ADO work items | `azure-actions` |
   | Cloudflare rules, DNS, cache, settings | `cf-actions` |
   | Code, config or pipelines in a repo; branches, commits, PRs | `git-actions` |
   | Anything only I can do (approval, call, portal-only step) | `manual` step |
   Plan only what I asked for. If only one system is involved, just follow that skill.
2. **Load each needed skill** with the Skill tool and follow its "read the current state" and "plan the steps" sections. **Do not** call `propose_plan` from inside a domain skill: collect its steps.
3. **Merge into one ordered plan**, by dependency:
   1. pre-checks and approvals (`manual`)
   2. infrastructure / Cloudflare / Azure changes, nonprod before prod
   3. code: branch → edits → commit → push → PR → deploy
   4. verify steps that prove the fix works
   5. **Zendesk last**: the internal note and customer reply describe what was done, then status, then time.
   The customer reply must not promise anything a later step might not deliver; if a change still needs approval, the reply says so.
4. **Call the `mcp__mon__propose_plan` tool once** (always: a plan written as text is not shown as a card) with `title`, `goal`, `ticketId` / `org`, all `steps`, the `checks` from every domain and all `assumptions`.
5. **Then reply in one or two sentences**: what the plan does across which systems, and what I must confirm.

If something essential is missing (environment, who to assign to, what to tell the customer), ask me instead of guessing.
