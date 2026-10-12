// Account messages of the identity module (verification links, codes,
// security notices) through the Mailer and SmsSender ports. In lite mode they
// land in backend/.data/outbox-{mail,sms}.jsonl. Templates are keys of the
// notification dictionary; variables never carry more than the message needs.
import { Injectable } from '@nestjs/common';
import type { Infra } from '#libs/infra/index.js';
import { InjectInfra } from '#libs/runtime/index.js';

export type MailTemplate =
  | 'identity.email_verification'
  | 'identity.account_exists'
  | 'identity.password_reset'
  | 'identity.email_change_notice'
  | 'identity.otp_code'
  | 'identity.password_changed'
  | 'identity.security_alert'
  | 'identity.consent_request';

@Injectable()
export class IdentityMessages {
  constructor(@InjectInfra() private readonly infra: Infra) {}

  email(to: string, template: MailTemplate, locale: string, variables: Record<string, string> = {}): Promise<void> {
    return this.infra.mailer.send({ to, template, locale, variables });
  }

  sms(to: string, template: 'identity.otp_code', locale: string, variables: Record<string, string>): Promise<void> {
    return this.infra.sms.send({ to, template, locale, variables });
  }
}
