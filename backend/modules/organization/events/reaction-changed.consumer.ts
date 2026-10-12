// community.reaction.changed → portfolio items (S6): the cached like_count of
// a portfolio item (52 PortfolioItem) follows the community module's count,
// which already leaves out the provider's own members (SEC-BF-9). The count
// is absolute, so a redelivery is harmless.
import { Injectable } from '@nestjs/common';
import type { EventEnvelope } from '#libs/infra/index.js';
import { EventConsumer } from '#libs/outbox/index.js';
import { TxRunner } from '#libs/tenancy/index.js';

@Injectable()
export class ReactionChangedPortfolioConsumer extends EventConsumer {
  readonly name = 'organization.reaction_changed';
  readonly subjects = ['community.reaction.changed'];

  constructor(private readonly tx: TxRunner) {
    super();
  }

  async handle(event: EventEnvelope): Promise<void> {
    const p = event.payload;
    if (p.target_type !== 'portfolio_item' || p.reaction_type !== 'like' || typeof p.target_id !== 'string') return;
    const count = Math.max(0, Math.trunc(Number(p.count) || 0));
    await this.tx.run({ actorType: 'system', requestId: event.requestId }, async ({ db }) => {
      await db
        .updateTable('organization.portfolio_items')
        .set({ like_count: count })
        .where('id', '=', p.target_id as string)
        .where('like_count', '<>', count)
        .execute();
    });
  }
}
