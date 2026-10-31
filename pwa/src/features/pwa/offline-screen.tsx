'use client';
// W-SYS-01 Offline (P12.T2): what the service worker answers for a page it has no copy of while the network is gone.
// Lists the pages saved on this device for the signed-in user (garage, cars, appointments, driver views — the
// worker's saved-pages list in the user's cache) with when they were saved, plus Try again. The page is precached
// without cookies, so it never holds a session itself; the list is read from Cache Storage in the browser.
import { useEffect, useState } from 'react';
import { Button } from '@/components/ds/button';
import { Icon } from '@/components/ds/icon';
import { useFormat } from '@/lib/format/client';
import { useLocale, useT } from '@/lib/i18n/client';
import { SAVED_PAGES_KEY, USER_CACHE_PREFIX, type SavedPage } from '@/sw/protocol';
import { useOnline } from './runtime';

/** Saved pages of the (one) user cache, newest first, limited to this locale. */
export async function readSavedPages(locale: string): Promise<SavedPage[]> {
  if (typeof caches === 'undefined') return [];
  const names = (await caches.keys()).filter((n) => n.startsWith(USER_CACHE_PREFIX));
  const out: SavedPage[] = [];
  for (const name of names) {
    const res = await (await caches.open(name)).match(SAVED_PAGES_KEY);
    if (res) out.push(...(((await res.json().catch(() => [])) as SavedPage[]) ?? []));
  }
  return out.filter((p) => typeof p.url === 'string' && p.url.startsWith(`/${locale}/`)).sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}

export function OfflineScreen() {
  const t = useT();
  const f = useFormat();
  const locale = useLocale();
  const online = useOnline();
  const [pages, setPages] = useState<SavedPage[] | null>(null);

  useEffect(() => {
    void readSavedPages(locale)
      .then(setPages)
      .catch(() => setPages([]));
  }, [locale]);

  return (
    <main id="main" className="pwa-offline-page">
      <div className="pwa-offline-head">
        <Icon name="offline" size={32} />
        <h1 className="pwa-text-title m-0">{t('pwa.offline.title')}</h1>
        <p className="m-0">{online ? t('pwa.offline.backOnline') : t('pwa.offline.text')}</p>
        <div>
          <Button variant="primary" icon="refresh" onClick={() => location.reload()}>
            {t('pwa.offline.retry')}
          </Button>
        </div>
      </div>
      <section aria-labelledby="saved-title" className="pwa-stack-sm">
        <h2 id="saved-title" className="pwa-text-label m-0">
          {t('pwa.offline.savedTitle')}
        </h2>
        {pages === null ? null : pages.length === 0 ? (
          <p className="pwa-text-caption m-0">{t('pwa.offline.nothingSaved')}</p>
        ) : (
          <ul className="pwa-offline-list" data-testid="saved-pages">
            {pages.map((p) => (
              <li key={p.url}>
                <a href={p.url} className="pwa-offline-item">
                  <span className="pwa-text-label" dir="auto">
                    {p.title || p.url}
                  </span>
                  <span className="pwa-text-caption">{t('pwa.offline.savedAt', { time: f.date(p.savedAt, 'dateTime') })}</span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
