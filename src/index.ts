import { join } from 'node:path';
import { createApp } from './app.ts';
import { config } from './config.ts';
import { Store } from './db.ts';
import { Queue } from './queue.ts';

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
const app = createApp(store, queue);

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
