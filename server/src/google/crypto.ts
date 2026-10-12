import { b64, fromUtf8, randomBytes, unb64, utf8 } from '../util.js';

// AES-256-GCM (WebCrypto) with a key derived from SESSION_SECRET via HKDF-SHA-256 (the secret is a 32+ char random value, not a password).
// Format: "v2:" + base64(iv(12) | ciphertext+tag).
const keys = new Map<string, Promise<CryptoKey>>();

function deriveKey(secret: string): Promise<CryptoKey> {
  let k = keys.get(secret);
  if (!k) {
    k = crypto.subtle.importKey('raw', utf8(secret), 'HKDF', false, ['deriveKey']).then((base) =>
      crypto.subtle.deriveKey(
        { name: 'HKDF', hash: 'SHA-256', salt: utf8('reminder-system/google-token-key/v2'), info: utf8('aes-256-gcm') },
        base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']));
    keys.set(secret, k);
  }
  return k;
}

export async function encryptToken(plain: string, secret: string): Promise<string> {
  const iv = randomBytes(12);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, await deriveKey(secret), utf8(plain)));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return 'v2:' + b64(out);
}

export async function decryptToken(enc: string, secret: string): Promise<string> {
  if (!enc.startsWith('v2:')) throw new Error('Unsupported token ciphertext version');
  const buf = unb64(enc.slice(3));
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf.subarray(0, 12) as BufferSource }, await deriveKey(secret), buf.subarray(12) as BufferSource);
  return fromUtf8(new Uint8Array(pt));
}
