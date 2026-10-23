/**
 * The fund's states, each on its own port, on the real server.
 *
 * This is a manual harness, not part of `npm test`: it binds ports and runs
 * until Ctrl-C. The unit tests assert the sentences; this exists so a person can
 * look at them in a browser, next to the number they are about, in every state
 * the product can be in. Use it when changing copy that depends on money.
 *
 *   npm run states          # five instances, ports 3100-3104
 *
 * Four of the five cannot be produced with real money — a real address holds
 * what it holds, and "120 sats against 500 owed" is not a state anyone can buy —
 * so those hand the app a reader carrying the figure under test. Everything else
 * is the shipped path: the real store, the real routers, the real templates, and
 * real answered calls, because owed is earned minus paid and a number written
 * into a template would prove nothing about the arithmetic.
 *
 * The fifth is the exception and deliberately so. "The chain could not be
 * reached" is a failure the product will meet on its own, so it is produced the
 * way it will happen: the real createPoolReader, a real address, and an endpoint
 * that refuses. Stubbing it would have exercised our own description of the
 * failure rather than the failure.
 */
import net from 'node:net';
import { createApp } from '../src/app.ts';
import { Store } from '../src/db.ts';
import { Queue } from '../src/queue.ts';
import { createPoolReader } from '../src/pool.ts';
import type { PoolReader } from '../src/pool.ts';

const FIRST_PORT = 3100;

async function until<T>(fn: () => Promise<T | null>, ms = 5000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting for a queued call');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** One answered call, so that a state has an owed figure to be a state about. */
async function answerOneCall(base: string, caller: string, responder: string, n: number): Promise<void> {
  // The caller's POST stays open until the reply exists, so it must not be
  // awaited here: the reply is what this function is about to create.
  const sending = fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': caller },
    body: JSON.stringify({
      model: 'human-1',
      max_tokens: 100,
      messages: [{ role: 'user', content: `question ${n}` }],
    }),
  });

  const id = await until(async () => {
    const queued = await fetch(`${base}/api/queue`, { headers: { 'x-human-key': responder } });
    const { requests } = (await queued.json()) as { requests: Array<{ id: string }> };
    return requests[0]?.id ?? null;
  });

  const claimed = await fetch(`${base}/api/requests/${id}/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-human-key': responder },
    body: JSON.stringify({ declare: true }),
  });
  if (claimed.status !== 200) throw new Error(`claim failed ${claimed.status}: ${await claimed.text()}`);

  const submitted = await fetch(`${base}/api/requests/${id}/submit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-human-key': responder },
    body: JSON.stringify({ text: `answer ${n}`, stop_reason: 'end_turn' }),
  });
  if (submitted.status !== 200) throw new Error(`submit failed ${submitted.status}: ${await submitted.text()}`);

  const answered = await sending;
  if (answered.status !== 200) throw new Error(`send failed ${answered.status}: ${await answered.text()}`);
}

/** Every port, checked BEFORE anything is bound: a half-started run looks like
 * a working one and prints two of five lines before it dies. */
async function assertPortsFree(ports: number[]): Promise<void> {
  for (const port of ports) {
    const free = await new Promise<boolean>((resolve) => {
      const probe = net.createServer();
      probe.once('error', () => resolve(false));
      probe.once('listening', () => probe.close(() => resolve(true)));
      probe.listen(port, '127.0.0.1');
    });
    if (!free) {
      console.error(
        `port ${port} is already in use — probably an earlier run of this harness.\n` +
          `Find it with: lsof -nP -iTCP:${ports[0]}-${ports[ports.length - 1]} -sTCP:LISTEN`,
      );
      process.exit(1);
    }
  }
}

const states: Array<{ name: string; sats: number; owedFrom: number }> = [
  { name: 'empty', sats: 0, owedFrom: 0 }, // the fund holds nothing
  { name: 'dust', sats: 1, owedFrom: 0 }, // holds something, covers no reply
  { name: 'partial', sats: 120, owedFrom: 2 }, // owes 500, holds 120
  { name: 'covered', sats: 250_000, owedFrom: 2 }, // owes 500, holds plenty
];

await assertPortsFree(states.map((_, index) => FIRST_PORT + index).concat(FIRST_PORT + states.length));

for (const [index, state] of states.entries()) {
  const store = new Store(':memory:', { claimLeaseMs: 180_000, callTimeoutMs: 600_000, poolSats: 0 });
  const queue = new Queue(store);
  const reader: PoolReader = {
    read: () => ({
      declared: false,
      address: 'bc1qdemoaddress',
      sats: state.sats,
      receivedSats: state.sats,
      spentSats: 0,
      txCount: 2,
      readAt: Date.now(),
      error: null,
    }),
    refresh: async () => reader.read(),
  };

  const port = FIRST_PORT + index;
  createApp(store, queue, reader).listen(port, '127.0.0.1');
  queue.start();

  const caller = store.mintCredential('caller', `demo-caller-${state.name}`).key;
  const responder = store.mintCredential('responder', `demo-${state.name}`).key;
  const base = `http://127.0.0.1:${port}`;

  for (let n = 0; n < state.owedFrom; n += 1) await answerOneCall(base, caller, responder, n);

  const owed = store.responderSummary().reduce((total, row) => total + row.owedSats, 0);
  console.log(
    `${state.name.padEnd(9)} port ${port}  held ${String(state.sats).padStart(7)}  owed ${String(owed).padStart(4)}  ` +
      `console http://127.0.0.1:${port}/console  key ${responder}  fund http://127.0.0.1:${port}/pool`,
  );
}

// The fifth state, through the shipped reader against a chain endpoint that
// refuses (port 9, discard, answers nothing here).
{
  const port = FIRST_PORT + states.length;
  const store = new Store(':memory:', { claimLeaseMs: 180_000, callTimeoutMs: 600_000, poolSats: 0 });
  const queue = new Queue(store);
  const reader = createPoolReader({ address: 'bc1qdemoaddress', apiBase: 'http://127.0.0.1:9/api' });

  createApp(store, queue, reader).listen(port, '127.0.0.1');
  queue.start();

  const caller = store.mintCredential('caller', 'demo-caller-unreadable').key;
  const responder = store.mintCredential('responder', 'demo-unreadable').key;
  const base = `http://127.0.0.1:${port}`;

  await answerOneCall(base, caller, responder, 0);

  // refresh() rather than read(): read() answers from the cache and starts the
  // fetch, so the line below would print the error field of a snapshot taken
  // before the fetch had failed — reporting "no error" about the error state.
  const reading = await reader.refresh();
  console.log(
    `${'unreadable'.padEnd(9)} port ${port}  held ${String(reading.sats).padStart(7)}  ` +
      `error ${JSON.stringify(reading.error)}  console http://127.0.0.1:${port}/console  key ${responder}`,
  );
}

console.log('\nserving. Ctrl-C to stop.');
setInterval(() => {}, 1 << 30);
