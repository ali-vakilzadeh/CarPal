// SMS gateway port (backend S26a.T3, NI-07, DQ-28). Every text message the backend sends goes through SmsGateway:
// the identity OTP codes and the notification module's SMS deliveries reach it through the SmsSender port of
// libs/infra (GatewaySmsSender). A provider is one adapter file behind this interface (providers/*.ts) plus its entry
// in the registry (registry.ts); nothing else changes when the owner chooses the external SMS provider.
//
// The helpers every provider shares live here: the E.164 check against the region's SMS country codes (SEC-AU-8,
// anti SMS pumping), the segment count (GSM-7 160/153, UCS-2 for Persian 70/67) and the opt-out keywords.

/** Provider-side status of one message. */
export type SmsStatus = 'queued' | 'sent' | 'delivered' | 'failed' | 'unknown';

/** Why a message is sent: providers bill and route OTP and transactional traffic differently. */
export type SmsCategory = 'otp' | 'transactional' | 'notification';

export interface SmsSendResult {
  /** The provider's id of the message (status lookups, Delivery health). */
  provider_message_id: string;
  status: SmsStatus;
  /** Billed parts (concatenated SMS). */
  segments: number;
}

export interface SmsSendOptions {
  category: SmsCategory;
  /** The same key never sends twice (a retried delivery, a double click). */
  idempotencyKey?: string;
}

export interface SmsOtpOptions {
  /** The provider's verification template ("lookup" style); without one, sendText is the fallback. */
  templateKey?: string | null;
  locale: string;
  idempotencyKey?: string;
  /** The rendered text, used when the provider has no template service. */
  fallbackText: string;
}

/**
 * A send that failed. permanent: the provider refused this message for good (invalid number, blocked, no route); a
 * retry cannot help. Otherwise the failure is temporary (timeout, throttling, provider down) and the caller retries.
 */
export class SmsSendError extends Error {
  constructor(
    message: string,
    readonly permanent: boolean,
  ) {
    super(message);
    this.name = 'SmsSendError';
  }
}

export interface SmsGateway {
  /** Short machine key recorded on every delivery attempt (Delivery health), e.g. mock, file, kavenegar. */
  readonly provider: string;
  /** True when no message leaves the server (mock, file): startup warns and admin.system_health shows it. */
  readonly simulated: boolean;
  sendText(to: string, text: string, options: SmsSendOptions): Promise<SmsSendResult>;
  sendOtp(to: string, code: string, options: SmsOtpOptions): Promise<SmsSendResult>;
  status(providerMessageId: string): Promise<SmsStatus>;
  /** Remaining credit in the provider's unit, or null when the provider does not say. */
  balance(): Promise<number | null>;
}

// ------------------------------------------------------------------ shared helpers

const E164 = /^\+[1-9][0-9]{7,14}$/;

/**
 * E.164 (+, country code, 8-15 digits) and, when the region lists them, one of its SMS country codes. Throws a
 * permanent SmsSendError: a number that fails here never becomes deliverable by retrying.
 */
export function assertE164(to: string, countryCodes: readonly string[] = []): void {
  if (!E164.test(to)) throw new SmsSendError('destination is not an E.164 number', true);
  if (countryCodes.length > 0 && !countryCodes.some((cc) => to.startsWith(cc)))
    throw new SmsSendError('destination country is not allowed for SMS in this region', true);
}

// GSM 03.38 default alphabet and its extension table (each extension character costs two septets).
const GSM7_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM7_EXTENDED = '^{}\\[~]|€\f';

/** Encoding and billed parts of a text: GSM-7 160 per message or 153 per part; UCS-2 (Persian) 70 or 67. */
export function smsSegments(text: string): { encoding: 'gsm7' | 'ucs2'; segments: number; units: number } {
  let septets = 0;
  let gsm = true;
  for (const ch of text) {
    if (GSM7_BASIC.includes(ch)) septets += 1;
    else if (GSM7_EXTENDED.includes(ch)) septets += 2;
    else {
      gsm = false;
      break;
    }
  }
  if (gsm) return { encoding: 'gsm7', units: septets, segments: septets === 0 ? 1 : septets <= 160 ? 1 : Math.ceil(septets / 153) };
  // UCS-2 counts UTF-16 code units (a character outside the BMP takes two).
  const units = text.length;
  return { encoding: 'ucs2', units, segments: units <= 70 ? 1 : Math.ceil(units / 67) };
}

/** Reply keywords that ask to stop messages (English and Persian, with Persian digits folded). */
export const OPT_OUT_KEYWORDS = ['stop', 'unsubscribe', 'cancel', 'لغو', 'لغو۱۱', 'لغو11', 'توقف'] as const;

/** True when an incoming reply asks to stop messages (for the vendor adapter's inbound hook, when one exists). */
export function isOptOut(reply: string): boolean {
  const t = reply
    .trim()
    .toLowerCase()
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/\s+/g, '');
  return OPT_OUT_KEYWORDS.some((k) => t === k.replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d))));
}
