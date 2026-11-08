import { describe, expect, it } from 'vitest';
import { mapRows, parseCsv } from './csv';
import { score, suggest } from './search';

const shortages = [
  { key: 'h1', genericName: 'Heparin Sodium Injection', packageNdc: '63323-262-01', status: 'Current', active: true, updateDate: '2026-11-01', companyName: '', presentation: '' },
  { key: 'h2', genericName: 'Heparin Sodium Injection', packageNdc: '63323-262-02', status: 'Current', active: true, updateDate: '2026-11-02', companyName: '', presentation: '' },
  { key: 'l1', genericName: 'Lidocaine Hydrochloride Injection', packageNdc: '0409-4888-10', status: 'Resolved', active: true, updateDate: '2026-10-01', companyName: '', presentation: '' },
  { key: 'b1', genericName: 'Bupivacaine Hydrochloride Injection', packageNdc: '0409-1159-01', status: 'Current', active: true, updateDate: '2026-11-05', companyName: '', presentation: '' },
  { key: 'x', genericName: 'Old record', packageNdc: '1-2-3', status: 'Current', active: false, updateDate: '2026-11-06', companyName: '', presentation: '' },
];
const items = [{ key: '1:63323026201', label: 'Heparin 5,000 units/mL', ndc: '63323026201', siteId: 1, shortageKey: 'h1' }];
const ctx = (risk: string) => ({ shortages, items, forecasts: new Map([['1:63323026201', { risk, pStockout: 0.8, inventoryRevision: 1 }]]),
  siteName: () => 'North', revisionOf: () => 1 });

describe('drug search suggestions', () => {
  it('ranks prefix > word-start > substring', () => {
    expect(score('Heparin Sodium', 'hep')).toBe(3);
    expect(score('Heparin Sodium', 'sod')).toBe(2);
    expect(score('Heparin Sodium', 'arin')).toBe(1);
    expect(score('Heparin Sodium', 'zzz')).toBe(0);
  });
  it('shows your inventory first, then one suggestion per FDA drug name, skipping inactive records', () => {
    const out = suggest('hep', ctx('critical'));
    expect(out[0]).toMatchObject({ kind: 'item', group: 'In your inventory' });
    const drugs = out.filter(s => s.kind === 'drug');
    expect(drugs).toHaveLength(1);
    expect(drugs[0].detail).toMatch(/2 packages/);
    expect(suggest('old', ctx('stable'))).toEqual([]);
  });
  it('matches NDC digits', () => {
    expect(suggest('0409-1159', ctx('stable'))[0]).toMatchObject({ kind: 'drug', shortageKey: 'b1' });
  });
  it('recommends from needs when the query is empty: at-risk items, then current shortages', () => {
    const out = suggest('', ctx('critical'));
    expect(out[0]).toMatchObject({ kind: 'item', group: 'Needs attention' });
    expect(out.some(s => s.kind === 'drug' && s.shortageKey === 'b1')).toBe(true);
    expect(out.some(s => s.kind === 'drug' && s.shortageKey === 'l1')).toBe(false); // resolved
    expect(suggest('', ctx('stable'))[0].kind).toBe('drug');
  });
});

describe('CSV import', () => {
  it('parses quotes, commas, and CRLF', () => {
    expect(parseCsv('a,b\r\n"x, y","he said ""hi"""\n\n')).toEqual([['a', 'b'], ['x, y', 'he said "hi"']]);
  });
  it('maps aliased headers, resolves sites by name or id, and validates', () => {
    const sites = [{ id: 1, name: 'North Pharmacy' }, { id: 2, name: 'South' }];
    const { rows, missing } = mapRows(parseCsv('Pharmacy,NDC,Drug,Qty,Usage\nnorth pharmacy,0409-4888-10,Lidocaine,"1,200",4\n2,123,Bad,-1,\nMoon,0409488810,X,5,'), sites);
    expect(missing).toEqual([]);
    expect(rows[0]).toMatchObject({ siteId: 1, ndc: '0409488810', onHand: 1200, dailyUse: 4, unit: 'units', leadTime: 7, errors: [] });
    expect(rows[1].errors).toEqual(expect.arrayContaining(['NDC must have 10–11 digits', 'On hand must be a number ≥ 0']));
    expect(rows[2].errors[0]).toMatch(/Unknown site/);
  });
  it('reports missing required columns', () => {
    expect(mapRows(parseCsv('site,ndc\nA,1'), []).missing).toEqual(['product', 'onHand']);
  });
});
