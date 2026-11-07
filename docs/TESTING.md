# Verification

## Routine checks

```bash
npm run build
npm run typecheck
npm test
```

The worker unit tests cover stable FDA keys, incomplete pagination rejection, deterministic and ordered forecast percentiles, and the unknown-demand case. The web build runs strict TypeScript and Vite. The SpacetimeDB module is compiled as part of `npm run demo` or `npm run publish:local`.

## Isolated integration run

`worker/tests/integration_local.py` targets a **separate** local database and never writes sample stock into `argus-supply`:

```bash
bash scripts/publish-supply.sh argus-supply-verify-new
ARGUS_VERIFY_DB=argus-supply-verify-new python3 worker/tests/integration_local.py
```

Use a fresh name for each run. The publish script stages the module to avoid root-owned `server/dist` output. The test creates two sample sites in that isolated database, grants a separate service identity, imports the **complete live FDA feed**, computes forecasts, checks an agent draft, verifies the service cannot approve a transfer, then exercises acceptance, reservation, shipment, and receipt. It rejects mismatched units both when requesting and receiving stock. It checks source reservations return to zero and destination count increases by the shipped quantity. Delete only the disposable verification database afterward with `spacetime delete argus-supply-verify-new --server local --yes`.

On 2026-11-07, this end-to-end run passed with **1,581 unique real FDA records** from a feed marked updated 2026-11-06. Counts and statuses will change as the source changes. The test does not validate clinical equivalence or production deployment security.

## Browser check

An isolated local browser walkthrough confirmed network creation, persistence after reload, and overview dashboard rendering. The main `argus-supply` database already had an admin identity during verification, so a new browser correctly reached its Access Pending screen. The isolated browser test used `argus-supply-ui-verify`; no sample stock was added to the main database. The live reducer integration test covers the data flows behind the other screens.
