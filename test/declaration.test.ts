/**
 * The declaration, and where it is asked.
 *
 * A key is a seat, not a person. The service can tell that a key was used; it
 * cannot tell what is on the other end of it, and every claim to the contrary
 * would be false. So the declaration is a stated fact with a date, and what is
 * enforced is that the sentence was put in front of somebody at the moment they
 * took their first call — the moment it means something — rather than that the
 * answer is true.
 *
 * These tests are about the gate, not the wording: a first claim without the
 * declaration is refused, the refusal leaves the call for somebody else, and the
 * declaration is remembered so that no later claim has to repeat it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, messageRequest } from './helpers.ts';

test('a first claim is refused without the declaration, and the call stays waiting', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  const pending = h.send(messageRequest());
  const row = await h.awaitQueued();

  const refused = await h.call(`/api/requests/${row.id}/claim`, { method: 'POST', body: {}, key: h.responderKey });
  assert.equal(refused.status, 400, 'a claim with no declaration must be refused');
  assert.match(refused.body.error.message, /say that you are a human/);
  // The refusal has to name the gesture that fixes it, or a caller reads it as a
  // fault in the service rather than as one word of body they left out.
  assert.match(refused.body.error.message, /"declare": true/);

  // Nothing was taken. A refusal that consumed the call would take it away from
  // every other responder to punish this one.
  const stillQueued = await h.call('/api/queue', { key: h.responderKey });
  assert.equal(stillQueued.body.requests.length, 1, 'the call must still be waiting for somebody');
  assert.equal(stillQueued.body.requests[0].id, row.id);

  // And it is genuinely still claimable — not merely listed, which is a status
  // the queue could report for a request nobody can take.
  await h.answer(row.id, { text: 'answered by the next one to try' });
  assert.equal((await pending).status, 200);
});

test('the declaration is remembered, and no later claim repeats it', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  const before = await h.call('/api/me', { key: h.responderKey });
  assert.equal(before.body.declared_at, null, 'a new key has not declared anything yet');

  const first = h.send(messageRequest());
  const row = await h.awaitQueued();
  const claimed = await h.call(`/api/requests/${row.id}/claim`, {
    method: 'POST',
    body: { declare: true },
    key: h.responderKey,
  });
  assert.equal(claimed.status, 200);

  const after = await h.call('/api/me', { key: h.responderKey });
  assert.equal(typeof after.body.declared_at, 'number', 'the date of the declaration must be on the record');

  await h.call(`/api/requests/${row.id}/submit`, { method: 'POST', key: h.responderKey, body: { text: 'one' } });
  assert.equal((await first).status, 200);

  // The second call, with an empty body: the question has been answered, so it
  // is not asked again.
  const second = h.send(messageRequest());
  const nextRow = await h.awaitQueued();
  const secondClaim = await h.call(`/api/requests/${nextRow.id}/claim`, {
    method: 'POST',
    body: {},
    key: h.responderKey,
  });
  assert.equal(secondClaim.status, 200, 'a responder who has declared should claim without repeating it');
  await h.call(`/api/requests/${nextRow.id}/submit`, { method: 'POST', key: h.responderKey, body: { text: 'two' } });
  assert.equal((await second).status, 200);
});

test('a claim is not a way to declare without taking anything', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  // Somebody else's call. The refusal here is about the hold, which is checked
  // before the declaration: a responder poking at a call that is already being
  // answered should be told that, not asked to declare.
  const other = h.store.mintCredential('responder', 'somebody-else').key;
  const pending = h.send(messageRequest());
  const row = await h.awaitQueued();
  await h.call(`/api/requests/${row.id}/claim`, { method: 'POST', body: { declare: true }, key: h.responderKey });

  const steal = await h.call(`/api/requests/${row.id}/claim`, {
    method: 'POST',
    body: { declare: true },
    key: other,
  });
  assert.equal(steal.status, 409);
  assert.match(steal.body.error.message, /is answering this one/);

  const me = await h.call('/api/me', { key: other });
  assert.equal(me.body.declared_at, null, 'a lost claim is not a declaration');

  await h.call(`/api/requests/${row.id}/submit`, { method: 'POST', key: h.responderKey, body: { text: 'mine' } });
  assert.equal((await pending).status, 200);
});
