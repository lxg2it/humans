import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.ts';
import { SOURCES } from '../src/docs.ts';
import { NAV } from '../src/layout.ts';
import { createPoolReader } from '../src/pool.ts';
import { answerPage, landingPage, poolPage } from '../src/site.ts';
import type { PoolReading } from '../src/pool.ts';
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

/**
 * The guarantee is a conditional promise, and the condition travels with it.
 *
 * Scott's ruling, 2026-10-16: the money is paid from the pool address and the
 * site says so — you are paid if there are funds in the pool. The failure this
 * guards against is the number appearing somewhere without the condition, which
 * is what an unconditional promise looks like even when nobody meant to make
 * one. A page is free to phrase it however it reads best; what it is not free to
 * do is state the number and stop.
 */
const POOL_ADDRESS = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';

function reading(over: Partial<PoolReading> = {}): PoolReading {
  return {
    declared: false,
    address: POOL_ADDRESS,
    sats: 250_000,
    receivedSats: 250_000,
    spentSats: 0,
    txCount: 3,
    readAt: Date.now() - 60_000,
    error: null,
    ...over,
  };
}

test('the number is never promised without the condition on it', async () => {
  const h = await harness();
  try {
    const empty = reading({ sats: 0, receivedSats: 0, txCount: 0 });
    const funded = reading();
    // A real store rather than a stub: the numbers on that page are read from
    // it, and a stub here would be testing a page nobody serves.
    const stats = publicStats(h.store);

    const pages: Array<[string, string]> = [
      ['the front page, funded', landingPage(stats, funded)],
      ['the front page, empty', landingPage(stats, empty)],
      ['the answering page, funded', answerPage(funded)],
      ['the answering page, empty', answerPage(empty)],
      ['the fund page, funded', poolPage(funded, 0)],
      ['the fund page, empty', poolPage(empty, 0)],
    ];

    // And every other page the service serves, discovered rather than listed:
    // maintaining a list is how a page gets missed, which is how a bare number
    // survived on the front page and then on the signup page.
    for (const route of [...SOURCES.map((source) => source.route), '/', '/answer', '/pool', '/signup', '/console']) {
      const response = await h.call(route);
      assert.equal(response.status, 200, `${route} does not serve, so it cannot be checked`);
      pages.push([route, response.body as string]);
    }

    const count = (haystack: string, needle: RegExp): number => haystack.match(needle)?.length ?? 0;

    let checked = 0;
    for (const [name, html] of pages) {
      // Two ways of stating it, both counted. The first draft counted only the
      // literal and only on pages flagged as literal, so on every discovered page
      // the count was zero by construction and the condition below skipped it
      // silently. The falsifier was a bare number appended to a page nobody had
      // listed, and the test passed it.
      const number = count(html, new RegExp(`${config.guaranteeSats} satoshis`, 'g'));
      const named = count(html, /HUMANS_GUARANTEE_SATS/g);
      const rule = count(html, /nothing is paid/g);

      if (number === 0 && named === 0) continue; // this page does not state the guarantee
      checked += 1;

      // The count, not the presence: a page stating the figure twice and the
      // condition once has a bare promise on it, and "the page mentions both" is
      // exactly the assertion that let one through the first time.
      assert.ok(
        rule >= number,
        `${name} states the guarantee ${number} time(s) and the condition ${rule}, so somewhere on it the number ` +
          `stands alone`,
      );
      // Naming the setting is not the same as stating a figure: the money
      // document discusses the mechanism and refers to it by name three times
      // inside one explanation. Requiring the condition at every mention there
      // would be an assertion nobody could keep, so what is required is that a
      // page which names it says, somewhere, when payment happens at all.
      assert.ok(
        named === 0 || rule >= 1,
        `${name} names the guarantee setting without ever saying it is paid only while the fund holds something`,
      );
      assert.match(html, /fund|pool/, `${name} does not say where the money comes from`);
    }

    // A test that skips everything proves nothing, so the pages that were
    // actually asserted on are counted and the number is required to be large
    // enough to include the ones known to state it.
    assert.ok(
      checked >= 8,
      `only ${checked} page(s) stated the guarantee, so this test is mostly skipping and would not notice a page ` +
        `being dropped from the set`,
    );
    
  } finally {
    await h.close();
  }
});

test('the fund page says how much of what is owed it actually covers', () => {
  // The partially funded case is the one that matters: neither of the two easy
  // stories is true, the promise is not dead and it is not fully backed either.
  const partly = poolPage(reading({ sats: 1_000 }), 2_500);
  assert.match(partly, /<strong>no\.<\/strong> 2,500 satoshis are owed and 1,000 are held/);
  assert.match(partly, /1,500 of what has been promised is recorded and unpaid/);

  const covered = poolPage(reading({ sats: 5_000 }), 2_500);
  assert.match(covered, /yes\. 2,500 satoshis are owed and 5,000 are held, leaving 2,500 to spare\./);

  const exact = poolPage(reading({ sats: 2_500 }), 2_500);
  assert.match(exact, /2,500 are held, exactly\./);

  const nothingOwed = poolPage(reading({ sats: 5_000 }), 0);
  assert.match(nothingOwed, /nothing is owed at the moment, so there is nothing to cover/);

  // A balance that was never read is a missing number, not a zero, and the one
  // line that decides whether anyone is covered must not invent it.
  const unread = poolPage(reading({ sats: null }), 2_500);
  assert.match(unread, /cannot be worked out, because the balance above has not been read/);
  assert.doesNotMatch(unread, /Covered:<\/strong> yes/);
});
