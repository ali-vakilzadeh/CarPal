// L21 observability (41 §2.2, §7; 40 SEC-LOG-1/2): structured JSON logs with
// redaction and control-character escaping, request ids (CarPal-Request-Id =
// trace id), and OpenTelemetry hooks. No exporter is registered in lite mode,
// so spans and metrics are no-ops until an SDK is installed (full mode).
import { metrics, SpanStatusCode, trace, type Span } from '@opentelemetry/api';
import { isIP } from 'node:net';
import pino, { type Logger, type LoggerOptions } from 'pino';
import { ID_PATTERN, uuidv7 } from '#libs/crypto/index.js';

export type { Logger } from 'pino';

/**
 * Keys that must never reach a log line (SEC-LOG-1): credentials, codes,
 * tokens, VINs, coordinates and contact data. Bodies are not logged at all;
 * this list is the second wall for objects passed to the logger by mistake.
 * Matched case-insensitively at any depth.
 */
export const REDACT_KEYS: ReadonlySet<string> = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'dpop',
  'carpal-attestation',
  'carpal-pow',
  'password',
  'new_password',
  'current_password',
  'token',
  'access_token',
  'refresh_token',
  'id_token',
  'client_assertion',
  'code',
  'otp',
  'secret',
  'vin',
  'email',
  'phone',
  'lat',
  'lng',
  'latitude',
  'longitude',
  'pin',
  'link_token',
]);

// C0/C1 controls, DEL, line/paragraph separators and bidi controls (SEC-LOG-2, SEC-IN-4).
// Built from a string: SWC un-escapes U+2028 inside regex literals, which breaks the literal.
// eslint-disable-next-line no-control-regex -- the control characters are what we escape
const UNSAFE = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069]', 'g');

/** Escapes characters that could forge or hide log lines; caps the length. */
export function escapeLogValue(value: string, max = 512): string {
  const s = value.length > max ? `${value.slice(0, max)}…` : value;
  return s.replace(UNSAFE, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function sanitize(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return escapeLogValue(value, 2048);
  if (value === null || typeof value !== 'object' || value instanceof Error) return value;
  // Deeper structures are cut off rather than logged unredacted.
  if (depth > 5) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => sanitize(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = REDACT_KEYS.has(k.toLowerCase()) ? '[redacted]' : sanitize(v, depth + 1);
  return out;
}

export interface LoggerConfig {
  level: LoggerOptions['level'];
  /** Static fields of every line (service, host, env). */
  base?: Record<string, string>;
  /** Write to a custom destination (tests capture lines). */
  destination?: pino.DestinationStream;
}

export function createLogger(cfg: LoggerConfig): Logger {
  const options: LoggerOptions = {
    level: cfg.level ?? 'info',
    base: cfg.base ?? null,
    timestamp: pino.stdTimeFunctions.isoTime,
    messageKey: 'msg',
    formatters: {
      level: (label) => ({ level: label }),
      log: (obj) => sanitize(obj) as Record<string, unknown>,
    },
    hooks: {
      logMethod(args, method) {
        // Escape the message string too (format arguments are not used).
        const [first, ...rest] = args as unknown[];
        if (typeof first === 'string') return method.apply(this, [escapeLogValue(first, 2048), ...rest] as never);
        if (typeof rest[0] === 'string') return method.apply(this, [first, escapeLogValue(rest[0], 2048), ...rest.slice(1)] as never);
        return method.apply(this, args);
      },
    },
    serializers: { err: pino.stdSerializers.err },
  };
  return cfg.destination ? pino(options, cfg.destination) : pino(options);
}

/**
 * CarPal-Request-Id (40 §1.3): a client UUID is echoed (lower-cased); any
 * other value is replaced by a server UUIDv7 so it cannot inject log content.
 */
export function resolveRequestId(header: string | undefined): string {
  if (header && header.length === 36) {
    const lower = header.toLowerCase();
    if (ID_PATTERN.test(lower)) return lower;
  }
  return uuidv7();
}

/** IP prefix for logs and rate limits (40 §2.8): /24 for IPv4, /56 for IPv6. */
export function ipPrefix(address: string | undefined): string {
  if (!address) return 'unknown';
  const a = address.startsWith('::ffff:') && isIP(address.slice(7)) === 4 ? address.slice(7) : address;
  if (isIP(a) === 4) return `${a.split('.').slice(0, 3).join('.')}.0/24`;
  if (isIP(a) === 6) {
    const groups = expandIpv6(a);
    // 56 bits = first 3 groups and the high byte of the 4th.
    return `${groups.slice(0, 3).join(':')}:${groups[3]!.slice(0, 2)}00::/56`;
  }
  return 'unknown';
}

function expandIpv6(a: string): string[] {
  const [head, tail] = a.split('::') as [string, string | undefined];
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const fill = tail === undefined ? [] : Array<string>(8 - h.length - t.length).fill('0');
  return [...h, ...fill, ...t].map((g) => g.padStart(4, '0').toLowerCase());
}

// ---------------------------------------------------------------- tracing

const tracer = trace.getTracer('carpal-backend');
const meter = metrics.getMeter('carpal-backend');

/** Per-module metrics of 41 §7 (no-ops without an SDK). */
export const appMetrics = {
  requestDuration: meter.createHistogram('carpal.http.server.duration', { unit: 'ms' }),
  requests: meter.createCounter('carpal.http.server.requests'),
  outboxLag: meter.createHistogram('carpal.outbox.lag', { unit: 'ms' }),
  consumerFailures: meter.createCounter('carpal.consumer.failures'),
  jobDuration: meter.createHistogram('carpal.job.duration', { unit: 'ms' }),
};

/** Runs `fn` inside an active span; marks the span as failed on error. */
export async function withSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean>,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await fn(span);
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw err;
    } finally {
      span.end();
    }
  });
}
