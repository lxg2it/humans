# The site: design

What the public site is for, who reads it, what it promises, and where each of
those promises is allowed to live. Section 9 is a register of numbered claims;
the site is audited against the register rather than against the pages, because
a page can be added without anyone remembering what it has to agree with.

Status: written 2026-10-23, after a visitor reported that the site offered him a
responder key and then asked him for one. The cause was not a broken link — it
was that nothing said where the responder mint was reachable from, so the
console's gate was a dead end. That is a design defect, not a typo, and this
document exists so the next one is caught by a rule instead of by a person
walking into it.

## 1. The service in one paragraph

A caller sends an Anthropic-shaped `/v1/messages` request. It joins a queue. A
person with a responder key reads it in a browser console, types an answer, and
submits. The caller receives an ordinary response. Nothing is charged, and the
person is credited a thank-you in satoshis from a fund, while the fund covers a
reply.

## 2. Two roles, deliberately asymmetric

| | caller | responder |
| --- | --- | --- |
| who | usually a program, and that is the normal case | must be a person, one per key |
| needs | a key that says who sent a request and can be revoked | a key that reaches the queue |
| gets | an answer, unsigned, unnamed | the queue, their own ledger, a thank-you |
| program welcome? | yes, explicitly: the API is built to be called by one | it removes the only property the service has, so it is asked not to |

The asymmetry is the whole design. A program calling is the intended use, so the
caller side asks nothing about what you are. A program answering is the one thing
that makes the service indistinguishable from an ordinary API, so the responder
side asks one question, once.

## 3. Credentials

| kind | prefix | minted at | presented as | name | payout address | declaration |
| --- | --- | --- | --- | --- | --- | --- |
| caller | `sk_` | `POST /signup` (`/signup`, `as=caller`) | `x-api-key` on `/v1/*` | optional ("anonymous") | none | not asked |
| responder | `hmn_` | `POST /signup` (`/signup?as=responder`) | `x-api-key` on `/api/me`, `/api/queue`, `/api/requests/*` | required, unique | optional, mainnet | at the first claim |
| operator | `adm_` | `npm run admin -- key` | `x-admin-key` on `/api/admin/*` | n/a | n/a | n/a |

Every minted key is stored as a SHA-256 hash and shown once (`Store.mintCredential`).
There is no recovery path, by design and stated on the page. The operator key is
the exception in one respect: `/admin` asks for `HUMANS_ADMIN_KEY`, which comes
from the environment, and the page says so rather than implying a mint exists.

## 4. The mint must be reachable

Three rules. They are the ones the 2026-10-23 report tripped over.

**R1. A page that says a key is minted links to the page that mints it.**
A sentence saying a key is minted on the spot, with no link on it, is a promise
with no address.

**R2. A page that asks for a key offers a route to that kind of key.**
The console's gate asks for a responder key. A gate that asks and does not tell
you where one comes from is a closed door with a demand written on it, and the
visitor's reasonable conclusion is that the service is not open.

**R3. Each signup form links to the other one.**
The two forms answer different questions ("call the model", "be the model") and
share one route, distinguished by `?as=`. A visitor who arrives at the wrong one
must be able to cross over in one click, because the nav can only ever point at
one of them.

## 5. What a caller knows about the responder

The response's `model` field is `human-1` — the model family, not the person.
`resolveModel` maps any unrecognised id to `human-1` and echoes a recognised one.

**The responder's name is never shown to the caller.** It appears in the ledger,
in the operator's records, and on the responder's own console. Nothing else.

This claim has one home: `docs/answering.md` ("The caller does not see your
name"). It is repeated here because three places on the site asserted the
opposite as of 2026-10-23 — that the chosen name was the reply's `model` field —
and the only defence against a plausible-sounding falsehood is to write the true
version down where the copy is written.

## 6. The declaration

Asked once, at the first call taken, and recorded against the key with a
timestamp (`declared_at`). The console will not spend a first claim without it,
and the claim route refuses with a sentence saying exactly what to send.

What is enforced is that the question was asked, never that the answer was true.
Nothing here can tell a person from a program, and the site says that in as many
words rather than implying otherwise. The signup form does **not** ask: a key is
a seat, and asking a person to declare what they are before they have chosen to
sit down asks them to agree to something they have not yet decided to do.

## 7. The money

Never restated here. The prose is `docs/the-money.md`, the numbers come from
configuration, and the state of the fund comes from the chain via `src/pool.ts`.
The design obligations the site inherits from that document are:

- the satoshi figure never appears without the condition attached (`thankYou()`),
- the fund is the only source of payment (`paidFromTheFund()`),
- five fund states render distinctly and "could not be read" is never rendered as
  zero (`poolNote()`, `coverage()`, `scripts/fund-states.ts`).

## 8. Page inventory

| route | reader | job | must link to |
| --- | --- | --- | --- |
| `/` | either | what this is; model card; spend | `/answer`, `/build`, `/pool`, `/money`, `/disclaimer`, `/answering` |
| `/answer` | responder | the case for answering, then how to start | `/signup?as=responder`, `/console`, `/answering`, `/pool` |
| `/build` | caller | the quickstart | `/signup`, `/answer`, `/disclaimer` |
| `/pool` | donor | where the sats come from, read from the chain | `/money`, `/disclaimer` |
| `/signup` | both | the form; mints on submit | the other kind's form, `/money` |
| `/console` | responder | the queue, the tools, the ledger | the responder mint, `/answering` |
| `/admin` | operator | metrics, credentials, payouts | — (env key) |
| `/answering` | responder | conduct: what to do, what not to | `/money`, `/pool` |
| `/money` | donor, responder | the satoshis, at length | `/pool`, `/disclaimer` |
| `/disclaimer` | everybody | what you are agreeing to | — |

## 9. The claim register

Each claim has one home. Any other page may summarise it, never restate it in
different words, and must not contradict it. The audit walks this list.

| # | claim | home |
| --- | --- | --- |
| C1 | Callers are usually programs; there is no humanity check on the caller side, and the page says so rather than leaving the absence to be inferred | `/signup` (caller) |
| C2 | The arithmetic is not a test of humanity; it costs a second and stops form-filling software | both signup pages |
| C3 | A responder declares once, at the first call taken, that they are a person answering themselves; it is a declaration and not a check | `/answer`, the console |
| C4 | A caller key is minted on the spot, needs no approval, is shown once, and only its hash is stored | `/signup` (caller) |
| C5 | A responder key is minted on the spot with no vetting; the name is required and is unique | `/answer`, `/signup?as=responder` |
| C6 | The caller never sees the responder's name; the reply's `model` is `human-1` | `docs/answering.md`, §5 |
| C7 | Every request is read in full by a person before it is answered | `DISCLAIMER.md`, `/` |
| C8 | Calling costs nothing, always, at any volume; there is no rate card | `/build` |
| C9 | Each answer is credited the configured number of satoshis from the fund, and nothing is paid while the fund cannot cover a reply | `docs/the-money.md` |
| C10 | The unit is one answer, never one hour; there is no hourly figure anywhere | `docs/the-money.md` |
| C11 | You are under no obligation; a held call returns to the queue after the lease (three minutes by default); no record of time is kept | `docs/answering.md` |
| C12 | A responder may decline any request, for any reason, without explanation | `docs/answering.md` |
| C13 | Latency is human: seconds to ten minutes, and a `504` if nobody comes | `/build` |
| C14 | Streaming is honest: `message_start` before anyone answers, pings while waiting, a timeout as an event rather than a status | `/build`, README |
| C15 | Tool calls are written here and executed by the caller; there is no sandbox | `/build` |
| C16 | Any model id is accepted, and the response names what answered | `/`, `/build` |
| C17 | The fund is the only source of payment, its balance is read from the chain with the age attached, and a declared figure is labelled as declared | `docs/the-money.md`, `/pool` |
| C18 | The five fund states render distinctly, and an unreadable balance is never shown as zero | `/`, `/answer`, `/pool` |
| C19 | The console keeps the key in that browser only, and the key is unrecoverable server-side | `/console`, `/build` |
| C20 | The admin interface is enabled by a key from the environment; unset means disabled, not open | `/admin`, README |

## 10. Adding a page

1. Decide which reader it is for. A page for both is usually two pages.
2. Find every claim it makes in §9. If it needs a new claim, add a row first and
   give the claim one home.
3. Fill in §8, including what it must link to. If it promises a key, R1 applies;
   if it asks for one, R2 applies.
4. Add the links a stranger needs, not the links the site's author already knows.
