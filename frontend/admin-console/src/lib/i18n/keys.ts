// Types of the console dictionary (GD-05). Namespaces: the shared ones the console uses (common, format) from
// shared/i18n/locales, plus the console's own 'admin' namespace in src/lib/i18n/locales/<lang>.json (kept out of the
// shared package so admin strings never ship in the public PWA bundle). A message key is "<namespace>.<path>";
// plural variants (_one, _other …) are addressed by their base key plus a `count` variable.
import type sharedEn from '@carpal/i18n/locales/en.json';
import type adminEn from './locales/en.json';

/** Shared namespaces the console loads (the rest of shared/i18n belongs to the consumer apps). */
export const SHARED_NAMESPACES = ['common', 'format'] as const;
export type SharedNamespace = (typeof SHARED_NAMESPACES)[number];

export type Dictionary = Pick<typeof sharedEn, SharedNamespace> & typeof adminEn;
export type Namespace = keyof Dictionary;
/** A loaded slice of the dictionary: some namespaces of one language. */
export type Resources = { [N in Namespace]?: Dictionary[N] };

type PluralSuffix = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other';
type StripPlural<K extends string> = K extends `${infer Base}_${PluralSuffix}` ? Base : K;
type Leaves<T, P extends string = ''> = {
  [K in keyof T & string]: T[K] extends string ? StripPlural<`${P}${K}`> : Leaves<T[K], `${P}${K}.`>;
}[keyof T & string];

/** Dotted keys of the English dictionary (the reference language). */
export type MessageKey = Leaves<Dictionary>;

export type MessageVars = Record<string, string | number>;

/** Translates a key in the bound language; falls back to the key itself when it is unknown. */
export type Translate = (key: MessageKey, vars?: MessageVars) => string;
