// SmsSender over the SmsGateway port (backend S26a.T3): the notification dispatcher and the identity messages keep
// the SmsSender port; this adapter turns each message into a gateway call. The one-time code (identity.otp_code)
// goes through sendOtp, so a provider with a verification template service uses it; everything else is sendText.
// Gateway failures become SendError (permanent or temporary) for the dispatcher's retry classes.
import { SmsSendError, type SmsGateway } from '#libs/sms/index.js';
import { SendError, type SendReceipt, type SmsMessage, type SmsSender } from './ports.js';

export class GatewaySmsSender implements SmsSender {
  /** Messages the gateway accepted, newest last (the last 1,000; tests read them like the old file sink). */
  readonly sent: SmsMessage[] = [];

  constructor(
    readonly gateway: SmsGateway,
    private readonly otpTemplate: string | null = null,
  ) {}

  get provider(): string {
    return this.gateway.provider;
  }

  async send(m: SmsMessage): Promise<SendReceipt> {
    const text = m.text ?? Object.values(m.variables).join(' ') ?? m.template;
    try {
      const code = m.variables.code;
      const r =
        m.template === 'identity.otp_code' && code
          ? await this.gateway.sendOtp(m.to, code, {
              templateKey: this.otpTemplate,
              locale: m.locale,
              fallbackText: text,
              ...(m.idempotencyKey ? { idempotencyKey: m.idempotencyKey } : {}),
            })
          : await this.gateway.sendText(m.to, text, {
              category: m.template.startsWith('identity.') ? 'transactional' : 'notification',
              ...(m.idempotencyKey ? { idempotencyKey: m.idempotencyKey } : {}),
            });
      this.sent.push(m);
      if (this.sent.length > 1000) this.sent.shift();
      return { providerMessageId: r.provider_message_id };
    } catch (err) {
      if (err instanceof SmsSendError) throw new SendError(err.message, err.permanent);
      throw err;
    }
  }
}
