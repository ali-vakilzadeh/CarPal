// Account set-up done by the web onboarding (P4.T6/T7):
// - the optional sign-up choices (marketing, AI personalisation) become consent records and preferences: auth.signup
//   takes no consents, so the hosted sign-in keeps them in this tab until the new account is signed in (DI-30);
// - the account's time zone follows the browser (OQ-13), so reminders and appointment times are right;
// - "Anything wrong?" keeps a draft for Help Me (P10 starts from it).
// All best effort: a failure here never blocks onboarding (the settings pages of P9 offer the same choices).
import type { ApiClient } from '@/lib/api/client';
import { takeSignupChoices } from '@/features/auth';

export async function applySignupChoices(api: ApiClient): Promise<void> {
  const choices = takeSignupChoices();
  if (!choices) return;
  const policy_version = choices.policyVersion;
  const prefs: { marketing_opt_in?: boolean; ai_personalization_enabled?: boolean } = {};
  if (choices.marketing) {
    await api.api('consents.grant', { body: { consent_type: 'marketing', policy_version, granted_to: { type: 'platform' } } });
    prefs.marketing_opt_in = true;
  }
  if (choices.aiPersonalization) {
    await api.api('consents.grant', { body: { consent_type: 'ai_personalization', policy_version, granted_to: { type: 'platform' } } });
    prefs.ai_personalization_enabled = true;
  }
  // ETAG: the read caches the preference ETag for the update.
  await api.api('me.preferences_get');
  await api.api('me.preferences_update', { body: prefs });
}

export function browserTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

export async function syncTimeZone(api: ApiClient): Promise<void> {
  const zone = browserTimeZone();
  if (!zone) return;
  const me = await api.api('me.get');
  if (me.timezone !== zone) await api.api('me.update', { body: { timezone: zone } });
}

export const HELP_DRAFT_KEY = 'cp:help-draft';

export interface HelpDraft {
  vehicleId: string | null;
  text: string;
  symptoms: string[];
  at: number;
}

export function saveHelpDraft(draft: Omit<HelpDraft, 'at'>): void {
  try {
    localStorage.setItem(HELP_DRAFT_KEY, JSON.stringify({ ...draft, at: Date.now() }));
  } catch {
    // Help Me starts empty
  }
}

/** The draft for Help Me (P10), or null. */
export function readHelpDraft(): HelpDraft | null {
  try {
    const d = JSON.parse(localStorage.getItem(HELP_DRAFT_KEY) ?? 'null') as HelpDraft | null;
    return d && typeof d.text === 'string' && Array.isArray(d.symptoms) ? d : null;
  } catch {
    return null;
  }
}
