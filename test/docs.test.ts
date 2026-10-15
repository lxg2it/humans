import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SOURCES, loadDocuments, renderMarkdown, resolveLink } from '../src/docs.ts';
import { harness } from './helpers.ts';

/**
 * The documents are the one part of this service that is prose, and the part
 * most likely to be edited by someone who is not thinking about a renderer. So
 * the tests here are of two kinds: that each construct produces the markup it
 * should, and that the things which must never happen — an unescaped tag, a
 * `javascript:` link, a document that is not being served where it says — do
 * not happen even when a document contains them.
 */

const render = (markdown: string, file = 'DISCLAIMER.md'): string => renderMarkdown(markdown, file);

test('headings, paragraphs and emphasis', () => {
  const html = render('# One\n\nsome *emphasis* and **strength** in a paragraph\nthat wrapped.\n\n## Two\n\n### Three\n');
  assert.equal(
    html,
    [
      '<h1>One</h1>',
      '<p>some <em>emphasis</em> and <strong>strength</strong> in a paragraph that wrapped.</p>',
      '<h2>Two</h2>',
      '<h3>Three</h3>',
    ].join('\n'),
  );
});

test('underscores are identifiers, not italics', () => {
  // The documents are full of names like this one. A renderer that treats `_`
  // as emphasis turns them into prose, and this is the guard for that choice.
  const html = render('The pool is `HUMANS_POOL_SATS` and the guarantee is HUMANS_GUARANTEE_SATS.');
  assert.match(html, /<code>HUMANS_POOL_SATS<\/code>/);
  assert.match(html, /HUMANS_GUARANTEE_SATS\./);
  assert.ok(!html.includes('<em>'), 'no emphasis should have been produced');
});

test('lists: both kinds, with a wrapped line folded into its item', () => {
  const html = render('- one\n- two\n  continued here\n\n1. first\n2. second\n');
  assert.equal(
    html,
    '<ul><li>one</li><li>two continued here</li></ul>\n<ol><li>first</li><li>second</li></ol>',
  );
});

test('blockquote, rule and fenced code', () => {
  const html = render('> quoted\n> twice\n\n---\n\n```json\n{ "a": "<b>" }\n```\n');
  assert.equal(
    html,
    [
      '<blockquote><p>quoted twice</p></blockquote>',
      '<hr />',
      '<pre><code class="language-json">{ &quot;a&quot;: &quot;&lt;b&gt;&quot; }</code></pre>'.replace(/&quot;/g, '"'),
    ].join('\n'),
  );
  // Inside a fence, markup is literal — including the tag that is escaped above.
  assert.ok(!html.includes('<b>'), 'a tag inside a code fence must not survive as markup');
});

test('a document cannot inject markup', () => {
  const hostile = 'Before <script>alert(1)</script> after <img src=x onerror=alert(2)>';
  const html = render(hostile);
  assert.ok(!html.includes('<script>'), 'a script tag survived rendering');
  assert.ok(!html.includes('<img'), 'an img tag survived rendering');
  // The control: the text is still there, escaped, so a renderer that dropped
  // the line entirely would not pass this test.
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('a document cannot inject a link scheme', () => {
  const html = render('[click](javascript:alert(1)) and [ok](https://example.com/x)');
  assert.ok(!html.includes('href="javascript:'), 'a javascript: URL reached an href');
  assert.match(html, /click/, 'the label should survive as text');
  assert.match(html, /href="https:\/\/example\.com\/x"/);
});

test('a link to a document we serve becomes a link to its page', () => {
  const html = render('See [the money](the-money.md) and [back](../DISCLAIMER.md).', 'docs/answering.md');
  assert.equal(
    html,
    '<p>See <a href="/money">the money</a> and <a href="/disclaimer">back</a>.</p>',
  );
});

test('every link in the real documents resolves, and none of them is left pointing at a file', async () => {
  // The documents are edited by hand, so this reads the files themselves rather
  // than samples: a link that a reader would see as a repository path is the
  // thing this whole renderer exists to avoid.
  //
  // Internal links are followed rather than matched against a list. A list was
  // the first version and it was wrong twice over: it could not express a link
  // to a page that is rendered rather than written (/answer, /build, /pool), and
  // it would have gone on agreeing with itself after a route was renamed. Asking
  // the running service is the question the check is actually about.
  const instance = await harness();
  try {
    for (const source of SOURCES) {
      const markdown = readFileSync(new URL(`../${source.file}`, import.meta.url), 'utf8');
      for (const match of markdown.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
        const href = resolveLink(match[1] ?? '', source.file);
        assert.ok(!href.endsWith('.md'), `${source.file}: ${match[1]} still points at a Markdown file`);
        if (/^https?:/.test(href) || href.startsWith('#')) continue;

        const response = await instance.call(href.split('#')[0]!);
        assert.equal(
          response.status,
          200,
          `${source.file}: ${match[1]} resolved to ${href}, which answers ${response.status}`,
        );
      }
    }
  } finally {
    await instance.close();
  }
});

test('resolveLink: ours goes to the page, theirs goes to the repository', () => {
  const cases: Array<[string, string, string]> = [
    ['docs/the-money.md', 'DISCLAIMER.md', '/money'],
    ['../DISCLAIMER.md', 'docs/the-money.md', '/disclaimer'],
    ['./docs/answering.md', 'DISCLAIMER.md', '/answering'],
    ['docs/the-money.md#the-commitment', 'DISCLAIMER.md', '/money#the-commitment'],
    ['LICENSE', 'DISCLAIMER.md', 'https://github.com/lxg2it/humans/blob/master/LICENSE'],
    // Not a document we serve: it stays a repository link rather than becoming
    // a site route, which is the half of this the served cases cannot show.
    ['README.md', 'DISCLAIMER.md', 'https://github.com/lxg2it/humans/blob/master/README.md'],
    ['https://example.com/x', 'DISCLAIMER.md', 'https://example.com/x'],
    ['/money', 'DISCLAIMER.md', '/money'],
    ['#anchor', 'DISCLAIMER.md', '#anchor'],
  ];
  for (const [href, fromFile, expected] of cases) {
    assert.equal(resolveLink(href, fromFile), expected, `${href} from ${fromFile}`);
  }
});

test('every document has a distinct route and a file that exists', () => {
  const routes = SOURCES.map((source) => source.route);
  assert.equal(new Set(routes).size, routes.length, 'routes must be distinct');
  for (const source of SOURCES) {
    assert.match(source.route, /^\/[a-z]+$/, `${source.route} should be a plain path`);
    assert.ok(readFileSync(new URL(`../${source.file}`, import.meta.url), 'utf8').length > 0);
  }
});

test('a missing document stops the boot rather than the page', () => {
  const dir = mkdtempSync(join(tmpdir(), 'humans-docs-'));
  assert.throws(() => loadDocuments(dir), /cannot read DISCLAIMER\.md/);

  // The control: the same directory with the file present loads, so the throw
  // above is about the missing file and not about the directory.
  writeFileSync(join(dir, 'DISCLAIMER.md'), '# Disclaimer\n\nHello.\n');
  assert.throws(() => loadDocuments(dir), /cannot read docs\/the-money\.md/);
});

test('the served pages are the documents, rendered', async () => {
  const instance = await harness();
  try {
    const documents = loadDocuments();
    for (const document of documents) {
      const response = await instance.call(document.route);
      assert.equal(response.status, 200, `${document.route} should be served`);
      assert.match(String(response.headers.get('content-type')), /^text\/html/, `${document.route} content type`);
      const heading = readFileSync(new URL(`../${document.file}`, import.meta.url), 'utf8')
        .split('\n')
        .find((line) => line.startsWith('# '))!
        .slice(2);
      assert.ok(
        String(response.body).includes(heading),
        `${document.route} should contain the first heading of ${document.file}`,
      );
    }

    // The control for the loop above: each page carries its own document. If the
    // routes were wired to one file, the check above would still pass.
    const money = await instance.call('/money');
    const disclaimer = await instance.call('/disclaimer');
    assert.ok(String(money.body).includes('The unit is one answer'), 'the money page should have the money');
    assert.ok(!String(money.body).includes('Do not send secrets'), 'the money page should not have the disclaimer');
    assert.ok(String(disclaimer.body).includes('Do not send secrets'), 'the disclaimer page should have the disclaimer');
  } finally {
    await instance.close();
  }
});

test('a page nothing is served at is still the API 404', async () => {
  const instance = await harness();
  try {
    const response = await instance.call('/disclaimers');
    assert.equal(response.status, 404);
    assert.equal(response.body.error.type, 'not_found_error');

    // The control: the path one character away is a document, so the 404 above
    // is about the name and not about documents being unreachable.
    assert.equal((await instance.call('/disclaimer')).status, 200);
  } finally {
    await instance.close();
  }
});

test('the disclaimer links to the money page on this site', async () => {
  const instance = await harness();
  try {
    const page = String((await instance.call('/disclaimer')).body);
    assert.match(page, /<a href="\/money">docs\/the-money\.md<\/a>/);

    const money = String((await instance.call('/money')).body);
    assert.match(money, /<a href="\/disclaimer">\.\.\/DISCLAIMER\.md<\/a>/);
  } finally {
    await instance.close();
  }
});
