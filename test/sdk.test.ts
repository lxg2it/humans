import { test } from 'node:test';
import assert from 'node:assert/strict';
import Anthropic from '@anthropic-ai/sdk';
import { harness } from './helpers.ts';

/**
 * The compatibility claim, checked with the vendor's own client.
 *
 * Every other streaming test here parses the event stream with our parser. That
 * is not an independent instrument: if we emit the wrong delta field name or
 * miss an event the client needs, our reader agrees with our writer and the
 * tests pass. The SDK is the only thing in this repository that was written by
 * somebody else against the same specification, so it is the one that can
 * disagree with us.
 */

function client(h: { base: string; callerKey: string }): Anthropic {
  return new Anthropic({ apiKey: h.callerKey, baseURL: h.base, maxRetries: 0 });
}

/** The SDK's own types are the union a caller sees; this narrows one block. */
function textOf(message: Anthropic.Message): string {
  const block = message.content[0];
  assert.ok(block, 'the message has no content');
  assert.equal(block.type, 'text');
  assert.ok(block.type === 'text');
  return block.text;
}

test('the official SDK streams a text answer, and reads it', async (t) => {
  const h = await harness({ callTimeoutMs: 60_000 });
  t.after(() => h.close());

  const stream = client(h).messages.stream({
    model: 'human-1',
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'What is the capital of Australia?' }],
  });

  const row = await h.awaitQueued();
  await h.answer(row.id, { text: 'Canberra.' });

  const message = await stream.finalMessage();
  assert.equal(message.role, 'assistant');
  assert.equal(message.content.length, 1);
  assert.equal(textOf(message), 'Canberra.');
  assert.equal(message.stop_reason, 'end_turn');
});

test('deltas typed before the answer are not sent twice to a real client', async (t) => {
  // The responder types into a request whose reply is then submitted in full.
  // A client concatenates deltas, so re-sending everything at submit turns
  // "Canberra." into "CanbCanberra." — and only a client that concatenates the
  // way the real one does can catch that.
  const h = await harness({ callTimeoutMs: 60_000 });
  t.after(() => h.close());

  const stream = client(h).messages.stream({
    model: 'human-1',
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'What is the capital of Australia?' }],
  });

  const row = await h.awaitQueued();
  await h.call(`/api/requests/${row.id}/claim`, { method: 'POST', body: {}, key: h.responderKey });
  const typed = await h.call(`/api/requests/${row.id}/partial`, {
    method: 'POST',
    key: h.responderKey,
    body: { text: 'Canb' },
  });
  assert.equal(typed.body.delivered, true, 'the caller is streaming, so typing reaches them');

  const deltas: string[] = [];
  stream.on('text', (delta) => deltas.push(delta));

  await h.call(`/api/requests/${row.id}/submit`, {
    method: 'POST',
    key: h.responderKey,
    body: { text: 'Canberra.' },
  });

  const message = await stream.finalMessage();
  assert.equal(textOf(message), 'Canberra.');
  assert.deepEqual(deltas, ['Canb', 'erra.'], 'only the part the caller has not been sent');
});

test('a tool call arrives as a parsed tool_use block, not as text', async (t) => {
  const h = await harness({ callTimeoutMs: 60_000 });
  t.after(() => h.close());

  const stream = client(h).messages.stream({
    model: 'human-1',
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'What is the weather in Melbourne?' }],
    tools: [
      {
        name: 'get_weather',
        description: 'Read the current weather for a city.',
        input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
      },
    ],
  });

  const row = await h.awaitQueued();
  await h.answer(row.id, { text: '', tools: [{ name: 'get_weather', input: { city: 'Melbourne' } }] });

  const message = await stream.finalMessage();
  assert.equal(message.stop_reason, 'tool_use');
  const block = message.content.find((entry) => entry.type === 'tool_use');
  assert.ok(block, 'the tool call has to survive the stream as a tool_use block');
  assert.equal(block.type === 'tool_use' && block.name, 'get_weather');
  assert.deepEqual(block.type === 'tool_use' && block.input, { city: 'Melbourne' });
});

test('the SDK reads a non-streaming answer through the same client', async (t) => {
  const h = await harness({ callTimeoutMs: 60_000 });
  t.after(() => h.close());

  const pending = client(h).messages.create({
    model: 'human-1',
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'What is the capital of Australia?' }],
  });

  const row = await h.awaitQueued();
  await h.answer(row.id, { text: 'Canberra.' });

  const message = await pending;
  assert.equal(textOf(message), 'Canberra.');
  assert.equal(message.stop_reason, 'end_turn');
  assert.ok(message.usage.input_tokens > 0 && message.usage.output_tokens > 0, 'usage is reported');
});

test('a request the SDK sends with the wrong model is refused anthropically', async (t) => {
  // The control: the client agreeing with us on the happy path proves nothing
  // unless it also sees a refusal in the shape it expects.
  const h = await harness({ callTimeoutMs: 60_000 });
  t.after(() => h.close());

  const request = client(h).messages.create({
    model: 'no-such-model',
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'hello' }],
  });

  await assert.rejects(request, (error: unknown) => {
    const failure = error as { status?: number; error?: { error?: { type?: string } } };
    assert.equal(failure.status, 400);
    assert.equal(failure.error?.error?.type, 'invalid_request_error');
    return true;
  });
});

test('an unanswerable request reaches the SDK as a timeout, not as silence', async (t) => {
  const h = await harness({ callTimeoutMs: 60 });
  t.after(() => h.close());

  await assert.rejects(
    client(h).messages.create({
      model: 'human-1',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'anybody there?' }],
    }),
    (error: unknown) => {
      const failure = error as { status?: number; error?: { error?: { type?: string } } };
      assert.equal(failure.status, 504);
      assert.equal(failure.error?.error?.type, 'timeout_error');
      return true;
    },
  );
});
