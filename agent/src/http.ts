/** Minimal SpacetimeDB HTTP client for scripts and tests (reducer calls and SQL). */
export class DbHttpError extends Error {}

type SqlResult = Array<{ schema?: { elements?: Array<{ name?: string | { some?: string } }> }; rows?: unknown[][] }>;

function decode(value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 1 && /^__.*__$/.test(entries[0][0])) return entries[0][1];
  }
  return value;
}

export class DbHttp {
  constructor(public host: string, public db: string, public token: string) {}

  private async post(path: string, body: string, contentType: string): Promise<unknown> {
    const response = await fetch(`${this.host.replace(/\/$/, '')}${path}`, {
      method: 'POST', body, headers: { 'Content-Type': contentType, Authorization: `Bearer ${this.token}` },
    });
    const text = await response.text();
    if (!response.ok) throw new DbHttpError(`HTTP ${response.status} ${path}: ${text.slice(0, 400)}`);
    return text ? JSON.parse(text) : null;
  }

  async call(reducer: string, ...args: unknown[]): Promise<void> {
    await this.post(`/v1/database/${this.db}/call/${reducer}`, JSON.stringify(args, (_k, v) => (typeof v === 'bigint' ? Number(v) : v)), 'application/json');
  }

  async sql<T = Record<string, unknown>>(query: string): Promise<T[]> {
    const result = await this.post(`/v1/database/${this.db}/sql`, query, 'text/plain') as SqlResult;
    const part = result?.[0];
    const cols = (part?.schema?.elements ?? []).map((e, i) => typeof e.name === 'string' ? e.name : e.name?.some ?? `col${i}`);
    return (part?.rows ?? []).map(row => Object.fromEntries(cols.map((c, i) => [c, decode(row[i])])) as T);
  }
}

export async function newIdentity(host: string): Promise<{ identity: string; token: string }> {
  const response = await fetch(`${host.replace(/\/$/, '')}/v1/identity`, { method: 'POST' });
  if (!response.ok) throw new DbHttpError(`identity HTTP ${response.status}`);
  return await response.json() as { identity: string; token: string };
}
