'use client';
// W-FEED-01 Home (mirrors C-HOME-01 Discover blocks and C-COMM-01; P8.T1) at /<locale>/home, signed in: the Help Me bar
// ("Something wrong with Silver? Describe it…" → Help Me with the text, P10), "Ask the community" (the composer is
// question-only, DI-02, so it opens W-QA-02), Needs your attention (at most 3 cards, one action each: add your first
// car, ownership requests, overdue or due reminders and documents expiring within 30 days of the active car;
// appointment and review cards come with P10/P11), and the Discover stream — feed.discover is the only feed the
// contract has (DI-07): no For you / Following / Nearby / Showcases / Tips / Q&A tabs, no "Not interested", no
// "3 new posts" pill. Cards: updates from followed shops (named through follows.list; behind community.feed.enabled),
// showcases, nearby shops with Follow; inline blocks: Recommended for your car, Maintenance for your car, Popular
// questions (qna.enabled). States: skeleton, error with Retry, thin feed (follow prompts + Q&A), empty.
import type { Follow, PublicOrgCard, VehicleDocument } from '@carpal/api-contracts';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { Badge } from '@/components/ds/badge';
import { Button, buttonClass } from '@/components/ds/button';
import { TextField } from '@/components/ds/text-field';
import { MediaImage } from '@/components/media/media-image';
import { useActiveVehicle, useVehicleLabel } from '@/components/shell/active-vehicle';
import { InfiniteList } from '@/components/shell/infinite-list';
import { StateView } from '@/components/shell/states';
import { visitSoon } from '@/features/appointments';
import { saveHelpDraft } from '@/features/onboarding';
import { invitationHref } from '@/features/reviews';
import { FollowButton, OrgCard } from '@/features/profiles';
import { useApiInfiniteQuery, useApiQuery } from '@/lib/api/query';
import { useFlag } from '@/lib/config/client';
import { useFormat } from '@/lib/format/client';
import { useLocale, useT } from '@/lib/i18n/client';
import type { MessageKey } from '@/lib/i18n/keys';
import { orgPath, questionPath, showcasePath } from '@/lib/seo/urls';
import { helpHref } from './help-link';
import { feedBlocks, THIN_FEED, type FeedBlock, type FeedCardView } from './model';

const FEED_PAGE = 20;
const SOON_DAYS = 30;

export interface AttentionCard {
  key: string;
  text: string;
  action: string;
  href: string;
  tone: 'danger' | 'signal' | 'neutral';
}

/** Days from today (calendar dates) to an ISO date or date-time; negative = past. */
export function daysUntil(iso: string, now = new Date()): number {
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  return Math.round((day.getTime() - today.getTime()) / 86_400_000);
}

/** Documents of the active car that expire within SOON_DAYS (or already did), soonest first. */
export function expiringDocuments(docs: readonly VehicleDocument[], now = new Date()): VehicleDocument[] {
  return docs
    .filter((d) => d.status === 'active' && d.expires_at && daysUntil(d.expires_at, now) <= SOON_DAYS)
    .sort((a, b) => a.expires_at!.localeCompare(b.expires_at!));
}

function useAttention(): AttentionCard[] {
  const t = useT();
  const f = useFormat();
  const locale = useLocale();
  const { vehicles, active, isLoading } = useActiveVehicle();
  const label = useVehicleLabel(active);
  const transfers = useApiQuery(
    'vehicles.transfers_list',
    { query: { direction: 'incoming', status: 'pending', limit: 20 } },
    { staleTime: 60_000 },
  );
  const reminders = useApiQuery('reminders.list', active ? { path: { vehicle_id: active.id }, query: { limit: 50 } } : undefined, {
    enabled: !!active,
    staleTime: 60_000,
  });
  const docs = useApiQuery('vehicles.documents_list', active ? { path: { vehicle_id: active.id }, query: { limit: 50 } } : undefined, {
    enabled: !!active,
    staleTime: 60_000,
  });
  // Appointments waiting for the user (P10.T6): a time the shop proposed, a visit in the next 24 hours.
  const requested = useApiQuery('appointments.list', { query: { group: 'requested', limit: 20 } }, { staleTime: 60_000 });
  const upcoming = useApiQuery('appointments.list', { query: { group: 'upcoming', limit: 20 } }, { staleTime: 60_000 });
  // Open review invitations (P11.T5): "How was your visit to Reza Auto Suspension?" → the review page.
  const invitations = useApiQuery('review_invitations.mine_list', { query: { limit: 10 } }, { staleTime: 60_000 });
  const cards: AttentionCard[] = [];
  for (const a of (requested.data?.items ?? []).filter((x) => x.status === 'alternative_proposed' && x.proposed_start_at).slice(0, 2))
    cards.push({
      key: `proposed:${a.id}`,
      text: t('community.home.attention.proposed', { name: a.provider.name, time: f.date(a.proposed_start_at!, 'dateTime') }),
      action: t('community.home.attention.reply'),
      href: `/${locale}/appointments/${encodeURIComponent(a.id)}`,
      tone: 'signal',
    });
  for (const a of (upcoming.data?.items ?? []).filter((x) => visitSoon(x)).slice(0, 1))
    cards.push({
      key: `visit:${a.id}`,
      text: t('community.home.attention.visit', { name: a.provider.name, time: f.date(a.confirmed_start_at!, 'dateTime') }),
      action: t('community.home.attention.openVisit'),
      href: `/${locale}/appointments/${encodeURIComponent(a.id)}`,
      tone: 'neutral',
    });
  for (const i of (invitations.data?.items ?? []).slice(0, 1)) {
    const href = invitationHref(locale, i);
    if (href)
      cards.push({
        key: `review:${i.id}`,
        text: t('community.home.attention.review', { name: i.subject.name }),
        action: t('community.home.attention.reviewAction'),
        href,
        tone: 'neutral',
      });
  }
  const garage = active ? `/${locale}/garage/${active.id}` : `/${locale}/garage`;
  if (!isLoading && vehicles.length === 0)
    cards.push({
      key: 'add-car',
      text: t('community.home.attention.addCar'),
      action: t('community.home.attention.addCarAction'),
      href: `/${locale}/garage/add`,
      tone: 'neutral',
    });
  const incoming = transfers.data?.items.length ?? 0;
  if (incoming)
    cards.push({
      key: 'transfers',
      text: t('shell.attention.transfers', { count: incoming }),
      action: t('shell.attention.review'),
      href: `/${locale}/garage`,
      tone: 'signal',
    });
  const due = (reminders.data?.items ?? []).filter((r) => r.status === 'overdue' || r.status === 'due');
  for (const r of due.sort((a, b) => Number(b.status === 'overdue') - Number(a.status === 'overdue')).slice(0, 2))
    cards.push({
      key: `reminder:${r.id}`,
      text: t(r.status === 'overdue' ? 'community.home.attention.overdue' : 'community.home.attention.due', {
        title: r.title,
        car: label ?? '',
      }),
      action: t('community.home.attention.openReminders'),
      href: `${garage}/reminders`,
      tone: r.status === 'overdue' ? 'danger' : 'signal',
    });
  for (const d of expiringDocuments(docs.data?.items ?? []).slice(0, 1)) {
    const days = daysUntil(d.expires_at!);
    cards.push({
      key: `doc:${d.id}`,
      text:
        days < 0
          ? t('community.home.attention.docExpired', { title: d.title, date: f.calendarDate(d.expires_at!.slice(0, 10)) })
          : t('community.home.attention.docExpiring', { title: d.title, date: f.calendarDate(d.expires_at!.slice(0, 10)) }),
      action: t('community.home.attention.openDocuments'),
      href: `${garage}/documents`,
      tone: days < 0 ? 'danger' : 'signal',
    });
  }
  return cards.slice(0, 3);
}

function HelpMeBar() {
  const t = useT();
  const locale = useLocale();
  const router = useRouter();
  const { active } = useActiveVehicle();
  const label = useVehicleLabel(active);
  const [text, setText] = useState('');
  return (
    <form
      className="pwa-helpme-bar"
      role="search"
      aria-label={t('community.home.helpMeLabel')}
      onSubmit={(e) => {
        e.preventDefault();
        saveHelpDraft({ vehicleId: active?.id ?? null, text: text.trim(), symptoms: [] });
        router.push(helpHref(locale));
      }}
    >
      <TextField
        icon="spark"
        label={label ? t('community.home.helpMeFor', { car: label }) : t('community.home.helpMe')}
        placeholder={t('community.home.helpMePlaceholder')}
        value={text}
        maxLength={2000}
        onChange={(e) => setText(e.target.value)}
      />
      <Button type="submit" variant="primary">
        {t('community.home.helpMeGo')}
      </Button>
    </form>
  );
}

const POST_TYPE: Record<string, MessageKey> = {
  showcase: 'community.postType.showcase',
  availability: 'community.postType.availability',
  seasonal_advice: 'community.postType.seasonal_advice',
  special_offer: 'community.postType.special_offer',
  educational_tip: 'community.postType.educational_tip',
  job_completion: 'community.postType.job_completion',
  community_event: 'community.postType.community_event',
};

function FeedCard({ card, orgs }: { card: FeedCardView; orgs: Map<string, PublicOrgCard> }) {
  const t = useT();
  const f = useFormat();
  const locale = useLocale();
  switch (card.kind) {
    case 'provider':
      return (
        <article className="pwa-feed-card">
          <Badge icon="pin">{t('community.feed.nearby')}</Badge>
          <OrgCard
            org={card.org}
            locale={locale}
            t={t}
            f={f}
            detail={card.distanceKm !== null ? f.distance(card.distanceKm * 1000) : null}
            headingLevel={3}
          />
          <FollowButton orgId={card.org.id} name={card.org.name} size="sm" />
        </article>
      );
    case 'showcase':
      return (
        <article className="pwa-feed-card">
          <Badge tone="accent" icon="image">
            {t('community.postType.showcase')}
          </Badge>
          <Link href={showcasePath(locale, card.id, card.title)} className="pwa-feed-media" tabIndex={-1} aria-hidden="true">
            <MediaImage url={card.thumbnail} alt="" aspect="wide" placeholder={t('community.media.pending')} placeholderIcon="image" />
          </Link>
          <h3 className="pwa-text-label m-0">
            <Link href={showcasePath(locale, card.id, card.title)} className="pwa-card-link" dir="auto">
              {card.title}
            </Link>
          </h3>
          <p className="pwa-text-caption m-0">
            {[card.org?.name, card.system, card.at ? f.relative(card.at) : null].filter(Boolean).join(' · ')}
          </p>
        </article>
      );
    case 'update': {
      const org = orgs.get(card.orgId);
      const href = org ? orgPath(locale, org) : null;
      return (
        <article className="pwa-feed-card">
          <div className="pwa-badges">
            <Badge icon="bell">{t('community.feed.following')}</Badge>
            <Badge>{t(POST_TYPE[card.postType] ?? 'community.postType.educational_tip')}</Badge>
            {card.at ? <span className="pwa-text-caption">{f.relative(card.at)}</span> : null}
          </div>
          {org ? (
            <p className="pwa-text-label m-0">
              {href ? (
                <Link href={href} className="pwa-link">
                  <bdi>{org.name}</bdi>
                </Link>
              ) : (
                <bdi>{org.name}</bdi>
              )}
            </p>
          ) : null}
          {card.title ? (
            <h3 className="pwa-text-label m-0" dir="auto">
              {card.title}
            </h3>
          ) : null}
          <p className="pwa-text-body pwa-user-text m-0" dir="auto">
            {card.excerpt}
          </p>
        </article>
      );
    }
    default:
      return null;
  }
}

function FeedBlockView({
  block,
  orgs,
  carLabel,
  carId,
}: {
  block: FeedBlock;
  orgs: Map<string, PublicOrgCard>;
  carLabel: string | null;
  carId: string | null;
}) {
  const t = useT();
  const f = useFormat();
  const locale = useLocale();
  if (block.kind === 'card') return <FeedCard card={block.card} orgs={orgs} />;
  if (block.kind === 'recommended')
    return (
      <section className="pwa-feed-block" aria-label={t('community.feed.recommendedFor', { car: carLabel ?? '' })}>
        <h3 className="pwa-text-label m-0">
          {carLabel ? t('community.feed.recommendedFor', { car: carLabel }) : t('community.feed.recommended')}
        </h3>
        <ul className="pwa-plain-list pwa-feed-block-list">
          {block.cards.map((c) => (
            <li key={c.key}>
              <OrgCard
                org={c.org}
                locale={locale}
                t={t}
                f={f}
                headingLevel={4}
                detail={c.distanceKm !== null ? f.distance(c.distanceKm * 1000) : null}
              />
            </li>
          ))}
        </ul>
      </section>
    );
  if (block.kind === 'tips')
    return (
      <section className="pwa-feed-block" aria-label={t('community.feed.maintenanceFor', { car: carLabel ?? '' })}>
        <h3 className="pwa-text-label m-0">
          {carLabel ? t('community.feed.maintenanceFor', { car: carLabel }) : t('community.feed.maintenance')}
        </h3>
        <ul className="pwa-plain-list pwa-stack-sm">
          {block.cards.map((c) => (
            <li key={c.key} className="pwa-feed-tip">
              <span dir="auto">{c.title}</span>
              {c.status === 'overdue' ? <Badge tone="danger">{t('community.feed.overdue')}</Badge> : null}
            </li>
          ))}
        </ul>
        {carId ? (
          <Link href={`/${locale}/garage/${carId}/reminders`} className={buttonClass({ variant: 'secondary', size: 'sm' })}>
            <span className="cp-btn-label">{t('community.home.attention.openReminders')}</span>
          </Link>
        ) : null}
      </section>
    );
  return (
    <section className="pwa-feed-block" aria-label={t('community.feed.questions')}>
      <h3 className="pwa-text-label m-0">{t('community.feed.questions')}</h3>
      <ul className="pwa-plain-list pwa-stack-sm">
        {block.cards.map((c) => (
          <li key={c.key}>
            <Link href={questionPath(locale, c)} className="pwa-link" dir="auto">
              {c.title}
            </Link>
            <span className="pwa-text-caption"> · {t('community.answer.count', { count: c.answers })}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function useFollowedOrgs(enabled: boolean): Map<string, PublicOrgCard> {
  const follows = useApiQuery('follows.list', { query: { limit: 50 } }, { enabled, staleTime: 60_000 });
  return useMemo(() => new Map((follows.data?.items ?? []).map((x: Follow) => [x.organization.id, x.organization])), [follows.data]);
}

export function HomeScreen({ cityKey }: { cityKey: string }) {
  const t = useT();
  const locale = useLocale();
  const qna = useFlag('qna.enabled');
  const posts = useFlag('community.feed.enabled');
  const attention = useAttention();
  const { active } = useActiveVehicle();
  const carLabel = useVehicleLabel(active);
  const orgs = useFollowedOrgs(posts);
  const feed = useApiInfiniteQuery(
    'feed.discover',
    { body: { location: { mode: 'chosen_city', city_key: cityKey }, ...(active ? { vehicle_id: active.id } : {}), limit: FEED_PAGE } },
    { cursorIn: 'body', staleTime: 60_000 },
  );
  const items = (feed.data?.pages.flatMap((p) => p.items) ?? []).filter((i) => posts || i.kind !== 'followed_update');
  const blocks = feedBlocks(items).filter((b) => qna || b.kind !== 'questions');
  const thin = feed.isSuccess && items.length < THIN_FEED;

  return (
    <div className="pwa-home">
      <h1 className="sr-only">{t('shell.nav.home')}</h1>
      <HelpMeBar />
      {qna ? (
        <section className="pwa-card pwa-home-ask">
          <div>
            <h2 className="pwa-text-label m-0">{t('community.home.askTitle')}</h2>
            <p className="pwa-text-caption m-0">{t('community.home.askText')}</p>
          </div>
          <Link href={`/${locale}/questions/ask`} className={buttonClass({ variant: 'secondary' })}>
            <span className="cp-btn-label">{t('community.qa.ask')}</span>
          </Link>
        </section>
      ) : null}
      {attention.length ? (
        <section className="pwa-stack-sm" aria-labelledby="home-attention">
          <h2 id="home-attention" className="pwa-text-h2 m-0">
            {t('shell.attention.title')}
          </h2>
          <ul className="pwa-plain-list pwa-attention-list">
            {attention.map((c) => (
              <li key={c.key} className={`pwa-attention-card is-${c.tone}`}>
                <span dir="auto">{c.text}</span>
                <Link href={c.href} className={buttonClass({ variant: 'secondary', size: 'sm' })}>
                  <span className="cp-btn-label">{c.action}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <section className="pwa-stack" aria-labelledby="home-discover">
        <h2 id="home-discover" className="pwa-text-h2 m-0">
          {t('community.feed.discover')}
        </h2>
        <InfiniteList
          items={blocks}
          getKey={(b) => (b.kind === 'card' ? b.card.key : `${b.kind}:${b.cards[0]?.key ?? ''}`)}
          renderItem={(b) => <FeedBlockView block={b} orgs={orgs} carLabel={carLabel} carId={active?.id ?? null} />}
          status={feed.status}
          error={feed.error}
          hasNextPage={feed.hasNextPage}
          isFetchingNextPage={feed.isFetchingNextPage}
          fetchNextPage={() => feed.fetchNextPage()}
          refetch={() => feed.refetch()}
          label={t('community.feed.discover')}
          restoreKey="feed:discover"
          empty={<StateView kind="empty" t={t} title={t('community.feed.empty')} text={t('community.feed.emptyText')} compact />}
        />
        {thin ? (
          <section className="pwa-card pwa-stack-sm" aria-label={t('community.feed.thinTitle')}>
            <h3 className="pwa-text-label m-0">{t('community.feed.thinTitle')}</h3>
            <p className="pwa-text-caption m-0">{t('community.feed.thinText')}</p>
            <div className="pwa-chip-row">
              <Link href={`/${locale}/search`} className={buttonClass({ variant: 'secondary', size: 'sm' })}>
                <span className="cp-btn-label">{t('community.feed.findShops')}</span>
              </Link>
              {qna ? (
                <Link href={`/${locale}/questions`} className={buttonClass({ variant: 'secondary', size: 'sm' })}>
                  <span className="cp-btn-label">{t('community.feed.browseQuestions')}</span>
                </Link>
              ) : null}
            </div>
          </section>
        ) : null}
      </section>
    </div>
  );
}
