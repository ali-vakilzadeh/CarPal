// L2 http-pipeline (41 §2.2, §5): contract router (L1 routes), transport
// checks, strict JSON, SEC-IN-4 normalization, closed-schema validation,
// problem+json, security headers, Cache-Control, signed cursors, and the
// ordered pipeline that runs every operation.
export { HttpPipeline, NotImplemented, ProtocolError, MAX_BODY_BYTES, type PipelineDeps } from './pipeline.js';
export { RouteTable, type MatchResult, type RouteEntry } from './router.js';
export {
  Operation,
  operationIdsOf,
  markOverride,
  isOverride,
  ok,
  created,
  accepted,
  noContent,
  redirect,
  type CachePolicy,
  type OperationContext,
  type OperationHandler,
  type OperationResult,
} from './operation.js';
export { parseStrictJson, MAX_DEPTH, MAX_KEYS } from './strict-json.js';
export { normalizeInput, normalizeString } from './normalize.js';
export { ContractValidator, NodeTypeChecker, toFieldErrors, type NodeRef } from './validation.js';
export { toProblem, problemTitle, type Problem } from './problem.js';
export { CONTRACT_VERSION, SECURITY_HEADERS, parseClientHeader, parseTimezone, versionBelow, type ClientInfo } from './headers.js';
export { ACK, iso, isoOrNull, meta, type MetaRow } from './wire.js';
