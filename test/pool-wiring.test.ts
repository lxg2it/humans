import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { config } from '../src/config.ts';
import { Store } from '../src/db.ts';
import { Queue } from '../src/queue.ts';
import type { PoolReader, PoolReading } from '../src/pool.ts';

/**
 * One pot of money, one reading of it.
 *
 * The console, the fund page, the health endpoint and the responder ledger all
 * describe the same balance. Each router used to build its own reader, which
 * meant two things: they could state different figures at the same moment, and
 * every unknown surface paid its own cold start — a healthy box answered "the
 * balance could not be read" to the first visitor after each restart, which is a
 * routine warm-up wearing the sentence reserved for an outage.
 *
 * The difference is only visible from outside by giving the app a reader it did
 * not build, carrying a figure nothing else would produce. If a surface reports
 * that figure it went through this reader; if the wiring regresses to one reader
 * per router, this one is never consulted and the assertions fail on the
 * declared setting instead. That is what makes this a measurement rather than a
 * restatement of the code.
 */

const HELD = 987_654; // deliberately unlike config.poolSats, which is 0 here

function reading(sats: number): PoolReading {
  return {
    declared: false,
    address: 'bc1qexampleaddressnotreal',
    sats,
    receivedSats: sats,
    spentSats: 0,
    txCount: 4,
    readAt: Date.now(),
    error: null,
  };
}

interface Served {
  base: string;
  store: Store;
  reads: () => number;
}

async function withApp(
  make: (count: () => number) => PoolReader,
  fn: (served: Served) => Promise<void>,
): Promise<void> {
  const store = new Store(':memory:', {
    claimLeaseMs: config.claimLeaseMs,
    callTimeoutMs: config.callTimeoutMs,
    poolSats: config.poolSats,
  });
  const queue = new Queue(store);
  let reads = 0;
  const count = () => {
    reads += 1;
    return reads;
  };
  const app = createApp(store, queue, make(count));
  const server: Server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  try {
    const { port } = server.address() as AddressInfo;
    await fn({ base: `http://127.0.0.1:${port}`, store, reads: () => reads });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** A reader that always answers the same way, and counts how often it is asked. */
function fixed(sats: number) {
  return (count: () => number): PoolReader => ({
    read() {
      count();
      return reading(sats);
    },
    async refresh() {
      count();
      return reading(sats);
    },
  });
}

test('every surface that reports the fund reports the same reading', async () => {
  await withApp(fixed(HELD), async ({ base, store, reads }) => {
    // The control, before anything is judged: this figure is not the declared
    // one, so a surface reporting it has demonstrably gone through the reader the
    // app was given rather than building its own.
    assert.notEqual(HELD, config.poolSats, 'the fixture figure equals the declared one and proves nothing');

    const health = (await (await fetch(`${base}/healthz`)).json()) as Record<string, unknown>;
    assert.equal(health.pool_sats, HELD, '/healthz reports the declared setting rather than the reading');
    assert.equal(health.pool_declared, false, '/healthz says the figure was declared');

    const poolPage = await (await fetch(`${base}/pool`)).text();
    assert.match(poolPage, /987,654/, 'the fund page does not show the reading');

    const key = store.mintCredential('responder', 'wiring-responder').key;
    const me = (await (await fetch(`${base}/api/me`, { headers: { 'x-human-key': key } })).json()) as Record<
      string,
      unknown
    >;
    assert.equal(me.pool_sats, HELD, '/api/me does not show the reading');
    assert.equal(me.pool_declared, false, '/api/me says the figure was declared');

    const ledger = (await (await fetch(`${base}/api/ledger`, { headers: { 'x-human-key': key } })).json()) as Record<
      string,
      unknown
    >;
    assert.equal(
      ledger.pool_sats,
      HELD,
      '/api/ledger reports a different figure from /api/me at the same moment',
    );

    // And one reader served them all, rather than four that happen to agree.
    assert.ok(reads() >= 4, `the injected reader was consulted ${reads()} time(s) across four surfaces`);
  });
});

test('a fund too small to pay one reply is named as such on the fund page', async () => {
  // The state that reads as fine if nobody says otherwise: nothing is owed and
  // there is money in the pot, so "nothing to cover" is literally true and
  // materially misleading — the next reply taken cannot be paid.
  await withApp(fixed(1), async ({ base }) => {
    const page = await (await fetch(`${base}/pool`)).text();

    assert.match(page, /not one reply&#39;s worth|not one reply's worth/, 'a one-satoshi fund is not named as unable to pay a reply');
    assert.match(page, new RegExp(`1 satoshi held`), 'the singular is printed as plural, which reads as boilerplate');
    assert.match(
      page,
      new RegExp(`${config.guaranteeSats} satoshis a single reply is promised`),
      'the guarantee figure is missing, so the comparison cannot be checked',
    );
    assert.doesNotMatch(
      page,
      /nothing to cover\. Held: 1 satoshi/,
      'the dust state is rendered as "nothing is owed, so there is nothing to cover"',
    );
  });
});

test('a fund of exactly one reply, with nothing owed, is not called dust', async () => {
  // The control for the test above: the dust branch must not swallow every small
  // number, or a genuinely funded pot would be reported as unfunded.
  await withApp(fixed(config.guaranteeSats), async ({ base }) => {
    const page = await (await fetch(`${base}/pool`)).text();
    assert.doesNotMatch(page, /not one reply&#39;s worth|not one reply's worth/, 'a funded pot is reported as dust');
    assert.match(page, /nothing is owed at the moment/, 'a funded pot with no obligations does not say so');
  });
});
