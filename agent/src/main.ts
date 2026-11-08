/**
 * Argus agent worker. Run several for failover:
 *   npm run agent -- --name worker-a
 *   npm run agent -- --name worker-b
 * Options: --db <name> --host <http url> --mode auto|llm|rules --identity
 */
import { hostname } from 'node:os';
import { parseArgs } from 'node:util';
import { loadOrCreate } from './identity.ts';
import { makeClient } from './llm.ts';
import { AgentWorker } from './worker.ts';

const { values } = parseArgs({
  options: {
    db: { type: 'string', default: process.env.ARGUS_SUPPLY_DB_NAME ?? 'argus-supply' },
    host: { type: 'string', default: process.env.ARGUS_SUPPLY_DB_HOST ?? 'http://127.0.0.1:3000' },
    name: { type: 'string', default: process.env.ARGUS_WORKER_NAME ?? '' },
    mode: { type: 'string', default: process.env.ARGUS_AGENT_MODE ?? 'auto' },
    identity: { type: 'boolean', default: false },
  },
});

const creds = await loadOrCreate(values.host!);
if (values.identity) {
  console.log(creds.identity);
  process.exit(0);
}
const mode = values.mode as 'auto' | 'llm' | 'rules';
if (!['auto', 'llm', 'rules'].includes(mode)) throw new Error('--mode must be auto, llm, or rules');
const llm = mode === 'rules' ? null : makeClient();
if (mode === 'llm' && !llm) throw new Error('--mode llm needs ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN / ANTHROPIC_PROFILE).');
const name = values.name || `worker-${process.pid}`;
const workerId = `${hostname().replace(/[^a-zA-Z0-9-]/g, '').slice(0, 24) || 'host'}-${name}-${process.pid}`.slice(0, 64);
const worker = new AgentWorker({ host: values.host!, db: values.db!, token: creds.token, identity: creds.identity,
  workerId, name, mode, llm });
console.log(`Agent mode: ${llm ? 'Claude (with deterministic fallback)' : 'deterministic planner'}; worker ${workerId}`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { worker.stop(); process.exit(0); });
await worker.start();
