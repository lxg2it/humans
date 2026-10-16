/*
 * Reading a request.
 *
 * The console shows a person what a machine sent. Everything in this service is
 * written by programs for programs: a system prompt arrives as an array of
 * content blocks, a tool call as a JSON object inside an argument, a tool's
 * shape as JSON Schema. Dumping that into a <pre> is a faithful transcription
 * and a poor reading — the person is left holding a machine's shape in their
 * head while they decide what to type back.
 *
 * So this file turns a request into a reader's shape: paragraphs, labelled
 * fields, one line per thing the caller permits. It is deliberately DOM-free
 * and returns plain data, because the decisions worth testing are which block
 * is what, what a tool may be called with, and what the answer will carry —
 * none of which need a browser to ask about.
 *
 * It never paraphrases. Every string a caller wrote is passed through byte for
 * byte, and no value is re-typed, rounded or reformatted; what changes is the
 * container, never the content.
 */
(() => {
  'use strict';

  const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
  const text = (value) => (typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value));
  const list = (value) => (Array.isArray(value) ? value : []);

  function imageNote(block) {
    const media = isObject(block.source) ? text(block.source.media_type) : '';
    return `[image${media ? ` ${media}` : ''} — the console does not render it]`;
  }

  /**
   * One argument of a tool call, as a label and a value.
   *
   * A string is shown as itself — the reader is looking at what the machine
   * decided, and quoting every string would be noise. Anything structured is
   * pretty-printed and flagged, so a value that is a list of objects is not
   * mistaken for a line of prose.
   */
  function argument(name, value) {
    if (typeof value === 'string') return { name, value, json: false, empty: value === '' };
    if (value === undefined) return { name, value: '', json: false, empty: true };
    if (typeof value === 'object' && value !== null) {
      return { name, value: JSON.stringify(value, null, 2), json: true, empty: false };
    }
    return { name, value: String(value), json: false, empty: false };
  }

  function toolResult(block) {
    const parts = [];
    const content = block.content;
    if (typeof content === 'string') {
      if (content !== '') parts.push({ kind: 'text', text: content });
    } else if (Array.isArray(content)) {
      for (const inner of content) {
        if (isObject(inner) && inner.type === 'text') parts.push({ kind: 'text', text: text(inner.text) });
        else if (isObject(inner) && inner.type === 'image') parts.push({ kind: 'note', text: imageNote(inner) });
        else parts.push({ kind: 'note', text: JSON.stringify(inner) });
      }
    } else if (content !== undefined && content !== null) {
      parts.push({ kind: 'text', text: JSON.stringify(content) });
    }
    const isError = block.is_error === true;
    return {
      kind: 'tool-result',
      id: text(block.tool_use_id),
      isError,
      label: isError ? 'tool returned an error' : 'tool result',
      parts,
      chars: parts.reduce((total, part) => total + part.text.length, 0),
    };
  }

  /** One content block, as the reader should meet it. */
  function block(entry) {
    if (!isObject(entry)) return { kind: 'note', text: text(entry) };
    switch (entry.type) {
      case 'text':
        return { kind: 'text', text: text(entry.text) };
      case 'thinking':
        return { kind: 'reasoning', text: text(entry.thinking) };
      case 'tool_use': {
        const args = [];
        if (isObject(entry.input)) {
          for (const [name, value] of Object.entries(entry.input)) args.push(argument(name, value));
        }
        return {
          kind: 'tool-call',
          name: text(entry.name),
          id: text(entry.id),
          args,
          // Shown under the fields rather than instead of them: the fields are
          // for reading, and this is what the caller's client will execute.
          raw: entry.input === undefined ? '' : JSON.stringify(entry.input),
          takesNothing: args.length === 0,
        };
      }
      case 'tool_result':
        return toolResult(entry);
      case 'image':
        return { kind: 'note', text: imageNote(entry) };
      default:
        return { kind: 'note', text: JSON.stringify(entry) };
    }
  }

  /** A message's content, whichever of the three shapes the caller used. */
  function content(value) {
    if (typeof value === 'string') return value === '' ? [] : [{ kind: 'text', text: value }];
    if (Array.isArray(value)) return value.map(block);
    if (value === undefined || value === null) return [];
    return [{ kind: 'note', text: JSON.stringify(value, null, 2) }];
  }

  /**
   * The system prompt.
   *
   * It is a string in most requests and an array of blocks in the ones that
   * matter — a caller that attaches a cached document, or a tool definition, or
   * a reasoning prefill. Showing the array as JSON was the console's worst
   * reading: a paragraph of instructions became a screenful of punctuation with
   * the words buried inside it.
   */
  function system(value) {
    if (value === undefined || value === null || value === '') return [];
    if (typeof value === 'string') return [{ kind: 'text', text: value }];
    if (Array.isArray(value)) return value.map(block);
    return [{ kind: 'note', text: JSON.stringify(value, null, 2) }];
  }

  const TYPE_WORDS = {
    text: 'text',
    enum: 'one of',
    boolean: 'yes or no',
    number: 'number',
    'string-list': 'list of values, one per line',
  };

  /** One declared field of a tool, in words rather than in schema keywords. */
  function fieldLine(spec) {
    const kind = text(spec.kind);
    const choices = kind === 'enum' ? list(spec.options).map((option) => {
      const value = text(option && option.value);
      const label = text(option && option.label);
      return label !== '' && label !== value ? `${value} (${label})` : value;
    }) : [];
    const bounds = [];
    if (spec.minimum !== undefined && spec.minimum !== null) bounds.push(`min ${spec.minimum}`);
    if (spec.maximum !== undefined && spec.maximum !== null) bounds.push(`max ${spec.maximum}`);
    let type = TYPE_WORDS[kind] || kind || 'value';
    if (kind === 'text' && spec.multiline === true) type = 'text, several lines';
    if (kind === 'number' && spec.integer === true) type = 'whole number';
    return {
      name: text(spec.name),
      label: text(spec.label) || text(spec.name),
      required: spec.required === true,
      type,
      choices,
      bounds: bounds.join(', '),
      description: text(spec.description),
      example: text(spec.example),
    };
  }

  /**
   * The tools a caller declared, as something a person can decide about.
   *
   * The server has already done the hard part — planForm() reads each JSON
   * Schema once and says whether it can be shown as fields or has to be JSON.
   * This reads that plan the rest of the way, and keeps the raw schema available
   * underneath: a person who wants to check the console's reading against the
   * caller's own words should be able to, and should not have to trust it.
   */
  function tools(entries) {
    return list(entries).filter(isObject).map((tool) => {
      const plan = isObject(tool.plan) ? tool.plan : null;
      const mode = plan ? text(plan.mode) : 'raw';
      const fields = mode === 'fields' ? list(plan.fields).filter(isObject).map(fieldLine) : [];
      return {
        name: text(tool.name),
        description: text(tool.description),
        mode,
        fields,
        takesNothing: mode === 'fields' && fields.length === 0,
        rawReason: mode === 'raw' ? text(plan.reason) : '',
        schema: JSON.stringify(tool.input_schema === undefined ? {} : tool.input_schema, null, 2),
      };
    });
  }

  /**
   * What can be added to this answer, and what the caller will accept.
   *
   * Three constraints come from the caller and they are not the same constraint:
   * tool_choice can name one tool and forbid the others, disable_parallel_tool_use
   * limits the reply to one call whatever it is, and mode "none" means no calls
   * at all. A control that only greys out the wrong choice leaves a person
   * guessing which of the three refused them, so each refusal carries its reason
   * and the note says the same thing in one line.
   *
   * All three refuse here, including "none" — which the console also handles by
   * hiding the section. Both, because they answer different questions: hiding is
   * this page's decision about what to draw, and the refusal is this function's
   * answer to whether the caller would accept a call at all. Without the second,
   * a return value saying "the caller accepts no tool calls" also said a call
   * could be added, and any second caller of this function would have offered
   * live buttons for a request the server answers with a 400.
   */
  function toolButtons(entries, chosen, choice) {
    const declared = list(entries).filter(isObject).map((tool) => ({
      name: text(tool.name),
      description: text(tool.description),
    }));
    const chosenNames = list(chosen).map((name) => text(name));
    const mode = choice && typeof choice.mode === 'string' ? choice.mode : 'auto';
    const named = choice ? text(choice.name) : '';
    const onePerTurn = mode !== 'tool' && Boolean(choice) && choice.parallel === false;

    let refusal = '';
    if (mode === 'tool') refusal = `the caller requires ${named || 'one tool'}, and only that one`;
    else if (mode === 'none') refusal = 'the caller accepts no tool calls';
    else if (onePerTurn && chosenNames.length > 0) refusal = 'this caller runs one tool call per turn';

    const buttons = declared.map((tool) => ({
      name: tool.name,
      description: tool.description,
      addable: refusal === '',
      why: refusal,
    }));

    let note = '';
    if (mode === 'tool') note = `the caller requires ${named || 'one tool'}, and only that`;
    else if (mode === 'any') {
      note = onePerTurn
        ? 'the caller requires exactly one tool call'
        : 'the caller requires at least one tool call';
    } else if (mode === 'none') note = 'the caller accepts no tool calls';
    else note = onePerTurn
      ? 'optional — the caller runs one tool call per turn'
      : 'optional — the caller will run whatever you choose';

    return { buttons, note, canAdd: refusal === '' && declared.length > 0, refusal };
  }

  /**
   * The two channels an answer can be written in.
   *
   * A reply carries a signed reasoning block and a response text, and the
   * console used to put them in two boxes on one page — a small thing that
   * quietly implied they are the same kind of thing, when one is what the caller
   * reads and the other is usually discarded. Reading them as channels, one at a
   * time, with the other channel's size always in view, keeps the difference
   * visible: an answer with reasoning and no text is a real answer that most
   * callers will receive as nothing, and that is worth saying before it is sent
   * rather than after.
   */
  function channels(draft) {
    const response = text(draft && draft.response);
    const reasoning = text(draft && draft.reasoning);
    const tabs = [
      {
        key: 'response',
        label: 'Response',
        chars: response.length,
        note: 'Text. This is what the caller receives as the answer.',
      },
      {
        key: 'reasoning',
        label: 'Reasoning',
        chars: reasoning.length,
        note:
          'A signed reasoning block, sent before the text. Most callers ignore it, and one that reads only the ' +
          'response text will receive nothing at all from a reply that carries reasoning alone.',
      },
    ];
    let warning = '';
    if (reasoning !== '' && response === '') {
      warning =
        'This answer has reasoning and no response text. A caller that ignores reasoning will receive an empty ' +
        'reply — write something in Response too, or send this knowing that.';
    }
    return { tabs, warning, empty: response === '' && reasoning === '' };
  }

  const Reading = { system, content, block, tools, toolButtons, channels };

  window.HumansReading = Reading;
})();
