/*
 * What the fund can carry, said before anybody picks up a call.
 *
 * The console tells a person what they will be paid for answering, and the
 * honest answer is conditional: the money comes from the pool address, so it is
 * paid while the pool holds something and not paid when it is empty. A figure
 * stated without that condition is an unconditional promise, which is the one
 * thing this service cannot have on its screen while someone decides whether to
 * work.
 *
 * It lives here, rather than inside console.js, because these sentences were
 * previously built at runtime from /api/me and were therefore invisible to every
 * test that reads the pages: the copy the responder actually reads was the only
 * copy nothing checked. This file takes the figures and returns the sentence and
 * its tone, with no DOM and no clock — the console supplies both, and the test
 * supplies the four states a person can be in.
 *
 * The order of the branches is the whole function. `poolSats` is null when the
 * instance reads its balance from the chain and the chain could not be reached,
 * and null must never fall through to the empty-pool sentence: "nobody knows"
 * told as "there is nothing" is a missing figure reported as a zero, and it is
 * the sentence a person reads while deciding whether to work.
 */
(() => {
  'use strict';

  const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);

  /** Thousands separators, so a five-figure sum does not have to be counted. */
  const sats = (value) => value.toLocaleString();

  function note(figures) {
    const guarantee = figures.guaranteeSats;
    const pool = figures.poolSats;
    const owed = figures.owedSats || 0;
    const reading = figures.readAge ? ` (read ${figures.readAge})` : '';

    // Unreadable, and it says so. `undefined` is treated as unreadable rather
    // than as zero for the same reason null is: a field the server did not send
    // is a figure we do not have, and the one reading a person must not be given
    // is that the fund is empty.
    if (pool === null || pool === undefined || !isNumber(pool)) {
      return {
        tone: 'warn',
        text:
          `The guarantee is ${guarantee} sats per reply. The pool balance could not be read` +
          `${figures.poolError ? ` — ${figures.poolError}` : ''}, so whether it is funded is unknown right now. ` +
          `That is a missing figure, not an empty one: while the pool holds something the guarantee is paid, and ` +
          `when it is empty nothing is paid.`,
      };
    }

    if (pool <= 0) {
      return {
        tone: 'warn',
        text:
          `${guarantee} sats per reply, paid from the pool — and the pool is empty${reading}. Nothing is ` +
          `paid while it is empty: the promise is recorded and unfunded, and it is paid if the pool gets topped up.`,
      };
    }

    // The case that matters and the one the two easy stories both get wrong: the
    // promise is neither dead nor fully backed, and the gap has a number on it.
    if (pool < owed) {
      return {
        tone: 'warn',
        text:
          `Paid ${guarantee} sats per answered reply, from a pool of ${sats(pool)} sats` +
          `${reading}. Already owed ${sats(owed)}, so ${sats(owed - pool)} of what has ` +
          `been promised is recorded and unpaid.`,
      };
    }

    return {
      tone: '',
      text:
        `Paid ${guarantee} sats per answered reply, from a pool of ${sats(pool)} sats` +
        `${reading}. The pool is the only place payment comes from: while there is something in it the guarantee ` +
        `is paid, and when it is empty nothing is paid.`,
    };
  }

  window.HumansPoolNote = { note };
})();
