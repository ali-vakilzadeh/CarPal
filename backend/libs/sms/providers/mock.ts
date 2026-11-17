// Mock SMS provider (backend S26a.T3, owner decision 2026-11-16: SMS through a mock until a provider is chosen).
// It behaves like a real provider without sending anything: message ids, statuses (queued, then delivered after a
// configurable delay), billed segments, a fake balance, and failures on purpose for configured test numbers so that
// retries, the status sweep and Delivery health can be exercised. Each message, codes included, is appended to
// outbox-sms.jsonl in the data folder; outside dev the file is readable by its owner only (0600).
import { appendFileSync, chmodSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  assertE164,
  smsSegments,
  SmsSendError,
  type SmsGateway,
  type SmsOtpOptions,
  type SmsSendOptions,
  type SmsSendResult,
  type SmsStatus,
} from '../gateway.js';

export interface MockSmsOptions {
  /** Where outbox-sms.jsonl goes; null keeps messages in memory only (tests). */
  dataDir: string | null;
  /** dev: the file keeps the default mode; elsewhere it is chmod 0600. */
  restrictFile: boolean;
  /** Milliseconds after which a sent message reports delivered. */
  deliveryMs: number;
  /** Numbers whose every send is refused for good (an invalid or blocked number). */
  failPermanent?: readonly string[];
  /** Numbers whose first, third, … send fails temporarily (provider busy): the retry gets through. */
  failTemporary?: readonly string[];
  /** Numbers that are accepted but never delivered: the status turns failed after the delay. */
  undeliverable?: readonly string[];
  /** Allowed country codes (region sms_country_codes); empty: E.164 shape only. */
  countryCodes?: readonly string[];
  now?: () => number;
}

export interface MockSmsRecord {
  at: string;
  provider_message_id: string;
  to: string;
  text: string;
  category: string;
  segments: number;
  /** OTP sends: the template the real provider would have used (null: plain text). */
  otp_template: string | null;
}

export const MOCK_BALANCE = 1_000_000;

export class MockSmsGateway implements SmsGateway {
  readonly provider = 'mock';
  readonly simulated = true;
  /** The last 1,000 messages, newest last (tests read them). */
  readonly sent: MockSmsRecord[] = [];
  readonly #file: string | null;
  readonly #byKey = new Map<string, SmsSendResult>();
  readonly #attempts = new Map<string, number>();
  readonly #now: () => number;

  constructor(private readonly o: MockSmsOptions) {
    this.#now = o.now ?? Date.now;
    this.#file = o.dataDir ? join(o.dataDir, 'outbox-sms.jsonl') : null;
    if (o.dataDir) mkdirSync(o.dataDir, { recursive: true });
  }

  async sendText(to: string, text: string, options: SmsSendOptions): Promise<SmsSendResult> {
    return this.#send(to, text, options.category, options.idempotencyKey, null);
  }

  async sendOtp(to: string, code: string, options: SmsOtpOptions): Promise<SmsSendResult> {
    // A real template provider sends only the code; the mock records the text the person would read.
    const text = options.fallbackText || code;
    return this.#send(to, text, 'otp', options.idempotencyKey, options.templateKey ?? null);
  }

  status(providerMessageId: string): Promise<SmsStatus> {
    const m = /^mock-([0-9]{13})-([0-9a-f]{12})(-u)?$/.exec(providerMessageId);
    if (!m) return Promise.resolve('unknown');
    if (this.#now() - Number(m[1]) < this.o.deliveryMs) return Promise.resolve('sent');
    return Promise.resolve(m[3] ? 'failed' : 'delivered');
  }

  balance(): Promise<number | null> {
    return Promise.resolve(MOCK_BALANCE);
  }

  #send(to: string, text: string, category: string, key: string | undefined, template: string | null): SmsSendResult {
    if (key && this.#byKey.has(key)) return this.#byKey.get(key)!;
    assertE164(to, this.o.countryCodes ?? []);
    if (this.o.failPermanent?.includes(to)) throw new SmsSendError('mock: number refused by the provider', true);
    if (this.o.failTemporary?.includes(to)) {
      const n = (this.#attempts.get(to) ?? 0) + 1;
      this.#attempts.set(to, n);
      if (n % 2 === 1) throw new SmsSendError('mock: provider temporarily unavailable', false);
    }
    const undeliverable = this.o.undeliverable?.includes(to) ?? false;
    const id = `mock-${String(this.#now()).padStart(13, '0')}-${randomBytes(6).toString('hex')}${undeliverable ? '-u' : ''}`;
    const result: SmsSendResult = { provider_message_id: id, status: 'queued', segments: smsSegments(text).segments };
    const record: MockSmsRecord = {
      at: new Date(this.#now()).toISOString(),
      provider_message_id: id,
      to,
      text,
      category,
      segments: result.segments,
      otp_template: template,
    };
    this.sent.push(record);
    if (this.sent.length > 1000) this.sent.shift();
    if (this.#file) {
      const created = !existsSync(this.#file);
      appendFileSync(this.#file, `${JSON.stringify(record)}\n`, this.o.restrictFile ? { mode: 0o600 } : undefined);
      if (this.o.restrictFile && created) chmodSync(this.#file, 0o600);
    }
    if (key) this.#byKey.set(key, result);
    if (this.#byKey.size > 10_000) this.#byKey.delete(this.#byKey.keys().next().value!);
    return result;
  }
}
