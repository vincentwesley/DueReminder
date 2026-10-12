export const CSRF_MESSAGE = 'Missing X-Requested-With: fetch header';

/** True for a state-changing request (not GET/HEAD/OPTIONS) that lacks the custom header a cross-site form or simple request cannot send. */
export const failsCsrf = (req: Request): boolean =>
  !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.get('x-requested-with') !== 'fetch';
