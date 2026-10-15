import { Router } from 'express';
import type { Request, Response } from 'express';
import { loadDocuments } from '../docs.ts';

/**
 * The prose pages: the disclaimer, what the money is, and what answering a call
 * involves.
 *
 * They are rendered once, when the router is built, so that a missing document
 * stops the service at boot rather than being discovered by a caller. There is
 * no route parameter here on purpose: the set of documents is fixed, and a path
 * that names a file is a path that can be walked.
 */
export function docsRouter(): Router {
  const router = Router();
  for (const document of loadDocuments()) {
    router.get(document.route, (_req: Request, res: Response) => {
      res.type('html').send(document.html);
    });
  }
  return router;
}
