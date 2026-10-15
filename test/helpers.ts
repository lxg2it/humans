import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { config } from '../src/config.ts';
import { Store } from '../src/db.ts';
import { Queue } from '../src/queue.ts';
import type { MessageRequest } from '../src/anthropic.ts';

/**
 * A running instance, in memory, on an ephemeral port.
 *
 * Everything the tests do goes through HTTP, including the streaming path: the
 * pieces that fail in production are the ones between the handler and the
 * socket, and a test that calls handlers directly cannot see them.
 */

export interface CallResult {
  status: number;
  body: any;
  headers: Headers;
}

export interface Harness {
  base: string;
  store: Store;
  queue: Queue;
  callerKey: string;
  callerName: string;
  responderKey: string;
  responderName: string;
  adminKey: string;
  call(
    path: string,
    init?: { method?: string; body?: unknown; key?: string; keyHeader?: 'x-human-key' | 'x-api-key'; headers?: Record<string, string> },
  ): Promise<CallResult>;
  /** Sends a message request and does not wait for it to be answered. */
  send(body: unknown, key?: string): Promise<CallResult>;
  /** Waits for a request to appear in a responder's queue and returns its id. */
  awaitQueued(key?: string, predicate?: (row: any) => boolean): Promise<any>;
  /** Answers a queued request end to end, as a responder would. */
  answer(id: string, submit: Record<string, unknown>): Promise<CallResult>;
  close(): Promise<void>;
}

/** Retries until the callback returns something truthy, or the deadline passes. */
export async function until<T>(fn: () => Promise<T | null | undefined>, ms = 4000, every = 20): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${ms}ms waiting for a condition`);
    await new Promise((resolve) => setTimeout(resolve, every));
  }
}

export async function harness(
  overrides: { callTimeoutMs?: number; sweepIntervalMs?: number; claimLeaseMs?: number; pingIntervalMs?: number } = {},
): Promise<Harness> {
  const store = new Store(':memory:', {
    // A short lease lets a test watch the sweep reclaim an abandoned claim
    // without waiting three minutes or reaching into the database.
    claimLeaseMs: overrides.claimLeaseMs ?? config.claimLeaseMs,
    callTimeoutMs: overrides.callTimeoutMs ?? config.callTimeoutMs,
    poolSats: config.poolSats,
  });
  const queue = new Queue(store, {
    // Sweeping fast keeps a short-timeout test from being a test of the sweep
    // interval instead of the timeout.
    callTimeoutMs: overrides.callTimeoutMs,
    sweepIntervalMs: overrides.sweepIntervalMs ?? 20,
    pingIntervalMs: overrides.pingIntervalMs ?? 50,
  });
  const app = createApp(store, queue);

  const server: Server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  queue.start();
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  const callerName = 'test-caller';
  const responderName = 'test-responder';
  const callerKey = store.mintCredential('caller', callerName).key;
  const responderKey = store.mintCredential('responder', responderName).key;

  const call: Harness['call'] = async (path, init = {}) => {
    const headers: Record<string, string> = { ...(init.headers || {}) };
    // Two different keys, two different headers. Sending a caller key as
    // x-human-key would 401 and look exactly like a request that never queued.
    if (init.key !== undefined) headers[init.keyHeader ?? 'x-human-key'] = init.key;
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(`${base}${path}`, {
      method: init.method ?? 'GET',
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const text = await response.text();
    let body: any = null;
    try {
      body = text === '' ? null : JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: response.status, body, headers: response.headers };
  };

  const harnessObject: Harness = {
    base,
    store,
    queue,
    callerKey,
    callerName,
    responderKey,
    responderName,
    adminKey: config.adminKey,
    call,
    send: (body, key) => call('/v1/messages', { method: 'POST', body, key: key ?? callerKey, keyHeader: 'x-api-key' }),
    awaitQueued: (key, predicate) =>
      until(async () => {
        const result = await call('/api/queue', { key: key ?? responderKey });
        // A refused queue read is not an empty queue. Letting it read as "still
        // waiting" is how a 401 becomes a four-second timeout.
        if (result.status !== 200) throw new Error(`queue read refused: ${result.status} ${JSON.stringify(result.body)}`);
        const rows = result.body.requests as any[];
        const match = predicate ? rows.find(predicate) : rows[0];
        return match ?? null;
      }),
    answer: async (id, submit) => {
      const claimed = await call(`/api/requests/${id}/claim`, { method: 'POST', body: {}, key: responderKey });
      if (claimed.status !== 200) throw new Error(`claim failed: ${JSON.stringify(claimed.body)}`);
      return call(`/api/requests/${id}/submit`, { method: 'POST', body: submit, key: responderKey });
    },
    close: async () => {
      queue.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
    },
  };
  return harnessObject;
}

export function messageRequest(overrides: Partial<MessageRequest> = {}): Record<string, unknown> {
  return {
    model: 'human-1',
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'What is the capital of Australia?' }],
    ...overrides,
  } as Record<string, unknown>;
}

export interface LiveStream {
  /** Events received so far. */
  events(): Array<{ event: string; data: any }>;
  /** The text deltas received so far, concatenated as a client would. */
  text(): string;
  finished(): boolean;
  /** Resolves once the condition holds; throws if the stream ends or time runs out first. */
  waitFor(predicate: (stream: LiveStream) => boolean, ms?: number): Promise<void>;
  close(): Promise<void>;
}

/**
 * A stream read as it arrives rather than after it ends.
 *
 * Half of what streaming means is *when* bytes arrive, and reading the whole
 * body cannot see that: a server that buffers the reply and sends it in one
 * write produces exactly the same text. This drains continuously and lets a test
 * assert against the state at a moment in time.
 */
export function liveStream(response: Response): LiveStream {
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  const events: Array<{ event: string; data: any }> = [];
  let buffer = '';
  let ended = false;
  let failure: unknown = null;

  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index = buffer.indexOf('\n\n');
        while (index !== -1) {
          const chunk = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const lines = chunk.split('\n');
          const dataLine = lines.find((line) => line.startsWith('data: '));
          const eventLine = lines.find((line) => line.startsWith('event: '));
          if (dataLine) {
            events.push({
              event: eventLine ? eventLine.slice(7).trim() : 'message',
              data: JSON.parse(dataLine.slice(6)),
            });
          }
          index = buffer.indexOf('\n\n');
        }
      }
    } catch (error) {
      failure = error;
    } finally {
      ended = true;
    }
  })();

  const stream: LiveStream = {
    events: () => events,
    text: () =>
      events
        .filter((event) => event.event === 'content_block_delta' && event.data.delta?.type === 'text_delta')
        .map((event) => event.data.delta.text as string)
        .join(''),
    finished: () => ended,
    waitFor: async (predicate, ms = 4000) => {
      const deadline = Date.now() + ms;
      for (;;) {
        if (failure) throw failure;
        if (predicate(stream)) return;
        if (ended) throw new Error(`the stream ended before the condition held; text was ${JSON.stringify(stream.text())}`);
        if (Date.now() > deadline) throw new Error(`timed out after ${ms}ms; text was ${JSON.stringify(stream.text())}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    },
    close: async () => {
      await reader.cancel().catch(() => undefined);
    },
  };
  return stream;
}

/** Reads a whole SSE stream and returns its parsed events. */
export async function readSse(response: Response): Promise<Array<{ event: string; data: any }>> {
  const text = await response.text();
  const events: Array<{ event: string; data: any }> = [];
  for (const chunk of text.split('\n\n')) {
    const lines = chunk.split('\n');
    const eventLine = lines.find((line) => line.startsWith('event: '));
    const dataLine = lines.find((line) => line.startsWith('data: '));
    if (!dataLine) continue;
    events.push({
      event: eventLine ? eventLine.slice(7).trim() : 'message',
      data: JSON.parse(dataLine.slice(6)),
    });
  }
  return events;
}
