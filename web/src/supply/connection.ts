import { DbConnection, type ErrorContext } from '../supply_bindings';

export const DB_NAME = import.meta.env.VITE_SPACETIMEDB_DB_NAME ?? 'argus-supply';
export const HOST = import.meta.env.VITE_SPACETIMEDB_HOST ?? `ws://${window.location.hostname || 'localhost'}:3000`;
const TOKEN_KEY = `argus-supply:${HOST}/${DB_NAME}/token`;

function readToken(): string | undefined {
  try { return localStorage.getItem(TOKEN_KEY) ?? undefined; }
  catch { return undefined; }
}

export const connectionBuilder = DbConnection.builder()
  .withUri(HOST)
  .withDatabaseName(DB_NAME)
  .withToken(readToken())
  .withAutomaticReconnect()
  .onConnect((_conn, _identity, token) => {
    try { localStorage.setItem(TOKEN_KEY, token); }
    catch { /* Private browsing may block storage. */ }
  })
  .onConnectError((_ctx: ErrorContext, error: Error) => {
    console.warn('[argus-supply] connection:', error.message);
  });
