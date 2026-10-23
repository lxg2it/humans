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

test('an unreachable chain is reported as a failure, not as nothing read yet', async () => {
  const h = await harness();
  try {
    const cold = poolPage(reading({ sats: null, receivedSats: null, spentSats: null, txCount: null, readAt: null }), 0);
    const failed = poolPage(
      reading({ sats: null, receivedSats: null, spentSats: null, txCount: null, readAt: null, error: 'ECONNREFUSED' }),
      0,
    );

    // The control: a cold reader with no error says it has not read, and does not
    // claim a failure it has no evidence of.
    assert.match(cold, /no fetch has completed/, 'a cold reader does not say where it stands');
    assert.doesNotMatch(cold, /could not be reached/, 'a cold reader claims a failure it cannot know about');

    // And the case this test exists for: the two must not render alike.
    assert.match(failed, /could not be reached/, 'a chain failure is reported as though nothing had been attempted');
    assert.match(failed, /ECONNREFUSED/, 'the reason the reading failed is missing from the page');
    assert.ok(
      failed !== cold,
      'an unreachable chain and a cold reader render identically, so the page cannot tell a reader which happened',
    );
  } finally {
    await h.close();
  }
});

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

    // The figure in any form it is written, not one phrasing of it. The version
    // before this counted only the literal "250 satoshis", so the answering page
    // — which writes the figure as "250 by default" — was skipped by the
    // `continue` below and passed by being invisible rather than by being
    // conditional. That is the third time this test has been blind to a page it
    // believed it was checking, so the detector is now built from the configured
    // figure and proved with controls before it judges anything.
    const figureDigits = [...new Set([String(config.guaranteeSats), config.guaranteeSats.toLocaleString('en-AU')])].map(
      (form) => form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    );
    // A standalone number: not the tail of a longer one, and not part of a larger
    // figure with a thousands separator ("250" inside "1,250,000" is a balance,
    // not the promise).
    const figureForms = new RegExp(`(?<![\\d.,])(?:${figureDigits.join('|')})(?![\\d.,])`, 'g');

    const figureMentions = (html: string): number => count(html, figureForms);
    const namedMentions = (html: string): number => count(html, /HUMANS_GUARANTEE_SATS/g);
    const CONDITION = /nothing is paid/g;
    // The rule itself, as a predicate, so that it can be shown to bite on a bare
    // promise instead of only being asserted about real pages.
    const barePromise = (html: string): boolean => figureMentions(html) > count(html, CONDITION);

    // The controls, before any page is judged — because a check that cannot see
    // what it is looking for agrees with everything.
    assert.equal(
      figureMentions('<p>a fixed number of satoshis per answer (250 by default)</p>'),
      1,
      'the detector cannot see the figure written as "250 by default", which is the form that escaped the last version',
    );
    assert.equal(figureMentions(`<p>${config.guaranteeSats} satoshis</p>`), 1, 'the detector cannot see the plain form');
    assert.equal(figureMentions('<p>1,250,000 satoshis held</p>'), 0, 'the detector counts the promise inside a larger balance');
    assert.equal(figureMentions('<p>nothing numeric here</p>'), 0, 'the detector finds a figure where there is none');
    assert.ok(barePromise('<p>You are credited 250 satoshis.</p>'), 'a bare promise is not reported as bare');
    assert.ok(
      !barePromise('<p>You are credited 250 satoshis. If the fund is empty, nothing is paid.</p>'),
      'a conditional promise is reported as bare, so the rule below would fail on good copy',
    );

    const checkedPages: string[] = [];
    let checked = 0;
    for (const [name, html] of pages) {
      const number = figureMentions(html);
      const named = namedMentions(html);
      const rule = count(html, CONDITION);

      if (number === 0 && named === 0) continue; // this page does not state the guarantee
      checked += 1;
      checkedPages.push(name);

      // The count, not the presence: a page stating the figure twice and the
      // condition once has a bare promise on it, and "the page mentions both" is
      // exactly the assertion that let one through the first time. This is the
      // predicate the controls above proved can tell a bare promise from a
      // conditional one, applied to the page rather than to a specimen.
      assert.ok(
        !barePromise(html),
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
        `${name} names the guarantee setting without ever saying when payment stops`,
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

    // And the pages where the promise actually lives, named, so that one of them
    // cannot quietly leave the checked set again — which is exactly how the
    // answering page passed this test for as long as it has. The answering page
    // is the one that matters most: it is where somebody deciding whether to pick
    // up a call reads the figure.
    for (const important of ['/answering', '/money', '/pool', '/']) {
      assert.ok(
        checkedPages.includes(important),
        `${important} is not among the pages this test checked (${checkedPages.join(', ')}), so the promise there ` +
          `is unverified rather than verified`,
      );
    }
    
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
