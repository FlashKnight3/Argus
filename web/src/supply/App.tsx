import { useEffect, useMemo, useState } from 'react';
import { Activity, ArrowLeftRight, Bot, Boxes, CloudOff, Database, FlaskConical, LayoutDashboard, Network, Radar, RefreshCw, Server, ShieldCheck } from 'lucide-react';
import { InventoryPage } from './InventoryPage';
import { TransfersPage } from './TransfersPage';
import { FdaPage } from './FdaPage';
import { NetworkPage } from './NetworkPage';
import { AgentPage } from './AgentPage';
import { SystemPage } from './SystemPage';
import { WorkerSetup } from './WorkerSetup';
import { plainPreview } from './Markdown';
import { DB_NAME } from './connection';
import { isCurrentShortage } from './fda';
import { useOfflineQueue, type OfflineQueue } from './offline';
import { Empty, Panel, Pill, date, errorText, number, percent, riskTone, siteName } from './ui';
import { useActions, useSupply, type Inventory, type SupplyActions, type SupplyState } from './useSupply';

export type Notify = (message: string, bad?: boolean) => void;
type View = 'overview' | 'inventory' | 'transfers' | 'agent' | 'fda' | 'network' | 'system';

const NAV: Array<{ id: View; label: string; icon: typeof LayoutDashboard }> = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'inventory', label: 'Inventory', icon: Boxes },
  { id: 'transfers', label: 'Transfers', icon: ArrowLeftRight },
  { id: 'agent', label: 'Agent', icon: Bot },
  { id: 'fda', label: 'FDA watch', icon: Radar },
  { id: 'network', label: 'Network', icon: Network },
  { id: 'system', label: 'System', icon: Server },
];

function Setup({ actions, notify }: { actions: SupplyActions; notify: Notify }) {
  const [ownerName, setOwnerName] = useState('');
  const [siteName, setSiteName] = useState('');
  const [region, setRegion] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try { await actions.bootstrapNetwork({ ownerName, siteName, region }); notify('Network created. Add real inventory to get started.'); }
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

function Access({ state, actions, notify }: { state: SupplyState; actions: SupplyActions; notify: Notify }) {
  const [name, setName] = useState('');
  const claim = async () => {
    try { await actions.claimSandboxAdmin({ name }); notify('Joined the sandbox as an admin.'); }
    catch (error) { notify(errorText(error), true); }
  };
  return <div className="gate"><div className="setup-card compact">
    {state.sandbox ? <FlaskConical size={36} className="accent-icon" /> : <ShieldCheck size={36} className="accent-icon" />}
    <div className="eyebrow">{state.sandbox ? 'SANDBOX NETWORK' : 'ACCESS PENDING'}</div>
    <h1>{state.sandbox ? 'Explore the sandbox.' : 'Your account needs access.'}</h1>
    {state.sandbox
      ? <><p>This network holds clearly labeled <b>synthetic</b> sites, stock, and usage history built around real FDA shortage notices. Anyone may join it as an admin.</p>
          <input className="full-input" placeholder="Your name" value={name} onChange={e => setName(e.target.value)} />
          <button className="button primary wide" onClick={claim}>Join sandbox as admin →</button></>
      : <><p>Ask a network admin to grant this browser identity in the Network page. Until then, this browser can read only the public FDA feed.</p>
          <code className="identity-code">{state.identity || 'Connecting…'}</code>
          <button className="button ghost wide" onClick={() => navigator.clipboard.writeText(state.identity)}>Copy identity</button></>}
  </div></div>;
}

function Overview({ state, visible, go }: { state: SupplyState; visible: Inventory[]; go: (view: View) => void }) {
  const fresh = (item: Inventory) => { const f = state.forecasts.get(item.key); return f?.inventoryRevision === item.revision ? f : undefined; };
  const atRisk = visible.filter(item => ['critical', 'watch'].includes(fresh(item)?.risk ?? ''));
  const pendingTransfers = state.transfers.filter(row => row.status !== 'received' && row.status !== 'cancelled');
  const pendingProposals = state.proposals.filter(row => row.status === 'pending');
  const pendingMatches = state.matches.filter(row => row.status === 'pending');
  const activeNotices = state.shortages.filter(isCurrentShortage);
  const attention = [...atRisk].sort((a, b) => (fresh(b)?.pStockout ?? 0) - (fresh(a)?.pStockout ?? 0)
    || (fresh(a)?.daysP10 ?? Infinity) - (fresh(b)?.daysP10 ?? Infinity));
  const online = state.workers.filter(w => w.status === 'online');
  const lastRun = state.agentRuns[0];
  const windows = state.metrics.reduce((n, m) => n + m.windows, 0);
  const coverage = windows ? state.metrics.reduce((s, m) => s + m.coverage80 * m.windows, 0) / windows : 0;

  return <div className="page-stack">
    <section className="hero"><div><div className="eyebrow">OPERATIONS / LIVE STATE</div>
      <h1>Know what is at risk.<br /><em>Move before it runs out.</em></h1>
      <p>FDA supply signals beside your actual site inventory. Every recommendation has a source, a timestamp, and a person in control.</p>
      <button className="button primary" onClick={() => go('inventory')}>Review inventory →</button>
    </div><div className="hero-art" aria-hidden="true"><div className="orbit a"/><div className="orbit b"/><div className="orbit c"/><div className="hero-center">A</div><span className="hero-dot one"/><span className="hero-dot two"/><span className="hero-dot three"/></div></section>

    <div className="metric-grid">
      <button className="metric" onClick={() => go('inventory')}><span>Tracked products</span><strong>{number(visible.length)}</strong><small>Across selected sites</small><Boxes size={18}/></button>
      <button className="metric" onClick={() => go('inventory')}><span>Supply at risk</span><strong>{number(atRisk.length)}</strong><small>Watch or critical before resupply</small><Activity size={18}/></button>
      <button className="metric" onClick={() => go('fda')}><span>FDA notices</span><strong>{number(activeNotices.length)}</strong><small>Current source records</small><Radar size={18}/></button>
      <button className="metric" onClick={() => go('transfers')}><span>Open transfers</span><strong>{number(pendingTransfers.length)}</strong><small>{pendingProposals.length} agent drafts to review</small><ArrowLeftRight size={18}/></button>
    </div>

    <div className="two-col">
      <Panel eyebrow="01 / PRIORITY" title="Needs attention" action={<button className="text-button" onClick={() => go('inventory')}>All inventory →</button>}>
        {attention.length ? <div className="list">{attention.slice(0, 5).map(item => {
          const forecast = fresh(item);
          return <div className="list-row" key={item.key}><div><strong>{item.label}</strong><small>{siteName(state.sites, item.siteId)} · NDC {item.ndc}{forecast?.fdaAdjusted ? ' · FDA shortage' : ''}</small></div><div className="list-right"><Pill tone={riskTone(forecast?.risk ?? '')}>{forecast?.risk ?? 'unknown'}</Pill><small>{forecast ? `${percent(forecast.pStockout)} stockout risk · ${number(forecast.daysP10, 1)}–${number(forecast.daysP90, 1)} days` : 'Awaiting forecast'}</small></div></div>;
        })}</div> : <Empty title="Nothing flagged yet" detail={visible.length ? 'No item is projected to run out before resupply.' : 'Add an inventory item to begin monitoring.'} />}
      </Panel>
      <Panel eyebrow="02 / NETWORK" title="Live coordination" action={<button className="text-button" onClick={() => go('transfers')}>Open transfers →</button>}>
        {pendingProposals.length ? <div className="list">{pendingProposals.slice(0, 3).map(row => <div className="list-row" key={row.key}><div><strong>Draft transfer · {number(row.quantity)} · NDC {row.ndc}</strong><small>{siteName(state.sites, row.sourceSiteId)} → {siteName(state.sites, row.destSiteId)}{row.runId ? ` · agent run #${row.runId}` : ''}</small></div><Pill tone="info">Review</Pill></div>)}</div>
          : pendingTransfers.length ? <div className="list">{pendingTransfers.slice(0, 3).map(row => <div className="list-row" key={row.id}><div><strong>Transfer #{row.id} · {row.label}</strong><small>{siteName(state.sites, row.sourceSiteId)} → {siteName(state.sites, row.destSiteId)}</small></div><Pill tone="info">{row.status}</Pill></div>)}</div>
          : <Empty title="Network is quiet" detail="Requests and agent drafts will appear here when sites coordinate." />}
      </Panel>
    </div>
    <div className="two-col">
      <Panel eyebrow="03 / AGENT" title="Planning agent" action={<button className="text-button" onClick={() => go('agent')}>Runs & trace →</button>}>
        {lastRun ? <div className="detail-stack"><div className="section-row"><strong>Run #{lastRun.id} · {lastRun.trigger === 'auto' ? 'automatic' : 'requested'}</strong><Pill tone={lastRun.status === 'done' ? 'good' : lastRun.status === 'failed' ? 'danger' : 'info'}>{lastRun.status}</Pill></div>
          <p>{lastRun.summary ? plainPreview(lastRun.summary, 240) : lastRun.status === 'queued' ? 'Waiting for the worker holding the agent lease…' : 'Working…'}</p>
          <small className="muted">{lastRun.proposals || lastRun.matches ? `${lastRun.proposals} transfer drafts · ${lastRun.matches} FDA link suggestions` : 'No action needed'}{pendingMatches.length ? ` · ${pendingMatches.length} awaiting review` : ''} · {date(lastRun.createdAt)}</small></div>
          : <Empty title="No agent runs yet" detail="The agent runs on its own when at-risk items change, or on request." />}
      </Panel>
      <Panel eyebrow="04 / SYSTEM" title="Distributed workers" action={<button className="text-button" onClick={() => go('system')}>Leases & health →</button>}>
        <div className="mini-grid"><div><span>Workers online</span><b>{online.length}</b></div><div><span>Leases held</span><b>{state.leases.filter(l => l.holder).length}/{state.leases.length || '—'}</b></div>
          <div><span>Forecast calibration</span><b>{windows ? percent(coverage) : '—'}</b></div><div><span>Backtest windows</span><b>{number(windows)}</b></div></div>
        <small className="muted">{windows ? 'Share of held-out weeks where actual demand fell inside the 80% predicted interval (target ≈ 80%).' : 'Calibration appears once items have three weeks of recorded usage.'}</small>
      </Panel>
    </div>
    <div className="source-note"><Database size={16}/><span>FDA notices update daily; inventory changes when your team records them. This is an operations tool, not clinical guidance.</span></div>
  </div>;
}

function ConnectionChip({ connected, queue }: { connected: boolean; queue: OfflineQueue }) {
  if (!connected) return <div className="status-chip offline"><CloudOff size={14}/> Offline{queue.queue.length ? ` · ${queue.queue.length} queued` : ''}</div>;
  if (queue.flushing || queue.queue.length) return <div className="status-chip syncing"><RefreshCw size={14} className="spin"/> Syncing {queue.queue.length}</div>;
  return <div className="status-chip live"><span className="live-dot"/> Live</div>;
}

export default function App() {
  const state = useSupply();
  const actions = useActions();
  const queue = useOfflineQueue(DB_NAME, state.connected, actions);
  const [view, setView] = useState<View>('overview');
  const [siteFilter, setSiteFilter] = useState(0);
  const [everReady, setEverReady] = useState(false);
  const [message, setMessage] = useState<{ text: string; bad: boolean } | null>(null);
  const [stockPrefill, setStockPrefill] = useState<{ ndc: string; label: string; shortageKey: string } | null>(null);
  const notify: Notify = (text, bad = false) => { setMessage({ text, bad }); window.setTimeout(() => setMessage(null), 5500); };
  useEffect(() => { if (state.ready && state.me) setEverReady(true); }, [state.ready, state.me]);
  const visible = useMemo(() => state.inventory.filter(item =>
    state.me?.role === 'admin' || state.me?.role === 'service' ? (!siteFilter || item.siteId === siteFilter) : item.siteId === state.me?.siteId),
    [state.inventory, state.me, siteFilter]);
  const toast = message && <div className={`toast ${message.bad ? 'bad' : ''}`}>{message.text}</div>;

  if (!state.connected && !everReady) return <div className="gate"><div className="setup-card compact"><div className="brand-mark large">A<span>✦</span></div><div className="eyebrow">CONNECTING TO SPACETIMEDB</div><h1>Opening the supply network…</h1><p>Start the local stack with <code>npm run demo</code>. The browser connects to <code>{DB_NAME}</code> on the machine serving this page.</p></div></div>;
  if (!state.ready && !everReady) return <div className="gate"><div className="setup-card compact"><h1>Loading network state…</h1></div></div>;
  if (!state.initialized && !everReady) return <><Setup actions={actions} notify={notify} />{toast}</>;
  if (!state.me && !everReady) return <><Access state={state} actions={actions} notify={notify} />{toast}</>;
  const me = state.me ?? { name: '…', role: 'viewer', siteId: 0, identity: state.identity };

  const page = view === 'overview' ? <Overview state={state} visible={visible} go={setView} />
    : view === 'inventory' ? <InventoryPage state={state} actions={actions} queue={queue} visible={visible} siteFilter={siteFilter} prefill={stockPrefill} clearPrefill={() => setStockPrefill(null)} notify={notify} />
    : view === 'transfers' ? <TransfersPage state={state} actions={actions} queue={queue} notify={notify} />
    : view === 'agent' ? <AgentPage state={state} actions={actions} notify={notify} />
    : view === 'fda' ? <FdaPage state={state} actions={actions} notify={notify} track={row => { setStockPrefill({ ndc: row.packageNdc, label: row.genericName, shortageKey: row.key }); setView('inventory'); }} />
    : view === 'network' ? <NetworkPage state={state} actions={actions} notify={notify} />
    : <SystemPage state={state} actions={actions} queue={queue} notify={notify} />;

  return <div className="app-shell">
    <aside className="sidebar"><div className="brand"><div className="brand-mark">A<span>✦</span></div><div><b>ARGUS</b><small>SUPPLY NETWORK</small></div></div>
      <div className="nav-label">WORKSPACE</div><nav>{NAV.map(item => <button key={item.id} className={`nav-item ${view === item.id ? 'active' : ''}`} onClick={() => setView(item.id)}><item.icon size={18}/><span>{item.label}</span>{((item.id === 'transfers' && state.proposals.some(row => row.status === 'pending')) || (item.id === 'agent' && state.matches.some(m => m.status === 'pending'))) && <i/>}</button>)}</nav>
      <div className="sidebar-bottom"><div className={`connection-dot ${state.connected ? '' : 'off'}`}/><div><strong>{state.connected ? 'Local network active' : 'Reconnecting…'}</strong><small>{state.workers.filter(w => w.status === 'online').length} worker(s) · {DB_NAME}</small></div></div>
    </aside>
    <div className="content-shell">
      {state.sandbox && <div className="sandbox-banner"><FlaskConical size={15}/> SANDBOX — every site, count, and usage event here is synthetic. FDA notices are real.</div>}
      <header className="topbar"><div><div className="eyebrow">ARGUS / {view.toUpperCase()}</div><strong>{NAV.find(item => item.id === view)?.label}</strong></div><div className="topbar-actions">
        <ConnectionChip connected={state.connected} queue={queue} />
        {me.role === 'admin' && <select aria-label="Site filter" value={siteFilter} onChange={event => setSiteFilter(Number(event.target.value))}><option value={0}>All sites</option>{state.sites.map(site => <option key={site.id} value={site.id}>{site.name}</option>)}</select>}
        <div className="user-chip"><span>{me.name.slice(0, 1).toUpperCase()}</span><div><strong>{me.name}</strong><small>{me.role === 'admin' ? 'Network admin' : siteName(state.sites, me.siteId)}</small></div></div>
      </div></header>
      <main className="main-content">
        <WorkerSetup state={state} actions={actions} notify={notify} openNetwork={() => setView('network')} />
        {queue.conflicts.length > 0 && <div className="notice-strip conflict-strip"><CloudOff size={16}/><span><b>{queue.conflicts.length} offline change{queue.conflicts.length === 1 ? '' : 's'} could not be applied.</b> {queue.conflicts[0].label}: {queue.conflicts[0].error}</span><button className="button ghost small" onClick={() => queue.discardConflict(queue.conflicts[0].opId)}>Dismiss</button></div>}
        {page}
      </main>
    </div>
    {toast}
  </div>;
}
