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
 *
 * The validation used to run at signup, on a form that asked for an address
 * before the person had seen a single call. That form is gone — a seat is made
 * the moment the console loads — so the address is set from the console when
 * there is something to be paid, and the refusals are tested where they now
 * live, on POST /api/me/payout-address.
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

interface Seat {
  status: number;
  key: string;
  name: string;
  body: Record<string, unknown>;
}

/** Takes a seat the way the console does: one POST, nothing supplied. */
async function takeSeat(base: string): Promise<Seat> {
  const response = await fetch(`${base}/api/responders`, { method: 'POST' });
  const body = (await response.json()) as Record<string, unknown>;
  return {
    status: response.status,
    key: typeof body.key === 'string' ? body.key : '',
    name: typeof body.name === 'string' ? body.name : '',
    body,
  };
}

test('a seat is made without being asked for anything, and starts with no address', async () => {
  const h = await harness();
  try {
    const seat = await takeSeat(h.base);
    assert.equal(seat.status, 201, JSON.stringify(seat.body));

    // The name is generated, not chosen, and it is the ledger's key — so it has
    // to be unique rather than memorable.
    assert.match(seat.name, /^responder-[0-9a-f]{6}$/, 'the seat name is generated');
    assert.match(seat.key, /^hmn_/, 'a responder key, not a caller key');

    const me = await h.call('/api/me', { key: seat.key });
    assert.equal(me.status, 200);
    assert.equal((me.body as any).name, seat.name);
    assert.equal((me.body as any).payout_address, null, 'nothing is asked for, so nothing is set');
    assert.equal(h.store.payoutAddressFor(seat.name), null);

    // The response never offers an address field: the seat is not a form.
    assert.ok(!('payout_address' in seat.body), 'the mint must not invite an address');
  } finally {
    await h.close();
  }
});

test('a responder can set, change and clear where they are paid, from the console', async () => {
  const h = await harness();
  try {
    const seat = await takeSeat(h.base);

    // Set it.
    const set = await h.call('/api/me/payout-address', {
      method: 'POST',
      body: { address: MAINNET },
      key: seat.key,
    });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    assert.equal((set.body as any).payout_address, MAINNET);

    // The thing settlement actually reads agrees with what /api/me says.
    assert.equal(h.store.payoutAddressFor(seat.name), MAINNET);

    // Change it: a rotated wallet should not require a new seat.
    const changed = await h.call('/api/me/payout-address', {
      method: 'POST',
      body: { address: MAINNET_TAPROOT },
      key: seat.key,
    });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    assert.equal((changed.body as any).payout_address, MAINNET_TAPROOT);
    assert.equal(h.store.payoutAddressFor(seat.name), MAINNET_TAPROOT);

    // A typo is refused, and the stored address is left alone rather than
    // replaced with the thing that failed validation.
    const rejected = await h.call('/api/me/payout-address', {
      method: 'POST',
      body: { address: 'not-an-address-at-all' },
      key: seat.key,
    });
    assert.equal(rejected.status, 400);
    assert.match(String((rejected.body as any).error?.message ?? ''), /not a Bitcoin address/);
    assert.equal(h.store.payoutAddressFor(seat.name), MAINNET_TAPROOT, 'a refused change must change nothing');

    // The discriminator for the network check: the SAME shape of address on
    // testnet is refused, so it is the network check and not the parser.
    const wrongnet = await h.call('/api/me/payout-address', {
      method: 'POST',
      body: { address: TESTNET },
      key: seat.key,
    });
    assert.equal(wrongnet.status, 400, 'a valid testnet address must still be refused here');
    assert.match(String((wrongnet.body as any).error?.message ?? ''), /testnet/);
    assert.equal(h.store.payoutAddressFor(seat.name), MAINNET_TAPROOT);

    // Clearing is allowed: not wanting to be paid is a position, not an error.
    const cleared = await h.call('/api/me/payout-address', {
      method: 'POST',
      body: { address: '' },
      key: seat.key,
    });
    assert.equal(cleared.status, 200);
    assert.equal((cleared.body as any).payout_address, null);
    assert.equal(h.store.payoutAddressFor(seat.name), null);
  } finally {
    await h.close();
  }
});

test('one responder cannot change another one\u2019s address', async () => {
  const h = await harness();
  try {
    const mine = await takeSeat(h.base);
    const theirs = await takeSeat(h.base);
    for (const [seat, address] of [
      [mine, MAINNET],
      [theirs, MAINNET_TAPROOT],
    ] as const) {
      const set = await h.call('/api/me/payout-address', { method: 'POST', body: { address }, key: seat.key });
      assert.equal(set.status, 200, JSON.stringify(set.body));
    }

    // There is no field for "whose" — the key decides, and that is the whole
    // point of the route being /api/me/*. Sending a name anyway must do nothing.
    const attempt = await h.call('/api/me/payout-address', {
      method: 'POST',
      body: { address: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', responder: theirs.name, name: theirs.name },
      key: mine.key,
    });
    assert.equal(attempt.status, 200);
    assert.equal(h.store.payoutAddressFor(theirs.name), MAINNET_TAPROOT, 'the other person\u2019s record must be untouched');
    assert.equal(h.store.payoutAddressFor(mine.name), '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa');

    // And the other person's own view of themselves is unchanged too: a route
    // that quietly rewrote the wrong row would be visible here as well.
    const theirView = await h.call('/api/me', { key: theirs.key });
    assert.equal((theirView.body as any).payout_address, MAINNET_TAPROOT);
  } finally {
    await h.close();
  }
});

test('two seats never answer under one name, because the ledger is keyed by it', async () => {
  const h = await harness();
  try {
    const seats = [];
    for (let index = 0; index < 6; index += 1) seats.push(await takeSeat(h.base));
    for (const seat of seats) assert.equal(seat.status, 201, JSON.stringify(seat.body));

    const names = new Set(seats.map((seat) => seat.name));
    assert.equal(names.size, seats.length, 'every seat gets its own name');

    // Everything on the money side is keyed by this string — earnings(name), the
    // ledger's `responder` column, the settle command — so two people under one
    // name would have their earnings added together and one settlement paid into
    // one of their addresses. The uniqueness is asserted here rather than left to
    // the generator: `responderNameTaken` is what makes it true, and a mint that
    // skipped the check would look identical from the outside.
    // Scoped to the generated names: the harness seeds its own responder, and a
    // bare count would be measuring that instead of the minting.
    const minted = h.store.listCredentials('responder').filter((row) => /^responder-[0-9a-f]{6}$/.test(row.name));
    assert.equal(minted.length, seats.length);
    for (const seat of seats) {
      assert.equal(minted.filter((row) => row.name === seat.name).length, 1);
    }
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

test('the signup form only offers an address to the side that gets paid', async () => {
  const h = await harness();
  try {
    const caller = await h.call('/signup');
    assert.doesNotMatch(caller.body as string, /payout_address/, 'nothing is paid to a caller');

    // A responder is no longer sent to a form at all: the old address is a
    // redirect to the console, where the seat is made.
    const retired = await fetch(`${h.base}/signup?as=responder`, { redirect: 'manual' });
    assert.equal(retired.status, 302);
    assert.equal(retired.headers.get('location'), '/console');
  } finally {
    await h.close();
  }
});
