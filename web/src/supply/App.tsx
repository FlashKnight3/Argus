import { useEffect, useMemo, useState } from 'react';
import { ArrowLeftRight, Bot, Boxes, ChevronDown, CloudOff, FlaskConical, House, LogIn, LogOut, Network, Power, Radar, RefreshCw, Server, ShieldCheck } from 'lucide-react';
import { InventoryPage } from './InventoryPage';
import { TransfersPage } from './TransfersPage';
import { FdaPage } from './FdaPage';
import { NetworkPage } from './NetworkPage';
import { AgentPage } from './AgentPage';
import { SystemPage } from './SystemPage';
import { WorkerSetup } from './WorkerSetup';
import { AuthNotConfigured, Connecting, CreateNetwork, LegacySignIn, Logo, NoAccess, SignIn } from './AuthScreens';
import { useSession, type Session } from './session';
import { plainPreview } from './Markdown';
import { DB_NAME } from './connection';
import { isCurrentShortage } from './fda';
import { useOfflineQueue, type OfflineQueue } from './offline';
import { Empty, PageHead, Pill, Section, date, errorText, number, percent, riskLabel, riskTone, siteName } from './ui';
import { useActions, useSupply, type Inventory, type SupplyActions, type SupplyState } from './useSupply';

export type Notify = (message: string, bad?: boolean) => void;
export type View = 'home' | 'inventory' | 'transfers' | 'agent' | 'fda' | 'network' | 'system';
export type Prefill = { ndc: string; label: string; shortageKey: string } | null;

const MENU: Array<{ id: View; label: string; icon: typeof House }> = [
  { id: 'home', label: 'Home', icon: House },
  { id: 'inventory', label: 'Inventory', icon: Boxes },
  { id: 'transfers', label: 'Transfers', icon: ArrowLeftRight },
  { id: 'agent', label: 'Agent', icon: Bot },
  { id: 'fda', label: 'FDA watch', icon: Radar },
];
const ADMIN: Array<{ id: View; label: string; icon: typeof House }> = [
  { id: 'network', label: 'Network', icon: Network },
  { id: 'system', label: 'System', icon: Server },
];

function Home({ state, visible, go }: { state: SupplyState; visible: Inventory[]; go: (view: View) => void }) {
  const fresh = (item: Inventory) => { const f = state.forecasts.get(item.key); return f?.inventoryRevision === item.revision ? f : undefined; };
  const atRisk = visible.filter(item => ['critical', 'watch'].includes(fresh(item)?.risk ?? ''))
    .sort((a, b) => (fresh(b)?.pStockout ?? 0) - (fresh(a)?.pStockout ?? 0));
  const critical = atRisk.filter(i => fresh(i)?.risk === 'critical').length;
  const openTransfers = state.transfers.filter(row => !['received', 'cancelled'].includes(row.status));
  const drafts = state.proposals.filter(row => row.status === 'pending');
  const lastRun = state.agentRuns.find(r => r.status === 'done') ?? state.agentRuns[0];
  const windows = state.metrics.reduce((n, m) => n + m.windows, 0);
  const coverage = windows ? state.metrics.reduce((s, m) => s + m.coverage80 * m.windows, 0) / windows : 0;
  const hour = new Date().getHours();

  return <>
    <PageHead title={`Good ${hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening'}, ${state.me?.name.split(' ')[0] ?? ''}`}
      subtitle="What's at risk across your pharmacies, and what the agent suggests doing about it." />
    <div className="grid-4" style={{ margin: '24px 0 30px' }}>
      <button className={`stat ${critical ? 'alert' : ''}`} onClick={() => go('inventory')}><span>At risk of running out</span><strong>{atRisk.length}</strong><small>{critical} critical before resupply</small></button>
      <button className="stat" onClick={() => go('transfers')}><span>Transfer drafts to review</span><strong>{drafts.length}</strong><small>{openTransfers.length} transfers in progress</small></button>
      <button className="stat" onClick={() => go('inventory')}><span>Products tracked</span><strong>{visible.length}</strong><small>across {state.sites.length} site{state.sites.length === 1 ? '' : 's'}</small></button>
      <button className="stat" onClick={() => go('fda')}><span>FDA shortages</span><strong>{number(state.shortages.filter(isCurrentShortage).length)}</strong><small>{state.sync?.feedDate ? `Feed updated ${state.sync.feedDate}` : 'Not imported yet'}</small></button>
    </div>
    <div className="split">
      <Section title="Needs attention" subtitle="Ranked by chance of running out before new stock arrives." action={<button className="link" onClick={() => go('inventory')}>All inventory</button>}>
        {atRisk.length ? <div className="table-wrap"><table className="table"><thead><tr><th>Product</th><th>Site</th><th>Risk</th><th className="num">Runs out in</th></tr></thead><tbody>
          {atRisk.slice(0, 8).map(item => { const f = fresh(item)!;
            return <tr key={item.key} className="clickable" onClick={() => go('inventory')}><td><strong title={item.label}>{item.label}</strong><small>NDC {item.ndc}</small></td><td>{siteName(state.sites, item.siteId)}</td>
              <td><Pill tone={riskTone(f.risk)}>{percent(f.pStockout)} · {riskLabel(f.risk)}</Pill></td><td className="num">{number(f.daysP10, 1)}–{number(f.daysMedian, 1)} days</td></tr>; })}
        </tbody></table></div> : <div className="card"><Empty title="Nothing at risk" detail={visible.length ? 'No tracked product is projected to run out before resupply.' : 'Add products on the Inventory page to start monitoring.'} /></div>}
      </Section>
      <div>
        <Section title="Latest from the agent" action={<button className="link" onClick={() => go('agent')}>Open agent</button>}>
          <div className="card">{lastRun ? <>
            <div className="inline" style={{ justifyContent: 'space-between' }}><small>Run #{lastRun.id} · {date(lastRun.createdAt)}</small>
              <Pill tone={lastRun.proposals || lastRun.matches ? 'good' : 'neutral'}>{lastRun.proposals || lastRun.matches ? `${lastRun.proposals} drafts · ${lastRun.matches} links` : 'No action needed'}</Pill></div>
            <p className="help" style={{ marginTop: 10, color: 'var(--text-2)' }}>{lastRun.summary ? plainPreview(lastRun.summary, 260) : 'Working…'}</p></>
            : <Empty title="No agent runs yet" detail="The agent runs automatically when products become at risk." />}</div>
        </Section>
        <Section title="Forecast accuracy">
          <div className="card"><div className="inline" style={{ justifyContent: 'space-between' }}><span className="big-number">{windows ? percent(coverage) : '—'}</span>
            {windows > 0 && <Pill tone={Math.abs(coverage - 0.8) <= 0.1 ? 'good' : 'watch'}>target ≈ 80%</Pill>}</div>
            <p className="help" style={{ marginTop: 6 }}>{windows ? `Of ${windows} past weeks, this share of actual usage fell inside the forecast's 80% range.` : 'Appears after about three weeks of recorded usage.'}</p></div>
        </Section>
      </div>
    </div>
  </>;
}

function ConnectionChip({ connected, queue }: { connected: boolean; queue: OfflineQueue }) {
  if (!connected) return <div className="status-chip offline"><CloudOff size={14}/> Offline{queue.queue.length ? ` · ${queue.queue.length} saved` : ''}</div>;
  if (queue.flushing || queue.queue.length) return <div className="status-chip syncing"><RefreshCw size={14} className="spin"/> Syncing</div>;
  return <div className="status-chip"><span className="live-dot"/> Live</div>;
}

/** One-time move for an admin who signed up before SpacetimeAuth: invite your email, then sign in with it. */
function SwitchToSignIn({ session, actions, notify }: { session: Session; actions: SupplyActions; notify: Notify }) {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try { await actions.inviteMember({ email, name: '', role: 'admin', siteId: 0 }); session.signIn(); }
    catch (e) { notify(errorText(e), true); setBusy(false); }
  };
  return <div className="notice amber"><ShieldCheck size={16}/><span><b>Switch to SpacetimeAuth sign-in.</b> You're signed in on this browser only. Enter the email you'll sign in with; it's invited as an admin, then you sign in and keep full access on any device.</span>
    <input type="email" placeholder="you@hospital.org" value={email} onChange={e => setEmail(e.target.value)} style={{ minWidth: 220 }} />
    <button className="button small primary" disabled={busy || !/@/.test(email)} onClick={go}><LogIn size={14}/> Invite & sign in</button></div>;
}

export default function App() {
  const state = useSupply();
  const actions = useActions();
  const session = useSession();
  const queue = useOfflineQueue(DB_NAME, state.connected, actions);
  const [view, setView] = useState<View>('home');
  const [siteFilter, setSiteFilter] = useState(0);
  const [everReady, setEverReady] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [message, setMessage] = useState<{ text: string; bad: boolean } | null>(null);
  const [prefill, setPrefill] = useState<Prefill>(null);
  const notify: Notify = (text, bad = false) => { setMessage({ text, bad }); window.setTimeout(() => setMessage(null), 5500); };
  useEffect(() => { if (state.ready && state.me) setEverReady(true); if (state.ready && state.connected && !state.me) setEverReady(false); }, [state.ready, state.me, state.connected]);
  const visible = useMemo(() => state.inventory.filter(item =>
    state.me?.role === 'admin' ? (!siteFilter || item.siteId === siteFilter) : item.siteId === state.me?.siteId),
    [state.inventory, state.me, siteFilter]);
  const toast = message && <div className={`toast ${message.bad ? 'bad' : ''}`}>{message.text}</div>;

  if (!state.connected && !everReady) return <Connecting db={DB_NAME} />;
  if (!state.ready && !everReady) return <Connecting db={DB_NAME} />;
  if (!state.me && !everReady) {
    if (!session.enabled) return <>{state.initialized && !state.sandbox
      ? <LegacySignIn state={state} actions={actions} />
      : <AuthNotConfigured state={state} actions={actions} />}{toast}</>;
    if (!state.initialized) return <><CreateNetwork session={session} actions={actions} />{toast}</>;
    if (!session.signedIn) return <><SignIn state={state} session={session} actions={actions} />{toast}</>;
    return <><NoAccess state={state} session={session} actions={actions} />{toast}</>;
  }
  const me = state.me ?? { name: '…', role: 'viewer', siteId: 0, identity: state.identity, email: '' };
  const admin = me.role === 'admin';
  const legacy = session.enabled && !session.signedIn && !state.sandbox;
  const signOut = async () => {
    setMenuOpen(false);
    if (session.signedIn) { await session.signOut(); return; }
    if (!session.enabled && me.email && !state.sandbox) {
      try { await actions.legacySignOut(); } catch (e) { notify(errorText(e), true); }
      return;
    }
    notify(legacy ? 'This browser-only admin has no sign-in to leave. Switch to SpacetimeAuth sign-in first.' : 'Sign-in is not configured for this deployment.', true);
  };
  const go = (v: View) => { setView(v); window.scrollTo(0, 0); };
  const badge = (id: View) => (id === 'transfers' && state.proposals.some(p => p.status === 'pending')) || (id === 'agent' && state.matches.some(m => m.status === 'pending'));

  const page = view === 'home' ? <Home state={state} visible={visible} go={go} />
    : view === 'inventory' ? <InventoryPage state={state} actions={actions} queue={queue} visible={visible} siteFilter={siteFilter} prefill={prefill} clearPrefill={() => setPrefill(null)} notify={notify} />
    : view === 'transfers' ? <TransfersPage state={state} actions={actions} queue={queue} notify={notify} />
    : view === 'agent' ? <AgentPage state={state} actions={actions} notify={notify} />
    : view === 'fda' ? <FdaPage state={state} actions={actions} notify={notify} track={row => { setPrefill({ ndc: row.packageNdc, label: row.genericName, shortageKey: row.key }); go('inventory'); }} />
    : view === 'network' ? <NetworkPage state={state} actions={actions} notify={notify} />
    : <SystemPage state={state} actions={actions} notify={notify} />;

  return <div className="shell">
    {state.sandbox ? <div className="sandbox-banner"><FlaskConical size={14}/> Sandbox: every site, count, and usage event here is synthetic. FDA notices are real.</div> : <div />}
    <header className="topbar"><Logo />
      <div className="topbar-right">
        <ConnectionChip connected={state.connected} queue={queue} />
        {admin && state.sites.length > 1 && <select aria-label="Site filter" value={siteFilter} onChange={e => setSiteFilter(Number(e.target.value))}><option value={0}>All sites</option>{state.sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select>}
        <div className="topbar-divider" />
        <div className="user-menu">
          <button className="user-button" onClick={() => setMenuOpen(o => !o)} aria-expanded={menuOpen}><span className="avatar">{me.name.slice(0, 1).toUpperCase()}</span>
            <div><strong>{me.name}</strong><small>{admin ? 'Network admin' : `${me.role === 'manager' ? 'Manager' : 'Viewer'} · ${siteName(state.sites, me.siteId)}`}</small></div><ChevronDown size={15} className="muted"/></button>
          {menuOpen && <div className="dropdown" onMouseLeave={() => setMenuOpen(false)}>
            <div className="dropdown-head"><strong>{me.name}</strong><small>{me.email || (state.sandbox ? 'Sandbox guest' : 'Browser-only sign-in')}</small>
              <small>{session.signedIn ? 'Signed in with SpacetimeAuth' : ''}</small></div>
            <button className="danger" onClick={signOut}><LogOut size={15}/> Sign out</button>
          </div>}
        </div>
      </div>
    </header>
    <div className="body">
      <aside className="sidebar">
        <div className="nav-label">MENU</div>
        <nav>{MENU.map(item => <button key={item.id} className={`nav-item ${view === item.id ? 'active' : ''}`} onClick={() => go(item.id)}><item.icon size={18}/><span>{item.label}</span>{badge(item.id) && <i className="nav-dot"/>}</button>)}
          <div className="nav-label" style={{ marginTop: 26 }}>NETWORK</div>
          {ADMIN.map(item => <button key={item.id} className={`nav-item ${view === item.id ? 'active' : ''}`} onClick={() => go(item.id)}><item.icon size={18}/><span>{item.label}</span></button>)}</nav>
        <div className="sidebar-foot"><div><small>{state.workers.filter(w => w.status === 'online').length} worker{state.workers.filter(w => w.status === 'online').length === 1 ? '' : 's'} online</small><small className="mono">{DB_NAME}</small></div>
          <button className="power" title="Sign out" onClick={signOut}><Power size={18}/></button></div>
      </aside>
      <main className="main">
        <WorkerSetup state={state} actions={actions} notify={notify} openNetwork={() => go('network')} />
        {legacy && admin && <SwitchToSignIn session={session} actions={actions} notify={notify} />}
        {queue.conflicts.length > 0 && <div className="notice amber"><CloudOff size={16}/><span><b>{queue.conflicts.length} offline change{queue.conflicts.length === 1 ? '' : 's'} could not be applied.</b> {queue.conflicts[0].label}: {queue.conflicts[0].error}</span><button className="button small ghost" onClick={() => queue.discardConflict(queue.conflicts[0].opId)}>Dismiss</button></div>}
        {page}
      </main>
    </div>
    {toast}
  </div>;
}
