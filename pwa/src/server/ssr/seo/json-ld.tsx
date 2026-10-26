// JSON-LD output (P5.T1, GD-15): the only place a page writes markup that is not React text. The serializer escapes
// '<', '>', '&' and the two JavaScript line separators, so API text can never close the <script> element or start
// markup; the result contains no '<' at all, which also keeps it inside the Trusted Types default policy on client
// renders (P3 boot script: markup-free HTML only). Next.js JSON-LD guide: a <script type="application/ld+json">.
import { headers } from 'next/headers';

export type JsonLdValue = string | number | boolean | null | undefined | JsonLdValue[] | { [key: string]: JsonLdValue };

const ESCAPES: Record<string, string> = {
  '<': '\\u003c',
  '>': '\\u003e',
  '&': '\\u0026',
  '\u2028': '\\u2028',
  '\u2029': '\\u2029',
};

/** Drops undefined/null members and empty arrays or objects, so builders can list optional fields freely. */
export function compact(value: JsonLdValue): JsonLdValue {
  if (Array.isArray(value)) {
    const items = value.map(compact).filter((v) => v !== undefined && v !== null);
    return items.length ? items : undefined;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value)
      .map(([k, v]) => [k, compact(v)] as const)
      .filter(([, v]) => v !== undefined && v !== null && v !== '');
    return entries.length ? Object.fromEntries(entries) : undefined;
  }
  return value;
}

export function serializeJsonLd(data: JsonLdValue): string {
  return JSON.stringify(compact(data) ?? {}).replace(/[<>&\u2028\u2029]/g, (c) => ESCAPES[c]!);
}

/**
 * One structured-data block; several entities go in as an array (a @graph would hide them from some validators). A data
 * block is never executed, so CSP does not govern it; it still carries the request nonce, so every script tag of the
 * page has one (P2 page-security rule). The browser hides the nonce after parsing, hence suppressHydrationWarning.
 */
export async function JsonLd({ data }: { data: JsonLdValue }) {
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  return (
    <script type="application/ld+json" nonce={nonce} suppressHydrationWarning dangerouslySetInnerHTML={{ __html: serializeJsonLd(data) }} />
  );
}
