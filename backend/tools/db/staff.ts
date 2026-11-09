// Staff accounts without the admin console (backend S12; admin console OQ-10 and BR-05).
//
// bootstrap: the first run of a deployment creates, if they do not exist, as many base staff accounts as the pilot
// needs (at least two ADM, because every ADM-only four-eyes change needs a second ADM, one MOD and one CRV; SUP is
// optional). It never changes an existing account: a staff member who exists is reported, and later role changes go
// through admin.platform_role_grant with a second approver (4EYES). It runs in every environment; outside dev the
// accounts come from a spec file and get a generated one-time password that is printed once.
//
// create / list: development helpers (create refuses outside dev; list is read-only and runs anywhere).
//
// New accounts are active with a verified email (the bootstrap is the operator's statement that the address is
// right), a password and the platform roles. They have no passkey: the first sign-in on the console asks for the
// password, a code sent to that email and a device-bound passkey (contract 1.3.0, auth.passkey_enrol). Rows are
// written as the worker in the system context, as the test fixtures do, and every creation is audited.
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { writeAudit } from '#libs/audit/index.js';
import { uuidv7, type CryptoServices } from '#libs/crypto/index.js';
import type { TxRunner, TxScope } from '#libs/tenancy/index.js';
import type { CarpalEnv } from './config.js';

/** The contract's role codes (40 §0.5) and their 52 RoleMembership.role values. */
export const ROLE_CODES = {
  ADM: 'platform_admin',
  MOD: 'platform_moderator',
  SUP: 'platform_support',
  CRV: 'platform_community_reviewer',
} as const;
export type RoleCode = keyof typeof ROLE_CODES;
const CODE_OF = Object.fromEntries(Object.entries(ROLE_CODES).map(([code, role]) => [role, code])) as Record<string, RoleCode>;

/** Pilot minimum (admin console OQ-10): two ADM for ADM-only four-eyes changes, one MOD, one CRV for Path 2 reviews. */
export const MINIMUM: Readonly<Record<RoleCode, number>> = { ADM: 2, MOD: 1, CRV: 1, SUP: 0 };

/** Development accounts: one per role plus a second ADM (admin console BR-05), all with the same password. */
export const DEV_STAFF_PASSWORD = 'carpal-staff-dev-password';
export const DEV_STAFF: readonly StaffSpec[] = [
  { email: 'adm1@staff.carpals.test', name: 'Dev Admin One', roles: ['ADM'] },
  { email: 'adm2@staff.carpals.test', name: 'Dev Admin Two', roles: ['ADM'] },
  { email: 'mod1@staff.carpals.test', name: 'Dev Moderator', roles: ['MOD'] },
  { email: 'crv1@staff.carpals.test', name: 'Dev Community Reviewer', roles: ['CRV'] },
  { email: 'sup1@staff.carpals.test', name: 'Dev Support', roles: ['SUP'] },
];

/** Recorded as the accepted terms and privacy versions: staff did not accept the consumer texts by signing up. */
export const BOOTSTRAP_POLICY_VERSION = 'staff-bootstrap';

const SpecSchema = z
  .object({
    email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
    name: z.string().trim().min(2).max(100),
    roles: z
      .array(z.enum(['ADM', 'MOD', 'SUP', 'CRV']))
      .min(1)
      .max(4),
    locale: z.enum(['fa', 'en']).optional(),
    /** Development only: a password of 12-128 characters (SEC-AU-7). */
    password: z.string().min(12).max(128).optional(),
  })
  .strict();
export type StaffSpec = z.input<typeof SpecSchema>;
type Spec = z.output<typeof SpecSchema>;

/** Validates a spec file's content: a JSON array of at most 50 accounts with unique emails. */
export function parseSpec(json: unknown, env: CarpalEnv): Spec[] {
  const parsed = z.array(SpecSchema).min(1).max(50).safeParse(json);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  [${i.path.join('.')}] ${i.message}`);
    throw new Error(`Invalid staff spec:\n${lines.join('\n')}`);
  }
  const specs = parsed.data.map((s) => ({ ...s, roles: [...new Set(s.roles)] }));
  const seen = new Set<string>();
  for (const s of specs) {
    if (seen.has(s.email)) throw new Error(`Invalid staff spec: ${s.email} is listed twice`);
    seen.add(s.email);
    if (s.password !== undefined && env !== 'dev')
      throw new Error(`Invalid staff spec: ${s.email} has a password; passwords in a file are refused outside dev (CARPAL_ENV=${env})`);
  }
  return specs;
}

/** Role counts below the pilot minimum, e.g. ["ADM: 1 of 2"]. A person may hold several roles. */
export function shortfall(specs: readonly { roles: readonly string[] }[]): string[] {
  return (Object.keys(MINIMUM) as RoleCode[])
    .filter((code) => MINIMUM[code] > 0)
    .map((code) => ({ code, have: specs.filter((s) => s.roles.includes(code)).length }))
    .filter(({ code, have }) => have < MINIMUM[code])
    .map(({ code, have }) => `${code}: ${have} of ${MINIMUM[code]}`);
}

export type StaffCommand = { kind: 'bootstrap'; file?: string } | { kind: 'create'; spec: StaffSpec } | { kind: 'list' };

const USAGE = [
  'Usage:',
  '  pnpm staff:bootstrap [--file <spec.json>]   create the base staff accounts that do not exist (any environment;',
  '                                              without --file: the development accounts, dev only)',
  '  pnpm dev:staff create --email <e> --name <n> --roles ADM,MOD,SUP,CRV [--locale fa|en] [--password <p>]   (dev only)',
  '  pnpm dev:staff list                         staff accounts and their roles',
].join('\n');

export function parseStaffArgs(argv: readonly string[]): StaffCommand {
  const [command, ...rest] = argv;
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const k = rest[i]!;
    const v = rest[i + 1];
    if (!k.startsWith('--') || v === undefined || v.startsWith('--')) throw new Error(`Expected --name value pairs, got "${k}"\n${USAGE}`);
    flags.set(k.slice(2), v);
  }
  const only = (...allowed: string[]) => {
    const extra = [...flags.keys()].filter((k) => !allowed.includes(k));
    if (extra.length) throw new Error(`Unknown option --${extra[0]} for ${command}\n${USAGE}`);
  };
  switch (command) {
    case 'bootstrap':
      only('file');
      return flags.has('file') ? { kind: 'bootstrap', file: flags.get('file')! } : { kind: 'bootstrap' };
    case 'create': {
      only('email', 'name', 'roles', 'locale', 'password');
      const roles = (flags.get('roles') ?? '')
        .split(',')
        .map((r) => r.trim().toUpperCase())
        .filter(Boolean);
      return {
        kind: 'create',
        spec: {
          email: flags.get('email') ?? '',
          name: flags.get('name') ?? '',
          roles: roles as RoleCode[],
          ...(flags.has('locale') ? { locale: flags.get('locale') as 'fa' | 'en' } : {}),
          ...(flags.has('password') ? { password: flags.get('password')! } : {}),
        },
      };
    }
    case 'list':
      only();
      return { kind: 'list' };
    default:
      throw new Error(USAGE);
  }
}

export interface StaffResult {
  email: string;
  roles: RoleCode[];
  status: 'created' | 'exists';
  /** Created accounts only: the password to hand over (dev: the known development password). */
  password?: string;
}

export interface StaffDeps {
  tx: TxRunner;
  crypto: CryptoServices;
  env: CarpalEnv;
}

/** Creates every spec'd account that does not exist yet; existing accounts are left exactly as they are. */
export async function bootstrapStaff(deps: StaffDeps, specs: readonly Spec[]): Promise<StaffResult[]> {
  const out: StaffResult[] = [];
  for (const spec of specs) out.push(await createOne(deps, spec));
  return out;
}

async function createOne(deps: StaffDeps, spec: Spec): Promise<StaffResult> {
  const password = spec.password ?? (deps.env === 'dev' ? DEV_STAFF_PASSWORD : randomBytes(18).toString('base64url'));
  const hash = await deps.crypto.passwords.hash(password);
  return deps.tx.run({ actorType: 'system' }, async (scope) => {
    const existing = await scope.db
      .selectFrom('identity.user_accounts')
      .select('id')
      .where('email', '=', spec.email)
      .where('deleted_at', 'is', null)
      .where('status', '<>', 'deleted')
      .forUpdate()
      .executeTakeFirst();
    if (existing) return { email: spec.email, roles: await rolesOf(scope, existing.id), status: 'exists' as const };
    const id = uuidv7();
    await scope.db
      .insertInto('identity.user_accounts')
      .values({
        id,
        full_name: spec.name,
        display_name: spec.name.slice(0, 50).trim().length >= 2 ? spec.name.slice(0, 50).trim() : null,
        email: spec.email,
        locale: spec.locale ?? 'fa',
        status: 'active',
        email_verified_at: new Date(),
        terms_version: BOOTSTRAP_POLICY_VERSION,
        privacy_policy_version: BOOTSTRAP_POLICY_VERSION,
      })
      .execute();
    await scope.db
      .insertInto('identity.authentication_methods')
      .values({ user_id: id, method_type: 'email_password', identifier: spec.email, credential_reference: hash, status: 'active' })
      .execute();
    for (const code of spec.roles)
      await scope.db
        .insertInto('identity.role_memberships')
        .values({ user_id: id, role: ROLE_CODES[code], status: 'active', joined_at: new Date() })
        .execute();
    await writeAudit(scope, {
      action: 'staff.bootstrap_created',
      entityType: 'user_account',
      entityId: id,
      reason: 'first-run staff bootstrap (admin console OQ-10)',
      next: spec.roles.join(','),
    });
    return { email: spec.email, roles: spec.roles, status: 'created' as const, password };
  });
}

async function rolesOf(scope: TxScope, userId: string): Promise<RoleCode[]> {
  const rows = await scope.db
    .selectFrom('identity.role_memberships')
    .select('role')
    .where('user_id', '=', userId)
    .where('organization_id', 'is', null)
    .where('role', 'like', 'platform\\_%')
    .where('status', '=', 'active')
    .where('deleted_at', 'is', null)
    .execute();
  return rows
    .map((r) => CODE_OF[r.role])
    .filter((c): c is RoleCode => !!c)
    .sort();
}

/** Every account with an active platform role. */
export async function listStaff(deps: Pick<StaffDeps, 'tx'>): Promise<{ email: string; roles: RoleCode[]; passkeys: number }[]> {
  return deps.tx.run(
    { actorType: 'system' },
    async (scope) => {
      const rows = await scope.db
        .selectFrom('identity.role_memberships as m')
        .innerJoin('identity.user_accounts as u', 'u.id', 'm.user_id')
        .select(['u.id', 'u.email', 'm.role'])
        .where('m.organization_id', 'is', null)
        .where('m.role', 'like', 'platform\\_%')
        .where('m.status', '=', 'active')
        .where('m.deleted_at', 'is', null)
        .where('u.deleted_at', 'is', null)
        .orderBy('u.email')
        .execute();
      const keys = await scope.db
        .selectFrom('identity.authentication_methods')
        .select(['user_id'])
        .where('method_type', '=', 'webauthn')
        .where('status', '=', 'active')
        .where('deleted_at', 'is', null)
        .where('user_id', 'in', rows.length ? rows.map((r) => r.id) : ['00000000-0000-0000-0000-000000000000'])
        .execute();
      const byUser = new Map<string, { email: string; roles: RoleCode[]; passkeys: number }>();
      for (const r of rows) {
        const e = byUser.get(r.id) ?? { email: r.email, roles: [], passkeys: keys.filter((k) => k.user_id === r.id).length };
        const code = CODE_OF[r.role];
        if (code) e.roles.push(code);
        byUser.set(r.id, e);
      }
      return [...byUser.values()].map((e) => ({ ...e, roles: e.roles.sort() }));
    },
    { readOnly: true },
  );
}

export function assertDev(env: CarpalEnv, what: string): void {
  if (env !== 'dev')
    throw new Error(`${what} only runs with CARPAL_ENV=dev (this is ${env}); use pnpm staff:bootstrap --file <spec.json>.`);
}
