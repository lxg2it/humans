import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describeAge } from '../src/pool.ts';

/**
 * The sentences the console shows a responder before they decide to work.
 *
 * These were built at runtime inside console.js, which meant the copy the
 * responder actually reads was the one copy in the service that no test could
 * see. The page tests discover the pages the service serves and check the
 * condition on every figure those pages carry — and a sentence assembled from
 * /api/me is on no page, so it was checked by nobody, in the place where the
 * decision is made.
 *
 * So the sentences live in public/pool-note.js, and this file loads the shipped
 * source into a fresh context with a window, the way a script tag loads it,
 * rather than importing a copy of the logic that could drift from what is
 * served. What is worth asking about here is not layout but the four states a
 * person can be in — including the one where the balance cannot be read at all,
 * which is the state that must never be rendered as an empty one.
 */

function load(): any {
  const sandbox: { window: any } = { window: {} };
  runInNewContext(readFileSync('public/pool-note.js', 'utf8'), sandbox);
  assert.ok(sandbox.window.HumansPoolNote, 'pool-note.js must publish window.HumansPoolNote');
  return sandbox.window.HumansPoolNote;
}

const PoolNote = load();

/** A value from the module's realm, rebuilt in this one — the same trade as the reading test. */
const plain = (value: any): any => JSON.parse(JSON.stringify(value));

const GUARANTEE = 250;

/**
 * The clock is passed in, never read. This module used to be handed an
 * already-formatted age string by console.js, which meant the parenthetical the
 * responder reads was produced by a second, untested copy of the formatter; now
 * it formats its own and this file owns both halves of the sentence.
 */
const NOW = 1_800_000_000_000;
const twoMinutesAgo = () => ({ readAt: NOW - 120_000, now: NOW });

const note = (over: Record<string, unknown> = {}) =>
  plain(
    PoolNote.note({
      guaranteeSats: GUARANTEE,
      poolSats: 0,
      poolError: null,
      owedSats: 0,
      readAt: null,
      now: NOW,
      ...over,
    }),
  );

test('an unreadable balance is a missing figure, never an empty one', () => {
  // The one sentence this service cannot get wrong: it is what someone reads
  // while deciding whether to spend an hour answering for nothing.
  const unknown = note({ poolSats: null });

  assert.equal(
    unknown.text,
    'The guarantee is 250 sats per reply. The pool balance could not be read, so whether it is funded is ' +
      'unknown right now. That is a missing figure, not an empty one: while the pool holds something the ' +
      'guarantee is paid, and when it is empty nothing is paid.',
  );
  assert.equal(unknown.tone, 'warn', 'an unknown balance is not a calm state to read');

  // The control: the empty pool, which is a different sentence about a different
  // world. If these two ever render alike, a person is told there is nothing
  // when the truth is that nobody looked.
  const empty = note({ poolSats: 0 });
  assert.notEqual(unknown.text, empty.text, 'an unreadable balance renders as an empty one');
  assert.doesNotMatch(unknown.text, /the pool is empty/, 'an unreadable balance claims the pool is empty');

  // A field the server did not send is a figure we do not have, for the same
  // reason: absent is not zero.
  assert.equal(note({ poolSats: undefined }).text, unknown.text, 'a missing pool field reads as an empty pool');

  // And the reason the reading failed is carried when there is one, because a
  // person deciding whether to wait wants to know whether anyone tried.
  const failed = note({ poolSats: null, poolError: 'ECONNREFUSED' });
  assert.match(failed.text, /could not be read — ECONNREFUSED, so whether it is funded is unknown/);
  // The control for that: no error, no invented reason.
  assert.doesNotMatch(unknown.text, /—/, 'a reading that did not fail is given a reason anyway');
});

test('an empty pool is stated as an unfunded promise, not as no promise', () => {
  // Both of the comfortable stories are wrong here. "We owe you nothing" is
  // false — the promise is recorded — and "you will be paid" is false too.
  const empty = note({ poolSats: 0, ...twoMinutesAgo() });

  assert.equal(
    empty.text,
    '250 sats per reply, paid from the pool — and the pool is empty (read 2 minutes ago). Nothing is paid ' +
      'while it is empty: the promise is recorded and unfunded, and it is paid if the pool gets topped up.',
  );
  assert.equal(empty.tone, 'warn');

  // The age of the reading is shown when there is one, and not invented when
  // there is not: a cold reader is not a reading from just now.
  assert.doesNotMatch(note({ poolSats: 0 }).text, /\(read/, 'a reading with no age is given one anyway');
});

test('a partly funded pool puts a number on the shortfall', () => {
  // The case that matters, and the only one where the honest answer is neither
  // of the two easy ones: the promise is alive and it is not fully backed.
  const partial = note({ poolSats: 1_000, owedSats: 2_500, ...twoMinutesAgo() });

  assert.equal(
    partial.text,
    'Paid 250 sats per answered reply, from a pool of 1,000 sats (read 2 minutes ago). Already owed 2,500, ' +
      'so 1,500 of what has been promised is recorded and unpaid.',
  );
  assert.equal(partial.tone, 'warn', 'a shortfall is not a calm state to read');

  // The subtraction is the figure a person is actually owed, and both sides of
  // it carry separators so five- and six-figure sums can be read at a glance.
  const bigger = note({ poolSats: 2_000, owedSats: 12_500 });
  assert.match(bigger.text, /from a pool of 2,000 sats/);
  assert.match(bigger.text, /Already owed 12,500, so 10,500 of what has been promised is recorded and unpaid/);

  // The boundary, in both directions: one satoshi short is a shortfall, and
  // exactly covered is covered. An off-by-one here is the difference between
  // telling someone they are owed money and telling them they are not.
  assert.equal(note({ poolSats: 2_499, owedSats: 2_500 }).tone, 'warn', 'one satoshi short reads as covered');
  assert.equal(note({ poolSats: 2_500, owedSats: 2_500 }).tone, '', 'exactly covered reads as a shortfall');
  assert.equal(note({ poolSats: 1, owedSats: 0 }).tone, '', 'a positive pool with nothing owed is not a shortfall');
});

test('a covered pool still says where the money comes from, and when it stops', () => {
  const covered = note({ poolSats: 250_000, owedSats: 2_500, ...twoMinutesAgo() });

  assert.equal(
    covered.text,
    'Paid 250 sats per answered reply, from a pool of 250,000 sats (read 2 minutes ago). The pool is the only ' +
      'place payment comes from: while there is something in it the guarantee is paid, and when it is empty ' +
      'nothing is paid.',
  );
  // The funded state is the tempting one to state as an unconditional promise.
  // It is not one, and the sentence has to say so even here.
  assert.match(covered.text, /when it is empty nothing is paid/, 'a funded pool is promised unconditionally');
  assert.equal(covered.tone, '', 'a fully funded pool is a calm state to read');
});

test('every state names the pool as the source, and none is skipped', () => {
  // The same shape as the page test: count what was actually asserted on, so a
  // state added later cannot quietly pass by matching nothing.
  const states: Array<[string, any]> = [
    ['unreadable', note({ poolSats: null })],
    ['empty', note({ poolSats: 0 })],
    ['partly funded', note({ poolSats: 1_000, owedSats: 2_500 })],
    ['covered', note({ poolSats: 250_000, owedSats: 2_500 })],
  ];

  let checked = 0;
  for (const [name, stated] of states) {
    assert.ok(stated.text.length > 0, `${name} renders nothing at all`);
    // Only that the source is named at all. The wording of each state is pinned
    // word for word by the assertions above, and my first version of this line
    // listed the phrasings I had in mind — which failed the unreadable state,
    // whose sentence names the pool as the thing that could not be read. A
    // phrase list dressed as a meaning test; this asks the question the loop can
    // actually answer, which is whether a state stops mentioning the pool.
    assert.match(stated.text, /pool/, `${name} states the guarantee without saying where the money comes from`);
    assert.match(
      stated.text,
      /nothing is paid|recorded and unfunded|recorded and unpaid/,
      `${name} states the figure without the condition on it`,
    );
    checked += 1;
  }

  assert.equal(checked, 4, 'the states were not all asserted on, so the loop above proves nothing');
  assert.equal(
    new Set(states.map(([, stated]) => stated.text)).size,
    4,
    'two states render identically, so the console cannot tell a responder which one they are in',
  );
});

test("the age it prints is the same string the page renders, boundary for boundary", () => {
  // Two copies of this formatter exist — one here for the browser, one in
  // src/pool.ts for the rendered pages — because a browser file and a server
  // module cannot share a source without one of them giving up its runtime.
  // What was missing was not the second copy but the pin between them: the copy
  // in console.js had no test at all, so the sentence above quoted an age
  // produced by code nothing checked. Drift between these two is now a failure
  // here rather than a difference nobody sees until a page contradicts a screen.
  const secondsToCheck = [];
  for (let seconds = 0; seconds <= 3 * 24 * 3_600; seconds += 7) secondsToCheck.push(seconds);
  // Plus the transitions themselves, where a rounding difference would live.
  secondsToCheck.push(0, 1, 89, 90, 91, 149, 150, 3_599, 3_600, 3_601, 5_399, 5_400, 129_599, 129_600, 130_000);

  const disagreed = [];
  const said = new Set();
  for (const seconds of secondsToCheck) {
    const readAt = NOW - seconds * 1_000;
    const mine = PoolNote.describeAge(readAt, NOW);
    const theirs = describeAge(readAt, NOW);
    if (mine !== theirs) disagreed.push(`${seconds}s: "${mine}" vs "${theirs}"`);
    said.add(mine);
  }

  assert.deepEqual(disagreed, [], 'the two copies of the age formatter have drifted apart');

  // Agreement over one branch proves nothing, so the sweep has to be shown to
  // reach all four.
  for (const pattern of [/^just now$/, /^\d+ minutes ago$/, /^\d+ hours ago$/, /^\d+ days ago$/]) {
    assert.ok([...said].some((text) => pattern.test(text)), `${pattern} was never reached by the sweep`);
  }
  assert.ok(said.has('1 hour ago'), 'the singular an hour-old reading needs is not produced');

  // And the same unreachability the server copy documents: nothing rounds to a
  // bare 1 in minutes or days, so neither branch carries a singular, and a change
  // to the 90-second window would show up here as a string with a missing "s".
  assert.ok(!said.has('1 minutes ago') && !said.has('1 minutes ago'.replace('s', '')));
});
