import { randomB64url, sha256b64url } from '../util.js';

export const generateCodeVerifier = (): string => randomB64url(48); // 64 chars, within RFC 7636 43..128
export const codeChallengeS256 = (verifier: string): Promise<string> => sha256b64url(verifier);
export const generateState = (): string => randomB64url(32);
