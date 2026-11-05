// W-SET-01 view model (P9.T2-T4): pure helpers the settings sections share — sections and their URLs, the public name
// preview, consent rows and shares, the consent history CSV, the notification matrix and data requests.
import type {
  ConsentRecord,
  ConsentType,
  DataSubjectRequest,
  NotificationCategory,
  NotificationChannel,
  NotificationPreference,
} from '@carpal/api-contracts';

/** Left sub-navigation of W-SET-01 (Docs/22): /<locale>/settings/<section>. */
export const SECTIONS = ['profile', 'security', 'privacy', 'ai', 'notifications', 'language', 'data', 'help'] as const;
export type Section = (typeof SECTIONS)[number];

export function isSection(v: string | undefined): v is Section {
  return !!v && (SECTIONS as readonly string[]).includes(v);
}

/** "Sara Mohammadi" → "Sara M." (Docs/21 C-PROF-01 "Your reviews show: Sara M."); a display name wins. */
export function publicName(fullName: string, displayName: string | null | undefined): string {
  const chosen = displayName?.trim();
  if (chosen) return chosen;
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0]!;
  const last = [...parts[parts.length - 1]!][0]!;
  return `${parts[0]} ${last}.`;
}

/** The general (account-wide, granted to the platform) consents of C-PROF-02, in display order. */
export const GENERAL_CONSENTS = [
  'ai_personalization',
  'marketing',
  'review_invitations',
  'location_usage',
] as const satisfies readonly ConsentType[];
export type GeneralConsent = (typeof GENERAL_CONSENTS)[number];

/** Active = granted, not withdrawn and not expired. */
export function isActive(c: ConsentRecord, now = Date.now()): boolean {
  return c.granted && !c.withdrawn_at && (!c.expires_at || Date.parse(c.expires_at) > now);
}

const isGeneral = (c: ConsentRecord) => c.scope_entity_type === null && (c.granted_to_type === 'platform' || c.granted_to_type === null);

export interface ConsentRow {
  type: GeneralConsent;
  /** Active records of this type (normally one; withdrawing withdraws all). */
  active: ConsentRecord[];
  /** Latest grant or withdrawal of this type, for "Granted 23 Sep 2026 · policy 2026-10". */
  latest: ConsentRecord | null;
}

export function consentRows(records: readonly ConsentRecord[], now = Date.now()): ConsentRow[] {
  return GENERAL_CONSENTS.map((type) => {
    const mine = records.filter((c) => c.consent_type === type && isGeneral(c));
    const latest = [...mine].sort((a, b) => changedAt(b).localeCompare(changedAt(a)))[0] ?? null;
    return { type, active: mine.filter((c) => isActive(c, now)), latest };
  });
}

/** Scoped consents still in effect (C-PROF-02 Active shares): history shared with a shop, a showcase, a photo … */
export function activeShares(records: readonly ConsentRecord[], now = Date.now()): ConsentRecord[] {
  return records.filter((c) => !isGeneral(c) && isActive(c, now)).sort((a, b) => changedAt(b).localeCompare(changedAt(a)));
}

/** When a record last changed: its withdrawal, else its grant. */
export function changedAt(c: ConsentRecord): string {
  return c.withdrawn_at ?? c.granted_at ?? c.created_at;
}

/** The change log (C-PROF-02 History): one entry per grant and per withdrawal, newest first. */
export function consentHistory(
  records: readonly ConsentRecord[],
): { at: string; record: ConsentRecord; change: 'granted' | 'withdrawn' }[] {
  const out: { at: string; record: ConsentRecord; change: 'granted' | 'withdrawn' }[] = [];
  for (const c of records) {
    if (c.granted_at) out.push({ at: c.granted_at, record: c, change: 'granted' });
    if (c.withdrawn_at) out.push({ at: c.withdrawn_at, record: c, change: 'withdrawn' });
  }
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

/** One CSV cell: quoted when needed; a leading = + - @ is neutralised so spreadsheets never run it as a formula. */
export function csvCell(value: string | null | undefined): string {
  let s = value ?? '';
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const CONSENT_CSV_COLUMNS = [
  'consent_type',
  'status',
  'granted_at',
  'withdrawn_at',
  'expires_at',
  'policy_version',
  'scope_type',
  'scope_id',
  'granted_to_type',
  'granted_to_id',
  'source',
  'record_id',
] as const;

/** Consent history download (Docs/22 W-SET-01 "downloadable consent history"): built in the browser from consents.list. */
export function consentCsv(records: readonly ConsentRecord[], now = Date.now()): string {
  const rows = [...records]
    .sort((a, b) => (a.granted_at ?? a.created_at).localeCompare(b.granted_at ?? b.created_at))
    .map((c) =>
      [
        c.consent_type,
        isActive(c, now) ? 'active' : c.withdrawn_at ? 'withdrawn' : c.granted ? 'expired' : 'declined',
        c.granted_at,
        c.withdrawn_at,
        c.expires_at,
        c.policy_version,
        c.scope_entity_type,
        c.scope_entity_id,
        c.granted_to_type,
        c.granted_to_id,
        c.source,
        c.id,
      ]
        .map(csvCell)
        .join(','),
    );
  return `${[CONSENT_CSV_COLUMNS.join(','), ...rows].join('\r\n')}\r\n`;
}

/** Rows of the consumer notification matrix (Docs/21 C-PROF-04; the business categories stay as they are). */
export const MATRIX_CATEGORIES = [
  'appointments',
  'reviews',
  'service_reminders',
  'inquiries',
  'community',
  'ai_suggestions',
  'marketing',
] as const satisfies readonly NotificationCategory[];

/** Account channels of the matrix; "Web push (this browser)" is a device subscription (P12), SMS comes later. */
export const MATRIX_CHANNELS = ['in_app', 'push', 'email'] as const satisfies readonly NotificationChannel[];

export type Frequency = NotificationPreference['frequency'];

export function prefKey(channel: NotificationChannel, category: NotificationCategory): string {
  return `${channel}:${category}`;
}

export function prefMap(items: readonly NotificationPreference[]): Map<string, NotificationPreference> {
  return new Map(items.map((p) => [prefKey(p.channel, p.category), p]));
}

/** notification_prefs.put replaces everything: send every stored row with the one change applied. */
export function withPreference(
  items: readonly NotificationPreference[],
  change: { channel: NotificationChannel; category: NotificationCategory; enabled?: boolean; frequency?: Frequency },
): NotificationPreference[] {
  const key = prefKey(change.channel, change.category);
  const found = items.some((p) => prefKey(p.channel, p.category) === key);
  const base = found
    ? items
    : [...items, { channel: change.channel, category: change.category, enabled: false, frequency: 'immediate' as Frequency }];
  return base.map((p) =>
    prefKey(p.channel, p.category) === key
      ? {
          ...p,
          ...(change.enabled !== undefined ? { enabled: change.enabled } : {}),
          ...(change.frequency ? { frequency: change.frequency } : {}),
        }
      : p,
  );
}

/** Data requests (C-PROF-07): the newest of a type and whether another one may be filed (one open request per type). */
export function latestRequest(
  requests: readonly DataSubjectRequest[],
  type: DataSubjectRequest['request_type'],
): DataSubjectRequest | null {
  return [...requests].filter((r) => r.request_type === type).sort((a, b) => b.requested_at.localeCompare(a.requested_at))[0] ?? null;
}

export function isOpen(r: DataSubjectRequest): boolean {
  return r.status !== 'completed' && r.status !== 'rejected';
}

/** The typed confirmation of account deletion (Docs/22 "final typed confirmation"), case- and space-insensitive. */
export function deletionConfirmed(typed: string, word: string): boolean {
  const norm = (s: string) => s.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
  return norm(typed) !== '' && norm(typed) === norm(word);
}

const COUNTRY_CODES =
  'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'.split(
    ' ',
  );

/** ISO 3166-1 countries by name in the UI language. */
export function countryOptions(locale: string): { value: string; label: string }[] {
  const names = new Intl.DisplayNames([locale], { type: 'region' });
  return COUNTRY_CODES.map((value) => ({ value, label: names.of(value) ?? value })).sort((a, b) => a.label.localeCompare(b.label, locale));
}

/** SMS is offered for what cannot wait (Docs/40 notification_prefs.put); fleet has no row in this matrix. */
export const SMS_CATEGORIES: readonly NotificationCategory[] = ['appointments', 'service_reminders'];

/** "22:00" of a time input; the backend takes 'HH:MM' and refuses an empty window. */
export function quietHoursValid(start: string, end: string): boolean {
  return /^\d{2}:\d{2}$/.test(start) && /^\d{2}:\d{2}$/.test(end) && start !== end;
}
