'use client';
// Tabs bound to the URL (AC14-2; first written for the organization page in AC9): the open tab is ?tab= (the first tab
// leaves it out), so a link or a reload opens the same tab. A WAI-ARIA tab list: one tab in the Tab order, arrow keys
// move between tabs in the reading direction (right-to-left in Persian), the panel names its tab.
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { ReactNode } from 'react';

/** The open tab from ?tab= (the first tab when absent or unknown) and a setter that keeps the other parameters. */
export function useUrlTab<T extends string>(tabs: readonly T[]): [T, (tab: T) => void] {
  const params = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const asked = params.get('tab');
  const first = tabs[0]!;
  const tab = tabs.find((x) => x === asked) ?? first;
  const go = (x: T) => {
    const p = new URLSearchParams(params);
    if (x === first) p.delete('tab');
    else p.set('tab', x);
    const q = p.toString();
    router.replace(`${pathname}${q ? `?${q}` : ''}`, { scroll: false });
  };
  return [tab, go];
}

export interface TabsProps<T extends string> {
  tabs: readonly T[];
  current: T;
  onChange: (tab: T) => void;
  /** The tab list's accessible name. */
  label: string;
  /** Element ids: `${idPrefix}-tab-${tab}` and `${idPrefix}-tabpanel`. */
  idPrefix: string;
  tabLabel: (tab: T) => string;
  children: ReactNode;
}

export function Tabs<T extends string>({ tabs, current, onChange, label, idPrefix, tabLabel, children }: TabsProps<T>) {
  return (
    <>
      <div className="adm-tabs" role="tablist" aria-label={label}>
        {tabs.map((x) => (
          <button
            key={x}
            type="button"
            role="tab"
            id={`${idPrefix}-tab-${x}`}
            aria-selected={x === current}
            aria-controls={`${idPrefix}-tabpanel`}
            tabIndex={x === current ? 0 : -1}
            className="adm-tab"
            onClick={() => onChange(x)}
            onKeyDown={(e) => {
              const i = tabs.indexOf(current);
              const rtl = document.documentElement.dir === 'rtl';
              const step = e.key === (rtl ? 'ArrowLeft' : 'ArrowRight') ? 1 : e.key === (rtl ? 'ArrowRight' : 'ArrowLeft') ? -1 : 0;
              const to =
                e.key === 'Home'
                  ? tabs[0]
                  : e.key === 'End'
                    ? tabs[tabs.length - 1]
                    : step
                      ? tabs[(i + step + tabs.length) % tabs.length]
                      : undefined;
              if (!to) return;
              e.preventDefault();
              onChange(to);
              document.getElementById(`${idPrefix}-tab-${to}`)?.focus();
            }}
          >
            {tabLabel(x)}
          </button>
        ))}
      </div>
      <div id={`${idPrefix}-tabpanel`} role="tabpanel" aria-labelledby={`${idPrefix}-tab-${current}`} className="adm-stack">
        <h2 className="sr-only">{tabLabel(current)}</h2>
        {children}
      </div>
    </>
  );
}
