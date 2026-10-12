import { randomB64url } from '../util.js';

export const generateCodeVerifier = (): string => randomB64url(48); // 64 chars, within RFC 7636 43..128
export const generateState = (): string => randomB64url(32);
