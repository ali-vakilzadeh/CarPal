'use client';
// Web push controls (P12.T3; Docs/22 W-NOTIF-01, §2.5): the offer after the first appointment request ("Get updates
// even when this tab is closed"), the "Web push on this browser" switch of W-SET-01 Notifications (built by features/settings with usePush), and the "Push
// notifications are off — Turn on" line of /notifications. All three use usePush(); nothing renders where the
// browser or the deployment cannot do web push (no service worker, Push API or VAPID key).
import { useState, useSyncExternalStore } from 'react';
import { useBrowserValue } from '@/lib/browser-value';
import { Banner } from '@/components/ds/banner';
import { Button } from '@/components/ds/button';
import { Icon } from '@/components/ds/icon';
import { useApiClient } from '@/lib/api/query';
import { useSession } from '@/lib/api/session';
import { usePwaConfig } from '@/lib/config/client';
import { useLocale, useT } from '@/lib/i18n/client';
import type { MessageKey } from '@/lib/i18n/keys';
import {
  PUSH_OFFER_KEY,
  browserPushEnv,
  pushStatusOf,
  pushSupported,
  shouldOfferPush,
  subscribePush,
  unsubscribePush,
  type PushStatus,
  type SubscribeOutcome,
} from './push';
import { APP_VERSION, notifyPushChanged, subscribePushChanges } from './runtime';

const OUTCOME_TEXT: Partial<Record<SubscribeOutcome, MessageKey>> = {
  denied: 'pwa.push.denied',
  unsupported: 'pwa.push.unsupported',
  'other-account': 'pwa.push.otherAccount',
  failed: 'pwa.push.failed',
};

export function usePush() {
  const api = useApiClient();
  const locale = useLocale();
  const { vapidPublicKey } = usePwaConfig();
  const session = useSession();
  const userId = session.data?.signed_in ? (session.data.user?.id ?? null) : null;
  const status = useSyncExternalStore(
    subscribePushChanges,
    () => {
      const supported = pushSupported(vapidPublicKey);
      return pushStatusOf({
        supported,
        permission: supported ? Notification.permission : null,
        record: supported ? browserPushEnv(APP_VERSION).read() : null,
        userId,
      });
    },
    (): PushStatus => 'unsupported',
  );
  const [outcome, setOutcome] = useState<SubscribeOutcome | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = notifyPushChanged;

  const turnOn = async (fresh = false) => {
    if (!userId || !vapidPublicKey) return null;
    setBusy(true);
    setOutcome(null);
    try {
      const result = await subscribePush(api, browserPushEnv(APP_VERSION), { userId, vapidKey: vapidPublicKey, locale, fresh });
      setOutcome(result);
      return result;
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const turnOff = async () => {
    setBusy(true);
    setOutcome(null);
    try {
      await unsubscribePush(api, browserPushEnv(APP_VERSION));
    } catch {
      setOutcome('failed');
    } finally {
      setBusy(false);
      refresh();
    }
  };

  return { status, outcome, busy, turnOn, turnOff, signedIn: !!userId };
}

/** The result of a failed Turn on, and "Use it for this account" after a 409 DUPLICATE. */
export function PushOutcome({ outcome, onFresh, busy }: { outcome: SubscribeOutcome | null; onFresh: () => void; busy: boolean }) {
  const t = useT();
  const key = outcome ? OUTCOME_TEXT[outcome] : undefined;
  if (!key) return null;
  return (
    <div className="pwa-stack-sm">
      <p className="pwa-error-text m-0" role="alert">
        {t(key)}
      </p>
      {outcome === 'other-account' ? (
        <div>
          <Button size="sm" loading={busy} onClick={onFresh}>
            {t('pwa.push.useHere')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function offerAnswered(): boolean {
  try {
    return localStorage.getItem(PUSH_OFFER_KEY) !== null;
  } catch {
    return true;
  }
}

function answerOffer(value: 'on' | 'later'): void {
  try {
    localStorage.setItem(PUSH_OFFER_KEY, value);
  } catch {
    // ignore
  }
}

/** After a benefiting action (Help Me Done: the first appointment request). Asked once per browser. */
export function PushOffer() {
  const t = useT();
  const push = usePush();
  const answeredBefore = useBrowserValue(offerAnswered, true);
  const [answeredNow, setAnswered] = useState(false);
  const answered = answeredBefore || answeredNow;
  if (push.status === 'on' && push.outcome === 'on')
    return <Banner tone="success" icon="bell" title={t('pwa.push.onTitle')} text={t('pwa.push.onText')} />;
  if (!shouldOfferPush(push.status, answered) && !push.outcome) return null;
  return (
    <section className="pwa-card pwa-push-offer" aria-labelledby="push-offer-title" data-testid="push-offer">
      <div className="pwa-push-offer-head">
        <Icon name="bell" />
        <h2 id="push-offer-title" className="pwa-text-label m-0">
          {t('pwa.push.offerTitle')}
        </h2>
      </div>
      <p className="m-0">{t('pwa.push.offerText')}</p>
      <PushOutcome outcome={push.outcome} busy={push.busy} onFresh={() => void push.turnOn(true)} />
      <div className="pwa-inline-buttons">
        <Button
          size="sm"
          variant="primary"
          icon="bell"
          loading={push.busy}
          onClick={async () => {
            answerOffer('on');
            await push.turnOn();
          }}
        >
          {t('pwa.push.turnOn')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            answerOffer('later');
            setAnswered(true);
          }}
        >
          {t('pwa.push.notNow')}
        </Button>
      </div>
    </section>
  );
}

/** /notifications: "Push notifications are off" with Turn on, while this browser could get them. */
export function PushOffBanner() {
  const t = useT();
  const push = usePush();
  if (push.status !== 'off' && !push.outcome) return null;
  if (push.status === 'on') return null;
  return (
    <Banner tone="info" icon="bell" title={t('pwa.push.offBanner')}>
      <PushOutcome outcome={push.outcome} busy={push.busy} onFresh={() => void push.turnOn(true)} />
      <div className="pwa-banner-actions">
        <Button size="sm" loading={push.busy} onClick={() => void push.turnOn()}>
          {t('pwa.push.turnOn')}
        </Button>
      </div>
    </Banner>
  );
}

/** Whether this browser receives web push now (the matrix's "Web push (this browser)" column). */
export function useWebPushOn(): boolean {
  return usePush().status === 'on';
}
