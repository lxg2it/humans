import {
  RequestError,
  STOP_REASONS,
  estimateTokensFromChars,
  readToolChoice,
  signThinking,
  toolUseId,
  type ToolUseBlock,
  type ResponseBlock,
  type MessageRequest,
  type StopReason,
  type ToolDefinition,
} from './anthropic.ts';
import { validateAgainst } from './schema-form.ts';

/**
 * Turning a responder's submission into the content array a caller receives.
 *
 * This is the one place where a person's typing becomes an API response, so it
 * is also the place where the contract is enforced. A tool call has to name a
 * tool the caller declared, carry an input the caller's own schema accepts, and
 * respect the caller's tool_choice. Getting any of those wrong produces a
 * response that looks plausible and breaks the client reading it.
 */

export interface SubmittedToolCall {
  id?: unknown;
  name?: unknown;
  input?: unknown;
}

export interface SubmitBody {
  thinking?: unknown;
  text?: unknown;
  tools?: unknown;
  stop_reason?: unknown;
  stop_sequence?: unknown;
}

export interface BuiltReply {
  content: ResponseBlock[];
  thinking: string;
  text: string;
  toolCalls: ToolUseBlock[];
  stopReason: StopReason;
  stopSequence: string | null;
  /** Tools whose schema could not be compiled, so their input went unchecked. */
  unchecked: string[];
}

function invalid(message: string, details?: Array<{ field: string; message: string }>): never {
  throw new RequestError(400, 'invalid_request_error', message, details);
}

const CUSTOM_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function buildReply(input: {
  request: MessageRequest;
  declaredTools: ToolDefinition[];
  maxTokens: number;
  body: SubmitBody;
}): BuiltReply {
  const { request, declaredTools, body } = input;
  const choice = readToolChoice(request);
  const byName = new Map(declaredTools.map((tool) => [tool.name, tool]));

  const thinking = typeof body.thinking === 'string' ? body.thinking : '';
  const text = typeof body.text === 'string' ? body.text : '';
  if (body.thinking !== undefined && typeof body.thinking !== 'string') {
    invalid('thinking: must be a string');
  }
  if (body.text !== undefined && typeof body.text !== 'string') {
    invalid('text: must be a string');
  }

  // ---- tool calls ----
  const rawTools = body.tools === undefined ? [] : body.tools;
  if (!Array.isArray(rawTools)) invalid('tools: must be an array');
  if (rawTools.length > 128) invalid('tools: at most 128 calls are accepted in one reply');
  if (choice.mode === 'none' && rawTools.length > 0) {
    invalid('this request sets tool_choice to "none", so no tool calls may be returned');
  }
  // Applies to every mode, not just a named tool: disable_parallel_tool_use is
  // the caller saying their client runs one call per turn.
  if (!choice.parallel && rawTools.length > 1) {
    invalid('this request sets disable_parallel_tool_use, so only one tool call may be returned');
  }
  if (choice.mode === 'tool') {
    const called = rawTools.filter((entry) => asRecord(entry)?.name === choice.name).length;
    if (called === 0) {
      invalid(`this request requires a call to "${choice.name}", and none was made`);
    }
    if (rawTools.length > called) {
      invalid(`this request requires "${choice.name}", and only that tool may be called`);
    }
  }
  if (choice.mode === 'any' && rawTools.length === 0) {
    invalid('this request requires at least one tool call (tool_choice "any")');
  }

  const seenIds = new Set<string>();
  const toolCalls: ToolUseBlock[] = [];
  const unchecked: string[] = [];
  const details: Array<{ field: string; message: string }> = [];

  rawTools.forEach((entry, index) => {
    const call = asRecord(entry);
    if (!call) invalid(`tools.${index}: must be an object`);
    const submitted = call as SubmittedToolCall;

    const name = submitted.name;
    if (typeof name !== 'string' || name === '') {
      invalid(`tools.${index}.name: field required`);
    }
    const tool = byName.get(name);
    if (!tool) {
      const declared = declaredTools.map((t) => t.name).sort();
      invalid(
        `tools.${index}.name: "${name}" is not a tool this request declares. Declared: ${
          declared.length > 0 ? declared.map((n) => `"${n}"`).join(', ') : '(none)'
        }`,
      );
    }

    const callInput = asRecord(submitted.input);
    if (!callInput) {
      invalid(
        `tools.${index}.input: must be a JSON object`,
        [{ field: `tool.${index}.input`, message: 'must be a JSON object' }],
      );
    }

    // The caller wrote the schema; the caller's client will run the tool. An
    // input that fails it is a call that cannot work, so it is refused here
    // rather than sent.
    const result = validateAgainst(tool.input_schema, callInput);
    if (!result.checked) {
      unchecked.push(name);
    } else if (!result.valid) {
      for (const error of result.errors) {
        details.push({ field: `tool.${index}.input${error.path === '(root)' ? '' : error.path}`, message: error.message });
      }
    }

    let id: string;
    if (submitted.id === undefined || submitted.id === null || submitted.id === '') {
      id = toolUseId();
    } else if (typeof submitted.id !== 'string' || !CUSTOM_ID_RE.test(submitted.id)) {
      invalid(`tools.${index}.id: must match ${CUSTOM_ID_RE.source}`);
    } else {
      id = submitted.id;
    }
    if (seenIds.has(id)) invalid(`tools.${index}.id: "${id}" is used twice in this reply`);
    seenIds.add(id);

    toolCalls.push({ type: 'tool_use', id, name, input: callInput });
  });

  if (details.length > 0) {
    invalid(
      `the tool input does not satisfy the schema this request declared: ${details
        .map((d) => `${d.field} ${d.message}`)
        .join('; ')}`,
      details,
    );
  }

  if (thinking === '' && text === '' && toolCalls.length === 0) {
    invalid('a reply must contain something: reasoning, text, or at least one tool call');
  }

  // ---- stop reason ----
  let stopReason: StopReason;
  if (toolCalls.length > 0) {
    // Derivable, so it is not asked of the responder: a client that receives
    // tool calls has to execute them, and a reply claiming end_turn alongside
    // them would send it down the wrong branch.
    stopReason = 'tool_use';
    if (body.stop_reason !== undefined && body.stop_reason !== 'tool_use') {
      invalid(`stop_reason: must be "tool_use" when tool calls are present, got ${JSON.stringify(body.stop_reason)}`);
    }
  } else if (body.stop_reason === undefined) {
    stopReason = 'end_turn';
  } else if (typeof body.stop_reason === 'string' && (STOP_REASONS as readonly string[]).includes(body.stop_reason)) {
    stopReason = body.stop_reason as StopReason;
    if (stopReason === 'tool_use') {
      invalid('stop_reason: "tool_use" requires at least one tool call');
    }
  } else {
    invalid(`stop_reason: must be one of ${STOP_REASONS.join(', ')}`);
  }

  let stopSequence: string | null = null;
  if (stopReason === 'stop_sequence') {
    const declared = request.stop_sequences ?? [];
    if (typeof body.stop_sequence !== 'string' || body.stop_sequence === '') {
      invalid('stop_sequence: required when stop_reason is "stop_sequence"');
    }
    if (declared.length > 0 && !declared.includes(body.stop_sequence)) {
      invalid(
        `stop_sequence: "${body.stop_sequence}" is not one of the sequences this request declared (${declared
          .map((s) => JSON.stringify(s))
          .join(', ')})`,
      );
    }
    stopSequence = body.stop_sequence;
  }

  // ---- budget ----
  const replyJson = JSON.stringify(toolCalls.map((call) => call.input));
  const chars = thinking.length + text.length + replyJson.length;
  const estimated = estimateTokensFromChars(chars);
  if (estimated > input.maxTokens) {
    invalid(
      `this reply is about ${estimated} tokens and the caller's max_tokens is ${input.maxTokens}. ` +
        `Trim it, or ask the caller to raise the limit.`,
    );
  }

  const content: ResponseBlock[] = [];
  if (thinking !== '') {
    content.push({ type: 'thinking', thinking, signature: signThinking(thinking) });
  }
  if (text !== '') {
    content.push({ type: 'text', text });
  }
  content.push(...toolCalls);

  return {
    content,
    thinking,
    text,
    toolCalls,
    stopReason,
    stopSequence,
    unchecked,
  };
}
