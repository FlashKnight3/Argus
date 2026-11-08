/** Drug search suggestions: ranked matches while typing, need-based recommendations when empty. */

export interface SearchShortage { key: string; genericName: string; packageNdc: string; status: string; active: boolean; updateDate: string; companyName: string; presentation: string }
export interface SearchItem { key: string; label: string; ndc: string; siteId: number; shortageKey: string }
export interface SearchForecast { risk: string; pStockout: number; inventoryRevision: number }

export type Suggestion =
  | { kind: 'item'; key: string; title: string; detail: string; group: string; risk?: string; itemKey: string }
  | { kind: 'drug'; key: string; title: string; detail: string; group: string; shortageKey: string; current: boolean };

const digits = (v: string) => v.replace(/[^0-9]/g, '');
export const isCurrent = (s: Pick<SearchShortage, 'active' | 'status'>) =>
  s.active && /current|shortage/i.test(s.status) && !/resolved|discontinued/i.test(s.status);

// Dosage forms and salt/hydrate words: shared by unrelated drugs, so they never count as a match.
const STOP = new Set(['injection', 'injectable', 'tablet', 'tablets', 'capsule', 'capsules', 'solution', 'oral', 'usp', 'and', 'for', 'with',
  'sodium', 'potassium', 'calcium', 'magnesium', 'hydrochloride', 'sulfate', 'chloride', 'phosphate', 'acetate', 'citrate', 'tartrate',
  'bitartrate', 'saccharate', 'aspartate', 'maleate', 'mesylate', 'besylate', 'succinate', 'monohydrate', 'dihydrate', 'anhydrous', 'hydrate',
  'extended', 'release', 'delayed', 'suspension', 'powder', 'vial', 'vials', 'premix', 'dextrose', 'water', 'sterile', 'intravenous']);
/** The drug's base name: its first non-salt, non-form word (e.g. "heparin" in "Heparin Sodium Injection"). */
export const baseName = (text: string) => text.toLowerCase().split(/[^a-z]+/).find(t => t.length >= 4 && !STOP.has(t)) ?? '';
export const tokens = (text: string) => new Set(text.toLowerCase().split(/[^a-z]+/).filter(t => t.length >= 4 && !STOP.has(t)));

/** 3 = starts with query, 2 = a word starts with it, 1 = contains, 0 = no match. */
export function score(text: string, query: string): number {
  const t = text.toLowerCase();
  const q = query.toLowerCase().trim();
  if (!q) return 0;
  if (t.startsWith(q)) return 3;
  if (new RegExp(`\\b${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(t)) return 2;
  return t.includes(q) ? 1 : 0;
}

interface Context {
  shortages: readonly SearchShortage[];
  items: readonly SearchItem[];
  forecasts: ReadonlyMap<string, SearchForecast>;
  siteName: (id: number) => string;
  revisionOf: (key: string) => number;
}

/** One suggestion per drug name (FDA lists many packages per drug). */
function drugsByName(shortages: readonly SearchShortage[]) {
  const byName = new Map<string, { rec: SearchShortage; packages: number; current: boolean }>();
  for (const s of shortages) {
    if (!s.active) continue;
    const name = s.genericName.trim();
    const e = byName.get(name.toLowerCase());
    if (e) { e.packages++; e.current ||= isCurrent(s); if (isCurrent(s) && !isCurrent(e.rec)) e.rec = s; }
    else byName.set(name.toLowerCase(), { rec: s, packages: 1, current: isCurrent(s) });
  }
  return [...byName.values()];
}

export function suggest(query: string, ctx: Context, limit = 8): Suggestion[] {
  const q = query.trim();
  const out: Suggestion[] = [];
  const fresh = (i: SearchItem) => { const f = ctx.forecasts.get(i.key); return f && f.inventoryRevision === ctx.revisionOf(i.key) ? f : undefined; };

  if (!q) {
    // Recommended from the network's needs: what's at risk now, then current shortages of drugs you stock.
    const atRisk = ctx.items.filter(i => ['critical', 'watch'].includes(fresh(i)?.risk ?? ''))
      .sort((a, b) => (fresh(b)?.pStockout ?? 0) - (fresh(a)?.pStockout ?? 0)).slice(0, 4);
    for (const i of atRisk) {
      const f = fresh(i)!;
      out.push({ kind: 'item', key: `i:${i.key}`, itemKey: i.key, group: 'Needs attention', risk: f.risk, title: i.label,
        detail: `${ctx.siteName(i.siteId)} · ${Math.round(f.pStockout * 100)}% chance of running out before resupply` });
    }
    const stocked = new Set(ctx.items.map(i => digits(i.ndc)));
    const yourTokens = new Set(ctx.items.flatMap(i => [...tokens(i.label)]));
    const related = drugsByName(ctx.shortages).filter(d => d.current && yourTokens.has(baseName(d.rec.genericName))
      && !stocked.has(digits(d.rec.packageNdc))).slice(0, 4);
    for (const d of related) out.push({ kind: 'drug', key: `d:${d.rec.key}`, shortageKey: d.rec.key, current: true, group: 'Related to what you stock',
      title: d.rec.genericName, detail: `${d.packages} package${d.packages === 1 ? '' : 's'} in FDA shortage` });
    if (out.length < limit) {
      const recent = drugsByName(ctx.shortages).filter(d => d.current && !out.some(o => o.key === `d:${d.rec.key}`))
        .sort((a, b) => b.rec.updateDate.localeCompare(a.rec.updateDate)).slice(0, limit - out.length);
      for (const d of recent) out.push({ kind: 'drug', key: `d:${d.rec.key}`, shortageKey: d.rec.key, current: true, group: 'Recently updated FDA shortages',
        title: d.rec.genericName, detail: `Updated ${d.rec.updateDate || 'recently'} · ${d.packages} package${d.packages === 1 ? '' : 's'}` });
    }
    return out.slice(0, limit);
  }

  const qd = digits(q);
  const items = ctx.items.map(i => ({ i, s: Math.max(score(i.label, q), qd.length >= 4 && digits(i.ndc).includes(qd) ? 3 : 0) }))
    .filter(x => x.s > 0).sort((a, b) => b.s - a.s || a.i.label.localeCompare(b.i.label)).slice(0, 3);
  for (const { i } of items) {
    const f = fresh(i);
    out.push({ kind: 'item', key: `i:${i.key}`, itemKey: i.key, group: 'In your inventory', risk: f?.risk, title: i.label,
      detail: `${ctx.siteName(i.siteId)} · NDC ${i.ndc}${f && f.risk !== 'unknown' ? ` · ${Math.round(f.pStockout * 100)}% stockout risk` : ''}` });
  }
  const drugs = drugsByName(ctx.shortages).map(d => ({ d, s: Math.max(score(d.rec.genericName, q),
    qd.length >= 4 && digits(d.rec.packageNdc).includes(qd) ? 3 : 0) + (d.current ? 0.5 : 0) }))
    .filter(x => x.s >= 1).sort((a, b) => b.s - a.s || a.d.rec.genericName.localeCompare(b.d.rec.genericName));
  for (const { d } of drugs.slice(0, limit - out.length)) out.push({ kind: 'drug', key: `d:${d.rec.key}`, shortageKey: d.rec.key, current: d.current,
    group: 'FDA drug shortages', title: d.rec.genericName, detail: `${d.current ? 'Current shortage' : d.rec.status} · ${d.packages} package${d.packages === 1 ? '' : 's'}` });
  return out;
}
