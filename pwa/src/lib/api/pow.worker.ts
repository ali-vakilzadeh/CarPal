// Web Worker of the proof-of-work solver (pow.ts): searches the whole nonce range and posts the first solution.
import { searchPow } from './pow';

self.onmessage = async (e: MessageEvent<{ prefix: string; bits: number; maxTries: number }>) => {
  const { prefix, bits, maxTries } = e.data;
  const nonce = await searchPow(prefix, bits, 0, maxTries);
  self.postMessage(nonce === null ? { error: 'no solution' } : { nonce });
};
