# Local operations and troubleshooting

## Start and stop

Run `npm ci` once.

- `npm run demo` runs the real network, `argus-supply`.
- `npm run sandbox` runs `argus-supply-sandbox` with synthetic data.

Both publish with `--delete-data=never` (an incompatible schema change fails rather than wiping stock), start `ARGUS_WORKERS` workers (default 2) named `worker-a`, `worker-b`, …, and serve the web app from port 5173 or the next free port (`ARGUS_SUPPLY_WEB_PORT` sets the start). `Ctrl-C` stops everything that invocation started. A SpacetimeDB server that was already running is left alone. Data lives in `.spacetime/`.

The worker token is in `.argus-supply/service.json` (all workers share this identity and differ by worker ID). `npm run worker:identity` prints it. The sandbox seeder has its own token in `.argus-supply/sandbox-seeder.json`. Keep both private, and don't delete `service.json` without updating membership.

Logs are written to `logs/supply-YYYYMMDD-HHMMSS-PID/` (only the 5 most recent runs are kept): `publish.log`, `worker-a.log`, `worker-b.log`, `seed.log` (sandbox), `web.log`, and `spacetimedb.log` (when the script started the database).

## Manual commands

```bash
spacetime start --data-dir .spacetime --non-interactive
npm run publish:local                       # or: bash scripts/publish-supply.sh <db>
npm run agent -- --name worker-a            # repeat in more terminals for more workers
npm run agent -- --db argus-supply-sandbox --mode rules
npm run sandbox:seed -- --db argus-supply-sandbox
npm run dev
```

**Environment variables:**

| Variable | Used by | Purpose |
|---|---|---|
| `ARGUS_SUPPLY_DB_HOST` | workers | Database host |
| `ARGUS_SUPPLY_DB_NAME` | workers | Database name |
| `ARGUS_AGENT_MODE` | workers | `auto`, `llm`, or `rules` |
| `ANTHROPIC_API_KEY` | workers | Enables the Claude agent |
| `ARGUS_AGENT_MODEL` | workers | Overrides the Claude model |
| `ARGUS_AGENT_EFFORT` | workers | Overrides the effort level |
| `VITE_SPACETIMEDB_HOST` | web | Database host (copy `web/.env.example` to `web/.env`) |
| `VITE_SPACETIMEDB_DB_NAME` | web | Database name |
| `SPACETIMEAUTH_CLIENT_ID` | launcher | Sets the browser client ID and the module's accepted OIDC audience |

After a schema change, run `npm run generate` then `npm run typecheck`. Adding columns requires a `.default(...)` so existing rows migrate.

## Sign-in and existing databases

- For a new real network, create a SpacetimeAuth client for the database and add `http://localhost:<web-port>/callback` as a redirect URI. Run `SPACETIMEAUTH_CLIENT_ID=client_… npm run demo`, then sign in and create the first site. The web port appears in the launcher output; it can change if 5173 is busy.
- Admins invite people by email in **Network → People**, then assign roles and sites. The invited person signs in through SpacetimeAuth with that email.
- An older local database may still contain `account` and `login_status` rows. The module retains these tables so a publish never deletes their data. With no OIDC client configured, the existing account holder can use the local email/password sign-in bridge; five failed attempts lock it for five minutes. No new local accounts are created.
- To move an existing admin to SpacetimeAuth, start with the client ID, open the existing browser identity, use the **Switch to SpacetimeAuth sign-in** banner to invite the desired email, then complete sign-in. Verify access before removing any old identity.
- Sandbox networks allow **Join sandbox** without a password.

## Getting data in

- **One product:** Inventory → **+**. Search a drug to fill in the name, NDC, and FDA link.
- **Daily usage:** Inventory → **Record usage**: enter used and received quantities for every product at a site, then **Save all**.
- **Bulk:** Inventory → **Import CSV** (download the template). Rows are validated and previewed; existing products are updated.

## Demonstrating the distributed behavior

- **Failover:** `kill <worker pid>`. Within about 10 s, System → Leases shows its resources at the survivor with a higher epoch, and the log shows `lease.acquire … taken over`.
- **Partition or pause:** `kill -STOP <pid>`, wait 15 s, then `kill -CONT <pid>`. The frozen worker is marked offline, loses its leases, and rejoins at new epochs. Any write it attempts under an old epoch is rejected (`Fenced`).
- **Offline browser:** stop SpacetimeDB or disconnect, record usage or edit a count (the chip shows *Offline · N queued*), then reconnect. The writes replay once. An edit made on a stale revision shows up as a conflict.
- **Reservation expiry:** set a small TTL in System → Settings, reserve a transfer, and watch the sweep cancel it and release the stock.

## Common problems

| Symptom | Cause and action |
|---|---|
| `tsc not found` / `Could not resolve 'spacetimedb/server'` | Incomplete `node_modules`. The demo script now detects this and runs `npm ci`. |
| `Cannot remove table account: table contains data` | The published module removed an old table while your database still has accounts. Update to the compatibility schema in this repo, then rerun `npm run demo`. Keep `--delete-data=never`; do not wipe the database. |
| `npm ci` fails with `EACCES` | Some `node_modules` or npm cache files were installed as root. Restore ownership to your user, or use a separate npm cache; avoid running npm with `sudo`. |
| `Missing spacetime` | The CLI is in `~/.local/bin`; the scripts add it, but check your installation. |
| Worker log: "Waiting for the service role" | An admin must grant the worker identity (Activate FDA worker, or Network). |
| Access Pending | The network already has an admin; give that admin the identity shown on screen. In a sandbox, use Join sandbox as admin. |
| No agent runs | Check that a worker holds the `agent` lease (System), that auto-run is on, and that items have forecasts. Runs fire only once forecasts are current. |
| Claude errors in a run trace | Bad or missing key, or rate limits. The run falls back to the deterministic planner automatically. |
| Calibration empty | Needs about three weeks of recorded usage per site. |
| `spacetime.pid already exists` | Another SpacetimeDB process owns `.spacetime/`. Check port 3000 before starting another. |

## Recovery

Never publish with `--delete-data` for `argus-supply`. Back up `.spacetime/` with the server stopped before upgrades, and restore it together with `.argus-supply/` tokens. Browser identities live in browser storage, and clearing it creates a new identity.
