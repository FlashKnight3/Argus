import { useState } from 'react';
import { BedMap } from '../components/BedMap';
import { EvacQueue } from '../components/EvacQueue';
import { AlertFeed, DecisionLog } from '../components/Feeds';
import { Gauges } from '../components/Gauges';
import { InflowWhatIf } from '../components/InflowWhatIf';
import { PatientDrawer } from '../components/PatientDrawer';
import { TopBar } from '../components/TopBar';
import type { ArgusState } from '../lib/useArgus';

/**
 * One commander screen does the demo:
 *  top: clock · left: bed map · centre: burn-down gauges · right: evac queue ·
 *  bottom: alerts and the decision log.
 */
export function Commander({ state, onError }: { state: ArgusState; onError: (m: string) => void }) {
  const [selected, setSelected] = useState<number | null>(null);
  return (
    <div className="flex h-full min-h-[920px] flex-col">
      <TopBar state={state} onError={onError} />
      <main className="grid min-h-0 flex-1 grid-cols-[minmax(300px,21%)_1fr_minmax(340px,24%)] grid-rows-[minmax(0,1fr)_minmax(150px,22%)] [@media(min-height:1000px)]:grid-rows-[minmax(0,1fr)_minmax(180px,26%)] gap-3 p-3">
        <BedMap state={state} selectedId={selected} onSelect={setSelected} />
        <div className="grid min-h-0 grid-rows-[minmax(0,1fr)_auto] gap-3">
          <Gauges state={state} />
          <InflowWhatIf state={state} onError={onError} />
        </div>
        <EvacQueue state={state} onError={onError} />
        <div className="col-span-3 grid min-h-0 grid-cols-[1.35fr_1fr] gap-3">
          <AlertFeed state={state} />
          <DecisionLog state={state} />
        </div>
      </main>
      {selected !== null && <PatientDrawer state={state} patientId={selected} onClose={() => setSelected(null)} onError={onError} />}
    </div>
  );
}
