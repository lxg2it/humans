import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness, messageRequest } from './helpers.ts';

/**
 * One word, one quantity.
 *
 * "Owed" was two numbers on two surfaces until 2026-10-22. The public /pool page
 * summed every responder's ledger and said so — "Owed now: N satoshis, across
 * everybody who has answered" — while the console handed its note a SINGLE
 * responder's balance and the sentence called it "what has been promised". So a
 * person who read the money page and then sat down to answer calls saw the same
 * word describing a figure that could differ by everyone else's credit.
 *
 * The console now receives both figures and names each one. This file pins the
 * pair apart at the source, because a renamed parameter is only a promise until
 * something fails when the wrong number is passed to it: with two responders
 * holding one credit each, the service's obligation is twice the reader's own,
 * and a field that echoed the reader's balance would look correct on any test
 * that only ever had one responder.
 */

test('the service obligation and the responder own credit are different figures, both reported', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  const other = h.store.mintCredential('responder', 'the-other-one').key;

  // Two calls, answered by two different people, so the two totals cannot agree.
  const first = h.send(messageRequest());
  const rowA = await h.awaitQueued();
  const claimA = await h.call(`/api/requests/${rowA.id}/claim`, {
    method: 'POST',
    body: { declare: true },
    key: h.responderKey,
  });
  assert.equal(claimA.status, 200);
  await h.call(`/api/requests/${rowA.id}/submit`, {
    method: 'POST',
    key: h.responderKey,
    body: { text: 'answered by one' },
  });
  assert.equal((await first).status, 200);

  const second = h.send(messageRequest());
  const rowB = await h.awaitQueued(h.responderKey, (row: any) => row.id !== rowA.id);
  const claimB = await h.call(`/api/requests/${rowB.id}/claim`, {
    method: 'POST',
    body: { declare: true },
    key: other,
  });
  assert.equal(claimB.status, 200);
  await h.call(`/api/requests/${rowB.id}/submit`, {
    method: 'POST',
    key: other,
    body: { text: 'answered by the other' },
  });
  assert.equal((await second).status, 200);

  const me = await h.call('/api/me', { key: h.responderKey });
  const guarantee = me.body.guarantee_sats;
  assert.equal(typeof guarantee, 'number');

  // Their own: one reply's worth. Everybody's: two. Written as a relationship
  // rather than as two literals, so a change to the guarantee does not quietly
  // turn this into a test of the setting.
  assert.equal(me.body.earnings.owedSats, guarantee, 'the reader was paid or credited the wrong amount');
  assert.equal(
    me.body.owed_across_everybody,
    guarantee * 2,
    'the console was handed one responder\'s balance as though it were what the service owes',
  );

  // And they are not the same field wearing two names.
  assert.notEqual(
    me.body.earnings.owedSats,
    me.body.owed_across_everybody,
    'the two figures agree here, so this test cannot tell them apart',
  );
});

test('with nothing answered yet, both figures are zero and neither is missing', async (t) => {
  // The control. If the field were absent, `undefined * 1` and a strict compare
  // against 0 would both look like a pass on a looser assertion; this states the
  // value at rest, which is the one a brand-new instance serves.
  const h = await harness();
  t.after(() => h.close());

  const me = await h.call('/api/me', { key: h.responderKey });
  assert.equal(typeof me.body.owed_across_everybody, 'number', 'the figure is absent, not zero');
  assert.equal(me.body.owed_across_everybody, 0);
  assert.equal(me.body.earnings.owedSats, 0);
});
