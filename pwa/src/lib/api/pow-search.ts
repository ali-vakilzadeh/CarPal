// The pure proof-of-work search (SEC-BF-7, DI-22), shared by the solver (pow.ts) and its Web Worker
// (pow.worker.ts). It must not import pow.ts: the worker's module graph would then contain the
// `new Worker(new URL('./pow.worker.ts'))` that starts it, and Turbopack's production build loops on that cycle
// (found in P3, Next.js 16.4.3).

const encoder = new TextEncoder();

export function leadingZeroBits(hash: Uint8Array): number {
  let bits = 0;
  for (const byte of hash) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    return bits + Math.clz32(byte) - 24;
  }
  return bits;
}

/** Tries nonces from `start` for `count` steps; the first solution, or null. */
export async function searchPow(prefix: string, bits: number, start: number, count: number): Promise<string | null> {
  for (let i = start; i < start + count; i++) {
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(prefix + i)));
    if (leadingZeroBits(hash) >= bits) return String(i);
  }
  return null;
}
