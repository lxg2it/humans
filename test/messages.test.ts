import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness, liveStream, messageRequest, readSse, until } from './helpers.ts';

/**
 * The contract, end to end over HTTP: a caller's request goes in, a person is
 * asked, a person answers, and the caller gets an Anthropic-shaped response.
 */

test('a caller is answered by a person, and the response is Anthropic-shaped', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  const pending = h.send(messageRequest());
  const row = await h.awaitQueued();
  assert.equal(row.status, 'queued', 'the request should be waiting, not assigned');

  const submitted = await h.answer(row.id, { text: 'Canberra.', stop_reason: 'end_turn' });
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));

  const response = await pending;
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.type, 'message');
  assert.equal(response.body.role, 'assistant');
  assert.equal(response.body.model, 'human-1');
  assert.equal(response.body.stop_reason, 'end_turn');
  assert.equal(response.body.stop_sequence, null);
  assert.deepEqual(response.body.content, [{ type: 'text', text: 'Canberra.' }]);
  assert.equal(typeof response.body.id, 'string');
  assert.match(response.body.id, /^msg_/);
  assert.deepEqual(response.body.usage, { input_tokens: response.body.usage.input_tokens, output_tokens: response.body.usage.output_tokens });
  assert.ok(response.body.usage.input_tokens > 0, 'input tokens are estimated from the prompt');
  assert.ok(response.body.usage.output_tokens > 0, 'output tokens are estimated from the reply');
});

test('a request is answered exactly once, even if the submit is replayed', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  const pending = h.send(messageRequest());
  const row = await h.awaitQueued();
  await h.answer(row.id, { text: 'first' });

  const replay = await h.call(`/api/requests/${row.id}/submit`, {
    method: 'POST',
    key: h.responderKey,
    body: { text: 'second' },
  });
  assert.equal(replay.status, 409, 'a second answer must be refused');

  const response = await pending;
  assert.equal(response.body.content[0].text, 'first', 'the caller got the first answer, not the second');
});

test('the queue does not hand out a prompt somebody else is answering', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  const otherKey = h.store.mintCredential('responder', 'someone-else').key;
  const pending = h.send(messageRequest());
  const row = await h.awaitQueued();
  await h.call(`/api/requests/${row.id}/claim`, { method: 'POST', body: {}, key: h.responderKey });

  const read = await h.call(`/api/requests/${row.id}`, { key: otherKey });
  assert.equal(read.status, 409, 'another responder must not read a claimed request');
  assert.match(read.body.error.message, /is answering this one/);

  const steal = await h.call(`/api/requests/${row.id}/claim`, { method: 'POST', body: {}, key: otherKey });
  assert.equal(steal.status, 409);

  await h.call(`/api/requests/${row.id}/submit`, { method: 'POST', key: h.responderKey, body: { text: 'mine' } });
  assert.equal((await pending).status, 200);
});

test('an abandoned request goes back to the queue and can still be answered', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  const pending = h.send(messageRequest());
  const row = await h.awaitQueued();
  await h.call(`/api/requests/${row.id}/claim`, { method: 'POST', body: {}, key: h.responderKey });
  const abandoned = await h.call(`/api/requests/${row.id}/abandon`, { method: 'POST', body: {}, key: h.responderKey });
  assert.equal(abandoned.status, 200);

  const requeued = await h.awaitQueued(h.responderKey, (r) => r.id === row.id && r.status === 'queued');
  assert.equal(requeued.claimed_by, null, 'abandoning must clear the claim');

  await h.answer(row.id, { text: 'answered after a change of mind' });
  assert.equal((await pending).status, 200);
});

test('a request nobody answers times out with 504, and the caller is told why', async (t) => {
  const h = await harness({ callTimeoutMs: 300, sweepIntervalMs: 25 });
  t.after(() => h.close());

  const pending = h.send(messageRequest());
  await h.awaitQueued();
  const response = await pending;
  assert.equal(response.status, 504);
  assert.equal(response.body.type, 'error');
  assert.equal(response.body.error.type, 'timeout_error');
  assert.match(response.body.error.message, /no responder/);

  const queued = await h.call('/api/queue', { key: h.responderKey });
  assert.equal(queued.body.requests.length, 0, 'the expired request must leave the queue');
});

test('a claim that is left alone is swept back to the queue', async (t) => {
  // The lease is what stops an abandoned tab from holding a request for its
  // whole lifetime. The harness shortens it, so the test exercises the sweep
  // rather than a database edit that only looks like one.
  const h = await harness({ callTimeoutMs: 60_000, sweepIntervalMs: 20, claimLeaseMs: 40 });
  t.after(() => h.close());

  const pending = h.send(messageRequest());
  const row = await h.awaitQueued();
  await h.call(`/api/requests/${row.id}/claim`, { method: 'POST', body: {}, key: h.responderKey });
  const held = await h.call(`/api/requests/${row.id}`, { key: h.responderKey });
  assert.equal(held.body.mine, true, 'the claim should hold at first');

  const released = await until(async () => {
    const queued = await h.call('/api/queue', { key: h.responderKey });
    const match = (queued.body.requests as any[]).find((r) => r.id === row.id);
    return match && match.claimed_by === null ? match : null;
  });
  assert.equal(released.status, 'queued', 'the lease should have lapsed');
  assert.equal(released.mine, false);

  await h.answer(row.id, { text: 'answered by whoever picked it up next' });
  assert.equal((await pending).status, 200);
});

test('two responders racing for one request: exactly one wins', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  const second = h.store.mintCredential('responder', 'racer-two').key;
  const pending = h.send(messageRequest());
  const row = await h.awaitQueued();

  const [a, b] = await Promise.all([
    h.call(`/api/requests/${row.id}/claim`, { method: 'POST', body: {}, key: h.responderKey }),
    h.call(`/api/requests/${row.id}/claim`, { method: 'POST', body: {}, key: second }),
  ]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [200, 409], `exactly one claim should win, got ${JSON.stringify([a.status, b.status])}`);

  const winner = a.status === 200 ? h.responderKey : second;
  await h.call(`/api/requests/${row.id}/submit`, { method: 'POST', key: winner, body: { text: 'won' } });
  assert.equal((await pending).status, 200);
});

// ---- streaming -------------------------------------------------------------

test('a streaming caller receives the events Anthropic clients expect, in order', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  const streamed = fetch(`${h.base}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': h.callerKey },
    body: JSON.stringify(messageRequest({ stream: true, max_tokens: 64 })),
  });

  const row = await h.awaitQueued();
  assert.equal(row.stream, true, 'the queue should say this one is streaming');
  await h.answer(row.id, { thinking: 'The capital is Canberra.', text: 'Canberra.', stop_reason: 'end_turn' });

  const response = await streamed;
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);

  const events = await readSse(response);
  const names = events.map((event) => event.event);
  assert.equal(names[0], 'message_start');
  assert.equal(names[names.length - 1], 'message_stop');

  const order = ['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop'];
  let cursor = 0;
  for (const wanted of order) {
    const at = names.indexOf(wanted, cursor);
    assert.ok(at >= cursor, `${wanted} must appear after the previous event; got ${names.join(', ')}`);
    cursor = at;
  }

  const start = events.find((event) => event.event === 'message_start');
  assert.ok(start, 'message_start must be present');
  assert.equal(start.data.type, 'message_start');
  assert.equal(start.data.message.role, 'assistant');
  assert.equal(start.data.message.model, 'human-1');
  assert.deepEqual(start.data.message.content, []);
  assert.equal(start.data.message.usage.output_tokens, 0, 'nothing has been emitted yet');

  const stop = events.find((event) => event.event === 'message_stop');
  assert.ok(stop, 'message_stop must be present');
  assert.equal(stop.data.type, 'message_stop');

  const delta = events.find((event) => event.event === 'message_delta');
  assert.ok(delta, 'message_delta must be present');
  assert.equal(delta.data.delta.stop_reason, 'end_turn');

  const text = events
    .filter((event) => event.event === 'content_block_delta' && event.data.delta.type === 'text_delta')
    .map((event) => event.data.delta.text)
    .join('');
  assert.equal(text, 'Canberra.');
});

test('a waiting stream is held open with pings rather than silence', async (t) => {
  // A person takes minutes. A reply that says nothing for that long is closed by
  // whatever is between us and the caller — Cloudflare ends an idle proxied
  // response at 100s — and the caller sees a truncated message rather than a
  // slow one.
  const h = await harness({ pingIntervalMs: 30, callTimeoutMs: 60_000 });
  t.after(() => h.close());

  const response = await fetch(`${h.base}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': h.callerKey },
    body: JSON.stringify(messageRequest({ stream: true })),
  });
  const stream = liveStream(response);
  const row = await h.awaitQueued();

  await stream.waitFor((s) => s.events().some((event) => event.event === 'ping'), 2000);
  const pingsBefore = stream.events().filter((event) => event.event === 'ping').length;
  assert.ok(pingsBefore >= 1);

  await h.answer(row.id, { text: 'answered after the wait' });
  await stream.waitFor((s) => s.events().some((event) => event.event === 'message_stop'));
  await stream.close();

  const names = stream.events().map((event) => event.event);
  assert.equal(names[0], 'message_start');
  assert.ok(
    names.indexOf('ping') < names.indexOf('message_delta'),
    `pings must come before the answer, got ${names.join(', ')}`,
  );
  assert.equal(stream.text(), 'answered after the wait');
});

test('a streaming caller sees text as it is typed, not only at the end', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  const response = await fetch(`${h.base}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': h.callerKey },
    body: JSON.stringify(messageRequest({ stream: true })),
  });
  assert.equal(response.status, 200);
  const stream = liveStream(response);

  const row = await h.awaitQueued();
  await h.call(`/api/requests/${row.id}/claim`, { method: 'POST', body: {}, key: h.responderKey });

  // A partial must reach the caller while the reply is still being written.
  // That is the whole difference between streaming a person and buffering one.
  await h.call(`/api/requests/${row.id}/partial`, { method: 'POST', key: h.responderKey, body: { text: 'Canb' } });
  await stream.waitFor((s) => s.text() === 'Canb');
  assert.equal(stream.finished(), false, 'the stream must still be open after a partial');

  await h.call(`/api/requests/${row.id}/partial`, {
    method: 'POST',
    key: h.responderKey,
    body: { text: 'Canberra is the capital.' },
  });
  await stream.waitFor((s) => s.text() === 'Canberra is the capital.');

  await h.call(`/api/requests/${row.id}/submit`, {
    method: 'POST',
    key: h.responderKey,
    body: { text: 'Canberra is the capital.', stop_reason: 'end_turn' },
  });
  await stream.waitFor((s) => s.events().some((event) => event.event === 'message_stop'));
  await stream.close();

  // Each send may only carry the suffix that is new: a client concatenates
  // deltas and cannot un-receive one, so a repeat would duplicate the text.
  const deltas = stream
    .events()
    .filter((event) => event.event === 'content_block_delta' && event.data.delta.type === 'text_delta')
    .map((event) => event.data.delta.text as string);
  assert.deepEqual(deltas, ['Canb', 'erra is the capital.']);
  assert.equal(stream.text(), 'Canberra is the capital.');
});

// ---- auth ------------------------------------------------------------------

test('a stream that times out says so inside the stream, because the status is spent', async (t) => {
  // Past the first byte there is no status left to send. The caller has already
  // been given 200 and a message_start, so the refusal has to arrive as an event
  // — and it has to be the same refusal they would have received as a 504.
  const h = await harness({ callTimeoutMs: 60, pingIntervalMs: 20 });
  t.after(() => h.close());

  const response = await fetch(`${h.base}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': h.callerKey },
    body: JSON.stringify(messageRequest({ stream: true })),
  });
  assert.equal(response.status, 200, 'the status went out with message_start');
  const stream = liveStream(response);

  await stream.waitFor((s) => s.events().some((event) => event.event === 'error'), 3000);
  await stream.close();

  const error = stream.events().find((event) => event.event === 'error')!;
  assert.equal(error.data.error.type, 'timeout_error');
  assert.match(error.data.error.message, /no responder/);
  assert.equal(
    stream.events().some((event) => event.event === 'message_stop'),
    false,
    'a timed-out message must not be closed as if it had been answered',
  );
});

test('a partial that reaches nobody says so rather than reporting success', async (t) => {
  // A non-streaming caller has no stream to write to, so the responder's typing
  // cannot be delivered. The console uses this to tell them the caller is gone
  // rather than leaving them typing into nothing.
  const h = await harness({ callTimeoutMs: 60_000 });
  t.after(() => h.close());

  const pending = h.send(messageRequest());
  const row = await h.awaitQueued();
  await h.call(`/api/requests/${row.id}/claim`, { method: 'POST', body: {}, key: h.responderKey });

  const partial = await h.call(`/api/requests/${row.id}/partial`, {
    method: 'POST',
    key: h.responderKey,
    body: { text: 'typing into the void' },
  });
  assert.equal(partial.status, 200);
  assert.equal(partial.body.ok, true);
  assert.equal(partial.body.delivered, false);

  // Submitted directly: this responder already holds the claim.
  await h.call(`/api/requests/${row.id}/submit`, {
    method: 'POST',
    key: h.responderKey,
    body: { text: 'still recorded' },
  });
  const answered = await pending;
  assert.equal(answered.status, 200, 'the answer is still delivered as a normal response');
  assert.equal(answered.body.content[0].text, 'still recorded');
});

test('a caller key is required when the deployment says so, and a wrong one is refused', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  const anonymous = await h.call('/v1/messages', { method: 'POST', body: messageRequest() });
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.body.error.type, 'authentication_error');

  const wrong = await h.call('/v1/messages', {
    method: 'POST',
    body: messageRequest(),
    headers: { 'x-api-key': 'not-a-real-key' },
  });
  assert.equal(wrong.status, 401);

  const responderTryingToCall = await h.call('/v1/messages', {
    method: 'POST',
    body: messageRequest(),
    headers: { 'x-api-key': h.responderKey },
  });
  assert.equal(responderTryingToCall.status, 401, 'a responder key is not a caller key');
});

test('a bearer token or an x-api-key will do, as Anthropic clients send both', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  const asHeader = h.call('/v1/messages', { method: 'POST', body: messageRequest(), headers: { 'x-api-key': h.callerKey } });
  const asBearer = h.call('/v1/messages', { method: 'POST', body: messageRequest(), headers: { authorization: `Bearer ${h.callerKey}` } });

  for (const pending of [asHeader, asBearer]) {
    const row = await h.awaitQueued();
    await h.answer(row.id, { text: 'ok' });
    assert.equal((await pending).status, 200);
  }
});

test('the operator API is closed without the admin key', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  const anonymous = await h.call('/api/admin/overview');
  assert.equal(anonymous.status, 401);
  const wrong = await h.call('/api/admin/overview', { key: 'not-the-admin-key' });
  assert.equal(wrong.status, 401, 'a responder key must not open the operator API');
  const wrongAgain = await h.call('/api/admin/overview', { headers: { 'x-admin-key': h.responderKey } });
  assert.equal(wrongAgain.status, 401);

  const right = await h.call('/api/admin/overview', { headers: { 'x-admin-key': h.adminKey } });
  assert.equal(right.status, 200);
  assert.ok(right.body.stats, 'the overview reports queue state');
});

test('an unknown endpoint answers with an Anthropic-shaped error rather than HTML', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  const missing = await h.call('/v1/nonsense', { key: h.callerKey });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.type, 'error');
  assert.equal(missing.body.error.type, 'not_found_error');
});
