// Closed-schema validation of request bodies, query strings and (in dev and
// test) responses against the schemas generated from 40 (GD-03, SEC-IN-3,
// SEC-AZ-5). Validators compile lazily per operation and are cached.
import type { ErrorObject, KeywordDefinition, ValidateFunction } from 'ajv';
import type { DataValidationCxt } from 'ajv/dist/types/index.js';
import { ApiError, createContractAjv, loadSchemas, type FieldError, type FieldErrorCode } from '#libs/contract/index.js';
import { ID_PATTERN } from '#libs/crypto/index.js';
import { normalizeString } from './normalize.js';

type Schema = Record<string, unknown>;

/** A `NodeId<type>` value found in a request body (40 §3.1): checked against the taxonomy after schema validation. */
export interface NodeRef {
  /** RFC 6901 pointer of the value. */
  pointer: string;
  id: string;
  /** Allowed node types (union branches at the same pointer are merged). */
  types: string[];
}

/**
 * Port for `NodeId<type>` checks (SEC-AZ-4), implemented by the taxonomy
 * module: unknown or inactive ids are 422 REFERENCE_NOT_FOUND, a node of
 * another type 422 TAXONOMY_MISMATCH. Parent chains are checked by use cases.
 */
export abstract class NodeTypeChecker {
  abstract check(refs: NodeRef[]): Promise<void>;
}

// Validation is synchronous, so one collector at a time is enough.
let nodeRefCollector: NodeRef[] | null = null;

const NODE_TYPE_KEYWORD: KeywordDefinition = {
  keyword: 'x-node-type',
  // NodeId<a> is a string, NodeId<a|b> an array of types.
  schemaType: ['string', 'array'],
  errors: false,
  validate: (schema: string | string[], data: unknown, _parent?: unknown, cxt?: DataValidationCxt) => {
    if (nodeRefCollector && typeof data === 'string' && ID_PATTERN.test(data)) {
      const pointer = cxt?.instancePath || '/';
      const types = typeof schema === 'string' ? [schema] : schema;
      const existing = nodeRefCollector.find((r) => r.pointer === pointer && r.id === data);
      if (existing) existing.types = [...new Set([...existing.types, ...types])];
      else nodeRefCollector.push({ pointer, id: data, types });
    }
    return true;
  },
};

const KEYWORD_CODES: Record<string, FieldErrorCode> = {
  required: 'required',
  additionalProperties: 'unknown_field',
  unevaluatedProperties: 'unknown_field',
  type: 'type',
  minLength: 'too_short',
  maxLength: 'too_long',
  minItems: 'too_short',
  maxItems: 'too_long',
  minProperties: 'too_short',
  maxProperties: 'too_long',
  minimum: 'out_of_range',
  maximum: 'out_of_range',
  exclusiveMinimum: 'out_of_range',
  exclusiveMaximum: 'out_of_range',
  multipleOf: 'out_of_range',
  pattern: 'pattern',
  format: 'pattern',
  enum: 'enum',
  const: 'enum',
  uniqueItems: 'not_unique',
};

const META_FIELDS = ['id', 'created_at', 'updated_at', 'version'];
const esc = (k: string): string => k.replace(/~/g, '~0').replace(/\//g, '~1');

/**
 * Errors of union branches (anyOf/oneOf) are reduced to the branch that came
 * closest (fewest errors), so a client sees the problems of the shape it
 * meant rather than every alternative. Needs ajv's verbose errors (the union
 * error carries its branch schemas, to map $ref branches).
 */
function pruneUnionBranches(errors: ErrorObject[]): ErrorObject[] {
  const keep = new Set(errors);
  for (const u of errors) {
    if ((u.keyword !== 'anyOf' && u.keyword !== 'oneOf') || !Array.isArray(u.schema)) continue;
    // Compare schema locations by their fragment: refs may be absolute (https://…#/$defs/X) or relative (#/$defs/X).
    const frag = (path: string): string => path.slice(Math.max(0, path.indexOf('#')));
    const branches = (u.schema as Schema[]).map((b, i) =>
      typeof b.$ref === 'string' ? `${frag(b.$ref)}/` : `${frag(u.schemaPath)}/${i}/`,
    );
    const groups = new Map<number, ErrorObject[]>();
    for (const e of errors) {
      if (e === u || !keep.has(e)) continue;
      if (!(e.instancePath === u.instancePath || e.instancePath.startsWith(`${u.instancePath}/`))) continue;
      const i = branches.findIndex((prefix) => `${frag(e.schemaPath)}/`.startsWith(prefix));
      if (i < 0) continue;
      groups.set(i, [...(groups.get(i) ?? []), e]);
    }
    if (groups.size === 0) continue;
    const best = [...groups.entries()].sort((a, b) => a[1].length - b[1].length)[0]![0];
    for (const [i, list] of groups) if (i !== best) for (const e of list) keep.delete(e);
    keep.delete(u);
  }
  return errors.filter((e) => keep.has(e));
}

export function toFieldErrors(errors: ErrorObject[] | null | undefined, prefix = ''): FieldError[] {
  const out: FieldError[] = [];
  const seen = new Set<string>();
  for (const e of pruneUnionBranches(errors ?? [])) {
    if (e.keyword === 'if') continue; // its then/else errors carry the detail
    let pointer = prefix + e.instancePath;
    if (e.keyword === 'required') pointer += `/${esc(String((e.params as { missingProperty: string }).missingProperty))}`;
    if (e.keyword === 'additionalProperties') pointer += `/${esc(String((e.params as { additionalProperty: string }).additionalProperty))}`;
    if (e.keyword === 'unevaluatedProperties')
      pointer += `/${esc(String((e.params as { unevaluatedProperty: string }).unevaluatedProperty))}`;
    const code: FieldErrorCode = KEYWORD_CODES[e.keyword] ?? 'type';
    const p = e.params as { limit?: number; comparison?: string };
    const err: FieldError = { pointer: pointer || '/', code };
    if (typeof p.limit === 'number') err.limit = String(p.limit);
    const key = `${err.pointer}|${err.code}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(err);
    }
  }
  // A union value with a specific failure (pattern, range, ...) also fails the other branches' type checks: keep the specific one.
  const specific = new Set(out.filter((e) => e.code !== 'type').map((e) => e.pointer));
  return out.filter((e) => e.code !== 'type' || !specific.has(e.pointer)).slice(0, 50);
}

interface OpValidators {
  input?: ValidateFunction;
  query: ValidateFunction;
  queryTypes: Map<string, string>;
  responses: Map<number, ValidateFunction>;
  readOnly: Set<string>;
}

export class ContractValidator {
  readonly #bodyAjv = createContractAjv({ verbose: true }, [NODE_TYPE_KEYWORD]);
  readonly #queryAjv = createContractAjv({ useDefaults: true, verbose: true });
  readonly #cache = new Map<string, OpValidators>();
  readonly #defs: Record<string, Schema>;

  constructor() {
    this.#defs = (loadSchemas().root.$defs ?? {}) as Record<string, Schema>;
  }

  #resolve(s: Schema | undefined): Schema | undefined {
    let cur = s;
    for (let i = 0; i < 10 && cur && typeof cur.$ref === 'string'; i++) cur = this.#defs[(cur.$ref as string).split('/').pop()!];
    return cur;
  }

  #topLevelProperties(s: Schema | undefined): string[] {
    const r = this.#resolve(s);
    if (!r) return [];
    const props = Object.keys((r.properties as Schema | undefined) ?? {});
    for (const k of ['allOf', 'anyOf', 'oneOf'])
      for (const sub of (r[k] as Schema[] | undefined) ?? []) props.push(...this.#topLevelProperties(sub));
    return props;
  }

  #primitive(s: Schema | undefined): string {
    const r = this.#resolve(s);
    if (!r) return 'string';
    if (typeof r.type === 'string') return r.type;
    if ('const' in r) return typeof r.const;
    for (const k of ['anyOf', 'oneOf']) {
      const t = ((r[k] as Schema[] | undefined) ?? []).map((x) => this.#primitive(x)).find((x) => x !== 'null');
      if (t) return t;
    }
    return 'string';
  }

  for(opId: string, successStatus: number): OpValidators {
    let v = this.#cache.get(opId);
    if (v) return v;
    const schemas = loadSchemas().operations[opId];
    if (!schemas) throw new Error(`no schemas for ${opId}`);
    const responses = new Map<number, ValidateFunction>();
    if (schemas.response) responses.set(successStatus, this.#bodyAjv.compile(schemas.response));
    for (const [status, schema] of Object.entries(schemas.alternateResponses ?? {}))
      responses.set(Number(status), this.#bodyAjv.compile(schema));
    const queryProps = (schemas.query.properties ?? {}) as Record<string, Schema>;
    v = {
      // x-external inputs (OAuth form posts) are validated by the auth server itself.
      ...(schemas.input && !('x-external' in schemas.input) ? { input: this.#bodyAjv.compile(schemas.input) } : {}),
      query: this.#queryAjv.compile(schemas.query),
      queryTypes: new Map(Object.entries(queryProps).map(([k, s]) => [k, this.#primitive(s)])),
      responses,
      readOnly: new Set([...META_FIELDS, ...this.#topLevelProperties(schemas.response)]),
    };
    this.#cache.set(opId, v);
    return v;
  }

  /**
   * Validates a body; throws 422 UNKNOWN_FIELD / READ_ONLY_FIELD / VALIDATION_FAILED.
   * Returns the `NodeId<type>` references of a valid body for the taxonomy check.
   */
  validateBody(opId: string, successStatus: number, body: unknown): NodeRef[] {
    const v = this.for(opId, successStatus);
    if (!v.input) return [];
    const refs: NodeRef[] = [];
    nodeRefCollector = refs;
    let valid: boolean;
    try {
      valid = v.input(body) as boolean;
    } finally {
      nodeRefCollector = null;
    }
    if (valid) return refs;
    const errors = toFieldErrors(v.input.errors).map((e): FieldError => {
      // A response-only field at the top level is read-only rather than unknown (40 §0.1).
      const top = /^\/([^/]+)$/.exec(e.pointer);
      if (e.code === 'unknown_field' && top && v.readOnly.has(top[1]!.replace(/~1/g, '/').replace(/~0/g, '~')))
        return { ...e, code: 'read_only' };
      return e;
    });
    const code = errors.some((e) => e.code === 'unknown_field')
      ? 'UNKNOWN_FIELD'
      : errors.some((e) => e.code === 'read_only')
        ? 'READ_ONLY_FIELD'
        : 'VALIDATION_FAILED';
    throw ApiError.validation(errors, code);
  }

  /**
   * Parses and validates a query string (SEC-IN-3): unknown or repeated
   * parameters are 400 UNKNOWN_QUERY_PARAM; values are normalized, coerced to
   * their declared type and checked (422 with pointers /query/<name>).
   */
  parseQuery(opId: string, successStatus: number, rawQuery: string): Record<string, unknown> {
    const v = this.for(opId, successStatus);
    const out: Record<string, unknown> = {};
    if (rawQuery) {
      let params: URLSearchParams;
      try {
        params = new URLSearchParams(rawQuery);
      } catch {
        throw new ApiError('MALFORMED_REQUEST', { detail: 'bad query string' });
      }
      const errors: FieldError[] = [];
      for (const [name, raw] of params) {
        if (!v.queryTypes.has(name) || name in out)
          throw new ApiError('UNKNOWN_QUERY_PARAM', { detail: `query parameter ${name.slice(0, 40)}` });
        const n = normalizeString(raw);
        if (!n.ok) errors.push({ pointer: `/query/${esc(name)}`, code: 'forbidden_character' });
        out[name] = coerce(n.value, v.queryTypes.get(name)!);
      }
      if (errors.length) throw ApiError.validation(errors);
    }
    if (!v.query(out)) throw ApiError.validation(toFieldErrors(v.query.errors, '/query'));
    return out;
  }

  /** Response check (dev/test): returns field errors, empty when valid or not declared. */
  checkResponse(opId: string, successStatus: number, status: number, body: unknown): FieldError[] {
    const fn = this.for(opId, successStatus).responses.get(status);
    if (!fn || fn(body)) return [];
    return toFieldErrors(fn.errors);
  }
}

function coerce(value: string, type: string): unknown {
  if (type === 'integer' && /^-?\d{1,15}$/.test(value)) return Number(value);
  if (type === 'number' && /^-?\d{1,15}(\.\d{1,15})?$/.test(value)) return Number(value);
  if (type === 'boolean' && (value === 'true' || value === 'false')) return value === 'true';
  return value;
}
