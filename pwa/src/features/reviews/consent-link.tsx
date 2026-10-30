'use client';
// W-REV-02 Showcase Consent Request (mirrors C-REV-03; P11.T4) at /l/cn#<token>: a shop asks to publish photos of
// the customer's repair. The token is read from the fragment and removed from the address bar (SEC-LT-2); the request
// belongs to one account, so a guest signs in first and comes back here (the tab keeps the token, storage.ts).
// consents.request_view shows who asks, the exact photos (preview_media_urls — as the shop prepared them, with its
// blurring), what the consent covers and where it will appear, and "Your choice doesn't affect your review or your
// record"; Approve / Decline answer with consents.request_respond (single use). Approval creates the
// showcase_publishing consent scoped to this portfolio item, which can be withdrawn later in Privacy & consent.
// "Ask for more blurring" cannot carry marked areas back to the shop (the respond operation takes only grant or
// decline, DI-67): it explains that and declines, so the shop can send a new request with more blurring.
// States: answered (approved / declined), expired or already answered (410), another account (403), incomplete link.
import type { ConsentRequestView } from '@carpal/api-contracts';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Avatar } from '@/components/ds/avatar';
import { Banner } from '@/components/ds/banner';
import { Button, buttonClass } from '@/components/ds/button';
import { Icon } from '@/components/ds/icon';
import { MediaImage } from '@/components/media/media-image';
import { Dialog } from '@/components/shell/dialog';
import { StateView } from '@/components/shell/states';
import { readFragmentToken } from '@/features/auth';
import { useApiClient } from '@/lib/api/query';
import { loginUrl, useSession } from '@/lib/api/session';
import { useBrowserValue } from '@/lib/browser-value';
import { goTo } from '@/lib/browser-nav';
import { useFormat } from '@/lib/format/client';
import { useLocale, useT } from '@/lib/i18n/client';
import { linkProblem, type LinkProblem } from './model';
import { carriedLink, carryLink, dropLink } from './storage';

const RETURN_TO = '/l/cn';

function readToken(): string | null {
  return readFragmentToken() ?? carriedLink('cn')?.token ?? null;
}

type Answer = 'approved' | 'declined' | 'declinedBlur';

export function ConsentLinkPage({ policyVersion }: { policyVersion: string }) {
  const t = useT();
  const f = useFormat();
  const locale = useLocale();
  const api = useApiClient();
  const session = useSession();
  const token = useBrowserValue<string | null | undefined>(readToken, undefined);
  const [view, setView] = useState<ConsentRequestView | null>(null);
  const [problem, setProblem] = useState<LinkProblem | null>(null);
  const [busy, setBusy] = useState<'grant' | 'decline' | null>(null);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [blurOpen, setBlurOpen] = useState(false);
  const started = useRef(false);
  const signedIn = session.data?.signed_in === true;
  const guest = session.data !== undefined && !session.data.signed_in;

  useEffect(() => {
    if (!token || !signedIn || started.current) return;
    started.current = true;
    api
      .api('consents.request_view', { body: { token } })
      .then((v) => setView(v))
      .catch((err: unknown) => {
        const p = linkProblem(err);
        if (p === 'expired' || p === 'used') dropLink('cn');
        setProblem(p);
      });
  }, [api, token, signedIn]);

  const respond = async (decision: 'grant' | 'decline', blur = false) => {
    if (!token || busy) return;
    setBusy(decision);
    try {
      await api.api('consents.request_respond', { body: { token, decision, policy_version: policyVersion } });
      dropLink('cn');
      setBlurOpen(false);
      setAnswer(decision === 'grant' ? 'approved' : blur ? 'declinedBlur' : 'declined');
    } catch (err) {
      const p = linkProblem(err);
      if (p === 'expired' || p === 'used') dropLink('cn');
      setBlurOpen(false);
      setProblem(p);
    } finally {
      setBusy(null);
    }
  };

  const signIn = (switchAccount = false) => {
    if (token) carryLink('cn', token);
    goTo(loginUrl({ returnTo: RETURN_TO, locale, ...(switchAccount ? { switchAccount: true } : {}) }));
  };

  const page = (body: ReactNode) => (
    <>
      <h1 className="sr-only">{t('reviews.consent.title')}</h1>
      {body}
    </>
  );
  const privacy = (
    <a href={`/${locale}/settings/privacy`} className={buttonClass({ variant: 'secondary' })}>
      <span className="cp-btn-label">{t('reviews.consent.privacy')}</span>
    </a>
  );
  const home = (
    <a href={`/${locale}`} className={buttonClass({ variant: 'secondary' })}>
      <span className="cp-btn-label">{t('reviews.invite.home')}</span>
    </a>
  );

  if (token === undefined || session.data === undefined) return page(<div className="pwa-state" role="status" aria-busy="true" />);
  if (token === null)
    return page(<StateView kind="removed" t={t} title={t('reviews.consent.title')} text={t('reviews.consent.missing')} action={home} />);
  if (answer === 'approved')
    return page(
      <StateView
        kind="empty"
        t={t}
        title={t('reviews.consent.approved')}
        text={t('reviews.consent.approvedText', { name: view?.requested_by.name ?? '' })}
        action={privacy}
      />,
    );
  if (answer)
    return page(
      <StateView
        kind="empty"
        t={t}
        title={t('reviews.consent.declined')}
        text={
          answer === 'declinedBlur'
            ? t('reviews.consent.declinedBlurText', { name: view?.requested_by.name ?? '' })
            : t('reviews.consent.declinedText')
        }
        action={home}
      />,
    );
  if (guest)
    return (
      <div className="pwa-stack" data-testid="consent-signin">
        <h1 className="pwa-text-title m-0">{t('reviews.consent.title')}</h1>
        <p className="pwa-text-body m-0">{t('reviews.consent.signInText')}</p>
        <Button variant="primary" block onClick={() => signIn()}>
          {t('reviews.consent.signIn')}
        </Button>
      </div>
    );
  if (problem === 'expired' || problem === 'used')
    return page(
      <StateView
        kind="removed"
        t={t}
        title={problem === 'used' ? t('reviews.consent.used') : t('reviews.consent.expired')}
        text={problem === 'used' ? t('reviews.consent.usedText') : t('reviews.consent.expiredText')}
        action={privacy}
      />,
    );
  if (problem === 'mismatch')
    return page(
      <StateView
        kind="noAccess"
        t={t}
        title={t('reviews.invite.mismatch')}
        text={t('reviews.consent.mismatchText')}
        action={
          <Button variant="primary" onClick={() => signIn(true)}>
            {t('reviews.invite.switchAccount')}
          </Button>
        }
      />,
    );
  if (problem && !view) return page(<StateView kind={problem === 'rateLimited' ? 'rateLimited' : 'error'} t={t} action={home} />);
  if (!view) return page(<div className="pwa-state" role="status" aria-busy="true" aria-label={t('reviews.consent.loading')} />);

  const org = view.requested_by;
  const showcase = view.consent_type === 'showcase_publishing';
  return (
    <div className="pwa-stack" data-testid="consent-request">
      <div className="pwa-review-invite-head">
        <Avatar name={org.name} src={org.logo_url ?? undefined} size={48} />
        <h1 className="pwa-text-title m-0">
          {showcase ? t('reviews.consent.heading', { name: org.name }) : t('reviews.consent.headingOther', { name: org.name })}
        </h1>
      </div>
      {view.preview_media_urls.length ? (
        <section className="pwa-stack-sm" aria-labelledby="consent-photos">
          <h2 id="consent-photos" className="pwa-text-label m-0">
            {t('reviews.consent.photos', { count: view.preview_media_urls.length })}
          </h2>
          <ul className="pwa-plain-list pwa-consent-photos">
            {view.preview_media_urls.map((url, i) => (
              <li key={url}>
                <MediaImage
                  url={url}
                  alt={t('reviews.consent.photoAlt', { n: f.number(i + 1) })}
                  aspect="photo"
                  placeholder={t('reviews.consent.photoPending')}
                />
              </li>
            ))}
          </ul>
          <p className="pwa-text-caption m-0">{t('reviews.consent.blurNote')}</p>
        </section>
      ) : (
        <Banner tone="plain" icon="image" text={t('reviews.consent.noPhotos')} />
      )}
      <section className="pwa-stack-sm" aria-labelledby="consent-where">
        <h2 id="consent-where" className="pwa-text-label m-0">
          {t('reviews.consent.where')}
        </h2>
        <ul className="pwa-plain-list pwa-stack-xs">
          <li className="pwa-text-body">
            <Icon name="store" size={20} /> {t('reviews.consent.whereProfile', { name: org.name })}
          </li>
          {showcase ? (
            <li className="pwa-text-body">
              <Icon name="chat" size={20} /> {t('reviews.consent.whereCommunity')}
            </li>
          ) : null}
        </ul>
        <p className="pwa-text-caption m-0">{t('reviews.consent.scope')}</p>
      </section>
      <Banner tone="info" icon="shield" text={t('reviews.consent.noEffect')} />
      <p className="pwa-text-caption m-0">{t('reviews.consent.expires', { date: f.date(view.expires_at, 'date') })}</p>
      {problem ? (
        <p className="pwa-error-text m-0" role="alert">
          {t('reviews.errors.failed')}
        </p>
      ) : null}
      <div className="pwa-consent-actions">
        <Button variant="primary" icon="check" loading={busy === 'grant'} disabled={!!busy} onClick={() => void respond('grant')}>
          {t('reviews.consent.approve')}
        </Button>
        <Button loading={busy === 'decline' && !blurOpen} disabled={!!busy} onClick={() => void respond('decline')}>
          {t('reviews.consent.decline')}
        </Button>
        <Button variant="ghost" icon="eye" disabled={!!busy} onClick={() => setBlurOpen(true)}>
          {t('reviews.consent.askBlur')}
        </Button>
      </div>
      <Dialog
        open={blurOpen}
        onClose={() => setBlurOpen(false)}
        title={t('reviews.consent.askBlur')}
        footer={
          <div className="pwa-inline-buttons">
            <Button variant="primary" loading={busy === 'decline'} onClick={() => void respond('decline', true)}>
              {t('reviews.consent.blurDecline')}
            </Button>
            <Button variant="ghost" onClick={() => setBlurOpen(false)}>
              {t('reviews.consent.blurBack')}
            </Button>
          </div>
        }
      >
        <p className="pwa-text-body">{t('reviews.consent.blurText', { name: org.name })}</p>
        <p className="pwa-text-caption">{t('reviews.consent.blurHow')}</p>
      </Dialog>
    </div>
  );
}
