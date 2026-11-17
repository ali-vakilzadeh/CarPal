// Adapter skeleton for the external SMS provider the owner will choose (DQ-28). Not registered and not built into
// the provider list: copy it to providers/<vendor>.ts, fill in the vendor's endpoints from its documentation, add the
// key to CARPAL_SMS_PROVIDER (libs/config) and one line to registry.ts, and run the port contract suite against it
// (libs/sms/sms.test.ts "SmsGateway contract", with recorded vendor answers). Nothing else in the backend changes.
//
// Settings reserved in .env.example: CARPAL_SMS_API_KEY (secret), CARPAL_SMS_SENDER_LINE (the dedicated line),
// CARPAL_SMS_OTP_TEMPLATE (the vendor's verification template, "lookup" style, for sendOtp).
//
// Rules every adapter keeps:
// - assertE164 before any network call (region sms_country_codes);
// - timeouts (5 s) with AbortSignal.timeout; a timeout or a 5xx/429 from the vendor is SmsSendError(permanent=false);
//   an invalid or blocked number, or a 4xx that a retry cannot fix, is SmsSendError(permanent=true);
// - the idempotency key goes to the vendor when it supports one, else a local short-lived map (like the mock);
// - never log the text or the code (SEC-LOG-1); log the provider message id only;
// - status() maps the vendor's states onto queued | sent | delivered | failed | unknown.
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

export interface VendorSmsOptions {
  apiKey: string;
  senderLine: string;
  otpTemplate: string | null;
  countryCodes: readonly string[];
  baseUrl: string;
}

export class ExampleVendorSmsGateway implements SmsGateway {
  readonly provider = 'example_vendor';
  readonly simulated = false;

  constructor(private readonly o: VendorSmsOptions) {}

  async sendText(to: string, text: string, _options: SmsSendOptions): Promise<SmsSendResult> {
    assertE164(to, this.o.countryCodes);
    const res = await this.#post('/sms/send', { receptor: to, sender: this.o.senderLine, message: text });
    return { provider_message_id: String(res.id), status: 'queued', segments: smsSegments(text).segments };
  }

  async sendOtp(to: string, code: string, options: SmsOtpOptions): Promise<SmsSendResult> {
    if (!this.o.otpTemplate) return this.sendText(to, options.fallbackText, { category: 'otp' });
    assertE164(to, this.o.countryCodes);
    const res = await this.#post('/verify/lookup', { receptor: to, token: code, template: this.o.otpTemplate });
    return { provider_message_id: String(res.id), status: 'queued', segments: 1 };
  }

  async status(providerMessageId: string): Promise<SmsStatus> {
    const res = await this.#post('/sms/status', { id: providerMessageId });
    return res.status === 'delivered' ? 'delivered' : res.status === 'failed' ? 'failed' : res.status === 'sent' ? 'sent' : 'unknown';
  }

  async balance(): Promise<number | null> {
    const res = await this.#post('/account/info', {});
    return typeof res.credit === 'number' ? res.credit : null;
  }

  async #post(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await fetch(`${this.o.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.o.apiKey}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      throw new SmsSendError('provider unreachable', false);
    }
    if (res.status >= 500 || res.status === 429) throw new SmsSendError(`provider answered ${res.status}`, false);
    if (!res.ok) throw new SmsSendError(`provider refused the message (${res.status})`, true);
    return (await res.json()) as Record<string, unknown>;
  }
}
