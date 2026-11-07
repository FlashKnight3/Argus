import { DbConnection, type ErrorContext } from '../module_bindings';

/**
 * Default to the machine serving this page, so a medic tablet on the same
 * local Wi-Fi reaches the commander laptop's SpacetimeDB with no setup.
 */
export const HOST =
  import.meta.env.VITE_SPACETIMEDB_HOST ?? `ws://${window.location.hostname || 'localhost'}:3000`;
export const DB_NAME = import.meta.env.VITE_SPACETIMEDB_DB_NAME ?? 'argus';
const TOKEN_KEY = `argus:${HOST}/${DB_NAME}/token`;

function readToken(): string | undefined {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

export const connectionBuilder = DbConnection.builder()
  .withUri(HOST)
  .withDatabaseName(DB_NAME)
  .withToken(readToken())
  .withAutomaticReconnect()
  .onConnect((_conn, _identity, token) => {
    // Table subscriptions are opened by `useTable` in each component.
    try {
      localStorage.setItem(TOKEN_KEY, token);
    } catch {
      /* private mode — fine */
    }
  })
  .onConnectError((_ctx: ErrorContext, err: Error) => {
    console.warn('[argus] SpacetimeDB connection failed:', err.message);
  });
