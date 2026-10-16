import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

/**
 * The console's reading of a request.
 *
 * This file is loaded into a page with a script tag, so it is exercised the way
 * the browser loads it — from the shipped source, into a fresh context with a
 * window — rather than through an import that could drift from what is served.
 * A test that read a copy of this logic would pass while the page ran something
 * else, which is the failure the module exists to prevent: the console showing
 * the caller's shape instead of its meaning, and looking like it is working.
 *
 * The decisions worth asking about are which block is what, what a tool may be
 * called with, and what the answer will carry. None of them need a browser.
 */

function load(): any {
  const sandbox: { window: any } = { window: {} };
  runInNewContext(readFileSync('public/console-reading.js', 'utf8'), sandbox);
  assert.ok(sandbox.window.HumansReading, 'console-reading.js must publish window.HumansReading');
  return sandbox.window.HumansReading;
}

const Reading = load();

/**
 * A value from the module's realm, rebuilt in this one.
 *
 * The module is loaded into a fresh V8 context, so its arrays and objects carry
 * a different prototype, and deepEqual — which compares prototypes — refuses to
 * call them equal even when every value inside them is. Importing a copy of the
 * file would avoid this and would also stop the test from exercising the file the
 * browser loads, which is the trade load() deliberately makes.
 */
const plain = (value: any): any => JSON.parse(JSON.stringify(value));

test('a system prompt sent as blocks is read as blocks, not as JSON', () => {
  // The worst reading the console ever had: a caller attaching a cached document
  // turned a paragraph of instructions into a screenful of punctuation with the
  // words buried inside it.
  const blocks = Reading.system([
    { type: 'text', text: 'You are terse.' },
    { type: 'text', text: 'Never apologise.' },
  ]);
  assert.deepEqual(plain(blocks), [
    { kind: 'text', text: 'You are terse.' },
    { kind: 'text', text: 'Never apologise.' },
  ]);

  // Same words as a plain string: an array with one block and the string must
  // read identically, or the shape the caller chose changes what a person sees.
  assert.deepEqual(plain(Reading.system('You are terse.')), plain(Reading.system([{ type: 'text', text: 'You are terse.' }])));
});

test('what the caller wrote is passed through byte for byte', () => {
  // The module's central claim: the container changes, never the content. A
  // reader deciding how to answer is reading the caller's own words, and a
  // normalised or trimmed version of them is a different request.
  const odd = '  Indented first line.\n\n  second, with trailing space   \n\ttab\n```\nnot markdown-parsed\n```';
  assert.deepEqual(plain(Reading.block({ type: 'text', text: odd })), { kind: 'text', text: odd });
  assert.equal(Reading.content(odd)[0].text, odd);
  assert.equal(Reading.block({ type: 'thinking', thinking: odd }).text, odd);
  // A block about a block: text nested in a tool result keeps its whitespace too.
  const result = Reading.block({ type: 'tool_result', tool_use_id: 'x', content: [{ type: 'text', text: odd }] });
  assert.equal(result.parts[0].text, odd);

  // An empty string is not a paragraph. Rendering one puts a blank gap in the
  // request that the caller never sent, so it is dropped rather than shown.
  assert.deepEqual(plain(Reading.content('')), []);
});

test('a block the reader does not know is shown, loudly, rather than dropped', () => {
  // Silence is the failure mode: a block that vanishes leaves the person reading
  // an incomplete request and no way to tell that anything is missing.
  const unknown = Reading.block({ type: 'future_thing', payload: { a: 1 } });
  assert.equal(unknown.kind, 'note');
  assert.match(unknown.text, /future_thing/);
  assert.match(unknown.text, /"a":1/);

  // A non-object block reaches the same branch rather than throwing.
  assert.equal(Reading.block('raw string as a block').kind, 'note');
});

test('an image says it was not rendered, and which media type it was', () => {
  const note = Reading.block({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } });
  assert.equal(note.kind, 'note');
  assert.match(note.text, /image\/png/);
  assert.match(note.text, /does not render/);
  // The base64 payload must not reach the page: it is megabytes of noise that
  // would be read as the request.
  assert.doesNotMatch(note.text, /AAAA/);
});

test('a tool call shows what the client will execute, exactly', () => {
  const input = { path: '/tmp/a b.txt', options: { depth: 2 }, deep: [[1, 2]] };
  const call = Reading.block({ type: 'tool_use', id: 'toolu_1', name: 'read_file', input });
  assert.equal(call.kind, 'tool-call');
  assert.equal(call.name, 'read_file');
  assert.equal(call.id, 'toolu_1');
  // The raw argument is what the caller's client executes, so it has to be the
  // argument itself and not the console's reading of it.
  assert.equal(call.raw, JSON.stringify(input));
  assert.deepEqual(JSON.parse(call.raw), input);

  // A string argument is prose and is shown as itself; a structured one is
  // pretty-printed and flagged, so a list of objects is not read as a sentence.
  const byName: Record<string, any> = Object.fromEntries(call.args.map((a: any) => [a.name, a]));
  assert.equal(byName.path.value, '/tmp/a b.txt');
  assert.equal(byName.path.json, false);
  assert.equal(byName.options.json, true);
  assert.deepEqual(JSON.parse(byName.options.value), { depth: 2 });

  // A call with no arguments takes nothing, and that is a fact the console needs
  // so it can say so instead of drawing an empty fieldset.
  const none = Reading.block({ type: 'tool_use', name: 'now', input: {} });
  assert.equal(none.takesNothing, true);
  assert.equal(none.raw, '{}');
  // An input that is absent entirely is not the same as an empty object, but
  // neither may render raw as the string "undefined".
  assert.equal(Reading.block({ type: 'tool_use', name: 'now' }).raw, '');
});

test('a declared tool is read into the fields the server planned for it', () => {
  const [withFields, raw] = Reading.tools([
    {
      name: 'schedule',
      description: 'Book a time',
      plan: {
        mode: 'fields',
        fields: [
          { name: 'when', label: 'When', kind: 'text', required: true, multiline: true, description: 'Local time' },
          { name: 'count', kind: 'number', integer: true, minimum: 1, maximum: 5 },
          { name: 'mode', kind: 'enum', options: [{ value: 'fast' }, { value: 'thorough', label: 'Thorough' }] },
        ],
      },
      input_schema: { type: 'object' },
    },
    { name: 'anything', plan: { mode: 'raw', reason: 'the schema has a nested union' }, input_schema: { type: 'object' } },
  ]);

  assert.equal(withFields.mode, 'fields');
  assert.equal(withFields.takesNothing, false);
  assert.deepEqual(plain(withFields.fields[0]), {
    name: 'when',
    label: 'When',
    required: true,
    type: 'text, several lines',
    choices: [],
    bounds: '',
    description: 'Local time',
    example: '',
  });
  // Numbers say what they are in words a person would use, including the bounds.
  assert.equal(withFields.fields[1].type, 'whole number');
  assert.equal(withFields.fields[1].bounds, 'min 1, max 5');
  // An enum shows its values, and a label only when it differs from the value.
  assert.deepEqual(plain(withFields.fields[2].choices), ['fast', 'thorough (Thorough)']);

  // A tool that could not be shown as fields keeps the reason and its schema:
  // the person can check the console's reading against the caller's own words.
  assert.equal(raw.mode, 'raw');
  assert.deepEqual(plain(raw.fields), []);
  assert.equal(raw.rawReason, 'the schema has a nested union');
  assert.match(raw.schema, /"type": "object"/);
});

test('a tool with no declared fields is read as taking nothing', () => {
  const [tool] = Reading.tools([{ name: 'now', plan: { mode: 'fields', fields: [] }, input_schema: {} }]);
  assert.equal(tool.takesNothing, true);
});

test('each way a caller can refuse a tool call carries its own reason', () => {
  const tools = [{ name: 'one' }, { name: 'two' }];

  // One: the caller named a single tool and forbids the others.
  const named = Reading.toolButtons(tools, [], { mode: 'tool', name: 'two' });
  assert.equal(named.canAdd, false);
  assert.match(named.refusal, /requires two/);
  assert.equal(named.buttons[0].addable, false);
  // The refusal is on every button, because it is not about which tool was
  // chosen — the two constraints are different and a person needs to know which
  // of them refused them.
  assert.equal(named.buttons[1].why, named.buttons[0].why);

  // Two: any tool is allowed, but only one call per turn.
  const onePerTurn = Reading.toolButtons(tools, ['one'], { mode: 'auto', parallel: false });
  assert.equal(onePerTurn.canAdd, false);
  assert.match(onePerTurn.refusal, /one tool call per turn/);
  assert.match(onePerTurn.note, /optional/);
  // With nothing chosen yet there is no refusal to make: the constraint bites on
  // the second call, not on the first.
  assert.equal(Reading.toolButtons(tools, [], { mode: 'auto', parallel: false }).canAdd, true);

  // Three: no calls at all.
  const none = Reading.toolButtons(tools, [], { mode: 'none' });
  assert.equal(none.canAdd, false);
  assert.equal(none.note, 'the caller accepts no tool calls');

  // And the control: an ordinary caller refuses nothing, so a refusal appearing
  // here means a constraint, not a constant.
  const free = Reading.toolButtons(tools, ['one'], { mode: 'auto', parallel: true });
  assert.equal(free.canAdd, true);
  assert.equal(free.refusal, '');
  assert.ok(free.buttons.every((b: any) => b.addable && b.why === ''));

  // A request with no tools declared cannot have one added to it.
  assert.equal(Reading.toolButtons([], [], { mode: 'auto' }).canAdd, false);
});

test('an answer with reasoning and no text is a warning, not an empty answer', () => {
  // A caller that reads only the response text receives nothing at all from a
  // reply that carries reasoning alone. Reporting that as "empty" would lose the
  // distinction between a draft that exists and one that does not.
  const reasoningOnly = Reading.channels({ response: '', reasoning: 'Weighing two options.' });
  assert.equal(reasoningOnly.empty, false);
  assert.match(reasoningOnly.warning, /reasoning and no response text/);
  assert.equal(reasoningOnly.tabs.length, 2);
  assert.deepEqual(plain(reasoningOnly.tabs.map((t: any) => t.key)), ['response', 'reasoning']);
  assert.equal(reasoningOnly.tabs[1].chars, 'Weighing two options.'.length);

  // The control, in both directions: a normal answer carries no warning, and a
  // draft with nothing in it does.
  assert.equal(Reading.channels({ response: 'Yes.', reasoning: '' }).warning, '');
  assert.equal(Reading.channels({ response: 'Yes.' }).empty, false);
  assert.equal(Reading.channels({}).empty, true);
  // Reasoning with text alongside it is fine and needs no warning.
  assert.equal(Reading.channels({ response: 'Yes.', reasoning: 'because' }).warning, '');
});
