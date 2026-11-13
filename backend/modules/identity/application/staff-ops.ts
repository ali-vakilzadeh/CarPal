// Staff directory on the admin plane (contract 1.4.0, 40 §23.2; admin console
// BR-10, A-STAFF-01). Staff are user accounts with platform_* role
// memberships (52 RoleMembership, organization_id null). Disabling a staff
// member suspends every platform role at once and ends their sessions; the
// account and any business membership stay as they are, so the person keeps
// using the consumer app. Enabling gives the suspended roles back and, like a
// role grant, waits for a second administrator (4EYES). The platform always
// keeps one active administrator, and nobody disables themselves.
import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { writeAudit } from '#libs/audit/index.js';
import { SessionStore } from '#libs/auth/index.js';
import { Authorizer } from '#libs/authz/index.js';
import { ApiError } from '#libs/contract/index.js';
import { isoOrNull, Operation, type OperationContext, type OperationHandler, type OperationResult } from '#libs/http-pipeline/index.js';
import type { TxScope } from '#libs/tenancy/index.js';
import { FourEyes, StaffNames, staffOf, type Staff } from '#modules/admin/interface/admin.js';

const ROLE_ORDER = ['platform_admin', 'platform_moderator', 'platform_support', 'platform_community_reviewer'];
const byRoleOrder = (roles: readonly string[]) =>
  ROLE_ORDER.filter((r) => roles.includes(r)) as (
    'platform_admin' | 'platform_moderator' | 'platform_support' | 'platform_community_reviewer'
  )[];
const isAdmin = (s: Staff) => s.roles.includes('platform_admin');

/** "a***@staff.carpals.test": enough to tell colleagues apart, not a contact address. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) return '***';
  return `${email[0]}***${email.slice(at)}`.slice(0, 120);
}

interface StaffRow {
  id: string;
  email: string;
  account_status: string;
  last_active_at: Date | null;
  active_roles: string[] | null;
  suspended_roles: string[] | null;
  passkeys: string;
}

/** Staff rows: one per user with a platform role that is active or suspended (not removed). */
async function staffRows(
  scope: TxScope,
  o: { userId?: string; role?: string; status?: 'active' | 'disabled'; after?: string; limit: number },
): Promise<StaffRow[]> {
  const { rows } = await sql<StaffRow>`
    SELECT u.id, u.email, u.status AS account_status, u.last_active_at,
           array_agg(m.role ORDER BY m.role) FILTER (WHERE m.status = 'active') AS active_roles,
           array_agg(m.role ORDER BY m.role) FILTER (WHERE m.status = 'suspended') AS suspended_roles,
           (SELECT count(*) FROM identity.authentication_methods a
             WHERE a.user_id = u.id AND a.method_type = 'webauthn' AND a.status = 'active' AND a.deleted_at IS NULL) AS passkeys
      FROM identity.role_memberships m
      JOIN identity.user_accounts u ON u.id = m.user_id AND u.deleted_at IS NULL
     WHERE m.organization_id IS NULL AND m.role LIKE 'platform\\_%' AND m.status IN ('active', 'suspended')
       AND m.deleted_at IS NULL
       ${o.userId ? sql`AND u.id = ${o.userId}::uuid` : sql``}
       ${o.after ? sql`AND u.id > ${o.after}::uuid` : sql``}
     GROUP BY u.id
    HAVING true
       ${o.role ? sql`AND bool_or(m.role = ${o.role})` : sql``}
       ${o.status === 'active' ? sql`AND bool_or(m.status = 'active')` : sql``}
       ${o.status === 'disabled' ? sql`AND NOT bool_or(m.status = 'active')` : sql``}
     ORDER BY u.id
     LIMIT ${o.limit}`.execute(scope.db);
  return rows;
}

/** 40 StaffMember: platform_admin callers get the directory fields, other staff name and roles only. */
function toStaffMember(r: StaffRow, displayName: string, full: boolean) {
  const active = r.active_roles ?? [];
  const status = active.length > 0 ? ('active' as const) : ('disabled' as const);
  const base = {
    user_id: r.id,
    display_name: displayName.slice(0, 50),
    // A disabled member shows the roles an enable would give back.
    platform_roles: byRoleOrder(status === 'active' ? active : (r.suspended_roles ?? [])),
    status,
  };
  if (!full) return base;
  return {
    ...base,
    email_masked: maskEmail(r.email),
    account_status: r.account_status,
    passkey_count: Math.min(100, Number(r.passkeys)),
    last_sign_in_at: isoOrNull(r.last_active_at),
  };
}

async function oneStaff(scope: TxScope, names: StaffNames, userId: string, locale: string) {
  const [row] = await staffRows(scope, { userId, limit: 1 });
  if (!row) throw new ApiError('NOT_FOUND');
  return toStaffMember(row, await names.name(scope, row.id, locale), true);
}

type ListQuery = { role?: string; status?: 'active' | 'disabled'; limit: number };

@Injectable()
@Operation('admin.staff_list')
export class AdminStaffListHandler implements OperationHandler {
  constructor(private readonly names: StaffNames) {}

  async handle(ctx: OperationContext<undefined, ListQuery>): Promise<OperationResult> {
    const s = staffOf(ctx);
    const full = isAdmin(s);
    const q = ctx.query;
    const after = (ctx.cursor as { id?: string } | undefined)?.id;
    // Other staff see active colleagues only (for assigning work); asking for disabled ones lists nobody.
    const status = full ? q.status : 'active';
    const body = await ctx.tx(
      async (scope) => {
        if (!full && q.status === 'disabled') return ctx.page([], null);
        const rows = await staffRows(scope, {
          ...(q.role ? { role: q.role } : {}),
          ...(status ? { status } : {}),
          ...(after ? { after } : {}),
          limit: q.limit + 1,
        });
        const page = rows.slice(0, q.limit);
        const names = await this.names.names(
          scope,
          page.map((r) => r.id),
          ctx.locale,
        );
        return ctx.page(
          page.map((r) => toStaffMember(r, names.get(r.id)!, full)),
          rows.length > q.limit ? { id: page.at(-1)!.id } : null,
        );
      },
      { readOnly: true },
    );
    return { body };
  }
}

@Injectable()
@Operation('admin.staff_disable')
export class AdminStaffDisableHandler implements OperationHandler {
  constructor(
    private readonly names: StaffNames,
    private readonly sessions: SessionStore,
    private readonly authorizer: Authorizer,
  ) {}

  async handle(ctx: OperationContext<{ reason: string }>): Promise<OperationResult> {
    const s = staffOf(ctx);
    const userId = ctx.params.user_id!;
    if (userId === s.userId) throw new ApiError('SELF_APPROVAL_FORBIDDEN', { detail: 'own account' });
    const body = await ctx.tx(async (scope) => {
      // Lock every active administrator first, always in id order: two admins disabling each other then run one
      // after the other (no deadlock), and the second sees the first's change (READ COMMITTED re-checks the rows).
      const admins = await scope.db
        .selectFrom('identity.role_memberships')
        .select('user_id')
        .where('role', '=', 'platform_admin')
        .where('organization_id', 'is', null)
        .where('status', '=', 'active')
        .where('deleted_at', 'is', null)
        .orderBy('id')
        .forUpdate()
        .execute();
      const memberships = await scope.db
        .selectFrom('identity.role_memberships')
        .select(['id', 'role', 'status'])
        .where('user_id', '=', userId)
        .where('organization_id', 'is', null)
        .where('role', 'like', 'platform\\_%')
        .where('status', 'in', ['active', 'suspended'])
        .where('deleted_at', 'is', null)
        .forUpdate()
        .execute();
      if (memberships.length === 0) throw new ApiError('NOT_FOUND');
      const active = memberships.filter((m) => m.status === 'active');
      if (active.length === 0) throw new ApiError('INVALID_TRANSITION', { detail: 'already_disabled' });
      // The platform keeps an administrator (reachable only by a race: the caller is an active one).
      if (active.some((m) => m.role === 'platform_admin') && !admins.some((a) => a.user_id !== userId))
        throw new ApiError('INVALID_TRANSITION', { detail: 'last_admin' });
      await scope.db
        .updateTable('identity.role_memberships')
        .set({ status: 'suspended' })
        .where(
          'id',
          'in',
          active.map((m) => m.id),
        )
        .execute();
      await writeAudit(scope, {
        action: 'staff.disabled',
        entityType: 'user',
        entityId: userId,
        reason: ctx.body.reason,
        previous: byRoleOrder(active.map((m) => m.role)).join(', '),
        next: 'disabled',
      });
      scope.afterCommit(async () => {
        await this.sessions.revokeAll(userId);
        await this.authorizer.invalidateUser(userId);
      });
      return oneStaff(scope, this.names, userId, ctx.locale);
    });
    return { body };
  }
}

/** Disabled staff member: platform roles that are all suspended (none active). */
async function suspendedRoles(scope: TxScope, userId: string, lock: boolean) {
  const q = scope.db
    .selectFrom('identity.role_memberships')
    .select(['id', 'role', 'status'])
    .where('user_id', '=', userId)
    .where('organization_id', 'is', null)
    .where('role', 'like', 'platform\\_%')
    .where('status', 'in', ['active', 'suspended'])
    .where('deleted_at', 'is', null);
  const rows = await (lock ? q.forUpdate() : q).execute();
  if (rows.length === 0) throw new ApiError('NOT_FOUND');
  if (rows.some((m) => m.status === 'active')) throw new ApiError('INVALID_TRANSITION', { detail: 'not_disabled' });
  return rows;
}

@Injectable()
@Operation('admin.staff_enable')
export class AdminStaffEnableHandler implements OperationHandler {
  constructor(
    private readonly fourEyes: FourEyes,
    private readonly names: StaffNames,
  ) {}

  async handle(ctx: OperationContext<{ reason: string }>): Promise<OperationResult> {
    const s = staffOf(ctx);
    const userId = ctx.params.user_id!;
    const body = await ctx.tx(async (scope) => {
      const roles = byRoleOrder((await suspendedRoles(scope, userId, false)).map((m) => m.role));
      const name = await this.names.name(scope, userId, ctx.locale);
      return this.fourEyes.request(
        scope,
        s.userId,
        {
          opId: 'admin.staff_enable',
          targetType: 'user',
          targetId: userId,
          payload: { user_id: userId },
          summary: `Enable staff member ${name} (user ${userId}) with ${roles.join(', ')}`,
          reason: ctx.body.reason,
          requiredRole: 'platform_admin',
        },
        ctx.locale,
      );
    });
    return { status: 202, body };
  }
}

/** Four-eyes executor of admin.staff_enable: the suspended platform roles become active again. */
export async function enableStaff(scope: TxScope, authorizer: Authorizer, userId: string, reason: string): Promise<void> {
  const rows = await suspendedRoles(scope, userId, true);
  await scope.db
    .updateTable('identity.role_memberships')
    .set({ status: 'active' })
    .where(
      'id',
      'in',
      rows.map((m) => m.id),
    )
    .execute();
  await writeAudit(scope, {
    action: 'staff.enabled',
    entityType: 'user',
    entityId: userId,
    reason,
    previous: 'disabled',
    next: byRoleOrder(rows.map((m) => m.role)).join(', '),
  });
  scope.afterCommit(() => authorizer.invalidateUser(userId));
}
