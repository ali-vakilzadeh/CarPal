// The forwarder's allowlist (AC3.T4, SEC-WEB-1, GD-07 amendment), adapted from pwa/src/server/bff/allowlist.ts (GD-03):
// built from the generated admin operation map (src/lib/api/generated/operations.ts, `pnpm contract:generate`), never
// from a hand-written list (R-06). Only admin-api routes are forwarded; the map holds no api-host read since AC2
// (the api host refuses cp-web-admin tokens), and one would be refused here until the forwarder learns a second host.
// Everything else — consumer and business routes, auth-host operations — answers 404 at the BFF.
import { ADMIN_OPERATIONS, type AdminOperationId, type AdminOperationMeta } from '@/lib/api/generated';

export interface AllowedRoute {
  opId: AdminOperationId;
  op: AdminOperationMeta;
  pattern: RegExp;
}

export type RouteMatch =
  | { kind: 'ok'; route: AllowedRoute; params: Record<string, string> }
  | { kind: 'method_not_allowed'; allow: string[] }
  | { kind: 'not_found' };

/** Path parameter values: one non-empty segment of unreserved or percent-encoded characters (ids, slugs, keys). */
const SEGMENT = '((?:[A-Za-z0-9._~-]|%[0-9A-Fa-f]{2})+)';

function compile(path: string): RegExp {
  const source = path
    .split('/')
    .map((part) => (/^\{[a-z_]+\}$/.test(part) ? SEGMENT : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('/');
  return new RegExp(`^${source}$`);
}

export class AdminAllowlist {
  readonly routes: readonly AllowedRoute[];

  constructor(operations: Readonly<Record<string, AdminOperationMeta>> = ADMIN_OPERATIONS) {
    const routes: AllowedRoute[] = [];
    for (const [opId, op] of Object.entries(operations)) {
      if (op.plane !== 'admin' || op.host !== 'admin-api' || !op.path.startsWith('/v1/admin/')) continue;
      routes.push({ opId: opId as AdminOperationId, op, pattern: compile(op.path) });
    }
    // Literal segments win over parameters (e.g. /v1/admin/users/search before /v1/admin/users/{user_id}).
    routes.sort((a, b) => literalWeight(b.op.path) - literalWeight(a.op.path));
    this.routes = routes;
  }

  match(method: string, path: string): RouteMatch {
    const allow = new Set<string>();
    for (const r of this.routes) {
      const m = r.pattern.exec(path);
      if (!m) continue;
      if (r.op.method !== method) {
        allow.add(r.op.method);
        continue;
      }
      const params: Record<string, string> = {};
      r.op.pathParams.forEach((name, i) => (params[name] = m[i + 1]!));
      return { kind: 'ok', route: r, params };
    }
    return allow.size ? { kind: 'method_not_allowed', allow: [...allow] } : { kind: 'not_found' };
  }
}

function literalWeight(path: string): number {
  return path.split('/').filter((p) => p && !p.startsWith('{')).length;
}

/**
 * Rejects paths that could mean something else upstream than they mean here: encoded slashes or backslashes, dot
 * segments, empty segments, and anything outside printable ASCII. (Copied unchanged from the PWA.)
 */
export function isCanonicalPath(path: string): boolean {
  if (!/^\/[\x21-\x7e]*$/.test(path)) return false;
  if (/%2f|%5c|\\/i.test(path)) return false;
  return path
    .split('/')
    .slice(1)
    .every((seg) => seg !== '' && seg !== '.' && seg !== '..' && !/^%2e/i.test(seg));
}
