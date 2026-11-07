import type { TriageCategory } from '@protocols';

/** Scenario minute → "T+1:05". */
export function clock(minute: number): string {
  const total = Math.max(0, Math.floor(minute));
  const h = Math.floor(total / 60);
  const m = String(total % 60).padStart(2, '0');
  return `T+${h}:${m}`;
}

export function minutes(m: number): string {
  if (m < 0) return '> 4 h';
  if (m < 1) return 'now';
  if (m >= 60) {
    const h = Math.floor(m / 60);
    const r = Math.round(m % 60);
    return r ? `${h} h ${r} m` : `${h} h`;
  }
  return `${Math.round(m)} min`;
}

export function round(n: number, dp = 0): string {
  const f = 10 ** dp;
  return String(Math.round(n * f) / f);
}

export const CATEGORY_LABEL: Record<TriageCategory, string> = {
  immediate: 'Immediate',
  delayed: 'Delayed',
  minimal: 'Minimal',
  expectant: 'Expectant',
  dead: 'Dead',
};

export const CATEGORY_SHORT: Record<TriageCategory, string> = {
  immediate: 'IMM',
  delayed: 'DEL',
  minimal: 'MIN',
  expectant: 'EXP',
  dead: 'DEAD',
};

/** Tailwind classes per triage category (bg, text, border, dot). */
export const CATEGORY_STYLE: Record<TriageCategory, { bg: string; text: string; border: string; dot: string }> = {
  immediate: { bg: 'bg-immediate/15', text: 'text-immediate', border: 'border-immediate/50', dot: 'bg-immediate' },
  delayed: { bg: 'bg-delayed/12', text: 'text-delayed', border: 'border-delayed/45', dot: 'bg-delayed' },
  minimal: { bg: 'bg-minimal/12', text: 'text-minimal', border: 'border-minimal/45', dot: 'bg-minimal' },
  expectant: { bg: 'bg-expectant/12', text: 'text-expectant', border: 'border-expectant/45', dot: 'bg-expectant' },
  dead: { bg: 'bg-dead/40', text: 'text-fg-subtle', border: 'border-dead', dot: 'bg-dead' },
};

export function asCategory(c: string): TriageCategory {
  return (['immediate', 'delayed', 'minimal', 'expectant', 'dead'] as const).includes(c as TriageCategory)
    ? (c as TriageCategory)
    : 'delayed';
}

export const LEVEL_STYLE: Record<string, { text: string; bg: string; border: string; label: string }> = {
  ok: { text: 'text-ok', bg: 'bg-ok/10', border: 'border-ok/30', label: 'Stable' },
  amber: { text: 'text-amber', bg: 'bg-amber/12', border: 'border-amber/40', label: 'Amber' },
  red: { text: 'text-red', bg: 'bg-red/12', border: 'border-red/45', label: 'Red' },
  info: { text: 'text-info', bg: 'bg-info/10', border: 'border-info/30', label: 'Info' },
};

export function safeJson<T>(s: string, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
