// Media data access (media.* tables only) and object keys. Storage keys
// stay inside the module (SEC-OUT-1). Assets are owned by a user or an
// organization (RLS owner_all); `USR | ORG(ANY)` operations find an asset in
// the caller's own context first and then in each organization the caller
// is an active member of, the same way jobs.get does.
import type { Selectable } from 'kysely';
import type { Authorizer } from '#libs/authz/index.js';
import { registerConstraintErrors, type DB } from '#libs/db/index.js';
import type { TxScope } from '#libs/tenancy/index.js';
import type { AttachmentTargets } from '../interface/media.js';

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
 * comes from the authorizer, so membership and status are checked). A fleet
 * driver owns the fleet's media only when they uploaded it or it is attached
 * to a record of a vehicle assigned to them (SEC-AZ-7); anything else of the
 * fleet is a foreign asset to them.
 */
export async function findVisibleAsset(
  scope: TxScope,
  authorizer: Authorizer,
  userId: string,
  assetId: string,
  lock = false,
  targets?: AttachmentTargets,
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
    const r = (await find()) ?? row;
    return {
      row: r,
      owned: m.role !== 'fleet_driver' || (await driverReaches(scope, authorizer, targets, m.orgId, userId, r)),
      orgId: m.orgId,
    };
  }
  for (const m of memberships) {
    await scope.setOrganization(m.orgId, m.role);
    const r = await find();
    if (r) {
      const own = r.owner_type === 'organization' && r.owner_id === m.orgId;
      return {
        row: r,
        owned: own && (m.role !== 'fleet_driver' || (await driverReaches(scope, authorizer, targets, m.orgId, userId, r))),
        orgId: m.orgId,
      };
    }
  }
  await scope.setOrganization(null);
  return null;
}

/** A fleet driver's own upload, or an asset attached to a record of a vehicle assigned to them. */
async function driverReaches(
  scope: TxScope,
  authorizer: Authorizer,
  targets: AttachmentTargets | undefined,
  orgId: string,
  userId: string,
  row: AssetRow,
): Promise<boolean> {
  if (row.uploaded_by === userId) return true;
  if (!targets) return false;
  const attachments = await scope.db
    .selectFrom('media.media_attachments')
    .select(['attached_to_type', 'attached_to_id'])
    .where('media_asset_id', '=', row.id)
    .where('status', '=', 'active')
    .where('deleted_at', 'is', null)
    .execute();
  for (const a of attachments) {
    const t = await targets.get(a.attached_to_type)?.(scope, a.attached_to_id);
    if (
      t?.vehicleId &&
      t.owner.type === 'organization' &&
      t.owner.id === orgId &&
      (await authorizer.isDriverAssigned(orgId, userId, t.vehicleId))
    )
      return true;
  }
  return false;
}
