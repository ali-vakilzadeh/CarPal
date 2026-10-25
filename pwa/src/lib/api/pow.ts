// Proof-of-work solver for the browser (SEC-BF-7, DI-22): SHA-256(prefix + nonce) with `bits` leading zero bits,
// decimal nonces. Runs in a Web Worker when one can be started, else on the main thread in slices so the page
// stays responsive. Only used when the server asks (strict mode).

import { searchPow } from './pow-search';

export { leadingZeroBits, searchPow } from './pow-search';

const SLICE = 2_000;
const MAX_TRIES = 1 << 26;

async function solveOnMainThread(prefix: string, bits: number): Promise<string> {
  for (let start = 0; start < MAX_TRIES; start += SLICE) {
    const found = await searchPow(prefix, bits, start, SLICE);
    if (found !== null) return found;
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error('proof of work: no solution');
}

export function solvePowChallenge(prefix: string, bits: number): Promise<string> {
  let worker: Worker;
  try {
    worker = new Worker(new URL('./pow.worker.ts', import.meta.url), { type: 'module' });
  } catch {
    // No worker (old browser, or a Trusted Types policy refused the script URL): solve here.
    return solveOnMainThread(prefix, bits);
  }
  return new Promise<string>((resolve, reject) => {
    worker.onmessage = (e: MessageEvent<{ nonce?: string; error?: string }>) => {
      worker.terminate();
      if (e.data.nonce !== undefined) resolve(e.data.nonce);
      else reject(new Error(e.data.error ?? 'proof of work failed'));
    };
    worker.onerror = () => {
      worker.terminate();
      solveOnMainThread(prefix, bits).then(resolve, reject);
    };
    worker.postMessage({ prefix, bits, maxTries: MAX_TRIES });
  });
}
