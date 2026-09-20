import { createHash, randomBytes } from 'node:crypto';

export const generateCodeVerifier = (): string => randomBytes(48).toString('base64url'); // 64 chars, within RFC 7636 43..128
export const codeChallengeS256 = (verifier: string): string => createHash('sha256').update(verifier).digest('base64url');
export const generateState = (): string => randomBytes(32).toString('base64url');
