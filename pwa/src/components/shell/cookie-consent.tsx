'use client';
// Cookie and tracking consent banner (Docs/22 §2.5, P3.T6): shown on the first visit (no cp_consent cookie) with
// Accept all, Reject non-essential and Choose at equal prominence (same button style and size, accept and reject
// side by side). Choose opens the purposes: Essential (always on) and Usage statistics. The footer's "Cookie
// settings" reopens the choices as a URL modal (?modal=cookies). The choice is a first-party cookie read by the
// analytics queue.
import { useId, useState } from 'react';
import { Button } from '@/components/ds/button';
import { useAnalytics } from '@/lib/analytics/client';
import { useT } from '@/lib/i18n/client';
import { useToast } from './toast';
import { UrlModal, useUrlModal } from './url-modal';

export const COOKIE_MODAL = 'cookies';

function Purposes({ analytics, onAnalytics }: { analytics: boolean; onAnalytics: (v: boolean) => void }) {
  const t = useT();
  const id = useId();
  return (
    <div className="pwa-consent-purposes">
      <div className="pwa-consent-purpose">
        <input id={`${id}-e`} type="checkbox" checked disabled aria-describedby={`${id}-et`} />
        <div>
          <label htmlFor={`${id}-e`} className="pwa-consent-name">
            {t('consent.essentialTitle')}
          </label>
          <p id={`${id}-et`} className="pwa-text-caption">
            {t('consent.essentialText')}
          </p>
        </div>
      </div>
      <div className="pwa-consent-purpose">
        <input
          id={`${id}-a`}
          type="checkbox"
          checked={analytics}
          onChange={(e) => onAnalytics(e.target.checked)}
          aria-describedby={`${id}-at`}
        />
        <div>
          <label htmlFor={`${id}-a`} className="pwa-consent-name">
            {t('consent.analyticsTitle')}
          </label>
          <p id={`${id}-at`} className="pwa-text-caption">
            {t('consent.analyticsText')}
          </p>
        </div>
      </div>
    </div>
  );
}

/** The choices in the "Cookie settings" modal; mounted when it opens, so it starts from the stored consent. */
function CookieSettings({ onDecide }: { onDecide: (analytics: boolean) => void }) {
  const t = useT();
  const { consent } = useAnalytics();
  const [analytics, setAnalytics] = useState(consent?.analytics ?? false);
  return (
    <>
      <p className="pwa-text-body">{t('consent.text')}</p>
      <Purposes analytics={analytics} onAnalytics={setAnalytics} />
      <div className="pwa-consent-actions">
        <Button onClick={() => onDecide(true)}>{t('consent.acceptAll')}</Button>
        <Button onClick={() => onDecide(false)}>{t('consent.rejectAll')}</Button>
        <Button onClick={() => onDecide(analytics)}>{t('consent.save')}</Button>
      </div>
    </>
  );
}

export function CookieConsent() {
  const t = useT();
  const toast = useToast();
  const { consent, setConsent } = useAnalytics();
  const modal = useUrlModal(COOKIE_MODAL);
  const [choosing, setChoosing] = useState(false);
  const [analytics, setAnalytics] = useState(false);

  const decide = (value: boolean, fromModal = false) => {
    setConsent({ analytics: value });
    setChoosing(false);
    if (fromModal) {
      modal.close();
      toast(t('consent.saved'));
    }
  };

  return (
    <>
      {consent === null && !modal.isOpen ? (
        <section className="pwa-consent" role="region" aria-labelledby="pwa-consent-title">
          <div className="pwa-consent-inner">
            <h2 id="pwa-consent-title" className="pwa-consent-title">
              {t('consent.title')}
            </h2>
            <p className="pwa-text-caption">{t('consent.text')}</p>
            {choosing ? <Purposes analytics={analytics} onAnalytics={setAnalytics} /> : null}
            <div className="pwa-consent-actions">
              <Button onClick={() => decide(true)}>{t('consent.acceptAll')}</Button>
              <Button onClick={() => decide(false)}>{t('consent.rejectAll')}</Button>
              {choosing ? (
                <Button onClick={() => decide(analytics)}>{t('consent.save')}</Button>
              ) : (
                <Button aria-expanded={false} onClick={() => setChoosing(true)}>
                  {t('consent.choose')}
                </Button>
              )}
            </div>
          </div>
        </section>
      ) : null}
      <UrlModal control={modal} name={COOKIE_MODAL} title={t('consent.title')}>
        {modal.isOpen ? <CookieSettings onDecide={(value) => decide(value, true)} /> : null}
      </UrlModal>
    </>
  );
}
