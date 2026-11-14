// Account messages of the identity module (verification links, codes,
// security notices). Since S6 they go through the notification module's
// Messenger (EN/FA templates); without it (tests that compose identity alone)
// straight to the Mailer and SmsSender ports. In lite mode they land in
// backend/.data/outbox-{mail,sms}.jsonl. Variables never carry more than the
// message needs.
import { Injectable, Optional } from '@nestjs/common';
import type { Infra } from '#libs/infra/index.js';
import { InjectInfra } from '#libs/runtime/index.js';
import { Messenger } from '#modules/notification/interface/messenger.js';

export type MailTemplate =
  | 'identity.email_verification'
  | 'identity.account_exists'
  | 'identity.password_reset'
  | 'identity.email_change_notice'
  | 'identity.otp_code'
  | 'identity.password_changed'
  | 'identity.security_alert'
  | 'identity.staff_passkey_added'
  | 'identity.staff_passkey_removed'
  | 'identity.staff_recovery_codes_created'
  | 'identity.staff_break_glass_account'
  | 'identity.staff_break_glass_admins'
  | 'identity.staff_recovery_code'
  | 'identity.staff_recovery_requested_admins'
  | 'identity.staff_recovery_approved'
  | 'identity.staff_recovery_rejected'
  | 'identity.staff_recovery_completed_account'
  | 'identity.staff_recovery_completed_admins'
  | 'identity.consent_request';

@Injectable()
export class IdentityMessages {
  constructor(
    @InjectInfra() private readonly infra: Infra,
    @Optional() private readonly messenger?: Messenger,
  ) {}

  email(to: string, template: MailTemplate, locale: string, variables: Record<string, string> = {}): Promise<void> {
    return this.messenger
      ? this.messenger.email(to, template, locale, variables)
      : this.infra.mailer.send({ to, template, locale, variables });
  }

  sms(to: string, template: 'identity.otp_code', locale: string, variables: Record<string, string>): Promise<void> {
    return this.messenger ? this.messenger.sms(to, template, locale, variables) : this.infra.sms.send({ to, template, locale, variables });
  }
}
