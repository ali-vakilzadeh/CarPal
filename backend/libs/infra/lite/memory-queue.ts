// In-process JobQueue for lite mode (BullMQ in full mode). FIFO per queue,
// bounded concurrency per processor, cancellation through AbortSignal.
import type { JobQueue, QueuedJob } from '../ports.js';

interface Processor {
  handler: (job: QueuedJob, signal: AbortSignal) => Promise<void>;
  concurrency: number;
  running: number;
}

export interface QueueLogger {
  error(obj: object, msg: string): void;
}

export class MemoryJobQueue implements JobQueue {
  readonly #queues = new Map<string, QueuedJob[]>();
  readonly #processors = new Map<string, Processor>();
  readonly #running = new Map<string, AbortController>();
  readonly #timers = new Set<NodeJS.Timeout>();
  #busy = 0;
  #waiters: (() => void)[] = [];

  constructor(private readonly log?: QueueLogger) {}

  async enqueue(queue: string, job: QueuedJob, options: { delayMs?: number } = {}): Promise<void> {
    if (options.delayMs && options.delayMs > 0) {
      this.#busy++;
      const t = setTimeout(() => {
        this.#timers.delete(t);
        this.#busy--;
        this.#push(queue, job);
      }, options.delayMs);
      this.#timers.add(t);
      return;
    }
    this.#push(queue, job);
  }

  #push(queue: string, job: QueuedJob): void {
    const q = this.#queues.get(queue) ?? [];
    q.push(job);
    this.#queues.set(queue, q);
    this.#busy++;
    queueMicrotask(() => {
      this.#busy--;
      this.#pump(queue);
    });
  }

  process(queue: string, handler: (job: QueuedJob, signal: AbortSignal) => Promise<void>, concurrency = 1): () => void {
    if (this.#processors.has(queue)) throw new Error(`queue ${queue} already has a processor`);
    this.#processors.set(queue, { handler, concurrency, running: 0 });
    this.#pump(queue);
    return () => this.#processors.delete(queue);
  }

  #pump(queue: string): void {
    const p = this.#processors.get(queue);
    const q = this.#queues.get(queue);
    if (!p || !q) {
      this.#notify();
      return;
    }
    while (p.running < p.concurrency && q.length > 0) {
      const job = q.shift()!;
      const ctl = new AbortController();
      this.#running.set(job.jobId, ctl);
      p.running++;
      this.#busy++;
      void p
        .handler(job, ctl.signal)
        .catch((err: unknown) => this.log?.error({ err, queue, job_id: job.jobId }, 'job processor failed'))
        .finally(() => {
          this.#running.delete(job.jobId);
          p.running--;
          this.#busy--;
          this.#pump(queue);
        });
    }
    this.#notify();
  }

  async cancel(jobId: string): Promise<void> {
    for (const q of this.#queues.values()) {
      const i = q.findIndex((j) => j.jobId === jobId);
      if (i >= 0) q.splice(i, 1);
    }
    this.#running.get(jobId)?.abort();
  }

  #notify(): void {
    const queued = [...this.#queues.entries()].some(([name, q]) => q.length > 0 && this.#processors.has(name));
    if (this.#busy === 0 && !queued) for (const w of this.#waiters.splice(0)) w();
  }

  idle(): Promise<void> {
    return new Promise((resolve) => {
      this.#waiters.push(resolve);
      this.#notify();
    });
  }

  async close(): Promise<void> {
    for (const t of this.#timers) clearTimeout(t);
    for (const c of this.#running.values()) c.abort();
    this.#queues.clear();
    this.#processors.clear();
    for (const w of this.#waiters.splice(0)) w();
  }
}
