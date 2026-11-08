import { useAuth } from 'react-oidc-context';
import { AUTH_ENABLED, forgetAnonymousIdentity } from './connection';

export interface Session {
  /** SpacetimeAuth is configured for this deployment. */
  enabled: boolean;
  signedIn: boolean;
  email: string;
  name: string;
  error: string;
  signIn: () => void;
  signOut: () => Promise<void>;
}

const DISABLED: Session = { enabled: false, signedIn: false, email: '', name: '', error: '', signIn: () => {}, signOut: async () => {} };

/** Sign-in state from SpacetimeAuth. AUTH_ENABLED is a build-time constant, so the hook order never changes. */
export function useSession(): Session {
  if (!AUTH_ENABLED) return DISABLED;
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const auth = useAuth();
  const profile = auth.user?.profile;
  return {
    enabled: true,
    signedIn: !!auth.user && !auth.user.expired,
    email: typeof profile?.email === 'string' ? profile.email : '',
    name: (profile?.name ?? profile?.preferred_username ?? '') as string,
    error: auth.error?.message ?? '',
    signIn: () => { void auth.signinRedirect(); },
    signOut: async () => { await auth.removeUser(); forgetAnonymousIdentity(); window.location.assign('/'); },
  };
}
