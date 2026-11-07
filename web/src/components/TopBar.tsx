import { Activity, BrainCircuit, Database, Pause, Play, Tablet, WifiOff, Wifi } from 'lucide-react';
import { useEffect, useState } from 'react';
import { clock, errorMessage } from '../lib/format';
import { heartbeatAgeMs, useActions, type ArgusState } from '../lib/useArgus';
import { ArgusMark, cx } from './ui';

const SPEEDS = [10, 30, 60];

function useOnline() {
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}

function useTick(ms: number) {
  const [, set] = useState(0);
  useEffect(() => {
    const id = setInterval(() => set(n => n + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
}

function Health({ ok, warn, icon, label, detail }: { ok: boolean; warn?: boolean; icon: React.ReactNode; label: string; detail: string }) {
  const tone = ok ? 'text-ok' : warn ? 'text-amber' : 'text-fg-subtle';
  return (
    <div className="flex items-center gap-1.5" title={`${label}: ${detail}`}>
      <span className={cx('relative flex h-1.5 w-1.5')}>
        {ok && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-ok/50" />}
        <span className={cx('relative inline-flex h-1.5 w-1.5 rounded-full', ok ? 'bg-ok' : warn ? 'bg-amber' : 'bg-fg-subtle')} />
      </span>
      <span className={cx('hidden items-center gap-1 text-[11px] xl:flex', tone)}>
        {icon}
        {label}
      </span>
    </div>
  );
}

export function TopBar({ state, onError }: { state: ArgusState; onError: (msg: string) => void }) {
  const { sim, connected } = state;
  const { setPlayback, setProtocol } = useActions();
  const online = useOnline();
  useTick(1000);

  const minute = sim?.minute ?? 0;
  const length = sim?.scenarioLengthMin ?? 120;
  const pct = Math.min(100, (minute / length) * 100);
  const speed = sim?.speed ?? 30;
  const paused = sim?.paused ?? true;
  const simAlive = !paused && heartbeatAgeMs(sim?.simulatorHeartbeat) < 4000;
  const mlSynced = !!sim && sim.mlMinute >= 0 && minute - sim.mlMinute < 3;

  const call = (p: Promise<void>) => p.catch(e => onError(errorMessage(e)));

  return (
    <header className="flex h-16 shrink-0 items-center gap-4 border-b border-line bg-ink-900/90 px-5 backdrop-blur">
      <div className="flex shrink-0 items-center gap-3">
        <ArgusMark />
        <div className="leading-tight">
          <div className="text-[15px] font-semibold tracking-[0.2em] text-fg">ARGUS</div>
          <div className="hidden whitespace-nowrap text-[10.5px] text-fg-subtle 2xl:block">Every patient seen · every resource watched</div>
        </div>
      </div>

      <div className="hidden min-w-0 shrink border-l border-line pl-5 lg:block">
        <div className="truncate text-[13px] font-medium text-fg">{sim?.scenarioTitle ?? 'No scenario'}</div>
        <div className="mt-0.5 flex items-center gap-2 text-[11px] text-fg-subtle">
          <span className="chip shrink-0 whitespace-nowrap border-amber/30 bg-amber/10 text-amber">Synthetic data</span>
          <span className="hidden truncate 2xl:inline">Decision support for training &amp; planning · not a medical device</span>
        </div>
      </div>

      <div className="mx-auto flex shrink-0 items-center gap-4">
        <button
          type="button"
          onClick={() => call(setPlayback({ paused: !paused, speed }))}
          disabled={!sim}
          className={cx(
            'flex h-10 w-10 items-center justify-center rounded-full border transition-colors',
            paused ? 'border-accent/50 bg-accent/15 text-accent hover:bg-accent/25' : 'border-line-strong bg-ink-800 text-fg hover:bg-ink-700'
          )}
          aria-label={paused ? 'Play scenario' : 'Pause scenario'}
        >
          {paused ? <Play className="ml-0.5 h-4 w-4" /> : <Pause className="h-4 w-4" />}
        </button>
        <div className="w-44">
          <div className="flex items-baseline justify-between">
            <span className="num text-2xl font-semibold tracking-tight text-fg">{clock(minute)}</span>
            <span className="num text-[11px] text-fg-subtle">/ {clock(length)}</span>
          </div>
          <div className="mt-1 h-1 overflow-hidden rounded-full bg-line">
            <div className="h-full rounded-full bg-accent transition-[width] duration-500" style={{ width: `${pct}%` }} />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="range"
            min={1}
            max={120}
            value={speed}
            aria-label="Simulation speed"
            onChange={e => call(setPlayback({ paused, speed: Number(e.target.value) }))}
            style={{ ['--pct' as string]: `${((speed - 1) / 119) * 100}%` }}
            className="w-24"
            disabled={!sim}
          />
          <div className="flex overflow-hidden rounded-lg border border-line">
            {SPEEDS.map(s => (
              <button
                key={s}
                type="button"
                disabled={!sim}
                onClick={() => call(setPlayback({ paused, speed: s }))}
                className={cx(
                  'num px-2 py-1 text-[11px] transition-colors',
                  Math.round(speed) === s ? 'bg-accent/15 text-accent' : 'text-fg-subtle hover:text-fg'
                )}
              >
                {s}×
              </button>
            ))}
          </div>
          <span className="num w-10 text-right text-[12px] text-fg-muted">{Math.round(speed)}×</span>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-3">
        <div className="flex overflow-hidden rounded-lg border border-line text-[11px]" title="Local triage protocol">
          {(['SALT', 'START'] as const).map(p => (
            <button
              key={p}
              type="button"
              disabled={!sim}
              onClick={() => call(setProtocol({ protocol: p }))}
              className={cx('whitespace-nowrap px-2 py-1 font-medium', sim?.protocol === p ? 'bg-ink-700 text-fg' : 'text-fg-subtle hover:text-fg')}
            >
              {p}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <Health ok={connected} icon={<Database className="h-3 w-3" />} label="SpacetimeDB" detail={connected ? 'subscribed' : 'disconnected'} />
          <Health ok={simAlive} warn={paused && !!sim} icon={<Activity className="h-3 w-3" />} label="Simulator" detail={paused ? 'paused' : simAlive ? 'streaming' : 'no heartbeat'} />
          <Health ok={mlSynced} warn={!!sim && !mlSynced} icon={<BrainCircuit className="h-3 w-3" />} label="ML" detail={mlSynced ? 'forecast current' : 'waiting for sidecar'} />
        </div>
        <span
          className={cx(
            'chip shrink-0 gap-1.5 whitespace-nowrap px-2 py-1',
            online ? 'border-line text-fg-subtle' : 'border-accent/50 bg-accent/10 text-accent'
          )}
          title={online ? 'Network available — Argus does not need it' : 'No network — everything runs on this laptop'}
        >
          {online ? <Wifi className="h-3.5 w-3.5" /> : <WifiOff className="h-3.5 w-3.5" />}
          {online ? 'Local' : 'Offline · local only'}
        </span>
        <a href="#/intake" target="_blank" rel="noreferrer" className="btn-ghost shrink-0 whitespace-nowrap !py-1 text-[12px]">
          <Tablet className="h-3.5 w-3.5" />
          Medic intake
        </a>
      </div>
    </header>
  );
}
