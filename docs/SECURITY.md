# Security boundary

## What is enforced

The module checks SpacetimeDB caller identities inside every mutation reducer. The first caller can create a new network and becomes admin. Admins add sites and grant roles. Managers may adjust their assigned site's counts and act on its transfers. Viewers have read-only UI. The service worker can import FDA records and write forecasts/drafts; it cannot reserve, ship, receive, or cancel stock. Counts are validated against reservations and every transition is logged.

## What is not enforced

**Read confidentiality is not provided by this version.** Its tables are public to SpacetimeDB clients so the React app can subscribe to live state. A modified client may query the tables even if the UI shows Access Pending. UI gating is not a data access control. The first-connected-caller bootstrap pattern also assumes a trusted local setup process; do not expose an empty database to untrusted clients. SpacetimeDB local server starts on all interfaces by default, and the Vite development server is not a hardened web server.

Therefore, use only non-patient, non-sensitive operational test data on a trusted local network. Do not enter PHI, patient names, prescription details, confidential purchasing terms, or production facility inventory. Do not expose ports 3000 or 5173 to the public internet. The FDA feed itself is public, but local stock may be sensitive in a real facility.

## Before any hospital deployment

1. Move operational tables to private storage and expose authorization-filtered [SpacetimeDB views](https://spacetimedb.com/docs/functions/views/) or another server-side access layer. Verify cross-site read policy and prevent direct SQL disclosure. Experimental RLS is not used here.
2. Add institution-managed authentication, identity lifecycle/revocation, per-site tenancy, and service credential rotation. Persist browser tokens only under an approved storage policy.
3. Serve browser and database over TLS behind an authenticated gateway with network isolation. Restrict bind addresses and firewall rules.
4. Add consistent backups, restore drills, high-availability design, monitoring, alerting, retention, and an external append-only audit trail.
5. Validate NDC/package matching, units, transfer workflow, model thresholds, and FDA feed use with pharmacists, security, legal, and compliance teams. Perform a threat model and penetration test.

This checklist is a deployment boundary, not a claim that the current app satisfies clinical, privacy, or regulatory requirements.
