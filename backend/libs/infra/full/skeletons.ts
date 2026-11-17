// Full-mode adapters (GD-04): Redis, NATS JetStream, BullMQ, OpenSearch,
// and S3/MinIO from infrastructure/docker/docker-compose.yml. They are
// typed skeletons until Docker is available to verify them (OQ-01); every
// call fails loudly instead of silently doing nothing.
import type { DeadLetterStore, EventBus, JobQueue, KeyValueStore, ObjectStorage, PushSender, SearchIndex } from '../ports.js';
import { OpenSearchIndex } from './opensearch.js';

export class NotConfiguredError extends Error {
  constructor(adapter: string, url: string) {
    super(`full-mode ${adapter} adapter is not configured yet (${url}); use CARPAL_INFRA=lite (OQ-01)`);
    this.name = 'NotConfiguredError';
  }
}

/** Builds an object whose every method rejects with NotConfiguredError. */
function skeleton<T extends object>(adapter: string, url: string, methods: (keyof T)[]): T {
  const fail = (): never => {
    throw new NotConfiguredError(adapter, url);
  };
  const out: Record<string, unknown> = {};
  for (const m of methods) out[m as string] = (): Promise<never> => Promise.reject(new NotConfiguredError(adapter, url));
  out.close = (): Promise<void> => Promise.resolve();
  if (methods.includes('subscribe' as keyof T) || methods.includes('process' as keyof T)) {
    out.subscribe = fail;
    out.process = fail;
  }
  return out as T;
}

export const redisKeyValueStore = (url: string): KeyValueStore =>
  skeleton<KeyValueStore>('Redis', url, [
    'get',
    'set',
    'del',
    'compareAndDelete',
    'incr',
    'expire',
    'ttl',
    'sAdd',
    'sRem',
    'sMembers',
    'slidingWindow',
    'delPrefix',
  ]);
export const natsEventBus = (url: string): EventBus => skeleton<EventBus>('NATS JetStream', url, ['publish', 'subscribe', 'idle']);
export const natsDeadLetters = (url: string): DeadLetterStore => skeleton<DeadLetterStore>('NATS dead-letter stream', url, ['add', 'list']);
export const bullJobQueue = (url: string): JobQueue => skeleton<JobQueue>('BullMQ', url, ['enqueue', 'process', 'cancel', 'idle']);
export const s3ObjectStorage = (url: string): ObjectStorage =>
  skeleton<ObjectStorage>('S3', url, ['put', 'get', 'head', 'delete', 'presignPut', 'presignGet']);
/** Written to the port in S6 but unverified (OQ-01). */
export const openSearchIndex = (url: string): SearchIndex => new OpenSearchIndex(url);
// SMTP and SMS moved out of the skeletons in S26a: libs/infra/smtp-mailer.ts and libs/sms (both modes).
export const pushGateway = (url: string): PushSender => ({
  ...skeleton<PushSender>('push gateway', url, ['send']),
  provider: 'push_gateway',
});
