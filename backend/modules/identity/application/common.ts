// Helpers shared by the identity use cases.
import { randomInt } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { UserPrincipal } from '#libs/auth/index.js';
import { ApiError } from '#libs/contract/index.js';
import type { OperationContext } from '#libs/http-pipeline/index.js';
import { isTimezone } from '#libs/i18n/index.js';
import type { TxScope } from '#libs/tenancy/index.js';
import { SubscriptionReader } from '#modules/billing/interface/billing.js';
import { OrgCards } from '#modules/organization/interface/org-cards.js';
import { toMe, toMembership } from '../api/projections.js';
import { getPreferences, getUser, type MembershipRow } from '../infrastructure/accounts.js';

/** The signed-in user of a USR operation. */
export function caller(ctx: OperationContext): UserPrincipal {
  if (ctx.principal.kind !== 'user') throw new ApiError('NOT_FOUND');
  return ctx.principal;
}

/** 40 Tz: an IANA name from the tzdb allowlist (422 at `pointer` otherwise). */
export function checkTimezone(tz: string, pointer: string): void {
  if (!isTimezone(tz)) throw ApiError.validation([{ pointer, code: 'enum' }]);
}

/**
 * SEC-AU-11: sign-up, sign-in, OTP and password-reset start take a fixed
 * minimum time (configured, default 400 ms) plus 0-50 ms jitter, whether
 * they succeed or fail, so timing does not reveal whether an account exists.
 */
export async function withMinLatency<T>(minMs: number, fn: () => Promise<T>): Promise<T> {
  const started = performance.now();
  const target = minMs > 0 ? minMs + randomInt(0, 51) : 0;
  try {
    return await fn();
  } finally {
    const wait = target - (performance.now() - started);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
}

/** Builds 40 Me for the caller (memberships: active and invited, ≤ 50). */
@Injectable()
export class MeReader {
  constructor(
    private readonly orgCards: OrgCards,
    private readonly subscriptions: SubscriptionReader,
  ) {}

  async membershipViews(scope: TxScope, rows: MembershipRow[]) {
    const orgs = await this.orgCards.cards(
      scope,
      rows.map((r) => r.organization_id).filter((id): id is string => id !== null),
    );
    return rows.map((r) => toMembership(r, orgs));
  }

  async me(scope: TxScope, userId: string) {
    const user = await getUser(scope, userId);
    if (!user) throw new ApiError('NOT_FOUND');
    const pref = await getPreferences(scope, userId);
    const memberships = await scope.db
      .selectFrom('identity.role_memberships')
      .selectAll()
      .where('user_id', '=', userId)
      .where('status', 'in', ['active', 'invited'])
      .where('deleted_at', 'is', null)
      .orderBy('id')
      .limit(50)
      .execute();
    return toMe(user, pref, await this.membershipViews(scope, memberships), await this.subscriptions.summaryForUser(scope, userId));
  }
}
