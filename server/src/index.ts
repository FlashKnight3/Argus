/** Argus Supply: multi-site shortage and inventory coordination.
 *
 * All mutations pass through reducers, each an atomic transaction.
 *
 * Distributed design
 * - A pool of agent workers shares the work through leases (`site:<id>`, `fda`, `agent`).
 *   Workers heartbeat; a scheduled sweep expires leases of silent workers so another
 *   worker takes over. Every lease acquisition bumps an epoch, and every worker write
 *   carries (workerId, epoch): a fencing token. A paused or partitioned worker whose
 *   lease moved on cannot overwrite newer results.
 * - Human writes carry a client operation ID. Browsers queue writes while offline and
 *   replay them; `op_receipt` makes replays idempotent. Inventory edits carry the
 *   revision the person saw, so a concurrent change is reported as a conflict rather
 *   than silently overwritten.
 * - Base tables are private. Members read through views; non-members see only the
 *   public FDA feed and `network_status`.
 *
 * Safety boundary: workers and the agent may import public notices, write derived
 * forecasts, and draft proposals/matches. Only humans reserve, ship, or receive stock.
 */
import { schema, SenderError, table, t, ScheduleAt, type InferSchema, type ReducerCtx } from 'spacetimedb/server';

// ── Tables: core ledger ─────────────────────────────────────────────────────

const site = table({ name: 'site' }, {
  id: t.u32().primaryKey().autoInc(),
  name: t.string(),
  region: t.string(),
  contact: t.string(),
  active: t.bool(),
  createdAt: t.timestamp(),
});

const member = table({ name: 'member' }, {
  identity: t.string().primaryKey(),
  name: t.string(),
  /** admin | manager | viewer | service */
  role: t.string(),
  /** 0 for an admin or service identity. */
  siteId: t.u32(),
  createdAt: t.timestamp(),
});

const inventory = table({ name: 'inventory' }, {
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
  /** Typical days from reorder to delivery under normal supply. */
  leadTimeDays: t.f64().default(7),
});

const stockEvent = table({ name: 'stock_event' }, {
  id: t.u32().primaryKey().autoInc(),
  inventoryKey: t.string(),
  /** receive | use | set | ship | transfer_receive | history (sandbox backfill) */
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

const transfer = table({ name: 'transfer' }, {
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
  /** When the reservation was made; the sweep releases reservations older than the TTL. */
  reservedAtMicros: t.i64().default(0n),
});

const forecast = table({ name: 'forecast' }, {
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
  /** P(demand during the resupply lead time exceeds free stock). */
  pStockout: t.f64().default(0),
  /** Expected resupply horizon used for pStockout, in days. */
  horizonDays: t.f64().default(0),
  /** Lead time was stretched because the item is linked to an active FDA shortage. */
  fdaAdjusted: t.bool().default(false),
  /** The demand prior was borrowed from other sites stocking the same NDC. */
  pooled: t.bool().default(false),
  workerId: t.string().default(''),
  leaseEpoch: t.u64().default(0n),
});

const proposal = table({ name: 'proposal' }, {
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
  /** Agent run that drafted this proposal (0 for legacy drafts). */
  runId: t.u32().default(0),
});

const activity = table({ name: 'activity' }, {
  id: t.u32().primaryKey().autoInc(),
  actor: t.string(),
  action: t.string(),
  detail: t.string(),
  at: t.timestamp(),
});

// ── Tables: coordination ────────────────────────────────────────────────────

const networkConfig = table({ name: 'network_config' }, {
  id: t.u32().primaryKey(),
  /** A sandbox network holds clearly labeled synthetic data only. */
  sandbox: t.bool(),
  reservationTtlHours: t.f64(),
  /** Let the agent start runs on its own when the set of critical items changes. */
  agentAutoRun: t.bool(),
});

const worker = table({ name: 'worker' }, {
  id: t.string().primaryKey(),
  identity: t.string(),
  name: t.string(),
  version: t.string(),
  /** online | offline */
  status: t.string(),
  startedAt: t.timestamp(),
  lastSeenMicros: t.i64(),
});

const lease = table({ name: 'lease' }, {
  /** site:<id> | fda | agent */
  resource: t.string().primaryKey(),
  /** Worker ID, or '' when free. */
  holder: t.string(),
  /** Fencing token: increments on every acquisition. */
  epoch: t.u64(),
  expiresAtMicros: t.i64(),
  acquiredAtMicros: t.i64(),
});

const sweepJob = table({ name: 'sweep_job' }, {
  scheduledId: t.u64().primaryKey().autoInc(),
  scheduledAt: t.scheduleAt(),
});

const opReceipt = table({ name: 'op_receipt' }, {
  opId: t.string().primaryKey(),
  actor: t.string(),
  reducer: t.string(),
  atMicros: t.i64(),
});

const agentRun = table({ name: 'agent_run' }, {
  id: t.u32().primaryKey().autoInc(),
  /** manual | auto */
  trigger: t.string(),
  requestedBy: t.string(),
  note: t.string(),
  /** queued | running | done | failed */
  status: t.string(),
  /** llm | rules (set when claimed) */
  mode: t.string(),
  workerId: t.string(),
  attempts: t.u32(),
  summary: t.string(),
  proposals: t.u32(),
  matches: t.u32(),
  createdAt: t.timestamp(),
  finishedAtMicros: t.i64(),
});

const agentStep = table({ name: 'agent_step' }, {
  id: t.u32().primaryKey().autoInc(),
  runId: t.u32().index('btree'),
  /** plan | thought | tool_call | tool_result | final | error */
  kind: t.string(),
  tool: t.string(),
  content: t.string(),
  at: t.timestamp(),
});

const matchSuggestion = table({ name: 'match_suggestion' }, {
  key: t.string().primaryKey(),
  inventoryKey: t.string(),
  shortageKey: t.string(),
  confidence: t.f64(),
  rationale: t.string(),
  /** pending | accepted | dismissed */
  status: t.string(),
  runId: t.u32(),
  createdAt: t.timestamp(),
});

const modelMetric = table({ name: 'model_metric' }, {
  /** site:<id> */
  key: t.string().primaryKey(),
  siteId: t.u32(),
  itemsEvaluated: t.u32(),
  windows: t.u32(),
  /** Share of held-out 7-day demand windows inside the predicted 80% interval. */
  coverage80: t.f64(),
  meanAbsError: t.f64(),
  /** Mean (predicted − actual) 7-day demand; positive means over-forecasting. */
  bias: t.f64(),
  workerId: t.string(),
  computedAt: t.timestamp(),
});

const spacetimedb = schema({
  site, member, inventory, stockEvent, shortage, syncState, transfer, forecast, proposal, activity,
  networkConfig, worker, lease, sweepJob, opReceipt, agentRun, agentStep, matchSuggestion, modelMetric,
});
export default spacetimedb;

type Ctx = ReducerCtx<InferSchema<typeof spacetimedb>>;
const SYNC_ID = 1;
const CONFIG_ID = 1;
const SECOND = 1_000_000n;
const LEASE_TTL_US = 10n * SECOND;
const WORKER_OFFLINE_US = 10n * SECOND;
const WORKER_FORGET_US = 60n * SECOND;
const SWEEP_INTERVAL_US = 2n * SECOND;
const RECEIPT_RETENTION_US = 7n * 86_400n * SECOND;
const MAX_AGENT_ATTEMPTS = 3;

// ── Helpers ─────────────────────────────────────────────────────────────────

function caller(ctx: Ctx): string { return ctx.sender.toHexString(); }
function now(ctx: Ctx): bigint { return ctx.timestamp.microsSinceUnixEpoch; }
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
function config(ctx: Ctx) {
  const row = ctx.db.networkConfig.id.find(CONFIG_ID);
  if (row) return row;
  return ctx.db.networkConfig.insert({ id: CONFIG_ID, sandbox: false, reservationTtlHours: 24, agentAutoRun: true });
}
function ensureSweep(ctx: Ctx) {
  for (const _job of ctx.db.sweepJob.iter()) return;
  ctx.db.sweepJob.insert({ scheduledId: 0n, scheduledAt: ScheduleAt.interval(SWEEP_INTERVAL_US) });
}
/** Idempotency: returns false when this client operation was already applied. */
function firstApply(ctx: Ctx, opId: string, reducer: string): boolean {
  const id = opId.trim();
  if (!id) return true;
  if (id.length > 80) throw new SenderError('Operation ID is too long.');
  if (ctx.db.opReceipt.opId.find(id)) return false;
  ctx.db.opReceipt.insert({ opId: id, actor: caller(ctx), reducer, atMicros: now(ctx) });
  return true;
}
function siteResource(siteId: number) { return `site:${siteId}`; }
function validResource(ctx: Ctx, resource: string): boolean {
  if (resource === 'fda' || resource === 'agent') return true;
  const m = /^site:(\d+)$/.exec(resource);
  return !!m && !!ctx.db.site.id.find(Number(m[1]));
}
/** The caller must be a live service/admin worker holding `resource` at exactly `epoch`. */
function requireLease(ctx: Ctx, workerId: string, resource: string, epoch: bigint) {
  requireRole(ctx, 'admin', 'service');
  const w = ctx.db.worker.id.find(workerId);
  if (!w || w.identity !== caller(ctx)) throw new SenderError('Unknown worker for this identity.');
  const l = ctx.db.lease.resource.find(resource);
  if (!l || l.holder !== workerId || l.epoch !== epoch || l.expiresAtMicros <= now(ctx))
    throw new SenderError(`Fenced: ${workerId} no longer holds ${resource} at epoch ${epoch}.`);
}
function releaseReservation(ctx: Ctx, tr: { sourceSiteId: number; ndc: string; quantity: number }) {
  const source = ctx.db.inventory.key.find(invKey(tr.sourceSiteId, tr.ndc));
  if (!source || source.reserved < tr.quantity) throw new SenderError('Reservation is inconsistent.');
  ctx.db.inventory.key.update({ ...source, reserved: source.reserved - tr.quantity,
    revision: source.revision + 1, updatedAt: ctx.timestamp });
}

// ── Lifecycle and scheduled sweep ───────────────────────────────────────────

export const init = spacetimedb.init(ctx => {
  // The first operator explicitly creates the network. No synthetic stock is seeded.
  ensureSweep(ctx);
});

export const onConnect = spacetimedb.clientConnected(ctx => { ensureSweep(ctx); });

export const sweep = spacetimedb.reducer({ onSchedule: sweepJob }, { arg: sweepJob.rowType }, (ctx, _a) => {
  const t0 = now(ctx);
  for (const l of [...ctx.db.lease.iter()]) {
    if (l.holder && l.expiresAtMicros <= t0) ctx.db.lease.resource.update({ ...l, holder: '' });
  }
  const offline = new Set<string>();
  for (const w of [...ctx.db.worker.iter()]) {
    const stale = t0 - w.lastSeenMicros > WORKER_OFFLINE_US;
    if (stale) offline.add(w.id);
    if (stale && w.status !== 'offline') {
      ctx.db.worker.id.update({ ...w, status: 'offline' });
      ctx.db.activity.insert({ id: 0, actor: w.identity, action: 'worker.offline', detail: `${w.name} (${w.id}) missed heartbeats`, at: ctx.timestamp });
    }
  }
  // Forget workers that have been gone for a while (each restart registers a new worker ID).
  // Their leases have long expired; any run they left behind is re-queued below.
  for (const w of [...ctx.db.worker.iter()]) {
    if (t0 - w.lastSeenMicros > WORKER_FORGET_US) ctx.db.worker.id.delete(w.id);
  }
  for (const run of [...ctx.db.agentRun.iter()]) {
    if (run.status !== 'running' || (!offline.has(run.workerId) && ctx.db.worker.id.find(run.workerId))) continue;
    const retry = run.attempts < MAX_AGENT_ATTEMPTS;
    ctx.db.agentRun.id.update({ ...run, status: retry ? 'queued' : 'failed', workerId: retry ? '' : run.workerId,
      summary: retry ? run.summary : 'Worker was lost repeatedly; run abandoned.', finishedAtMicros: retry ? 0n : t0 });
    ctx.db.agentStep.insert({ id: 0, runId: run.id, kind: 'error', tool: '',
      content: retry ? `Worker ${run.workerId} went silent; run re-queued for another worker.` : 'Worker lost; giving up after retries.', at: ctx.timestamp });
  }
  const ttlUs = BigInt(Math.round(config(ctx).reservationTtlHours * 3600)) * SECOND;
  if (ttlUs > 0n) {
    for (const tr of [...ctx.db.transfer.iter()]) {
      if (tr.status !== 'reserved' || tr.reservedAtMicros <= 0n || t0 - tr.reservedAtMicros < ttlUs) continue;
      releaseReservation(ctx, tr);
      ctx.db.transfer.id.update({ ...tr, status: 'cancelled', reason: `${tr.reason} [reservation expired]`.trim(), updatedAt: ctx.timestamp });
      ctx.db.activity.insert({ id: 0, actor: 'system', action: 'transfer.expire', detail: `#${tr.id}: unshipped reservation released`, at: ctx.timestamp });
    }
  }
  for (const r of [...ctx.db.opReceipt.iter()]) {
    if (t0 - r.atMicros > RECEIPT_RETENTION_US) ctx.db.opReceipt.opId.delete(r.opId);
  }
});

// ── Network setup and access ────────────────────────────────────────────────

export const bootstrapNetwork = spacetimedb.reducer(
  { ownerName: t.string(), siteName: t.string(), region: t.string() },
  (ctx, a) => {
    for (const _m of ctx.db.member.iter()) throw new SenderError('The network has already been created.');
    if (!a.ownerName.trim() || !a.siteName.trim()) throw new SenderError('Name and first site are required.');
    const s = ctx.db.site.insert({ id: 0, name: a.siteName.trim(), region: a.region.trim(), contact: '', active: true, createdAt: ctx.timestamp });
    ctx.db.member.insert({ identity: caller(ctx), name: a.ownerName.trim(), role: 'admin', siteId: 0, createdAt: ctx.timestamp });
    if (!ctx.db.syncState.id.find(SYNC_ID))
      ctx.db.syncState.insert({ id: SYNC_ID, runId: '', status: 'never', feedDate: '', recordCount: 0, completedAt: ctx.timestamp });
    config(ctx);
    ensureSweep(ctx);
    log(ctx, 'network.bootstrap', `Created ${s.name}`);
  }
);

/** Creates a network flagged as a sandbox: synthetic data, open admin claims, history backfill. */
export const bootstrapSandbox = spacetimedb.reducer({ ownerName: t.string() }, (ctx, a) => {
  for (const _m of ctx.db.member.iter()) throw new SenderError('The network has already been created.');
  ctx.db.member.insert({ identity: caller(ctx), name: a.ownerName.trim() || 'Sandbox seeder', role: 'admin', siteId: 0, createdAt: ctx.timestamp });
  if (!ctx.db.syncState.id.find(SYNC_ID))
    ctx.db.syncState.insert({ id: SYNC_ID, runId: '', status: 'never', feedDate: '', recordCount: 0, completedAt: ctx.timestamp });
  const c = config(ctx);
  ctx.db.networkConfig.id.update({ ...c, sandbox: true });
  ensureSweep(ctx);
  log(ctx, 'network.bootstrap', 'Created SANDBOX network (synthetic data only)');
});

export const claimSandboxAdmin = spacetimedb.reducer({ name: t.string() }, (ctx, a) => {
  if (!config(ctx).sandbox) throw new SenderError('Only a sandbox network allows self-service admin access.');
  if (currentMember(ctx)) return;
  ctx.db.member.insert({ identity: caller(ctx), name: a.name.trim() || 'Sandbox admin', role: 'admin', siteId: 0, createdAt: ctx.timestamp });
  log(ctx, 'member.sandbox_claim', caller(ctx).slice(0, 8));
});

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

export const revokeMember = spacetimedb.reducer({ identity: t.string() }, (ctx, a) => {
  requireRole(ctx, 'admin');
  const id = a.identity.toLowerCase();
  if (id === caller(ctx)) throw new SenderError('You cannot revoke your own access.');
  const old = ctx.db.member.identity.find(id);
  if (!old) throw new SenderError('Member not found.');
  ctx.db.member.identity.delete(id);
  log(ctx, 'member.revoke', `${id.slice(0, 8)} (${old.role})`);
});

export const setNetworkConfig = spacetimedb.reducer(
  { reservationTtlHours: t.f64(), agentAutoRun: t.bool() },
  (ctx, a) => {
    requireRole(ctx, 'admin');
    nonnegative(a.reservationTtlHours, 'Reservation TTL');
    const c = config(ctx);
    ctx.db.networkConfig.id.update({ ...c, reservationTtlHours: a.reservationTtlHours, agentAutoRun: a.agentAutoRun });
    log(ctx, 'config.update', `reservation TTL ${a.reservationTtlHours}h; agent auto-run ${a.agentAutoRun ? 'on' : 'off'}`);
  }
);

// ── Inventory (idempotent, conflict-checked) ────────────────────────────────

export const upsertInventory = spacetimedb.reducer(
  { opId: t.string(), siteId: t.u32(), packageNdc: t.string(), label: t.string(), unit: t.string(), onHand: t.f64(),
    baselineDaily: t.f64(), safetyStock: t.f64(), leadTimeDays: t.f64(), shortageKey: t.string(), expectedRevision: t.u32() },
  (ctx, a) => {
    requireSite(ctx, a.siteId);
    if (!firstApply(ctx, a.opId, 'upsert_inventory')) return;
    nonnegative(a.onHand, 'On-hand stock');
    nonnegative(a.baselineDaily, 'Daily usage');
    nonnegative(a.safetyStock, 'Safety stock');
    positive(a.leadTimeDays, 'Lead time');
    if (!a.label.trim() || !a.unit.trim()) throw new SenderError('Product name and unit are required.');
    const code = ndc(a.packageNdc);
    const key = invKey(a.siteId, code);
    const old = ctx.db.inventory.key.find(key);
    if ((old?.revision ?? 0) !== a.expectedRevision)
      throw new SenderError(old
        ? `Conflict: ${old.label} changed to revision ${old.revision} since you opened it. Review the latest count and re-enter.`
        : 'Conflict: this product no longer exists at the site.');
    if (old && a.onHand < old.reserved) throw new SenderError('On-hand stock cannot fall below reservations.');
    if (a.shortageKey && !ctx.db.shortage.key.find(a.shortageKey)) throw new SenderError('FDA record not found.');
    const row = { key, siteId: a.siteId, ndc: code, label: a.label.trim(), unit: a.unit.trim(),
      onHand: a.onHand, reserved: old?.reserved ?? 0, baselineDaily: a.baselineDaily,
      safetyStock: a.safetyStock, shortageKey: a.shortageKey, revision: (old?.revision ?? 0) + 1,
      updatedAt: ctx.timestamp, leadTimeDays: a.leadTimeDays };
    if (old) ctx.db.inventory.key.update(row);
    else ctx.db.inventory.insert(row);
    stockLog(ctx, key, 'set', a.onHand - (old?.onHand ?? 0), old ? 'Inventory corrected' : 'Opening inventory');
    log(ctx, 'inventory.upsert', `${key}: ${a.onHand} ${row.unit}`);
  }
);

export const recordStock = spacetimedb.reducer(
  { opId: t.string(), inventoryKey: t.string(), kind: t.string(), quantity: t.f64(), note: t.string() },
  (ctx, a) => {
    const item = ctx.db.inventory.key.find(a.inventoryKey);
    if (!item) throw new SenderError('Inventory item not found.');
    requireSite(ctx, item.siteId);
    if (!firstApply(ctx, a.opId, 'record_stock')) return;
    if (a.kind !== 'receive' && a.kind !== 'use') throw new SenderError('Choose receive or use.');
    positive(a.quantity, 'Quantity');
    if (a.kind === 'use' && a.quantity > item.onHand - item.reserved) throw new SenderError('Not enough unreserved stock.');
    const delta = a.kind === 'use' ? -a.quantity : a.quantity;
    ctx.db.inventory.key.update({ ...item, onHand: item.onHand + delta, revision: item.revision + 1, updatedAt: ctx.timestamp });
    stockLog(ctx, item.key, a.kind, delta, a.note.trim());
    log(ctx, `stock.${a.kind}`, `${item.key}: ${delta} ${item.unit}`);
  }
);

/** Sandbox only: backfill dated usage history so forecasts and calibration have data. */
export const sandboxSeedHistory = spacetimedb.reducer({ inventoryKey: t.string(), eventsJson: t.string() }, (ctx, a) => {
  requireRole(ctx, 'admin');
  if (!config(ctx).sandbox) throw new SenderError('History backfill is only allowed in a sandbox network.');
  const item = ctx.db.inventory.key.find(a.inventoryKey);
  if (!item) throw new SenderError('Inventory item not found.');
  let events: Array<{ daysAgo: number; quantity: number }>;
  try { events = JSON.parse(a.eventsJson); } catch { throw new SenderError('History must be JSON.'); }
  if (!Array.isArray(events) || events.length > 400) throw new SenderError('At most 400 history events per call.');
  const Ts = ctx.timestamp.constructor as new (micros: bigint) => typeof ctx.timestamp;
  for (const e of events) {
    if (!(e.daysAgo > 0 && e.daysAgo <= 120) || !(e.quantity > 0)) throw new SenderError('Invalid history event.');
    const at = new Ts(now(ctx) - BigInt(Math.round(e.daysAgo * 86_400)) * SECOND);
    ctx.db.stockEvent.insert({ id: 0, inventoryKey: item.key, kind: 'use', delta: -e.quantity,
      note: 'Synthetic sandbox history', actor: caller(ctx), at });
  }
  log(ctx, 'sandbox.history', `${item.key}: ${events.length} synthetic usage events`);
});

// ── Transfers ───────────────────────────────────────────────────────────────

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
    createdAt: ctx.timestamp, updatedAt: ctx.timestamp, reservedAtMicros: 0n });
  log(ctx, 'transfer.request', `#${row.id}: ${quantity} ${source.unit} ${source.label}, ${sourceSiteId} → ${destSiteId}`);
}

export const createTransfer = spacetimedb.reducer(
  { opId: t.string(), sourceSiteId: t.u32(), destSiteId: t.u32(), packageNdc: t.string(), quantity: t.f64(), reason: t.string() },
  (ctx, a) => {
    requireSite(ctx, a.destSiteId);
    if (!firstApply(ctx, a.opId, 'create_transfer')) return;
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
  ctx.db.transfer.id.update({ ...tr, status: 'reserved', approvedBy: caller(ctx), updatedAt: ctx.timestamp, reservedAtMicros: now(ctx) });
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
    shortageKey: source.shortageKey, revision: 1, updatedAt: ctx.timestamp, leadTimeDays: source.leadTimeDays });
  stockLog(ctx, key, 'transfer_receive', tr.quantity, `Transfer #${tr.id}`);
  ctx.db.transfer.id.update({ ...tr, status: 'received', updatedAt: ctx.timestamp });
  log(ctx, 'transfer.receive', `#${tr.id}`);
});

export const cancelTransfer = spacetimedb.reducer({ transferId: t.u32() }, (ctx, a) => {
  const tr = ctx.db.transfer.id.find(a.transferId);
  if (!tr || !['requested', 'reserved'].includes(tr.status)) throw new SenderError('Only unshipped transfers can be cancelled.');
  const m = requireRole(ctx, 'admin', 'manager');
  if (m.role !== 'admin' && m.siteId !== tr.sourceSiteId && m.siteId !== tr.destSiteId) throw new SenderError('This transfer belongs to another site.');
  if (tr.status === 'reserved') releaseReservation(ctx, tr);
  ctx.db.transfer.id.update({ ...tr, status: 'cancelled', updatedAt: ctx.timestamp });
  log(ctx, 'transfer.cancel', `#${tr.id}`);
});

// ── Workers, leases, fencing ────────────────────────────────────────────────

export const workerHeartbeat = spacetimedb.reducer(
  { workerId: t.string(), name: t.string(), version: t.string() },
  (ctx, a) => {
    requireRole(ctx, 'admin', 'service');
    if (!/^[a-zA-Z0-9._:-]{3,64}$/.test(a.workerId)) throw new SenderError('Invalid worker ID.');
    ensureSweep(ctx);
    const t0 = now(ctx);
    const old = ctx.db.worker.id.find(a.workerId);
    if (old && old.identity !== caller(ctx)) throw new SenderError('Worker ID belongs to another identity.');
    if (old) ctx.db.worker.id.update({ ...old, name: a.name, version: a.version, status: 'online', lastSeenMicros: t0 });
    else {
      ctx.db.worker.insert({ id: a.workerId, identity: caller(ctx), name: a.name, version: a.version, status: 'online', startedAt: ctx.timestamp, lastSeenMicros: t0 });
      log(ctx, 'worker.online', `${a.name} (${a.workerId})`);
    }
    if (old && old.status === 'offline') log(ctx, 'worker.online', `${a.name} (${a.workerId}) reconnected`);
    for (const l of [...ctx.db.lease.iter()]) {
      if (l.holder === a.workerId && l.expiresAtMicros > t0) ctx.db.lease.resource.update({ ...l, expiresAtMicros: t0 + LEASE_TTL_US });
    }
  }
);

export const acquireLease = spacetimedb.reducer({ workerId: t.string(), resource: t.string() }, (ctx, a) => {
  requireRole(ctx, 'admin', 'service');
  const w = ctx.db.worker.id.find(a.workerId);
  if (!w || w.identity !== caller(ctx) || w.status !== 'online') throw new SenderError('Heartbeat before acquiring leases.');
  if (!validResource(ctx, a.resource)) throw new SenderError('Unknown lease resource.');
  const t0 = now(ctx);
  const old = ctx.db.lease.resource.find(a.resource);
  if (old && old.holder && old.holder !== a.workerId && old.expiresAtMicros > t0) throw new SenderError(`Lease held by ${old.holder}.`);
  if (old && old.holder === a.workerId && old.expiresAtMicros > t0) {
    ctx.db.lease.resource.update({ ...old, expiresAtMicros: t0 + LEASE_TTL_US });
    return;
  }
  const row = { resource: a.resource, holder: a.workerId, epoch: (old?.epoch ?? 0n) + 1n, expiresAtMicros: t0 + LEASE_TTL_US, acquiredAtMicros: t0 };
  if (old) ctx.db.lease.resource.update(row);
  else ctx.db.lease.insert(row);
  log(ctx, 'lease.acquire', `${a.resource} → ${w.name} (epoch ${row.epoch}${old?.holder ? `, taken over from ${old.holder}` : ''})`);
});

export const releaseLease = spacetimedb.reducer({ workerId: t.string(), resource: t.string() }, (ctx, a) => {
  requireRole(ctx, 'admin', 'service');
  const w = ctx.db.worker.id.find(a.workerId);
  if (!w || w.identity !== caller(ctx)) throw new SenderError('Unknown worker for this identity.');
  const l = ctx.db.lease.resource.find(a.resource);
  if (!l || l.holder !== a.workerId) return;
  ctx.db.lease.resource.update({ ...l, holder: '', expiresAtMicros: now(ctx) });
  log(ctx, 'lease.release', `${a.resource} released by ${w.name} for rebalancing`);
});

// ── FDA import (fenced by the `fda` lease, or an admin in the browser) ──────

function requireImporter(ctx: Ctx, workerId: string, epoch: bigint) {
  if (workerId) requireLease(ctx, workerId, 'fda', epoch);
  else requireRole(ctx, 'admin');
}

export const beginFdaSync = spacetimedb.reducer({ runId: t.string(), workerId: t.string(), leaseEpoch: t.u64() }, (ctx, a) => {
  requireImporter(ctx, a.workerId, a.leaseEpoch);
  if (!a.runId.trim()) throw new SenderError('Run ID is required.');
  const old = ctx.db.syncState.id.find(SYNC_ID);
  if (!old) throw new SenderError('Set up the network first.');
  ctx.db.syncState.id.update({ ...old, runId: a.runId, status: 'running', recordCount: 0 });
  log(ctx, 'fda.sync.start', a.runId);
});

type FdaRow = { key: string; packageNdc: string; genericName: string; companyName: string;
  presentation: string; dosageForm: string; status: string; details: string; updateDate: string; rxcui: string };

export const importFdaBatch = spacetimedb.reducer(
  { runId: t.string(), rowsJson: t.string(), workerId: t.string(), leaseEpoch: t.u64() },
  (ctx, a) => {
    requireImporter(ctx, a.workerId, a.leaseEpoch);
    const sync = ctx.db.syncState.id.find(SYNC_ID);
    if (!sync || sync.status !== 'running' || sync.runId !== a.runId) throw new SenderError('No matching FDA import run.');
    let rows: FdaRow[];
    try { rows = JSON.parse(a.rowsJson) as FdaRow[]; }
    catch { throw new SenderError('FDA batch must be JSON.'); }
    if (!Array.isArray(rows) || rows.length > 200) throw new SenderError('FDA batch must contain at most 200 rows.');
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
  }
);

export const finishFdaSync = spacetimedb.reducer(
  { runId: t.string(), feedDate: t.string(), workerId: t.string(), leaseEpoch: t.u64() },
  (ctx, a) => {
    requireImporter(ctx, a.workerId, a.leaseEpoch);
    const sync = ctx.db.syncState.id.find(SYNC_ID);
    if (!sync || sync.status !== 'running' || sync.runId !== a.runId) throw new SenderError('No matching FDA import run.');
    for (const row of [...ctx.db.shortage.iter()]) {
      if (row.active && row.runId !== a.runId) ctx.db.shortage.key.update({ ...row, active: false });
    }
    ctx.db.syncState.id.update({ ...sync, status: 'complete', feedDate: a.feedDate, completedAt: ctx.timestamp });
    log(ctx, 'fda.sync.complete', `${sync.recordCount} records; feed ${a.feedDate}`);
  }
);

// ── Forecasts and calibration (fenced by the site lease) ────────────────────

export const writeForecast = spacetimedb.reducer(
  { workerId: t.string(), leaseEpoch: t.u64(), inventoryKey: t.string(), inventoryRevision: t.u32(), ratePerDay: t.f64(),
    daysP10: t.f64(), daysMedian: t.f64(), daysP90: t.f64(), pStockout: t.f64(), horizonDays: t.f64(),
    fdaAdjusted: t.bool(), pooled: t.bool(), risk: t.string(), explanation: t.string() },
  (ctx, a) => {
    const item = ctx.db.inventory.key.find(a.inventoryKey);
    if (!item) throw new SenderError('Forecast input is stale.');
    requireLease(ctx, a.workerId, siteResource(item.siteId), a.leaseEpoch);
    if (item.revision !== a.inventoryRevision) throw new SenderError('Forecast input is stale.');
    if (!['unknown', 'stable', 'watch', 'critical'].includes(a.risk)) throw new SenderError('Unknown forecast risk.');
    for (const x of [a.ratePerDay, a.daysP10, a.daysMedian, a.daysP90, a.horizonDays]) nonnegative(x, 'Forecast value');
    if (!(a.pStockout >= 0 && a.pStockout <= 1)) throw new SenderError('Stockout probability must be in [0, 1].');
    const row = { key: a.inventoryKey, inventoryRevision: a.inventoryRevision, computedAt: ctx.timestamp,
      ratePerDay: a.ratePerDay, daysP10: a.daysP10, daysMedian: a.daysMedian, daysP90: a.daysP90,
      risk: a.risk, explanation: a.explanation, pStockout: a.pStockout, horizonDays: a.horizonDays,
      fdaAdjusted: a.fdaAdjusted, pooled: a.pooled, workerId: a.workerId, leaseEpoch: a.leaseEpoch };
    if (ctx.db.forecast.key.find(a.inventoryKey)) ctx.db.forecast.key.update(row);
    else ctx.db.forecast.insert(row);
  }
);

export const writeModelMetric = spacetimedb.reducer(
  { workerId: t.string(), leaseEpoch: t.u64(), siteId: t.u32(), itemsEvaluated: t.u32(), windows: t.u32(),
    coverage80: t.f64(), meanAbsError: t.f64(), bias: t.f64() },
  (ctx, a) => {
    requireLease(ctx, a.workerId, siteResource(a.siteId), a.leaseEpoch);
    const row = { key: siteResource(a.siteId), siteId: a.siteId, itemsEvaluated: a.itemsEvaluated, windows: a.windows,
      coverage80: a.coverage80, meanAbsError: a.meanAbsError, bias: a.bias, workerId: a.workerId, computedAt: ctx.timestamp };
    if (ctx.db.modelMetric.key.find(row.key)) ctx.db.modelMetric.key.update(row);
    else ctx.db.modelMetric.insert(row);
  }
);

// ── Agent runs (queue → claim → steps → finish), fenced by the `agent` lease ─

function enqueueRun(ctx: Ctx, trigger: string, note: string) {
  for (const run of ctx.db.agentRun.iter()) {
    if (run.status === 'queued' || run.status === 'running') return run;
  }
  const run = ctx.db.agentRun.insert({ id: 0, trigger, requestedBy: caller(ctx), note: note.trim().slice(0, 500), status: 'queued',
    mode: '', workerId: '', attempts: 0, summary: '', proposals: 0, matches: 0, createdAt: ctx.timestamp, finishedAtMicros: 0n });
  log(ctx, 'agent.queue', `Run #${run.id} (${trigger})${note.trim() ? `: ${note.trim().slice(0, 80)}` : ''}`);
  return run;
}

export const requestAgentRun = spacetimedb.reducer({ note: t.string() }, (ctx, a) => {
  requireRole(ctx, 'admin', 'manager');
  enqueueRun(ctx, 'manual', a.note);
});

/** A worker asks for an automatic run when the set of at-risk items changes. */
export const requestAutoAgentRun = spacetimedb.reducer({ workerId: t.string(), leaseEpoch: t.u64(), note: t.string() }, (ctx, a) => {
  requireLease(ctx, a.workerId, 'agent', a.leaseEpoch);
  if (!config(ctx).agentAutoRun) return;
  enqueueRun(ctx, 'auto', a.note);
});

function requireRunOwner(ctx: Ctx, runId: number, workerId: string, epoch: bigint) {
  requireLease(ctx, workerId, 'agent', epoch);
  const run = ctx.db.agentRun.id.find(runId);
  if (!run || run.status !== 'running' || run.workerId !== workerId) throw new SenderError('This worker does not own that run.');
  return run;
}

export const claimAgentRun = spacetimedb.reducer(
  { runId: t.u32(), workerId: t.string(), leaseEpoch: t.u64(), mode: t.string() },
  (ctx, a) => {
    requireLease(ctx, a.workerId, 'agent', a.leaseEpoch);
    if (!['llm', 'rules'].includes(a.mode)) throw new SenderError('Unknown agent mode.');
    const run = ctx.db.agentRun.id.find(a.runId);
    if (!run || run.status !== 'queued') throw new SenderError('Run is not queued.');
    ctx.db.agentRun.id.update({ ...run, status: 'running', mode: a.mode, workerId: a.workerId, attempts: run.attempts + 1 });
  }
);

export const appendAgentStep = spacetimedb.reducer(
  { runId: t.u32(), workerId: t.string(), leaseEpoch: t.u64(), kind: t.string(), tool: t.string(), content: t.string() },
  (ctx, a) => {
    requireRunOwner(ctx, a.runId, a.workerId, a.leaseEpoch);
    if (!['plan', 'thought', 'tool_call', 'tool_result', 'final', 'error'].includes(a.kind)) throw new SenderError('Unknown step kind.');
    ctx.db.agentStep.insert({ id: 0, runId: a.runId, kind: a.kind, tool: a.tool.slice(0, 64), content: a.content.slice(0, 4000), at: ctx.timestamp });
  }
);

export const finishAgentRun = spacetimedb.reducer(
  { runId: t.u32(), workerId: t.string(), leaseEpoch: t.u64(), status: t.string(), summary: t.string() },
  (ctx, a) => {
    const run = requireRunOwner(ctx, a.runId, a.workerId, a.leaseEpoch);
    if (!['done', 'failed'].includes(a.status)) throw new SenderError('Finish as done or failed.');
    ctx.db.agentRun.id.update({ ...run, status: a.status, summary: a.summary.slice(0, 2000), finishedAtMicros: now(ctx) });
    log(ctx, `agent.${a.status}`, `Run #${run.id}: ${run.proposals} drafts, ${run.matches} match suggestions`);
  }
);

export const proposeTransfer = spacetimedb.reducer(
  { workerId: t.string(), leaseEpoch: t.u64(), runId: t.u32(), key: t.string(), sourceSiteId: t.u32(), destSiteId: t.u32(),
    packageNdc: t.string(), quantity: t.f64(), reason: t.string() },
  (ctx, a) => {
    const run = requireRunOwner(ctx, a.runId, a.workerId, a.leaseEpoch);
    if (a.sourceSiteId === a.destSiteId) throw new SenderError('Choose different sites.');
    positive(a.quantity, 'Quantity');
    const code = ndc(a.packageNdc);
    const source = ctx.db.inventory.key.find(invKey(a.sourceSiteId, code));
    const dest = ctx.db.inventory.key.find(invKey(a.destSiteId, code));
    if (!source || !dest || !ctx.db.site.id.find(a.destSiteId)) throw new SenderError('Both sites must stock the product.');
    if (source.unit.trim().toLowerCase() !== dest.unit.trim().toLowerCase()) throw new SenderError('Units differ between sites.');
    if (source.onHand - source.reserved - source.safetyStock < a.quantity) throw new SenderError('Proposed quantity exceeds source surplus.');
    for (const p of ctx.db.proposal.iter()) {
      if (p.status === 'pending' && p.destSiteId === a.destSiteId && p.sourceSiteId === a.sourceSiteId && p.ndc === code)
        throw new SenderError('A pending draft already covers this route.');
    }
    if (ctx.db.proposal.key.find(a.key)) return;
    ctx.db.proposal.insert({ key: a.key, sourceSiteId: a.sourceSiteId, destSiteId: a.destSiteId,
      ndc: code, quantity: a.quantity, reason: a.reason.slice(0, 1000), status: 'pending', createdAt: ctx.timestamp, runId: a.runId });
    ctx.db.agentRun.id.update({ ...run, proposals: run.proposals + 1 });
    log(ctx, 'agent.propose', `${a.key}: ${a.quantity} ${source.unit}, ${a.sourceSiteId} → ${a.destSiteId}`);
  }
);

export const suggestMatch = spacetimedb.reducer(
  { workerId: t.string(), leaseEpoch: t.u64(), runId: t.u32(), inventoryKey: t.string(), shortageKey: t.string(),
    confidence: t.f64(), rationale: t.string() },
  (ctx, a) => {
    const run = requireRunOwner(ctx, a.runId, a.workerId, a.leaseEpoch);
    const item = ctx.db.inventory.key.find(a.inventoryKey);
    if (!item) throw new SenderError('Inventory item not found.');
    if (!ctx.db.shortage.key.find(a.shortageKey)) throw new SenderError('FDA record not found.');
    if (item.shortageKey === a.shortageKey) throw new SenderError('Item is already linked to that record.');
    if (!(a.confidence >= 0 && a.confidence <= 1)) throw new SenderError('Confidence must be in [0, 1].');
    const key = `${a.inventoryKey}|${a.shortageKey}`;
    if (ctx.db.matchSuggestion.key.find(key)) return;
    ctx.db.matchSuggestion.insert({ key, inventoryKey: a.inventoryKey, shortageKey: a.shortageKey, confidence: a.confidence,
      rationale: a.rationale.slice(0, 1000), status: 'pending', runId: a.runId, createdAt: ctx.timestamp });
    ctx.db.agentRun.id.update({ ...run, matches: run.matches + 1 });
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

export const acceptMatch = spacetimedb.reducer({ key: t.string() }, (ctx, a) => {
  const s = ctx.db.matchSuggestion.key.find(a.key);
  if (!s || s.status !== 'pending') throw new SenderError('Suggestion is not pending.');
  const item = ctx.db.inventory.key.find(s.inventoryKey);
  if (!item) throw new SenderError('Inventory item not found.');
  requireSite(ctx, item.siteId);
  if (!ctx.db.shortage.key.find(s.shortageKey)) throw new SenderError('FDA record not found.');
  ctx.db.inventory.key.update({ ...item, shortageKey: s.shortageKey, revision: item.revision + 1, updatedAt: ctx.timestamp });
  ctx.db.matchSuggestion.key.update({ ...s, status: 'accepted' });
  log(ctx, 'match.accept', `${item.key} ↔ FDA ${s.shortageKey}`);
});

export const dismissMatch = spacetimedb.reducer({ key: t.string() }, (ctx, a) => {
  const s = ctx.db.matchSuggestion.key.find(a.key);
  if (!s || s.status !== 'pending') throw new SenderError('Suggestion is not pending.');
  const item = ctx.db.inventory.key.find(s.inventoryKey);
  if (!item) throw new SenderError('Inventory item not found.');
  requireSite(ctx, item.siteId);
  ctx.db.matchSuggestion.key.update({ ...s, status: 'dismissed' });
});

// ── Read access: members-only views over private tables ─────────────────────

type ViewDb = { member: { identity: { find(id: string): unknown } } };
function isMember(db: ViewDb, sender: { toHexString(): string }) { return !!db.member.identity.find(sender.toHexString()); }

export const networkStatus = spacetimedb.anonymousView(
  { name: 'network_status', public: true },
  t.array(t.object('NetworkStatusRow', { id: t.u32(), initialized: t.bool(), sandbox: t.bool() })),
  ctx => {
    let initialized = false;
    for (const _m of ctx.db.member.iter()) { initialized = true; break; }
    return [{ id: 1, initialized, sandbox: ctx.db.networkConfig.id.find(CONFIG_ID)?.sandbox ?? false }];
  }
);

export const siteView = spacetimedb.view({ name: 'site_view', public: true }, t.array(site.rowType),
  ctx => isMember(ctx.db, ctx.sender) ? [...ctx.db.site.iter()] : []);
export const memberView = spacetimedb.view({ name: 'member_view', public: true }, t.array(member.rowType),
  ctx => isMember(ctx.db, ctx.sender) ? [...ctx.db.member.iter()] : []);
export const inventoryView = spacetimedb.view({ name: 'inventory_view', public: true }, t.array(inventory.rowType),
  ctx => isMember(ctx.db, ctx.sender) ? [...ctx.db.inventory.iter()] : []);
export const stockEventView = spacetimedb.view({ name: 'stock_event_view', public: true }, t.array(stockEvent.rowType),
  ctx => isMember(ctx.db, ctx.sender) ? [...ctx.db.stockEvent.iter()] : []);
export const transferView = spacetimedb.view({ name: 'transfer_view', public: true }, t.array(transfer.rowType),
  ctx => isMember(ctx.db, ctx.sender) ? [...ctx.db.transfer.iter()] : []);
export const forecastView = spacetimedb.view({ name: 'forecast_view', public: true }, t.array(forecast.rowType),
  ctx => isMember(ctx.db, ctx.sender) ? [...ctx.db.forecast.iter()] : []);
export const proposalView = spacetimedb.view({ name: 'proposal_view', public: true }, t.array(proposal.rowType),
  ctx => isMember(ctx.db, ctx.sender) ? [...ctx.db.proposal.iter()] : []);
export const activityView = spacetimedb.view({ name: 'activity_view', public: true }, t.array(activity.rowType),
  ctx => isMember(ctx.db, ctx.sender) ? [...ctx.db.activity.iter()] : []);
export const configView = spacetimedb.view({ name: 'config_view', public: true }, t.array(networkConfig.rowType),
  ctx => isMember(ctx.db, ctx.sender) ? [...ctx.db.networkConfig.iter()] : []);
export const workerView = spacetimedb.view({ name: 'worker_view', public: true }, t.array(worker.rowType),
  ctx => isMember(ctx.db, ctx.sender) ? [...ctx.db.worker.iter()] : []);
export const leaseView = spacetimedb.view({ name: 'lease_view', public: true }, t.array(lease.rowType),
  ctx => isMember(ctx.db, ctx.sender) ? [...ctx.db.lease.iter()] : []);
export const agentRunView = spacetimedb.view({ name: 'agent_run_view', public: true }, t.array(agentRun.rowType),
  ctx => isMember(ctx.db, ctx.sender) ? [...ctx.db.agentRun.iter()] : []);
export const agentStepView = spacetimedb.view({ name: 'agent_step_view', public: true }, t.array(agentStep.rowType),
  ctx => isMember(ctx.db, ctx.sender) ? [...ctx.db.agentStep.iter()] : []);
export const matchView = spacetimedb.view({ name: 'match_view', public: true }, t.array(matchSuggestion.rowType),
  ctx => isMember(ctx.db, ctx.sender) ? [...ctx.db.matchSuggestion.iter()] : []);
export const metricView = spacetimedb.view({ name: 'metric_view', public: true }, t.array(modelMetric.rowType),
  ctx => isMember(ctx.db, ctx.sender) ? [...ctx.db.modelMetric.iter()] : []);
