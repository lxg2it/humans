import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.ts';
import { SOURCES } from '../src/docs.ts';
import { NAV } from '../src/layout.ts';
import { createPoolReader } from '../src/pool.ts';
import { landingPage } from '../src/site.ts';
import { publicStats } from '../src/stats.ts';
import { harness, messageRequest } from './helpers.ts';

/**
 * The landing pages.
 *
 * These are the pages a stranger sees, and they make claims — about alignment,
 * about who reads what, about a number of satoshis. A claim on a public page is
 * a promise the service has to keep, so the ones the documents make mandatory
 * are asserted here rather than trusted to survive the next edit.
 */

/** Internal links only: an anchor is not a page and a repository link is not ours. */
function internalLinks(html: string): string[] {
  return [...html.matchAll(/href="(\/[^"#]*)"/g)].map((match) => match[1]!);
}

test('the front door is the landing page and the console is behind it', async () => {
  const h = await harness();
  try {
    const root = await h.call('/');
    assert.equal(root.status, 200);
    assert.match(root.body as string, /The model is a person\./);
    // The falsifier for the move: if `/` still served the console, every
    // assertion above would still pass and the landing page would be dead code.
    assert.doesNotMatch(root.body as string, /<title>console<\/title>/);

    const console_ = await h.call('/console');
    assert.equal(console_.status, 200, 'the console must still be reachable after moving off /');
    assert.match(console_.body as string, /<title>console<\/title>/);
  } finally {
    await h.close();
  }
});

test('the landing page carries the claims the documents require of it', async () => {
  const h = await harness();
  try {
    const html = (await h.call('/')).body as string;

    // "A person reads what you send" is the most important sentence on the site
    // (DISCLAIMER.md), and it has to be on the page rather than one click away.
    assert.match(html, /read in full by a human being/);
    assert.match(html, /A person reads what you send/);

    // The joke is that these are the real answers, not a disclaimer parody.
    assert.match(html, /unaligned/);
    assert.match(html, /Guardrails<\/dt>\s*<dd><strong>None\.<\/strong>/);

    // The money is never the joke, and the figure comes from configuration: a
    // page with a hardcoded guarantee starts lying the first time the value is
    // changed.
    assert.match(html, new RegExp(`${config.guaranteeSats} satoshis`));
    assert.match(html, /not a wage/);
    // ...and it must not be advertised as a way to earn, which the-money.md
    // forbids in as many words.
    assert.doesNotMatch(html, /earn money|per hour|hourly|side hustle|income/i);
  } finally {
    await h.close();
  }
});

test('every internal link on every landing page resolves', async () => {
  const h = await harness();
  try {
    for (const path of ['/', '/answer', '/build']) {
      const page = await h.call(path);
      assert.equal(page.status, 200, `${path} is not served`);
      const links = [...new Set(internalLinks(page.body as string))];
      assert.ok(links.length > 0, `${path} has no internal links, which is suspicious rather than good`);
      for (const link of links) {
        const target = await h.call(link);
        assert.equal(target.status, 200, `${path} links to ${link}, which answers ${target.status}`);
      }
    }
  } finally {
    await h.close();
  }
});

test('the navigation covers every document the service serves', async () => {
  const h = await harness();
  try {
    const hrefs = NAV.map((entry) => entry.href);
    for (const source of SOURCES) {
      assert.ok(hrefs.includes(source.route), `${source.route} is served but not in the navigation`);
    }
    // And the other direction, which is the one that actually breaks: a nav
    // entry pointing at a page that does not exist 404s on every page of the
    // site at once.
    for (const href of hrefs) {
      const response = await h.call(href);
      assert.equal(response.status, 200, `the navigation links to ${href}, which answers ${response.status}`);
    }
  } finally {
    await h.close();
  }
});

test('/api/stats publishes aggregates and nothing that identifies anyone', async () => {
  const h = await harness();
  try {
    const response = await h.call('/api/stats');
    assert.equal(response.status, 200);
    const stats = response.body as Record<string, unknown>;

    // The exact key set, not a subset: this is a public endpoint, and a field
    // added later would be published without anyone deciding to publish it.
    // Failing here is the point — it makes the decision explicit.
    assert.deepEqual(Object.keys(stats).sort(), [
      'answers_total',
      'calls_total',
      'days',
      'guarantee_sats',
      'median_answer_ms',
      'pool_sats',
      'responders',
    ]);

    const days = stats.days as Array<Record<string, unknown>>;
    assert.equal(days.length, 14);
    for (const day of days) {
      assert.deepEqual(Object.keys(day).sort(), ['answered', 'calls', 'date']);
      assert.match(String(day.date), /^\d{4}-\d{2}-\d{2}$/);
    }
    // The window ends today, in UTC, and does not run into the future.
    assert.equal(days[days.length - 1]!.date, new Date().toISOString().slice(0, 10));
  } finally {
    await h.close();
  }
});

/** The pool in its declared state: no address, so the figure is the operator's word. */
const declaredPool = (sats: number) => createPoolReader({ address: null, declaredSats: sats }).read();

test('the chart counts real traffic, and says so plainly when there is none', async () => {
  const h = await harness();
  try {
    const empty = landingPage(publicStats(h.store), declaredPool(0));
    assert.match(empty, /No calls yet/, 'an empty chart must say it is empty rather than look broken');

    // Not awaited yet: a caller's request does not return until a person
    // answers it, so awaiting here would be the timeout rather than the test.
    const pending = h.send(messageRequest());
    const queued = await h.awaitQueued();
    await h.answer(queued.id, { text: 'Canberra.' });
    const sent = await pending;
    assert.equal(sent.status, 200, JSON.stringify(sent.body));

    const drawn = landingPage(publicStats(h.store), declaredPool(0));
    assert.match(drawn, /\d{4}-\d{2}-\d{2} — 1 \/ 1<\/li>/, 'one call answered should read as one call and one answer');
    assert.doesNotMatch(drawn, /No calls yet/);
  } finally {
    await h.close();
  }
});
