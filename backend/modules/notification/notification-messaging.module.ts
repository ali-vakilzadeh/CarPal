// Transactional messaging of the notification module (Messenger with the
// EN/FA templates). A separate global module so the auth host (identity
// schema only, GD-14) can send account mails without the rest of the module.
import { Global, Module } from '@nestjs/common';
import { TemplateMessenger } from './infrastructure/template-messenger.js';
import { Messenger } from './interface/messenger.js';

@Global()
@Module({ providers: [{ provide: Messenger, useClass: TemplateMessenger }], exports: [Messenger] })
export class NotificationMessagingModule {}
