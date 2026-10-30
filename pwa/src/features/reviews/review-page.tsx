'use client';
// W-REV-01 Write Review (mirrors C-REV-01/02) and W-REV-03 Write Vendor Review (C-REV-04) at
// /<locale>/review/<slug>[?as=vendor&appointment|inquiry|record=<id>&invite=1&edit=<review id>], signed in (P11.T1/T3).
// reviews.eligibility decides the form: the visit the link names (or the first inside its 7-day window) makes it
// Path 1 "Verified visit" / "Verified purchase"; no visit, or the window passed (the visit is attached), makes it
// Path 2 with "Send for approval". An emailed invitation arrives with a grant from /l/ri (storage.ts) that fixes the
// path. Left column: context header, overall stars, sub-ratings (radio groups: arrow keys), would-return, title, text
// (10-5000), photos; right column: tips, the privacy check (plates, phones, emails, links → Remove / Keep), tags
// (review_tag nodes for the subject; those taxonomy.suggest finds in the text are marked Suggested, only kept ones are
// sent) and "Shown as Sara M.". The draft is kept per shop in this browser. After sending, a confirmation panel
// replaces the form (C-REV-02). ?edit= edits an unpublished review (reviews.mine_update, ETag).
import type { ConfirmationPath, Eligibility, PublicOrgProfile, Review, TaxonomyNode } from '@carpal/api-contracts';
import Link from 'next/link';
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { Badge } from '@/components/ds/badge';
import { Banner } from '@/components/ds/banner';
import { Button, buttonClass } from '@/components/ds/button';
import { Chip } from '@/components/ds/chip';
import { Icon } from '@/components/ds/icon';
import { TextField } from '@/components/ds/text-field';
import { SkeletonCard } from '@/components/shell/skeleton';
import { StateView, stateFromProblem } from '@/components/shell/states';
import { releaseGroup, uploadsOf, UploadZone, useUploads, whenReady } from '@/features/media';
import { useApiClient, useApiQuery } from '@/lib/api/query';
import { useSession } from '@/lib/api/session';
import { useTaxonomyNodes } from '@/lib/config/taxonomy';
import { useFormat } from '@/lib/format/client';
import { useLocale, useT } from '@/lib/i18n/client';
import type { MessageKey } from '@/lib/i18n/keys';
import { sellerPath, shopPath } from '@/lib/seo/urls';
import {
  BODY_MAX,
  BODY_MIN,
  createBody,
  dimensionsOf,
  draftOf,
  draftProblems,
  EMPTY_DRAFT,
  findingKey,
  formMode,
  MAX_TAGS,
  privacyFindings,
  removeFinding,
  requestedVisitId,
  reviewHeld,
  reviewHref,
  subjectOf,
  submitOutcome,
  tagsFor,
  TITLE_MAX,
  updateBody,
  type Candidate,
  type ReviewDraft,
  type ReviewPageQuery,
  type SubjectType,
  type SubmitOutcome,
} from './model';
import { dropDraft, dropGrant, grantFor, readDraft, rememberOrg, saveDraft, type StoredGrant } from './storage';
import { StarInput } from './stars';

const GROUP = (orgId: string) => `review:${orgId}`;
const SUGGEST_MIN = 20;
const SUGGEST_DEBOUNCE_MS = 600;

export interface ReviewPageProps {
  slug: string;
  query: ReviewPageQuery;
}

export function ReviewPage({ slug, query }: ReviewPageProps) {
  const t = useT();
  const profile = useApiQuery('public.org_get', { path: { slug } }, { retry: false });
  const p = profile.data;
  const subject = p ? subjectOf(p.roles, query.as) : null;
  const heading = subject === 'vendor' ? t('reviews.form.vendorHeading') : t('reviews.form.heading');

  if (profile.status === 'pending') return <PageFrame heading={heading} busy />;
  if (profile.status === 'error' || !p || !subject)
    return (
      <PageFrame heading={heading}>
        <StateView
          kind={profile.error ? stateFromProblem(profile.error) : 'notFound'}
          t={t}
          title={t('reviews.form.noSubject')}
          text={t('reviews.form.noSubjectText')}
        />
      </PageFrame>
    );
  return <ReviewLoader profile={p} subject={subject} query={query} />;
}

function PageFrame({ heading, busy, children }: { heading: string; busy?: boolean; children?: ReactNode }) {
  return (
    <div className="pwa-review-page">
      <h1 className="pwa-text-title m-0">{heading}</h1>
      {busy ? <SkeletonCard lines={6} /> : children}
    </div>
  );
}

function ReviewLoader({ profile: p, subject, query }: { profile: PublicOrgProfile; subject: SubjectType; query: ReviewPageQuery }) {
  const t = useT();
  const locale = useLocale();
  const [grant] = useState<StoredGrant | null>(() => (query.invite ? grantFor(p.id) : null));
  const eligibility = useApiQuery('reviews.eligibility', { body: { subject_organization_id: p.id } }, { staleTime: 0, retry: false });
  const editing = useApiQuery('reviews.mine_get', query.edit ? { path: { review_id: query.edit } } : undefined, {
    enabled: !!query.edit,
    retry: false,
  });
  const heading = subject === 'vendor' ? t('reviews.form.vendorHeading') : t('reviews.form.heading');

  if (query.edit) {
    if (editing.status === 'pending') return <PageFrame heading={heading} busy />;
    if (editing.status === 'error' || !editing.data)
      return (
        <PageFrame heading={heading}>
          <StateView kind={editing.error ? stateFromProblem(editing.error) : 'notFound'} t={t} />
        </PageFrame>
      );
    const r = editing.data;
    if (r.status !== 'draft' && r.status !== 'pending_moderation' && r.status !== 'pending_approval')
      return (
        <PageFrame heading={t('reviews.form.editHeading')}>
          <StateView
            kind="empty"
            t={t}
            title={t('reviews.form.notEditable')}
            text={t('reviews.form.notEditableText')}
            action={
              <Link href={`/${locale}/activity?tab=reviews`} className={buttonClass({ variant: 'secondary' })}>
                <span className="cp-btn-label">{t('reviews.done.activity')}</span>
              </Link>
            }
          />
        </PageFrame>
      );
    return (
      <ReviewForm
        profile={p}
        subject={(r.subject_type as SubjectType) ?? subject}
        path={r.confirmation_path ?? 'approval_based'}
        candidate={null}
        late={false}
        grant={null}
        editing={r}
      />
    );
  }

  if (eligibility.status === 'pending') return <PageFrame heading={heading} busy />;
  if (eligibility.status === 'error')
    return (
      <PageFrame heading={heading}>
        <StateView
          kind={stateFromProblem(eligibility.error)}
          t={t}
          action={<Button onClick={() => void eligibility.refetch()}>{t('common.actions.retry')}</Button>}
        />
      </PageFrame>
    );
  const mode = formMode(eligibility.data, requestedVisitId(query), grant?.path ?? null);
  if (mode.kind === 'blocked') return <Blocked profile={p} subject={subject} reason={mode.reason} />;
  return <ReviewForm profile={p} subject={subject} path={mode.path} candidate={mode.candidate} late={mode.late} grant={grant} />;
}

const BLOCKED: Record<NonNullable<Eligibility['reason_code']>, MessageKey> = {
  ok: 'reviews.blocked.subject_not_published',
  member_of_subject: 'reviews.blocked.member_of_subject',
  already_reviewed: 'reviews.blocked.already_reviewed',
  velocity_limit: 'reviews.blocked.velocity_limit',
  unverified_contact: 'reviews.blocked.unverified_contact',
  subject_not_published: 'reviews.blocked.subject_not_published',
};

function Blocked({ profile: p, subject, reason }: { profile: PublicOrgProfile; subject: SubjectType; reason: keyof typeof BLOCKED }) {
  const t = useT();
  const locale = useLocale();
  const action =
    reason === 'unverified_contact' ? (
      <Link href={`/${locale}/settings/profile`} className={buttonClass({ variant: 'primary' })}>
        <span className="cp-btn-label">{t('reviews.blocked.verifyContact')}</span>
      </Link>
    ) : reason === 'already_reviewed' ? (
      <Link href={`/${locale}/activity?tab=reviews`} className={buttonClass({ variant: 'primary' })}>
        <span className="cp-btn-label">{t('reviews.blocked.openReviews')}</span>
      </Link>
    ) : p.slug ? (
      <Link
        href={subject === 'vendor' ? sellerPath(locale, p.slug) : shopPath(locale, p.slug)}
        className={buttonClass({ variant: 'secondary' })}
      >
        <span className="cp-btn-label">{t('reviews.done.profile')}</span>
      </Link>
    ) : undefined;
  return (
    <PageFrame heading={subject === 'vendor' ? t('reviews.form.vendorHeading') : t('reviews.form.heading')}>
      <StateView kind="noAccess" t={t} title={t('reviews.blocked.title', { name: p.name })} text={t(BLOCKED[reason])} action={action} />
    </PageFrame>
  );
}

// ---------------------------------------------------------------------------------------------- context header

function useVisitLine(candidate: Candidate | null, grant: StoredGrant | null): string | null {
  const f = useFormat();
  const appointment = useApiQuery(
    'appointments.get',
    candidate?.type === 'appointment' ? { path: { appointment_id: candidate.id } } : undefined,
    { enabled: candidate?.type === 'appointment', retry: false, staleTime: 60_000 },
  );
  const inquiry = useApiQuery('inquiries.get', candidate?.type === 'stock_inquiry' ? { path: { inquiry_id: candidate.id } } : undefined, {
    enabled: candidate?.type === 'stock_inquiry',
    retry: false,
    staleTime: 60_000,
  });
  if (grant?.visit) {
    const v = grant.visit;
    return (
      [
        v.vehicle ? `${v.vehicle.brand.text} ${v.vehicle.model.text}` : null,
        v.service_system?.text,
        v.service_task?.text,
        v.service_date ? f.calendarDate(v.service_date) : null,
      ]
        .filter(Boolean)
        .join(' · ') || null
    );
  }
  if (appointment.data) {
    const a = appointment.data;
    return [`${a.vehicle.brand.text} ${a.vehicle.model.text}`, a.service_system?.text, candidate ? f.calendarDate(candidate.date) : null]
      .filter(Boolean)
      .join(' · ');
  }
  if (inquiry.data)
    return [inquiry.data.inquiry.inventory_item.name.text, candidate ? f.calendarDate(candidate.date) : null].filter(Boolean).join(' · ');
  return candidate ? f.calendarDate(candidate.date) : null;
}

function ContextHeader(o: {
  name: string;
  subject: SubjectType;
  path: ConfirmationPath;
  candidate: Candidate | null;
  late: boolean;
  grant: StoredGrant | null;
}) {
  const t = useT();
  const f = useFormat();
  const line = useVisitLine(o.candidate, o.grant);
  const vendor = o.subject === 'vendor';
  if (o.path === 'visit_based')
    return (
      <div className="pwa-review-context" data-testid="review-context">
        <Badge tone="success" icon="check">
          {vendor ? t('reviews.context.verifiedPurchase') : t('reviews.context.verifiedVisit')}
        </Badge>
        <p className="pwa-text-body m-0">
          {line ? <>{line} · </> : null}
          <bdi>{o.name}</bdi>
        </p>
      </div>
    );
  return (
    <Banner
      tone="plain"
      icon="info"
      title={vendor ? t('reviews.context.noInquiry') : t('reviews.context.noAppointment')}
      text={
        o.late && o.candidate
          ? t('reviews.context.late', { date: f.calendarDate(o.candidate.date) })
          : o.grant
            ? t('reviews.context.invitedApproval', { name: o.name })
            : vendor
              ? t('reviews.context.approvalVendor')
              : t('reviews.context.approval')
      }
    />
  );
}

// ---------------------------------------------------------------------------------------------- the form

function useTagSuggestions(body: string): Set<string> {
  const [text, setText] = useState('');
  useEffect(() => {
    const v = body.trim();
    const timer = setTimeout(() => setText([...v].length >= SUGGEST_MIN ? v.slice(0, 500) : ''), SUGGEST_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [body]);
  const q = useApiQuery('taxonomy.suggest', text ? { body: { text, types: ['review_tag'] } } : undefined, {
    enabled: !!text,
    staleTime: 5 * 60_000,
    retry: false,
  });
  return useMemo(() => new Set((q.data?.items ?? []).map((s) => s.node.id)), [q.data]);
}

interface FormProps {
  profile: PublicOrgProfile;
  subject: SubjectType;
  path: ConfirmationPath;
  candidate: Candidate | null;
  late: boolean;
  grant: StoredGrant | null;
  editing?: Review;
}

function ReviewForm(o: FormProps) {
  const t = useT();
  const f = useFormat();
  const locale = useLocale();
  const api = useApiClient();
  const session = useSession();
  const user = session.data?.user ?? null;
  const p = o.profile;
  const vendor = o.subject === 'vendor';
  const draftKey = o.editing ? `edit:${o.editing.id}` : p.id;
  const initial = useMemo(() => (o.editing ? draftOf(o.editing) : EMPTY_DRAFT), [o.editing]);
  // The form mounts in the browser only (after the eligibility read), so the saved draft is read once, here.
  const [draft, setDraft] = useState<ReviewDraft>(() => (user ? readDraft(user.id, draftKey) : null) ?? initial);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<SubmitOutcome | null>(null);
  const [existing, setExisting] = useState<Review | null>(null);
  const [kept, setKept] = useState<Set<string>>(new Set());
  const [done, setDone] = useState<Review | null>(null);
  const group = GROUP(p.id);
  const uploads = useUploads(group);
  const uploading = uploads.some((u) => u.state.phase !== 'ready' && u.state.phase !== 'failed');
  const tagNodes = useTaxonomyNodes('review_tag');
  const tags = useMemo(() => tagsFor(tagNodes.data ?? [], o.subject), [tagNodes.data, o.subject]);
  const suggested = useTagSuggestions(draft.body);

  // Typing saves the draft (C-REV-01 "Draft saved").
  useEffect(() => {
    if (!user || done || draft === initial) return;
    const timer = setTimeout(() => {
      saveDraft(user.id, draftKey, draft);
      setSavedAt(Date.now());
    }, 800);
    return () => clearTimeout(timer);
  }, [draft, user, done, draftKey, initial]);

  const set = <K extends keyof ReviewDraft>(k: K, v: ReviewDraft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const problems = draftProblems(draft);
  // The privacy check per field (lines count within the review text); the title's findings come first.
  const findings = [
    ...privacyFindings(draft.title).map((x) => ({ ...x, field: 'title' as const })),
    ...privacyFindings(draft.body).map((x) => ({ ...x, field: 'body' as const })),
  ].filter((x) => !kept.has(findingKey(x)));
  const bodyLength = [...draft.body.trim()].length;
  const approval = o.path === 'approval_based';
  const held = reviewHeld(draft.title, draft.body);

  const removeIt = (x: (typeof findings)[number]) => set(x.field, removeFinding(draft[x.field], x));

  const toggleTag = (id: string) =>
    setDraft((d) => ({
      ...d,
      tags: d.tags.includes(id) ? d.tags.filter((x) => x !== id) : d.tags.length >= MAX_TAGS ? d.tags : [...d.tags, id],
    }));

  const finish = (r: Review) => {
    if (user) dropDraft(user.id, draftKey);
    if (p.slug) rememberOrg(p.id, { name: p.name, slug: p.slug, as: o.subject });
    if (o.grant) dropGrant();
    releaseGroup(group);
    setDone(r);
    window.scrollTo?.({ top: 0 });
  };

  const findExisting = async () => {
    const ctxId = o.candidate?.id;
    try {
      const mine = await api.api('reviews.mine_list', { query: { limit: 50 } });
      setExisting(
        mine.items.find(
          (r) =>
            r.subject_organization_id === p.id &&
            (!ctxId || r.context_appointment_id === ctxId || r.context_stock_inquiry_id === ctxId || r.context_service_record_id === ctxId),
        ) ?? null,
      );
    } catch {
      setExisting(null);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    setProblem(null);
    if (problems.length || uploading || busy) {
      if (problems.includes('bodyShort') || problems.includes('bodyLong')) document.getElementById('review-body')?.focus();
      return;
    }
    setBusy(true);
    try {
      if (o.editing) {
        const path = `/v1/me/reviews/${o.editing.id}`;
        const r = await api.api('reviews.mine_update', {
          path: { review_id: o.editing.id },
          body: updateBody(initial, draft, o.subject),
          ifMatch: api.etags.get(path) ?? `"v${o.editing.version}"`,
        });
        finish(r);
        return;
      }
      const assets = await Promise.all(uploadsOf(group).map((u) => whenReady(u.id)));
      const mediaIds = assets.filter((a): a is NonNullable<typeof a> => !!a).map((a) => a.id);
      const r = await api.api('reviews.create', {
        body: createBody({ draft, subject: o.subject, orgId: p.id, candidate: o.candidate, grant: o.grant?.grant, locale, mediaIds }),
      });
      finish(r);
    } catch (err) {
      const out = submitOutcome(err);
      if (out.kind === 'grantExpired' || out.kind === 'linkUsed') dropGrant();
      if (out.kind === 'duplicate') void findExisting();
      setProblem(out);
    } finally {
      setBusy(false);
    }
  };

  if (done)
    return <Submitted review={done} profile={p} subject={o.subject} heldText={reviewHeld(done.title, done.body)} edited={!!o.editing} />;

  const heading = o.editing ? t('reviews.form.editHeading') : vendor ? t('reviews.form.vendorHeading') : t('reviews.form.heading');
  const profileHref = p.slug ? (vendor ? sellerPath(locale, p.slug) : shopPath(locale, p.slug)) : null;

  return (
    <div className="pwa-review-page">
      <div className="pwa-review-top">
        <h1 className="pwa-text-title m-0">{heading}</h1>
        {savedAt ? (
          <span className="pwa-text-caption" role="status">
            {t('reviews.form.draftSaved')}
          </span>
        ) : null}
      </div>
      <form className="pwa-review-cols" onSubmit={(e) => void submit(e)} noValidate aria-describedby="review-context-line">
        <div className="pwa-stack">
          <div id="review-context-line">
            {o.editing ? (
              <Banner tone="plain" icon="edit" title={t('reviews.form.editing', { name: p.name })} text={t('reviews.form.editingText')} />
            ) : (
              <ContextHeader name={p.name} subject={o.subject} path={o.path} candidate={o.candidate} late={o.late} grant={o.grant} />
            )}
          </div>
          <StarInput
            label={t('reviews.form.overall')}
            size="lg"
            required
            value={draft.overall}
            onChange={(v) => set('overall', v)}
            error={tried && problems.includes('overall') ? t('reviews.form.overallRequired') : null}
          />
          <fieldset className="pwa-review-sub">
            <legend className="pwa-text-label">{t('reviews.form.subRatings')}</legend>
            <p className="pwa-text-caption m-0">{t('reviews.form.subRatingsHint')}</p>
            {dimensionsOf(o.subject).map((dim) => (
              <StarInput
                key={dim}
                label={t(`profiles.reviews.sub.${dim}`)}
                value={draft.ratings[dim] ?? 0}
                clearable
                onChange={(v) => setDraft((d) => ({ ...d, ratings: { ...d.ratings, [dim]: v } }))}
              />
            ))}
            {!vendor ? (
              <div className="pwa-review-return" role="group" aria-labelledby="would-return">
                <span id="would-return" className="pwa-stars-legend">
                  {t('reviews.form.wouldReturn')}
                </span>
                <div className="pwa-chips">
                  <Chip selected={draft.wouldReturn === true} onClick={() => set('wouldReturn', draft.wouldReturn === true ? null : true)}>
                    {t('reviews.form.yes')}
                  </Chip>
                  <Chip
                    selected={draft.wouldReturn === false}
                    onClick={() => set('wouldReturn', draft.wouldReturn === false ? null : false)}
                  >
                    {t('reviews.form.no')}
                  </Chip>
                </div>
              </div>
            ) : null}
          </fieldset>
          <TextField
            label={t('reviews.form.title')}
            value={draft.title}
            maxLength={TITLE_MAX}
            onChange={(e) => set('title', e.target.value)}
            error={tried && problems.includes('title') ? t('reviews.form.titleInvalid') : undefined}
          />
          <TextField
            multiline
            id="review-body"
            label={t('reviews.form.body')}
            rows={7}
            value={draft.body}
            maxLength={BODY_MAX + 200}
            onChange={(e) => set('body', e.target.value)}
            hint={
              <>
                {vendor ? t('reviews.form.bodyHintVendor') : t('reviews.form.bodyHint')}{' '}
                <span aria-live="polite">{t('reviews.form.count', { n: f.number(bodyLength), max: f.number(BODY_MAX) })}</span>
              </>
            }
            error={
              tried && problems.includes('bodyShort')
                ? t('reviews.form.bodyShort', { min: f.number(BODY_MIN) })
                : problems.includes('bodyLong')
                  ? t('reviews.form.bodyLong', { max: f.number(BODY_MAX) })
                  : undefined
            }
          />
          {!o.editing ? (
            <section className="pwa-stack-sm" aria-labelledby="review-photos">
              <h2 id="review-photos" className="pwa-text-label m-0">
                {t('reviews.form.photos')}
              </h2>
              <UploadZone group={group} purpose="review_photo" label={t('reviews.form.addPhotos')} hint={t('reviews.form.photosHint')} />
            </section>
          ) : null}
          {problem ? (
            <SubmitProblem outcome={problem} existing={existing} profileHref={profileHref} slug={p.slug} subject={o.subject} />
          ) : null}
          <div className="pwa-review-submit">
            <Button type="submit" variant="primary" icon={approval && !o.editing ? 'send' : 'check'} loading={busy} disabled={uploading}>
              {uploading
                ? t('reviews.form.waitUploads')
                : o.editing
                  ? t('reviews.form.saveEdit')
                  : approval
                    ? t('reviews.form.sendForApproval')
                    : t('reviews.form.submit')}
            </Button>
            {profileHref ? (
              <Link href={profileHref} className={buttonClass({ variant: 'ghost' })}>
                <span className="cp-btn-label">{t('reviews.form.cancel')}</span>
              </Link>
            ) : null}
          </div>
        </div>
        <aside className="pwa-stack pwa-review-aside" aria-label={t('reviews.form.asideLabel')}>
          <section className="pwa-review-box" aria-labelledby="review-tips">
            <h2 id="review-tips" className="pwa-text-label m-0">
              {t('reviews.tips.title')}
            </h2>
            <ul className="pwa-review-tips">
              <li>{vendor ? t('reviews.tips.vendorWhat') : t('reviews.tips.what')}</li>
              <li>{t('reviews.tips.facts')}</li>
              <li>{t('reviews.tips.private')}</li>
              <li>{t('reviews.tips.rating')}</li>
            </ul>
          </section>
          <section className="pwa-review-box" aria-labelledby="review-privacy" aria-live="polite">
            <h2 id="review-privacy" className="pwa-text-label m-0">
              {t('reviews.privacy.title')}
            </h2>
            {findings.length === 0 ? (
              <p className="pwa-text-caption m-0">
                <Icon name="shield" size={16} /> {t('reviews.privacy.clear')}
              </p>
            ) : (
              <ul className="pwa-plain-list pwa-stack-sm" data-testid="privacy-findings">
                {findings.slice(0, 5).map((x) => (
                  <li key={`${x.field}:${x.kind}:${x.start}`} className="pwa-review-finding">
                    <p className="pwa-text-body m-0">
                      {t(`reviews.privacy.${x.kind}`, { line: f.number(x.line) })} <bdi className="pwa-review-match">{x.match}</bdi>
                    </p>
                    <div className="pwa-inline-buttons">
                      <Button size="sm" onClick={() => removeIt(x)}>
                        {t('reviews.privacy.remove')}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setKept((k) => new Set([...k, findingKey(x)]))}>
                        {t('reviews.privacy.keep')}
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {held && !approval ? <p className="pwa-text-caption m-0">{t('reviews.privacy.held')}</p> : null}
          </section>
          <TagPicker tags={tags} selected={draft.tags} suggested={suggested} onToggle={toggleTag} loading={tagNodes.isPending} />
          <p className="pwa-review-shown pwa-text-caption">
            <Icon name="user" size={16} /> {user ? t('reviews.form.shownAs', { name: user.display_name }) : t('reviews.form.shownAsYou')}
          </p>
        </aside>
      </form>
    </div>
  );
}

function TagPicker(o: {
  tags: TaxonomyNode[];
  selected: string[];
  suggested: Set<string>;
  onToggle: (id: string) => void;
  loading: boolean;
}) {
  const t = useT();
  if (!o.loading && o.tags.length === 0) return null;
  const suggested = o.tags.filter((n) => o.suggested.has(n.id));
  const rest = o.tags.filter((n) => !o.suggested.has(n.id));
  const chip = (n: TaxonomyNode, mark?: boolean) => (
    <Chip key={n.id} selected={o.selected.includes(n.id)} icon={mark ? 'spark' : undefined} onClick={() => o.onToggle(n.id)}>
      {n.name.text}
    </Chip>
  );
  return (
    <section className="pwa-review-box" aria-labelledby="review-tags">
      <h2 id="review-tags" className="pwa-text-label m-0">
        {t('reviews.tags.title')}
      </h2>
      <p className="pwa-text-caption m-0">{t('reviews.tags.hint')}</p>
      {suggested.length ? (
        <div className="pwa-chips" role="group" aria-label={t('reviews.tags.suggested')} data-testid="suggested-tags">
          {suggested.map((n) => chip(n, true))}
        </div>
      ) : null}
      <div className="pwa-chips" role="group" aria-label={t('reviews.tags.all')}>
        {rest.map((n) => chip(n))}
      </div>
    </section>
  );
}

function SubmitProblem(o: {
  outcome: SubmitOutcome;
  existing: Review | null;
  profileHref: string | null;
  slug: string | null;
  subject: SubjectType;
}) {
  const t = useT();
  const locale = useLocale();
  const x = o.outcome;
  const text: Record<Exclude<SubmitOutcome['kind'], 'notAllowed'>, MessageKey> = {
    contact: 'reviews.errors.contact',
    duplicate: 'reviews.errors.duplicate',
    grantExpired: 'reviews.errors.grantExpired',
    linkUsed: 'reviews.errors.linkUsed',
    changed: 'reviews.errors.changed',
    published: 'reviews.errors.published',
    invalid: 'reviews.errors.invalid',
    rateLimited: 'reviews.errors.rateLimited',
    offline: 'reviews.errors.offline',
    failed: 'reviews.errors.failed',
  };
  const message = x.kind === 'notAllowed' ? t(x.key) : t(text[x.kind]);
  let action = null;
  if (x.kind === 'contact')
    action = (
      <Link href={`/${locale}/settings/profile`} className="pwa-link">
        {t('reviews.blocked.verifyContact')}
      </Link>
    );
  else if (x.kind === 'duplicate' && o.existing && o.slug)
    action = (
      <Link
        href={
          o.existing.status === 'published'
            ? `/${locale}/activity?tab=reviews&review=${encodeURIComponent(o.existing.id)}`
            : reviewHref(locale, o.slug, { as: o.subject, edit: o.existing.id })
        }
        className="pwa-link"
      >
        {t('reviews.errors.openExisting')}
      </Link>
    );
  else if ((x.kind === 'grantExpired' || x.kind === 'linkUsed') && o.slug)
    action = (
      <a href={reviewHref(locale, o.slug, { as: o.subject })} className="pwa-link">
        {t('reviews.errors.writeWithout')}
      </a>
    );
  return (
    <div className="pwa-stack-xs" role="alert">
      <p className="pwa-error-text m-0">{message}</p>
      {action}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------- C-REV-02

function Submitted(o: { review: Review; profile: PublicOrgProfile; subject: SubjectType; heldText: boolean; edited: boolean }) {
  const t = useT();
  const locale = useLocale();
  const session = useSession();
  const r = o.review;
  const p = o.profile;
  const approval = r.confirmation_path !== 'visit_based';
  const first = session.data?.user?.display_name?.split(/\s+/)[0] ?? '';
  const profileHref = p.slug ? (o.subject === 'vendor' ? sellerPath(locale, p.slug) : shopPath(locale, p.slug)) : null;
  const status =
    r.status === 'published'
      ? t('reviews.done.published')
      : approval
        ? t('reviews.status.waiting')
        : o.heldText
          ? t('reviews.done.checkingTeam')
          : t('reviews.done.checking');
  return (
    <div className="pwa-review-page">
      <section className="pwa-review-done" aria-labelledby="review-done" data-testid="review-submitted">
        <Icon name={approval ? 'clock' : 'check'} size={40} className={approval ? undefined : 'pwa-success-icon'} />
        <h1 id="review-done" className="pwa-text-title m-0">
          {o.edited
            ? t('reviews.done.edited')
            : approval
              ? t('reviews.done.sentTitle')
              : first
                ? t('reviews.done.thanks', { name: first })
                : t('reviews.done.thanksAnon')}
        </h1>
        <p className="pwa-text-body m-0">{approval ? t('reviews.done.sentText') : t('reviews.done.thanksText')}</p>
        <Badge icon="clock" tone={approval ? 'signal' : 'neutral'}>
          {status}
        </Badge>
        {approval ? (
          <ol className="pwa-review-steps">
            <li>
              <span className="pwa-text-label">{o.subject === 'vendor' ? t('reviews.done.step1Vendor') : t('reviews.done.step1')}</span>
              <span className="pwa-text-caption">{t('reviews.done.step1Text')}</span>
            </li>
            <li>
              <span className="pwa-text-label">{t('reviews.done.step2')}</span>
              <span className="pwa-text-caption">{t('reviews.done.step2Text')}</span>
            </li>
            <li>
              <span className="pwa-text-label">{t('reviews.done.step3')}</span>
            </li>
          </ol>
        ) : null}
        <p className="pwa-text-caption m-0">{approval ? t('reviews.done.approvalNote') : t('reviews.done.visitNote')}</p>
        <div className="pwa-inline-buttons">
          {profileHref ? (
            <Link href={profileHref} className={buttonClass({ variant: 'primary' })}>
              <span className="cp-btn-label">{t('reviews.done.profile')}</span>
            </Link>
          ) : null}
          {r.context_appointment_id ? (
            <Link
              href={`/${locale}/appointments/${encodeURIComponent(r.context_appointment_id)}`}
              className={buttonClass({ variant: 'secondary' })}
            >
              <span className="cp-btn-label">{t('reviews.done.appointment')}</span>
            </Link>
          ) : null}
          <Link href={`/${locale}/activity?tab=reviews&review=${encodeURIComponent(r.id)}`} className={buttonClass({ variant: 'ghost' })}>
            <span className="cp-btn-label">{t('reviews.done.activity')}</span>
          </Link>
        </div>
      </section>
    </div>
  );
}
