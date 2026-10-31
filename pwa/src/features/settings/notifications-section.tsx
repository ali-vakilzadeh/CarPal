'use client';
// W-SET-01 Notifications (mirrors C-PROF-04; P9.T3): the matrix of categories (Appointments, Reviews and replies,
// Reminders, Stock inquiries, Community, Tips and suggestions, Marketing) × channels (In-app, Push (mobile app),
// Web push (this browser), Email with instant / daily / weekly digest), and the locked row "Safety and security alerts
// are always delivered" (critical notifications reach the app regardless, Docs/40 §20.2). notification_prefs.put
// replaces the whole list, so every change sends all rows; marketing needs the marketing consent (403
// CONSENT_REQUIRED → Privacy & consent). "Web push (this browser)" (P12.T3) shows whether this browser receives the
// category: the contract has one push channel for the mobile app and browsers (DI-71), so a category reaches this
// browser when its Push switch is on and the "Web push on this browser" card below has subscribed it; SMS comes later. "Only safety and security alerts" is the account's critical_alerts_only. The bells of followed shops
// live on Saved & Following.
import type { NotificationCategory, NotificationChannel, NotificationPreference } from '@carpal/api-contracts';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { apiQueryKey, useApiClient, useApiQuery } from '@/lib/api/query';
import { ApiProblem } from '@/lib/api/problem';
import { useLocale, useT } from '@/lib/i18n/client';
import type { MessageKey } from '@/lib/i18n/keys';
import { PushOutcome, usePush } from '@/features/pwa';
import { useSetPreference } from './consents';
import { MATRIX_CATEGORIES, MATRIX_CHANNELS, prefKey, prefMap, withPreference, type Frequency } from './model';
import { Card, ErrorLine, ReadState, SwitchRow } from './parts';

const CATEGORY: Record<(typeof MATRIX_CATEGORIES)[number], MessageKey> = {
  appointments: 'settings.notifications.cat.appointments',
  reviews: 'settings.notifications.cat.reviews',
  service_reminders: 'settings.notifications.cat.service_reminders',
  inquiries: 'settings.notifications.cat.inquiries',
  community: 'settings.notifications.cat.community',
  ai_suggestions: 'settings.notifications.cat.ai_suggestions',
  marketing: 'settings.notifications.cat.marketing',
};

const CHANNEL: Record<(typeof MATRIX_CHANNELS)[number], MessageKey> = {
  in_app: 'settings.notifications.ch.in_app',
  push: 'settings.notifications.ch.push',
  email: 'settings.notifications.ch.email',
};

const PREFS_KEY = apiQueryKey('notification_prefs.get');

export function NotificationsSection() {
  const t = useT();
  const locale = useLocale();
  const api = useApiClient();
  const queryClient = useQueryClient();
  const prefs = useApiQuery('notification_prefs.get', undefined, { staleTime: 60_000 });
  const account = useApiQuery('me.preferences_get', undefined, { staleTime: 60_000 });
  const setPreference = useSetPreference();
  const push = usePush();
  const webPush = push.status === 'on';
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);

  const change = async (c: { channel: NotificationChannel; category: NotificationCategory; enabled?: boolean; frequency?: Frequency }) => {
    const before = prefs.data?.items ?? [];
    const next = withPreference(before, c);
    setError(null);
    setSaving(true);
    queryClient.setQueryData(PREFS_KEY, { items: next });
    try {
      queryClient.setQueryData(PREFS_KEY, await api.api('notification_prefs.put', { body: { items: next } }));
    } catch (err) {
      queryClient.setQueryData(PREFS_KEY, { items: before });
      setError(err);
    } finally {
      setSaving(false);
    }
  };

  const setCriticalOnly = async (on: boolean) => {
    setError(null);
    try {
      await setPreference({ critical_alerts_only: on });
    } catch (err) {
      setError(err);
    }
  };

  if (!prefs.data) return <ReadState status={prefs.status} error={prefs.error} refetch={prefs.refetch} />;
  const map = prefMap(prefs.data.items);
  const get = (channel: NotificationChannel, category: NotificationCategory): NotificationPreference | undefined =>
    map.get(prefKey(channel, category));
  const needsConsent = error instanceof ApiProblem && error.code === 'CONSENT_REQUIRED';

  return (
    <div className="pwa-stack">
      <Card title={t('settings.notifications.matrixTitle')} text={t('settings.notifications.matrixText')}>
        <div className="pwa-table-wrap">
          <table className="pwa-table pwa-matrix" aria-busy={saving}>
            <caption className="sr-only">{t('settings.notifications.matrixTitle')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('settings.notifications.colCategory')}</th>
                {MATRIX_CHANNELS.map((ch) => (
                  <th scope="col" key={ch}>
                    {t(CHANNEL[ch])}
                  </th>
                ))}
                <th scope="col">{t('settings.notifications.ch.webPush')}</th>
                <th scope="col">{t('settings.notifications.colFrequency')}</th>
              </tr>
            </thead>
            <tbody>
              <tr className="is-locked">
                <th scope="row">
                  <span className="pwa-text-label">{t('settings.notifications.safetyRow')}</span>
                  <span className="block pwa-text-caption">{t('settings.notifications.safetyHint')}</span>
                </th>
                {MATRIX_CHANNELS.map((ch) => (
                  <td key={ch}>
                    <input
                      type="checkbox"
                      checked
                      disabled
                      aria-label={t('settings.notifications.cell', {
                        category: t('settings.notifications.safetyRow'),
                        channel: t(CHANNEL[ch]),
                      })}
                    />
                  </td>
                ))}
                <td>—</td>
                <td>{t('settings.notifications.freq.immediate')}</td>
              </tr>
              {MATRIX_CATEGORIES.map((cat) => {
                const email = get('email', cat);
                return (
                  <tr key={cat} data-testid={`prefs-${cat}`}>
                    <th scope="row">{t(CATEGORY[cat])}</th>
                    {MATRIX_CHANNELS.map((ch) => (
                      <td key={ch}>
                        <input
                          type="checkbox"
                          checked={get(ch, cat)?.enabled ?? false}
                          aria-label={t('settings.notifications.cell', { category: t(CATEGORY[cat]), channel: t(CHANNEL[ch]) })}
                          onChange={(e) => void change({ channel: ch, category: cat, enabled: e.target.checked })}
                        />
                      </td>
                    ))}
                    <td>
                      <input
                        type="checkbox"
                        checked={webPush && (get('push', cat)?.enabled ?? false)}
                        disabled
                        aria-label={t('settings.notifications.webPushCell', { category: t(CATEGORY[cat]) })}
                      />
                    </td>
                    <td>
                      <select
                        className="pwa-matrix-select"
                        value={email?.frequency ?? 'immediate'}
                        disabled={!email?.enabled}
                        aria-label={t('settings.notifications.freqLabel', { category: t(CATEGORY[cat]) })}
                        onChange={(e) => void change({ channel: 'email', category: cat, frequency: e.target.value as Frequency })}
                      >
                        <option value="immediate">{t('settings.notifications.freq.immediate')}</option>
                        <option value="daily_digest">{t('settings.notifications.freq.daily_digest')}</option>
                        <option value="weekly_digest">{t('settings.notifications.freq.weekly_digest')}</option>
                      </select>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {needsConsent ? (
          <p className="pwa-error-text m-0" role="alert">
            {t('settings.notifications.marketingConsent')}{' '}
            <Link href={`/${locale}/settings/privacy`} className="pwa-link">
              {t('settings.nav.privacy')}
            </Link>
          </p>
        ) : (
          <ErrorLine error={error} />
        )}
        <p className="pwa-text-caption m-0">{t('settings.notifications.channelsNote')}</p>
      </Card>
      <Card title={t('pwa.push.settingsTitle')} text={t('pwa.push.settingsText')}>
        <div data-testid="web-push-card" className="pwa-stack-sm">
          {push.status === 'unsupported' ? (
            <p className="m-0">{t('pwa.push.unsupported')}</p>
          ) : push.status === 'denied' ? (
            <p className="m-0">{t('pwa.push.denied')}</p>
          ) : (
            <SwitchRow
              label={t('pwa.push.thisBrowser')}
              checked={webPush}
              disabled={push.busy}
              onChange={(on) => void (on ? push.turnOn() : push.turnOff())}
            />
          )}
          <PushOutcome outcome={push.outcome} busy={push.busy} onFresh={() => void push.turnOn(true)} />
        </div>
      </Card>
      <Card title={t('settings.notifications.quietTitle')}>
        {account.data ? (
          <SwitchRow
            label={t('settings.notifications.criticalOnly')}
            hint={t('settings.notifications.criticalOnlyHint')}
            checked={account.data.critical_alerts_only}
            onChange={(v) => void setCriticalOnly(v)}
          />
        ) : (
          <ReadState status={account.status} error={account.error} refetch={account.refetch} />
        )}
        <p className="pwa-text-caption m-0">
          {t('settings.notifications.followedShops')}{' '}
          <Link href={`/${locale}/saved?tab=following`} className="pwa-link">
            {t('shell.nav.saved')}
          </Link>
        </p>
      </Card>
    </div>
  );
}
