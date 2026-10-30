'use client';
// Account consents for Privacy & consent and AI preferences (P9.T3, Docs/40 §6.4, MVP §14): the list, and switching
// a general consent on (consents.grant to the platform with the current policy version, then the preference that
// depends on it: ai_personalization_enabled, marketing_opt_in) or off (every active record of the type is withdrawn;
// the backend switches the dependent preference off itself, SEC-AZ-8). Effects are immediate: the list and the
// preferences are replaced from the responses before anything is read again.
import type { ConsentRecord, OperationResponse, UserPreference } from '@carpal/api-contracts';
import { useQueryClient } from '@tanstack/react-query';
import { apiQueryKey, useApiClient, useApiQuery } from '@/lib/api/query';
import type { GeneralConsent } from './model';

export const CONSENTS_ARGS = { query: { limit: 100 } } as const;

const DEPENDENT_PREF: Partial<Record<GeneralConsent, 'ai_personalization_enabled' | 'marketing_opt_in'>> = {
  ai_personalization: 'ai_personalization_enabled',
  marketing: 'marketing_opt_in',
};

export function useConsents() {
  return useApiQuery('consents.list', CONSENTS_ARGS, { staleTime: 30_000 });
}

/** Account preferences (me.preferences_update, ETAG); the result replaces the cached read. */
export function useSetPreference() {
  const api = useApiClient();
  const queryClient = useQueryClient();
  return async (patch: Partial<UserPreference>) => {
    // ETAG: the read caches the preference ETag for the update (the onboarding does the same).
    await api.api('me.preferences_get');
    const prefs = await api.api('me.preferences_update', { body: patch });
    queryClient.setQueryData(apiQueryKey('me.preferences_get'), prefs);
    return prefs;
  };
}

export function useConsentActions(policyVersion: string) {
  const api = useApiClient();
  const queryClient = useQueryClient();
  const setPreference = useSetPreference();
  const key = apiQueryKey('consents.list', CONSENTS_ARGS);

  const replace = (records: ConsentRecord[]) =>
    queryClient.setQueryData<OperationResponse<'consents.list'>>(key, (old) => {
      const byId = new Map((old?.items ?? []).map((c) => [c.id, c]));
      for (const r of records) byId.set(r.id, r);
      return { items: [...byId.values()], next_cursor: old?.next_cursor ?? null };
    });

  return {
    async grant(type: GeneralConsent): Promise<ConsentRecord> {
      const record = await api.api('consents.grant', {
        // No grantee: the backend checks platform-wide consents without one (identity.has_consent, DI-59).
        body: { consent_type: type, policy_version: policyVersion },
      });
      replace([record]);
      const pref = DEPENDENT_PREF[type];
      if (pref) await setPreference({ [pref]: true });
      return record;
    },
    async withdraw(records: readonly ConsentRecord[]): Promise<void> {
      const done: ConsentRecord[] = [];
      for (const c of records) done.push(await api.api('consents.withdraw', { path: { consent_id: c.id } }));
      replace(done);
      // The backend switched the dependent preference off; read it again.
      await queryClient.invalidateQueries({ queryKey: apiQueryKey('me.preferences_get') });
    },
  };
}
