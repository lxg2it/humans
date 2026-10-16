import { fetchAddressStats } from './btc.ts';
import type { ChainStats, Fetcher } from './btc.ts';
import { config } from './config.ts';

/**
 * The pool: what is actually set aside to pay for answers.
 *
 * Until now this was a number in an environment variable, and the landing page
 * printed it — which is the exact failure the site's own notes warn about ("a
 * landing page that hardcodes a guarantee is a page that starts lying the first
 * time somebody changes an environment variable"). A declared figure is a claim
 * about a wallet. Given an address, it becomes a reading of one.
 *
 * So there are two states and the page is not allowed to confuse them:
 *
 *   declared — no address is configured. The number is what the operator says,
 *              the page says it is what the operator says, and it cannot be
 *              checked by anyone.
 *   measured — an address is configured and read. The number comes off the
 *              chain, with the time it was read, and `received` is kept separate
 *              from `balance` so that money already paid out cannot be advertised
 *              as still being held.
 *
 * The failure mode is deliberately not "fall back to the declared number": if
 * the chain cannot be reached, the honest thing is to say when the last good
 * reading was, not to quietly substitute a figure nobody can check. A reading
 * without an age is worse than no reading, because it looks current.
 */

export interface PoolReading {
  /** True when the figure is the operator's word rather than a reading. */
  declared: boolean;
  /** The address the pool lives at, when there is one. */
  address: string | null;
  /** What to show. Null means "we have never managed to read it", which is not zero. */
  sats: number | null;
  /** Everything that has ever arrived, as distinct from what is left. */
  receivedSats: number | null;
  spentSats: number | null;
  txCount: number | null;
  /** When `sats` was true, in epoch milliseconds. Null when it was never read. */
  readAt: number | null;
  /** Why the most recent attempt failed, or null. */
  error: string | null;
}

export interface PoolReader {
  read(): PoolReading;
  /** Reads through the cache. Exists so a page render never waits on a cold read. */
  refresh(): Promise<PoolReading>;
}

export interface PoolReaderOptions {
  address?: string | null;
  declaredSats?: number;
  apiBase?: string;
  fetcher?: Fetcher;
  /** How long a reading is reused. The chain is not the thing under load here. */
  ttlMs?: number;
  now?: () => number;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;

export function createPoolReader(options: PoolReaderOptions = {}): PoolReader {
  const address = options.address !== undefined ? options.address : config.poolAddress;
  const declaredSats = options.declaredSats ?? config.poolSats;
  const apiBase = options.apiBase ?? config.chainApi;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now ?? Date.now;

  /**
   * The last answer we managed to get, kept for as long as the process lives so
   * that a chain outage degrades into a stale reading with a timestamp rather
   * than into a blank space where the money was.
   */
  let lastGood: { stats: ChainStats; at: number } | null = null;
  let lastError: string | null = null;
  let inFlight: Promise<PoolReading> | null = null;

  function snapshot(): PoolReading {
    if (address === null || address === '') {
      return {
        declared: true,
        address: null,
        sats: declaredSats,
        receivedSats: null,
        spentSats: null,
        txCount: null,
        readAt: null,
        error: null,
      };
    }
    return {
      declared: false,
      address,
      sats: lastGood ? lastGood.stats.balanceSats : null,
      receivedSats: lastGood ? lastGood.stats.receivedSats : null,
      spentSats: lastGood ? lastGood.stats.spentSats : null,
      txCount: lastGood ? lastGood.stats.txCount : null,
      readAt: lastGood ? lastGood.at : null,
      error: lastError,
    };
  }

  async function refresh(): Promise<PoolReading> {
    if (address === null || address === '') return snapshot();
    // One read at a time. Without this, a page open in three tabs on a cold
    // cache is three requests to somebody else's free API.
    if (inFlight) return inFlight;

    inFlight = (async () => {
      const stats = await fetchAddressStats(address, apiBase, options.fetcher);
      const at = now();
      if (stats.ok) {
        lastGood = { stats, at };
        lastError = null;
      } else {
        lastError = stats.error ?? 'the chain could not be read';
      }
      return snapshot();
    })();

    try {
      return await inFlight;
    } finally {
      inFlight = null;
    }
  }

  return {
    read(): PoolReading {
      if (address === null || address === '') return snapshot();
      if (lastGood && now() - lastGood.at < ttlMs) return snapshot();
      // Stale or never read: answer with what we have, and start a read that the
      // next caller will benefit from. A page render must not sit on a socket.
      void refresh().catch(() => undefined);
      return snapshot();
    },
    refresh,
  };
}

/** "4 minutes ago", for a reading whose age is part of what it means. */
export function describeAge(readAt: number, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - readAt) / 1000));
  if (seconds < 90) return 'just now';
  // No singular here, deliberately: the just-now window is 90 seconds, so this
  // branch first sees two minutes and can never round to one. The hours branch
  // below does start at one, and carries the singular for it.
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  return `${Math.round(hours / 24)} days ago`;
}
