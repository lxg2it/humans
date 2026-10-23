import { join } from 'node:path';
import { createApp } from './app.ts';
import { config } from './config.ts';
import { Store } from './db.ts';
import { Queue } from './queue.ts';
import { createPoolReader } from './pool.ts';

/**
 * The entry point. Opens the store, listens, and sweeps.
 *
 * One thing here is not a detail: the request timeout. Node kills any request
 * that has been open for five minutes by default, which is well inside the time
 * a person takes to answer, so the default would silently convert every slow
 * reply into a socket error at the five-minute mark.
 */

const dbPath = join(config.dataDir, 'humans.sqlite');
const store = new Store(dbPath, {
  claimLeaseMs: config.claimLeaseMs,
  callTimeoutMs: config.callTimeoutMs,
  poolSats: config.poolSats,
});
const queue = new Queue(store);
// One reader for the whole process: the console, the fund page and the health
// endpoint are all describing the same pot of money, and a reader each meant
// they could disagree — and each paid its own cold start, which is how a healthy
// box told the first visitor after a restart that the balance could not be read.
const pool = createPoolReader();
const app = createApp(store, queue, pool);

/*
 * Read the fund at boot, before anybody asks.
 *
 * The reading is deliberately non-blocking: `read()` answers from what it knows
 * and refreshes behind the request, so no page ever waits on the chain. The
 * consequence is that the first request after a restart finds nothing known yet
 * and renders "could not be read" — a sentence that exists for an outage,
 * shown instead as a routine warm-up, which is the same defect as any other two
 * states rendering alike. Warming here costs one fetch at start and removes it.
 */
void pool
  .refresh()
  .then((reading) => {
    if (reading.sats === null) {
      console.log(`[humans] the fund could not be read at boot (${reading.error ?? 'no fetch completed'}).`);
      return;
    }
    console.log(`[humans] the fund holds ${reading.sats} sats, read at boot.`);
  })
  .catch((error: unknown) => {
    // A warm-up that fails is not a crash: the next request retries it.
    console.log(`[humans] the fund could not be read at boot (${String(error)}).`);
  });

const server = app.listen(config.port, config.host, () => {
  const address = `http://${config.host}:${config.port}`;
  console.log(`[humans] listening on ${address}`);
  console.log(`[humans] database ${dbPath}`);
  console.log(`[humans] the console is at ${address}/`);

  const credentials = store.listCredentials();
  if (credentials.length === 0) {
    console.log('[humans] no credentials exist yet. Mint one with:');
    console.log('[humans]   npm run admin -- key responder <name>');
    if (config.requireCallerKey) {
      console.log('[humans] until a caller key exists, every /v1 request will be refused.');
    }
  }
  if (config.adminKey === '') {
    console.log('[humans] HUMANS_ADMIN_KEY is not set, so the operator interface is disabled.');
  }
  if (config.poolSats < config.guaranteeSats) {
    console.log(
      `[humans] the guarantee is ${config.guaranteeSats} sats per reply, but the pool is ${config.poolSats}. ` +
        'The console will say so rather than promise money that is not there.',
    );
  }
});

// A person may take minutes. The socket must outlive them, and its headers must
// still arrive promptly enough to be worth trusting.
server.requestTimeout = config.callTimeoutMs + 30_000;
server.headersTimeout = 30_000;
server.keepAliveTimeout = 65_000;

queue.start();

const pruneTimer = setInterval(() => {
  const pruned = store.pruneRequests(config.pruneAfterMs);
  if (pruned > 0) console.log(`[humans] pruned ${pruned} request bodies`);
}, 3_600_000);
pruneTimer.unref();

function shutdown(signal: string): void {
  console.log(`[humans] ${signal}: stopping`);
  clearInterval(pruneTimer);
  queue.stop();
  server.close(() => {
    store.close();
    process.exit(0);
  });
  // Anything still waiting is already answered with a 503 by queue.stop(); if
  // the sockets do not close, the process still goes.
  setTimeout(() => process.exit(0), 3_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
