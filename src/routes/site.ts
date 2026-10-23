import { Router } from 'express';
import type { Request, Response } from 'express';
import type { Store } from '../db.ts';
import { createPoolReader } from '../pool.ts';
import type { PoolReader } from '../pool.ts';
import { answerPage, buildPage, landingPage, poolPage } from '../site.ts';
import { createStatsReader } from '../stats.ts';

/**
 * The landing pages, and the one public endpoint behind them.
 *
 * These are rendered per request rather than once at boot, unlike the prose
 * documents, because the traffic chart is a live reading of the database. The
 * reading itself is cached inside the stats reader: the page is public and
 * unauthenticated, which makes it the cheapest thing on the internet to hammer,
 * and it should not turn every visit into four queries.
 *
 * The pool reading works the same way and for the same reason, with one
 * addition: a page render never waits on the chain. `read()` answers from
 * whatever it already knows and refreshes in the background, so a slow or dead
 * indexer costs the page a stale timestamp rather than a hung request.
 */
export function siteRouter(store: Store, pool: PoolReader = createPoolReader()): Router {
  const router = Router();
  const stats = createStatsReader(store);

  /**
   * What the service has promised and not yet paid, across everybody. The sum
   * lives on the store now, because the console note beside the claim button
   * needs the same figure and had been given a single responder's balance while
   * using the same word for it.
   */
  function owedSats(): number {
    return store.owedAcrossEverybody();
  }

  router.get('/', (_req: Request, res: Response) => {
    res.type('html').send(landingPage(stats.read(), pool.read()));
  });

  router.get('/answer', (_req: Request, res: Response) => {
    res.type('html').send(answerPage(pool.read()));
  });

  router.get('/pool', (_req: Request, res: Response) => {
    res.type('html').send(poolPage(pool.read(), owedSats()));
  });

  router.get('/build', (_req: Request, res: Response) => {
    res.type('html').send(buildPage());
  });

  /**
   * The same snapshot the landing page draws, for anyone who would rather read
   * the number than the chart. It is aggregates only, by construction: see
   * src/stats.ts.
   */
  router.get('/api/stats', (_req: Request, res: Response) => {
    res.json(stats.read());
  });

  return router;
}
