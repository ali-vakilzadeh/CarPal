// W5 consumer (41 §6.2): every routed event becomes notifications and
// deliveries (application/dispatcher.ts). De-duplicated on event_id by the
// consumer registry; a failed delivery never fails the event (retried by the
// notification.delivery_retry rule).
import { Injectable } from '@nestjs/common';
import type { EventEnvelope } from '#libs/infra/index.js';
import { EventConsumer } from '#libs/outbox/index.js';
import { NotificationDispatcher } from '../application/dispatcher.js';
import { ROUTED_EVENTS } from '../domain/routing.js';

@Injectable()
export class NotificationDispatchConsumer extends EventConsumer {
  readonly name = 'notification.dispatch';
  readonly subjects = [...ROUTED_EVENTS];

  constructor(private readonly dispatcher: NotificationDispatcher) {
    super();
  }

  async handle(event: EventEnvelope): Promise<void> {
    await this.dispatcher.dispatch(event);
  }
}
