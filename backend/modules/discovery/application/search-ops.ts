// Search operations (40 §14.2): search.run, search.page, search.session_get,
// search.refine, search.result_event and safety.check. Sessions belong to their requester
// (RLS requester_all: user, context organization or anonymous device key);
// another caller's session is 404.
import { Injectable } from '@nestjs/common';
import { ACK, Operation, type OperationContext, type OperationHandler, type OperationResult } from '#libs/http-pipeline/index.js';
import { SafetyCheck } from '#libs/safety-check/index.js';
import {
  SearchService,
  safetyBlock,
  type IntentChip,
  type InterpretedIntent,
  type LocationInput,
  type SearchFilters,
  type SearchRequest,
} from './search-service.js';

@Injectable()
@Operation('search.run')
export class SearchRunHandler implements OperationHandler {
  constructor(private readonly search: SearchService) {}

  async handle(ctx: OperationContext<SearchRequest>): Promise<OperationResult> {
    return { body: await this.search.run(ctx, ctx.body) };
  }
}

@Injectable()
@Operation('search.page')
export class SearchPageHandler implements OperationHandler {
  constructor(private readonly search: SearchService) {}

  async handle(ctx: OperationContext<undefined, { limit?: number }>): Promise<OperationResult> {
    const offset = (ctx.cursor as { o?: number } | undefined)?.o ?? 0;
    // 40 search.page: cursor plus limit (contract 1.1.0, DI-46); the cursor carries the offset.
    const limit = ctx.query.limit ?? 20;
    const body = await ctx.tx(
      async (scope) => {
        const s = await this.search.session(scope, ctx.params.session_id!);
        await this.search.sessionContext(ctx, scope, s.row.requester_organization_id);
        const rows = await this.search.results(scope, s.row.id, offset, limit);
        const cards = await this.search.resultCards(
          scope,
          { id: s.row.id, origin: s.origin, locale: ctx.locale, vehicle: s.vehicle },
          rows.slice(0, limit),
        );
        return ctx.page(cards, rows.length > limit ? { o: offset + limit } : null);
      },
      { readOnly: true },
    );
    return { body };
  }
}

@Injectable()
@Operation('search.session_get')
export class SearchSessionGetHandler implements OperationHandler {
  constructor(private readonly search: SearchService) {}

  async handle(ctx: OperationContext<undefined, { limit?: number }>): Promise<OperationResult> {
    const body = await ctx.tx((scope) => this.search.sessionPage(ctx, scope, ctx.params.session_id!, ctx.query.limit ?? 20), {
      readOnly: true,
    });
    return { body };
  }
}

type RefineBody = {
  intent_override?: InterpretedIntent;
  filters?: SearchFilters;
  location?: LocationInput;
  vehicle_filter_applied?: boolean;
  sort?: SearchRequest['sort'];
  facets?: boolean;
};

@Injectable()
@Operation('search.refine')
export class SearchRefineHandler implements OperationHandler {
  constructor(private readonly search: SearchService) {}

  async handle(ctx: OperationContext<RefineBody>): Promise<OperationResult> {
    const b = ctx.body;
    const { req, chips } = await ctx.tx(
      async (scope) => {
        const s = await this.search.session(scope, ctx.params.session_id!);
        return { req: this.search.storedRequest(s), chips: s.stored.chips as IntentChip[] };
      },
      { readOnly: true },
    );
    // A new session with the edits; the ranking rules are unchanged (40 search.refine).
    const next: SearchRequest = {
      ...req,
      ...(b.intent_override ? { intent_override: b.intent_override } : {}),
      ...(b.filters ? { filters: b.filters } : {}),
      ...(b.location ? { location: b.location } : {}),
      ...(b.vehicle_filter_applied !== undefined ? { vehicle_filter_applied: b.vehicle_filter_applied } : {}),
      ...(b.sort ? { sort: b.sort } : {}),
      // facets default to the refined session's value (contract 1.1.0).
      ...(b.facets !== undefined ? { facets: b.facets } : {}),
    };
    return { body: await this.search.run(ctx, next, b.intent_override ? { previousChips: chips } : {}) };
  }
}

@Injectable()
@Operation('search.result_event')
export class SearchResultEventHandler implements OperationHandler {
  constructor(private readonly search: SearchService) {}

  async handle(ctx: OperationContext<{ event: 'viewed' | 'selected' }>): Promise<OperationResult> {
    await ctx.tx(async (scope) => {
      const s = await this.search.session(scope, ctx.params.session_id!);
      await this.search.markResult(scope, s.row.id, ctx.params.result_id!, ctx.body.event);
    });
    return { body: ACK };
  }
}

@Injectable()
@Operation('safety.check')
export class SafetyCheckHandler implements OperationHandler {
  constructor(private readonly safety: SafetyCheck) {}

  async handle(ctx: OperationContext<{ text: string; locale?: string }>): Promise<OperationResult> {
    // The lexicon covers every enabled language at once; locale only labels the request.
    const r = await this.safety.check(ctx.body.text);
    return { body: safetyBlock({ safety_flag: r.safety_flag, urgency: r.urgency }) };
  }
}
