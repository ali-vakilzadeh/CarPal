// Community's references to organizations for an organization merge (backend S22, BR-08): posts and answers move;
// follows and favourites move unless the user already follows (favours) the surviving organization, in which case the
// merged organization's one ends.
import { keyedRef, moveRef, type OrgReference } from '#modules/organization/interface/org-references.js';

const ended = (status: string) => `status = '${status}', deleted_at = now(), deletion_reason = 'organization merged into ' || $INTO::text`;

export function communityOrgReferences(): OrgReference[] {
  return [
    keyedRef('community.follows', {
      table: 'community.follows',
      columns: ['organization_id'],
      key: ['user_id'],
      unique: "%.status = 'active'",
      retire: ended('unfollowed'),
    }),
    keyedRef('community.favorites', {
      table: 'community.favorites',
      columns: ['organization_id'],
      key: ['user_id'],
      unique: "%.status = 'active'",
      retire: ended('removed'),
    }),
    moveRef('community.posts', { table: 'community.posts', columns: ['author_organization_id'] }),
    moveRef('community.answers', { table: 'community.answers', columns: ['author_organization_id'] }),
  ];
}
