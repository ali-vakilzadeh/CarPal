'use client';
// The directory page's map (Docs/22 W-PUB-04 "map in the right rail, loaded after the list so the page stays fast";
// open point 9: the 2.5 s budget is measured without it). The rail shows from 1200 px only, so the map mounts only
// on wide screens and only once the page has loaded and the browser is idle; pins are the listed providers.
import { useEffect, useState } from 'react';
import { MapCanvas, boundsOf, type Place, type Point } from '@/features/map';
import { useT } from '@/lib/i18n/client';
import { WIDE, useMediaQuery } from '@/lib/media-query';

function afterLoad(fn: () => void): () => void {
  let idle = 0;
  const run = () => {
    idle = typeof requestIdleCallback === 'function' ? requestIdleCallback(fn, { timeout: 3_000 }) : window.setTimeout(fn, 200);
  };
  if (document.readyState === 'complete') run();
  else window.addEventListener('load', run, { once: true });
  return () => {
    window.removeEventListener('load', run);
    if (typeof cancelIdleCallback === 'function') cancelIdleCallback(idle);
    else window.clearTimeout(idle);
  };
}

export function DirectoryMap({
  places,
  center,
  zoom,
  styleUrl,
}: {
  places: Place[];
  center: Point;
  zoom: number;
  styleUrl: string | null;
}) {
  const t = useT();
  const wide = useMediaQuery(WIDE);
  const [load, setLoad] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => (wide ? afterLoad(() => setLoad(true)) : undefined), [wide]);
  if (failed) return <p className="pwa-text-caption">{t('search.map.failedTitle')}</p>;
  if (!wide || !load) return <div className="pwa-directory-map is-placeholder" aria-hidden="true" />;
  const bbox = boundsOf(places.map((p) => p.point));
  return (
    <MapCanvas
      className="pwa-directory-map"
      center={center}
      zoom={zoom}
      places={places}
      bestMatch
      styleUrl={styleUrl}
      fit={bbox ? { key: 'directory', bbox } : null}
      label={t('search.map.label')}
      onSelect={(id) =>
        document.querySelector(`[data-location-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
      }
      onFailed={() => setFailed(true)}
    />
  );
}
