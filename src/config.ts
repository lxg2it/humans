import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

function env(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer, got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

export const config = {
  port: envInt('PORT', 8484),
  host: env('HOST', '127.0.0.1'),
  dataDir: env('HUMANS_DATA_DIR', join(homedir(), '.humans')),

  /**
   * How long a caller waits for a person. Ten minutes is a guess that will be
   * wrong in both directions: too long for a health check, too short for
   * someone who stepped away. It is a config value precisely because it is a
   * policy about people rather than a technical constant.
   */
  callTimeoutMs: envInt('HUMANS_CALL_TIMEOUT_MS', 600_000),

  /** How long a responder holds a request before it goes back in the queue. */
  claimLeaseMs: envInt('HUMANS_CLAIM_LEASE_MS', 180_000),
  sweepIntervalMs: envInt('HUMANS_SWEEP_INTERVAL_MS', 15_000),

  /**
   * Tokens are estimated from characters. Every commercial tokeniser disagrees
   * with every other one, and we cannot see the caller's, so the number is
   * published as an estimate rather than presented as a measurement.
   */
  charsPerToken: envInt('HUMANS_CHARS_PER_TOKEN', 4),

  /**
   * How long a finished request's body is kept. The reply is the record worth
   * keeping; the prompt it answered is somebody else's content, so it goes.
   */
  pruneAfterMs: envInt('HUMANS_PRUNE_AFTER_MS', 86_400_000),

  maxBodyBytes: envInt('HUMANS_MAX_BODY_BYTES', 1_048_576),
  rateLimitPerMinute: envInt('HUMANS_RATE_LIMIT_PER_MINUTE', 60),

  requireCallerKey: envBool('HUMANS_REQUIRE_CALLER_KEY', true),

  /**
   * Whether to believe X-Forwarded-For. Off by default: with it on and no proxy
   * in front, any caller can claim any address, and rate limits become theatre.
   */
  trustProxy: envBool('HUMANS_TRUST_PROXY', false),
  adminKey: process.env.HUMANS_ADMIN_KEY ?? '',

  /** Sats guaranteed per answered reply, and who is paying for them. */
  guaranteeSats: envInt('HUMANS_GUARANTEE_SATS', 250),

  /**
   * What the operator has actually set aside to pay with. Kept separate from
   * the guarantee so that an unfunded promise is visible as one: the console
   * shows the two numbers side by side and says when the fund is short.
   */
  poolSats: envInt('HUMANS_POOL_SATS', 0),
  operator: env('HUMANS_OPERATOR', 'the operator'),
  publicName: env('HUMANS_PUBLIC_NAME', 'humans'),
  publicUrl: env('HUMANS_PUBLIC_URL', ''),
} as const;

/** Generated on first boot and written to the data directory, never to a log. */
export function generateKey(prefix: string): string {
  return `${prefix}_${randomBytes(24).toString('base64url')}`;
}
