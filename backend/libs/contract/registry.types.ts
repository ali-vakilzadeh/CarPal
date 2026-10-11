// Shape of the operation registry generated from Docs/40.API contract.md
// (tools/contract/generate.ts → libs/contract/generated/operations.json).
// The router (S2) registers exactly these routes; anything else is 404 (40 SEC-AZ-1).

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** Deployable that serves a route (40 §1.1, 41 §1). `storage` = signed direct upload, not a NestJS route. */
export type Host = 'api' | 'admin-api' | 'auth' | 'storage';

/** Security tag names of 40 §0.4. */
export type SecTagName =
  | 'PUB'
  | 'USR'
  | 'ORG'
  | 'DRV'
  | 'STF'
  | 'LNK'
  | 'AAL2'
  | 'AAL3'
  | 'ATT'
  | 'IDEM'
  | 'ETAG'
  | 'RL'
  | 'ENT'
  | 'CNS'
  | 'FLAG'
  | 'ASYNC'
  | 'AUD'
  | 'RSN'
  | '4EYES'
  | 'PURP'
  | 'PII';

export interface SecTag {
  tag: SecTagName;
  /** Comma-separated arguments before an optional ':' (role groups, bucket, entitlement key, flag key, consent type, link type). */
  args: string[];
  /** Text after ':' or a whole-argument qualifier such as "if exists", "by target", "own reports", "no token". */
  qualifier?: string;
}

/**
 * Security for one route. The caller must satisfy ONE of `principals` (each an
 * AND-list of principal tags: PUB, USR, ORG, DRV, STF, LNK) and ALL of `tags`.
 * `A | B` in the contract yields two alternatives (or two routes for {V}/{A}/{RQ}).
 */
export interface RouteSecurity {
  principals: SecTag[][];
  tags: SecTag[];
}

/** Which path prefix of a dual-scope operation this route is (40 §0.3). */
export type RouteScope = 'me' | 'org' | 'fleet' | 'single';

export interface Route {
  scope: RouteScope;
  host: Host;
  method: HttpMethod;
  /** Expanded path with {param} placeholders, e.g. /v1/orgs/{org_id}/fleet/vehicles/{vehicle_id}. */
  path: string;
  pathParams: string[];
  security: RouteSecurity;
}

export interface QueryParam {
  name: string;
  optional: boolean;
  /** Contract type expression; null for the cursor?/limit? shorthand (40 §3.3). */
  type: string | null;
  default?: string;
}

export interface OperationError {
  status: number;
  code: string;
  detail?: string;
}

export interface EmittedEvent {
  event: string;
  note?: string;
}

export interface Operation {
  opId: string;
  /** "12.2" */
  section: string;
  sectionTitle: string;
  /** Owning backend module (41 §2.1), or "platform" for backend/libs operations. */
  module: string;
  summary: string;
  method: HttpMethod;
  /** Path exactly as written in 40, aliases unexpanded. */
  pathTemplate: string;
  routes: Route[];
  successStatus: number;
  /** Response type expression as written (e.g. "Page<Vehicle>", "{ redirect_url: Url }"), or null. */
  responseType: string | null;
  /** Other success responses ("-> 200 FeatureFlag | 202 PendingChange": 4EYES changes). */
  alternateResponses?: { status: number; type: string }[];
  /** Types of path parameters that are not Ids (indented line under the request line). */
  pathParamTypes?: Record<string, string>;
  /** Free text after the status when it is not a type, e.g. "hosted sign-in", "empty", "storage". */
  responseNote?: string;
  /** Request body type expression, or null when "in: -" or absent. */
  inputType: string | null;
  /** Body encoding: JSON except the OAuth form posts (TR-5) and the raw storage upload. */
  inputEncoding: 'json' | 'form' | 'raw' | 'none';
  /** Trailing // note of the in: line (e.g. "C: exactly one"). */
  inputNote?: string;
  query: QueryParam[];
  /** Trailing // note of the q: line (e.g. "≤ 366 days"). */
  queryNote?: string;
  /** The raw sec: line. */
  sec: string;
  errors: OperationError[];
  emits: EmittedEvent[];
  /** 1-based line of the "#### op.id" heading in 40. */
  line: number;
}

export interface OperationRegistry {
  source: string;
  sourceSha256: string;
  contractVersion: string;
  operationCount: number;
  routeCount: number;
  /** Operations staff may run through an assist session (40 admin.assist_session_start). */
  assistAllowlist: string[];
  operations: Operation[];
}
