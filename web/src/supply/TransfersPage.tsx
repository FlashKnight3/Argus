import { useState } from 'react';
import { ArrowRight, Check, PackageCheck, Plus, Send, Truck, X } from 'lucide-react';
import { Empty, Panel, Pill, canManage, date, errorText, number, siteName } from './ui';
import type { Notify } from './App';
import type { SupplyActions, SupplyState, Transfer } from './useSupply';

function statusTone(status: string): 'neutral' | 'good' | 'watch' | 'info' {
  return status === 'received' ? 'good' : status === 'cancelled' ? 'neutral' : status === 'requested' ? 'watch' : 'info';
}

export function TransfersPage({ state, actions, notify }: { state: SupplyState; actions: SupplyActions; notify: Notify }) {
  const [showForm, setShowForm] = useState(false);
  const [sourceSiteId, setSourceSiteId] = useState(0);
  const [destSiteId, setDestSiteId] = useState(state.me?.role === 'admin' ? 0 : state.me?.siteId ?? 0);
  const [ndc, setNdc] = useState('');
  const [quantity, setQuantity] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const open = state.transfers.filter(row => !['received', 'cancelled'].includes(row.status));
  const finished = state.transfers.filter(row => ['received', 'cancelled'].includes(row.status));
  const pending = state.proposals.filter(row => row.status === 'pending');
  const sources = state.inventory.filter(row => row.siteId === sourceSiteId);

  const act = async (promise: Promise<void>, success: string): Promise<boolean> => {
    setBusy(true);
    try { await promise; notify(success); return true; }
    catch (error) { notify(errorText(error), true); return false; }
    finally { setBusy(false); }
  };
  const create = async () => {
    if (await act(actions.createTransfer({ sourceSiteId, destSiteId, packageNdc: ndc, quantity: Number(quantity), reason }), 'Transfer request created. The source site can reserve it.')) {
      setShowForm(false); setQuantity(''); setReason('');
    }
  };
  const actionFor = (row: Transfer) => {
    if (row.status === 'requested' && canManage(state.me, row.sourceSiteId)) return <button className="button primary small" disabled={busy} onClick={() => act(actions.approveTransfer({ transferId: row.id }), `Transfer #${row.id} reserved.`)}><Check size={15}/> Reserve stock</button>;
    if (row.status === 'reserved' && canManage(state.me, row.sourceSiteId)) return <button className="button primary small" disabled={busy} onClick={() => act(actions.shipTransfer({ transferId: row.id }), `Transfer #${row.id} shipped.`)}><Truck size={15}/> Mark shipped</button>;
    if (row.status === 'shipped' && canManage(state.me, row.destSiteId)) return <button className="button primary small" disabled={busy} onClick={() => act(actions.receiveTransfer({ transferId: row.id }), `Transfer #${row.id} received into inventory.`)}><PackageCheck size={15}/> Confirm receipt</button>;
    return null;
  };

  return <div className="page-stack"><div className="page-intro"><div><div className="eyebrow">MULTI-SITE COORDINATION</div><h1>Transfers</h1><p>Stock moves through explicit requests, reservations, shipment, and receipt. No agent can approve a transfer.</p></div>{state.me?.role !== 'viewer' && <button className="button primary" onClick={() => setShowForm(true)}><Plus size={16}/> Request stock</button>}</div>
    <div className="transfer-flow"><div><span>01</span><strong>Request</strong><small>Destination asks</small></div><ArrowRight size={18}/><div><span>02</span><strong>Reserve</strong><small>Source confirms</small></div><ArrowRight size={18}/><div><span>03</span><strong>Ship</strong><small>Source releases</small></div><ArrowRight size={18}/><div><span>04</span><strong>Receive</strong><small>Destination counts</small></div></div>
    {pending.length > 0 && <Panel eyebrow="AGENT / HUMAN REVIEW" title={`${pending.length} transfer draft${pending.length === 1 ? '' : 's'}`}><div className="proposal-grid">{pending.map(item => <div className="proposal-card" key={item.key}><div className="proposal-head"><Pill tone="info">Agent draft</Pill><small>{date(item.createdAt)}</small></div><h3>{number(item.quantity, 1)} units · NDC {item.ndc}</h3><p>{siteName(state.sites, item.sourceSiteId)} <ArrowRight size={14}/> {siteName(state.sites, item.destSiteId)}</p><div className="proposal-reason">{item.reason}</div><div className="proposal-actions">{canManage(state.me, item.destSiteId) ? <><button className="button primary small" disabled={busy} onClick={() => act(actions.acceptProposal({ key: item.key }), 'Draft accepted as a request. Source approval is still required.')}>Create request</button><button className="button ghost small" disabled={busy} onClick={() => act(actions.dismissProposal({ key: item.key }), 'Draft dismissed.')}>Dismiss</button></> : <small>Awaiting destination manager</small>}</div></div>)}</div></Panel>}
    <Panel eyebrow="OPEN / AUDITABLE" title={`${open.length} active transfers`}>
      {open.length ? <div className="transfer-list">{open.map(row => <div className="transfer-card" key={row.id}><div className="transfer-icon"><Truck size={20}/></div><div className="transfer-main"><div className="transfer-title"><strong>#{row.id} · {row.label}</strong><Pill tone={statusTone(row.status)}>{row.status}</Pill></div><div className="transfer-route">{siteName(state.sites, row.sourceSiteId)} <ArrowRight size={14}/> {siteName(state.sites, row.destSiteId)}</div><small>{number(row.quantity, 1)} units · NDC {row.ndc} · {row.reason || 'No note'} · {date(row.createdAt)}</small></div><div className="transfer-actions">{actionFor(row)}{['requested', 'reserved'].includes(row.status) && (canManage(state.me, row.sourceSiteId) || canManage(state.me, row.destSiteId)) && <button className="icon-button" disabled={busy} title="Cancel transfer" onClick={() => act(actions.cancelTransfer({ transferId: row.id }), `Transfer #${row.id} cancelled.`)}><X size={17}/></button>}</div></div>)}</div> : <Empty title="No active transfers" detail="Create a request or review an agent draft when another site can help." />}
    </Panel>
    <Panel eyebrow="HISTORY" title="Completed and cancelled"><div className="compact-list">{finished.slice(0, 12).map(row => <div key={row.id}><span>#{row.id} · {row.label}</span><small>{siteName(state.sites, row.sourceSiteId)} → {siteName(state.sites, row.destSiteId)}</small><Pill tone={statusTone(row.status)}>{row.status}</Pill></div>)}{!finished.length && <span className="muted">No completed transfers yet.</span>}</div></Panel>

    {showForm && <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setShowForm(false); }}><div className="modal"><div className="modal-head"><div><div className="eyebrow">HUMAN-INITIATED</div><h2>Request stock</h2></div><button className="icon-button" onClick={() => setShowForm(false)} aria-label="Close"><X size={18}/></button></div><p className="modal-copy">The source manager must approve a reservation before any quantity is committed.</p>
      <div className="form-grid"><label>From site<select value={sourceSiteId} onChange={event => { setSourceSiteId(Number(event.target.value)); setNdc(''); }}><option value={0}>Choose source</option>{state.sites.map(site => <option key={site.id} value={site.id}>{site.name}</option>)}</select></label><label>To site<select value={destSiteId} onChange={event => setDestSiteId(Number(event.target.value))} disabled={state.me?.role !== 'admin'}><option value={0}>Choose destination</option>{state.sites.map(site => <option key={site.id} value={site.id}>{site.name}</option>)}</select></label><label className="full">Product at source<select value={ndc} onChange={event => setNdc(event.target.value)}><option value="">Choose product</option>{sources.map(item => <option key={item.key} value={item.ndc}>{item.label} · {number(item.onHand - item.reserved, 1)} {item.unit} free · NDC {item.ndc}</option>)}</select></label><label>Quantity<input type="number" min="0" step="any" value={quantity} onChange={event => setQuantity(event.target.value)} placeholder="0"/></label><label>Reason<input value={reason} onChange={event => setReason(event.target.value)} placeholder="Why this site needs stock"/></label></div><div className="modal-foot"><small>Requests do not reserve stock until approved by the source.</small><button className="button primary" disabled={busy || !sourceSiteId || !destSiteId || !ndc || !(Number(quantity) > 0)} onClick={create}><Send size={15}/> Send request</button></div>
    </div></div>}
  </div>;
}
