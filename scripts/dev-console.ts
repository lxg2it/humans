/**
 * A real server on a fixed port, for driving the console in a browser.
 *
 * Not part of the test suite: the suite uses an ephemeral port per test, and a
 * browser harness needs one address it can be pointed at. Everything here goes
 * through the same createApp the server uses, so what the browser sees is the
 * real thing rather than a render of the templates.
 */
import { createApp } from '../src/app.ts';
import { config } from '../src/config.ts';
import { Store } from '../src/db.ts';
import { Queue } from '../src/queue.ts';

const PORT = Number(process.env.PORT ?? 8788);

const store = new Store(':memory:', {
  claimLeaseMs: config.claimLeaseMs,
  callTimeoutMs: config.callTimeoutMs,
  poolSats: config.poolSats,
});
const queue = new Queue(store, {
  callTimeoutMs: config.callTimeoutMs,
  sweepIntervalMs: 1000,
  pingIntervalMs: 1000,
});
const app = createApp(store, queue);

const caller = store.mintCredential('caller', 'browser-check-caller');
const server = app.listen(PORT, '127.0.0.1', () => {
  queue.start();
  console.log(`listening on http://127.0.0.1:${PORT}`);
  console.log(`caller key: ${caller.key.slice(0, 8)}…`);
});

// One request for the queue, sent the way a caller would send it.
const kick = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 250));
  // The caller's side is the half a console harness cannot show you. This
  // resolves whenever a human answers, so print what the caller actually got.
  const pending = fetch(`http://127.0.0.1:${PORT}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': caller.key },
    body: JSON.stringify({
      model: 'human-1',
      max_tokens: 512,
      messages: [
        {
          role: 'user',
          content:
            'I am writing a short note to a neighbour about a fence that leans into my yard. Can you draft three or four sentences that ask them to look at it without sounding like a complaint?',
        },
      ],
    }),
  }).then(async (res) => {
    const body = (await res.json()) as {
      id?: string;
      content?: { type: string; text?: string }[];
      stop_reason?: string;
      usage?: { input_tokens: number; output_tokens: number };
    };
    // Who answered is deliberately absent from the caller's view, so this
    // prints what a caller can actually see and nothing more.
    const text = (body.content ?? []).map((block) => block.text ?? '').join('');
    console.log(`\n[caller] ${res.status} id=${body.id} stop_reason=${body.stop_reason}`);
    console.log(`[caller] usage=${JSON.stringify(body.usage)}`);
    console.log(`[caller] answer (${text.length} chars):\n${text}\n`);
  });
  await pending;
};
void kick();

const shutdown = (): void => {
  queue.stop();
  server.close(() => {
    store.close();
    process.exit(0);
  });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
