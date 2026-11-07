import type { SupplyActions, Shortage } from './useSupply';

const ENDPOINT = 'https://api.fda.gov/drug/shortages.json';

type RawRow = {
  package_ndc?: string;
  generic_name?: string;
  company_name?: string;
  presentation?: string;
  dosage_form?: string;
  status?: string;
  related_info?: string;
  update_date?: string;
  openfda?: { rxcui?: string[] };
};

type Response = {
  meta: { last_updated: string; results: { total: number } };
  results: RawRow[];
};

export const ndcDigits = (value: string) => value.replace(/[^0-9]/g, '');

export function isCurrentShortage(row: Pick<Shortage, 'active' | 'status'>): boolean {
  return row.active && /current|shortage/i.test(row.status) && !/resolved|discontinued/i.test(row.status);
}

async function sourceKey(row: RawRow): Promise<string> {
  const source = [row.package_ndc, row.generic_name, row.company_name, row.presentation]
    .map(value => String(value ?? '').trim().toLowerCase()).join('|');
  const bytes = new TextEncoder().encode(source);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), n => n.toString(16).padStart(2, '0')).join('').slice(0, 24);
}

async function normalize(row: RawRow) {
  return {
    key: await sourceKey(row),
    packageNdc: String(row.package_ndc ?? ''),
    genericName: String(row.generic_name ?? 'Unknown product'),
    companyName: String(row.company_name ?? ''),
    presentation: String(row.presentation ?? ''),
    dosageForm: String(row.dosage_form ?? ''),
    status: String(row.status ?? 'Unknown'),
    details: String(row.related_info ?? '').slice(0, 1600),
    updateDate: String(row.update_date ?? ''),
    rxcui: String(row.openfda?.rxcui?.[0] ?? ''),
  };
}

async function page(skip: number): Promise<Response> {
  const response = await fetch(`${ENDPOINT}?limit=1000&skip=${skip}`);
  if (!response.ok) throw new Error(`FDA API returned HTTP ${response.status}`);
  return response.json() as Promise<Response>;
}

/** Download fully before changing SpacetimeDB, then import in bounded batches. */
export async function syncFda(actions: SupplyActions, progress: (message: string) => void): Promise<number> {
  progress('Downloading the FDA feed…');
  const first = await page(0);
  const total = first.meta?.results?.total ?? 0;
  const feedDate = first.meta?.last_updated ?? '';
  if (!total || !feedDate) throw new Error('FDA response is missing a record count or update date.');
  const raw = [...first.results];
  while (raw.length < total) {
    const next = await page(raw.length);
    if (!next.results.length) throw new Error('FDA feed ended before the declared record count.');
    raw.push(...next.results);
    progress(`Downloaded ${raw.length} of ${total} FDA records…`);
  }
  if (raw.length !== total) throw new Error('FDA feed changed during download. Retry the sync.');
  progress('Matching and preparing source records…');
  const rows = await Promise.all(raw.map(normalize));
  const unique = [...new Map(rows.map(row => [row.key, row])).values()];
  const runId = `${new Date().toISOString()}-browser`;
  await actions.beginFdaSync({ runId });
  for (let i = 0; i < unique.length; i += 100) {
    await actions.importFdaBatch({ runId, rowsJson: JSON.stringify(unique.slice(i, i + 100)) });
    progress(`Imported ${Math.min(i + 100, unique.length)} of ${unique.length} records…`);
  }
  await actions.finishFdaSync({ runId, feedDate });
  progress(`FDA feed current through ${feedDate}.`);
  return unique.length;
}

export function shortageForNdc(shortages: readonly Shortage[], code: string): Shortage | undefined {
  const digits = ndcDigits(code);
  return shortages.find(row => row.active && ndcDigits(row.packageNdc) === digits);
}
