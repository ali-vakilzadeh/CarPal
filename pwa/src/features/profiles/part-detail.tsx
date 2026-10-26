'use client';
// Client parts of the public part page (Docs/22 W-PUB-08, mirrors C-INV-02 / C-INV-03): the photo gallery with
// thumbnails, the fitment table with the visitor's car highlighted, and Ask about stock — guests sign in through the
// auth-intent modal (the form draft survives sign-in), then the stock inquiry form (quantity, message, optional
// vehicle context through the vendor_fitment_context consent: model, series and year, never VIN or plate).
import type { MediaAttachmentView, PublicInventoryItem } from '@carpal/api-contracts';
import { useState } from 'react';
import { Badge } from '@/components/ds/badge';
import { Button } from '@/components/ds/button';
import { Check } from '@/components/ds/check';
import { IconButton } from '@/components/ds/icon-button';
import { TextField } from '@/components/ds/text-field';
import { MediaImage } from '@/components/media/media-image';
import { useGatedAction, useIntentHandler } from '@/components/shell/auth-intent';
import { Dialog } from '@/components/shell/dialog';
import { useToast } from '@/components/shell/toast';
import { ApiProblem } from '@/lib/api';
import { useApiClient } from '@/lib/api/query';
import { useFormat } from '@/lib/format/client';
import { useLocale, useT } from '@/lib/i18n/client';
import { useCarNames } from './use-car';
import { fitmentTone, servableImages, type VehicleNames } from './view-model';

export function PartGallery({ media, name }: { media: readonly MediaAttachmentView[]; name: string }) {
  const t = useT();
  const f = useFormat();
  const images = servableImages(media);
  const [index, setIndex] = useState(0);
  const current = images[index] ?? null;
  return (
    <div className="pwa-gallery">
      <MediaImage
        url={current?.url}
        alt={current?.caption ?? name}
        width={current?.width}
        height={current?.height}
        priority
        placeholder={t('profiles.parts.photoPending')}
        placeholderIcon="part"
      />
      {images.length > 1 ? (
        <ul className="pwa-plain-list pwa-thumbs" aria-label={t('profiles.part.photo', { n: index + 1, total: images.length })}>
          {images.map((m, i) => (
            <li key={m.attachment_id}>
              <button
                type="button"
                className="pwa-thumb-btn"
                aria-label={t('profiles.part.showPhoto', { n: i + 1 })}
                aria-current={i === index ? 'true' : undefined}
                onClick={() => setIndex(i)}
              >
                <MediaImage
                  url={m.url}
                  thumbnailUrl={m.thumbnail_url}
                  variant="thumb"
                  alt=""
                  aspect="square"
                  placeholder={f.number(i + 1)}
                />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

type Fitment = PublicInventoryItem['fitment'][number];

const same = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && a.localeCompare(b, undefined, { sensitivity: 'base' }) === 0;

/** True when a fitment row covers the car (brand, and model/series/year where the row names them). */
export function fitsCar(row: Fitment, car: VehicleNames & { year?: number | null }): boolean {
  if (!same(row.brand.text, car.brand)) return false;
  if (row.model && car.model && !same(row.model.text, car.model)) return false;
  if (row.series && car.series && !same(row.series.text, car.series)) return false;
  if (car.year) {
    if (row.year_start && car.year < row.year_start) return false;
    if (row.year_end && car.year > row.year_end) return false;
  }
  return true;
}

export function FitmentTable({ fitment }: { fitment: readonly Fitment[] }) {
  const t = useT();
  const f = useFormat();
  const { car } = useCarNames();
  if (!fitment.length) return <p className="pwa-text-body">{t('profiles.fitment.empty')}</p>;
  const mine = car ? fitment.filter((r) => fitsCar(r, car)) : [];
  const years = (r: Fitment) =>
    r.year_start && r.year_end
      ? t('profiles.fitment.years', { from: f.digits(r.year_start), to: f.digits(r.year_end) })
      : r.year_start
        ? t('profiles.fitment.yearsFrom', { from: f.digits(r.year_start) })
        : r.year_end
          ? t('profiles.fitment.yearsTo', { to: f.digits(r.year_end) })
          : '';
  const ordered = [...mine, ...fitment.filter((r) => !mine.includes(r))];
  return (
    <div className="pwa-stack-sm">
      {car && mine.length && mine.every((r) => r.confidence === 'uncertain') ? (
        <p className="pwa-text-caption" role="note">
          {t('profiles.fitment.uncertainBanner')}
        </p>
      ) : null}
      <table className="pwa-table">
        <caption className="sr-only">{t('profiles.fitment.fits')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('profiles.fitment.vehicle')}</th>
            <th scope="col">{t('profiles.fitment.engine')}</th>
            <th scope="col">{t('profiles.fitment.coverage')}</th>
          </tr>
        </thead>
        <tbody>
          {ordered.map((r, i) => {
            const isMine = mine.includes(r);
            return (
              <tr key={i} className={isMine ? 'is-mine' : undefined}>
                <th scope="row">
                  <bdi>{[r.brand.text, r.model?.text, r.series?.text].filter(Boolean).join(' ')}</bdi>
                  {years(r) ? <span className="pwa-text-caption"> · {years(r)}</span> : null}
                  {isMine ? <span className="pwa-text-caption"> · {t('profiles.fitment.yourCar')}</span> : null}
                </th>
                <td>{r.engine?.text ?? '—'}</td>
                <td>
                  <Badge tone={fitmentTone(r.confidence)} icon={r.confidence === 'confirmed' ? 'check' : 'help'}>
                    {t(`profiles.fitment.confidence.${r.confidence}`)}
                  </Badge>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

interface InquiryDraft {
  quantity: number;
  message: string;
  share: boolean;
}

export function AskAboutStock({
  itemId,
  itemName,
  vendorName,
  outOfStock,
  policyVersion,
}: {
  itemId: string;
  itemName: string;
  vendorName: string;
  outOfStock: boolean;
  policyVersion: string;
}) {
  const t = useT();
  const f = useFormat();
  const locale = useLocale();
  const api = useApiClient();
  const toast = useToast();
  const gate = useGatedAction();
  const { car } = useCarNames();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<InquiryDraft>(() => ({ quantity: 1, message: t('profiles.inquiry.defaultMessage'), share: true }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = (d: InquiryDraft = draft) => {
    setDraft(d);
    gate<InquiryDraft>({
      type: 'inquiry',
      target: itemId,
      draft: d,
      title: t('profiles.intent.ask', { name: vendorName }),
      run: () => setOpen(true),
    });
  };
  // Back from sign-in: reopen the form with what the guest had typed.
  useIntentHandler<InquiryDraft>('inquiry', (intent) => {
    if (intent.target !== itemId) return;
    if (intent.draft) setDraft(intent.draft);
    setOpen(true);
  });

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.api('inquiries.create', {
        body: {
          inventory_item_id: itemId,
          quantity: draft.quantity,
          message: draft.message.trim() || t('profiles.inquiry.defaultMessage'),
          content_locale: locale,
          ...(draft.share && car ? { share_vehicle_context: { vehicle_id: car.id, policy_version: policyVersion } } : {}),
        },
      });
      setOpen(false);
      toast(t('profiles.inquiry.sent', { name: vendorName }));
    } catch (err) {
      const code = err instanceof ApiProblem ? err.code : null;
      setError(
        code === 'DUPLICATE'
          ? t('profiles.inquiry.duplicate')
          : code === 'VERIFIED_CONTACT_REQUIRED'
            ? t('profiles.inquiry.verifiedContact')
            : code === 'RATE_LIMITED'
              ? t('profiles.inquiry.rateLimited')
              : t('profiles.toast.failed'),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button variant="primary" block icon="send" onClick={() => start()}>
        {outOfStock ? t('profiles.part.askBack') : t('profiles.part.ask')}
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={t('profiles.inquiry.title')}
        footer={
          <Button variant="primary" block icon="send" loading={busy} onClick={() => void send()}>
            {t('profiles.inquiry.send')}
          </Button>
        }
      >
        <div className="pwa-stack">
          <p className="pwa-text-label m-0" dir="auto">
            {itemName}
          </p>
          <div className="pwa-stepper-row">
            <span className="cp-field-label">{t('profiles.inquiry.quantity')}</span>
            <span className="pwa-stepper">
              <IconButton
                icon="minus"
                label={t('profiles.inquiry.less')}
                onClick={() => setDraft((d) => ({ ...d, quantity: Math.max(1, d.quantity - 1) }))}
              />
              <output aria-live="polite">{f.number(draft.quantity)}</output>
              <IconButton
                icon="plus"
                label={t('profiles.inquiry.more')}
                onClick={() => setDraft((d) => ({ ...d, quantity: Math.min(10000, d.quantity + 1) }))}
              />
            </span>
          </div>
          <TextField
            multiline
            label={t('profiles.inquiry.message')}
            value={draft.message}
            maxLength={2000}
            rows={3}
            onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setDraft((d) => ({ ...d, message: e.target.value }))}
          />
          {car ? (
            <Check
              checked={draft.share}
              onChange={(e) => setDraft((d) => ({ ...d, share: e.target.checked }))}
              hint={t('profiles.inquiry.shareVehicleText')}
            >
              {t('profiles.inquiry.shareVehicle')} (<bdi>{car.label}</bdi>)
            </Check>
          ) : null}
          {error ? (
            <p className="pwa-error-text" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      </Dialog>
    </>
  );
}
