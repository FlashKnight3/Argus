/** Demand inference: Gamma–Poisson posterior, resupply-aware stockout probability, and backtests. */
import { gamma, poisson, quantile, seededRandom } from './rng.ts';

export const DAY_MS = 86_400_000;
export const PRIOR_DAYS = 7;
export const HISTORY_DAYS = 30;
const POOL_PRIOR_DAYS = 3;
const DRAWS = 2000;
/** How much an active national shortage stretches the expected resupply time, and its uncertainty. */
export const SHORTAGE_LEAD_MULTIPLIER = 2.5;
const NORMAL_LEAD_CV = 0.25;
const SHORTAGE_LEAD_CV = 0.6;

export type Risk = 'unknown' | 'stable' | 'watch' | 'critical';

export interface UsageEvent { atMs: number; quantity: number }

export interface ForecastInput {
  key: string;
  revision: number;
  unit: string;
  /** on hand minus reserved */
  free: number;
  baselineDaily: number;
  leadTimeDays: number;
  /** Positive usage quantities with timestamps (any age; the model applies its own window). */
  usage: UsageEvent[];
  /** Earliest ledger event for the item (opening count, receipt, …), bounding observed exposure. */
  firstObservedMs: number | null;
}

export interface ForecastOptions {
  nowMs: number;
  /** The item is linked to an FDA record that is currently in shortage. */
  fdaActive: boolean;
  /** Mean daily rate at other sites stocking the same NDC, if any (empirical-Bayes pooling). */
  poolRate?: number;
}

export interface Forecast {
  ratePerDay: number;
  daysP10: number;
  daysMedian: number;
  daysP90: number;
  pStockout: number;
  horizonDays: number;
  fdaAdjusted: boolean;
  pooled: boolean;
  risk: Risk;
  explanation: string;
}

export interface Posterior { shape: number; rate: number; pooled: boolean }

/** Gamma posterior over the Poisson daily demand rate, or null when nothing informs it. */
export function posterior(baseline: number, used: number, observedDays: number, poolRate = 0): Posterior | null {
  if (baseline > 0) return { shape: Math.max(0.5, baseline * PRIOR_DAYS) + used, rate: PRIOR_DAYS + observedDays, pooled: false };
  if (poolRate > 0) return { shape: Math.max(0.5, poolRate * POOL_PRIOR_DAYS) + used, rate: POOL_PRIOR_DAYS + observedDays, pooled: true };
  if (used > 0) return { shape: 0.5 + used, rate: 1 + observedDays, pooled: false };
  return null;
}

/** Usage in the trailing window and the observed exposure (days) that usage covers. */
export function windowStats(usage: readonly UsageEvent[], firstObservedMs: number | null, endMs: number, days = HISTORY_DAYS) {
  const start = endMs - days * DAY_MS;
  let used = 0;
  for (const e of usage) if (e.atMs >= start && e.atMs < endMs) used += e.quantity;
  const first = firstObservedMs ?? endMs;
  const observedDays = Math.min(days, Math.max(0, (endMs - Math.max(first, start)) / DAY_MS));
  return { used, observedDays };
}

function round(x: number, digits = 1) { const f = 10 ** digits; return Math.round(x * f) / f; }

export function classify(free: number, p10: number, pStockout: number, known: boolean): Risk {
  if (free <= 0) return 'critical';
  if (!known) return 'unknown';
  if (pStockout >= 0.5 || p10 <= 7) return 'critical';
  if (pStockout >= 0.15 || p10 <= 21) return 'watch';
  return 'stable';
}

export function forecastItem(input: ForecastInput, opts: ForecastOptions): Forecast {
  const { used, observedDays } = windowStats(input.usage, input.firstObservedMs, opts.nowMs);
  const post = posterior(input.baselineDaily, used, observedDays, opts.poolRate);
  const meanLead = Math.max(0.5, input.leadTimeDays) * (opts.fdaActive ? SHORTAGE_LEAD_MULTIPLIER : 1);
  const free = Math.max(0, input.free);
  if (!post) {
    return { ratePerDay: 0, daysP10: 0, daysMedian: 0, daysP90: 0, pStockout: free <= 0 ? 1 : 0, horizonDays: round(meanLead),
      fdaAdjusted: opts.fdaActive, pooled: false, risk: classify(free, 0, 0, false),
      explanation: free <= 0 ? 'No unreserved stock.' : 'Enter a daily usage baseline or record usage to enable a forecast.' };
  }
  const rng = seededRandom(`${input.key}:${input.revision}:${Math.floor(opts.nowMs / DAY_MS)}`);
  const cv = opts.fdaActive ? SHORTAGE_LEAD_CV : NORMAL_LEAD_CV;
  const leadShape = 1 / (cv * cv);
  const days: number[] = new Array(DRAWS);
  let stockouts = 0;
  for (let i = 0; i < DRAWS; i++) {
    const lambda = Math.max(gamma(rng, post.shape, 1 / post.rate), 1e-6);
    days[i] = free / lambda;
    const lead = gamma(rng, leadShape, meanLead / leadShape);
    if (poisson(rng, lambda * lead) > free) stockouts++;
  }
  days.sort((a, b) => a - b);
  const mean = post.shape / post.rate;
  const p10 = round(quantile(days, 0.1)), p50 = round(quantile(days, 0.5)), p90 = round(quantile(days, 0.9));
  const pStockout = free <= 0 ? 1 : Math.round((stockouts / DRAWS) * 1000) / 1000;
  const risk = classify(free, p10, pStockout, true);
  const parts = [
    `${free} ${input.unit} free; demand ≈ ${round(mean, 2)}/day (${used} used over ${round(observedDays)} observed days${input.baselineDaily > 0 ? `, ${input.baselineDaily}/day baseline prior` : post.pooled ? ', prior pooled from other sites' : ''}).`,
    `P(stockout before resupply) ${Math.round(pStockout * 100)}% over a ~${round(meanLead)}-day lead time${opts.fdaActive ? ` (stretched ×${SHORTAGE_LEAD_MULTIPLIER} by an active FDA shortage)` : ''}.`,
    'Ranges reflect demand and resupply uncertainty, not delivery promises.',
  ];
  return { ratePerDay: Math.round(mean * 1000) / 1000, daysP10: p10, daysMedian: p50, daysP90: p90, pStockout,
    horizonDays: round(meanLead), fdaAdjusted: opts.fdaActive, pooled: post.pooled, risk, explanation: parts.join(' ') };
}

/** Per-site pooled rates: mean demand estimate across sites with their own data, keyed by NDC. */
export function poolRates(items: ReadonlyArray<{ ndc: string; baselineDaily: number; used: number; observedDays: number }>): Map<string, number> {
  const sums = new Map<string, { total: number; n: number }>();
  for (const it of items) {
    const rate = it.baselineDaily > 0 ? it.baselineDaily : it.observedDays >= 1 && it.used > 0 ? it.used / it.observedDays : 0;
    if (rate <= 0) continue;
    const s = sums.get(it.ndc) ?? { total: 0, n: 0 };
    s.total += rate; s.n += 1;
    sums.set(it.ndc, s);
  }
  return new Map([...sums].map(([k, s]) => [k, s.total / s.n]));
}

export interface BacktestWindow { predictedMean: number; lo: number; hi: number; actual: number }

/**
 * Rolling-origin evaluation: at weekly origins, fit on the trailing window only and predict the
 * next 7 days of demand (Gamma–Poisson predictive). Requires at least three weeks of history.
 */
export function backtestItem(key: string, baseline: number, usage: readonly UsageEvent[], firstObservedMs: number | null,
  nowMs: number, horizonDays = 7): BacktestWindow[] {
  if (firstObservedMs === null || !usage.length) return [];
  const windows: BacktestWindow[] = [];
  const step = horizonDays * DAY_MS;
  for (let origin = firstObservedMs + 14 * DAY_MS; origin + step <= nowMs; origin += step) {
    const { used, observedDays } = windowStats(usage, firstObservedMs, origin);
    const post = posterior(baseline, used, observedDays);
    if (!post) continue;
    const rng = seededRandom(`${key}:bt:${origin}`);
    const draws: number[] = [];
    for (let i = 0; i < 800; i++) draws.push(poisson(rng, gamma(rng, post.shape, 1 / post.rate) * horizonDays));
    draws.sort((a, b) => a - b);
    let actual = 0;
    for (const e of usage) if (e.atMs >= origin && e.atMs < origin + step) actual += e.quantity;
    windows.push({ predictedMean: (post.shape / post.rate) * horizonDays, lo: quantile(draws, 0.1), hi: quantile(draws, 0.9), actual });
  }
  return windows;
}

export function summarizeBacktest(windows: readonly BacktestWindow[]) {
  if (!windows.length) return { windows: 0, coverage80: 0, meanAbsError: 0, bias: 0 };
  let covered = 0, abs = 0, bias = 0;
  for (const w of windows) {
    if (w.actual >= w.lo && w.actual <= w.hi) covered++;
    abs += Math.abs(w.predictedMean - w.actual);
    bias += w.predictedMean - w.actual;
  }
  const n = windows.length;
  return { windows: n, coverage80: covered / n, meanAbsError: abs / n, bias: bias / n };
}
