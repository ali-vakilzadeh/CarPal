// Ports the identity module serves to the platform and other modules: the
// L16 consent gate (identity.has_consent, never cached) and user display
// cards (identity.user_cards). Both are definer functions (42 §5.3), so they
// work in any caller's RLS context.
import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { ConsentChecker, type ConsentQuery } from '#libs/consent-gate/index.js';
import type { TxScope } from '#libs/tenancy/index.js';
import { AccountFacts, UserCards, type UserCard } from '../interface/identity.js';

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
