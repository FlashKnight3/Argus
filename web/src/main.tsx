import { StrictMode, useMemo, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { AuthProvider, useAuth } from 'react-oidc-context';
import { WebStorageStateStore } from 'oidc-client-ts';
import { SpacetimeDBProvider } from 'spacetimedb/react';
import App from './supply/App';
import { AUTH_ENABLED, OIDC_AUTHORITY, OIDC_CLIENT_ID, connectionBuilder } from './supply/connection';
import './index.css';

/** Connects to SpacetimeDB with the signed-in user's ID token (or anonymously), reconnecting when it changes. */
function Database({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const idToken = auth.user?.id_token;
  const builder = useMemo(() => connectionBuilder(idToken), [idToken]);
  if (auth.isLoading) return null;
  return <SpacetimeDBProvider key={idToken ? `user:${auth.user?.profile.sub}` : 'anonymous'} connectionBuilder={builder}>{children}</SpacetimeDBProvider>;
}

function NoAuthDatabase({ children }: { children: ReactNode }) {
  const builder = useMemo(() => connectionBuilder(), []);
  return <SpacetimeDBProvider connectionBuilder={builder}>{children}</SpacetimeDBProvider>;
}

const root = createRoot(document.getElementById('root')!);
root.render(<StrictMode>{AUTH_ENABLED
  ? <AuthProvider authority={OIDC_AUTHORITY} client_id={OIDC_CLIENT_ID} redirect_uri={`${window.location.origin}/callback`}
      post_logout_redirect_uri={window.location.origin} scope="openid profile email" response_type="code" automaticSilentRenew
      userStore={new WebStorageStateStore({ store: window.localStorage })}
      onSigninCallback={() => window.history.replaceState({}, document.title, '/')}>
      <Database><App /></Database>
    </AuthProvider>
  : <NoAuthDatabase><App /></NoAuthDatabase>}</StrictMode>);
