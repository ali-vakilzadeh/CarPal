// Media's references to organizations for an organization merge (backend S22, BR-08): the files the merged
// organization owns move with the records they belong to, except its verification documents and system exports
// (they stay with the merged organization's verification history); its logo and cover attachments end.
import { historyRef, moveRef, retireRef, type OrgReference } from '#modules/organization/interface/org-references.js';

const KEPT = "('verification_document','system_export')";

export function mediaOrgReferences(): OrgReference[] {
  return [
    moveRef('media.assets', {
      table: 'media.media_assets',
      columns: ['owner_id'],
      where: `%.owner_type = 'organization' AND %.purpose NOT IN ${KEPT}`,
    }),
    historyRef('media.verification_documents', {
      table: 'media.media_assets',
      columns: ['owner_id'],
      where: `%.owner_type = 'organization' AND %.purpose IN ${KEPT}`,
    }),
    retireRef(
      'media.profile_images',
      {
        table: 'media.media_attachments',
        columns: ['attached_to_id'],
        where: "%.attached_to_type = 'organization' AND %.status = 'active'",
      },
      "status = 'removed'",
    ),
  ];
}
