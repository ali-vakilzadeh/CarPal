// Policies and consent texts (backend S15; admin console BR-12, A-POL-01; 40 §6.7, §23.5; 52 PolicyDocument,
// PolicyVersion, PolicyAcceptance). Shared by the api host (policy.current, policy.accept, Me.policy_reconsent),
// the auth host (sign-up accepts the versions in force), the admin plane (drafts, four-eyes publish) and the
// worker (scheduled versions come into force).
//
// One document per policy key and region (the deployment's region, RegionConfigService.regionKey). The version in
// force is the newest non-draft version whose effective_at has passed; every read decides this by time, so a
// scheduled version is in force at its effective_at even before settleStatuses() has moved the stored status on.
// A user must accept a policy again when a version that requires re-consent has come into force and they have not
// accepted it or a later version: always for `blocking` documents (terms, privacy), and for `notice` documents
// (community guidelines) only when the account is older than that version.
//
// Consent texts (backend S15b, owner decisions DQ-18 and DQ-19): every ConsentType has a document of mode `consent`.
// A grant must name the consent text in force (consentTextFor) and records it; a consent stands on the newest text it
// was granted or confirmed under (SQL identity.consent_text_at). When a consent-text version that requires re-consent
// comes into force, the active consents under older texts need re-consent: listed in Me.policy_reconsent (user
// consents) and flagged on ConsentRecord (user and organization consents) until confirmed or withdrawn. The version's
// reconsent_action decides what they do meanwhile: keep (stay in effect) or pause (the consent gate treats them as not
// granted; SQL identity.consent_reconsent and identity.has_consent).
import type { Selectable } from 'kysely';
import { sql } from 'kysely';
import { writeAudit } from '#libs/audit/index.js';
import { ApiError, type FieldError } from '#libs/contract/index.js';
import { ENUMS, type ConsentType } from '#libs/contract/generated/enums.js';
import type { DB } from '#libs/db/index.js';
import { iso, isoOrNull } from '#libs/http-pipeline/index.js';
import { l10n, type Locale, type Translations } from '#libs/i18n/index.js';
import type { TxScope } from '#libs/tenancy/index.js';

/** The legal policies (DQ-02); every other key is a consent text. */
export const LEGAL_POLICY_KEYS = ['terms', 'privacy', 'community_guidelines'] as const;
export const CONSENT_TEXT_KEYS: readonly ConsentType[] = ENUMS.ConsentType;
export const POLICY_KEYS: readonly PolicyKey[] = [...LEGAL_POLICY_KEYS, ...CONSENT_TEXT_KEYS];
export type PolicyKey = (typeof LEGAL_POLICY_KEYS)[number] | ConsentType;
export type ReconsentMode = 'blocking' | 'notice' | 'consent';
/** DQ-19: what consents under an older text do until they are confirmed. */
export type ReconsentAction = 'keep' | 'pause';

export const isPolicyKey = (v: unknown): v is PolicyKey => typeof v === 'string' && (POLICY_KEYS as readonly string[]).includes(v);
export const isConsentKey = (v: unknown): v is ConsentType => typeof v === 'string' && (CONSENT_TEXT_KEYS as readonly string[]).includes(v);

/**
 * DQ-02 default: terms and privacy block further use until accepted again; the guidelines show a notice. Consent texts
 * (S15b) ask for the consents granted under an older text to be confirmed again.
 */
export const reconsentModeOf = (key: PolicyKey): ReconsentMode =>
  key === 'terms' || key === 'privacy' ? 'blocking' : key === 'community_guidelines' ? 'notice' : 'consent';

/** Locales every policy version needs (40 Translations: platform-curated, all enabled locales). */
export const POLICY_LOCALES = ['en', 'fa'] as const;

export type PolicyDocumentRow = Selectable<DB['identity.policy_documents']>;
export type PolicyVersionRow = Selectable<DB['identity.policy_versions']>;

/** 422 errors for a translations map that misses an enabled locale (undefined: not sent, nothing to check). */
export function missingLocales(t: unknown, pointer: string): FieldError[] {
  if (t === undefined || t === null) return [];
  const m = t as Record<string, string | undefined>;
  return POLICY_LOCALES.filter((l) => !m[l]?.trim()).map((l) => ({ pointer: `${pointer}/${l}`, code: 'required' as const }));
}

export async function findDocument(scope: TxScope, region: string, key: PolicyKey): Promise<PolicyDocumentRow | undefined> {
  return scope.db
    .selectFrom('identity.policy_documents')
    .selectAll()
    .where('region_key', '=', region)
    .where('policy_key', '=', key)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
}

/** The region's document of a key, created on first use (a region without seeded texts). */
export async function ensureDocument(scope: TxScope, region: string, key: PolicyKey): Promise<PolicyDocumentRow> {
  await scope.db
    .insertInto('identity.policy_documents')
    .values({ policy_key: key, region_key: region, reconsent_mode: reconsentModeOf(key) })
    .onConflict((oc) => oc.columns(['policy_key', 'region_key']).doNothing())
    .execute();
  const doc = await findDocument(scope, region, key);
  if (!doc) throw new ApiError('NOT_FOUND');
  return doc;
}

/** The version in force: newest non-draft version whose effective_at has passed. */
export async function versionInForce(scope: TxScope, documentId: string): Promise<PolicyVersionRow | undefined> {
  return scope.db
    .selectFrom('identity.policy_versions')
    .selectAll()
    .where('document_id', '=', documentId)
    .where('status', '<>', 'draft')
    .where('effective_at', '<=', sql<Date>`now()`)
    .where('deleted_at', 'is', null)
    .orderBy('effective_at', 'desc')
    .orderBy('id', 'desc')
    .executeTakeFirst();
}

/** A published version whose effective_at is still ahead (at most one per document). */
export async function upcomingVersion(scope: TxScope, documentId: string): Promise<PolicyVersionRow | undefined> {
  return scope.db
    .selectFrom('identity.policy_versions')
    .selectAll()
    .where('document_id', '=', documentId)
    .where('status', '<>', 'draft')
    .where('effective_at', '>', sql<Date>`now()`)
    .where('deleted_at', 'is', null)
    .orderBy('effective_at')
    .executeTakeFirst();
}

/**
 * Moves stored statuses on to match the clock: the version in force becomes `published`, older non-draft versions
 * `superseded` (one document, or every document). Returns the versions that changed.
 */
export async function settleStatuses(
  scope: TxScope,
  documentId?: string,
): Promise<{ id: string; document_id: string; status: string; policy_version: string }[]> {
  const { rows } = await sql<{ id: string; document_id: string; status: string; policy_version: string }>`
    WITH f AS (
      SELECT DISTINCT ON (document_id) document_id, id
        FROM identity.policy_versions
       WHERE status <> 'draft' AND effective_at <= now() AND deleted_at IS NULL
             ${documentId ? sql`AND document_id = ${documentId}::uuid` : sql``}
       ORDER BY document_id, effective_at DESC, id DESC)
    UPDATE identity.policy_versions v
       SET status = CASE WHEN v.id = f.id THEN 'published' ELSE 'superseded' END
      FROM f
     WHERE v.document_id = f.document_id AND v.status IN ('scheduled', 'published', 'superseded') AND v.effective_at <= now()
       AND v.status <> CASE WHEN v.id = f.id THEN 'published' ELSE 'superseded' END
 RETURNING v.id, v.document_id, v.status, v.policy_version`.execute(scope.db);
  return rows;
}

/** 40 PolicyReconsent. */
export interface PolicyReconsentView {
  policy_key: PolicyKey;
  policy_version: string;
  effective_at: string;
  mode: ReconsentMode;
  /** mode consent: the caller's active consents of this type under an older text (empty for policies). */
  consent_ids: string[];
  /** mode consent: some of them are paused until confirmed (DQ-19 b). */
  paused: boolean;
}

/** The policies a user must accept again and the consent types whose consents need confirming (Me.policy_reconsent). */
export async function reconsentFor(scope: TxScope, userId: string, region: string): Promise<PolicyReconsentView[]> {
  return [...(await policiesToAccept(scope, userId, region)), ...(await consentsToConfirm(scope, userId, region))];
}

/** Legal policies (blocking, notice) the user must accept again, in key order. */
async function policiesToAccept(scope: TxScope, userId: string, region: string): Promise<PolicyReconsentView[]> {
  const { rows } = await sql<{ policy_key: PolicyKey; policy_version: string; effective_at: Date; mode: ReconsentMode }>`
    WITH d AS (
      SELECT id, policy_key, reconsent_mode FROM identity.policy_documents
       WHERE region_key = ${region} AND reconsent_mode <> 'consent' AND deleted_at IS NULL),
    f AS (
      SELECT DISTINCT ON (v.document_id) v.document_id, v.policy_version, v.effective_at
        FROM identity.policy_versions v JOIN d ON d.id = v.document_id
       WHERE v.status <> 'draft' AND v.effective_at <= now() AND v.deleted_at IS NULL
       ORDER BY v.document_id, v.effective_at DESC, v.id DESC),
    r AS (
      SELECT v.document_id, max(v.effective_at) AS since
        FROM identity.policy_versions v JOIN d ON d.id = v.document_id
       WHERE v.status <> 'draft' AND v.requires_reconsent AND v.effective_at <= now() AND v.deleted_at IS NULL
       GROUP BY v.document_id)
    SELECT d.policy_key, f.policy_version, f.effective_at, d.reconsent_mode AS mode
      FROM d
      JOIN f ON f.document_id = d.id
      JOIN r ON r.document_id = d.id
      JOIN identity.user_accounts u ON u.id = ${userId}::uuid
     WHERE (d.reconsent_mode = 'blocking' OR u.created_at < r.since)
       AND NOT EXISTS (
             SELECT 1 FROM identity.policy_acceptances a
               JOIN identity.policy_versions av ON av.id = a.policy_version_id
              WHERE a.user_id = ${userId}::uuid AND av.document_id = d.id AND av.effective_at >= r.since)
     ORDER BY array_position(ARRAY['terms','privacy','community_guidelines'], d.policy_key::text)`.execute(scope.db);
  return rows.map((r) => ({
    policy_key: r.policy_key,
    policy_version: r.policy_version,
    effective_at: iso(r.effective_at),
    mode: r.mode,
    consent_ids: [],
    paused: false,
  }));
}

/** The SQL state of a consent row `c` in a region: null (nothing to confirm), keep or pause (DQ-19). */
const reconsentOf = (region: string) =>
  sql<ReconsentAction | null>`CASE WHEN c.granted AND c.withdrawn_at IS NULL AND (c.expires_at IS NULL OR c.expires_at > now())
    THEN identity.consent_reconsent(c.consent_type, identity.consent_text_at(c.id, c.policy_version_id, c.granted_at), ${region})
    END`;

/** One entry per consent type whose active user consents stand on a text older than a re-consent version in force. */
async function consentsToConfirm(scope: TxScope, userId: string, region: string): Promise<PolicyReconsentView[]> {
  const { rows } = await sql<{ policy_key: ConsentType; policy_version: string; effective_at: Date; ids: string[]; paused: boolean }>`
    WITH c AS (
      SELECT c.id, c.consent_type::text AS consent_type, ${reconsentOf(region)} AS action
        FROM identity.consent_records c
       WHERE c.subject_type = 'user' AND c.subject_id = ${userId}::uuid AND c.deleted_at IS NULL),
    f AS (
      SELECT DISTINCT ON (d.id) d.policy_key, v.policy_version, v.effective_at
        FROM identity.policy_documents d JOIN identity.policy_versions v ON v.document_id = d.id
       WHERE d.region_key = ${region} AND d.reconsent_mode = 'consent' AND d.deleted_at IS NULL
         AND v.status <> 'draft' AND v.effective_at <= now() AND v.deleted_at IS NULL
       ORDER BY d.id, v.effective_at DESC, v.id DESC)
    SELECT f.policy_key, f.policy_version, f.effective_at, array_agg(c.id ORDER BY c.id) AS ids,
           bool_or(c.action = 'pause') AS paused
      FROM c JOIN f ON f.policy_key = c.consent_type
     WHERE c.action IS NOT NULL
     GROUP BY f.policy_key, f.policy_version, f.effective_at
     ORDER BY array_position(${sql.val([...CONSENT_TEXT_KEYS])}::text[], f.policy_key)`.execute(scope.db);
  return rows.map((r) => ({
    policy_key: r.policy_key,
    policy_version: r.policy_version,
    effective_at: iso(r.effective_at),
    mode: 'consent' as const,
    consent_ids: r.ids.slice(0, 100),
    paused: r.paused,
  }));
}

/** Re-consent state and latest confirmation of consent records (40 ConsentRecord, S15b). */
export interface ConsentTextState {
  reconsent: ReconsentAction | null;
  confirmedVersion: string | null;
  confirmedAt: Date | null;
}

export async function consentStates(scope: TxScope, region: string, ids: readonly string[]): Promise<Map<string, ConsentTextState>> {
  if (ids.length === 0) return new Map();
  const { rows } = await sql<{
    id: string;
    reconsent: ReconsentAction | null;
    confirmed_version: string | null;
    confirmed_at: Date | null;
  }>`
    SELECT c.id, ${reconsentOf(region)} AS reconsent, k.policy_version AS confirmed_version, k.confirmed_at
      FROM identity.consent_records c
      LEFT JOIN LATERAL (
        SELECT v.policy_version, k.confirmed_at
          FROM identity.consent_confirmations k JOIN identity.policy_versions v ON v.id = k.policy_version_id
         WHERE k.consent_id = c.id AND k.deleted_at IS NULL
         ORDER BY v.effective_at DESC, k.confirmed_at DESC
         LIMIT 1) k ON true
     WHERE c.id = ANY(${sql.val([...new Set(ids)])}::uuid[])`.execute(scope.db);
  return new Map(rows.map((r) => [r.id, { reconsent: r.reconsent, confirmedVersion: r.confirmed_version, confirmedAt: r.confirmed_at }]));
}

/**
 * The consent text in force a grant refers to (S15b.T2): the label sent must be the version in force of that consent
 * type in the region (409 POLICY_VERSION_OUTDATED, detail the consent type). A region without a text of the type
 * accepts any label and records no text (null), like sign-up without terms (signupVersions).
 */
export async function consentTextFor(scope: TxScope, region: string, consentType: ConsentType, sent: string): Promise<string | null> {
  const doc = await findDocument(scope, region, consentType);
  const current = doc ? await versionInForce(scope, doc.id) : undefined;
  if (!current) return null;
  if (current.policy_version !== sent) throw new ApiError('POLICY_VERSION_OUTDATED', { detail: consentType });
  return current.id;
}

/**
 * Confirms consents under the consent text in force (S15b.T3): the subject's active consents of the type (or the one
 * named) that stand on an older text get a confirmation row and an audit entry. 404 when the region has no text of the
 * type; 409 POLICY_VERSION_OUTDATED when the label is not the one in force. Returns the text and the consents confirmed.
 */
export async function confirmConsents(
  scope: TxScope,
  region: string,
  q: {
    subject: { type: 'user' | 'organization'; id: string };
    consentType: ConsentType;
    policyVersion: string;
    consentId?: string;
    by: string;
  },
): Promise<{ version: PolicyVersionRow; confirmed: string[] }> {
  const doc = await findDocument(scope, region, q.consentType);
  const current = doc ? await versionInForce(scope, doc.id) : undefined;
  if (!current) throw new ApiError('NOT_FOUND');
  if (current.policy_version !== q.policyVersion) throw new ApiError('POLICY_VERSION_OUTDATED', { detail: q.consentType });
  const { rows } = await sql<{ id: string }>`
    INSERT INTO identity.consent_confirmations (consent_id, policy_version_id, confirmed_by)
    SELECT c.id, ${current.id}::uuid, ${q.by}::uuid
      FROM identity.consent_records c
     WHERE c.subject_type = ${q.subject.type} AND c.subject_id = ${q.subject.id}::uuid
       AND c.consent_type = ${q.consentType} AND c.deleted_at IS NULL
       AND c.granted AND c.withdrawn_at IS NULL AND (c.expires_at IS NULL OR c.expires_at > now())
       ${q.consentId ? sql`AND c.id = ${q.consentId}::uuid` : sql``}
       AND identity.consent_text_at(c.id, c.policy_version_id, c.granted_at)
           < (SELECT v.effective_at FROM identity.policy_versions v WHERE v.id = ${current.id}::uuid)
    ON CONFLICT (consent_id, policy_version_id) DO NOTHING
    RETURNING consent_id AS id`.execute(scope.db);
  for (const r of rows)
    await writeAudit(scope, {
      action: 'consent.confirmed',
      entityType: 'consent_record',
      entityId: r.id,
      next: `${q.consentType} ${current.policy_version} (${region})`,
    });
  return { version: current, confirmed: rows.map((r) => r.id) };
}

/**
 * auth.signup: the terms and privacy versions sent must be the ones in force (409 POLICY_VERSION_OUTDATED). A key
 * without a version in force in this region accepts any label (nothing to record). Returns the versions to record.
 */
export async function signupVersions(scope: TxScope, region: string, sent: { terms: string; privacy: string }): Promise<string[]> {
  const ids: string[] = [];
  for (const key of ['terms', 'privacy'] as const) {
    const doc = await findDocument(scope, region, key);
    const current = doc ? await versionInForce(scope, doc.id) : undefined;
    if (!current) continue;
    if (current.policy_version !== sent[key]) throw new ApiError('POLICY_VERSION_OUTDATED', { detail: key });
    ids.push(current.id);
  }
  return ids;
}

export async function recordAcceptances(
  scope: TxScope,
  userId: string,
  versionIds: string[],
  source: 'signup' | 'prompt',
): Promise<{ id: string; accepted_at: Date }[]> {
  if (versionIds.length === 0) return [];
  return scope.db
    .insertInto('identity.policy_acceptances')
    .values(versionIds.map((policy_version_id) => ({ user_id: userId, policy_version_id, source })))
    .onConflict((oc) => oc.columns(['user_id', 'policy_version_id']).doNothing())
    .returning(['id', 'accepted_at'])
    .execute();
}

// ------------------------------------------------------------------ views

/** Status as clients see it: by the clock, whatever the stored status says (40 PolicyVersionStatus). */
export function displayStatus(v: PolicyVersionRow, inForceId: string | undefined, now = new Date()): string {
  if (v.status === 'draft' || !v.effective_at) return 'draft';
  if (v.effective_at > now) return 'scheduled';
  return v.id === inForceId ? 'published' : 'superseded';
}

/** 40 PolicyText (public). */
export function toPolicyText(doc: PolicyDocumentRow, v: PolicyVersionRow, next: PolicyVersionRow | undefined, locale: Locale) {
  const fallback = { text: '', locale };
  return {
    policy_key: doc.policy_key as PolicyKey,
    policy_version: v.policy_version,
    title: l10n(v.title_translations as Translations, locale) ?? fallback,
    body: l10n(v.body_translations as Translations, locale) ?? fallback,
    change_summary: l10n(v.change_summary_translations as Translations | null, locale),
    effective_at: iso(v.effective_at!),
    requires_reconsent: v.requires_reconsent,
    reconsent_mode: doc.reconsent_mode as ReconsentMode,
    reconsent_action: v.reconsent_action as ReconsentAction | null,
    upcoming: next
      ? {
          policy_version: next.policy_version,
          effective_at: iso(next.effective_at!),
          requires_reconsent: next.requires_reconsent,
          reconsent_action: next.reconsent_action as ReconsentAction | null,
        }
      : null,
  };
}

/** 40 StaffPolicyVersionSummary; `names` maps staff ids to display names. */
export function toStaffSummary(
  key: string,
  v: PolicyVersionRow,
  inForceId: string | undefined,
  names: Map<string, string>,
  locale: Locale,
) {
  const name = (id: string | null) => (id ? (names.get(id) ?? null) : null);
  const titles = v.title_translations as Translations;
  return {
    id: v.id,
    policy_key: key as PolicyKey,
    policy_version: v.policy_version,
    status: displayStatus(v, inForceId),
    title: l10n(titles, locale) ?? { text: '', locale },
    effective_at: isoOrNull(v.effective_at),
    requires_reconsent: v.requires_reconsent,
    reconsent_action: v.reconsent_action as ReconsentAction | null,
    locales: POLICY_LOCALES.filter((l) => !!titles[l] && !!(v.body_translations as Translations)[l]),
    created_by_display: (name(v.created_by) ?? 'CarPal').slice(0, 50),
    created_at: iso(v.created_at),
    published_by_display: name(v.published_by),
    approved_by_display: name(v.approved_by),
    published_at: isoOrNull(v.published_at),
  };
}

/** 40 StaffPolicyVersion (with every locale's texts and the If-Match version). */
export function toStaffVersion(
  key: string,
  v: PolicyVersionRow,
  inForceId: string | undefined,
  names: Map<string, string>,
  locale: Locale,
) {
  return {
    ...toStaffSummary(key, v, inForceId, names, locale),
    title_translations: v.title_translations,
    body_translations: v.body_translations,
    change_summary_translations: v.change_summary_translations,
    version: v.version,
  };
}

/** The staff ids a version names (author, publisher, approver). */
export const staffIdsOf = (rows: PolicyVersionRow[]) => rows.flatMap((v) => [v.created_by, v.published_by, v.approved_by]);
