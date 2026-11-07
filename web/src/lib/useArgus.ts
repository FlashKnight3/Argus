import { useMemo } from 'react';
import { useReducer, useSpacetimeDB, useTable } from 'spacetimedb/react';
import { reducers, tables } from '../module_bindings';
import type {
  Alert,
  AuditLog,
  Bed,
  ConsumptionEvent,
  Decision,
  EvacRanking,
  EvacSlot,
  Forecast,
  InflowForecast,
  Patient,
  Resource,
  SimState,
} from '../module_bindings/types';

export type {
  Alert,
  AuditLog,
  Bed,
  ConsumptionEvent,
  Decision,
  EvacRanking,
  EvacSlot,
  Forecast,
  InflowForecast,
  Patient,
  Resource,
  SimState,
};

export interface ArgusState {
  connected: boolean;
  ready: boolean;
  sim: SimState | undefined;
  patients: readonly Patient[];
  patientsById: Map<number, Patient>;
  beds: readonly Bed[];
  resources: Map<string, Resource>;
  events: readonly ConsumptionEvent[];
  eventsByPatient: Map<number, ConsumptionEvent[]>;
  slots: readonly EvacSlot[];
  decisions: readonly Decision[];
  alerts: readonly Alert[];
  forecasts: Map<string, Forecast>;
  inflow: InflowForecast | undefined;
  rankings: readonly EvacRanking[];
  audit: readonly AuditLog[];
}

/** Every table the dashboard renders, kept live by SpacetimeDB subscriptions. */
export function useArgus(): ArgusState {
  const { isActive } = useSpacetimeDB();
  const [simRows, simReady] = useTable(tables.simState);
  const [patients, patientsReady] = useTable(tables.patient);
  const [beds] = useTable(tables.bed);
  const [resourceRows] = useTable(tables.resource);
  const [events] = useTable(tables.consumptionEvent);
  const [slots] = useTable(tables.evacSlot);
  const [decisions] = useTable(tables.decision);
  const [alerts] = useTable(tables.alert);
  const [forecastRows] = useTable(tables.forecast);
  const [inflowRows] = useTable(tables.inflowForecast);
  const [rankings] = useTable(tables.evacRanking);
  const [audit] = useTable(tables.auditLog);

  return useMemo(() => {
    const eventsByPatient = new Map<number, ConsumptionEvent[]>();
    for (const e of events) {
      const list = eventsByPatient.get(e.patientId) ?? [];
      list.push(e);
      eventsByPatient.set(e.patientId, list);
    }
    return {
      connected: isActive,
      ready: simReady && patientsReady,
      sim: simRows[0],
      patients,
      patientsById: new Map(patients.map(p => [p.id, p])),
      beds: [...beds].sort((a, b) => a.id - b.id),
      resources: new Map(resourceRows.map(r => [r.resourceType, r])),
      events,
      eventsByPatient,
      slots,
      decisions,
      alerts: [...alerts].sort((a, b) => b.id - a.id),
      forecasts: new Map(forecastRows.map(f => [f.resourceType, f])),
      inflow: inflowRows[0],
      rankings,
      audit: [...audit].sort((a, b) => b.id - a.id),
    };
  }, [
    isActive, simRows, simReady, patients, patientsReady, beds, resourceRows, events, slots,
    decisions, alerts, forecastRows, inflowRows, rankings, audit,
  ]);
}

/** Reducer calls, each returning a promise that rejects with the module's error. */
export function useActions() {
  return {
    setPlayback: useReducer(reducers.setPlayback),
    setProtocol: useReducer(reducers.setProtocol),
    admitPatient: useReducer(reducers.admitPatient),
    setTriage: useReducer(reducers.setTriage),
    assignBed: useReducer(reducers.assignBed),
    applyWhatIf: useReducer(reducers.applyWhatIf),
    clearWhatIf: useReducer(reducers.clearWhatIf),
    openEvacSlot: useReducer(reducers.openEvacSlot),
    cancelEvacSlot: useReducer(reducers.cancelEvacSlot),
    recordDecision: useReducer(reducers.recordDecision),
    setWeights: useReducer(reducers.setWeights),
  };
}

export function heartbeatAgeMs(ts: { microsSinceUnixEpoch: bigint } | undefined): number {
  if (!ts) return Infinity;
  return Date.now() - Number(ts.microsSinceUnixEpoch / 1000n);
}
