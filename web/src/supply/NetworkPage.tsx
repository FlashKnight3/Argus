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
  const [editId, setEditId] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async (p: Promise<void>, ok: string) => {
    setBusy(true);
    try { await p; notify(ok); return true; } catch (e) { notify(errorText(e), true); return false; } finally { setBusy(false); }
  };
  const people = state.members.filter(m => m.role !== 'service');
  const workers = state.members.filter(m => m.role === 'service');

  return <>
    <PageHead title="Network" subtitle="Your sites and the people who can sign in with SpacetimeAuth."
      right={admin && tab !== 'workers' && <button className="fab" title={tab === 'sites' ? 'Add site' : 'Invite someone'} onClick={() => setModal(tab === 'sites' ? 'site' : 'person')}><Plus size={20}/></button>} />
    <Tabs value={tab} onChange={setTab} tabs={[{ id: 'sites', label: 'Sites', count: state.sites.length }, { id: 'people', label: 'People', count: people.length + state.invites.length }, ...(admin ? [{ id: 'workers' as const, label: 'Workers' }] : [])]} />

    {tab === 'sites' && (state.sites.length ? <div className="table-wrap"><table className="table"><thead><tr><th>Site</th><th>Region</th><th>Contact</th><th className="num">Products</th><th>Added</th></tr></thead><tbody>
      {state.sites.map(s => <tr key={s.id}><td><strong>{s.name}</strong><small>Site {s.id}</small></td><td>{s.region || '—'}</td><td>{s.contact || '—'}</td>
        <td className="num">{state.inventory.filter(i => i.siteId === s.id).length}</td><td><small>{date(s.createdAt)}</small></td></tr>)}
    </tbody></table></div> : <div className="card"><Empty title="No sites" detail="Add your first site." /></div>)}

    {tab === 'people' && <>
      <div className="table-wrap"><table className="table"><thead><tr><th>Name</th><th>Role</th><th>Site</th><th>Since</th>{admin && <th className="actions">Actions</th>}</tr></thead><tbody>
        {people.map(m => <tr key={m.identity}><td><strong>{m.name}{m.identity === state.identity ? ' (you)' : ''}</strong><small>{m.email || (state.sandbox ? 'Sandbox guest' : 'Browser-only sign-in (from before SpacetimeAuth)')}</small></td>
          <td><Pill tone={m.role === 'admin' ? 'good' : 'neutral'}>{roleLabel[m.role]}</Pill></td><td>{m.role === 'admin' ? 'All sites' : siteName(state.sites, m.siteId)}</td><td><small>{date(m.createdAt)}</small></td>
          {admin && <td className="actions">{m.identity !== state.identity && <><button className="link" onClick={() => setEditId(m.identity)}>Edit role</button>
            <button className="link danger" disabled={busy} onClick={() => { if (window.confirm(`Remove ${m.name}'s access?`)) void run(actions.revokeMember({ identity: m.identity }), 'Access removed.'); }}>Remove</button></>}</td>}</tr>)}
      </tbody></table></div>
      {admin && <div style={{ marginTop: 26 }}><div className="section-head"><div><h2>Invitations</h2><p>People join automatically the first time they sign in with the invited email.</p></div></div>
        {state.invites.length ? <div className="table-wrap"><table className="table"><thead><tr><th>Email</th><th>Role</th><th>Site</th><th>Invited</th><th className="actions">Actions</th></tr></thead><tbody>
          {state.invites.map(inv => <tr key={inv.email}><td><strong>{inv.name || inv.email}</strong><small>{inv.email}</small></td><td><Pill tone="watch">{roleLabel[inv.role]} · pending</Pill></td>
            <td>{inv.role === 'admin' ? 'All sites' : siteName(state.sites, inv.siteId)}</td><td><small>{date(inv.createdAt)} by {inv.invitedBy}</small></td>
            <td className="actions"><button className="link danger" disabled={busy} onClick={() => run(actions.cancelInvite({ email: inv.email }), 'Invitation cancelled.')}>Cancel</button></td></tr>)}
        </tbody></table></div> : <div className="card"><Empty title="No pending invitations" detail="Use the + button to invite someone by email." /></div>}</div>}
    </>}

    {tab === 'workers' && admin && <WorkersAccess state={state} actions={actions} run={run} busy={busy} workers={workers} />}

    {modal === 'site' && <SiteForm onClose={() => setModal(null)} onSave={(f) => run(actions.createSite(f), 'Site added.')} />}
    {modal === 'person' && <InviteForm state={state} onClose={() => setModal(null)} onSave={(f) => run(actions.inviteMember(f), `Invitation saved. ${f.email} gets access the first time they sign in.`)} />}
    {editId && <EditRole state={state} identity={editId} onClose={() => setEditId('')} onSave={(f) => run(actions.updateMember(f), 'Role updated.')} />}
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

type InviteFields = { email: string; name: string; role: string; siteId: number };
function InviteForm({ state, onClose, onSave }: { state: SupplyState; onClose: () => void; onSave: (f: InviteFields) => Promise<boolean> }) {
  const [f, setF] = useState<InviteFields>({ email: '', name: '', role: 'manager', siteId: state.sites[0]?.id ?? 0 });
  const submit = async (e: FormEvent) => { e.preventDefault(); if (await onSave(f)) onClose(); };
  return <Modal title="Invite someone" subtitle="They sign in with SpacetimeAuth using this email and join automatically. No passwords to share." onClose={onClose}>
    <form className="form-grid" onSubmit={submit}>
      <label>Name<input value={f.name} onChange={e => setF({ ...f, name: e.target.value })} placeholder="Optional" autoFocus /></label>
      <label>Email<input type="email" value={f.email} onChange={e => setF({ ...f, email: e.target.value })} required /></label>
      <label>Role<select value={f.role} onChange={e => setF({ ...f, role: e.target.value })}><option value="manager">Manager: edits one site</option><option value="viewer">Viewer: read-only, one site</option><option value="admin">Admin: everything</option></select></label>
      {f.role !== 'admin' ? <label>Site<select value={f.siteId} onChange={e => setF({ ...f, siteId: Number(e.target.value) })}>{state.sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label> : <div />}
      <div className="full modal-foot" style={{ marginTop: 4 }}><button type="button" className="button ghost" onClick={onClose}>Cancel</button><button className="button primary">Send invitation</button></div>
    </form>
  </Modal>;
}

function EditRole({ state, identity, onClose, onSave }: { state: SupplyState; identity: string; onClose: () => void; onSave: (f: { identity: string; role: string; siteId: number }) => Promise<boolean> }) {
  const m = state.members.find(x => x.identity === identity);
  const [f, setF] = useState({ identity, role: m?.role ?? 'viewer', siteId: m?.siteId || state.sites[0]?.id || 0 });
  return <Modal title={`Edit ${m?.name ?? 'member'}`} onClose={onClose} footer={<><button className="button ghost" onClick={onClose}>Cancel</button><button className="button primary" onClick={async () => { if (await onSave(f)) onClose(); }}>Save</button></>}>
    <div className="form-grid"><label>Role<select value={f.role} onChange={e => setF({ ...f, role: e.target.value })}><option value="manager">Manager</option><option value="viewer">Viewer</option><option value="admin">Admin</option></select></label>
      {f.role !== 'admin' ? <label>Site<select value={f.siteId} onChange={e => setF({ ...f, siteId: Number(e.target.value) })}>{state.sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label> : <div />}</div>
  </Modal>;
}
