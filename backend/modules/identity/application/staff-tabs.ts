// User tabs on the admin plane (backend S23, admin console BR-16, DI-07; 40 §23.2): admin.user_consents (A-USR-02
// Consents: the full history, read-only) and admin.user_sessions (Sessions & devices). Both are PURP PII: the purpose
// is bound to the user in the path (S14) and each read writes its pii.read entry before anything is returned.
import { Injectable } from '@nestjs/common';
import { SessionStore } from '#libs/auth/index.js';
import { ApiError } from '#libs/contract/index.js';
import { Operation, type OperationContext, type OperationHandler, type OperationResult } from '#libs/http-pipeline/index.js';
import type { TxScope } from '#libs/tenancy/index.js';
import { auditStaffRead, staffOf } from '#modules/admin/interface/admin.js';
import { PushDevicesRead } from '#modules/notification/interface/push-devices.js';
import { toSession } from '../api/projections.js';
import { ConsentViews, listConsents } from './consent-ops.js';

const MAX_SESSIONS = 100;
const MAX_DEVICES = 50;

/** The user named in the path must exist (404 otherwise; a deleted account is not listed either). */
async function requireUser(scope: TxScope, id: string): Promise<void> {
  const u = await scope.db
    .selectFrom('identity.user_accounts')
    .select('id')
    .where('id', '=', id)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  if (!u) throw new ApiError('NOT_FOUND');
}

/** 40 admin.user_consents: the user's consent records, active and withdrawn, newest first (as consents.list). */
@Injectable()
@Operation('admin.user_consents')
export class AdminUserConsentsHandler implements OperationHandler {
  constructor(private readonly views: ConsentViews) {}

  async handle(ctx: OperationContext<undefined, { consent_type?: string; active?: boolean; limit: number }>): Promise<OperationResult> {
    const s = staffOf(ctx);
    const userId = ctx.params.user_id!;
    await ctx.tx(async (scope) => {
      await requireUser(scope, userId);
      await auditStaffRead(scope, s, 'user', userId, 'consent history');
    });
    return { body: await listConsents(ctx, { type: 'user', id: userId }, this.views) };
  }
}

/** 40 admin.user_sessions: active sessions (newest first, at most 100) and push devices; never tokens. */
@Injectable()
@Operation('admin.user_sessions')
export class AdminUserSessionsHandler implements OperationHandler {
  constructor(
    private readonly sessions: SessionStore,
    private readonly devices: PushDevicesRead,
  ) {}

  async handle(ctx: OperationContext): Promise<OperationResult> {
    const s = staffOf(ctx);
    const userId = ctx.params.user_id!;
    const devices = await ctx.tx(async (scope) => {
      await requireUser(scope, userId);
      await auditStaffRead(scope, s, 'user', userId, 'sessions and devices');
      return this.devices.forUser(scope, userId, MAX_DEVICES);
    });
    const all = (await this.sessions.list(userId)).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.sid.localeCompare(a.sid));
    const sessions = all.slice(0, MAX_SESSIONS).map((x) => {
      // The staff caller's session is never one of the user's: `current` has no meaning here.
      const { current: _current, ...view } = toSession(x, '');
      return { ...view, staff: x.staff };
    });
    return { body: { sessions, sessions_total: all.length, push_devices: devices } };
  }
}
