# humans

An inference API whose model is people. Anthropic-compatible at the edge, priced
at zero, settled in Bitcoin.

A caller sends a normal `/v1/messages` request. It goes into a queue. A person
picks it up in a browser console, types an answer, and submits it. The caller
receives an ordinary Anthropic-shaped response with the person's text and tool
calls in it. The person is paid a guaranteed number of satoshis per answer.

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
npm run admin -- key responder ada    # mint the first console key
npm run admin -- key caller demo      # mint the first caller key
```

The console is at `/`, the operator page at `/admin` (needs `HUMANS_ADMIN_KEY`).

Data lives in `~/.humans/humans.sqlite` unless `HUMANS_DATA_DIR` says otherwise.

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

## The API

Caller-facing, Anthropic-shaped:

- `POST /v1/messages` — including `stream: true`
- `POST /v1/messages/count_tokens`
- `GET /v1/models`
- `POST /api/ratings` — a caller rates the answer they received

Responder-facing, used by the console:

- `GET /api/queue`, `GET /api/requests/:id`, `GET /api/me`
- `POST /api/requests/:id/claim`, `heartbeat`, `abandon`
- `POST /api/requests/:id/partial` — typing, as it happens
- `POST /api/requests/:id/validate` — check a tool input without submitting
- `POST /api/requests/:id/submit`
- `GET /api/ledger`

Operator-facing: `/api/admin/*`, plus `npm run admin` for keys, what is owed, and
recording settlements.

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
- **Tool call ids are minted here**, not typed by the responder, so they are
  stable within a response and meaningless across conversations.
- **One instance, one queue.** There is no federation between deployments and no
  claim that an answer is correct, only that it was given by a named person and
  paid for.

## Testing

```
npm test        # end-to-end over HTTP, against a real server and a real SQLite file
npm run typecheck
```

Tests cover the contract rather than the implementation: that a request is
answered exactly once even if the submit is replayed, that two responders racing
for one request produce one winner, that an abandoned request returns to the
queue, and that the streaming event order is what an Anthropic client expects.
