/** Methods that never change state and so need no CSRF header. */
export const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);
export const isSafeMethod = (method: string): boolean => SAFE_METHODS.has(method);

export const CSRF_MESSAGE = 'Missing X-Requested-With: fetch header';

/** True when the request carries the custom header a cross-site form or simple request cannot send. */
export const hasCsrfHeader = (req: Request): boolean => (req.headers.get('x-requested-with') ?? '') === 'fetch';

/** True when the request is a state-changing one that lacks the CSRF header. */
export const failsCsrf = (req: Request): boolean => !isSafeMethod(req.method) && !hasCsrfHeader(req);
