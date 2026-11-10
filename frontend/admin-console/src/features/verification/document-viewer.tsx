'use client';
// The document viewer of a verification (AC9.T4, Docs/23 A-VER-02 centre panel: zoom, rotate, page through, watermark
// "CarPal internal"). The documents are private files of the organization (VerificationSubmit.submitted_document_ids);
// each is shown on demand through admin.media_download_url (PURP verification:<id>, audited as a staff download: the
// "documents viewed" of the Docs/23 audit line) as the 5-minute display copy, inline with the watermark and no download
// button. A file without a display copy (a PDF, for example) cannot be drawn inline: the viewer offers a link that
// opens it in a new tab for the same 5 minutes (D-61). Pages = the documents of the request, one at a time.
import { useState } from 'react';
import { problemText } from '@/components/admin';
import { Button } from '@/components/ds/button';
import { IconButton } from '@/components/ds/icon-button';
import type { AccessPurpose } from '@/lib/api/client';
import type { ApiProblem } from '@/lib/api/problem';
import { useApiClient } from '@/lib/api/query';
import { Bidi } from '@/lib/format/bidi';
import { useFormat } from '@/lib/format/client';
import { useT } from '@/lib/i18n/client';

type Shown =
  | { s: 'idle' }
  | { s: 'busy' }
  | { s: 'image'; url: string; expires: string }
  | { s: 'link'; url: string; expires: string }
  | { s: 'failed'; p: ApiProblem };

const ZOOMS = [0.5, 0.75, 1, 1.5, 2, 3] as const;

export function DocumentViewer({ ids, purpose }: { ids: readonly string[]; purpose: AccessPurpose }) {
  const t = useT();
  const [index, setIndex] = useState(0);
  if (!ids.length) return <p data-testid="no-documents">{t('admin.verification.docs.none')}</p>;
  const at = Math.min(index, ids.length - 1);
  return (
    <div className="adm-docs" data-testid="document-viewer">
      <div className="adm-docs-nav">
        <IconButton icon="back" label={t('admin.verification.docs.prev')} disabled={at === 0} onClick={() => setIndex(at - 1)} />
        <span aria-live="polite">{t('admin.verification.docs.page', { n: at + 1, total: ids.length })}</span>
        <IconButton
          icon="next"
          label={t('admin.verification.docs.next')}
          disabled={at >= ids.length - 1}
          onClick={() => setIndex(at + 1)}
        />
      </div>
      <OneDocument key={ids[at]} mediaId={ids[at]!} purpose={purpose} />
    </div>
  );
}

function OneDocument({ mediaId, purpose }: { mediaId: string; purpose: AccessPurpose }) {
  const t = useT();
  const f = useFormat();
  const api = useApiClient();
  const [shown, setShown] = useState<Shown>({ s: 'idle' });
  const [zoom, setZoom] = useState(2); // index into ZOOMS (100 %)
  const [turn, setTurn] = useState(0);

  const show = async () => {
    setShown({ s: 'busy' });
    try {
      const r = await api.api('admin.media_download_url', { path: { media_id: mediaId }, body: { variant: 'display' }, purpose });
      setShown({ s: 'image', url: r.url, expires: r.expires_at });
    } catch (err) {
      const p = err as ApiProblem;
      // No display copy (not an image): the original, opened in a new tab.
      if (p.status === 404) {
        try {
          const r = await api.api('admin.media_download_url', { path: { media_id: mediaId }, body: { variant: 'original' }, purpose });
          setShown({ s: 'link', url: r.url, expires: r.expires_at });
          return;
        } catch (again) {
          setShown({ s: 'failed', p: again as ApiProblem });
          return;
        }
      }
      setShown({ s: 'failed', p });
    }
  };

  if (shown.s === 'image')
    return (
      <div className="adm-doc" data-testid="document">
        <div className="adm-doc-tools" role="toolbar" aria-label={t('admin.verification.docs.tools')}>
          <IconButton icon="minus" label={t('admin.verification.docs.zoomOut')} disabled={zoom === 0} onClick={() => setZoom(zoom - 1)} />
          <span className="adm-muted">{f.number(ZOOMS[zoom]!, { style: 'percent' })}</span>
          <IconButton
            icon="plus"
            label={t('admin.verification.docs.zoomIn')}
            disabled={zoom === ZOOMS.length - 1}
            onClick={() => setZoom(zoom + 1)}
          />
          <IconButton icon="refresh" label={t('admin.verification.docs.rotate')} onClick={() => setTurn((turn + 90) % 360)} />
        </div>
        <figure className="adm-media adm-doc-frame" onContextMenu={(e) => e.preventDefault()}>
          {/* A signed display copy from the storage host (CSP img-src); next/image would proxy it through the console. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={shown.url}
            alt={t('admin.verification.docs.alt')}
            draggable={false}
            referrerPolicy="no-referrer"
            data-zoom={ZOOMS[zoom]}
            data-turn={turn}
            style={{ transform: `rotate(${turn}deg) scale(${ZOOMS[zoom]})` }}
            onError={() => setShown({ s: 'link', url: shown.url, expires: shown.expires })}
          />
          <span className="adm-media-mark" aria-hidden="true">
            CarPal internal
          </span>
          <figcaption className="adm-muted">{t('admin.moderation.media.internal', { when: f.date(shown.expires, 'time') })}</figcaption>
        </figure>
      </div>
    );
  if (shown.s === 'link')
    return (
      <p data-testid="document">
        <a href={shown.url} target="_blank" rel="noopener noreferrer">
          {t('admin.verification.docs.open')}
        </a>{' '}
        <span className="adm-muted">{t('admin.reviews.linkExpires', { when: f.date(shown.expires, 'time') })}</span>
      </p>
    );
  return (
    <div>
      <p className="adm-muted">
        {t('admin.verification.docs.file')} <Bidi ltr>{`…${mediaId.slice(-8)}`}</Bidi>
      </p>
      <Button size="sm" variant="secondary" icon="image" loading={shown.s === 'busy'} onClick={() => void show()}>
        {t('admin.verification.docs.show')}
      </Button>
      {shown.s === 'failed' ? (
        <p className="adm-error" role="alert">
          {problemText(shown.p, t)}
        </p>
      ) : null}
      <p className="adm-muted">{t('admin.verification.docs.logged')}</p>
    </div>
  );
}
