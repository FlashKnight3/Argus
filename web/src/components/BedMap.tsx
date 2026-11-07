import { BedDouble, Droplet, Footprints, Plane, Scissors, Wind } from 'lucide-react';
import { CATEGORY_LABEL, CATEGORY_STYLE, asCategory } from '../lib/format';
import type { ArgusState, Patient } from '../lib/useArgus';
import { CategoryBadge, Panel, cx } from './ui';

function HeldIcons({ events }: { events: ArgusState['events'] }) {
  const active = events.filter(e => e.status !== 'done');
  const has = (t: string) => active.some(e => e.resourceType === t);
  const queued = (t: string) => active.some(e => e.resourceType === t && e.status === 'queued');
  return (
    <div className="flex items-center gap-1 text-fg-subtle">
      {has('vent') && <Wind className={cx('h-3 w-3', queued('vent') ? 'text-amber' : 'text-info')} aria-label="Ventilator" />}
      {has('or_table') && <Scissors className={cx('h-3 w-3', queued('or_table') ? 'text-amber' : 'text-info')} aria-label="OR" />}
      {has('blood_unit') && <Droplet className="h-3 w-3 text-immediate/80" aria-label="Transfusing" />}
    </div>
  );
}

function BedTile({ label, patient, state, onSelect, selected }: {
  label: string;
  patient: Patient | undefined;
  state: ArgusState;
  onSelect: (id: number) => void;
  selected: boolean;
}) {
  if (!patient) {
    return (
      <div className="flex h-[58px] flex-col justify-between rounded-lg border border-dashed border-line px-2 py-1.5">
        <span className="num text-[10px] text-fg-subtle">{label}</span>
        <span className="text-[10px] text-fg-subtle/70">Open</span>
      </div>
    );
  }
  const c = asCategory(patient.category);
  const s = CATEGORY_STYLE[c];
  const worsening = patient.rtsTrend < -0.3;
  return (
    <button
      type="button"
      onClick={() => onSelect(patient.id)}
      className={cx(
        'group relative flex h-[58px] flex-col justify-between overflow-hidden rounded-lg border px-2 py-1.5 text-left transition-all',
        s.bg,
        s.border,
        selected ? 'ring-2 ring-accent/70' : 'hover:brightness-125'
      )}
      title={`${patient.tag} · ${CATEGORY_LABEL[c]} · T-RTS ${patient.tRts}`}
    >
      <span className={cx('absolute inset-y-0 left-0 w-[3px]', s.dot)} />
      <div className="flex items-center justify-between">
        <span className="num text-[10px] text-fg-subtle">{label}</span>
        <HeldIcons events={state.eventsByPatient.get(patient.id) ?? []} />
      </div>
      <div className="flex items-end justify-between gap-1">
        <span className="num text-[12.5px] font-semibold text-fg">{patient.tag}</span>
        <span className={cx('num text-[10.5px]', worsening ? 'animate-pulse-soft text-immediate' : s.text)}>
          {worsening ? '▼' : ''}
          {patient.tRts}
        </span>
      </div>
    </button>
  );
}

export function BedMap({ state, selectedId, onSelect }: {
  state: ArgusState;
  selectedId: number | null;
  onSelect: (id: number) => void;
}) {
  const waiting = state.patients
    .filter(p => p.status === 'waiting')
    .sort((a, b) => a.arrivalMin - b.arrivalMin);
  const ambulatory = state.patients.filter(p => p.status === 'ambulatory');
  const evacuated = state.patients.filter(p => p.status === 'evacuated');
  const deceased = state.patients.filter(p => p.status === 'deceased');
  const occupied = state.beds.filter(b => b.patientId !== 0).length;
  const counts = (['immediate', 'delayed', 'minimal', 'expectant'] as const).map(c => [
    c,
    state.patients.filter(p => p.category === c && p.status !== 'evacuated' && p.status !== 'deceased').length,
  ] as const);

  return (
    <Panel
      title="Bed map"
      icon={<BedDouble className="h-3.5 w-3.5" />}
      right={
        <span className="num text-[11px] text-fg-muted">
          {occupied}/{state.beds.length} occupied
        </span>
      }
      bodyClassName="flex flex-col gap-3 overflow-y-auto p-3"
    >
      <div className="grid grid-cols-4 gap-2 text-[10.5px]">
        {counts.map(([c, n]) => (
          <div key={c} className={cx('rounded-lg border px-2 py-1.5', CATEGORY_STYLE[c].border, CATEGORY_STYLE[c].bg)}>
            <div className={cx('font-medium', CATEGORY_STYLE[c].text)}>{CATEGORY_LABEL[c]}</div>
            <div className="num text-base font-semibold text-fg">{n}</div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-4 gap-1.5">
        {state.beds.map(b => (
          <BedTile
            key={b.id}
            label={b.label}
            patient={b.patientId ? state.patientsById.get(b.patientId) : undefined}
            state={state}
            onSelect={onSelect}
            selected={selectedId === b.patientId && b.patientId !== 0}
          />
        ))}
      </div>

      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <span className="eyebrow">Holding · no bed</span>
          <span className={cx('num text-[11px]', waiting.length ? 'text-amber' : 'text-fg-subtle')}>{waiting.length}</span>
        </div>
        {waiting.length === 0 ? (
          <div className="rounded-lg border border-dashed border-line px-3 py-2 text-[11px] text-fg-subtle">Nobody waiting for a bed</div>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {waiting.map(p => (
              <button key={p.id} type="button" onClick={() => onSelect(p.id)} className="animate-fade-in">
                <CategoryBadge category={p.category} short className="!py-1" />
                <span className="num ml-1 text-[11px] text-fg-muted">{p.tag}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="mt-auto grid grid-cols-3 gap-2 border-t border-line pt-3 text-[11px]">
        <div className="flex items-center gap-1.5 text-fg-muted">
          <Footprints className="h-3.5 w-3.5 text-minimal" />
          <span className="num font-semibold text-fg">{ambulatory.length}</span> ambulatory
        </div>
        <div className="flex items-center gap-1.5 text-fg-muted">
          <Plane className="h-3.5 w-3.5 text-accent" />
          <span className="num font-semibold text-fg">{evacuated.length}</span> evacuated
        </div>
        <div className="flex items-center gap-1.5 text-fg-muted">
          <span className="h-2 w-2 rounded-full bg-dead ring-1 ring-fg-subtle/40" />
          <span className="num font-semibold text-fg">{deceased.length}</span> deceased
        </div>
      </div>
    </Panel>
  );
}
