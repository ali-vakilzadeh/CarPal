'use client';
// W-SET-01 Privacy & consent (mirrors C-PROF-02; P9.T3, MVP §14): the general consents (AI personalisation, news and
// offers, review invitations, location) as switches with the date granted and the policy version; the active shares
// (scoped consents: history shared with a shop for an appointment, a showcase, vehicle details for a stock inquiry)
// with Withdraw — a showcase asks first, because the post leaves the shop's profile at once; the history of changes
// (collapsed) and its CSV download (built here from consents.list); and Cookies, which reopens the first-visit choices.
// Every change takes effect immediately (consents.ts).
import type { ConsentRecord } from '@carpal/api-contracts';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { Button, buttonClass } from '@/components/ds/button';
import { COOKIE_MODAL } from '@/components/shell/cookie-consent';
import { Dialog } from '@/components/shell/dialog';
import { useToast } from '@/components/shell/toast';
import { modalHref } from '@/components/shell/url-modal';
import { useFormat } from '@/lib/format/client';
import { useT } from '@/lib/i18n/client';
import type { MessageKey } from '@/lib/i18n/keys';
import { useConsentActions, useConsents } from './consents';
import { activeShares, consentCsv, consentHistory, consentRows, type ConsentRow, type GeneralConsent } from './model';
import { Card, downloadText, ErrorLine, ReadState, SwitchRow } from './parts';

const CONSENT_TEXT: Record<GeneralConsent, { label: MessageKey; hint: MessageKey }> = {
  ai_personalization: { label: 'settings.privacy.ai', hint: 'settings.privacy.aiHint' },
  marketing: { label: 'settings.privacy.marketing', hint: 'settings.privacy.marketingHint' },
  review_invitations: { label: 'settings.privacy.reviews', hint: 'settings.privacy.reviewsHint' },
  location_usage: { label: 'settings.privacy.location', hint: 'settings.privacy.locationHint' },
};

/** "Granted 23 Sep 2026 · policy 2026-10", "Withdrawn …" or "Never granted". */
function useStatusLine() {
  const t = useT();
  const f = useFormat();
  return (row: ConsentRow) => {
    const c = row.active[0] ?? row.latest;
    if (!c) return t('settings.privacy.never');
    if (row.active.length && c.granted_at)
      return t('settings.privacy.grantedOn', { date: f.date(c.granted_at), version: c.policy_version });
    if (c.withdrawn_at) return t('settings.privacy.withdrawnOn', { date: f.date(c.withdrawn_at) });
    return t('settings.privacy.never');
  };
}

export function ConsentSwitch({
  row,
  policyVersion,
  label,
  hint,
}: {
  row: ConsentRow;
  policyVersion: string;
  label?: string;
  hint?: string;
}) {
  const t = useT();
  const toast = useToast();
  const actions = useConsentActions(policyVersion);
  const status = useStatusLine();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const on = row.active.length > 0;
  const change = async (next: boolean) => {
    setBusy(true);
    setError(null);
    try {
      if (next) await actions.grant(row.type);
      else await actions.withdraw(row.active);
      toast(t(next ? 'settings.privacy.grantedToast' : 'settings.privacy.withdrawnToast'));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="pwa-stack-xs" data-testid={`consent-${row.type}`}>
      <SwitchRow
        label={label ?? t(CONSENT_TEXT[row.type].label)}
        hint={
          <>
            <span className="block">{hint ?? t(CONSENT_TEXT[row.type].hint)}</span>
            <span className="block">{status(row)}</span>
          </>
        }
        checked={on}
        disabled={busy}
        onChange={(v) => void change(v)}
      />
      <ErrorLine error={error} />
    </div>
  );
}

const SHARE_TEXT: Partial<Record<ConsentRecord['consent_type'], MessageKey>> = {
  service_history_sharing: 'settings.privacy.share.service_history_sharing',
  vehicle_data_sharing: 'settings.privacy.share.vehicle_data_sharing',
  vendor_fitment_context: 'settings.privacy.share.vendor_fitment_context',
  photo_publishing: 'settings.privacy.share.photo_publishing',
  showcase_publishing: 'settings.privacy.share.showcase_publishing',
  fleet_driver_data_visibility: 'settings.privacy.share.fleet_driver_data_visibility',
};

const SCOPE_TEXT: Record<NonNullable<ConsentRecord['scope_entity_type']>, MessageKey> = {
  vehicle: 'settings.privacy.scope.vehicle',
  appointment: 'settings.privacy.scope.appointment',
  media_asset: 'settings.privacy.scope.media_asset',
  portfolio_item: 'settings.privacy.scope.portfolio_item',
  stock_inquiry: 'settings.privacy.scope.stock_inquiry',
};

const confirmFirst = (c: ConsentRecord) => c.consent_type === 'showcase_publishing' || c.consent_type === 'photo_publishing';

function Shares({ records, policyVersion }: { records: readonly ConsentRecord[]; policyVersion: string }) {
  const t = useT();
  const f = useFormat();
  const toast = useToast();
  const actions = useConsentActions(policyVersion);
  const [asking, setAsking] = useState<ConsentRecord | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const shares = activeShares(records);
  const withdraw = async (c: ConsentRecord) => {
    setBusy(c.id);
    setError(null);
    try {
      await actions.withdraw([c]);
      setAsking(null);
      toast(t('settings.privacy.withdrawnToast'));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  };
  return (
    <Card title={t('settings.privacy.sharesTitle')} text={t('settings.privacy.sharesText')}>
      {shares.length === 0 ? <p className="pwa-text-body m-0">{t('settings.privacy.noShares')}</p> : null}
      {shares.length ? (
        <ul className="pwa-settings-list">
          {shares.map((c) => (
            <li key={c.id} className="pwa-settings-item" data-testid="share">
              <div className="pwa-stack-xs">
                <span className="pwa-text-label">{t(SHARE_TEXT[c.consent_type] ?? 'settings.privacy.share.other')}</span>
                <span className="pwa-text-caption">
                  {c.scope_entity_type ? `${t(SCOPE_TEXT[c.scope_entity_type])} · ` : ''}
                  {c.granted_at ? t('settings.privacy.grantedOn', { date: f.date(c.granted_at), version: c.policy_version }) : null}
                  {c.expires_at ? ` · ${t('settings.privacy.until', { date: f.date(c.expires_at) })}` : ''}
                </span>
              </div>
              <Button size="sm" variant="ghost" loading={busy === c.id} onClick={() => (confirmFirst(c) ? setAsking(c) : void withdraw(c))}>
                {t('settings.privacy.withdraw')}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <ErrorLine error={error} />
      <Dialog
        name="withdraw-share"
        open={asking !== null}
        onClose={() => setAsking(null)}
        title={t('settings.privacy.withdrawTitle')}
        footer={
          <>
            <Button variant="danger" loading={asking !== null && busy === asking.id} onClick={() => asking && void withdraw(asking)}>
              {t('settings.privacy.withdraw')}
            </Button>
            <Button variant="ghost" onClick={() => setAsking(null)}>
              {t('common.actions.cancel')}
            </Button>
          </>
        }
      >
        <p className="pwa-text-body">{t('settings.privacy.withdrawShowcase')}</p>
      </Dialog>
    </Card>
  );
}

const HISTORY_SHOWN = 20;

function History({ records }: { records: readonly ConsentRecord[] }) {
  const t = useT();
  const f = useFormat();
  const entries = consentHistory(records);
  return (
    <Card title={t('settings.privacy.historyTitle')} text={t('settings.privacy.historyText')}>
      {entries.length ? (
        <details className="pwa-settings-details">
          <summary>{t('settings.privacy.showHistory', { count: entries.length })}</summary>
          <ul className="pwa-settings-list">
            {entries.slice(0, HISTORY_SHOWN).map((e) => (
              <li key={`${e.record.id}:${e.change}`} className="pwa-settings-item">
                <span>
                  {t(e.change === 'granted' ? 'settings.privacy.historyGranted' : 'settings.privacy.historyWithdrawn', {
                    what: t(
                      CONSENT_TEXT[e.record.consent_type as GeneralConsent]?.label ??
                        SHARE_TEXT[e.record.consent_type] ??
                        'settings.privacy.share.other',
                    ),
                  })}
                </span>
                <time className="pwa-text-caption" dateTime={e.at}>
                  {f.date(e.at)}
                </time>
              </li>
            ))}
          </ul>
        </details>
      ) : (
        <p className="pwa-text-body m-0">{t('settings.privacy.noHistory')}</p>
      )}
      <div className="pwa-inline-buttons">
        <Button
          size="sm"
          icon="download"
          disabled={records.length === 0}
          onClick={() => downloadText('carpal-consent-history.csv', consentCsv(records), 'text/csv;charset=utf-8')}
        >
          {t('settings.privacy.downloadCsv')}
        </Button>
      </div>
    </Card>
  );
}

function Cookies() {
  const t = useT();
  const pathname = usePathname();
  const search = useSearchParams();
  return (
    <Card title={t('settings.privacy.cookiesTitle')} text={t('settings.privacy.cookiesText')}>
      <div className="pwa-inline-buttons">
        <Link
          href={modalHref(pathname, new URLSearchParams(search.toString()), COOKIE_MODAL)}
          scroll={false}
          className={buttonClass({ size: 'sm' })}
        >
          <span className="cp-btn-label">{t('settings.privacy.cookiesChange')}</span>
        </Link>
      </div>
    </Card>
  );
}

export function PrivacySection({ policyVersion }: { policyVersion: string }) {
  const t = useT();
  const consents = useConsents();
  const records = consents.data?.items ?? [];
  return (
    <div className="pwa-stack">
      <Card title={t('settings.privacy.generalTitle')} text={t('settings.privacy.generalText')}>
        {consents.data ? (
          consentRows(records).map((row) => <ConsentSwitch key={row.type} row={row} policyVersion={policyVersion} />)
        ) : (
          <ReadState status={consents.status} error={consents.error} refetch={consents.refetch} />
        )}
      </Card>
      {consents.data ? <Shares records={records} policyVersion={policyVersion} /> : null}
      {consents.data ? <History records={records} /> : null}
      <Cookies />
    </div>
  );
}
