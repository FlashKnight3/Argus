import { useMemo, useState } from 'react';
import { ExternalLink, Plus, RefreshCw, Search } from 'lucide-react';
import { isCurrentShortage, ndcDigits, syncFda } from './fda';
import { Empty, Panel, Pill, date, errorText, number } from './ui';
import type { Notify } from './App';
import type { Shortage, SupplyActions, SupplyState } from './useSupply';

export function FdaPage({ state, actions, notify, track }: {
  state: SupplyState; actions: SupplyActions; notify: Notify; track: (row: Shortage) => void;
}) {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'current' | 'all'>('current');
  const [limit, setLimit] = useState(40);
  const [selectedKey, setSelectedKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const rows = useMemo(() => state.shortages.filter(row => row.active &&
    (filter === 'all' || isCurrentShortage(row)) &&
    `${row.genericName} ${row.presentation} ${row.companyName} ${row.packageNdc}`.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => a.genericName.localeCompare(b.genericName)), [state.shortages, filter, search]);
  const selected = state.shortages.find(row => row.key === selectedKey);
  const linked = selected ? state.inventory.filter(item => item.shortageKey === selected.key) : [];
  const sync = async () => {
    setBusy(true);
    try { const count = await syncFda(actions, setProgress); notify(`Imported ${number(count)} FDA records.`); }
    catch (error) { notify(errorText(error), true); setProgress('Sync failed. Existing completed data remains available.'); }
    finally { setBusy(false); }
  };

  return <div className="page-stack"><div className="page-intro"><div><div className="eyebrow">EXTERNAL SIGNAL / FDA</div><h1>FDA watch</h1><p>Public shortage notices, with source dates and exact product identifiers. Match these to local stock before acting.</p></div>{state.me?.role === 'admin' && <button className="button primary" disabled={busy} onClick={sync}><RefreshCw size={16} className={busy ? 'spin' : ''}/>{busy ? 'Syncing…' : 'Sync FDA now'}</button>}</div>
    <div className="feed-status"><div className="feed-icon"><RefreshCw size={18}/></div><div><strong>{state.sync?.status === 'complete' ? `FDA source updated ${state.sync.feedDate}` : state.sync?.status === 'running' ? 'FDA sync in progress' : 'FDA feed has not been imported'}</strong><small>{state.sync?.status === 'complete' ? `${number(state.sync.recordCount)} records · imported ${date(state.sync.completedAt)}` : 'An admin can sync from the public FDA API.'}</small></div><Pill tone={state.sync?.status === 'complete' ? 'good' : 'watch'}>{state.sync?.status ?? 'waiting'}</Pill></div>
    {progress && <div className="notice-strip"><span className="notice-icon">↻</span>{progress}</div>}
    <div className="inventory-layout"><Panel title={`${number(rows.length)} source records`} eyebrow="SEARCH / VERIFY" action={<div className="search-box"><Search size={16}/><input aria-label="Search FDA notices" placeholder="Drug, company, or NDC" value={search} onChange={event => { setSearch(event.target.value); setLimit(40); }}/></div>}>
      <div className="tab-line"><button className={filter === 'current' ? 'active' : ''} onClick={() => setFilter('current')}>Current shortage</button><button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>All FDA statuses</button></div>
      {rows.length ? <div className="notice-list">{rows.slice(0, limit).map(row => <button className={`notice-card ${selectedKey === row.key ? 'selected' : ''}`} key={row.key} onClick={() => setSelectedKey(row.key)}><div><strong>{row.genericName}</strong><small>{row.presentation || row.dosageForm || 'Presentation unavailable'}</small><small>{row.companyName} · NDC {row.packageNdc || 'not supplied'}</small></div><Pill tone={isCurrentShortage(row) ? 'watch' : 'neutral'}>{row.status}</Pill></button>)}{limit < rows.length && <button className="button ghost wide" onClick={() => setLimit(x => x + 40)}>Show more</button>}</div> : <Empty title="No matching notices" detail={state.shortages.length ? 'Try a broader search or view all statuses.' : 'An admin can import the real FDA feed above.'} />}
    </Panel><Panel title={selected ? selected.genericName : 'Notice details'} eyebrow="SOURCE RECORD">
      {selected ? <div className="detail-stack"><div className="detail-top"><div><small>FDA SHORTAGE RECORD</small><strong>{selected.genericName}</strong></div><Pill tone={isCurrentShortage(selected) ? 'watch' : 'neutral'}>{selected.status}</Pill></div><div className="detail-section"><strong>Presentation</strong><p>{selected.presentation || 'Not specified'}</p></div><div className="mini-grid"><div><span>Package NDC</span><b>{selected.packageNdc || '—'}</b></div><div><span>RxCUI</span><b>{selected.rxcui || '—'}</b></div><div><span>Company</span><b>{selected.companyName || '—'}</b></div><div><span>FDA update</span><b>{selected.updateDate || '—'}</b></div></div><div className="detail-section"><strong>FDA notes</strong><p>{selected.details || 'No additional source note.'}</p></div><div className="detail-section"><strong>Local stock linked to this record</strong>{linked.length ? <div className="compact-list">{linked.map(item => <div key={item.key}><span>{item.label}</span><small>{number(item.onHand - item.reserved, 1)} {item.unit} available</small></div>)}</div> : <p>No site inventory is linked yet.</p>}</div><div className="detail-actions">{state.me?.role !== 'viewer' && ndcDigits(selected.packageNdc).length >= 10 && ndcDigits(selected.packageNdc).length <= 11 && <button className="button primary" onClick={() => track(selected)}><Plus size={15}/> Track at a site</button>}<a className="button ghost" href="https://www.accessdata.fda.gov/scripts/drugshortages/default.cfm" target="_blank" rel="noreferrer">FDA database <ExternalLink size={14}/></a></div><small className="source-caution">FDA records are public supply signals. They are not local inventory or a basis for medication-care decisions.</small></div> : <Empty title="Select a source record" detail="Inspect its status, package code, update date, and any inventory linked by your team." />}
    </Panel></div>
  </div>;
}
