'use client';
// The Directions menu (P6.T5, Docs/90 S-SHARED-10, Docs/22 W-MAP-01 "Directions on the web"): the region's map apps
// (platform web), the phone's own map app on Android/iOS, the address with Copy, and "Remember my choice". A
// remembered app turns the button into a direct link ("Directions in Neshan") with the menu one tap away. The choice
// is the account's navigation_app_key when signed in (me.preferences, ETag), else the cp_nav cookie. An approximate
// address shows the area only; the exact address comes with the confirmed appointment. The tap is the registered
// map.directions_tapped event (consent-gated, GD-17).
import type { UserPreference } from '@carpal/api-contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { Button, buttonClass } from '@/components/ds/button';
import { Icon } from '@/components/ds/icon';
import { IconButton } from '@/components/ds/icon-button';
import { useToast } from '@/components/shell/toast';
import { useAnalytics } from '@/lib/analytics/client';
import { apiQueryKey, useApiMutation, useApiQuery } from '@/lib/api/query';
import { useSession } from '@/lib/api/session';
import { useBrowserValue } from '@/lib/browser-value';
import { useRegion } from '@/lib/config/client';
import { useT } from '@/lib/i18n/client';
import {
  DEVICE_APP,
  devicePlatform,
  directionsApps,
  navCookieString,
  readNavCookie,
  rememberedApp,
  type DevicePlatform,
} from './directions-links';

/** The remembered navigation app and how to change it. */
export function useNavigationChoice() {
  const region = useRegion();
  const session = useSession();
  const signedIn = session.data?.signed_in === true;
  const queryClient = useQueryClient();
  const prefs = useApiQuery('me.preferences_get', undefined, { enabled: signedIn, staleTime: 5 * 60_000 });
  const cookieKey = useBrowserValue(() => readNavCookie(document.cookie), null);
  const [chosen, setChosen] = useState<string | null | undefined>(undefined);
  const save = useApiMutation('me.preferences_update', {
    onSuccess: (p) => queryClient.setQueryData<UserPreference>(apiQueryKey('me.preferences_get'), p),
    onError: () => void queryClient.invalidateQueries({ queryKey: apiQueryKey('me.preferences_get') }),
  });
  const stored = signedIn ? (prefs.data?.navigation_app_key ?? null) : cookieKey;
  const remembered = rememberedApp(region, chosen !== undefined ? chosen : stored);
  const remember = (key: string | null) => {
    setChosen(key);
    if (signedIn) save.mutate({ body: { navigation_app_key: key } });
    else document.cookie = navCookieString(key, location.protocol === 'https:');
  };
  return { remembered, remember };
}

export interface DirectionsMenuProps {
  /** The public point (approximate for businesses that hide their street address, SEC-OUT-4). */
  point: { lat: number; lng: number };
  /** The address line, or the area for an approximate address (shown with Copy). */
  address?: string | null;
  approximate?: boolean;
  /** The business name, for the menu title ("Directions to …"). */
  name?: string;
  block?: boolean;
  size?: 'md' | 'sm';
}

export function DirectionsMenu({ point, address, approximate, name, block, size = 'md' }: DirectionsMenuProps) {
  const t = useT();
  const region = useRegion();
  const toast = useToast();
  const { track } = useAnalytics();
  const { remembered, remember } = useNavigationChoice();
  const platform = useBrowserValue<DevicePlatform>(() => devicePlatform(navigator.userAgent, navigator.maxTouchPoints), null);
  const [keep, setKeep] = useState(false);
  const id = `directions-${useId().replace(/:/g, '')}`;
  const apps = directionsApps(region, point, { platform, remembered, deviceLabel: t('profiles.directions.device') });
  if (!apps.length) return null;
  const direct = remembered ? apps.find((a) => a.key === remembered) : undefined;
  const title = name ? t('profiles.directions.title', { name }) : t('profiles.location.directionsTitle');

  const tapped = (key: string) => {
    track('map.directions_tapped', { navigation_app_key: key === DEVICE_APP ? 'device' : key, target_type: 'location' });
    if (keep && key !== DEVICE_APP && key !== remembered) {
      remember(key);
      toast(t('profiles.directions.remembered'));
    }
  };

  return (
    <span className={block ? 'pwa-directions is-block' : 'pwa-directions'}>
      {direct ? (
        <>
          <a
            href={direct.href}
            target="_blank"
            rel="noopener noreferrer"
            className={buttonClass({ variant: 'secondary', size, block })}
            onClick={() => tapped(direct.key)}
          >
            <Icon name="route" size={20} />
            <span className="cp-btn-label">{t('profiles.directions.openIn', { app: direct.label })}</span>
          </a>
          <IconButton icon="more" label={t('profiles.directions.otherApps')} popoverTarget={id} aria-haspopup="dialog" />
        </>
      ) : (
        <Button icon="route" size={size} block={block} popoverTarget={id} aria-haspopup="dialog">
          {t('profiles.location.directions')}
        </Button>
      )}
      <div id={id} popover="auto" role="dialog" className="pwa-popover pwa-popover-menu" aria-label={title}>
        <p className="pwa-text-label m-0">{title}</p>
        {approximate ? (
          <p className="pwa-text-caption m-0">
            {address ? t('profiles.location.approximate', { area: address }) : null} {t('profiles.location.approximateText')}
          </p>
        ) : address ? (
          <div className="pwa-address">
            <p className="pwa-text-caption m-0" dir="auto">
              {address}
            </p>
            <CopyAddress text={address} />
          </div>
        ) : null}
        {apps.map((a) => (
          <a
            key={a.key}
            className="pwa-menu-item"
            href={a.href}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => tapped(a.key)}
            aria-current={a.key === remembered ? 'true' : undefined}
          >
            <Icon name={a.device ? 'phone' : a.key === 'osm' ? 'globe' : 'map'} size={20} />
            <span>{a.label}</span>
            {a.key === remembered ? <span className="pwa-text-caption">· {t('profiles.directions.yourChoice')}</span> : null}
          </a>
        ))}
        <label className="pwa-check-line">
          <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} />
          <span>{t('profiles.directions.remember')}</span>
        </label>
        {remembered ? (
          <button type="button" className="pwa-link" onClick={() => remember(null)}>
            {t('profiles.directions.forget')}
          </button>
        ) : null}
        <p className="pwa-text-caption m-0">{t('profiles.directions.onlyDestination')}</p>
      </div>
    </span>
  );
}

/** Copy address (S-SHARED-10); also used by the profiles' Location section. */
export function CopyAddress({ text }: { text: string }) {
  const t = useT();
  const toast = useToast();
  return (
    <IconButton
      icon="copy"
      label={t('profiles.location.copyAddress')}
      onClick={() =>
        void navigator.clipboard.writeText(text).then(
          () => toast(t('profiles.location.addressCopied')),
          () => toast(t('profiles.actions.copyFailed')),
        )
      }
    />
  );
}
