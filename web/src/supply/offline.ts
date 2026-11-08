/**
 * Offline-first writes. Each human write gets a client operation ID. If the browser is offline,
 * or a call's outcome is unknown because the connection dropped mid-flight, the write is queued
 * in localStorage and replayed on reconnect. The server's op_receipt table makes a replay of an
 * already-applied write a no-op, so "retry until acknowledged" is safe. A replay the server
 * rejects (e.g. a revision conflict) moves to `conflicts` for a person to resolve.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { SupplyActions } from './useSupply';

export type QueueableReducer = 'upsertInventory' | 'recordStock' | 'createTransfer';
type ArgsOf<K extends QueueableReducer> = Parameters<SupplyActions[K]>[0];

export interface QueuedOp<K extends QueueableReducer = QueueableReducer> {
  opId: string;
  reducer: K;
  args: ArgsOf<K>;
  label: string;
  queuedAt: number;
}
export interface Conflict extends QueuedOp { error: string }

const CALL_TIMEOUT_MS = 8000;

function storageKey(db: string) { return `argus-supply:${db}:offline-queue`; }

function read<T>(key: string): T[] {
  try { return JSON.parse(localStorage.getItem(key) ?? '[]') as T[]; } catch { return []; }
}
function write(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage may be unavailable */ }
}

export function newOpId(): string {
  try { return crypto.randomUUID(); } catch { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`; }
}

class UnknownOutcome extends Error {}

function withTimeout(promise: Promise<void>): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new UnknownOutcome('No acknowledgement before timeout')), CALL_TIMEOUT_MS);
    promise.then(() => { clearTimeout(timer); resolve(); }, error => { clearTimeout(timer); reject(error); });
  });
}

export function useOfflineQueue(db: string, connected: boolean, actions: SupplyActions) {
  const qKey = storageKey(db);
  const cKey = `${qKey}:conflicts`;
  const [queue, setQueue] = useState<QueuedOp[]>(() => read<QueuedOp>(qKey));
  const [conflicts, setConflicts] = useState<Conflict[]>(() => read<Conflict>(cKey));
  const [flushing, setFlushing] = useState(false);
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  const connectedRef = useRef(connected);
  connectedRef.current = connected;

  const saveQueue = useCallback((next: QueuedOp[]) => { write(qKey, next); setQueue(next); }, [qKey]);
  const saveConflicts = useCallback((next: Conflict[]) => { write(cKey, next); setConflicts(next); }, [cKey]);

  const call = useCallback((op: QueuedOp) => {
    const fn = actionsRef.current[op.reducer] as (args: unknown) => Promise<void>;
    return withTimeout(fn(op.args));
  }, []);

  /** Submit a write: applied now when online, otherwise queued. Resolves to 'applied' | 'queued'. */
  const submit = useCallback(async <K extends QueueableReducer>(reducer: K, args: ArgsOf<K>, label: string): Promise<'applied' | 'queued'> => {
    const op: QueuedOp = { opId: (args as { opId: string }).opId, reducer, args, label, queuedAt: Date.now() };
    const enqueue = () => { saveQueue([...read<QueuedOp>(qKey), op]); return 'queued' as const; };
    if (!connectedRef.current || read<QueuedOp>(qKey).length) return enqueue(); // keep order behind earlier queued writes
    try { await call(op); return 'applied'; }
    catch (error) {
      if (error instanceof UnknownOutcome || !connectedRef.current) return enqueue();
      throw error;
    }
  }, [call, qKey, saveQueue]);

  const flushingRef = useRef(false);
  const [retryTick, setRetryTick] = useState(0);
  useEffect(() => {
    if (!queue.length) return;
    const timer = setInterval(() => setRetryTick(n => n + 1), 10_000);
    return () => clearInterval(timer);
  }, [queue.length]);
  useEffect(() => {
    if (!connected || flushingRef.current || !queue.length) return;
    flushingRef.current = true;
    setFlushing(true);
    (async () => {
      let pending = read<QueuedOp>(qKey);
      while (pending.length && connectedRef.current) {
        const op = pending[0];
        try { await call(op); }
        catch (error) {
          if (error instanceof UnknownOutcome || !connectedRef.current) break; // retry on the next reconnect
          saveConflicts([...read<Conflict>(cKey), { ...op, error: error instanceof Error ? error.message : String(error) }]);
        }
        pending = read<QueuedOp>(qKey).filter(x => x.opId !== op.opId);
        saveQueue(pending);
      }
    })().finally(() => { flushingRef.current = false; setFlushing(false); });
  }, [connected, queue.length, retryTick, call, qKey, cKey, saveQueue, saveConflicts]);

  const discardConflict = useCallback((opId: string) => saveConflicts(read<Conflict>(cKey).filter(c => c.opId !== opId)), [cKey, saveConflicts]);

  return { queue, conflicts, flushing, submit, discardConflict };
}

export type OfflineQueue = ReturnType<typeof useOfflineQueue>;
