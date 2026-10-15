import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/db.ts';
import { createStatsReader, publicStats } from '../src/stats.ts';

/**
 * The per-day counts, and the cache in front of them.
 *
 * The interesting rule here is not which day a call lands in; it is what happens
 * to a call that straddles midnight. The only way to test that is to put a row on
 * either side of one, so these tests run against a store on a real file and move
 * the two timestamps by hand. An in-memory store cannot be reached by a second
 * connection, and a test that waits for midnight is a test nobody runs.
 */

const DAY = 86_400_000;
const MIDNIGHT = Math.floor(Date.now() / DAY) * DAY;

interface Fixture {
  store: Store;
  /** A second connection, used only to place rows at chosen instants. */
  place(id: string, created: number, answered: number | null): void;
  close(): void;
}

function fixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'humans-stats-'));
  const path = join(dir, 'humans.sqlite');
  const store = new Store(path, { claimLeaseMs: 180_000, callTimeoutMs: 600_000, poolSats: 0 });
  const raw = new DatabaseSync(path);

  return {
    store,
    place: (id, created, answered) => {
      if (answered !== null) {
        assert.ok(store.claim(id, 'test-responder'), 'the fixture must claim before it finishes');
        store.finishRequest(id, 'answered');
        raw.prepare('UPDATE requests SET created_at = ?, answered_at = ? WHERE id = ?').run(created, answered, id);
      } else {
        raw.prepare('UPDATE requests SET created_at = ? WHERE id = ?').run(created, id);
      }
    },
    close: () => {
      raw.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('an empty window is a continuous run of days, not an empty chart', () => {
  const f = fixture();
  try {
    const days = f.store.dailyCounts(14, MIDNIGHT + 60_000);
    assert.equal(days.length, 14, 'every day of the window must be present, including the quiet ones');
    assert.equal(days[days.length - 1]!.date, new Date(MIDNIGHT).toISOString().slice(0, 10));

    // The axis is unbroken: each date is exactly one day after the last. A
    // GROUP BY with no rows returns nothing, and a chart interpolated from
    // nothing looks identical to one drawn from a quiet fortnight.
    for (let i = 1; i < days.length; i += 1) {
      const previous = new Date(`${days[i - 1]!.date}T00:00:00Z`).getTime();
      const current = new Date(`${days[i]!.date}T00:00:00Z`).getTime();
      assert.equal(current - previous, DAY, `${days[i]!.date} does not follow ${days[i - 1]!.date}`);
    }
    assert.deepEqual(
      days.map((day) => day.calls),
      [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    );
  } finally {
    f.close();
  }
});

test('a call made before UTC midnight and answered after it lands in each day', () => {
  const f = fixture();
  try {
    const id = 'req-straddle';
    f.store.insertRequest({
      id,
      caller: 'test-caller',
      model: 'human-1',
      requestJson: '{}',
      summary: 'a question at midnight',
      toolsJson: '[]',
      stream: false,
      inputChars: 10,
    });
    // 23:59 yesterday to 00:01 today.
    f.place(id, MIDNIGHT - 60_000, MIDNIGHT + 60_000);

    const days = f.store.dailyCounts(2, MIDNIGHT + 3_600_000);
    assert.equal(days.length, 2);
    // The falsifier: an implementation that bucketed the answer on created_at
    // would report 1/1 and 0/0 here, and every other test in this file would
    // still pass.
    assert.equal(days[0]!.calls, 1, 'the call belongs to the day it was made');
    assert.equal(days[0]!.answered, 0, 'it was not answered on that day');
    assert.equal(days[1]!.calls, 0, 'the answer was not a new call');
    assert.equal(days[1]!.answered, 1, 'the answer belongs to the day it was given');
  } finally {
    f.close();
  }
});

test('a window counts what is inside it and nothing else', () => {
  const f = fixture();
  try {
    // One call on the oldest day of the window, one twenty days ago.
    const inside = 'req-inside';
    const outside = 'req-outside';
    for (const id of [inside, outside]) {
      f.store.insertRequest({
        id,
        caller: 'test-caller',
        model: 'human-1',
        requestJson: '{}',
        summary: 'a question',
        toolsJson: '[]',
        stream: false,
        inputChars: 10,
      });
    }
    f.place(inside, MIDNIGHT - 13 * DAY + 3_600_000, null);
    f.place(outside, MIDNIGHT - 20 * DAY, null);

    const days = f.store.dailyCounts(14, MIDNIGHT + 60_000);
    assert.equal(days.length, 14);
    assert.equal(days[0]!.calls, 1, 'the oldest day of the window is inside it');
    assert.equal(
      days.reduce((total, day) => total + day.calls, 0),
      1,
      'the call from twenty days ago must not be counted',
    );
  } finally {
    f.close();
  }
});

test('no window is an empty axis rather than an error', () => {
  const f = fixture();
  try {
    assert.deepEqual(f.store.dailyCounts(0), []);
    assert.deepEqual(f.store.dailyCounts(-3), []);
  } finally {
    f.close();
  }
});

test('the public snapshot counts calls, and never asks who made them', () => {
  const f = fixture();
  try {
    const id = 'req-one';
    f.store.insertRequest({
      id,
      caller: 'test-caller',
      model: 'human-1',
      requestJson: '{}',
      summary: 'a question',
      toolsJson: '[]',
      stream: false,
      inputChars: 10,
    });
    f.store.claim(id, 'test-responder');
    f.store.finishRequest(id, 'answered');

    const stats = publicStats(f.store, { days: 3, now: MIDNIGHT + 60_000 });
    assert.equal(stats.calls_total, 1);
    assert.equal(stats.answers_total, 1);
    assert.equal(stats.days.length, 3);
    assert.equal(stats.days[2]!.answered, 1);

    // The shape is the contract. A field added to this object is published to
    // anybody who asks, so it has to be a decision rather than an accident —
    // and the one thing it must never grow is something that identifies a
    // caller or a responder.
    assert.deepEqual(Object.keys(stats).sort(), [
      'answers_total',
      'calls_total',
      'days',
      'guarantee_sats',
      'median_answer_ms',
      'pool_sats',
      'responders',
    ]);
    assert.deepEqual(Object.keys(stats.days[0]!).sort(), ['answered', 'calls', 'date']);
  } finally {
    f.close();
  }
});

test('the reader holds a reading briefly, then lets it go', () => {
  const f = fixture();
  try {
    let clock = MIDNIGHT + 60_000;
    const reader = createStatsReader(f.store, { days: 2, maxAgeMs: 30_000, now: () => clock });

    assert.equal(reader.read().calls_total, 0);

    // Traffic arrives. The held reading must not notice it yet...
    f.store.insertRequest({
      id: 'req-later',
      caller: null,
      model: 'human-1',
      requestJson: '{}',
      summary: 'a question',
      toolsJson: '[]',
      stream: false,
      inputChars: 10,
    });
    assert.equal(reader.read().calls_total, 0, 'the reading was cached, so it cannot have seen this');

    // ...and must notice it once the cache expires, which is the half that
    // matters: a cache that never lets go is a service whose front page stops
    // being true.
    clock += 30_000;
    assert.equal(reader.read().calls_total, 1, 'the reading expired and must be recomputed');
  } finally {
    f.close();
  }
});
