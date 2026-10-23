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

test('a responder needs a name, because the credit is kept against it', async () => {
  const h = await harness();
  try {
    const page = await h.call('/signup?as=responder');
    // The reason, stated on the page. It used to read "the model name the caller
    // is shown", which is not true of any reply this service sends, and the
    // refusal carried the same sentence.
    assert.match(page.body as string, /keeps your credit against|credit is kept against/);
    assert.doesNotMatch(page.body as string, /model name the caller is shown/);
    const challenge = challengeFrom(page.body as string);

    const unnamed = await postForm(h.base, { as: 'responder', ...challenge, solution: solve(challenge.seed) });
    assert.equal(unnamed.status, 400);
    assert.match(unnamed.body, /a responder needs a name/);

    // The same submission with a name goes through, so the refusal above is the
    // name and not a form that refuses everything posted to it.
    const second = challengeFrom(unnamed.body);
    const named = await postForm(h.base, {
      as: 'responder',
      ...second,
      solution: solve(second.seed),
      name: 'someone-in-particular',
    });
    assert.equal(named.status, 201, named.body);
    assert.match(named.body, /You are on the roster/);

    const key = keyFrom(named.body);
    const me = await h.call('/api/me', { key });
    assert.equal(me.status, 200, JSON.stringify(me.body));
    assert.equal((me.body as any).name, 'someone-in-particular');
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

test('the declaration is asked at the first call, not at signup, and each side says which', async () => {
  const h = await harness();
  try {
    const caller = (await h.call('/signup')).body as string;
    const responder = (await h.call('/signup?as=responder')).body as string;

    // Neither form asks. A key is a seat rather than a decision to sit down, and
    // the checkbox that used to be here was a tick the server never saw: the
    // claim route asks the same question again, at the only moment it means
    // anything. The recording is tested in test/declaration.test.ts.
    assert.doesNotMatch(responder, /id="human"/, 'the responder form asks for a declaration again');
    assert.doesNotMatch(responder, /I am a human/, 'the responder form asks for a declaration again');
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

    // The responder is told when they will be asked, so the question on the
    // claim bar is not a surprise when they get there.
    assert.match(
      responder,
      /when you take your first call/,
      'the responder form no longer says when the declaration happens',
    );
    assert.match(
      responder,
      /in your own hand/,
      'the responder form no longer says the declaration is theirs to make',
    );

    // /answer is where somebody decides to take the job, so it carries the same
    // ask and the same timing.
    const answer = (await h.call('/answer')).body as string;
    assert.match(answer, /answer as yourself/, 'the answering page drops the one thing asked of a responder');
    assert.match(answer, /take your first call/, 'the answering page no longer says when the ask happens');
  } finally {
    await h.close();
  }
});

test('the name a responder picks is theirs, and the caller is never shown it', async () => {
  const h = await harness();
  try {
    const responder = (await h.call('/signup?as=responder')).body as string;
    // The reply names the model. The page asserted the opposite until
    // 2026-10-23 — that the chosen name was the reply's `model` field — while
    // docs/answering.md, the landing model card and resolveModel all said
    // human-1. This is the regression guard for the copy, not for the code.
    assert.doesNotMatch(
      responder,
      /model name the caller is shown/,
      'the signup page promises callers the responder name again',
    );
    assert.match(
      responder,
      /Callers never see it|never your name/,
      'the signup page no longer says the caller does not see the name',
    );

    // And the result page, which is what the person reads once they hold a key.
    const challenge = challengeFrom(responder);
    const minted = await postForm(h.base, {
      as: 'responder',
      ...challenge,
      solution: solve(challenge.seed),
      name: 'ada-plain',
    });
    assert.equal(minted.status, 201);
    assert.match(minted.body, /human-1/, 'the result page does not say what the caller will see');
    assert.doesNotMatch(
      minted.body,
      /the name the caller will be shown/,
      'the result page promises the caller the responder name again',
    );
  } finally {
    await h.close();
  }
});

test('the two notices say different things to different readers', async () => {
  const h = await harness();
  try {
    const responder = (await h.call('/signup?as=responder')).body as string;
    const caller = (await h.call('/signup')).body as string;

    assert.match(responder, /If you are a model, turn back\./);
    assert.match(caller, /If you are an agent, you are welcome to call/);

    // The asymmetry is the design: a machine calling is a caller like any other,
    // and a machine answering removes the thing the service is. If a later edit
    // makes these one notice, this is the assertion that notices.
    assert.doesNotMatch(caller, /turn back/);
    assert.doesNotMatch(responder, /welcome to call/);

    // And neither page claims the checkbox proves anything.
    for (const html of [caller, responder]) {
      assert.match(html, /not a test of humanity/);
    }
  } finally {
    await h.close();
  }
});
