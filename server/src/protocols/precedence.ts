/**
 * MEDEVAC precedence, 9-line request line 3 (TCCC module 19).
 *
 *   A  Urgent            — evacuate within 2 h to save life, limb or eyesight
 *   B  Urgent-Surgical   — within 2 h, needs surgical intervention to stabilise
 *   C  Priority          — within 4 h, otherwise condition likely to deteriorate
 *   D  Routine           — within 24 h
 *   E  Convenience       — for convenience, not medical necessity
 *
 * Tiers are a hard rule. The ranker never places a Priority patient above an
 * Urgent one; ML only orders patients *inside* a tier.
 */
import type { Precedence, TriageCategory } from './types';

export const PRECEDENCE_LABEL: Record<Precedence, string> = {
  A: 'Urgent',
  B: 'Urgent-Surgical',
  C: 'Priority',
  D: 'Routine',
  E: 'Convenience',
};

/** Evacuation window in minutes. */
export const PRECEDENCE_WINDOW_MIN: Record<Precedence, number> = {
  A: 120,
  B: 120,
  C: 240,
  D: 1440,
  E: 2880,
};

/** Tier order: A and B share the same 2-hour window, so they share tier 0. */
export const PRECEDENCE_TIER: Record<Precedence, number> = {
  A: 0,
  B: 0,
  C: 1,
  D: 2,
  E: 3,
};

/**
 * Map a protocol category to precedence. Returns `null` for Expectant and
 * Dead: those patients are never auto-ranked for evacuation; a commander must
 * re-evaluate them explicitly.
 */
export function precedenceFor(
  category: TriageCategory | string,
  needsSurgery: boolean,
): Precedence | null {
  switch (category) {
    case 'immediate':
      return needsSurgery ? 'B' : 'A';
    case 'delayed':
      return 'C';
    case 'minimal':
      return 'D';
    default:
      return null;
  }
}

export function precedenceDeadline(arrivalMin: number, p: Precedence | null): number {
  if (!p) return -1;
  return arrivalMin + PRECEDENCE_WINDOW_MIN[p];
}

/** Compare two precedences by tier only (negative = a goes first). */
export function compareTier(a: Precedence, b: Precedence): number {
  return PRECEDENCE_TIER[a] - PRECEDENCE_TIER[b];
}
