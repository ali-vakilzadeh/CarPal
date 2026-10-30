'use client';
// W-ME-01 My Activity → Reviews (mirrors C-PROF-06 Reviews; P11.T5): the open in-app review invitations ("How was
// your visit?" → the review page with the visit) above the caller's reviews in every status (reviews.mine_list):
// Being checked, Waiting for approval, Proof requested (a reviewer asked for evidence or the business objected),
// Published, Not published / Removed with the reason, Withdrawn. Actions: Edit (before publication), Add evidence
// (reviews.evidence_add, review_evidence: visible to CarPal staff only), Withdraw (reviews.mine_withdraw), Appeal
// (disputes.create mediation_request on the review; disputes.mine_list shows its status, withdrawable while open)
// and View on profile. The author's Review names its shop by id only (DI-66): names come from this browser's
// memory of reviews written here and from the user's past appointments and stock inquiries.
import type { Dispute, Review, ReviewInvitation } from '@carpal/api-contracts';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { Badge } from '@/components/ds/badge';
import { Button, buttonClass } from '@/components/ds/button';
import { Icon } from '@/components/ds/icon';
import { TextField } from '@/components/ds/text-field';
import { Dialog } from '@/components/shell/dialog';
import { SkeletonList } from '@/components/shell/skeleton';
import { StateView, stateFromProblem } from '@/components/shell/states';
import { useToast } from '@/components/shell/toast';
import { releaseGroup, uploadsOf, UploadZone, useUploads, whenReady } from '@/features/media';
import { useApiClient, useApiInfiniteQuery, useApiQuery } from '@/lib/api/query';
import { useBrowserValue } from '@/lib/browser-value';
import { ApiProblem } from '@/lib/api/problem';
import { useFormat } from '@/lib/format/client';
import { useLocale, useT } from '@/lib/i18n/client';
import type { MessageKey } from '@/lib/i18n/keys';
import { sellerPath, shopPath } from '@/lib/seo/urls';
import {
  authorStatus,
  canAppeal,
  canWithdraw,
  invitationHref,
  isEditable,
  reasonKey,
  reviewHeld,
  reviewHref,
  STATUS_TONE,
  type AuthorStatus,
  type SubjectType,
} from './model';
import { knownOrgsSnapshot, parseKnownOrgs, type KnownOrg } from './storage';

const STATUS_LABEL: Record<AuthorStatus, MessageKey> = {
  draft: 'reviews.status.draft',
  checking: 'reviews.status.checking',
  waiting: 'reviews.status.waiting',
  evidence: 'reviews.status.evidence',
  published: 'reviews.status.published',
  rejected: 'reviews.status.rejected',
  removed: 'reviews.status.removed',
  withdrawn: 'reviews.status.withdrawn',
};

const OPEN_DISPUTE = new Set<Dispute['status']>(['open', 'in_mediation']);
const APPEAL_MIN = 10;

/** Shop names by organization id: remembered here, then the user's past appointments and inquiries. */
function useShopNames(): Map<string, KnownOrg> {
  const past = useApiQuery('appointments.list', { query: { group: 'past', limit: 50 } }, { staleTime: 60_000, retry: false });
  const inquiries = useApiQuery('inquiries.list', { query: { limit: 50 } }, { staleTime: 60_000, retry: false });
  const raw = useBrowserValue(knownOrgsSnapshot, '');
  return useMemo(() => {
    const remembered = parseKnownOrgs(raw);
    const m = new Map<string, KnownOrg>();
    for (const a of past.data?.items ?? []) m.set(a.provider.id, { name: a.provider.name, slug: a.provider.slug, as: 'provider' });
    for (const i of inquiries.data?.items ?? []) m.set(i.vendor.id, { name: i.vendor.name, slug: i.vendor.slug, as: 'vendor' });
    for (const [id, o] of Object.entries(remembered)) m.set(id, o);
    return m;
  }, [past.data, inquiries.data, raw]);
}

export function ActivityReviews({ highlight }: { highlight?: string | null }) {
  const t = useT();
  const locale = useLocale();
  const invitations = useApiQuery('review_invitations.mine_list', { query: { limit: 20 } }, { staleTime: 30_000 });
  const list = useApiInfiniteQuery('reviews.mine_list', { query: { limit: 20 } });
  const disputes = useApiQuery('disputes.mine_list', { query: { limit: 50 } }, { staleTime: 30_000, retry: false });
  const names = useShopNames();
  const items = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);
  const appeals = useMemo(() => {
    const m = new Map<string, Dispute>();
    for (const d of disputes.data?.items ?? []) if (d.target.type === 'review' && !m.has(d.target.id)) m.set(d.target.id, d);
    return m;
  }, [disputes.data]);

  useEffect(() => {
    if (!highlight || !items.some((r) => r.id === highlight)) return;
    document.getElementById(`my-review-${highlight}`)?.scrollIntoView?.({ block: 'center' });
  }, [highlight, items]);

  const invites = (invitations.data?.items ?? []).filter((i) => ['sent', 'opened', 'reminded', 'pending'].includes(i.status));

  return (
    <div className="pwa-stack">
      {invites.length ? (
        <section className="pwa-stack-sm" aria-labelledby="review-invitations">
          <h2 id="review-invitations" className="pwa-section-title">
            {t('reviews.activity.invitations')}
          </h2>
          <ul className="pwa-plain-list pwa-stack-sm">
            {invites.map((i) => (
              <InvitationRow key={i.id} invitation={i} />
            ))}
          </ul>
        </section>
      ) : null}
      <section className="pwa-stack-sm" aria-labelledby="my-reviews">
        <h2 id="my-reviews" className="pwa-section-title">
          {t('reviews.activity.title')}
        </h2>
        {list.status === 'pending' ? (
          <SkeletonList count={3} label={t('reviews.activity.title')} />
        ) : list.status === 'error' ? (
          <StateView
            kind={stateFromProblem(list.error)}
            t={t}
            compact
            action={
              <Button size="sm" onClick={() => void list.refetch()}>
                {t('common.actions.retry')}
              </Button>
            }
          />
        ) : items.length === 0 ? (
          <StateView
            kind="empty"
            t={t}
            compact
            title={t('reviews.activity.emptyTitle')}
            text={t('reviews.activity.emptyText')}
            action={
              <Link href={`/${locale}/appointments?seg=past`} className={buttonClass({ size: 'sm' })}>
                <span className="cp-btn-label">{t('reviews.activity.pastVisits')}</span>
              </Link>
            }
          />
        ) : (
          <ul className="pwa-plain-list pwa-stack-sm" data-testid="my-reviews">
            {items.map((r) => (
              <ReviewRow
                key={r.id}
                review={r}
                org={names.get(r.subject_organization_id) ?? null}
                appeal={appeals.get(r.id) ?? null}
                highlighted={highlight === r.id}
                onChanged={() => {
                  void list.refetch();
                  void disputes.refetch();
                }}
              />
            ))}
          </ul>
        )}
        {list.hasNextPage ? (
          <Button size="sm" variant="ghost" loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
            {t('common.actions.loadMore')}
          </Button>
        ) : null}
      </section>
    </div>
  );
}

function InvitationRow({ invitation: i }: { invitation: ReviewInvitation }) {
  const t = useT();
  const f = useFormat();
  const locale = useLocale();
  const href = invitationHref(locale, i);
  return (
    <li className="pwa-attention-card is-signal" data-testid="review-invitation">
      <div className="pwa-stack-xs">
        <p className="pwa-text-body m-0">
          {i.visit.type === 'stock_inquiry'
            ? t('reviews.activity.inviteVendor', { name: i.subject.name })
            : t('reviews.activity.invite', { name: i.subject.name })}
        </p>
        {i.expires_at ? (
          <p className="pwa-text-caption m-0">{t('reviews.activity.inviteUntil', { date: f.date(i.expires_at, 'date') })}</p>
        ) : null}
      </div>
      {href ? (
        <Link href={href} className={buttonClass({ size: 'sm', variant: 'primary' })}>
          <span className="cp-btn-label">{t('reviews.activity.write')}</span>
        </Link>
      ) : null}
    </li>
  );
}

function statusText(r: Review, vendor: boolean): MessageKey {
  const s = authorStatus(r);
  if (s === 'checking') return reviewHeld(r.title, r.body) ? 'reviews.statusText.checkingTeam' : 'reviews.statusText.checking';
  if (s === 'waiting')
    return r.business_confirmation_status === 'confirmed' || r.business_confirmation_status === 'no_response'
      ? 'reviews.statusText.reviewer'
      : vendor
        ? 'reviews.statusText.waitingVendor'
        : 'reviews.statusText.waiting';
  if (s === 'evidence')
    return r.business_confirmation_status === 'rejected' ? 'reviews.statusText.objected' : 'reviews.statusText.evidence';
  return `reviews.statusText.${s}` as MessageKey;
}

function ReviewRow(o: { review: Review; org: KnownOrg | null; appeal: Dispute | null; highlighted: boolean; onChanged: () => void }) {
  const t = useT();
  const f = useFormat();
  const locale = useLocale();
  const r = o.review;
  const vendor = r.subject_type === 'vendor';
  const s = authorStatus(r);
  const reason = reasonKey(r.reviewer_reason_code);
  const slug = o.org?.slug ?? null;
  const as: SubjectType = vendor ? 'vendor' : 'provider';
  const profile = slug ? (vendor ? sellerPath(locale, slug) : shopPath(locale, slug)) : null;
  const [dialog, setDialog] = useState<'withdraw' | 'appeal' | 'evidence' | null>(null);
  const name = o.org?.name ?? (vendor ? t('reviews.activity.aSeller') : t('reviews.activity.aShop'));
  const openAppeal = o.appeal && OPEN_DISPUTE.has(o.appeal.status) ? o.appeal : null;
  return (
    <li
      id={`my-review-${r.id}`}
      className={`pwa-my-review${o.highlighted ? ' is-highlighted' : ''}`}
      data-testid="my-review"
      tabIndex={o.highlighted ? -1 : undefined}
    >
      <div className="pwa-my-review-head">
        <div className="pwa-stack-xs">
          <span className="pwa-text-label">
            {profile ? (
              <Link href={profile} className="pwa-link">
                <bdi>{name}</bdi>
              </Link>
            ) : (
              <bdi>{name}</bdi>
            )}
          </span>
          <span className="pwa-text-caption">
            {t('reviews.activity.written', { date: f.date(r.created_at, 'date') })}
            {r.published_at ? ` · ${t('reviews.activity.publishedOn', { date: f.date(r.published_at, 'date') })}` : ''}
          </span>
        </div>
        <Badge tone={STATUS_TONE[s]} icon={s === 'published' ? 'check' : s === 'rejected' || s === 'removed' ? 'alert' : 'clock'}>
          {t(STATUS_LABEL[s])}
        </Badge>
      </div>
      <p className="pwa-rating m-0" role="img" aria-label={t('profiles.rating.stars', { value: f.number(r.overall_rating) })}>
        {Array.from({ length: 5 }, (_, i) => (
          <Icon key={i} name="star" size={16} filled={i < r.overall_rating} className={i < r.overall_rating ? 'cp-star' : 'pwa-star-off'} />
        ))}
      </p>
      {r.title ? (
        <p className="pwa-text-label m-0" dir="auto" lang={r.content_locale}>
          {r.title}
        </p>
      ) : null}
      <p className="pwa-text-body pwa-user-text pwa-clamp-3 m-0" dir="auto" lang={r.content_locale}>
        {r.body}
      </p>
      <p className="pwa-text-caption m-0">
        {t(statusText(r, vendor))}
        {reason && (s === 'rejected' || s === 'removed') ? ` ${t('reviews.activity.reason', { reason: t(reason) })}` : ''}
      </p>
      {s === 'published' ? (
        <p className="pwa-text-caption m-0">
          {r.confirmation_path === 'visit_based'
            ? vendor
              ? t('profiles.reviews.label.verified_purchase')
              : t('profiles.reviews.label.verified_visit')
            : t('profiles.reviews.label.approved_by_business_and_carpal')}
          {r.helpful_count ? ` · ${t('profiles.reviews.helpfulCount', { count: r.helpful_count })}` : ''}
          {r.response ? ` · ${t('reviews.activity.replied')}` : ''}
          {r.disputed_by_business ? ` · ${t('profiles.reviews.disputed')}` : ''}
        </p>
      ) : null}
      {o.appeal ? (
        <p className="pwa-text-caption m-0" data-testid="review-appeal">
          {t(`reviews.appeal.status.${o.appeal.status}`)}
          {o.appeal.resolution ? ` — ${o.appeal.resolution}` : ''}
        </p>
      ) : null}
      <div className="pwa-inline-buttons">
        {isEditable(r) && slug ? (
          <Link href={reviewHref(locale, slug, { as, edit: r.id })} className={buttonClass({ size: 'sm' })}>
            <span className="cp-btn-label">{t('reviews.activity.edit')}</span>
          </Link>
        ) : null}
        {r.can_add_evidence ? (
          <Button size="sm" icon="attach" onClick={() => setDialog('evidence')}>
            {t('reviews.evidence.add')}
          </Button>
        ) : null}
        {canAppeal(r) && !openAppeal ? (
          <Button size="sm" icon="flag" onClick={() => setDialog('appeal')}>
            {t('reviews.appeal.button')}
          </Button>
        ) : null}
        {openAppeal ? <WithdrawAppeal dispute={openAppeal} onDone={o.onChanged} /> : null}
        {s === 'published' && profile ? (
          <Link href={`${profile}#reviews`} className={buttonClass({ size: 'sm', variant: 'ghost' })}>
            <span className="cp-btn-label">{t('reviews.done.profile')}</span>
          </Link>
        ) : null}
        {canWithdraw(r) ? (
          <Button size="sm" variant="ghost" icon="trash" onClick={() => setDialog('withdraw')}>
            {t('reviews.withdraw.button')}
          </Button>
        ) : null}
      </div>
      {dialog === 'withdraw' ? <WithdrawDialog review={r} onClose={() => setDialog(null)} onDone={o.onChanged} /> : null}
      {dialog === 'appeal' ? <AppealDialog review={r} onClose={() => setDialog(null)} onDone={o.onChanged} /> : null}
      {dialog === 'evidence' ? <EvidenceDialog review={r} onClose={() => setDialog(null)} onDone={o.onChanged} /> : null}
    </li>
  );
}

function WithdrawDialog({ review, onClose, onDone }: { review: Review; onClose: () => void; onDone: () => void }) {
  const t = useT();
  const api = useApiClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const go = async () => {
    setBusy(true);
    setFailed(false);
    try {
      await api.api('reviews.mine_withdraw', { path: { review_id: review.id } });
      toast(t('reviews.withdraw.done'));
      onClose();
      onDone();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('reviews.withdraw.title')}
      footer={
        <div className="pwa-inline-buttons">
          <Button variant="danger" loading={busy} onClick={() => void go()}>
            {t('reviews.withdraw.confirm')}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            {t('reviews.withdraw.keep')}
          </Button>
        </div>
      }
    >
      <p className="pwa-text-body">{review.status === 'published' ? t('reviews.withdraw.textPublished') : t('reviews.withdraw.text')}</p>
      {failed ? (
        <p className="pwa-error-text" role="alert">
          {t('reviews.errors.failed')}
        </p>
      ) : null}
    </Dialog>
  );
}

function AppealDialog({ review, onClose, onDone }: { review: Review; onClose: () => void; onDone: () => void }) {
  const t = useT();
  const f = useFormat();
  const api = useApiClient();
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);
  const short = [...reason.trim()].length < APPEAL_MIN;
  const go = async () => {
    setTried(true);
    if (short) return;
    setBusy(true);
    setError(null);
    try {
      await api.api('disputes.create', {
        body: { target: { type: 'review', id: review.id }, dispute_type: 'mediation_request', reason: reason.trim() },
      });
      toast(t('reviews.appeal.sent'));
      onClose();
      onDone();
    } catch (err) {
      setError(err instanceof ApiProblem && err.code === 'DUPLICATE' ? 'reviews.appeal.duplicate' : 'reviews.errors.failed');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('reviews.appeal.title')}
      footer={
        <div className="pwa-inline-buttons">
          <Button variant="primary" icon="send" loading={busy} onClick={() => void go()}>
            {t('reviews.appeal.send')}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            {t('common.actions.cancel')}
          </Button>
        </div>
      }
    >
      <p className="pwa-text-body">{t('reviews.appeal.text')}</p>
      <TextField
        multiline
        rows={4}
        label={t('reviews.appeal.reason')}
        value={reason}
        maxLength={2000}
        onChange={(e) => setReason(e.target.value)}
        hint={t('reviews.appeal.hint', { min: f.number(APPEAL_MIN) })}
        error={tried && short ? t('reviews.appeal.short', { min: f.number(APPEAL_MIN) }) : undefined}
      />
      {error ? (
        <p className="pwa-error-text" role="alert">
          {t(error)}
        </p>
      ) : null}
    </Dialog>
  );
}

function WithdrawAppeal({ dispute, onDone }: { dispute: Dispute; onDone: () => void }) {
  const t = useT();
  const api = useApiClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      await api.api('disputes.withdraw', { path: { dispute_id: dispute.id } });
      toast(t('reviews.appeal.withdrawn'));
      onDone();
    } catch {
      toast(t('reviews.errors.failed'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button size="sm" variant="ghost" loading={busy} onClick={() => void go()}>
      {t('reviews.appeal.withdraw')}
    </Button>
  );
}

function EvidenceDialog({ review, onClose, onDone }: { review: Review; onClose: () => void; onDone: () => void }) {
  const t = useT();
  const api = useApiClient();
  const toast = useToast();
  const group = `review-evidence:${review.id}`;
  const uploads = useUploads(group);
  const pending = uploads.some((u) => u.state.phase !== 'ready' && u.state.phase !== 'failed');
  const ready = uploads.some((u) => u.state.phase === 'ready');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);
  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      const assets = await Promise.all(uploadsOf(group).map((u) => whenReady(u.id)));
      const ids = assets.filter((a): a is NonNullable<typeof a> => !!a).map((a) => a.id);
      if (!ids.length) return;
      await api.api('reviews.evidence_add', { path: { review_id: review.id }, body: { media_ids: ids.slice(0, 10) } });
      releaseGroup(group);
      toast(t('reviews.evidence.done'));
      onClose();
      onDone();
    } catch (err) {
      setError(
        err instanceof ApiProblem && err.code === 'MEDIA_NOT_READY'
          ? 'reviews.evidence.notReady'
          : err instanceof ApiProblem && err.code === 'INVALID_TRANSITION'
            ? 'reviews.evidence.closed'
            : 'reviews.errors.failed',
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('reviews.evidence.title')}
      footer={
        <div className="pwa-inline-buttons">
          <Button variant="primary" loading={busy} disabled={pending || !ready} onClick={() => void go()}>
            {t('reviews.evidence.send')}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            {t('common.actions.cancel')}
          </Button>
        </div>
      }
    >
      <p className="pwa-text-body">{t('reviews.evidence.text')}</p>
      <UploadZone group={group} purpose="review_evidence" label={t('reviews.evidence.files')} hint={t('reviews.evidence.hint')} />
      {error ? (
        <p className="pwa-error-text" role="alert">
          {t(error)}
        </p>
      ) : null}
    </Dialog>
  );
}
