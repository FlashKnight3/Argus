import { useEffect, useState } from 'react';
import { PageHead, Pill, Section, Tabs, errorText, percent, siteName } from './ui';
import type { Notify } from './App';
import type { SupplyActions, SupplyState } from './useSupply';

function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(t); }, [ms]);
  return now;
}

const jobName = (state: SupplyState, resource: string) => {
  const m = /^site:(\d+)$/.exec(resource);
  return m ? `Forecasting · ${siteName(state.sites, Number(m[1]))}` : resource === 'fda' ? 'FDA import' : resource === 'agent' ? 'Planning agent' : resource;
};

export function SystemPage({ state, actions, notify }: { state: SupplyState; actions: SupplyActions; notify: Notify }) {
  const now = useNow();
  const admin = state.me?.role === 'admin';
  const [tab, setTab] = useState<'status' | 'settings'>('status');
  const online = state.workers.filter(w => w.status === 'online');
  const healthy = online.length > 0 && state.leases.every(l => l.holder && Number(l.expiresAtMicros / 1000n) > now);

  return <>
    <PageHead title="System" subtitle="The background workers that keep forecasts, the FDA feed, and the agent running." />
    <Tabs value={tab} onChange={setTab} tabs={[{ id: 'status', label: 'Status' }, ...(admin ? [{ id: 'settings' as const, label: 'Settings' }] : [])]} />
    {tab === 'status' && <>
      <div className={`notice ${healthy ? 'green' : 'amber'}`}><span><b>{healthy ? 'Everything is running.' : online.length ? 'Some jobs are being reassigned…' : 'No workers are running.'}</b> {online.length} worker{online.length === 1 ? '' : 's'} online.
        {' '}If a worker stops, another takes over its jobs within about 10 seconds.</span></div>
      <Section title="Who is doing what" subtitle="Each job is held by one worker and renewed every 2 seconds. “Handoffs” counts how many times a job has moved between workers; old holders can't write once it moves.">
        <div className="table-wrap"><table className="table"><thead><tr><th>Job</th><th>Worker</th><th className="num">Handoffs</th><th>Status</th></tr></thead><tbody>
          {state.leases.map(l => { const left = (Number(l.expiresAtMicros / 1000n) - now) / 1000; const live = !!l.holder && left > 0;
            return <tr key={l.resource}><td><strong>{jobName(state, l.resource)}</strong></td><td>{live ? state.workers.find(w => w.id === l.holder)?.name ?? '—' : <span className="muted">reassigning…</span>}</td>
              <td className="num">{String(l.epoch)}</td><td>{live ? <Pill tone="good">Active</Pill> : <Pill tone="watch">Waiting</Pill>}</td></tr>; })}
          {!state.leases.length && <tr><td colSpan={4} className="muted">No jobs yet. Start the workers with <code>npm run demo</code>.</td></tr>}
        </tbody></table></div>
      </Section>
    </>}
    {tab === 'settings' && admin && <Settings state={state} actions={actions} notify={notify} />}
  </>;
}

function Settings({ state, actions, notify }: { state: SupplyState; actions: SupplyActions; notify: Notify }) {
  const c = state.config;
  const [f, setF] = useState({ ttl: String(c?.reservationTtlHours ?? 24), auto: c?.agentAutoRun ?? true, mult: String(c?.shortageLeadMultiplier ?? 2.5), llm: c?.llmAllowed ?? true });
  useEffect(() => { if (c) setF({ ttl: String(c.reservationTtlHours), auto: c.agentAutoRun, mult: String(c.shortageLeadMultiplier), llm: c.llmAllowed }); }, [c]);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try { await actions.setNetworkConfig({ reservationTtlHours: Number(f.ttl), agentAutoRun: f.auto, shortageLeadMultiplier: Number(f.mult), llmAllowed: f.llm }); notify('Settings saved. Forecasts update within a few seconds.'); }
    catch (e) { notify(errorText(e), true); } finally { setBusy(false); }
  };
  return <div className="card" style={{ maxWidth: 760 }}>
    <div className="form-grid">
      <label>Slower resupply during an FDA shortage (×)<input type="number" min="1" max="10" step="0.1" value={f.mult} onChange={e => setF({ ...f, mult: e.target.value })} />
        <span className="help">For drugs on an active FDA shortage, normal resupply time is multiplied by this. 1 = no adjustment. Lower it if items look more at risk than they are.</span></label>
      <label>Release unshipped reservations after (hours)<input type="number" min="0" step="any" value={f.ttl} onChange={e => setF({ ...f, ttl: e.target.value })} />
        <span className="help">Reserved stock that never ships is freed after this long. 0 = never.</span></label>
      <label className="check full"><input type="checkbox" checked={f.auto} onChange={e => setF({ ...f, auto: e.target.checked })} /> Run the agent automatically when products become at risk</label>
      <label className="check full"><input type="checkbox" checked={f.llm} onChange={e => setF({ ...f, llm: e.target.checked })} /> Allow the agent to use Claude (sends product names, NDCs, quantities, and site names to the Anthropic API). Off = built-in planner only.</label>
    </div>
    <div className="modal-foot"><small>{state.sandbox ? 'Sandbox network' : 'Live network'} · current forecast accuracy {state.metrics.length ? percent(state.metrics.reduce((s, m) => s + m.coverage80 * m.windows, 0) / Math.max(1, state.metrics.reduce((n, m) => n + m.windows, 0))) : '—'}</small>
      <button className="button primary" disabled={busy || !(Number(f.mult) >= 1 && Number(f.mult) <= 10) || !(Number(f.ttl) >= 0)} onClick={save}>Save settings</button></div>
  </div>;
}
