# Architecture and distributed systems

## Components

| Component | Runtime | Job |
|---|---|---|
| `server/src/index.ts` | SpacetimeDB TypeScript module | Authoritative tables, reducers, validation, roles, state transitions |
| `web/src/supply` | React/Vite browser | Real-time subscriptions, data entry, human review |
| `web/src/supply_bindings` | Generated SpacetimeDB client | Typed reducer and table interface; regenerate after schema changes |
| `worker/argus_supply.py` | Python 3 standard library | FDA ingestion, demand inference, bounded transfer drafts |
| `scripts/start-demo.sh` | Bash | Local startup, safe publish, worker/web process control |

## State machine and invariants

SpacetimeDB holds ten tables: `site`, `member`, `inventory`, `stock_event`, `shortage`, `sync_state`, `transfer`, `forecast`, `proposal`, and `activity`. All writes go through reducers. A reducer runs as an atomic transaction; failure leaves stock and transfer state unchanged.

`inventory.key = site_id + ':' + canonical_digits(package_ndc)` identifies a product at a site. `on_hand` is the counted quantity. `reserved` is approved but unshipped transfer stock. Free stock is `on_hand - reserved`; it cannot become negative through a valid usage or reservation reducer.

```text
requested → reserved → shipped → received
      ↘ cancelled  ↙
```

- `create_transfer`: destination manager (or admin) requests; no stock is committed.
- `approve_transfer`: source manager (or admin) checks free stock and increases `reserved` atomically.
- `ship_transfer`: source decreases both `on_hand` and `reserved`, and writes a stock event.
- `receive_transfer`: destination increases its count or creates the product record, then closes the transfer.
- `cancel_transfer`: allowed only before shipment; a reserved cancellation releases the reservation.

Business actions write an `activity` entry; every quantity change writes a `stock_event`. Per-record FDA imports and forecast recomputations do not emit separate activity rows. For production, an external append-only audit sink and retention policy would be needed. The current activity table is not tamper-proof against a database owner.

## Consistency and concurrency

The database serializes reducers. Two simultaneous source approvals cannot both reserve the same free units because each reducer checks current `on_hand - reserved` inside its transaction. The browser sees server changes through live subscriptions, so separate sites converge on the committed state. Connectivity loss pauses the UI; there is no offline write queue. The local SpacetimeDB server is one node, not a replicated high-availability cluster.

Inventory `revision` increases on count, usage, receipt, reservation, and shipment. The worker reads a revision with its inputs and sends it with `write_forecast`. The reducer rejects stale forecasts. A retry computes again from fresh state. Proposal keys hash source/destination inventory keys and revisions; this prevents a retry from duplicating a draft for the same state. The agent also avoids drafting while an open transfer already exists for the destination product.

## FDA import protocol

The worker first downloads **all** openFDA pages, checking the declared total and source update date. It then starts a run (`begin_fda_sync`), imports batches of at most 100 (`import_fda_batch`), and commits the snapshot (`finish_fda_sync`). Each source row has a stable hash of package NDC, generic name, company, and presentation, so replaying a batch updates the same row. On a completed run, records not present in the new feed are marked inactive. A failed partial run leaves the last completed feed date in the table, with `sync_state.status` still `running`; some row values may already have changed. A production connector should stage an entire snapshot privately and swap it atomically.

The browser admin can trigger the same bounded import flow as a fallback. Only admins/service identities may call the import reducers. The worker's service role cannot call human transfer reducers.

## Operational boundaries

This is a functional **single-server distributed application**: multiple browsers and a separate worker coordinate through one transactional database and live subscriptions. It demonstrates state ownership, optimistic version checks, role-scoped write paths, idempotent ingestion, bounded agent outputs, and explicit human approval. It does not claim cross-region consensus, durable message queues, offline conflict resolution, or hospital-grade availability.
