/** openFDA drug shortage feed: full download, validation, stable normalization. */
import { createHash } from 'node:crypto';

export const FDA_URL = 'https://api.fda.gov/drug/shortages.json';

export interface RawFdaRecord {
  package_ndc?: string; generic_name?: string; company_name?: string; presentation?: string;
  dosage_form?: string; status?: string; related_info?: string; update_date?: string;
  openfda?: { rxcui?: string[] };
}
interface FdaPage { meta?: { last_updated?: string; results?: { total?: number } }; results?: RawFdaRecord[] }

export interface FdaRow {
  key: string; packageNdc: string; genericName: string; companyName: string; presentation: string;
  dosageForm: string; status: string; details: string; updateDate: string; rxcui: string;
}

/** Stable key: identical to the browser importer, so replays update the same row. */
export function normalizeFda(record: RawFdaRecord): FdaRow {
  const source = [record.package_ndc, record.generic_name, record.company_name, record.presentation]
    .map(v => String(v ?? '').trim().toLowerCase()).join('|');
  return {
    key: createHash('sha256').update(source).digest('hex').slice(0, 24),
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

type Fetcher = (url: string) => Promise<FdaPage>;

async function defaultFetcher(url: string): Promise<FdaPage> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const response = await fetch(url, { headers: { 'User-Agent': 'argus-supply/2.0 (operations research)' }, signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json() as FdaPage;
    } catch (error) {
      lastError = error;
      await new Promise(r => setTimeout(r, 2 ** attempt * 1000));
    }
  }
  throw new Error(`FDA feed fetch failed: ${String(lastError)}`);
}

/** Never import a partial feed: download every page, check the declared total, then dedupe. */
export async function fetchFda(fetcher: Fetcher = defaultFetcher): Promise<{ feedDate: string; rows: FdaRow[] }> {
  const first = await fetcher(`${FDA_URL}?limit=1000&skip=0`);
  const total = Number(first.meta?.results?.total ?? 0);
  const feedDate = String(first.meta?.last_updated ?? '');
  if (!feedDate || total < 1) throw new Error('FDA response lacks a valid update date or record count');
  const records = [...(first.results ?? [])];
  while (records.length < total) {
    const page = await fetcher(`${FDA_URL}?limit=1000&skip=${records.length}`);
    if (!page.results?.length) throw new Error('FDA pagination ended before the declared record count');
    records.push(...page.results);
  }
  if (records.length !== total) throw new Error('FDA pagination count changed during download; retry later');
  const unique = new Map(records.map(r => { const n = normalizeFda(r); return [n.key, n] as const; }));
  return { feedDate, rows: [...unique.values()] };
}
