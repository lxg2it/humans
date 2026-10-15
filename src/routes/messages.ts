import { Router } from 'express';
import type { Request, Response } from 'express';
import {
  DEFAULT_MODEL,
  MODELS,
  estimateTokensFromChars,
  messageId,
  parseMessageRequest,
  requestTextLength,
  resolveModel,
  type MessageRequest,
} from '../anthropic.ts';
import type { Store } from '../db.ts';
import type { Queue } from '../queue.ts';
import { rateLimit, requireCaller } from '../http.ts';

/**
 * The caller-facing surface: a subset of the Anthropic Messages API.
 *
 * A request arrives, is written to the queue, and the connection stays open
 * until somebody answers it. Everything below is bookkeeping around that wait,
 * plus the validation that keeps the two ends of it honest with each other.
 */

/** A short line for the queue list. The full request is one click away, and only one click. */
export function summariseRequest(request: MessageRequest, chars: number): string {
  const messages = Array.isArray(request.messages) ? request.messages : [];
  const tools = Array.isArray(request.tools) ? request.tools : [];
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const preview = typeof lastUser?.content === 'string'
    ? lastUser.content
    : Array.isArray(lastUser?.content)
      ? lastUser.content
          .map((b) => (b.type === 'text' && typeof b.text === 'string' ? b.text : b.type === 'tool_result' ? '[tool result]' : `[${b.type}]`))
          .join(' ')
      : '';

  const parts = [
    `${messages.length} ${messages.length === 1 ? 'message' : 'messages'}`,
    tools.length > 0 ? `${tools.length} tools` : null,
    `${chars.toLocaleString('en-AU')} chars`,
    request.system !== undefined ? 'system prompt' : null,
  ].filter(Boolean);

  const compact = preview.replace(/\s+/g, ' ').trim();
  return compact.length > 0 ? `${parts.join(' · ')} · “${compact.slice(0, 90)}”` : parts.join(' · ');
}

export function messagesRouter(store: Store, queue: Queue): Router {
  const router = Router();

  router.post('/v1/messages', requireCaller(store), rateLimit(), async (req: Request, res: Response) => {
    const request = parseMessageRequest(req.body);
    const model = resolveModel(request.model);
    const chars = requestTextLength(request);
    const inputTokens = estimateTokensFromChars(chars);
    const id = messageId();
    const stream = request.stream === true;

    store.insertRequest({
      id,
      caller: req.caller?.name ?? null,
      model,
      requestJson: JSON.stringify(request),
      summary: summariseRequest(request, chars),
      toolsJson: JSON.stringify(request.tools ?? []),
      stream,
      inputChars: chars,
    });

    if (stream) {
      // Headers go out now, before a person has even been asked, so the client
      // sees an open message rather than a connection doing nothing.
      queue.awaitStream({ requestId: id, model, inputTokens, res });
      return;
    }

    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) controller.abort();
    });
    const response = await queue.awaitJson({ requestId: id, model, inputTokens, signal: controller.signal });
    res.json(response);
  });

  /**
   * Token counting, answered by the same estimate used everywhere else. It is
   * offered because clients call it, and returning a number derived from the
   * same arithmetic keeps the two consistent even when both are approximate.
   */
  router.post('/v1/messages/count_tokens', requireCaller(store), rateLimit(), (req: Request, res: Response) => {
    const supplied = (req.body ?? {}) as Partial<MessageRequest>;
    // max_tokens does not affect a count, so it is not demanded here even
    // though the messages endpoint requires it.
    const request = parseMessageRequest({
      ...supplied,
      model: supplied.model ?? DEFAULT_MODEL,
      max_tokens: supplied.max_tokens ?? 1,
    });
    res.json({ input_tokens: estimateTokensFromChars(requestTextLength(request)) });
  });

  router.get('/v1/models', requireCaller(store), (_req: Request, res: Response) => {
    const data = MODELS.map((model) => ({
      type: 'model' as const,
      id: model.id,
      display_name: model.display_name,
      created_at: model.created_at,
    }));
    res.json({
      data,
      has_more: false,
      first_id: data[0]?.id ?? null,
      last_id: data[data.length - 1]?.id ?? null,
    });
  });

  return router;
}
