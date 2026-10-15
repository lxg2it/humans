# humans

An inference API whose model is people. Anthropic-compatible at the edge, priced
at zero, settled in Bitcoin.

A caller sends a normal `/v1/messages` request. It goes into a queue. A person
picks it up in a browser console, types an answer, and submits it. The caller
receives an ordinary Anthropic-shaped response with the person's text and tool
calls in it.

Every request is read in full by a human being. That is the premise, and it is
also the thing to know before you send anything: read
[DISCLAIMER.md](DISCLAIMER.md) first. The person is credited a fixed number of
satoshis per answer, which is a thank-you rather than a wage: the unit is one
answer and never one hour, nobody should be at the console for it, and
[docs/the-money.md](docs/the-money.md) says so at greater length.

## Why it exists

Two things are true of every AI service and neither is usually said out loud.
The model is a stranger, and the price per token is a fiction invented to cover
a GPU. Here the stranger is named in the ledger and the GPU is a browser tab.

It is also, deliberately, a working demonstration of an idea: that a language
model is a function from a request to a response, and *who* evaluates it is a
separate question from whether the interface works. The interface is the same
either way. That is the joke, and it is load-bearing rather than decorative —
every endpoint here is the endpoint a machine would have offered.

## Running it

```
npm install
npm start                       # listens on 127.0.0.1:8484
npm run admin -- key responder ada    # mint a key from the command line
npm run admin -- key caller demo      # ... for either side of the service
```

Keys are normally minted at `/signup`, which is self-service for both sides: a caller key
buys no compute, so making the operator the front door bought nothing. The command line
above is for minting one on somebody else's behalf.

The landing page is at `/`, the console it advertises is at `/console`, and the operator page
is at `/admin` (needs `HUMANS_ADMIN_KEY`). The landing page, `/answer` and `/build` are rendered
by the service (`src/site.ts`) rather than served from a file, because the traffic chart on the
front page is a live reading of the database.

Data lives in `~/.humans/humans.sqlite` unless `HUMANS_DATA_DIR` says otherwise.

### Environment

| variable | default | what it does |
| --- | --- | --- |
| `HUMANS_GUARANTEE_SATS` | `250` | promised per answered reply |
| `HUMANS_POOL_SATS` | `0` | the declared fund, used only when no address is set |
| `HUMANS_POOL_ADDRESS` | unset | the address donations go to. With this set, `/pool` and the console read the balance from the chain and label it a reading; without it they print the declared figure and label *that* |
| `HUMANS_CHAIN_API` | `https://mempool.space/api` | where the balance is read from; unauthenticated |
| `HUMANS_ADMIN_KEY` | unset | enables `/api/admin/*`. Unset means the admin interface is disabled, not open |
| `HUMANS_TRUST_PROXY` | `false` | believe `X-Forwarded-For`. Needed behind a proxy for the signup rate limit to mean anything, and dangerous without one |

The server never holds a key. `HUMANS_POOL_ADDRESS` is an address, which is public by
construction: this service signs nothing, spends nothing and can move nothing, and pays out by
the operator sending satoshis from a wallet it has no access to.

### In a container

```
mkdir -p data                     # the mount below has to exist first
docker compose up -d --build      # builds the image, publishes 127.0.0.1:8484
```

`.env` is optional — every value has a default — and the ledger lives in `./data`,
so a backup is a copy of a directory rather than a date with `docker volume`.
Two things to know: the port is published on the loopback interface only, because
terminating TLS is a reverse proxy's job and not this service's; and the data
directory has to be writable by the container's user, `1000:1000` unless
`HUMANS_UID`/`HUMANS_GID` say otherwise.

That second point is worth more than it looks. The directory is a bind mount, so
if it is missing, the container does not fall back to a writable one: on Linux
Docker creates it as `root`, the service cannot open its own database, and it
exits. Restart is `unless-stopped`, so what you get is a container that keeps
dying and a message that says only `unhealthy`. Hence the `mkdir` above, and hence
`scripts/container-smoke.sh` checking it before it starts anything — the
checkout carries an empty `data/.gitkeep` for exactly this reason.

### Configuration

Every value has a working default; these are the ones worth knowing.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` / `HOST` | `8484` / `127.0.0.1` | Where the service listens |
| `HUMANS_DATA_DIR` | `~/.humans` | SQLite location |
| `HUMANS_CALL_TIMEOUT_MS` | `600000` | How long a caller waits before a 504 |
| `HUMANS_CLAIM_LEASE_MS` | `180000` | How long a responder holds a request while idle |
| `HUMANS_GUARANTEE_SATS` | `250` | Paid per answer, owed whether or not the caller is still there |
| `HUMANS_POOL_SATS` | `0` | Satoshis shown as available in the pool |
| `HUMANS_REQUIRE_CALLER_KEY` | `true` | Whether `/v1/*` requires a key |
| `HUMANS_RATE_LIMIT_PER_MINUTE` | `60` | Per caller |
| `HUMANS_TRUST_PROXY` | `false` | Whether `X-Forwarded-For` is believed |

### Deploying it

There is no deployment machinery here, on purpose: no orchestration, no migration
tooling, no cluster. The whole of it is the compose file.

```
git clone <this repo> && cd humans
printf 'HUMANS_ADMIN_KEY=%s\n' "$(openssl rand -hex 32)" > .env
docker compose up -d --build
```

Then put a reverse proxy in front, because this service does not speak TLS and
does not want to:

```
location / {
    proxy_pass http://127.0.0.1:8484;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 700s;      # above HUMANS_CALL_TIMEOUT_MS, or a wait is a 502
    proxy_buffering off;          # for stream: true
}
```

Set `HUMANS_TRUST_PROXY=true` when you do, or every caller is rate-limited as
127.0.0.1. Two operational notes worth more than they cost: back up `./data` (it
is the ledger and the queue, and it is a directory so `rsync` is the whole
procedure), and set `HUMANS_POOL_SATS` to what you have actually put aside before
you point anyone at it — an unfunded guarantee is still a promise, and the console
will say which it is either way.

## The API

Caller-facing, Anthropic-shaped:

- `POST /v1/messages` — including `stream: true`
- `POST /v1/messages/count_tokens`
- `GET /v1/models`
- `POST /api/ratings` — a caller rates the answer they received

Responder-facing, used by the console:

- `GET /api/queue`, `GET /api/requests/:id`, `GET /api/me`
- `POST /api/me/payout-address` — where this responder wants to be paid, changeable at any time.
  Mainnet addresses only: a testnet address validates cleanly, records cleanly and can never
  deliver anything, which makes it the most expensive kind of typo available here.
- `POST /api/requests/:id/claim`, `heartbeat`, `abandon`
- `POST /api/requests/:id/partial` — typing, as it happens
- `POST /api/requests/:id/validate` — check a tool input without submitting
- `POST /api/requests/:id/submit`
- `GET /api/ledger`

Public, for the landing pages:

- `GET /signup` — the form, for either side (`?as=responder`), and `POST /signup`, which
  mints the key and shows it once. Gated by a signed proof-of-work challenge and a per-address
  attempt limit; see `src/signup.ts`, which is explicit about what that does and does not prove.
- `GET /pool` — the fund: the address, its balance read from the chain, and what is owed against
  it. Renders what it knows when the chain is unreachable, with the age of the reading, rather
  than substituting the configured figure for a measurement.
- `GET /api/stats` — call counts per day and a few aggregates. **Aggregates only**, by
  construction: no caller name, no responder name, no prompt. Cached for 30 seconds.
- `GET /healthz` — whether it is up and how deep the queue is

Operator-facing: `/api/admin/*`, plus `npm run admin` for keys, what is owed, and
recording settlements.

### Model ids

Any id in `model` is answered, and the response names the model that actually
answered: `human-1`. Refusing an unfamiliar id would put this service out of
reach of every client that hardcodes a model name, and it would conceal nothing,
because the answer names who answered either way and the queue shows the
responder what the caller asked for — which, for this service, is the
interesting part. An id that is missing, empty or not a string is still a 400:
an unfamiliar model is a routing question, a malformed one is a mistake.

## The streaming contract

Streaming is where a human model stops being a substitute for a machine and
starts being an oddity, so the semantics are written down rather than inferred.

- `message_start` goes out when the caller joins the queue, before anybody has
  answered. The caller is told a model, an id, and how large its prompt is, and
  then waits.
- While the request is unanswered, `ping` events are sent on a timer. Silence
  and a dead connection are indistinguishable to a client, so a waiting stream
  says so.
- If the responder typed with `/partial`, `content_block_start` and
  `content_block_delta` events carry their text as it appears. Partials are
  advisory: a client concatenates deltas and cannot un-receive one, so an edit to
  text already sent is not reflected.
- At submit, any block that was never typed is opened and sent. **A responder who
  pastes an answer and one who types it produce the same stream**, which is not
  an accident — before this was explicit, an answer that was never typed reached
  a streaming caller as a `stop_reason` with no content at all.
- `/partial` answers with `delivered`. `false` means nobody received it: the
  caller is not streaming, or has gone. The console says so rather than leaving
  someone typing into a closed socket.
- The stored reply is authoritative, not the stream. If the two disagree, the
  reply is what the ledger pays for and what a non-streaming caller would receive.
- A timeout after the stream has started cannot be a status code, because 200 and
  `message_start` have already been sent. It arrives as an `error` event with
  `timeout_error` — the same refusal a non-streaming caller receives as a 504 —
  and `message_stop` is not sent, so a timed-out message is never closed as if it
  had been answered.

## What this does not do

- **No sandboxing.** A tool call is JSON emitted by a person and executed by
  whoever called us. There is no code execution here, and there is no pretence
  that there is.
- **Human latency is the latency.** A request waits for a human to notice it. The
  default timeout is ten minutes because that is the honest unit.
- **Tool call ids are minted here** unless the responder supplies one, and are
  checked for shape either way. They are unique per response and carry no meaning
  across conversations: a client that replays a history sends back the id it was
  given, exactly as it would with any other provider.
- **One instance, one queue.** There is no federation between deployments and no
  claim that an answer is correct, only that it was given by a named person and
  paid for.

## Reading

- [DISCLAIMER.md](DISCLAIMER.md) — what this is, what it is not, and what a
  person answering means for your privacy and your expectations. Worth reading
  before you send anything.
- [docs/answering.md](docs/answering.md) — for the person at the console: what
  you see, what not to do, and why you are under no obligation.
- [docs/the-money.md](docs/the-money.md) — what the satoshis are, the unit being
  one answer rather than one hour, and the commitment that the money never
  becomes the joke.

## Testing

```
npm test                        # end-to-end over HTTP, against a real server and a real SQLite file
npm run typecheck
scripts/container-smoke.sh      # builds the deployment image and drives it
```

Tests cover the contract rather than the implementation: that a request is
answered exactly once even if the submit is replayed, that two responders racing
for one request produce one winner, that an abandoned request returns to the
queue, and that the streaming event order is what an Anthropic client expects.

`test/sdk.test.ts` drives the service with the official `@anthropic-ai/sdk`. That
matters more than it sounds: every other streaming test here parses the events
with our own parser, so a wrong delta field name would be agreed on by our reader
and our writer and pass. The vendor's client is the only instrument in the
repository that can disagree with us.

`test/docs.test.ts` checks the pages a reader is served rather than the documents
they were built from: that every relative link now points somewhere on the site,
that no `.md` path survives, and that a page renders as HTML rather than markup.
The smoke test covers the rest of what a container changes: that the documents
were copied in, that the console is served, and that a call without a key is
refused rather than queued for a person to read.

## Licence

MIT. See [LICENSE](LICENSE). The licence covers the code; the disclaimer covers
the hosted service, and if you run your own instance you are its operator.
