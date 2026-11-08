/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SPACETIMEDB_HOST?: string;
  readonly VITE_SPACETIMEDB_DB_NAME?: string;
  /** Set by scripts/start-demo.sh so an admin can grant the local worker in one click. */
  readonly VITE_ARGUS_WORKER_IDENTITY?: string;
}
