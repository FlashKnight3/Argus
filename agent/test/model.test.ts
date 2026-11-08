import { describe, expect, it } from 'vitest';
import { backtestItem, DAY_MS, forecastItem, poolRates, posterior, summarizeBacktest, type UsageEvent } from '../src/model.ts';
import { poisson, seededRandom } from '../src/rng.ts';

const NOW = Date.UTC(2026, 10, 7);
const base = { key: '1:00409488810', revision: 3, unit: 'vials', leadTimeDays: 7, firstObservedMs: NOW - 30 * DAY_MS };

function history(rate: number, days: number, seed = 'h'): UsageEvent[] {
  const rng = seededRandom(seed);
  const out: UsageEvent[] = [];
  for (let d = days; d >= 1; d--) { const q = poisson(rng, rate); if (q) out.push({ atMs: NOW - d * DAY_MS + 3600_000, quantity: q }); }
  return out;
}

describe('demand posterior', () => {
  it('is unknown without a baseline, usage, or pooled prior', () => {
    expect(posterior(0, 0, 10)).toBeNull();
    const f = forecastItem({ ...base, free: 40, baselineDaily: 0, usage: [] }, { nowMs: NOW, fdaActive: false });
    expect(f.risk).toBe('unknown');
  });
  it('borrows a weak prior from other sites when the site has no data', () => {
    const p = posterior(0, 0, 0, 4)!;
    expect(p.pooled).toBe(true);
    expect(p.shape / p.rate).toBeCloseTo(4, 5);
    const f = forecastItem({ ...base, free: 40, baselineDaily: 0, usage: [] }, { nowMs: NOW, fdaActive: false, poolRate: 4 });
    expect(f.pooled).toBe(true);
    expect(f.risk).not.toBe('unknown');
  });
  it('lets observed usage outweigh a stale baseline', () => {
    const f = forecastItem({ ...base, free: 100, baselineDaily: 1, usage: history(6, 30) }, { nowMs: NOW, fdaActive: false });
    expect(f.ratePerDay).toBeGreaterThan(4.5);
  });
  it('pools rates per NDC from sites that have their own data', () => {
    const pools = poolRates([{ ndc: 'a', baselineDaily: 2, used: 0, observedDays: 0 }, { ndc: 'a', baselineDaily: 0, used: 40, observedDays: 10 }, { ndc: 'b', baselineDaily: 0, used: 0, observedDays: 5 }]);
    expect(pools.get('a')).toBeCloseTo(3);
    expect(pools.has('b')).toBe(false);
  });
});

describe('stockout probability', () => {
  it('reads 30 observed days of zero usage as evidence of low demand', () => {
    const quiet = forecastItem({ ...base, free: 25, baselineDaily: 3, usage: [] }, { nowMs: NOW, fdaActive: false });
    const fresh = forecastItem({ ...base, firstObservedMs: null, free: 25, baselineDaily: 3, usage: [] }, { nowMs: NOW, fdaActive: false });
    expect(quiet.ratePerDay).toBeLessThan(fresh.ratePerDay);
  });
  it('is deterministic for the same inputs and ordered percentiles', () => {
    const input = { ...base, free: 30, baselineDaily: 3, usage: history(3, 30) };
    const a = forecastItem(input, { nowMs: NOW, fdaActive: false });
    const b = forecastItem(input, { nowMs: NOW, fdaActive: false });
    expect(a).toEqual(b);
    expect(a.daysP10).toBeLessThanOrEqual(a.daysMedian);
    expect(a.daysMedian).toBeLessThanOrEqual(a.daysP90);
  });
  it('rises as free stock falls', () => {
    // No observed exposure yet, so the 3/day baseline drives demand.
    const p = (free: number) => forecastItem({ ...base, firstObservedMs: null, free, baselineDaily: 3, usage: [] }, { nowMs: NOW, fdaActive: false }).pStockout;
    expect(p(10)).toBeGreaterThan(p(25));
    expect(p(25)).toBeGreaterThan(p(60));
    expect(p(0)).toBe(1);
  });
  it('treats an active FDA shortage as a longer, less certain resupply', () => {
    const input = { ...base, free: 35, baselineDaily: 3, usage: [] };
    const normal = forecastItem(input, { nowMs: NOW, fdaActive: false });
    const shortage = forecastItem(input, { nowMs: NOW, fdaActive: true });
    expect(shortage.fdaAdjusted).toBe(true);
    expect(shortage.horizonDays).toBeGreaterThan(normal.horizonDays);
    expect(shortage.pStockout).toBeGreaterThan(normal.pStockout);
  });
  it('classifies risk from pStockout and pessimistic cover', () => {
    expect(forecastItem({ ...base, free: 5, baselineDaily: 3, usage: [] }, { nowMs: NOW, fdaActive: false }).risk).toBe('critical');
    expect(forecastItem({ ...base, free: 500, baselineDaily: 3, usage: [] }, { nowMs: NOW, fdaActive: false }).risk).toBe('stable');
  });
});

describe('rolling backtest', () => {
  it('is empty without enough history', () => {
    expect(backtestItem('k', 2, history(2, 10), NOW - 10 * DAY_MS, NOW)).toEqual([]);
  });
  it('produces roughly calibrated 80% intervals on Poisson demand', () => {
    const windows = Array.from({ length: 12 }, (_, i) => {
      const usage = history(4, 70, `cal${i}`);
      return backtestItem(`k${i}`, 4, usage, NOW - 70 * DAY_MS, NOW);
    }).flat();
    const s = summarizeBacktest(windows);
    expect(s.windows).toBeGreaterThan(50);
    expect(s.coverage80).toBeGreaterThan(0.65);
    expect(s.coverage80).toBeLessThan(0.97);
    expect(Math.abs(s.bias)).toBeLessThan(4);
  });
});
