import { ClipboardList, Droplet, HeartPulse, Scissors, ShieldAlert, Wind, X } from 'lucide-react';
import { useState } from 'react';
import { PRECEDENCE_LABEL, injurySpec, type Precedence, type TriageCategory } from '@protocols';
import { CATEGORY_LABEL, CATEGORY_STYLE, asCategory, clock, errorMessage, minutes, round, safeJson } from '../lib/format';
import { useActions, type ArgusState } from '../lib/useArgus';
import { CategoryBadge, PrecedenceBadge, cx } from './ui';

const RESOURCE_ICON: Record<string, React.ReactNode> = {
  vent: <Wind className="h-3.5 w-3.5" />,
  or_table: <Scissors className="h-3.5 w-3.5" />,
  blood_unit: <Droplet className="h-3.5 w-3.5" />,
  o2: <Wind className="h-3.5 w-3.5" />,
};

function Vital({ label, value, unit, alarm }: { label: string; value: number; unit?: string; alarm?: boolean }) {
  return (
    <div className={cx('rounded-lg border px-2.5 py-2', alarm ? 'border-red/40 bg-red/10' : 'border-line bg-ink-800/60')}>
      <div className="eyebrow">{label}</div>
      <div className={cx('num mt-0.5 text-lg font-semibold', alarm ? 'text-red' : 'text-fg')}>
        {round(value)}
        {unit && <span className="ml-0.5 text-[11px] font-normal text-fg-subtle">{unit}</span>}
      </div>
    </div>
  );
}

export function PatientDrawer({ state, patientId, onClose, onError }: {
  state: ArgusState;
  patientId: number;
  onClose: () => void;
  onError: (m: string) => void;
}) {
  const { setTriage } = useActions();
  const p = state.patientsById.get(patientId);
  const [category, setCategory] = useState<TriageCategory | ''>('');
  const [reason, setReason] = useState('');
  if (!p) return null;

  const c = asCategory(p.category);
  const trace = safeJson<string[]>(p.triageTrace, []);
  const mist = safeJson<Record<string, string>>(p.mistCard, {});
  const events = (state.eventsByPatient.get(p.id) ?? []).filter(e => e.status !== 'done');
  const minute = state.sim?.minute ?? 0;
  const left = p.precedenceDeadline - minute;
  const bed = state.beds.find(b => b.id === p.bedId);

  const submit = () => {
    if (!category) return;
    setTriage({ patientId: p.id, category, reason })
      .then(() => {
        setCategory('');
        setReason('');
      })
      .catch(e => onError(errorMessage(e)));
  };

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-ink-950/60 backdrop-blur-[2px]" onClick={onClose}>
      <aside
        className="animate-slide-in flex h-full w-[440px] max-w-full flex-col border-l border-line bg-ink-900 shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <header className={cx('relative border-b border-line px-5 pb-4 pt-5')}>
          <div className={cx('absolute inset-x-0 top-0 h-1', CATEGORY_STYLE[c].dot)} />
          <div className="flex items-start justify-between">
            <div>
              <div className="flex items-center gap-2">
                <span className="num text-xl font-semibold text-fg">{p.tag}</span>
                <CategoryBadge category={p.category} />
                <PrecedenceBadge precedence={p.evacPrecedence} full />
              </div>
              <div className="mt-1 text-[12px] text-fg-muted">
                {p.age} y · {injurySpec(p.injuryType).label} · {bed ? bed.label : p.status} · arrived {clock(p.arrivalMin)}
              </div>
            </div>
            <button type="button" onClick={onClose} className="rounded-md p-1 text-fg-subtle hover:bg-ink-700 hover:text-fg" aria-label="Close">
              <X className="h-4 w-4" />
            </button>
          </div>
        </header>

        <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
          <section>
            <div className="mb-2 flex items-center justify-between">
              <span className="eyebrow flex items-center gap-1.5">
                <HeartPulse className="h-3.5 w-3.5" /> Vitals · {clock(p.vitalsMin)}
              </span>
              <span className={cx('num text-[11px]', p.rtsTrend < -0.3 ? 'text-red' : 'text-fg-subtle')}>
                trend {p.rtsTrend >= 0 ? '+' : ''}
                {round(p.rtsTrend, 2)} RTS / 30 min
              </span>
            </div>
            <div className="grid grid-cols-5 gap-1.5">
              <Vital label="HR" value={p.hr} alarm={p.hr > 120 || p.hr < 50} />
              <Vital label="SBP" value={p.sbp} alarm={p.sbp < 90} />
              <Vital label="RR" value={p.rr} alarm={p.rr > 29 || p.rr < 10} />
              <Vital label="SpO₂" value={p.oxygenSat} unit="%" alarm={p.oxygenSat < 90} />
              <Vital label="GCS" value={p.gcs} alarm={p.gcs < 13} />
            </div>
            <div className="mt-2 grid grid-cols-3 gap-1.5">
              <div className="rounded-lg border border-line bg-ink-800/60 px-2.5 py-2">
                <div className="eyebrow">T-RTS</div>
                <div className="num text-lg font-semibold text-fg">
                  {p.tRts}
                  <span className="text-[11px] font-normal text-fg-subtle">/12</span>
                </div>
              </div>
              <div className="rounded-lg border border-line bg-ink-800/60 px-2.5 py-2">
                <div className="eyebrow">Weighted RTS</div>
                <div className="num text-lg font-semibold text-fg">
                  {round(p.weightedRts, 2)}
                  <span className="text-[11px] font-normal text-fg-subtle">/7.84</span>
                </div>
              </div>
              <div className="rounded-lg border border-line bg-ink-800/60 px-2.5 py-2">
                <div className="eyebrow">Evac window</div>
                <div className={cx('num text-lg font-semibold', left >= 0 && left < 20 ? 'text-red' : 'text-fg')}>
                  {p.precedenceDeadline < 0 ? '—' : left < 0 ? 'passed' : minutes(left)}
                </div>
              </div>
            </div>
          </section>

          <section>
            <div className="eyebrow mb-2 flex items-center gap-1.5">
              <ShieldAlert className="h-3.5 w-3.5" /> Protocol · {p.triageProtocol}
            </div>
            <ol className="space-y-1 border-l border-line pl-3">
              {trace.map((step, i) => (
                <li key={i} className="relative text-[12px] leading-snug text-fg-muted">
                  <span className="absolute -left-[15.5px] top-1.5 h-1.5 w-1.5 rounded-full bg-line-strong" />
                  {step}
                </li>
              ))}
            </ol>
            {p.evacPrecedence && (
              <p className="mt-2 text-[11px] text-fg-subtle">
                MEDEVAC precedence {p.evacPrecedence} · {PRECEDENCE_LABEL[p.evacPrecedence as Precedence]}
                {p.needsSurgery ? ' (surgical)' : ''}
              </p>
            )}
          </section>

          <section>
            <div className="eyebrow mb-2 flex items-center gap-1.5">
              <ClipboardList className="h-3.5 w-3.5" /> MIST handoff
            </div>
            <dl className="divide-y divide-line rounded-lg border border-line bg-ink-800/50 text-[12px]">
              {(['mechanism', 'injuries', 'signs', 'treatment'] as const).map(k => (
                <div key={k} className="grid grid-cols-[92px_1fr] gap-2 px-3 py-2">
                  <dt className="font-medium capitalize text-fg-subtle">{k}</dt>
                  <dd className="text-fg-muted">{mist[k] || '—'}</dd>
                </div>
              ))}
            </dl>
            {mist.source && <p className="mt-1 text-[10.5px] text-fg-subtle">source: {mist.source}</p>}
          </section>

          <section>
            <div className="eyebrow mb-2">Resources held</div>
            {events.length === 0 ? (
              <p className="text-[12px] text-fg-subtle">None</p>
            ) : (
              <ul className="space-y-1">
                {events.map(e => (
                  <li key={e.id} className="flex items-center gap-2 text-[12px] text-fg-muted">
                    <span className="text-info">{RESOURCE_ICON[e.resourceType]}</span>
                    <span className="flex-1">{state.resources.get(e.resourceType)?.label ?? e.resourceType}</span>
                    <span className="num text-fg-subtle">
                      {state.resources.get(e.resourceType)?.kind === 'consumable'
                        ? `${round(e.consumed, 1)} / ${round(e.amount, 1)}`
                        : e.status === 'queued'
                          ? 'queued'
                          : e.durationMin > 0
                            ? `${minutes(e.startMin + e.durationMin - minute)} left`
                            : 'until evac'}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="rounded-xl border border-line bg-ink-800/40 p-3">
            <div className="eyebrow mb-2">Manual triage (medic)</div>
            <div className="grid grid-cols-5 gap-1">
              {(['immediate', 'delayed', 'minimal', 'expectant', 'dead'] as const).map(k => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setCategory(k)}
                  className={cx(
                    'rounded-md border px-1 py-1.5 text-[11px] font-medium',
                    category === k ? cx(CATEGORY_STYLE[k].bg, CATEGORY_STYLE[k].border, CATEGORY_STYLE[k].text) : 'border-line text-fg-subtle hover:text-fg'
                  )}
                >
                  {CATEGORY_LABEL[k]}
                </button>
              ))}
            </div>
            {category === 'expectant' && (
              <p className="mt-2 rounded-md border border-expectant/40 bg-expectant/10 px-2 py-1.5 text-[11px] text-expectant">
                SALT: Expectant is a clinical judgement — "unlikely to survive given current resources". Argus never assigns it automatically.
              </p>
            )}
            <input value={reason} onChange={e => setReason(e.target.value)} placeholder="Reason (required, logged)" className="input mt-2" />
            <button type="button" disabled={!category || !reason.trim()} onClick={submit} className="btn-primary mt-2 w-full">
              Record triage change
            </button>
          </section>
        </div>
      </aside>
    </div>
  );
}
