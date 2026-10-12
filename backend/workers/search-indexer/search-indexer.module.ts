// W2 search-indexer host (41 §2.4): the discovery module's indexer consumer,
// change sweep and nightly reconciliation (52 §10 projections).
import { Module } from '@nestjs/common';
import { DiscoveryWorkerModule } from '#modules/discovery/discovery-worker.module.js';

@Module({ imports: [DiscoveryWorkerModule] })
export class SearchIndexerModule {}
