export class GoogleHttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public reasons: string[] = [],
    public retryAfterMs?: number,
    public body?: unknown,
  ) {
    super(message);
    this.name = 'GoogleHttpError';
  }
}

/** Connectivity failure (DNS, refused, timeout). Triggers offline status; outbox is retained. */
export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkError';
  }
}

/** Refresh token invalid/revoked or 401 persisted after refresh. */
export class ReauthRequiredError extends Error {
  constructor(message = 'Google authorization expired or was revoked; reconnect required') {
    super(message);
    this.name = 'ReauthRequiredError';
  }
}
