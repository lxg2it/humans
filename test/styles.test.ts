import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * The stylesheets have to parse, and balancing braces is the cheap way to know.
 *
 * This exists because one unbalanced `{` silently killed everything below it in
 * console.css and nothing noticed for fifteen days. The file still returned 200,
 * the page still rendered, the DOM was still correct, and every functional test
 * still passed — because a browser discards what it cannot parse and carries on,
 * so the only symptom was that the console had no layout at all.
 *
 * CSS has one delimiter and no nesting to recover from: the first unmatched `{`
 * swallows every rule after it. That is a property of the format rather than of
 * this file, which is why the check is on all of them and not just the one that
 * broke.
 */

const here = dirname(fileURLToPath(import.meta.url));
const stylesheets = readdirSync(join(here, '..', 'public'))
  .filter((name) => name.endsWith('.css'))
  .sort();

/** Walks the text and returns the line of the first `{` that never closes, or null. */
function unclosedBlock(css: string): { line: number; selector: string } | null {
  let depth = 0;
  let line = 1;
  let openedAt: { line: number; selector: string } | null = null;
  let selectorStart = 0;

  for (let i = 0; i < css.length; i += 1) {
    const ch = css[i];
    if (ch === '\n') line += 1;
    if (ch === '{') {
      depth += 1;
      if (depth === 1) {
        const selector = css.slice(selectorStart, i).trim().split('\n').pop() ?? '';
        openedAt = { line, selector };
      }
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        openedAt = null;
        selectorStart = i + 1;
      }
      // A stray `}` closes the browser's own recovery; it is an error too, but
      // it does not swallow the rest of the file, so it is reported separately.
      if (depth < 0) return { line, selector: 'stray }' };
    }
  }

  return depth === 0 ? null : openedAt;
}

test('every stylesheet is one or more balanced blocks', () => {
  assert.ok(stylesheets.length >= 4, `expected the served stylesheets, found ${stylesheets.join(', ')}`);

  const broken: string[] = [];

  for (const name of stylesheets) {
    const css = readFileSync(join(here, '..', 'public', name), 'utf8');
    const open = unclosedBlock(css);
    if (!open) continue;
    const lines = css.split('\n').length;
    const selector = open.selector || '(a comment or blank line)';
    broken.push(
      `${name}: the block opened at line ${open.line} (${selector}) never closes, so every rule after it ` +
        `is discarded — a browser drops it silently and the page keeps rendering. The file is ${lines} lines.`,
    );
  }

  assert.deepEqual(broken, [], `a stylesheet does not parse:\n  ${broken.join('\n  ')}`);
});
