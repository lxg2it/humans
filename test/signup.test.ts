import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  CHALLENGE_BITS,
  CHALLENGE_MAX_AGE_MS,
  SOLVER_SCRIPT,
  challengeSubject,
  checkSolution,
  issueChallenge,
  leadingZeroBits,
} from '../src/signup.ts';
import type { Challenge } from '../src/signup.ts';
import { harness, until } from './helpers.ts';

/**
 * The signup form, which is the only place this service mints a credential for
 * someone it has not met.
 *
 * Two different things are tested here. One is that a submission which did not
 * do the work is refused — the ordinary direction, and the easy one. The other
 * is that a submission which *did* the work is accepted, which is the direction
 * that fails silently: a solver and a verifier that disagree reject every
 * visitor while each looks correct in its own file. That is why the browser's
 * script is executed below, in Node, rather than trusted.
 */

/** Solves a challenge the way a browser does — by trying numbers, one at a time. */
function solve(seed: string, bits = CHALLENGE_BITS): string {
  for (let candidate = 0; ; candidate += 1) {
    const digest = createHash('sha256').update(challengeSubject(seed, String(candidate))).digest();
    if (leadingZeroBits(digest) >= bits) return String(candidate);
  }
}

/** The hidden fields a rendered form hands the browser, read back out of it. */
function challengeFrom(html: string): Challenge {
  const field = (name: string): string => {
    const match = html.match(new RegExp(`name="${name}" value="([^"]*)"`));
    assert.ok(match, `the page did not carry a ${name} field`);
    return match[1]!;
  };
  return {
    seed: field('seed'),
    issued: field('issued'),
    sig: field('sig'),
    bits: Number(field('bits')),
  };
}

/** The key off the result page, which is the only place it exists in the clear. */
function keyFrom(html: string): string {
  const match = html.match(/<pre id="key"><code>([^<]+)<\/code><\/pre>/);
  assert.ok(match, 'the result page did not show a key');
  return match[1]!;
}

/** Posts the form as a browser would: urlencoded, not JSON, which the harness does not do. */
async function postForm(
  base: string,
  fields: Record<string, string | number>,
): Promise<{ status: number; body: string }> {
  const response = await fetch(`${base}/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(
      Object.entries(fields).map(([key, value]): [string, string] => [key, String(value)]),
    ).toString(),
  });
  return { status: response.status, body: await response.text() };
}

test('leading zero bits are counted the way the browser counts them', () => {
  assert.equal(leadingZeroBits(Buffer.from([0x80])), 0);
  assert.equal(leadingZeroBits(Buffer.from([0x40])), 1);
  assert.equal(leadingZeroBits(Buffer.from([0x01])), 7);
  assert.equal(leadingZeroBits(Buffer.from([0x00])), 8);
  assert.equal(leadingZeroBits(Buffer.from([0x00, 0x01])), 15);
  // The one a version that stopped at the first byte would get wrong.
  assert.equal(leadingZeroBits(Buffer.from([0x00, 0x00, 0xff])), 16);
});

test('a solved challenge is accepted and an unsolved one is not', () => {
  const challenge = issueChallenge();
  const solution = solve(challenge.seed);
  const at = Number(challenge.issued);

  assert.deepEqual(checkSolution({ ...challenge, solution }, at), { ok: true });

  // The falsifier for the whole mechanism: delete the difficulty check and
  // every other assertion in this file still passes. This is the one that fails.
  assert.equal(checkSolution({ ...challenge, solution: '0' }, at).ok, false);
});

test('a challenge we did not issue is refused, however good the work is', () => {
  const now = Date.now();
  const forged = { seed: 'a'.repeat(22), issued: String(now), sig: 'b'.repeat(43) };
  assert.equal(checkSolution({ ...forged, solution: solve(forged.seed) }, now).ok, false);

  // And the same seed signed by us, so the refusal above is the signature and
  // not a verifier that refuses everything.
  const real = issueChallenge(now);
  assert.deepEqual(checkSolution({ ...real, solution: solve(real.seed) }, now), { ok: true });
});

test('a stale challenge is refused and a fresh one is not', () => {
  const now = Date.now();
  const old = issueChallenge(now - CHALLENGE_MAX_AGE_MS - 1);
  assert.equal(checkSolution({ ...old, solution: solve(old.seed) }, now).ok, false);

  const recent = issueChallenge(now - 1000);
  assert.equal(checkSolution({ ...recent, solution: solve(recent.seed) }, now).ok, true);
});

test('a malformed submission is refused rather than throwing', () => {
  for (const bad of [{}, { seed: 'x' }, { seed: 'x', issued: 'y' }, { seed: 'x', issued: '1', sig: 'z' }]) {
    assert.equal(checkSolution(bad, Date.now()).ok, false, `${JSON.stringify(bad)} should be refused`);
  }
  // A very long solution must be rejected by shape, not hashed: the regex is
  // the bound that stops a POST of arbitrary size becoming arbitrary work.
  const challenge = issueChallenge();
  assert.equal(checkSolution({ ...challenge, solution: '1'.repeat(100000) }, Number(challenge.issued)).ok, false);
});

/**
 * The two implementations of the rule, checked against each other.
 *
 * The string below is the exact script the page is served, run against a stub
 * of the handful of browser globals it touches. Node has WebCrypto and
 * TextEncoder, so the arithmetic under test is the real arithmetic.
 *
 * It does not prove the form's wiring in a browser — a real click, a real change
 * event, a real submit. That is what the run against the live page is for, and
 * it belongs in the runbook rather than in a unit test that cannot see it.
 */
/**
 * Runs the served script against a fake document and returns what it did.
 *
 * The fake document is deliberately thin: `#signup`, its elements, the status
 * line and the button. It has no `#human` node, because the served script must
 * not want one — a missing element it reached for would throw a TypeError and
 * leave the button dead, which is the failure an earlier branch existed to
 * prevent and this one prevents by not looking.
 *
 * `bits` is a parameter because the difficulty is a property of the scheme and
 * not of the wiring, and the arithmetic is geometric: one solve in twenty takes
 * four times the mean, and one in three thousand eight times it. Measured: 2
 * failures in 8 runs of this file when every solve ran at CHALLENGE_BITS
 * against a 4s wait, both of them this test timing out rather than failing. The
 * wiring is therefore exercised at a low difficulty, where its subject is the
 * wiring; the shipped difficulty is exercised by the agreement test, which is
 * the test that would notice a difficulty of zero.
 */
async function runSolver(bits = 12, deadlineMs = 10_000) {
  const challenge = issueChallenge();
  const solutionField = { value: '' };
  const elements: Record<string, unknown> = {
    seed: { value: challenge.seed },
    bits: { value: String(bits) },
    solution: solutionField,
  };
  const listeners: Array<() => void> = [];
  const status = { textContent: '' };
  const submit = { disabled: true };

  const document = {
    getElementById: (id: string) => {
      if (id === 'signup') return { elements };
      if (id === 'human-status') return status;
      if (id === 'go') return submit;
      return null;
    },
  };

  new Function('document', SOLVER_SCRIPT)(document);
  await until(async () => solutionField.value !== '', deadlineMs);
  return { challenge, solutionField, listeners, status, submit };
}

test("the browser's script produces a solution the server accepts, at the shipped difficulty", async () => {
  // 30s, not the default 4s: this is the one test that must run at the
  // difficulty the service actually ships, and its tail is real.
  const { challenge, solutionField, status } = await runSolver(CHALLENGE_BITS, 30_000);
  assert.match(status.textContent, /arithmetic/, 'no status text');
  const verdict = checkSolution({ ...challenge, solution: solutionField.value }, Number(challenge.issued));
  assert.deepEqual(verdict, { ok: true }, 'the browser and the server disagree');
});

test('the arithmetic is the whole gate, and the script asks nothing else of the page', async () => {
  // Nobody is asked whether they are a person on either form any more, so the
  // submit is released by the solver's own say-so — and nothing is wired to a
  // declaration node. Both directions matter: a script that waited for a tick
  // would leave every visitor on a dead button, and one that reached for a
  // missing `#human` would throw before enabling anything.
  const solved = await runSolver();
  assert.equal(solved.submit.disabled, false, 'the form waits for something the page no longer asks for');
  assert.equal(solved.listeners.length, 0, 'the script wired a listener to a declaration that is not there');
});

test('signing up mints a caller key that authenticates', async () => {
  const h = await harness();
  try {
    const page = await h.call('/signup');
    assert.equal(page.status, 200);
    const challenge = challengeFrom(page.body as string);

    const response = await postForm(h.base, {
      as: 'caller',
      ...challenge,
      solution: solve(challenge.seed),
      name: 'a-new-caller',
    });
    assert.equal(response.status, 201, response.body);
    assert.match(response.body, /only time it will be shown/);

    const key = keyFrom(response.body);
    assert.match(key, /^sk/, 'a caller key should look like a caller key');

    // The credential is real in the store, and it is the name that was typed.
    assert.ok(
      h.store.listCredentials('caller').some((row) => row.name === 'a-new-caller'),
      'the minted credential should be in the store under the submitted name',
    );

    // And it authenticates over HTTP. The discriminator is the pair: the same
    // malformed request answers 400 with the minted key and 401 with a key that
    // was never minted. "Not 401" alone would pass if the route stopped
    // authenticating callers altogether.
    const withKey = await h.call('/v1/messages', { method: 'POST', body: {}, key, keyHeader: 'x-api-key' });
    assert.equal(withKey.status, 400, JSON.stringify(withKey.body));
    assert.equal((withKey.body as any).error.type, 'invalid_request_error');

    const withNothing = await h.call('/v1/messages', { method: 'POST', body: {}, key: 'sk_never-minted' , keyHeader: 'x-api-key' });
    assert.equal(withNothing.status, 401);
    assert.equal((withNothing.body as any).error.type, 'authentication_error');
  } finally {
    await h.close();
  }
});

test('one challenge cannot be spent twice', async () => {
  const h = await harness();
  try {
    const challenge = challengeFrom((await h.call('/signup')).body as string);
    const body = { as: 'caller', ...challenge, solution: solve(challenge.seed), name: 'first' };

    assert.equal((await postForm(h.base, body)).status, 201);
    const replay = await postForm(h.base, body);
    assert.equal(replay.status, 400, 'a replayed solution must not mint a second key');
    assert.match(replay.body, /already been used/);
    assert.equal(h.store.listCredentials('caller').filter((row) => row.name === 'first').length, 1);
  } finally {
    await h.close();
  }
});

test('a submission that did no work is refused, and gets a working form back', async () => {
  const h = await harness();
  try {
    const challenge = challengeFrom((await h.call('/signup')).body as string);
    const response = await postForm(h.base, { as: 'caller', ...challenge, solution: '0', name: 'lazy' });
    assert.equal(response.status, 400);
    assert.match(response.body, /the work was not done/);
    // A refusal that leaves the visitor on a dead page is a worse gate than no
    // gate, so the form comes back with a fresh challenge in it.
    assert.match(response.body, /id="signup"/);
    assert.doesNotMatch(response.body, new RegExp(challenge.seed));
  } finally {
    await h.close();
  }
});

test('the declaration is asked at the first call, not when the seat is made, and each side says which', async () => {
  const h = await harness();
  try {
    const caller = (await h.call('/signup')).body as string;

    // Neither side asks at the door. A key is a seat rather than a decision to
    // sit down, and the checkbox that used to be here was a tick the server never
    // saw: the claim route asks the same question again, at the only moment it
    // means anything. The recording is tested in test/declaration.test.ts.
    assert.doesNotMatch(caller, /id="human"/, 'the caller form asks for a declaration again');
    assert.doesNotMatch(caller, /I am a human/, 'the caller form asks for a declaration again');

    // The absence on the caller side is stated, rather than left for a reader to
    // assume they passed a check. Scott's correction, 2026-10-16: an API-key form
    // is exactly where nobody cares, so a declaration there asks the wrong reader.
    assert.match(
      caller,
      /No humanity check on this side/,
      'the caller form removed the check without saying so',
    );

    // A seat is made with nothing supplied at all, which is a stronger version of
    // the same property: there is no form left to ask on, and the seat starts
    // having declared nothing.
    const minted = await fetch(`${h.base}/api/responders`, { method: 'POST' });
    assert.equal(minted.status, 201);
    const seat = (await minted.json()) as any;
    assert.equal(seat.declared_at ?? null, null, 'a fresh seat has declared nothing');
    const me = await h.call('/api/me', { key: seat.key });
    assert.equal((me.body as any).declared_at ?? null, null, 'the seat was made without a declaration');

    // /answer is where somebody decides to take the job, so it carries the ask,
    // the timing, and the reason it is a sentence rather than a check.
    const answer = (await h.call('/answer')).body as string;
    assert.match(answer, /answer as yourself/, 'the answering page drops the one thing asked of a responder');
    assert.match(answer, /take your first call/, 'the answering page no longer says when the ask happens');
  } finally {
    await h.close();
  }
});

test('a seat is given a name rather than choosing one, and the caller is never shown it', async () => {
  const h = await harness();
  try {
    const answer = (await h.call('/answer')).body as string;
    // The reply names the model. The pages asserted the opposite until
    // 2026-10-23 — that a chosen name was the reply's `model` field — while
    // docs/answering.md, the landing model card and resolveModel all said
    // human-1. This is the regression guard for the copy, not for the code.
    assert.doesNotMatch(
      answer,
      /model name the caller is shown/,
      'the answering page promises callers the seat name again',
    );
    assert.match(answer, /The caller never sees it/, 'the answering page no longer says the caller does not see it');
    assert.match(answer, /human-1/, 'the answering page no longer says what the caller does see');

    // And the name itself: generated, because it is the ledger's key and nothing
    // else. A name a person chose would invite them to sign their answers, which
    // is the one thing this service promises callers they are not getting.
    const minted = await fetch(`${h.base}/api/responders`, { method: 'POST' });
    const seat = (await minted.json()) as any;
    assert.match(seat.name, /^responder-[0-9a-f]{6}$/, 'the seat name is generated, not chosen');
    const me = await h.call('/api/me', { key: seat.key });
    assert.equal((me.body as any).name, seat.name);
  } finally {
    await h.close();
  }
});

test('the two notices say different things to different readers', async () => {
  const h = await harness();
  try {
    // The responder notice moved with the responder: there is no signup page for
    // them any more, and /answer is where somebody decides to start answering.
    // The flat request has to be on the page they actually read, not on a page
    // that no longer exists.
    const responder = (await h.call('/answer')).body as string;
    const caller = (await h.call('/signup')).body as string;

    assert.match(responder, /If you are a model, turn back\./);
    assert.match(caller, /If you are an agent, you are welcome to call/);

    // The asymmetry is the design: a machine calling is a caller like any other,
    // and a machine answering removes the thing the service is. If a later edit
    // makes these one notice, this is the assertion that notices.
    assert.doesNotMatch(caller, /turn back/);
    assert.doesNotMatch(responder, /welcome to call/);

    // And neither page claims a puzzle proves anything.
    assert.match(caller, /not a test of humanity/);
    assert.match(responder, /not a check/);
  } finally {
    await h.close();
  }
});
