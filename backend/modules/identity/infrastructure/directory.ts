// Ports the identity module serves to the platform and other modules: the
// L16 consent gate (identity.has_consent, never cached) and user display
// cards (identity.user_cards). Both are definer functions (42 §5.3), so they
// work in any caller's RLS context.
import { Injectable, Optional } from '@nestjs/common';
import { sql } from 'kysely';
import { writeAudit } from '#libs/audit/index.js';
import { OrganizationDirectory } from '#libs/authz/index.js';
import { ConsentChecker, type ConsentQuery } from '#libs/consent-gate/index.js';
import { ApiError } from '#libs/contract/index.js';
import type { TxScope } from '#libs/tenancy/index.js';
import { AccountFacts, ConsentGrants, UserCards, type ScopedConsentGrant, type UserCard } from '../interface/identity.js';

@Injectable()
export class DbConsentChecker extends ConsentChecker {
  async isGranted(scope: TxScope, q: ConsentQuery): Promise<boolean> {
    const { rows } = await sql<{ ok: boolean }>`
      SELECT identity.has_consent(${q.subject.type}, ${q.subject.id}::uuid, ${q.consentType},
                                  ${q.scopeEntity?.type ?? null}, ${q.scopeEntity?.id ?? null}::uuid,
                                  ${q.grantee?.type ?? null}, ${q.grantee?.id ?? null}::uuid) AS ok`.execute(scope.db);
    return rows[0]?.ok === true;
  }
}

@Injectable()
export class DbUserCards extends UserCards {
  async cards(scope: TxScope, ids: readonly string[]): Promise<Map<string, UserCard>> {
    const unique = [...new Set(ids)].slice(0, 500);
    if (unique.length === 0) return new Map();
    const { rows } = await sql<{ id: string; display_name: string | null; status: string }>`
      SELECT id, display_name, status FROM identity.user_cards(${sql.val(unique)}::uuid[])`.execute(scope.db);
    return new Map(rows.map((r) => [r.id, { id: r.id, displayName: r.display_name, status: r.status }]));
  }
}

@Injectable()
export class DbAccountFacts extends AccountFacts {
  async hasVerifiedContact(scope: TxScope, userId: string): Promise<boolean> {
    const row = await scope.db
      .selectFrom('identity.user_accounts')
      .select(['email_verified_at', 'phone_verified_at', 'status'])
      .where('id', '=', userId)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    return !!row && row.status === 'active' && (row.email_verified_at !== null || row.phone_verified_at !== null);
  }
}

/**
 * Consents recorded by another module together with its own record (the
 * inquiry's vendor_fitment_context). Runs in the signed-in subject's
 * context (policy subject_all) and is audited like consents.grant.
 */
@Injectable()
export class DbConsentGrants extends ConsentGrants {
  // Not bound on the auth host (no organization module there); grants happen on the api host only.
  constructor(@Optional() private readonly orgs?: OrganizationDirectory) {
    super();
  }

  async grantScoped(scope: TxScope, g: ScopedConsentGrant): Promise<string> {
    const org = await this.orgs?.get(g.grantee.id);
    if (!org || org.status === 'merged' || org.status === 'archived')
      throw new ApiError('REFERENCE_NOT_FOUND', { detail: 'consent grantee organization unknown' });
    const row = await scope.db
      .insertInto('identity.consent_records')
      .values({
        subject_type: 'user',
        subject_id: g.subjectUserId,
        consent_type: g.consentType,
        scope_entity_type: g.scope.type,
        scope_entity_id: g.scope.id,
        granted_to_type: g.grantee.type,
        granted_to_id: g.grantee.id,
        policy_version: g.policyVersion,
        granted: true,
        granted_at: sql`now()`,
        source: 'ui',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await writeAudit(scope, { action: 'consent.granted', entityType: 'consent_record', entityId: row.id, next: g.consentType });
    return row.id;
  }
}
