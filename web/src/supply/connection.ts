import { DbConnection, type ErrorContext } from '../supply_bindings';

export const DB_NAME = import.meta.env.VITE_SPACETIMEDB_DB_NAME ?? 'argus-supply';
export const HOST = import.meta.env.VITE_SPACETIMEDB_HOST ?? `ws://${window.location.hostname || 'localhost'}:3000`;

/** SpacetimeAuth (OIDC). Sign-in is enabled when a client ID is configured. */
export const OIDC_AUTHORITY = import.meta.env.VITE_OIDC_AUTHORITY ?? 'https://auth.spacetimedb.com/oidc';
export const OIDC_CLIENT_ID = import.meta.env.VITE_SPACETIMEAUTH_CLIENT_ID ?? '';
export const AUTH_ENABLED = !!OIDC_CLIENT_ID;

/** Anonymous identity: used for sandbox browsing and for members from before sign-in existed. */
const ANON_KEY = `argus-supply:${HOST}/${DB_NAME}/token`;
function anonymousToken(): string | undefined {
  try { return localStorage.getItem(ANON_KEY) ?? undefined; } catch { return undefined; }
}
export function forgetAnonymousIdentity() {
  try { localStorage.removeItem(ANON_KEY); } catch { /* storage unavailable */ }
}

/**
 * With an ID token, SpacetimeDB verifies it against the issuer and derives the identity from
 * (issuer, subject): the same person gets the same identity on every device.
 */
export function connectionBuilder(idToken?: string) {
  return DbConnection.builder()
    .withUri(HOST)
    .withDatabaseName(DB_NAME)
    .withToken(idToken ?? anonymousToken())
    .withAutomaticReconnect()
    .withConfirmedReads(true)
    .onConnect((_conn, _identity, token) => {
      if (idToken) return; // the OIDC token is managed by the auth library
      try { localStorage.setItem(ANON_KEY, token); } catch { /* private browsing */ }
    })
    .onConnectError((_ctx: ErrorContext, error: Error) => {
      console.warn('[argus-supply] connection:', error.message);
    });
}
