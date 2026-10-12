// OrgCards through organization.org_cards() (42 §5.3): readable in any RLS
// context, minimal columns, at most 500 ids per call. Logos come from the
// media module and are signed only when publicly servable (52 §15).
import { Injectable, Optional } from '@nestjs/common';
import { sql } from 'kysely';
import type { OrgStatus, OrgType, VerificationStatus } from '#libs/contract/generated/enums.js';
import type { TxScope } from '#libs/tenancy/index.js';
import { MediaService } from '#modules/media/interface/media.js';
import { OrgCards, type OrgCard } from '../interface/org-cards.js';

@Injectable()
export class DbOrgCards extends OrgCards {
  // Optional: hosts without the media module (auth) get cards without logos.
  constructor(@Optional() private readonly media?: MediaService) {
    super();
  }

  async cards(scope: TxScope, ids: readonly string[]): Promise<Map<string, OrgCard>> {
    const unique = [...new Set(ids)].slice(0, 500);
    if (unique.length === 0) return new Map();
    const { rows } = await sql<{
      id: string;
      name: string;
      organization_type: string;
      slug: string | null;
      status: string;
      verification_status: string;
    }>`
      SELECT id, name, organization_type, slug, status, verification_status
        FROM organization.org_cards(${sql.val(unique)}::uuid[])`.execute(scope.db);
    const logos =
      this.media && rows.length
        ? await this.media.logoUrls(
            scope,
            rows.map((r) => r.id),
          )
        : new Map<string, string>();
    return new Map(
      rows.map((r) => [
        r.id,
        {
          id: r.id,
          name: r.name,
          organizationType: r.organization_type as OrgType,
          slug: r.slug,
          status: r.status as OrgStatus,
          verificationStatus: r.verification_status as VerificationStatus,
          logoUrl: logos.get(r.id) ?? null,
        },
      ]),
    );
  }
}
