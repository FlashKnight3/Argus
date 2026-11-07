/** Argus Supply: local, multi-site shortage and inventory coordination.
 *
 * All mutations pass through reducers. The FDA worker may import public notices
 * and write derived projections, but it cannot reserve, ship, or receive stock.
 * Those transitions require a human site manager.
 */
import { schema, SenderError, table, t, type InferSchema, type ReducerCtx } from 'spacetimedb/server';

const site = table({ name: 'site', public: true }, {
  id: t.u32().primaryKey().autoInc(),
  name: t.string(),
  region: t.string(),
  contact: t.string(),
  active: t.bool(),
  createdAt: t.timestamp(),
});

const member = table({ name: 'member', public: true }, {
  identity: t.string().primaryKey(),
  name: t.string(),
  /** admin | manager | viewer | service */
  role: t.string(),
  /** 0 for an admin or service identity. */
  siteId: t.u32(),
  createdAt: t.timestamp(),
});

const inventory = table({ name: 'inventory', public: true }, {
  /** site ID and canonicalized NDC, joined by a colon. */
  key: t.string().primaryKey(),
  siteId: t.u32(),
  ndc: t.string(),
  label: t.string(),
  unit: t.string(),
  onHand: t.f64(),
  reserved: t.f64(),
  baselineDaily: t.f64(),
  safetyStock: t.f64(),
  /** An optional confirmed FDA shortage key. */
  shortageKey: t.string(),
  revision: t.u32(),
  updatedAt: t.timestamp(),
});

const stockEvent = table({ name: 'stock_event', public: true }, {
  id: t.u32().primaryKey().autoInc(),
  inventoryKey: t.string(),
  /** receive | use | set | ship | transfer_receive */
  kind: t.string(),
  delta: t.f64(),
  note: t.string(),
  actor: t.string(),
  at: t.timestamp(),
});

const shortage = table({ name: 'shortage', public: true }, {
  key: t.string().primaryKey(),
  packageNdc: t.string(),
  genericName: t.string(),
  companyName: t.string(),
  presentation: t.string(),
  dosageForm: t.string(),
  status: t.string(),
  details: t.string(),
  updateDate: t.string(),
  rxcui: t.string(),
  runId: t.string(),
  active: t.bool(),
  observedAt: t.timestamp(),
});

const syncState = table({ name: 'sync_state', public: true }, {
  id: t.u32().primaryKey(),
  runId: t.string(),
  status: t.string(),
  feedDate: t.string(),
  recordCount: t.u32(),
  completedAt: t.timestamp(),
});

const transfer = table({ name: 'transfer', public: true }, {
  id: t.u32().primaryKey().autoInc(),
  sourceSiteId: t.u32(),
  destSiteId: t.u32(),
  ndc: t.string(),
  label: t.string(),
  quantity: t.f64(),
  /** requested | reserved | shipped | received | cancelled */
  status: t.string(),
  reason: t.string(),
  requestedBy: t.string(),
  approvedBy: t.string(),
  createdAt: t.timestamp(),
  updatedAt: t.timestamp(),
});

const forecast = table({ name: 'forecast', public: true }, {
  key: t.string().primaryKey(),
  inventoryRevision: t.u32(),
  computedAt: t.timestamp(),
  ratePerDay: t.f64(),
  daysP10: t.f64(),
  daysMedian: t.f64(),
  daysP90: t.f64(),
  /** unknown | stable | watch | critical */
  risk: t.string(),
  explanation: t.string(),
});

const proposal = table({ name: 'proposal', public: true }, {
  /** Stable fingerprint allows a worker retry without duplicate proposals. */
  key: t.string().primaryKey(),
  sourceSiteId: t.u32(),
  destSiteId: t.u32(),
  ndc: t.string(),
  quantity: t.f64(),
  reason: t.string(),
  /** pending | accepted | dismissed */
  status: t.string(),
  createdAt: t.timestamp(),
});

const activity = table({ name: 'activity', public: true }, {
  id: t.u32().primaryKey().autoInc(),
  actor: t.string(),
  action: t.string(),
  detail: t.string(),
  at: t.timestamp(),
});

const spacetimedb = schema({ site, member, inventory, stockEvent, shortage, syncState, transfer, forecast, proposal, activity });
export default spacetimedb;

type Ctx = ReducerCtx<InferSchema<typeof spacetimedb>>;
const SYNC_ID = 1;

function caller(ctx: Ctx): string { return ctx.sender.toHexString(); }
function currentMember(ctx: Ctx) { return ctx.db.member.identity.find(caller(ctx)); }
function requireRole(ctx: Ctx, ...roles: string[]) {
  const m = currentMember(ctx);
  if (!m || !roles.includes(m.role)) throw new SenderError('This action requires an authorized account.');
  return m;
}
function requireSite(ctx: Ctx, siteId: number) {
  const m = requireRole(ctx, 'admin', 'manager');
  if (m.role !== 'admin' && m.siteId !== siteId) throw new SenderError('You manage a different site.');
  if (!ctx.db.site.id.find(siteId)) throw new SenderError('Site not found.');
  return m;
}
function requireWorker(ctx: Ctx) { return requireRole(ctx, 'admin', 'service'); }
function positive(value: number, label: string) {
  if (!Number.isFinite(value) || value <= 0) throw new SenderError(`${label} must be positive.`);
}
function nonnegative(value: number, label: string) {
  if (!Number.isFinite(value) || value < 0) throw new SenderError(`${label} must be zero or greater.`);
}
function ndc(value: string): string {
  const digits = value.replace(/[^0-9]/g, '');
  if (digits.length < 10 || digits.length > 11) throw new SenderError('Enter a 10–11 digit package NDC.');
  return digits;
}
function invKey(siteId: number, code: string) { return `${siteId}:${code}`; }
function log(ctx: Ctx, action: string, detail: string) {
  ctx.db.activity.insert({ id: 0, actor: caller(ctx), action, detail, at: ctx.timestamp });
}
function stockLog(ctx: Ctx, key: string, kind: string, delta: number, note: string) {
  ctx.db.stockEvent.insert({ id: 0, inventoryKey: key, kind, delta, note, actor: caller(ctx), at: ctx.timestamp });
}

export const init = spacetimedb.init(_ctx => {
  // The first operator explicitly creates the network. No synthetic stock is seeded.
});

export const bootstrapNetwork = spacetimedb.reducer(
  { ownerName: t.string(), siteName: t.string(), region: t.string() },
  (ctx, a) => {
    for (const _m of ctx.db.member.iter()) throw new SenderError('The network has already been created.');
    if (!a.ownerName.trim() || !a.siteName.trim()) throw new SenderError('Name and first site are required.');
    const s = ctx.db.site.insert({ id: 0, name: a.siteName.trim(), region: a.region.trim(), contact: '', active: true, createdAt: ctx.timestamp });
    ctx.db.member.insert({ identity: caller(ctx), name: a.ownerName.trim(), role: 'admin', siteId: 0, createdAt: ctx.timestamp });
    ctx.db.syncState.insert({ id: SYNC_ID, runId: '', status: 'never', feedDate: '', recordCount: 0, completedAt: ctx.timestamp });
    log(ctx, 'network.bootstrap', `Created ${s.name}`);
  }
);

export const createSite = spacetimedb.reducer(
  { name: t.string(), region: t.string(), contact: t.string() },
  (ctx, a) => {
    requireRole(ctx, 'admin');
    if (!a.name.trim()) throw new SenderError('Site name is required.');
    const s = ctx.db.site.insert({ id: 0, name: a.name.trim(), region: a.region.trim(), contact: a.contact.trim(), active: true, createdAt: ctx.timestamp });
    log(ctx, 'site.create', `${s.id}: ${s.name}`);
  }
);

export const grantMember = spacetimedb.reducer(
  { identity: t.string(), name: t.string(), role: t.string(), siteId: t.u32() },
  (ctx, a) => {
    requireRole(ctx, 'admin');
    if (!/^[0-9a-f]{64}$/i.test(a.identity)) throw new SenderError('Identity must be a 64-character hex string.');
    if (!['admin', 'manager', 'viewer', 'service'].includes(a.role)) throw new SenderError('Unknown role.');
    if (['manager', 'viewer'].includes(a.role) && !ctx.db.site.id.find(a.siteId)) throw new SenderError('Site not found.');
    const row = { identity: a.identity.toLowerCase(), name: a.name.trim() || a.role, role: a.role,
      siteId: a.role === 'manager' || a.role === 'viewer' ? a.siteId : 0, createdAt: ctx.timestamp };
    const old = ctx.db.member.identity.find(row.identity);
    if (old) ctx.db.member.identity.update({ ...old, ...row, createdAt: old.createdAt });
    else ctx.db.member.insert(row);
    log(ctx, 'member.grant', `${row.identity.slice(0, 8)} → ${row.role}${row.siteId ? ` at ${row.siteId}` : ''}`);
  }
);

export const upsertInventory = spacetimedb.reducer(
  { siteId: t.u32(), packageNdc: t.string(), label: t.string(), unit: t.string(), onHand: t.f64(),
    baselineDaily: t.f64(), safetyStock: t.f64(), shortageKey: t.string() },
  (ctx, a) => {
    requireSite(ctx, a.siteId);
    nonnegative(a.onHand, 'On-hand stock');
    nonnegative(a.baselineDaily, 'Daily usage');
    nonnegative(a.safetyStock, 'Safety stock');
    if (!a.label.trim() || !a.unit.trim()) throw new SenderError('Product name and unit are required.');
    const code = ndc(a.packageNdc);
    const key = invKey(a.siteId, code);
    const old = ctx.db.inventory.key.find(key);
    if (old && a.onHand < old.reserved) throw new SenderError('On-hand stock cannot fall below reservations.');
    if (a.shortageKey && !ctx.db.shortage.key.find(a.shortageKey)) throw new SenderError('FDA record not found.');
    const row = { key, siteId: a.siteId, ndc: code, label: a.label.trim(), unit: a.unit.trim(),
      onHand: a.onHand, reserved: old?.reserved ?? 0, baselineDaily: a.baselineDaily,
      safetyStock: a.safetyStock, shortageKey: a.shortageKey, revision: (old?.revision ?? 0) + 1,
      updatedAt: ctx.timestamp };
    if (old) ctx.db.inventory.key.update(row);
    else ctx.db.inventory.insert(row);
    stockLog(ctx, key, 'set', a.onHand - (old?.onHand ?? 0), old ? 'Inventory corrected' : 'Opening inventory');
    log(ctx, 'inventory.upsert', `${key}: ${a.onHand} ${row.unit}`);
  }
);

export const recordStock = spacetimedb.reducer(
  { inventoryKey: t.string(), kind: t.string(), quantity: t.f64(), note: t.string() },
  (ctx, a) => {
    const item = ctx.db.inventory.key.find(a.inventoryKey);
    if (!item) throw new SenderError('Inventory item not found.');
    requireSite(ctx, item.siteId);
    if (a.kind !== 'receive' && a.kind !== 'use') throw new SenderError('Choose receive or use.');
    positive(a.quantity, 'Quantity');
    if (a.kind === 'use' && a.quantity > item.onHand - item.reserved) throw new SenderError('Not enough unreserved stock.');
    const delta = a.kind === 'use' ? -a.quantity : a.quantity;
    ctx.db.inventory.key.update({ ...item, onHand: item.onHand + delta, revision: item.revision + 1, updatedAt: ctx.timestamp });
    stockLog(ctx, item.key, a.kind, delta, a.note.trim());
    log(ctx, `stock.${a.kind}`, `${item.key}: ${delta} ${item.unit}`);
  }
);

function requestTransfer(ctx: Ctx, sourceSiteId: number, destSiteId: number, code: string, quantity: number, reason: string) {
  if (sourceSiteId === destSiteId) throw new SenderError('Choose two different sites.');
  positive(quantity, 'Quantity');
  if (!ctx.db.site.id.find(destSiteId)) throw new SenderError('Destination site not found.');
  const source = ctx.db.inventory.key.find(invKey(sourceSiteId, code));
  if (!source) throw new SenderError('Source site does not stock this product.');
  const dest = ctx.db.inventory.key.find(invKey(destSiteId, code));
  if (dest && dest.unit.trim().toLowerCase() !== source.unit.trim().toLowerCase())
    throw new SenderError('Source and destination units must match before transfer.');
  const row = ctx.db.transfer.insert({ id: 0, sourceSiteId, destSiteId, ndc: code, label: source.label,
    quantity, status: 'requested', reason: reason.trim(), requestedBy: caller(ctx), approvedBy: '',
    createdAt: ctx.timestamp, updatedAt: ctx.timestamp });
  log(ctx, 'transfer.request', `#${row.id}: ${quantity} ${source.unit} ${source.label}, ${sourceSiteId} → ${destSiteId}`);
}

export const createTransfer = spacetimedb.reducer(
  { sourceSiteId: t.u32(), destSiteId: t.u32(), packageNdc: t.string(), quantity: t.f64(), reason: t.string() },
  (ctx, a) => {
    requireSite(ctx, a.destSiteId);
    requestTransfer(ctx, a.sourceSiteId, a.destSiteId, ndc(a.packageNdc), a.quantity, a.reason);
  }
);

export const approveTransfer = spacetimedb.reducer({ transferId: t.u32() }, (ctx, a) => {
  const tr = ctx.db.transfer.id.find(a.transferId);
  if (!tr || tr.status !== 'requested') throw new SenderError('Transfer is not awaiting approval.');
  requireSite(ctx, tr.sourceSiteId);
  const source = ctx.db.inventory.key.find(invKey(tr.sourceSiteId, tr.ndc));
  if (!source || source.onHand - source.reserved < tr.quantity) throw new SenderError('Insufficient unreserved stock.');
  ctx.db.inventory.key.update({ ...source, reserved: source.reserved + tr.quantity, revision: source.revision + 1, updatedAt: ctx.timestamp });
  ctx.db.transfer.id.update({ ...tr, status: 'reserved', approvedBy: caller(ctx), updatedAt: ctx.timestamp });
  log(ctx, 'transfer.reserve', `#${tr.id}: ${tr.quantity} ${source.unit}`);
});

export const shipTransfer = spacetimedb.reducer({ transferId: t.u32() }, (ctx, a) => {
  const tr = ctx.db.transfer.id.find(a.transferId);
  if (!tr || tr.status !== 'reserved') throw new SenderError('Transfer is not reserved.');
  requireSite(ctx, tr.sourceSiteId);
  const source = ctx.db.inventory.key.find(invKey(tr.sourceSiteId, tr.ndc));
  if (!source || source.reserved < tr.quantity || source.onHand < tr.quantity) throw new SenderError('Reservation is inconsistent.');
  ctx.db.inventory.key.update({ ...source, onHand: source.onHand - tr.quantity,
    reserved: source.reserved - tr.quantity, revision: source.revision + 1, updatedAt: ctx.timestamp });
  stockLog(ctx, source.key, 'ship', -tr.quantity, `Transfer #${tr.id}`);
  ctx.db.transfer.id.update({ ...tr, status: 'shipped', updatedAt: ctx.timestamp });
  log(ctx, 'transfer.ship', `#${tr.id}`);
});

export const receiveTransfer = spacetimedb.reducer({ transferId: t.u32() }, (ctx, a) => {
  const tr = ctx.db.transfer.id.find(a.transferId);
  if (!tr || tr.status !== 'shipped') throw new SenderError('Transfer has not shipped.');
  requireSite(ctx, tr.destSiteId);
  const source = ctx.db.inventory.key.find(invKey(tr.sourceSiteId, tr.ndc));
  if (!source) throw new SenderError('Source product is missing.');
  const key = invKey(tr.destSiteId, tr.ndc);
  const dest = ctx.db.inventory.key.find(key);
  if (dest && dest.unit.trim().toLowerCase() !== source.unit.trim().toLowerCase())
    throw new SenderError('Destination unit changed; reconcile it before receipt.');
  if (dest) ctx.db.inventory.key.update({ ...dest, onHand: dest.onHand + tr.quantity,
    revision: dest.revision + 1, updatedAt: ctx.timestamp });
  else ctx.db.inventory.insert({ key, siteId: tr.destSiteId, ndc: tr.ndc, label: source.label,
    unit: source.unit, onHand: tr.quantity, reserved: 0, baselineDaily: 0, safetyStock: 0,
    shortageKey: source.shortageKey, revision: 1, updatedAt: ctx.timestamp });
  stockLog(ctx, key, 'transfer_receive', tr.quantity, `Transfer #${tr.id}`);
  ctx.db.transfer.id.update({ ...tr, status: 'received', updatedAt: ctx.timestamp });
  log(ctx, 'transfer.receive', `#${tr.id}`);
});

export const cancelTransfer = spacetimedb.reducer({ transferId: t.u32() }, (ctx, a) => {
  const tr = ctx.db.transfer.id.find(a.transferId);
  if (!tr || !['requested', 'reserved'].includes(tr.status)) throw new SenderError('Only unshipped transfers can be cancelled.');
  const m = requireRole(ctx, 'admin', 'manager');
  if (m.role !== 'admin' && m.siteId !== tr.sourceSiteId && m.siteId !== tr.destSiteId) throw new SenderError('This transfer belongs to another site.');
  if (tr.status === 'reserved') {
    const source = ctx.db.inventory.key.find(invKey(tr.sourceSiteId, tr.ndc));
    if (!source || source.reserved < tr.quantity) throw new SenderError('Reservation is inconsistent.');
    ctx.db.inventory.key.update({ ...source, reserved: source.reserved - tr.quantity,
      revision: source.revision + 1, updatedAt: ctx.timestamp });
  }
  ctx.db.transfer.id.update({ ...tr, status: 'cancelled', updatedAt: ctx.timestamp });
  log(ctx, 'transfer.cancel', `#${tr.id}`);
});

type FdaRow = { key: string; packageNdc: string; genericName: string; companyName: string;
  presentation: string; dosageForm: string; status: string; details: string; updateDate: string; rxcui: string };

export const beginFdaSync = spacetimedb.reducer({ runId: t.string() }, (ctx, a) => {
  requireWorker(ctx);
  if (!a.runId.trim()) throw new SenderError('Run ID is required.');
  const old = ctx.db.syncState.id.find(SYNC_ID);
  if (!old) throw new SenderError('Set up the network first.');
  ctx.db.syncState.id.update({ ...old, runId: a.runId, status: 'running', recordCount: 0 });
  log(ctx, 'fda.sync.start', a.runId);
});

export const importFdaBatch = spacetimedb.reducer({ runId: t.string(), rowsJson: t.string() }, (ctx, a) => {
  requireWorker(ctx);
  const sync = ctx.db.syncState.id.find(SYNC_ID);
  if (!sync || sync.status !== 'running' || sync.runId !== a.runId) throw new SenderError('No matching FDA import run.');
  let rows: FdaRow[];
  try { rows = JSON.parse(a.rowsJson) as FdaRow[]; }
  catch { throw new SenderError('FDA batch must be JSON.'); }
  if (!Array.isArray(rows) || rows.length > 100) throw new SenderError('FDA batch must contain at most 100 rows.');
  for (const r of rows) {
    if (!r.key || !r.genericName || !r.status) throw new SenderError('FDA row is missing required fields.');
    const old = ctx.db.shortage.key.find(r.key);
    const row = { key: r.key, packageNdc: r.packageNdc ?? '', genericName: r.genericName,
      companyName: r.companyName ?? '', presentation: r.presentation ?? '', dosageForm: r.dosageForm ?? '',
      status: r.status, details: r.details ?? '', updateDate: r.updateDate ?? '', rxcui: r.rxcui ?? '',
      runId: a.runId, active: true, observedAt: ctx.timestamp };
    if (old) ctx.db.shortage.key.update(row);
    else ctx.db.shortage.insert(row);
  }
  ctx.db.syncState.id.update({ ...sync, recordCount: sync.recordCount + rows.length });
});

export const finishFdaSync = spacetimedb.reducer({ runId: t.string(), feedDate: t.string() }, (ctx, a) => {
  requireWorker(ctx);
  const sync = ctx.db.syncState.id.find(SYNC_ID);
  if (!sync || sync.status !== 'running' || sync.runId !== a.runId) throw new SenderError('No matching FDA import run.');
  for (const row of ctx.db.shortage.iter()) {
    if (row.active && row.runId !== a.runId) ctx.db.shortage.key.update({ ...row, active: false });
  }
  ctx.db.syncState.id.update({ ...sync, status: 'complete', feedDate: a.feedDate, completedAt: ctx.timestamp });
  log(ctx, 'fda.sync.complete', `${sync.recordCount} records; feed ${a.feedDate}`);
});

export const writeForecast = spacetimedb.reducer(
  { inventoryKey: t.string(), inventoryRevision: t.u32(), ratePerDay: t.f64(),
    daysP10: t.f64(), daysMedian: t.f64(), daysP90: t.f64(), risk: t.string(), explanation: t.string() },
  (ctx, a) => {
    requireWorker(ctx);
    const item = ctx.db.inventory.key.find(a.inventoryKey);
    if (!item || item.revision !== a.inventoryRevision) throw new SenderError('Forecast input is stale.');
    if (!['unknown', 'stable', 'watch', 'critical'].includes(a.risk)) throw new SenderError('Unknown forecast risk.');
    for (const x of [a.ratePerDay, a.daysP10, a.daysMedian, a.daysP90]) nonnegative(x, 'Forecast value');
    const row = { key: a.inventoryKey, inventoryRevision: a.inventoryRevision, computedAt: ctx.timestamp,
      ratePerDay: a.ratePerDay, daysP10: a.daysP10, daysMedian: a.daysMedian, daysP90: a.daysP90,
      risk: a.risk, explanation: a.explanation };
    if (ctx.db.forecast.key.find(a.inventoryKey)) ctx.db.forecast.key.update(row);
    else ctx.db.forecast.insert(row);
  }
);

export const proposeTransfer = spacetimedb.reducer(
  { key: t.string(), sourceSiteId: t.u32(), destSiteId: t.u32(), packageNdc: t.string(),
    quantity: t.f64(), reason: t.string() },
  (ctx, a) => {
    requireWorker(ctx);
    if (a.sourceSiteId === a.destSiteId) throw new SenderError('Choose different sites.');
    positive(a.quantity, 'Quantity');
    const code = ndc(a.packageNdc);
    const source = ctx.db.inventory.key.find(invKey(a.sourceSiteId, code));
    const dest = ctx.db.inventory.key.find(invKey(a.destSiteId, code));
    if (!source || !dest || !ctx.db.site.id.find(a.destSiteId)) throw new SenderError('Both sites must stock the product.');
    if (source.onHand - source.reserved - source.safetyStock < a.quantity) throw new SenderError('Proposed quantity exceeds source surplus.');
    if (ctx.db.proposal.key.find(a.key)) return;
    ctx.db.proposal.insert({ key: a.key, sourceSiteId: a.sourceSiteId, destSiteId: a.destSiteId,
      ndc: code, quantity: a.quantity, reason: a.reason, status: 'pending', createdAt: ctx.timestamp });
    log(ctx, 'agent.propose', `${a.key}: ${a.quantity} ${source.unit}`);
  }
);

export const acceptProposal = spacetimedb.reducer({ key: t.string() }, (ctx, a) => {
  const p = ctx.db.proposal.key.find(a.key);
  if (!p || p.status !== 'pending') throw new SenderError('Proposal is not pending.');
  requireSite(ctx, p.destSiteId);
  requestTransfer(ctx, p.sourceSiteId, p.destSiteId, p.ndc, p.quantity, `Agent proposal: ${p.reason}`);
  ctx.db.proposal.key.update({ ...p, status: 'accepted' });
  log(ctx, 'agent.accept', a.key);
});

export const dismissProposal = spacetimedb.reducer({ key: t.string() }, (ctx, a) => {
  const p = ctx.db.proposal.key.find(a.key);
  if (!p || p.status !== 'pending') throw new SenderError('Proposal is not pending.');
  requireSite(ctx, p.destSiteId);
  ctx.db.proposal.key.update({ ...p, status: 'dismissed' });
  log(ctx, 'agent.dismiss', a.key);
});
