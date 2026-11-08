/** openFDA drug shortage feed: normalization shared by the in-database importer (and its tests). */
import { sha256Hex } from './hash';

export const FDA_URL = 'https://api.fda.gov/drug/shortages.json';

export interface RawFdaRecord {
  package_ndc?: string; generic_name?: string; company_name?: string; presentation?: string;
  dosage_form?: string; status?: string; related_info?: string; update_date?: string;
  openfda?: { rxcui?: string[] };
}
export interface FdaPage { meta?: { last_updated?: string; results?: { total?: number } }; results?: RawFdaRecord[] }
export interface FdaRow {
  key: string; packageNdc: string; genericName: string; companyName: string; presentation: string;
  dosageForm: string; status: string; details: string; updateDate: string; rxcui: string;
}

/** Stable key over package NDC, name, company, presentation, so re-imports update the same row. */
export function normalizeFda(record: RawFdaRecord): FdaRow {
  const source = [record.package_ndc, record.generic_name, record.company_name, record.presentation]
    .map(v => String(v ?? '').trim().toLowerCase()).join('|');
  return {
    key: sha256Hex(source).slice(0, 24),
    packageNdc: String(record.package_ndc ?? ''),
    genericName: String(record.generic_name ?? 'Unknown product'),
    companyName: String(record.company_name ?? ''),
    presentation: String(record.presentation ?? ''),
    dosageForm: String(record.dosage_form ?? ''),
    status: String(record.status ?? 'Unknown'),
    details: String(record.related_info ?? '').slice(0, 1600),
    updateDate: String(record.update_date ?? ''),
    rxcui: String(record.openfda?.rxcui?.[0] ?? ''),
  };
}

/** Download every page with `fetchPage`, refuse partial feeds, dedupe by key. */
export function collectFda(fetchPage: (skip: number) => FdaPage): { feedDate: string; rows: FdaRow[] } {
  const first = fetchPage(0);
  const total = Number(first.meta?.results?.total ?? 0);
  const feedDate = String(first.meta?.last_updated ?? '');
  if (!feedDate || total < 1) throw new Error('FDA response lacks a valid update date or record count');
  const records = [...(first.results ?? [])];
  while (records.length < total) {
    const page = fetchPage(records.length);
    if (!page.results?.length) throw new Error('FDA pagination ended before the declared record count');
    records.push(...page.results);
  }
  if (records.length !== total) throw new Error('FDA record count changed during download; retry later');
  const unique = new Map(records.map(r => { const n = normalizeFda(r); return [n.key, n] as const; }));
  return { feedDate, rows: [...unique.values()] };
}
