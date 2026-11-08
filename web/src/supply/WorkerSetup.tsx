import { useState } from 'react';
import { Radar } from 'lucide-react';
import { errorText } from './ui';
import type { Notify } from './App';
import type { SupplyActions, SupplyState } from './useSupply';

const WORKER_IDENTITY = (import.meta.env.VITE_ARGUS_WORKER_IDENTITY ?? '').trim().toLowerCase();

/** Admin-only banner shown until the background workers are authorized and the first FDA import completes. */
export function WorkerSetup({ state, actions, notify, openNetwork }: {
  state: SupplyState; actions: SupplyActions; notify: Notify; openNetwork: () => void;
}) {
  const [busy, setBusy] = useState(false);
  if (state.me?.role !== 'admin') return null;
  const hasService = state.members.some(row => row.role === 'service');
  const status = state.sync?.status ?? 'never';
  if (hasService) {
    if (status === 'complete') return null;
    return <div className="notice green"><Radar size={16}/><span>{status === 'running'
      ? `Importing the FDA shortage feed: ${state.sync?.recordCount ?? 0} records so far…` : 'Background workers are active. The first FDA import starts within a few seconds.'}</span></div>;
  }
  const activate = async () => {
    setBusy(true);
    try {
      await actions.grantMember({ identity: WORKER_IDENTITY, name: 'Agent workers', role: 'service', siteId: 0 });
      notify('Workers activated. The FDA shortage feed will import shortly.');
    } catch (error) { notify(errorText(error), true); } finally { setBusy(false); }
  };
  return <div className="notice green"><Radar size={16}/>
    <span><b>Turn on the background workers.</b> They import the FDA shortage feed, forecast every product, and run the planning agent. They can't approve or move stock.</span>
    {/^[0-9a-f]{64}$/.test(WORKER_IDENTITY)
      ? <button className="button primary small" disabled={busy} onClick={activate}>{busy ? 'Activating…' : 'Activate workers'}</button>
      : <button className="button ghost small" onClick={openNetwork}>Set up in Network</button>}
  </div>;
}
