// Types of the shared UI dictionary (GD-10). The top-level keys of shared/i18n/locales/en.json are the namespaces
// (common, shell, states, system, consent, format, vehicle …); a message key is "<namespace>.<path>". Plural
// variants (_one, _other …) are addressed by their base key plus a `count` variable.
import type en from '@carpal/i18n/locales/en.json';

export type Dictionary = typeof en;
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
