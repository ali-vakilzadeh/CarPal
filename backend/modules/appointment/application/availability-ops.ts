// public.availability (40 §14.3). S6 placeholder: the provider and location
// are checked for real (published provider, active location of that
// organization), but no slots are computed yet: availability rules, buffers,
// capacity, time off and existing appointments belong to the appointment
// module of S7, which replaces this handler's slot computation. Until then
// the answer is an empty list (S6 deviation).
import { Injectable } from '@nestjs/common';
import { ApiError } from '#libs/contract/index.js';
import { Operation, type OperationContext, type OperationHandler, type OperationResult } from '#libs/http-pipeline/index.js';
import { PublicProfiles } from '#modules/organization/interface/public-profiles.js';

type Query = { location_id: string; from: string; days: number; appointment_type?: string };

@Injectable()
@Operation('public.availability')
export class PublicAvailabilityHandler implements OperationHandler {
  constructor(private readonly profiles: PublicProfiles) {}

  async handle(ctx: OperationContext<undefined, Query>): Promise<OperationResult> {
    const orgId = ctx.params.org_id!;
    const body = await ctx.tx(
      async (scope) => {
        const card = (await this.profiles.cards(scope, [orgId])).get(orgId);
        if (!card?.roles.includes('provider')) throw new ApiError('NOT_FOUND');
        const pins = (await this.profiles.pins(scope, [orgId])).get(orgId) ?? [];
        if (!pins.some((p) => p.location_id === ctx.query.location_id))
          throw ApiError.validation([{ pointer: '/location_id', code: 'reference_not_found' }], 'REFERENCE_NOT_FOUND');
        return { slots: [] };
      },
      { readOnly: true },
    );
    return { body, cache: { public: 60 } };
  }
}
