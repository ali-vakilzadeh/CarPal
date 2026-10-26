'use client';
// Parts of a seller (Docs/22 W-PUB-03, C-VEND-01 inventory tab): search within the seller, a category filter, "Fits my
// car" for a signed-in user's active vehicle, and the part grid. The first page (the seller's first part category) is
// server-rendered so crawlers reach the part pages. Anti-scraping rule (Docs/22): without a search term there is no
// page beyond the first; the backend also refuses a search without text, category or vehicle (SEC-BF-4).
import type { PublicInventoryCard } from '@carpal/api-contracts';
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ds/button';
import { Chip } from '@/components/ds/chip';
import { TextField } from '@/components/ds/text-field';
import { SkeletonCard } from '@/components/shell/skeleton';
import { StateView, stateFromProblem } from '@/components/shell/states';
import { useApiInfiniteQuery } from '@/lib/api/query';
import { useFormat } from '@/lib/format/client';
import { useLocale, useT } from '@/lib/i18n/client';
import { partPath } from '@/lib/seo/urls';
import { PartCard } from './part-card';
import { useCarNames } from './use-car';

const PAGE = 12;

export function VendorParts({
  orgId,
  vendorSlug,
  categories,
  initial,
  initialCategory,
}: {
  orgId: string;
  vendorSlug: string;
  categories: { id: string; label: string }[];
  initial: { items: PublicInventoryCard[]; next_cursor: string | null } | null;
  initialCategory: string | null;
}) {
  const t = useT();
  const f = useFormat();
  const locale = useLocale();
  const { car } = useCarNames();
  const [draft, setDraft] = useState('');
  const [text, setText] = useState('');
  const [category, setCategory] = useState<string | null>(initialCategory);
  const [mine, setMine] = useState(false);
  const live = text !== '' || category !== initialCategory || mine;
  const hasFilter = text !== '' || category !== null || (mine && !!car);
  const q = useApiInfiniteQuery(
    'public.org_inventory_search',
    {
      path: { org_id: orgId },
      body: {
        limit: PAGE,
        ...(text ? { text } : {}),
        ...(category ? { part_category_node_id: category } : {}),
        ...(mine && car ? { vehicle_id: car.id } : {}),
      },
    },
    { cursorIn: 'body', enabled: live && hasFilter },
  );
  const items = live ? (q.data?.pages.flatMap((p) => p.items) ?? []) : (initial?.items ?? []);
  // Beyond the first page only with a search term (Docs/22 anti-scraping rule).
  const canPage = text !== '' && (live ? q.hasNextPage : !!initial?.next_cursor);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setText(draft.trim().slice(0, 100));
  };

  return (
    <div className="pwa-stack">
      <form role="search" className="pwa-parts-search" onSubmit={submit} aria-label={t('profiles.parts.searchLabel')}>
        <TextField
          label={t('profiles.parts.searchLabel')}
          placeholder={t('profiles.parts.searchPlaceholder')}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          maxLength={100}
          icon="search"
        />
        <Button type="submit">{t('profiles.parts.search')}</Button>
      </form>
      <div className="pwa-chips" role="group" aria-label={t('profiles.parts.category')}>
        {categories.map((c) => (
          <Chip key={c.id} selected={category === c.id} onClick={() => setCategory(category === c.id ? null : c.id)}>
            {c.label}
          </Chip>
        ))}
        {car ? (
          <Chip selected={mine} icon="car" onClick={() => setMine((v) => !v)}>
            <bdi>{car.label}</bdi>
          </Chip>
        ) : null}
      </div>
      {!hasFilter ? (
        <p className="pwa-text-caption">{t('profiles.parts.searchForMore')}</p>
      ) : live && q.isPending ? (
        <SkeletonCard lines={3} />
      ) : live && q.error ? (
        <StateView
          kind={stateFromProblem(q.error)}
          t={t}
          compact
          action={<Button onClick={() => void q.refetch()}>{t('common.actions.retry')}</Button>}
        />
      ) : items.length === 0 ? (
        <p className="pwa-text-body">{live ? t('profiles.parts.empty') : t('profiles.parts.emptyCatalog')}</p>
      ) : (
        <div className="pwa-part-grid" aria-label={t('profiles.parts.results')}>
          {items.map((item) => (
            <PartCard key={item.id} item={item} href={partPath(locale, vendorSlug, item.id, item.name.text)} t={t} f={f} />
          ))}
        </div>
      )}
      {canPage ? (
        <div>
          <Button loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
            {t('profiles.parts.loadMore')}
          </Button>
        </div>
      ) : items.length > 0 && !text ? (
        <p className="pwa-text-caption">{t('profiles.parts.searchForMore')}</p>
      ) : null}
    </div>
  );
}
