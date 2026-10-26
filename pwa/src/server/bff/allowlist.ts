// The consumer audience of the forwarder (SEC-WEB-5, GD-08 amendment), derived from the generated registry: a route
// is forwarded when it is on the api host and either (a) is outside the organization scope /v1/orgs/{org_id}/… and
// admits a USR, PUB or LNK principal — routes that only name an organization as their target (follows, favourites,
// /v1/public/orgs/{org_id}/… reads) are consumer routes (P5 fix) —, or (b) is a /v1/orgs/{org_id}/fleet/… route that
// admits DRV (fleet drivers use the PWA, P12). Everything else — {org} business routes, the admin plane, auth-host
// operations — answers 404 at the BFF.
import { OPERATIONS, type OperationId, type OperationRoute } from '@carpal/api-contracts';

export interface AllowedRoute {
  opId: OperationId;
  method: string;
  route: OperationRoute;
  pattern: RegExp;
}

export type RouteMatch =
  | { kind: 'ok'; route: AllowedRoute; params: Record<string, string> }
  | { kind: 'method_not_allowed'; allow: string[] }
  | { kind: 'not_found' };

const CONSUMER_PRINCIPALS = ['USR', 'PUB', 'LNK'];

export function isConsumerRoute(route: OperationRoute): boolean {
  if (route.host !== 'api') return false;
  const admits = (tags: string[]) => route.principals.some((alt) => alt.some((t) => tags.includes(t.tag)));
  if (!route.path.startsWith('/v1/orgs/{org_id}')) return admits(CONSUMER_PRINCIPALS);
  return route.path.startsWith('/v1/orgs/{org_id}/fleet/') && admits(['DRV']);
}

/** Path parameter values: one non-empty segment of unreserved or percent-encoded characters (ids, slugs, keys). */
const SEGMENT = '((?:[A-Za-z0-9._~-]|%[0-9A-Fa-f]{2})+)';

function compile(path: string): RegExp {
  const source = path
    .split('/')
    .map((part) => (/^\{[a-z_]+\}$/.test(part) ? SEGMENT : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('/');
  return new RegExp(`^${source}$`);
}

export class ConsumerAllowlist {
  readonly routes: readonly AllowedRoute[];

  constructor(operations: Readonly<Record<string, (typeof OPERATIONS)[OperationId]>> = OPERATIONS) {
    const routes: AllowedRoute[] = [];
    for (const [opId, op] of Object.entries(operations)) {
      for (const route of op.routes) {
        if (isConsumerRoute(route)) routes.push({ opId: opId as OperationId, method: op.method, route, pattern: compile(route.path) });
      }
    }
    // Literal segments win over parameters (e.g. /v1/me/vehicles/transfers before /v1/me/vehicles/{vehicle_id}).
    routes.sort((a, b) => literalWeight(b.route.path) - literalWeight(a.route.path));
    this.routes = routes;
  }

  match(method: string, path: string): RouteMatch {
    const allow = new Set<string>();
    for (const r of this.routes) {
      const m = r.pattern.exec(path);
      if (!m) continue;
      if (r.method !== method) {
        allow.add(r.method);
        continue;
      }
      const params: Record<string, string> = {};
      r.route.pathParams.forEach((name, i) => (params[name] = m[i + 1]!));
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
 * segments, empty segments, and anything outside printable ASCII.
 */
export function isCanonicalPath(path: string): boolean {
  if (!/^\/[\x21-\x7e]*$/.test(path)) return false;
  if (/%2f|%5c|\\/i.test(path)) return false;
  return path
    .split('/')
    .slice(1)
    .every((seg) => seg !== '' && seg !== '.' && seg !== '..' && !/^%2e/i.test(seg));
}
