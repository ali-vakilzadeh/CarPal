'use client';
// Before/after slider (Docs/22 W-PUB-05: drag, arrow keys or click to toggle; C-PROV-02 "the handle follows the
// layout direction"). `pos` is the share of the before photo shown from the inline-start edge. A native range input
// carries the keyboard and screen-reader behaviour; the clip position is set
// through the CSSOM (the CSP allows no style attributes). Without JavaScript both photos show side by side.
import { useEffect, useRef, useState } from 'react';
import type { MediaAttachmentView } from '@carpal/api-contracts';
import { MediaImage } from '@/components/media/media-image';
import { useBrowserValue } from '@/lib/browser-value';
import { useDirection, useT } from '@/lib/i18n/client';

export function BeforeAfter({
  before,
  after,
  priority,
}: {
  before: MediaAttachmentView | null;
  after: MediaAttachmentView | null;
  priority?: boolean;
}) {
  const t = useT();
  const dir = useDirection();
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(50);
  const ready = useBrowserValue(() => true, false); // the slider needs JavaScript; without it both photos show
  const dragging = useRef(false);

  useEffect(() => {
    box.current?.style.setProperty('--pwa-ba-pos', `${pos}%`);
  }, [pos, ready]);

  const pending = t('profiles.showcase.photoPending');
  if (!before || !after) {
    const one = after ?? before;
    return (
      <MediaImage
        url={one?.url}
        alt={one?.caption ?? t('profiles.showcase.slider')}
        width={one?.width}
        height={one?.height}
        priority={priority}
        placeholder={pending}
      />
    );
  }

  const fromPointer = (clientX: number) => {
    const r = box.current?.getBoundingClientRect();
    if (!r || r.width === 0) return;
    const x = ((clientX - r.left) / r.width) * 100;
    setPos(Math.round(Math.min(100, Math.max(0, dir === 'rtl' ? 100 - x : x))));
  };

  return (
    <figure className="pwa-ba-figure">
      <div
        ref={box}
        className={ready ? 'pwa-ba is-ready' : 'pwa-ba'}
        onPointerDown={(e) => {
          dragging.current = true;
          (e.target as Element).setPointerCapture?.(e.pointerId);
          fromPointer(e.clientX);
        }}
        onPointerMove={(e) => dragging.current && fromPointer(e.clientX)}
        onPointerUp={() => (dragging.current = false)}
        onPointerCancel={() => (dragging.current = false)}
      >
        <div className="pwa-ba-layer is-after">
          <MediaImage
            url={after.url}
            alt={after.caption ?? t('profiles.showcase.after')}
            width={after.width}
            height={after.height}
            priority={priority}
            placeholder={pending}
          />
          <span className="pwa-ba-tag is-after">{t('profiles.showcase.after')}</span>
        </div>
        <div className="pwa-ba-layer is-before">
          <MediaImage
            url={before.url}
            alt={before.caption ?? t('profiles.showcase.before')}
            width={before.width}
            height={before.height}
            placeholder={pending}
          />
          <span className="pwa-ba-tag is-before">{t('profiles.showcase.before')}</span>
        </div>
        {ready ? <span className="pwa-ba-handle" aria-hidden="true" /> : null}
      </div>
      {ready ? (
        <div className="pwa-ba-controls">
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={pos}
            aria-label={t('profiles.showcase.position')}
            aria-valuetext={`${t('profiles.showcase.before')} ${pos}% · ${t('profiles.showcase.after')} ${100 - pos}%`}
            onChange={(e) => setPos(Number(e.target.value))}
            className="pwa-ba-range"
          />
          <button type="button" className="pwa-link" onClick={() => setPos((p) => (p >= 50 ? 0 : 100))}>
            {pos >= 50 ? t('profiles.showcase.after') : t('profiles.showcase.before')}
          </button>
        </div>
      ) : null}
      <figcaption className="pwa-text-caption">{t('profiles.showcase.sliderHint')}</figcaption>
    </figure>
  );
}
