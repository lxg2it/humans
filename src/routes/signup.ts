import express, { Router } from 'express';
import type { Request, Response } from 'express';
import type { Store } from '../db.ts';
import { validateAddress, normaliseAddress } from '../btc.ts';
import { CHALLENGE_MAX_AGE_MS, checkSolution, issueChallenge } from '../signup.ts';
import type { SignupKind } from '../signup.ts';
import { signupPage, signupResultPage } from '../site.ts';

/**
 * Self-service keys.
 *
 * The service used to mint every key by hand, which made the operator the
 * front door and meant a visitor arriving at three in the morning met a page
 * telling them to ask somebody. That is a bad trade for a key that buys no
 * compute: what a key is for here is attribution and revocation, and neither of
 * those is improved by a human in the loop.
 *
 * What is worth being careful about is not the key, it is the queue behind it.
 * So the arithmetic in src/signup.ts gates the form, the limit below gates
 * repetition, and the page itself asks agents to turn back — a request, made in
 * plain language, because that is the only mechanism here that could possibly
 * work and pretending otherwise would be the dishonest kind of theatre.
 */

/**
 * Attempts allowed per address per hour, counted on submissions rather than on
 * keys, since a script that fails is the thing worth bounding.
 *
 * Set to survive a busy day rather than to be tight: a household, an office or a
 * university shares one address, and refusing a real visitor at the moment they
 * decided to try costs far more than a stray row. The work in the form is what
 * makes volume expensive.
 */
const ATTEMPTS_PER_HOUR = 20;
const HOUR_MS = 60 * 60 * 1000;

/** How many addresses one process will remember. Past this, expired entries are swept. */
const TRACKED_ADDRESSES = 10_000;

export function signupRouter(store: Store): Router {
  const router = Router();

  /**
   * Both of these are per-process, in memory, and lost on restart, which is the
   * same limitation the rate limiter carries and for the same reason: there is
   * no shared store here by design. Restarting the service resets a visitor's
   * budget. That is a real limitation rather than a hidden one.
   */
  const attempts = new Map<string, number[]>();
  const spent = new Map<string, number>();

  function overBudget(address: string, now: number): boolean {
    const recent = (attempts.get(address) ?? []).filter((at) => now - at < HOUR_MS);
    recent.push(now);
    attempts.set(address, recent);
    if (attempts.size > TRACKED_ADDRESSES) {
      for (const [key, times] of attempts) {
        if (times.every((at) => now - at >= HOUR_MS)) attempts.delete(key);
      }
    }
    return recent.length > ATTEMPTS_PER_HOUR;
  }

  function alreadySpent(seed: string, now: number): boolean {
    for (const [key, until] of spent) if (until <= now) spent.delete(key);
    return spent.has(seed);
  }

  function kindOf(value: unknown): SignupKind {
    return value === 'responder' ? 'responder' : 'caller';
  }

  /**
   * The name is not an identity and does not pretend to be one. For a responder
   * it is the model name the caller will be shown, which is why it is required
   * there and optional for a caller: signing a reply is a different act from
   * sending a request.
   */
  function nameOf(raw: unknown, kind: SignupKind): { ok: true; name: string } | { ok: false; reason: string } {
    const text = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : '';
    if (text === '') {
      return kind === 'responder'
        ? { ok: false, reason: 'a responder needs a name: it is the model name the caller is shown' }
        : { ok: true, name: 'anonymous' };
    }
    if (text.length > 64) return { ok: false, reason: 'that name is longer than 64 characters' };
    if (/[\u0000-\u001f\u007f]/.test(text)) return { ok: false, reason: 'that name contains control characters' };
    // One name, one person. Everything on the money side is keyed by this
    // string — the ledger's `responder` column, earnings(), the settle command —
    // so a second person answering under a taken name would have their earnings
    // added to someone else's and any settlement paid into someone else's
    // address. That was survivable while an operator minted every key by hand
    // and would have noticed; it is not survivable with an open form.
    if (kind === 'responder' && store.responderNameTaken(text)) {
      return {
        ok: false,
        reason:
          `somebody is already answering as "${text}". That name is the model name callers see, and it is what ` +
          `the ledger keys earnings by, so it has to be yours alone. Pick another one.`,
      };
    }
    return { ok: true, name: text };
  }

  /**
   * Where a responder wants to be paid, if they have said.
   *
   * Optional, and deliberately so: reading the queue should not require handing
   * over a financial address, and the money is a thank-you rather than a wage.
   * A responder with no address is simply a responder who cannot be paid yet,
   * which the console says plainly rather than refusing them a seat.
   *
   * Mainnet only. A testnet address here would be accepted by a validator, look
   * completely normal in the ledger, and send real satoshis nowhere — so the
   * network is checked rather than assumed.
   */
  function addressOf(raw: unknown, kind: SignupKind): { ok: true; address: string | null } | { ok: false; reason: string } {
    if (kind !== 'responder') return { ok: true, address: null };
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (text === '') return { ok: true, address: null };
    const result = validateAddress(text);
    if (!result.valid) return { ok: false, reason: `that address is not one: ${result.reason}` };
    if (result.info.network !== 'mainnet') {
      return { ok: false, reason: 'that is a testnet address. Payments here are real, so it has to be a real address.' };
    }
    return { ok: true, address: normaliseAddress(result.info.address) };
  }

  router.get('/signup', (req: Request, res: Response) => {
    const kind = kindOf(req.query.as);
    res.type('html').send(signupPage(kind, issueChallenge()));
  });

  /**
   * No CSRF token, deliberately, and it is worth writing down why rather than
   * leaving an absence to look like an oversight: there is no session and no
   * cookie anywhere in this service, so there is nobody to forge a request *as*.
   * A key minted by someone else's browser is a key sent to them.
   */
  router.post('/signup', express.urlencoded({ extended: false, limit: '16kb' }), (req: Request, res: Response) => {
    const form = (req.body ?? {}) as Record<string, unknown>;
    const kind = kindOf(form.as);
    const now = Date.now();
    const address = req.ip ?? 'unknown';

    if (overBudget(address, now)) {
      res
        .status(429)
        .type('html')
        .send(
          signupPage(kind, issueChallenge(now), {
            status: 429,
            text:
              `That is ${ATTEMPTS_PER_HOUR} attempts from this address in the last hour, which is the limit. It resets ` +
              `within the hour. If you are on a shared network and this is a surprise, it is somebody else on it.`,
          }),
        );
      return;
    }

    const verdict = checkSolution(
      { seed: form.seed, issued: form.issued, sig: form.sig, solution: form.solution },
      now,
    );
    if (!verdict.ok) {
      res.status(400).type('html').send(signupPage(kind, issueChallenge(now), { status: 400, text: verdict.reason }));
      return;
    }

    // One challenge, one key: without this a solution could be replayed, and a
    // solution is the only thing in the request that cost anything to produce.
    const seed = form.seed as string;
    if (alreadySpent(seed, now)) {
      res
        .status(400)
        .type('html')
        .send(
          signupPage(kind, issueChallenge(now), {
            status: 400,
            text: 'That challenge has already been used. Reload the page and start again.',
          }),
        );
      return;
    }

    const named = nameOf(form.name, kind);
    if (!named.ok) {
      res.status(400).type('html').send(signupPage(kind, issueChallenge(now), { status: 400, text: named.reason }));
      return;
    }

    const paid = addressOf(form.payout_address, kind);
    if (!paid.ok) {
      res.status(400).type('html').send(signupPage(kind, issueChallenge(now), { status: 400, text: paid.reason }));
      return;
    }

    spent.set(seed, Number(form.issued) + CHALLENGE_MAX_AGE_MS);
    const minted = store.mintCredential(kind, named.name);
    if (paid.address !== null) store.setPayoutAddress(minted.id, paid.address);
    res.status(201).type('html').send(signupResultPage(kind, named.name, minted.key, paid.address));
  });

  return router;
}
