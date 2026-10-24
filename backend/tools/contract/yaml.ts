// Minimal deterministic YAML 1.2 emitter for JSON data (the OpenAPI file):
// block mappings and sequences, two-space indentation, keys in insertion
// order. A string is written plain only when it cannot be read as anything
// else; otherwise it is JSON-quoted, which is a valid YAML double-quoted
// scalar (same escapes). No anchors, tags or multi-line block scalars.

const PLAIN = /^[A-Za-z_$/][A-Za-z0-9_.$/-]*$/;
const RESERVED = /^(true|false|null|yes|no|on|off|y|n|~)$/i;

function scalar(v: unknown): string {
  if (v === null) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error(`YAML: non-finite number ${v}`);
    return String(v);
  }
  if (typeof v === 'string') return PLAIN.test(v) && !RESERVED.test(v) ? v : JSON.stringify(v);
  throw new Error(`YAML: unsupported value ${typeof v}`);
}

const isNode = (v: unknown): v is object => typeof v === 'object' && v !== null;
const isEmpty = (v: object): boolean => (Array.isArray(v) ? v.length === 0 : Object.keys(v).length === 0);
const inline = (v: unknown): string | null => (!isNode(v) ? scalar(v) : isEmpty(v) ? (Array.isArray(v) ? '[]' : '{}') : null);

function lines(v: object, indent: number): string[] {
  const pad = ' '.repeat(indent);
  const out: string[] = [];
  if (Array.isArray(v)) {
    for (const item of v) {
      const s = inline(item);
      if (s !== null) {
        out.push(`${pad}- ${s}`);
        continue;
      }
      const nested = lines(item as object, indent + 2);
      out.push(`${pad}- ${nested[0]!.slice(indent + 2)}`, ...nested.slice(1));
    }
    return out;
  }
  for (const [k, val] of Object.entries(v)) {
    if (val === undefined) continue;
    const key = scalar(k);
    const s = inline(val);
    if (s !== null) out.push(`${pad}${key}: ${s}`);
    else out.push(`${pad}${key}:`, ...lines(val as object, indent + 2));
  }
  return out;
}

export function toYaml(doc: object, header = ''): string {
  return header + lines(doc, 0).join('\n') + '\n';
}
