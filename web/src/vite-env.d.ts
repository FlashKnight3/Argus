/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SPACETIMEDB_HOST?: string;
  readonly VITE_SPACETIMEDB_DB_NAME?: string;
  /** Set by scripts/start-demo.sh so an admin can grant the local worker in one click. */
  readonly VITE_ARGUS_WORKER_IDENTITY?: string;
  /** SpacetimeAuth client ID (from the Maincloud dashboard → SpacetimeAuth → Clients). Enables sign-in. */
  readonly VITE_SPACETIMEAUTH_CLIENT_ID?: string;
  /** OIDC authority; defaults to SpacetimeAuth. */
  readonly VITE_OIDC_AUTHORITY?: string;
}
