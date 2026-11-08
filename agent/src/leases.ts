/** Deterministic lease assignment: every worker computes the same map from the same view. */
import { createHash } from 'node:crypto';

function score(resource: string, worker: string): number {
  return createHash('sha256').update(`${resource}|${worker}`).digest().readUInt32BE(0);
}

/**
 * Rendezvous hashing with a fair-share cap: each resource goes to its highest-scoring live
 * worker that still has room (ceil(R / W)). Stable when membership is stable; when a worker
 * joins or leaves, only the resources it gains or loses move.
 */
export function assignLeases(resources: readonly string[], workers: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (!workers.length) return out;
  const cap = Math.ceil(resources.length / workers.length);
  const load = new Map(workers.map(w => [w, 0]));
  const ordered = [...resources].sort();
  for (const resource of ordered) {
    const ranked = [...workers].sort((a, b) => score(resource, b) - score(resource, a) || a.localeCompare(b));
    const owner = ranked.find(w => (load.get(w) ?? 0) < cap) ?? ranked[0];
    out.set(resource, owner);
    load.set(owner, (load.get(owner) ?? 0) + 1);
  }
  return out;
}

export interface LeaseRow { resource: string; holder: string; epoch: bigint; expiresAtMicros: bigint }

/** What a worker should do this tick, given the shared assignment and current lease rows. */
export function leaseActions(me: string, assignment: ReadonlyMap<string, string>, leases: readonly LeaseRow[], nowMicros: bigint) {
  const byResource = new Map(leases.map(l => [l.resource, l]));
  const acquire: string[] = [];
  const release: string[] = [];
  for (const [resource, owner] of assignment) {
    const lease = byResource.get(resource);
    const live = !!lease && !!lease.holder && lease.expiresAtMicros > nowMicros;
    if (owner === me && (!live || lease!.holder === me)) {
      if (!live || lease!.holder !== me) acquire.push(resource);
    }
    if (owner !== me && live && lease!.holder === me) release.push(resource);
  }
  for (const l of leases) {
    if (l.holder === me && l.expiresAtMicros > nowMicros && !assignment.has(l.resource)) release.push(l.resource);
  }
  return { acquire, release };
}
