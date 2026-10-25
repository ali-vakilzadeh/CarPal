// Server-side i18n (P3.T2, GD-10, Docs/02 §3.1): the bundled dictionary, refreshed from the CDN when config.client
// announces another dictionary version (<i18n.base_url>/<version>/<locale>.json). The newer file is laid over the
// bundled one (never removes keys), validated (nested strings only, size-capped) and cached per version; a failed
// fetch keeps the bundled text and is not retried for REMOTE_BACKOFF_MS. Client providers get the same text (by
// namespace), so server and browser always render identical strings.
import 'server-only';
import { connection } from 'next/server';
import { createI18n, translator } from '@/lib/i18n/core';
import {
  BUNDLED,
  mergeDictionary,
  pickNamespaces,
  type Dictionary,
  type Namespace,
  type Resources,
  type Translate,
} from '@/lib/i18n/dictionary';
import type { Locale } from '@/lib/i18n/locales';
import { loadClientConfig } from './config';

/** Versions that mean "use the bundled copy": the backend's dev default and the region-file fallback. */
const NO_REMOTE_VERSIONS = new Set(['', 'dev', 'bundled']);
export const REMOTE_TIMEOUT_MS = 3_000;
export const REMOTE_BACKOFF_MS = 5 * 60_000;
const MAX_REMOTE_BYTES = 512 * 1024;

export function remoteDictionaryUrl(baseUrl: string, version: string, locale: Locale): string | null {
  if (NO_REMOTE_VERSIONS.has(version) || !/^[A-Za-z0-9._-]{1,40}$/.test(version)) return null;
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return null;
  }
  if (base.protocol !== 'https:') return null;
  return `${base.toString().replace(/\/$/, '')}/${encodeURIComponent(version)}/${locale}.json`;
}

type Loaded = { dict: Dictionary; at: number } | { failedAt: number };

export class RemoteDictionaries {
  readonly #entries = new Map<string, Loaded>();
  readonly #pending = new Map<string, Promise<Dictionary | null>>();

  constructor(
    private readonly doFetch: typeof fetch = (i, init) => fetch(i, init),
    private readonly now: () => number = Date.now,
  ) {}

  /** The merged dictionary for a version, or null while it is unavailable (the caller uses the bundled copy). */
  async get(url: string, locale: Locale): Promise<Dictionary | null> {
    const hit = this.#entries.get(url);
    if (hit && 'dict' in hit) return hit.dict;
    if (hit && this.now() - hit.failedAt < REMOTE_BACKOFF_MS) return null;
    let pending = this.#pending.get(url);
    if (!pending) {
      pending = this.#load(url, locale).finally(() => this.#pending.delete(url));
      this.#pending.set(url, pending);
    }
    return pending;
  }

  async #load(url: string, locale: Locale): Promise<Dictionary | null> {
    try {
      const res = await this.doFetch(url, { signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS), headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (text.length > MAX_REMOTE_BYTES) throw new Error('too large');
      const dict = mergeDictionary(BUNDLED[locale], JSON.parse(text));
      this.#entries.set(url, { dict, at: this.now() });
      return dict;
    } catch (err) {
      console.warn(`i18n: ${url} unavailable (${err instanceof Error ? err.message : String(err)}); using the bundled dictionary`);
      this.#entries.set(url, { failedAt: this.now() });
      return null;
    }
  }
}

const holder = globalThis as typeof globalThis & { __carpalRemoteDict?: RemoteDictionaries };
const remote = () => (holder.__carpalRemoteDict ??= new RemoteDictionaries());
const translators = new WeakMap<Dictionary, Translate>();

export interface ServerI18n {
  locale: Locale;
  t: Translate;
  dict: Dictionary;
  /** The namespaces a client provider receives. */
  resources: (namespaces: readonly Namespace[]) => Resources;
}

/** Translations for a server component or metadata function. Never throws: any failure means the bundled copy. */
export async function serverI18n(locale: Locale): Promise<ServerI18n> {
  await connection(); // request-time only: never prerendered with build-time config
  const { config } = await loadClientConfig(locale);
  const url = remoteDictionaryUrl(config.i18n.base_url, config.i18n.version, locale);
  const dict = (url && (await remote().get(url, locale))) || BUNDLED[locale];
  let t = translators.get(dict);
  if (!t) {
    t = translator(createI18n(locale, dict));
    translators.set(dict, t);
  }
  return { locale, t, dict, resources: (namespaces) => pickNamespaces(dict, namespaces) };
}
