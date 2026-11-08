import { useState, type FormEvent } from 'react';
import { Plus } from 'lucide-react';
import { Empty, Modal, PageHead, Pill, Tabs, date, errorText, siteName } from './ui';
import type { Notify } from './App';
import type { SupplyActions, SupplyState } from './useSupply';

type Tab = 'sites' | 'people' | 'workers';
const roleLabel: Record<string, string> = { admin: 'Admin', manager: 'Manager', viewer: 'Viewer', service: 'Worker' };

export function NetworkPage({ state, actions, notify }: { state: SupplyState; actions: SupplyActions; notify: Notify }) {
  const admin = state.me?.role === 'admin';
  const [tab, setTab] = useState<Tab>('sites');
  const [modal, setModal] = useState<'site' | 'person' | null>(null);
  const [editEmail, setEditEmail] = useState('');
  const [resetFor, setResetFor] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async (p: Promise<void>, ok: string) => {
    setBusy(true);
    try { await p; notify(ok); return true; } catch (e) { notify(errorText(e), true); return false; } finally { setBusy(false); }
  };
  const legacy = state.members.filter(m => !m.email && m.role !== 'service');
  const workers = state.members.filter(m => m.role === 'service');
  const signedIn = (email: string) => state.members.filter(m => m.email === email).length;

  return <>
    <PageHead title="Network" subtitle="Your sites and the people who can sign in."
      right={admin && tab !== 'workers' && <button className="fab" title={tab === 'sites' ? 'Add site' : 'Add person'} onClick={() => setModal(tab === 'sites' ? 'site' : 'person')}><Plus size={20}/></button>} />
    <Tabs value={tab} onChange={setTab} tabs={[{ id: 'sites', label: 'Sites', count: state.sites.length }, { id: 'people', label: 'People', count: state.accounts.length + legacy.length }, ...(admin ? [{ id: 'workers' as const, label: 'Workers' }] : [])]} />

    {tab === 'sites' && (state.sites.length ? <div className="table-wrap"><table className="table"><thead><tr><th>Site</th><th>Region</th><th>Contact</th><th className="num">Products</th><th>Added</th></tr></thead><tbody>
      {state.sites.map(s => <tr key={s.id}><td><strong>{s.name}</strong><small>Site {s.id}</small></td><td>{s.region || '—'}</td><td>{s.contact || '—'}</td>
        <td className="num">{state.inventory.filter(i => i.siteId === s.id).length}</td><td><small>{date(s.createdAt)}</small></td></tr>)}
    </tbody></table></div> : <div className="card"><Empty title="No sites" detail="Add your first site." /></div>)}

    {tab === 'people' && <>
      {admin ? <div className="table-wrap"><table className="table"><thead><tr><th>Name</th><th>Role</th><th>Site</th><th>Last sign-in</th><th className="actions">Actions</th></tr></thead><tbody>
        {state.accounts.map(a => <tr key={a.email}><td><strong>{a.name}</strong><small>{a.email}{signedIn(a.email) ? ` · signed in on ${signedIn(a.email)} browser${signedIn(a.email) === 1 ? '' : 's'}` : ''}</small></td>
          <td><Pill tone={a.role === 'admin' ? 'good' : 'neutral'}>{roleLabel[a.role]}</Pill>{a.locked && <> <Pill tone="danger">Locked</Pill></>}</td>
          <td>{a.role === 'admin' ? 'All sites' : siteName(state.sites, a.siteId)}</td><td><small>{a.lastLoginMicros > 0n ? date({ microsSinceUnixEpoch: a.lastLoginMicros }) : 'Never'}</small></td>
          <td className="actions"><button className="link" onClick={() => setEditEmail(a.email)}>Edit</button><button className="link" onClick={() => setResetFor(a.email)}>Reset password</button>
            {a.email !== state.me?.email && <button className="link danger" disabled={busy} onClick={() => { if (window.confirm(`Remove ${a.name}'s access?`)) void run(actions.deleteAccount({ email: a.email }), 'Account removed.'); }}>Remove</button>}</td></tr>)}
        {legacy.map(m => <tr key={m.identity}><td><strong>{m.name}</strong><small>Browser-only sign-in (no email yet)</small></td><td><Pill>{roleLabel[m.role]}</Pill></td><td>{m.role === 'admin' ? 'All sites' : siteName(state.sites, m.siteId)}</td><td>—</td>
          <td className="actions">{m.identity !== state.identity && <button className="link danger" disabled={busy} onClick={() => run(actions.revokeMember({ identity: m.identity }), 'Access removed.')}>Remove</button>}</td></tr>)}
      </tbody></table></div>
        : <div className="table-wrap"><table className="table"><thead><tr><th>Name</th><th>Role</th><th>Site</th></tr></thead><tbody>
          {state.members.filter(m => m.role !== 'service').map(m => <tr key={m.identity}><td>{m.name}</td><td>{roleLabel[m.role]}</td><td>{m.role === 'admin' ? 'All sites' : siteName(state.sites, m.siteId)}</td></tr>)}</tbody></table></div>}
    </>}

    {tab === 'workers' && admin && <WorkersAccess state={state} actions={actions} run={run} busy={busy} workers={workers} />}

    {modal === 'site' && <SiteForm onClose={() => setModal(null)} onSave={(f) => run(actions.createSite(f), 'Site added.')} />}
    {modal === 'person' && <PersonForm state={state} onClose={() => setModal(null)} onSave={(f) => run(actions.createAccount(f), `Account created. Share the email and temporary password with ${f.name}.`)} />}
    {editEmail && <EditPerson state={state} email={editEmail} onClose={() => setEditEmail('')} onSave={(f) => run(actions.updateAccount(f), 'Account updated.')} />}
    {resetFor && <ResetPassword email={resetFor} onClose={() => setResetFor('')} onSave={(password) => run(actions.resetAccountPassword({ email: resetFor, password }), 'Password reset. Share the new password securely.')} />}
  </>;
}

function WorkersAccess({ state, actions, run, busy, workers }: { state: SupplyState; actions: SupplyActions; run: (p: Promise<void>, ok: string) => Promise<boolean>; busy: boolean; workers: SupplyState['members'] }) {
  const [identity, setIdentity] = useState('');
  return <>
    <p className="help" style={{ marginBottom: 16 }}>Background workers sign in with a service identity instead of a password. They can import FDA data, forecast, and draft, but never approve or move stock. Use <code>npm run worker:identity</code> to print the identity.</p>
    {workers.length > 0 && <div className="table-wrap" style={{ marginBottom: 18 }}><table className="table"><thead><tr><th>Name</th><th>Identity</th><th className="actions">Actions</th></tr></thead><tbody>
      {workers.map(w => <tr key={w.identity}><td>{w.name}</td><td className="mono">{w.identity.slice(0, 20)}…</td><td className="actions"><button className="link danger" disabled={busy} onClick={() => run(actions.revokeMember({ identity: w.identity }), 'Worker access removed.')}>Remove</button></td></tr>)}
    </tbody></table></div>}
    <div className="inline"><input className="mono" placeholder="64-character worker identity" value={identity} onChange={e => setIdentity(e.target.value.trim())} />
      <button className="button primary" disabled={busy || !/^[0-9a-f]{64}$/i.test(identity)} onClick={async () => { if (await run(actions.grantMember({ identity, name: 'Agent workers', role: 'service', siteId: 0 }), 'Worker added.')) setIdentity(''); }}>Add worker</button></div>
    {state.sync?.status !== 'complete' && <p className="help" style={{ marginTop: 10 }}>Once a worker is added, it imports the FDA feed automatically.</p>}
  </>;
}

function SiteForm({ onClose, onSave }: { onClose: () => void; onSave: (f: { name: string; region: string; contact: string }) => Promise<boolean> }) {
  const [f, setF] = useState({ name: '', region: '', contact: '' });
  return <Modal title="Add a site" onClose={onClose} footer={<><button className="button ghost" onClick={onClose}>Cancel</button><button className="button primary" disabled={!f.name.trim()} onClick={async () => { if (await onSave(f)) onClose(); }}>Add site</button></>}>
    <div className="form-grid"><label className="full">Name<input value={f.name} onChange={e => setF({ ...f, name: e.target.value })} autoFocus /></label>
      <label>Region<input value={f.region} onChange={e => setF({ ...f, region: e.target.value })} /></label><label>Contact (optional)<input value={f.contact} onChange={e => setF({ ...f, contact: e.target.value })} /></label></div>
  </Modal>;
}

type PersonFields = { email: string; name: string; role: string; siteId: number; password: string };
function PersonForm({ state, onClose, onSave }: { state: SupplyState; onClose: () => void; onSave: (f: PersonFields) => Promise<boolean> }) {
  const [f, setF] = useState<PersonFields>({ email: '', name: '', role: 'manager', siteId: state.sites[0]?.id ?? 0, password: '' });
  const submit = async (e: FormEvent) => { e.preventDefault(); if (await onSave(f)) onClose(); };
  return <Modal title="Add a person" subtitle="They sign in with this email and the temporary password, then can change it from their menu." onClose={onClose}>
    <form className="form-grid" onSubmit={submit}>
      <label>Name<input value={f.name} onChange={e => setF({ ...f, name: e.target.value })} required autoFocus /></label>
      <label>Email<input type="email" value={f.email} onChange={e => setF({ ...f, email: e.target.value })} required /></label>
      <label>Role<select value={f.role} onChange={e => setF({ ...f, role: e.target.value })}><option value="manager">Manager: edits one site</option><option value="viewer">Viewer: read-only, one site</option><option value="admin">Admin: everything</option></select></label>
      {f.role !== 'admin' ? <label>Site<select value={f.siteId} onChange={e => setF({ ...f, siteId: Number(e.target.value) })}>{state.sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label> : <div />}
      <label className="full">Temporary password<input type="text" value={f.password} onChange={e => setF({ ...f, password: e.target.value })} minLength={8} required placeholder="At least 8 characters" /></label>
      <div className="full modal-foot" style={{ marginTop: 4 }}><button type="button" className="button ghost" onClick={onClose}>Cancel</button><button className="button primary">Create account</button></div>
    </form>
  </Modal>;
}

function EditPerson({ state, email, onClose, onSave }: { state: SupplyState; email: string; onClose: () => void; onSave: (f: { email: string; name: string; role: string; siteId: number }) => Promise<boolean> }) {
  const acct = state.accounts.find(a => a.email === email);
  const [f, setF] = useState({ email, name: acct?.name ?? '', role: acct?.role ?? 'viewer', siteId: acct?.siteId || state.sites[0]?.id || 0 });
  return <Modal title={`Edit ${acct?.name ?? email}`} onClose={onClose} footer={<><button className="button ghost" onClick={onClose}>Cancel</button><button className="button primary" onClick={async () => { if (await onSave(f)) onClose(); }}>Save</button></>}>
    <div className="form-grid"><label className="full">Name<input value={f.name} onChange={e => setF({ ...f, name: e.target.value })} /></label>
      <label>Role<select value={f.role} onChange={e => setF({ ...f, role: e.target.value })}><option value="manager">Manager</option><option value="viewer">Viewer</option><option value="admin">Admin</option></select></label>
      {f.role !== 'admin' ? <label>Site<select value={f.siteId} onChange={e => setF({ ...f, siteId: Number(e.target.value) })}>{state.sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label> : <div />}</div>
  </Modal>;
}

function ResetPassword({ email, onClose, onSave }: { email: string; onClose: () => void; onSave: (password: string) => Promise<boolean> }) {
  const [p, setP] = useState('');
  return <Modal title="Reset password" subtitle={`Set a new temporary password for ${email}. This also unlocks the account.`} onClose={onClose}
    footer={<><button className="button ghost" onClick={onClose}>Cancel</button><button className="button primary" disabled={p.length < 8} onClick={async () => { if (await onSave(p)) onClose(); }}>Reset</button></>}>
    <label>New password<input type="text" value={p} onChange={e => setP(e.target.value)} minLength={8} placeholder="At least 8 characters" autoFocus /></label>
  </Modal>;
}
