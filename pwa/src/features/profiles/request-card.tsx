'use client';
// The Request appointment card (Docs/22 W-PUB-02 right rail; C-PROV-01 sticky bar): the active vehicle chip (or
// "Select your car"), "Fit for your car" from the public capabilities, the next open slots of the primary location
// (public.availability; none when the shop has no availability rules → "Request anyway", BA-19), the primary
// Request appointment, and Call, which loads the number on click (it is not in the page HTML; open point 7) and
// counts as a selected search result when the visitor came from one (DI-10). The request step is W-HELP-01
// (/<locale>/help?provider…, P10); guests go through the auth-intent modal first and land back here.
import type { PublicCapability, Slot } from '@carpal/api-contracts';
import { useState } from 'react';
import { Badge } from '@/components/ds/badge';
import { Button, buttonClass } from '@/components/ds/button';
import { Icon } from '@/components/ds/icon';
import { useGatedAction, useIntentHandler } from '@/components/shell/auth-intent';
import { useLoginHref } from '@/components/shell/use-login-href';
import { VehicleChip } from '@/components/shell/vehicle-context';
import { useApiClient } from '@/lib/api/query';
import { useSession } from '@/lib/api/session';
import { goTo } from '@/lib/browser-nav';
import { useFormat } from '@/lib/format/client';
import { useLocale, useT } from '@/lib/i18n/client';
import { reportSearchSelection } from './search-origin';
import { useCarNames } from './use-car';
import { bestFit, slotDays } from './view-model';

const MAX_SLOTS = 6;

/**
 * The request step (P10, W-HELP-01 /<locale>/help?…): ids, the shop's slug (the request step reads its public profile by
 * slug), an ISO slot time and where the request starts (Docs/55 §4.9 request source) — never text (GD-14).
 */
export function requestHref(
  locale: string,
  orgId: string,
  locationId: string | null,
  slot?: string,
  o: { slug?: string | null; via?: 'profile' | 'search' | 'saved' } = {},
): string {
  const q = new URLSearchParams({ provider: orgId });
  if (locationId) q.set('location', locationId);
  if (slot) q.set('slot', slot);
  if (o.slug) q.set('shop', o.slug);
  if (o.via) q.set('via', o.via);
  return `/${locale}/help?${q.toString()}`;
}

export function CallButton({ slug, orgId }: { slug: string; orgId: string }) {
  const t = useT();
  const api = useApiClient();
  const [state, setState] = useState<{ phone: string | null; whatsapp: string | null } | 'loading' | 'failed' | null>(null);
  const reveal = async () => {
    setState('loading');
    try {
      const p = await api.api('public.org_get', { path: { slug } });
      const pick = (type: 'phone' | 'whatsapp') =>
        p.contact_channels.find((c) => c.type === type && c.preferred)?.value ??
        p.contact_channels.find((c) => c.type === type)?.value ??
        null;
      setState({ phone: pick('phone'), whatsapp: pick('whatsapp') });
      reportSearchSelection(api, orgId);
    } catch {
      setState('failed');
    }
  };
  if (state === null || state === 'loading' || state === 'failed')
    return (
      <div className="pwa-stack-xs">
        <Button icon="phone" block loading={state === 'loading'} onClick={() => void reveal()}>
          {t('profiles.request.call')}
        </Button>
        {state === 'failed' ? (
          <p className="pwa-text-caption" role="alert">
            {t('profiles.request.revealFailed')}
          </p>
        ) : null}
      </div>
    );
  if (!state.phone && !state.whatsapp) return <p className="pwa-text-caption">{t('profiles.request.noPhone')}</p>;
  return (
    <div className="pwa-stack-xs" aria-live="polite">
      {state.phone ? (
        <a className={buttonClass({ block: true })} href={`tel:${state.phone.replace(/[^\d+]/g, '')}`}>
          <Icon name="phone" size={20} />
          <span className="cp-btn-label">
            {t('profiles.request.call')} · <bdi dir="ltr">{state.phone}</bdi>
          </span>
        </a>
      ) : null}
      {state.whatsapp ? (
        <a
          className={buttonClass({ block: true, variant: 'ghost' })}
          href={`https://wa.me/${state.whatsapp.replace(/[^\d]/g, '')}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          <Icon name="chat" size={20} />
          <span className="cp-btn-label">
            {t('profiles.request.whatsapp')} · <bdi dir="ltr">{state.whatsapp}</bdi>
          </span>
        </a>
      ) : null}
    </div>
  );
}

export function RequestCard({
  orgId,
  slug,
  name,
  rating,
  locationId,
  capabilities,
  slots,
  todayHours,
  heading = 'h2',
  idSuffix = 'card',
}: {
  orgId: string;
  slug: string;
  name: string;
  rating: string | null;
  locationId: string | null;
  capabilities: readonly PublicCapability[];
  slots: readonly Slot[];
  /** "Today: 08:00–18:00" / "Closed today", rendered on the server. */
  todayHours: string | null;
  heading?: 'h2' | 'h3';
  /** Keeps ids unique when the card appears twice (inline on small screens, in the rail on wide ones). */
  idSuffix?: string;
}) {
  const t = useT();
  const f = useFormat();
  const locale = useLocale();
  const gate = useGatedAction();
  const session = useSession();
  const loginHref = useLoginHref();
  const { car } = useCarNames();
  const fit = car ? bestFit(capabilities, car) : null;
  const H = heading;

  const request = (slot?: string) => {
    const href = requestHref(locale, orgId, locationId, slot, { slug, via: 'profile' });
    gate({
      type: 'request',
      target: orgId,
      draft: slot ? { slot } : undefined,
      title: t('profiles.intent.request', { name }),
      run: () => goTo(href),
    });
  };
  useIntentHandler<{ slot?: string }>('request', (intent) => {
    if (intent.target !== orgId) return;
    goTo(requestHref(locale, orgId, locationId, intent.draft?.slot, { slug, via: 'profile' }));
  });

  return (
    <section className="pwa-request-card" aria-labelledby={`request-${orgId}-${idSuffix}`}>
      <H id={`request-${orgId}-${idSuffix}`} className="pwa-text-label m-0">
        {t('profiles.request.title')}
      </H>
      {session.data?.signed_in ? (
        <VehicleChip />
      ) : (
        <a href={loginHref} className="cp-chip pwa-vehicle-chip">
          <Icon name="car" size={18} />
          <span>{t('profiles.request.selectCar')}</span>
        </a>
      )}
      {fit && car ? (
        <div className="pwa-fit">
          <span className="pwa-text-caption">{t('profiles.request.fit')}</span>
          <span className="pwa-text-label">
            {t('profiles.request.fitLine', {
              vehicle: car.label,
              system: fit.service_system.text,
              level: t(`profiles.services.level.${fit.confidence_level}`),
            })}
          </span>
          <span className="pwa-text-caption">
            {t('profiles.services.evidence', { count: fit.evidence_count })}
            {rating ? ` · ★ ${f.number(Number(rating), { minimumFractionDigits: 1, maximumFractionDigits: 1 })}` : ''}
          </span>
        </div>
      ) : null}
      {slots.length ? (
        <div className="pwa-stack-xs">
          <span className="pwa-text-caption">{t('profiles.request.slots')}</span>
          <div className="pwa-stack-sm" role="group" aria-label={t('profiles.request.slotsLabel')}>
            {slotDays(slots.slice(0, MAX_SLOTS), (iso) => f.date(iso, 'weekdayDate')).map((day) => (
              <div key={day.label} className="pwa-stack-xs">
                <span className="pwa-text-label">{day.label}</span>
                <ul className="pwa-plain-list pwa-slots">
                  {day.slots.map((s) => (
                    <li key={`${s.location_id}-${s.start_at}`}>
                      <button
                        type="button"
                        className="cp-chip pwa-slot"
                        aria-label={`${day.label} ${f.date(s.start_at, 'time')}`}
                        onClick={() => request(s.start_at)}
                      >
                        {f.date(s.start_at, 'time')}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <p className="pwa-text-caption">
          <Icon name="calendar" size={16} /> {t('profiles.request.noSlots')}
        </p>
      )}
      <Button variant="primary" block onClick={() => request()}>
        {slots.length ? t('profiles.request.request') : t('profiles.request.requestAnyway')}
      </Button>
      <CallButton slug={slug} orgId={orgId} />
      {todayHours ? (
        <p className="pwa-text-caption">
          <Badge icon="clock">{todayHours}</Badge>
        </p>
      ) : null}
    </section>
  );
}

/** "Request similar service" (Docs/22 W-PUB-05): the request step with this provider (P10), through sign-in for guests. */
export function RequestSimilarButton({ orgId, name, slug = null }: { orgId: string; name: string; slug?: string | null }) {
  const t = useT();
  const locale = useLocale();
  const gate = useGatedAction();
  const href = requestHref(locale, orgId, null, undefined, { slug, via: 'profile' });
  useIntentHandler('request.similar', (intent) => {
    if (intent.target === orgId) goTo(href);
  });
  return (
    <Button
      variant="primary"
      block
      onClick={() => gate({ type: 'request.similar', target: orgId, title: t('profiles.intent.request', { name }), run: () => goTo(href) })}
    >
      {t('profiles.showcase.request')}
    </Button>
  );
}
