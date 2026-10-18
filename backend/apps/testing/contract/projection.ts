// Projection rules of the contract sweep (40 Appendix C.4, SEC-OUT-1/2):
// fields that no response may carry, the full VIN outside vehicles.vin_reveal
// and trade prices outside the vendor's own members or an approved trade
// account. Used twice: statically over every response schema of the registry
// (a closed response schema cannot carry a field it does not declare) and
// dynamically over every response of the sweep (server-defined Json values,
// free text and VIN values).

/** SEC-OUT-1 field names: credentials, hashes, storage and KMS references, internal scoring and AI flags, vectors. */
export const FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  'password',
  'password_hash',
  'credential_reference',
  'token_hash',
  'link_token',
  'link_token_hash',
  'refresh_token_hash',
  'code_hash',
  'recovery_code_hash',
  'secret',
  'totp_secret',
  'storage_key',
  'storage_reference',
  'kms_key',
  'kms_key_id',
  'kms_reference',
  'trust_weight',
  'ai_sentiment',
  'ai_complaint_flags',
  'embedding',
  'embedding_vector',
]);

/** Operations whose response may carry a full VIN (SEC-OUT-2). */
export const VIN_OPERATIONS: ReadonlySet<string> = new Set(['vehicles.vin_reveal']);

const ARGON2 = /^\$argon2(id|i|d)\$/;

export interface ProjectionContext {
  opId: string;
  /** Full VINs the sweep registered: none may appear in any other response (SEC-OUT-2). */
  vins: ReadonlySet<string>;
  /** price_trade may carry a value (vendor's own member, or an approved trade account). */
  tradeAllowed: boolean;
}

/** Violations of the projection rules in one response body (JSON pointers). */
export function projectionViolations(body: unknown, o: ProjectionContext): string[] {
  const out: string[] = [];
  const vinAllowed = VIN_OPERATIONS.has(o.opId);
  const walk = (v: unknown, pointer: string): void => {
    if (typeof v === 'string') {
      if (ARGON2.test(v)) out.push(`${pointer}: password hash`);
      if (!vinAllowed) for (const vin of o.vins) if (v.includes(vin)) out.push(`${pointer}: full VIN`);
      return;
    }
    if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${pointer}/${i}`));
      return;
    }
    if (v === null || typeof v !== 'object') return;
    for (const [k, x] of Object.entries(v)) {
      const p = `${pointer}/${k}`;
      if (FORBIDDEN_KEYS.has(k)) out.push(`${p}: SEC-OUT-1 field`);
      if (k === 'vin' && x !== null && x !== undefined && !vinAllowed) out.push(`${p}: full VIN outside vehicles.vin_reveal`);
      if (k === 'price_trade' && x !== null && x !== undefined && !o.tradeAllowed) out.push(`${p}: trade price without trade access`);
      walk(x, p);
    }
  };
  walk(body, '');
  return out;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON Schema documents
type Schema = Record<string, any>;

/**
 * Property names reachable from a response schema, with their paths
 * ($refs into the shared $defs followed once per walk).
 */
export function schemaProperties(root: unknown, defs: Record<string, Schema>): { name: string; path: string }[] {
  const out: { name: string; path: string }[] = [];
  const seen = new Set<string>();
  const walk = (x: unknown, path: string): void => {
    if (Array.isArray(x)) {
      x.forEach((v, i) => walk(v, `${path}[${i}]`));
      return;
    }
    if (x === null || typeof x !== 'object') return;
    const s = x as Schema;
    if (typeof s.$ref === 'string') {
      const name = s.$ref.split('/').at(-1)!;
      if (!seen.has(name)) {
        seen.add(name);
        walk(defs[name], name);
      }
    }
    for (const [k, v] of Object.entries((s.properties ?? {}) as Record<string, unknown>)) {
      out.push({ name: k, path: `${path}.${k}` });
      walk(v, `${path}.${k}`);
    }
    for (const [k, v] of Object.entries(s)) if (k !== 'properties' && k !== '$ref') walk(v, path);
  };
  walk(root, '');
  return out;
}
