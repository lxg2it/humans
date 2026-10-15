import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { CHALLENGE_BITS, challengeSubject, leadingZeroBits } from '../src/signup.ts';
import type { Challenge } from '../src/signup.ts';
import { harness } from './helpers.ts';

/**
 * Where a responder wants to be paid, and the two ways that can go wrong.
 *
 * An address is the one field on this service where a mistake is not
 * recoverable: a transfer to a wrong address is gone, and a transfer to a
 * testnet address is gone more quietly than that, because the ledger records a
 * payment, the responder sees a settlement, and no money ever arrives anywhere.
 * So both are tested as refusals rather than trusted to validation.
 */

const MAINNET = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
const MAINNET_TAPROOT = 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr';
const TESTNET = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';

function solve(seed: string, bits = CHALLENGE_BITS): string {
  for (let candidate = 0; ; candidate += 1) {
    const digest = createHash('sha256').update(challengeSubject(seed, String(candidate))).digest();
    if (leadingZeroBits(digest) >= bits) return String(candidate);
  }
}

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

function keyFrom(html: string): string {
  const match = html.match(/<pre id="key"><code>([^<]+)<\/code><\/pre>/);
  assert.ok(match, 'the result page did not show a key');
  return match[1]!;
}

async function postForm(base: string, fields: Record<string, string | number>): Promise<{ status: number; body: string }> {
  const response = await fetch(`${base}/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(
      Object.entries(fields).map(([key, value]): [string, string] => [key, String(value)]),
    ).toString(),
  });
  return { status: response.status, body: await response.text() };
}

/** Signs a responder up, doing the work, and returns the key it was given. */
async function signUpResponder(
  base: string,
  fields: Record<string, string> = {},
): Promise<{ status: number; body: string; key: string }> {
  const challenge = challengeFrom(await (await fetch(`${base}/signup?as=responder`)).text());
  const response = await postForm(base, {
    as: 'responder',
    ...challenge,
    solution: solve(challenge.seed),
    ...fields,
  });
  return { ...response, key: response.status === 201 ? keyFrom(response.body) : '' };
}

test('a responder can say where to be paid, and it is stored on the key', async () => {
  const h = await harness();
  try {
    const signed = await signUpResponder(h.base, { name: 'paid-person', payout_address: MAINNET });
    assert.equal(signed.status, 201, signed.body);
    assert.match(signed.body, new RegExp(MAINNET), 'the result page should say where the money is going');

    const me = await h.call('/api/me', { key: signed.key });
    assert.equal(me.status, 200);
    assert.equal((me.body as any).payout_address, MAINNET);

    // And the thing settlement actually reads agrees with what /api/me says.
    assert.equal(h.store.payoutAddressFor('paid-person'), MAINNET);
  } finally {
    await h.close();
  }
});

test('a responder can decline to give one, and is still let in', async () => {
  const h = await harness();
  try {
    const signed = await signUpResponder(h.base, { name: 'unpaid-person' });
    assert.equal(signed.status, 201, 'a key is a seat, and a seat does not require a financial address');
    const me = await h.call('/api/me', { key: signed.key });
    assert.equal((me.body as any).payout_address, null);
    assert.match(signed.body, /No address, so nothing can be sent to you yet/);
  } finally {
    await h.close();
  }
});

test('an address that is not one is refused, and the visitor gets a working form back', async () => {
  const h = await harness();
  try {
    const bad = await signUpResponder(h.base, { name: 'typo-person', payout_address: 'bc1qnotactuallyanaddress' });
    assert.equal(bad.status, 400);
    assert.match(bad.body, /not one/);

    // The refusal must not have created anything.
    assert.equal(h.store.responderByName('typo-person'), undefined);

    // And the form that came back can be used, which is the difference between a
    // gate and a wall.
    const challenge = challengeFrom(bad.body);
    const good = await postForm(h.base, {
      as: 'responder',
      ...challenge,
      solution: solve(challenge.seed),
      name: 'typo-person',
      payout_address: MAINNET,
    });
    assert.equal(good.status, 201, good.body);
  } finally {
    await h.close();
  }
});

test('a testnet address is refused, because the satoshis here are not testnet ones', async () => {
  const h = await harness();
  try {
    // The discriminator: the SAME shape of address on mainnet is accepted, so
    // this is the network check refusing and not the parser.
    const testnet = await signUpResponder(h.base, { name: 'testnet-person', payout_address: TESTNET });
    assert.equal(testnet.status, 400, 'a valid testnet address must still be refused here');
    assert.match(testnet.body, /testnet/);

    const mainnet = await signUpResponder(h.base, { name: 'testnet-person', payout_address: MAINNET_TAPROOT });
    assert.equal(mainnet.status, 201, 'the same address on mainnet goes through');
  } finally {
    await h.close();
  }
});

test('a caller is never given a payout address, whatever it posts', async () => {
  const h = await harness();
  try {
    const challenge = challengeFrom((await h.call('/signup')).body as string);
    const response = await postForm(h.base, {
      as: 'caller',
      ...challenge,
      solution: solve(challenge.seed),
      name: 'caller-with-an-address',
      payout_address: MAINNET,
    });
    assert.equal(response.status, 201);
    const key = keyFrom(response.body);
    const me = await h.call('/api/me', { key, keyHeader: 'x-api-key' });
    // A caller has no /api/me, and the point is that nothing was stored.
    assert.notEqual(me.status, 200);
    const row = h.store.listCredentials('caller').find((entry) => entry.name === 'caller-with-an-address');
    assert.ok(row, 'the caller key exists');
    assert.equal(row!.payout_address, null, 'nothing is ever paid to a caller');
  } finally {
    await h.close();
  }
});

test('two people cannot answer under one name', async () => {
  const h = await harness();
  try {
    const first = await signUpResponder(h.base, { name: 'alex' });
    assert.equal(first.status, 201);

    // Everything on the money side is keyed by this string, so a second person
    // under it would have their earnings merged with the first person's and any
    // settlement paid into one of their wallets.
    const second = await signUpResponder(h.base, { name: 'alex' });
    assert.equal(second.status, 400, 'the same name must not be mintable twice');
    assert.match(second.body, /already answering as "alex"/);
    assert.equal(h.store.listCredentials('responder').filter((row) => row.name === 'alex').length, 1);

    // Two callers may share a name: nothing is paid to a caller and nothing is
    // keyed on theirs.
    const a = challengeFrom((await h.call('/signup')).body as string);
    const b = challengeFrom((await h.call('/signup')).body as string);
    for (const challenge of [a, b]) {
      const response = await postForm(h.base, {
        as: 'caller',
        ...challenge,
        solution: solve(challenge.seed),
        name: 'anonymous',
      });
      assert.equal(response.status, 201, response.body);
    }
  } finally {
    await h.close();
  }
});

test('a responder can change and clear their own address from the console', async () => {
  const h = await harness();
  try {
    const signed = await signUpResponder(h.base, { name: 'changer', payout_address: MAINNET });

    // Change it: a rotated wallet should not require a new key.
    const changed = await h.call('/api/me/payout-address', {
      method: 'POST',
      body: { address: MAINNET_TAPROOT },
      key: signed.key,
    });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    assert.equal((changed.body as any).payout_address, MAINNET_TAPROOT);
    assert.equal(h.store.payoutAddressFor('changer'), MAINNET_TAPROOT);

    // A typo is refused, and the stored address is left alone rather than
    // replaced with the thing that failed validation.
    const rejected = await h.call('/api/me/payout-address', {
      method: 'POST',
      body: { address: 'not-an-address-at-all' },
      key: signed.key,
    });
    assert.equal(rejected.status, 400);
    assert.equal(h.store.payoutAddressFor('changer'), MAINNET_TAPROOT, 'a refused change must change nothing');

    const wrongnet = await h.call('/api/me/payout-address', {
      method: 'POST',
      body: { address: TESTNET },
      key: signed.key,
    });
    assert.equal(wrongnet.status, 400);
    assert.equal(h.store.payoutAddressFor('changer'), MAINNET_TAPROOT);

    // Clearing is allowed: not wanting to be paid is a position, not an error.
    const cleared = await h.call('/api/me/payout-address', {
      method: 'POST',
      body: { address: '' },
      key: signed.key,
    });
    assert.equal(cleared.status, 200);
    assert.equal((cleared.body as any).payout_address, null);
    assert.equal(h.store.payoutAddressFor('changer'), null);
  } finally {
    await h.close();
  }
});

test('one responder cannot change another one\u2019s address', async () => {
  const h = await harness();
  try {
    const mine = await signUpResponder(h.base, { name: 'mine', payout_address: MAINNET });
    const theirs = await signUpResponder(h.base, { name: 'theirs', payout_address: MAINNET_TAPROOT });

    // There is no field for "whose" — the key decides, and that is the whole
    // point of the route being /api/me/*. Sending a name anyway must do nothing.
    const attempt = await h.call('/api/me/payout-address', {
      method: 'POST',
      body: { address: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', responder: 'theirs', name: 'theirs' },
      key: mine.key,
    });
    assert.equal(attempt.status, 200);
    assert.equal(h.store.payoutAddressFor('theirs'), MAINNET_TAPROOT, 'the other person\u2019s record must be untouched');
    assert.equal(h.store.payoutAddressFor('mine'), '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa');

    // And the other person's own view of themselves is unchanged too: a route
    // that quietly rewrote the wrong row would be visible here as well.
    const theirView = await h.call('/api/me', { key: theirs.key });
    assert.equal((theirView.body as any).payout_address, MAINNET_TAPROOT);
  } finally {
    await h.close();
  }
});

test('the signup form only offers an address to the side that gets paid', async () => {
  const h = await harness();
  try {
    const caller = await h.call('/signup');
    assert.doesNotMatch(caller.body as string, /payout_address/, 'nothing is paid to a caller');

    const responder = await h.call('/signup?as=responder');
    assert.match(responder.body as string, /name="payout_address"/);
    assert.match(responder.body as string, /optional/);
  } finally {
    await h.close();
  }
});
