/** Inventory CSV import: parse, map columns, validate against the network's sites. */

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some(v => v.trim())) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some(v => v.trim())) rows.push(row);
  return rows;
}

export const TEMPLATE = 'site,ndc,product,unit,on_hand,daily_use,safety_stock,lead_time_days\n'
  + 'North Pharmacy,0409-4888-10,Lidocaine 1% 10 mL vial,vials,120,4,20,7\n';

const ALIASES: Record<string, string[]> = {
  site: ['site', 'site_name', 'pharmacy', 'location'],
  ndc: ['ndc', 'package_ndc', 'ndc_code'],
  product: ['product', 'name', 'label', 'drug', 'description'],
  unit: ['unit', 'units', 'uom'],
  onHand: ['on_hand', 'onhand', 'quantity', 'qty', 'count', 'stock'],
  dailyUse: ['daily_use', 'daily_usage', 'use_per_day', 'baseline', 'usage'],
  safetyStock: ['safety_stock', 'safety', 'par', 'minimum', 'min'],
  leadTime: ['lead_time_days', 'lead_time', 'leadtime'],
};

export interface ImportRow {
  line: number;
  siteId: number;
  siteLabel: string;
  ndc: string;
  product: string;
  unit: string;
  onHand: number;
  dailyUse: number;
  safetyStock: number;
  leadTime: number;
  errors: string[];
}

export function mapRows(rows: string[][], sites: ReadonlyArray<{ id: number; name: string }>): { rows: ImportRow[]; missing: string[] } {
  if (!rows.length) return { rows: [], missing: ['header row'] };
  const header = rows[0].map(h => h.trim().toLowerCase().replace(/[\s-]+/g, '_'));
  const col = (field: string) => header.findIndex(h => ALIASES[field].includes(h));
  const idx = Object.fromEntries(Object.keys(ALIASES).map(f => [f, col(f)])) as Record<keyof typeof ALIASES, number>;
  const missing = ['site', 'ndc', 'product', 'onHand'].filter(f => idx[f] < 0);
  if (missing.length) return { rows: [], missing };
  const num = (v: string | undefined, fallback: number) => (v === undefined || v.trim() === '' ? fallback : Number(v.replace(/,/g, '')));
  const out = rows.slice(1).map((r, i) => {
    const get = (f: keyof typeof ALIASES) => (idx[f] >= 0 ? (r[idx[f]] ?? '').trim() : undefined);
    const siteRaw = get('site') ?? '';
    const site = sites.find(s => s.name.toLowerCase() === siteRaw.toLowerCase() || String(s.id) === siteRaw);
    const ndc = (get('ndc') ?? '').replace(/[^0-9]/g, '');
    const row: ImportRow = { line: i + 2, siteId: site?.id ?? 0, siteLabel: site?.name ?? siteRaw, ndc, product: get('product') ?? '',
      unit: get('unit') || 'units', onHand: num(get('onHand'), NaN), dailyUse: num(get('dailyUse'), 0),
      safetyStock: num(get('safetyStock'), 0), leadTime: num(get('leadTime'), 7), errors: [] };
    if (!site) row.errors.push(`Unknown site “${siteRaw}”`);
    if (ndc.length < 10 || ndc.length > 11) row.errors.push('NDC must have 10–11 digits');
    if (!row.product) row.errors.push('Product name is missing');
    for (const [label, v] of [['On hand', row.onHand], ['Daily use', row.dailyUse], ['Safety stock', row.safetyStock]] as const)
      if (!Number.isFinite(v) || v < 0) row.errors.push(`${label} must be a number ≥ 0`);
    if (!Number.isFinite(row.leadTime) || row.leadTime <= 0) row.errors.push('Lead time must be > 0');
    return row;
  });
  return { rows: out, missing: [] };
}
