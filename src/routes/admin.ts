import { Router } from 'express';
import type { Request, Response } from 'express';
import { normaliseAddress, validateMainnetAddress, validateTxid } from '../btc.ts';
import { config } from '../config.ts';
import type { Store } from '../db.ts';
import type { Queue } from '../queue.ts';
import { badRequest, conflict, notFound, objectBody, pathParam, requireAdmin } from '../http.ts';

/**
 * The operator's view: who has a key, what has been asked, and what is owed.
 *
 * Two rules hold throughout. Keys are shown exactly once, at the moment they are
 * minted, and never read back afterwards. And money is only ever recorded, never
 * moved: settling a balance writes a row saying a payment happened and by what
 * transaction, because this service cannot know that a payment did.
 */

export function adminRouter(store: Store, queue: Queue): Router {
  const router = Router();
  // Per route, for the reason given in responder.ts: mounted at the root, a
  // router.use() guard here would run for requests it has no business seeing.
  const asAdmin = requireAdmin();

  router.get('/api/admin/overview', asAdmin, (_req: Request, res: Response) => {
    res.json({
      stats: store.stats(),
      responders: store.responderSummary(),
      // CredentialRow deliberately has no key column: a key exists in plaintext
      // once, in the response that mints it, and never again.
      credentials: store.listCredentials(),
      requests: store.recentRequests(50).map((row) => ({
        ...row,
        deadline_at: row.created_at + queue.callTimeoutMs,
      })),
      config: {
        public_name: config.publicName,
        public_url: config.publicUrl,
        operator: config.operator,
        call_timeout_ms: config.callTimeoutMs,
        claim_lease_ms: config.claimLeaseMs,
        guarantee_sats: config.guaranteeSats,
        pool_sats: config.poolSats,
        require_caller_key: config.requireCallerKey,
      },
    });
  });

  router.get('/api/admin/ledger', asAdmin, (req: Request, res: Response) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    res.json({
      entries: store.allLedger(limit),
      responders: store.responderSummary(),
      stats: store.stats(),
    });
  });

  /** The only time a key is ever visible. It is stored hashed, so we cannot show it again. */
  router.post('/api/admin/credentials', asAdmin, (req: Request, res: Response) => {
    const body = objectBody(req.body);
    const kind = typeof body.kind === 'string' ? body.kind : '';
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (kind !== 'caller' && kind !== 'responder') {
      badRequest('kind: must be "caller" or "responder"');
    }
    if (name === '') badRequest('name: required');
    if (name.length > 64) badRequest('name: at most 64 characters');
    if (store.listCredentials(kind).some((credential) => credential.name === name && credential.active === 1)) {
      conflict(`an active ${kind} credential named "${name}" already exists`);
    }
    const minted = store.mintCredential(kind, name);
    res.status(201).json({
      id: minted.id,
      kind,
      name,
      key: minted.key,
      warning: 'this key is shown once and stored only as a hash',
    });
  });

  router.post('/api/admin/credentials/:id/revoke', asAdmin, (req: Request, res: Response) => {
    const id = pathParam(req, 'id');
    if (!store.revokeCredential(id)) notFound('no such credential, or it was already revoked');
    res.json({ revoked: true, id });
  });

  /**
   * Records a payment. `txid` is not verified against any chain: this writes
   * down what the operator says they did, which is exactly why the field is
   * required rather than optional.
   */
  router.post('/api/admin/settlements', asAdmin, (req: Request, res: Response) => {
    const body = objectBody(req.body);
    const responder = typeof body.responder === 'string' ? body.responder.trim() : '';
    const sats = body.sats;
    const address = typeof body.address === 'string' ? body.address.trim() : '';
    const txid = typeof body.txid === 'string' ? body.txid.trim() : '';
    const note = typeof body.note === 'string' ? body.note.trim() : null;

    if (responder === '') badRequest('responder: required');
    if (!Number.isInteger(sats) || (sats as number) <= 0) badRequest('sats: must be a positive integer');
    if (address === '') badRequest('address: required — a payment has to say where it went');
    if (txid === '') {
      badRequest('txid: required — if there is no transaction id yet, the payment has not been made');
    }
    // A settlement is the one part of this ledger claiming to be a record of
    // something that happened rather than a promise, so both fields are checked
    // rather than stored as typed. A settlement against a testnet address is the
    // worst of the available mistakes: it looks complete on every screen, and no
    // money can ever reach it.
    const destination = validateMainnetAddress(address);
    if (!destination.valid) {
      badRequest(
        destination.wrongNetwork
          ? 'address: that is a testnet address, and the satoshis here are mainnet ones'
          : `address: that is not a Bitcoin address (${destination.reason})`,
      );
    }
    const tx = validateTxid(txid);
    if (!tx.valid) badRequest(`txid: ${tx.reason}`);
    const owed = store.earnings(responder).owedSats;
    if (owed <= 0) {
      conflict(`${responder} is not owed anything (earned ${store.earnings(responder).earnedSats}, paid ${store.earnings(responder).paidSats})`);
    }

    store.addLedger({
      responder,
      kind: 'settlement',
      sats: sats as number,
      address: normaliseAddress(destination.info.address),
      txid: txid.toLowerCase(),
      note: note === '' ? null : note,
    });
    res.status(201).json({ recorded: true, responder, sats, remaining_owed: store.earnings(responder).owedSats });
  });

  return router;
}
