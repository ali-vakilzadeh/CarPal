'use client';
// W-SET-01 AI preferences (mirrors C-PROF-03; P9.T3): the master switch "Use my vehicles and history to personalise" is
// the AI personalisation consent itself (the same row as in Privacy & consent), what it uses, and maintenance
// suggestions (ai_suggestions_enabled). With personalisation off, Help Me still works with only what is typed in the
// session (MVP §7.1). The per-feature switches of contract 1.2.0 (DI-55): Help Me personalised vs this session only and
// personalised matching need that consent; writing help and "Show why" do not. "Show why" hides match reasons in search
// and Help Me (useShowReasons).
import type { UserPreference } from '@carpal/api-contracts';
import { useState } from 'react';
import { useApiQuery } from '@/lib/api/query';
import { useT } from '@/lib/i18n/client';
import { useConsents, useSetPreference } from './consents';
import { consentRows } from './model';
import { Card, ErrorLine, ReadState, SwitchRow } from './parts';
import { ConsentSwitch } from './privacy-section';

type AiPatch = Partial<
  Pick<
    UserPreference,
    'ai_suggestions_enabled' | 'ai_help_me_personalised' | 'ai_personalised_matching' | 'ai_writing_help' | 'ai_show_reasons'
  >
>;

export function AiSection({ policyVersion }: { policyVersion: string }) {
  const t = useT();
  const consents = useConsents();
  const prefs = useApiQuery('me.preferences_get', undefined, { staleTime: 60_000 });
  const setPreference = useSetPreference();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const row = consents.data ? consentRows(consents.data.items).find((r) => r.type === 'ai_personalization') : undefined;
  const personal = !!row?.active.length;

  const set = async (patch: AiPatch) => {
    setBusy(true);
    setError(null);
    try {
      await setPreference(patch);
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
          <>
            <SwitchRow
              label={t('settings.ai.helpMe')}
              hint={t(personal ? 'settings.ai.helpMeHint' : 'settings.ai.needsConsent')}
              checked={prefs.data.ai_help_me_personalised}
              disabled={busy || !personal}
              onChange={(v) => void set({ ai_help_me_personalised: v })}
            />
            <SwitchRow
              label={t('settings.ai.matching')}
              hint={t(personal ? 'settings.ai.matchingHint' : 'settings.ai.needsConsent')}
              checked={prefs.data.ai_personalised_matching}
              disabled={busy || !personal}
              onChange={(v) => void set({ ai_personalised_matching: v })}
            />
            <SwitchRow
              label={t('settings.ai.suggestions')}
              hint={t('settings.ai.suggestionsHint')}
              checked={prefs.data.ai_suggestions_enabled}
              disabled={busy}
              onChange={(v) => void set({ ai_suggestions_enabled: v })}
            />
            <SwitchRow
              label={t('settings.ai.writing')}
              hint={t('settings.ai.writingHint')}
              checked={prefs.data.ai_writing_help}
              disabled={busy}
              onChange={(v) => void set({ ai_writing_help: v })}
            />
            <SwitchRow
              label={t('settings.ai.showWhy')}
              hint={t('settings.ai.showWhyHint')}
              checked={prefs.data.ai_show_reasons}
              disabled={busy}
              onChange={(v) => void set({ ai_show_reasons: v })}
            />
          </>
        ) : (
          <ReadState status={prefs.status} error={prefs.error} refetch={prefs.refetch} />
        )}
        <ErrorLine error={error} />
      </Card>
    </div>
  );
}
