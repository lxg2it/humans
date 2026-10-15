import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { generateKey } from './config.ts';

/**
 * All state lives in one SQLite file. There is no second service, because the
 * queue is the entire system: a request arrives, waits, and is answered.
 *
 * The table that matters is `requests`. It is both the queue and the audit
 * trail, and every question the console asks ("what is waiting", "who has it",
 * "how long has that been true") is a query against it rather than a fact held
 * in a process that might restart.
 */

export type RequestStatus = 'queued' | 'claimed' | 'answered' | 'failed' | 'expired';

export const SCHEMA_VERSION = 1;

export interface RequestRow {
  id: string;
  caller: string | null;
  status: RequestStatus;
  model: string;
  request_json: string;
  summary: string;
  tools_json: string;
  stream: number;
  input_chars: number;
  created_at: number;
  claimed_at: number | null;
  claimed_by: string | null;
  answered_at: number | null;
  last_seen_at: number | null;
  stop_reason: string | null;
  note: string | null;
}

export interface ReplyRow {
  id: string;
  request_id: string;
  responder: string;
  thinking: string;
  text: string;
  tools_json: string;
  stop_reason: string;
  stop_sequence: string | null;
  submitted_at: number;
  prompt_chars: number;
  reply_chars: number;
  tool_calls: number;
}

/** What a waiting request looks like in the queue list, without its body. */
export type RequestSummary = Omit<
  Pick<
    RequestRow,
    | 'id'
    | 'caller'
    | 'summary'
    | 'model'
    | 'stream'
    | 'input_chars'
    | 'created_at'
    | 'status'
    | 'claimed_by'
    | 'claimed_at'
    | 'last_seen_at'
  >,
  'stream'
> & {
  /**
   * A boolean on the way out, because SQLite has no boolean type and `stream:
   * 1` would put that fact into a JSON API every console has to know about.
   */
  stream: boolean;
};

/** The same shape as it comes back from SQLite, before it is converted. */
type RawSummary = Omit<RequestSummary, 'stream'> & { stream: number };

function toSummary(row: RawSummary): RequestSummary {
  return { ...row, stream: row.stream === 1 };
}


export interface CredentialRow {
  id: string;
  kind: string;
  name: string;
  created_at: number;
  last_used_at: number | null;
  active: number;
}

export interface LedgerRow {
  id: string;
  request_id: string | null;
  reply_id: string | null;
  responder: string;
  /** 'guarantee' is money earned; 'settlement' is money paid. */
  kind: string;
  sats: number;
  created_at: number;
  note: string | null;
  address: string | null;
  txid: string | null;
}

/** One UTC calendar day of traffic, as a chart wants it. */
export interface DayCount {
  /** `YYYY-MM-DD`, UTC. */
  date: string;
  calls: number;
  answered: number;
}

export interface Stats {
  /** Every request ever, whatever became of it. */
  total: number;
  waiting: number;
  claimed: number;
  answered: number;
  expired: number;
  answeredLast24h: number;
  medianResponseMs: number | null;
  responders: number;
  earnedSats: number;
  paidSats: number;
  owedSats: number;
  poolSats: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS requests (
  id            TEXT PRIMARY KEY,
  caller        TEXT,
  status        TEXT NOT NULL,
  model         TEXT NOT NULL,
  request_json  TEXT NOT NULL,
  summary       TEXT NOT NULL,
  tools_json    TEXT NOT NULL,
  stream        INTEGER NOT NULL,
  input_chars   INTEGER NOT NULL,
  created_at    INTEGER NOT NULL,
  claimed_at    INTEGER,
  claimed_by    TEXT,
  answered_at   INTEGER,
  last_seen_at  INTEGER,
  stop_reason   TEXT,
  note          TEXT
);
CREATE INDEX IF NOT EXISTS requests_status_created ON requests (status, created_at);

CREATE TABLE IF NOT EXISTS replies (
  id            TEXT PRIMARY KEY,
  request_id    TEXT NOT NULL REFERENCES requests (id),
  responder     TEXT NOT NULL,
  thinking      TEXT NOT NULL DEFAULT '',
  text          TEXT NOT NULL DEFAULT '',
  tools_json    TEXT NOT NULL DEFAULT '[]',
  stop_reason   TEXT NOT NULL,
  stop_sequence TEXT,
  submitted_at  INTEGER NOT NULL,
  prompt_chars  INTEGER NOT NULL,
  reply_chars   INTEGER NOT NULL,
  tool_calls    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS replies_responder ON replies (responder, submitted_at);

CREATE TABLE IF NOT EXISTS ratings (
  request_id  TEXT PRIMARY KEY REFERENCES requests (id),
  responder   TEXT NOT NULL,
  rating      INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS credentials (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,
  name          TEXT NOT NULL,
  key_hash      TEXT NOT NULL UNIQUE,
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER,
  active        INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS credentials_kind ON credentials (kind, active);

CREATE TABLE IF NOT EXISTS ledger (
  id          TEXT PRIMARY KEY,
  request_id  TEXT,
  reply_id    TEXT,
  responder   TEXT NOT NULL,
  kind        TEXT NOT NULL,
  sats        INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  note        TEXT,
  address     TEXT,
  txid        TEXT
);
CREATE INDEX IF NOT EXISTS ledger_responder ON ledger (responder, created_at);
`;

export function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export class Store {
  private readonly db: DatabaseSync;
  private readonly opts: { claimLeaseMs: number; callTimeoutMs: number; poolSats: number };

  constructor(path: string, opts: { claimLeaseMs: number; callTimeoutMs: number; poolSats: number }) {
    this.opts = opts;
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    // The admin CLI is a second writer. Without a busy timeout, whichever
    // process arrives mid-write fails outright instead of waiting its turn.
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec(SCHEMA);
    this.checkSchemaVersion();
  }

  close(): void {
    this.db.close();
  }

  // ---- requests -----------------------------------------------------------

  /**
   * A version marker, so a database written by a later build is refused rather
   * than read with columns this build does not know it is missing.
   */
  private checkSchemaVersion(): void {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
      | { value: string }
      | undefined;
    if (!row) {
      this.db
        .prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?)")
        .run(String(SCHEMA_VERSION));
      return;
    }
    const found = Number(row.value);
    if (found > SCHEMA_VERSION) {
      throw new Error(
        `the database at this path was written by a newer version of this service (schema ${found}, this build understands ${SCHEMA_VERSION}). ` +
          'Refusing to start rather than read it wrongly.',
      );
    }
  }

  insertRequest(input: {
    id: string;
    caller: string | null;
    model: string;
    requestJson: string;
    summary: string;
    toolsJson: string;
    stream: boolean;
    inputChars: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO requests (id, caller, status, model, request_json, summary, tools_json, stream, input_chars, created_at, last_seen_at)
         VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        input.id,
        input.caller,
        input.model,
        input.requestJson,
        input.summary,
        input.toolsJson,
        input.stream ? 1 : 0,
        input.inputChars,
        Date.now(),
      );
  }

  /** The queue listing: summaries only, so the console does not ship whole prompts to every seat. */
  listQueued(limit: number): RequestSummary[] {
    const rows = this.db
      .prepare(
        `SELECT id, caller, summary, model, stream, input_chars, created_at, status, claimed_by, claimed_at, last_seen_at
           FROM requests
          WHERE status IN ('queued', 'claimed')
          ORDER BY created_at ASC
          LIMIT ?`,
      )
      .all(limit) as unknown as RawSummary[];
    return rows.map(toSummary);
  }

  /** Everything recent, whatever its state, for the operator view. */
  recentRequests(limit: number): RequestSummary[] {
    const rows = this.db
      .prepare(
        `SELECT id, caller, summary, model, stream, input_chars, created_at, status, claimed_by, claimed_at, last_seen_at
           FROM requests
          ORDER BY created_at DESC
          LIMIT ?`,
      )
      .all(limit) as unknown as RawSummary[];
    return rows.map(toSummary);
  }

  getRequest(id: string): RequestRow | undefined {
    return this.db.prepare('SELECT * FROM requests WHERE id = ?').get(id) as RequestRow | undefined;
  }

  replyFor(requestId: string): ReplyRow | undefined {
    return this.db.prepare('SELECT * FROM replies WHERE request_id = ?').get(requestId) as ReplyRow | undefined;
  }

  /**
   * The claim is a conditional update, so two consoles racing for the same
   * request cannot both win: whoever's UPDATE matches a row owns it, and the
   * other gets `changes = 0`. A read-then-write would let both through.
   */
  claim(id: string, responder: string): boolean {
    const now = Date.now();
    const staleBefore = now - this.opts.claimLeaseMs;
    const result = this.db
      .prepare(
        `UPDATE requests
            SET status = 'claimed', claimed_by = ?, claimed_at = ?, last_seen_at = ?
          WHERE id = ?
            AND (status = 'queued'
                 OR (status = 'claimed' AND (last_seen_at IS NULL OR last_seen_at < ?)))`,
      )
      .run(responder, now, now, id, staleBefore);
    return Number(result.changes) === 1;
  }

  heartbeat(id: string, responder: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE requests SET last_seen_at = ?
          WHERE id = ? AND status = 'claimed' AND claimed_by = ?`,
      )
      .run(Date.now(), id, responder);
    return Number(result.changes) === 1;
  }

  releaseClaim(id: string, responder: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE requests
            SET status = 'queued', claimed_by = NULL, claimed_at = NULL, last_seen_at = NULL
          WHERE id = ? AND status = 'claimed' AND claimed_by = ?`,
      )
      .run(id, responder);
    return Number(result.changes) === 1;
  }

  /** Called only after the reply is written, so a request is never both answered and unclaimed. */
  finishRequest(id: string, status: RequestStatus, note?: string): void {
    this.db
      .prepare('UPDATE requests SET status = ?, note = ?, answered_at = ? WHERE id = ?')
      .run(status, note ?? null, Date.now(), id);
  }

  /**
   * Returns claims that lapsed (so the console can be told) and requests whose
   * deadline has passed. Expiry is decided here rather than in the caller's
   * timer so that a request abandoned by a restarted server is still closed.
   */
  sweep(): { released: string[]; expired: Array<{ id: string }> } {
    const now = Date.now();
    const staleBefore = now - this.opts.claimLeaseMs;
    const expiredBefore = now - this.opts.callTimeoutMs;

    const released = this.db
      .prepare(
        `SELECT id FROM requests
          WHERE status = 'claimed' AND (last_seen_at IS NULL OR last_seen_at < ?)`,
      )
      .all(staleBefore) as Array<{ id: string }>;

    if (released.length > 0) {
      this.db
        .prepare(
          `UPDATE requests
              SET status = 'queued', claimed_by = NULL, claimed_at = NULL, last_seen_at = NULL
            WHERE status = 'claimed' AND (last_seen_at IS NULL OR last_seen_at < ?)`,
        )
        .run(staleBefore);
    }

    // Deliberately after the release pass: a request whose lease lapsed a moment
    // before its deadline is expired rather than re-queued for nobody.
    const expired = this.db
      .prepare(
        `SELECT id FROM requests
          WHERE status IN ('queued', 'claimed') AND created_at < ?`,
      )
      .all(expiredBefore) as Array<{ id: string }>;

    if (expired.length > 0) {
      this.db
        .prepare(
          `UPDATE requests SET status = 'expired', note = 'deadline passed'
            WHERE status IN ('queued', 'claimed') AND created_at < ?`,
        )
        .run(expiredBefore);
    }

    return { released: released.map((r) => r.id), expired };
  }

  // ---- replies ------------------------------------------------------------

  saveReply(input: {
    requestId: string;
    responder: string;
    thinking: string;
    text: string;
    toolsJson: string;
    stopReason: string;
    stopSequence: string | null;
    promptChars: number;
    replyChars: number;
    toolCalls: number;
  }): ReplyRow {
    const id = randomUUID();
    const submittedAt = Date.now();
    this.db
      .prepare(
        `INSERT INTO replies (id, request_id, responder, thinking, text, tools_json, stop_reason, stop_sequence,
                              submitted_at, prompt_chars, reply_chars, tool_calls)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.requestId,
        input.responder,
        input.thinking,
        input.text,
        input.toolsJson,
        input.stopReason,
        input.stopSequence,
        submittedAt,
        input.promptChars,
        input.replyChars,
        input.toolCalls,
      );
    return this.db.prepare('SELECT * FROM replies WHERE id = ?').get(id) as unknown as ReplyRow;
  }

  recordRating(requestId: string, responder: string, rating: number): void {
    this.db
      .prepare(
        `INSERT INTO ratings (request_id, responder, rating, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (request_id) DO UPDATE SET rating = excluded.rating, created_at = excluded.created_at`,
      )
      .run(requestId, responder, rating, Date.now());
  }

  // ---- credentials --------------------------------------------------------

  /** Returns the plaintext key exactly once; only its hash is stored. */
  mintCredential(kind: string, name: string): { id: string; key: string } {
    const id = randomUUID();
    const key = generateKey(kind === 'responder' ? 'hmn' : kind === 'caller' ? 'sk' : 'adm');
    this.db
      .prepare('INSERT INTO credentials (id, kind, name, key_hash, created_at, active) VALUES (?, ?, ?, ?, ?, 1)')
      .run(id, kind, name, hashKey(key), Date.now());
    return { id, key };
  }

  lookupCredential(key: string, kind: string): CredentialRow | undefined {
    const row = this.db
      .prepare('SELECT * FROM credentials WHERE key_hash = ? AND kind = ? AND active = 1')
      .get(hashKey(key), kind) as CredentialRow | undefined;
    if (row) {
      this.db.prepare('UPDATE credentials SET last_used_at = ? WHERE id = ?').run(Date.now(), row.id);
    }
    return row;
  }

  listCredentials(kind?: string): CredentialRow[] {
    return (kind
      ? this.db
          .prepare('SELECT * FROM credentials WHERE kind = ? ORDER BY created_at DESC')
          .all(kind)
      : this.db.prepare('SELECT * FROM credentials ORDER BY created_at DESC').all()) as unknown as CredentialRow[];
  }

  revokeCredential(id: string): boolean {
    const result = this.db.prepare('UPDATE credentials SET active = 0 WHERE id = ?').run(id);
    return Number(result.changes) === 1;
  }

  // ---- ledger -------------------------------------------------------------

  addLedger(input: {
    requestId?: string | null;
    replyId?: string | null;
    responder: string;
    kind: 'guarantee' | 'settlement';
    sats: number;
    note?: string | null;
    address?: string | null;
    txid?: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO ledger (id, request_id, reply_id, responder, kind, sats, created_at, note, address, txid)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        input.requestId ?? null,
        input.replyId ?? null,
        input.responder,
        input.kind,
        input.sats,
        Date.now(),
        input.note ?? null,
        input.address ?? null,
        input.txid ?? null,
      );
  }

  /**
   * What a responder has earned, what they have been paid, and the difference.
   * The three are kept apart because "we owe you" and "we paid you" are the two
   * facts a person actually wants, and a single net figure hides both.
   */
  earnings(responder: string): {
    replies: number;
    earnedSats: number;
    paidSats: number;
    owedSats: number;
    ratings: number;
    averageRating: number | null;
    lastAt: number | null;
  } {
    const totals = this.db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN kind = 'guarantee' THEN 1 ELSE 0 END), 0) AS replies,
           COALESCE(SUM(CASE WHEN kind = 'guarantee' THEN sats ELSE 0 END), 0) AS earned,
           COALESCE(SUM(CASE WHEN kind = 'settlement' THEN sats ELSE 0 END), 0) AS paid
         FROM ledger WHERE responder = ?`,
      )
      .get(responder) as { replies: number; earned: number; paid: number };
    const rated = this.db
      .prepare('SELECT COUNT(*) AS n, AVG(rating) AS avg FROM ratings WHERE responder = ?')
      .get(responder) as { n: number; avg: number | null };
    const last = this.db
      .prepare('SELECT MAX(submitted_at) AS at FROM replies WHERE responder = ?')
      .get(responder) as { at: number | null };
    const earned = Number(totals.earned);
    const paid = Number(totals.paid);
    return {
      replies: Number(totals.replies),
      earnedSats: earned,
      paidSats: paid,
      owedSats: earned - paid,
      ratings: Number(rated.n),
      averageRating: rated.avg === null ? null : Number(rated.avg),
      lastAt: last.at === null ? null : Number(last.at),
    };
  }

  /** Everyone's ledger, for the operator view. */
  allLedger(limit: number): LedgerRow[] {
    return this.db
      .prepare('SELECT * FROM ledger ORDER BY created_at DESC LIMIT ?')
      .all(limit) as unknown as LedgerRow[];
  }

  /**
   * One row per responder: how much work, how much earned, how much paid.
   * Built from the ledger rather than from a stored running total, so it cannot
   * disagree with it.
   */
  responderSummary(): Array<{
    responder: string;
    replies: number;
    earnedSats: number;
    paidSats: number;
    owedSats: number;
    ratings: number;
    averageRating: number | null;
  }> {
    const rows = this.db
      .prepare(
        `SELECT responder,
                SUM(CASE WHEN kind = 'guarantee' THEN 1 ELSE 0 END) AS replies,
                SUM(CASE WHEN kind = 'guarantee' THEN sats ELSE 0 END) AS earned,
                SUM(CASE WHEN kind = 'settlement' THEN sats ELSE 0 END) AS paid
           FROM ledger
          GROUP BY responder
          ORDER BY earned DESC`,
      )
      .all() as Array<{ responder: string; replies: number; earned: number; paid: number }>;
    const ratings = this.db
      .prepare('SELECT responder, COUNT(*) AS n, AVG(rating) AS avg FROM ratings GROUP BY responder')
      .all() as Array<{ responder: string; n: number; avg: number | null }>;
    const byResponder = new Map(ratings.map((r) => [r.responder, r]));
    return rows.map((row) => {
      const rated = byResponder.get(row.responder);
      return {
        responder: row.responder,
        replies: Number(row.replies),
        earnedSats: Number(row.earned),
        paidSats: Number(row.paid),
        owedSats: Number(row.earned) - Number(row.paid),
        ratings: rated ? Number(rated.n) : 0,
        averageRating: rated?.avg === null || rated === undefined ? null : Number(rated.avg),
      };
    });
  }

  ledgerFor(responder: string, limit: number): LedgerRow[] {
    return this.db
      .prepare('SELECT * FROM ledger WHERE responder = ? ORDER BY created_at DESC LIMIT ?')
      .all(responder, limit) as unknown as LedgerRow[];
  }

  // ---- stats --------------------------------------------------------------

  stats(): Stats {
    const count = (status: string): number =>
      Number((this.db.prepare('SELECT COUNT(*) AS n FROM requests WHERE status = ?').get(status) as { n: number }).n);

    const since = Date.now() - 86_400_000;
    const answeredLast24h = Number(
      (
        this.db
          .prepare("SELECT COUNT(*) AS n FROM requests WHERE status = 'answered' AND answered_at > ?")
          .get(since) as { n: number }
      ).n,
    );

    const durations = this.db
      .prepare("SELECT answered_at - created_at AS ms FROM requests WHERE status = 'answered' ORDER BY answered_at DESC LIMIT 50")
      .all() as Array<{ ms: number }>;
    const sorted = durations.map((d) => Number(d.ms)).sort((a, b) => a - b);
    const median = sorted.length === 0 ? null : sorted[Math.floor(sorted.length / 2)]!;

    const money = this.db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN kind = 'guarantee' THEN sats ELSE 0 END), 0) AS earned,
           COALESCE(SUM(CASE WHEN kind = 'settlement' THEN sats ELSE 0 END), 0) AS paid
         FROM ledger`,
      )
      .get() as { earned: number; paid: number };
    const responders = Number(
      (
        this.db
          .prepare("SELECT COUNT(DISTINCT responder) AS n FROM replies")
          .get() as { n: number }
      ).n,
    );

    return {
      total: Number((this.db.prepare('SELECT COUNT(*) AS n FROM requests').get() as { n: number }).n),
      waiting: count('queued'),
      claimed: count('claimed'),
      answered: count('answered'),
      expired: count('expired'),
      answeredLast24h,
      medianResponseMs: median,
      responders,
      earnedSats: Number(money.earned),
      paidSats: Number(money.paid),
      owedSats: Number(money.earned) - Number(money.paid),
      poolSats: this.opts.poolSats,
    };
  }

  /**
   * Calls and answers per UTC day, over a continuous window ending today.
   *
   * The continuity is the point of this method rather than an incidental
   * property of it. A GROUP BY returns only the days that have rows, so a
   * fortnight with traffic on two of them comes back as two days — and a chart
   * drawn from two points is not a smaller chart, it is a wrong one, because it
   * says the quiet days did not happen. The axis is built in full here and the
   * counts are dropped into it.
   *
   * `answered` is bucketed on answered_at and not on created_at, deliberately:
   * a call made at 23:50 and answered at 00:10 belongs to two different days,
   * and putting it in one day's column twice would double it.
   *
   * Two queries, one per measure, over a window of weeks on a table of
   * hundreds. Neither measure can use the (status, created_at) index as it
   * stands, and both scan; that is cheaper than an index this table will not
   * earn until it is far larger than it is ever likely to be.
   */
  dailyCounts(days: number, now = Date.now()): DayCount[] {
    if (days <= 0) return [];
    const dayMs = 86_400_000;
    const today = Math.floor(now / dayMs) * dayMs;
    const first = today - (days - 1) * dayMs;

    const byDay = (rows: Array<{ day: string; n: number }>): Map<string, number> =>
      new Map(rows.map((row) => [row.day, Number(row.n)]));

    const calls = byDay(
      this.db
        .prepare(
          `SELECT date(created_at / 1000, 'unixepoch') AS day, COUNT(*) AS n
             FROM requests WHERE created_at >= ? GROUP BY day`,
        )
        .all(first) as Array<{ day: string; n: number }>,
    );
    const answered = byDay(
      this.db
        .prepare(
          `SELECT date(answered_at / 1000, 'unixepoch') AS day, COUNT(*) AS n
             FROM requests WHERE status = 'answered' AND answered_at >= ? GROUP BY day`,
        )
        .all(first) as Array<{ day: string; n: number }>,
    );

    const out: DayCount[] = [];
    for (let offset = 0; offset < days; offset += 1) {
      const date = new Date(first + offset * dayMs).toISOString().slice(0, 10);
      out.push({ date, calls: calls.get(date) ?? 0, answered: answered.get(date) ?? 0 });
    }
    return out;
  }

  /** Trims request bodies for answered and failed calls; the reply is the part worth keeping. */
  pruneRequests(olderThanMs: number): number {
    const result = this.db
      .prepare(
        `UPDATE requests SET request_json = '[pruned]'
          WHERE status IN ('answered', 'expired', 'failed')
            AND created_at < ?
            AND request_json != '[pruned]'`,
      )
      .run(Date.now() - olderThanMs);
    return Number(result.changes);
  }
}
