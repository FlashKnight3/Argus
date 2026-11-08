import { useEffect, useMemo, useState } from 'react';
import { ArrowDownRight, ArrowUpRight, Check, Download, Plus, Upload } from 'lucide-react';
import { ndcDigits, shortageForNdc, isCurrentShortage } from './fda';
import { DrugSearch } from './DrugSearch';
import { mapRows, parseCsv, TEMPLATE, type ImportRow } from './csv';
import { Empty, Modal, PageHead, Pill, Section, Tabs, canManage, date, errorText, number, percent, riskLabel, riskTone, siteName } from './ui';
import { newOpId, type OfflineQueue } from './offline';
import type { Notify, Prefill } from './App';
import type { Inventory, SupplyActions, SupplyState } from './useSupply';

type Tab = 'stock' | 'usage' | 'import';
type Draft = { siteId: number; ndc: string; label: string; unit: string; onHand: string; baselineDaily: string;
  safetyStock: string; leadTimeDays: string; shortageKey: string; expectedRevision: number };
const blank = (siteId: number): Draft => ({ siteId, ndc: '', label: '', unit: 'units', onHand: '', baselineDaily: '', safetyStock: '0', leadTimeDays: '7', shortageKey: '', expectedRevision: 0 });

export function InventoryPage({ state, actions, queue, visible, siteFilter, prefill, clearPrefill, notify }: {
  state: SupplyState; actions: SupplyActions; queue: OfflineQueue; visible: Inventory[]; siteFilter: number;
  prefill: Prefill; clearPrefill: () => void; notify: Notify;
}) {
  const homeSite = state.me?.role === 'admin' ? (siteFilter || state.sites[0]?.id || 0) : (state.me?.siteId || 0);
  const editable = state.me?.role === 'admin' || state.me?.role === 'manager';
  const [tab, setTab] = useState<Tab>('stock');
  const [query, setQuery] = useState('');
  const [selectedKey, setSelectedKey] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);

  useEffect(() => {
    if (prefill) { setDraft({ ...blank(homeSite), ndc: prefill.ndc, label: prefill.label, shortageKey: prefill.shortageKey }); clearPrefill(); }
  }, [prefill, homeSite, clearPrefill]);

  const fresh = (item: Inventory) => { const f = state.forecasts.get(item.key); return f?.inventoryRevision === item.revision ? f : undefined; };
  const rows = useMemo(() => visible.filter(item => `${item.label} ${item.ndc} ${siteName(state.sites, item.siteId)}`.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => (fresh(b)?.pStockout ?? -1) - (fresh(a)?.pStockout ?? -1)), [visible, query, state.sites, state.forecasts]); // eslint-disable-line react-hooks/exhaustive-deps
  const selected = state.inventory.find(item => item.key === selectedKey);

  return <>
    <PageHead title="Inventory" subtitle="Counts entered by your team, with a forecast of when each product runs out."
      right={editable && <button className="fab" title="Add product" onClick={() => setDraft(blank(homeSite))}><Plus size={20}/></button>} />
    <Tabs value={tab} onChange={setTab} tabs={[{ id: 'stock', label: 'Stock', count: visible.length }, ...(editable ? [{ id: 'usage' as const, label: 'Record usage' }, { id: 'import' as const, label: 'Import CSV' }] : [])]} />

    {tab === 'stock' && <>
      <div className="toolbar"><DrugSearch state={state} value={query} onChange={setQuery} placeholder="Search your stock or any FDA shortage drug…"
        onPick={s => {
          if (s.kind === 'item') { setSelectedKey(s.itemKey); setQuery(''); }
          else { const rec = state.shortages.find(r => r.key === s.shortageKey);
            if (rec && editable) setDraft({ ...blank(homeSite), ndc: rec.packageNdc, label: rec.genericName, shortageKey: rec.key });
            else setQuery(s.title); }
        }} /></div>
      <div className="split">
        <div>{rows.length ? <div className="table-wrap"><table className="table"><thead><tr><th>Product</th><th>Site</th><th className="num">Available</th><th>Runs out</th><th>FDA</th></tr></thead><tbody>
          {rows.map(item => { const f = fresh(item); const shortage = state.shortages.find(r => r.key === item.shortageKey);
            return <tr key={item.key} className={`clickable ${selectedKey === item.key ? 'selected' : ''}`} onClick={() => setSelectedKey(item.key)}>
              <td><strong title={item.label}>{item.label}</strong><small>NDC {item.ndc}</small></td><td>{siteName(state.sites, item.siteId)}</td>
              <td className="num"><strong>{number(item.onHand - item.reserved, 1)}</strong><small>{item.unit}{item.reserved ? ` · ${number(item.reserved)} reserved` : ''}</small></td>
              <td>{f && f.risk !== 'unknown' ? <><Pill tone={riskTone(f.risk)}>{percent(f.pStockout)} risk</Pill><small>~{number(f.daysMedian, 1)} days</small></> : <span className="muted">{f ? 'Needs usage data' : 'Calculating…'}</span>}</td>
              <td>{shortage && isCurrentShortage(shortage) ? <Pill tone="watch">Shortage</Pill> : state.matches.some(m => m.inventoryKey === item.key && m.status === 'pending') ? <Pill tone="info">Match?</Pill> : <span className="muted">—</span>}</td></tr>; })}
        </tbody></table></div> : <div className="card"><Empty title={visible.length ? 'No matches' : 'No products yet'} detail={visible.length ? 'Try a different search.' : 'Add a product with the + button, record a count, or import a CSV.'} /></div>}</div>
        <Detail key={selected?.key ?? 'none'} item={selected} state={state} actions={actions} queue={queue} notify={notify} onEdit={item => setDraft({ siteId: item.siteId, ndc: item.ndc, label: item.label, unit: item.unit,
          onHand: String(item.onHand), baselineDaily: String(item.baselineDaily), safetyStock: String(item.safetyStock), leadTimeDays: String(item.leadTimeDays), shortageKey: item.shortageKey, expectedRevision: item.revision })} />
      </div>
    </>}
    {tab === 'usage' && <UsageEntry state={state} visible={visible} queue={queue} notify={notify} />}
    {tab === 'import' && <CsvImport state={state} queue={queue} notify={notify} />}
    {draft && <ProductForm state={state} queue={queue} notify={notify} initial={draft} onClose={() => setDraft(null)} />}
  </>;
}

function Detail({ item, state, actions, queue, notify, onEdit }: { item?: Inventory; state: SupplyState; actions: SupplyActions; queue: OfflineQueue; notify: Notify; onEdit: (i: Inventory) => void }) {
  const [kind, setKind] = useState<'use' | 'receive'>('use');
  const [qty, setQty] = useState('');
  const [busy, setBusy] = useState(false);
  if (!item) return <div className="drawer"><Empty title="Select a product" detail="See its forecast, record usage or a delivery, and check its FDA status." /></div>;
  const f = state.forecasts.get(item.key);
  const current = f && f.inventoryRevision === item.revision ? f : undefined;
  const linked = state.shortages.find(r => r.key === item.shortageKey);
  const suggestions = state.matches.filter(m => m.inventoryKey === item.key && m.status === 'pending');
  const manage = canManage(state.me, item.siteId);
  const record = async () => {
    setBusy(true);
    try {
      const out = await queue.submit('recordStock', { opId: newOpId(), inventoryKey: item.key, kind, quantity: Number(qty), note: '' }, `${kind === 'use' ? 'Use' : 'Receive'} ${qty} ${item.unit} of ${item.label}`);
      setQty(''); notify(out === 'queued' ? 'Saved offline; it will sync when you reconnect.' : kind === 'use' ? 'Usage recorded.' : 'Delivery recorded.');
    } catch (e) { notify(errorText(e), true); } finally { setBusy(false); }
  };
  const decide = async (key: string, accept: boolean) => {
    try { await (accept ? actions.acceptMatch({ key }) : actions.dismissMatch({ key })); notify(accept ? 'FDA notice linked.' : 'Suggestion dismissed.'); }
    catch (e) { notify(errorText(e), true); }
  };
  return <div className="drawer">
    <div className="inline" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}><div><h3>{item.label}</h3><div className="drawer-sub">{siteName(state.sites, item.siteId)} · NDC {item.ndc}</div></div>
      {manage && <button className="link" onClick={() => onEdit(item)}>Edit</button>}</div>
    <div className="kv"><div><span>Available</span><b>{number(item.onHand - item.reserved, 1)}</b></div><div><span>Use / day</span><b>{number(current?.ratePerDay ?? item.baselineDaily, 1)}</b></div><div><span>Safety stock</span><b>{number(item.safetyStock)}</b></div></div>
    <div className="block"><h4>Chance of running out before resupply {current && current.risk !== 'unknown' && <Pill tone={riskTone(current.risk)}>{riskLabel(current.risk)}</Pill>}</h4>
      {current && current.risk !== 'unknown' ? <><div className="big-number">{percent(current.pStockout)}<em>within ~{number(current.horizonDays, 1)} days</em></div>
        <div className={`meter ${riskTone(current.risk)}`}><div style={{ width: `${Math.max(3, current.pStockout * 100)}%` }}/></div>
        <p className="help">Lasts about {number(current.daysMedian, 1)} days (worst case {number(current.daysP10, 1)}).{current.fdaAdjusted ? ' Resupply assumed slower because of an active FDA shortage.' : ''}{current.pooled ? ' Usage estimated from other sites stocking this drug.' : ''}</p></>
        : <p className="help">{current ? 'Enter a typical daily use or record usage to get a forecast.' : 'Calculating…'}</p>}</div>
    {manage && <div className="block"><h4>Record</h4>
      <div className="inline"><div className="segmented"><button className={kind === 'use' ? 'active' : ''} onClick={() => setKind('use')}><ArrowUpRight size={14}/> Used</button><button className={kind === 'receive' ? 'active' : ''} onClick={() => setKind('receive')}><ArrowDownRight size={14}/> Received</button></div>
        <input type="number" min="0" step="any" placeholder="Quantity" value={qty} onChange={e => setQty(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && Number(qty) > 0) void record(); }} />
        <button className="button primary" disabled={busy || !(Number(qty) > 0)} onClick={record}>Save</button></div></div>}
    <div className="block"><h4>FDA status</h4>
      {linked ? <p className="help"><Pill tone={isCurrentShortage(linked) ? 'watch' : 'neutral'}>{linked.status}</Pill> {linked.genericName} · {linked.companyName} · updated {linked.updateDate || '—'}</p> : <p className="help">Not linked to an FDA notice.</p>}
      {suggestions.map(m => { const s = state.shortages.find(r => r.key === m.shortageKey);
        return <div className="suggestion" key={m.key}><b>Agent suggests linking:</b> {s ? `${s.genericName} (${s.packageNdc}, ${s.status})` : m.shortageKey} <Pill tone="info">{percent(m.confidence)}</Pill><p>{m.rationale}</p>
          {manage && <div className="inline"><button className="button primary small" onClick={() => decide(m.key, true)}><Check size={14}/> Link</button><button className="button ghost small" onClick={() => decide(m.key, false)}>Dismiss</button></div>}</div>; })}</div>
    <div className="block"><h4>Recent activity</h4><div className="events">{state.stockEvents.filter(e => e.inventoryKey === item.key).slice(0, 6).map(e =>
      <div key={e.id}><span>{e.kind === 'use' ? 'Used' : e.kind === 'receive' ? 'Received' : e.kind === 'set' ? 'Count set' : e.kind === 'ship' ? 'Shipped' : e.kind === 'transfer_receive' ? 'Transfer in' : e.kind}</span>
        <b className={e.delta < 0 ? 'negative' : 'positive'}>{e.delta > 0 ? '+' : ''}{number(e.delta, 1)}</b><small>{date(e.at)}</small></div>)}</div></div>
  </div>;
}

function ProductForm({ state, queue, notify, initial, onClose }: { state: SupplyState; queue: OfflineQueue; notify: Notify; initial: Draft; onClose: () => void }) {
  const [d, setD] = useState<Draft>(initial);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const auto = shortageForNdc(state.shortages, d.ndc);
  const linked = state.shortages.find(r => r.key === (d.shortageKey || auto?.key));
  const valid = d.label.trim() && ndcDigits(d.ndc).length >= 10 && ndcDigits(d.ndc).length <= 11 && d.onHand !== '' && d.siteId;
  const set = (k: keyof Draft) => (e: { target: { value: string } }) => setD(v => ({ ...v, [k]: k === 'siteId' ? Number(e.target.value) : e.target.value }));
  const save = async () => {
    setBusy(true);
    try {
      const out = await queue.submit('upsertInventory', { opId: newOpId(), siteId: d.siteId, packageNdc: d.ndc, label: d.label, unit: d.unit, onHand: Number(d.onHand),
        baselineDaily: Number(d.baselineDaily) || 0, safetyStock: Number(d.safetyStock) || 0, leadTimeDays: Number(d.leadTimeDays) || 7,
        shortageKey: d.shortageKey || auto?.key || '', expectedRevision: d.expectedRevision }, `Save ${d.label}`);
      notify(out === 'queued' ? 'Saved offline; it will sync when you reconnect.' : 'Product saved. The forecast updates in a few seconds.');
      onClose();
    } catch (e) { notify(errorText(e), true); } finally { setBusy(false); }
  };
  return <Modal title={d.expectedRevision ? 'Edit product' : 'Add product'} onClose={onClose}
    subtitle="Search for the drug to fill in its name, NDC, and FDA status, then enter your actual count."
    footer={<><button className="button ghost" onClick={onClose}>Cancel</button><button className="button primary" disabled={busy || !valid} onClick={save}>{busy ? 'Saving…' : 'Save product'}</button></>}>
    {!d.expectedRevision && <div style={{ marginBottom: 16 }}><DrugSearch state={state} value={query} onChange={setQuery} placeholder="Search a drug (suggestions are based on what your network needs)"
      onPick={s => { if (s.kind === 'drug') { const r = state.shortages.find(x => x.key === s.shortageKey); if (r) setD(v => ({ ...v, ndc: r.packageNdc, label: r.genericName, shortageKey: r.key })); }
        else { const it = state.inventory.find(i => i.key === s.itemKey); if (it) setD(v => ({ ...v, ndc: it.ndc, label: it.label, unit: it.unit, shortageKey: it.shortageKey })); }
        setQuery(''); }} /></div>}
    <div className="form-grid">
      <label>Site<select value={d.siteId} onChange={set('siteId')} disabled={state.me?.role !== 'admin' || !!d.expectedRevision}>{state.sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
      <label>Package NDC<input value={d.ndc} onChange={set('ndc')} placeholder="e.g. 0409-4888-10" disabled={!!d.expectedRevision} /></label>
      <label className="full">Product name<input value={d.label} onChange={set('label')} placeholder="Name, strength, and form" /></label>
      <label>On hand<input type="number" min="0" step="any" value={d.onHand} onChange={set('onHand')} /></label>
      <label>Unit<input value={d.unit} onChange={set('unit')} placeholder="vials, tablets…" /></label>
      <label>Typical use per day<input type="number" min="0" step="any" value={d.baselineDaily} onChange={set('baselineDaily')} /></label>
      <label>Safety stock<input type="number" min="0" step="any" value={d.safetyStock} onChange={set('safetyStock')} /></label>
      <label>Normal resupply time (days)<input type="number" min="0.5" step="any" value={d.leadTimeDays} onChange={set('leadTimeDays')} /></label>
      <label>FDA notice<select value={d.shortageKey || auto?.key || ''} onChange={set('shortageKey')}><option value="">Not linked</option>{linked && <option value={linked.key}>{linked.genericName} · {linked.status}</option>}</select></label>
    </div>
    {d.expectedRevision > 0 && <p className="help" style={{ marginTop: 12 }}>If someone else changes this product before you save, you'll be asked to review their change first.</p>}
  </Modal>;
}

function UsageEntry({ state, visible, queue, notify }: { state: SupplyState; visible: Inventory[]; queue: OfflineQueue; notify: Notify }) {
  const [site, setSite] = useState(state.me?.role === 'admin' ? state.sites[0]?.id ?? 0 : state.me?.siteId ?? 0);
  const [used, setUsed] = useState<Record<string, string>>({});
  const [received, setReceived] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const items = visible.filter(i => i.siteId === site);
  const changes = items.flatMap(i => [
    ...(Number(used[i.key]) > 0 ? [{ item: i, kind: 'use' as const, q: Number(used[i.key]) }] : []),
    ...(Number(received[i.key]) > 0 ? [{ item: i, kind: 'receive' as const, q: Number(received[i.key]) }] : []),
  ]);
  const saveAll = async () => {
    setBusy(true);
    let ok = 0, queued = 0;
    for (const c of changes) {
      try {
        const out = await queue.submit('recordStock', { opId: newOpId(), inventoryKey: c.item.key, kind: c.kind, quantity: c.q, note: 'Daily entry' }, `${c.kind === 'use' ? 'Use' : 'Receive'} ${c.q} ${c.item.label}`);
        out === 'queued' ? queued++ : ok++;
      } catch (e) { notify(`${c.item.label}: ${errorText(e)}`, true); }
    }
    setUsed({}); setReceived({}); setBusy(false);
    notify(`Recorded ${ok} change${ok === 1 ? '' : 's'}${queued ? `, ${queued} saved offline` : ''}. Forecasts will update.`);
  };
  return <Section title="Record today's usage and deliveries" subtitle="Enter what was used or received for each product, then save everything at once. Real usage makes forecasts much more accurate."
    action={state.me?.role === 'admin' && <select value={site} onChange={e => setSite(Number(e.target.value))}>{state.sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select>}>
    {items.length ? <><div className="table-wrap"><table className="table"><thead><tr><th>Product</th><th className="num">On hand</th><th>Used</th><th>Received</th></tr></thead><tbody>
      {items.map(i => <tr key={i.key}><td><strong title={i.label}>{i.label}</strong><small>NDC {i.ndc}</small></td><td className="num">{number(i.onHand, 1)} <small>{i.unit}</small></td>
        <td><input type="number" min="0" step="any" placeholder="0" value={used[i.key] ?? ''} onChange={e => setUsed(v => ({ ...v, [i.key]: e.target.value }))} /></td>
        <td><input type="number" min="0" step="any" placeholder="0" value={received[i.key] ?? ''} onChange={e => setReceived(v => ({ ...v, [i.key]: e.target.value }))} /></td></tr>)}
    </tbody></table></div>
    <div className="modal-foot"><small>{changes.length} change{changes.length === 1 ? '' : 's'} ready</small><button className="button primary" disabled={busy || !changes.length} onClick={saveAll}>{busy ? 'Saving…' : 'Save all'}</button></div></>
      : <div className="card"><Empty title="No products at this site" detail="Add products first, or import them from a CSV." /></div>}
  </Section>;
}

function CsvImport({ state, queue, notify }: { state: SupplyState; queue: OfflineQueue; notify: Notify }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const parsed = useMemo(() => text.trim() ? mapRows(parseCsv(text), state.sites) : null, [text, state.sites]);
  const good = parsed?.rows.filter(r => !r.errors.length) ?? [];
  const bad = parsed?.rows.filter(r => r.errors.length) ?? [];
  const allowed = (r: ImportRow) => state.me?.role === 'admin' || state.me?.siteId === r.siteId;
  const run = async () => {
    setBusy(true);
    let ok = 0;
    for (const r of good.filter(allowed)) {
      const existing = state.inventory.find(i => i.key === `${r.siteId}:${r.ndc}`);
      try {
        await queue.submit('upsertInventory', { opId: newOpId(), siteId: r.siteId, packageNdc: r.ndc, label: r.product, unit: r.unit, onHand: r.onHand,
          baselineDaily: r.dailyUse, safetyStock: r.safetyStock, leadTimeDays: r.leadTime, shortageKey: existing?.shortageKey || shortageForNdc(state.shortages, r.ndc)?.key || '',
          expectedRevision: existing?.revision ?? 0 }, `Import ${r.product}`);
        ok++;
      } catch (e) { notify(`Line ${r.line}: ${errorText(e)}`, true); }
    }
    setBusy(false); setText('');
    notify(`Imported ${ok} product${ok === 1 ? '' : 's'}. Forecasts will appear in a few seconds.`);
  };
  const onFile = async (file?: File) => { if (file) setText(await file.text()); };
  return <Section title="Import inventory from a CSV" subtitle="Columns: site, ndc, product, unit, on_hand, daily_use, safety_stock, lead_time_days. Sites can be names or IDs. Existing products are updated."
    action={<a className="button ghost small" href={`data:text/csv;charset=utf-8,${encodeURIComponent(TEMPLATE)}`} download="argus-inventory-template.csv"><Download size={14}/> Template</a>}>
    <div className="card">
      <div className="inline" style={{ marginBottom: 12 }}><label className="button ghost small" style={{ flexDirection: 'row', cursor: 'pointer' }}><Upload size={14}/> Choose file<input type="file" accept=".csv,text/csv" hidden onChange={e => onFile(e.target.files?.[0])} /></label><small>or paste below</small></div>
      <textarea rows={6} style={{ width: '100%', fontFamily: 'ui-monospace,Menlo,monospace', fontSize: 12 }} placeholder={TEMPLATE} value={text} onChange={e => setText(e.target.value)} />
    </div>
    {parsed?.missing.length ? <div className="notice amber" style={{ marginTop: 14 }}><span>Missing required column{parsed.missing.length > 1 ? 's' : ''}: {parsed.missing.join(', ')}</span></div> : null}
    {parsed && !parsed.missing.length && <div style={{ marginTop: 18 }}>
      <div className="table-wrap"><table className="table"><thead><tr><th>Line</th><th>Site</th><th>Product</th><th>NDC</th><th className="num">On hand</th><th className="num">Use/day</th><th>Status</th></tr></thead><tbody>
        {parsed.rows.slice(0, 200).map(r => <tr key={r.line}><td className="muted">{r.line}</td><td>{r.siteLabel}</td><td>{r.product}</td><td className="mono">{r.ndc}</td><td className="num">{number(r.onHand)}</td><td className="num">{number(r.dailyUse, 1)}</td>
          <td>{r.errors.length ? <Pill tone="danger">{r.errors[0]}</Pill> : !allowed(r) ? <Pill tone="watch">Not your site</Pill> : state.inventory.some(i => i.key === `${r.siteId}:${r.ndc}`) ? <Pill tone="info">Update</Pill> : <Pill tone="good">New</Pill>}</td></tr>)}
      </tbody></table></div>
      <div className="modal-foot"><small>{good.filter(allowed).length} ready · {bad.length} with errors (skipped)</small><button className="button primary" disabled={busy || !good.filter(allowed).length} onClick={run}>{busy ? 'Importing…' : `Import ${good.filter(allowed).length}`}</button></div>
    </div>}
  </Section>;
}
