import { createHash, createPublicKey, createVerify } from 'node:crypto';
import { certsUrl, type GoogleCtx } from './config';
import { doFetch } from './tokens';

export interface IdClaims {
  iss: string; aud: string; sub: string; exp: number; email?: string; email_verified?: boolean; name?: string; picture?: string; nonce?: string;
}

/** Deterministic nonce bound to the state value (no extra storage needed). */
export const nonceFor = (state: string): string => createHash('sha256').update('nonce:' + state).digest('base64url');

const b64json = (s: string) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as Record<string, unknown>;

let jwksCache: { at: number; keys: Array<Record<string, string>> } | null = null;

async function jwks(ctx: GoogleCtx): Promise<Array<Record<string, string>>> {
  if (jwksCache && Date.now() - jwksCache.at < 3_600_000) return jwksCache.keys;
  const res = await doFetch(ctx, certsUrl(ctx.config));
  if (!res.ok) throw new Error(`JWKS fetch failed (${res.status})`);
  const body = (await res.json()) as { keys: Array<Record<string, string>> };
  jwksCache = { at: Date.now(), keys: body.keys };
  return body.keys;
}

/** Validates iss/aud/exp/nonce; verifies the RS256 signature when `verifyIdTokenSignature` is on (real Google). */
export async function verifyIdToken(ctx: GoogleCtx, idToken: string, state: string): Promise<IdClaims> {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new Error('Malformed id_token');
  const header = b64json(parts[0]!);
  const claims = b64json(parts[1]!) as unknown as IdClaims;
  const c = ctx.config;

  if (c.verifyIdTokenSignature) {
    if (header.alg !== 'RS256') throw new Error('Unsupported id_token alg');
    const key = (await jwks(ctx)).find((k) => k.kid === header.kid);
    if (!key) throw new Error('id_token signing key not found');
    const ok = createVerify('RSA-SHA256')
      .update(`${parts[0]}.${parts[1]}`)
      .verify(createPublicKey({ key: key as never, format: 'jwk' }), Buffer.from(parts[2]!, 'base64url'));
    if (!ok) throw new Error('id_token signature invalid');
  }
  if (claims.nonce !== nonceFor(state)) throw new Error('id_token nonce mismatch');
  if (!['https://accounts.google.com', 'accounts.google.com', c.authBase].includes(claims.iss)) throw new Error('id_token issuer invalid');
  if (claims.aud !== c.clientId) throw new Error('id_token audience mismatch');
  if (typeof claims.exp !== 'number' || claims.exp * 1000 < Date.now()) throw new Error('id_token expired');
  if (!claims.sub) throw new Error('id_token missing sub');
  return claims;
}
