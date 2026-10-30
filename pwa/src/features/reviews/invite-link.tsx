'use client';
// /l/ri#<token> (P11.T2; Docs/22 W-REV-01 "/review/<token>", C-REV-01 invitation link, S-AUTH-07 'review' state): the
// emailed review invitation. The token is read from the fragment and removed from the address bar (SEC-LT-2), then
// review_invitations.open (PUB, ATT) shows the shop and the visit and mails a one-time code to the invited address —
// a forwarded link is not enough. Entering the code needs the invited person signed in (review_invitations.verify is
// USR): a guest signs in or signs up and comes back here (the tab keeps the token and the opened view, storage.ts, so
// no second code is sent). The 30-minute grant goes with the review page (/<locale>/review/<slug>?invite=1), which
// sends it with reviews.create. States: expired (410 LINK_EXPIRED → write from the profile, Path 2), already used
// (410 LINK_USED → open your review), another account (403 LINK_RECIPIENT_MISMATCH → switch account), wrong code,
// too many tries (429), incomplete link.
import type { InvitationOpenView } from '@carpal/api-contracts';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Avatar } from '@/components/ds/avatar';
import { Banner } from '@/components/ds/banner';
import { Button, buttonClass } from '@/components/ds/button';
import { StateView } from '@/components/shell/states';
import { CodeInput, readFragmentToken } from '@/features/auth';
import { useApiClient } from '@/lib/api/query';
import { loginUrl, useSession } from '@/lib/api/session';
import { useBrowserValue } from '@/lib/browser-value';
import { goTo } from '@/lib/browser-nav';
import { useFormat } from '@/lib/format/client';
import { useLocale, useT } from '@/lib/i18n/client';
import { orgPath } from '@/lib/seo/urls';
import { linkProblem, reviewHref, type LinkProblem, type SubjectType } from './model';
import { carriedLink, carryLink, dropLink, saveGrant } from './storage';

const RETURN_TO = '/l/ri';

function readToken(): string | null {
  return readFragmentToken() ?? carriedLink('ri')?.token ?? null;
}

/** The subject of an invitation: its role, or for a business with both roles the kind of visit (vendors have no car or service). */
export function invitedSubject(o: InvitationOpenView): SubjectType {
  const roles = o.subject.roles;
  if (roles.includes('provider') && roles.includes('vendor'))
    return o.visit_context.vehicle || o.visit_context.service_system ? 'provider' : 'vendor';
  return roles.includes('vendor') && !roles.includes('provider') ? 'vendor' : 'provider';
}

export function InviteLinkPage() {
  const t = useT();
  const f = useFormat();
  const locale = useLocale();
  const api = useApiClient();
  const session = useSession();
  const token = useBrowserValue<string | null | undefined>(readToken, undefined);
  const [fresh, setOpened] = useState<InvitationOpenView | null>(null);
  // Coming back from the sign-in: the opened view is kept with the token (no second code).
  const carried = useMemo(() => {
    const c = token ? carriedLink('ri') : null;
    return c?.token === token ? (c?.opened ?? null) : null;
  }, [token]);
  const opened = fresh ?? carried;
  const [problem, setProblem] = useState<LinkProblem | null>(null);
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resent, setResent] = useState(false);
  const started = useRef(false);
  const signedIn = session.data?.signed_in === true;

  const open = async (tok: string) => {
    try {
      const view = await api.api('review_invitations.open', { body: { token: tok } });
      carryLink('ri', tok, view);
      setOpened(view);
      return true;
    } catch (err) {
      const p = linkProblem(err);
      if (p === 'expired' || p === 'used') dropLink('ri');
      setProblem(p);
      return false;
    }
  };

  useEffect(() => {
    if (!token || carried || started.current) return;
    started.current = true;
    void open(token);
  });

  const verify = async (value: string) => {
    if (!token || !opened || busy) return;
    setBusy(true);
    setCodeError(null);
    try {
      const g = await api.api('review_invitations.verify', { body: { token, code: value } });
      const subject = invitedSubject(opened);
      if (!opened.subject.slug) {
        setProblem('failed');
        return;
      }
      saveGrant({
        orgId: opened.subject.id,
        slug: opened.subject.slug,
        name: opened.subject.name,
        subject,
        grant: g.invitation_grant,
        expiresAt: g.expires_at,
        path: g.path,
        visit: opened.visit_context,
      });
      dropLink('ri');
      goTo(reviewHref(locale, opened.subject.slug, { as: subject, invite: true }));
    } catch (err) {
      const p = linkProblem(err);
      if (p === 'code') {
        setCodeError(t('reviews.invite.wrongCode'));
        setCode('');
      } else if (p === 'rateLimited') setCodeError(t('reviews.invite.tooMany'));
      else {
        if (p === 'expired' || p === 'used') dropLink('ri');
        setProblem(p);
      }
    } finally {
      setBusy(false);
    }
  };

  const resend = async () => {
    if (!token) return;
    setResent(false);
    setCodeError(null);
    if (await open(token)) setResent(true);
  };

  const signIn = (screen?: 'signup') => {
    if (token) carryLink('ri', token, opened ?? undefined);
    goTo(loginUrl({ returnTo: RETURN_TO, locale, ...(screen ? { screen } : {}) }));
  };

  const page = (body: ReactNode) => (
    <>
      <h1 className="sr-only">{t('reviews.invite.title')}</h1>
      {body}
    </>
  );
  const activity = (
    <a href={`/${locale}/activity?tab=reviews`} className={buttonClass({ variant: 'primary' })}>
      <span className="cp-btn-label">{t('reviews.invite.openReview')}</span>
    </a>
  );
  const profileHref = opened ? orgPath(locale, opened.subject) : null;
  const fromProfile = opened?.subject.slug ? (
    <a href={reviewHref(locale, opened.subject.slug, { as: invitedSubject(opened) })} className={buttonClass({ variant: 'primary' })}>
      <span className="cp-btn-label">{t('reviews.invite.fromProfile')}</span>
    </a>
  ) : (
    <a href={`/${locale}`} className={buttonClass({ variant: 'secondary' })}>
      <span className="cp-btn-label">{t('reviews.invite.home')}</span>
    </a>
  );

  if (token === undefined) return page(<div className="pwa-state" role="status" aria-busy="true" />);
  if (token === null)
    return page(
      <StateView kind="removed" t={t} title={t('reviews.invite.title')} text={t('reviews.invite.missing')} action={fromProfile} />,
    );
  if (problem === 'expired')
    return page(
      <StateView kind="removed" t={t} title={t('reviews.invite.expired')} text={t('reviews.invite.expiredText')} action={fromProfile} />,
    );
  if (problem === 'used')
    return page(<StateView kind="removed" t={t} title={t('reviews.invite.used')} text={t('reviews.invite.usedText')} action={activity} />);
  if (problem === 'mismatch')
    return page(
      <StateView
        kind="noAccess"
        t={t}
        title={t('reviews.invite.mismatch')}
        text={t('reviews.invite.mismatchText')}
        action={
          <Button
            variant="primary"
            onClick={() => {
              carryLink('ri', token, opened ?? undefined);
              goTo(loginUrl({ returnTo: RETURN_TO, locale, switchAccount: true }));
            }}
          >
            {t('reviews.invite.switchAccount')}
          </Button>
        }
      />,
    );
  if (problem === 'rateLimited' && !opened) return page(<StateView kind="rateLimited" t={t} />);
  if (problem === 'failed' && !opened)
    return page(
      <StateView
        kind="error"
        t={t}
        action={
          <Button
            onClick={() => {
              setProblem(null);
              void open(token);
            }}
          >
            {t('common.actions.retry')}
          </Button>
        }
      />,
    );
  if (!opened) return page(<div className="pwa-state" role="status" aria-busy="true" aria-label={t('reviews.invite.opening')} />);

  const v = opened.visit_context;
  const visit = [
    v.vehicle ? `${v.vehicle.brand.text} ${v.vehicle.model.text}` : null,
    v.service_system?.text,
    v.service_task?.text,
    v.service_date ? f.calendarDate(v.service_date) : null,
  ].filter(Boolean);

  return (
    <div className="pwa-stack" data-testid="review-invite">
      <div className="pwa-review-invite-head">
        <Avatar name={opened.subject.name} src={opened.subject.logo_url ?? undefined} size={48} />
        <div className="pwa-stack-xs">
          <h1 className="pwa-text-title m-0">{t('reviews.invite.heading', { name: opened.subject.name })}</h1>
          {visit.length ? <p className="pwa-text-body m-0">{visit.join(' · ')}</p> : null}
          <p className="pwa-text-caption m-0">
            {opened.path === 'visit_based' ? t('reviews.invite.pathVisit') : t('reviews.invite.pathApproval')}
          </p>
        </div>
      </div>
      <Banner tone="info" icon="lock" title={t('reviews.invite.confirmTitle')} text={t('reviews.invite.confirmText')} />
      {signedIn ? (
        <div className="pwa-stack-sm">
          <p className="pwa-text-body m-0">
            {t('reviews.invite.codeSent')} <bdi dir="ltr">{opened.code_sent_to}</bdi>
          </p>
          <CodeInput
            label={t('reviews.invite.codeLabel')}
            value={code}
            onChange={setCode}
            onComplete={(c) => void verify(c)}
            error={codeError}
            disabled={busy}
            autoFocus
          />
          {problem === 'failed' ? (
            <p className="pwa-error-text m-0" role="alert">
              {t('reviews.errors.failed')}
            </p>
          ) : null}
          <Button variant="primary" block loading={busy} disabled={code.length !== 6} onClick={() => void verify(code)}>
            {t('reviews.invite.continue')}
          </Button>
          <div className="pwa-inline-buttons">
            <Button variant="ghost" size="sm" onClick={() => void resend()}>
              {t('reviews.invite.resend')}
            </Button>
            {resent ? (
              <span className="pwa-text-caption" role="status">
                {t('reviews.invite.resent')}
              </span>
            ) : null}
          </div>
          <p className="pwa-text-caption m-0">{t('reviews.invite.expires', { date: f.date(opened.expires_at, 'date') })}</p>
        </div>
      ) : (
        <div className="pwa-stack-sm">
          <p className="pwa-text-body m-0">
            {t('reviews.invite.signInFirst')} <bdi dir="ltr">{opened.code_sent_to}</bdi>
          </p>
          <Button variant="primary" block onClick={() => signIn()}>
            {t('reviews.invite.signIn')}
          </Button>
          <Button variant="secondary" block onClick={() => signIn('signup')}>
            {t('reviews.invite.signUp')}
          </Button>
        </div>
      )}
      {profileHref ? (
        <a href={profileHref} className="pwa-link">
          {t('reviews.invite.viewProfile', { name: opened.subject.name })}
        </a>
      ) : null}
    </div>
  );
}
