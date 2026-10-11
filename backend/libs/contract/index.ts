// L1 contract library (41 §2.2): the operation registry and JSON Schemas generated
// from Docs/40.API contract.md (pnpm contract:generate). The router registers only
// these operations (fail closed, 40 SEC-AZ-1); the HTTP pipeline validates bodies,
// queries and path parameters against these schemas.
import { readFileSync } from 'node:fs';
import { Ajv2020, type Options } from 'ajv/dist/2020.js';
import type { Operation, OperationRegistry } from './registry.types.js';

export type * from './registry.types.js';
export { OPERATION_IDS, type OperationId } from './generated/operation-ids.js';
export { ERROR_CODES, type ErrorCode, type ErrorCodeInfo } from './generated/errors.js';
export { ENUMS } from './generated/enums.js';
export { ROLE_GROUPS, type RoleGroup, type RoleGroupName } from './generated/role-groups.js';
export { ApiError, isApiError, type ApiErrorOptions, type FieldError, type FieldErrorCode } from './api-error.js';

type JsonSchema = Record<string, unknown>;

export interface OperationSchemas {
  input?: JsonSchema;
  response?: JsonSchema;
  alternateResponses?: Record<string, JsonSchema>;
  query: JsonSchema;
  pathParams: Record<string, JsonSchema>;
}

export interface ContractSchemas {
  /** Root schema with every named type in $defs; its $id is the base of all $ref. */
  root: JsonSchema & { $id: string; 'x-custom-keywords': string[] };
  operations: Record<string, OperationSchemas>;
}

const generated = (file: string): URL => new URL(`./generated/${file}`, import.meta.url);
const readJson = <T>(file: string): T => JSON.parse(readFileSync(generated(file), 'utf8')) as T;

let registryCache: OperationRegistry | undefined;
let schemasCache: ContractSchemas | undefined;

export function loadRegistry(): OperationRegistry {
  return (registryCache ??= readJson<OperationRegistry>('operations.json'));
}

export function loadSchemas(): ContractSchemas {
  if (!schemasCache) {
    const root = readJson<ContractSchemas['root']>('schemas.json');
    const ops = readJson<{ operations: Record<string, OperationSchemas> }>('operation-schemas.json');
    schemasCache = { root, operations: ops.operations };
  }
  return schemasCache;
}

export function operationById(opId: string): Operation {
  const op = loadRegistry().operations.find((o) => o.opId === opId);
  if (!op) throw new Error(`Unknown operation ${opId}`);
  return op;
}

/**
 * An ajv instance (JSON Schema 2020-12, strict) that knows the contract's named
 * types and custom x- keywords. Compile operation schemas with it.
 */
export function createContractAjv(options: Pick<Options, 'useDefaults' | 'allErrors' | 'verbose'> = {}): Ajv2020 {
  const { root } = loadSchemas();
  const ajv = new Ajv2020({ strict: true, allErrors: true, unicodeRegExp: true, ...options });
  ajv.addVocabulary(root['x-custom-keywords']);
  ajv.addKeyword('x-custom-keywords');
  ajv.addSchema(root);
  return ajv;
}
