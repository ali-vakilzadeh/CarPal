// File SMS provider (the lite sink before S26a): appends each message to outbox-sms.jsonl and reports it sent. It
// has no delivery status (unknown) and never fails on purpose; kept for setups that read the sink file directly.
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  assertE164,
  smsSegments,
  type SmsGateway,
  type SmsOtpOptions,
  type SmsSendOptions,
  type SmsSendResult,
  type SmsStatus,
} from '../gateway.js';

export class FileSmsGateway implements SmsGateway {
  readonly provider = 'file';
  readonly simulated = true;
  readonly sent: { to: string; text: string; provider_message_id: string }[] = [];
  readonly #file: string | null;

  constructor(
    dataDir: string | null,
    private readonly countryCodes: readonly string[] = [],
  ) {
    this.#file = dataDir ? join(dataDir, 'outbox-sms.jsonl') : null;
    if (dataDir) mkdirSync(dataDir, { recursive: true });
  }

  async sendText(to: string, text: string, options: SmsSendOptions): Promise<SmsSendResult> {
    assertE164(to, this.countryCodes);
    const id = `file-${randomBytes(8).toString('hex')}`;
    const entry = { to, text, provider_message_id: id };
    this.sent.push(entry);
    if (this.sent.length > 1000) this.sent.shift();
    if (this.#file)
      appendFileSync(this.#file, `${JSON.stringify({ at: new Date().toISOString(), category: options.category, ...entry })}\n`);
    return { provider_message_id: id, status: 'sent', segments: smsSegments(text).segments };
  }

  sendOtp(to: string, _code: string, options: SmsOtpOptions): Promise<SmsSendResult> {
    return this.sendText(to, options.fallbackText, { category: 'otp' });
  }

  status(): Promise<SmsStatus> {
    return Promise.resolve('unknown');
  }

  balance(): Promise<number | null> {
    return Promise.resolve(null);
  }
}
