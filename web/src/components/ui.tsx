import { AlertOctagon, AlertTriangle, CheckCircle2, Info } from 'lucide-react';
import type { ReactNode } from 'react';
import { PRECEDENCE_LABEL, type Precedence } from '@protocols';
import { CATEGORY_LABEL, CATEGORY_SHORT, CATEGORY_STYLE, LEVEL_STYLE, asCategory } from '../lib/format';

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

export function ArgusMark({ className = 'h-7 w-7' }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" fill="none" className={className} aria-hidden>
      <rect width="64" height="64" rx="14" className="fill-ink-800" />
      <path
        d="M8 32c6.5-10 14.6-15 24-15s17.5 5 24 15c-6.5 10-14.6 15-24 15S14.5 42 8 32Z"
        className="stroke-accent"
        strokeWidth="3.2"
        strokeLinejoin="round"
      />
      <circle cx="32" cy="32" r="8.5" className="stroke-accent" strokeWidth="3.2" />
      <circle cx="32" cy="32" r="3" className="fill-accent" />
    </svg>
  );
}

export function CategoryBadge({ category, short = false, className }: { category: string; short?: boolean; className?: string }) {
  const c = asCategory(category);
  const s = CATEGORY_STYLE[c];
  return (
    <span className={cx('chip', s.bg, s.text, s.border, className)}>
      <span className={cx('h-1.5 w-1.5 rounded-full', s.dot)} />
      {short ? CATEGORY_SHORT[c] : CATEGORY_LABEL[c]}
    </span>
  );
}

const PRECEDENCE_STYLE: Record<string, string> = {
  A: 'border-immediate/40 text-immediate bg-immediate/10',
  B: 'border-immediate/40 text-immediate bg-immediate/10',
  C: 'border-delayed/40 text-delayed bg-delayed/10',
  D: 'border-minimal/40 text-minimal bg-minimal/10',
  E: 'border-line-strong text-fg-muted bg-ink-800',
};

export function PrecedenceBadge({ precedence, full = false }: { precedence: string; full?: boolean }) {
  if (!precedence) {
    return <span className="chip border-line text-fg-subtle">— no precedence</span>;
  }
  return (
    <span className={cx('chip font-mono', PRECEDENCE_STYLE[precedence])}>
      {precedence}
      {full && <span className="font-sans">· {PRECEDENCE_LABEL[precedence as Precedence]}</span>}
    </span>
  );
}

export function LevelIcon({ level, className = 'h-4 w-4' }: { level: string; className?: string }) {
  if (level === 'red') return <AlertOctagon className={cx(className, 'text-red')} aria-hidden />;
  if (level === 'amber') return <AlertTriangle className={cx(className, 'text-amber')} aria-hidden />;
  if (level === 'info') return <Info className={cx(className, 'text-info')} aria-hidden />;
  return <CheckCircle2 className={cx(className, 'text-ok')} aria-hidden />;
}

/** Status pill: icon + word + colour, never colour alone. */
export function LevelPill({ level, label }: { level: string; label?: string }) {
  const s = LEVEL_STYLE[level] ?? LEVEL_STYLE.ok;
  return (
    <span className={cx('chip gap-1.5 px-2 py-1 uppercase tracking-wider', s.bg, s.text, s.border)}>
      <LevelIcon level={level} className="h-3.5 w-3.5" />
      {label ?? s.label}
    </span>
  );
}

export function Panel({
  title,
  icon,
  right,
  children,
  className,
  bodyClassName,
}: {
  title: ReactNode;
  icon?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={cx('panel flex min-h-0 flex-col', className)}>
      <header className="panel-header">
        <div className="flex items-center gap-2">
          {icon && <span className="text-fg-subtle">{icon}</span>}
          <h2 className="eyebrow !text-fg-muted">{title}</h2>
        </div>
        {right}
      </header>
      <div className={cx('min-h-0 flex-1', bodyClassName)}>{children}</div>
    </section>
  );
}

export function Stat({ label, value, sub, className }: { label: string; value: ReactNode; sub?: ReactNode; className?: string }) {
  return (
    <div className={cx('min-w-0', className)}>
      <div className="eyebrow">{label}</div>
      <div className="num mt-0.5 text-lg font-semibold text-fg">{value}</div>
      {sub && <div className="text-[11px] text-fg-subtle">{sub}</div>}
    </div>
  );
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 py-8 text-center">
      {icon && <div className="text-fg-subtle">{icon}</div>}
      <div className="text-sm font-medium text-fg-muted">{title}</div>
      {children && <div className="max-w-xs text-xs leading-relaxed text-fg-subtle">{children}</div>}
    </div>
  );
}
