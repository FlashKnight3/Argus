import { useMemo, useState } from 'react';
import { ExternalLink, Plus, RefreshCw } from 'lucide-react';
import { isCurrentShortage, ndcDigits, syncFda } from './fda';
import { DrugSearch } from './DrugSearch';
import { Empty, PageHead, Pill, Tabs, date, errorText, number } from './ui';
import type { Notify } from './App';
import type { Shortage, SupplyActions, SupplyState } from './useSupply';

export function FdaPage({ state, actions, notify, track }: {
  state: SupplyState; actions: SupplyActions; notify: Notify; track: (row: Shortage) => void;
}) {
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<'current' | 'all'>('current');
  const [limit, setLimit] = useState(50);
  const [selectedKey, setSelectedKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const current = state.shortages.filter(isCurrentShortage);
  const rows = useMemo(() => state.shortages.filter(r => r.active && (tab === 'all' || isCurrentShortage(r))
    && `${r.genericName} ${r.presentation} ${r.companyName} ${r.packageNdc}`.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => a.genericName.localeCompare(b.genericName)), [state.shortages, tab, query]);
  const selected = state.shortages.find(r => r.key === selectedKey);
  const linked = selected ? state.inventory.filter(i => i.shortageKey === selected.key) : [];
  const sync = async () => {
    setBusy(true);
    try { const n = await syncFda(actions, setProgress); notify(`Imported ${number(n)} FDA records.`); }
    catch (e) { notify(errorText(e), true); setProgress('Sync failed. Existing data is still available.'); }
    finally { setBusy(false); }
  };

  return <>
    <PageHead title="FDA watch" subtitle={state.sync?.status === 'complete' ? `National drug shortage list from the FDA, updated ${state.sync.feedDate}. ${number(state.sync.recordCount)} package records.` : 'National drug shortage list from the FDA.'}
      right={state.me?.role === 'admin' && <button className="button ghost" disabled={busy} onClick={sync}><RefreshCw size={15} className={busy ? 'spin' : ''}/> {busy ? 'Syncing…' : 'Refresh now'}</button>} />
    <Tabs value={tab} onChange={t => { setTab(t); setLimit(50); }} tabs={[{ id: 'current', label: 'Current shortages', count: current.length }, { id: 'all', label: 'All notices' }]} />
    {progress && busy && <div className="notice"><RefreshCw size={15} className="spin"/><span>{progress}</span></div>}
    <div className="toolbar"><DrugSearch state={state} value={query} onChange={v => { setQuery(v); setLimit(50); }} placeholder="Search a drug, company, or NDC…"
      onPick={s => { if (s.kind === 'drug') { setSelectedKey(s.shortageKey); setQuery(s.title); } else { const it = state.inventory.find(i => i.key === s.itemKey); setQuery(it?.label.split(/[ ,]/)[0] ?? s.title); } }} /></div>
    <div className="split">
      <div>{rows.length ? <><div className="table-wrap"><table className="table"><thead><tr><th>Drug</th><th>Package NDC</th><th>Company</th><th>Status</th></tr></thead><tbody>
        {rows.slice(0, limit).map(r => <tr key={r.key} className={`clickable ${selectedKey === r.key ? 'selected' : ''}`} onClick={() => setSelectedKey(r.key)}>
          <td><strong title={r.genericName}>{r.genericName}</strong><small>{r.presentation || r.dosageForm}</small></td><td className="mono">{r.packageNdc || '—'}</td><td><small style={{ color: 'var(--text-2)' }}>{r.companyName}</small></td>
          <td><Pill tone={isCurrentShortage(r) ? 'watch' : 'neutral'}>{r.status}</Pill></td></tr>)}
      </tbody></table></div>
        {limit < rows.length && <div style={{ textAlign: 'center', marginTop: 14 }}><button className="button ghost small" onClick={() => setLimit(l => l + 50)}>Show more ({rows.length - limit} left)</button></div>}</>
        : <div className="card"><Empty title={state.shortages.length ? 'No matches' : 'Not imported yet'} detail={state.shortages.length ? 'Try a broader search or All notices.' : 'Activate the workers (Home) to import the FDA feed.'} /></div>}</div>
      <div className="drawer">{selected ? <>
        <div className="inline" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}><div><h3>{selected.genericName}</h3><div className="drawer-sub">{selected.companyName}</div></div><Pill tone={isCurrentShortage(selected) ? 'watch' : 'neutral'}>{selected.status}</Pill></div>
        <div className="kv"><div><span>Package NDC</span><b className="mono">{selected.packageNdc || '—'}</b></div><div><span>RxCUI</span><b>{selected.rxcui || '—'}</b></div><div><span>Updated</span><b>{selected.updateDate || '—'}</b></div></div>
        <div className="block"><h4>Presentation</h4><p className="help">{selected.presentation || 'Not specified'}</p></div>
        <div className="block"><h4>FDA notes</h4><p className="help">{selected.details || 'No additional notes.'}</p></div>
        <div className="block"><h4>Your stock of this package</h4>{linked.length ? linked.map(i => <p key={i.key} className="help">{i.label}: {number(i.onHand - i.reserved)} {i.unit} available</p>) : <p className="help">None of your sites track this package.</p>}</div>
        <div className="inline" style={{ marginTop: 16 }}>{state.me?.role !== 'viewer' && ndcDigits(selected.packageNdc).length >= 10 && ndcDigits(selected.packageNdc).length <= 11 &&
          <button className="button primary" onClick={() => track(selected)}><Plus size={15}/> Track at a site</button>}
          <a className="button ghost" href="https://www.accessdata.fda.gov/scripts/drugshortages/default.cfm" target="_blank" rel="noreferrer">FDA database <ExternalLink size={14}/></a></div>
        <p className="help" style={{ marginTop: 14 }}>FDA notices are a national supply signal, not your stock, and not a basis for treatment decisions. Last imported {date(state.sync?.completedAt)}.</p>
      </> : <Empty title="Select a drug" detail="See its status, package code, FDA notes, and whether your sites stock it." />}</div>
    </div>
  </>;
}
