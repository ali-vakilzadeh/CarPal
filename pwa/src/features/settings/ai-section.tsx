'use client';
// W-SET-01 AI preferences (mirrors C-PROF-03; P9.T3): the master switch "Use my vehicles and history to personalise" is
// the AI personalisation consent itself (the same row as in Privacy & consent), what it uses, and maintenance
// suggestions (ai_suggestions_enabled). With personalisation off, Help Me still works with only what is typed in the
// session (MVP §7.1). Docs/21's per-feature switches (Help Me personalised vs session, matching, writing help, "Show
// why") have no preference in the contract (DI-55) and are not offered; match reasons are always shown.
import { useState } from 'react';
import { useApiQuery } from '@/lib/api/query';
import { useT } from '@/lib/i18n/client';
import { useConsents, useSetPreference } from './consents';
import { consentRows } from './model';
import { Card, ErrorLine, ReadState, SwitchRow } from './parts';
import { ConsentSwitch } from './privacy-section';

export function AiSection({ policyVersion }: { policyVersion: string }) {
  const t = useT();
  const consents = useConsents();
  const prefs = useApiQuery('me.preferences_get', undefined, { staleTime: 60_000 });
  const setPreference = useSetPreference();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const row = consents.data ? consentRows(consents.data.items).find((r) => r.type === 'ai_personalization') : undefined;

  const setSuggestions = async (on: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await setPreference({ ai_suggestions_enabled: on });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pwa-stack">
      <Card title={t('settings.ai.personaliseTitle')} text={t('settings.ai.personaliseText')}>
        {row ? (
          <ConsentSwitch row={row} policyVersion={policyVersion} label={t('settings.ai.master')} hint={t('settings.ai.masterHint')} />
        ) : (
          <ReadState status={consents.status} error={consents.error} refetch={consents.refetch} />
        )}
        <div className="pwa-stack-xs">
          <p className="pwa-text-label m-0">{t('settings.ai.usesTitle')}</p>
          <ul className="pwa-bullets">
            <li>{t('settings.ai.usesVehicles')}</li>
            <li>{t('settings.ai.usesHistory')}</li>
            <li>{t('settings.ai.usesIssues')}</li>
          </ul>
          <p className="pwa-text-caption m-0">{t('settings.ai.offNote')}</p>
        </div>
      </Card>
      <Card title={t('settings.ai.whereTitle')}>
        {prefs.data ? (
          <SwitchRow
            label={t('settings.ai.suggestions')}
            hint={t('settings.ai.suggestionsHint')}
            checked={prefs.data.ai_suggestions_enabled}
            disabled={busy}
            onChange={(v) => void setSuggestions(v)}
          />
        ) : (
          <ReadState status={prefs.status} error={prefs.error} refetch={prefs.refetch} />
        )}
        <ErrorLine error={error} />
        <p className="pwa-text-caption m-0">{t('settings.ai.reasonsNote')}</p>
      </Card>
    </div>
  );
}
