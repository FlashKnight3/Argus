import { useState } from 'react';
import { ArrowRight, Plus } from 'lucide-react';
import { Empty, Modal, PageHead, Pill, Tabs, canManage, date, errorText, number, siteName, type Tone } from './ui';
import { newOpId, type OfflineQueue } from './offline';
import type { Notify } from './App';
import type { SupplyActions, SupplyState, Transfer } from './useSupply';

type Tab = 'drafts' | 'active' | 'history';
const statusTone = (s: string): Tone => s === 'received' ? 'good' : s === 'cancelled' ? 'neutral' : s === 'requested' ? 'watch' : 'info';
const statusLabel: Record<string, string> = { requested: 'Requested', reserved: 'Reserved', shipped: 'Shipped', received: 'Received', cancelled: 'Cancelled' };

export function TransfersPage({ state, actions, queue, notify }: { state: SupplyState; actions: SupplyActions; queue: OfflineQueue; notify: Notify }) {
  const drafts = state.proposals.filter(p => p.status === 'pending');
  const active = state.transfers.filter(t => !['received', 'cancelled'].includes(t.status));
  const history = state.transfers.filter(t => ['received', 'cancelled'].includes(t.status));
  const [tab, setTab] = useState<Tab>(drafts.length ? 'drafts' : 'active');
  const [busy, setBusy] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const editable = state.me?.role === 'admin' || state.me?.role === 'manager';
  const unit = (siteId: number, ndc: string) => state.inventory.find(i => i.key === `${siteId}:${ndc}`)?.unit ?? 'units';
  const label = (ndc: string) => state.inventory.find(i => i.ndc === ndc)?.label ?? `NDC ${ndc}`;

  const act = async (p: Promise<void>, ok: string) => {
    setBusy(true);
    try { await p; notify(ok); } catch (e) { notify(errorText(e), true); } finally { setBusy(false); }
  };
  const next = (t: Transfer) => {
    if (t.status === 'requested' && canManage(state.me, t.sourceSiteId)) return <button className="link" disabled={busy} onClick={() => act(actions.approveTransfer({ transferId: t.id }), `Transfer #${t.id} reserved.`)}>Reserve stock</button>;
    if (t.status === 'reserved' && canManage(state.me, t.sourceSiteId)) return <button className="link" disabled={busy} onClick={() => act(actions.shipTransfer({ transferId: t.id }), `Transfer #${t.id} shipped.`)}>Mark shipped</button>;
    if (t.status === 'shipped' && canManage(state.me, t.destSiteId)) return <button className="link" disabled={busy} onClick={() => act(actions.receiveTransfer({ transferId: t.id }), `Transfer #${t.id} received.`)}>Confirm receipt</button>;
    return <span className="muted" style={{ fontSize: 12 }}>Waiting on {t.status === 'shipped' ? siteName(state.sites, t.destSiteId) : siteName(state.sites, t.sourceSiteId)}</span>;
  };

  return <>
    <PageHead title="Transfers" subtitle="Move stock between your sites. The agent drafts; people request, reserve, ship, and receive."
      right={editable && <button className="fab" title="Request stock" onClick={() => setShowForm(true)}><Plus size={20}/></button>} />
    <Tabs value={tab} onChange={setTab} tabs={[{ id: 'drafts', label: 'Agent drafts', count: drafts.length }, { id: 'active', label: 'In progress', count: active.length }, { id: 'history', label: 'History' }]} />
    {tab !== 'drafts' && <div className="flow"><span><span className="n">1</span><b>Request</b></span><ArrowRight size={14}/><span><span className="n">2</span><b>Reserve</b> at source</span><ArrowRight size={14}/><span><span className="n">3</span><b>Ship</b></span><ArrowRight size={14}/><span><span className="n">4</span><b>Receive</b> at destination</span>
      {state.config?.reservationTtlHours ? <span className="muted">· unshipped reservations release after {state.config.reservationTtlHours} h</span> : null}</div>}

    {tab === 'drafts' && (drafts.length ? <div className="table-wrap"><table className="table"><thead><tr><th>Product</th><th>From → To</th><th className="num">Quantity</th><th>Why</th><th className="actions">Actions</th></tr></thead><tbody>
      {drafts.map(p => <tr key={p.key}><td><strong title={label(p.ndc)}>{label(p.ndc)}</strong><small>NDC {p.ndc}{p.destNdc ? ` → ${p.destNdc}` : ''}</small>{p.destNdc && <Pill tone="watch">Equivalent product</Pill>}</td>
        <td>{siteName(state.sites, p.sourceSiteId)} → {siteName(state.sites, p.destSiteId)}</td><td className="num">{number(p.quantity)} <small>{unit(p.sourceSiteId, p.ndc)}</small></td>
        <td style={{ maxWidth: 360 }}><small style={{ color: 'var(--text-2)' }}>{p.reason}</small></td>
        <td className="actions">{canManage(state.me, p.destSiteId) ? <><button className="link" disabled={busy} onClick={() => act(actions.acceptProposal({ key: p.key }), 'Request created. The source site can now reserve it.')}>Request</button>
          <button className="link danger" disabled={busy} onClick={() => act(actions.dismissProposal({ key: p.key }), 'Draft dismissed.')}>Dismiss</button></> : <span className="muted" style={{ fontSize: 12 }}>For {siteName(state.sites, p.destSiteId)}</span>}</td></tr>)}
    </tbody></table></div> : <div className="card"><Empty title="No drafts" detail="The agent drafts a transfer when one site is running low and another has stock it can spare." /></div>)}

    {tab === 'active' && (active.length ? <div className="table-wrap"><table className="table"><thead><tr><th>#</th><th>Product</th><th>From → To</th><th className="num">Quantity</th><th>Status</th><th className="actions">Next step</th></tr></thead><tbody>
      {active.map(t => <tr key={t.id}><td className="muted">{t.id}</td><td><strong title={t.label}>{t.label}</strong><small>NDC {t.ndc}{t.destNdc ? ` → ${t.destNdc}` : ''} · {date(t.createdAt)}</small></td>
        <td>{siteName(state.sites, t.sourceSiteId)} → {siteName(state.sites, t.destSiteId)}</td><td className="num">{number(t.quantity)}</td>
        <td><Pill tone={statusTone(t.status)}>{statusLabel[t.status]}</Pill></td>
        <td className="actions">{next(t)}{['requested', 'reserved'].includes(t.status) && (canManage(state.me, t.sourceSiteId) || canManage(state.me, t.destSiteId)) &&
          <button className="link danger" disabled={busy} onClick={() => act(actions.cancelTransfer({ transferId: t.id }), `Transfer #${t.id} cancelled.`)}>Cancel</button>}</td></tr>)}
    </tbody></table></div> : <div className="card"><Empty title="Nothing in progress" detail="Requests you create, or agent drafts you accept, show up here." /></div>)}

    {tab === 'history' && (history.length ? <div className="table-wrap"><table className="table"><thead><tr><th>#</th><th>Product</th><th>From → To</th><th className="num">Quantity</th><th>Status</th><th>Updated</th></tr></thead><tbody>
      {history.slice(0, 100).map(t => <tr key={t.id}><td className="muted">{t.id}</td><td><strong title={t.label}>{t.label}</strong><small>{t.reason.slice(0, 80)}</small></td><td>{siteName(state.sites, t.sourceSiteId)} → {siteName(state.sites, t.destSiteId)}</td>
        <td className="num">{number(t.quantity)}</td><td><Pill tone={statusTone(t.status)}>{statusLabel[t.status]}</Pill></td><td><small>{date(t.updatedAt)}</small></td></tr>)}
    </tbody></table></div> : <div className="card"><Empty title="No history yet" detail="Completed and cancelled transfers appear here." /></div>)}

    {showForm && <RequestForm state={state} queue={queue} notify={notify} onClose={() => setShowForm(false)} />}
  </>;
}

function RequestForm({ state, queue, notify, onClose }: { state: SupplyState; queue: OfflineQueue; notify: Notify; onClose: () => void }) {
  const [source, setSource] = useState(0);
  const [dest, setDest] = useState(state.me?.role === 'admin' ? 0 : state.me?.siteId ?? 0);
  const [ndc, setNdc] = useState('');
  const [qty, setQty] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const products = state.inventory.filter(i => i.siteId === source);
  const product = products.find(p => p.ndc === ndc);
  const free = product ? product.onHand - product.reserved : 0;
  const tooMany = !!product && Number(qty) > free;
  const save = async () => {
    setBusy(true);
    try {
      const out = await queue.submit('createTransfer', { opId: newOpId(), sourceSiteId: source, destSiteId: dest, packageNdc: ndc, quantity: Number(qty), reason }, `Request ${qty} of NDC ${ndc}`);
      notify(out === 'queued' ? 'Saved offline; the request is sent when you reconnect.' : 'Request sent. The source site can now reserve it.');
      onClose();
    } catch (e) { notify(errorText(e), true); } finally { setBusy(false); }
  };
  return <Modal title="Request stock" subtitle="Ask another site to send you a product. Nothing is reserved until the source approves." onClose={onClose}
    footer={<><button className="button ghost" onClick={onClose}>Cancel</button><button className="button primary" disabled={busy || !source || !dest || !ndc || !(Number(qty) > 0) || tooMany} onClick={save}>Send request</button></>}>
    <div className="form-grid">
      <label>From<select value={source} onChange={e => { setSource(Number(e.target.value)); setNdc(''); }}><option value={0}>Choose site</option>{state.sites.filter(s => s.id !== dest).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
      <label>To<select value={dest} onChange={e => setDest(Number(e.target.value))} disabled={state.me?.role !== 'admin'}><option value={0}>Choose site</option>{state.sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
      <label className="full">Product<select value={ndc} onChange={e => setNdc(e.target.value)} disabled={!source}><option value="">{source ? 'Choose product' : 'Choose the source site first'}</option>{products.map(p => <option key={p.key} value={p.ndc}>{p.label} · {number(p.onHand - p.reserved)} {p.unit} free</option>)}</select></label>
      <label>Quantity{product && <span className="help">{free} {product.unit} free at the source</span>}<input type="number" min="0" max={free || undefined} step="any" value={qty} onChange={e => setQty(e.target.value)} style={tooMany ? { borderColor: 'var(--red)' } : undefined} />
        {tooMany && <span className="help" style={{ color: 'var(--red)' }}>The source only has {free} free.</span>}</label>
      <label>Reason<input value={reason} onChange={e => setReason(e.target.value)} placeholder="Optional" /></label>
    </div>
  </Modal>;
}
