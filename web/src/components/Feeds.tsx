import { BellRing, ScrollText } from 'lucide-react';
import { clock, LEVEL_STYLE } from '../lib/format';
import type { ArgusState } from '../lib/useArgus';
import { Empty, LevelIcon, Panel, cx } from './ui';

export function AlertFeed({ state }: { state: ArgusState }) {
  const alerts = state.alerts.slice(0, 60);
  const reds = state.alerts.filter(a => a.level === 'red').length;
  const ambers = state.alerts.filter(a => a.level === 'amber').length;
  return (
    <Panel
      title="Alerts"
      icon={<BellRing className="h-3.5 w-3.5" />}
      right={
        <div className="num flex items-center gap-2 text-[11px]">
          <span className="flex items-center gap-1 text-red">
            <LevelIcon level="red" className="h-3 w-3" /> {reds}
          </span>
          <span className="flex items-center gap-1 text-amber">
            <LevelIcon level="amber" className="h-3 w-3" /> {ambers}
          </span>
        </div>
      }
      bodyClassName="overflow-y-auto"
    >
      {alerts.length === 0 ? (
        <Empty title="No alerts yet" />
      ) : (
        <ul className="divide-y divide-line/70">
          {alerts.map((a, i) => {
            const s = LEVEL_STYLE[a.level] ?? LEVEL_STYLE.info;
            return (
              <li key={a.id} className={cx('flex items-start gap-3 px-4 py-2', i === 0 && 'animate-fade-in')}>
                <span className="num w-12 shrink-0 pt-px text-[11px] text-fg-subtle">{clock(a.minute)}</span>
                <LevelIcon level={a.level} className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span className={cx('w-24 shrink-0 truncate text-[11.5px] font-medium', s.text)}>{a.subject}</span>
                <span className="min-w-0 flex-1 text-[12px] text-fg-muted">{a.message}</span>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

const ACTION_STYLE: Record<string, string> = {
  'evac.accept': 'border-accent/35 bg-accent/10 text-accent',
  'evac.override': 'border-amber/35 bg-amber/10 text-amber',
  'patient.triage': 'border-info/35 bg-info/10 text-info',
};

const ACTION_LABEL: Record<string, string> = {
  'evac.accept': 'Accepted',
  'evac.override': 'Override',
  'evac.open': 'Slot open',
  'evac.cancel': 'Slot cancel',
  'patient.triage': 'Re-triage',
  'patient.intake': 'Intake',
  'patient.bed': 'Bed move',
  'scenario.load': 'Scenario',
  'clock.play': 'Play',
  'clock.pause': 'Pause',
  'settings.protocol': 'Protocol',
  'resource.resupply': 'Resupply',
  'whatif.surge': 'What-if',
  'whatif.lose': 'What-if',
  'whatif.gain': 'What-if',
  'whatif.clear': 'What-if',
};

export function DecisionLog({ state }: { state: ArgusState }) {
  const entries = state.audit.filter(a => !a.action.startsWith('clock.')).slice(0, 80);
  const accepted = state.decisions.filter(d => d.accepted).length;
  const overridden = state.decisions.length - accepted;
  return (
    <Panel
      title="Decision & audit log"
      icon={<ScrollText className="h-3.5 w-3.5" />}
      right={
        <span className="num text-[11px] text-fg-subtle">
          {accepted} accepted · {overridden} overridden
        </span>
      }
      bodyClassName="overflow-y-auto"
    >
      {entries.length === 0 ? (
        <Empty title="Nothing logged yet">Every accept, override, manual triage and what-if lands here with time and reason.</Empty>
      ) : (
        <ul className="divide-y divide-line/70">
          {entries.map(e => (
            <li key={e.id} className="flex items-start gap-3 px-4 py-2">
              <span className="num w-12 shrink-0 pt-px text-[11px] text-fg-subtle">{clock(e.minute)}</span>
              <span className={cx('chip w-20 shrink-0 justify-center', ACTION_STYLE[e.action] ?? 'border-line text-fg-muted')}>
                {ACTION_LABEL[e.action] ?? e.action}
              </span>
              <span className="min-w-0 flex-1 text-[12px] text-fg-muted">{e.detail}</span>
              <span className="num shrink-0 text-[10px] text-fg-subtle" title="Actor identity">
                {e.actor}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
