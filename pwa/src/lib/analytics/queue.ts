// Analytics queue (GD-17, P3.T6 skeleton): registered events (events.ts) are stamped at capture time, held only while
// the visitor allows analytics (consent.ts), and sent to events.ingest with platform 'web_pwa' in batches of at most
// 50 — on an interval, when the queue fills and when the page is hidden. Events older than 7 days are dropped (the
// API refuses them, BA-20). A 501 from the API (not deployed) turns the queue off silently; other failures keep the
// events for the next flush, capped. Screens start calling track() from P5/P6.
import { validProperties, type EventName, type EventProperties } from './events';

export const MAX_BATCH = 50;
export const MAX_QUEUED = 200;
export const FLUSH_INTERVAL_MS = 15_000;
export const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface QueuedEvent {
  event_name: EventName;
  schema_version: number;
  occurred_at: string;
  session_id?: string;
  properties?: Record<string, string | number | boolean>;
}

export interface AnalyticsQueueOptions {
  /** Sends one batch; rejects with an error carrying `status` on HTTP failures. */
  send: (events: QueuedEvent[]) => Promise<void>;
  /** Whether the visitor allows analytics right now. */
  allowed: () => boolean;
  now?: () => number;
  sessionId?: string;
}

export class AnalyticsQueue {
  #events: QueuedEvent[] = [];
  #disabled = false;
  #flushing: Promise<void> | null = null;
  readonly #o: AnalyticsQueueOptions & { now: () => number };

  constructor(o: AnalyticsQueueOptions) {
    this.#o = { ...o, now: o.now ?? Date.now };
  }

  get size(): number {
    return this.#events.length;
  }

  get disabled(): boolean {
    return this.#disabled;
  }

  /** Records an event if analytics are allowed and its properties are registered; never throws. */
  track<N extends EventName>(name: N, properties: EventProperties<N> = {} as EventProperties<N>): boolean {
    if (this.#disabled || !this.#o.allowed()) return false;
    const props = Object.fromEntries(Object.entries(properties).filter(([, v]) => v !== undefined)) as Record<
      string,
      string | number | boolean
    >;
    if (!validProperties(name, props)) return false;
    this.#events.push({
      event_name: name,
      schema_version: 1,
      occurred_at: new Date(this.#o.now()).toISOString(),
      ...(this.#o.sessionId ? { session_id: this.#o.sessionId } : {}),
      ...(Object.keys(props).length ? { properties: props } : {}),
    });
    if (this.#events.length > MAX_QUEUED) this.#events.splice(0, this.#events.length - MAX_QUEUED);
    if (this.#events.length >= MAX_BATCH) void this.flush();
    return true;
  }

  /** Withdrawn consent: queued events are discarded, nothing more is recorded until it is given again. */
  clear(): void {
    this.#events = [];
  }

  async flush(): Promise<void> {
    if (this.#flushing) return this.#flushing;
    this.#flushing = this.#flush().finally(() => (this.#flushing = null));
    return this.#flushing;
  }

  async #flush(): Promise<void> {
    if (!this.#o.allowed()) {
      this.#events = [];
      return;
    }
    const oldest = this.#o.now() - MAX_AGE_MS;
    this.#events = this.#events.filter((e) => Date.parse(e.occurred_at) >= oldest);
    while (this.#events.length > 0 && !this.#disabled) {
      const batch = this.#events.slice(0, MAX_BATCH);
      try {
        await this.#o.send(batch);
        this.#events.splice(0, batch.length);
      } catch (err) {
        const status = (err as { status?: number }).status;
        if (status === 501) {
          this.#disabled = true;
          this.#events = [];
        } else if (status !== undefined && status >= 400 && status < 500 && status !== 429) {
          this.#events.splice(0, batch.length); // refused as a whole: never resend the same batch
        }
        return;
      }
    }
  }

  /** Flushes on an interval and when the page is hidden; returns the stop function. */
  start(): () => void {
    const timer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
    const onHide = () => {
      if (document.visibilityState === 'hidden') void this.flush();
    };
    document.addEventListener('visibilitychange', onHide);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onHide);
    };
  }
}
