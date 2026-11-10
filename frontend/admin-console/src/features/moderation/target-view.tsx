'use client';
// The case target as the public sees it (AC8.T3, Docs/23 A-CON-02 centre panel, A-INV-01 "item as published"). The
// snapshot of admin.case_get is plain fields per target type (never contact data, DI-21); this panel shows them in
// words, the text in its own direction, the link to the public page where the public web app has one (GD-07: opened in
// a new tab, never read through the BFF), and a file through the media viewer: admin.media_download_url (PURP, AUD)
// gives a 5-minute display link, shown inline with a "CarPal internal" watermark and no download button (images; other
// files open in a new tab). Unknown target types show their fields as they come.
import Link from 'next/link';
import { useState } from 'react';
import { EntityChip, problemText } from '@/components/admin';
import { Badge } from '@/components/ds/badge';
import { Button } from '@/components/ds/button';
import type { AccessPurpose } from '@/lib/api/client';
import type { ApiProblem } from '@/lib/api/problem';
import { useApiClient } from '@/lib/api/query';
import { Bidi } from '@/lib/format/bidi';
import { useFormat } from '@/lib/format/client';
import { useLocale, useT } from '@/lib/i18n/client';
import { orgHref } from '../orgs/org-logic';
import { enumLabel, field, num, str, thingKey, type Target } from './case-logic';

/** Labels of target statuses the backend uses (anything else renders as "Unknown (…)"). */
export const TARGET_STATUSES = [
  'draft',
  'published',
  'active',
  'open',
  'hidden',
  'removed',
  'rejected',
  'pending_review',
  'pending_moderation',
  'pending_approval',
  'suspended',
  'deleted',
  'inactive',
  'merged',
  'closed',
] as const;
const MODERATION_STATUSES = ['pending', 'approved', 'rejected'] as const;
const CONSENT_STATUSES = ['not_required', 'requested', 'granted', 'withdrawn', 'missing'] as const;
const SCAN_STATUSES = ['pending', 'clean', 'infected', 'failed'] as const;

/** The public page of a target in the public web app, when it has one (GD-07: a new tab, never through the BFF). */
export function publicHref(t: Target, base: string | undefined, locale: string): string | null {
  if (!base) return null;
  const root = `${base.replace(/\/+$/, '')}/${locale}`;
  if (t.type === 'post' && field(t, 'status') === 'published') return `${root}/post/${t.id}`;
  if (t.type === 'question' && field(t, 'status') === 'open') return `${root}/questions/${t.id}`;
  if (t.type === 'organization' && field(t, 'status') === 'active') {
    const slug = field(t, 'slug');
    const kind = field(t, 'organization_type');
    if (slug && kind === 'provider') return `${root}/shop/${slug}`;
    if (slug && kind === 'vendor') return `${root}/parts-seller/${slug}`;
  }
  return null;
}

function Fact({ label, children, testId }: { label: string; children: React.ReactNode; testId?: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd data-testid={testId}>{children}</dd>
    </div>
  );
}

function Quote({ title, body }: { title?: string | null; body?: string | null }) {
  if (!title && !body) return null;
  return (
    <blockquote className="adm-quote">
      {title ? (
        <p className="adm-quote-title">
          <Bidi>{title}</Bidi>
        </p>
      ) : null}
      {body ? (
        <p>
          <Bidi>{body}</Bidi>
        </p>
      ) : null}
    </blockquote>
  );
}

/** Names of a listing in each language it has (inventory name_translations). */
function translations(v: unknown): [string, string][] {
  if (!v || typeof v !== 'object') return [];
  return Object.entries(v as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string');
}

export interface TargetBlockProps {
  target: Target;
  /** The case's purpose: the media link is read for it. */
  purpose: AccessPurpose;
  publicWeb?: string;
}

/** The target of a case: what it is, its state, its text, its owner and its public page. */
export function TargetBlock({ target: tg, purpose, publicWeb }: TargetBlockProps) {
  const t = useT();
  const f = useFormat();
  const locale = useLocale();
  const thing = t(thingKey(tg.type));
  const status = field(tg, 'status');
  const moderation = field(tg, 'moderation_status');
  const href = publicHref(tg, publicWeb, locale);
  // AC9: an organization or location case opens the organization page for the case's purpose (Locations tab to
  // correct a pin, admin.location_correct).
  const orgPage =
    tg.type === 'organization'
      ? orgHref(tg.id, purpose)
      : tg.type === 'organization_location' && field(tg, 'organization_id')
        ? orgHref(field(tg, 'organization_id')!, purpose, 'locations')
        : null;
  const statusLabel = (v: string | null) => enumLabel(TARGET_STATUSES, 'admin.moderation.status', v, t);
  const org = (key: string) => {
    const id = field(tg, key);
    return id ? <EntityChip type="organization" id={id} /> : '—';
  };

  const facts = (): React.ReactNode => {
    switch (tg.type) {
      case 'post':
      case 'comment':
      case 'question':
      case 'answer':
        return (
          <>
            {field(tg, 'post_type') ? (
              <Fact label={t('admin.moderation.fact.postType')}>
                <Bidi ltr>{field(tg, 'post_type')}</Bidi>
              </Fact>
            ) : null}
          </>
        );
      case 'review_response':
        return (
          <>
            <Fact label={t('admin.moderation.fact.organization')}>{org('organization_id')}</Fact>
            {field(tg, 'review_id') ? (
              <Fact label={t('admin.moderation.fact.review')}>
                <EntityChip type="review" id={field(tg, 'review_id')!} />
              </Fact>
            ) : null}
          </>
        );
      case 'portfolio_item': {
        const consent = field(tg, 'customer_consent_status') ?? 'missing';
        return (
          <>
            <Fact label={t('admin.moderation.fact.organization')}>{org('provider_organization_id')}</Fact>
            <Fact label={t('admin.moderation.fact.consent')} testId="consent">
              <Badge tone={consent === 'granted' || consent === 'not_required' ? 'success' : 'danger'}>
                {enumLabel(CONSENT_STATUSES, 'admin.moderation.consent', consent, t)}
              </Badge>
            </Fact>
          </>
        );
      }
      case 'media_asset':
        return (
          <>
            <Fact label={t('admin.moderation.fact.mediaType')}>
              {enumLabel(['image', 'video', 'document'], 'admin.reviews.mediaType', field(tg, 'media_type'), t)}
            </Fact>
            <Fact label={t('admin.moderation.fact.purpose')}>
              <Bidi ltr>{field(tg, 'purpose') ?? '—'}</Bidi>
            </Fact>
            <Fact label={t('admin.moderation.fact.privacy')}>
              <Bidi ltr>{field(tg, 'privacy_level') ?? '—'}</Bidi>
            </Fact>
            <Fact label={t('admin.moderation.fact.scan')}>
              {enumLabel(SCAN_STATUSES, 'admin.moderation.scan', field(tg, 'scan_status'), t)}
            </Fact>
            {field(tg, 'owner_type') === 'organization' ? (
              <Fact label={t('admin.moderation.fact.organization')}>{org('owner_id')}</Fact>
            ) : null}
          </>
        );
      case 'inventory_item':
        return (
          <>
            <Fact label={t('admin.moderation.fact.vendor')}>{org('vendor_organization_id')}</Fact>
            <Fact label={t('admin.moderation.fact.sku')}>
              <Bidi ltr>{field(tg, 'sku') ?? '—'}</Bidi>
            </Fact>
            <Fact label={t('admin.moderation.fact.visibility')}>
              <Bidi ltr>{field(tg, 'visibility') ?? '—'}</Bidi>
            </Fact>
          </>
        );
      case 'inventory_fitment': {
        const from = num(tg.data.year_start);
        const to = num(tg.data.year_end);
        return (
          <>
            {field(tg, 'inventory_item_id') ? (
              <Fact label={t('admin.moderation.fact.listing')}>
                <EntityChip type="inventory_item" id={field(tg, 'inventory_item_id')!} />
              </Fact>
            ) : null}
            <Fact label={t('admin.moderation.fact.years')}>
              {from != null || to != null ? `${from != null ? f.number(from) : '…'}–${to != null ? f.number(to) : '…'}` : '—'}
            </Fact>
            <Fact label={t('admin.moderation.fact.source')}>
              <Bidi ltr>{field(tg, 'source') ?? '—'}</Bidi>
            </Fact>
          </>
        );
      }
      case 'organization': {
        const score = num(tg.data.trust_score);
        return (
          <>
            <Fact label={t('admin.moderation.fact.orgType')}>
              <Bidi ltr>{field(tg, 'organization_type') ?? '—'}</Bidi>
            </Fact>
            <Fact label={t('admin.moderation.fact.verification')}>
              <Bidi ltr>{field(tg, 'verification_status') ?? '—'}</Bidi>
            </Fact>
            <Fact label={t('admin.moderation.fact.trustScore')}>{score != null ? f.number(score) : '—'}</Fact>
          </>
        );
      }
      case 'organization_location': {
        const p = tg.data.public_point as { lat?: unknown; lng?: unknown } | undefined;
        const lat = num(p?.lat);
        const lng = num(p?.lng);
        return (
          <>
            <Fact label={t('admin.moderation.fact.organization')}>{org('organization_id')}</Fact>
            <Fact label={t('admin.moderation.fact.place')}>
              <Bidi>{[field(tg, 'city'), field(tg, 'region'), field(tg, 'country')].filter(Boolean).join(', ') || '—'}</Bidi>
            </Fact>
            <Fact label={t('admin.moderation.fact.point')}>
              <Bidi ltr>{lat != null && lng != null ? `${lat.toFixed(5)}, ${lng.toFixed(5)}` : '—'}</Bidi>
            </Fact>
            <Fact label={t('admin.moderation.fact.locationCheck')}>
              <Bidi ltr>{field(tg, 'location_check_status') ?? '—'}</Bidi>
            </Fact>
          </>
        );
      }
      case 'user':
        return (
          <Fact label={t('admin.moderation.fact.trustedUser')}>
            {tg.data.trusted_user === true ? t('admin.reviews.yes') : t('admin.reviews.no')}
          </Fact>
        );
      case 'ai_output':
        return (
          <>
            <Fact label={t('admin.moderation.fact.insightType')}>
              <Bidi ltr>{field(tg, 'insight_type') ?? '—'}</Bidi>
            </Fact>
            <Fact label={t('admin.moderation.fact.visibility')}>
              <Bidi ltr>{field(tg, 'visibility') ?? '—'}</Bidi>
            </Fact>
            <Fact label={t('admin.kit.ai.model')}>
              <Bidi ltr>{field(tg, 'model_version') ?? '—'}</Bidi>
            </Fact>
          </>
        );
      default:
        return Object.entries(tg.data)
          .filter(([k, v]) => !['type', 'id', 'status', 'available'].includes(k) && (typeof v === 'string' || typeof v === 'number'))
          .slice(0, 12)
          .map(([k, v]) => (
            <Fact key={k} label={k}>
              <Bidi ltr>{String(v)}</Bidi>
            </Fact>
          ));
    }
  };

  const text = (): React.ReactNode => {
    switch (tg.type) {
      case 'review_response':
        return <Quote body={field(tg, 'response_text')} />;
      case 'portfolio_item':
        return <Quote title={field(tg, 'title')} body={field(tg, 'description') ?? field(tg, 'caption')} />;
      case 'inventory_item':
        return (
          <ul className="adm-inline-list" aria-label={t('admin.moderation.fact.names')}>
            {translations(tg.data.name_translations).map(([lang, name]) => (
              <li key={lang} lang={lang}>
                <Bidi>{name}</Bidi>
              </li>
            ))}
          </ul>
        );
      case 'user':
        return field(tg, 'display_name') ? (
          <p className="adm-review-head">
            <Bidi>{field(tg, 'display_name')}</Bidi>
          </p>
        ) : null;
      case 'organization':
        return field(tg, 'name') ? (
          <p className="adm-review-head">
            <Bidi>{field(tg, 'name')}</Bidi>
          </p>
        ) : null;
      case 'ai_output':
        return <Quote body={field(tg, 'summary')} />;
      default:
        return <Quote title={field(tg, 'title')} body={str(tg.data.body)} />;
    }
  };

  return (
    <section
      className="adm-panel"
      aria-label={t('admin.moderation.targetLabel', { thing })}
      data-testid="case-target"
      data-target={tg.type}
    >
      <p className="adm-badges">
        <Badge>{thing}</Badge>
        {status ? (
          <Badge
            tone={
              status === 'published' || status === 'active' || status === 'open'
                ? 'success'
                : status === 'removed' || status === 'rejected' || status === 'hidden' || status === 'suspended'
                  ? 'danger'
                  : 'signal'
            }
          >
            <span data-testid="target-status">{statusLabel(status)}</span>
          </Badge>
        ) : null}
        {moderation ? (
          <Badge tone="accent">
            {t('admin.moderation.moderationStatus', {
              status: enumLabel(MODERATION_STATUSES, 'admin.moderation.moderation', moderation, t),
            })}
          </Badge>
        ) : null}
        <EntityChip type={tg.type} id={tg.id} />
      </p>
      {text()}
      {tg.type === 'media_asset' ? <MediaViewer mediaId={tg.id} purpose={purpose} mediaType={field(tg, 'media_type')} /> : null}
      <dl className="adm-facts">
        {facts()}
        {field(tg, 'created_at') ? (
          <Fact label={t('admin.moderation.fact.created')}>
            <time dateTime={field(tg, 'created_at')!}>{f.date(field(tg, 'created_at')!, 'dateTime')}</time>
          </Fact>
        ) : null}
      </dl>
      {href ? (
        <p>
          <a href={href} target="_blank" rel="noopener noreferrer" data-testid="public-link">
            {t('admin.moderation.publicPage')}
          </a>
        </p>
      ) : null}
      {orgPage ? (
        <p>
          <Link href={orgPage} data-testid="org-link">
            {tg.type === 'organization_location' ? t('admin.moderation.orgLocations') : t('admin.moderation.orgPage')}
          </Link>
        </p>
      ) : null}
    </section>
  );
}

type MediaState = { s: 'idle' } | { s: 'busy' } | { s: 'ready'; url: string; expires: string } | { s: 'failed'; p: ApiProblem };

/** A file of a case, shown for the case's purpose: inline with a watermark (images) or as a short-lived link. */
export function MediaViewer({ mediaId, purpose, mediaType }: { mediaId: string; purpose: AccessPurpose; mediaType: string | null }) {
  const t = useT();
  const f = useFormat();
  const api = useApiClient();
  const [state, setState] = useState<MediaState>({ s: 'idle' });
  const show = async () => {
    setState({ s: 'busy' });
    try {
      const r = await api.api('admin.media_download_url', { path: { media_id: mediaId }, body: { variant: 'display' }, purpose });
      setState({ s: 'ready', url: r.url, expires: r.expires_at });
    } catch (err) {
      setState({ s: 'failed', p: err as ApiProblem });
    }
  };
  if (state.s === 'ready')
    return mediaType === 'image' ? (
      <figure className="adm-media" data-testid="media-viewer" onContextMenu={(e) => e.preventDefault()}>
        {/* A signed display copy from the storage host (CSP img-src); next/image would proxy it through the console. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={state.url} alt={t('admin.moderation.media.alt')} draggable={false} referrerPolicy="no-referrer" />
        <span className="adm-media-mark" aria-hidden="true">
          CarPal internal
        </span>
        <figcaption className="adm-muted">{t('admin.moderation.media.internal', { when: f.date(state.expires, 'time') })}</figcaption>
      </figure>
    ) : (
      <p data-testid="media-viewer">
        <a href={state.url} target="_blank" rel="noopener noreferrer">
          {t('admin.reviews.openFile')}
        </a>{' '}
        <span className="adm-muted">{t('admin.reviews.linkExpires', { when: f.date(state.expires, 'time') })}</span>
      </p>
    );
  return (
    <div>
      <Button size="sm" variant="secondary" icon="image" loading={state.s === 'busy'} onClick={() => void show()}>
        {t('admin.moderation.media.show')}
      </Button>
      {state.s === 'failed' ? (
        <p className="adm-error" role="alert">
          {problemText(state.p, t)}
        </p>
      ) : null}
    </div>
  );
}
