// SMTP mailer (backend S26a.T2, NI-07): the backend submits mail to the carpals.ir mailbox on the cPanel host
// (mail.carpals.ir: 465 implicit TLS, or 587 with STARTTLS) with the mailbox's login. The API server never delivers
// mail itself: the domain's SPF record ends in -all and lists only the mail hosts (BR-update-plan meta.email_check).
//
// - Pooled connection (2 sockets, 100 messages each), timeouts 10 s connect / 20 s greeting / 30 s socket.
// - TLS always: smtps:// or smtp:// with STARTTLS required; the certificate must verify (TLS 1.2+). Only dev may
//   talk plain SMTP to a loopback test server or accept a self-signed certificate (CARPAL_SMTP_TLS_INSECURE).
// - Text mail (the notification templates are plain text); subjects in Persian are RFC 2047 encoded by nodemailer;
//   Message-ID on the sending domain; List-Unsubscribe only on optional mail.
// - Hourly cap (CARPAL_MAIL_MAX_PER_HOUR, shared hosting quota): above it a deferrable message (normal-priority
//   notifications) is held until the next hour (SendError with retryAt); sign-in codes, security notices and every
//   direct send still go out.
// - Failures: an SMTP 5xx answer is permanent (SendError permanent); 4xx answers, timeouts and connection errors are
//   temporary and the caller retries. A login failure is logged as an error and retried (a settings fix brings it back).
import { randomUUID } from 'node:crypto';
import { createTransport, type Transporter } from 'nodemailer';
import { SendError, type EmailMessage, type KeyValueStore, type Mailer, type SendReceipt } from './ports.js';

export interface SmtpMailerOptions {
  /** smtps://user:password@mail.carpals.ir:465 or smtp://user:password@mail.carpals.ir:587 */
  url: string;
  from: string;
  replyTo: string | null;
  maxPerHour: number;
  env: 'dev' | 'staging' | 'prod';
  /** Dev only: accept a self-signed certificate (a local test server). */
  tlsInsecure: boolean;
  /** Shared counter of the hourly cap (Redis in full mode, memory in lite mode). */
  kv: KeyValueStore;
  now?: () => Date;
  logger?: { warn(o: object, msg: string): void; error(o: object, msg: string): void };
  /** Tests: a CA to trust (a local server's self-signed certificate) without turning verification off. */
  ca?: string;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/** The address part of "Name <addr@domain>" or "addr@domain". */
export function addressOf(from: string): string {
  const m = /<([^<>\s]+@[^<>\s]+)>/.exec(from);
  return (m ? m[1]! : from).trim();
}

export class SmtpMailer implements Mailer {
  readonly provider = 'smtp';
  readonly #transport: Transporter;
  readonly #domain: string;
  readonly #now: () => Date;

  constructor(private readonly o: SmtpMailerOptions) {
    const u = new URL(o.url);
    const secure = u.protocol === 'smtps:';
    const plainAllowed = o.env === 'dev' && LOOPBACK.has(u.hostname);
    this.#now = o.now ?? (() => new Date());
    this.#domain = addressOf(o.from).split('@')[1] ?? 'carpals.ir';
    this.#transport = createTransport({
      pool: true,
      maxConnections: 2,
      maxMessages: 100,
      host: u.hostname.replace(/^\[|\]$/g, ''),
      port: Number(u.port) || (secure ? 465 : 587),
      secure,
      requireTLS: !secure && !plainAllowed,
      ...(u.username ? { auth: { user: decodeURIComponent(u.username), pass: decodeURIComponent(u.password) } } : {}),
      tls: {
        rejectUnauthorized: !(o.env === 'dev' && o.tlsInsecure),
        servername: u.hostname,
        minVersion: 'TLSv1.2',
        ...(o.ca ? { ca: o.ca } : {}),
      },
      connectionTimeout: 10_000,
      greetingTimeout: 20_000,
      socketTimeout: 30_000,
    });
  }

  /** Opens a connection and logs in (pnpm mail:test, startup check); throws with the reason. */
  async verify(): Promise<void> {
    await this.#transport.verify();
  }

  async send(m: EmailMessage): Promise<SendReceipt> {
    const now = this.#now();
    const hour = now.toISOString().slice(0, 13);
    const key = `mail:smtp:sent:${hour}`;
    if (m.deferrable) {
      const used = Number((await this.o.kv.get(key)) ?? 0);
      if (used >= this.o.maxPerHour) {
        const next = new Date(now);
        next.setUTCMinutes(60, 0, 0);
        throw new SendError('hourly mail cap reached; held until the next hour', false, next);
      }
    }
    await this.o.kv.incr(key, 1, 2 * 3_600_000);
    const messageId = `<${randomUUID()}@${this.#domain}>`;
    try {
      const info = await this.#transport.sendMail({
        from: this.o.from,
        to: m.to,
        ...(this.o.replyTo ? { replyTo: this.o.replyTo } : {}),
        subject: m.subject ?? m.template,
        text: m.text ?? fallbackText(m),
        messageId,
        ...(m.unsubscribeUrl ? { list: { unsubscribe: { url: m.unsubscribeUrl, comment: 'Unsubscribe' } } } : {}),
        headers: { 'X-CarPal-Template': m.template },
      });
      return { providerMessageId: (info.messageId as string | undefined) ?? messageId };
    } catch (err) {
      throw classify(err, this.o.logger);
    }
  }

  close(): void {
    this.#transport.close();
  }
}

/** Without a rendered text (identity composed alone, tests): the template key and its values. */
function fallbackText(m: EmailMessage): string {
  const vars = Object.entries(m.variables).map(([k, v]) => `${k}: ${v}`);
  return [m.template, ...vars].join('\n');
}

/** Maps a nodemailer error onto the retry classes of the dispatcher (never with the login in the text). */
export function classify(err: unknown, logger?: SmtpMailerOptions['logger']): Error {
  const e = err as { responseCode?: number; code?: string; message?: string };
  const reason = `${e.code ?? 'SMTP'} ${e.responseCode ?? ''} ${(e.message ?? 'send failed').replace(/\/\/[^@\s]*@/g, '//***@')}`
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
  if (e.code === 'EAUTH') {
    logger?.error({ err: reason }, 'SMTP login refused: check CARPAL_SMTP_URL (mailbox and password)');
    return new SendError(reason, false);
  }
  if (typeof e.responseCode === 'number' && e.responseCode >= 500 && e.responseCode < 600) return new SendError(reason, true);
  logger?.warn({ err: reason }, 'SMTP send failed (temporary)');
  return new SendError(reason, false);
}
