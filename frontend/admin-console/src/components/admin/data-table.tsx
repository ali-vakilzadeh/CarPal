'use client';
// DataTable (AC5.T1, Docs/23 §1 principle 9, Docs/40 §3.3, SEC-ADM-7): a dense table with a fixed header, column
// choice and saved views (kept in this browser without any data, src/lib/prefs, GD-12), filters bound to the URL
// (enumerated values only, so a view link can be shared), cursor paging (admin pages hold at most 100 rows; a
// cursor carries its filters, so changing a filter starts again at page 1), keyboard row navigation (↑/↓ on the row
// buttons, J/K anywhere on the page, Enter opens), loading, empty and error states, and a Latin-digit toggle for IDs
// and timestamps in Persian (GD-05).
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Banner } from '@/components/ds/banner';
import { Button } from '@/components/ds/button';
import { Check } from '@/components/ds/check';
import { IconButton } from '@/components/ds/icon-button';
import { useShortcut } from '@/features/shell';
import type { ApiProblem } from '@/lib/api/problem';
import { useLocale, useT } from '@/lib/i18n/client';
import { localizeDigits } from '@/lib/format';
import { cleanFilters, readLatinIds, readTablePrefs, writeLatinIds, writeTablePrefs, type SavedView, type TablePrefs } from '@/lib/prefs';
import { problemText } from './four-eyes-banner';

/** Admin list pages hold at most 100 rows (Docs/40 §3.3, SEC-ADM-7). */
export const ADMIN_PAGE_MAX = 100;

export interface CellContext {
  /** Digits for IDs, codes and timestamps: Latin when the staff member chose so, else the UI language's. */
  digits: (value: string) => string;
}

export interface Column<T> {
  /** a-z and '_' (kept in view settings). */
  id: string;
  header: string;
  cell: (row: T, ctx: CellContext) => ReactNode;
  /** Always shown (the row's name); the first pinned column carries the row button. */
  pinned?: boolean;
  defaultHidden?: boolean;
  /** Numbers and dates align to the end. */
  align?: 'start' | 'end';
}

export interface FilterOption {
  value: string;
  label: string;
}

export interface FilterDef {
  key: string;
  label: string;
  options: readonly FilterOption[];
  /** Used when the URL has no (valid) value; '' = no filter ("All"). */
  defaultValue?: string;
  /** Adds an "All" choice (value ''). */
  allowAll?: boolean;
}

/** Filters bound to the URL: only listed values count, anything else falls back to the default. */
export function useUrlFilters(defs: readonly FilterDef[]) {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const values = useMemo(() => {
    const out: Record<string, string> = {};
    for (const d of defs) {
      const v = params.get(d.key);
      const valid = v !== null && (d.options.some((o) => o.value === v) || (d.allowAll && v === ''));
      out[d.key] = valid ? v : (d.defaultValue ?? '');
    }
    return out;
  }, [defs, params]);

  const replace = useCallback(
    (next: Record<string, string>) => {
      const p = new URLSearchParams(params);
      for (const d of defs) {
        const v = next[d.key];
        if (v === undefined || v === (d.defaultValue ?? '')) p.delete(d.key);
        else p.set(d.key, v);
      }
      const q = p.toString();
      router.replace(`${pathname}${q ? `?${q}` : ''}`, { scroll: false });
    },
    [defs, params, pathname, router],
  );

  const setFilter = useCallback((key: string, value: string) => replace({ ...values, [key]: value }), [replace, values]);
  const applyView = useCallback(
    (view: SavedView) => {
      const next: Record<string, string> = {};
      for (const d of defs) next[d.key] = view.filters[d.key] ?? d.defaultValue ?? '';
      replace(next);
    },
    [defs, replace],
  );
  /** The filters as a query for the operation (empty values left out). */
  const query = useMemo(() => Object.fromEntries(Object.entries(values).filter(([, v]) => v !== '')), [values]);
  return { values, query, setFilter, applyView };
}

/** Cursor paging: a stack of cursors in memory; a new `resetKey` (other filters) starts at page 1. */
export function useCursorPaging(resetKey: string) {
  const [state, setState] = useState<{ key: string; stack: (string | undefined)[] }>({ key: resetKey, stack: [undefined] });
  let stack = state.stack;
  if (state.key !== resetKey) {
    stack = [undefined];
    setState({ key: resetKey, stack });
  }
  return {
    cursor: stack[stack.length - 1],
    page: stack.length,
    next: (cursor: string) => setState({ key: resetKey, stack: [...stack, cursor] }),
    prev: () => setState({ key: resetKey, stack: stack.length > 1 ? stack.slice(0, -1) : stack }),
    first: () => setState({ key: resetKey, stack: [undefined] }),
  };
}

export interface DataTableProps<T> {
  /** Settings key (a-z, digits, '-'), e.g. "approvals". */
  id: string;
  caption: string;
  columns: readonly Column<T>[];
  rows: readonly T[] | undefined;
  rowKey: (row: T) => string;
  loading?: boolean;
  error?: ApiProblem | null;
  onRetry?: () => void;
  emptyText: string;
  selectedKey?: string | null;
  onSelect?: (row: T) => void;
  /** J/K select the next/previous row (one table per page should own them). */
  shortcuts?: boolean;
  filters?: readonly FilterDef[];
  filterValues?: Record<string, string>;
  onFilterChange?: (key: string, value: string) => void;
  onApplyView?: (view: SavedView) => void;
  paging?: { page: number; hasPrev: boolean; hasNext: boolean; onPrev: () => void; onNext: () => void };
}

export function DataTable<T>(props: DataTableProps<T>) {
  const { id, caption, columns, rows, rowKey, loading, error, onRetry, emptyText, selectedKey, onSelect, shortcuts = true } = props;
  const t = useT();
  const locale = useLocale();
  const uid = useId();
  const body = useRef<HTMLTableSectionElement>(null);
  const [prefs, setPrefs] = useState<TablePrefs>({ hidden: columns.filter((c) => c.defaultHidden).map((c) => c.id), views: [] });
  const [latin, setLatin] = useState(false);

  // View settings live in this browser; read them after hydration so the server and client render the same first.
  useEffect(() => {
    const stored = readTablePrefs(id);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- browser-only settings after hydration
    if (stored.hidden.length || stored.views.length) setPrefs(stored);
    setLatin(readLatinIds());
  }, [id]);

  const savePrefs = (next: TablePrefs) => {
    setPrefs(next);
    writeTablePrefs(id, next);
  };

  const shown = columns.filter((c) => c.pinned || !prefs.hidden.includes(c.id));
  const primary = shown.find((c) => c.pinned) ?? shown[0];
  const ctx: CellContext = { digits: (v) => (latin || locale === 'en' ? v : localizeDigits(v, locale)) };

  const keys = rows?.map(rowKey) ?? [];
  const selectedIndex = selectedKey ? keys.indexOf(selectedKey) : -1;

  const focusRow = (index: number) => {
    const buttons = body.current?.querySelectorAll<HTMLButtonElement>('button[data-row-button]');
    buttons?.[index]?.focus();
  };

  const move = (delta: number) => {
    if (!rows?.length || !onSelect) return;
    const from = selectedIndex < 0 ? (delta > 0 ? -1 : rows.length) : selectedIndex;
    const to = Math.min(rows.length - 1, Math.max(0, from + delta));
    onSelect(rows[to]!);
    focusRow(to);
  };
  useShortcut('next', () => move(1), shortcuts && !!onSelect);
  useShortcut('previous', () => move(-1), shortcuts && !!onSelect);

  const onRowKey = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      focusRow(Math.min(keys.length - 1, Math.max(0, index + (e.key === 'ArrowDown' ? 1 : -1))));
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      focusRow(e.key === 'Home' ? 0 : keys.length - 1);
    }
  };

  const state = error ? 'error' : loading && !rows ? 'loading' : rows && rows.length === 0 ? 'empty' : 'ready';

  return (
    <div className="adm-table" data-kit="data-table" data-table={id} data-state={state}>
      <TableToolbar {...props} prefs={prefs} savePrefs={savePrefs} latin={latin} setLatin={setLatin} />
      {error ? (
        <div className="adm-table-error">
          <Banner tone="danger" text={problemText(error, t)} />
          {onRetry ? (
            <Button size="sm" icon="refresh" onClick={onRetry}>
              {t('admin.kit.table.retry')}
            </Button>
          ) : null}
        </div>
      ) : null}
      {/* A scrollable box must be reachable by keyboard (axe scrollable-region-focusable): a named, focusable group
          (not a landmark, so it never duplicates the case layout regions). */}
      <div className="adm-table-scroll" tabIndex={0} role="group" aria-label={caption}>
        <table aria-describedby={`${uid}-state`} aria-busy={loading ? true : undefined}>
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr>
              {shown.map((c) => (
                <th key={c.id} scope="col" data-align={c.align ?? 'start'}>
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody ref={body}>
            {state === 'ready' && rows
              ? rows.map((row, index) => {
                  const key = rowKey(row);
                  const selected = key === selectedKey;
                  return (
                    <tr key={key} aria-current={selected ? 'true' : undefined} data-row={key}>
                      {shown.map((c) => (
                        <td key={c.id} data-align={c.align ?? 'start'}>
                          {c === primary && onSelect ? (
                            <button
                              type="button"
                              className="adm-row-button"
                              data-row-button
                              aria-pressed={selected}
                              onClick={() => onSelect(row)}
                              onKeyDown={(e) => onRowKey(e, index)}
                            >
                              {c.cell(row, ctx)}
                            </button>
                          ) : (
                            c.cell(row, ctx)
                          )}
                        </td>
                      ))}
                    </tr>
                  );
                })
              : null}
          </tbody>
        </table>
        <p id={`${uid}-state`} className={state === 'ready' ? 'sr-only' : 'adm-table-state'} role="status">
          {state === 'loading'
            ? t('admin.kit.table.loading')
            : state === 'empty'
              ? emptyText
              : state === 'error'
                ? t('admin.kit.table.failed')
                : t('admin.kit.table.rows', { count: rows?.length ?? 0 })}
        </p>
      </div>
      {props.paging && (props.paging.hasPrev || props.paging.hasNext) ? (
        <nav className="adm-table-paging" aria-label={t('admin.kit.table.paging')}>
          <Button size="sm" icon="back" disabled={!props.paging.hasPrev} onClick={props.paging.onPrev}>
            {t('admin.kit.table.prev')}
          </Button>
          <span className="adm-muted">{t('admin.kit.table.page', { n: ctx.digits(String(props.paging.page)) })}</span>
          <Button size="sm" iconEnd="next" disabled={!props.paging.hasNext} onClick={props.paging.onNext}>
            {t('admin.kit.table.next')}
          </Button>
        </nav>
      ) : null}
    </div>
  );
}

function TableToolbar<T>({
  columns,
  filters,
  filterValues,
  onFilterChange,
  onApplyView,
  prefs,
  savePrefs,
  latin,
  setLatin,
}: DataTableProps<T> & { prefs: TablePrefs; savePrefs: (p: TablePrefs) => void; latin: boolean; setLatin: (v: boolean) => void }) {
  const t = useT();
  const locale = useLocale();
  const uid = useId();
  const [viewName, setViewName] = useState('');
  const hideable = columns.filter((c) => !c.pinned);
  const saveView = () => {
    const name = viewName.trim().slice(0, 40);
    if (!name || !filterValues) return;
    const view: SavedView = { name, filters: cleanFilters(filterValues) };
    savePrefs({ ...prefs, views: [view, ...prefs.views.filter((v) => v.name !== name)] });
    setViewName('');
  };
  return (
    <div className="adm-table-toolbar">
      {filters?.map((d) => (
        <div key={d.key} className="adm-filter">
          <label htmlFor={`${uid}-${d.key}`}>{d.label}</label>
          <select
            id={`${uid}-${d.key}`}
            className="adm-select"
            value={filterValues?.[d.key] ?? ''}
            onChange={(e) => onFilterChange?.(d.key, e.target.value)}
          >
            {d.allowAll ? <option value="">{t('admin.kit.table.all')}</option> : null}
            {d.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      ))}
      <div className="adm-table-tools">
        {hideable.length ? (
          <details className="adm-menu">
            <summary className="cp-btn cp-btn-ghost cp-btn-sm">{t('admin.kit.table.columns')}</summary>
            <fieldset className="adm-menu-panel">
              <legend className="sr-only">{t('admin.kit.table.columns')}</legend>
              {hideable.map((c) => (
                <Check
                  key={c.id}
                  checked={!prefs.hidden.includes(c.id)}
                  onChange={(e) =>
                    savePrefs({
                      ...prefs,
                      hidden: e.target.checked ? prefs.hidden.filter((h) => h !== c.id) : [...prefs.hidden, c.id],
                    })
                  }
                >
                  {c.header}
                </Check>
              ))}
            </fieldset>
          </details>
        ) : null}
        {filters?.length && onApplyView ? (
          <details className="adm-menu">
            <summary className="cp-btn cp-btn-ghost cp-btn-sm">{t('admin.kit.table.views')}</summary>
            <div className="adm-menu-panel">
              {prefs.views.length ? (
                <ul className="adm-views">
                  {prefs.views.map((v) => (
                    <li key={v.name}>
                      <Button size="sm" variant="ghost" onClick={() => onApplyView(v)}>
                        {v.name}
                      </Button>
                      <IconButton
                        icon="trash"
                        label={t('admin.kit.table.deleteView', { name: v.name })}
                        onClick={() => savePrefs({ ...prefs, views: prefs.views.filter((x) => x.name !== v.name) })}
                      />
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="adm-muted">{t('admin.kit.table.noViews')}</p>
              )}
              <form
                className="adm-view-save"
                onSubmit={(e) => {
                  e.preventDefault();
                  saveView();
                }}
              >
                <label htmlFor={`${uid}-view`}>{t('admin.kit.table.viewName')}</label>
                <input
                  id={`${uid}-view`}
                  className="adm-input"
                  value={viewName}
                  maxLength={40}
                  dir="auto"
                  onChange={(e) => setViewName(e.target.value)}
                />
                <Button size="sm" type="submit" disabled={!viewName.trim()}>
                  {t('admin.kit.table.saveView')}
                </Button>
              </form>
              <p className="adm-muted">{t('admin.kit.table.viewsLocal')}</p>
            </div>
          </details>
        ) : null}
        {locale !== 'en' ? (
          <Check
            checked={latin}
            onChange={(e) => {
              setLatin(e.target.checked);
              writeLatinIds(e.target.checked);
            }}
          >
            {t('admin.kit.table.latinDigits')}
          </Check>
        ) : null}
      </div>
    </div>
  );
}
