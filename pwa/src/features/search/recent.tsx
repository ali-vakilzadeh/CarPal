'use client';
// Recent searches (Docs/21 S-SHARED-01: the last 5, each removable, Clear all). Kept per device in localStorage
// (storage.ts) and never sent; picking one runs it again through the search hand-over.
import { Icon } from '@/components/ds/icon';
import { IconButton } from '@/components/ds/icon-button';
import { useT } from '@/lib/i18n/client';
import { useSyncExternalStore } from 'react';
import { clearRecent, readRecent, removeRecent, subscribeRecent, type RecentSearch } from './storage';

const NONE: RecentSearch[] = [];

export function useRecentSearches(): RecentSearch[] {
  return useSyncExternalStore(subscribeRecent, readRecent, () => NONE);
}

export function RecentSearches({ onPick, compact }: { onPick: (r: RecentSearch) => void; compact?: boolean }) {
  const t = useT();
  const recent = useRecentSearches();
  if (!recent.length) return null;
  return (
    <section
      className={compact ? 'pwa-recent is-compact' : 'pwa-recent'}
      aria-labelledby={compact ? undefined : 'recent-title'}
      aria-label={compact ? t('shell.header.recentTitle') : undefined}
    >
      <div className="pwa-section-head">
        {compact ? (
          <span className="pwa-text-caption">{t('shell.header.recentTitle')}</span>
        ) : (
          <h2 id="recent-title" className="pwa-text-label m-0">
            {t('shell.header.recentTitle')}
          </h2>
        )}
        <button type="button" className="pwa-link pwa-text-caption" onMouseDown={(e) => e.preventDefault()} onClick={clearRecent}>
          {t('shell.header.recentClear')}
        </button>
      </div>
      <ul className="pwa-plain-list pwa-recent-list">
        {recent.map((r) => (
          <li key={r.text} className="pwa-recent-item">
            <button type="button" className="pwa-recent-pick" onMouseDown={(e) => e.preventDefault()} onClick={() => onPick(r)}>
              <Icon name="clock" size={20} />
              <span dir="auto">{r.text}</span>
            </button>
            <IconButton
              icon="close"
              label={t('shell.header.recentRemove', { text: r.text })}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => removeRecent(r.text)}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}
