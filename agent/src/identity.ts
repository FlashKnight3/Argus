/** Persisted SpacetimeDB identity tokens (kept out of Git under .argus-supply/). */
import { mkdirSync, openSync, readFileSync, writeSync, closeSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const SERVICE_TOKEN = resolve(ROOT, '.argus-supply/service.json');

export interface Credentials { identity: string; token: string }

export async function loadOrCreate(host: string, file: string = SERVICE_TOKEN): Promise<Credentials> {
  if (existsSync(file)) {
    const saved = JSON.parse(readFileSync(file, 'utf8')) as Credentials;
    if (saved.identity && saved.token) return saved;
  }
  const response = await fetch(`${host.replace(/\/$/, '')}/v1/identity`, { method: 'POST' });
  if (!response.ok) throw new Error(`SpacetimeDB did not issue an identity (HTTP ${response.status})`);
  const body = await response.json() as Credentials;
  if (!body.identity || !body.token) throw new Error('SpacetimeDB did not return an identity and token');
  mkdirSync(dirname(file), { recursive: true });
  const fd = openSync(file, 'wx', 0o600);
  writeSync(fd, JSON.stringify({ identity: body.identity, token: body.token }));
  closeSync(fd);
  return body;
}
