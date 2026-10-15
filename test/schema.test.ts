import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_VERSION, Store } from '../src/db.ts';

/**
 * Opening a database that already has somebody's data in it.
 *
 * This service was deployed before it had a migration path, so the first column
 * it ever added had to arrive in a live file holding real keys. Both directions
 * are tested here: that an older database is brought forward with its rows
 * intact, and that a newer one is refused rather than read wrongly.
 *
 * The version marker is part of the fix, not decoration. A migration that adds
 * the column but leaves the marker at the old number has removed the only thing
 * that stops an older binary from opening the result — and it looks completely
 * successful from the outside, which is how it went unnoticed until a real copy
 * of the production database was opened.
 */

function withDatabase(run: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'humans-schema-'));
  const path = join(dir, 'humans.sqlite');
  try {
    run(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const opts = { claimLeaseMs: 1000, callTimeoutMs: 1000, poolSats: 0 };

test('a fresh database records the current schema version', () => {
  withDatabase((path) => {
    new Store(path, opts).close();
    const db = new DatabaseSync(path);
    const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string };
    assert.equal(Number(row.value), SCHEMA_VERSION);
    db.close();
  });
});

test('an older database gains the new column, keeps its rows, and moves its version marker', () => {
  withDatabase((path) => {
    // Build a database as the previous version would have left it: the column
    // absent and the marker at 1.
    const before = new Store(path, opts);
    const key = before.mintCredential('responder', 'someone-real');
    before.close();

    const raw = new DatabaseSync(path);
    raw.exec('ALTER TABLE credentials DROP COLUMN payout_address');
    raw.prepare("UPDATE meta SET value = '1' WHERE key = 'schema_version'").run();
    raw.close();

    // Now open it with this build, which is what a deploy does.
    const after = new Store(path, opts);
    const columns = (new DatabaseSync(path).prepare('PRAGMA table_info(credentials)').all() as Array<{ name: string }>)
      .map((column) => column.name);
    assert.ok(columns.includes('payout_address'), 'the column should have been added');

    const row = new DatabaseSync(path)
      .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as { value: string };
    assert.equal(
      Number(row.value),
      SCHEMA_VERSION,
      'the marker must move with the schema, or an older build stops being refused',
    );

    // The rows that were there before are still there, and still usable.
    assert.equal(after.responderByName('someone-real')?.id, key.id);
    after.close();
  });
});

test('a database from a newer build is refused rather than read wrongly', () => {
  withDatabase((path) => {
    new Store(path, opts).close();
    const raw = new DatabaseSync(path);
    raw.prepare('UPDATE meta SET value = ? WHERE key = ?').run(String(SCHEMA_VERSION + 1), 'schema_version');
    raw.close();

    assert.throws(
      () => new Store(path, opts),
      /newer version of this service/,
      'reading a future schema with this build is the one failure that corrupts data quietly',
    );
  });
});

test('opening the same database twice is a no-op, not a second migration', () => {
  withDatabase((path) => {
    for (let i = 0; i < 3; i += 1) {
      const store = new Store(path, opts);
      assert.equal(store.listCredentials().length >= 0, true);
      store.close();
    }
    const db = new DatabaseSync(path);
    const columns = (db.prepare('PRAGMA table_info(credentials)').all() as Array<{ name: string }>).filter(
      (column) => column.name === 'payout_address',
    );
    assert.equal(columns.length, 1, 'a column added twice would be an error on the second boot');
    db.close();
  });
});
