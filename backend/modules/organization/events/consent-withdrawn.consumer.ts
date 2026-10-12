// consent.withdrawn → portfolio items (41 §6.2, SEC-AZ-8): a customer who
// withdraws showcase consent for an item takes it off public pages at once.
// The item returns to draft with customer_consent_status = withdrawn; the
// provider may ask again. Idempotent (only rows still marked granted or
// requested change).
import { Injectable } from '@nestjs/common';
import type { EventEnvelope } from '#libs/infra/index.js';
import { EventConsumer } from '#libs/outbox/index.js';
import { TxRunner } from '#libs/tenancy/index.js';

@Injectable()
export class ConsentWithdrawnPortfolioConsumer extends EventConsumer {
  readonly name = 'organization.consent_withdrawn';
  readonly subjects = ['consent.withdrawn'];

  constructor(private readonly tx: TxRunner) {
    super();
  }

  async handle(event: EventEnvelope): Promise<void> {
    const p = event.payload;
    if (p.scope_entity_type !== 'portfolio_item' || typeof p.scope_entity_id !== 'string') return;
    if (p.consent_type !== 'showcase_publishing' && p.consent_type !== 'photo_publishing') return;
    await this.tx.run({ actorType: 'system', requestId: event.requestId }, async ({ db }) => {
      await db
        .updateTable('organization.portfolio_items')
        .set({ customer_consent_status: 'withdrawn', consent_reference_id: null, status: 'draft', moderation_status: 'pending' })
        .where('id', '=', p.scope_entity_id as string)
        .where('customer_consent_status', 'in', ['granted', 'requested'])
        .where('status', '<>', 'archived')
        .execute();
    });
  }
}
