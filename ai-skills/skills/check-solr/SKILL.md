---
name: check-solr
description: Check a customer's Solr (Solr SaaS on the Dataweavers AKS clusters) when Sitecore search or indexing misbehaves - search results missing or stale, index rebuild failing, "Solr is unavailable" / connection errors in Sitecore logs, xDB index errors, slow search: finds the client's instance by dw-id, checks pods and restarts, reads the Solr ERROR/WARN logs, links them to the Sitecore symptom and offers the Solr dashboard. Use when asked to check Solr, a Solr pod, Solr logs, the Solr dashboard or a Sitecore index problem.
mon-model: sonnet
mon-effort: medium
mon-category: Investigation
---

# Solr check (AKS Solr SaaS)

Goal: answer "Is Solr the problem, and what exactly is failing?" with evidence from the pods and the Solr logs.

## Input
At least one of:
- A Zendesk ticket number
- A client (code, alias or dw-id prefix) and environment (Prod, PreProd, UAT, Dev...)
- A dw-id (e.g. `acu-sc-xp-104-p1`) or namespace
- The Sitecore symptom or error text, and when it happened (with the customer's time zone)

## Steps
0. **Reuse first.** If a ticket is given, read it with `zendesk_ticket`. Check `past_chats` for "solr" plus the client.

1. **Find the instance** with `solr_instances` (client filter first; list without a filter if the prefix differs from the client code, e.g. Toyota = `tmca` / `tma`).
   - dw-id = `<client>-sc-<xp|xm|xmh|mvc>-<Sitecore version, 104 = 10.4>-<env code>[-<suffix>]`.
   - `environment` tells Prod / PreProd / NonProd: a `p`/`p1` code on a NonProd (`-np-`) cluster is **PreProd**. The UK cluster holds Prod and NonProd together.
   - Several instances can fit (e.g. `-lex` / `-tyt` brands, `-admin` copies, `p` and `p2`): pick the one the symptom points to, or ask. Say which one you checked.

2. **Health** with `solr_health`.
   - All Solr and ZooKeeper pods Running and ready, `readyReplicas` = `replicas`?
   - Restarts: when, and why (`OOMKilled` = heap or memory limit too small for the load; `Error` exit 137/143 = killed; recent restart matching the incident time).
   - Memory close to the limit, CPU pinned, warning events (FailedScheduling, Unhealthy probes, evictions, volume errors).

3. **Logs** with `solr_logs` (ERROR + WARN, window from the symptom; default 24h).
   - Pod restarted since the incident? Read `previous: true` too: the current container's log starts at the restart.
   - Narrow with `grep` on the core (`sitecore_web_index`, `sitecore_master_index`, `sitecore_xdb_index`...), `SolrException`, `OutOfMemory`, `ZooKeeper`, `recovery`, `Timeout`.
   - Startup-only WARNs (Jetty deprecations, "Trusting all certificates") are noise: skip them.

4. **Interpret** (link the Solr evidence to the Sitecore symptom):
   | Solr evidence | Likely Sitecore effect |
   |---|---|
   | `undefined field` / `unknown field` | Schema not populated or out of date for this Sitecore version: run "Populate Solr Managed Schema", then rebuild the index |
   | `Cannot find collection` / `core not found` / `no such core` | Index name or alias in Sitecore config does not match the collection (switch-on-rebuild aliases, `_rebuild` cores) |
   | `OutOfMemoryError`, `OOMKilled`, long GC | Indexing or rebuild fails mid-way, search timeouts; heap or memory limit too small |
   | `ZooKeeper` session expired / `KeeperErrorCode` / leader election | Writes rejected, replicas in recovery: indexing stops, search may serve stale results |
   | `recovery` / `RecoveryStrategy` repeating | A replica cannot catch up: stale or inconsistent results between requests |
   | `maxClauseCount` / `too many boolean clauses` | Large Sitecore queries (many templates / languages) fail |
   | `Timeout` / `Read timed out` / `503` | Sitecore logs "Solr unavailable"; check pod restarts and CPU at that time |
   | No errors, pods healthy | Solr is probably fine: look at Sitecore (CM/CD logs, index config, crawlers, the connection string / credentials) |

5. **Dashboard.** If the user should look at cores, schema, document counts or run a query themselves, call `offer_solr_dashboard` for the instance. Solr may ask for its admin sign-in (Basic auth).

## Output
1. **Verdict:** Solr healthy / degraded / down, and whether it explains the Sitecore symptom, with confidence (high / medium / low) and the one check that would confirm it.
2. **Instance:** dw-id, environment, cluster / namespace, Solr version, replicas ready.
3. **Evidence:** pod state and restarts, then the top log messages as a small table (level, count, first / last seen in UTC and Sydney time, core, message).
4. **Next steps**, narrowest first, each marked *user runs* and, for Prod, *needs client approval* where it affects the customer. Never claim anything was restarted or changed: changes (restart a pod, scale, change heap) go through `propose_plan` as manual steps.
5. If the customer needs an update, a short holding message in a draft block.
