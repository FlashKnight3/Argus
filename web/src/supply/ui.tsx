import { useEffect, type ReactNode } from 'react';
import { X } from 'lucide-react';
import type { Member, Site } from './useSupply';

export type Tone = 'neutral' | 'good' | 'watch' | 'danger' | 'info' | 'orange';

export function Pill({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`pill pill-${tone}`}>{children}</span>;
}

export function Empty({ title, detail, action }: { title: string; detail: string; action?: ReactNode }) {
  return <div className="empty"><strong>{title}</strong><p>{detail}</p>{action && <div style={{ marginTop: 14 }}>{action}</div>}</div>;
}

export function PageHead({ title, subtitle, right }: { title: string; subtitle?: string; right?: ReactNode }) {
  return <div className="page-head"><div><h1>{title}</h1>{subtitle && <p>{subtitle}</p>}</div>{right && <div className="page-head-right">{right}</div>}</div>;
}

export function Tabs<T extends string>({ tabs, value, onChange }: {
  tabs: Array<{ id: T; label: string; count?: number }>; value: T; onChange: (id: T) => void;
}) {
  return <div className="tabs" role="tablist">{tabs.map(t => <button key={t.id} role="tab" aria-selected={value === t.id}
    className={`tab ${value === t.id ? 'active' : ''}`} onClick={() => onChange(t.id)}>{t.label}{t.count !== undefined && t.count > 0 && <span className="count">{t.count}</span>}</button>)}</div>;
}

export function Section({ title, subtitle, action, children }: { title?: string; subtitle?: string; action?: ReactNode; children: ReactNode }) {
  return <section className="section">{(title || action) && <div className="section-head"><div>{title && <h2>{title}</h2>}{subtitle && <p>{subtitle}</p>}</div>{action}</div>}{children}</section>;
}

export function Modal({ title, subtitle, onClose, children, footer }: { title: string; subtitle?: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="modal" role="dialog" aria-label={title}>
      <div className="modal-head"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div><button className="icon-button" onClick={onClose} aria-label="Close"><X size={18}/></button></div>
      {children}
      {footer && <div className="modal-foot">{footer}</div>}
    </div></div>;
}

export function number(value: number, digits = 0) {
  return Number.isFinite(value) ? value.toLocaleString(undefined, { maximumFractionDigits: digits }) : '—';
}

export function percent(value: number) {
  return Number.isFinite(value) ? `${Math.round(value * 100)}%` : '—';
}

export function date(value: { microsSinceUnixEpoch: bigint } | undefined) {
  if (!value) return '—';
  const n = Number(value.microsSinceUnixEpoch / 1000n);
  return Number.isFinite(n) ? new Date(n).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—';
}

export function siteName(sites: readonly Site[], id: number) {
  return sites.find(site => site.id === id)?.name ?? `Site ${id}`;
}

export function canManage(member: Member | undefined, siteId: number) {
  return member?.role === 'admin' || (member?.role === 'manager' && member.siteId === siteId);
}

export function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function riskTone(risk: string): Tone {
  return risk === 'critical' ? 'danger' : risk === 'watch' ? 'watch' : risk === 'stable' ? 'good' : 'neutral';
}

export const riskLabel = (risk: string) => risk === 'critical' ? 'Critical' : risk === 'watch' ? 'Watch' : risk === 'stable' ? 'Stable' : 'Unknown';
