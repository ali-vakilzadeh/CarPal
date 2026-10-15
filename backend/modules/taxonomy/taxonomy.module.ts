// taxonomy module (41 §2.1 M4, 40 §11): the controlled vocabulary, served
// from an in-memory catalog to the four public operations and, through
// interface/TaxonomyResolver, to every other module. Global so the platform
// (NodeId<type> checks, config.client version) and the shared safety check
// (L18) can inject its ports.
import { Global, Injectable, Module, Optional, type OnModuleInit } from '@nestjs/common';
import { JobService } from '#libs/jobs/index.js';
import type { CarpalConfig } from '#libs/config/index.js';
import { NodeTypeChecker } from '#libs/http-pipeline/index.js';
import { TaxonomyVersion } from '#libs/platform/index.js';
import { CARPAL_CONFIG } from '#libs/runtime/index.js';
import { SafetyCheck, SafetyLexicon } from '#libs/safety-check/index.js';
import { FourEyesExecutors } from '#modules/admin/interface/admin.js';
import {
  MappingsListHandler,
  MappingUpsertHandler,
  repointTaxonomy,
  startTaxonomyMerge,
  SynonymCreateHandler,
  SynonymDecideHandler,
  SynonymDeleteHandler,
  SynonymsListHandler,
  TaxonomyMergeHandler,
  TaxonomyMerger,
  TaxonomyNodeCreateHandler,
  TaxonomyNodeUpdateHandler,
} from './application/admin-ops.js';
import {
  TaxonomyNodeGetHandler,
  TaxonomySnapshotHandler,
  TaxonomySuggestHandler,
  TaxonomyVersionHandler,
} from './application/taxonomy-ops.js';
import { TaxonomyCatalog } from './infrastructure/catalog.js';
import { CatalogNodeTypeChecker, CatalogSafetyLexicon, CatalogTaxonomyVersion } from './infrastructure/ports.js';
import { TaxonomyReferences, TaxonomyResolver } from './interface/taxonomy-resolver.js';

export { TAXONOMY_MERGE_QUEUE, TaxonomyMerger } from './application/admin-ops.js';

/** Admin-plane registrations (S8): the four-eyes executor of merges and the module's own references. */
@Injectable()
export class TaxonomyAdminRegistrations implements OnModuleInit {
  constructor(
    private readonly references: TaxonomyReferences,
    private readonly jobs: JobService,
    @Optional() private readonly executors?: FourEyesExecutors,
  ) {}

  onModuleInit(): void {
    this.references.register('taxonomy', repointTaxonomy);
    this.executors?.register('admin.taxonomy_merge', async (scope, c) => void (await startTaxonomyMerge(scope, this.jobs, c)));
  }
}

@Global()
@Module({
  providers: [
    TaxonomyCatalog,
    { provide: TaxonomyResolver, useExisting: TaxonomyCatalog },
    { provide: NodeTypeChecker, useClass: CatalogNodeTypeChecker },
    { provide: TaxonomyVersion, useClass: CatalogTaxonomyVersion },
    { provide: SafetyLexicon, useClass: CatalogSafetyLexicon },
    {
      provide: SafetyCheck,
      useFactory: (lexicon: SafetyLexicon, config: CarpalConfig) => new SafetyCheck(lexicon, config.db.locale),
      inject: [SafetyLexicon, CARPAL_CONFIG],
    },
    TaxonomyVersionHandler,
    TaxonomySnapshotHandler,
    TaxonomyNodeGetHandler,
    TaxonomySuggestHandler,
    // One registry per application context (contexts share a process in pnpm dev and tests).
    { provide: TaxonomyReferences, useFactory: () => new TaxonomyReferences() },
    TaxonomyAdminRegistrations,
    TaxonomyMerger,
    // admin-api host (§23.3); other hosts skip them.
    TaxonomyNodeCreateHandler,
    TaxonomyNodeUpdateHandler,
    TaxonomyMergeHandler,
    SynonymsListHandler,
    SynonymCreateHandler,
    SynonymDecideHandler,
    SynonymDeleteHandler,
    MappingsListHandler,
    MappingUpsertHandler,
  ],
  exports: [TaxonomyResolver, NodeTypeChecker, TaxonomyVersion, SafetyLexicon, SafetyCheck, TaxonomyReferences, TaxonomyMerger],
})
export class TaxonomyModule {}
