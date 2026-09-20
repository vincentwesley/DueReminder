import type { ApiError } from '../../shared/types.js';

export type ErrorCode = ApiError['error']['code'];

export class AppError extends Error {
  constructor(public status: number, public code: ErrorCode, message: string, public details?: unknown) {
    super(message);
  }
}
export const badRequest = (m: string, d?: unknown) => new AppError(400, 'bad_request', m, d);
export const notFound = (m = 'Not found') => new AppError(404, 'not_found', m);
export const unauthorized = (m = 'Authentication required') => new AppError(401, 'unauthorized', m);
export const conflict = (m: string, d?: unknown) => new AppError(409, 'conflict', m, d);
