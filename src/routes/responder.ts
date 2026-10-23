import { Router } from 'express';
import type { Request, Response } from 'express';
import {
  RequestError,
  STOP_REASONS,
  estimateTokensFromChars,
  readToolChoice,
  requestTextLength,
  type MessageRequest,
  type ToolDefinition,
} from '../anthropic.ts';
import type { Store, RequestRow } from '../db.ts';
import type { Queue } from '../queue.ts';
import { planForm, validateAgainst } from '../schema-form.ts';
import { buildReply, type SubmitBody } from '../reply.ts';
import { conflict, notFound, objectBody, pathParam, requireCaller, requireResponder } from '../http.ts';
import { config } from '../config.ts';
import { normaliseAddress, validateMainnetAddress } from '../btc.ts';
import { createPoolReader } from '../pool.ts';
import type { PoolReader } from '../pool.ts';

/**
 * The responder-facing surface: what the console calls.
 *
 * Nothing here is Anthropic-shaped and nothing here is public. A responder key
 * reaches the queue, the request they are working on, and their own ledger.
 */

function parseRequestRow(row: RequestRow): MessageRequest {
  if (row.request_json === '[pruned]') {
    throw new RequestError(410, 'not_found_error', 'this request is no longer in the queue; its body has been pruned');
  }
  return JSON.parse(row.request_json) as MessageRequest;
}

function declaredTools(row: RequestRow): ToolDefinition[] {
  const parsed: unknown = JSON.parse(row.tools_json);
  return Array.isArray(parsed) ? (parsed as ToolDefinition[]) : [];
}

/**
 * Everything a responder needs to answer a request, and nothing about anyone
 * else's. Field-level detail is sent raw rather than summarised: the console's
 * job is to show the person what is actually in the request.
 */
function detail(
  row: RequestRow,
  tools: ToolDefinition[],
  responderName: string,
  callTimeoutMs: number,
): Record<string, unknown> {
  const request = parseRequestRow(row);
  const choice = readToolChoice(request);
  return {
    id: row.id,
    caller: row.caller,
    summary: row.summary,
    model: row.model,
    stream: row.stream === 1,
    status: row.status,
    created_at: row.created_at,
    deadline_at: row.created_at + callTimeoutMs,
    input_chars: row.input_chars,
    input_tokens: estimateTokensFromChars(requestTextLength(request)),
    max_tokens: request.max_tokens,
    system: request.system ?? null,
    messages: request.messages,
    stop_sequences: request.stop_sequences ?? [],
    tool_choice: choice,
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? '',
      input_schema: tool.input_schema,
      plan: planForm(tool),
    })),
    mine: row.claimed_by === responderName,
    claimed_by: row.claimed_by,
    lease_expires_at: row.last_seen_at === null ? null : row.last_seen_at + config.claimLeaseMs,
  };
}

export function responderRouter(
  store: Store,
  queue: Queue,
  pool: PoolReader = createPoolReader(),
): Router {
  const router = Router();

  /*
   * Auth is attached per route rather than with router.use().
   *
   * These routers are mounted at the application root, so `router.use(mw)` runs
   * for every request that reaches the router — including ones that match none
   * of its routes and are on their way to the 404 handler. As middleware that
   * was a live bug: the responder guard refused /api/admin/overview before the
   * admin guard ever saw it, so the operator API was unreachable from anything
   * that was not also a responder. A request should only meet the guard that
   * belongs to the route it asked for.
   */
  const asResponder = requireResponder(store);

  router.get('/api/me', asResponder, (req: Request, res: Response) => {
    const responder = req.responder!;
    const reading = pool.read();
    res.json({
      name: responder.name,
      key_id: responder.id,
      earnings: store.earnings(responder.name),
      payout_address: responder.payout_address,
      // Null until the person has said it. The console asks at the first call
      // taken, and the claim route below refuses a first claim that arrives
      // without it, so this is a fact about the key rather than a UI preference.
      declared_at: responder.declared_at,
      guarantee_sats: config.guaranteeSats,
      // Their own credit is `earnings.owedSats`; this is what the SERVICE has
      // promised across everyone, which is the figure the pool has to cover and
      // the one the console note speaks about. Both are sent, because a person
      // deciding whether to work needs to know that their own credit exists and
      // that the fund is shared — and a single number labelled "owed" cannot
      // say both.
      owed_across_everybody: store.owedAcrossEverybody(),
      // Null is not zero, and the console branches on it as its own case. A
      // measured pool that cannot be read must not arrive here looking like an
      // empty one, or the console tells a person deciding whether to work that
      // there is nothing in the fund when the truth is that nobody knows.
      pool_sats: reading.sats,
      pool_declared: reading.declared,
      pool_read_at: reading.readAt,
      pool_error: reading.error,
      call_timeout_ms: config.callTimeoutMs,
      claim_lease_ms: config.claimLeaseMs,
      chars_per_token: config.charsPerToken,
      // The console renders its choices from these rather than keeping a second
      // copy of the list that can drift from the one the server enforces.
      stop_reasons: STOP_REASONS,
    });
  });

  /**
   * Where this responder wants to be paid, changeable at any time.
   *
   * Self-service on purpose. An address is the kind of thing that goes stale —
   * wallets get rotated, an address gets pasted wrong, someone moves to a new
   * wallet and stops using the old one — and the alternative to this route is a
   * person emailing an operator to have their own record corrected. It can only
   * ever touch the key that authenticated the request.
   *
   * Clearing it is allowed and is not an error: not wanting to be paid is a
   * position this service has no business arguing with.
   */
  router.post('/api/me/payout-address', asResponder, (req: Request, res: Response) => {
    const responder = req.responder!;
    const raw = typeof req.body?.address === 'string' ? req.body.address.trim() : '';
    if (raw === '') {
      store.setPayoutAddress(responder.id, null);
      res.json({ payout_address: null });
      return;
    }
    const result = validateMainnetAddress(raw);
    if (!result.valid) {
      const message = result.wrongNetwork
        ? 'that is a testnet address. The satoshis here are real, so the address has to be a real one.'
        : `that is not a Bitcoin address: ${result.reason}`;
      throw new RequestError(400, 'invalid_request_error', message);
    }
    const address = normaliseAddress(result.info.address);
    store.setPayoutAddress(responder.id, address);
    // Read back rather than echoing what was sent: the caller should be able to
    // see what is stored, not what they typed.
    res.json({ payout_address: store.payoutAddressFor(responder.name) ?? address });
  });

  router.get('/api/queue', asResponder, (req: Request, res: Response) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const responder = req.responder!;
    res.json({
      requests: store.listQueued(limit).map((row) => ({
        ...row,
        deadline_at: row.created_at + queue.callTimeoutMs,
        mine: row.claimed_by === responder.name,
      })),
      server_time: Date.now(),
    });
  });

  /**
   * A request can be read while it is waiting, and after. Once somebody else has
   * claimed it there is nothing to read it for, and a 409 says so rather than
   * handing over a prompt that is being answered.
   */
  router.get('/api/requests/:id', asResponder, (req: Request, res: Response) => {
    const responder = req.responder!;
    const id = pathParam(req, 'id');
    const row = store.getRequest(id);
    if (!row) notFound('no such request');
    if (row.status === 'claimed' && row.claimed_by !== responder.name) {
      conflict(`${row.claimed_by} is answering this one`);
    }
    res.json(detail(row, declaredTools(row), responder.name, queue.callTimeoutMs));
  });

  /**
   * Takes a call, and asks once whether the person holding the key is answering
   * it themselves.
   *
   * The question is here rather than at signup because this is the moment it
   * means something: a key is a seat, and asking a person to declare what they
   * are before they have decided to sit down is asking them to agree to
   * something they have not yet chosen to do. It is asked once — the date is
   * kept, and no later claim has to repeat it.
   *
   * What is enforced is that the question is asked, not its answer. Nothing in
   * this service can tell a person from a program, and any claim to the
   * contrary would be false; an agent that sends declare: true without reading
   * the sentence gets through, exactly as it can at the signup form. The
   * alternative — no gate at all, with the sentence living only in one client's
   * JavaScript — would mean the declaration is not a record of anything.
   */
  router.post('/api/requests/:id/claim', asResponder, (req: Request, res: Response) => {
    const responder = req.responder!;
    const id = pathParam(req, 'id');
    const row = store.getRequest(id);
    if (!row) notFound('no such request');
    if (row.status !== 'queued' && !(row.status === 'claimed' && row.claimed_by === responder.name)) {
      conflict(
        row.status === 'claimed'
          ? `${row.claimed_by} is answering this one`
          : `this request is ${row.status} and is no longer waiting`,
      );
    }
    if (responder.declared_at === null) {
      if (req.body?.declare !== true) {
        throw new RequestError(
          400,
          'invalid_request_error',
          'before taking a call, say that you are a human and will answer it yourself: send {"declare": true} with ' +
            'this claim. It is recorded once, with the time, against your key.',
        );
      }
      store.declareResponder(responder.id, Date.now());
    }
    if (!store.claim(id, responder.name)) {
      // The conditional update lost, which means somebody claimed it between the
      // read above and the write. Saying so is better than a retry loop.
      conflict('somebody claimed this while you were looking at it');
    }
    const claimed = store.getRequest(id)!;
    res.json(detail(claimed, declaredTools(claimed), responder.name, queue.callTimeoutMs));
  });

  router.post('/api/requests/:id/abandon', asResponder, (req: Request, res: Response) => {
    const responder = req.responder!;
    const id = pathParam(req, 'id');
    if (!store.releaseClaim(id, responder.name)) {
      conflict('you do not hold this request');
    }
    res.json({ released: true });
  });

  router.post('/api/requests/:id/heartbeat', asResponder, (req: Request, res: Response) => {
    const responder = req.responder!;
    const id = pathParam(req, 'id');
    if (!store.heartbeat(id, responder.name)) {
      conflict('your claim on this request has lapsed');
    }
    res.json({ lease_ms: config.claimLeaseMs });
  });

  /**
   * Deltas for the streaming path.
   *
   * Only the appended suffix can be sent: a caller's client reconstructs the
   * message by concatenating deltas and cannot un-receive one, so an edit to
   * text already streamed is not reflected. The stored reply is the submitted
   * text, and the README says which of the two is authoritative.
   */
  router.post('/api/requests/:id/partial', asResponder, (req: Request, res: Response) => {
    const responder = req.responder!;
    const id = pathParam(req, 'id');
    const body = objectBody(req.body);
    const thinking = typeof body.thinking === 'string' ? body.thinking : '';
    const text = typeof body.text === 'string' ? body.text : '';
    if (!store.heartbeat(id, responder.name)) {
      conflict('your claim on this request has lapsed');
    }
    /*
     * Whether anyone received it is reported rather than assumed. A partial can
     * reach nobody — the caller may not be streaming, or may have disconnected —
     * and a responder typing into a closed socket should be able to see that.
     */
    const delivered = queue.partial(id, { thinking, text });
    res.json({ ok: true, delivered });
  });

  /**
   * Checks one tool input against the schema the caller declared, so the console
   * can show the responder what is wrong before they try to submit. The same
   * check runs again on submit; this one exists to be early, not to be trusted.
   */
  router.post('/api/requests/:id/validate', asResponder, (req: Request, res: Response) => {
    const id = pathParam(req, 'id');
    const row = store.getRequest(id);
    if (!row) notFound('no such request');
    const body = objectBody(req.body);
    const name = typeof body.name === 'string' ? body.name : '';
    const tool = declaredTools(row).find((candidate) => candidate.name === name);
    if (!tool) notFound(`this request declares no tool named "${name}"`);
    const result = validateAgainst(tool.input_schema, body.input);
    res.json(result);
  });

  router.post('/api/requests/:id/submit', asResponder, (req: Request, res: Response) => {
    const responder = req.responder!;
    const id = pathParam(req, 'id');
    const row = store.getRequest(id);
    if (!row) notFound('no such request');
    if (row.status === 'answered') conflict('this request has already been answered');
    if (row.status !== 'claimed' || row.claimed_by !== responder.name) {
      conflict('you do not hold this request');
    }

    const request = parseRequestRow(row);
    const built = buildReply({
      request,
      declaredTools: declaredTools(row),
      maxTokens: request.max_tokens,
      body: objectBody(req.body) as SubmitBody,
    });

    const reply = store.saveReply({
      requestId: row.id,
      responder: responder.name,
      thinking: built.thinking,
      text: built.text,
      toolsJson: JSON.stringify(built.toolCalls),
      stopReason: built.stopReason,
      stopSequence: built.stopSequence,
      promptChars: row.input_chars,
      replyChars: built.thinking.length + built.text.length,
      toolCalls: built.toolCalls.length,
    });
    store.finishRequest(row.id, 'answered');
    const delivered = queue.deliver(row, built.content, built.stopReason, built.stopSequence);

    // The guarantee is written after the reply is durable, and it is owed even
    // when the caller has already gone: the work happened either way.
    store.addLedger({
      requestId: row.id,
      replyId: reply.id,
      responder: responder.name,
      kind: 'guarantee',
      sats: config.guaranteeSats,
    });

    res.json({
      reply_id: reply.id,
      stop_reason: built.stopReason,
      tool_calls: built.toolCalls.length,
      unchecked_schemas: built.unchecked,
      delivered,
      earnings: store.earnings(responder.name),
    });
  });

  router.get('/api/ledger', asResponder, (req: Request, res: Response) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const responder = req.responder!;
    res.json({
      entries: store.ledgerFor(responder.name, limit),
      earnings: store.earnings(responder.name),
      pool_sats: config.poolSats,
      guarantee_sats: config.guaranteeSats,
    });
  });

  return router;
}

/**
 * Ratings come from the caller, not the responder, so they are authenticated
 * with a caller key and live here only because they are about a reply.
 */
export function ratingsRouter(store: Store): Router {
  const router = Router();

  router.post('/api/ratings', requireCaller(store), (req: Request, res: Response) => {
    const body = objectBody(req.body);
    const requestId = typeof body.request_id === 'string' ? body.request_id : '';
    const rating = body.rating;
    if (!Number.isInteger(rating) || (rating as number) < 1 || (rating as number) > 5) {
      throw new RequestError(400, 'invalid_request_error', 'rating: must be an integer from 1 to 5');
    }
    const row = store.getRequest(requestId);
    if (!row) notFound('no such request');
    // A caller may only rate its own request, which is why the request records
    // who asked for it.
    if (row.caller !== (req.caller?.name ?? null)) {
      throw new RequestError(403, 'permission_error', 'this request was not made with your key');
    }
    const reply = store.replyFor(requestId);
    if (!reply) notFound('this request has not been answered yet');
    store.recordRating(requestId, reply.responder, rating as number);
    res.json({ recorded: true, responder: reply.responder, rating });
  });

  return router;
}
