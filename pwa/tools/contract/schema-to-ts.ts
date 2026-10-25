// JSON Schema 2020-12 → TypeScript type expressions, for the subset the backend generator emits
// (backend/tools/contract/types/json-schema.ts): $ref, const, enum, anyOf/oneOf, allOf, type (also as a list),
// objects with properties/required/additionalProperties/propertyNames, arrays, and the x- annotations
// (x-server-schema names a type taken from the OpenAPI components; x-external marks RFC-defined documents).

export type JsonSchema = boolean | { [keyword: string]: unknown };

export interface ConvertOptions {
  /** Maps a $ref (or an x-server-schema name) to the TypeScript name to emit. */
  refName(ref: string): string;
}

const IDENT = /^[A-Za-z_$][\w$]*$/;

export function propertyKey(name: string): string {
  return IDENT.test(name) ? name : JSON.stringify(name);
}

function literal(value: unknown): string {
  return JSON.stringify(value);
}

/** One-line JSDoc text; never closes the comment early. */
export function docComment(text: string, indent: string): string {
  const line = text.replace(/\s+/g, ' ').trim().replace(/\*\//g, '*\\/');
  return line ? `${indent}/** ${line} */\n` : '';
}

/** True when a type expression has a top-level `|` or `&` (outside braces, brackets, parentheses, generics and strings). */
export function hasTopLevelOperator(type: string): boolean {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < type.length; i++) {
    const c = type[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '{' || c === '[' || c === '(' || c === '<') depth++;
    else if (c === '}' || c === ']' || c === ')' || c === '>') depth--;
    else if (depth === 0 && (c === '|' || c === '&')) return true;
  }
  return false;
}

function wrap(type: string): string {
  return hasTopLevelOperator(type) ? `(${type})` : type;
}

function union(types: string[]): string {
  const unique = [...new Set(types)];
  if (unique.includes('unknown')) return 'unknown';
  return unique.length === 0 ? 'never' : unique.map(wrap).join(' | ');
}

export function schemaToTs(schema: JsonSchema | undefined, opts: ConvertOptions, indent = ''): string {
  if (schema === undefined || schema === true) return 'unknown';
  if (schema === false) return 'never';
  const s = schema;
  if (typeof s.$ref === 'string') return opts.refName(s.$ref);
  if (typeof s['x-server-schema'] === 'string') return opts.refName(s['x-server-schema']);
  if (s['x-external'] !== undefined) return 'Record<string, unknown>';
  if ('const' in s) return literal(s.const);
  if (Array.isArray(s.enum)) return union(s.enum.map(literal));
  const alternatives = (Array.isArray(s.anyOf) ? s.anyOf : Array.isArray(s.oneOf) ? s.oneOf : null) as JsonSchema[] | null;
  if (alternatives) return union(alternatives.map((a) => schemaToTs(a, opts, indent)));
  if (Array.isArray(s.allOf)) return (s.allOf as JsonSchema[]).map((a) => wrap(schemaToTs(a, opts, indent))).join(' & ');
  if (Array.isArray(s.type)) return union((s.type as string[]).map((t) => schemaToTs({ ...s, type: t }, opts, indent)));
  switch (s.type) {
    case 'string':
      return 'string';
    case 'integer':
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'null':
      return 'null';
    case 'array': {
      const item = schemaToTs(s.items as JsonSchema | undefined, opts, indent);
      return hasTopLevelOperator(item) ? `Array<${item}>` : `${item}[]`;
    }
    case 'object':
      return objectToTs(s, opts, indent);
    default:
      return s.properties ? objectToTs(s, opts, indent) : 'unknown';
  }
}

function objectToTs(s: { [keyword: string]: unknown }, opts: ConvertOptions, indent: string): string {
  const properties = (s.properties ?? {}) as Record<string, JsonSchema>;
  const required = new Set((s.required ?? []) as string[]);
  const names = Object.keys(properties);
  const additional = s.additionalProperties as JsonSchema | undefined;
  const valueType = typeof additional === 'object' ? schemaToTs(additional, opts, indent) : additional === false ? null : 'unknown';
  const keyNames = (s.propertyNames as { enum?: unknown[] } | undefined)?.enum;
  const keyType = keyNames ? union(keyNames.map(literal)) : 'string';

  if (names.length === 0) {
    if (valueType === null) return 'Record<string, never>';
    return keyNames ? `Partial<Record<${keyType}, ${valueType}>>` : `Record<string, ${valueType}>`;
  }
  const inner = `${indent}  `;
  const lines = names.map((name) => {
    const p = properties[name];
    const doc = typeof p === 'object' && typeof p.description === 'string' ? docComment(p.description, inner) : '';
    return `${doc}${inner}${propertyKey(name)}${required.has(name) ? '' : '?'}: ${schemaToTs(p, opts, inner)};`;
  });
  const object = `{\n${lines.join('\n')}\n${indent}}`;
  // Closed objects (additionalProperties false) and the TypeScript default are the same shape here.
  return valueType === null || valueType === 'unknown' ? object : `${object} & Record<string, ${valueType}>`;
}
