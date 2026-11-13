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
import type { Selectable } from 'kysely';
import { sql } from 'kysely';
import { ApiError, type FieldError } from '#libs/contract/index.js';
import type { DB } from '#libs/db/index.js';
import { iso, isoOrNull } from '#libs/http-pipeline/index.js';
import { l10n, type Locale, type Translations } from '#libs/i18n/index.js';
import type { TxScope } from '#libs/tenancy/index.js';

export const POLICY_KEYS = ['terms', 'privacy', 'community_guidelines'] as const;
export type PolicyKey = (typeof POLICY_KEYS)[number];
export type ReconsentMode = 'blocking' | 'notice';

/** DQ-02 default: terms and privacy block further use until accepted again; the guidelines show a notice. */
export const RECONSENT_MODE: Readonly<Record<PolicyKey, ReconsentMode>> = {
  terms: 'blocking',
  privacy: 'blocking',
  community_guidelines: 'notice',
};

/** Locales every policy version needs (40 Translations: platform-curated, all enabled locales). */
export const POLICY_LOCALES = ['en', 'fa'] as const;

export const isPolicyKey = (v: unknown): v is PolicyKey => typeof v === 'string' && (POLICY_KEYS as readonly string[]).includes(v);

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
    .values({ policy_key: key, region_key: region, reconsent_mode: RECONSENT_MODE[key] })
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
     WHERE v.document_id = f.document_id AND v.status IN ('scheduled', 'published') AND v.effective_at <= now()
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
}

/** The policies a user must accept again (Me.policy_reconsent), in key order. */
export async function reconsentFor(scope: TxScope, userId: string, region: string): Promise<PolicyReconsentView[]> {
  const { rows } = await sql<{ policy_key: PolicyKey; policy_version: string; effective_at: Date; mode: ReconsentMode }>`
    WITH d AS (
      SELECT id, policy_key, reconsent_mode FROM identity.policy_documents WHERE region_key = ${region} AND deleted_at IS NULL),
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
  return rows.map((r) => ({ policy_key: r.policy_key, policy_version: r.policy_version, effective_at: iso(r.effective_at), mode: r.mode }));
}

/**
 * auth.signup: the terms and privacy versions sent must be the ones in force (409 POLICY_VERSION_OUTDATED). A key
 * without a version in force in this region accepts any label (nothing to record). Returns the versions to record.
 */
export async function signupVersions(
  scope: TxScope,
  region: string,
  sent: { terms: string; privacy: string },
): Promise<string[]> {
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
    upcoming: next
      ? { policy_version: next.policy_version, effective_at: iso(next.effective_at!), requires_reconsent: next.requires_reconsent }
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
    locales: POLICY_LOCALES.filter((l) => !!titles[l] && !!(v.body_translations as Translations)[l]),
    created_by_display: (name(v.created_by) ?? 'CarPal').slice(0, 50),
    created_at: iso(v.created_at),
    published_by_display: name(v.published_by),
    approved_by_display: name(v.approved_by),
    published_at: isoOrNull(v.published_at),
  };
}

/** 40 StaffPolicyVersion (with every locale's texts and the If-Match version). */
export function toStaffVersion(key: string, v: PolicyVersionRow, inForceId: string | undefined, names: Map<string, string>, locale: Locale) {
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
