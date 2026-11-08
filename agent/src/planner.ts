/** Bounded, deterministic transfer planning across the whole network. */
import { createHash } from 'node:crypto';

/** Every site keeps at least this many days of its own expected demand after giving stock away. */
export const KEEP_DAYS = 21;
/** Destinations are topped up to this many days of expected demand (or their safety stock, if higher). */
export const TARGET_DAYS = 21;

export interface PlanItem {
  key: string;
  siteId: number;
  ndc: string;
  unit: string;
  label: string;
  free: number;
  safetyStock: number;
  /** Posterior mean daily demand (0 when unknown). */
  rate: number;
  risk: string;
  pStockout: number;
  daysP10: number;
  revision: number;
  /** RxCUI of the linked FDA record; items sharing one are equivalent products across package NDCs. */
  rxcui?: string;
}

export interface Draft {
  key: string;
  sourceSiteId: number;
  destSiteId: number;
  ndc: string;
  quantity: number;
  reason: string;
  /** Destination package NDC when it differs from the source's (equivalent product). */
  destNdc?: string;
}

/** Largest quantity a source can give without dropping below safety stock or KEEP_DAYS of cover. */
export function maxGive(source: Pick<PlanItem, 'free' | 'safetyStock' | 'rate' | 'risk'>): number {
  if (source.risk !== 'stable') return 0;
  return Math.max(0, Math.floor(source.free - Math.max(source.safetyStock, source.rate * KEEP_DAYS)));
}

export function needOf(dest: Pick<PlanItem, 'free' | 'safetyStock' | 'rate' | 'risk' | 'pStockout'>): number {
  const atRisk = dest.risk === 'critical' || dest.pStockout >= 0.5;
  if (!atRisk || dest.rate <= 0) return 0;
  return Math.max(0, Math.ceil(Math.max(dest.safetyStock, dest.rate * TARGET_DAYS) - dest.free));
}

/** Same package NDC, or the same drug (RxCUI from the linked FDA record) in a different package. */
export function sameProduct(a: PlanItem, b: PlanItem): 'exact' | 'equivalent' | false {
  if (a.ndc === b.ndc) return 'exact';
  return a.rxcui && a.rxcui === b.rxcui ? 'equivalent' : false;
}

export function draftKey(source: PlanItem, dest: PlanItem, quantity: number): string {
  return createHash('sha256').update(`${source.key}:${source.revision}:${dest.key}:${dest.revision}:${quantity}`).digest('hex').slice(0, 24);
}

/**
 * Greedy multi-source plan: the most urgent destinations first; each takes from the sources with
 * the most spare stock until its gap closes. Source capacity is shared across destinations.
 * `blocked` holds `dest:ndc` routes that already have an open transfer or pending draft.
 */
export function planTransfers(items: readonly PlanItem[], blocked: ReadonlySet<string> = new Set()): Draft[] {
  const capacity = new Map(items.map(i => [i.key, maxGive(i)]));
  const dests = items.filter(i => needOf(i) > 0 && !blocked.has(`${i.siteId}:${i.ndc}`))
    .sort((a, b) => b.pStockout - a.pStockout || a.daysP10 - b.daysP10);
  const drafts: Draft[] = [];
  for (const dest of dests) {
    let need = needOf(dest);
    // Exact-NDC donors first, then equivalent products (same RxCUI); most spare stock first within each.
    const sources = items.filter(s => s.siteId !== dest.siteId && sameProduct(s, dest)
      && s.unit.trim().toLowerCase() === dest.unit.trim().toLowerCase() && (capacity.get(s.key) ?? 0) >= 1)
      .sort((a, b) => (sameProduct(a, dest) === 'exact' ? 0 : 1) - (sameProduct(b, dest) === 'exact' ? 0 : 1)
        || (capacity.get(b.key) ?? 0) - (capacity.get(a.key) ?? 0));
    for (const source of sources) {
      if (need < 1) break;
      const quantity = Math.min(need, capacity.get(source.key) ?? 0);
      if (quantity < 1) continue;
      capacity.set(source.key, (capacity.get(source.key) ?? 0) - quantity);
      need -= quantity;
      const equivalent = source.ndc !== dest.ndc;
      drafts.push({ key: draftKey(source, dest, quantity), sourceSiteId: source.siteId, destSiteId: dest.siteId, ndc: source.ndc, quantity,
        ...(equivalent ? { destNdc: dest.ndc } : {}),
        reason: `Site ${dest.siteId} has ${dest.free} ${dest.unit} free, ${Math.round(dest.pStockout * 100)}% stockout risk before resupply `
          + `(p10 ${dest.daysP10} days). Site ${source.siteId} keeps ≥${KEEP_DAYS} days of its own demand after sending ${quantity}. `
          + (equivalent ? `Equivalent product: NDC ${source.ndc} (same RxCUI ${source.rxcui}) for ${dest.ndc}; a pharmacist must confirm the substitution. ` : '')
          + 'Draft only; both managers must act.' });
    }
  }
  return drafts;
}
