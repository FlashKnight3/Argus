/**
 * Argus — SpacetimeDB module.
 *
 * SpacetimeDB is the single source of truth. Every device and model reads by
 * subscribing to these tables and writes only through the reducers below:
 *
 *   simulator  ──admitPatient / consumeResource / advanceClock──▶ ┐
 *   medic tablet ──admitPatient / setTriage──────────────────────▶ │  module
 *   ML sidecar ──writeForecast / writeInflow / writeRanking──────▶ │  (this file)
 *   commander  ──recordDecision / setWeights / applyWhatIf───────▶ ┘
 *
 * Protocol rules (SALT, START/JumpSTART, RTS, MEDEVAC precedence) run here as
 * deterministic code. The ML sidecar only forecasts and orders within tiers.
 * No recommendation applies itself: evacuation happens only in
 * `recordDecision`, which a human triggers.
 */
import { schema, SenderError, table, t, type InferSchema, type ReducerCtx } from 'spacetimedb/server';
import {
  RESOURCES,
  injurySpec,
  precedenceDeadline,
  precedenceFor,
  protocolFor,
  retriage,
  revisedTraumaScore,
  triage,
  type Assessment,
  type ResourceType,
  type TriageCategory,
} from './protocols';

// ─────────────────────────────────────────────────────────────────────────────
// Tables
// ─────────────────────────────────────────────────────────────────────────────

/** Singleton (id = 1): scenario clock, playback, settings, evac weights. */
const simState = table(
  { name: 'sim_state', public: true },
  {
    id: t.u32().primaryKey(),
    scenarioName: t.string(),
    scenarioTitle: t.string(),
    scenarioLengthMin: t.f64(),
    minute: t.f64(),
    speed: t.f64(),
    paused: t.bool(),
    /** Local triage protocol: 'SALT' or 'START' (START routes children to JumpSTART). */
    protocol: t.string(),
    /** EvacScore weights. */
    wDeterioration: t.f64(),
    wResourceRelief: t.f64(),
    wDestinationMatch: t.f64(),
    /** What-if: hypothetical extra casualties folded into the inflow forecast. */
    whatIfSurge: t.u32(),
    /** Minute the ML sidecar last wrote, for the health indicator. */
    mlMinute: t.f64(),
    simulatorHeartbeat: t.timestamp(),
    mlHeartbeat: t.timestamp(),
  }
);

const patient = table(
  { name: 'patient', public: true },
  {
    id: t.u32().primaryKey().autoInc(),
    tag: t.string(),
    source: t.string(),
    arrivalMin: t.f64(),
    age: t.u32(),
    injuryType: t.string(),
    mechanism: t.string(),
    /** Protocol that produced the category: SALT / START / JumpSTART / medic. */
    triageProtocol: t.string(),
    category: t.string(),
    categorySetByMedic: t.bool(),
    triageTrace: t.string(),
    hr: t.f64(),
    sbp: t.f64(),
    rr: t.f64(),
    oxygenSat: t.f64(),
    gcs: t.f64(),
    tRts: t.u32(),
    weightedRts: t.f64(),
    /** Change in weighted RTS per 30 simulated minutes (negative = worsening). */
    rtsTrend: t.f64(),
    vitalsMin: t.f64(),
    evacPrecedence: t.string(),
    precedenceDeadline: t.f64(),
    needsSurgery: t.bool(),
    capability: t.string(),
    mistCard: t.string(),
    bedId: t.u32(),
    /** waiting | bedded | ambulatory | evacuated | deceased */
    status: t.string(),
    evacSlotId: t.u32(),
  }
);

const bed = table(
  { name: 'bed', public: true },
  {
    id: t.u32().primaryKey(),
    label: t.string(),
    patientId: t.u32(),
  }
);

const resource = table(
  { name: 'resource', public: true },
  {
    resourceType: t.string().primaryKey(),
    label: t.string(),
    unit: t.string(),
    /** consumable | reusable */
    kind: t.string(),
    capacity: t.f64(),
    /** Consumables: amount used so far. Reusables: units currently held. */
    inUse: t.f64(),
    resupplyEtaMin: t.f64(),
    resupplyAmount: t.f64(),
  }
);

const consumptionEvent = table(
  { name: 'consumption_event', public: true },
  {
    id: t.u32().primaryKey().autoInc(),
    patientId: t.u32().index('btree'),
    resourceType: t.string(),
    amount: t.f64(),
    consumed: t.f64(),
    startMin: t.f64(),
    /** 0 = held until the patient leaves. */
    durationMin: t.f64(),
    /** queued | active | done */
    status: t.string(),
  }
);

const evacSlot = table(
  { name: 'evac_slot', public: true },
  {
    id: t.u32().primaryKey().autoInc(),
    mode: t.string(),
    callsign: t.string(),
    seats: t.u32(),
    seatsFilled: t.u32(),
    openedMin: t.f64(),
    departMin: t.f64(),
    destination: t.string(),
    capability: t.string(),
    /** open | departed | cancelled */
    status: t.string(),
  }
);

const decision = table(
  { name: 'decision', public: true },
  {
    id: t.u32().primaryKey().autoInc(),
    slotId: t.u32(),
    patientId: t.u32(),
    aiRank: t.u32(),
    accepted: t.bool(),
    overrideReason: t.string(),
    minute: t.f64(),
    actor: t.string(),
    at: t.timestamp(),
  }
);

const alert = table(
  { name: 'alert', public: true },
  {
    id: t.u32().primaryKey().autoInc(),
    minute: t.f64(),
    /** info | amber | red */
    level: t.string(),
    subject: t.string(),
    message: t.string(),
  }
);

const forecast = table(
  { name: 'forecast', public: true },
  {
    resourceType: t.string().primaryKey(),
    computedMin: t.f64(),
    available: t.f64(),
    capacity: t.f64(),
    /** Median minutes until zero; -1 when beyond the horizon. */
    ttzMedian: t.f64(),
    ttzLow: t.f64(),
    ttzHigh: t.f64(),
    burnPerHour: t.f64(),
    /** ok | amber | red */
    level: t.string(),
    /** JSON: [[minutesAhead, p10, p50, p90], ...] projected availability. */
    curve: t.string(),
  }
);

const inflowForecast = table(
  { name: 'inflow_forecast', public: true },
  {
    id: t.u32().primaryKey(),
    computedMin: t.f64(),
    ratePerHour: t.f64(),
    halfHour: t.f64(),
    halfHourLow: t.f64(),
    halfHourHigh: t.f64(),
    oneHour: t.f64(),
    oneHourLow: t.f64(),
    oneHourHigh: t.f64(),
    ninetyMin: t.f64(),
    ninetyMinLow: t.f64(),
    ninetyMinHigh: t.f64(),
  }
);

const evacRanking = table(
  { name: 'evac_ranking', public: true },
  {
    id: t.u32().primaryKey().autoInc(),
    slotId: t.u32().index('btree'),
    patientId: t.u32(),
    rank: t.u32(),
    score: t.f64(),
    tier: t.u32(),
    precedence: t.string(),
    reason: t.string(),
    /** JSON: [{label, value}] contribution of each factor. */
    factors: t.string(),
    computedMin: t.f64(),
  }
);

const auditLog = table(
  { name: 'audit_log', public: true },
  {
    id: t.u32().primaryKey().autoInc(),
    minute: t.f64(),
    actor: t.string(),
    action: t.string(),
    detail: t.string(),
    at: t.timestamp(),
  }
);

const spacetimedb = schema({
  simState,
  patient,
  bed,
  resource,
  consumptionEvent,
  evacSlot,
  decision,
  alert,
  forecast,
  inflowForecast,
  evacRanking,
  auditLog,
});
export default spacetimedb;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

type Ctx = ReducerCtx<InferSchema<typeof spacetimedb>>;

const SIM_ID = 1;

function state(ctx: Ctx) {
  const s = ctx.db.simState.id.find(SIM_ID);
  if (!s) throw new SenderError('No scenario loaded. Run the simulator or call load_scenario first.');
  return s;
}

function nowMin(ctx: Ctx): number {
  return ctx.db.simState.id.find(SIM_ID)?.minute ?? 0;
}

function actorOf(ctx: Ctx): string {
  return ctx.sender.toHexString().slice(0, 8);
}

function audit(ctx: Ctx, action: string, detail: string) {
  ctx.db.auditLog.insert({
    id: 0,
    minute: nowMin(ctx),
    actor: actorOf(ctx),
    action,
    detail,
    at: ctx.timestamp,
  });
}

function raiseAlert(ctx: Ctx, level: 'info' | 'amber' | 'red', subject: string, message: string) {
  ctx.db.alert.insert({ id: 0, minute: nowMin(ctx), level, subject, message });
}

function fmtMin(m: number): string {
  const total = Math.max(0, Math.round(m));
  const h = Math.floor(total / 60);
  const mm = String(total % 60).padStart(2, '0');
  return `T+${h}:${mm}`;
}

function getResource(ctx: Ctx, type: string) {
  const r = ctx.db.resource.resourceType.find(type);
  if (!r) throw new SenderError(`Unknown resource type '${type}'`);
  return r;
}

function setInUse(ctx: Ctx, type: string, delta: number) {
  const r = ctx.db.resource.resourceType.find(type);
  if (!r) return;
  ctx.db.resource.resourceType.update({ ...r, inUse: Math.max(0, r.inUse + delta) });
}

function available(r: { capacity: number; inUse: number }): number {
  return r.capacity - r.inUse;
}

function freeBed(ctx: Ctx) {
  let best: { id: number; label: string; patientId: number } | undefined;
  for (const b of ctx.db.bed.iter()) {
    if (b.patientId === 0 && (!best || b.id < best.id)) best = b;
  }
  return best;
}

function syncBedResource(ctx: Ctx) {
  let used = 0;
  let total = 0;
  for (const b of ctx.db.bed.iter()) {
    total += 1;
    if (b.patientId !== 0) used += 1;
  }
  const r = ctx.db.resource.resourceType.find('bed');
  if (r) ctx.db.resource.resourceType.update({ ...r, capacity: total, inUse: used });
}

/** Patients who need a bed: everyone except ambulatory Minimal casualties. */
function needsBed(category: string): boolean {
  return category === 'immediate' || category === 'delayed' || category === 'expectant';
}

/** Put a patient in a bed if one is free; otherwise they wait. */
function placePatient(ctx: Ctx, p: ReturnType<typeof ctx.db.patient.id.find> & {}) {
  if (p.status === 'evacuated' || p.status === 'deceased') return p;
  if (!needsBed(p.category)) {
    if (p.bedId !== 0) releaseBed(ctx, p.bedId);
    const next = { ...p, bedId: 0, status: 'ambulatory' };
    ctx.db.patient.id.update(next);
    return next;
  }
  if (p.bedId !== 0) return p;
  const b = freeBed(ctx);
  if (!b) {
    const next = { ...p, status: 'waiting' };
    ctx.db.patient.id.update(next);
    return next;
  }
  ctx.db.bed.id.update({ ...b, patientId: p.id });
  const next = { ...p, bedId: b.id, status: 'bedded' };
  ctx.db.patient.id.update(next);
  syncBedResource(ctx);
  return next;
}

function releaseBed(ctx: Ctx, bedId: number) {
  const b = ctx.db.bed.id.find(bedId);
  if (b) ctx.db.bed.id.update({ ...b, patientId: 0 });
  syncBedResource(ctx);
}

/** Fill free beds with waiting patients, most severe first, then by arrival. */
function backfillBeds(ctx: Ctx) {
  const order: Record<string, number> = { immediate: 0, delayed: 1, expectant: 2 };
  const waiting = [...ctx.db.patient.iter()]
    .filter(p => p.status === 'waiting')
    .sort((a, b) => (order[a.category] ?? 9) - (order[b.category] ?? 9) || a.arrivalMin - b.arrivalMin);
  for (const p of waiting) {
    if (!freeBed(ctx)) break;
    placePatient(ctx, p);
  }
}

/** Start queued reusable-resource events (OR, vents) when capacity frees up. */
function startQueued(ctx: Ctx, now: number) {
  const queued = [...ctx.db.consumptionEvent.iter()]
    .filter(e => e.status === 'queued')
    .sort((a, b) => a.startMin - b.startMin || a.id - b.id);
  for (const e of queued) {
    const r = ctx.db.resource.resourceType.find(e.resourceType);
    if (!r || available(r) < e.amount) continue;
    ctx.db.consumptionEvent.id.update({ ...e, status: 'active', startMin: now });
    setInUse(ctx, e.resourceType, e.amount);
  }
}

/** End every active hold for a patient (on evacuation or death). */
function releasePatientResources(ctx: Ctx, patientId: number) {
  for (const e of [...ctx.db.consumptionEvent.patientId.filter(patientId)]) {
    if (e.status === 'done') continue;
    const r = ctx.db.resource.resourceType.find(e.resourceType);
    if (r && r.kind === 'reusable' && e.status === 'active') setInUse(ctx, e.resourceType, -e.amount);
    ctx.db.consumptionEvent.id.update({ ...e, status: 'done' });
  }
}

function seedResource(ctx: Ctx, type: ResourceType, capacity: number) {
  const spec = RESOURCES[type];
  ctx.db.resource.insert({
    resourceType: type,
    label: spec.label,
    unit: spec.unit,
    kind: spec.kind,
    capacity,
    inUse: 0,
    resupplyEtaMin: -1,
    resupplyAmount: 0,
  });
}

function clearAll(ctx: Ctx) {
  ctx.db.patient.clear();
  ctx.db.bed.clear();
  ctx.db.resource.clear();
  ctx.db.consumptionEvent.clear();
  ctx.db.evacSlot.clear();
  ctx.db.decision.clear();
  ctx.db.alert.clear();
  ctx.db.forecast.clear();
  ctx.db.inflowForecast.clear();
  ctx.db.evacRanking.clear();
  ctx.db.auditLog.clear();
  ctx.db.simState.clear();
}

function parseAssessment(json: string): Assessment {
  if (!json) return {};
  try {
    const v = JSON.parse(json);
    return v && typeof v === 'object' ? (v as Assessment) : {};
  } catch {
    throw new SenderError('assessment must be a JSON object');
  }
}

const CATEGORIES: TriageCategory[] = ['immediate', 'delayed', 'minimal', 'expectant', 'dead'];

// ─────────────────────────────────────────────────────────────────────────────
// Lifecycle
// ─────────────────────────────────────────────────────────────────────────────

export const init = spacetimedb.init(_ctx => {
  // State is seeded by `load_scenario`, so a fresh publish shows an empty board.
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario & clock (simulator + top bar)
// ─────────────────────────────────────────────────────────────────────────────

export const loadScenario = spacetimedb.reducer(
  {
    name: t.string(),
    title: t.string(),
    lengthMin: t.f64(),
    beds: t.u32(),
    bloodUnits: t.f64(),
    oxygenCylinders: t.f64(),
    vents: t.u32(),
    orTables: t.u32(),
    protocol: t.string(),
  },
  (ctx, a) => {
    if (a.beds === 0 || a.beds > 500) throw new SenderError('beds must be 1–500');
    if (a.protocol !== 'SALT' && a.protocol !== 'START') throw new SenderError('protocol must be SALT or START');
    clearAll(ctx);
    ctx.db.simState.insert({
      id: SIM_ID,
      scenarioName: a.name,
      scenarioTitle: a.title,
      scenarioLengthMin: a.lengthMin,
      minute: 0,
      speed: 30,
      paused: true,
      protocol: a.protocol,
      wDeterioration: 0.5,
      wResourceRelief: 0.3,
      wDestinationMatch: 0.2,
      whatIfSurge: 0,
      mlMinute: -1,
      simulatorHeartbeat: ctx.timestamp,
      mlHeartbeat: ctx.timestamp,
    });
    for (let i = 1; i <= a.beds; i++) {
      ctx.db.bed.insert({ id: i, label: `B${String(i).padStart(2, '0')}`, patientId: 0 });
    }
    seedResource(ctx, 'bed', a.beds);
    seedResource(ctx, 'blood_unit', a.bloodUnits);
    seedResource(ctx, 'o2', a.oxygenCylinders);
    seedResource(ctx, 'vent', a.vents);
    seedResource(ctx, 'or_table', a.orTables);
    audit(ctx, 'scenario.load', `${a.title} — ${a.beds} beds, ${a.bloodUnits} blood, ${a.vents} vents, ${a.orTables} OR`);
    raiseAlert(ctx, 'info', 'Scenario', `${a.title} loaded. Protocol: ${a.protocol}. All figures are synthetic.`);
  }
);

export const setPlayback = spacetimedb.reducer(
  { paused: t.bool(), speed: t.f64() },
  (ctx, { paused, speed }) => {
    const s = state(ctx);
    if (!(speed >= 1 && speed <= 120)) throw new SenderError('speed must be 1–120×');
    ctx.db.simState.id.update({ ...s, paused, speed });
    if (s.paused !== paused) audit(ctx, paused ? 'clock.pause' : 'clock.play', `at ${speed}×`);
  }
);

/** Called by the simulator every tick with the new scenario minute. */
export const advanceClock = spacetimedb.reducer({ minute: t.f64() }, (ctx, { minute }) => {
  const s = state(ctx);
  if (minute < s.minute) throw new SenderError('clock cannot go backwards');
  ctx.db.simState.id.update({ ...s, minute, simulatorHeartbeat: ctx.timestamp });

  // Consumption accounting.
  for (const e of [...ctx.db.consumptionEvent.iter()]) {
    if (e.status !== 'active') continue;
    const r = ctx.db.resource.resourceType.find(e.resourceType);
    if (!r) continue;
    if (r.kind === 'consumable') {
      const frac = e.durationMin <= 0 ? 1 : Math.min(1, (minute - e.startMin) / e.durationMin);
      const target = e.amount * Math.max(0, frac);
      const want = target - e.consumed;
      const give = Math.max(0, Math.min(want, available(r)));
      if (give > 0) setInUse(ctx, e.resourceType, give);
      const consumed = e.consumed + give;
      const exhausted = want > 0 && give < want - 1e-9;
      ctx.db.consumptionEvent.id.update({
        ...e,
        consumed,
        status: frac >= 1 || exhausted ? 'done' : 'active',
      });
      if (exhausted) {
        raiseAlert(ctx, 'red', r.label, `${r.label} exhausted — demand for patient #${e.patientId} unmet at ${fmtMin(minute)}`);
      }
    } else if (e.durationMin > 0 && minute - e.startMin >= e.durationMin) {
      setInUse(ctx, e.resourceType, -e.amount);
      ctx.db.consumptionEvent.id.update({ ...e, status: 'done' });
    }
  }
  startQueued(ctx, minute);

  // Scheduled resupply.
  for (const r of [...ctx.db.resource.iter()]) {
    if (r.resupplyEtaMin >= 0 && minute >= r.resupplyEtaMin) {
      ctx.db.resource.resourceType.update({
        ...r,
        capacity: r.capacity + r.resupplyAmount,
        resupplyEtaMin: -1,
        resupplyAmount: 0,
      });
      raiseAlert(ctx, 'info', r.label, `Resupply arrived: +${r.resupplyAmount} ${r.unit}`);
    }
  }

  // Departures.
  for (const slot of [...ctx.db.evacSlot.iter()]) {
    if (slot.status === 'open' && minute >= slot.departMin) {
      ctx.db.evacSlot.id.update({ ...slot, status: 'departed' });
      raiseAlert(
        ctx,
        'info',
        slot.callsign,
        `${slot.callsign} departed with ${slot.seatsFilled}/${slot.seats} seats filled`
      );
      for (const r of [...ctx.db.evacRanking.slotId.filter(slot.id)]) ctx.db.evacRanking.delete(r);
    }
  }
});

export const setProtocol = spacetimedb.reducer({ protocol: t.string() }, (ctx, { protocol }) => {
  if (protocol !== 'SALT' && protocol !== 'START') throw new SenderError('protocol must be SALT or START');
  const s = state(ctx);
  ctx.db.simState.id.update({ ...s, protocol });
  audit(ctx, 'settings.protocol', `Local protocol → ${protocol}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// Patients (simulator + medic intake)
// ─────────────────────────────────────────────────────────────────────────────

export const admitPatient = spacetimedb.reducer(
  {
    tag: t.string(),
    source: t.string(),
    age: t.u32(),
    injuryType: t.string(),
    mechanism: t.string(),
    hr: t.f64(),
    sbp: t.f64(),
    rr: t.f64(),
    oxygenSat: t.f64(),
    gcs: t.f64(),
    /** JSON of {@link Assessment}; empty string derives answers from vitals. */
    assessment: t.string(),
    /** Optional medic category ('' = let the protocol decide). */
    medicCategory: t.string(),
    mistCard: t.string(),
  },
  (ctx, a) => {
    const s = state(ctx);
    if (a.gcs < 3 || a.gcs > 15) throw new SenderError('GCS must be 3–15');
    const vitals = { hr: a.hr, sbp: a.sbp, rr: a.rr, spo2: a.oxygenSat, gcs: a.gcs };
    const assessment = parseAssessment(a.assessment);
    const local = s.protocol === 'START' ? 'START' : 'SALT';
    const result = triage(local, a.age, vitals, assessment);

    let category: string = result.category;
    let categorySetByMedic = false;
    const trace = [...result.trace];
    if (a.medicCategory) {
      if (!CATEGORIES.includes(a.medicCategory as TriageCategory)) {
        throw new SenderError(`medicCategory must be one of ${CATEGORIES.join(', ')}`);
      }
      if (a.medicCategory !== category) {
        trace.push(`Medic set category → ${a.medicCategory} (protocol said ${category})`);
        category = a.medicCategory;
        categorySetByMedic = true;
      }
    }

    const rts = revisedTraumaScore(vitals);
    const injury = injurySpec(a.injuryType);
    const precedence = precedenceFor(category, injury.needsSurgery);

    const inserted = ctx.db.patient.insert({
      id: 0,
      tag: a.tag,
      source: a.source,
      arrivalMin: s.minute,
      age: a.age,
      injuryType: a.injuryType,
      mechanism: a.mechanism,
      triageProtocol: categorySetByMedic ? `${protocolFor(local, a.age)} + medic` : result.protocol,
      category,
      categorySetByMedic,
      triageTrace: JSON.stringify(trace),
      hr: a.hr,
      sbp: a.sbp,
      rr: a.rr,
      oxygenSat: a.oxygenSat,
      gcs: a.gcs,
      tRts: rts.tRts,
      weightedRts: rts.weighted,
      rtsTrend: 0,
      vitalsMin: s.minute,
      evacPrecedence: precedence ?? '',
      precedenceDeadline: precedenceDeadline(s.minute, precedence),
      needsSurgery: injury.needsSurgery,
      capability: injury.capability,
      mistCard: a.mistCard,
      bedId: 0,
      status: category === 'dead' ? 'deceased' : 'waiting',
      evacSlotId: 0,
    });
    const placed = placePatient(ctx, inserted);
    if (placed.status === 'waiting') {
      raiseAlert(ctx, 'amber', 'Beds', `No free bed for ${a.tag} (${category}) — holding at intake`);
    }
    if (a.source === 'medic') {
      audit(ctx, 'patient.intake', `${a.tag}: ${result.protocol} → ${category}, T-RTS ${rts.tRts}`);
    }
  }
);

export const updateVitals = spacetimedb.reducer(
  {
    patientId: t.u32(),
    hr: t.f64(),
    sbp: t.f64(),
    rr: t.f64(),
    oxygenSat: t.f64(),
    gcs: t.f64(),
  },
  (ctx, a) => {
    const s = state(ctx);
    const p = ctx.db.patient.id.find(a.patientId);
    if (!p) throw new SenderError(`No patient #${a.patientId}`);
    if (p.status === 'evacuated' || p.status === 'deceased') return;
    const vitals = { hr: a.hr, sbp: a.sbp, rr: a.rr, spo2: a.oxygenSat, gcs: a.gcs };
    const rts = revisedTraumaScore(vitals);
    const dt = Math.max(1, s.minute - p.vitalsMin);
    const trend = ((rts.weighted - p.weightedRts) / dt) * 30;
    const local = s.protocol === 'START' ? 'START' : 'SALT';
    const next = triage(local, p.age, vitals, { hemorrhageControlled: true });
    const re = retriage(p.category, p.categorySetByMedic, next);

    let trace = p.triageTrace;
    let precedence = p.evacPrecedence;
    let deadline = p.precedenceDeadline;
    if (re.changed) {
      const steps: string[] = JSON.parse(p.triageTrace || '[]');
      steps.push(`${fmtMin(s.minute)} re-triage (${next.protocol}): ${p.category} → ${re.category}`);
      trace = JSON.stringify(steps);
      const np = precedenceFor(re.category, p.needsSurgery);
      precedence = np ?? '';
      // A tighter window starts from now, but never extends the old deadline.
      const nd = precedenceDeadline(s.minute, np);
      deadline = p.precedenceDeadline < 0 ? nd : Math.min(p.precedenceDeadline, nd);
      raiseAlert(ctx, 'amber', p.tag, `${p.tag} deteriorating — re-triaged ${p.category} → ${re.category}`);
    }
    const updated = {
      ...p,
      hr: a.hr,
      sbp: a.sbp,
      rr: a.rr,
      oxygenSat: a.oxygenSat,
      gcs: a.gcs,
      tRts: rts.tRts,
      weightedRts: rts.weighted,
      rtsTrend: Math.round(trend * 100) / 100,
      vitalsMin: s.minute,
      category: re.category,
      triageTrace: trace,
      evacPrecedence: precedence,
      precedenceDeadline: deadline,
    };
    ctx.db.patient.id.update(updated);
    if (re.changed) {
      placePatient(ctx, updated);
    }
  }
);

/** Manual triage. The only way a patient becomes Expectant. */
export const setTriage = spacetimedb.reducer(
  { patientId: t.u32(), category: t.string(), reason: t.string() },
  (ctx, { patientId, category, reason }) => {
    const s = state(ctx);
    if (!CATEGORIES.includes(category as TriageCategory)) {
      throw new SenderError(`category must be one of ${CATEGORIES.join(', ')}`);
    }
    if (!reason.trim()) throw new SenderError('A reason is required for a manual triage change');
    const p = ctx.db.patient.id.find(patientId);
    if (!p) throw new SenderError(`No patient #${patientId}`);
    const steps: string[] = JSON.parse(p.triageTrace || '[]');
    steps.push(`${fmtMin(s.minute)} medic: ${p.category} → ${category} — ${reason}`);
    const precedence = precedenceFor(category, p.needsSurgery);
    let updated = {
      ...p,
      category,
      categorySetByMedic: true,
      triageProtocol: p.triageProtocol.endsWith('+ medic') ? p.triageProtocol : `${p.triageProtocol} + medic`,
      triageTrace: JSON.stringify(steps),
      evacPrecedence: precedence ?? '',
      precedenceDeadline: precedenceDeadline(s.minute, precedence),
    };
    if (category === 'dead') {
      releasePatientResources(ctx, p.id);
      if (p.bedId !== 0) releaseBed(ctx, p.bedId);
      updated = { ...updated, bedId: 0, status: 'deceased' };
      ctx.db.patient.id.update(updated);
      backfillBeds(ctx);
    } else {
      ctx.db.patient.id.update(updated);
      placePatient(ctx, updated);
    }
    audit(ctx, 'patient.triage', `${p.tag}: ${p.category} → ${category} — ${reason}`);
  }
);

export const assignBed = spacetimedb.reducer(
  { patientId: t.u32(), bedId: t.u32() },
  (ctx, { patientId, bedId }) => {
    const p = ctx.db.patient.id.find(patientId);
    if (!p) throw new SenderError(`No patient #${patientId}`);
    const b = ctx.db.bed.id.find(bedId);
    if (!b) throw new SenderError(`No bed #${bedId}`);
    if (b.patientId !== 0 && b.patientId !== patientId) throw new SenderError(`${b.label} is occupied`);
    if (p.bedId !== 0 && p.bedId !== bedId) releaseBed(ctx, p.bedId);
    ctx.db.bed.id.update({ ...b, patientId });
    ctx.db.patient.id.update({ ...p, bedId, status: 'bedded' });
    syncBedResource(ctx);
    audit(ctx, 'patient.bed', `${p.tag} → ${b.label}`);
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Resources
// ─────────────────────────────────────────────────────────────────────────────

export const consumeResource = spacetimedb.reducer(
  { patientId: t.u32(), resourceType: t.string(), amount: t.f64(), durationMin: t.f64() },
  (ctx, a) => {
    const s = state(ctx);
    const p = ctx.db.patient.id.find(a.patientId);
    if (!p) throw new SenderError(`No patient #${a.patientId}`);
    if (p.status === 'evacuated' || p.status === 'deceased') return;
    if (!(a.amount > 0)) throw new SenderError('amount must be positive');
    const r = getResource(ctx, a.resourceType);
    if (r.resourceType === 'bed') throw new SenderError('Use assign_bed for beds');

    let status = 'active';
    if (r.kind === 'reusable') {
      if (available(r) >= a.amount) setInUse(ctx, r.resourceType, a.amount);
      else {
        status = 'queued';
        raiseAlert(ctx, 'amber', r.label, `No ${r.label.toLowerCase()} free — ${p.tag} queued`);
      }
    }
    ctx.db.consumptionEvent.insert({
      id: 0,
      patientId: p.id,
      resourceType: r.resourceType,
      amount: a.amount,
      consumed: 0,
      startMin: s.minute,
      durationMin: a.durationMin,
      status,
    });
  }
);

export const scheduleResupply = spacetimedb.reducer(
  { resourceType: t.string(), amount: t.f64(), etaMin: t.f64() },
  (ctx, { resourceType, amount, etaMin }) => {
    const r = getResource(ctx, resourceType);
    ctx.db.resource.resourceType.update({ ...r, resupplyEtaMin: etaMin, resupplyAmount: amount });
    audit(ctx, 'resource.resupply', `${r.label}: +${amount} ${r.unit} due ${fmtMin(etaMin)}`);
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// What-if panel
// ─────────────────────────────────────────────────────────────────────────────

/**
 * kind:
 *  - 'surge'          → amount hypothetical extra casualties in the next hour (forecast only)
 *  - 'lose:<type>'    → remove `amount` units of a resource from the board (e.g. lose 1 vent)
 *  - 'gain:<type>'    → add `amount` units
 */
export const applyWhatIf = spacetimedb.reducer(
  { kind: t.string(), amount: t.f64() },
  (ctx, { kind, amount }) => {
    const s = state(ctx);
    if (!(amount > 0)) throw new SenderError('amount must be positive');
    if (kind === 'surge') {
      ctx.db.simState.id.update({ ...s, whatIfSurge: s.whatIfSurge + Math.round(amount) });
      audit(ctx, 'whatif.surge', `+${Math.round(amount)} hypothetical casualties`);
      raiseAlert(ctx, 'info', 'What-if', `Forecast now includes +${s.whatIfSurge + Math.round(amount)} hypothetical casualties`);
      return;
    }
    const [op, type] = kind.split(':');
    if ((op !== 'lose' && op !== 'gain') || !type) throw new SenderError(`Unknown what-if '${kind}'`);
    if (type === 'bed') throw new SenderError('Beds cannot be changed from the what-if panel');
    const r = getResource(ctx, type);
    const capacity = op === 'lose' ? Math.max(0, r.capacity - amount) : r.capacity + amount;
    ctx.db.resource.resourceType.update({ ...r, capacity });
    audit(ctx, `whatif.${op}`, `${op === 'lose' ? '−' : '+'}${amount} ${r.unit} ${r.label}`);
    raiseAlert(
      ctx,
      op === 'lose' ? 'amber' : 'info',
      r.label,
      `${op === 'lose' ? 'Lost' : 'Added'} ${amount} ${r.unit} — capacity now ${capacity}`
    );
    if (r.kind === 'reusable' && r.inUse > capacity) {
      raiseAlert(ctx, 'red', r.label, `${r.label} over capacity: ${r.inUse} in use, ${capacity} available`);
    }
  }
);

export const clearWhatIf = spacetimedb.reducer(ctx => {
  const s = state(ctx);
  ctx.db.simState.id.update({ ...s, whatIfSurge: 0 });
  audit(ctx, 'whatif.clear', 'Hypothetical surge cleared');
});

// ─────────────────────────────────────────────────────────────────────────────
// Evacuation
// ─────────────────────────────────────────────────────────────────────────────

export const openEvacSlot = spacetimedb.reducer(
  {
    mode: t.string(),
    callsign: t.string(),
    seats: t.u32(),
    departInMin: t.f64(),
    destination: t.string(),
    capability: t.string(),
  },
  (ctx, a) => {
    const s = state(ctx);
    if (a.mode !== 'air' && a.mode !== 'ground') throw new SenderError("mode must be 'air' or 'ground'");
    if (a.seats === 0 || a.seats > 20) throw new SenderError('seats must be 1–20');
    ctx.db.evacSlot.insert({
      id: 0,
      mode: a.mode,
      callsign: a.callsign,
      seats: a.seats,
      seatsFilled: 0,
      openedMin: s.minute,
      departMin: s.minute + Math.max(1, a.departInMin),
      destination: a.destination,
      capability: a.capability,
      status: 'open',
    });
    raiseAlert(
      ctx,
      'info',
      a.callsign,
      `${a.mode === 'air' ? 'Air' : 'Ground'} slot open: ${a.seats} seats → ${a.destination}, departs in ${Math.round(a.departInMin)} min`
    );
    audit(ctx, 'evac.open', `${a.callsign}: ${a.seats} seats → ${a.destination}`);
  }
);

export const cancelEvacSlot = spacetimedb.reducer({ slotId: t.u32() }, (ctx, { slotId }) => {
  const slot = ctx.db.evacSlot.id.find(slotId);
  if (!slot) throw new SenderError(`No slot #${slotId}`);
  ctx.db.evacSlot.id.update({ ...slot, status: 'cancelled' });
  for (const r of [...ctx.db.evacRanking.slotId.filter(slotId)]) ctx.db.evacRanking.delete(r);
  audit(ctx, 'evac.cancel', slot.callsign);
});

/**
 * The human decision. `accepted = true` boards the patient; `accepted = false`
 * is an override and must carry a reason. Both are permanently logged.
 */
export const recordDecision = spacetimedb.reducer(
  {
    slotId: t.u32(),
    patientId: t.u32(),
    aiRank: t.u32(),
    accepted: t.bool(),
    overrideReason: t.string(),
  },
  (ctx, a) => {
    const s = state(ctx);
    const slot = ctx.db.evacSlot.id.find(a.slotId);
    if (!slot || slot.status !== 'open') throw new SenderError('That evacuation slot is not open');
    const p = ctx.db.patient.id.find(a.patientId);
    if (!p) throw new SenderError(`No patient #${a.patientId}`);
    if (!a.accepted && !a.overrideReason.trim()) throw new SenderError('An override needs a one-tap reason');

    if (a.accepted) {
      if (p.status === 'evacuated' || p.status === 'deceased') throw new SenderError(`${p.tag} is no longer on site`);
      if (slot.seatsFilled >= slot.seats) throw new SenderError(`${slot.callsign} is full`);
      releasePatientResources(ctx, p.id);
      if (p.bedId !== 0) releaseBed(ctx, p.bedId);
      ctx.db.patient.id.update({ ...p, bedId: 0, status: 'evacuated', evacSlotId: slot.id });
      ctx.db.evacSlot.id.update({ ...slot, seatsFilled: slot.seatsFilled + 1 });
      backfillBeds(ctx);
      startQueued(ctx, s.minute);
    }

    // Remove the patient from this slot's ranking either way; the sidecar re-ranks.
    for (const r of [...ctx.db.evacRanking.slotId.filter(slot.id)]) {
      if (r.patientId === p.id) ctx.db.evacRanking.delete(r);
    }

    ctx.db.decision.insert({
      id: 0,
      slotId: slot.id,
      patientId: p.id,
      aiRank: a.aiRank,
      accepted: a.accepted,
      overrideReason: a.overrideReason,
      minute: s.minute,
      actor: actorOf(ctx),
      at: ctx.timestamp,
    });
    audit(
      ctx,
      a.accepted ? 'evac.accept' : 'evac.override',
      a.accepted
        ? `${p.tag} (AI #${a.aiRank}) → ${slot.callsign}`
        : `${p.tag} (AI #${a.aiRank}) skipped for ${slot.callsign} — ${a.overrideReason}`
    );
  }
);

export const setWeights = spacetimedb.reducer(
  { deterioration: t.f64(), resourceRelief: t.f64(), destinationMatch: t.f64() },
  (ctx, w) => {
    const s = state(ctx);
    for (const v of [w.deterioration, w.resourceRelief, w.destinationMatch]) {
      if (!(v >= 0 && v <= 1)) throw new SenderError('weights must be 0–1');
    }
    ctx.db.simState.id.update({
      ...s,
      wDeterioration: w.deterioration,
      wResourceRelief: w.resourceRelief,
      wDestinationMatch: w.destinationMatch,
    });
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// ML sidecar write-back
// ─────────────────────────────────────────────────────────────────────────────

const LEVEL_RANK: Record<string, number> = { ok: 0, amber: 1, red: 2 };

export const writeForecast = spacetimedb.reducer(
  {
    resourceType: t.string(),
    available: t.f64(),
    capacity: t.f64(),
    ttzMedian: t.f64(),
    ttzLow: t.f64(),
    ttzHigh: t.f64(),
    burnPerHour: t.f64(),
    curve: t.string(),
  },
  (ctx, f) => {
    const s = state(ctx);
    const r = getResource(ctx, f.resourceType);
    // Thresholds from the design doc: amber under 90 min, red under 30 min.
    const level = f.ttzMedian < 0 ? 'ok' : f.ttzMedian < 30 ? 'red' : f.ttzMedian < 90 ? 'amber' : 'ok';
    const prev = ctx.db.forecast.resourceType.find(f.resourceType);
    const row = { ...f, computedMin: s.minute, level };
    if (prev) ctx.db.forecast.resourceType.update(row);
    else ctx.db.forecast.insert(row);

    const before = prev?.level ?? 'ok';
    if (LEVEL_RANK[level] > LEVEL_RANK[before]) {
      const range =
        f.ttzHigh < 0
          ? `range ${Math.round(f.ttzLow)} min to beyond 4 h`
          : `range ${Math.round(f.ttzLow)}–${Math.round(f.ttzHigh)}`;
      raiseAlert(
        ctx,
        level as 'amber' | 'red',
        r.label,
        `${r.label}: ~${Math.round(f.ttzMedian)} min to zero at current rate (${range})`
      );
    } else if (level === 'ok' && before !== 'ok') {
      raiseAlert(ctx, 'info', r.label, `${r.label}: forecast back above 90 min`);
    }
  }
);

export const writeInflow = spacetimedb.reducer(
  {
    ratePerHour: t.f64(),
    halfHour: t.f64(),
    halfHourLow: t.f64(),
    halfHourHigh: t.f64(),
    oneHour: t.f64(),
    oneHourLow: t.f64(),
    oneHourHigh: t.f64(),
    ninetyMin: t.f64(),
    ninetyMinLow: t.f64(),
    ninetyMinHigh: t.f64(),
  },
  (ctx, f) => {
    const s = state(ctx);
    const row = { id: 1, computedMin: s.minute, ...f };
    if (ctx.db.inflowForecast.id.find(1)) ctx.db.inflowForecast.id.update(row);
    else ctx.db.inflowForecast.insert(row);
    ctx.db.simState.id.update({ ...s, mlMinute: s.minute, mlHeartbeat: ctx.timestamp });
  }
);

/** Replace the ranking for one slot. `rankings` is a JSON array from the sidecar. */
export const writeRanking = spacetimedb.reducer(
  { slotId: t.u32(), rankings: t.string() },
  (ctx, { slotId, rankings }) => {
    const s = state(ctx);
    const slot = ctx.db.evacSlot.id.find(slotId);
    if (!slot || slot.status !== 'open') return;
    let rows: Array<{
      patientId: number;
      rank: number;
      score: number;
      tier: number;
      precedence: string;
      reason: string;
      factors: unknown;
    }>;
    try {
      rows = JSON.parse(rankings);
    } catch {
      throw new SenderError('rankings must be JSON');
    }
    if (!Array.isArray(rows)) throw new SenderError('rankings must be a JSON array');

    // Defence in depth: re-check the hard tier rule here, so a buggy model can
    // never place a lower-precedence patient above a higher one.
    for (let i = 1; i < rows.length; i++) {
      if (rows[i].tier < rows[i - 1].tier) {
        throw new SenderError('Ranking violates MEDEVAC precedence tiers');
      }
    }
    for (const r of [...ctx.db.evacRanking.slotId.filter(slotId)]) ctx.db.evacRanking.delete(r);
    for (const r of rows.slice(0, 10)) {
      const p = ctx.db.patient.id.find(r.patientId);
      if (!p || p.status === 'evacuated' || p.status === 'deceased') continue;
      ctx.db.evacRanking.insert({
        id: 0,
        slotId,
        patientId: r.patientId,
        rank: r.rank,
        score: r.score,
        tier: r.tier,
        precedence: r.precedence,
        reason: r.reason,
        factors: JSON.stringify(r.factors ?? []),
        computedMin: s.minute,
      });
    }
  }
);

/** Precedence-window breach alerts, raised by the sidecar once per patient. */
export const flagPrecedenceBreach = spacetimedb.reducer({ patientId: t.u32() }, (ctx, { patientId }) => {
  const p = ctx.db.patient.id.find(patientId);
  if (!p) return;
  raiseAlert(ctx, 'red', p.tag, `${p.tag} (${p.evacPrecedence}) has passed its evacuation window`);
});
