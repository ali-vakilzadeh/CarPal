// L9 outbox (41 §2.2, §6.1; 42 §7; 52 §20): use cases publish domain events
// into core.domain_event_outbox inside their own transaction; the W1 relay
// (workers/outbox-relay) moves pending rows to the event bus; consumers are
// idempotent through de-duplication on event_id.
import { sql } from 'kysely';
import type { EventBus, EventEnvelope, KeyValueStore } from '#libs/infra/index.js';
import type { TxScope } from '#libs/tenancy/index.js';

export const EVENT_TYPE = /^[a-z_]+(\.[a-z_]+)+$/;

export interface DomainEvent {
  /** 40 Appendix A / 52 §20 event type, e.g. "vehicle.created". */
  type: string;
  aggregateType: string;
  aggregateId: string;
  /** Minimal payload: ids and changed fields, never secrets or contact data. */
  payload?: Record<string, unknown>;
  schemaVersion?: number;
}

/** Writes the event in the caller's transaction (core.publish_event); returns the event id. */
export async function publishEvent(scope: TxScope, e: DomainEvent): Promise<string> {
  if (!EVENT_TYPE.test(e.type)) throw new Error(`invalid event type ${e.type}`);
  const { rows } = await sql<{ id: string }>`
    SELECT core.publish_event(${e.type}, ${e.aggregateType}, ${e.aggregateId}::uuid,
                              ${JSON.stringify(e.payload ?? {})}::jsonb, ${e.schemaVersion ?? 1}) AS id`.execute(scope.db);
  scope.marks.add(`event:${e.type}`);
  return rows[0]!.id;
}

// ------------------------------------------------------------------ consumers

export interface ConsumerLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

/** A durable event consumer (41 §6.2). Subclasses implement handle(); delivery is at least once. */
export abstract class EventConsumer {
  /** Durable name, e.g. "notification.dispatch". */
  abstract readonly name: string;
  /** Event types or patterns ("review.*", ">"). */
  abstract readonly subjects: string[];
  readonly maxDeliver: number = 5;
  readonly backoffMs: number[] = [200, 1_000, 5_000, 15_000];

  abstract handle(event: EventEnvelope): Promise<void>;
}

const DONE_TTL_MS = 7 * 86_400_000;
const RUNNING_TTL_MS = 2 * 60_000;

/**
 * Subscribes a consumer with de-duplication on event_id: an event already
 * handled by this consumer is acknowledged without running it again, so the
 * relay's at-least-once delivery becomes exactly-once processing.
 */
export function registerConsumer(bus: EventBus, kv: KeyValueStore, consumer: EventConsumer, log?: ConsumerLogger): () => void {
  return bus.subscribe({
    consumer: consumer.name,
    subjects: consumer.subjects,
    maxDeliver: consumer.maxDeliver,
    backoffMs: consumer.backoffMs,
    handler: async (event, attempt) => {
      const key = `consumer:${consumer.name}:${event.eventId}`;
      if (!(await kv.set(key, 'running', { ttlMs: RUNNING_TTL_MS, mode: 'NX' }))) {
        if ((await kv.get(key)) === 'done') return; // duplicate delivery
        throw new Error('event is being processed by another delivery');
      }
      try {
        await consumer.handle(event);
        await kv.set(key, 'done', { ttlMs: DONE_TTL_MS });
      } catch (err) {
        await kv.del(key);
        log?.warn({ err, consumer: consumer.name, event_id: event.eventId, event_type: event.type, attempt }, 'consumer failed');
        throw err;
      }
    },
  });
}

export { OutboxRelay, type OutboxRelayOptions } from './relay.js';
