// pnpm contract:generate — writes src/lib/api/generated/ (AC1.T2) from the backend's generated registry
// (backend/libs/contract/generated/operations.json):
//   operations.ts  the admin-api operations (host admin-api, Docs/40 §23) plus the short list of api-host reads of
//                  GD-07, with method, path, staff roles and the sec tags the console acts on (RSN, PURP, 4EYES, ETAG,
//                  IDEM, ASYNC, AAL3, PII, AUD, RL). The BFF allowlist (AC3) and the typed client are built on it.
//   roles.ts       the role table: staff role → operations it may call (GD-09). The UI hides; the server decides.
//   types.ts       request and response types of these operations, picked from @carpal/api-contracts (the full
//                  typed contract the PWA generator writes into shared/api-contracts/generated), so the console never
//                  carries a second copy of the 400-operation type file.
// pnpm contract:check — exits 1 when the generated files are stale, or when shared/api-contracts/generated was made
// from another registry than the backend's (then run `pnpm contract:generate` in pwa/ first).
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const repoDir = join(appDir, '..', '..');

export const PATHS = {
  registry: join(repoDir, 'backend', 'libs', 'contract', 'generated', 'operations.json'),
  sharedOperations: join(repoDir, 'shared', 'api-contracts', 'generated', 'operations.ts'),
  out: join(appDir, 'src', 'lib', 'api', 'generated'),
};

/** The contract version this plan was written against; a new version is a reviewed change (meta.sources_of_truth). */
export const EXPECTED_CONTRACT = '1.2.0';

/**
 * GD-07: api-host reads the console may forward besides the admin plane. Whether the cp-web-admin token is accepted
 * on the api host is checked in AC2 (BR-04); until then these entries are marked `plane: 'api-read'`.
 */
export const API_READS = ['me.get', 'config.client', 'taxonomy.version', 'taxonomy.snapshot', 'taxonomy.node_get'] as const;

/** The four staff roles of Docs/40 §0.5 and their RoleMembership.role values (GD-09). */
export const STAFF_ROLES = {
  ADM: 'platform_admin',
  MOD: 'platform_moderator',
  SUP: 'platform_support',
  CRV: 'platform_community_reviewer',
} as const;
export type StaffRole = keyof typeof STAFF_ROLES;

interface SecTag {
  tag: string;
  args?: string[];
  qualifier?: string;
}
interface Route {
  scope: string;
  host: 'api' | 'admin-api' | 'auth' | 'storage';
  method: string;
  path: string;
  pathParams: string[];
  security: { principals: SecTag[][]; tags: SecTag[] };
}
interface Operation {
  opId: string;
  section: string;
  module: string;
  summary: string;
  method: string;
  routes: Route[];
  successStatus: number;
  inputEncoding: 'none' | 'json' | 'form' | 'raw';
  sec: string;
  errors: { status: number; code: string }[];
}
export interface Registry {
  contractVersion: string;
  sourceSha256: string;
  operationCount: number;
  operations: Operation[];
}

/** A tag that always applies (true), only under the listed conditions (string[]), or not at all (false). */
type Conditional = boolean | string[];

export interface AdminOperation {
  plane: 'admin' | 'api-read';
  section: string;
  module: string;
  method: string;
  host: string;
  path: string;
  pathParams: string[];
  successStatus: number;
  inputEncoding: string;
  /** Staff roles allowed (STF(...)); empty for the api-host reads (any signed-in staff member, if AC2 confirms). */
  roles: StaffRole[];
  /** Narrowing of the role set, e.g. "moderation changes only" on four_eyes_decide (MOD). */
  roleQualifier: string | null;
  reason: boolean;
  purpose: boolean;
  fourEyes: Conditional;
  etag: boolean;
  idempotent: boolean;
  async: boolean;
  aal3: Conditional;
  pii: boolean;
  audited: boolean;
  rateLimit: string | null;
  sec: string;
  errors: string[];
}

const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, 'utf8')) as T;

function conditional(tags: SecTag[], name: string): Conditional {
  const tag = tags.find((t) => t.tag === name);
  if (!tag) return false;
  return tag.args && tag.args.length > 0 ? [...tag.args] : true;
}

/** The console's view of one registry operation (one route: the admin plane has no scoped duplicates). */
export function toAdminOperation(op: Operation, plane: AdminOperation['plane']): AdminOperation {
  if (op.routes.length !== 1) throw new Error(`${op.opId}: expected one route, found ${op.routes.length}`);
  const route = op.routes[0]!;
  const tags = route.security.tags;
  const has = (name: string) => tags.some((t) => t.tag === name);
  const staff = route.security.principals.flat().filter((t) => t.tag === 'STF');
  if (plane === 'admin' && staff.length !== 1) throw new Error(`${op.opId}: expected exactly one STF(...) principal`);
  const roles = [...new Set(staff.flatMap((t) => t.args ?? []))];
  for (const r of roles) if (!(r in STAFF_ROLES)) throw new Error(`${op.opId}: unknown staff role ${r}`);
  return {
    plane,
    section: op.section,
    module: op.module,
    method: op.method,
    host: route.host,
    path: route.path,
    pathParams: route.pathParams,
    successStatus: op.successStatus,
    inputEncoding: op.inputEncoding,
    roles: (Object.keys(STAFF_ROLES) as StaffRole[]).filter((r) => roles.includes(r)),
    roleQualifier: staff[0]?.qualifier ?? null,
    reason: has('RSN'),
    purpose: has('PURP'),
    fourEyes: conditional(tags, '4EYES'),
    etag: has('ETAG'),
    idempotent: has('IDEM'),
    async: has('ASYNC'),
    aal3: conditional(tags, 'AAL3'),
    pii: has('PII'),
    audited: has('AUD'),
    rateLimit: tags.find((t) => t.tag === 'RL')?.args?.[0] ?? null,
    sec: op.sec,
    errors: [...new Set(op.errors.map((e) => e.code))],
  };
}

export function selectOperations(registry: Registry): Map<string, AdminOperation> {
  const out = new Map<string, AdminOperation>();
  for (const op of registry.operations) {
    if (op.routes.some((r) => r.host === 'admin-api')) out.set(op.opId, toAdminOperation(op, 'admin'));
  }
  for (const id of API_READS) {
    const op = registry.operations.find((o) => o.opId === id);
    if (!op) throw new Error(`GD-07 api read ${id} is not in the registry`);
    if (op.method !== 'GET') throw new Error(`GD-07 api read ${id} is not a GET`);
    out.set(id, toAdminOperation(op, 'api-read'));
  }
  return out;
}

/** The CONTRACT constant of shared/api-contracts/generated/operations.ts (written by the PWA generator). */
export function sharedContractOf(text: string): { version: string; sourceSha256: string } | null {
  const m = /export const CONTRACT = (\{[^\n]*\}) as const;/.exec(text);
  if (!m?.[1]) return null;
  return JSON.parse(m[1]) as { version: string; sourceSha256: string };
}

function header(registry: Registry): string {
  return (
    `// GENERATED by frontend/admin-console/tools/contract/generate.ts from backend/libs/contract/generated/operations.json` +
    ` (contract ${registry.contractVersion}, Docs/40 sha256 ${registry.sourceSha256.slice(0, 12)}).\n// Do not edit; run \`pnpm contract:generate\` in frontend/admin-console/.\n`
  );
}

export function generateFiles(registry: Registry): Map<string, string> {
  const ops = selectOperations(registry);
  const admin = [...ops.values()].filter((o) => o.plane === 'admin').length;
  const head = header(registry);
  const ids = [...ops.keys()];

  const operations = [
    head,
    `export const ADMIN_CONTRACT = ${JSON.stringify({
      version: registry.contractVersion,
      sourceSha256: registry.sourceSha256,
      adminOperationCount: admin,
      apiReadCount: ops.size - admin,
    })} as const;\n`,
    `export type StaffRole = 'ADM' | 'MOD' | 'SUP' | 'CRV';`,
    `/** A tag that always applies (true), only under the listed conditions, or not at all (false). */`,
    `export type Conditional = boolean | readonly string[];\n`,
    `export interface AdminOperationMeta {`,
    `  /** 'admin' = admin-api (Docs/40 §23); 'api-read' = a GD-07 read on the api host (accepted for cp-web-admin once AC2 confirms). */`,
    `  readonly plane: 'admin' | 'api-read';`,
    `  readonly section: string;`,
    `  readonly module: string;`,
    `  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';`,
    `  readonly host: 'api' | 'admin-api';`,
    `  readonly path: string;`,
    `  readonly pathParams: readonly string[];`,
    `  readonly successStatus: number;`,
    `  readonly inputEncoding: 'none' | 'json' | 'form' | 'raw';`,
    `  /** STF(...) roles; empty on api reads. */`,
    `  readonly roles: readonly StaffRole[];`,
    `  readonly roleQualifier: string | null;`,
    `  /** RSN: body 'reason' (CarPal-Reason header on DELETE). */`,
    `  readonly reason: boolean;`,
    `  /** PURP: CarPal-Access-Purpose header (GD-10). */`,
    `  readonly purpose: boolean;`,
    `  /** 4EYES: answers 202 PendingChange (GD-11). */`,
    `  readonly fourEyes: Conditional;`,
    `  readonly etag: boolean;`,
    `  readonly idempotent: boolean;`,
    `  readonly async: boolean;`,
    `  /** AAL3 step-up (GD-11): always, or only for the listed actions. */`,
    `  readonly aal3: Conditional;`,
    `  readonly pii: boolean;`,
    `  readonly audited: boolean;`,
    `  readonly rateLimit: string | null;`,
    `  /** The sec: line of Docs/40, for display and review. */`,
    `  readonly sec: string;`,
    `  readonly errors: readonly string[];`,
    `}\n`,
    `export const ADMIN_OPERATIONS = {`,
    ...[...ops].map(([id, op]) => `  ${JSON.stringify(id)}: ${JSON.stringify(op)},`),
    `} as const satisfies Record<string, AdminOperationMeta>;\n`,
    `export type AdminOperationId = keyof typeof ADMIN_OPERATIONS;`,
    `export const ADMIN_OPERATION_IDS = Object.keys(ADMIN_OPERATIONS) as AdminOperationId[];\n`,
  ].join('\n');

  const roleTable: Record<string, string[]> = {};
  for (const role of Object.keys(STAFF_ROLES)) roleTable[role] = ids.filter((id) => ops.get(id)!.roles.includes(role as StaffRole));
  const roles = [
    head,
    `import type { AdminOperationId, StaffRole } from './operations';\n`,
    `/** Docs/40 §0.5: staff role → RoleMembership.role. */`,
    `export const STAFF_ROLES = ${JSON.stringify(STAFF_ROLES)} as const satisfies Record<StaffRole, string>;\n`,
    `/** GD-09 role table: the admin operations each staff role may call (sec: STF(...)). The server always decides. */`,
    `export const ROLE_TABLE = {`,
    ...Object.entries(roleTable).map(([role, list]) => `  ${role}: ${JSON.stringify(list)},`),
    `} as const satisfies Record<StaffRole, readonly AdminOperationId[]>;\n`,
  ].join('\n');

  const types = [
    head,
    `// Request and response types of the console's operations, picked from the full contract in @carpal/api-contracts.`,
    `import type { OperationTypes } from '@carpal/api-contracts';`,
    `import type { AdminOperationId } from './operations';\n`,
    `export type AdminOperationTypes = Pick<OperationTypes, AdminOperationId>;`,
    `export type AdminPath<Id extends AdminOperationId> = AdminOperationTypes[Id]['path'];`,
    `export type AdminQuery<Id extends AdminOperationId> = AdminOperationTypes[Id]['query'];`,
    `export type AdminInput<Id extends AdminOperationId> = AdminOperationTypes[Id]['input'];`,
    `export type AdminResponse<Id extends AdminOperationId> = AdminOperationTypes[Id]['response'];\n`,
  ].join('\n');

  const files = new Map<string, string>();
  files.set('operations.ts', operations);
  files.set('roles.ts', roles);
  files.set('types.ts', types);
  files.set('index.ts', `${head}\nexport * from './operations';\nexport * from './roles';\nexport * from './types';\n`);
  return files;
}

/** Files that differ from the generated content (missing, changed or extra). */
export function staleFiles(files: Map<string, string>, outDir = PATHS.out): string[] {
  const stale: string[] = [];
  for (const [name, content] of files) {
    const target = join(outDir, name);
    if (!existsSync(target) || readFileSync(target, 'utf8') !== content) stale.push(name);
  }
  if (existsSync(outDir)) for (const f of readdirSync(outDir)) if (!files.has(f)) stale.push(`${f} (extra)`);
  return stale;
}

/** Everything contract:check reports; empty = in step. */
export function contractProblems(registry: Registry, paths = PATHS): string[] {
  const problems: string[] = [];
  if (registry.contractVersion !== EXPECTED_CONTRACT)
    problems.push(
      `contract is ${registry.contractVersion}, this console expects ${EXPECTED_CONTRACT} (review, then update EXPECTED_CONTRACT)`,
    );
  const shared = existsSync(paths.sharedOperations) ? sharedContractOf(readFileSync(paths.sharedOperations, 'utf8')) : null;
  if (!shared || shared.sourceSha256 !== registry.sourceSha256)
    problems.push('shared/api-contracts/generated is not made from this registry: run `pnpm contract:generate` in pwa/');
  const stale = staleFiles(generateFiles(registry), paths.out);
  if (stale.length > 0) problems.push(`src/lib/api/generated is stale (${stale.join(', ')}): run \`pnpm contract:generate\``);
  return problems;
}

function main(argv: string[]): void {
  const registry = readJson<Registry>(PATHS.registry);
  const ops = selectOperations(registry);
  const admin = [...ops.values()].filter((o) => o.plane === 'admin').length;
  if (argv.includes('--check')) {
    const problems = contractProblems(registry);
    if (problems.length > 0) {
      console.error(`Admin contract check failed:\n  ${problems.join('\n  ')}`);
      process.exit(1);
    }
    console.log(
      `Admin contract ${registry.contractVersion} is up to date: ${admin} admin-api operations + ${ops.size - admin} api reads (GD-07).`,
    );
    return;
  }
  const files = generateFiles(registry);
  rmSync(PATHS.out, { recursive: true, force: true });
  mkdirSync(PATHS.out, { recursive: true });
  for (const [name, content] of files) writeFileSync(join(PATHS.out, name), content);
  console.log(`Wrote ${files.size} files to src/lib/api/generated (${admin} admin-api operations + ${ops.size - admin} api reads).`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv.slice(2));
