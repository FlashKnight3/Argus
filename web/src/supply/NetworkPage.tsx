import { useState } from 'react';
import { Copy, Plus, ShieldCheck } from 'lucide-react';
import { Empty, Panel, Pill, date, errorText, siteName } from './ui';
import type { Notify } from './App';
import type { SupplyActions, SupplyState } from './useSupply';

export function NetworkPage({ state, actions, notify }: { state: SupplyState; actions: SupplyActions; notify: Notify }) {
  const [site, setSite] = useState({ name: '', region: '', contact: '' });
  const [member, setMember] = useState({ identity: '', name: '', role: 'manager', siteId: 0 });
  const [busy, setBusy] = useState(false);
  const admin = state.me?.role === 'admin';
  const saveSite = async () => {
    setBusy(true);
    try { await actions.createSite(site); setSite({ name: '', region: '', contact: '' }); notify('Site created.'); }
    catch (error) { notify(errorText(error), true); }
    finally { setBusy(false); }
  };
  const saveMember = async () => {
    setBusy(true);
    try { await actions.grantMember({ ...member, identity: member.identity.trim().toLowerCase() }); setMember({ identity: '', name: '', role: 'manager', siteId: 0 }); notify('Access granted.'); }
    catch (error) { notify(errorText(error), true); }
    finally { setBusy(false); }
  };
  return <div className="page-stack"><div className="page-intro"><div><div className="eyebrow">IDENTITY / ACCESS / AUDIT</div><h1>Network</h1><p>Manage participating sites and identities. Every inventory movement and transfer is recorded in the shared ledger.</p></div></div>
    <div className="two-col"><Panel eyebrow="PARTICIPANTS" title={`${state.sites.length} sites`}>
      <div className="compact-list">{state.sites.map(row => <div key={row.id}><span><b>{row.name}</b><small>{row.region || 'Region not set'}{row.contact ? ` · ${row.contact}` : ''}</small></span><Pill tone="good">Site {row.id}</Pill></div>)}</div>
      {admin && <div className="detail-section"><strong>Add a site</strong><div className="form-grid"><label>Name<input value={site.name} onChange={e => setSite({ ...site, name: e.target.value })}/></label><label>Region<input value={site.region} onChange={e => setSite({ ...site, region: e.target.value })}/></label><label className="full">Contact (optional)<input value={site.contact} onChange={e => setSite({ ...site, contact: e.target.value })}/></label></div><button className="button primary" disabled={busy || !site.name.trim()} onClick={saveSite}><Plus size={15}/> Add site</button></div>}
    </Panel><Panel eyebrow="ROLE-BASED ACCESS" title={`${state.members.length} identities`}>
      <div className="compact-list">{state.members.map(row => <div key={row.identity}><span><b>{row.name}</b><small title={row.identity}>{row.identity.slice(0, 12)}… · {row.role === 'admin' || row.role === 'service' ? 'Network-wide' : siteName(state.sites, row.siteId)}</small></span><Pill tone={row.role === 'service' ? 'info' : 'neutral'}>{row.role}</Pill></div>)}</div>
      {admin && <div className="detail-section"><strong>Grant or update access</strong><p>A browser displays its identity on the access screen. Get the worker identity with <code>npm run worker:identity</code>, then grant it the service role.</p><div className="form-grid"><label className="full">64-character identity<input value={member.identity} onChange={e => setMember({ ...member, identity: e.target.value })} placeholder="Paste identity"/></label><label>Name<input value={member.name} onChange={e => setMember({ ...member, name: e.target.value })}/></label><label>Role<select value={member.role} onChange={e => setMember({ ...member, role: e.target.value })}><option value="manager">Manager</option><option value="viewer">Viewer</option><option value="service">Service worker</option><option value="admin">Admin</option></select></label>{['manager', 'viewer'].includes(member.role) && <label className="full">Site<select value={member.siteId} onChange={e => setMember({ ...member, siteId: Number(e.target.value) })}><option value={0}>Choose site</option>{state.sites.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label>}</div><button className="button primary" disabled={busy || !/^[a-f\d]{64}$/i.test(member.identity) || (['manager', 'viewer'].includes(member.role) && !member.siteId)} onClick={saveMember}><ShieldCheck size={15}/> Grant access</button></div>}
    </Panel></div>
    <div className="two-col"><Panel eyebrow="YOUR ACCOUNT" title="Current identity"><div className="identity-panel"><code>{state.identity}</code><button className="icon-button" title="Copy identity" onClick={() => navigator.clipboard.writeText(state.identity)}><Copy size={16}/></button></div><p className="muted">This identity is stored with your browser token. Clearing browser storage creates a new identity that needs access again.</p></Panel>
      <Panel eyebrow="IMMUTABLE EVENTS" title="Recent activity">{state.activity.length ? <div className="compact-list">{state.activity.slice(0, 12).map(row => <div key={row.id}><span><b>{row.action}</b><small>{row.detail}</small></span><small>{date(row.at)}</small></div>)}</div> : <Empty title="No activity yet" detail="Changes will appear here as the network operates." />}</Panel></div>
    <div className="source-note"><ShieldCheck size={16}/><span>This local prototype exposes shared network data to connected clients. Use only operational, non-patient data. See the security documentation before deploying.</span></div>
  </div>;
}
