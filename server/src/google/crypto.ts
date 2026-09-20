import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

// AES-256-GCM with a key derived from SESSION_SECRET via scrypt. Format: "v1:" + base64(iv|tag|ciphertext).
const keyCache = new Map<string, Buffer>();

function deriveKey(secret: string): Buffer {
  let k = keyCache.get(secret);
  if (!k) {
    k = scryptSync(secret, 'reminder-system/google-token-key/v1', 32);
    keyCache.set(secret, k);
  }
  return k;
}

export function encryptToken(plain: string, secret: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', deriveKey(secret), iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return 'v1:' + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}

export function decryptToken(enc: string, secret: string): string {
  if (!enc.startsWith('v1:')) throw new Error('Unsupported token ciphertext version');
  const buf = Buffer.from(enc.slice(3), 'base64');
  const d = createDecipheriv('aes-256-gcm', deriveKey(secret), buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
}
