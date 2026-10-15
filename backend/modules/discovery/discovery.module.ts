// discovery module (41 §2.1 M9; 40 §14.2, feed.discover; W2). Three Nest
// modules share this folder:
//   DiscoveryModule        (global, every deployable) the search projections
//                          (SearchProjections), the search service and
//                          MatchResults (appointments from results, S7).
//   DiscoveryApiModule     search, map, safety and feed operations on the api host.
//   DiscoveryWorkerModule  W2: the indexer consumer and its W15 rules (change
//                          sweep, nightly reconciliation, rebuild at start);
//                          hosted by workers/search-indexer.
import { Global, Module } from '@nestjs/common';
import { SearchService } from './application/search-service.js';
import { DbMatchResults } from './infrastructure/match-results.js';
import { SearchProjections } from './infrastructure/projections.js';
import { MatchResults } from './interface/match-results.js';
import { DiscoveryAdminRegistrations } from './application/admin-registrations.js';

@Global()
@Module({
  providers: [DiscoveryAdminRegistrations, SearchProjections, SearchService, { provide: MatchResults, useClass: DbMatchResults }],
  exports: [SearchProjections, SearchService, MatchResults],
})
export class DiscoveryModule {}
