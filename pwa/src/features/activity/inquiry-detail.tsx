'use client';
// W-ME-01 Inquiry detail (C-PROF-06 Inquiries; P9.T5) at /<locale>/activity/inquiries/<id>: the item, the seller, the
// shared vehicle context (never VIN or plate), the status (with "reserved until"), the message thread with a reply box,
// and the requester's transitions — Cancel while open, "I picked it up" once answered or reserved (a completed
// inquiry lets the requester review the seller on Path 1, P11). 404 = not found (someone else's or gone, SEC-AZ-2).
import type { InquiryMessage, StockInquiry } from '@carpal/api-contracts';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { Button, buttonClass } from '@/components/ds/button';
import { TextField } from '@/components/ds/text-field';
import { SkeletonCard } from '@/components/shell/skeleton';
import { StateView, stateFromProblem } from '@/components/shell/states';
import { useToast } from '@/components/shell/toast';
import { apiQueryKey, useApiClient, useApiQuery } from '@/lib/api/query';
import { ApiProblem } from '@/lib/api/problem';
import { useFormat } from '@/lib/format/client';
import { reviewHref } from '@/features/reviews';
import { useLocale, useT } from '@/lib/i18n/client';
import { InquiryStatusBadge } from './activity';
import { inquiryActions } from './model';

const MAX_MESSAGE = 2000;

function Thread({ messages }: { messages: readonly InquiryMessage[] }) {
  const t = useT();
  const f = useFormat();
  if (messages.length === 0) return <p className="pwa-text-body m-0">{t('activity.inquiry.noMessages')}</p>;
  return (
    <ol className="pwa-inquiry-thread" aria-label={t('activity.inquiry.messages')}>
      {messages.map((m) => (
        <li key={m.id} className={m.author_side === 'requester' ? 'pwa-inquiry-msg is-mine' : 'pwa-inquiry-msg'}>
          <span className="pwa-text-caption">
            <bdi>{m.author_side === 'requester' ? t('activity.inquiry.you') : m.author_display}</bdi> ·{' '}
            <time dateTime={m.created_at}>{f.relative(m.created_at)}</time>
          </span>
          <p className="pwa-text-body m-0 pwa-user-text" dir="auto" lang={m.content_locale}>
            {m.body}
          </p>
        </li>
      ))}
    </ol>
  );
}

export function InquiryDetail({ inquiryId }: { inquiryId: string }) {
  const t = useT();
  const f = useFormat();
  const locale = useLocale();
  const api = useApiClient();
  const toast = useToast();
  const queryClient = useQueryClient();
  const args = { path: { inquiry_id: inquiryId } };
  const q = useApiQuery('inquiries.get', args);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = (inquiry?: StockInquiry) => {
    if (inquiry) queryClient.setQueryData(apiQueryKey('inquiries.get', args), (old: typeof q.data) => (old ? { ...old, inquiry } : old));
    void queryClient.invalidateQueries({ queryKey: apiQueryKey('inquiries.get', args) });
    void queryClient.invalidateQueries({ queryKey: ['inquiries.list'] });
  };
  const failed = (err: unknown) =>
    setError(
      err instanceof ApiProblem && err.code === 'INVALID_TRANSITION'
        ? t('activity.inquiry.closed')
        : err instanceof ApiProblem && err.status === 429
          ? t('settings.errors.tooMany')
          : t('settings.errors.failed'),
    );

  if (!q.data) {
    if (q.status === 'pending') return <SkeletonCard lines={5} />;
    return (
      <StateView
        kind={stateFromProblem(q.error)}
        t={t}
        action={
          <Link href={`/${locale}/activity?tab=inquiries`} className="pwa-link">
            {t('activity.inquiry.back')}
          </Link>
        }
      />
    );
  }
  const { inquiry: i, messages } = q.data;
  const can = inquiryActions(i);
  const v = i.vehicle_context_snapshot;

  const send = async (e: FormEvent) => {
    e.preventDefault();
    const text = body.trim();
    if (!text) return;
    setBusy('send');
    setError(null);
    try {
      await api.api('inquiries.message', { path: { inquiry_id: i.id }, body: { body: text, content_locale: locale } });
      setBody('');
      refresh();
    } catch (err) {
      failed(err);
    } finally {
      setBusy(null);
    }
  };

  const transition = async (to: 'cancelled' | 'completed') => {
    setBusy(to);
    setError(null);
    try {
      refresh(await api.api('inquiries.transition', { path: { inquiry_id: i.id }, body: { to } }));
      toast(t(to === 'completed' ? 'activity.inquiry.pickedUpToast' : 'activity.inquiry.cancelledToast'));
    } catch (err) {
      failed(err);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="pwa-activity">
      <Link href={`/${locale}/activity?tab=inquiries`} className="pwa-link">
        {t('activity.inquiry.back')}
      </Link>
      <div className="pwa-stack-xs">
        <h1 className="pwa-text-title m-0" dir="auto">
          {i.inventory_item.name.text}
        </h1>
        <p className="pwa-text-body m-0">
          <bdi>{i.vendor.name}</bdi> · <InquiryStatusBadge inquiry={i} />
        </p>
        {i.status === 'reserved' && i.reserved_until ? (
          <p className="pwa-text-caption m-0">{t('activity.inquiry.reservedUntil', { date: f.date(i.reserved_until) })}</p>
        ) : null}
        <p className="pwa-text-caption m-0">
          {t('activity.inquiry.sentOn', { date: f.date(i.created_at) })}
          {i.quantity ? ` · ${t('activity.inquiry.quantity', { count: i.quantity })}` : ''}
        </p>
        {v ? (
          <p className="pwa-text-caption m-0">
            {t('activity.inquiry.vehicle')}{' '}
            <bdi>{[v.brand.text, v.model.text, v.series?.text, f.digits(v.year)].filter(Boolean).join(' ')}</bdi>
          </p>
        ) : null}
      </div>
      <section className="pwa-stack-sm" aria-labelledby="inquiry-thread">
        <h2 id="inquiry-thread" className="pwa-section-title">
          {t('activity.inquiry.messages')}
        </h2>
        <Thread messages={messages} />
        {can.message ? (
          <form className="pwa-stack-sm" onSubmit={send} noValidate>
            <TextField
              multiline
              rows={3}
              label={t('activity.inquiry.reply')}
              value={body}
              maxLength={MAX_MESSAGE}
              onChange={(e) => setBody(e.target.value)}
            />
            <div>
              <Button type="submit" variant="primary" size="sm" icon="send" loading={busy === 'send'} disabled={!body.trim()}>
                {t('activity.inquiry.send')}
              </Button>
            </div>
          </form>
        ) : (
          <p className="pwa-text-caption m-0">{t('activity.inquiry.closed')}</p>
        )}
      </section>
      {error ? (
        <p className="pwa-error-text m-0" role="alert">
          {error}
        </p>
      ) : null}
      {can.cancel || can.pickedUp ? (
        <div className="pwa-inline-buttons">
          {can.pickedUp ? (
            <Button icon="check" loading={busy === 'completed'} onClick={() => void transition('completed')}>
              {t('activity.inquiry.pickedUp')}
            </Button>
          ) : null}
          {can.cancel ? (
            <Button variant="ghost" icon="close" loading={busy === 'cancelled'} onClick={() => void transition('cancelled')}>
              {t('activity.inquiry.cancel')}
            </Button>
          ) : null}
        </div>
      ) : null}
      {i.can_review && i.vendor.slug ? (
        <div>
          <Link
            href={reviewHref(locale, i.vendor.slug, { as: 'vendor', inquiry: i.id })}
            className={buttonClass({ variant: 'primary', size: 'sm' })}
            data-testid="review-seller"
          >
            <span className="cp-btn-label">{t('reviews.form.reviewSeller')}</span>
          </Link>
        </div>
      ) : null}
    </div>
  );
}
