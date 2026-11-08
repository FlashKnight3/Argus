# Verification

## Routine checks

```bash
npm run typecheck   # module, web, and agent
npm test            # agent unit tests (26) + web tests (9: search suggestions, CSV import, FDA matching)
npm run build
```

**Unit tests** (`agent/test/`):

- **Model:** pooled priors; zero-usage evidence; deterministic, ordered percentiles; stockout probability falling as stock rises; FDA lead-time stretching; risk classes; and backtest calibration on synthetic Poisson demand.
- **NDC:** 5-4-2 normalization, local 10-digit layouts, and match ranking.
- **Planner:** surplus bounds, multi-source fill with shared capacity, blocked routes, and unit mismatch.
- **Leases:** fair-share assignment, determinism, membership changes, and acquire/release decisions.
- **FDA ingestion:** stable keys, refusal of incomplete feeds, and dedupe.
- **Claude loop** (scripted fake client): strict schemas, tool execution, `is_error` rejections, the trace, fallback parameters, and refusal handling.

## End-to-end

```bash
npm run test:integration   # needs SpacetimeDB on :3000; uses the live FDA feed
```

This publishes the module to a fresh `argus-supply-verify-<timestamp>` database, runs two real workers in-process, and deletes the database afterwards. It checks, in order:

1. Base tables are private; views show members everything and outsiders nothing.
2. OIDC: anonymous and wrong-audience tokens cannot bootstrap; the verified owner creates the network, and an invited email joins with its assigned role and site. Outsiders cannot see private views.
3. Four leases split across two workers.
4. The full FDA feed is imported exactly once.
5. Forecasts arrive within seconds of an inventory change; the destination is critical.
6. A replayed operation ID is applied once.
7. A stale-revision edit is rejected as a conflict.
8. A stale epoch or a non-holder write is fenced.
9. An automatic agent run drafts a transfer within source surplus and suggests the FDA link, with a trace.
10. The service identity cannot approve stock movements.
11. Match acceptance and request → reserve → ship → receive work, and the destination count rises.
12. The linked item is re-forecast with an FDA-stretched lead time.
13. The scheduled sweep releases an expired reservation.
14. An equivalent product (two real FDA packages sharing an RxCUI) is drafted across NDCs, accepted, shipped, and received into the destination's own NDC item.
15. A killed worker's site lease moves to the survivor at a higher epoch, which resumes forecasting.

The integration test currently reports 16 checks, including the authenticated HTTP inventory endpoint. Its live FDA record count and failover time vary by run.

## Manual checks performed

- **Migration:** the existing `argus-supply` database (2 members, 3 inventory rows, 1 transfer, 1,581 notices) was migrated in place with identical row counts. The migration was first rehearsed on a scratch copy of the previous schema.
- **Sandbox:** the seeder built 6 real FDA shortage products × 4 synthetic sites with 971 usage events.
  - The agent drafted 3 transfers (including one to a site whose forecast was pooled) and reported 3 items with no internal source.
  - It suggested 5 FDA matches (exact 0.97, package-variant 0.75).
  - Calibration coverage was 93% and 73% at the first two sites.
- **Freeze test:** `SIGSTOP` on a worker for 16 s marked it offline and moved its 3 leases to the peer. On `SIGCONT` it rejoined and took back a fair share at epoch 3. No errors were logged.
- **Browser:** sandbox join, Overview, Agent (trace and review queue), System (workers, leases, calibration), and the Inventory detail (stockout meter, pooled badge, match suggestion) all rendered with live data and no app console errors.

## Not covered

- A live Claude API run. The loop is tested only with a scripted client, because no API key was available while it was built.
- Browser offline replay through a real disconnect. The server-side idempotency and conflict checks are tested end to end.
- Load beyond a handful of sites.
- Clinical validity of the thresholds.
