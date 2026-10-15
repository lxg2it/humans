import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { signingKey } from './secret.ts';

/**
 * The arithmetic behind the signup form, and a plain account of what it is for.
 *
 * It is not a test of humanity, because there is no such test. Anything a person
 * can solve a model solves faster, and a page that claimed otherwise would be
 * telling exactly the kind of lie this service exists to complain about. What a
 * puzzle does establish is that whoever submitted the form ran some code of
 * their own, which is enough to stop the traffic that fills in every form it
 * finds, and is nothing at all to anyone who actually means it.
 *
 * So the page says that, in those words, underneath the checkbox. The thing
 * that asks agents to turn back is a sentence on the same page, and it is a
 * sentence — the honest division of labour is that the sentence is the policy
 * and the arithmetic is a speed bump.
 *
 * Both implementations of the rule live here: the browser's, as a string, and
 * this one, as code. Nothing makes them agree except being tested against each
 * other, which test/signup.test.ts does by running the client script in Node
 * and handing its answer to the verifier below.
 */

/**
 * How much arithmetic a visitor is asked to do, as leading zero bits.
 *
 * The count of hashes needed is geometric, so the mean is 2^bits and the tail is
 * worse: roughly one visitor in twenty does four times the average and one in
 * three thousand does eight times it.
 *
 * Eighteen bits rather than sixteen, which was the first guess, and the reason
 * is that the page tells visitors they are being asked for about a second of
 * arithmetic. Measured in Chrome over the live service, batched 64 wide:
 * 536,625 hashes a second, so sixteen bits averages 0.12s — fast enough that the
 * sentence would have been flattering itself — and eighteen averages 0.49s,
 * with a 1-in-20 wait of about 2s and a worst realistic case near 4s. A phone
 * does this three to five times slower, which is still a pause rather than a
 * problem.
 *
 * The honest reading is that this buys very little either way. What it buys is
 * that a script author has to write the loop, and no amount of bits changes
 * whether someone who means it gets through.
 */
export const CHALLENGE_BITS = 18;

/** Long enough to read the page, short enough that an answer precomputed for a challenge goes stale. */
export const CHALLENGE_MAX_AGE_MS = 20 * 60 * 1000;

/** Requests that arrive from slightly ahead of us are not an attack, they are a clock. */
const MAX_CLOCK_SKEW_MS = 60 * 1000;

/**
 * The two sides of the service, which is also the two sides of this form. It
 * lives with the scheme rather than with the routes because the pages are built
 * from it too, and a view importing from a route would be a cycle.
 */
export type SignupKind = 'caller' | 'responder';

export interface Challenge {
  seed: string;
  issued: string;
  sig: string;
  bits: number;
}

/**
 * The exact string hashed by both sides.
 *
 * One function, because the alternative — writing it out twice — is how the two
 * halves of a scheme drift by a character and reject every visitor while looking
 * perfectly correct in both files.
 */
export function challengeSubject(seed: string, solution: string): string {
  return `${seed}.${solution}`;
}

/** Leading zero bits of a digest, counted the way the browser counts them. */
export function leadingZeroBits(digest: Uint8Array): number {
  let bits = 0;
  for (const byte of digest) {
    if (byte !== 0) return bits + (Math.clz32(byte) - 24);
    bits += 8;
  }
  return bits;
}

function signature(seed: string, issued: number): Buffer {
  return createHmac('sha256', signingKey()).update(challengeSubject(seed, String(issued))).digest();
}

export function issueChallenge(now: number = Date.now()): Challenge {
  const seed = randomBytes(16).toString('base64url');
  return {
    seed,
    issued: String(now),
    sig: signature(seed, now).toString('base64url'),
    bits: CHALLENGE_BITS,
  };
}

export type SolutionVerdict = { ok: true } | { ok: false; reason: string };

export interface Submitted {
  seed?: unknown;
  issued?: unknown;
  sig?: unknown;
  solution?: unknown;
}

/**
 * Checks one submission: that we issued it, that it is fresh, and that the work
 * was done — in that order, cheapest first.
 *
 * The signature is what makes this a challenge rather than a formality. Without
 * it a visitor could pick their own seed, and picking a seed whose hash already
 * satisfies the difficulty is much less work than finding a solution to ours.
 */
export function checkSolution(input: Submitted, now: number = Date.now()): SolutionVerdict {
  const { seed, issued, sig, solution } = input;

  if (typeof seed !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(seed)) {
    return { ok: false, reason: 'no challenge was issued to you' };
  }
  if (typeof issued !== 'string' || !/^\d{1,20}$/.test(issued)) {
    return { ok: false, reason: 'no challenge was issued to you' };
  }
  if (typeof sig !== 'string' || !/^[A-Za-z0-9_-]{40,64}$/.test(sig)) {
    return { ok: false, reason: 'no challenge was issued to you' };
  }
  if (typeof solution !== 'string' || !/^\d{1,16}$/.test(solution)) {
    return { ok: false, reason: 'the checkbox was not completed' };
  }

  const issuedAt = Number(issued);
  if (issuedAt - now > MAX_CLOCK_SKEW_MS) {
    return { ok: false, reason: 'that challenge is from the future' };
  }
  if (now - issuedAt > CHALLENGE_MAX_AGE_MS) {
    return { ok: false, reason: 'that challenge has expired; reload the page and try again' };
  }

  const expected = signature(seed, issuedAt);
  const offered = Buffer.from(sig, 'base64url');
  if (offered.length !== expected.length || !timingSafeEqual(offered, expected)) {
    return { ok: false, reason: 'that challenge was not issued by this service' };
  }

  const digest = createHash('sha256').update(challengeSubject(seed, solution)).digest();
  if (leadingZeroBits(digest) < CHALLENGE_BITS) {
    return { ok: false, reason: 'the work was not done' };
  }

  return { ok: true };
}

/**
 * The browser's half, as served.
 *
 * Kept as a string here rather than in a file under public/ because it belongs
 * to this scheme and nowhere else, and because the test runs these exact bytes
 * against the verifier above — the script a test exercises should be the script
 * a visitor gets, not a copy of it.
 *
 * It writes the answer into a hidden field and enables the submit button. A
 * visitor with scripting off gets a disabled form and a line saying so, which is
 * a worse experience and an honest one; silently refusing them would be neither.
 */
export const SOLVER_SCRIPT = `(function () {
  var form = document.getElementById('signup');
  if (!form) return;
  var box = document.getElementById('human');
  var status = document.getElementById('human-status');
  var submit = document.getElementById('go');
  var seed = form.elements.seed.value;
  var bits = Number(form.elements.bits.value);
  var encoder = new TextEncoder();

  function zeros(bytes) {
    var n = 0;
    for (var i = 0; i < bytes.length; i += 1) {
      if (bytes[i] !== 0) return n + (Math.clz32(bytes[i]) - 24);
      n += 8;
    }
    return n;
  }

  var started = Date.now();
  var batch = 64;

  function attempt(base) {
    var work = [];
    // let, and it is not a style choice. With var, every closure below shares
    // one binding, so all sixty-four of them report the *last* candidate in the
    // batch rather than the one they hashed — and the answer that comes back is
    // a number whose hash does not satisfy the difficulty. Measured: the form
    // submitted 60927, whose digest has no leading zero bits at all, while the
    // batch that actually contained a winning candidate started at 60864.
    for (let i = 0; i < batch; i += 1) {
      const candidate = String(base + i);
      work.push(
        crypto.subtle.digest('SHA-256', encoder.encode(seed + '.' + candidate)).then(function (hash) {
          return [candidate, new Uint8Array(hash)];
        }),
      );
    }
    return Promise.all(work);
  }

  function solve(base) {
    return attempt(base).then(function (results) {
      for (var i = 0; i < results.length; i += 1) {
        if (zeros(results[i][1]) >= bits) return results[i][0];
      }
      return solve(base + batch);
    });
  }

  solve(0).then(function (solution) {
    form.elements.solution.value = solution;
    var seconds = ((Date.now() - started) / 1000).toFixed(1);
    box.disabled = false;
    status.textContent = 'Done, in ' + seconds + ' seconds of arithmetic. That is the whole check.';
  });

  box.addEventListener('change', function () {
    submit.disabled = !box.checked;
  });
})();`;
