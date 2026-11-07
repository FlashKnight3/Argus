import { useMemo } from 'react';
import { useReducer, useSpacetimeDB, useTable } from 'spacetimedb/react';
import { reducers, tables } from '../supply_bindings';
import type { Activity, Forecast, Inventory, Member, Proposal, Shortage, Site, StockEvent, SyncState, Transfer } from '../supply_bindings/types';

export type { Activity, Forecast, Inventory, Member, Proposal, Shortage, Site, StockEvent, SyncState, Transfer };

export function useSupply() {
  const connection = useSpacetimeDB();
  const [sites, sitesReady] = useTable(tables.site);
  const [members, membersReady] = useTable(tables.member);
  const [inventory] = useTable(tables.inventory);
  const [stockEvents] = useTable(tables.stockEvent);
  const [shortages] = useTable(tables.shortage);
  const [syncStates] = useTable(tables.syncState);
  const [transfers] = useTable(tables.transfer);
  const [forecasts] = useTable(tables.forecast);
  const [proposals] = useTable(tables.proposal);
  const [activity] = useTable(tables.activity);
  const identity = connection.identity?.toHexString().toLowerCase() ?? '';

  return useMemo(() => ({
    connected: connection.isActive,
    ready: sitesReady && membersReady,
    identity,
    me: members.find(member => member.identity.toLowerCase() === identity),
    sites: [...sites].sort((a, b) => a.id - b.id),
    members,
    inventory: [...inventory].sort((a, b) => a.label.localeCompare(b.label)),
    stockEvents: [...stockEvents].sort((a, b) => b.id - a.id),
    shortages,
    sync: syncStates[0],
    transfers: [...transfers].sort((a, b) => b.id - a.id),
    forecasts: new Map(forecasts.map(row => [row.key, row])),
    proposals: [...proposals].sort((a, b) => b.createdAt.microsSinceUnixEpoch > a.createdAt.microsSinceUnixEpoch ? 1 : -1),
    activity: [...activity].sort((a, b) => b.id - a.id),
  }), [connection.isActive, sitesReady, membersReady, identity, sites, members, inventory,
    stockEvents, shortages, syncStates, transfers, forecasts, proposals, activity]);
}

export function useActions() {
  return {
    bootstrapNetwork: useReducer(reducers.bootstrapNetwork),
    createSite: useReducer(reducers.createSite),
    grantMember: useReducer(reducers.grantMember),
    upsertInventory: useReducer(reducers.upsertInventory),
    recordStock: useReducer(reducers.recordStock),
    createTransfer: useReducer(reducers.createTransfer),
    approveTransfer: useReducer(reducers.approveTransfer),
    shipTransfer: useReducer(reducers.shipTransfer),
    receiveTransfer: useReducer(reducers.receiveTransfer),
    cancelTransfer: useReducer(reducers.cancelTransfer),
    acceptProposal: useReducer(reducers.acceptProposal),
    dismissProposal: useReducer(reducers.dismissProposal),
    beginFdaSync: useReducer(reducers.beginFdaSync),
    importFdaBatch: useReducer(reducers.importFdaBatch),
    finishFdaSync: useReducer(reducers.finishFdaSync),
  };
}

export type SupplyState = ReturnType<typeof useSupply>;
export type SupplyActions = ReturnType<typeof useActions>;
