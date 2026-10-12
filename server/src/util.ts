// WebCrypto + encoding helpers (no node:crypto, no Buffer: runs on Workers without nodejs_compat).
const enc = new TextEncoder();
/** Env flag: '1' or 'true'. */
export const on = (v: string | undefined) => v === '1' || v === 'true';
export const utf8 = (s: string) => enc.encode(s);
export const fromUtf8 = (b: Uint8Array): string => new TextDecoder().decode(b);

export function b64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export const b64url = (bytes: Uint8Array): string => b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export function unb64url(s: string) {
  const t = s.replace(/-/g, '+').replace(/_/g, '/');
  return unb64(t + '='.repeat((4 - (t.length % 4)) % 4));
}

export const randomBytes = (n: number) => crypto.getRandomValues(new Uint8Array(n));
export const randomHex = (n: number): string => [...randomBytes(n)].map((b) => b.toString(16).padStart(2, '0')).join('');
export const randomB64url = (n: number): string => b64url(randomBytes(n));

export async function sha256(data: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', utf8(data)));
}
export const sha256b64url = async (s: string): Promise<string> => b64url(await sha256(s));
export const sha256b64 = async (s: string): Promise<string> => b64(await sha256(s));
export const sha256hex = async (s: string): Promise<string> => [...(await sha256(s))].map((b) => b.toString(16).padStart(2, '0')).join('');

/** D1 allows at most 100 bound parameters per statement: split big IN (...) lists. */
export function chunk<T>(items: T[], size = 90): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
