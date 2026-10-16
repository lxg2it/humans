import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPoolReader, describeAge } from '../src/pool.ts';
import type { Fetcher } from '../src/btc.ts';

const ADDRESS = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';

/** An indexer that answers with whatever stats it was handed, and counts the asking. */
type CountingFetcher = Fetcher & { calls: number };

function indexer(stats: { funded: number; spent?: number; tx?: number }): CountingFetcher {
  const counted = { calls: 0 };
  const fetcher = (async () => {
    counted.calls += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        chain_stats: {
          funded_txo_sum: stats.funded,
          spent_txo_sum: stats.spent ?? 0,
          tx_count: stats.tx ?? 1,
        },
        mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0, tx_count: 0 },
      }),
    };
  }) as Fetcher;
  Object.defineProperty(fetcher, 'calls', { get: () => counted.calls });
  return fetcher as CountingFetcher;
}

const broken = (message: string): Fetcher => async () => {
  throw new Error(message);
};

test('with no address the pool is declared, and says so', () => {
  const pool = createPoolReader({ address: null, declaredSats: 1000 });
  const reading = pool.read();
  assert.equal(reading.declared, true);
  assert.equal(reading.sats, 1000);
  assert.equal(reading.address, null);
  // Nothing to read means nothing to be stale about.
  assert.equal(reading.readAt, null);
  assert.equal(reading.error, null);
});

test('with an address the figure comes off the chain', async () => {
  const fetch = indexer({ funded: 250_000, spent: 0, tx: 3 });
  const pool = createPoolReader({ address: ADDRESS, declaredSats: 999, fetcher: fetch });
  const reading = await pool.refresh();
  assert.equal(reading.declared, false);
  assert.equal(reading.sats, 250_000);
  assert.equal(reading.receivedSats, 250_000);
  assert.equal(reading.txCount, 3);
  assert.ok(reading.readAt !== null, 'a reading has a time, because the time is part of what it says');
  assert.equal(reading.error, null);
});

test('money that has been paid out is not still advertised as held', async () => {
  // The whole reason balance and received are separate fields. An operator who
  // funds the pool and then pays a responder out of it must not have the pages
  // go on claiming the money is there — a reader built on "funded" alone passes
  // every other test in this file and fails this one.
  const fetch = indexer({ funded: 500_000, spent: 250_000, tx: 2 });
  const pool = createPoolReader({ address: ADDRESS, fetcher: fetch });
  const reading = await pool.refresh();
  assert.equal(reading.receivedSats, 500_000, 'ever received');
  assert.equal(reading.spentSats, 250_000, 'paid out');
  assert.equal(reading.sats, 250_000, 'held now');
});

test('a funded address that has been emptied reads as zero, not as its history', async () => {
  const fetch = indexer({ funded: 400_000, spent: 400_000, tx: 2 });
  const pool = createPoolReader({ address: ADDRESS, fetcher: fetch });
  const reading = await pool.refresh();
  assert.equal(reading.sats, 0);
  assert.equal(reading.receivedSats, 400_000);
});

test('a chain that cannot be read is unknown, never zero and never the declared figure', async () => {
  const pool = createPoolReader({
    address: ADDRESS,
    declaredSats: 5000,
    fetcher: broken('sockets are hard'),
  });
  const reading = await pool.refresh();
  assert.equal(reading.sats, null, 'null is the point: "we do not know" must not render as "there is nothing"');
  assert.equal(reading.error, 'sockets are hard');
  assert.equal(reading.readAt, null);
});

test('an outage degrades to the last good reading with its age, not to a blank', async () => {
  let fail = false;
  const fetch: Fetcher = async (url, init) => {
    if (fail) throw new Error('indexer is down');
    return indexer({ funded: 300_000, spent: 0 })(url, init);
  };
  const pool = createPoolReader({ address: ADDRESS, fetcher: fetch, ttlMs: 0 });
  const first = await pool.refresh();
  assert.equal(first.sats, 300_000);

  fail = true;
  const second = await pool.refresh();
  assert.equal(second.sats, 300_000, 'the last thing we knew, still shown');
  assert.equal(second.error, 'indexer is down', 'and flagged as not current');
  assert.ok(second.readAt !== null, 'with the time it was actually true');
});

test('a stale reading is served from cache rather than re-fetched on every page view', async () => {
  const fetch = indexer({ funded: 1 });
  let clock = 1_000_000;
  const pool = createPoolReader({ address: ADDRESS, fetcher: fetch, ttlMs: 60_000, now: () => clock });
  await pool.refresh();
  assert.equal(fetch.calls, 1);

  pool.read();
  pool.read();
  assert.equal(fetch.calls, 1, 'a landing page refresh must not be a request to somebody else\u2019s free API');

  clock += 61_000;
  pool.read(); // kicks off a background read
  await pool.refresh();
  assert.equal(fetch.calls, 2, 'and once it is stale, it does refresh');
});

test('concurrent readers share one request', async () => {
  const fetch = indexer({ funded: 7 });
  const pool = createPoolReader({ address: ADDRESS, fetcher: fetch });
  await Promise.all([pool.refresh(), pool.refresh(), pool.refresh()]);
  assert.equal(fetch.calls, 1, 'three tabs open at once is one read, not three');
});

test('an age is said in words, because a stale number that looks current is a lie', () => {
  const now = 1_800_000_000_000;
  assert.equal(describeAge(now - 5_000, now), 'just now');
  assert.equal(describeAge(now + 5_000, now), 'just now');
  // 90 seconds is the first reading the minutes branch sees, and it rounds up.
  assert.equal(describeAge(now - 90_000, now), '2 minutes ago');
  assert.equal(describeAge(now - 5 * 60_000, now), '5 minutes ago');
  // The singular, which this copy got wrong: an hour-old reading read as
  // "1 hours ago", and that string is printed on a public page.
  assert.equal(describeAge(now - 3_600_000, now), '1 hour ago');
  assert.equal(describeAge(now - 3 * 3_600_000, now), '3 hours ago');
  assert.equal(describeAge(now - 50 * 3_600_000, now), '2 days ago');
});

test('the plural is only ever wrong where the formatter can be asked', () => {
  const now = 1_800_000_000_000;
  const said = new Set<string>();
  // A sweep rather than points, because the question is which outputs are
  // reachable at all — four assertions cannot answer that, and two of the four
  // I first reached for were wrong.
  for (let seconds = 0; seconds <= 3 * 24 * 3_600; seconds += 7) {
    said.add(describeAge(now - seconds * 1_000, now));
  }

  // Every unit is exercised, so a sweep that hit one branch cannot pass as
  // coverage of the formatter.
  for (const pattern of [/^just now$/, /^\d+ minutes ago$/, /^\d+ hours ago$/, /^\d+ days ago$/]) {
    assert.ok([...said].some((text) => pattern.test(text)), `${pattern} was never said`);
  }

  assert.ok(said.has('1 hour ago'), 'an hour-old reading is reachable and must be singular');
  // Unreachable by construction, not by luck: the just-now window is 90 seconds,
  // so the minutes branch starts at 2, and days start at 2 because the hours
  // branch runs to 36. Nothing can round to a bare 1 in either place, which is
  // why neither branch carries a singular — and if the thresholds move, this is
  // the test that says the singular became necessary.
  assert.ok(!said.has('1 minutes ago'), 'a one-minute reading is impossible');
  assert.ok(!said.has('1 day ago'), 'a one-day reading is impossible');
});
