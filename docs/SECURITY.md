# Security boundary

## What is enforced

- **Writes.** Every reducer checks the caller's SpacetimeDB identity and role:
  - The first caller creates the network and becomes admin.
  - Admins manage sites, grants, revocations, and policies.
  - Managers act on their own site; viewers are read-only.
  - Service workers may import FDA records, write forecasts and metrics, and draft proposals and matches, and only while holding the matching lease at the current epoch.
  - No service or agent path can reserve, ship, receive, or cancel stock.
- **Reads.** Operational tables are private. Members read through views that return rows only when the caller is a member. Non-members see only the public FDA feed, `sync_state`, and `network_status`. An integration test checks that an outsider gets nothing from the views and can't query private tables.
- **Integrity.** Writes are idempotent by operation ID; inventory edits are revision-checked; forecast writes are revision-checked and fenced.
- **Sandbox isolation.** Self-service admin claims and synthetic history backfill are refused unless the network was created with `bootstrap_sandbox`. The seeder refuses database names without "sandbox".

## What is not enforced

- All members can read the whole network, including other sites' stock, because cross-site coordination depends on it. There is no per-site read isolation.
- Bootstrap trusts the first caller. Don't expose an empty database to untrusted clients.
- The SpacetimeDB local server listens on all interfaces, and Vite is a development server. Neither should be reachable from the internet.
- With the Claude agent enabled, network summaries (product names, NDCs, quantities, site names) are sent to the Anthropic API. Use rules mode (`ARGUS_AGENT_MODE=rules`) if that isn't acceptable.
- The activity log is not tamper-proof against the database owner.

Use only non-patient, non-sensitive test data. Don't enter PHI, prescription details, or confidential purchasing terms.

## Before any hospital deployment

1. Institution-managed authentication, identity lifecycle, per-site read policy, and rotation of the service credential.
2. TLS and an authenticated gateway, network isolation, and restricted bind addresses.
3. Database backups, restore drills, replication or high availability, monitoring, and an external append-only audit trail.
4. Pharmacist, security, legal, and compliance review of NDC matching, units, model thresholds, agent behavior, and data sent to external APIs, plus a threat model and penetration test.
