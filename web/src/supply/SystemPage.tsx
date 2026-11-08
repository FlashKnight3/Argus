import { useEffect, useState } from 'react';
import { Activity, CloudOff, Gauge, KeyRound, Server } from 'lucide-react';
import { Empty, Panel, Pill, date, errorText, number, percent, siteName } from './ui';
import type { Notify } from './App';
import type { OfflineQueue } from './offline';
import type { SupplyActions, SupplyState } from './useSupply';

function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), intervalMs); return () => clearInterval(t); }, [intervalMs]);
  return now;
}

const resourceLabel = (state: SupplyState, resource: string) => {
  const m = /^site:(\d+)$/.exec(resource);
  return m ? `Forecasts · ${siteName(state.sites, Number(m[1]))}` : resource === 'fda' ? 'FDA import' : resource === 'agent' ? 'Planning agent' : resource;
};

export function SystemPage({ state, actions, queue, notify }: { state: SupplyState; actions: SupplyActions; queue: OfflineQueue; notify: Notify }) {
  const now = useNow();
  const admin = state.me?.role === 'admin';
  const [ttl, setTtl] = useState(String(state.config?.reservationTtlHours ?? 24));
  const [autoRun, setAutoRun] = useState(state.config?.agentAutoRun ?? true);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (state.config) { setTtl(String(state.config.reservationTtlHours)); setAutoRun(state.config.agentAutoRun); } }, [state.config]);
  const online = state.workers.filter(w => w.status === 'online');
  const stopped = state.workers.filter(w => w.status !== 'online');
  const events = state.activity.filter(a => /^(lease|worker|agent\.(queue|done|failed)|transfer\.expire|config)/.test(a.action)).slice(0, 25);
  const save = async () => {
    setBusy(true);
    try { await actions.setNetworkConfig({ reservationTtlHours: Number(ttl), agentAutoRun: autoRun }); notify('Settings saved.'); }
    catch (error) { notify(errorText(error), true); }
    finally { setBusy(false); }
  };

  return <div className="page-stack">
    <div className="page-intro"><div><div className="eyebrow">DISTRIBUTED SYSTEM / LIVE</div><h1>System</h1>
      <p>Background workers do the automatic work: forecasting each site, importing the FDA feed, and running the agent. This page shows who is doing what, and proves the system keeps working when a worker fails.</p></div></div>
    <div className="two-col">
      <Panel eyebrow="WORKER POOL" title={`${online.length} worker${online.length === 1 ? '' : 's'} online`}>
        <p className="help">Each worker checks in every 2 seconds. If one goes quiet for 10 seconds it's marked offline and the others take over its jobs. Stopped workers disappear from this list after a minute; a restart shows up as a new worker.</p>
        {online.length ? <div className="table-scroll"><table className="data-table"><thead><tr><th>Worker</th><th>Status</th><th>Last heartbeat</th><th>Leases</th></tr></thead><tbody>
          {online.map(w => { const age = Math.max(0, (now - Number(w.lastSeenMicros / 1000n)) / 1000);
            return <tr key={w.id}><td><strong>{w.name}</strong><small title={w.id}>{w.id.slice(-18)} · v{w.version}</small></td><td><Pill tone={w.status === 'online' ? 'good' : 'neutral'}>{w.status}</Pill></td><td>{age < 120 ? `${age.toFixed(0)} s ago` : date({ microsSinceUnixEpoch: w.lastSeenMicros })}</td><td>{state.leases.filter(l => l.holder === w.id).length}</td></tr>; })}
        </tbody></table></div> : <Empty title="No workers running" detail="Start the app with npm run demo (it starts two workers), and make sure the worker has the service role." />}
        {stopped.length > 0 && <small className="muted">{stopped.length} recently stopped worker{stopped.length === 1 ? '' : 's'} ({stopped.map(w => w.name).join(', ')}): their jobs were handed to the online workers.</small>}
      </Panel>
      <Panel eyebrow="WHO IS DOING WHAT" title={`${state.leases.length} jobs`}>
        <p className="help">Each job is held by exactly one worker at a time and renewed every couple of seconds (the countdown). <b>Epoch</b> counts how many times the job has changed hands; the database rejects any write tagged with an older epoch, so a frozen worker that wakes up late can't overwrite newer work.</p>
        {state.leases.length ? <div className="table-scroll"><table className="data-table"><thead><tr><th>Resource</th><th>Holder</th><th>Epoch</th><th>Expires</th></tr></thead><tbody>
          {state.leases.map(l => { const left = (Number(l.expiresAtMicros / 1000n) - now) / 1000; const live = !!l.holder && left > 0;
            return <tr key={l.resource}><td><strong>{resourceLabel(state, l.resource)}</strong><small>{l.resource}</small></td><td>{live ? state.workers.find(w => w.id === l.holder)?.name ?? l.holder : <span className="muted">unassigned</span>}</td><td><code>{String(l.epoch)}</code></td><td>{live ? <Pill tone={left < 4 ? 'watch' : 'good'}>{left.toFixed(0)} s</Pill> : <Pill>expired</Pill>}</td></tr>; })}
        </tbody></table></div> : <Empty title="No leases yet" detail="Leases appear as soon as a worker heartbeats." />}
      </Panel>
    </div>
    <div className="two-col">
      <Panel eyebrow="INFERENCE QUALITY" title="How accurate are the forecasts?">
        <p className="help">Each week of past usage is hidden from the model, it predicts that week, and we check whether the real number fell inside its 80% range. Close to 80% means the ranges can be trusted.</p>
        {state.metrics.length ? <div className="table-scroll"><table className="data-table"><thead><tr><th>Site</th><th>80% interval coverage</th><th>MAE (7-day units)</th><th>Bias</th></tr></thead><tbody>
          {state.metrics.map(m => <tr key={m.key}><td><strong>{siteName(state.sites, m.siteId)}</strong><small>{m.itemsEvaluated} items · {m.windows} weekly windows</small></td>
            <td><Pill tone={Math.abs(m.coverage80 - 0.8) <= 0.1 ? 'good' : 'watch'}>{percent(m.coverage80)}</Pill></td><td>{number(m.meanAbsError, 1)}</td><td>{m.bias >= 0 ? '+' : ''}{number(m.bias, 1)}</td></tr>)}
        </tbody></table></div> : <Empty title="Not enough history yet" detail="This needs about three weeks of recorded usage at a site. Record usage on the Inventory page (or try the sandbox, which has 60 days)." />}
        <small className="muted"><Gauge size={12}/> At weekly origins the model is refit on prior data only and predicts the next 7 days. Well-calibrated 80% intervals contain the actual demand about 80% of the time.</small>
      </Panel>
      <Panel eyebrow="THIS BROWSER" title="Offline changes">
        <p className="help">If this browser loses its connection, changes you make are saved here and sent automatically when it reconnects. Each is applied exactly once. All zeros means everything is synced.</p>
        <div className="mini-grid"><div><span>Connection</span><b>{state.connected ? 'Live' : 'Offline'}</b></div><div><span>Queued writes</span><b>{queue.queue.length}</b></div><div><span>Conflicts</span><b>{queue.conflicts.length}</b></div><div><span>Identity</span><b title={state.identity}>{state.identity.slice(0, 10)}…</b></div></div>
        {queue.queue.map(op => <div className="list-row" key={op.opId}><div><strong>{op.label}</strong><small>{op.opId.slice(0, 8)} · queued {new Date(op.queuedAt).toLocaleTimeString()}</small></div><Pill tone="watch">pending</Pill></div>)}
        {queue.conflicts.map(op => <div className="list-row" key={op.opId}><div><strong>{op.label}</strong><small>{op.error}</small></div><button className="button ghost small" onClick={() => queue.discardConflict(op.opId)}>Dismiss</button></div>)}
        <small className="muted"><CloudOff size={12}/> Writes made while offline replay in order with their operation IDs; the database applies each at most once.</small>
      </Panel>
    </div>
    <div className="two-col">
      <Panel eyebrow="COORDINATION LOG" title="Leases, failover, expiries">
        {events.length ? <div className="event-list wide">{events.map(e => <div key={e.id}><span>{e.action}</span><b>{e.detail}</b><small>{date(e.at)}</small></div>)}</div> : <Empty title="Quiet" detail="Lease handoffs, worker failures, and expired reservations show up here." />}
      </Panel>
      <Panel eyebrow="SETTINGS" title="Network policies">
        <div className="form-grid"><label>Release unshipped reservations after (hours, 0 = never)<input type="number" min="0" step="any" value={ttl} disabled={!admin} onChange={e => setTtl(e.target.value)}/></label>
          <label className="checkbox"><input type="checkbox" checked={autoRun} disabled={!admin} onChange={e => setAutoRun(e.target.checked)}/> Let the agent start runs when at-risk items change</label></div>
        {admin && <button className="button primary" disabled={busy || !(Number(ttl) >= 0)} onClick={save}><KeyRound size={15}/> Save settings</button>}
        <div className="source-note"><Server size={14}/><span>{state.sandbox ? 'Sandbox network: synthetic data only.' : 'Production-style network: no synthetic data.'} <Activity size={12}/> SpacetimeDB sweep runs every 2 s.</span></div>
      </Panel>
    </div>
  </div>;
}
