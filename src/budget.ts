/**
 * A fixed-window budget per address, held in memory.
 *
 * Two things in this service need one — submissions to the form, and seats
 * minted on arrival at the console — and they need the same behaviour, so it is
 * here rather than copied. What they do NOT share is the number, which is the
 * interesting part: a form submission is worth bounding tightly and a seat is
 * not, because the queue behind a seat is the scarce thing, not the row.
 *
 * Counted per process, so restarting the service clears everybody's budget. That
 * is the same limitation the rate limiter carries and for the same reason: there
 * is no shared store here by design. It is stated rather than hidden.
 */
export interface AddressBudget {
  /** Records an attempt and answers whether it was over the limit. */
  record(address: string, now?: number): boolean;
}

/** How many addresses one process will remember past their window. */
const TRACKED_ADDRESSES = 10_000;

export function createAddressBudget(limit: number, windowMs: number): AddressBudget {
  const attempts = new Map<string, number[]>();

  return {
    record(address: string, now: number = Date.now()): boolean {
      const recent = (attempts.get(address) ?? []).filter((at) => now - at < windowMs);
      recent.push(now);
      attempts.set(address, recent);
      if (attempts.size > TRACKED_ADDRESSES) {
        for (const [key, times] of attempts) {
          if (times.every((at) => now - at >= windowMs)) attempts.delete(key);
        }
      }
      return recent.length > limit;
    },
  };
}
