import type { Request, RequestHandler, Response, NextFunction } from 'express';
import { config } from './config.ts';
import { RequestError } from './anthropic.ts';
import type { Store, CredentialRow } from './db.ts';

/**
 * Shared plumbing: how a caller proves who it is, how a refusal is shaped, and
 * how fast anyone may ask.
 */

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      caller?: CredentialRow;
      responder?: CredentialRow;
    }
  }
}

function header(req: Request, name: string): string {
  const value = req.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

/** Accepts the key in either the standard Anthropic header or ours. */
export function extractCallerKey(req: Request): string {
  const auth = header(req, 'authorization');
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return header(req, 'x-api-key');
}

/**
 * Caller authentication. `x-api-key` is accepted as well as `Authorization:
 * Bearer`, because every Anthropic client sends one or the other and a client
 * that cannot authenticate cannot be pointed at this service at all.
 */
export function requireCaller(store: Store): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const key = extractCallerKey(req);
    if (key === '') {
      if (!config.requireCallerKey) {
        next();
        return;
      }
      next(new RequestError(401, 'authentication_error', 'missing API key: send x-api-key or Authorization: Bearer'));
      return;
    }
    const credential = store.lookupCredential(key, 'caller');
    if (!credential) {
      next(new RequestError(401, 'authentication_error', 'invalid API key'));
      return;
    }
    req.caller = credential;
    next();
  };
}

export function requireResponder(store: Store): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const key = header(req, 'x-human-key');
    if (key === '') {
      next(new RequestError(401, 'authentication_error', 'missing x-human-key'));
      return;
    }
    const credential = store.lookupCredential(key, 'responder');
    if (!credential) {
      next(new RequestError(401, 'authentication_error', 'invalid or revoked responder key'));
      return;
    }
    req.responder = credential;
    next();
  };
}

/**
 * Admin access exists only when a key is configured. An unset key disables the
 * routes rather than opening them: the failure mode of a missing secret should
 * be a closed door, not an empty one.
 */
export function requireAdmin(): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (config.adminKey === '') {
      next(new RequestError(404, 'not_found_error', 'the admin interface is disabled on this instance'));
      return;
    }
    const offered = header(req, 'x-admin-key');
    if (offered === '' || offered !== config.adminKey) {
      next(new RequestError(401, 'authentication_error', 'invalid admin key'));
      return;
    }
    next();
  };
}

// ---- rate limiting ---------------------------------------------------------

interface Window {
  count: number;
  resetAt: number;
}

/**
 * A fixed window per identity, held in memory.
 *
 * It is per-process, so running two of these services would double every limit.
 * That is a real limitation rather than a hidden one: the honest fix is a shared
 * counter, and there is no shared store here by design.
 */
export function rateLimit(): RequestHandler {
  const windows = new Map<string, Window>();
  const limit = config.rateLimitPerMinute;

  return (req: Request, _res: Response, next: NextFunction) => {
    if (limit <= 0) {
      next();
      return;
    }
    const key = req.caller?.id ?? extractCallerKey(req) ?? req.ip ?? 'unknown';
    const now = Date.now();
    if (windows.size > 10_000) {
      for (const [k, w] of windows) if (w.resetAt <= now) windows.delete(k);
    }
    const window = windows.get(key);
    if (!window || window.resetAt <= now) {
      windows.set(key, { count: 1, resetAt: now + 60_000 });
      next();
      return;
    }
    window.count += 1;
    if (window.count > limit) {
      const retryAfter = Math.max(1, Math.ceil((window.resetAt - now) / 1000));
      next(
        new RequestError(
          429,
          'rate_limit_error',
          `rate limit exceeded: ${limit} requests per minute. Retry in ${retryAfter}s.`,
        ),
      );
      return;
    }
    next();
  };
}

/**
 * A path parameter, narrowed. Express types these as possibly an array, which
 * cannot happen on a route with a single named segment; this keeps the compiler
 * satisfied without a cast at every call site.
 */
export function pathParam(req: Request, name: string): string {
  const value: unknown = req.params[name as keyof typeof req.params];
  return typeof value === 'string' ? value : '';
}

// ---- errors ----------------------------------------------------------------

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function notFound(message = 'not found'): never {
  throw new RequestError(404, 'not_found_error', message);
}

export function conflict(message: string): never {
  throw new RequestError(409, 'conflict_error', message);
}

export function badRequest(message: string, details?: Array<{ field: string; message: string }>): never {
  throw new RequestError(400, 'invalid_request_error', message, details);
}

export function objectBody(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    badRequest('the request body must be a JSON object');
  }
  return value as Record<string, unknown>;
}

/**
 * The last handler. Everything a caller sees as an error passes through here, so
 * the shape is decided once: Anthropic's, because the clients are Anthropic's.
 */
export function errorHandler(): (err: unknown, req: Request, res: Response, next: NextFunction) => void {
  return (err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof RequestError) {
      if (res.headersSent) {
        res.end();
        return;
      }
      res.status(err.status).json(err.toBody());
      return;
    }

    const type = (err as { type?: unknown })?.type;

    if (type === 'entity.too.large') {
      res.status(413).json(
        new RequestError(413, 'request_too_large', `the request body exceeds ${config.maxBodyBytes} bytes`).toBody(),
      );
      return;
    }
    if (type === 'entity.parse.failed') {
      res.status(400).json(new RequestError(400, 'invalid_request_error', 'the request body is not valid JSON').toBody());
      return;
    }

    // Anything unexpected is reported without its message: a stack trace is an
    // internal detail, and the caller can do nothing with it.
    console.error('[humans] unhandled error:', err);
    if (res.headersSent) {
      res.end();
      return;
    }
    res.status(500).json(new RequestError(500, 'api_error', 'internal error').toBody());
  };
}
