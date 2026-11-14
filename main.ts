// Entry lifecycle: how this process talks to the harness env.
//
// The env is a server the harness starts next to this process. It hands this
// process a base URL through MAKEFUN_ENV_URL, and this file's only job is the
// handshake around it: bind a port, hand that port to the env, then wait until
// the env reports the trial is over. The scored work lives in app.ts — this
// file only keeps the process alive and correctly registered while the suite
// runs against the server.
//
// The handshake, step by step:
//
//   1. Read MAKEFUN_ENV_URL. It names the env's origin (in a trial it looks
//      like http://store:8080). If it is empty there is no env to talk to,
//      so the process gives up at once with exit code 1.
//   2. Build the server from app.ts and bind it to port 0, letting the
//      kernel choose a free port. Port 8080 is the env's own port and must
//      never be bound here.
//   3. POST {"port": N} to $MAKEFUN_ENV_URL/register. The env stores the
//      caller's address plus N as this entry's base URL and starts dialing
//      it. Whoever registers first wins; a 409 reply means the slot is
//      already taken, and this process simply waits like everyone else.
//   4. Poll GET $MAKEFUN_ENV_URL/done until it answers {"done": true}.
//      The env replies immediately (false while the suite is still running),
//      so this is a short poll loop, never a held-open request.
//   5. Close the server and exit 0. The harness then stops the env, which
//      writes the export the scorer reads.

import { createApp } from './app.ts';

// The env's origin, with any trailing slashes trimmed off.
const rawEnvUrl = process.env.MAKEFUN_ENV_URL ?? '';
const ENV_URL = rawEnvUrl.replace(/\/+$/, '');
if (ENV_URL === '') {
  const msg = '[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n';
  process.stderr.write(msg);
  process.exit(1);
}

/** Longest a single register or done request may run before it is dropped and retried. */
const CALL_TIMEOUT_MS = 30_000;
/** Backoff between retries: start here, double each time, never pass the cap. */
const BACKOFF_START_MS = 250;
const BACKOFF_CAP_MS = 2_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait after `failures` failed attempts: exponential from the start value, capped. */
function backoffAfter(failures: number): number {
  const capped = Math.min(failures, 8);
  return Math.min(BACKOFF_CAP_MS, BACKOFF_START_MS * 2 ** capped);
}

/**
 * Tell the env which port this process bound. A 200 means the env recorded
 * it; a 409 means an earlier register already holds the slot, which is fine
 * too. 400 and 405 are contract mistakes and end the program right away.
 * Anything else — a dropped connection, a timeout, another status — is
 * retried, because the env may only just be coming up.
 */
async function register(port: number): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    try {
      const res = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        const detail = await res.text();
        throw new Error(`register answered HTTP ${res.status}: ${detail}`);
      }
    } catch (err) {
      const fatal = err instanceof Error && err.message.startsWith('register answered HTTP ');
      if (fatal) throw err;
    }
    await sleep(backoffAfter(failures));
  }
}

/**
 * Ask the env whether the trial is over, again and again until it says yes.
 * A poll that fails or times out just means "not done yet", so it is never
 * treated as an error — the loop keeps going until {"done": true} arrives.
 */
async function waitForDone(): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    try {
      const res = await fetch(`${ENV_URL}/done`, { signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // No answer, or the request timed out: the env is not done, poll again.
    }
    await sleep(backoffAfter(failures));
  }
}

/** Bind, register, then wait for the env: the whole life of this process. */
async function main(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => {
      resolve();
    });
  });
  const boundAddress = server.address();
  if (boundAddress === null || typeof boundAddress === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  const listeningLine = `[entry] listening on port ${boundAddress.port}\n`;
  process.stdout.write(listeningLine);

  await register(boundAddress.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await waitForDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await main();
  process.exit(0);
} catch (err) {
  const detail = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[entry] ${detail}\n`);
  process.exit(1);
}
