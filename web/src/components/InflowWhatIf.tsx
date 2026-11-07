import { FlaskConical, TrendingUp, UsersRound, Wind, Scissors, Droplet, X } from 'lucide-react';
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis } from 'recharts';
import { errorMessage, round } from '../lib/format';
import { useActions, type ArgusState } from '../lib/useArgus';
import { Panel } from './ui';

const BIN = 10;

function Horizon({ label, exp, lo, hi }: { label: string; exp: number; lo: number; hi: number }) {
  return (
    <div className="rounded-lg border border-line bg-ink-800/60 px-2.5 py-2">
      <div className="eyebrow">{label}</div>
      <div className="num mt-0.5 text-xl font-semibold text-fg">{round(exp, 0)}</div>
      <div className="num text-[10.5px] text-fg-subtle">
        {round(lo, 0)}–{round(hi, 0)} likely
      </div>
    </div>
  );
}

export function InflowWhatIf({ state, onError }: { state: ArgusState; onError: (m: string) => void }) {
  const { applyWhatIf, clearWhatIf } = useActions();
  const f = state.inflow;
  const minute = state.sim?.minute ?? 0;
  const surge = state.sim?.whatIfSurge ?? 0;

  const bins = Math.max(1, Math.ceil(Math.max(minute, 1) / BIN));
  const data = Array.from({ length: Math.max(bins, 12) }, (_, i) => ({
    t: i * BIN,
    n: state.patients.filter(p => p.arrivalMin >= i * BIN && p.arrivalMin < (i + 1) * BIN).length,
  }));

  const run = (p: Promise<void>) => p.catch(e => onError(errorMessage(e)));
  const vents = state.resources.get('vent');
  const ors = state.resources.get('or_table');

  return (
    <Panel
      title="Inflow & what-if"
      icon={<TrendingUp className="h-3.5 w-3.5" />}
      right={
        f && (
          <span className="num text-[11px] text-fg-muted">
            {round(f.ratePerHour, 1)} / h now
          </span>
        )
      }
      bodyClassName="grid grid-cols-[1.25fr_1fr] gap-4 p-3"
    >
      <div className="flex min-w-0 flex-col gap-2">
        <div className="grid grid-cols-3 gap-2">
          <Horizon label="Next 30 min" exp={f?.halfHour ?? 0} lo={f?.halfHourLow ?? 0} hi={f?.halfHourHigh ?? 0} />
          <Horizon label="Next 60 min" exp={f?.oneHour ?? 0} lo={f?.oneHourLow ?? 0} hi={f?.oneHourHigh ?? 0} />
          <Horizon label="Next 90 min" exp={f?.ninetyMin ?? 0} lo={f?.ninetyMinLow ?? 0} hi={f?.ninetyMinHigh ?? 0} />
        </div>
        <div className="relative h-14 min-h-[48px] flex-1">
          <div className="absolute inset-0">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
              <XAxis dataKey="t" tick={{ fill: '#627083', fontSize: 9.5 }} axisLine={false} tickLine={false} tickFormatter={v => `${v}`} interval={2} height={14} />
              <Tooltip
                cursor={{ fill: 'rgba(94,234,212,0.06)' }}
                contentStyle={{ background: '#0b1118', border: '1px solid #283444', borderRadius: 8, fontSize: 11 }}
                labelFormatter={v => `T+${v}–${Number(v) + BIN} min`}
                formatter={(v: unknown) => [String(v), 'arrivals']}
              />
              <Bar dataKey="n" fill="#5eead4" fillOpacity={0.55} radius={[3, 3, 0, 0]} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
          </div>
        </div>
        <div className="truncate text-[10.5px] text-fg-subtle">
          Arrivals per 10 min · Poisson rate with Gamma posterior, recent minutes weighted (half-life 15 min)
        </div>
      </div>

      <div className="flex min-w-0 flex-col gap-2 border-l border-line pl-4">
        <div className="flex items-center gap-1.5 text-[12px] font-medium text-fg">
          <FlaskConical className="h-3.5 w-3.5 text-info" /> What-if
        </div>
        <p className="text-[11px] leading-relaxed text-fg-subtle">Re-runs the forecast and ranking in seconds.</p>
        <div className="grid grid-cols-2 gap-1.5">
          <button type="button" className="btn-ghost justify-start" onClick={() => run(applyWhatIf({ kind: 'surge', amount: 10 }))}>
            <UsersRound className="h-3.5 w-3.5 text-info" /> +10 casualties
          </button>
          <button type="button" className="btn-ghost justify-start" disabled={!vents || vents.capacity < 1} onClick={() => run(applyWhatIf({ kind: 'lose:vent', amount: 1 }))}>
            <Wind className="h-3.5 w-3.5 text-amber" /> Lose 1 vent
          </button>
          <button type="button" className="btn-ghost justify-start" disabled={!ors || ors.capacity < 1} onClick={() => run(applyWhatIf({ kind: 'lose:or_table', amount: 1 }))}>
            <Scissors className="h-3.5 w-3.5 text-amber" /> Lose 1 OR
          </button>
          <button type="button" className="btn-ghost justify-start" onClick={() => run(applyWhatIf({ kind: 'gain:blood_unit', amount: 6 }))}>
            <Droplet className="h-3.5 w-3.5 text-minimal" /> +6 blood
          </button>
        </div>
        {surge > 0 && (
          <div className="mt-auto flex items-center justify-between rounded-lg border border-info/30 bg-info/10 px-2.5 py-1.5 text-[11px] text-info">
            <span>
              Forecast includes <span className="num font-semibold">+{surge}</span> hypothetical
            </span>
            <button type="button" onClick={() => run(clearWhatIf())} className="rounded p-0.5 hover:bg-info/20" aria-label="Clear what-if surge">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </div>
    </Panel>
  );
}
