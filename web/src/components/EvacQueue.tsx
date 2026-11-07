import { Ambulance, Check, ChevronDown, Lock, Plane, Plus, SlidersHorizontal, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { CAPABILITY_LABEL, PRECEDENCE_LABEL, type Capability } from '@protocols';
import { errorMessage, minutes, round, safeJson } from '../lib/format';
import { useActions, type ArgusState, type EvacRanking, type EvacSlot } from '../lib/useArgus';
import { CategoryBadge, Empty, Panel, PrecedenceBadge, cx } from './ui';

const OVERRIDE_REASONS = [
  'Clinical judgement',
  'Unstable for transport',
  'Destination mismatch',
  'Needs procedure on site first',
  'Better fit for next slot',
];

const TIER_LABEL = ['Tier 1 · Urgent / Urgent-Surgical · ≤ 2 h', 'Tier 2 · Priority · ≤ 4 h', 'Tier 3 · Routine · ≤ 24 h', 'Tier 4 · Convenience'];

type FactorRow = { key: string; label: string; value: number };

function SlotHeader({ slot, minute, onCancel }: { slot: EvacSlot; minute: number; onCancel: () => void }) {
  const departs = slot.departMin - minute;
  const Icon = slot.mode === 'air' ? Plane : Ambulance;
  const seatsLeft = slot.seats - slot.seatsFilled;
  return (
    <div className="rounded-xl border border-accent/25 bg-gradient-to-br from-accent/[0.08] to-transparent p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-accent/30 bg-accent/10 text-accent">
            <Icon className="h-4.5 w-4.5" />
          </div>
          <div>
            <div className="num text-[14px] font-semibold text-fg">{slot.callsign}</div>
            <div className="text-[11px] text-fg-muted">
              {slot.destination} · {CAPABILITY_LABEL[slot.capability as Capability] ?? slot.capability}
            </div>
          </div>
        </div>
        <button type="button" onClick={onCancel} className="rounded p-1 text-fg-subtle hover:bg-ink-700 hover:text-fg" title="Cancel slot">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2 text-[11px]">
        <div>
          <div className="eyebrow">Seats</div>
          <div className="num mt-0.5 flex items-center gap-1 text-sm font-semibold text-fg">
            {Array.from({ length: slot.seats }, (_, i) => (
              <span key={i} className={cx('h-2.5 w-2.5 rounded-sm', i < slot.seatsFilled ? 'bg-accent' : 'border border-accent/40')} />
            ))}
            <span className="ml-1">{seatsLeft} left</span>
          </div>
        </div>
        <div>
          <div className="eyebrow">Departs</div>
          <div className={cx('num mt-0.5 text-sm font-semibold', departs < 5 ? 'text-amber' : 'text-fg')}>in {minutes(departs)}</div>
        </div>
        <div>
          <div className="eyebrow">Mode</div>
          <div className="mt-0.5 text-sm font-semibold capitalize text-fg">{slot.mode}</div>
        </div>
      </div>
    </div>
  );
}

function Candidate({
  r,
  state,
  slot,
  disabled,
  onError,
}: {
  r: EvacRanking;
  state: ArgusState;
  slot: EvacSlot;
  disabled: boolean;
  onError: (m: string) => void;
}) {
  const { recordDecision } = useActions();
  const [open, setOpen] = useState(false);
  const [overriding, setOverriding] = useState(false);
  const [busy, setBusy] = useState(false);
  const p = state.patientsById.get(r.patientId);
  const factors = safeJson<FactorRow[]>(r.factors, []);
  const maxScore = 1;
  if (!p) return null;

  const decide = async (accepted: boolean, reason = '') => {
    setBusy(true);
    try {
      await recordDecision({ slotId: slot.id, patientId: p.id, aiRank: r.rank, accepted, overrideReason: reason });
    } catch (e) {
      onError(errorMessage(e));
    } finally {
      setBusy(false);
      setOverriding(false);
    }
  };

  const left = p.precedenceDeadline - (state.sim?.minute ?? 0);

  return (
    <li className="animate-fade-in rounded-xl border border-line bg-ink-800/70 transition-colors hover:border-line-strong">
      <div className="flex items-start gap-3 p-3">
        <div className="num flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-ink-700 text-[13px] font-semibold text-fg">
          {r.rank}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="num text-[13.5px] font-semibold text-fg">{p.tag}</span>
            <CategoryBadge category={p.category} short />
            <PrecedenceBadge precedence={r.precedence} full />
            {left >= 0 && <span className={cx('num text-[10.5px]', left < 20 ? 'text-red' : 'text-fg-subtle')}>{Math.round(left)} min window</span>}
          </div>
          <p className="mt-1 text-[12px] leading-snug text-fg-muted">{r.reason}</p>
          <div className="mt-1.5 flex items-center gap-2">
            <div className="h-1 flex-1 overflow-hidden rounded-full bg-line">
              <div className="h-full rounded-full bg-accent/80" style={{ width: `${Math.min(100, (r.score / maxScore) * 100)}%` }} />
            </div>
            <span className="num text-[10.5px] text-fg-subtle">{round(r.score, 2)}</span>
            <button type="button" onClick={() => setOpen(o => !o)} className="flex items-center gap-0.5 text-[10.5px] text-fg-subtle hover:text-fg">
              why <ChevronDown className={cx('h-3 w-3 transition-transform', open && 'rotate-180')} />
            </button>
          </div>
        </div>
      </div>

      {open && (
        <div className="mx-3 mb-2 space-y-1 rounded-lg border border-line bg-ink-900/70 p-2">
          {factors.map(f => (
            <div key={f.key} className="flex items-center gap-2 text-[11px]">
              <span className="min-w-0 flex-1 truncate text-fg-muted">{f.label}</span>
              <div className="h-1 w-16 overflow-hidden rounded-full bg-line">
                <div className="h-full bg-info" style={{ width: `${Math.min(100, f.value * 200)}%` }} />
              </div>
              <span className="num w-9 text-right text-fg-subtle">+{round(f.value, 2)}</span>
            </div>
          ))}
          <div className="pt-1 text-[10px] text-fg-subtle">{p.injuryType.replace(/_/g, ' ')} · weighted RTS {round(p.weightedRts, 2)} · {p.triageProtocol}</div>
        </div>
      )}

      {overriding ? (
        <div className="border-t border-line p-2.5">
          <div className="mb-1.5 text-[11px] text-fg-muted">Override reason (logged)</div>
          <div className="flex flex-wrap gap-1.5">
            {OVERRIDE_REASONS.map(reason => (
              <button key={reason} type="button" disabled={busy} onClick={() => decide(false, reason)} className="chip border-amber/35 bg-amber/10 px-2 py-1 text-amber hover:bg-amber/20">
                {reason}
              </button>
            ))}
            <button type="button" onClick={() => setOverriding(false)} className="chip border-line px-2 py-1 text-fg-subtle hover:text-fg">
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="flex gap-2 border-t border-line p-2">
          <button type="button" disabled={disabled || busy} onClick={() => decide(true)} className="btn-primary flex-1">
            <Check className="h-3.5 w-3.5" /> Accept
          </button>
          <button type="button" disabled={busy} onClick={() => setOverriding(true)} className="btn-ghost flex-1">
            <X className="h-3.5 w-3.5" /> Override
          </button>
        </div>
      )}
    </li>
  );
}

function Weights({ state, onError }: { state: ArgusState; onError: (m: string) => void }) {
  const { setWeights } = useActions();
  const sim = state.sim;
  const [w, setW] = useState({ deterioration: 0.5, resourceRelief: 0.3, destinationMatch: 0.2 });
  const dirty = useRef(false);
  useEffect(() => {
    if (sim && !dirty.current) {
      setW({ deterioration: sim.wDeterioration, resourceRelief: sim.wResourceRelief, destinationMatch: sim.wDestinationMatch });
    }
  }, [sim?.wDeterioration, sim?.wResourceRelief, sim?.wDestinationMatch]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!dirty.current) return;
    const id = setTimeout(() => {
      dirty.current = false;
      setWeights(w).catch(e => onError(errorMessage(e)));
    }, 180);
    return () => clearTimeout(id);
  }, [w]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows: Array<[keyof typeof w, string, string]> = [
    ['deterioration', 'w₁ Deterioration risk', 'severity · trend · window'],
    ['resourceRelief', 'w₂ Resource relief', 'frees scarce resources'],
    ['destinationMatch', 'w₃ Destination match', 'capability fit'],
  ];
  return (
    <div className="space-y-2.5">
      {rows.map(([k, label, hint]) => (
        <label key={k} className="block">
          <div className="flex items-baseline justify-between text-[11.5px]">
            <span className="text-fg-muted">
              {label} <span className="text-fg-subtle">· {hint}</span>
            </span>
            <span className="num text-fg">{w[k].toFixed(2)}</span>
          </div>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={w[k]}
            onChange={e => {
              dirty.current = true;
              setW(prev => ({ ...prev, [k]: Number(e.target.value) }));
            }}
            style={{ ['--pct' as string]: `${w[k] * 100}%` }}
            className="mt-1.5 w-full"
          />
        </label>
      ))}
      <p className="text-[10.5px] leading-relaxed text-fg-subtle">
        EvacScore = w₁·Deterioration + w₂·Relief + w₃·Destination. Hand-set, illustrative weights. They only reorder patients{' '}
        <em>within</em> a precedence tier.
      </p>
    </div>
  );
}

function OpenSlotForm({ onError, onDone }: { onError: (m: string) => void; onDone: () => void }) {
  const { openEvacSlot } = useActions();
  const [mode, setMode] = useState<'air' | 'ground'>('air');
  const [seats, setSeats] = useState(2);
  const [departIn, setDepartIn] = useState(15);
  const [capability, setCapability] = useState<Capability>('trauma_surgery');
  const submit = () =>
    openEvacSlot({
      mode,
      callsign: mode === 'air' ? `AIR ${Math.floor(Math.random() * 90 + 10)}` : `MEDIC ${Math.floor(Math.random() * 90 + 10)}`,
      seats,
      departInMin: departIn,
      destination: CAPABILITY_LABEL[capability],
      capability,
    })
      .then(onDone)
      .catch(e => onError(errorMessage(e)));

  return (
    <div className="space-y-2 rounded-xl border border-line bg-ink-800/60 p-3">
      <div className="grid grid-cols-2 gap-2">
        {(['air', 'ground'] as const).map(m => (
          <button key={m} type="button" onClick={() => setMode(m)} className={cx('btn', mode === m ? 'border-accent/40 bg-accent/10 text-accent' : 'border-line text-fg-muted')}>
            {m === 'air' ? <Plane className="h-3.5 w-3.5" /> : <Ambulance className="h-3.5 w-3.5" />} {m}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-2 text-[11px] text-fg-muted">
        <label>
          Seats
          <input type="number" min={1} max={8} value={seats} onChange={e => setSeats(Number(e.target.value))} className="input num mt-1 !py-1.5" />
        </label>
        <label>
          Departs in (min)
          <input type="number" min={1} max={120} value={departIn} onChange={e => setDepartIn(Number(e.target.value))} className="input num mt-1 !py-1.5" />
        </label>
      </div>
      <select value={capability} onChange={e => setCapability(e.target.value as Capability)} className="input !py-1.5 text-[12px]">
        {Object.entries(CAPABILITY_LABEL).map(([k, v]) => (
          <option key={k} value={k}>
            {v}
          </option>
        ))}
      </select>
      <button type="button" onClick={submit} className="btn-primary w-full">
        <Plus className="h-3.5 w-3.5" /> Open slot
      </button>
    </div>
  );
}

export function EvacQueue({ state, onError }: { state: ArgusState; onError: (m: string) => void }) {
  const { cancelEvacSlot } = useActions();
  const open = useMemo(() => state.slots.filter(s => s.status === 'open').sort((a, b) => a.departMin - b.departMin), [state.slots]);
  const [slotId, setSlotId] = useState<number | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [showWeights, setShowWeights] = useState(false);
  const slot = open.find(s => s.id === slotId) ?? open[0];
  const minute = state.sim?.minute ?? 0;

  const ranked = useMemo(
    () => (slot ? state.rankings.filter(r => r.slotId === slot.id).sort((a, b) => a.rank - b.rank) : []),
    [state.rankings, slot]
  );

  return (
    <Panel
      title="Evacuation queue"
      icon={<Plane className="h-3.5 w-3.5" />}
      right={
        <div className="flex items-center gap-1">
          <button type="button" onClick={() => setShowWeights(s => !s)} className={cx('rounded-md p-1.5 hover:bg-ink-700', showWeights ? 'text-accent' : 'text-fg-subtle')} title="Ranking weights">
            <SlidersHorizontal className="h-3.5 w-3.5" />
          </button>
          <button type="button" onClick={() => setShowForm(s => !s)} className={cx('rounded-md p-1.5 hover:bg-ink-700', showForm ? 'text-accent' : 'text-fg-subtle')} title="Open a slot">
            <Plus className="h-3.5 w-3.5" />
          </button>
        </div>
      }
      bodyClassName="flex flex-col gap-3 overflow-y-auto p-3"
    >
      {showWeights && (
        <div className="animate-slide-in rounded-xl border border-line bg-ink-800/60 p-3">
          <Weights state={state} onError={onError} />
        </div>
      )}
      {showForm && <OpenSlotForm onError={onError} onDone={() => setShowForm(false)} />}

      {open.length > 1 && (
        <div className="flex gap-1.5 overflow-x-auto">
          {open.map(s => (
            <button
              key={s.id}
              type="button"
              onClick={() => setSlotId(s.id)}
              className={cx('chip shrink-0 px-2 py-1', s.id === slot?.id ? 'border-accent/40 bg-accent/10 text-accent' : 'border-line text-fg-muted')}
            >
              {s.mode === 'air' ? <Plane className="h-3 w-3" /> : <Ambulance className="h-3 w-3" />}
              {s.callsign}
            </button>
          ))}
        </div>
      )}

      {!slot ? (
        <Empty icon={<Plane className="h-6 w-6" />} title="No evacuation slot open">
          When a vehicle or flight slot opens, Argus ranks the top five candidates — precedence tier first, then a transparent score inside the
          tier. Nothing moves until you accept.
        </Empty>
      ) : (
        <>
          <SlotHeader slot={slot} minute={minute} onCancel={() => cancelEvacSlot({ slotId: slot.id }).catch(e => onError(errorMessage(e)))} />
          {ranked.length === 0 ? (
            <Empty title="Ranking…">Waiting for the ML sidecar to score candidates for this slot.</Empty>
          ) : (
            <ol className="space-y-2">
              {ranked.map((r, i) => (
                <div key={r.id}>
                  {(i === 0 || ranked[i - 1].tier !== r.tier) && (
                    <div className="mb-1.5 mt-1 flex items-center gap-2 text-[10.5px] text-fg-subtle">
                      <Lock className="h-3 w-3" />
                      <span className="eyebrow !text-[10px]">{TIER_LABEL[r.tier] ?? `Tier ${r.tier + 1}`}</span>
                      <span className="h-px flex-1 bg-line" />
                    </div>
                  )}
                  <Candidate r={r} state={state} slot={slot} disabled={slot.seatsFilled >= slot.seats} onError={onError} />
                </div>
              ))}
            </ol>
          )}
          <p className="flex items-start gap-1.5 text-[10.5px] leading-relaxed text-fg-subtle">
            <Lock className="mt-0.5 h-3 w-3 shrink-0" />
            MEDEVAC precedence ({Object.entries(PRECEDENCE_LABEL).slice(0, 3).map(([k, v]) => `${k} ${v}`).join(', ')}…) is a hard rule; the model
            only orders within a tier. No recommendation applies itself — every accept and override is logged.
          </p>
        </>
      )}
    </Panel>
  );
}


