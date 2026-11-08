import { useState, type FormEvent, type ReactNode } from 'react';
import { FlaskConical, LogIn, LogOut, RefreshCw } from 'lucide-react';
import { errorText } from './ui';
import type { Session } from './session';
import type { SupplyActions, SupplyState } from './useSupply';

export function Logo() {
  return <div className="logo"><div className="logo-mark">A</div><div><b>ARGUS</b><small>SUPPLY NETWORK</small></div></div>;
}

function AuthCard({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return <div className="auth"><div className="auth-card"><Logo /><h1>{title}</h1><p>{subtitle}</p>{children}
    <div className="auth-foot">Operations prototype · no patient records · not for medication or treatment decisions</div></div></div>;
}

function SignInButton({ session }: { session: Session }) {
  return <button className="button primary wide" onClick={session.signIn}><LogIn size={15}/> Sign in with SpacetimeAuth</button>;
}

function SandboxJoin({ actions }: { actions: SupplyActions }) {
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  return <><div className="auth-divider">or explore the sandbox</div>
    <div className="inline"><input placeholder="Your name" value={name} onChange={e => setName(e.target.value)} />
      <button className="button ghost" onClick={async () => { try { await actions.claimSandboxAdmin({ name }); } catch (e) { setError(errorText(e)); } }}><FlaskConical size={15}/> Join</button></div>
    {error && <div className="auth-error" style={{ marginTop: 10 }}>{error}</div>}</>;
}

export function Connecting({ db }: { db: string }) {
  return <AuthCard title="Connecting…" subtitle={`Opening the ${db} network. Start the local stack with “npm run demo” if this doesn't finish.`}><div /></AuthCard>;
}

/** Shown when sign-in has not been configured for this deployment. */
export function AuthNotConfigured({ state, actions }: { state: SupplyState; actions: SupplyActions }) {
  return <AuthCard title="Sign-in isn't set up yet" subtitle="Argus uses SpacetimeAuth for sign-in. Create a SpacetimeAuth client for this database, then restart with its client ID.">
    <ol className="help" style={{ paddingLeft: 18, margin: 0, lineHeight: 1.8 }}>
      <li>Maincloud dashboard → your database → <b>SpacetimeAuth</b> → Use SpacetimeAuth.</li>
      <li>Clients → add redirect URI <code>{window.location.origin}/callback</code>.</li>
      <li>Run <code>SPACETIMEAUTH_CLIENT_ID=client_… npm run demo</code>.</li>
    </ol>
    {state.sandbox && <SandboxJoin actions={actions} />}
  </AuthCard>;
}

/** Sign-in bridge for an existing local database with a pre-OIDC account. */
export function LegacySignIn({ state, actions }: { state: SupplyState; actions: SupplyActions }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setError(''); setBusy(true);
    try { await actions.legacySignIn({ email, password }); }
    catch (err) { setError(errorText(err)); }
    finally { setBusy(false); }
  };
  return <AuthCard title="Sign in to your local network" subtitle="Use the email and password from this database's earlier account system. This local sign-in is available while SpacetimeAuth is unconfigured.">
    <form onSubmit={submit}>
      <label>Email<input type="email" autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} required autoFocus /></label>
      <label>Password<input type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} required /></label>
      {(error || (state.legacyLoginStatus && !state.legacyLoginStatus.ok && state.legacyLoginStatus.atMicros > 0n)) &&
        <div className="auth-error">{error || state.legacyLoginStatus?.message}</div>}
      <button className="button primary wide" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
    </form>
  </AuthCard>;
}

export function CreateNetwork({ session, actions }: { session: Session; actions: SupplyActions }) {
  const [siteName, setSiteName] = useState('');
  const [region, setRegion] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  if (!session.signedIn) return <AuthCard title="Create your network" subtitle="Sign in first. You'll become the network's admin and can invite everyone else by email."><SignInButton session={session} /></AuthCard>;
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError('');
    try { await actions.bootstrapNetwork({ siteName, region }); } catch (err) { setError(errorText(err)); } finally { setBusy(false); }
  };
  return <AuthCard title="Create your network" subtitle={`Signed in as ${session.email}. You'll be the first admin. No inventory is invented: every count is entered by your team.`}>
    <form onSubmit={submit}>
      <label>First site<input value={siteName} onChange={e => setSiteName(e.target.value)} placeholder="e.g. North Pharmacy" required autoFocus /></label>
      <label>Region<input value={region} onChange={e => setRegion(e.target.value)} placeholder="e.g. Chicago, IL" /></label>
      {error && <div className="auth-error">{error}</div>}
      <button className="button primary wide" disabled={busy}>{busy ? 'Creating…' : 'Create network'}</button>
    </form>
  </AuthCard>;
}

export function SignIn({ state, session, actions }: { state: SupplyState; session: Session; actions: SupplyActions }) {
  return <AuthCard title="Sign in" subtitle={state.sandbox ? 'This sandbox holds synthetic data. Sign in, or join instantly as an admin.' : 'Sign in with the email your network admin invited.'}>
    <SignInButton session={session} />
    {session.error && <div className="auth-error" style={{ marginTop: 12 }}>{session.error}</div>}
    {state.sandbox && <SandboxJoin actions={actions} />}
  </AuthCard>;
}

/** Signed in, but not (yet) a member of this network. */
export function NoAccess({ state, session, actions }: { state: SupplyState; session: Session; actions: SupplyActions }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const retry = async () => {
    setBusy(true); setError('');
    try { await actions.joinNetwork(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  return <AuthCard title="Waiting for an invitation" subtitle={`You're signed in as ${session.email || 'this account'}, but this email hasn't been invited to the network yet. Ask a network admin to invite it, then check again.`}>
    <div className="inline"><button className="button primary" disabled={busy} onClick={retry}><RefreshCw size={15}/> Check again</button>
      <button className="button ghost" onClick={() => void session.signOut()}><LogOut size={15}/> Use another account</button></div>
    {error && <div className="auth-error" style={{ marginTop: 12 }}>{error}</div>}
    {state.sandbox && <SandboxJoin actions={actions} />}
  </AuthCard>;
}
