// Vehicle documents (40 §12.2): vehicles.documents_list / document_create /
// document_update / document_delete. A document is a private, encrypted
// media asset (purpose vehicle_document) of the vehicle's owner. Sharing it
// with a provider needs the owner's vehicle_data_sharing consent scoped to
// the vehicle and granted to that provider (52 VehicleDocument, CNS); a fleet
// shares its own documents by its coordinators' decision (no personal
// consent applies to organization data).
import { Injectable } from '@nestjs/common';
import { writeAudit } from '#libs/audit/index.js';
import { ConsentChecker, requireConsent } from '#libs/consent-gate/index.js';
import { ApiError, type FieldError } from '#libs/contract/index.js';
import { ACK, created, Operation, type OperationContext, type OperationHandler, type OperationResult } from '#libs/http-pipeline/index.js';
import type { TxScope } from '#libs/tenancy/index.js';
import { MediaService } from '#modules/media/interface/media.js';
import { OrgCards } from '#modules/organization/interface/org-cards.js';
import { toDocument, type DocumentRow, type VehicleRow } from '../api/projections.js';
import {
  afterId,
  checkVersion,
  failIf,
  loadVehicle,
  notFoundAt,
  pageOf,
  vehicleAccess,
  vehiclesPath,
  type VehicleAccess,
} from './common.js';

type DocumentWrite = {
  document_type: string;
  title: string;
  media_asset_id: string;
  visibility: 'private' | 'shared_with_provider' | 'fleet';
  shared_with_organization_id?: string;
  issued_at?: string;
  expires_at?: string;
};

type Sharing = Pick<DocumentWrite, 'visibility' | 'shared_with_organization_id' | 'issued_at' | 'expires_at'>;

@Injectable()
export class DocumentRules {
  constructor(
    private readonly consents: ConsentChecker,
    private readonly orgs: OrgCards,
  ) {}

  /** Conditional fields (40 DocumentWrite C:) and, when the sharing target changes, the provider and the consent. */
  async check(scope: TxScope, a: VehicleAccess, v: VehicleRow, d: Sharing, sharingChanged: boolean): Promise<void> {
    const errors: FieldError[] = [];
    if (d.visibility === 'fleet' && !a.fleet) errors.push({ pointer: '/visibility', code: 'conditional_forbidden' });
    if (d.visibility === 'shared_with_provider' && !d.shared_with_organization_id)
      errors.push({ pointer: '/shared_with_organization_id', code: 'conditional_required' });
    if (d.visibility !== 'shared_with_provider' && d.shared_with_organization_id)
      errors.push({ pointer: '/shared_with_organization_id', code: 'conditional_forbidden' });
    if (d.issued_at && d.expires_at && d.expires_at < d.issued_at) errors.push({ pointer: '/expires_at', code: 'order' });
    failIf(errors);
    if (d.visibility !== 'shared_with_provider' || !sharingChanged) return;
    const orgId = d.shared_with_organization_id!;
    const card = (await this.orgs.cards(scope, [orgId])).get(orgId);
    if (
      !card ||
      !['provider', 'hybrid_provider_vendor'].includes(card.organizationType) ||
      ['archived', 'merged', 'suspended'].includes(card.status)
    )
      throw notFoundAt('/shared_with_organization_id');
    if (v.owner_type === 'user')
      await requireConsent(this.consents, scope, {
        consentType: 'vehicle_data_sharing',
        subject: { type: 'user', id: v.owner_id },
        scopeEntity: { type: 'vehicle', id: v.id },
        grantee: { type: 'organization', id: orgId },
      });
  }
}

async function loadDocument(scope: TxScope, vehicleId: string, documentId: string, lock = false): Promise<DocumentRow> {
  const q = scope.db
    .selectFrom('vehicle.vehicle_documents')
    .selectAll()
    .where('id', '=', documentId)
    .where('vehicle_id', '=', vehicleId)
    .where('status', '=', 'active')
    .where('deleted_at', 'is', null);
  const row = await (lock ? q.forUpdate() : q).executeTakeFirst();
  if (!row) throw new ApiError('NOT_FOUND');
  return row;
}

@Injectable()
@Operation('vehicles.documents_list')
export class VehicleDocumentsListHandler implements OperationHandler {
  async handle(ctx: OperationContext<undefined, { limit: number }>): Promise<OperationResult> {
    const a = vehicleAccess(ctx);
    const after = afterId(ctx);
    const rows = await ctx.tx(
      async (scope) => {
        const v = await loadVehicle(scope, a, ctx.params.vehicle_id!);
        let q = scope.db
          .selectFrom('vehicle.vehicle_documents')
          .selectAll()
          .where('vehicle_id', '=', v.id)
          .where('status', '=', 'active')
          .where('deleted_at', 'is', null);
        if (after) q = q.where('id', '<', after);
        return q
          .orderBy('id', 'desc')
          .limit(ctx.query.limit + 1)
          .execute();
      },
      { readOnly: true },
    );
    return { body: pageOf(ctx, rows, toDocument) };
  }
}

@Injectable()
@Operation('vehicles.document_create')
export class VehicleDocumentCreateHandler implements OperationHandler {
  constructor(
    private readonly rules: DocumentRules,
    private readonly media: MediaService,
  ) {}

  async handle(ctx: OperationContext<DocumentWrite>): Promise<OperationResult> {
    const a = vehicleAccess(ctx);
    const b = ctx.body;
    const row = await ctx.tx(async (scope) => {
      const v = await loadVehicle(scope, a, ctx.params.vehicle_id!);
      await this.rules.check(scope, a, v, b, true);
      // A private, encrypted asset of the vehicle's owner, scanned clean (409 MEDIA_NOT_READY before the scan).
      await this.media.requireReady(scope, [b.media_asset_id], {
        owner: a.owner,
        purposes: ['vehicle_document'],
        pointer: '/media_asset_id',
      });
      return scope.db
        .insertInto('vehicle.vehicle_documents')
        .values({
          vehicle_id: v.id,
          document_type: b.document_type,
          title: b.title,
          media_asset_id: b.media_asset_id,
          visibility: b.visibility,
          shared_with_organization_id: b.shared_with_organization_id ?? null,
          issued_at: b.issued_at ?? null,
          expires_at: b.expires_at ?? null,
          uploaded_by: a.userId,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    });
    return created(toDocument(row), `${vehiclesPath(a)}/${row.vehicle_id}/documents/${row.id}`);
  }
}

@Injectable()
@Operation('vehicles.document_update')
export class VehicleDocumentUpdateHandler implements OperationHandler {
  constructor(private readonly rules: DocumentRules) {}

  async handle(ctx: OperationContext<Partial<Omit<DocumentWrite, 'media_asset_id'>>>): Promise<OperationResult> {
    const a = vehicleAccess(ctx);
    const b = ctx.body;
    const row = await ctx.tx(async (scope) => {
      const v = await loadVehicle(scope, a, ctx.params.vehicle_id!);
      const d = await loadDocument(scope, v.id, ctx.params.document_id!, true);
      checkVersion(d.version, ctx.ifMatch);
      const visibility = b.visibility ?? (d.visibility as Sharing['visibility']);
      // Leaving shared_with_provider drops the provider; otherwise the stored one stays unless replaced.
      const sharedWith = visibility === 'shared_with_provider' ? (b.shared_with_organization_id ?? d.shared_with_organization_id) : null;
      const merged: Sharing = {
        visibility,
        ...(sharedWith ? { shared_with_organization_id: sharedWith } : {}),
        ...((b.issued_at ?? d.issued_at) ? { issued_at: (b.issued_at ?? d.issued_at)! } : {}),
        ...((b.expires_at ?? d.expires_at) ? { expires_at: (b.expires_at ?? d.expires_at)! } : {}),
      };
      if (visibility !== 'shared_with_provider' && b.shared_with_organization_id)
        failIf([{ pointer: '/shared_with_organization_id', code: 'conditional_forbidden' }]);
      const sharingChanged = visibility !== d.visibility || sharedWith !== d.shared_with_organization_id;
      await this.rules.check(scope, a, v, merged, sharingChanged);
      return scope.db
        .updateTable('vehicle.vehicle_documents')
        .set({
          ...(b.document_type !== undefined ? { document_type: b.document_type } : {}),
          ...(b.title !== undefined ? { title: b.title } : {}),
          ...(b.issued_at !== undefined ? { issued_at: b.issued_at } : {}),
          ...(b.expires_at !== undefined ? { expires_at: b.expires_at } : {}),
          visibility,
          shared_with_organization_id: sharedWith,
        })
        .where('id', '=', d.id)
        .returningAll()
        .executeTakeFirstOrThrow();
    });
    return { body: toDocument(row) };
  }
}

@Injectable()
@Operation('vehicles.document_delete')
export class VehicleDocumentDeleteHandler implements OperationHandler {
  async handle(ctx: OperationContext): Promise<OperationResult> {
    const a = vehicleAccess(ctx);
    await ctx.tx(async (scope) => {
      const v = await loadVehicle(scope, a, ctx.params.vehicle_id!);
      const d = await loadDocument(scope, v.id, ctx.params.document_id!, true);
      // The media asset follows its retention policy (S8 purge); the document leaves every list now.
      await scope.db.updateTable('vehicle.vehicle_documents').set({ status: 'removed' }).where('id', '=', d.id).execute();
      await writeAudit(scope, {
        action: 'vehicle.document_removed',
        entityType: 'vehicle_document',
        entityId: d.id,
        previous: d.document_type,
      });
    });
    return { body: ACK };
  }
}
