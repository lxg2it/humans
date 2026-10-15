import type { Response } from 'express';
import type { Store, RequestRow } from './db.ts';
import {
  buildResponse,
  estimateTokensFromChars,
  responseTextLength,
  sse,
  RequestError,
  type ResponseBlock,
  type MessageResponse,
  type StopReason,
} from './anthropic.ts';
import { config } from './config.ts';

/**
 * Holds the connections that are waiting for a human, and turns a human's
 * typing into the byte stream a caller is reading.
 *
 * The waiting half is the interesting half. A language model answers in
 * seconds; a person answers in minutes, and the client on the other end was
 * written for the first case. Everything here exists to make a ten-minute gap
 * look like a slow completion rather than a broken connection: an immediate
 * response with a live body, pings so nothing upstream reaps an idle socket,
 * and a refusal that arrives as a status code instead of a hang.
 */

interface BlockState {
  type: 'thinking' | 'text';
  index: number;
  /** Text already sent as deltas. Deltas are append-only, so this is a high-water mark. */
  emitted: string;
}

interface Waiter {
  requestId: string;
  kind: 'json' | 'sse';
  createdAt: number;
  inputTokens: number;
  model: string;
  blocks: BlockState[];
  nextIndex: number;
  settled: boolean;
  pingTimer?: NodeJS.Timeout;
  timeoutTimer?: NodeJS.Timeout;
  resolveJson?: (response: MessageResponse) => void;
  rejectJson?: (error: RequestError) => void;
  sse?: { res: Response; started: boolean };
}

export class Queue {
  private readonly waiters = new Map<string, Waiter>();
  private readonly store: Store;
  private sweepTimer?: NodeJS.Timeout;

  /**
   * The runtime's own numbers. They are here, once, and everything that reasons
   * about a deadline reads them from this object: a caller's deadline, the
   * timeout that closes its socket and the sweep that expires its row are three
   * views of one value, and they must not be three copies of it.
   */
  readonly callTimeoutMs: number;
  readonly sweepIntervalMs: number;
  readonly pingIntervalMs: number;

  constructor(store: Store, opts: { callTimeoutMs?: number; sweepIntervalMs?: number; pingIntervalMs?: number } = {}) {
    this.store = store;
    this.callTimeoutMs = opts.callTimeoutMs ?? config.callTimeoutMs;
    this.sweepIntervalMs = opts.sweepIntervalMs ?? config.sweepIntervalMs;
    this.pingIntervalMs = opts.pingIntervalMs ?? 20_000;
  }

  start(intervalMs = this.sweepIntervalMs): void {
    this.sweepTimer ??= setInterval(() => this.sweep(), intervalMs);
    this.sweepTimer.unref?.();
  }

  stop(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
    for (const waiter of [...this.waiters.values()]) {
      this.settle(waiter, {
        ok: false,
        error: new RequestError(503, 'api_error', 'server is shutting down'),
      });
    }
  }

  /**
   * The one answer to "nobody answered in time".
   *
   * Two mechanisms can get here — the per-request timer and the sweep that
   * notices a deadline that passed while the process was busy — and a caller
   * cannot tell which one fired, so they must not say different things. Written
   * once for that reason; the test that caught them disagreeing also asserts the
   * type, because the Anthropic SDK defines a 504 as `timeout_error` and a
   * caller branching on error.type is entitled to the distinction.
   */
  private timeoutError(): RequestError {
    return new RequestError(
      504,
      'timeout_error',
      `no responder answered within ${Math.round(this.callTimeoutMs / 1000)}s`,
    );
  }

  /** Leases that ran out return to the queue; deadlines that passed close the request. */
  private sweep(): void {
    const { expired } = this.store.sweep();
    for (const row of expired) {
      const waiter = this.waiters.get(row.id);
      if (waiter) {
        this.settle(waiter, { ok: false, error: this.timeoutError() });
      }
    }
  }

  private settle(waiter: Waiter, outcome: { ok: true; response: MessageResponse } | { ok: false; error: RequestError }): void {
    if (waiter.settled) return;
    waiter.settled = true;
    this.waiters.delete(waiter.requestId);
    if (waiter.pingTimer) clearInterval(waiter.pingTimer);
    if (waiter.timeoutTimer) clearTimeout(waiter.timeoutTimer);

    if (outcome.ok) {
      if (waiter.kind === 'json') {
        waiter.resolveJson?.(outcome.response);
      } else if (waiter.sse) {
        this.streamFinal(waiter, outcome.response);
      }
    } else {
      if (waiter.kind === 'json') {
        waiter.rejectJson?.(outcome.error);
      } else if (waiter.sse) {
        // Past the first byte there is no status left to send, so the refusal
        // has to arrive as an error event inside the stream. That is the one
        // place in this service where a failure cannot be reported honestly by
        // the transport, and it is unavoidable.
        const res = waiter.sse.res;
        if (!res.writableEnded) {
          res.write(sse('error', outcome.error.toBody()));
          res.end();
        }
      }
    }
  }

  private streamFinal(waiter: Waiter, response: MessageResponse): void {
    const res = waiter.sse?.res;
    if (!res || res.writableEnded) return;

    /*
     * The blocks a responder streamed while typing are opened already; anything
     * they left to submit time has to be opened here. Both halves matter: a
     * responder who types and one who pastes an answer are equally normal, and
     * before this, the second kind of caller received a message with no content
     * at all — a stop_reason and nothing to stop.
     */
    const unclaimed = [...waiter.blocks];
    const takeStreamed = (type: 'thinking' | 'text'): BlockState | undefined => {
      const index = unclaimed.findIndex((block) => block.type === type);
      return index === -1 ? undefined : unclaimed.splice(index, 1)[0];
    };
    const openBlock = (type: 'thinking' | 'text'): number => {
      const index = waiter.nextIndex++;
      res.write(
        sse('content_block_start', {
          type: 'content_block_start',
          index,
          content_block: type === 'thinking' ? { type: 'thinking', thinking: '' } : { type: 'text', text: '' },
        }),
      );
      return index;
    };
    const sendDelta = (type: 'thinking' | 'text', index: number, text: string): void => {
      if (text === '') return;
      res.write(
        sse('content_block_delta', {
          type: 'content_block_delta',
          index,
          delta:
            type === 'thinking' ? { type: 'thinking_delta', thinking: text } : { type: 'text_delta', text },
        }),
      );
    };
    const closeBlock = (index: number): void => {
      res.write(sse('content_block_stop', { type: 'content_block_stop', index }));
    };

    for (const block of response.content) {
      if (block.type === 'tool_use') {
        // Tool calls are structured, so they are opened and closed at submit
        // time rather than typed: one JSON document per block.
        const index = waiter.nextIndex++;
        res.write(
          sse('content_block_start', {
            type: 'content_block_start',
            index,
            content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
          }),
        );
        res.write(
          sse('content_block_delta', {
            type: 'content_block_delta',
            index,
            delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input ?? {}) },
          }),
        );
        closeBlock(index);
        continue;
      }
      const text = block.type === 'thinking' ? block.thinking : block.text;
      const streamed = takeStreamed(block.type);
      if (!streamed) {
        const index = openBlock(block.type);
        sendDelta(block.type, index, text);
        closeBlock(index);
        continue;
      }
      /*
       * Only the part the caller has not seen. A client concatenates deltas and
       * cannot un-receive one, so a repeat would duplicate the text. If the
       * responder edited what they had already streamed, the edit cannot be
       * undone on the wire and the streamed text is what the caller has; the
       * stored reply remains the authoritative record.
       */
      const remaining = text.startsWith(streamed.emitted) ? text.slice(streamed.emitted.length) : '';
      sendDelta(block.type, streamed.index, remaining);
      closeBlock(streamed.index);
    }

    // A block the responder streamed that the final reply does not mention —
    // text they typed and then deleted — is still open at the caller's end.
    for (const block of unclaimed) closeBlock(block.index);

    res.write(
      sse('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: response.stop_reason, stop_sequence: response.stop_sequence },
        usage: { output_tokens: response.usage.output_tokens },
      }),
    );
    res.write(sse('message_stop', { type: 'message_stop' }));
    res.end();
  }

  pending(): number {
    return this.waiters.size;
  }

  /**
   * Registers a non-streaming caller. Resolves with the human's reply, or
   * rejects with a RequestError once the deadline passes.
   */
  awaitJson(input: {
    requestId: string;
    model: string;
    inputTokens: number;
    signal: AbortSignal;
  }): Promise<MessageResponse> {
    return new Promise<MessageResponse>((resolve, reject) => {
      const waiter: Waiter = {
        requestId: input.requestId,
        kind: 'json',
        createdAt: Date.now(),
        inputTokens: input.inputTokens,
        model: input.model,
        blocks: [],
        nextIndex: 0,
        settled: false,
        resolveJson: resolve,
        rejectJson: reject,
      };
      const onAbort = (): void => {
        this.settle(waiter, {
          ok: false,
          error: new RequestError(499, 'api_error', 'the caller closed the connection before a responder answered'),
        });
        this.store.finishRequest(input.requestId, 'failed', 'caller disconnected');
      };
      input.signal.addEventListener('abort', onAbort, { once: true });
      waiter.timeoutTimer = setTimeout(() => {
        this.settle(waiter, { ok: false, error: this.timeoutError() });
        this.store.finishRequest(input.requestId, 'expired', 'no responder answered in time');
      }, this.callTimeoutMs);
      this.waiters.set(input.requestId, waiter);
    });
  }

  /**
   * Registers a streaming caller and commits the response headers. The message
   * is opened immediately, before any human has been asked, because a client
   * that is told "200, here comes a message" will wait, and a client staring at
   * a pending connection will time out.
   */
  awaitStream(input: { requestId: string; model: string; inputTokens: number; res: Response }): void {
    const res = input.res;
    const waiter: Waiter = {
      requestId: input.requestId,
      kind: 'sse',
      createdAt: Date.now(),
      inputTokens: input.inputTokens,
      model: input.model,
      blocks: [],
      nextIndex: 0,
      settled: false,
      sse: { res, started: true },
    };

    res.status(200);
    res.setHeader('content-type', 'text/event-stream; charset=utf-8');
    res.setHeader('cache-control', 'no-cache, no-transform');
    res.setHeader('connection', 'keep-alive');
    res.setHeader('x-accel-buffering', 'no');
    res.flushHeaders?.();

    res.write(
      sse('message_start', {
        type: 'message_start',
        message: {
          id: input.requestId,
          type: 'message',
          role: 'assistant',
          model: input.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: input.inputTokens, output_tokens: 0 },
        },
      }),
    );

    // Anything between here and the answer is dead air. A human working through
    // a stack trace is indistinguishable from a hung socket, so keep saying
    // something; 20s is inside the shortest idle timeout in the path (Cloudflare
    // ends an idle proxied response at 100s).
    waiter.pingTimer = setInterval(() => {
      if (!res.writableEnded) res.write(sse('ping', { type: 'ping' }));
    }, this.pingIntervalMs);

    waiter.timeoutTimer = setTimeout(() => {
      this.settle(waiter, { ok: false, error: this.timeoutError() });
      this.store.finishRequest(input.requestId, 'expired', 'no responder answered in time');
    }, this.callTimeoutMs);

    res.on('close', () => {
      if (!waiter.settled) {
        this.settle(waiter, {
          ok: false,
          error: new RequestError(499, 'api_error', 'the caller closed the connection'),
        });
        this.store.finishRequest(input.requestId, 'failed', 'caller disconnected');
      }
    });

    this.waiters.set(input.requestId, waiter);
  }

  /**
   * Called as a human types. The payload is the whole current field contents
   * rather than a keystroke, so a dropped or retried update cannot desynchronise
   * the stream: only the suffix beyond what has already been sent is emitted.
   */
  partial(requestId: string, fields: { thinking?: string; text?: string }): boolean {
    const waiter = this.waiters.get(requestId);
    if (!waiter || waiter.settled || !waiter.sse) return false;
    const res = waiter.sse.res;
    if (res.writableEnded) return false;

    // Thinking is offered to the stream first, because a caller reading the
    // content array expects it there.
    for (const type of ['thinking', 'text'] as const) {
      const incoming = fields[type];
      if (incoming === undefined) continue;
      let block = waiter.blocks.find((b) => b.type === type);
      if (!block) {
        if (incoming.length === 0) continue;
        block = { type, index: waiter.nextIndex++, emitted: '' };
        waiter.blocks.push(block);
        res.write(
          sse('content_block_start', {
            type: 'content_block_start',
            index: block.index,
            content_block: type === 'thinking' ? { type: 'thinking', thinking: '' } : { type: 'text', text: '' },
          }),
        );
      }
      // Deltas cannot be retracted, so an edit that shortens the text is simply
      // not sent: the high-water mark only moves forward.
      if (incoming.length <= block.emitted.length) continue;
      if (!incoming.startsWith(block.emitted)) continue;
      const suffix = incoming.slice(block.emitted.length);
      block.emitted = incoming;
      res.write(
        sse('content_block_delta', {
          type: 'content_block_delta',
          index: block.index,
          delta:
            type === 'thinking'
              ? { type: 'thinking_delta', thinking: suffix }
              : { type: 'text_delta', text: suffix },
        }),
      );
    }
    return true;
  }

  /**
   * Delivers a completed answer. Returns false when nobody is listening, which
   * is not an error: the answer is still recorded against the request.
   */
  deliver(row: RequestRow, content: ResponseBlock[], stopReason: StopReason, stopSequence: string | null): boolean {
    const waiter = this.waiters.get(row.id);
    if (!waiter) return false;
    const response = buildResponse({
      id: row.id,
      // From the waiter, not the row: the row stores what the caller asked for,
      // and the answer names the model that answered.
      model: waiter.model,
      content,
      stopReason,
      stopSequence,
      // The input count is the one the caller was quoted in message_start, not a
      // fresh estimate: the same request should not have two sizes.
      inputTokens: waiter.inputTokens,
      outputTokens: estimateTokensFromChars(responseTextLength(content)),
    });
    this.settle(waiter, { ok: true, response });
    return true;
  }
}
