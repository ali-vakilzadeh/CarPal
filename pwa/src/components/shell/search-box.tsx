'use client';
// Global header search (Docs/22 §2.2, Docs/21 S-SHARED-01): a combobox (WAI-ARIA 1.2) with the '/' shortcut,
// typeahead suggestions from taxonomy.suggest (any supported language, Persian typed in Latin letters matches), a
// "Search for …" first option, a "Browse on map" link and — signed in — the vehicle context chip. Suggestions share
// the guest search rate limit (RL search, DI-28), so they are debounced, cached per text and paused after a 429
// until the server's delay passes. With an empty field the panel lists the recent searches of this device (P6.T1).
// The search itself starts through savePendingSearch() (free text never goes into the URL, GD-14): the search page
// (P6, src/features/search) runs search.run and moves to /<locale>/search/<session_id>.
import type { TaxonomySuggestion, TaxonomyType } from '@carpal/api-contracts';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { cx } from '@/components/ds/cx';
import { Icon, type IconName } from '@/components/ds/icon';
import { ApiProblem } from '@/lib/api/problem';
import { useApiClient } from '@/lib/api/query';
import { useLocale, useT } from '@/lib/i18n/client';
import { RecentSearches } from '@/features/search/recent';

/** At most 5 (taxonomy.suggest types: Set<TaxonomyType,5>): problems, jobs, parts and cars. */
export const SUGGEST_TYPES: TaxonomyType[] = ['symptom', 'service_task', 'part_category', 'vehicle_brand', 'vehicle_model'];
export const SUGGEST_MIN_CHARS = 2;
export const SUGGEST_DEBOUNCE_MS = 350;
export const SEARCH_INPUT_ID = 'site-search';
export const PENDING_SEARCH_KEY = 'cp:pending-search';
/** Dispatched on window when a new search was handed over (the search page may already be open). */
export const PENDING_SEARCH_EVENT = 'carpal:pending-search';

const TYPE_ICON: Partial<Record<TaxonomyType, IconName>> = {
  symptom: 'alert',
  service_task: 'wrench',
  service_system: 'wrench',
  part_category: 'part',
  vehicle_brand: 'car',
  vehicle_model: 'car',
};

export interface PendingSearch {
  text: string;
  node?: { id: string; type: TaxonomyType; name: string };
  /** A guest's "Your car" (landing hero): sent as brand/model/series filters, never as vehicle_id (BA-16). */
  vehicle?: { brand_node_id: string; model_node_id?: string; series_node_id?: string };
  /** A chosen pilot city (region city_key): the chosen_city location of the search (BA-16). */
  city?: string;
  /** Where it started, for the search.started analytics event (the landing hero = home). */
  entry?: 'home';
  at: number;
}

/** Hands the query to the search page in sessionStorage (never in the URL, GD-14). P6 reads and clears it. */
export function savePendingSearch(search: Omit<PendingSearch, 'at'>): void {
  try {
    sessionStorage.setItem(PENDING_SEARCH_KEY, JSON.stringify({ ...search, at: Date.now() }));
  } catch {
    /* storage blocked: the search page starts empty */
  }
  window.dispatchEvent(new Event(PENDING_SEARCH_EVENT));
}

/** True when focus is in a field, so the '/' shortcut must type a slash instead. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

type Option = { kind: 'text'; text: string } | { kind: 'node'; suggestion: TaxonomySuggestion };

export function SearchBox({ vehicleChip, className }: { vehicleChip?: React.ReactNode; className?: string }) {
  const t = useT();
  const locale = useLocale();
  const router = useRouter();
  const api = useApiClient();
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  // Results per normalised text: the cache and the source of the visible suggestions (derived, not copied).
  const [results, setResults] = useState<Record<string, TaxonomySuggestion[]>>({});
  const pausedUntil = useRef(0);

  // '/' focuses the search from anywhere (Docs/22 principle 6); #search links land here too.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) return;
      e.preventDefault();
      inputRef.current?.focus();
    };
    document.addEventListener('keydown', onKey);
    if (location.hash === '#search') inputRef.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const q = text.trim();
  const key = q.toLowerCase();
  const wanted = q.length >= SUGGEST_MIN_CHARS;
  const known = wanted && key in results;
  const suggestions = wanted ? (results[key] ?? []) : [];

  useEffect(() => {
    if (!wanted || known || Date.now() < pausedUntil.current) return;
    const ctrl = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const res = await api.api('taxonomy.suggest', { body: { text: q, types: SUGGEST_TYPES }, signal: ctrl.signal });
        setResults((r) => ({ ...r, [key]: res.items }));
      } catch (err) {
        if (ctrl.signal.aborted) return;
        if (err instanceof ApiProblem && (err.status === 429 || err.code === 'PAUSED'))
          pausedUntil.current = Date.now() + (err.retryAfterMs ?? 60_000);
      }
    }, SUGGEST_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      ctrl.abort();
    };
  }, [q, key, wanted, known, api]);

  const options: Option[] = q
    ? [{ kind: 'text', text: q }, ...suggestions.slice(0, 8).map((s) => ({ kind: 'node' as const, suggestion: s }))]
    : [];
  // The panel opens with focus (it always offers "Browse on map"); the listbox only when there are options.
  const expanded = open && options.length > 0;

  const choose = useCallback(
    (o: Option) => {
      if (o.kind === 'text') savePendingSearch({ text: o.text });
      else
        savePendingSearch({
          text: o.suggestion.node.name.text,
          node: { id: o.suggestion.node.id, type: o.suggestion.node.type, name: o.suggestion.node.name.text },
        });
      setOpen(false);
      setActive(-1);
      router.push(`/${locale}/search`);
    },
    [router, locale],
  );

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' && options.length) {
      e.preventDefault();
      setOpen(true);
      setActive((i) => (i + 1) % options.length);
    } else if (e.key === 'ArrowUp' && options.length) {
      e.preventDefault();
      setActive((i) => (i <= 0 ? options.length - 1 : i - 1));
    } else if (e.key === 'Escape') {
      if (expanded) {
        e.preventDefault();
        setOpen(false);
        setActive(-1);
      }
    }
  };

  const optionId = (i: number) => `${listId}-o${i}`;

  return (
    <div
      className={cx('pwa-search', className)}
      onFocus={() => setOpen(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setOpen(false);
          setActive(-1);
        }
      }}
    >
      <form
        role="search"
        className="pwa-search-form"
        onSubmit={(e) => {
          e.preventDefault();
          const picked = active >= 0 ? options[active] : undefined;
          if (picked) choose(picked);
          else if (q) choose({ kind: 'text', text: q });
        }}
      >
        <div className="cp-field-box pwa-search-box">
          <Icon name="search" size={20} />
          <label htmlFor={SEARCH_INPUT_ID} className="sr-only">
            {t('shell.header.searchLabel')}
          </label>
          <input
            ref={inputRef}
            id={SEARCH_INPUT_ID}
            className="cp-field-input"
            type="search"
            dir="auto"
            autoComplete="off"
            enterKeyHint="search"
            placeholder={t('shell.header.searchPlaceholder')}
            role="combobox"
            aria-expanded={expanded}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={expanded && active >= 0 ? optionId(active) : undefined}
            aria-keyshortcuts="/"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setOpen(true);
              setActive(-1);
            }}
            onKeyDown={onKeyDown}
          />
          {vehicleChip}
          <kbd className="pwa-kbd" aria-hidden="true">
            /
          </kbd>
        </div>
      </form>
      <div className={cx('pwa-search-panel', !open && 'is-hidden')}>
        <ul id={listId} role="listbox" aria-label={t('shell.header.suggestions')} className="pwa-search-list">
          {expanded
            ? options.map((o, i) => (
                <li
                  key={o.kind === 'text' ? 'text' : o.suggestion.node.id}
                  id={optionId(i)}
                  role="option"
                  aria-selected={i === active}
                  className={cx('pwa-search-option', i === active && 'is-active')}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => choose(o)}
                >
                  <Icon name={o.kind === 'text' ? 'search' : (TYPE_ICON[o.suggestion.node.type] ?? 'search')} size={20} />
                  <span dir="auto">{o.kind === 'text' ? t('shell.header.searchFor', { text: o.text }) : o.suggestion.node.name.text}</span>
                </li>
              ))
            : null}
        </ul>
        {open && !q ? (
          <RecentSearches
            compact
            onPick={(r) => {
              savePendingSearch({ text: r.text, ...(r.node ? { node: r.node } : {}) });
              setOpen(false);
              router.push(`/${locale}/search`);
            }}
          />
        ) : null}
        {open ? (
          <Link href={`/${locale}/map`} className="pwa-search-map">
            <Icon name="map" size={20} />
            <span>{t('shell.header.browseOnMap')}</span>
          </Link>
        ) : null}
      </div>
    </div>
  );
}
