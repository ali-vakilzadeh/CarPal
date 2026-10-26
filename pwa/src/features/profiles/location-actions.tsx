'use client';
// Client parts of Location & Hours: the Directions menu (Docs/22 W-PUB-02 → the Directions menu of W-MAP-01; the apps
// and link formats come from the region config, open point 8) and Copy address. Directions use the location's public
// point (SEC-OUT-4); the tap is the registered map.directions_tapped event (consent-gated, GD-17).
import { useId } from 'react';
import { Button } from '@/components/ds/button';
import { IconButton } from '@/components/ds/icon-button';
import { useToast } from '@/components/shell/toast';
import { useAnalytics } from '@/lib/analytics/client';
import { useRegion } from '@/lib/config/client';
import { useT } from '@/lib/i18n/client';

/** A navigation app link: {lat} and {lng} of the template filled with the point (six decimals at most). */
export function directionsUrl(template: string, point: { lat: number; lng: number }): string {
  const lat = point.lat.toFixed(6).replace(/\.?0+$/, '');
  const lng = point.lng.toFixed(6).replace(/\.?0+$/, '');
  return template.replaceAll('{lat}', lat).replaceAll('{lng}', lng);
}

export function DirectionsMenu({ point, block }: { point: { lat: number; lng: number }; block?: boolean }) {
  const t = useT();
  const region = useRegion();
  const { track } = useAnalytics();
  const id = `directions-${useId().replace(/:/g, '')}`;
  const apps = region.navigation_apps.filter((a) => a.platforms.includes('web'));
  if (!apps.length) return null;
  return (
    <>
      <Button icon="route" block={block} popoverTarget={id} aria-haspopup="dialog">
        {t('profiles.location.directions')}
      </Button>
      <div
        id={id}
        popover="auto"
        role="dialog"
        className="pwa-popover pwa-popover-menu"
        aria-label={t('profiles.location.directionsTitle')}
      >
        <p className="pwa-text-label m-0">{t('profiles.location.directionsTitle')}</p>
        {apps.map((a) => (
          <a
            key={a.key}

            className="pwa-menu-item"
            href={directionsUrl(a.url_template, point)}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => track('map.directions_tapped', { navigation_app_key: a.key, target_type: 'location' })}
          >
            {a.label.text}
          </a>
        ))}
      </div>
    </>
  );
}

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
