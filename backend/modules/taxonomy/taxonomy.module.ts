// taxonomy module (41 §2.1 M4, 40 §11): the controlled vocabulary, served
// from an in-memory catalog to the four public operations and, through
// interface/TaxonomyResolver, to every other module. Global so the platform
// (NodeId<type> checks, config.client version) and the shared safety check
// (L18) can inject its ports.
import { Global, Module } from '@nestjs/common';
import type { CarpalConfig } from '#libs/config/index.js';
import { NodeTypeChecker } from '#libs/http-pipeline/index.js';
import { TaxonomyVersion } from '#libs/platform/index.js';
import { CARPAL_CONFIG } from '#libs/runtime/index.js';
import { SafetyCheck, SafetyLexicon } from '#libs/safety-check/index.js';
import {
  TaxonomyNodeGetHandler,
  TaxonomySnapshotHandler,
  TaxonomySuggestHandler,
  TaxonomyVersionHandler,
} from './application/taxonomy-ops.js';
import { TaxonomyCatalog } from './infrastructure/catalog.js';
import { CatalogNodeTypeChecker, CatalogSafetyLexicon, CatalogTaxonomyVersion } from './infrastructure/ports.js';
import { TaxonomyResolver } from './interface/taxonomy-resolver.js';

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
  ],
  exports: [TaxonomyResolver, NodeTypeChecker, TaxonomyVersion, SafetyLexicon, SafetyCheck],
})
export class TaxonomyModule {}
