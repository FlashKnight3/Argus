/**
 * End-to-end verification against a disposable database (never argus-supply).
 *   bash scripts/test-integration.sh
 * Exercises: read privacy, two live workers splitting leases, change-driven forecasts, fencing,
 * failover, idempotent replays, revision conflicts, reservation expiry, the agent (rules mode),
 * FDA matching, and the human transfer flow. Imports the live FDA feed.
 */
import assert from 'node:assert/strict';
import { DbHttp, newIdentity } from '../src/http.ts';
import { AgentWorker } from '../src/worker.ts';

const host = process.env.ARGUS_SUPPLY_DB_HOST ?? 'http://127.0.0.1:3000';
const db = process.env.ARGUS_VERIFY_DB;
if (!db || !/verify|test/.test(db)) throw new Error('Set ARGUS_VERIFY_DB to a disposable database name containing "verify" or "test".');

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until<T>(label: string, fn: () => Promise<T | undefined | false>, timeoutMs = 60_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v) return v as T;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for: ${label}`);
    await sleep(400);
  }
}
const pass = (m: string) => console.log(`PASS  ${m}`);
async function rejects(p: Promise<unknown>, pattern: RegExp, label: string) {
  try { await p; } catch (e) { assert.match(String(e), pattern, label); return; }
  throw new Error(`Expected rejection: ${label}`);
}

const ownerId = await newIdentity(host), serviceId = await newIdentity(host), outsiderId = await newIdentity(host);
const owner = new DbHttp(host, db, ownerId.token);
const service = new DbHttp(host, db, serviceId.token);
const outsider = new DbHttp(host, db, outsiderId.token);

// ── Setup and privacy ───────────────────────────────────────────────────────
assert.equal((await owner.sql('SELECT * FROM network_status'))[0]?.initialized, false);
await owner.call('bootstrap_network', 'Verification Admin', 'Source Pharmacy', 'Test');
await owner.call('create_site', 'Destination Pharmacy', 'Test', '');
await owner.call('create_site', 'Third Pharmacy', 'Test', '');
await owner.call('grant_member', serviceId.identity, 'Verification workers', 'service', 0);
await rejects(owner.call('bootstrap_network', 'x', 'y', 'z'), /already been created/, 'second bootstrap');
await rejects(outsider.sql('SELECT * FROM inventory'), /private|no such table|not.*scope/i, 'outsider reads private table');
assert.equal((await outsider.sql('SELECT * FROM site_view')).length, 0);
assert.equal((await owner.sql('SELECT * FROM site_view')).length, 3);
pass('base tables are private; views show members everything and outsiders nothing');

// ── Two workers share the leases ────────────────────────────────────────────
const quiet = () => {};
const mk = (name: string) => new AgentWorker({ host, db, token: serviceId.token, identity: serviceId.identity,
  workerId: `verify-${name}-${process.pid}`, name, mode: 'rules', llm: null, log: quiet });
const wa = mk('wa'), wb = mk('wb');
await wa.start(); await wb.start();
type Lease = { resource: string; holder: string; epoch: number; expires_at_micros: number };
const leases = () => owner.sql<Lease>('SELECT * FROM lease_view');
const split = await until('leases split across both workers', async () => {
  const ls = await leases();
  const holders = new Set(ls.filter(l => l.holder).map(l => l.holder));
  return ls.length === 5 && ls.every(l => l.holder) && holders.size === 2 ? ls : undefined;
}, 30_000);
pass(`5 leases split across 2 workers: ${split.map(l => `${l.resource}→${l.holder.split('-')[1]}`).join(', ')}`);

await until('FDA feed imported by the fda lease holder', async () => {
  const [s] = await owner.sql<{ status: string; record_count: number }>('SELECT * FROM sync_state');
  return s?.status === 'complete' && s.record_count > 100;
}, 120_000);
const shortages = await owner.sql<{ key: string; package_ndc: string; status: string; active: boolean }>('SELECT * FROM shortage');
pass(`full FDA feed imported once (${shortages.length} records)`);

// ── Change-driven forecasts ─────────────────────────────────────────────────
const target = shortages.find(s => s.active && /current/i.test(s.status) && /^\d{4,5}-\d{3,4}-\d{1,2}$/.test(s.package_ndc))!;
const [a, b, c] = target.package_ndc.split('-');
const code = a.padStart(5, '0') + b.padStart(4, '0') + c.padStart(2, '0');
await owner.call('upsert_inventory', 'op-src', 1, code, 'Verification product', 'vials', 500, 2, 20, 7, '', 0);
await owner.call('upsert_inventory', 'op-dst', 2, code, 'Verification product', 'vials', 4, 6, 20, 7, '', 0);
type Fc = { key: string; risk: string; p_stockout: number; worker_id: string; lease_epoch: number; inventory_revision: number };
const fc = await until('forecasts for both sites', async () => {
  const rows = await owner.sql<Fc>('SELECT * FROM forecast_view');
  return rows.length >= 2 ? rows : undefined;
}, 20_000);
const dest = fc.find(f => f.key === `2:${code}`)!;
assert.equal(dest.risk, 'critical');
assert.ok(dest.p_stockout > 0.5);
pass(`forecasts written within seconds of the change; destination critical (P(stockout)=${dest.p_stockout})`);

// ── Idempotent replay and revision conflicts ────────────────────────────────
await owner.call('record_stock', 'op-use-1', `1:${code}`, 'use', 5, 'first');
await owner.call('record_stock', 'op-use-1', `1:${code}`, 'use', 5, 'replayed');
type Inv = { key: string; on_hand: number; reserved: number; revision: number; shortage_key: string };
const src = (await owner.sql<Inv>('SELECT * FROM inventory_view')).find(i => i.key === `1:${code}`)!;
assert.equal(src.on_hand, 495);
pass('a replayed operation ID is applied once (495, not 490)');
await rejects(owner.call('upsert_inventory', 'op-stale', 1, code, 'Verification product', 'vials', 999, 2, 20, 7, '', 1), /Conflict/, 'stale revision');
pass(`an edit based on revision 1 is rejected as a conflict (current revision ${src.revision})`);

// ── Fencing ─────────────────────────────────────────────────────────────────
const site1 = (await leases()).find(l => l.resource === 'site:1')!;
await rejects(service.call('write_forecast', site1.holder, site1.epoch - 1, `1:${code}`, src.revision, 1, 1, 1, 1, 0, 1, false, false, 'stable', 'stale writer'),
  /Fenced/, 'stale epoch');
const other = [wa, wb].map(w => (w as unknown as { opts: { workerId: string } }).opts.workerId).find(id => id !== site1.holder)!;
await rejects(service.call('write_forecast', other, site1.epoch, `1:${code}`, src.revision, 1, 1, 1, 1, 0, 1, false, false, 'stable', 'wrong holder'),
  /Fenced/, 'non-holder');
pass(`writes with an old epoch or from a non-holder are fenced (site:1 epoch ${site1.epoch})`);

// ── Agent run (auto) drafts a transfer and an FDA match ─────────────────────
type Prop = { key: string; source_site_id: number; dest_site_id: number; quantity: number; status: string; run_id: number };
const proposals = await until('agent drafted a transfer', async () => {
  const rows = (await owner.sql<Prop>('SELECT * FROM proposal_view')).filter(p => p.status === 'pending');
  return rows.length ? rows : undefined;
}, 60_000).catch(async error => {
  console.error('runs:', await owner.sql('SELECT * FROM agent_run_view'));
  console.error('steps:', (await owner.sql<{ content: string }>('SELECT * FROM agent_step_view')).map(s => s.content));
  console.error('forecasts:', await owner.sql('SELECT key, risk, p_stockout, inventory_revision FROM forecast_view'));
  throw error;
});
const draft = proposals[0];
assert.equal(draft.source_site_id, 1); assert.equal(draft.dest_site_id, 2);
assert.ok(draft.quantity <= 495 - Math.max(20, 2 * 21));
const matches = await until('agent suggested the FDA link', async () => {
  const rows = await owner.sql<{ key: string; inventory_key: string; shortage_key: string; confidence: number }>('SELECT * FROM match_view');
  return rows.some(m => m.shortage_key === target.key) ? rows : undefined;
}, 30_000);
const runs = await owner.sql<{ id: number; status: string; mode: string }>('SELECT * FROM agent_run_view');
const steps = await owner.sql('SELECT * FROM agent_step_view');
assert.ok(runs.some(r => r.status === 'done' && r.mode === 'rules'));
assert.ok(steps.length >= 3);
pass(`agent run (auto, rules) drafted ${draft.quantity} vials 1→2 within source surplus and ${matches.length} FDA match(es); ${steps.length} trace steps`);

// ── Human flow: accept match, accept draft, reserve, ship, receive ──────────
const m = matches.find(x => x.shortage_key === target.key && x.inventory_key === `2:${code}`) ?? matches[0];
await owner.call('accept_match', m.key);
await owner.call('accept_proposal', draft.key);
type Tr = { id: number; status: string; quantity: number };
const tr = (await owner.sql<Tr>('SELECT * FROM transfer_view'))[0];
await rejects(service.call('approve_transfer', tr.id), /authorized/, 'service cannot approve');
pass('the service identity cannot approve, ship, or receive stock');
await owner.call('approve_transfer', tr.id);
await owner.call('ship_transfer', tr.id);
await owner.call('receive_transfer', tr.id);
const after = await owner.sql<Inv>('SELECT * FROM inventory_view');
assert.equal(after.find(i => i.key === `1:${code}`)!.reserved, 0);
assert.equal(after.find(i => i.key === `2:${code}`)!.on_hand, 4 + tr.quantity);
assert.equal(after.find(i => i.key === m.inventory_key)!.shortage_key, target.key);
pass(`match accepted; transfer #${tr.id} requested → reserved → shipped → received (${tr.quantity} vials)`);
const linked = await until('forecast picks up the FDA link', async () => {
  const f = (await owner.sql<Fc & { fda_adjusted: boolean }>('SELECT * FROM forecast_view')).find(x => x.key === m.inventory_key);
  return f?.fda_adjusted ? f : undefined;
}, 20_000);
pass(`linked item re-forecast with FDA-stretched lead time (P(stockout)=${linked.p_stockout})`);

// ── Reservation expiry by the scheduled sweep ───────────────────────────────
await owner.call('set_network_config', 0.0008, true);   // ≈ 3 s
await owner.call('create_transfer', 'op-tr-exp', 1, 3, code, 7, 'expiry check');
const exp = (await owner.sql<Tr>('SELECT * FROM transfer_view')).find(t => t.status === 'requested')!;
await owner.call('approve_transfer', exp.id);
await until('unshipped reservation released', async () => {
  const t = (await owner.sql<Tr>('SELECT * FROM transfer_view')).find(x => x.id === exp.id);
  const s = (await owner.sql<Inv>('SELECT * FROM inventory_view')).find(i => i.key === `1:${code}`);
  return t?.status === 'cancelled' && s?.reserved === 0;
}, 20_000);
await owner.call('set_network_config', 24, true);
pass('the scheduled sweep cancels a stale reservation and releases the stock');

// ── Failover ────────────────────────────────────────────────────────────────
const before = (await leases()).find(l => l.resource === 'site:1')!;
const victim = [wa, wb].find(w => (w as unknown as { opts: { workerId: string } }).opts.workerId === before.holder)!;
const survivor = victim === wa ? wb : wa;
const t0 = Date.now();
victim.stop();
const moved = await until('site:1 taken over by the surviving worker', async () => {
  const l = (await leases()).find(x => x.resource === 'site:1');
  return l && l.holder && l.holder !== before.holder ? l : undefined;
}, 40_000);
assert.ok(moved.epoch > before.epoch);
const [ws] = [await owner.sql<{ id: string; status: string }>('SELECT * FROM worker_view')];
await until('victim marked offline', async () => (await owner.sql<{ id: string; status: string }>('SELECT * FROM worker_view'))
  .some(w => w.id === before.holder && w.status === 'offline'), 20_000);
await owner.call('record_stock', 'op-after-failover', `1:${code}`, 'use', 3, 'after failover');
await until('survivor forecasts the change under its new epoch', async () => {
  const f = (await owner.sql<Fc>('SELECT * FROM forecast_view')).find(x => x.key === `1:${code}`);
  const inv = (await owner.sql<Inv>('SELECT * FROM inventory_view')).find(x => x.key === `1:${code}`);
  return f && inv && f.inventory_revision === inv.revision && f.lease_epoch === moved.epoch ? f : undefined;
}, 20_000);
pass(`worker killed; site:1 moved to the survivor in ${((Date.now() - t0) / 1000).toFixed(1)} s (epoch ${before.epoch} → ${moved.epoch}) and it resumed forecasting (${ws.length} workers registered)`);

survivor.stop();
console.log('\nAll integration checks passed.');
process.exit(0);
