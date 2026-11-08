import { useState } from 'react';
import { Radar } from 'lucide-react';
import { errorText } from './ui';
import type { Notify } from './App';
import type { SupplyActions, SupplyState } from './useSupply';

const WORKER_IDENTITY = (import.meta.env.VITE_ARGUS_WORKER_IDENTITY ?? '').trim().toLowerCase();

/** Admin-only banner shown until the FDA worker is authorized and its first import completes. */
export function WorkerSetup({ state, actions, notify, openNetwork }: {
  state: SupplyState; actions: SupplyActions; notify: Notify; openNetwork: () => void;
}) {
  const [busy, setBusy] = useState(false);
  if (state.me?.role !== 'admin') return null;
  const hasService = state.members.some(row => row.role === 'service');
  const status = state.sync?.status ?? 'never';

  if (hasService) {
    if (status === 'complete') return null;
    return <div className="notice-strip worker-setup"><Radar size={16}/><span><b>FDA worker active.</b> {status === 'running'
      ? `Importing the FDA shortage feed: ${state.sync?.recordCount ?? 0} records so far…`
      : 'The first FDA import starts within about 30 seconds.'}</span></div>;
  }

  const activate = async () => {
    setBusy(true);
    try {
      await actions.grantMember({ identity: WORKER_IDENTITY, name: 'FDA worker', role: 'service', siteId: 0 });
      notify('FDA worker activated. The shortage feed will import shortly.');
    } catch (error) { notify(errorText(error), true); }
    finally { setBusy(false); }
  };
  return <div className="notice-strip worker-setup"><Radar size={16}/>
    <span><b>No FDA data yet.</b> The local worker is waiting for permission to import the FDA shortage feed and run forecasts. It cannot approve or move stock.</span>
    {/^[0-9a-f]{64}$/.test(WORKER_IDENTITY)
      ? <button className="button primary" disabled={busy} onClick={activate}>{busy ? 'Activating…' : 'Activate FDA worker'}</button>
      : <button className="button ghost" onClick={openNetwork}>Grant in Network →</button>}
  </div>;
}
