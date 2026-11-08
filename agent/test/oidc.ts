/**
 * A minimal OIDC issuer for tests: serves discovery + JWKS on localhost and signs RS256 ID tokens.
 * SpacetimeDB verifies these exactly like SpacetimeAuth tokens (it fetches the issuer's JWKS).
 */
import { createServer, type Server } from 'node:http';
import { createSign, generateKeyPairSync } from 'node:crypto';

export const TEST_ISSUER_PORT = Number(process.env.ARGUS_TEST_OIDC_PORT ?? 4499);
export const TEST_ISSUER = `http://localhost:${TEST_ISSUER_PORT}`;
export const TEST_CLIENT = 'client_argus_test';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' };

export function startIssuer(): Promise<Server> {
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url?.startsWith('/.well-known/openid-configuration')) return res.end(JSON.stringify({ issuer: TEST_ISSUER, jwks_uri: `${TEST_ISSUER}/jwks` }));
    if (req.url?.startsWith('/jwks')) return res.end(JSON.stringify({ keys: [jwk] }));
    res.statusCode = 404; res.end('{}');
  });
  return new Promise(resolve => server.listen(TEST_ISSUER_PORT, () => resolve(server)));
}

export function idToken(claims: { sub: string; email: string; name?: string; aud?: string; email_verified?: boolean }): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'RS256', typ: 'JWT', kid: 'test-key' });
  const body = b64({ iss: TEST_ISSUER, aud: [claims.aud ?? TEST_CLIENT], iat: now, exp: now + 3600, email_verified: true, ...claims });
  const sig = createSign('RSA-SHA256').update(`${head}.${body}`).sign(privateKey).toString('base64url');
  return `${head}.${body}.${sig}`;
}
