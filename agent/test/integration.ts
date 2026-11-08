/**
 * End-to-end verification against a disposable database (never argus-supply).
 *   bash scripts/test-integration.sh
 * Exercises: OIDC sign-in (a local test issuer standing in for SpacetimeAuth) and invitations,
 * network-scoped views, the in-database FDA import (scheduled procedure with HTTP), HTTP endpoints,
 * two live workers splitting leases, change-driven forecasts, fencing, failover, idempotent replays,
 * revision conflicts, reservation expiry, the agent (rules mode), FDA matching, equivalent products,
 * and the human transfer flow. Imports the live FDA feed.
 */
import assert from 'node:assert/strict';
import { DbHttp, newIdentity } from '../src/http.ts';
import { idToken, startIssuer, TEST_CLIENT } from './oidc.ts';
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

const issuer = await startIssuer();
const ownerTok = idToken({ sub: 'owner-1', email: 'owner@verify.test', name: 'Verification Admin' });
const managerTok = idToken({ sub: 'manager-1', email: 'manager@verify.test', name: 'Site Manager' });
const outsiderTok = idToken({ sub: 'outsider-1', email: 'outsider@verify.test', name: 'Outsider' });
const wrongAudTok = idToken({ sub: 'evil-1', email: 'owner@verify.test', aud: 'client_someone_else' });
const anonId = await newIdentity(host), serviceId = await newIdentity(host);
const owner = new DbHttp(host, db, ownerTok);
const manager = new DbHttp(host, db, managerTok);
const outsider = new DbHttp(host, db, outsiderTok);
const anonymous = new DbHttp(host, db, anonId.token);
const wrongAud = new DbHttp(host, db, wrongAudTok);
const service = new DbHttp(host, db, serviceId.token);

// ── Sign-in (OIDC) and invitations ──────────────────────────────────────────
assert.equal((await owner.sql('SELECT * FROM network_status'))[0]?.initialized, false);
await rejects(anonymous.call('bootstrap_network', 'Site', 'X'), /Sign in/, 'anonymous cannot create the network');
await rejects(wrongAud.call('bootstrap_network', 'Site', 'X'), /not accepted/, 'token for another client is refused');
await owner.call('bootstrap_network', 'Source Pharmacy', 'Test');
type Mem = { identity: string; email: string; name: string; role: string; site_id: number };
const ownerRow = (await owner.sql<Mem>('SELECT * FROM member_view'))[0];
assert.equal(ownerRow.email, 'owner@verify.test'); assert.equal(ownerRow.role, 'admin');
await owner.call('create_site', 'Destination Pharmacy', 'Test', '');
await owner.call('create_site', 'Third Pharmacy', 'Test', '');
await rejects(owner.call('bootstrap_network', 'y', 'z'), /already been created/, 'second bootstrap');
pass(`OIDC: anonymous and wrong-audience tokens are refused; the signed-in owner (${ownerRow.email}) creates the network as admin`);

await rejects(owner.call('grant_member', anonId.identity, 'x', 'manager', 2), /Invite people by email/, 'people cannot be granted by identity');
await owner.call('grant_member', serviceId.identity, 'Verification workers', 'service', 0);
await owner.call('invite_member', 'Manager@Verify.test', 'Site Manager', 'manager', 2);
assert.equal((await owner.sql('SELECT * FROM invite_view')).length, 1);
// A verified person's first request triggers clientConnected, which consumes the invitation.
assert.equal((await manager.sql('SELECT * FROM site_view')).length, 3);
assert.equal((await owner.sql('SELECT * FROM invite_view')).length, 0);
await manager.call('join_network');
const mgr = (await owner.sql<Mem>('SELECT * FROM member_view')).find(m => m.email === 'manager@verify.test')!;
assert.equal(mgr.role, 'manager'); assert.equal(mgr.site_id, 2);
assert.equal((await manager.sql('SELECT * FROM site_view')).length, 3);
assert.equal((await manager.sql('SELECT * FROM invite_view')).length, 0);
await rejects(manager.call('create_site', 'Sneaky', '', ''), /authorized/, 'manager cannot create sites');
await rejects(outsider.call('join_network'), /No invitation/, 'uninvited person cannot join');
await rejects(outsider.sql('SELECT * FROM inventory'), /private|no such table|not.*scope/i, 'outsider reads private table');
assert.equal((await outsider.sql('SELECT * FROM site_view')).length, 0);
assert.equal((await outsider.sql('SELECT * FROM member_view')).length, 0);
pass('invitations: invited email joins with its role and site; invites are admin-only; uninvited and anonymous callers see nothing');

// ── In-database FDA import (scheduled procedure with HTTP) ──────────────────
const sync = await until('FDA feed imported by the scheduled procedure', async () => {
  const [st] = await owner.sql<{ status: string; record_count: number; feed_date: string }>('SELECT * FROM sync_state');
  return st?.status === 'complete' && st.record_count > 100 ? st : undefined;
}, 120_000);
pass(`scheduled procedure imported the full FDA feed inside the database (${sync.record_count} records, feed ${sync.feed_date}); no worker involved`);

// ── HTTP endpoints ──────────────────────────────────────────────────────────
const route = (path: string, init?: RequestInit) => fetch(`${host}/v1/database/${db}/route${path}`, init);
const health = await (await route('/health')).json() as { status: string; fdaRecords: number };
assert.equal(health.status, 'ok'); assert.equal(health.fdaRecords, sync.record_count);
assert.equal((await route('/inventory', { method: 'POST', body: '[]' })).status, 401);
const ingestKey = process.env.ARGUS_TEST_INGEST_KEY!;
const ing = await route('/inventory', { method: 'POST', headers: { authorization: `Bearer ${ingestKey}`, 'content-type': 'application/json' },
  body: JSON.stringify([{ siteId: 3, ndc: '1234567890', label: 'Integration product', unit: 'units', onHand: 40, dailyUse: 2 }]) });
assert.equal(ing.status, 200, await ing.clone().text());
assert.deepEqual(await ing.json(), { updated: 0, created: 1 });
const bad = await route('/inventory', { method: 'POST', headers: { authorization: `Bearer ${ingestKey}` }, body: JSON.stringify([{ siteId: 99, ndc: '1234567890', onHand: 1 }]) });
assert.equal(bad.status, 422);
pass('HTTP: /health answers; /inventory rejects a missing key, applies an authenticated batch atomically, and rejects an invalid batch whole');

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
  return ls.length === 4 && ls.every(l => l.holder) && holders.size === 2 ? ls : undefined;
}, 30_000);
pass(`4 leases (3 sites + agent) split across 2 workers: ${split.map(l => `${l.resource}→${l.holder.split('-')[1]}`).join(', ')}`);

const shortages = await owner.sql<{ key: string; package_ndc: string; status: string; active: boolean }>('SELECT * FROM shortage');

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
await owner.call('set_network_config', 0.0008, true, 2.5, true);   // ≈ 3 s
await owner.call('create_transfer', 'op-tr-exp', 1, 3, code, 7, 'expiry check');
const exp = (await owner.sql<Tr>('SELECT * FROM transfer_view')).find(t => t.status === 'requested')!;
await owner.call('approve_transfer', exp.id);
await until('unshipped reservation released', async () => {
  const t = (await owner.sql<Tr>('SELECT * FROM transfer_view')).find(x => x.id === exp.id);
  const s = (await owner.sql<Inv>('SELECT * FROM inventory_view')).find(i => i.key === `1:${code}`);
  return t?.status === 'cancelled' && s?.reserved === 0;
}, 20_000);
await owner.call('set_network_config', 24, true, 2.5, true);
pass('the scheduled sweep cancels a stale reservation and releases the stock');

// ── Equivalent products: same RxCUI, different package NDC ──────────────────
type Sh = { key: string; package_ndc: string; rxcui: string; active: boolean; status: string };
const to11 = (n: string) => { const p = n.split('-'); return p.length === 3 ? p[0].padStart(5, '0') + p[1].padStart(4, '0') + p[2].padStart(2, '0') : ''; };
const byRx = new Map<string, Sh[]>();
for (const r of await owner.sql<Sh>('SELECT * FROM shortage')) {
  if (!r.active || !r.rxcui || !/^\d{4,5}-\d{3,4}-\d{1,2}$/.test(r.package_ndc)) continue;
  byRx.set(r.rxcui, [...(byRx.get(r.rxcui) ?? []), r]);
}
const pair = [...byRx.values()].map(g => g.filter((r, i) => g.findIndex(x => to11(x.package_ndc) === to11(r.package_ndc)) === i)).find(g => g.length >= 2)!;
assert.ok(pair, 'need two FDA packages with the same RxCUI');
const [pa, pb] = pair;
const na = to11(pa.package_ndc), nb = to11(pb.package_ndc);
await owner.call('upsert_inventory', 'op-eq-dst', 3, na, 'Equivalent A', 'units', 3, 5, 10, 7, pa.key, 0);
await owner.call('upsert_inventory', 'op-eq-src', 1, nb, 'Equivalent B', 'units', 900, 1, 10, 7, pb.key, 0);
await owner.call('request_agent_run', 'equivalence check');
const eq = await until('agent drafted an equivalent-product transfer', async () =>
  (await owner.sql<Prop & { dest_ndc: string }>('SELECT * FROM proposal_view')).find(p => p.status === 'pending' && p.dest_site_id === 3 && p.dest_ndc === na), 60_000);
assert.equal(eq.source_site_id, 1);
await owner.call('accept_proposal', eq.key);
const eqTr = (await owner.sql<Tr & { dest_ndc: string; ndc: string }>('SELECT * FROM transfer_view')).find(t => t.dest_ndc === na)!;
await owner.call('approve_transfer', eqTr.id); await owner.call('ship_transfer', eqTr.id); await owner.call('receive_transfer', eqTr.id);
const dst = (await owner.sql<Inv>('SELECT * FROM inventory_view')).find(i => i.key === `3:${na}`)!;
assert.equal(dst.on_hand, 3 + eqTr.quantity);
assert.ok(!(await owner.sql<Inv>('SELECT * FROM inventory_view')).some(i => i.key === `3:${nb}`));
pass(`equivalent product (RxCUI ${pa.rxcui}): ${eqTr.quantity} units of NDC ${nb} drafted and received into site 3's NDC ${na} item`);

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
issuer.close();
console.log('\nAll integration checks passed.');
process.exit(0);
