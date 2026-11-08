/** One agent worker process: live subscription, heartbeats, leases, fenced writes. */
import { DbConnection } from '../../web/src/supply_bindings/index.ts';
import { assignLeases, leaseActions } from './leases.ts';
import { backtestItem, DAY_MS, forecastItem, poolRates, summarizeBacktest, windowStats, type UsageEvent } from './model.ts';
import { digits, isCurrent, matchCandidates } from './ndc.ts';
import { maxGive, planTransfers, type PlanItem } from './planner.ts';
import { fetchFda } from './fda.ts';
import { AGENT_MODEL, runLlmAgent, type AgentToolbox } from './llm.ts';
import type Anthropic from '@anthropic-ai/sdk';
import { createHash } from 'node:crypto';

export const VERSION = '2.0.0';
const HEARTBEAT_MS = 2000;
const DEBOUNCE_MS = 200;
const FORECAST_MAX_AGE_MS = 10 * 60_000;
const METRIC_INTERVAL_MS = 60_000;
const FDA_REFRESH_MS = 24 * 3600_000;
const AUTO_RUN_COOLDOWN_MS = 60_000;

const VIEWS = ['site_view', 'member_view', 'inventory_view', 'stock_event_view', 'transfer_view', 'forecast_view',
  'proposal_view', 'config_view', 'worker_view', 'lease_view', 'agent_run_view', 'match_view', 'metric_view'];
const PUBLIC = ['shortage', 'sync_state', 'network_status'];

export interface WorkerOptions {
  host: string;            // http(s)://host:port
  db: string;
  token: string;
  identity: string;
  workerId: string;
  name: string;
  mode: 'auto' | 'llm' | 'rules';
  llm: Pick<Anthropic, 'beta'> | null;
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

const micros = (t: { microsSinceUnixEpoch: bigint }) => t.microsSinceUnixEpoch;
const CALL_TIMEOUT_MS = 20_000;

/** Every reducer call settles: a call whose result never arrives is rejected instead of hanging the worker. */
function withTimeouts<T extends object>(reducers: T): T {
  return new Proxy(reducers, {
    get(target, prop, receiver) {
      const fn = Reflect.get(target, prop, receiver);
      if (typeof fn !== 'function') return fn;
      return (...args: unknown[]) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out waiting for the database (${String(prop)})`)), CALL_TIMEOUT_MS);
        (fn as (...a: unknown[]) => Promise<unknown>).apply(target, args).then(
          v => { clearTimeout(timer); resolve(v); }, e => { clearTimeout(timer); reject(e); });
      });
    },
  });
}
const ms = (t: { microsSinceUnixEpoch: bigint }) => Number(t.microsSinceUnixEpoch / 1000n);
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class AgentWorker {
  conn: DbConnection | null = null;
  ready = false;
  private timers: NodeJS.Timeout[] = [];
  private debounce: NodeJS.Timeout | null = null;
  private busy = { sites: false, agent: false, fda: false };
  private written = new Map<string, string>();   // inventory key → input signature last written
  private lastMetric = new Map<number, number>(); // site → ms
  private lastAutoSignature = '';
  private lastAutoAt = 0;
  private myFdaRun = '';
  private stopped = false;
  readonly stats = { forecasts: 0, fenced: 0, runs: 0, fdaImports: 0 };

  constructor(private opts: WorkerOptions) {}

  private log(level: 'info' | 'warn' | 'error', message: string) {
    (this.opts.log ?? ((l, m) => console[l === 'info' ? 'log' : l](`${new Date().toISOString()} [${this.opts.name}] ${l.toUpperCase()} ${m}`)))(level, message);
  }

  start(): Promise<void> {
    const ws = this.opts.host.replace(/^http/, 'ws');
    return new Promise<void>((resolve, reject) => {
      const conn = DbConnection.builder()
        .withUri(ws).withDatabaseName(this.opts.db).withToken(this.opts.token)
        .onConnect(c => {
          this.log('info', `Connected to ${this.opts.db} as ${this.opts.identity.slice(0, 12)}… (worker ${this.opts.workerId})`);
          c.subscriptionBuilder()
            .onApplied(() => { this.ready = true; this.schedule(); resolve(); })
            .onError(ctx => this.log('error', `Subscription error: ${String((ctx as { event?: unknown }).event ?? 'unknown')}`))
            .subscribe([...VIEWS, ...PUBLIC].map(t => `SELECT * FROM ${t}`));
        })
        .onConnectError((_ctx, error) => { this.log('error', `Connect failed: ${error.message}`); reject(error); })
        .onDisconnect((_ctx, error) => { this.ready = false; if (!this.stopped) this.log('warn', `Disconnected${error ? `: ${error.message}` : ''}`); })
        .build();
      this.conn = conn;
      const db = conn.db;
      for (const table of [db.inventoryView, db.stockEventView, db.forecastView, db.transferView, db.proposalView, db.leaseView,
        db.agentRunView, db.workerView, db.matchView, db.shortage, db.syncState, db.siteView, db.memberView, db.configView]) {
        const t = table as unknown as { onInsert(cb: () => void): void; onDelete(cb: () => void): void };
        t.onInsert(() => this.schedule());
        t.onDelete(() => this.schedule());
      }
    }).then(() => {
      this.timers.push(setInterval(() => void this.tick(), HEARTBEAT_MS));
      this.timers.push(setInterval(() => this.schedule(), 30_000));
      return this.tick();
    });
  }

  stop() {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    if (this.debounce) clearTimeout(this.debounce);
    this.conn?.disconnect();
  }

  // ── State accessors ───────────────────────────────────────────────────────

  private get db() { return this.conn!.db; }
  private reducersCache: DbConnection['reducers'] | null = null;
  private get reducers() { return (this.reducersCache ??= withTimeouts(this.conn!.reducers)); }
  authorized(): boolean {
    const me = [...this.db.memberView.iter()].find(m => m.identity.toLowerCase() === this.opts.identity.toLowerCase());
    return me?.role === 'service' || me?.role === 'admin';
  }
  private heldEpoch(resource: string): bigint | null {
    const l = [...this.db.leaseView.iter()].find(x => x.resource === resource);
    if (!l || l.holder !== this.opts.workerId || l.expiresAtMicros <= BigInt(Date.now()) * 1000n) return null;
    return l.epoch;
  }
  private liveWorkers(): string[] {
    return [...this.db.workerView.iter()].filter(w => w.status === 'online').map(w => w.id).sort();
  }
  private resources(): string[] {
    return [...[...this.db.siteView.iter()].filter(s => s.active).map(s => `site:${s.id}`), 'fda', 'agent'];
  }

  // ── Heartbeat and lease reconciliation ───────────────────────────────────

  private async tick() {
    if (!this.ready || this.stopped) return;
    if (!this.authorized()) { this.log('warn', `Waiting for the service role. Grant identity ${this.opts.identity}.`); return; }
    try {
      await this.reducers.workerHeartbeat({ workerId: this.opts.workerId, name: this.opts.name, version: VERSION });
    } catch (e) { this.log('warn', `Heartbeat failed: ${errText(e)}`); return; }
    const workers = this.liveWorkers();
    if (!workers.includes(this.opts.workerId)) workers.push(this.opts.workerId);
    const assignment = assignLeases(this.resources(), workers.sort());
    const leases = [...this.db.leaseView.iter()];
    const { acquire, release } = leaseActions(this.opts.workerId, assignment, leases, BigInt(Date.now()) * 1000n);
    for (const resource of release) {
      // Hand off only between units of work; a lease in use is released on a later tick.
      if ((resource === 'agent' && this.busy.agent) || (resource === 'fda' && this.busy.fda) || (resource.startsWith('site:') && this.busy.sites)) continue;
      try { await this.reducers.releaseLease({ workerId: this.opts.workerId, resource }); this.log('info', `Released ${resource} to ${assignment.get(resource) ?? 'nobody'}`); }
      catch (e) { this.log('warn', `Release ${resource}: ${errText(e)}`); }
    }
    for (const resource of acquire) {
      try { await this.reducers.acquireLease({ workerId: this.opts.workerId, resource }); this.log('info', `Acquired ${resource}`); this.schedule(); }
      catch (e) { if (!/held by/.test(errText(e))) this.log('warn', `Acquire ${resource}: ${errText(e)}`); }
    }
  }

  private schedule() {
    if (this.debounce || this.stopped) return;
    this.debounce = setTimeout(() => { this.debounce = null; void this.process(); }, DEBOUNCE_MS);
  }

  private async process() {
    if (!this.ready || !this.authorized()) return;
    void this.siteWork();
    void this.agentWork();
    void this.fdaWork();
  }

  private fenced(e: unknown): boolean {
    if (/Fenced/.test(errText(e))) { this.stats.fenced++; this.log('warn', `Write rejected by fencing: ${errText(e)}`); return true; }
    return false;
  }

  // ── Forecasts and calibration for leased sites ───────────────────────────

  private usageByItem() {
    const usage = new Map<string, UsageEvent[]>();
    const first = new Map<string, number>();
    for (const e of this.db.stockEventView.iter()) {
      const at = ms(e.at);
      first.set(e.inventoryKey, Math.min(first.get(e.inventoryKey) ?? at, at));
      if (e.kind === 'use') {
        const list = usage.get(e.inventoryKey) ?? [];
        list.push({ atMs: at, quantity: -e.delta });
        usage.set(e.inventoryKey, list);
      }
    }
    return { usage, first };
  }

  private fdaActiveFor(shortageKey: string): boolean {
    if (!shortageKey) return false;
    const s = this.db.shortage.key.find(shortageKey);
    return !!s && isCurrent(s);
  }

  private async siteWork() {
    if (this.busy.sites) return;
    this.busy.sites = true;
    try {
      const nowMs = Date.now();
      const items = [...this.db.inventoryView.iter()];
      const shortageMultiplier = [...this.db.configView.iter()][0]?.shortageLeadMultiplier ?? 2.5;
      const forecasts = new Map([...this.db.forecastView.iter()].map(f => [f.key, f]));
      const { usage, first } = this.usageByItem();
      const pools = poolRates(items.map(i => ({ ndc: i.ndc, baselineDaily: i.baselineDaily,
        ...windowStats(usage.get(i.key) ?? [], first.get(i.key) ?? null, nowMs) })));
      for (const site of this.db.siteView.iter()) {
        const resource = `site:${site.id}`;
        const epoch = this.heldEpoch(resource);
        if (epoch === null) continue;
        for (const item of items.filter(i => i.siteId === site.id)) {
          const fdaActive = this.fdaActiveFor(item.shortageKey);
          const others = items.filter(o => o.ndc === item.ndc && o.siteId !== item.siteId);
          const poolRate = item.baselineDaily > 0 || !others.length ? 0 : pools.get(item.ndc) ?? 0;
          const signature = `${item.revision}|${fdaActive}|${poolRate.toFixed(2)}|${shortageMultiplier}|${Math.floor(nowMs / DAY_MS)}|${epoch}`;
          const existing = forecasts.get(item.key);
          const fresh = existing && existing.inventoryRevision === item.revision && nowMs - ms(existing.computedAt) < FORECAST_MAX_AGE_MS;
          if (fresh && this.written.get(item.key) === signature) continue;
          if (fresh && !this.written.has(item.key) && existing.workerId === this.opts.workerId && existing.leaseEpoch === epoch) { this.written.set(item.key, signature); continue; }
          const f = forecastItem({ key: item.key, revision: item.revision, unit: item.unit, free: item.onHand - item.reserved,
            baselineDaily: item.baselineDaily, leadTimeDays: item.leadTimeDays, usage: usage.get(item.key) ?? [],
            firstObservedMs: first.get(item.key) ?? null }, { nowMs, fdaActive, poolRate, shortageMultiplier });
          try {
            await this.reducers.writeForecast({ workerId: this.opts.workerId, leaseEpoch: epoch, inventoryKey: item.key,
              inventoryRevision: item.revision, ...f });
            this.written.set(item.key, signature);
            this.stats.forecasts++;
          } catch (e) {
            if (this.fenced(e)) break;
            if (!/stale/.test(errText(e))) this.log('warn', `Forecast ${item.key}: ${errText(e)}`);
          }
        }
        if (nowMs - (this.lastMetric.get(site.id) ?? 0) >= METRIC_INTERVAL_MS && this.heldEpoch(resource) === epoch) {
          const windows = items.filter(i => i.siteId === site.id)
            .flatMap(i => backtestItem(i.key, i.baselineDaily, usage.get(i.key) ?? [], first.get(i.key) ?? null, nowMs));
          const evaluated = items.filter(i => i.siteId === site.id && (usage.get(i.key)?.length ?? 0) > 0).length;
          const s = summarizeBacktest(windows);
          if (s.windows) {
            this.lastMetric.set(site.id, nowMs); // with nothing to score yet, retry on the next change
            try {
              await this.reducers.writeModelMetric({ workerId: this.opts.workerId, leaseEpoch: epoch, siteId: site.id,
                itemsEvaluated: evaluated, windows: s.windows, coverage80: s.coverage80, meanAbsError: s.meanAbsError, bias: s.bias });
            } catch (e) { if (!this.fenced(e)) this.log('warn', `Metric site ${site.id}: ${errText(e)}`); }
          }
        }
      }
    } finally { this.busy.sites = false; }
  }

  // ── Agent runs ────────────────────────────────────────────────────────────

  planItems(): PlanItem[] {
    const forecasts = new Map([...this.db.forecastView.iter()].map(f => [f.key, f]));
    return [...this.db.inventoryView.iter()].map(i => {
      const f = forecasts.get(i.key);
      const ok = f && f.inventoryRevision === i.revision;
      return { key: i.key, siteId: i.siteId, ndc: i.ndc, unit: i.unit, label: i.label, free: i.onHand - i.reserved,
        safetyStock: i.safetyStock, rate: ok ? f.ratePerDay : 0, risk: ok ? f.risk : 'unknown', pStockout: ok ? f.pStockout : 0,
        daysP10: ok ? f.daysP10 : 0, revision: i.revision,
        rxcui: i.shortageKey ? this.db.shortage.key.find(i.shortageKey)?.rxcui ?? '' : '' };
    });
  }

  private blockedRoutes(): Set<string> {
    const blocked = new Set<string>();
    for (const t of this.db.transferView.iter()) if (!['received', 'cancelled'].includes(t.status)) blocked.add(`${t.destSiteId}:${t.destNdc || t.ndc}`);
    for (const p of this.db.proposalView.iter()) if (p.status === 'pending') blocked.add(`${p.destSiteId}:${p.destNdc || p.ndc}`);
    return blocked;
  }

  /**
   * Fingerprint of what an automatic run would act on: at-risk items plus every potential donor of
   * the same NDC (with its giveable surplus). Empty until all forecasts are current, so a run never
   * fires on a half-updated picture (e.g. a critical destination before its donor is forecast).
   */
  private atRiskSignature(): string {
    const forecasts = new Map([...this.db.forecastView.iter()].map(f => [f.key, f]));
    const settled = [...this.db.inventoryView.iter()].every(i => forecasts.get(i.key)?.inventoryRevision === i.revision);
    if (!settled) return '';
    const items = this.planItems();
    const atRisk = items.filter(i => i.risk === 'critical' || i.pStockout >= 0.5);
    if (!atRisk.length) return '';
    const ndcs = new Set(atRisk.map(i => i.ndc));
    const donors = items.filter(i => ndcs.has(i.ndc) && !atRisk.includes(i)).map(i => `${i.key}:${i.risk}:${Math.floor(maxGive(i) / 5)}`);
    return [...atRisk.map(i => `${i.key}@${i.risk}`), ...donors].sort().join(',');
  }

  private async agentWork() {
    const epoch = this.heldEpoch('agent');
    if (epoch === null || this.busy.agent) return;
    this.busy.agent = true;
    try {
      const queued = [...this.db.agentRunView.iter()].filter(r => r.status === 'queued').sort((a, b) => a.id - b.id)[0];
      if (!queued) {
        const signature = this.atRiskSignature();
        // The fingerprint and cooldown are read back from the last auto run in the database, so a
        // lease handoff or worker restart doesn't re-run (and re-bill) an unchanged situation.
        const fingerprint = signature ? createHash('sha256').update(signature).digest('hex').slice(0, 12) : '';
        const lastAuto = [...this.db.agentRunView.iter()].filter(r => r.trigger === 'auto').sort((a, b) => b.id - a.id)[0];
        const sinceLastMs = lastAuto ? Date.now() - ms(lastAuto.createdAt) : Infinity;
        const seen = !!lastAuto && lastAuto.note.includes(`[${fingerprint}]`);
        if (fingerprint && !seen && fingerprint !== this.lastAutoSignature && sinceLastMs > AUTO_RUN_COOLDOWN_MS && Date.now() - this.lastAutoAt > AUTO_RUN_COOLDOWN_MS) {
          this.lastAutoSignature = fingerprint;
          this.lastAutoAt = Date.now();
          try { await this.reducers.requestAutoAgentRun({ workerId: this.opts.workerId, leaseEpoch: epoch, note: `At-risk items changed [${fingerprint}]` }); }
          catch (e) { if (!this.fenced(e)) this.log('warn', `Auto run: ${errText(e)}`); }
        }
        return;
      }
      const llmAllowed = [...this.db.configView.iter()][0]?.llmAllowed ?? true;
      const mode = this.opts.mode === 'rules' || !this.opts.llm || !llmAllowed ? 'rules' : 'llm';
      try { await this.reducers.claimAgentRun({ runId: queued.id, workerId: this.opts.workerId, leaseEpoch: epoch, mode }); }
      catch (e) { if (!this.fenced(e)) this.log('warn', `Claim run #${queued.id}: ${errText(e)}`); return; }
      this.stats.runs++;
      this.log('info', `Running agent run #${queued.id} (${queued.trigger}, ${mode}${mode === 'llm' ? `, ${AGENT_MODEL}` : ''})`);
      const toolbox = this.toolbox(queued.id, epoch);
      let summary: string;
      let status: 'done' | 'failed' = 'done';
      try {
        if (mode === 'llm') {
          try { summary = await runLlmAgent(this.opts.llm!, toolbox, queued.trigger === 'manual' ? queued.note : ''); }
          catch (e) {
            await toolbox.step('error', '', `LLM unavailable (${errText(e)}); falling back to the deterministic planner.`);
            summary = `LLM fallback. ${await this.runRules(toolbox)}`;
          }
        } else summary = await this.runRules(toolbox);
      } catch (e) {
        if (this.fenced(e)) return;
        status = 'failed';
        summary = errText(e);
      }
      try { await this.reducers.finishAgentRun({ runId: queued.id, workerId: this.opts.workerId, leaseEpoch: epoch, status, summary }); }
      catch (e) { if (!this.fenced(e)) this.log('warn', `Finish run #${queued.id}: ${errText(e)}`); }
    } finally {
      this.busy.agent = false;
      this.schedule();
    }
  }

  /** Deterministic planner: network-wide multi-source transfer drafts plus FDA match suggestions. */
  async runRules(tools: AgentToolbox): Promise<string> {
    const items = this.planItems();
    const atRisk = items.filter(i => i.risk === 'critical' || i.pStockout >= 0.5);
    await tools.step('plan', '', `Deterministic planner: ${items.length} items, ${atRisk.length} at risk; checking surplus at other sites and unlinked FDA notices.`);
    const drafts = planTransfers(items, this.blockedRoutes());
    let made = 0;
    for (const d of drafts) {
      await tools.step('tool_call', 'propose_transfer', JSON.stringify({ source_site_id: d.sourceSiteId, dest_site_id: d.destSiteId, ndc: d.ndc, dest_ndc: d.destNdc ?? '', quantity: d.quantity }));
      try { const out = await tools.proposeTransfer({ source_site_id: d.sourceSiteId, dest_site_id: d.destSiteId, ndc: d.ndc, dest_ndc: d.destNdc ?? '', quantity: d.quantity, reason: d.reason }); made++; await tools.step('tool_result', 'propose_transfer', out); }
      catch (e) { if (/Fenced/.test(errText(e))) throw e; await tools.step('tool_result', 'propose_transfer', `Rejected: ${errText(e)}`); }
    }
    const unmet = atRisk.filter(i => !drafts.some(d => d.destSiteId === i.siteId && (d.destNdc ?? d.ndc) === i.ndc) && !this.blockedRoutes().has(`${i.siteId}:${i.ndc}`));
    if (unmet.length) await tools.step('thought', '', `No site has spare stock for: ${unmet.map(i => `${i.label} at site ${i.siteId}`).join('; ')}. External sourcing needed.`);
    let matches = 0;
    const existing = new Set([...this.db.matchView.iter()].map(m => m.key));
    const shortages = [...this.db.shortage.iter()];
    for (const item of this.db.inventoryView.iter()) {
      if (item.shortageKey && this.db.shortage.key.find(item.shortageKey)?.active) continue;
      const best = matchCandidates(item, shortages, 1)[0];
      if (!best || existing.has(`${item.key}|${best.shortageKey}`)) continue;
      try { await tools.suggestMatch({ inventory_key: item.key, shortage_key: best.shortageKey, confidence: best.confidence, rationale: best.rationale }); matches++; }
      catch (e) { if (/Fenced/.test(errText(e))) throw e; }
    }
    const summary = `Drafted ${made} transfer${made === 1 ? '' : 's'} and ${matches} FDA match suggestion${matches === 1 ? '' : 's'}.`
      + (unmet.length ? ` ${unmet.length} at-risk item(s) have no internal source.` : '');
    await tools.step('final', '', summary);
    return summary;
  }

  toolbox(runId: number, epoch: bigint): AgentToolbox {
    const r = () => this.reducers;
    const base = { runId, workerId: this.opts.workerId, leaseEpoch: epoch };
    const sites = () => new Map([...this.db.siteView.iter()].map(s => [s.id, s.name]));
    return {
      step: async (kind, tool, content) => { await r().appendAgentStep({ ...base, kind, tool, content }); },
      overview: () => {
        const names = sites();
        return {
          sites: [...names].map(([id, name]) => ({ id, name })),
          items: this.planItems().map(i => {
            const inv = this.db.inventoryView.iter();
            const row = [...inv].find(x => x.key === i.key);
            const s = row?.shortageKey ? this.db.shortage.key.find(row.shortageKey) : undefined;
            return { inventory_key: i.key, site_id: i.siteId, site: names.get(i.siteId), label: i.label, ndc: i.ndc, unit: i.unit,
              free: i.free, safety_stock: i.safetyStock, rate_per_day: i.rate, p_stockout: i.pStockout, days_p10: i.daysP10, risk: i.risk, rxcui: i.rxcui || null,
              linked_fda: s ? { key: s.key, status: s.status, generic: s.genericName } : null, max_give: maxGive(i) };
          }),
          open_transfers: [...this.db.transferView.iter()].filter(t => !['received', 'cancelled'].includes(t.status))
            .map(t => ({ id: t.id, from: t.sourceSiteId, to: t.destSiteId, ndc: t.ndc, quantity: t.quantity, status: t.status })),
          pending_drafts: [...this.db.proposalView.iter()].filter(p => p.status === 'pending')
            .map(p => ({ from: p.sourceSiteId, to: p.destSiteId, ndc: p.ndc, quantity: p.quantity })),
        };
      },
      itemDetail: (key: string) => {
        const item = [...this.db.inventoryView.iter()].find(i => i.key === key);
        if (!item) return { error: 'No such inventory key.' };
        const since = Date.now() - 14 * DAY_MS;
        const daily = new Map<string, number>();
        for (const e of this.db.stockEventView.iter()) {
          if (e.inventoryKey !== key || e.kind !== 'use' || ms(e.at) < since) continue;
          const d = new Date(ms(e.at)).toISOString().slice(0, 10);
          daily.set(d, (daily.get(d) ?? 0) - e.delta);
        }
        const f = [...this.db.forecastView.iter()].find(x => x.key === key);
        const s = item.shortageKey ? this.db.shortage.key.find(item.shortageKey) : undefined;
        return { item: { key, label: item.label, ndc: item.ndc, unit: item.unit, on_hand: item.onHand, reserved: item.reserved,
          baseline: item.baselineDaily, safety_stock: item.safetyStock, lead_time_days: item.leadTimeDays },
          usage_last_14_days: Object.fromEntries([...daily].sort()), forecast: f ? { explanation: f.explanation, risk: f.risk, p_stockout: f.pStockout } : null,
          linked_fda: s ? { genericName: s.genericName, status: s.status, presentation: s.presentation, details: s.details.slice(0, 400) } : null,
          candidate_fda_matches: matchCandidates(item, [...this.db.shortage.iter()], 3) };
      },
      searchFda: (query: string, limit: number) => {
        const q = query.toLowerCase();
        const qd = digits(query);
        return [...this.db.shortage.iter()].filter(s => s.active && (`${s.genericName} ${s.companyName} ${s.presentation}`.toLowerCase().includes(q)
          || (qd.length >= 5 && digits(s.packageNdc).includes(qd)))).slice(0, limit)
          .map(s => ({ shortage_key: s.key, generic: s.genericName, package_ndc: s.packageNdc, presentation: s.presentation, status: s.status, company: s.companyName }));
      },
      proposeTransfer: async a => {
        const items = this.planItems();
        const code = digits(a.ndc);
        const destCode = a.dest_ndc ? digits(a.dest_ndc) : code;
        const source = items.find(i => i.siteId === a.source_site_id && i.ndc === code);
        const dest = items.find(i => i.siteId === a.dest_site_id && i.ndc === destCode);
        if (!source || !dest) throw new Error('Source must stock ndc and destination must stock dest_ndc (or ndc).');
        if (destCode !== code && !(source.rxcui && source.rxcui === dest.rxcui)) throw new Error('Different NDCs are only allowed for equivalent products with the same RxCUI.');
        if (source.unit.trim().toLowerCase() !== dest.unit.trim().toLowerCase()) throw new Error('Units differ between sites.');
        const limit = maxGive(source);
        if (!(a.quantity >= 1) || a.quantity > limit) throw new Error(`Quantity must be between 1 and the source max_give (${limit}).`);
        if (this.blockedRoutes().has(`${dest.siteId}:${destCode}`)) throw new Error('An open transfer or pending draft already covers this destination product.');
        const key = `${runId}-${source.key}-${dest.key}`.replace(/[^a-zA-Z0-9:-]/g, '');
        await r().proposeTransfer({ ...base, key, sourceSiteId: source.siteId, destSiteId: dest.siteId, packageNdc: code,
          destPackageNdc: destCode !== code ? destCode : '', quantity: Math.floor(a.quantity), reason: a.reason });
        return `Drafted ${Math.floor(a.quantity)} ${source.unit} from site ${source.siteId} to site ${dest.siteId}${destCode !== code ? ' (equivalent product)' : ''}.`;
      },
      suggestMatch: async a => {
        if (![...this.db.inventoryView.iter()].find(i => i.key === a.inventory_key)) throw new Error('No such inventory key.');
        if (!this.db.shortage.key.find(a.shortage_key)) throw new Error('No such FDA record.');
        await r().suggestMatch({ ...base, inventoryKey: a.inventory_key, shortageKey: a.shortage_key,
          confidence: Math.min(1, Math.max(0, a.confidence)), rationale: a.rationale });
        return 'Suggestion recorded for pharmacist review.';
      },
    };
  }

  // ── FDA import ────────────────────────────────────────────────────────────

  private async fdaWork() {
    const epoch = this.heldEpoch('fda');
    if (epoch === null || this.busy.fda) return;
    const sync = this.db.syncState.id.find(1);
    if (!sync) return;
    const stale = sync.status === 'never'
      || (sync.status === 'complete' && Date.now() - ms(sync.completedAt) > FDA_REFRESH_MS)
      || (sync.status === 'running' && sync.runId !== this.myFdaRun);
    if (!stale) return;
    this.busy.fda = true;
    try {
      this.log('info', sync.status === 'running' ? `Taking over an interrupted FDA import (${sync.runId})` : 'Downloading the full FDA shortage feed');
      const { feedDate, rows } = await fetchFda();
      if (this.heldEpoch('fda') !== epoch) { this.log('warn', 'Lost the fda lease during download; discarding.'); return; }
      const runId = `${new Date().toISOString().replace(/[-:.]/g, '')}-${this.opts.workerId}`;
      this.myFdaRun = runId;
      const base = { workerId: this.opts.workerId, leaseEpoch: epoch };
      await this.reducers.beginFdaSync({ runId, ...base });
      for (let i = 0; i < rows.length; i += 200) {
        await this.reducers.importFdaBatch({ runId, rowsJson: JSON.stringify(rows.slice(i, i + 200)), ...base });
      }
      await this.reducers.finishFdaSync({ runId, feedDate, ...base });
      this.stats.fdaImports++;
      this.log('info', `Imported ${rows.length} FDA records (feed ${feedDate})`);
    } catch (e) {
      if (!this.fenced(e)) this.log('error', `FDA import failed: ${errText(e)}`);
    } finally { this.busy.fda = false; }
  }
}

export { micros };
