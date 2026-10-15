import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from './config.ts';
import { signingKey } from './secret.ts';

/**
 * The subset of the Anthropic Messages API this service speaks.
 *
 * Strictness here is a service to the caller: this endpoint exists to be
 * pointed at by clients written against the real API, so a request the real API
 * would reject is rejected here too, with the same shape of error. Being more
 * permissive would silently accept traffic that breaks the moment the base URL
 * points somewhere else.
 *
 * One deliberate exception, and it is the model id: the real API refuses a model
 * it does not serve, while this one answers the request anyway and names the
 * model that answered. See `resolveModel`.
 */

export const ANTHROPIC_VERSION = '2023-06-01';

export const MODELS = [
  {
    id: 'human-1',
    display_name: 'Human (1st generation)',
    created_at: '2026-10-15T00:00:00Z',
  },
] as const;

export const DEFAULT_MODEL = 'human-1';

export const STOP_REASONS = [
  'end_turn',
  'max_tokens',
  'stop_sequence',
  'tool_use',
  'pause_turn',
  'refusal',
] as const;
export type StopReason = (typeof STOP_REASONS)[number];

export type TextBlock = {
  type: 'text';
  text: string;
}
export type ThinkingBlock = {
  type: 'thinking';
  thinking: string;
  signature: string;
}
export type ToolUseBlock = {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}
export type ToolResultBlock = {
  type: 'tool_result';
  tool_use_id: string;
  content?: string | ContentBlock[];
  is_error?: boolean;
}
export interface ContentBlock {
  type: string;
  [key: string]: unknown;
}

/**
 * What we send back.
 *
 * A caller may send any block shape, which is why `ContentBlock` is loose, but
 * an answer is our own construction and only ever these three. Keeping the two
 * apart is what lets the streaming path read `block.text` as a string instead of
 * hoping: the loose type made every field `unknown`, and code that has to
 * re-check its own output for a type it just built is a type that is wrong.
 */
export type ResponseBlock = TextBlock | ThinkingBlock | ToolUseBlock;

export interface MessageParam {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

export interface ToolDefinition {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
  [key: string]: unknown;
}

export interface MessageRequest {
  model: string;
  max_tokens: number;
  messages: MessageParam[];
  system?: string | ContentBlock[];
  tools?: ToolDefinition[];
  tool_choice?: unknown;
  stream?: boolean;
  thinking?: unknown;
  temperature?: number;
  stop_sequences?: string[];
  metadata?: { user_id?: string; [key: string]: unknown };
  [key: string]: unknown;
}

export interface ApiError {
  type: 'error';
  error: { type: string; message: string; details?: Array<{ field: string; message: string }> };
}

export class RequestError extends Error {
  readonly status: number;
  readonly errorType: string;
  /**
   * Per-field detail, set only on the responder-facing routes so the console
   * can mark the input that is wrong. A field of the error body the real API
   * does not have, so it is never sent to a `/v1` caller.
   */
  readonly details?: Array<{ field: string; message: string }>;

  constructor(status: number, errorType: string, message: string, details?: Array<{ field: string; message: string }>) {
    super(message);
    this.status = status;
    this.errorType = errorType;
    this.details = details;
  }

  toBody(): ApiError {
    return {
      type: 'error',
      error: {
        type: this.errorType,
        message: this.message,
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}

const TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,128}$/;

function invalid(message: string): never {
  throw new RequestError(400, 'invalid_request_error', message);
}

/**
 * Which model answers a request, given the id the caller asked for.
 *
 * Every id is answered by the same model, and that is a decision rather than an
 * oversight. A client that hardcodes a model name is most clients, and refusing
 * an id it was never told to change would put this service out of reach of every
 * one of them; the id would have to be overridden in two places (a model and a
 * small fast model) before anything could be pointed here at all.
 *
 * Refusing an unknown id also conceals nothing that answering does not state
 * plainly: the response names the model that actually answered, which is
 * human-1 whatever was asked for, and the console shows the person what the
 * caller believed it was buying. A caller that reads the response learns the
 * truth either way, and a caller that does not read it was never going to.
 *
 * A model field that is missing, empty or not a string is still refused, in
 * `parseMessageRequest`: an unknown model is a routing question, a malformed
 * one is a mistake in the request, and the two deserve different answers. This
 * function is where per-caller routing would grow if there were ever more than
 * one queue to route to.
 */
export function resolveModel(requested: string): string {
  return MODELS.some((model) => model.id === requested) ? requested : DEFAULT_MODEL;
}

function isBlockArray(content: unknown): content is ContentBlock[] {
  return Array.isArray(content);
}

/**
 * Validates the parts of a request whose rejection is useful to the caller.
 * Deliberately does not validate optional fields it does not act on
 * (temperature, tool_choice); carrying them through unexamined would be a
 * promise we do not keep, so they are accepted and ignored.
 */
export function parseMessageRequest(body: unknown): MessageRequest {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    invalid('the request body must be a JSON object');
  }
  const raw = body as Record<string, unknown>;

  if (typeof raw.model !== 'string' || raw.model === '') {
    invalid('model: field required');
  }

  if (typeof raw.max_tokens !== 'number' || !Number.isInteger(raw.max_tokens) || raw.max_tokens < 1) {
    invalid('max_tokens: must be an integer of at least 1');
  }

  if (!Array.isArray(raw.messages) || raw.messages.length === 0) {
    invalid('messages: at least one message is required');
  }

  const messages: MessageParam[] = [];
  const seenToolUseIds = new Set<string>();
  let expectedRole: 'user' | 'assistant' = 'user';

  raw.messages.forEach((entry, i) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      invalid(`messages.${i}: must be an object`);
    }
    const message = entry as Record<string, unknown>;
    const role = message.role;
    if (role !== 'user' && role !== 'assistant') {
      invalid(`messages.${i}.role: must be "user" or "assistant"`);
    }
    if (role !== expectedRole) {
      invalid(
        `messages.${i}.role: roles must alternate starting with "user", got "${role}" where "${expectedRole}" was expected`,
      );
    }
    expectedRole = role === 'user' ? 'assistant' : 'user';

    const content = message.content;
    if (typeof content === 'string') {
      if (content.length === 0) invalid(`messages.${i}.content: text content must not be empty`);
      messages.push({ role, content });
      return;
    }
    if (!isBlockArray(content)) {
      invalid(`messages.${i}.content: must be a string or an array of content blocks`);
    }
    if (content.length === 0) invalid(`messages.${i}.content: must not be an empty array`);

    content.forEach((block, j) => {
      if (typeof block !== 'object' || block === null || Array.isArray(block)) {
        invalid(`messages.${i}.content.${j}: must be an object`);
      }
      const b = block as Record<string, unknown>;
      const type = b.type;
      if (typeof type !== 'string') invalid(`messages.${i}.content.${j}.type: field required`);

      switch (type) {
        case 'text':
          if (typeof b.text !== 'string') invalid(`messages.${i}.content.${j}.text: field required`);
          if (b.text.length === 0) {
            // Matching the real API, which refuses rather than storing a blank turn.
            invalid(`messages.${i}.content.${j}: text content blocks must be non-empty`);
          }
          break;
        case 'tool_use': {
          if (typeof b.id !== 'string' || b.id === '') invalid(`messages.${i}.content.${j}.id: field required`);
          if (typeof b.name !== 'string' || b.name === '') {
            invalid(`messages.${i}.content.${j}.name: field required`);
          }
          if (!('input' in b)) invalid(`messages.${i}.content.${j}.input: field required`);
          seenToolUseIds.add(b.id);
          break;
        }
        case 'tool_result': {
          if (typeof b.tool_use_id !== 'string' || b.tool_use_id === '') {
            invalid(`messages.${i}.content.${j}.tool_use_id: field required`);
          }
          if (!seenToolUseIds.has(b.tool_use_id)) {
            invalid(
              `messages.${i}.content.${j}: tool_result references ${b.tool_use_id}, which no preceding tool_use declared`,
            );
          }
          break;
        }
        case 'thinking':
          if (typeof b.thinking !== 'string') {
            invalid(`messages.${i}.content.${j}.thinking: field required`);
          }
          if (typeof b.signature !== 'string' || b.signature === '') {
            invalid(
              `messages.${i}.content.${j}.signature: field required when a thinking block is sent back. ` +
                'Echo the block as it was returned, or drop it from the history.',
            );
          }
          if (!thinkingSignatureValid(b.thinking, b.signature)) {
            invalid(
              `messages.${i}.content.${j}: the thinking block's text does not match its signature. ` +
                'A signed block is the record of what was written, so it cannot be edited and sent back.',
            );
          }
          break;
        default:
          // Images, documents and anything else are carried but not interpreted.
          break;
      }
    });

    messages.push({ role, content: content as ContentBlock[] });
  });

  let tools: ToolDefinition[] | undefined;
  if (raw.tools !== undefined) {
    if (!Array.isArray(raw.tools)) invalid('tools: must be an array');
    tools = raw.tools.map((entry, i) => {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        invalid(`tools.${i}: must be an object`);
      }
      const tool = entry as Record<string, unknown>;
      if (typeof tool.name !== 'string' || !TOOL_NAME_RE.test(tool.name)) {
        invalid(`tools.${i}.name: must match ${TOOL_NAME_RE.source}`);
      }
      if (typeof tool.input_schema !== 'object' || tool.input_schema === null) {
        invalid(`tools.${i}.input_schema: must be a JSON Schema object`);
      }
      const schema = tool.input_schema as Record<string, unknown>;
      if (schema.type !== undefined && schema.type !== 'object') {
        invalid(`tools.${i}.input_schema.type: must be "object"`);
      }
      return tool as ToolDefinition;
    });
    const names = new Set<string>();
    for (const tool of tools) {
      if (names.has(tool.name)) invalid(`tools: duplicate tool name "${tool.name}"`);
      names.add(tool.name);
    }
    if (raw.tool_choice !== undefined && raw.tool_choice !== null) {
      const choice = readToolChoice(raw as unknown as MessageRequest);
      if (choice.mode === 'tool' && !names.has(choice.name)) {
        invalid(
          `tool_choice.name: "${choice.name}" is not one of the tools this request declares` +
            (names.size > 0 ? ` (${[...names].map((n) => `"${n}"`).join(', ')})` : ' (none are declared)'),
        );
      }
      if ((choice.mode === 'tool' || choice.mode === 'any') && names.size === 0) {
        invalid(`tool_choice: this request declares no tools, so tool_choice "${choice.mode}" cannot be satisfied`);
      }
    }
  } else if (raw.tool_choice !== undefined && raw.tool_choice !== null) {
    const choice = readToolChoice(raw as unknown as MessageRequest);
    if (choice.mode === 'tool' || choice.mode === 'any') {
      invalid(`tool_choice: this request declares no tools, so tool_choice "${choice.mode}" cannot be satisfied`);
    }
  }

  if (raw.tool_choice !== undefined && raw.tool_choice !== null) {
    // Read here rather than at use, so a caller learns about a malformed
    // tool_choice on the request it sent rather than on the reply it gets back.
    readToolChoice(raw as unknown as MessageRequest);
  }

  if (raw.stream !== undefined && typeof raw.stream !== 'boolean') {
    invalid('stream: must be a boolean');
  }
  if (raw.system !== undefined && typeof raw.system !== 'string' && !Array.isArray(raw.system)) {
    invalid('system: must be a string or an array of content blocks');
  }
  if (raw.stop_sequences !== undefined) {
    if (!Array.isArray(raw.stop_sequences) || raw.stop_sequences.some((s) => typeof s !== 'string')) {
      invalid('stop_sequences: must be an array of strings');
    }
  }

  return raw as unknown as MessageRequest;
}

/**
 * `parallel` is the inverse of the caller's disable_parallel_tool_use, and it is
 * carried in every form rather than only the named-tool one: a caller who
 * disables parallel calls means it whoever the calls name.
 */
export type ToolChoice =
  | { mode: 'auto'; parallel: boolean }
  | { mode: 'any'; parallel: boolean }
  | { mode: 'none'; parallel: boolean }
  | { mode: 'tool'; name: string; parallel: boolean };

/** Reads the caller's tool_choice. Absent means auto, as in the real API. */
export function readToolChoice(request: MessageRequest): ToolChoice {
  const choice = request.tool_choice;
  if (choice === undefined || choice === null) return { mode: 'auto', parallel: true };
  if (typeof choice !== 'object' || Array.isArray(choice)) {
    invalid('tool_choice: must be an object');
  }
  const raw = choice as Record<string, unknown>;
  const parallel = raw.disable_parallel_tool_use !== true;
  switch (raw.type) {
    case undefined:
    case 'auto':
      return { mode: 'auto', parallel };
    case 'any':
      return { mode: 'any', parallel };
    case 'none':
      return { mode: 'none', parallel };
    case 'tool': {
      if (typeof raw.name !== 'string' || raw.name === '') {
        invalid('tool_choice.name: required when tool_choice.type is "tool"');
      }
      return { mode: 'tool', name: raw.name, parallel };
    }
    default:
      invalid(`tool_choice.type: must be one of auto, any, none, tool — got ${JSON.stringify(raw.type)}`);
  }
}

/** Anthropic-shaped ids: a prefix plus an opaque body. */
export function messageId(): string {
  return 'msg_' + randomBytes(18).toString('base64url');
}

export function toolUseId(): string {
  return 'toolu_' + randomBytes(18).toString('base64url');
}

/**
 * Usage numbers are an estimate and are reported as one. The API has no field
 * for "this was counted differently", so the derivation is documented in the
 * README and the console shows the real character counts beside it.
 */
export function estimateTokens(text: string): number {
  return estimateTokensFromChars(text.length);
}

/**
 * The one estimator. Everything that reports a token count goes through here,
 * so the number a caller is charged against and the number a responder is shown
 * cannot drift apart.
 */
export function estimateTokensFromChars(chars: number): number {
  if (chars === 0) return 0;
  return Math.max(1, Math.ceil(chars / config.charsPerToken));
}

export function requestTextLength(request: MessageRequest): number {
  let total = 0;
  const add = (v: unknown): void => {
    if (typeof v === 'string') total += v.length;
    else if (Array.isArray(v)) v.forEach(add);
    else if (typeof v === 'object' && v !== null) Object.values(v).forEach(add);
  };
  add(request.system);
  add(request.messages);
  add(request.tools);
  return total;
}

/**
 * How much there is in a reply, for the output token count. Tool inputs count:
 * a reply that is one large tool call is not an empty reply.
 */
export function responseTextLength(content: ResponseBlock[]): number {
  let total = 0;
  for (const block of content) {
    const record = block as Record<string, unknown>;
    if (typeof record.text === 'string') total += record.text.length;
    if (typeof record.thinking === 'string') total += record.thinking.length;
    if (record.type === 'tool_use') {
      total += String(record.name ?? '').length + JSON.stringify(record.input ?? {}).length;
    }
  }
  return total;
}

export interface MessageResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: ResponseBlock[];
  stop_reason: StopReason;
  stop_sequence: string | null;
  usage: { input_tokens: number; output_tokens: number };
}

export function buildResponse(input: {
  id: string;
  model: string;
  content: ResponseBlock[];
  stopReason: StopReason;
  stopSequence?: string | null;
  inputTokens: number;
  outputTokens: number;
}): MessageResponse {
  return {
    id: input.id,
    type: 'message',
    role: 'assistant',
    model: input.model,
    content: input.content,
    stop_reason: input.stopReason,
    stop_sequence: input.stopSequence ?? null,
    usage: { input_tokens: input.inputTokens, output_tokens: input.outputTokens },
  };
}

/**
 * A signature over a reasoning block. Deliberately not a copy of the real API's
 * format: it is ours, we can verify it, and pretending otherwise would suggest
 * an interoperability that does not exist.
 */
export function signThinking(thinking: string): string {
  return createHmac('sha256', signingKey()).update(thinking).digest('base64url');
}

export function thinkingSignatureValid(thinking: string, signature: string): boolean {
  const expected = Buffer.from(signThinking(thinking));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

// ---- server-sent events ---------------------------------------------------


export function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export interface StreamBlock {
  index: number;
  block: ContentBlock;
}
