// Contract router (41 §5 step 2; 40 SEC-AZ-1, SEC-IN-8, §0.3): only the routes
// of operations.json for this host exist. Unknown path → 404, known path with
// another method → 405 (HEAD and OPTIONS included: no CORS, TR-6). Path
// parameters are validated before routing (Id, Slug …): invalid → 404.
// Encoded slashes, dot segments, empty segments and backslashes never match.
import type { ValidateFunction } from 'ajv';
import {
  createContractAjv,
  loadRegistry,
  loadSchemas,
  type Host,
  type HttpMethod,
  type Operation,
  type Route,
} from '#libs/contract/index.js';

export interface RouteEntry {
  op: Operation;
  route: Route;
  paramValidators: Map<string, ValidateFunction>;
}

export type MatchResult =
  | { kind: 'match'; entry: RouteEntry; params: Record<string, string> }
  | { kind: 'not_found' }
  | { kind: 'method_not_allowed'; allow: HttpMethod[] };

interface Node {
  literal: Map<string, Node>;
  params: Map<string, Node>;
  methods: Map<HttpMethod, RouteEntry>;
}

const node = (): Node => ({ literal: new Map(), params: new Map(), methods: new Map() });

export class RouteTable {
  readonly #root = node();
  readonly entries: RouteEntry[] = [];

  constructor(readonly host: Host) {
    const ajv = createContractAjv();
    const schemas = loadSchemas().operations;
    for (const op of loadRegistry().operations) {
      for (const route of op.routes) {
        if (route.host !== host) continue;
        const paramValidators = new Map<string, ValidateFunction>();
        for (const p of route.pathParams) {
          const schema = schemas[op.opId]?.pathParams[p];
          if (!schema) throw new Error(`no schema for path parameter ${p} of ${op.opId}`);
          paramValidators.set(p, ajv.compile(schema));
        }
        const entry: RouteEntry = { op, route, paramValidators };
        this.#insert(route.path, entry);
        this.entries.push(entry);
      }
    }
  }

  #insert(path: string, entry: RouteEntry): void {
    let n = this.#root;
    for (const seg of path.split('/').slice(1)) {
      const param = /^\{([a-z_]+)\}$/.exec(seg);
      const map = param ? n.params : n.literal;
      const key = param ? param[1]! : seg;
      let next = map.get(key);
      if (!next) map.set(key, (next = node()));
      n = next;
    }
    if (n.methods.has(entry.route.method)) throw new Error(`route conflict: ${entry.route.method} ${entry.route.path}`);
    n.methods.set(entry.route.method, entry);
  }

  match(method: string, rawPath: string): MatchResult {
    // SEC-IN-8: no encoded slashes or backslashes, dot segments, empty segments or trailing slashes.
    if (!rawPath.startsWith('/') || rawPath.length > 2048 || /%2f|%5c|\\/i.test(rawPath)) return { kind: 'not_found' };
    const raw = rawPath.split('/').slice(1);
    const segments: string[] = [];
    for (const s of raw) {
      let d: string;
      try {
        d = decodeURIComponent(s);
      } catch {
        return { kind: 'not_found' };
      }
      if (d === '' || d === '.' || d === '..') return { kind: 'not_found' };
      segments.push(d);
    }
    const found: { n: Node; params: Record<string, string> }[] = [];
    this.#walk(this.#root, segments, 0, {}, found);
    if (found.length === 0) return { kind: 'not_found' };
    // Only routes whose path parameters are valid exist for this request (§0.3).
    const valid = found.filter(({ n, params }) =>
      [...n.methods.values()].some((e) => [...e.paramValidators.entries()].every(([k, v]) => v(params[k]))),
    );
    if (valid.length === 0) return { kind: 'not_found' };
    for (const { n, params } of valid) {
      const entry = n.methods.get(method as HttpMethod);
      if (entry && [...entry.paramValidators.entries()].every(([k, v]) => v(params[k]))) return { kind: 'match', entry, params };
    }
    const allow = [...new Set(valid.flatMap(({ n }) => [...n.methods.keys()]))].sort();
    return { kind: 'method_not_allowed', allow };
  }

  #walk(n: Node, segs: string[], i: number, params: Record<string, string>, out: { n: Node; params: Record<string, string> }[]): void {
    if (i === segs.length) {
      if (n.methods.size > 0) out.push({ n, params });
      return;
    }
    const seg = segs[i]!;
    const lit = n.literal.get(seg);
    if (lit) this.#walk(lit, segs, i + 1, params, out);
    for (const [name, child] of n.params) this.#walk(child, segs, i + 1, { ...params, [name]: seg }, out);
  }
}
