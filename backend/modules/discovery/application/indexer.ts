// W2 search-indexer (41 §2.4, §6.2; S6.T2): keeps the search projections in
// step with the owning modules. Events rebuild what they touch; a change
// sweep every minute picks up organization edits that publish no event
// (catalog, coverage, capabilities, certifications, portfolio); a nightly
// reconciliation rebuilds everything and removes what is no longer public.
// In lite mode the index lives in the worker's memory, so the scheduler's
// first run of the reconciliation rebuilds it (CARPAL_SEARCH_REBUILD_ON_START).
import { Injectable } from '@nestjs/common';
import type { CarpalConfig } from '#libs/config/index.js';
import type { EventEnvelope } from '#libs/infra/index.js';
import { ScheduledRule } from '#libs/jobs/index.js';
import { EventConsumer } from '#libs/outbox/index.js';
import { InjectConfig } from '#libs/runtime/index.js';
import { TxRunner } from '#libs/tenancy/index.js';
import type { CommunityEntity } from '#modules/community/interface/community.js';
import { PublicProfiles } from '#modules/organization/interface/public-profiles.js';
import { SearchProjections } from '../infrastructure/projections.js';

/** Organization-level events: the organization's documents are rebuilt. */
const ORG_EVENTS = [
  'provider.profile.published',
  'provider.profile.unpublished',
  'vendor.profile.published',
  'vendor.profile.unpublished',
  'organization.profile.updated',
  'organization.verified',
  'organization.location.corrected',
  'vendor.inventory.imported',
  // S7-S8 producers (reviews, badges, trust scores, moderation); consumed now so they need no indexer change.
  'review.published',
  'review.approved',
  'review.removed',
  'badge.awarded',
  'badge.revoked',
  'trust.score.changed',
  'moderation.action.taken',
  // S7: availability (next open slot) changes with confirmations and calendar edits.
  'appointment.confirmed',
  'appointment.availability.changed',
];

const str = (v: unknown): string | null => (typeof v === 'string' && /^[0-9a-f-]{36}$/.test(v) ? v : null);

@Injectable()
export class SearchIndexerConsumer extends EventConsumer {
  readonly name = 'discovery.search_indexer';
  readonly subjects = [
    ...ORG_EVENTS,
    'inventory.updated',
    'portfolio.published',
    'community.content.changed',
    'qna.question.created',
    'taxonomy.node.merged',
  ];

  constructor(private readonly projections: SearchProjections) {
    super();
  }

  async handle(e: EventEnvelope): Promise<void> {
    const p = e.payload;
    if (ORG_EVENTS.includes(e.type)) {
      const org =
        str(p.organization_id) ??
        str(p.vendor_organization_id) ??
        str(p.subject_organization_id) ??
        str(p.provider_organization_id) ??
        e.organizationId;
      const target = org ?? (e.aggregateType === 'organization' ? e.aggregateId : null);
      if (target) await this.projections.reindexOrgs([target]);
      return;
    }
    switch (e.type) {
      case 'inventory.updated': {
        const ids = Array.isArray(p.item_ids) ? p.item_ids.filter((x): x is string => typeof x === 'string') : [];
        if (ids.length) await this.projections.reindexItems(ids);
        else await this.projections.reindexOrgs([e.aggregateId]);
        return;
      }
      case 'portfolio.published': {
        // Moderation approves on the admin plane (no path organization): the payload names it (S8).
        const org = str(p.organization_id) ?? e.organizationId;
        await this.projections.reindexCommunity([{ type: 'portfolio_item', id: e.aggregateId }]);
        if (org) await this.projections.reindexOrgs([org]);
        return;
      }
      case 'community.content.changed':
        await this.projections.reindexCommunity([
          { type: (p.entity_type as CommunityEntity) ?? e.aggregateType, id: str(p.entity_id) ?? e.aggregateId },
        ]);
        return;
      case 'qna.question.created':
        await this.projections.reindexCommunity([{ type: 'question', id: e.aggregateId }]);
        return;
      case 'taxonomy.node.merged':
        await this.projections.ensureTaxonomy();
        return;
    }
  }
}

/** Every minute: organizations whose public data changed since the last sweep (no event for catalog edits, DI-45). */
@Injectable()
export class SearchSweepRule extends ScheduledRule {
  readonly name = 'discovery.search_sweep';
  readonly everyMs = 60_000;
  #since = new Date();

  constructor(
    private readonly tx: TxRunner,
    private readonly profiles: PublicProfiles,
    private readonly projections: SearchProjections,
  ) {
    super();
  }

  async run(): Promise<number> {
    let total = 0;
    for (let i = 0; i < 20; i++) {
      const { ids, until } = await this.tx.run({ actorType: 'system' }, (scope) => this.profiles.changedSince(scope, this.#since, 200));
      if (ids.length === 0 || !until) break;
      await this.projections.reindexOrgs(ids);
      total += ids.length;
      this.#since = until;
      if (ids.length < 200) break;
    }
    return total;
  }
}

/**
 * Nightly reconciliation (41 §6.3): rebuild everything public, remove the
 * rest. The scheduler runs every rule once when the worker starts, which
 * rebuilds the lite index (in memory, so empty at start); with
 * CARPAL_SEARCH_REBUILD_ON_START=0 (tests) that first run is skipped.
 */
@Injectable()
export class SearchReconcileRule extends ScheduledRule {
  readonly name = 'discovery.search_reconcile';
  readonly everyMs = 86_400_000;
  #first = true;

  constructor(
    private readonly projections: SearchProjections,
    @InjectConfig() private readonly config: CarpalConfig,
  ) {
    super();
  }

  async run(): Promise<unknown> {
    const first = this.#first;
    this.#first = false;
    if (first && !this.config.search.rebuildOnStart) return { skipped: 'rebuild on start disabled' };
    return this.projections.reconcile();
  }
}
