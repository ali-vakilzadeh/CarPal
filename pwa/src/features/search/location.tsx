'use client';
// The location chip and the location consent (P6.T6, Docs/21 C-SEARCH-01 "location chip", 40 LocationInput):
//   - a pilot city (chosen_city) works for everybody; "Near me" (user_position) is for signed-in users only (BA-16) —
//     guests are asked to pick a city or sign in;
//   - the browser position is asked for only after the user taps "Near me", and only with an active location_usage
//     consent (consents.list / consents.grant; a 403 LOCATION_CONSENT_REQUIRED from the API opens the same step);
//   - default precision (no high-accuracy request), rounded to ~1 m; the point travels in request bodies only, never in
//     a URL (TR-7), and is kept for re-running the search in this tab's sessionStorage only.
import type { LocationInput, RegionConfig } from '@carpal/api-contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/ds/button';
import { cx } from '@/components/ds/cx';
import { Icon } from '@/components/ds/icon';
import { Dialog } from '@/components/shell/dialog';
import { useLoginHref } from '@/components/shell/use-login-href';
import { roundPoint } from '@/features/map';
import { apiQueryKey, useApiClient, useApiQuery } from '@/lib/api/query';
import { useSession } from '@/lib/api/session';
import { useT } from '@/lib/i18n/client';

export const GEO_TIMEOUT_MS = 15_000;
const CONSENT_QUERY = { query: { consent_type: 'location_usage', active: true, limit: 1 } } as const;

/** The location_usage consent of a signed-in user, and how to grant it. */
export function useLocationConsent(policyVersion: string) {
  const session = useSession();
  const signedIn = session.data?.signed_in === true;
  const api = useApiClient();
  const queryClient = useQueryClient();
  const list = useApiQuery('consents.list', CONSENT_QUERY, { enabled: signedIn, staleTime: 5 * 60_000 });
  const granted = (list.data?.items.length ?? 0) > 0;
  const grant = async () => {
    await api.api('consents.grant', {
      // No grantee: search.run checks the consent without one, which matches only grantee-less records (DI-59).
      body: { consent_type: 'location_usage', policy_version: policyVersion },
    });
    await queryClient.invalidateQueries({ queryKey: apiQueryKey('consents.list', CONSENT_QUERY) });
  };
  return { signedIn, granted, known: !signedIn || list.isSuccess, grant };
}

export type PositionError = 'denied' | 'unavailable' | 'unsupported';

/** One browser position at default precision (call only from a user action). */
export function currentPosition(geo: Geolocation | undefined = globalThis.navigator?.geolocation): Promise<LocationInput> {
  return new Promise((resolve, reject) => {
    if (!geo) return reject('unsupported' satisfies PositionError);
    geo.getCurrentPosition(
      (p) =>
        resolve({
          mode: 'user_position',
          point: roundPoint({ lat: p.coords.latitude, lng: p.coords.longitude }, 5),
          accuracy_m: Math.max(0, Math.min(100_000, Math.round(p.coords.accuracy))),
        }),
      (e) => reject((e.code === e.PERMISSION_DENIED ? 'denied' : 'unavailable') satisfies PositionError),
      { enableHighAccuracy: false, maximumAge: 600_000, timeout: GEO_TIMEOUT_MS },
    );
  });
}

/** The chip's text: the city, "Near me" or "This map area". */
export function locationLabel(loc: LocationInput, region: Pick<RegionConfig, 'cities'>, t: ReturnType<typeof useT>): string {
  if (loc.mode === 'chosen_city') return region.cities.find((c) => c.city_key === loc.city_key)?.label.text ?? loc.city_key;
  if (loc.mode === 'user_position') return t('search.location.nearMe');
  return t('search.location.mapArea');
}

export function LocationChip({
  value,
  region,
  policyVersion,
  onChange,
  consentAsked,
  onConsentClosed,
}: {
  value: LocationInput;
  region: Pick<RegionConfig, 'cities'>;
  policyVersion: string;
  onChange: (loc: LocationInput) => void;
  /** The API answered 403 LOCATION_CONSENT_REQUIRED: open on the consent step. */
  consentAsked?: boolean;
  onConsentClosed?: () => void;
}) {
  const t = useT();
  const loginHref = useLoginHref();
  const consent = useLocationConsent(policyVersion);
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<'choose' | 'consent'>('choose');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<PositionError | 'consent' | null>(null);
  const shown = open || consentAsked === true;
  const showConsent = step === 'consent' || consentAsked === true;

  const close = () => {
    setOpen(false);
    setStep('choose');
    setError(null);
    onConsentClosed?.();
  };

  const locate = async () => {
    setBusy(true);
    setError(null);
    try {
      const loc = await currentPosition();
      onChange(loc);
      close();
    } catch (err) {
      setError(typeof err === 'string' ? (err as PositionError) : 'unavailable');
    } finally {
      setBusy(false);
    }
  };

  const nearMe = () => {
    if (!consent.granted) setStep('consent');
    else void locate();
  };

  const allow = async () => {
    setBusy(true);
    setError(null);
    try {
      await consent.grant();
    } catch {
      setBusy(false);
      setError('consent');
      return;
    }
    setStep('choose');
    await locate();
  };

  return (
    <>
      <button
        type="button"
        className="cp-chip pwa-location-chip"
        aria-haspopup="dialog"
        aria-label={t('search.location.change', { place: locationLabel(value, region, t) })}
        onClick={() => setOpen(true)}
      >
        <Icon name={value.mode === 'user_position' ? 'locate' : value.mode === 'map_center' ? 'map' : 'pin'} size={18} />
        <span>{locationLabel(value, region, t)}</span>
        <Icon name="down" size={18} />
      </button>
      <Dialog
        open={shown}
        onClose={close}
        title={showConsent ? t('search.location.consentTitle') : t('search.location.title')}
        variant="sheet"
        name="location"
      >
        {showConsent ? (
          <div className="pwa-stack">
            <p className="pwa-text-body">{t('search.location.consentText')}</p>
            <p className="pwa-text-caption">{t('search.location.consentPrivacy')}</p>
            {error ? <p className="pwa-text-caption pwa-error-text">{t(`search.location.error.${error}`)}</p> : null}
            <div className="pwa-inline-actions">
              <Button variant="primary" icon="locate" loading={busy} onClick={() => void allow()}>
                {t('search.location.allow')}
              </Button>
              <Button onClick={close}>{t('search.location.notNow')}</Button>
            </div>
          </div>
        ) : (
          <div className="pwa-stack">
            {consent.signedIn ? (
              <Button icon="locate" loading={busy} onClick={nearMe} aria-pressed={value.mode === 'user_position'}>
                {t('search.location.nearMe')}
              </Button>
            ) : (
              <div className="pwa-explain">
                <p className="pwa-text-label m-0">{t('search.location.guestTitle')}</p>
                <p className="pwa-text-caption">{t('search.location.guestText')}</p>
                <a className="pwa-link" href={loginHref}>
                  {t('shell.header.logIn')}
                </a>
              </div>
            )}
            {error ? (
              <p className="pwa-text-caption pwa-error-text" role="alert">
                {t(`search.location.error.${error}`)}
              </p>
            ) : null}
            <ul className="pwa-option-list" role="radiogroup" aria-label={t('search.location.cities')}>
              {value.mode === 'map_center' ? (
                <li>
                  <button type="button" role="radio" aria-checked className="pwa-option is-selected" onClick={close}>
                    <Icon name="map" size={20} />
                    <span className="pwa-option-title">{t('search.location.mapArea')}</span>
                    <Icon name="check" size={20} />
                  </button>
                </li>
              ) : null}
              {region.cities.map((c) => {
                const selected = value.mode === 'chosen_city' && value.city_key === c.city_key;
                return (
                  <li key={c.city_key}>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      className={cx('pwa-option', selected && 'is-selected')}
                      onClick={() => {
                        onChange({ mode: 'chosen_city', city_key: c.city_key });
                        close();
                      }}
                    >
                      <Icon name="pin" size={20} />
                      <span className="pwa-option-title">{c.label.text}</span>
                      {selected ? <Icon name="check" size={20} /> : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </Dialog>
    </>
  );
}
