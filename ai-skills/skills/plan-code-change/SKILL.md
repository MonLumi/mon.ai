---
name: plan-code-change
description: Plan code and repository changes on my behalf and show them as a plan card: edit files (config, pipelines, rewrites, app settings in code), create a branch, commit, push, open a pull request, pull or switch branches in my local repos. Use when I ask you to change, fix, update or commit code, YAML or config in a repo, or to raise a PR. Not for live Azure or Cloudflare changes (plan-azure-change, plan-cloudflare-dashboard-change) or tickets (plan-ticket-change).
mon-model: opus
mon-effort: medium
mon-category: Actions
---

# Git / code actions

Input: the repo (or client) and what I want changed, e.g. `/plan-code-change ACU add the new redirect for /old-courses to the CD rewrite rules` or `/plan-code-change CQU bump the pipeline agent to windows-2025`.

mon.ai can't change files or run git yet: you **propose** a plan with the `mcp__mon__propose_plan` tool (called `propose_plan` below), I review it. Never say anything was edited or committed.

## 1. Find the repo and read the code
- `git_repos` (filter by `org`) → the repo path, current branch, pending changes, ahead/behind. Pipelines and infra usually live in the client's `*DW-Pipelines` repo.
- **If the repo has uncommitted changes or is behind its remote**, say so in `checks`; plan a `pull` first, and never plan over my uncommitted work.
- `git_log` for recent commits on the files you'll touch (who changed them, why).
- `Grep` / `Glob` / `Read` to find every place that needs the change, and read enough around it to match the file's style. Check whether the same setting exists per environment (e.g. `*.prod.yml` vs `*.nonprod.yml`, transforms, `.env` files).
- `past_chats` for the same change before.

## 2. Plan the steps
`action: git`, in this order:
1. **Branch**: `params`: `repo`, `command: ["switch","-c","<branch>"]` from the up-to-date default branch. Name: `fix/<ticket>-<short-desc>` or `feature/<short-desc>`.
2. **One step per file edited**: `params`: `repo`, `file` (path relative to the repo), `kind: edit | create | delete`. Put the change in `content` as a **unified diff** (`--- a/…` / `+++ b/…` / `@@` hunks with a few lines of context), exact and complete, so it can be applied as-is. No "…" or placeholders.
3. **Commit**: `params.command: ["commit","-am","<message>"]`; message style matches `git_log` (often `#<ticket> <what>` or the ADO work item `AB#1234`).
4. **Push**: `["push","-u","origin","<branch>"]`.
5. **Pull request** (`action: ado_update` for ADO repos): `params`: `org`, `project`, `repo`, `source`, `target` (default branch), `title`, reviewers if I named them; PR description in `content`.

Rules:
- **Never** plan a push straight to `main` / `master` / `release/*`, a force push, a rebase of a shared branch or a history rewrite, unless I asked explicitly (then `risk: high`).
- Secrets: never put keys, passwords or connection strings in a diff. If the change needs one, add a `manual` step (Key Vault / pipeline variable / library) and reference it by name.
- If the change only takes effect after a pipeline run or deployment, add a `manual` step for that (which pipeline, which environment), or say that plan-azure-change should plan the deploy.
- Edits to pipelines, infra (Bicep/ARM/Terraform) or prod config are `risk: medium` or higher; say what they affect in `why`.
- Add a **verify** step: how to check it (build/pipeline to watch, the URL or setting to look at after deploy).

## 3. Propose
Call `propose_plan` once: `title`, `goal`, `org`, `ticketId` if any, the steps, `checks` (repo state and the files/lines you read) and `assumptions`. Then one or two sentences: what changes and what I must confirm (branch name, target, reviewers).
