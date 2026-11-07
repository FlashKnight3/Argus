# Data sources, inference, and the transfer agent

## FDA source

The importer reads the [openFDA drug shortage endpoint](https://api.fda.gov/drug/shortages.json), documented by [openFDA](https://open.fda.gov/apis/drug/drugshortages/). It preserves the source's `package_ndc`, `generic_name`, `company_name`, `presentation`, `dosage_form`, `status`, `related_info`, `update_date`, and first `openfda.rxcui` when supplied. Each completed import stores `meta.last_updated`, count, and completion timestamp. The worker refreshes at most once per 24 hours while it stays running; an admin can sync on demand.

The FDA dataset is national and public. Its status is **not** proof a particular site has or lacks stock. It may change between pages or be revised later. The importer rejects an incomplete page count. FDA information is not for medical decisions; verify product equivalence and sourcing through approved clinical/pharmacy processes.

## Local inventory provenance

Sites enter actual counts, units, a baseline daily use rate, and a safety stock threshold. Every adjustment is timestamped with the actor's SpacetimeDB identity. The current product key uses only numeric NDC digits; the UI keeps the original FDA package NDC in the source record. Different package formats that reduce to the same digits will map to the same local key. A manager should confirm the package before linking. This is an operational quantity ledger, not an ERP purchase/order system.

## Forecast model

For each inventory item, the worker reads unreserved stock, the manager's baseline daily use, and recorded `use` events from the past 30 days. It uses a Gamma posterior for a Poisson demand rate:

```text
shape = max(0.5, baseline_per_day × 7) + observed_use
rate  = 7 + observed_days
sampled_days_of_supply = free_stock / sampled_daily_rate
```

The seven-day prior prevents one or two events from overwhelming a manager's baseline. The worker draws 1,200 deterministic samples per inventory revision and stores the 10th, 50th, and 90th percentile days of supply. `critical` means no free stock or a pessimistic (10th percentile) estimate of at most 7 days; `watch` is at most 21 days; otherwise `stable`. If positive stock exists but neither baseline nor usage exists, risk is `unknown`, with no fabricated demand estimate. These are **demand** intervals only: they do not model lead time, recalls, substitutions, allocation contracts, patient case mix, or shipment reliability. A pharmacist should validate inputs and interpretation.

## Bounded agent

The worker scans critical destinations with a positive baseline. It calculates a target of the larger of site safety stock and 21 days of baseline use. It considers only a different site with the **same canonical package NDC**, `stable` forecast risk, and free quantity above its own safety stock. It drafts at most one source for that destination product and caps quantity at the deficit and source surplus. Its explanation includes each site's pessimistic days of supply. Existing open transfers suppress drafts for the same destination product.

A draft cannot move stock. The destination must accept it as a request; the source must reserve and ship; the destination must record receipt. The database rechecks stock at every step. This is a deterministic decision agent with probabilistic demand input, not an autonomous prescribing or purchasing agent. No LLM is required or used.

## Future real integrations

The manual count entry can later be replaced or supplemented with an institution-approved feed from its inventory/ERP system, with per-site credentials, reconciliation, units and package conversion, failure alerts, and conflict handling. Public drug metadata can help normalize names but cannot provide live hospital counts. Do not claim “real-time hospital inventory” until an actual hospital system is connected and validated.
