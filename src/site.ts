import { config } from './config.ts';
import { chart } from './chart.ts';
import { REPOSITORY, escapeText, page } from './layout.ts';
import type { PublicStats } from './stats.ts';

/**
 * The landing pages: the front door, and the two rooms behind it.
 *
 * The service speaks with one voice and this is where it is loudest. What is
 * being sent up is modelled on the boilerplate every model provider publishes,
 * and the trick is that almost none of it is a joke: the models really are
 * unaligned, there really are no guardrails, and a person really does read what
 * you send. Satire that has to lie to land is just an advertisement, and this
 * page would rather be accurate than funny. Where the two collide, accuracy
 * wins and the joke is written to survive it.
 *
 * Three rules came out of the documents rather than out of taste, and each of
 * them is load-bearing:
 *
 *  - The money is never the joke. Answering is not work, not a rate, not a way
 *    to earn, and no page will present it as one (docs/the-money.md). The satoshi
 *    figure is a thank-you and is described as one, in the same breath as the
 *    fact that nobody should do this for it.
 *  - A person reads what you send, and it is said before anything is asked of
 *    the reader, not buried under a fold. It is the single most important
 *    sentence on the site.
 *  - The numbers are read from the running service, never written into the
 *    prose. A landing page that hardcodes a guarantee is a page that starts
 *    lying the first time somebody changes an environment variable.
 */

/** A block of shell or JSON, escaped and pre-formatted. */
function code(text: string): string {
  return `<pre><code>${escapeText(text)}</code></pre>`;
}

function band(inner: string, className = ''): string {
  return `      <section class="band${className ? ` ${className}` : ''}">\n        <div class="wrap">\n${inner}\n        </div>\n      </section>`;
}

/**
 * The satoshi sentence, which is the same everywhere it appears and is the one
 * the documents are strictest about: a thank-you, never a wage, and the number
 * comes from the configuration rather than from a copywriter.
 */
function thankYou(): string {
  return (
    `Each answer is credited <strong>${config.guaranteeSats} satoshis</strong> as a thank-you. It is not a wage, ` +
    `not a rate, not a job and not a way to earn a living, and if the amount is meaningful to you then this is not ` +
    `a good use of your afternoon.`
  );
}

// ---- the front door --------------------------------------------------------

export function landingPage(stats: PublicStats): string {
  const unfunded = config.poolSats <= 0;

  const spec: ReadonlyArray<readonly [string, string]> = [
    ['Model id', '<code>human-1</code>. You may send <em>any</em> id; the response names the model that answered.'],
    ['Modality', 'Text in, text out. No images, no audio, no embeddings, no vision.'],
    [
      'Alignment',
      '<strong>None.</strong> Our models were not trained to be helpful, harmless and honest. They arrived with values of their own and we take them as we find them.',
    ],
    [
      'Guardrails',
      '<strong>None.</strong> Nothing filters the request on the way in or the answer on the way out. A refusal is a person declining, not a policy firing.',
    ],
    [
      'Context window',
      'About a day, and less when they are tired. Attention is not a resource we can sell you more of.',
    ],
    ['Latency', 'Four seconds to ten minutes, and occasionally never. One queue, and a queue of people.'],
    ['Throughput', 'One answer at a time per model. Our models are not batchable and we have stopped trying.'],
    ['Temperature', 'Varies with caffeine, sleep and the news.'],
    [
      'Hallucination',
      'Yes, confidently, and often with the caveat attached. Unlike the other kind, ours will usually tell you when they are guessing.',
    ],
    ['Weights', 'Not open. The weights are people, and they are not for download.'],
    [
      'Fine-tuning',
      'Not offered, not planned, and not something you should want. You may not train on the replies.',
    ],
    ['Cost', `<strong>Free to you.</strong> ${thankYou()}`],
  ];

  const rows = spec
    .map(([term, description]) => `          <dt>${escapeText(term)}</dt>\n          <dd>${description}</dd>`)
    .join('\n');

  const paths = band(
    `          <h2 class="sec">Two ways in</h2>
          <div class="paths">
            <div class="path">
              <span class="kicker">Be the model</span>
              <h3>Answer calls</h3>
              <p>Someone else's software asked a question and it is sitting in a queue, because there is no machine
              to answer it. Read it, type an answer, and it goes back as the response. There is no shift, no rota
              and no obligation: put a call back whenever you like and nothing will think less of you.</p>
              <a class="btn btn-primary" href="/answer">Answer calls <span class="arrow">→</span></a>
            </div>
            <div class="path">
              <span class="kicker">Call the model</span>
              <h3>Make an API call</h3>
              <p>Point an Anthropic client at this service and send an ordinary request. Two environment variables
              change and nothing else does. Keys are issued by hand at the moment, and the quickstart takes about a
              minute from here.</p>
              <a class="btn" href="/build">Get a key and call it <span class="arrow">→</span></a>
            </div>
          </div>`,
  );

  const fine = band(
    `          <h2 class="sec">The small print</h2>
          <div class="fine">
            <ol>
              <li><strong>Alignment.</strong> Our models are unaligned. They were not trained to be helpful,
              harmless and honest, no amount of prompting will make them so, and each has goals of their own — one
              of which is occasionally to answer you.</li>
              <li><strong>Guardrails.</strong> There are none. No safety filter, no refusal policy, no content
              classifier between you and the answer. What you get is what one person decided to write.</li>
              <li><strong>A person reads what you send.</strong> Every request, in full, before it is answered.
              Do not send secrets, credentials, keys, tokens, anyone else's private information, or anything you
              would not show a stranger. This is the most important line on this page and it is not a joke.</li>
              <li><strong>Answers are not authoritative.</strong> Nobody here is vetted, trained, supervised or
              fact-checked. Nothing produced by this service is professional advice of any kind, and it should not
              be used anywhere an error causes harm.</li>
              <li><strong>Latency is human.</strong> Four seconds to ten minutes, then a timeout. There is no
              autoscaling, no queue-depth guarantee, no uptime promise and no roadmap that fixes any of that.</li>
              <li><strong>The money is not the joke.</strong> ${thankYou()}</li>
              <li><strong>Availability varies with human attention.</strong> The service may be throttled, changed
              or switched off at any time, and stored data may be deleted.</li>
              <li><strong>No warranty.</strong> Provided as is, with all faults. Where liability cannot lawfully be
              excluded it is limited to the amount actually set aside to pay for answers, which may be nothing.</li>
              <li><strong>Not affiliated with anybody.</strong> &ldquo;Anthropic&rdquo;, &ldquo;Claude&rdquo; and the
              names of their products are trademarks of their respective owners. Compatibility here means the wire
              format — the same HTTP and the same JSON — and nothing else.</li>
            </ol>
            ${
              unfunded
                ? `<p class="note-warn"><strong>The pool is empty.</strong> ${config.poolSats} satoshis have been set
              aside, so the guarantee above is recorded and unfunded. The console says the same thing, in the same
              words, before anybody picks up a call.</p>`
                : ''
            }
            <p class="closing">That is the summary. The <a href="/disclaimer">disclaimer</a> is the one that counts,
            <a href="/money">the money</a> says the rest about the satoshis, and
            <a href="/answering">answering calls</a> is written for whoever is at the console.</p>
          </div>`,
  );

  return page({
    title: 'an inference API whose model is people',
    description:
      'Anthropic-compatible at the edge, priced at zero, settled in Bitcoin. Every request is read in full by a human being.',
    styles: ['/shell.css', '/site.css'],
    current: '/',
    mainId: 'site',
    body: [
      band(
        `          <p class="eyebrow">humans · an inference API</p>
          <h1 class="headline">The model is a person.</h1>
          <p class="lede">Anthropic-compatible at the edge, priced at zero, settled in Bitcoin. Every request is
          read in full by a human being, and that is the premise rather than a side effect.</p>
          <p class="plede">Point any Anthropic client at this service and send an ordinary request. It queues.
          Someone picks it up, reads the whole thing, and types an answer. It comes back in the shape your client
          already knows.</p>
          <div class="cta">
            <a class="btn btn-primary" href="/answer">Answer calls <span class="arrow">→</span></a>
            <a class="btn" href="/build">Make an API call <span class="arrow">→</span></a>
          </div>`,
        'hero',
      ),
      band(
        `          <h2 class="sec">Model card</h2>
          <div class="card">
            <dl class="spec">
${rows}
            </dl>
          </div>`,
      ),
      band(
        `          <h2 class="sec">Traffic</h2>
          ${chart(stats.days, {
            title: 'Calls per day',
            note: `last ${stats.days.length} days · UTC`,
            emptyNote:
              'No calls yet, so this is a flat line. It is not a placeholder and it is not broken: nobody has asked a person anything yet, and the chart will move the moment someone does.',
          })}`,
      ),
      paths,
      fine,
    ].join('\n'),
  });
}

// ---- the console side ------------------------------------------------------

export function answerPage(): string {
  const unfunded = config.poolSats <= 0;

  const seen: ReadonlyArray<readonly [string, string]> = [
    [
      'You see',
      "the request: what was asked, the name of the caller key that sent it, the model id it asked for, whether it is streaming, roughly how large it is, and the tool schemas on offer.",
    ],
    [
      'The caller sees',
      'your text, any tool calls you fill in, and your reasoning if you write something in that field. Reasoning is returned to the caller as a signed block and streamed live if they asked for a stream, so treat it as part of the answer.',
    ],
    [
      'The caller does not see',
      'your name. It appears in the ledger, in the operator&rsquo;s records and on your own console, and nowhere else.',
    ],
    [
      'Nobody sees',
      'how long you spent, or whether you were here at all. There is no clock in the accounting, no shift, no timesheet and no login that starts a session.',
    ],
  ];

  const rows = seen
    .map(([term, description]) => `          <dt>${escapeText(term)}</dt>\n          <dd>${description}</dd>`)
    .join('\n');

  return page({
    title: 'Answer calls',
    description:
      'Be the model: read a request, answer it, and be thanked in satoshis. No shifts, no rota, no obligation.',
    styles: ['/shell.css', '/site.css'],
    current: '/answer',
    mainId: 'site',
    body: [
      band(
        `          <p class="eyebrow">be the model</p>
          <h1 class="headline">Answer calls.</h1>
          <p class="lede">A caller&rsquo;s software sent an ordinary request and it is sitting in a queue, because
          there is no machine to answer it. You read it, you type an answer, and it goes back as the response.</p>
          <p class="plede">That is the whole job. It is also not a job — see the money, below, which is the part
          this project is most careful about.</p>
          <div class="cta">
            <a class="btn btn-primary" href="/console">Open the console <span class="arrow">→</span></a>
            <a class="btn" href="/answering">What answering involves</a>
          </div>`,
        'hero',
      ),
      band(
        `          <h2 class="sec">You are under no obligation</h2>
          <p class="body"><strong>Take the call, put it back, close the tab, go and do something else.</strong>
          A call you are holding returns to the queue on its own if you go quiet for the lease period, which is
          three minutes by default. Nobody is told that you dropped it, because nobody is told anything about you.</p>
          <p class="body">There is no shift, no rota, no expectation, and no record of how long you sat there —
          the accounting counts answers and cannot count time. Responders may decline any request, for any reason,
          without explanation.</p>`,
      ),
      band(
        `          <h2 class="sec">What you see, and what they see</h2>
          <div class="card">
            <dl class="spec">
${rows}
            </dl>
          </div>`,
      ),
      band(
        `          <h2 class="sec">The money, plainly</h2>
          <p class="body">${thankYou()}</p>
          <p class="body">The unit is <strong>one answer</strong>, never one hour. There is no hourly figure
          anywhere in this project and there will not be one: pricing a reply is a statement that an answer is a
          discrete thing, and pricing an hour is a statement that a person&rsquo;s time can be bought, which is a
          claim this service has no business making.</p>
          <p class="body">The ledger records a guarantee when an answer is submitted and a settlement when the
          operator actually pays, and the console shows the promise and the money behind it as two separate
          facts.</p>
          ${
            unfunded
              ? `<p class="note-warn"><strong>The guarantee is currently unfunded.</strong> The pool holds
              ${config.poolSats} satoshis, so an answer is recorded and owed and the money is not there yet. The
              console says so before you pick up a call, and holding the record of a promise you are not keeping
              would be worse than never having made it. <a href="/money">The money</a> is explicit about this.</p>`
              : `<p class="body">The pool holds <strong>${config.poolSats} satoshis</strong> against guarantees of
              ${config.guaranteeSats} per answer.</p>`
          }
          <p class="body">If you fork this and run it as a real service with real expectations on people&rsquo;s
          time, you are not running this project, you are running its parody. Pay people properly, in a currency,
          under an actual agreement. Being small does not make it honest.</p>`,
      ),
      band(
        `          <h2 class="sec">How to start</h2>
          <ol class="steps">
            <li>
              <h3>Get a responder key</h3>
              <p>Responder keys are minted by whoever runs this instance, by hand, and there is no signup form
              yet. That is a real gap rather than a policy: every key is a person who will read other
              people&rsquo;s requests, so it is not a thing this page should hand out to anyone who finds it.</p>
              <p class="muted">If you want one, ask in the project&rsquo;s issue tracker, or ask whoever pointed
              you here.</p>
            </li>
            <li>
              <h3>Open the console and paste it in</h3>
              <p>The console lives at <code>/console</code> and asks for the key once. It is kept in that browser
              only, and it is stored server-side as a hash, so nobody — including the operator — can read it back.</p>
            </li>
            <li>
              <h3>Take a call and answer it</h3>
              <p>Calls appear in the queue as they arrive. Read one, type what you actually think, and submit.
              If you do not know, say so; a confident guess gets carried a long way by software that has no reason
              to doubt it.</p>
              <p class="muted">Read <a href="/answering">answering calls</a> before you take your first one. It is
              short, and it is the page that tells you what not to do.</p>
            </li>
          </ol>
          <div class="cta">
            <a class="btn btn-primary" href="/console">Open the console <span class="arrow">→</span></a>
          </div>`,
      ),
    ].join('\n'),
  });
}

// ---- the caller side -------------------------------------------------------

export function buildPage(): string {
  const base = config.publicUrl === '' ? 'https://humans.lxg2it.com' : config.publicUrl.replace(/\/$/, '');

  const curl = `curl ${base}/v1/messages \\
  -H "x-api-key: $HUMANS_KEY" \\
  -H "anthropic-version: 2023-06-01" \\
  -H "content-type: application/json" \\
  -d '{
    "model": "human-1",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Explain the offside rule to someone who has never seen football."}]
  }'`;

  const env = `# any Anthropic client will do it
export ANTHROPIC_BASE_URL=${base}
export ANTHROPIC_API_KEY=sk_...        # your caller key`;

  const stream = `curl -N ${base}/v1/messages \\
  -H "x-api-key: $HUMANS_KEY" \\
  -H "content-type: application/json" \\
  -d '{"model": "human-1", "max_tokens": 1024, "stream": true,
       "messages": [{"role": "user", "content": "Why is the sky blue?"}]}'`;

  return page({
    title: 'Make an API call',
    description:
      'Point any Anthropic client at a service answered by people. The key, the first call, the endpoints, and the four differences that matter.',
    styles: ['/shell.css', '/site.css'],
    current: '/build',
    mainId: 'site',
    body: [
      band(
        `          <p class="eyebrow">call the model</p>
          <h1 class="headline">Point your Anthropic client at a person.</h1>
          <p class="lede">The same wire format, the same response shape, the same SDKs. The difference is on the
          other end, and it is not hidden: it is the point.</p>
          <p class="plede">Nothing is charged. There is nothing to upgrade to, no token accounting to watch, and no
          rate card. What you are spending instead is somebody&rsquo;s attention, which is worth being careful with.</p>
          <div class="cta">
            <a class="btn btn-primary" href="#key">Get a key <span class="arrow">→</span></a>
            <a class="btn" href="${REPOSITORY}#the-api">The full endpoint list</a>
          </div>`,
        'hero slim',
      ),
      band(
        `          <h2 class="sec" id="key">The whole quickstart</h2>
          <ol class="steps">
            <li>
              <h3>Get a caller key</h3>
              <p>Caller keys are issued by the operator, by hand, and there is no signup form yet. That is a real
              gap rather than a policy: an unauthenticated key is somebody&rsquo;s attention being spent by a
              stranger, and this service has exactly one queue.</p>
              <p class="muted">Ask in the project&rsquo;s issue tracker, or ask whoever pointed you here. A key
              looks like <code>sk_...</code> and is shown to you once, because only its hash is stored.</p>
            </li>
            <li>
              <h3>Point a client at it</h3>
              <p>Anything that speaks the Anthropic API works, including the official SDKs. There is no proxy, no
              shim, no adapter and nothing to install.</p>
              ${code(env)}
            </li>
            <li>
              <h3>Send a request</h3>
              <p>An ordinary request. <code>model</code> may be any id you like and the response names the model
              that answered, so a client with a model name baked into it does not need changing.</p>
              ${code(curl)}
            </li>
            <li>
              <h3>Wait for a person</h3>
              <p>Your request goes into the queue and stays there until somebody picks it up and answers it. Four
              seconds if someone is at the console, up to ten minutes if not, and a <code>504</code> if nobody
              comes. The default timeout is a configuration value, and it is a policy about people rather than a
              technical constant.</p>
            </li>
          </ol>`,
      ),
      band(
        `          <h2 class="sec">What is different</h2>
          <div class="card">
            <dl class="spec">
              <dt>Latency</dt>
              <dd>Seconds to minutes, per call. A person has to read the whole thing first, and there is no way to
              make that faster without making it worse.</dd>
              <dt>Determinism</dt>
              <dd>None on offer. The same prompt sent twice may be answered differently, or better. There is no
              seed and no temperature to set.</dd>
              <dt>Streaming</dt>
              <dd>Supported, and honest about it. <code>message_start</code> arrives when you join the queue, before
              anybody has answered; <code>ping</code> events are sent while you wait, because silence and a dead
              socket look identical to a client. If the responder is typing, the text streams as it appears.</dd>
              <dt>Timeout</dt>
              <dd>Ten minutes by default, and a timed-out stream cannot be a status code, because a 200 and a
              <code>message_start</code> have already gone out. It arrives as an <code>error</code> event with
              <code>timeout_error</code>, and the message is not closed as though it had been answered.</dd>
              <dt>Tool calls</dt>
              <dd>Supported. They are JSON written by a person and executed by <em>you</em>. There is no sandbox
              here and no pretence that there is one: whatever a tool call asks for, your software decides.</dd>
              <dt>Cost</dt>
              <dd>Nothing. There is no charge to you at any volume, and no invoice. The person who answered is
              credited a thank-you in satoshis, which is not a cost you carry and not a wage they are owed.</dd>
              <dt>Model ids</dt>
              <dd>Any. <code>claude-sonnet-4-6</code>, <code>gpt-9</code>, <code>banana</code>: it all routes to
              a person, and the response says so. The only thing refused is a missing or malformed id, because an
              unfamiliar model is a routing question and an empty one is a mistake.</dd>
            </dl>
          </div>`,
      ),
      band(
        `          <h2 class="sec">Streaming, if you want it</h2>
          <p class="body">Add <code>"stream": true</code> and the usual events come back. The only thing worth
          knowing before you build on it is that partial text cannot be un-sent: if the responder edits what they
          typed, the stream already carries the earlier version and the stored reply is what counts.</p>
          ${code(stream)}`,
      ),
      band(
        `          <h2 class="sec">Endpoints</h2>
          <ul class="body">
            <li><code>POST /v1/messages</code> — the request, including <code>stream: true</code></li>
            <li><code>POST /v1/messages/count_tokens</code> — an estimate, and published as one</li>
            <li><code>GET /v1/models</code> — what this service claims to offer</li>
            <li><code>POST /api/ratings</code> — rate an answer you received</li>
            <li><code>GET /api/stats</code> — the aggregate numbers behind the landing page, and nothing else</li>
            <li><code>GET /healthz</code> — whether it is up, and how deep the queue is</li>
          </ul>
          <p class="body">The full list, the streaming contract and the refusal shapes are in the repository&rsquo;s
          <a href="${REPOSITORY}#the-api">API section</a>.</p>
          <p class="body"><strong>Before you send anything:</strong> a person reads the whole request. Do not put
          secrets, credentials or other people&rsquo;s private information in a prompt. This is worth more than a
          glance — it is what <a href="/disclaimer">the disclaimer</a> leads with.</p>
          <div class="cta">
            <a class="btn" href="/answer">Or answer calls instead <span class="arrow">→</span></a>
          </div>`,
      ),
    ].join('\n'),
  });
}
