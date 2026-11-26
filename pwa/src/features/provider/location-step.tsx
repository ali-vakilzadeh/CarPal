'use client';
// PW-ONB-02 "Where is the workshop" (provider plan PW2.T3): the exact point is the map's centre under a fixed pin, or
// the phone's position ("Use my location", then geo.reverse fills the empty address fields). The typed address is
// required (street and city); org.location_pin_check compares it with the pin and a far-apart result warns without
// blocking (Docs/56 §2.11). The owner chooses whether customers see the exact address or only the area; a mobile
// mechanic gives a radius instead (the circle replaces the street address). Loaded only on this step (React.lazy), so
// the map code reaches no other Workshop page (PRV-GD-04). Without WebGL the map is skipped: the phone's position is
// the only way to place the pin here; without that either, the Web UI sets the location.
import type { GeocodeCandidate, Location, PinCheck } from '@carpal/api-contracts';
import { useState } from 'react';
import { Banner } from '@/components/ds/banner';
import { Button } from '@/components/ds/button';
import { cx } from '@/components/ds/cx';
import { Icon } from '@/components/ds/icon';
import { TextField } from '@/components/ds/text-field';
import { useToast } from '@/components/shell/toast';
import { MapCanvas, roundPoint, type Point } from '@/features/map';
import { ApiProblem } from '@/lib/api/problem';
import { useApiClient } from '@/lib/api/query';
import { usePwaConfig, useRegion } from '@/lib/config/client';
import { useFormat } from '@/lib/format/client';
import { useLocale, useT } from '@/lib/i18n/client';
import { portalHref } from './model';
import { DEFAULT_RADIUS_KM, ifMatchOf, regionCountry } from './onboarding-model';
import type { SetupData } from './onboarding';

const PIN_ZOOM = 17;

type Geo = 'idle' | 'asking' | 'denied' | 'unsupported';

interface Address {
  line1: string;
  city: string;
  region: string;
  postal: string;
  country: string;
}

const fromLocation = (l: Location | null, country: string): Address => ({
  line1: l?.address_line_1 ?? '',
  city: l?.city ?? '',
  region: l?.region ?? '',
  postal: l?.postal_code ?? '',
  country: l?.country ?? country,
});

/** Empty fields take the candidate's values; what the owner typed stays. */
export function fillAddress(a: Address, c: GeocodeCandidate): Address {
  return {
    line1: a.line1 || c.address_line_1,
    city: a.city || c.city,
    region: a.region || (c.region ?? ''),
    postal: a.postal || (c.postal_code ?? ''),
    country: c.country || a.country,
  };
}

export default function LocationStep({
  orgId,
  data,
  styleUrl,
  onDone,
}: {
  orgId: string;
  data: SetupData;
  styleUrl: string | null;
  onDone: (p: Partial<SetupData>) => Promise<void>;
}) {
  const t = useT();
  const f = useFormat();
  const api = useApiClient();
  const toast = useToast();
  const locale = useLocale();
  const region = useRegion();
  const { regionTimeZone, portalUrl } = usePwaConfig();
  const existing = data.location;
  const mobile = data.profile?.provider_type === 'mobile_mechanic';
  const startPin = existing?.latitude != null && existing.longitude != null ? { lat: existing.latitude, lng: existing.longitude } : null;
  const [pin, setPin] = useState<Point | null>(startPin);
  const [focus, setFocus] = useState<{ key: string; center: Point; zoom: number } | null>(null);
  const [address, setAddress] = useState<Address>(() => fromLocation(existing, regionCountry(region.region_key)));
  const [exact, setExact] = useState(existing ? existing.public_address_visibility === 'exact' : !mobile);
  const [radius, setRadius] = useState(String(existing?.service_radius_km ?? DEFAULT_RADIUS_KM));
  const [mapFailed, setMapFailed] = useState(false);
  const [geo, setGeo] = useState<Geo>(() => (typeof navigator !== 'undefined' && 'geolocation' in navigator ? 'idle' : 'unsupported'));
  const [far, setFar] = useState<PinCheck | null>(null);
  const [missing, setMissing] = useState<{ line1?: boolean; city?: boolean; pin?: boolean; radius?: boolean }>({});
  const [saving, setSaving] = useState(false);
  const [filling, setFilling] = useState(false);

  const set = (patch: Partial<Address>) => {
    setAddress((a) => ({ ...a, ...patch }));
    setFar(null);
  };

  const reverse = async (p: Point) => {
    setFilling(true);
    try {
      const r = await api.api('geo.reverse', { path: { org_id: orgId }, body: { point: roundPoint(p) } });
      if (r.candidate) setAddress((a) => fillAddress(a, r.candidate!));
    } catch (err) {
      console.warn('reverse geocoding failed', err);
    } finally {
      setFilling(false);
    }
  };

  const locate = () => {
    setGeo('asking');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const p = roundPoint({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setGeo('idle');
        setPin(p);
        setFar(null);
        setFocus({ key: `${p.lat},${p.lng}`, center: p, zoom: PIN_ZOOM });
        void reverse(p);
      },
      (err) => setGeo(err.code === err.PERMISSION_DENIED ? 'denied' : 'idle'),
      { enableHighAccuracy: true, maximumAge: 60_000, timeout: 15_000 },
    );
  };

  const radiusKm = Number(radius);
  const submit = async () => {
    const miss = {
      line1: !address.line1.trim(),
      city: !address.city.trim(),
      pin: !pin,
      radius: mobile && !(radiusKm > 0 && radiusKm <= 200),
    };
    setMissing(miss);
    if (Object.values(miss).some(Boolean) || !pin) return;
    setSaving(true);
    try {
      const where = { address_line_1: address.line1.trim(), city: address.city.trim(), country: address.country };
      // The pin check warns once; the owner then moves the pin or saves anyway.
      if (!far) {
        const check = await api
          .api('org.location_pin_check', {
            path: { org_id: orgId },
            body: { ...where, ...(address.postal.trim() ? { postal_code: address.postal.trim() } : {}), pin },
          })
          .catch(() => null);
        if (check?.location_check_status === 'far_apart') {
          setFar(check);
          return;
        }
      }
      const body = {
        ...where,
        ...(address.region.trim() ? { region: address.region.trim() } : {}),
        ...(address.postal.trim() ? { postal_code: address.postal.trim() } : {}),
        pin,
        public_address_visibility: exact ? ('exact' as const) : ('approximate' as const),
        ...(mobile ? { service_radius_km: radiusKm } : {}),
      };
      const location = existing
        ? await api.api('org.location_update', {
            path: { org_id: orgId, location_id: existing.id },
            body,
            ifMatch: ifMatchOf(existing.version),
          })
        : await api.api('org.location_create', {
            path: { org_id: orgId },
            body: { ...body, timezone: regionTimeZone, is_primary: true },
          });
      await onDone({ location });
    } catch (err) {
      if (err instanceof ApiProblem && err.fields.length) {
        const at = (p: string) => err.fields.some((x) => x.pointer === p);
        setMissing({ line1: at('/address_line_1'), city: at('/city'), pin: at('/pin'), radius: at('/service_radius_km') });
      }
      console.warn('location not saved', err);
      toast(t('provider.onboarding.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const noWay = mapFailed && (geo === 'denied' || geo === 'unsupported') && !pin;
  return (
    <div className="pwa-ws-stack">
      <p className="m-0">{t('provider.onboarding.location.intro')}</p>
      <div>
        <Button icon="locate" loading={geo === 'asking'} disabled={geo === 'unsupported'} onClick={locate}>
          {t('provider.onboarding.location.useMine')}
        </Button>
      </div>
      {geo === 'denied' ? <p className="pwa-text-caption m-0">{t('provider.onboarding.location.denied')}</p> : null}
      {mapFailed ? (
        <p className="pwa-text-caption m-0" data-testid="no-map">
          {t('provider.onboarding.location.noMap')}
        </p>
      ) : (
        <div className="pwa-ws-pinmap">
          <MapCanvas
            center={pin ?? region.map.default_center}
            zoom={pin ? PIN_ZOOM : region.map.default_zoom}
            places={[]}
            styleUrl={styleUrl}
            focus={focus}
            label={t('provider.onboarding.location.mapLabel')}
            onMove={(m) => {
              if (!m.byUser) return;
              setPin(roundPoint(m.center));
              setFar(null);
            }}
            onFailed={() => setMapFailed(true)}
            overlay={
              <span className="pwa-ws-pinmap-hint pwa-text-caption">
                {pin ? t('provider.onboarding.location.pinSet') : t('provider.onboarding.location.moveMap')}
              </span>
            }
          />
          <span className={cx('pwa-ws-pinmap-pin', pin && 'is-set')} aria-hidden="true">
            <Icon name="pin" size={36} />
          </span>
        </div>
      )}
      {noWay ? (
        <Banner
          tone="warn"
          icon="alert"
          title={t('provider.onboarding.location.noWayTitle')}
          text={t('provider.onboarding.location.noWayText')}
        >
          <div className="pwa-banner-actions">
            <a href={portalHref(portalUrl, locale, orgId, 'locations')} target="_blank" rel="noopener" className="pwa-link">
              {t('provider.menu.openWebUi')}
            </a>
          </div>
        </Banner>
      ) : null}
      {missing.pin ? (
        <p className="pwa-ws-error m-0" role="alert">
          {t('provider.onboarding.location.pinRequired')}
        </p>
      ) : null}
      {pin && !mapFailed ? (
        <div>
          <Button size="sm" variant="ghost" icon="pin" loading={filling} onClick={() => void reverse(pin)}>
            {t('provider.onboarding.location.fillFromPin')}
          </Button>
        </div>
      ) : null}
      <TextField
        label={t('provider.onboarding.location.street')}
        value={address.line1}
        onChange={(e) => set({ line1: e.target.value })}
        autoComplete="street-address"
        maxLength={200}
        error={missing.line1 ? t('provider.onboarding.location.streetRequired') : undefined}
      />
      <TextField
        label={t('provider.onboarding.location.city')}
        value={address.city}
        onChange={(e) => set({ city: e.target.value })}
        autoComplete="address-level2"
        maxLength={100}
        error={missing.city ? t('provider.onboarding.location.cityRequired') : undefined}
      />
      <TextField
        label={t('provider.onboarding.location.postal')}
        value={address.postal}
        onChange={(e) => set({ postal: e.target.value })}
        inputMode="numeric"
        autoComplete="postal-code"
        maxLength={20}
      />
      {far ? (
        <Banner
          tone="warn"
          icon="alert"
          title={t('provider.onboarding.location.farTitle')}
          text={t('provider.onboarding.location.farText', { distance: f.number(Math.round((far.distance_m ?? 0) / 100) / 10) })}
        />
      ) : null}
      <fieldset className="pwa-fieldset">
        <legend className="cp-field-label">{t('provider.onboarding.location.show')}</legend>
        <div className="pwa-option-list">
          {([true, false] as const).map((v) => (
            <label key={String(v)} className={cx('pwa-option', exact === v && 'is-selected')}>
              <input type="radio" name="visibility" checked={exact === v} onChange={() => setExact(v)} />
              <span className="flex flex-col">
                <span className="pwa-option-title">
                  {t(v ? 'provider.onboarding.location.exact' : 'provider.onboarding.location.area')}
                </span>
                <span className="pwa-text-caption">
                  {t(v ? 'provider.onboarding.location.exactText' : 'provider.onboarding.location.areaText')}
                </span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      {mobile ? (
        <TextField
          label={t('provider.onboarding.location.radius')}
          hint={t('provider.onboarding.location.radiusHint')}
          type="number"
          inputMode="numeric"
          min={1}
          max={200}
          value={radius}
          onChange={(e) => setRadius(e.target.value)}
          error={missing.radius ? t('provider.onboarding.location.radiusInvalid') : undefined}
        />
      ) : null}
      <div className="pwa-onb-actions">
        <Button variant="primary" loading={saving} onClick={() => void submit()}>
          {far ? t('provider.onboarding.location.saveAnyway') : t('provider.onboarding.next')}
        </Button>
      </div>
    </div>
  );
}
