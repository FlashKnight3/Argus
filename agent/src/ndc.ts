/** NDC normalization and FDA-notice matching. */

export const digits = (value: string) => value.replace(/[^0-9]/g, '');

/** FDA package NDCs carry hyphens, so they convert unambiguously to the 11-digit 5-4-2 form. */
export function fdaTo11(packageNdc: string): string | null {
  const parts = packageNdc.trim().split('-');
  if (parts.length === 3 && parts.every(p => /^\d+$/.test(p))) {
    const [a, b, c] = parts;
    if (a.length > 5 || b.length > 4 || c.length > 2) return null;
    return a.padStart(5, '0') + b.padStart(4, '0') + c.padStart(2, '0');
  }
  const d = digits(packageNdc);
  return d.length === 11 ? d : null;
}

/** Locally stored NDCs keep digits only; a 10-digit code maps to one of three 11-digit layouts. */
export function localCandidates11(code: string): string[] {
  const d = digits(code);
  if (d.length === 11) return [d];
  if (d.length !== 10) return [];
  return [`0${d}`, `${d.slice(0, 5)}0${d.slice(5)}`, `${d.slice(0, 9)}0${d.slice(9)}`];
}

const STOP = new Set(['injection', 'injectable', 'tablet', 'tablets', 'capsule', 'capsules', 'solution', 'oral', 'usp',
  'vial', 'vials', 'single', 'dose', 'multi', 'and', 'for', 'with', 'sodium', 'hydrochloride', 'hcl', 'extended', 'release',
  'suspension', 'powder', 'intravenous', 'sterile', 'water', 'chloride', 'sulfate', 'acetate', 'unit', 'units']);

export function nameTokens(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z]+/).filter(t => t.length >= 4 && !STOP.has(t)));
}

export interface ShortageLike { key: string; packageNdc: string; genericName: string; presentation: string; status: string; active: boolean }
export interface MatchCandidate { shortageKey: string; confidence: number; rationale: string }

export function isCurrent(row: Pick<ShortageLike, 'active' | 'status'>): boolean {
  return row.active && /current|shortage/i.test(row.status) && !/resolved|discontinued/i.test(row.status);
}

/** Ranked candidate FDA records for a local item, strongest evidence first. */
export function matchCandidates(item: { ndc: string; label: string }, shortages: readonly ShortageLike[], limit = 3): MatchCandidate[] {
  const local = new Set(localCandidates11(item.ndc));
  const localProducts = new Set([...local].map(c => c.slice(0, 9)));
  const labelTokens = nameTokens(item.label);
  const out: MatchCandidate[] = [];
  for (const s of shortages) {
    if (!s.active) continue;
    const f11 = fdaTo11(s.packageNdc);
    const current = isCurrent(s);
    const status = current ? 'current shortage' : s.status.toLowerCase();
    if (f11 && local.has(f11)) {
      out.push({ shortageKey: s.key, confidence: current ? 0.97 : 0.9, rationale: `Exact package NDC ${s.packageNdc} (${status}).` });
      continue;
    }
    if (f11 && localProducts.has(f11.slice(0, 9))) {
      out.push({ shortageKey: s.key, confidence: current ? 0.75 : 0.65,
        rationale: `Same labeler and product code as FDA ${s.packageNdc}, different package size (${status}). Confirm the package is equivalent.` });
      continue;
    }
    const generic = nameTokens(s.genericName);
    if (!generic.size || !labelTokens.size) continue;
    let hit = 0;
    for (const t of generic) if (labelTokens.has(t)) hit++;
    const share = hit / generic.size;
    if (share >= 0.99) out.push({ shortageKey: s.key, confidence: current ? 0.5 : 0.4,
      rationale: `Product name matches “${s.genericName}” but the NDC differs (${status}). A pharmacist must confirm equivalence.` });
  }
  return out.sort((a, b) => b.confidence - a.confidence).slice(0, limit);
}
