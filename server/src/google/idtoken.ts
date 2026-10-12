import { certsUrl, type GoogleCtx } from './config';
import { doFetch } from './tokens';
import { fromUtf8, sha256b64url, unb64url } from '../util.js';

export interface IdClaims {
  iss: string; aud: string; sub: string; exp: number; email?: string; email_verified?: boolean; name?: string; picture?: string; nonce?: string;
}

/** Deterministic nonce bound to the state value (no extra storage needed). */
export const nonceFor = (state: string): Promise<string> => sha256b64url('nonce:' + state);

const b64json = (s: string) => JSON.parse(fromUtf8(unb64url(s))) as Record<string, unknown>;

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
    const jwk = (await jwks(ctx)).find((k) => k.kid === header.kid);
    if (!jwk) throw new Error('id_token signing key not found');
    const key = await crypto.subtle.importKey('jwk', jwk as JsonWebKey, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, unb64url(parts[2]!) as BufferSource, signed);
    if (!ok) throw new Error('id_token signature invalid');
  }
  if (claims.nonce !== (await nonceFor(state))) throw new Error('id_token nonce mismatch');
  if (!['https://accounts.google.com', 'accounts.google.com', c.authBase].includes(claims.iss)) throw new Error('id_token issuer invalid');
  if (claims.aud !== c.clientId) throw new Error('id_token audience mismatch');
  if (typeof claims.exp !== 'number' || claims.exp * 1000 < Date.now()) throw new Error('id_token expired');
  if (!claims.sub) throw new Error('id_token missing sub');
  return claims;
}
