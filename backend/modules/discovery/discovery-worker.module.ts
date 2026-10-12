// W2 search-indexer work on the worker deployable (41 §2.4): the event
// consumer (subscribed by the consumer registry) and the W15 rules.
import { Module } from '@nestjs/common';
import { SearchIndexerConsumer, SearchReconcileRule, SearchSweepRule } from './application/indexer.js';

export { SearchIndexerConsumer, SearchReconcileRule, SearchSweepRule } from './application/indexer.js';

@Module({ providers: [SearchIndexerConsumer, SearchSweepRule, SearchReconcileRule] })
export class DiscoveryWorkerModule {}
