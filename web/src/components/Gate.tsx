import { Loader2, Terminal } from 'lucide-react';
import type { ReactNode } from 'react';
import { DB_NAME, HOST } from '../lib/connection';
import { ArgusMark } from './ui';

function Code({ children }: { children: ReactNode }) {
  return <code className="block rounded-lg border border-line bg-ink-950 px-3 py-2 font-mono text-[12px] text-accent">{children}</code>;
}

export function Gate({ connected }: { connected: boolean }) {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="panel w-full max-w-lg p-7">
        <div className="flex items-center gap-3">
          <ArgusMark className="h-10 w-10" />
          <div>
            <div className="text-lg font-semibold tracking-[0.2em] text-fg">ARGUS</div>
            <div className="text-[12px] text-fg-subtle">Every patient seen, every resource watched.</div>
          </div>
        </div>
        <div className="mt-6 flex items-center gap-2 text-[13px] text-fg-muted">
          {connected ? (
            <>
              <span className="h-2 w-2 rounded-full bg-ok" /> Connected to <span className="num text-fg">{DB_NAME}</span> — no scenario loaded yet.
            </>
          ) : (
            <>
              <Loader2 className="h-4 w-4 animate-spin text-accent" /> Connecting to SpacetimeDB at <span className="num text-fg">{HOST}</span>…
            </>
          )}
        </div>
        <div className="mt-5 space-y-2.5">
          <div className="eyebrow flex items-center gap-1.5">
            <Terminal className="h-3.5 w-3.5" /> {connected ? 'Start the scenario' : 'Start everything with one command'}
          </div>
          <Code>npm run demo</Code>
          <p className="text-[12px] leading-relaxed text-fg-subtle">
            Starts a local SpacetimeDB, publishes the module, then runs the simulator, the ML sidecar and this dashboard. No internet required.
          </p>
        </div>
      </div>
    </div>
  );
}
