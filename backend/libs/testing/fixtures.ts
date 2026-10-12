// Test fixtures with RLS kept real (S2.T14). Rows are written through a
// privileged connection (carpal_worker, system context) exactly as the owning
// modules store them; the application under test connects with its real role
// (carpal_api, carpal_admin_api, …), so RLS applies to every request.
//
// Isolation strategy: one shared database per test run (pnpm test:int runs
// db:setup once), no reset between tests. Every fixture gets fresh UUIDv7 ids
// and unique emails, and tests assert only on rows they created. Template
// clones lose the per-database role settings (S1 notes) and per-test rollback
// cannot cover an HTTP app with its own transactions; `pnpm db:reset` wipes
// local data when needed.
import { CLIENTS, type Acr, type ClientId, type SessionStore, type TokenService } from '#libs/auth/index.js';
import type { CarpalConfig } from '#libs/config/index.js';
import type { OrgType } from '#libs/contract/generated/enums.js';
import { CryptoServices, uuidv7 } from '#libs/crypto/index.js';
import type { TxRunner } from '#libs/tenancy/index.js';

export interface TestUser {
  id: string;
  email: string;
  /** Platform roles (staff) granted to the user. */
  platformRoles: string[];
}

export interface TestOrg {
  id: string;
  type: OrgType;
}

export interface TokenOptions {
  clientId?: ClientId;
  acr?: Acr;
  /** Epoch seconds of the last authentication (default: now). */
  authTime?: number;
  /** Staff session on the admin host (aal3, admin audience). */
  staff?: boolean;
  /** Session of an account without a second factor (fresh aal1 satisfies AAL2, see Authenticator.requireAssurance). */
  mfaEnrolled?: boolean;
}

export class Fixtures {
  constructor(
    private readonly tx: TxRunner,
    private readonly tokens: TokenService,
    private readonly sessions: SessionStore,
    private readonly config: CarpalConfig,
  ) {}

  /** The fixtures' transaction runner (carpal_worker): run consumers and system-context checks as the worker would. */
  get worker(): TxRunner {
    return this.tx;
  }

  /** An active user with a verified email (identity.user_accounts; the bootstrap trigger adds preferences and the individual role). */
  async user(o: { locale?: 'en' | 'fa'; platformRoles?: string[]; status?: 'active' | 'suspended' } = {}): Promise<TestUser> {
    const id = uuidv7();
    const email = `t-${id}@test.carpal.app`;
    await this.tx.run({ actorType: 'system' }, async ({ db }) => {
      await db
        .insertInto('identity.user_accounts')
        .values({
          id,
          full_name: 'Test User',
          email,
          locale: o.locale ?? 'en',
          status: o.status ?? 'active',
          email_verified_at: new Date(),
          terms_version: '1.0',
          privacy_policy_version: '1.0',
        })
        .execute();
      for (const role of o.platformRoles ?? []) {
        await db.insertInto('identity.role_memberships').values({ user_id: id, role, status: 'active', joined_at: new Date() }).execute();
      }
    });
    return { id, email, platformRoles: o.platformRoles ?? [] };
  }

  /** Adds an active email_password method (Argon2id) to a user. */
  async withPassword(user: TestUser, password: string): Promise<void> {
    const hash = await new CryptoServices(this.config.secrets.master).passwords.hash(password);
    await this.tx.run({ actorType: 'system' }, ({ db }) =>
      db
        .insertInto('identity.authentication_methods')
        .values({ user_id: user.id, method_type: 'email_password', identifier: user.email, credential_reference: hash, status: 'active' })
        .execute(),
    );
  }

  async staff(...roles: string[]): Promise<TestUser> {
    return this.user({ platformRoles: roles.length ? roles : ['platform_admin'] });
  }

  async org(type: OrgType, o: { status?: 'draft' | 'active' | 'suspended' } = {}): Promise<TestOrg> {
    const id = uuidv7();
    await this.tx.run({ actorType: 'system' }, ({ db }) =>
      db
        .insertInto('organization.organizations')
        .values({
          id,
          name: `Test ${type} ${id.slice(-6)}`,
          organization_type: type,
          contact_email: `org-${id}@test.carpal.app`,
          status: o.status ?? 'active',
        })
        .execute(),
    );
    return { id, type };
  }

  async member(user: TestUser, org: TestOrg, role: string, status: 'active' | 'suspended' | 'removed' = 'active'): Promise<void> {
    await this.tx.run({ actorType: 'system' }, ({ db }) =>
      db
        .insertInto('identity.role_memberships')
        .values({ user_id: user.id, organization_id: org.id, role, status, joined_at: new Date() })
        .execute(),
    );
  }

  /** A user who is a member of a new organization of `type` with `role`. */
  async memberOf(type: OrgType, role: string): Promise<{ user: TestUser; org: TestOrg; token: string }> {
    const [user, org] = await Promise.all([this.user(), this.org(type)]);
    await this.member(user, org, role);
    return { user, org, token: await this.token(user) };
  }

  /** Creates a live session in the KV store and an access token for it. */
  async token(user: TestUser, o: TokenOptions = {}): Promise<string> {
    const clientId = o.clientId ?? (o.staff ? 'cp-web-admin' : 'cp-mobile');
    const acr = o.acr ?? (o.staff ? 'aal3' : 'aal1');
    const authTime = o.authTime ?? Math.floor(Date.now() / 1000);
    const sid = uuidv7();
    await this.sessions.create(
      {
        sid,
        userId: user.id,
        clientId,
        acr,
        authTime,
        createdAt: new Date().toISOString(),
        staff: !!o.staff,
        ...(o.mfaEnrolled !== undefined ? { mfaEnrolled: o.mfaEnrolled } : {}),
      },
      3_600_000,
    );
    return this.tokens.issue({
      subject: user.id,
      clientId,
      audience: o.staff ? this.config.http.audiences['admin-api'] : this.config.http.audiences.api,
      sessionId: sid,
      acr,
      authTime,
      scope: 'openid',
      ttlSeconds: CLIENTS[clientId].accessTtlS,
    });
  }

  /** Anonymous client token (SEC-AU-14). */
  async anonymousToken(clientId: ClientId = 'cp-mobile'): Promise<string> {
    return this.tokens.issue({
      subject: uuidv7(),
      clientId,
      audience: this.config.http.audiences.api,
      acr: 'anonymous',
      scope: 'public.read search',
      ttlSeconds: 900,
      cnf: { jkt: uuidv7() },
    });
  }

  /** A current subscription of an organization to a plan (as admin.subscription_assign or org.create would create it). */
  async subscription(org: TestOrg, planKey: string, o: { status?: 'trial' | 'active'; vehicleLimit?: number } = {}): Promise<string> {
    const id = uuidv7();
    await this.tx.run({ actorType: 'system' }, async ({ db }) => {
      const plan = await db.selectFrom('billing.plans').select('id').where('plan_key', '=', planKey).executeTakeFirstOrThrow();
      await db
        .insertInto('billing.subscriptions')
        .values({
          id,
          subscriber_type: 'organization',
          subscriber_id: org.id,
          plan_id: plan.id,
          status: o.status ?? 'active',
          ...(o.status === 'trial' ? { trial_ends_at: new Date(Date.now() + 30 * 86_400_000) } : {}),
          ...(o.vehicleLimit !== undefined ? { vehicle_limit_override: o.vehicleLimit } : {}),
        })
        .execute();
    });
    return id;
  }

  /** A background job row (core.background_jobs) owned by a user, optionally of an organization. */
  async job(
    owner: TestUser,
    o: { orgId?: string; status?: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' } = {},
  ): Promise<string> {
    const id = uuidv7();
    await this.tx.run({ actorType: 'system' }, ({ db }) =>
      db
        .insertInto('core.background_jobs')
        .values({
          id,
          kind: 'data_export',
          owner_user_id: owner.id,
          organization_id: o.orgId ?? null,
          owning_module: 'identity',
          status: o.status ?? 'queued',
          ...(o.status === 'succeeded' ? { result_type: 'data_subject_request', result_id: uuidv7(), progress: 100 } : {}),
          ...(o.status === 'failed' ? { error_code: 'INTERNAL' } : {}),
        })
        .execute(),
    );
    return id;
  }
}

/** The CarPal-Client header matching a token's client (CarPal-Client must equal client_id). */
export const clientHeader = (clientId: ClientId = 'cp-mobile'): string =>
  `${clientId}/1.0.0 (${clientId === 'cp-mobile' ? 'ios' : 'web'} 17.4)`;
