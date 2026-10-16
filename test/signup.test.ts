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
 * `withBox` exists because the form has two wirings: the responder side carries
 * a declaration the arithmetic releases, and the caller side carries none. A
 * harness that only builds the checkbox form would leave the caller branch
 * untested — and the caller branch is the one that would crash on a null box.
 */
async function runSolver(withBox: boolean) {
  const challenge = issueChallenge();
  const solutionField = { value: '' };
  const elements: Record<string, unknown> = {
    seed: { value: challenge.seed },
    bits: { value: String(challenge.bits) },
    solution: solutionField,
  };
  const listeners: Array<() => void> = [];
  const box = {
    disabled: true,
    checked: false,
    addEventListener: (_event: string, fn: () => void) => listeners.push(fn),
  };
  const status = { textContent: '' };
  const submit = { disabled: true };

  const document = {
    getElementById: (id: string) => {
      if (id === 'signup') return { elements };
      if (id === 'human') return withBox ? box : null;
      if (id === 'human-status') return status;
      if (id === 'go') return submit;
      return null;
    },
  };

  new Function('document', SOLVER_SCRIPT)(document);
  await until(async () => solutionField.value !== '');
  return { challenge, solutionField, box, listeners, status, submit };
}

test("the browser's script produces a solution the server accepts, with and without the declaration", async () => {
  for (const withBox of [true, false]) {
    const { challenge, solutionField, status } = await runSolver(withBox);
    assert.match(status.textContent, /arithmetic/, `no status text when withBox=${withBox}`);
    const verdict = checkSolution({ ...challenge, solution: solutionField.value }, Number(challenge.issued));
    assert.deepEqual(verdict, { ok: true }, `the browser and the server disagree when withBox=${withBox}`);
  }
});

test('the declaration gates the button on one side, and only that side waits for a click', async () => {
  // The responder side: the box is released by the arithmetic, and the submit is
  // still refused until a person has ticked it. The old harness stubbed
  // addEventListener as a no-op, so it could not see this gate at all — the
  // script could have submitted on the solver's own say-so and every assertion
  // would still have passed.
  const declared = await runSolver(true);
  assert.equal(declared.box.disabled, false, 'the arithmetic must release the declaration');
  assert.equal(declared.submit.disabled, true, 'the form submits before anything was declared');
  assert.equal(declared.listeners.length, 1, 'nothing is listening for the declaration');
  declared.box.checked = true;
  declared.listeners[0]!();
  assert.equal(declared.submit.disabled, false, 'ticking the declaration must release the button');
  declared.box.checked = false;
  declared.listeners[0]!();
  assert.equal(declared.submit.disabled, true, 'unticking the declaration must take the button back');

  // The caller side: nobody is asked whether they are a person, so nobody waits
  // to be asked. The arithmetic is the whole gate.
  const undeclared = await runSolver(false);
  assert.equal(undeclared.submit.disabled, false, 'the caller form waits for a declaration it does not make');
  assert.equal(undeclared.listeners.length, 0, 'the caller form wired a listener to a box that is not there');
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

test('a responder needs a name, because that name is the model the caller is shown', async () => {
  const h = await harness();
  try {
    const page = await h.call('/signup?as=responder');
    assert.match(page.body as string, /the model name the caller is shown/);
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

test('the humanity declaration is on the side of the service that needs one', async () => {
  const h = await harness();
  try {
    const caller = (await h.call('/signup')).body as string;
    const responder = (await h.call('/signup?as=responder')).body as string;

    // The responder is the person: the declaration is theirs, and it says what
    // they are undertaking rather than merely what they are.
    assert.match(responder, /id="human"/, 'the answering side no longer asks the person to say so');
    assert.match(
      responder,
      /I am a human, and I will answer these calls myself/,
      'the declaration no longer names the thing being undertaken',
    );

    // The caller is a key, not an account, and usually not a person at all.
    // Scott's correction, 2026-10-16: an API-key form is exactly where nobody
    // cares, so a declaration here would be asking the wrong reader.
    assert.doesNotMatch(caller, /id="human"/, 'the caller form asks for a declaration again');
    assert.doesNotMatch(caller, /I am a human/, 'the caller form asks for a declaration again');

    // And the absence is stated, rather than left for a reader to assume they
    // passed a check. An agent reading this page should not be left wondering.
    assert.match(
      caller,
      /No humanity check on this side/,
      'the caller form removed the check without saying so',
    );

    // The requirement belongs where the answering happens too, not only on the
    // signup form: /answer is where somebody decides to take the job.
    const answer = (await h.call('/answer')).body as string;
    assert.match(answer, /answer as yourself/, 'the answering page drops the one thing asked of a responder');
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
