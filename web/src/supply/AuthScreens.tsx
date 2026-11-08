import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { FlaskConical, LogIn } from 'lucide-react';
import { errorText } from './ui';
import type { SupplyActions, SupplyState } from './useSupply';

export function Logo() {
  return <div className="logo"><div className="logo-mark">A</div><div><b>ARGUS</b><small>SUPPLY NETWORK</small></div></div>;
}

function AuthCard({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return <div className="auth"><div className="auth-card"><Logo /><h1>{title}</h1><p>{subtitle}</p>{children}
    <div className="auth-foot">Operations prototype · no patient records · not for medication or treatment decisions</div></div></div>;
}

export function Connecting({ db }: { db: string }) {
  return <AuthCard title="Connecting…" subtitle={`Opening the ${db} network. Start the local stack with “npm run demo” if this doesn't finish.`}><div /></AuthCard>;
}

export function CreateNetwork({ actions }: { actions: SupplyActions }) {
  const [f, setF] = useState({ ownerName: '', email: '', password: '', siteName: '', region: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError('');
    try { await actions.bootstrapNetwork(f); }
    catch (err) { setError(errorText(err)); }
    finally { setBusy(false); }
  };
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF(v => ({ ...v, [k]: e.target.value }));
  return <AuthCard title="Create your network" subtitle="You'll be the first admin. Add more sites and people after signing in. No inventory is invented: every count is entered by your team.">
    <form onSubmit={submit}>
      <label>Your name<input value={f.ownerName} onChange={set('ownerName')} autoComplete="name" required /></label>
      <label>Email<input type="email" value={f.email} onChange={set('email')} autoComplete="email" required /></label>
      <label>Password<input type="password" value={f.password} onChange={set('password')} autoComplete="new-password" minLength={8} required placeholder="At least 8 characters" /></label>
      <label>First site<input value={f.siteName} onChange={set('siteName')} placeholder="e.g. North Pharmacy" required /></label>
      <label>Region<input value={f.region} onChange={set('region')} placeholder="e.g. Chicago, IL" /></label>
      {error && <div className="auth-error">{error}</div>}
      <button className="button primary wide" disabled={busy}>{busy ? 'Creating…' : 'Create network'}</button>
    </form>
  </AuthCard>;
}

export function SignIn({ state, actions }: { state: SupplyState; actions: SupplyActions }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [pendingSince, setPendingSince] = useState(0);
  const [error, setError] = useState('');
  const status = state.loginStatus;

  useEffect(() => {
    if (!pendingSince || !status) return;
    if (Number(status.atMicros / 1000n) < pendingSince - 2000) return;
    if (!status.ok) { setError(status.message); setPendingSince(0); }
  }, [status, pendingSince]);
  useEffect(() => {
    if (!pendingSince) return;
    const t = window.setTimeout(() => { setPendingSince(0); setError('No response from the server. Try again.'); }, 8000);
    return () => window.clearTimeout(t);
  }, [pendingSince]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(''); setPendingSince(Date.now());
    try { await actions.signIn({ email, password }); }
    catch (err) { setError(errorText(err)); setPendingSince(0); }
  };
  const join = async () => {
    try { await actions.claimSandboxAdmin({ name }); } catch (err) { setError(errorText(err)); }
  };

  return <AuthCard title="Sign in" subtitle={state.sandbox ? 'This is a sandbox network with synthetic data. Sign in, or join instantly as an admin.' : 'Sign in with the account your network admin created for you.'}>
    <form onSubmit={submit}>
      <label>Email<input type="email" value={email} onChange={e => setEmail(e.target.value)} autoComplete="username" required autoFocus /></label>
      <label>Password<input type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" required /></label>
      {error && <div className="auth-error">{error}</div>}
      <button className="button primary wide" disabled={!!pendingSince}><LogIn size={15}/> {pendingSince ? 'Signing in…' : 'Sign in'}</button>
    </form>
    {state.sandbox && <><div className="auth-divider">or</div>
      <div className="inline"><input placeholder="Your name" value={name} onChange={e => setName(e.target.value)} />
        <button className="button ghost" onClick={join}><FlaskConical size={15}/> Join sandbox</button></div></>}
    {!state.sandbox && <div className="auth-identity">Forgot your password? Ask a network admin to reset it.</div>}
  </AuthCard>;
}
