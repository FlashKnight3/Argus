import { useMemo, useState } from 'react';
import { Activity, ArrowLeftRight, Boxes, Database, LayoutDashboard, Network, Radar, ShieldCheck } from 'lucide-react';
import { InventoryPage } from './InventoryPage';
import { TransfersPage } from './TransfersPage';
import { FdaPage } from './FdaPage';
import { NetworkPage } from './NetworkPage';
import { WorkerSetup } from './WorkerSetup';
import { isCurrentShortage } from './fda';
import { Empty, Panel, Pill, errorText, number, riskTone, siteName } from './ui';
import { useActions, useSupply, type Inventory, type SupplyActions, type SupplyState } from './useSupply';

export type Notify = (message: string, bad?: boolean) => void;
type View = 'overview' | 'inventory' | 'transfers' | 'fda' | 'network';

const NAV: Array<{ id: View; label: string; icon: typeof LayoutDashboard }> = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'inventory', label: 'Inventory', icon: Boxes },
  { id: 'transfers', label: 'Transfers', icon: ArrowLeftRight },
  { id: 'fda', label: 'FDA watch', icon: Radar },
  { id: 'network', label: 'Network', icon: Network },
];

function Setup({ actions, notify }: { actions: SupplyActions; notify: Notify }) {
  const [ownerName, setOwnerName] = useState('');
  const [siteName, setSiteName] = useState('');
  const [region, setRegion] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try { await actions.bootstrapNetwork({ ownerName, siteName, region }); notify('Network created. Add real inventory to get started.'); window.location.reload(); }
    catch (error) { notify(errorText(error), true); }
    finally { setBusy(false); }
  };
  return <div className="gate"><div className="setup-card">
    <div className="brand-mark large">A<span>✦</span></div>
    <div className="eyebrow">ARGUS / SUPPLY NETWORK</div>
    <h1>Make shortages visible before they become surprises.</h1>
    <p>Create your local network. No inventory is invented: every quantity starts with a person entering it.</p>
    <div className="setup-grid">
      <label>Your name<input value={ownerName} onChange={event => setOwnerName(event.target.value)} placeholder="e.g. Alex Morgan" /></label>
      <label>First site<input value={siteName} onChange={event => setSiteName(event.target.value)} placeholder="e.g. North Pharmacy" /></label>
      <label>Region<input value={region} onChange={event => setRegion(event.target.value)} placeholder="e.g. Chicago, IL" /></label>
    </div>
    <button className="button primary wide" onClick={submit} disabled={busy || !ownerName.trim() || !siteName.trim()}>{busy ? 'Creating…' : 'Create network →'}</button>
    <small>Local operations prototype · No patient records · Not for medication or treatment decisions</small>
  </div></div>;
}

function Access({ identity }: { identity: string }) {
  return <div className="gate"><div className="setup-card compact">
    <ShieldCheck size={36} className="accent-icon" />
    <div className="eyebrow">ACCESS PENDING</div><h1>Your account needs access.</h1>
    <p>Ask a network admin to grant this browser identity in the Network page.</p>
    <code className="identity-code">{identity || 'Connecting…'}</code>
    <button className="button ghost wide" onClick={() => navigator.clipboard.writeText(identity)}>Copy identity</button>
  </div></div>;
}

function Overview({ state, visible, go }: { state: SupplyState; visible: Inventory[]; go: (view: View) => void }) {
  const atRisk = visible.filter(item => {
    const forecast = state.forecasts.get(item.key);
    return forecast?.inventoryRevision === item.revision && ['critical', 'watch'].includes(forecast.risk);
  });
  const pendingTransfers = state.transfers.filter(row => row.status !== 'received' && row.status !== 'cancelled');
  const pendingProposals = state.proposals.filter(row => row.status === 'pending');
  const activeNotices = state.shortages.filter(isCurrentShortage);
  const attention = [...atRisk].sort((a, b) =>
    (state.forecasts.get(a.key)?.daysP10 ?? Infinity) - (state.forecasts.get(b.key)?.daysP10 ?? Infinity));

  return <div className="page-stack">
    <section className="hero"><div><div className="eyebrow">OPERATIONS / LIVE STATE</div>
      <h1>Know what is at risk.<br /><em>Move before it runs out.</em></h1>
      <p>FDA supply signals beside your actual site inventory. Every recommendation has a source, a timestamp, and a person in control.</p>
      <button className="button primary" onClick={() => go('inventory')}>Review inventory →</button>
    </div><div className="hero-art" aria-hidden="true"><div className="orbit a"/><div className="orbit b"/><div className="orbit c"/><div className="hero-center">A</div><span className="hero-dot one"/><span className="hero-dot two"/><span className="hero-dot three"/></div></section>

    <div className="metric-grid">
      <button className="metric" onClick={() => go('inventory')}><span>Tracked products</span><strong>{number(visible.length)}</strong><small>Across selected sites</small><Boxes size={18}/></button>
      <button className="metric" onClick={() => go('inventory')}><span>Supply at risk</span><strong>{number(atRisk.length)}</strong><small>Forecast watch or critical</small><Activity size={18}/></button>
      <button className="metric" onClick={() => go('fda')}><span>FDA notices</span><strong>{number(activeNotices.length)}</strong><small>Current source records</small><Radar size={18}/></button>
      <button className="metric" onClick={() => go('transfers')}><span>Open transfers</span><strong>{number(pendingTransfers.length)}</strong><small>{pendingProposals.length} agent drafts to review</small><ArrowLeftRight size={18}/></button>
    </div>

    <div className="two-col">
      <Panel eyebrow="01 / PRIORITY" title="Needs attention" action={<button className="text-button" onClick={() => go('inventory')}>All inventory →</button>}>
        {attention.length ? <div className="list">{attention.slice(0, 5).map(item => {
          const forecast = state.forecasts.get(item.key);
          return <div className="list-row" key={item.key}><div><strong>{item.label}</strong><small>{siteName(state.sites, item.siteId)} · NDC {item.ndc}</small></div><div className="list-right"><Pill tone={riskTone(forecast?.risk ?? '')}>{forecast?.risk ?? 'unknown'}</Pill><small>{forecast ? `${number(forecast.daysP10, 1)}–${number(forecast.daysP90, 1)} days` : 'Awaiting forecast'}</small></div></div>;
        })}</div> : <Empty title="Nothing flagged yet" detail={visible.length ? 'The worker has not found a near-term stock risk.' : 'Add an inventory item to begin monitoring.'} />}
      </Panel>
      <Panel eyebrow="02 / NETWORK" title="Live coordination" action={<button className="text-button" onClick={() => go('transfers')}>Open transfers →</button>}>
        {pendingProposals.length ? <div className="list">{pendingProposals.slice(0, 3).map(row => <div className="list-row" key={row.key}><div><strong>Draft transfer · {row.ndc}</strong><small>{siteName(state.sites, row.sourceSiteId)} → {siteName(state.sites, row.destSiteId)}</small></div><Pill tone="info">Review</Pill></div>)}</div>
          : pendingTransfers.length ? <div className="list">{pendingTransfers.slice(0, 3).map(row => <div className="list-row" key={row.id}><div><strong>Transfer #{row.id} · {row.label}</strong><small>{siteName(state.sites, row.sourceSiteId)} → {siteName(state.sites, row.destSiteId)}</small></div><Pill tone="info">{row.status}</Pill></div>)}</div>
          : <Empty title="Network is quiet" detail="Requests and agent drafts will appear here when sites coordinate." />}
      </Panel>
    </div>
    <div className="source-note"><Database size={16}/><span>FDA notices update daily; inventory changes when your team records them. This is an operations tool, not clinical guidance.</span></div>
  </div>;
}

export default function App() {
  const state = useSupply();
  const actions = useActions();
  const [view, setView] = useState<View>('overview');
  const [siteFilter, setSiteFilter] = useState(0);
  const [message, setMessage] = useState<{ text: string; bad: boolean } | null>(null);
  const [stockPrefill, setStockPrefill] = useState<{ ndc: string; label: string; shortageKey: string } | null>(null);
  const notify: Notify = (text, bad = false) => { setMessage({ text, bad }); window.setTimeout(() => setMessage(null), 5500); };
  const visible = useMemo(() => state.inventory.filter(item =>
    state.me?.role === 'admin' ? (!siteFilter || item.siteId === siteFilter) : item.siteId === state.me?.siteId),
    [state.inventory, state.me, siteFilter]);

  if (!state.connected) return <div className="gate"><div className="setup-card compact"><div className="brand-mark large">A<span>✦</span></div><div className="eyebrow">CONNECTING TO SPACETIMEDB</div><h1>Opening the supply network…</h1><p>Start the local stack with <code>npm run demo</code>. The browser connects to <code>argus-supply</code> on the machine serving this page.</p></div></div>;
  if (!state.ready) return <div className="gate"><div className="setup-card compact"><h1>Loading network state…</h1></div></div>;
  if (!state.members.length) return <><Setup actions={actions} notify={notify} />{message && <div className={`toast ${message.bad ? 'bad' : ''}`}>{message.text}</div>}</>;
  if (!state.me) return <Access identity={state.identity} />;

  const page = view === 'overview' ? <Overview state={state} visible={visible} go={setView} />
    : view === 'inventory' ? <InventoryPage state={state} actions={actions} visible={visible} siteFilter={siteFilter} prefill={stockPrefill} clearPrefill={() => setStockPrefill(null)} notify={notify} />
    : view === 'transfers' ? <TransfersPage state={state} actions={actions} notify={notify} />
    : view === 'fda' ? <FdaPage state={state} actions={actions} notify={notify} track={row => { setStockPrefill({ ndc: row.packageNdc, label: row.genericName, shortageKey: row.key }); setView('inventory'); }} />
    : <NetworkPage state={state} actions={actions} notify={notify} />;

  return <div className="app-shell">
    <aside className="sidebar"><div className="brand"><div className="brand-mark">A<span>✦</span></div><div><b>ARGUS</b><small>SUPPLY NETWORK</small></div></div>
      <div className="nav-label">WORKSPACE</div><nav>{NAV.map(item => <button key={item.id} className={`nav-item ${view === item.id ? 'active' : ''}`} onClick={() => setView(item.id)}><item.icon size={18}/><span>{item.label}</span>{item.id === 'transfers' && state.proposals.some(row => row.status === 'pending') && <i/>}</button>)}</nav>
      <div className="sidebar-bottom"><div className="connection-dot"/><div><strong>Local network active</strong><small>SpacetimeDB · subscribed</small></div></div>
    </aside>
    <div className="content-shell"><header className="topbar"><div><div className="eyebrow">ARGUS / {view.toUpperCase()}</div><strong>{NAV.find(item => item.id === view)?.label}</strong></div><div className="topbar-actions">
      {state.me.role === 'admin' && <select aria-label="Site filter" value={siteFilter} onChange={event => setSiteFilter(Number(event.target.value))}><option value={0}>All sites</option>{state.sites.map(site => <option key={site.id} value={site.id}>{site.name}</option>)}</select>}
      <div className="user-chip"><span>{state.me.name.slice(0, 1).toUpperCase()}</span><div><strong>{state.me.name}</strong><small>{state.me.role === 'admin' ? 'Network admin' : siteName(state.sites, state.me.siteId)}</small></div></div>
    </div></header><main className="main-content"><WorkerSetup state={state} actions={actions} notify={notify} openNetwork={() => setView('network')} />{page}</main></div>
    {message && <div className={`toast ${message.bad ? 'bad' : ''}`}>{message.text}</div>}
  </div>;
}
