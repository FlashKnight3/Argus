# Architecture and distributed systems

## Components

| Component | Runtime | Job |
|---|---|---|
| `server/src/index.ts` | SpacetimeDB TypeScript module | Private tables, members-only views, reducers (atomic transactions), roles, leases and fencing, scheduled sweep |
| `agent/src/worker.ts` | Node (one process per worker) | Live subscription; heartbeats; lease reconciliation; forecasts, backtests, FDA import, and agent runs for the leases it holds |
| `agent/src/{model,planner,ndc,leases,fda,llm}.ts` | Pure TypeScript | Inference, bounded planning, NDC matching, lease assignment, feed ingestion, Claude tool loop |
| `web/src/supply` | React/Vite | Live views, data entry, offline queue, human review |
| `scripts/start-demo.sh` | Bash | Local stack: DB, N workers, optional sandbox seeding, web |

## Ledger state machine

Tables: `site`, `member`, `inventory`, `stock_event`, `shortage`, `sync_state`, `transfer`, `forecast`, `proposal`, `activity`, plus the coordination tables `network_config`, `worker`, `lease`, `sweep_job`, `op_receipt`, `agent_run`, `agent_step`, `match_suggestion`, and `model_metric`.

```text
requested → reserved → shipped → received
      ↘ cancelled  ↙        (reserved → cancelled automatically after the reservation TTL)
```

Free stock is `on_hand − reserved`. Approval reserves atomically; shipping removes on-hand and reserved stock together; receipt adds at the destination. Every quantity change writes a `stock_event`, and every business action writes an `activity` row.

## Work distribution: leases with fencing tokens

Work is partitioned into **resources**: `site:<id>` (forecasts and calibration for that site), `fda` (feed import), and `agent` (planning runs).

1. **Membership.** Each worker calls `worker_heartbeat` every 2 s. The scheduled `sweep` reducer (every 2 s, `sweep_job` table) marks workers silent for over 10 s `offline`.
2. **Assignment.** Every worker computes the same map from the same view: rendezvous hashing with a fair-share cap of ⌈resources / live workers⌉ (`agent/src/leases.ts`). A worker acquires the resources assigned to it when they're free or expired, and releases those assigned elsewhere. It only hands off between units of work, never mid-run.
3. **Leases.** `acquire_lease` grants a 10 s lease and **increments its epoch**. Heartbeats renew live leases. The sweep frees expired ones.
4. **Fencing.** Every worker write (`write_forecast`, `write_model_metric`, FDA import, agent steps, proposals, matches) carries `(workerId, epoch)`. The reducer rejects it unless that worker holds the lease *at that epoch* and it hasn't expired. A worker that was paused, partitioned, or garbage-collected and comes back late cannot overwrite the new owner's results.
5. **Failover.** When a worker dies or freezes, its leases expire, the survivors' assignment now includes those resources, and they acquire them at a higher epoch. Agent runs left `running` by an offline worker are re-queued (up to 3 attempts). An FDA import interrupted mid-run is restarted by the next `fda` holder.

Measured locally: a killed worker's site lease moved to the survivor in about 10 s (`npm run test:integration`). A worker frozen with `SIGSTOP` lost all its leases to its peer and took back a fair share at a new epoch when resumed.

## Event-driven processing

Workers subscribe to every view over WebSocket and react to inserts and deletes (debounced 200 ms) instead of polling. A forecast is recomputed when the item's revision, FDA status, pooled prior, day, or lease epoch changes, and at least every 10 minutes. Stale input is also rejected by revision: `write_forecast` requires the inventory revision the forecast was computed from.

## Human writes: idempotency, offline queue, conflicts

`upsert_inventory`, `record_stock`, and `create_transfer` take a client **operation ID**. The first application stores an `op_receipt` (kept 7 days); a replay with the same ID is a no-op. The browser (`web/src/supply/offline.ts`):

- queues these writes in `localStorage` when disconnected, or when a call isn't acknowledged within 8 s (outcome unknown);
- replays them in order on reconnect, so "retry until acknowledged" is safe;
- moves any write the server rejects on replay into a visible **conflict** list.

Inventory edits carry `expectedRevision`, the revision the person was looking at. If someone else changed the item first, the edit is rejected with a conflict instead of silently overwriting their count.

## Read access

Base tables are private. Members read through `*_view` views that return rows only when the caller is a member; outsiders see nothing but the public FDA feed, `sync_state`, and `network_status` (whether a network exists, and whether it is a sandbox).

## Limits

The database itself is a single SpacetimeDB node: there is no replication or cross-region consensus. The worker pool is fault-tolerant, but the database is not. Offline mode covers counts, usage, receipts, and transfer requests; approvals and shipments require a live connection because they must check current stock. The activity log is not tamper-proof against the database owner.
