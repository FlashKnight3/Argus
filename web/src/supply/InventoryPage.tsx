import { useEffect, useMemo, useState } from 'react';
import { ArrowDownRight, ArrowUpRight, Plus, Search, X } from 'lucide-react';
import { ndcDigits, shortageForNdc, isCurrentShortage } from './fda';
import { Empty, Panel, Pill, canManage, date, errorText, number, riskTone, siteName } from './ui';
import type { Notify } from './App';
import type { Inventory, SupplyActions, SupplyState } from './useSupply';

type Draft = { siteId: number; ndc: string; label: string; unit: string; onHand: string;
  baselineDaily: string; safetyStock: string; shortageKey: string };
const blank = (siteId: number): Draft => ({ siteId, ndc: '', label: '', unit: 'units', onHand: '', baselineDaily: '', safetyStock: '0', shortageKey: '' });

export function InventoryPage({ state, actions, visible, siteFilter, prefill, clearPrefill, notify }: {
  state: SupplyState; actions: SupplyActions; visible: Inventory[]; siteFilter: number;
  prefill: { ndc: string; label: string; shortageKey: string } | null; clearPrefill: () => void; notify: Notify;
}) {
  const initialSite = state.me?.role === 'admin' ? (siteFilter || state.sites[0]?.id || 0) : (state.me?.siteId || 0);
  const [search, setSearch] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [draft, setDraft] = useState<Draft>(() => blank(initialSite));
  const [selectedKey, setSelectedKey] = useState('');
  const [stockKind, setStockKind] = useState<'receive' | 'use'>('receive');
  const [stockQty, setStockQty] = useState('');
  const [stockNote, setStockNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [matchSearch, setMatchSearch] = useState('');

  useEffect(() => {
    if (prefill) {
      setDraft({ ...blank(initialSite), ndc: prefill.ndc, label: prefill.label, shortageKey: prefill.shortageKey });
      setShowForm(true);
      clearPrefill();
    }
  }, [prefill, initialSite, clearPrefill]);

  const rows = useMemo(() => visible.filter(item =>
    `${item.label} ${item.ndc} ${siteName(state.sites, item.siteId)}`.toLowerCase().includes(search.toLowerCase())),
    [visible, search, state.sites]);
  const selected = state.inventory.find(item => item.key === selectedKey);
  const selectedForecast = selected ? state.forecasts.get(selected.key) : undefined;
  const matches = state.shortages.filter(row => row.active &&
    `${row.genericName} ${row.packageNdc} ${row.presentation}`.toLowerCase().includes(matchSearch.toLowerCase())).slice(0, 12);
  const auto = shortageForNdc(state.shortages, draft.ndc);
  const linked = selected ? state.shortages.find(row => row.key === selected.shortageKey) : undefined;

  const edit = (item: Inventory) => {
    setDraft({ siteId: item.siteId, ndc: item.ndc, label: item.label, unit: item.unit,
      onHand: String(item.onHand), baselineDaily: String(item.baselineDaily), safetyStock: String(item.safetyStock), shortageKey: item.shortageKey });
    setShowForm(true);
  };
  const save = async () => {
    setBusy(true);
    try {
      await actions.upsertInventory({ siteId: draft.siteId, packageNdc: draft.ndc, label: draft.label,
        unit: draft.unit, onHand: Number(draft.onHand), baselineDaily: Number(draft.baselineDaily),
        safetyStock: Number(draft.safetyStock), shortageKey: draft.shortageKey || auto?.key || '' });
      setShowForm(false);
      setDraft(blank(initialSite));
      notify('Inventory saved. The forecast worker will recompute this product.');
    } catch (error) { notify(errorText(error), true); }
    finally { setBusy(false); }
  };
  const record = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      await actions.recordStock({ inventoryKey: selected.key, kind: stockKind, quantity: Number(stockQty), note: stockNote });
      setStockQty(''); setStockNote(''); notify('Stock movement recorded.');
    } catch (error) { notify(errorText(error), true); }
    finally { setBusy(false); }
  };

  return <div className="page-stack">
    <div className="page-intro"><div><div className="eyebrow">STOCK LEDGER / SOURCE OF TRUTH</div><h1>Inventory</h1><p>Enter actual counts, record usage and receipts, and see the provenance of any FDA match.</p></div>
      {state.me?.role !== 'viewer' && <button className="button primary" onClick={() => { setDraft(blank(initialSite)); setShowForm(true); }}><Plus size={16}/> Add product</button>}
    </div>
    <div className="notice-strip"><span className="notice-icon">i</span> These quantities are entered by your team. FDA notices are external supply signals; they are not proof of local stock.</div>
    <div className="inventory-layout"><Panel title={`${number(rows.length)} tracked products`} eyebrow="LIVE SITE COUNTS" action={<div className="search-box"><Search size={16}/><input aria-label="Search inventory" placeholder="Search product or NDC" value={search} onChange={event => setSearch(event.target.value)}/></div>}>
      {rows.length ? <div className="table-scroll"><table className="data-table"><thead><tr><th>Product</th><th>Site</th><th>Available</th><th>Forecast</th><th>Signal</th></tr></thead><tbody>
        {rows.map(item => { const f = state.forecasts.get(item.key); const shortage = state.shortages.find(row => row.key === item.shortageKey);
          return <tr key={item.key} className={selectedKey === item.key ? 'selected' : ''} onClick={() => setSelectedKey(item.key)}><td><strong>{item.label}</strong><small>NDC {item.ndc}</small></td><td>{siteName(state.sites, item.siteId)}</td><td><strong>{number(item.onHand - item.reserved, 1)}</strong><small>{item.reserved ? `${number(item.reserved, 1)} reserved · ` : ''}{item.unit}</small></td><td>{f && f.inventoryRevision === item.revision && f.risk !== 'unknown' ? <><strong>{number(f.daysMedian, 1)} days</strong><small>{number(f.daysP10, 1)}–{number(f.daysP90, 1)} range</small></> : <span className="muted">Awaiting data</span>}</td><td>{shortage && isCurrentShortage(shortage) ? <Pill tone="watch">FDA matched</Pill> : <Pill>None linked</Pill>}</td></tr>;
        })}
      </tbody></table></div> : <Empty title="Your ledger is empty" detail="Add a product with an NDC and a real on-hand count. No sample stock is preloaded." />}
    </Panel>
    <Panel title={selected ? selected.label : 'Product detail'} eyebrow="INSPECT & RECORD">
      {!selected ? <Empty title="Select a product" detail="Choose a row to see forecast inputs, movements, and a linked FDA notice." /> : <div className="detail-stack">
        <div className="detail-top"><div><small>NDC {selected.ndc} · {siteName(state.sites, selected.siteId)}</small><strong>{number(selected.onHand - selected.reserved, 1)} <em>{selected.unit} available</em></strong></div>{canManage(state.me, selected.siteId) && <button className="button ghost small" onClick={() => edit(selected)}>Edit count & settings</button>}</div>
        <div className="mini-grid"><div><span>On hand</span><b>{number(selected.onHand, 1)}</b></div><div><span>Reserved</span><b>{number(selected.reserved, 1)}</b></div><div><span>Daily baseline</span><b>{number(selected.baselineDaily, 2)}</b></div><div><span>Safety stock</span><b>{number(selected.safetyStock, 1)}</b></div></div>
        <div className="detail-section"><div className="section-row"><strong>Runout estimate</strong><Pill tone={riskTone(selectedForecast?.risk ?? '')}>{selectedForecast?.risk ?? 'pending'}</Pill></div>
          {selectedForecast && selectedForecast.inventoryRevision === selected.revision ? <><div className="forecast-large">{selectedForecast.risk === 'unknown' ? 'Not enough usage data' : `${number(selectedForecast.daysMedian, 1)} days`}</div><p>{selectedForecast.explanation}</p><small>Computed {date(selectedForecast.computedAt)} · inventory revision {selectedForecast.inventoryRevision}</small></> : <p>Inventory changed. Waiting for a fresh forecast.</p>}
        </div>
        <div className="detail-section"><div className="section-row"><strong>FDA signal</strong>{linked && <Pill tone={isCurrentShortage(linked) ? 'watch' : 'neutral'}>{linked.status}</Pill>}</div>{linked ? <p>{linked.presentation || linked.genericName}<br/><span className="muted">Updated {linked.updateDate || 'date unavailable'} · {linked.companyName}</span></p> : <p>No confirmed FDA notice is linked to this item.</p>}</div>
        {canManage(state.me, selected.siteId) && <div className="detail-section"><strong>Record stock movement</strong><div className="segmented"><button className={stockKind === 'receive' ? 'active' : ''} onClick={() => setStockKind('receive')}><ArrowDownRight size={15}/> Receive</button><button className={stockKind === 'use' ? 'active' : ''} onClick={() => setStockKind('use')}><ArrowUpRight size={15}/> Use</button></div><div className="inline-fields"><input type="number" min="0" step="any" placeholder="Quantity" value={stockQty} onChange={event => setStockQty(event.target.value)}/><input placeholder="Optional note" value={stockNote} onChange={event => setStockNote(event.target.value)}/><button className="button primary" onClick={record} disabled={busy || !(Number(stockQty) > 0)}>Record</button></div></div>}
        <div className="detail-section"><strong>Recent movements</strong><div className="event-list">{state.stockEvents.filter(row => row.inventoryKey === selected.key).slice(0, 5).map(row => <div key={row.id}><span>{row.kind.replace('_', ' ')}</span><b className={row.delta < 0 ? 'negative' : 'positive'}>{row.delta > 0 ? '+' : ''}{number(row.delta, 1)}</b><small>{date(row.at)}</small></div>)}</div></div>
      </div>}
    </Panel></div>

    {showForm && <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setShowForm(false); }}><div className="modal"><div className="modal-head"><div><div className="eyebrow">REAL INVENTORY INPUT</div><h2>Track a product</h2></div><button className="icon-button" onClick={() => setShowForm(false)} aria-label="Close"><X size={18}/></button></div>
      <div className="form-grid"><label>Site<select value={draft.siteId} onChange={event => setDraft(d => ({ ...d, siteId: Number(event.target.value) }))} disabled={state.me?.role !== 'admin'}>{state.sites.map(site => <option key={site.id} value={site.id}>{site.name}</option>)}</select></label><label>Package NDC<input value={draft.ndc} onChange={event => setDraft(d => ({ ...d, ndc: event.target.value }))} placeholder="e.g. 0228-2551-06"/></label><label className="full">Product label<input value={draft.label} onChange={event => setDraft(d => ({ ...d, label: event.target.value }))} placeholder="Name, strength, and form"/></label><label>On hand<input type="number" min="0" step="any" value={draft.onHand} onChange={event => setDraft(d => ({ ...d, onHand: event.target.value }))}/></label><label>Unit<input value={draft.unit} onChange={event => setDraft(d => ({ ...d, unit: event.target.value }))} placeholder="vials, tablets, etc."/></label><label>Typical use / day<input type="number" min="0" step="any" value={draft.baselineDaily} onChange={event => setDraft(d => ({ ...d, baselineDaily: event.target.value }))}/></label><label>Safety stock<input type="number" min="0" step="any" value={draft.safetyStock} onChange={event => setDraft(d => ({ ...d, safetyStock: event.target.value }))}/></label></div>
      <div className="form-divider"><strong>Link an FDA notice</strong><small>{auto ? `Exact package NDC match: ${auto.genericName}` : 'Search or leave unlinked.'}</small></div>
      <input className="full-input" placeholder="Search FDA drug or NDC" value={matchSearch} onChange={event => setMatchSearch(event.target.value)}/>
      <select className="full-input" value={draft.shortageKey || auto?.key || ''} onChange={event => setDraft(d => ({ ...d, shortageKey: event.target.value }))}><option value="">No confirmed match</option>{(matchSearch ? matches : auto ? [auto] : []).map(row => <option key={row.key} value={row.key}>{row.genericName} · {row.packageNdc} · {row.status}</option>)}</select>
      <div className="modal-foot"><small>Counts and daily use are entered by your team; this app does not infer local stock from FDA data.</small><button className="button primary" onClick={save} disabled={busy || !draft.label.trim() || ndcDigits(draft.ndc).length < 10 || ndcDigits(draft.ndc).length > 11 || !draft.onHand}>{busy ? 'Saving…' : 'Save product'}</button></div>
    </div></div>}
  </div>;
}
