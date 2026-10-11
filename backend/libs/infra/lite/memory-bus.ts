// In-process EventBus for lite mode. Mirrors the JetStream semantics the
// consumers rely on (41 §6.1): at-least-once delivery per durable consumer,
// redelivery with backoff, and a dead-letter store after max_deliver attempts.
import type { DeadLetterStore, EventBus, EventEnvelope, Subscription } from '../ports.js';

const DEFAULT_BACKOFF = [100, 500, 2_000, 5_000];

export function subjectMatches(pattern: string, subject: string): boolean {
  if (pattern === '>' || pattern === subject) return true;
  const p = pattern.split('.');
  const s = subject.split('.');
  for (let i = 0; i < p.length; i++) {
    if (p[i] === '>') return true;
    if (i >= s.length) return false;
    if (p[i] !== '*' && p[i] !== s[i]) return false;
  }
  return p.length === s.length;
}

export interface BusLogger {
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export class MemoryEventBus implements EventBus {
  readonly #subs = new Set<Subscription>();
  readonly #timers = new Set<NodeJS.Timeout>();
  #pending = 0;
  #waiters: (() => void)[] = [];
  #closed = false;

  constructor(
    private readonly deadLetters: DeadLetterStore,
    private readonly log?: BusLogger,
  ) {}

  async publish(event: EventEnvelope): Promise<void> {
    if (this.#closed) throw new Error('event bus closed');
    for (const sub of this.#subs) {
      if (sub.subjects.some((p) => subjectMatches(p, event.type))) this.#schedule(sub, event, 1, 0);
    }
  }

  subscribe(subscription: Subscription): () => void {
    this.#subs.add(subscription);
    return () => this.#subs.delete(subscription);
  }

  #schedule(sub: Subscription, event: EventEnvelope, attempt: number, delayMs: number): void {
    this.#pending++;
    const timer = setTimeout(() => {
      this.#timers.delete(timer);
      void this.#deliver(sub, event, attempt);
    }, delayMs);
    this.#timers.add(timer);
  }

  async #deliver(sub: Subscription, event: EventEnvelope, attempt: number): Promise<void> {
    try {
      if (!this.#subs.has(sub) || this.#closed) return;
      await sub.handler(event, attempt);
    } catch (err) {
      const maxDeliver = sub.maxDeliver ?? 5;
      const message = err instanceof Error ? err.message : String(err);
      if (attempt >= maxDeliver) {
        this.log?.error(
          { consumer: sub.consumer, event_id: event.eventId, event_type: event.type, attempts: attempt },
          'event dead-lettered',
        );
        await this.deadLetters.add({
          consumer: sub.consumer,
          event,
          attempts: attempt,
          error: message.slice(0, 1000),
          at: new Date().toISOString(),
        });
      } else {
        const backoff = sub.backoffMs ?? DEFAULT_BACKOFF;
        const delay = backoff[Math.min(attempt - 1, backoff.length - 1)] ?? 1_000;
        this.log?.warn({ consumer: sub.consumer, event_id: event.eventId, attempt, retry_in_ms: delay }, 'event delivery failed');
        this.#schedule(sub, event, attempt + 1, delay);
      }
    } finally {
      this.#pending--;
      if (this.#pending === 0) for (const w of this.#waiters.splice(0)) w();
    }
  }

  idle(): Promise<void> {
    return this.#pending === 0 ? Promise.resolve() : new Promise((r) => this.#waiters.push(r));
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const t of this.#timers) clearTimeout(t);
    this.#timers.clear();
    this.#subs.clear();
    this.#pending = 0;
    for (const w of this.#waiters.splice(0)) w();
  }
}
