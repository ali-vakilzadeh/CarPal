// Arrays of domain types (core.country[], core.role_key[] …) have no parser
// in pg, so they arrive as the text literal "{a,b}". Simple text arrays only:
// elements without commas, quotes or braces (codes, keys, slugs).
export function textArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== 'string' || value.length < 2 || value[0] !== '{' || value.at(-1) !== '}') return [];
  const inner = value.slice(1, -1);
  if (!inner) return [];
  return inner.split(',').map((v) => v.replace(/^"(.*)"$/, '$1'));
}
