import { config } from './config.ts';
import type { DayCount, Store } from './db.ts';

/**
 * The public snapshot: the numbers the landing page is allowed to show.
 *
 * It exists as a named, typed shape rather than as a query next to a template
 * because of one rule, and the rule is worth stating where the next person to
 * add a field will read it:
 *
 *   This endpoint is public and unauthenticated. It publishes AGGREGATES ONLY.
 *   Never a caller key name, never a responder name, never a prompt, never a
 *   credential id, never anything from which one of those can be worked out.
 *
 * The failure mode is not a breach that looks like one. It is somebody adding
 * "recent_callers" to a page that already exists and having it work perfectly.
 */

export const DEFAULT_STATS_DAYS = 14;

/**
 * Recomputing this on every page view would be several queries per visitor on
 * the one page an anonymous stranger can hammer, so the result is held briefly.
 * Thirty seconds is short enough that a call placed now appears to be missing
 * only for as long as it takes to read the page twice.
 */
export const DEFAULT_STATS_MAX_AGE_MS = 30_000;

export interface PublicStats {
  /** Every request ever, whatever became of it. */
  calls_total: number;
  answers_total: number;
  /** How many distinct people have answered at least one call. A count, not a list. */
  responders: number;
  /** Median time from request to answer, over recent answers. Null until there are any. */
  median_answer_ms: number | null;
  /** The promise per answer, and what is actually behind it. Shown apart, never as one number. */
  guarantee_sats: number;
  pool_sats: number;
  /** Oldest first, continuous, one entry per UTC day including the empty ones. */
  days: DayCount[];
}

/**
 * Reads the numbers. Pure: no cache and no clock of its own beyond the one it
 * is handed, so a test can put it at a moment in time.
 */
export function publicStats(store: Store, opts: { days?: number; now?: number } = {}): PublicStats {
  const days = opts.days ?? DEFAULT_STATS_DAYS;
  const totals = store.stats();
  return {
    calls_total: totals.total,
    answers_total: totals.answered,
    responders: totals.responders,
    median_answer_ms: totals.medianResponseMs,
    guarantee_sats: config.guaranteeSats,
    pool_sats: config.poolSats,
    days: store.dailyCounts(days, opts.now),
  };
}

/**
 * Memoises a reading for a short while.
 *
 * The clock is injectable for the same reason it is in `publicStats`: a cache
 * whose expiry can only be tested by sleeping is a cache whose expiry is
 * tested by nobody.
 */
export function createStatsReader(
  store: Store,
  opts: { days?: number; maxAgeMs?: number; now?: () => number } = {},
): { read(): PublicStats } {
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_STATS_MAX_AGE_MS;
  const days = opts.days ?? DEFAULT_STATS_DAYS;
  const clock = opts.now ?? Date.now;
  let held: { at: number; value: PublicStats } | null = null;

  return {
    read(): PublicStats {
      const now = clock();
      if (held !== null && now - held.at < maxAgeMs) return held.value;
      const value = publicStats(store, { days, now });
      held = { at: now, value };
      return value;
    },
  };
}
