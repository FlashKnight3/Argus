/**
 * Seeds a SANDBOX network: synthetic sites, stock, and backdated usage built around real,
 * current FDA shortage notices. Refuses to touch a database that is not flagged as a sandbox.
 *
 *   tsx agent/src/seed-sandbox.ts --db argus-supply-sandbox
 * Requires a running worker (it imports the FDA feed this seeder builds on).
 */
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { DbHttp } from './http.ts';
import { loadOrCreate, ROOT, SERVICE_TOKEN } from './identity.ts';
import { fdaTo11, isCurrent } from './ndc.ts';
import { poisson, seededRandom } from './rng.ts';

const { values } = parseArgs({ options: {
  db: { type: 'string', default: 'argus-supply-sandbox' },
  host: { type: 'string', default: process.env.ARGUS_SUPPLY_DB_HOST ?? 'http://127.0.0.1:3000' },
} });
const host = values.host!;
const db = values.db!;
if (!/sandbox|demo|test|verify/.test(db)) throw new Error(`Refusing to seed "${db}": sandbox database names must contain "sandbox".`);

const seeder = await loadOrCreate(host, resolve(ROOT, '.argus-supply/sandbox-seeder.json'));
const service = await loadOrCreate(host, SERVICE_TOKEN);
const api = new DbHttp(host, db, seeder.token);
const log = (m: string) => console.log(`[sandbox] ${m}`);

const [status] = await api.sql<{ initialized: boolean; sandbox: boolean }>('SELECT * FROM network_status');
if (status?.initialized && !status.sandbox) throw new Error(`${db} is a real (non-sandbox) network; not seeding.`);
if (status?.initialized) {
  const sites = await api.sql('SELECT * FROM site_view');
  if (sites.length) { log(`${db} is already seeded (${sites.length} sites).`); process.exit(0); }
} else {
  await api.call('bootstrap_sandbox', 'Sandbox seeder');
  log('Created sandbox network.');
}
await api.call('grant_member', service.identity, 'Agent workers', 'service', 0);

const SITES = [
  ['North Campus Pharmacy', 'Chicago, IL'], ['Lakeside Medical Center', 'Evanston, IL'],
  ['Westbrook Community Hospital', 'Oak Park, IL'], ['Riverside Children’s', 'Naperville, IL'],
];
for (const [name, region] of SITES) await api.call('create_site', name, region, 'sandbox@example.org');
const siteIds = (await api.sql<{ id: number; name: string }>('SELECT * FROM site_view')).map(s => s.id).sort((a, b) => a - b);
log(`Created ${siteIds.length} synthetic sites.`);

log('Waiting for a worker to import the real FDA feed…');
type ShortageRow = { key: string; package_ndc: string; generic_name: string; status: string; active: boolean };
let shortages: ShortageRow[] = [];
for (let i = 0; i < 120 && !shortages.length; i++) {
  shortages = await api.sql<ShortageRow>('SELECT * FROM shortage');
  if (!shortages.length) await new Promise(r => setTimeout(r, 2000));
}
if (!shortages.length) throw new Error('No FDA records after 4 minutes. Is a worker running with the service role?');

const PREFERRED = ['heparin', 'lidocaine', 'epinephrine', 'dexamethasone', 'ondansetron', 'cefazolin', 'furosemide', 'bicarbonate', 'dextrose', 'morphine', 'amoxicillin', 'methotrexate'];
const usable = shortages.filter(s => isCurrent(s) && fdaTo11(s.package_ndc));
const picked: ShortageRow[] = [];
const seen = new Set<string>();
for (const word of [...PREFERRED, '']) {
  for (const s of usable) {
    const generic = s.generic_name.toLowerCase();
    const base = generic.split(/[^a-z]+/)[0];
    if (picked.length >= 6) break;
    if (seen.has(base) || (word && !generic.includes(word))) continue;
    seen.add(base);
    picked.push(s);
  }
}
if (picked.length < 6) throw new Error('Not enough current FDA shortages with package NDCs to build the sandbox.');

// [site index] → [on hand, daily rate (0 = no baseline), safety stock]
type Plan = Array<[number, number, number] | null>;
const SCENARIOS: Array<{ title: string; plan: Plan; link: boolean; ndcVariant?: boolean; surge?: number }> = [
  { title: 'one site critical, one with surplus', plan: [[6, 4, 20], [420, 3, 30], null, [60, 2, 10]], link: true },
  { title: 'critical site, two partial donors', plan: [[160, 2, 15], [9, 6, 25], [150, 2, 20], [140, 3, 20]], link: true },
  { title: 'network-wide shortage, no internal source', plan: [[14, 3, 20], [18, 4, 20], [11, 2, 15], null], link: true, surge: 1.8 },
  { title: 'stable everywhere', plan: [[300, 3, 30], [260, 2, 20], [280, 4, 30], [240, 2, 20]], link: true },
  { title: 'different package size than the FDA notice', plan: [null, [80, 2, 10], [35, 3, 10], null], link: false, ndcVariant: true },
  { title: 'new site without a baseline (pooled prior)', plan: [[120, 3, 15], null, [100, 2, 15], [12, 0, 10]], link: false },
];

let events = 0;
for (const [k, scenario] of SCENARIOS.entries()) {
  const s = picked[k];
  const fda11 = fdaTo11(s.package_ndc)!;
  const ndc = scenario.ndcVariant ? `${fda11.slice(0, 9)}${fda11.slice(9) === '99' ? '98' : '99'}` : fda11;
  const label = `${s.generic_name}`.slice(0, 80);
  for (const [i, cfg] of scenario.plan.entries()) {
    if (!cfg) continue;
    const [onHand, rate, safety] = cfg;
    const siteId = siteIds[i];
    await api.call('upsert_inventory', '', siteId, ndc, label, 'units', onHand, rate, safety, 5 + (k % 3) * 2,
      scenario.link ? s.key : '', 0);
    const histRate = rate > 0 ? rate : 2.5;
    if (rate === 0) continue; // the "new site" has no history: its forecast must borrow from the network
    const rng = seededRandom(`sandbox:${k}:${i}`);
    const history = [];
    for (let day = 60; day >= 1; day--) {
      const r = scenario.surge && day <= 14 ? histRate * scenario.surge : histRate;
      const q = poisson(rng, r);
      if (q > 0) history.push({ daysAgo: day - 0.5 + rng() * 0.4, quantity: q });
    }
    await api.call('sandbox_seed_history', `${siteId}:${ndc}`, JSON.stringify(history));
    events += history.length;
  }
  log(`Product ${k + 1}: ${label} (${scenario.title})`);
}
log(`Seeded ${SCENARIOS.length} products across ${siteIds.length} sites with ${events} synthetic usage events.`);
log('Workers will forecast, backtest, and run the agent automatically. Open the dashboard and join as admin.');
