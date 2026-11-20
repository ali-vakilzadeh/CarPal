// Policies & consent texts (AC14.T4): the pure rules of the screen, kept apart for unit tests. A draft needs a version
// label and a title and text in every enabled locale (Docs/40 PolicyVersionWrite); a publish needs an effective time
// that is not in the past, read on the staff member's clock, and offers the keep / pause choice only for a consent
// text that requires re-consent (DQ-19, backend S15b: 422 conditional_forbidden otherwise).
import type { PolicyKey, PolicyVersionStatus, ReconsentAction, ReconsentMode, StaffPolicyVersion } from '@carpal/api-contracts';
import { toLatinDigits } from '@/lib/format';
import { zoneOffsetMinutes } from '@/features/plans';

export const POLICY_LOCALES = ['en', 'fa'] as const;
export type PolicyLocale = (typeof POLICY_LOCALES)[number];

export const POLICY_KEYS: readonly PolicyKey[] = [
  'terms',
  'privacy',
  'community_guidelines',
  'vehicle_data_sharing',
  'service_history_sharing',
  'vendor_fitment_context',
  'photo_publishing',
  'showcase_publishing',
  'ai_personalization',
  'review_invitations',
  'fleet_driver_data_visibility',
  'fleet_data_ai_use',
  'provider_analytics_ai_use',
  'vendor_inventory_ai_use',
  'location_usage',
  'marketing',
];
export const RECONSENT_MODES: readonly ReconsentMode[] = ['blocking', 'notice', 'consent'];
export const VERSION_STATUSES: readonly PolicyVersionStatus[] = ['draft', 'scheduled', 'published', 'superseded'];
export const RECONSENT_ACTIONS: readonly ReconsentAction[] = ['keep', 'pause'];

/** Contract limits of the write (Docs/40 PolicyVersionWrite): label Str<1,20>, title Str<1,200>, summary Str<0,1000>. */
export const LABEL_MAX = 20;
export const TITLE_MAX = 200;
export const SUMMARY_MAX = 1000;
/** Text Str<1,60000> per locale (Docs/40; the 256 KiB body of SEC-IN-1 holds both). */
export const BODY_MAX = 60_000;

export type Texts = Record<PolicyLocale, string>;
export interface VersionDraft {
  label: string;
  title: Texts;
  body: Texts;
  summary: Texts;
}
export type DraftProblem = 'label' | `title.${PolicyLocale}` | `body.${PolicyLocale}` | `summary.${PolicyLocale}`;

const texts = (v: Partial<Record<PolicyLocale, string>> | null | undefined): Texts => ({ en: v?.en ?? '', fa: v?.fa ?? '' });

/** A draft from a stored version (to edit it, or to start the next version from it with an empty label). */
export function draftOf(v: StaffPolicyVersion | null, keepLabel = true): VersionDraft {
  return {
    label: v && keepLabel ? v.policy_version : '',
    title: texts(v?.title_translations),
    body: texts(v?.body_translations),
    summary: keepLabel ? texts(v?.change_summary_translations) : texts(null),
  };
}

/** The draft as the contract's write (without the reason), or what is wrong with it. */
export function writeOf(d: VersionDraft):
  | {
      value: {
        policy_version: string;
        title_translations: Texts;
        body_translations: Texts;
        change_summary_translations?: Partial<Texts>;
      };
    }
  | { problems: DraftProblem[] } {
  const problems: DraftProblem[] = [];
  const label = toLatinDigits(d.label).trim();
  if (!label || label.length > LABEL_MAX) problems.push('label');
  for (const l of POLICY_LOCALES) {
    const title = d.title[l].trim();
    if (!title || title.length > TITLE_MAX) problems.push(`title.${l}`);
    if (!d.body[l].trim() || d.body[l].length > BODY_MAX) problems.push(`body.${l}`);
    if (d.summary[l].trim().length > SUMMARY_MAX) problems.push(`summary.${l}`);
  }
  // A change summary is optional, but once given the backend wants it in every locale (checkTexts; DI-40).
  const summaryGiven = POLICY_LOCALES.some((l) => d.summary[l].trim());
  for (const l of POLICY_LOCALES)
    if (summaryGiven && !d.summary[l].trim() && !problems.includes(`summary.${l}`)) problems.push(`summary.${l}`);
  if (problems.length) return { problems };
  const summary = summaryOf(d.summary);
  return {
    value: {
      policy_version: label,
      title_translations: { en: d.title.en.trim(), fa: d.title.fa.trim() },
      body_translations: { en: d.body.en, fa: d.body.fa },
      ...(summary ? { change_summary_translations: summary } : {}),
    },
  };
}

/** The change summary with only the locales that have one (each entry is Str<1,1000>); null when there is none. */
export function summaryOf(s: Texts): Partial<Texts> | null {
  const out: Partial<Texts> = {};
  for (const l of POLICY_LOCALES) if (s[l].trim()) out[l] = s[l].trim();
  return Object.keys(out).length ? out : null;
}

/** Only the fields that changed, for admin.policy_version_update (a PATCH). */
export function patchOf(stored: StaffPolicyVersion, value: NonNullable<Extract<ReturnType<typeof writeOf>, { value: unknown }>['value']>) {
  const before = draftOf(stored);
  const patch: {
    policy_version?: string;
    title_translations?: Texts;
    body_translations?: Texts;
    change_summary_translations?: Partial<Texts> | null;
  } = {};
  if (value.policy_version !== before.label) patch.policy_version = value.policy_version;
  if (JSON.stringify(value.title_translations) !== JSON.stringify(before.title)) patch.title_translations = value.title_translations;
  if (JSON.stringify(value.body_translations) !== JSON.stringify(before.body)) patch.body_translations = value.body_translations;
  const summary = value.change_summary_translations ?? null;
  if (JSON.stringify(summary) !== JSON.stringify(summaryOf(before.summary))) patch.change_summary_translations = summary;
  return patch;
}

/** A day (YYYY-MM-DD) and time (HH:mm) on the staff member's clock as an ISO instant; null when malformed. */
export function zonedIso(day: string, time: string, timeZone: string): string | null {
  const d = toLatinDigits(day).trim();
  const tm = toLatinDigits(time).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(tm)) return null;
  const naive = new Date(`${d}T${tm}:00Z`);
  if (Number.isNaN(naive.getTime())) return null;
  return new Date(naive.getTime() - zoneOffsetMinutes(naive, timeZone) * 60_000).toISOString();
}

export interface PublishDraft {
  when: 'approval' | 'at';
  day: string;
  time: string;
  reconsent: boolean;
  action: ReconsentAction;
}

/** Whether the keep / pause choice applies (a consent text that asks for re-consent, DQ-19). */
export const offersReconsentAction = (mode: ReconsentMode, reconsent: boolean) => mode === 'consent' && reconsent;

/**
 * The publish body (without the reason) or the problem. "As soon as approved" sends the current time: a version
 * approved after its effective time comes into force at approval (backend S15).
 */
export function publishOf(
  p: PublishDraft,
  mode: ReconsentMode,
  timeZone: string,
  now = Date.now(),
): { value: { effective_at: string; requires_reconsent: boolean; reconsent_action?: ReconsentAction } } | { problem: 'when' | 'past' } {
  let at: string;
  if (p.when === 'approval') at = new Date(now).toISOString();
  else {
    const iso = zonedIso(p.day, p.time, timeZone);
    if (!iso) return { problem: 'when' };
    if (new Date(iso).getTime() < now) return { problem: 'past' };
    at = iso;
  }
  return {
    value: {
      effective_at: at,
      requires_reconsent: p.reconsent,
      ...(offersReconsentAction(mode, p.reconsent) ? { reconsent_action: p.action } : {}),
    },
  };
}

export const statusTone = (s: PolicyVersionStatus) =>
  s === 'published' ? 'success' : s === 'scheduled' ? 'accent' : s === 'draft' ? 'signal' : 'neutral';
