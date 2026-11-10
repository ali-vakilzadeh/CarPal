// Language and theme links (AC4, GD-05): ?lang= and ?theme= on the current page; the proxy stores the choice in a
// cookie and redirects to the same page without the parameter, so they work without JavaScript. On a sign-in page the
// authorize request's ui_locales follows the choice (it would win over the cookie there).
export function prefHref(path: string, key: 'lang' | 'theme', value: string): string {
  const u = new URL(path || '/', 'http://console.invalid');
  u.searchParams.set(key, value);
  if (key === 'lang' && u.searchParams.has('ui_locales')) u.searchParams.set('ui_locales', value);
  return `${u.pathname}${u.search}${u.hash}`;
}

// View settings of data tables (AC5.T1, GD-12): column choice, saved views and the Latin-digit choice for IDs. The
// only module that touches localStorage (lint-enforced elsewhere). Nothing from a response is ever stored: a saved
// view keeps filter values only when they look like enumerated values (letters, digits, '_', '-', '.', ':'), so an
// email, a name or free text can never land in browser storage.

export interface SavedView {
  name: string;
  filters: Record<string, string>;
  sort?: string;
}

export interface TablePrefs {
  /** Hidden column ids (the rest are shown). */
  hidden: string[];
  views: SavedView[];
}

const TABLE_KEY = (id: string) => `cpa.table.${id}`;
const LATIN_IDS_KEY = 'cpa.latin-ids';
const ENUM_VALUE = /^[A-Za-z0-9_.:-]{1,60}$/;
const VIEW_NAME_MAX = 40;
const MAX_VIEWS = 20;

function storage(): Storage | null {
  try {
    // GD-12: view settings without data, the one allowed use of browser storage.
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Only enumerated-looking values survive (GD-12); anything else is dropped. */
export function cleanFilters(filters: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(filters)) {
    if (/^[a-z_]{1,40}$/.test(k) && typeof v === 'string' && ENUM_VALUE.test(v)) out[k] = v;
  }
  return out;
}

function cleanView(v: unknown): SavedView | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const name = typeof o.name === 'string' ? o.name.trim().slice(0, VIEW_NAME_MAX) : '';
  if (!name) return null;
  const view: SavedView = { name, filters: cleanFilters((o.filters as Record<string, unknown>) ?? {}) };
  if (typeof o.sort === 'string' && ENUM_VALUE.test(o.sort)) view.sort = o.sort;
  return view;
}

export function readTablePrefs(id: string): TablePrefs {
  const empty: TablePrefs = { hidden: [], views: [] };
  const raw = storage()?.getItem(TABLE_KEY(id));
  if (!raw) return empty;
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    const hidden = Array.isArray(o.hidden) ? o.hidden.filter((h): h is string => typeof h === 'string' && /^[a-z_]{1,40}$/.test(h)) : [];
    const views = Array.isArray(o.views) ? o.views.map(cleanView).filter((v): v is SavedView => v !== null) : [];
    return { hidden, views: views.slice(0, MAX_VIEWS) };
  } catch {
    return empty;
  }
}

export function writeTablePrefs(id: string, prefs: TablePrefs): void {
  const clean: TablePrefs = {
    hidden: prefs.hidden.filter((h) => /^[a-z_]{1,40}$/.test(h)),
    views: prefs.views
      .map(cleanView)
      .filter((v): v is SavedView => v !== null)
      .slice(0, MAX_VIEWS),
  };
  try {
    storage()?.setItem(TABLE_KEY(id), JSON.stringify(clean));
  } catch {
    // Storage full or blocked: the choice lasts for this page only.
  }
}

/** IDs, codes and timestamps in tables in Latin digits even in Persian (GD-05). */
export function readLatinIds(): boolean {
  return storage()?.getItem(LATIN_IDS_KEY) === '1';
}

export function writeLatinIds(on: boolean): void {
  try {
    storage()?.setItem(LATIN_IDS_KEY, on ? '1' : '0');
  } catch {
    // ignore
  }
}
