import express from 'express';
import type { Express } from 'express';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.ts';
import type { Store } from './db.ts';
import type { Queue } from './queue.ts';
import { errorHandler } from './http.ts';
import { messagesRouter } from './routes/messages.ts';
import { ratingsRouter, responderRouter } from './routes/responder.ts';
import { adminRouter } from './routes/admin.ts';
import { docsRouter } from './routes/docs.ts';

/**
 * The whole service, assembled. Nothing here listens: the tests build an app and
 * ask it questions, and index.ts is the only place that opens a port.
 */

const publicDir = join(import.meta.dirname, '../public');

export function createApp(store: Store, queue: Queue): Express {
  const app = express();

  // Behind a proxy, req.ip is the proxy's. Trusting it blindly would let anyone
  // claim any address, so it is off unless the deployment says otherwise.
  app.set('trust proxy', config.trustProxy ? 1 : false);
  app.disable('x-powered-by');
  app.use(express.json({ limit: config.maxBodyBytes }));

  app.get('/healthz', (_req, res) => {
    res.json({
      ok: true,
      pending_calls: queue.pending(),
      pool_sats: config.poolSats,
      // Said plainly, because it is the difference between a service that can be
      // charged for and one that cannot.
      caller_keys_required: config.requireCallerKey,
    });
  });

  app.use(messagesRouter(store, queue));
  app.use(ratingsRouter(store));
  app.use(responderRouter(store, queue));
  app.use(adminRouter(store, queue));

  // The prose: what this is, what the money is, what answering involves. Read
  // from the repository's own Markdown at boot, so the site and the source
  // cannot disagree about what a visitor was told.
  app.use(docsRouter());

  // The console and the operator page. Both are plain files with no build step,
  // so there is nothing to keep in sync.
  app.use('/', express.static(publicDir, { index: 'index.html', extensions: ['html'] }));

  if (config.adminKey !== '' && existsSync(join(publicDir, 'admin.html'))) {
    app.get('/admin', (_req, res) => {
      res.sendFile(join(publicDir, 'admin.html'));
    });
  }

  app.use((_req, res) => {
    res.status(404).json({
      type: 'error',
      error: { type: 'not_found_error', message: 'no such endpoint' },
    });
  });

  app.use(errorHandler());
  return app;
}
