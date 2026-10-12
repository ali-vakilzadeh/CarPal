// Converts the parsed contract types (parser.ts) into JSON Schema 2020-12.
//
// Every object is closed (additionalProperties: false, 40 §0.1). Because closed
// objects cannot be combined with allOf, intersections, Omit<>, Partial<> and
// references inside them are flattened into one object at generation time.
// The §3.1 primitives are built in. Field comments become "description";
// "// C: rule" becomes "x-conditional" (enforced by the owning module).
import type { Field, TypeDef, TypeNode } from './parser.js';

export type JsonSchema = Record<string, unknown>;

/** Non-standard keywords emitted here; validators must register them (ajv.addVocabulary). */
export const CUSTOM_KEYWORDS = ['x-node-type', 'x-conditional', 'x-server-schema', 'x-locale-config', 'x-external', 'x-vin'] as const;

/** Enabled locales (40 §3.1 Locale: "en | fa (config)"). */
export const LOCALES = ['en', 'fa'] as const;

interface FlatField {
  schema: JsonSchema;
  optional: boolean;
  comment?: string;
}
type FlatObject = Map<string, FlatField>;

export class ConversionError extends Error {}

export class SchemaBuilder {
  /** Type names referenced but neither defined nor built in. */
  readonly unresolved = new Set<string>();
  private readonly defs: Map<string, TypeDef>;

  constructor(
    defs: TypeDef[],
    /** Prefix for $ref to named definitions, e.g. "#/$defs/" or "<$id>#/$defs/". */
    private readonly refPrefix: string,
  ) {
    this.defs = new Map(defs.map((d) => [d.name, d]));
  }

  /** Schema for a named definition (the value placed in $defs). */
  definition(name: string): JsonSchema {
    const def = this.defs.get(name);
    if (!def) throw new ConversionError(`unknown type ${name}`);
    if (def.params.length > 0) throw new ConversionError(`${name} is generic; it is instantiated where used`);
    const schema = this.schema(def.type, new Map(), [name]);
    if (def.comment) schema.description = def.comment;
    return schema;
  }

  /** Schema for a type expression (operation in:/response types). */
  expression(node: TypeNode): JsonSchema {
    return this.schema(node, new Map(), []);
  }

  isGeneric(name: string): boolean {
    return (this.defs.get(name)?.params.length ?? 0) > 0;
  }

  // ------------------------------------------------------------------ core
  private schema(node: TypeNode, env: Map<string, TypeNode>, stack: string[]): JsonSchema {
    switch (node.k) {
      case 'lit':
        return node.value === null ? { type: 'null' } : { const: node.value };
      case 'array':
        return { type: 'array', items: this.schema(node.of, env, stack) };
      case 'union':
        return this.union(node.members, env, stack);
      case 'inter':
        return this.objectSchema(this.flatten(node, env, stack));
      case 'obj':
        return this.objectSchema(this.flatten(node, env, stack));
      case 'index': {
        const obj = this.flatten(node.of, env, stack);
        const f = obj.get(node.key);
        if (!f) throw new ConversionError(`no field "${node.key}" for indexed access`);
        return f.schema;
      }
      case 'ref':
        return this.ref(node, env, stack);
    }
  }

  private union(members: TypeNode[], env: Map<string, TypeNode>, stack: string[]): JsonSchema {
    const resolved = members.map((m) => (m.k === 'ref' && env.has(m.name) ? env.get(m.name)! : m));
    const lits = resolved.filter((m): m is Extract<TypeNode, { k: 'lit' }> => m.k === 'lit');
    const others = resolved.filter((m) => m.k !== 'lit');
    if (others.length === 0) {
      const values = lits.map((l) => l.value);
      const types = [
        ...new Set(
          values.map((v) => (v === null ? 'null' : typeof v === 'number' ? (Number.isInteger(v) ? 'integer' : 'number') : typeof v)),
        ),
      ];
      return { type: types.length === 1 ? types[0] : types, enum: values };
    }
    const anyOf: JsonSchema[] = others.map((m) => this.schema(m, env, stack));
    const nonNull = lits.filter((l) => l.value !== null);
    if (nonNull.length > 0) anyOf.push(this.union(nonNull, env, stack));
    if (lits.some((l) => l.value === null)) anyOf.push({ type: 'null' });
    return anyOf.length === 1 ? anyOf[0]! : { anyOf };
  }

  private objectSchema(obj: FlatObject): JsonSchema {
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];
    for (const [name, f] of obj) {
      const s = { ...f.schema };
      if (f.comment) {
        const conditional = /(?:^|\s)C:\s*(.*)$/.exec(f.comment);
        if (conditional) s['x-conditional'] = conditional[1]!.trim();
        s.description = f.comment;
      }
      properties[name] = s;
      if (!f.optional) required.push(name);
    }
    return { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false };
  }

  /** Resolves a node to one flat, closed object (fields in declaration order). */
  private flatten(node: TypeNode, env: Map<string, TypeNode>, stack: string[]): FlatObject {
    switch (node.k) {
      case 'obj': {
        const out: FlatObject = new Map();
        for (const f of node.fields) out.set(f.name, this.flatField(f, env, stack));
        return out;
      }
      case 'inter': {
        const out: FlatObject = new Map();
        for (const m of node.members) for (const [k, v] of this.flatten(m, env, stack)) out.set(k, v);
        return out;
      }
      case 'ref': {
        if (env.has(node.name)) return this.flatten(env.get(node.name)!, env, stack);
        if (node.name === 'Partial') {
          const base = this.flatten(arg(node, 0), env, stack);
          return new Map([...base].map(([k, v]) => [k, { ...v, optional: true }]));
        }
        if (node.name === 'Omit') {
          const base = this.flatten(arg(node, 0), env, stack);
          for (const key of literalKeys(arg(node, 1))) {
            if (!base.has(key)) throw new ConversionError(`Omit: no field "${key}"`);
            base.delete(key);
          }
          return base;
        }
        const builtin = BUILTIN_OBJECTS[node.name];
        if (builtin) return builtin(node.args, (n) => this.schema(n, env, stack));
        const def = this.defs.get(node.name);
        if (!def) throw new ConversionError(`cannot flatten unknown type ${node.name}`);
        if (stack.includes(node.name)) throw new ConversionError(`recursive object type ${node.name}`);
        return this.flatten(def.type, bind(def, node.args, env), [...stack, node.name]);
      }
      default:
        throw new ConversionError(`a ${node.k} type cannot be merged into an object`);
    }
  }

  private flatField(f: Field, env: Map<string, TypeNode>, stack: string[]): FlatField {
    return { schema: this.schema(f.type, env, stack), optional: f.optional, ...(f.comment ? { comment: f.comment } : {}) };
  }

  private ref(node: Extract<TypeNode, { k: 'ref' }>, env: Map<string, TypeNode>, stack: string[]): JsonSchema {
    if (env.has(node.name)) return this.schema(env.get(node.name)!, env, stack);
    const builtin = BUILTINS[node.name];
    if (builtin) return builtin(node.args, (n) => this.schema(n, env, stack));
    if (node.name === 'Partial' || node.name === 'Omit') return this.objectSchema(this.flatten(node, env, stack));
    const def = this.defs.get(node.name);
    if (!def) {
      this.unresolved.add(node.name);
      throw new ConversionError(`unknown type ${node.name}`);
    }
    if (def.params.length > 0) {
      if (stack.includes(node.name)) throw new ConversionError(`recursive generic ${node.name}`);
      return this.schema(def.type, bind(def, node.args, env), [...stack, node.name]);
    }
    return { $ref: this.refPrefix + node.name };
  }
}

function arg(node: Extract<TypeNode, { k: 'ref' }>, i: number): TypeNode {
  const a = node.args[i];
  if (!a) throw new ConversionError(`${node.name} needs argument ${i + 1}`);
  return a;
}

function literalKeys(node: TypeNode): string[] {
  const members = node.k === 'union' ? node.members : [node];
  return members.map((m) => {
    if (m.k !== 'lit' || typeof m.value !== 'string') throw new ConversionError('Omit keys must be string literals');
    return m.value;
  });
}

function bind(def: TypeDef, args: TypeNode[], outer: Map<string, TypeNode>): Map<string, TypeNode> {
  if (args.length !== def.params.length)
    throw new ConversionError(`${def.name} takes ${def.params.length} type arguments, got ${args.length}`);
  const env = new Map(outer);
  def.params.forEach((p, i) => env.set(p, args[i]!));
  return env;
}

// ------------------------------------------------------------ built-ins (§3.1)
const num = (n: TypeNode | undefined, what: string): number => {
  if (!n || n.k !== 'lit' || typeof n.value !== 'number') throw new ConversionError(`${what} needs a number argument`);
  return n.value;
};
/** Bare word argument such as NodeId<vehicle_brand> or Token<ri> (parsed as a ref). */
const word = (n: TypeNode | undefined, what: string): string => {
  if (n?.k === 'ref' && n.args.length === 0) return n.name;
  if (n?.k === 'lit' && typeof n.value === 'string') return n.value;
  throw new ConversionError(`${what} needs a name argument`);
};

const ID_PATTERN = '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
const str = (min: number, max: number): JsonSchema => ({ type: 'string', minLength: min, maxLength: max, pattern: '^[^\\r\\n]*$' });
const lat: JsonSchema = { type: 'number', minimum: -90, maximum: 90 };
const lng: JsonSchema = { type: 'number', minimum: -180, maximum: 180 };
const locale: JsonSchema = { type: 'string', enum: [...LOCALES], 'x-locale-config': true };
const closed = (properties: Record<string, JsonSchema>, required = Object.keys(properties)): JsonSchema => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

type Builtin = (args: TypeNode[], sub: (n: TypeNode) => JsonSchema) => JsonSchema;

const BUILTINS: Record<string, Builtin> = {
  string: () => ({ type: 'string' }),
  number: () => ({ type: 'number' }),
  boolean: () => ({ type: 'boolean' }),
  unknown: () => ({}),
  Id: () => ({ type: 'string', pattern: ID_PATTERN }),
  // A bare `Str` (auth.authorize client_id) has no bounds in 40: non-empty, single line (doc issue DI-06).
  Str: ([a, b]) => (a === undefined ? { type: 'string', minLength: 1, pattern: '^[^\\r\\n]*$' } : str(num(a, 'Str'), num(b, 'Str'))),
  Text: ([b]) => ({ type: 'string', minLength: 1, maxLength: num(b, 'Text') }),
  Int: ([a, b]) => ({ type: 'integer', minimum: num(a, 'Int'), maximum: num(b, 'Int') }),
  Dec: ([i, f]) => ({ type: 'string', pattern: `^\\d{1,${num(i, 'Dec')}}(\\.\\d{1,${num(f, 'Dec')}})?$` }),
  Money: () =>
    closed({ amount: { type: 'string', pattern: '^\\d{1,10}(\\.\\d{1,2})?$' }, currency: { type: 'string', pattern: '^[A-Z]{3}$' } }),
  Currency: () => ({ type: 'string', pattern: '^[A-Z]{3}$' }),
  Country: () => ({ type: 'string', pattern: '^[A-Z]{2}$' }),
  Locale: () => ({ ...locale }),
  Lang: () => ({ type: 'string', pattern: '^[a-z]{2}$' }),
  Tz: () => ({ type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z][A-Za-z0-9_+\\-]*(/[A-Za-z0-9_+\\-]+)*$' }),
  Date: () => ({ type: 'string', pattern: '^\\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\\d|3[01])$' }),
  DateTime: () => ({ type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,3})?Z$' }),
  Time: () => ({ type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' }),
  Lat: () => ({ ...lat }),
  Lng: () => ({ ...lng }),
  GeoPoint: () => closed({ lat, lng }),
  BBox: () => closed({ south: lat, west: lng, north: lat, east: lng }),
  Email: () => ({ type: 'string', maxLength: 254, pattern: '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$' }),
  Phone: () => ({ type: 'string', pattern: '^\\+[1-9]\\d{6,14}$' }),
  Url: () => ({ type: 'string', maxLength: 2048, pattern: '^https://[^\\s@#/?]+([/?][^\\s#]*)?$' }),
  Slug: () => ({ type: 'string', pattern: '^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$' }),
  // x-vin: the validator upper-cases the value and converts Persian/Arabic digits before the pattern check (40 §3.1, 52 §8).
  Vin: () => ({ type: 'string', pattern: '^[A-HJ-NPR-Z0-9]{17}$', 'x-vin': true }),
  // NodeId<service_system|service_task>: any of the listed node types.
  NodeId: ([t]) => {
    const types = t?.k === 'union' ? t.members.map((m) => word(m, 'NodeId')) : [word(t, 'NodeId')];
    return { type: 'string', pattern: ID_PATTERN, 'x-node-type': types.length === 1 ? types[0] : types };
  },
  Translations: ([b]) => ({
    type: 'object',
    propertyNames: { enum: [...LOCALES] },
    additionalProperties: { type: 'string', minLength: 1, maxLength: num(b, 'Translations') },
    minProperties: 1,
  }),
  L10n: () => closed({ text: { type: 'string' }, locale }),
  Ref: ([t], sub) => closed({ type: sub(t ?? { k: 'ref', name: 'string', args: [] }), id: { type: 'string', pattern: ID_PATTERN } }),
  Cursor: () => ({ type: 'string', minLength: 1, maxLength: 512, pattern: '^[A-Za-z0-9_-]+$' }),
  Token: ([t]) => ({ type: 'string', pattern: `^cp_${word(t, 'Token')}_[A-Za-z0-9_-]{43}$` }),
  Code6: () => ({ type: 'string', pattern: '^[0-9]{6}$' }),
  Reason: () => str(3, 500),
  Json: ([n]) => ({ type: 'object', 'x-server-schema': word(n, 'Json') }),
  // Protocol documents defined by their standards, not by 40 (§6.2 authorization server).
  OidcDiscovery: () => ({ type: 'object', 'x-external': 'OpenID Connect Discovery 1.0 §3' }),
  Jwks: () => ({ type: 'object', 'x-external': 'RFC 7517 §5 (JWK Set)' }),
  TokenRequest: () => ({ type: 'object', 'x-external': 'RFC 6749 §4.1.3/§6, RFC 9449; grant types listed on auth.token' }),
  WebAuthnOptions: () => ({ type: 'object', 'x-external': 'WebAuthn Level 3 PublicKeyCredential*OptionsJSON' }),
  /** 40 §4.4: any catalog code, or an OAuth error code on /oauth/*. */
  ErrorCode: () => ({ type: 'string', pattern: '^[A-Za-z_]{2,64}$' }),
  List: ([t, n], sub) => ({ type: 'array', items: sub(t!), maxItems: num(n, 'List') }),
  Set: ([t, n], sub) => ({ type: 'array', items: sub(t!), maxItems: num(n, 'Set'), uniqueItems: true }),
};

/** Built-ins that are objects, so they can take part in intersections. */
const BUILTIN_OBJECTS: Record<string, (args: TypeNode[], sub: (n: TypeNode) => JsonSchema) => FlatObject> = {
  GeoPoint: () =>
    new Map([
      ['lat', { schema: lat, optional: false }],
      ['lng', { schema: lng, optional: false }],
    ]),
  // Ref<T> = { type: T; id: Id } (allows CommentTarget['type']).
  Ref: ([t], sub) =>
    new Map([
      ['type', { schema: sub(t ?? { k: 'ref', name: 'string', args: [] }), optional: false }],
      ['id', { schema: { type: 'string', pattern: ID_PATTERN }, optional: false }],
    ]),
};

export const BUILTIN_NAMES: ReadonlySet<string> = new Set(Object.keys(BUILTINS));
