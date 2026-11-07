import { Gauge } from 'lucide-react';
import { Area, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { RESOURCE_ORDER } from '@protocols';
import { minutes, round, safeJson } from '../lib/format';
import type { ArgusState, Forecast, Resource } from '../lib/useArgus';
import { LevelPill, Panel, cx } from './ui';

const LEVEL_COLOR: Record<string, string> = { ok: '#5eead4', amber: '#f59e0b', red: '#f2545b' };

type CurvePoint = { t: number; band: [number, number]; p50: number };

function curveData(f: Forecast | undefined): CurvePoint[] {
  const raw = safeJson<number[][]>(f?.curve ?? '', []);
  return raw.map(([t, p10, p50, p90]) => ({ t, band: [p10, p90], p50 }));
}

function headline(r: Resource, f: Forecast | undefined) {
  const consumable = r.kind === 'consumable';
  if (!f) return { main: 'Awaiting forecast', sub: 'ML sidecar not yet reporting' };
  if (f.ttzMedian < 0) {
    return { main: consumable ? 'No stock-out within 4 h' : 'No queue within 4 h', sub: `burn ${round(f.burnPerHour, 1)} ${r.unit}/h` };
  }
  const verb = consumable ? 'Zero in' : f.ttzMedian < 1 ? 'Queue now' : 'Queue in';
  const range =
    f.ttzHigh < 0 ? `${Math.round(f.ttzLow)} min – > 4 h` : `${Math.round(f.ttzLow)}–${Math.round(f.ttzHigh)} min`;
  return {
    main: f.ttzMedian < 1 && !consumable ? verb : `${verb} ~${minutes(f.ttzMedian)}`,
    sub: `range ${range} · burn ${round(f.burnPerHour, 1)} ${r.unit}/h`,
  };
}

function ResourceCard({ r, f, hero }: { r: Resource; f: Forecast | undefined; hero?: boolean }) {
  const level = f?.level ?? 'ok';
  const color = LEVEL_COLOR[level] ?? LEVEL_COLOR.ok;
  const available = Math.max(0, r.capacity - r.inUse);
  const pct = r.capacity > 0 ? (available / r.capacity) * 100 : 0;
  const data = curveData(f);
  const h = headline(r, f);
  const resupply = r.resupplyEtaMin >= 0;
  const id = `g-${r.resourceType}`;

  return (
    <div
      className={cx(
        'relative flex h-full min-h-0 flex-col overflow-hidden rounded-xl border bg-ink-800/60 p-3.5 transition-colors',
        level === 'red' ? 'border-red/50' : level === 'amber' ? 'border-amber/45' : 'border-line'
      )}
    >
      {level !== 'ok' && (
        <div
          className="pointer-events-none absolute inset-0 opacity-[0.07]"
          style={{ background: `radial-gradient(120% 80% at 100% 0%, ${color}, transparent 60%)` }}
        />
      )}
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="eyebrow">{r.label}</div>
          <div className="mt-1 flex items-baseline gap-1.5">
            <span className={cx('num font-semibold tracking-tight text-fg', hero ? 'text-4xl' : 'text-3xl')}>
              {round(available, r.kind === 'consumable' ? 1 : 0)}
            </span>
            <span className="num text-sm text-fg-subtle">
              / {round(r.capacity, 0)} {r.unit}
            </span>
          </div>
        </div>
        <LevelPill level={level} />
      </div>

      <div className="mt-2.5 h-1.5 shrink-0 overflow-hidden rounded-full bg-line">
        <div className="h-full rounded-full transition-[width] duration-700" style={{ width: `${pct}%`, background: color }} />
      </div>

      <div className="mt-2.5">
        <div className={cx('text-[13.5px] font-medium', level === 'ok' ? 'text-fg' : level === 'amber' ? 'text-amber' : 'text-red')}>
          {h.main}
        </div>
        <div className="num text-[11px] text-fg-subtle">{h.sub}</div>
        {resupply && (
          <div className="num mt-0.5 text-[11px] text-info">
            Resupply +{r.resupplyAmount} {r.unit} at T+{Math.floor(r.resupplyEtaMin / 60)}:
            {String(Math.round(r.resupplyEtaMin % 60)).padStart(2, '0')}
          </div>
        )}
      </div>

      <div className="relative -mx-1 mt-2 min-h-[56px] flex-1">
        {data.length > 1 ? (
          <div className="absolute inset-0">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
              <defs>
                <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={color} stopOpacity={0.32} />
                  <stop offset="100%" stopColor={color} stopOpacity={0.04} />
                </linearGradient>
              </defs>
              <XAxis
                dataKey="t"
                type="number"
                domain={[0, 240]}
                ticks={[0, 60, 120, 180, 240]}
                tickFormatter={v => (v === 0 ? 'now' : `+${v / 60}h`)}
                tick={{ fill: '#627083', fontSize: 9.5 }}
                axisLine={false}
                tickLine={false}
                height={14}
              />
              <YAxis hide domain={[Math.min(0, ...data.map(d => d.band[0])), Math.max(r.capacity, 1)]} />
              <ReferenceLine y={0} stroke="#f2545b" strokeOpacity={0.55} strokeDasharray="3 3" />
              <Tooltip
                cursor={{ stroke: '#283444' }}
                contentStyle={{ background: '#0b1118', border: '1px solid #283444', borderRadius: 8, fontSize: 11 }}
                labelFormatter={v => `in ${v} min`}
                formatter={(value: unknown, name: unknown) =>
                  Array.isArray(value)
                    ? [`${round(value[0], 1)} – ${round(value[1], 1)}`, '80% band']
                    : [round(Number(value), 1), name === 'p50' ? 'median' : String(name)]
                }
              />
              <Area dataKey="band" stroke="none" fill={`url(#${id})`} isAnimationActive={false} />
              <Line dataKey="p50" stroke={color} strokeWidth={1.75} dot={false} isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>
          </div>
        ) : (
          <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-line text-[11px] text-fg-subtle">
            projection appears once the sidecar runs
          </div>
        )}
      </div>
    </div>
  );
}

export function Gauges({ state }: { state: ArgusState }) {
  const list = RESOURCE_ORDER.map(t => state.resources.get(t)).filter((r): r is Resource => !!r);
  const [first, second, ...rest] = list;
  return (
    <Panel
      title="Burn-down forecast"
      icon={<Gauge className="h-3.5 w-3.5" />}
      right={
        <span className="text-[11px] text-fg-subtle">
          Monte Carlo · 500 runs · median with 10th–90th band · amber &lt; 90 min · red &lt; 30 min
        </span>
      }
      bodyClassName="grid grid-cols-6 grid-rows-[minmax(0,1.15fr)_minmax(0,1fr)] gap-3 p-3"
    >
      {first && (
        <div className="col-span-3 min-h-0">
          <ResourceCard r={first} f={state.forecasts.get(first.resourceType)} hero />
        </div>
      )}
      {second && (
        <div className="col-span-3 min-h-0">
          <ResourceCard r={second} f={state.forecasts.get(second.resourceType)} hero />
        </div>
      )}
      {rest.map(r => (
        <div key={r.resourceType} className="col-span-2 min-h-0">
          <ResourceCard r={r} f={state.forecasts.get(r.resourceType)} />
        </div>
      ))}
    </Panel>
  );
}
