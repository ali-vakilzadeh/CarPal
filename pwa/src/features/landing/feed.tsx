// "Recent showcases" of the landing page (Docs/22 W-PUB-01): showcase items of feed.discover for the chosen city. The
// feed card is server-defined JSON (FeedCard, backend modules/discovery/application/feed-ops.ts: title, organization,
// service_system, thumbnail_url, published_at), so it is read defensively; unknown shapes are skipped.
// Server-renderable.
import type { FeedItem, PublicOrgCard } from '@carpal/api-contracts';
import { MediaImage } from '@/components/media/media-image';
import type { Locale } from '@/lib/i18n/locales';
import type { Translate } from '@/lib/i18n/keys';
import { showcasePath } from '@/lib/seo/urls';

export interface ShowcaseTeaser {
  id: string;
  title: string;
  system: string | null;
  organization: Pick<PublicOrgCard, 'name'> | null;
  thumbnailUrl: string | null;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

export function showcaseTeasers(items: readonly FeedItem[], max = 6): ShowcaseTeaser[] {
  const out: ShowcaseTeaser[] = [];
  for (const item of items) {
    if (item.kind !== 'showcase' || item.ref.type !== 'portfolio_item') continue;
    const c = item.card as Record<string, unknown>;
    const title = str(c.title);
    if (!title) continue;
    const system = c.service_system && typeof c.service_system === 'object' ? str((c.service_system as { text?: unknown }).text) : null;
    const org = c.organization && typeof c.organization === 'object' ? str((c.organization as { name?: unknown }).name) : null;
    out.push({ id: item.ref.id, title, system, organization: org ? { name: org } : null, thumbnailUrl: str(c.thumbnail_url) });
    if (out.length >= max) break;
  }
  return out;
}

export function ShowcaseTeasers({ items, locale, t }: { items: readonly ShowcaseTeaser[]; locale: Locale; t: Translate }) {
  return (
    <ul className="pwa-plain-list pwa-showcase-grid">
      {items.map((s) => (
        <li key={s.id} className="pwa-showcase-card">
          <MediaImage url={s.thumbnailUrl} alt="" aspect="square" placeholder={t('landing.showcases.photoPending')} />
          <a href={showcasePath(locale, s.id, s.title)} className="pwa-card-link pwa-text-label" dir="auto">
            {s.title}
          </a>
          <span className="pwa-text-caption">{[s.organization?.name, s.system].filter(Boolean).join(' · ')}</span>
        </li>
      ))}
    </ul>
  );
}
