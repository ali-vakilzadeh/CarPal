// Media data access (media.* tables only) and object keys. Storage keys
// stay inside the module (SEC-OUT-1). Assets are owned by a user or an
// organization (RLS owner_all); `USR | ORG(ANY)` operations find an asset in
// the caller's own context first and then in each organization the caller
// is an active member of, the same way jobs.get does.
import type { Selectable } from 'kysely';
import type { Authorizer } from '#libs/authz/index.js';
import { registerConstraintErrors, type DB } from '#libs/db/index.js';
import type { TxScope } from '#libs/tenancy/index.js';

export type AssetRow = Selectable<DB['media.media_assets']>;
export type AttachmentRow = Selectable<DB['media.media_attachments']>;

registerConstraintErrors({
  media_attachments_pair_uq: { code: 'VALIDATION_FAILED', pointer: '/pair_group_key', fieldCode: 'not_unique' },
});

/** Object keys: the raw upload, then the processed variants written by W6. */
export const keys = {
  upload: (id: string) => `uploads/${id}`,
  original: (id: string) => `media/${id}/original`,
  display: (id: string) => `media/${id}/display`,
  thumbnail: (id: string) => `media/${id}/thumb`,
};

/** Display variant of a processed asset (images); other types serve their processed original. */
export const displayKeyOf = (a: Pick<AssetRow, 'id' | 'media_type' | 'storage_reference'>): string | null =>
  a.media_type === 'image' && a.storage_reference ? keys.display(a.id) : a.storage_reference;

export const servableToOwner = (a: Pick<AssetRow, 'status' | 'scan_status'>): boolean => a.status === 'active' && a.scan_status === 'clean';

export interface VisibleAsset {
  row: AssetRow;
  /** The caller owns it (their own asset, or one of an organization they are a member of). */
  owned: boolean;
  /** Organization of an organization-owned asset the caller is a member of. */
  orgId: string | null;
}

/**
 * Finds an asset the caller may see. An organization-owned asset switches
 * the transaction to that organization's context (the caller's role there
 * comes from the authorizer, so membership and status are checked).
 */
export async function findVisibleAsset(
  scope: TxScope,
  authorizer: Authorizer,
  userId: string,
  assetId: string,
  lock = false,
): Promise<VisibleAsset | null> {
  const find = () => {
    const q = scope.db.selectFrom('media.media_assets').selectAll().where('id', '=', assetId).where('deleted_at', 'is', null);
    return (lock ? q.forUpdate() : q).executeTakeFirst();
  };
  const memberships = await authorizer.memberships(userId);
  const row = await find();
  if (row?.owner_type === 'user') return { row, owned: row.owner_id === userId, orgId: null };
  if (row?.owner_type === 'organization') {
    const m = memberships.find((x) => x.orgId === row.owner_id);
    if (!m) return { row, owned: false, orgId: null };
    await scope.setOrganization(m.orgId, m.role);
    return { row: (await find()) ?? row, owned: true, orgId: m.orgId };
  }
  for (const m of memberships) {
    await scope.setOrganization(m.orgId, m.role);
    const r = await find();
    if (r) return { row: r, owned: r.owner_type === 'organization' && r.owner_id === m.orgId, orgId: m.orgId };
  }
  await scope.setOrganization(null);
  return null;
}
