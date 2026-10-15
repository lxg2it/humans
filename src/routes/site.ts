import { Router } from 'express';
import type { Request, Response } from 'express';
import type { Store } from '../db.ts';
import { answerPage, buildPage, landingPage } from '../site.ts';
import { createStatsReader } from '../stats.ts';

/**
 * The landing pages, and the one public endpoint behind them.
 *
 * These are rendered per request rather than once at boot, unlike the prose
 * documents, because the traffic chart is a live reading of the database. The
 * reading itself is cached inside the stats reader: the page is public and
 * unauthenticated, which makes it the cheapest thing on the internet to hammer,
 * and it should not turn every visit into four queries.
 */
export function siteRouter(store: Store): Router {
  const router = Router();
  const stats = createStatsReader(store);

  router.get('/', (_req: Request, res: Response) => {
    res.type('html').send(landingPage(stats.read()));
  });

  router.get('/answer', (_req: Request, res: Response) => {
    res.type('html').send(answerPage());
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
