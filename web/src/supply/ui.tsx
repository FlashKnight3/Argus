import type { ReactNode } from 'react';
import type { Member, Site } from './useSupply';

export function Panel({ title, eyebrow, action, children, className = '' }: {
  title: string; eyebrow?: string; action?: ReactNode; children: ReactNode; className?: string;
}) {
  return <section className={`panel ${className}`}>
    <div className="panel-head"><div>{eyebrow && <div className="eyebrow">{eyebrow}</div>}<h2>{title}</h2></div>{action}</div>
    <div className="panel-body">{children}</div>
  </section>;
}

export function Pill({ tone = 'neutral', children }: { tone?: 'neutral' | 'good' | 'watch' | 'danger' | 'info'; children: ReactNode }) {
  return <span className={`pill pill-${tone}`}>{children}</span>;
}

export function Empty({ title, detail }: { title: string; detail: string }) {
  return <div className="empty"><div className="empty-orbit">◇</div><strong>{title}</strong><p>{detail}</p></div>;
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
  return Number.isFinite(n) ? new Date(n).toLocaleString() : '—';
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

export function riskTone(risk: string): 'neutral' | 'good' | 'watch' | 'danger' {
  return risk === 'critical' ? 'danger' : risk === 'watch' ? 'watch' : risk === 'stable' ? 'good' : 'neutral';
}
