// Messenger (interface/messenger.ts): renders the EN/FA template and sends it
// through the Mailer or SmsSender port. Template key and variables travel
// with the rendered text (the lite sinks record both).
import { Injectable } from '@nestjs/common';
import type { Infra } from '#libs/infra/index.js';
import { InjectInfra } from '#libs/runtime/index.js';
import { render } from '../domain/templates.js';
import { Messenger } from '../interface/messenger.js';

@Injectable()
export class TemplateMessenger extends Messenger {
  constructor(@InjectInfra() private readonly infra: Infra) {
    super();
  }

  async email(to: string, template: string, locale: string, variables: Record<string, string> = {}): Promise<void> {
    const r = render(template, locale, variables);
    await this.infra.mailer.send({ to, template, locale, variables, subject: r.subject, text: r.text });
  }

  async sms(to: string, template: string, locale: string, variables: Record<string, string> = {}): Promise<void> {
    await this.infra.sms.send({ to, template, locale, variables, text: render(template, locale, variables).text });
  }
}
