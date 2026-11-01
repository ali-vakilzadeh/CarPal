// Enum values from newer servers (Docs/40 TR-3, Appendix C; P13.T5): within /v1 the server may add enum values, and
// clients map the ones they do not know to 'unknown'. Lookups keyed by a contract enum go through knownEnum (or a
// `?? fallback`), labels fall back to "Unknown" in the translator (lib/i18n/core.ts), and response fields this build
// does not know are ignored (the client never validates responses against closed schemas).
import { ENUMS } from '@carpal/api-contracts';

export type EnumName = keyof typeof ENUMS;
export type EnumValue<N extends EnumName> = (typeof ENUMS)[N][number];
export const UNKNOWN = 'unknown' as const;

export function isKnownEnum<N extends EnumName>(name: N, value: unknown): value is EnumValue<N> {
  return typeof value === 'string' && (ENUMS[name] as readonly string[]).includes(value);
}

/** The value when this build knows it, else 'unknown'. */
export function knownEnum<N extends EnumName>(name: N, value: unknown): EnumValue<N> | typeof UNKNOWN {
  return isKnownEnum(name, value) ? value : UNKNOWN;
}
