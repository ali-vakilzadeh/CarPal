// Text normalization of request input (40 SEC-IN-4, 52 §2.5): every string is
// checked for rejected characters (C0/C1 controls except \n and \t, unpaired
// surrogates, noncharacters, bidi embedding/override/isolate controls), then
// trimmed and NFC-normalized; Persian and Arabic-Indic digits become Latin in
// numeric and code-like values. ZWNJ, ZWJ, LRM and RLM are allowed.
import type { FieldError } from '#libs/contract/index.js';
import { latinDigits } from '#libs/i18n/index.js';

// Built from strings with escaped code points (SWC rewrites some escapes inside regex literals).
const FORBIDDEN = new RegExp(
  '[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f\\u202a-\\u202e\\u2066-\\u2069\\ufdd0-\\ufdef\\ufffe\\uffff' +
    Array.from({ length: 16 }, (_, p) => `\\u{${(p + 1).toString(16)}fffe}\\u{${(p + 1).toString(16)}ffff}`).join('') +
    ']',
  'u',
);
const NUMERIC_LIKE = new RegExp('^[\\s+\\-.:/0-9\\u06f0-\\u06f9\\u0660-\\u0669]+$');
const NON_LATIN_DIGIT = new RegExp('[\\u06f0-\\u06f9\\u0660-\\u0669]');

/** Values that are never trimmed or rewritten (secrets compare byte for byte after NFC). */
const VERBATIM_KEYS = new Set(['password', 'new_password', 'current_password', 'client_secret', 'code_verifier']);

const escapePointer = (k: string): string => k.replace(/~/g, '~0').replace(/\//g, '~1');

export function normalizeString(value: string, verbatim = false): { value: string; ok: boolean } {
  if (!value.isWellFormed() || FORBIDDEN.test(value)) return { value, ok: false };
  let v = value.normalize('NFC');
  if (!verbatim) {
    v = v.trim();
    if (NUMERIC_LIKE.test(v) && NON_LATIN_DIGIT.test(v)) v = latinDigits(v);
  }
  return { value: v, ok: true };
}

/**
 * Returns a normalized copy of a parsed JSON value and the pointers of strings
 * with rejected characters (422 VALIDATION_FAILED, code forbidden_character).
 */
export function normalizeInput(input: unknown): { value: unknown; errors: FieldError[] } {
  const errors: FieldError[] = [];
  const walk = (v: unknown, pointer: string, verbatim: boolean): unknown => {
    if (typeof v === 'string') {
      const r = normalizeString(v, verbatim);
      if (!r.ok) errors.push({ pointer: pointer || '/', code: 'forbidden_character' });
      return r.value;
    }
    if (Array.isArray(v)) return v.map((x, i) => walk(x, `${pointer}/${i}`, verbatim));
    if (v !== null && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) {
        if (!k.isWellFormed() || FORBIDDEN.test(k)) errors.push({ pointer: `${pointer}/${escapePointer(k)}`, code: 'forbidden_character' });
        out[k] = walk(x, `${pointer}/${escapePointer(k)}`, VERBATIM_KEYS.has(k));
      }
      return out;
    }
    return v;
  };
  const value = walk(input, '', false);
  return { value, errors: errors.slice(0, 50) };
}
