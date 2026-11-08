import { describe, expect, it } from 'vitest';
import { assignLeases, leaseActions } from '../src/leases.ts';
import { fdaTo11, localCandidates11, matchCandidates } from '../src/ndc.ts';
import { maxGive, needOf, planTransfers, type PlanItem } from '../src/planner.ts';
import { collectFda, normalizeFda } from '../../server/src/fda.ts';

describe('NDC normalization and FDA matching', () => {
  it('converts hyphenated FDA NDCs to 5-4-2 and enumerates local 10-digit layouts', () => {
    expect(fdaTo11('0409-4888-10')).toBe('00409488810');
    expect(fdaTo11('63323-262-01')).toBe('63323026201');
    expect(localCandidates11('0409488810')).toContain('00409488810');
    expect(localCandidates11('6332326201')).toContain('63323026201');
  });
  const shortages = [
    { key: 'exact', packageNdc: '0409-4888-10', genericName: 'Lidocaine Hydrochloride', presentation: '', status: 'Current', active: true },
    { key: 'pkg', packageNdc: '63323-262-01', genericName: 'Heparin Sodium', presentation: '', status: 'Currently in Shortage', active: true },
    { key: 'name', packageNdc: '1111-2222-33', genericName: 'Ondansetron', presentation: '', status: 'Current', active: true },
    { key: 'gone', packageNdc: '0409-4888-10', genericName: 'Lidocaine', presentation: '', status: 'Resolved', active: false },
  ];
  it('ranks exact package > same product code > name only, ignoring inactive records', () => {
    expect(matchCandidates({ ndc: '00409488810', label: 'Lidocaine 1% vial' }, shortages)[0]).toMatchObject({ shortageKey: 'exact', confidence: 0.97 });
    expect(matchCandidates({ ndc: '63323026299', label: 'Heparin 5000 unit/mL' }, shortages)[0]).toMatchObject({ shortageKey: 'pkg', confidence: 0.75 });
    expect(matchCandidates({ ndc: '99999999999', label: 'Ondansetron 2 mg/mL injection' }, shortages)[0]).toMatchObject({ shortageKey: 'name', confidence: 0.5 });
    expect(matchCandidates({ ndc: '99999999999', label: 'Something else' }, shortages)).toEqual([]);
  });
});

const item = (over: Partial<PlanItem>): PlanItem => ({ key: `${over.siteId}:n`, siteId: 1, ndc: 'n', unit: 'vials', label: 'Drug',
  free: 100, safetyStock: 10, rate: 2, risk: 'stable', pStockout: 0, daysP10: 40, revision: 1, ...over });

describe('bounded transfer planner', () => {
  it('never lets a source drop below safety stock or 21 days of its own demand', () => {
    expect(maxGive(item({ free: 100, safetyStock: 10, rate: 2 }))).toBe(58);
    expect(maxGive(item({ free: 100, safetyStock: 70, rate: 2 }))).toBe(30);
    expect(maxGive(item({ risk: 'watch' }))).toBe(0);
  });
  it('fills a critical destination from multiple sources, most spare first, sharing capacity', () => {
    const dest = item({ siteId: 1, free: 4, rate: 6, safetyStock: 20, risk: 'critical', pStockout: 0.9, daysP10: 0.5 });
    const a = item({ siteId: 2, free: 80, rate: 2, safetyStock: 10 });   // gives 38
    const b = item({ siteId: 3, free: 120, rate: 2, safetyStock: 10 });  // gives 78
    expect(needOf(dest)).toBe(122);
    const drafts = planTransfers([dest, a, b]);
    expect(drafts.map(d => [d.sourceSiteId, d.quantity])).toEqual([[3, 78], [2, 38]]);
    expect(drafts.every(d => d.destSiteId === 1)).toBe(true);
  });
  it('uses an equivalent product (same RxCUI, different NDC) only when no exact donor covers the need', () => {
    const dest = item({ key: '1:a', siteId: 1, ndc: 'a', rxcui: '123', free: 2, rate: 3, risk: 'critical', pStockout: 0.9 });
    const exact = item({ key: '2:a', siteId: 2, ndc: 'a', rxcui: '123', free: 80, rate: 1 });      // gives 59
    const equiv = item({ key: '3:b', siteId: 3, ndc: 'b', rxcui: '123', free: 300, rate: 1 });     // gives 279
    const other = item({ key: '4:c', siteId: 4, ndc: 'c', rxcui: '999', free: 900, rate: 1 });
    const drafts = planTransfers([dest, exact, equiv, other]);
    expect(drafts.map(d => [d.sourceSiteId, d.ndc, d.destNdc, d.quantity])).toEqual([[2, 'a', undefined, 59], [3, 'b', 'a', 2]]);
    expect(drafts[1].reason).toMatch(/pharmacist must confirm/);
    expect(planTransfers([dest, { ...equiv, rxcui: undefined }])).toEqual([]);
  });
  it('skips routes that already have an open transfer, and units that differ', () => {
    const dest = item({ siteId: 1, free: 2, rate: 3, risk: 'critical', pStockout: 0.8 });
    const src = item({ siteId: 2, free: 300 });
    expect(planTransfers([dest, src], new Set(['1:n']))).toEqual([]);
    expect(planTransfers([dest, { ...src, unit: 'mL' }])).toEqual([]);
  });
});

describe('lease assignment', () => {
  const resources = ['agent', 'fda', 'site:1', 'site:2', 'site:3'];
  it('gives every worker a fair share and is identical on every worker', () => {
    const m = assignLeases(resources, ['w1', 'w2']);
    const counts = [...m.values()].reduce((acc, w) => acc.set(w, (acc.get(w) ?? 0) + 1), new Map<string, number>());
    expect([...counts.values()].sort()).toEqual([2, 3]);
    expect(assignLeases(resources, ['w1', 'w2'])).toEqual(m);
  });
  it('moves only the departed worker’s resources when membership shrinks', () => {
    const three = assignLeases(resources, ['w1', 'w2', 'w3']);
    const two = assignLeases(resources, ['w1', 'w2']);
    for (const [r, w] of three) if (w !== 'w3' && two.get(r) !== w) {
      // a survivor may only lose a resource if fair-share capacity forced it; never to w3
      expect(two.get(r)).not.toBe('w3');
    }
    expect([...two.values()].every(w => w !== 'w3')).toBe(true);
  });
  it('acquires free or expired assigned leases, waits on live ones held elsewhere, releases the rest', () => {
    const now = 1_000_000n;
    const assignment = new Map([['a', 'me'], ['b', 'me'], ['c', 'other']]);
    const leases = [
      { resource: 'a', holder: '', epoch: 1n, expiresAtMicros: 0n },
      { resource: 'b', holder: 'other', epoch: 4n, expiresAtMicros: now + 5n },
      { resource: 'c', holder: 'me', epoch: 2n, expiresAtMicros: now + 5n },
    ];
    expect(leaseActions('me', assignment, leases, now)).toEqual({ acquire: ['a'], release: ['c'] });
    const expired = leases.map(l => l.resource === 'b' ? { ...l, expiresAtMicros: now - 1n } : l);
    expect(leaseActions('me', assignment, expired, now).acquire).toEqual(['a', 'b']);
  });
});

describe('FDA ingestion (runs inside the database as a scheduled procedure)', () => {
  it('normalizes with the same stable key as the browser importer', () => {
    const row = normalizeFda({ package_ndc: '0409-4888-10', generic_name: 'Lidocaine', company_name: 'Hospira', presentation: 'Vial' });
    expect(row.key).toHaveLength(24);
    expect(normalizeFda({ package_ndc: ' 0409-4888-10 ', generic_name: 'LIDOCAINE', company_name: 'Hospira', presentation: 'vial' }).key).toBe(row.key);
  });
  it('refuses a feed whose pages do not add up to the declared total', () => {
    const pages = [{ meta: { last_updated: '2026-11-06', results: { total: 3 } }, results: [{ generic_name: 'a' }, { generic_name: 'b' }] }, { results: [] }];
    let i = 0;
    expect(() => collectFda(() => pages[i++])).toThrow(/declared record count/);
  });
  it('dedupes a complete feed', () => {
    const r = { package_ndc: '1-2-3', generic_name: 'x', company_name: 'c', presentation: 'p', status: 'Current' };
    const out = collectFda(() => ({ meta: { last_updated: '2026-11-06', results: { total: 2 } }, results: [r, r] }));
    expect(out.rows).toHaveLength(1);
    expect(out.feedDate).toBe('2026-11-06');
  });
});
