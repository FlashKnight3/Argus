# Security boundary

## What is enforced

- **Sign-in.** People have accounts (email + password). Passwords are salted and hashed with 2,049 rounds of SHA-256 inside the module; plaintext is never stored. `sign_in` never throws on bad credentials, so failures are recorded: 5 in a row lock the account for 5 minutes (an admin reset unlocks it). Signing in binds the browser's SpacetimeDB identity to the account; signing out removes that binding. A member from before accounts existed must add an email before they can sign out, so nobody locks themselves out. Once a network exists (any account, member, or site), it can't be re-created.
- **Writes.** Every reducer checks the caller's role:
  - The first caller creates the network and becomes admin; admins create the other accounts.
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
- Passwords travel over the WebSocket to the database. Without TLS (`wss://`), anyone on the network path could read them. There is no email verification or self-service password reset; admins reset passwords.
- Password hashing is iterated SHA-256 (the module runtime has no bcrypt/argon2). That's adequate for a prototype, not for production; use institutional SSO.
- The SpacetimeDB local server listens on all interfaces, and Vite is a development server. Neither should be reachable from the internet.
- With the Claude agent enabled, network summaries (product names, NDCs, quantities, site names) are sent to the Anthropic API. Use rules mode (`ARGUS_AGENT_MODE=rules`) if that isn't acceptable.
- The activity log is not tamper-proof against the database owner.

Use only non-patient, non-sensitive test data. Don't enter PHI, prescription details, or confidential purchasing terms.

## Before any hospital deployment

1. Institutional SSO (SAML/OIDC) instead of local passwords, identity lifecycle, per-site read policy, and rotation of the service credential.
2. TLS and an authenticated gateway, network isolation, and restricted bind addresses.
3. Database backups, restore drills, replication or high availability, monitoring, and an external append-only audit trail.
4. Pharmacist, security, legal, and compliance review of NDC matching, units, model thresholds, agent behavior, and data sent to external APIs, plus a threat model and penetration test.
