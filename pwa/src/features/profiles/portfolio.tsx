'use client';
// Portfolio (Docs/22 W-PUB-02, C-PROV-01 tab 3): a grid of before/after showcases with repair-area filters; the first
// page is server-rendered, filters and "Show more" use public.org_portfolio through the BFF. On wide screens a card
// opens the showcase in a modal with a URL (?modal=showcase&item=<id>; Back closes it), on phones it opens the page.
import type { PublicPortfolioItem } from '@carpal/api-contracts';
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ds/badge';
import { Button } from '@/components/ds/button';
import { Chip } from '@/components/ds/chip';
import { MediaImage } from '@/components/media/media-image';
import { SkeletonCard } from '@/components/shell/skeleton';
import { StateView, stateFromProblem } from '@/components/shell/states';
import { UrlModal, useUrlModal } from '@/components/shell/url-modal';
import { useApiInfiniteQuery, useApiQuery } from '@/lib/api/query';
import { useFormat } from '@/lib/format/client';
import { useLocale, useT } from '@/lib/i18n/client';
import { showcasePath } from '@/lib/seo/urls';
import { ShowcaseBody } from './showcase';
import { beforeAfter } from './view-model';

export const SHOWCASE_MODAL = 'showcase';
const WIDE = '(min-width: 768px)';

export function ShowcaseCard({ item, onOpen }: { item: PublicPortfolioItem; onOpen?: (id: string) => void }) {
  const t = useT();
  const locale = useLocale();
  const { after, before } = beforeAfter(item.media);
  const cover = after ?? before;
  const href = showcasePath(locale, item.id, item.title);
  return (
    <article className="pwa-showcase-card">
      <MediaImage
        url={cover?.url}
        thumbnailUrl={cover?.thumbnail_url}
        variant="thumb"
        alt=""
        aspect="square"
        placeholder={t('profiles.portfolio.photoPending')}
      />
      <a
        href={href}
        className="pwa-card-link pwa-text-label"
        dir="auto"
        onClick={(e) => {
          if (!onOpen || e.metaKey || e.ctrlKey || e.shiftKey || !window.matchMedia(WIDE).matches) return;
          e.preventDefault();
          onOpen(item.id);
        }}
      >
        {item.title}
      </a>
      <span className="pwa-text-caption">
        {[item.service_system.text, item.vehicle.series?.text ?? item.vehicle.model?.text].filter(Boolean).join(' · ')}
      </span>
      {after && before ? <Badge>{t('profiles.portfolio.beforeAfter')}</Badge> : null}
    </article>
  );
}

function ShowcaseModalBody({ id }: { id: string }) {
  const t = useT();
  const f = useFormat();
  const locale = useLocale();
  const q = useApiQuery('showcases.get', { path: { item_id: id } }, { staleTime: 60_000 });
  if (q.isPending) return <SkeletonCard lines={4} />;
  if (q.error) return <StateView kind={stateFromProblem(q.error)} t={t} compact />;
  return (
    <div className="pwa-stack">
      <ShowcaseBody item={q.data} locale={locale} t={t} f={f} headingLevel={2} />
      <a className="pwa-link" href={showcasePath(locale, q.data.id, q.data.title)}>
        {t('profiles.showcase.openPage')}
      </a>
    </div>
  );
}

export function Portfolio({
  orgId,
  initial,
  categories,
}: {
  orgId: string;
  initial: { items: PublicPortfolioItem[]; next_cursor: string | null };
  categories: { id: string; label: string }[];
}) {
  const t = useT();
  const modal = useUrlModal(SHOWCASE_MODAL, ['item']);
  const [system, setSystem] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const live = system !== null || more;
  const q = useApiInfiniteQuery(
    'public.org_portfolio',
    { path: { org_id: orgId }, query: { limit: 12, ...(system ? { service_system_node_id: system } : {}) } },
    { enabled: live },
  );
  const items = live ? (q.data?.pages.flatMap((p) => p.items) ?? []) : initial.items;
  const hasMore = live ? q.hasNextPage : !!initial.next_cursor;
  const openId = modal.isOpen ? modal.params.get('item') : null;
  const pages = q.data?.pages.length ?? 0;
  // "Show more" on the server-rendered page: the live list starts with the same first page, so go on to the second.
  useEffect(() => {
    if (more && system === null && pages === 1 && q.hasNextPage && !q.isFetchingNextPage) void q.fetchNextPage();
  }, [more, system, pages, q]);

  if (!live && initial.items.length === 0)
    return (
      <StateView
        kind="empty"
        t={t}
        title={t('profiles.portfolio.empty')}
        text={t('profiles.portfolio.emptyText')}
        compact
        headingLevel={3}
      />
    );

  return (
    <div className="pwa-stack">
      {categories.length > 1 ? (
        <div className="pwa-chips" role="group" aria-label={t('profiles.portfolio.filterLabel')}>
          <Chip selected={system === null} onClick={() => setSystem(null)}>
            {t('profiles.portfolio.all')}
          </Chip>
          {categories.map((c) => (
            <Chip key={c.id} selected={system === c.id} onClick={() => setSystem(c.id)}>
              {c.label}
            </Chip>
          ))}
        </div>
      ) : null}
      {live && q.isPending ? (
        <SkeletonCard lines={2} />
      ) : live && q.error ? (
        <StateView
          kind={stateFromProblem(q.error)}
          t={t}
          compact
          action={<Button onClick={() => void q.refetch()}>{t('common.actions.retry')}</Button>}
        />
      ) : items.length === 0 ? (
        <p className="pwa-text-body">{t('profiles.portfolio.empty')}</p>
      ) : (
        <div className="pwa-showcase-grid">
          {items.map((item) => (
            <ShowcaseCard key={item.id} item={item} onOpen={(id) => modal.open({ item: id })} />
          ))}
        </div>
      )}
      {hasMore ? (
        <div>
          <Button
            loading={q.isFetchingNextPage}
            onClick={() => {
              if (!live) setMore(true);
              else void q.fetchNextPage();
            }}
          >
            {t('profiles.portfolio.loadMore')}
          </Button>
        </div>
      ) : null}
      <UrlModal control={modal} name={SHOWCASE_MODAL} title={t('profiles.showcase.label')}>
        {openId ? <ShowcaseModalBody id={openId} /> : null}
      </UrlModal>
    </div>
  );
}
