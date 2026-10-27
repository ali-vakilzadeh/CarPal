'use client';
// Upload kit UI (P7.T2, Docs/22 W-GAR-02 "drag and drop of invoices (PDF/images), multi-file upload"): a drop zone
// with a file picker that also takes pasted files (Ctrl+V / Cmd+V anywhere on the page while it is shown — pasted
// text still goes to the focused field), and one row per file with its progress, the reason when it cannot be used
// (type, size, megapixels, video length, HEIC the browser cannot convert, scan result) and Retry / Remove.
import type { UploadPurpose } from '@carpal/api-contracts';
import { useEffect, useId, useRef, useState, type DragEvent } from 'react';
import { Button } from '@/components/ds/button';
import { cx } from '@/components/ds/cx';
import { Icon } from '@/components/ds/icon';
import { IconButton } from '@/components/ds/icon-button';
import { Meter } from '@/components/ds/meter';
import { useApiClient } from '@/lib/api/query';
import { useSession } from '@/lib/api/session';
import { useFormat } from '@/lib/format/client';
import { useT } from '@/lib/i18n/client';
import type { MessageKey } from '@/lib/i18n/keys';
import type { UploadFailure, UploadPhase } from './engine';
import { acceptFor, MAX_VIDEO_SECONDS } from './policy';
import { checkAgain, removeUpload, retryUpload, startUploads, useUploads, type UploadItem } from './store';

export interface UploadZoneProps {
  /** Uploads of this group are listed here (e.g. "record:<vehicle id>"). */
  group: string;
  purpose: UploadPurpose;
  label: string;
  hint?: string;
  multiple?: boolean;
  /** Take pasted files (only one zone per page should). */
  paste?: boolean;
  className?: string;
}

const PHASE_TEXT: Record<Exclude<UploadPhase, 'failed'>, MessageKey> = {
  checking: 'media.phase.checking',
  converting: 'media.phase.converting',
  hashing: 'media.phase.preparing',
  sending: 'media.phase.sending',
  processing: 'media.phase.processing',
  ready: 'media.phase.ready',
};

const FAILURE_TEXT: Record<UploadFailure, MessageKey> = {
  type: 'media.failure.type',
  size: 'media.failure.size',
  pixels: 'media.failure.pixels',
  duration: 'media.failure.duration',
  heic: 'media.failure.heic',
  unreadable: 'media.failure.unreadable',
  refused: 'media.failure.refused',
  rateLimited: 'media.failure.rateLimited',
  network: 'media.failure.network',
  expired: 'media.failure.expired',
  mismatch: 'media.failure.mismatch',
  infected: 'media.failure.infected',
  scanFailed: 'media.failure.scanFailed',
  quarantined: 'media.failure.quarantined',
  timeout: 'media.failure.timeout',
};

/** Failures that sending the same file again cannot fix. */
const FINAL: ReadonlySet<UploadFailure> = new Set([
  'type',
  'size',
  'pixels',
  'duration',
  'heic',
  'unreadable',
  'refused',
  'infected',
  'quarantined',
]);

export function UploadZone({ group, purpose, label, hint, multiple = true, paste = true, className }: UploadZoneProps) {
  const t = useT();
  const api = useApiClient();
  const session = useSession();
  const ownerId = session.data?.user?.id ?? null;
  const items = useUploads(group);
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const hintId = useId();

  const add = (files: FileList | File[] | null) => {
    if (!files || !ownerId) return;
    const list = [...files];
    if (list.length === 0) return;
    startUploads(multiple ? list : list.slice(0, 1), { group, purpose, ownerId, api });
  };

  useEffect(() => {
    if (!paste) return;
    const onPaste = (e: ClipboardEvent) => {
      const files = e.clipboardData?.files;
      if (!files || files.length === 0) return;
      e.preventDefault();
      add(files);
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  });

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    add(e.dataTransfer.files);
  };

  return (
    <div className={cx('pwa-upload', className)}>
      <div
        className={cx('pwa-dropzone', over && 'is-over')}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        data-testid={`dropzone-${group}`}
      >
        <Icon name="attach" size={24} />
        <div className="pwa-dropzone-text">
          <p className="pwa-dropzone-label">{label}</p>
          <p id={hintId} className="pwa-text-caption">
            {hint ?? t(paste ? 'media.dropHintPaste' : 'media.dropHint')}
          </p>
        </div>
        <Button
          size="sm"
          variant="secondary"
          icon="plus"
          aria-describedby={hintId}
          disabled={!ownerId}
          onClick={() => input.current?.click()}
        >
          {t('media.choose')}
        </Button>
        <input
          ref={input}
          type="file"
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          accept={acceptFor(purpose)}
          multiple={multiple}
          onChange={(e) => {
            add(e.target.files);
            e.target.value = '';
          }}
        />
      </div>
      {items.length > 0 ? (
        <ul className="pwa-upload-list" aria-label={t('media.listLabel')}>
          {items.map((u) => (
            <UploadRow key={u.id} item={u} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function UploadRow({ item }: { item: UploadItem }) {
  const t = useT();
  const f = useFormat();
  const s = item.state;
  const failed = s.phase === 'failed';
  const busy = !failed && s.phase !== 'ready';
  const status = failed
    ? t(FAILURE_TEXT[s.failure ?? 'network'], { seconds: f.digits(MAX_VIDEO_SECONDS) })
    : s.phase === 'sending'
      ? t('media.phase.sendingPercent', { percent: f.digits(Math.round(s.progress * 100)) })
      : t(PHASE_TEXT[s.phase as Exclude<UploadPhase, 'failed'>]);
  return (
    <li className={cx('pwa-upload-row', failed && 'is-failed', s.phase === 'ready' && 'is-ready')} data-upload-phase={s.phase}>
      <span className="pwa-upload-thumb" aria-hidden="true">
        {item.previewUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- a local blob: preview of the chosen file
          <img src={item.previewUrl} alt="" />
        ) : (
          <Icon name={s.kind === 'pdf' ? 'doc' : s.kind === 'video' ? 'video' : 'attach'} size={24} />
        )}
      </span>
      <div className="pwa-upload-body">
        <p className="pwa-upload-name" dir="auto">
          <bdi>{s.converted ? s.file.name : item.name}</bdi>
        </p>
        <p className={cx('pwa-text-caption', failed && 'pwa-error-text')} role={failed ? 'alert' : 'status'}>
          {failed ? <Icon name="alert" size={16} /> : s.phase === 'ready' ? <Icon name="check" size={16} /> : null}
          {status}
          {s.converted && !failed ? ` · ${t('media.converted')}` : ''}
        </p>
        {busy ? (
          <Meter
            value={s.phase === 'sending' ? s.progress * 100 : s.phase === 'processing' ? 100 : 5}
            label={t('media.progress', { name: item.name })}
          />
        ) : null}
      </div>
      <div className="pwa-upload-actions">
        {failed && s.failure === 'timeout' ? (
          <Button size="sm" variant="ghost" onClick={() => checkAgain(item.id)}>
            {t('media.checkAgain')}
          </Button>
        ) : null}
        {failed && s.failure !== 'timeout' && !FINAL.has(s.failure ?? 'network') ? (
          <Button size="sm" variant="ghost" onClick={() => retryUpload(item.id)}>
            {t('common.actions.retry')}
          </Button>
        ) : null}
        <IconButton icon="close" label={t('media.remove', { name: item.name })} onClick={() => removeUpload(item.id)} />
      </div>
    </li>
  );
}
