/*
 * What the fund can carry, said before anybody picks up a call.
 *
 * The console tells a person what they will be paid for answering, and the
 * honest answer is conditional: the money comes from the pool address, so it is
 * paid while the pool covers a reply and not paid once it is empty or short of
 * one. A figure stated without that condition is an unconditional promise, which
 * is the one thing this service cannot have on its screen while someone decides
 * whether to work. Note "covers a reply" rather than "holds something": the
 * earlier wording asserted that anything in the pool paid, which a single
 * satoshi does not make true — so the sentence written to be conditional carried
 * a false sufficiency inside it, on every branch.
 *
 * It lives here, rather than inside console.js, because these sentences were
 * previously built at runtime from /api/me and were therefore invisible to every
 * test that reads the pages: the copy the responder actually reads was the only
 * copy nothing checked. This file takes the figures and returns the sentence and
 * its tone, with no DOM and no clock — the console supplies both, and the test
 * supplies the five states a person can be in.
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

  /**
   * A quantity with its unit, for the places the sentence counts real satoshis.
   *
   * "from a pool of 1 sats" is what the dust state renders without this, and dust
   * is the state the sentence exists for — a pool that holds something and cannot
   * pay a reply. The bare `sats()` is still used where the figure stands on its
   * own, because there the unit is supplied by the words around it.
   */
  const satsUnit = (value) => (value === 1 ? '1 sat' : `${sats(value)} sats`);

  /**
   * "4 minutes ago", for a reading whose age is part of what it means.
   *
   * The same formatter exists server-side in src/pool.ts, because a rendered page
   * and a browser file cannot share a source module without one of them giving up
   * its runtime. It lived here too, as a copy inside console.js, with no test on
   * it — so the sentence below quoted an age produced by code nothing checked.
   * Now there are two copies and both are tested, and the test pins them to each
   * other across every boundary, which is the part that was missing.
   */
  function describeAge(readAt, now) {
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

  function note(figures) {
    const guarantee = figures.guaranteeSats;
    const pool = figures.poolSats;
    // The SERVICE's obligation, not the reader's. A single responder's balance
    // used to arrive here under this name while the sentence said "what has
    // been promised", so the console and /pool answered "what is owed" with two
    // different numbers. The parameter is named in full so that a caller passing
    // the wrong one has to ignore the name to do it.
    const owed = figures.owedAcrossEverybody || 0;
    // The reading's age, formatted here rather than handed in: the parenthetical
    // is part of the sentence, and a caller that formats it is a caller that can
    // format it differently. `undefined` is treated as no reading at all, so a
    // console that has not fetched yet cannot imply a fresh one.
    const readAge =
      figures.readAt === null || figures.readAt === undefined
        ? null
        : describeAge(figures.readAt, figures.now === undefined ? Date.now() : figures.now);
    const reading = readAge === null ? '' : ` (read ${readAge})`;

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
          `That is a missing figure, not an empty one: nothing is paid until the pool covers a reply, and nothing ` +
          `is paid once it is empty.`,
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

    // Funded, but not enough for one reply. Nothing is owed yet, so the shortfall
    // branch below cannot see this, and without its own branch it fell to the
    // covered one — which said the guarantee is paid whenever the pool holds
    // anything, and one satoshi does not make that true. Dust is a real state and
    // it reads as its own sentence.
    if (owed <= 0 && pool < guarantee) {
      return {
        tone: 'warn',
        text:
          `Paid ${guarantee} sats per answered reply, from a pool of ${satsUnit(pool)}` +
          `${reading}. That is less than the ${satsUnit(guarantee)} a single reply is promised, so a reply taken now ` +
          `would be recorded and unpaid until the pool is topped up.`,
      };
    }

    // The case that matters and the one the two easy stories both get wrong: the
    // promise is neither dead nor fully backed, and the gap has a number on it.
    if (pool < owed) {
      return {
        tone: 'warn',
        text:
          `Paid ${guarantee} sats per answered reply, from a pool of ${satsUnit(pool)}` +
          `${reading}. ${sats(owed)} is owed across everybody who has answered, so ` +
          `${sats(owed - pool)} of what has been promised is recorded and unpaid.`,
      };
    }

    return {
      tone: '',
      text:
        `Paid ${guarantee} sats per answered reply, from a pool of ${satsUnit(pool)}` +
        `${reading}. ` +
        (owed > 0
          ? `It covers the ${sats(owed)} owed across everybody right now; `
          : `Nothing is owed across everybody right now; `) +
        `the next replies are paid out of the same address, and when it is empty nothing is paid.`,
    };
  }

  window.HumansPoolNote = { note, describeAge };
})();
