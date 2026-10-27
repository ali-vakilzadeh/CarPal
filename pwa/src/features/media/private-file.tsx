'use client';
// Private media in the garage (W-GAR-02): thumbnails of attached assets, the in-place preview of a document (PDF in
// a frame, image full size) and Download — all through 5-minute signed URLs (SEC-UP-4). Documents are served as
// attachments, so the preview reads the bytes into a blob URL (frame-src blob: on the garage pages only, GD-15
// amendment P7); the URL is revoked when the preview closes. 409 MEDIA_NOT_READY = still being checked.
import type { MediaAsset } from '@carpal/api-contracts';
import { useEffect, useState } from 'react';
import { Banner } from '@/components/ds/banner';
import { Button } from '@/components/ds/button';
import { Icon } from '@/components/ds/icon';
import { Dialog } from '@/components/shell/dialog';
import { ApiProblem } from '@/lib/api/problem';
import { useApiClient, useApiQuery } from '@/lib/api/query';
import { useT } from '@/lib/i18n/client';
import { blobUrlOf } from './browser-io';

/** media.get with a short cache; 404 (not visible yet) is not retried by the screen. */
export function useMediaAsset(mediaId: string | null | undefined) {
  return useApiQuery('media.get', mediaId ? { path: { media_id: mediaId } } : undefined, { enabled: !!mediaId, staleTime: 60_000 });
}

/** A small square thumbnail of an attached asset, or its type icon until a thumbnail exists. */
export function AssetThumb({ mediaId, label }: { mediaId: string; label: string }) {
  const asset = useMediaAsset(mediaId);
  const a = asset.data;
  return (
    <span className="pwa-asset-thumb" title={label}>
      {a?.thumbnail_url ? (
        // eslint-disable-next-line @next/next/no-img-element -- signed URL on the media host (see media-image.tsx)
        <img src={a.thumbnail_url} alt={label} loading="lazy" />
      ) : (
        <Icon name={a?.media_type === 'document' ? 'doc' : a?.media_type === 'video' ? 'video' : 'image'} size={24} label={label} />
      )}
    </span>
  );
}

type Preview = { state: 'loading' } | { state: 'ready'; url: string; type: string } | { state: 'notReady' } | { state: 'error' };

async function fileOf(
  api: ReturnType<typeof useApiClient>,
  asset: MediaAsset,
  signal?: AbortSignal,
): Promise<{ url: string; type: string }> {
  // Images show the re-encoded display variant; a document's original is the sanitized PDF (owner only).
  const variant = asset.media_type === 'image' ? 'display' : 'original';
  const signed = await api.api('media.download_url', { path: { media_id: asset.id }, body: { variant }, ...(signal ? { signal } : {}) });
  // Images: no declared type — the display variant's format is the server's choice and <img> sniffs it.
  const type = asset.media_type === 'image' ? '' : asset.mime_type;
  return { url: await blobUrlOf(signed.url, type, signal), type };
}

/** "Preview" in a dialog: PDF in a frame, images as an image. */
export function DocumentPreview({ mediaId, title, open, onClose }: { mediaId: string; title: string; open: boolean; onClose: () => void }) {
  const t = useT();
  const asset = useMediaAsset(open ? mediaId : null);
  return (
    <Dialog
      name="document-preview"
      open={open}
      onClose={onClose}
      title={title}
      className="pwa-preview-dialog"
      footer={<DownloadButton mediaId={mediaId} name={title} />}
    >
      {asset.isError ? <Banner tone="danger" text={t('media.previewFailed')} /> : null}
      {open && asset.data ? (
        <PreviewBody key={asset.data.id} asset={asset.data} title={title} />
      ) : !asset.isError ? (
        <p className="pwa-text-caption" role="status">
          {t('media.loadingPreview')}
        </p>
      ) : null}
    </Dialog>
  );
}

/** Mounted per opened asset: fetches the file into a blob URL and revokes it when closed. */
function PreviewBody({ asset, title }: { asset: MediaAsset; title: string }) {
  const t = useT();
  const api = useApiClient();
  const [preview, setPreview] = useState<Preview>({ state: 'loading' });

  useEffect(() => {
    const ctrl = new AbortController();
    let url: string | null = null;
    fileOf(api, asset, ctrl.signal)
      .then((r) => {
        url = r.url;
        setPreview({ state: 'ready', ...r });
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        setPreview(err instanceof ApiProblem && err.code === 'MEDIA_NOT_READY' ? { state: 'notReady' } : { state: 'error' });
      });
    return () => {
      ctrl.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [asset, api]);

  return (
    <>
      {preview.state === 'error' ? <Banner tone="danger" text={t('media.previewFailed')} /> : null}
      {preview.state === 'notReady' ? <Banner tone="info" text={t('media.notReady')} /> : null}
      {preview.state === 'loading' ? (
        <p className="pwa-text-caption" role="status">
          {t('media.loadingPreview')}
        </p>
      ) : null}
      {preview.state === 'ready' && preview.type === 'application/pdf' ? (
        <iframe className="pwa-pdf-frame" src={preview.url} title={t('media.previewOf', { name: title })} data-testid="pdf-preview" />
      ) : null}
      {preview.state === 'ready' && preview.type !== 'application/pdf' ? (
        // eslint-disable-next-line @next/next/no-img-element -- blob: URL of a private image
        <img className="pwa-image-preview" src={preview.url} alt={title} data-testid="image-preview" />
      ) : null}
    </>
  );
}

/** Downloads the original file under a readable name (through a blob, so images download too). */
export function DownloadButton({ mediaId, name, size = 'md' }: { mediaId: string; name: string; size?: 'md' | 'sm' }) {
  const t = useT();
  const api = useApiClient();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const download = async () => {
    setBusy(true);
    setFailed(false);
    try {
      const asset = await api.api('media.get', { path: { media_id: mediaId } });
      const signed = await api.api('media.download_url', { path: { media_id: mediaId }, body: { variant: 'original' } });
      const url = await blobUrlOf(signed.url, asset.mime_type);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName(name, asset.mime_type);
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button size={size} variant="secondary" icon="download" loading={busy} onClick={() => void download()}>
        {t('media.download')}
      </Button>
      {failed ? (
        <p className="pwa-text-caption pwa-error-text" role="alert">
          {t('media.downloadFailed')}
        </p>
      ) : null}
    </>
  );
}

export function fileName(title: string, mime: string): string {
  const ext =
    mime === 'application/pdf'
      ? 'pdf'
      : mime === 'image/png'
        ? 'png'
        : mime === 'image/webp'
          ? 'webp'
          : mime === 'video/mp4'
            ? 'mp4'
            : 'jpg';
  const visible = [...title].filter((c) => c >= ' ' && c !== '\x7f').join('');
  const base =
    visible
      .replace(/[\\/:*?"<>|]+/g, ' ')
      .trim()
      .slice(0, 80) || 'file';
  return `${base}.${ext}`;
}
