import { useMemo } from 'react';
import { useProcedure, useReducer, useSpacetimeDB, useTable } from 'spacetimedb/react';
import { procedures, reducers, tables } from '../supply_bindings';
// View rows share their base table's shape; the generated *View aliases are empty, so use the table types.
import type {
  Activity, AgentRun, AgentStep, Invite, NetworkConfig as Config, Forecast, Inventory, Lease, MatchSuggestion,
  Member, ModelMetric as Metric, Proposal, Shortage, Site, StockEvent, SyncState, Transfer, Worker,
} from '../supply_bindings/types';

export type { Activity, AgentRun, AgentStep, Invite, Config, Forecast, Inventory, Lease, MatchSuggestion, Member, Metric, Proposal,
  Shortage, Site, StockEvent, SyncState, Transfer, Worker };

export function useSupply() {
  const connection = useSpacetimeDB();
  const [status, statusReady] = useTable(tables.networkStatus);
  const [sites, sitesReady] = useTable(tables.siteView);
  const [members, membersReady] = useTable(tables.memberView);
  const [inventory] = useTable(tables.inventoryView);
  const [stockEvents] = useTable(tables.stockEventView);
  const [shortages] = useTable(tables.shortage);
  const [syncStates] = useTable(tables.syncState);
  const [transfers] = useTable(tables.transferView);
  const [forecasts] = useTable(tables.forecastView);
  const [proposals] = useTable(tables.proposalView);
  const [activity] = useTable(tables.activityView);
  const [configs] = useTable(tables.configView);
  const [workers] = useTable(tables.workerView);
  const [leases] = useTable(tables.leaseView);
  const [agentRuns] = useTable(tables.agentRunView);
  const [agentSteps] = useTable(tables.agentStepView);
  const [matches] = useTable(tables.matchView);
  const [metrics] = useTable(tables.metricView);
  const [invites] = useTable(tables.inviteView);
  const identity = connection.identity?.toHexString().toLowerCase() ?? '';

  return useMemo(() => ({
    connected: connection.isActive,
    ready: statusReady && sitesReady && membersReady,
    identity,
    initialized: status[0]?.initialized ?? false,
    sandbox: status[0]?.sandbox ?? false,
    me: members.find(member => member.identity.toLowerCase() === identity),
    sites: [...sites].sort((a, b) => a.id - b.id),
    members,
    inventory: [...inventory].sort((a, b) => a.label.localeCompare(b.label) || a.siteId - b.siteId),
    stockEvents: [...stockEvents].sort((a, b) => b.id - a.id),
    shortages,
    sync: syncStates[0],
    transfers: [...transfers].sort((a, b) => b.id - a.id),
    forecasts: new Map(forecasts.map(row => [row.key, row])),
    proposals: [...proposals].sort((a, b) => b.createdAt.microsSinceUnixEpoch > a.createdAt.microsSinceUnixEpoch ? 1 : -1),
    activity: [...activity].sort((a, b) => b.id - a.id),
    config: configs[0],
    workers: [...workers].sort((a, b) => a.name.localeCompare(b.name)),
    leases: [...leases].sort((a, b) => a.resource.localeCompare(b.resource)),
    agentRuns: [...agentRuns].sort((a, b) => b.id - a.id),
    agentSteps: [...agentSteps].sort((a, b) => a.id - b.id),
    matches,
    metrics: [...metrics].sort((a, b) => a.siteId - b.siteId),
    invites: [...invites].sort((a, b) => a.email.localeCompare(b.email)),
  }), [connection.isActive, statusReady, sitesReady, membersReady, identity, status, sites, members, inventory, stockEvents,
    shortages, syncStates, transfers, forecasts, proposals, activity, configs, workers, leases, agentRuns, agentSteps, matches, metrics, invites]);
}

export type SupplyState = ReturnType<typeof useSupply>;

export function useActions() {
  return {
    bootstrapNetwork: useReducer(reducers.bootstrapNetwork),
    joinNetwork: useReducer(reducers.joinNetwork),
    inviteMember: useReducer(reducers.inviteMember),
    cancelInvite: useReducer(reducers.cancelInvite),
    updateMember: useReducer(reducers.updateMember),
    claimSandboxAdmin: useReducer(reducers.claimSandboxAdmin),
    createSite: useReducer(reducers.createSite),
    grantMember: useReducer(reducers.grantMember),
    revokeMember: useReducer(reducers.revokeMember),
    setNetworkConfig: useReducer(reducers.setNetworkConfig),
    upsertInventory: useReducer(reducers.upsertInventory),
    recordStock: useReducer(reducers.recordStock),
    createTransfer: useReducer(reducers.createTransfer),
    approveTransfer: useReducer(reducers.approveTransfer),
    shipTransfer: useReducer(reducers.shipTransfer),
    receiveTransfer: useReducer(reducers.receiveTransfer),
    cancelTransfer: useReducer(reducers.cancelTransfer),
    acceptProposal: useReducer(reducers.acceptProposal),
    dismissProposal: useReducer(reducers.dismissProposal),
    acceptMatch: useReducer(reducers.acceptMatch),
    dismissMatch: useReducer(reducers.dismissMatch),
    requestAgentRun: useReducer(reducers.requestAgentRun),
    /** Runs inside the database: downloads the FDA feed over HTTP and commits it in one transaction. */
    refreshFda: useProcedure(procedures.refreshFda),
  };
}

export type SupplyActions = ReturnType<typeof useActions>;
