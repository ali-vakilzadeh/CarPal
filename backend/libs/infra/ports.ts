// Infrastructure ports (GD-04). Business code and platform libraries depend
// only on these interfaces; CARPAL_INFRA chooses the adapter set:
//   lite  in-process adapters (single process, data under backend/.data/)
//   full  Redis, NATS JetStream, BullMQ, OpenSearch, S3/MinIO, SMTP (docker compose)

// ------------------------------------------------------------------ key-value

export interface SetOptions {
  ttlMs?: number;
  /** NX: only if absent. XX: only if present. */
  mode?: 'NX' | 'XX';
}

export interface WindowResult {
  allowed: boolean;
  /** Weighted count in the window after this call (including the cost when allowed). */
  count: number;
  limit: number;
  remaining: number;
  /** Milliseconds until the window has room again (0 when allowed). */
  retryAfterMs: number;
  /** Milliseconds until the current fixed window resets. */
  resetMs: number;
}

/** Redis-like store: sessions, idempotency, rate limits, caches, locks (41 §3.1). Values are strings. */
export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  /** Returns false when the NX/XX condition failed. */
  set(key: string, value: string, options?: SetOptions): Promise<boolean>;
  del(key: string): Promise<boolean>;
  /** Deletes only when the current value equals `expected` (lock release). */
  compareAndDelete(key: string, expected: string): Promise<boolean>;
  /** Atomic increment; `ttlMs` is applied when the key is created. */
  incr(key: string, by?: number, ttlMs?: number): Promise<number>;
  expire(key: string, ttlMs: number): Promise<boolean>;
  /** Remaining TTL in ms; null when absent or without TTL. */
  ttl(key: string): Promise<number | null>;
  sAdd(key: string, member: string, ttlMs?: number): Promise<void>;
  sRem(key: string, member: string): Promise<void>;
  sMembers(key: string): Promise<string[]>;
  /**
   * Sliding-window counter (approximation over two fixed windows, as Redis
   * rate limiters do). Consumes `cost` only when allowed.
   */
  slidingWindow(key: string, windowMs: number, limit: number, cost?: number, now?: number): Promise<WindowResult>;
  /** Deletes every key with the prefix (tests and cache invalidation). */
  delPrefix(prefix: string): Promise<number>;
  close(): Promise<void>;
}

// ------------------------------------------------------------------ events

/** A domain event as relayed from core.domain_event_outbox (52 §20). */
export interface EventEnvelope {
  eventId: string;
  type: string;
  aggregateType: string;
  aggregateId: string;
  organizationId: string | null;
  payload: Record<string, unknown>;
  schemaVersion: number;
  occurredAt: string;
  requestId: string | null;
}

export interface Subscription {
  /** Durable consumer name (one delivery per consumer). */
  consumer: string;
  /** Event types; "review.*" matches one level, ">" matches everything. */
  subjects: string[];
  handler: (event: EventEnvelope, attempt: number) => Promise<void>;
  /** Deliveries before the message is dead-lettered (JetStream max_deliver). */
  maxDeliver?: number;
  /** Backoff per redelivery in ms; the last value repeats. */
  backoffMs?: number[];
}

/** NATS JetStream in full mode: streams evt.<module>, subjects = event types (41 §6.1). */
export interface EventBus {
  publish(event: EventEnvelope): Promise<void>;
  subscribe(subscription: Subscription): () => void;
  /** Resolves when no delivery is pending or running (tests, shutdown). */
  idle(): Promise<void>;
  close(): Promise<void>;
}

export interface DeadLetter {
  consumer: string;
  event: EventEnvelope;
  attempts: number;
  error: string;
  at: string;
}

export interface DeadLetterStore {
  add(entry: DeadLetter): Promise<void>;
  list(consumer?: string): Promise<DeadLetter[]>;
}

// ------------------------------------------------------------------ jobs

export interface QueuedJob {
  /** core.background_jobs.id */
  jobId: string;
  data?: Record<string, unknown>;
}

export interface JobQueue {
  enqueue(queue: string, job: QueuedJob, options?: { delayMs?: number }): Promise<void>;
  /** Registers a processor; the signal aborts when the job is cancelled. */
  process(queue: string, handler: (job: QueuedJob, signal: AbortSignal) => Promise<void>, concurrency?: number): () => void;
  /** Removes a queued job or aborts a running one. */
  cancel(jobId: string): Promise<void>;
  idle(): Promise<void>;
  close(): Promise<void>;
}

// ------------------------------------------------------------------ storage

export interface StoredObjectInfo {
  size: number;
  contentType: string;
  /** Base64 SHA-256 of the plaintext. */
  sha256: string;
  /** Encrypted at rest (SSE-KMS in full mode; AES-256-GCM in lite mode). */
  encrypted?: boolean;
}

export interface PutOptions {
  /** Encrypt at rest (40 SEC-UP-5: documents and private media). */
  encrypt?: boolean;
}

export interface PresignedPut {
  url: string;
  method: 'PUT';
  /** Headers the client must send unchanged (fixed in the signature, 40 SEC-UP-1). */
  headers: Record<string, string>;
  expiresAt: Date;
}

export interface ObjectStorage {
  put(key: string, body: Buffer, contentType: string, options?: PutOptions): Promise<StoredObjectInfo>;
  get(key: string): Promise<{ body: Buffer; info: StoredObjectInfo } | null>;
  head(key: string): Promise<StoredObjectInfo | null>;
  delete(key: string): Promise<void>;
  presignPut(
    key: string,
    constraints: { contentType: string; contentLength: number; sha256: string; expiresInMs: number },
  ): Promise<PresignedPut>;
  presignGet(key: string, options: { expiresInMs: number; disposition?: 'inline' | 'attachment' }): Promise<string>;
}

// ------------------------------------------------------------------ search

/** A point of a geo field (GeoPoint, 40 §3.1). */
export interface SearchPoint {
  lat: number;
  lng: number;
}

/** A projection document (52 §10): JSON values; text fields are analyzed with libs/i18n searchTokens. */
export type SearchDocument = Record<string, unknown>;

export type SearchScalar = string | number | boolean;

/**
 * Structured filters (Elasticsearch term/terms/range/exists/bool). A field
 * holding an array matches when any element matches; dotted paths reach into
 * objects and arrays of objects ("locations.city").
 */
export type SearchFilter =
  | { field: string; eq: SearchScalar }
  | { field: string; in: readonly SearchScalar[] }
  /** Every value is present in the field (array containment). */
  | { field: string; all: readonly SearchScalar[] }
  | { field: string; gte?: number | string; lte?: number | string }
  | { field: string; exists: boolean }
  | { not: SearchFilter }
  | { any: readonly SearchFilter[] };

/** Full-text part of a query: analyzed tokens matched against analyzed fields, with per-field boosts. */
export interface SearchText {
  query: string;
  /** Field → boost. */
  fields: Readonly<Record<string, number>>;
  /** all: every query token must match some field; any: at least one (default all). */
  operator?: 'all' | 'any';
  /** Prefix and one-edit typo matches for longer tokens (default true). */
  fuzzy?: boolean;
}

/** Geo restriction on a field holding a point or a list of points; the nearest point gives distance_km. */
export interface SearchGeo {
  field: string;
  /** Origin for distances (and the radius). */
  origin?: SearchPoint;
  radiusKm?: number;
  /**
   * Field (sibling of each point) holding a per-point radius in km: a point
   * also matches when the origin lies within it (service radius circles, 54 §5.1).
   */
  pointRadiusField?: string;
  bbox?: { south: number; west: number; north: number; east: number };
}

export interface SearchQuery {
  filters?: readonly SearchFilter[];
  text?: SearchText;
  geo?: SearchGeo;
  /** Maximum hits (default 100, at most 1,000). */
  size?: number;
}

export interface SearchHit {
  id: string;
  /** Text relevance (0 without a text query). */
  score: number;
  source: SearchDocument;
  /** Distance from geo.origin to the nearest point (km, unrounded), null without an origin. */
  distanceKm: number | null;
}

/**
 * Search projections (52 §10: provider, vendor, inventory, community and
 * taxonomy documents, rebuilt by W2). Lite: in memory per process; full:
 * Elasticsearch/OpenSearch. Ranking beyond text relevance belongs to the
 * discovery module (54 §5); the index only filters and retrieves.
 */
export interface SearchIndex {
  upsert(index: string, id: string, document: SearchDocument): Promise<void>;
  remove(index: string, id: string): Promise<void>;
  /** Removes every document matching all filters (e.g. a vendor's items); returns the count. */
  removeWhere(index: string, filters: readonly SearchFilter[]): Promise<number>;
  get(index: string, id: string): Promise<SearchDocument | null>;
  /** Hits by text score (desc), then distance (asc), then id. */
  search(index: string, query: SearchQuery): Promise<{ hits: SearchHit[]; total: number }>;
  count(index: string): Promise<number>;
  /** Every document id of an index (reconciliation). */
  ids(index: string): Promise<string[]>;
}

// ------------------------------------------------------------------ messaging

export interface EmailMessage {
  to: string;
  template: string;
  locale: string;
  variables: Record<string, string>;
  /** Rendered subject and plain-text body (notification module templates, S6); the sink sends these. */
  subject?: string;
  text?: string;
}
export interface SmsMessage {
  to: string;
  template: string;
  locale: string;
  variables: Record<string, string>;
  /** Rendered text (notification module templates, S6). */
  text?: string;
}
export interface PushMessage {
  /** Device token reference (never the raw token in logs). */
  deviceTokenId: string;
  platform?: 'ios' | 'android' | 'web';
  /** The decrypted device token for the push gateway; sinks never log or store it. */
  token?: string;
  title: string;
  body: string;
  data?: Record<string, string>;
}

export interface Mailer {
  send(message: EmailMessage): Promise<void>;
}
export interface SmsSender {
  send(message: SmsMessage): Promise<void>;
}
export interface PushSender {
  send(message: PushMessage): Promise<void>;
}

/** Everything one process uses, built once at startup (libs/infra createInfra). */
export interface Infra {
  mode: 'lite' | 'full';
  kv: KeyValueStore;
  bus: EventBus;
  deadLetters: DeadLetterStore;
  jobs: JobQueue;
  storage: ObjectStorage;
  search: SearchIndex;
  mailer: Mailer;
  sms: SmsSender;
  push: PushSender;
  close(): Promise<void>;
}
