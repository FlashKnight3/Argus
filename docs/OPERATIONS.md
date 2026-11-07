# Local operations and troubleshooting

## Start and stop

Run `npm ci` once, then `npm run demo` from the repository root. `Ctrl-C` stops the web process and worker started by that invocation. It leaves an already-running SpacetimeDB server alone and preserves `.spacetime/` data. The script publishes `argus-supply` with `--delete-data=never`; an incompatible schema update fails rather than wiping stock.

If port 5173 is busy, the script chooses the next free port. Read the printed URL. To choose a starting port, run `ARGUS_SUPPLY_WEB_PORT=5180 npm run demo`. The worker token is in `.argus-supply/service.json`. `npm run worker:identity` prints the identity to grant in Network. Do not delete this token without also updating the network membership.

Logs are under `logs/supply-YYYYMMDD-HHMMSS-PID/`: `spacetimedb.log` when this script starts the DB, `publish.log`, `worker.log`, and `web.log`. The worker logs unauthorized status until its identity receives the service role. It uses a validated system CA bundle for the FDA HTTPS request; `SSL_CERT_FILE` can specify a trusted bundle on platforms without one.

## Manual commands

```bash
spacetime start --data-dir .spacetime --non-interactive
npm run publish:local
npm run dev
npm run worker:identity
npm run worker
```

Use separate terminals for long-running commands. After a schema change, run `npm run generate` and `npm run build`. `scripts/publish-supply.sh` stages the module under the OS temporary directory to avoid stale or root-owned `server/dist` files. It never deletes an existing database.

For a non-default database endpoint, set `ARGUS_SUPPLY_DB_HOST` and `ARGUS_SUPPLY_DB_NAME` for the worker. Copy `web/.env.example` to `web/.env` and set `VITE_SPACETIMEDB_HOST` and `VITE_SPACETIMEDB_DB_NAME` for the browser. Use `wss://` and `https://` when placing a server behind TLS. The launcher itself targets the default local server and `argus-supply` database.

## What the common errors mean

| Symptom | Cause and action |
|---|---|
| `ERR_MODULE_NOT_FOUND ... magic-string` from Tailwind | Old Vite config loaded a damaged Tailwind dependency. The current Vite config no longer loads that plugin. If other packages are missing, run `npm ci`. |
| `logs/publish.log: Permission denied` | A prior run left root-owned log files. The launcher now creates a unique log directory for every run. |
| `tsc not found` | Dependencies were incomplete. Run `npm ci`; the published module uses its workspace TypeScript dev dependency. |
| `Connection refused` at `127.0.0.1:3000` | SpacetimeDB is not listening. Run `npm run demo`, then read `spacetimedb.log`. |
| `spacetime.pid already exists` | Another local SpacetimeDB process owns the data directory. Check port 3000 and the process before starting another instance. Do not delete the PID file while a process is alive. |
| Access Pending | The database already has an admin. Give that admin the browser identity shown on screen; clearing browser storage creates a new identity. |
| FDA sync stuck or failed | Check `worker.log`, network access, FDA rate limits, and `sync_state`. An admin can retry with the Sync button. Existing completed records remain visible. |
| Forecast pending | Grant the worker service access, enter a daily use baseline or usage, and check worker logs. A changed inventory revision requires recomputation. |

## Recovery and backups

Do not use `spacetime publish --delete-data` or `--delete-data=on-conflict` for this database. Back up `.spacetime/` with the server stopped or use a SpacetimeDB-supported consistent backup procedure before upgrades. Restore the data and the relevant identities together; browser and worker tokens control their grants. This repository does not include automated backup, replication, or disaster recovery.
