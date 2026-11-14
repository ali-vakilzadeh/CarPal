// Typed target snapshots of moderation cases (40 §23.1 TargetSnapshot, ContentAuthor, CaseTargetSummary; backend
// S18, admin console BR-27, BR-33). The module that owns a record builds its snapshot fields and names its author
// (ModerationTargets); this service adds the author block every content snapshot carries: the display name, the role
// (member, or the type of the organization the record was written for), the organization card and the author's
// history (the owning module's live and removed counts plus the warn_user actions in the moderation log).
import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type { TxScope } from '#libs/tenancy/index.js';
import { OrgCards, toOrgSummary } from '#modules/organization/interface/org-cards.js';
import { ModerationTargets, StaffNames, subjectKey, type SubjectRef, type TargetAuthor, type TargetSummary } from '../interface/admin.js';

/** 40 ContentAuthor. */
export interface ContentAuthorView {
  user_id: string;
  display_name: string;
  role: string;
  organization: ReturnType<typeof toOrgSummary> | null;
  history: { published: number; removed: number; warnings: number } | null;
}

type AuthorRef = Pick<TargetAuthor, 'userId' | 'organizationId'> & Partial<Pick<TargetAuthor, 'published' | 'removed'>>;

@Injectable()
export class CaseSnapshots {
  constructor(
    private readonly targets: ModerationTargets,
    private readonly names: StaffNames,
    private readonly orgs: OrgCards,
  ) {}

  /** 40 TargetSnapshot of a record: its type's fields with the author block, or UnavailableSnapshot once it is gone. */
  async snapshot(scope: TxScope, type: string, id: string, locale: string): Promise<Record<string, unknown>> {
    const handler = this.targets.get(type);
    const fields = handler ? await handler.snapshot(scope, id, locale) : null;
    if (!handler || !fields) return { type, id, available: false };
    if (!handler.authorOf) return fields;
    const author = await handler.authorOf(scope, id);
    return { ...fields, author: author ? (await this.authors(scope, [author], locale, true))[0]! : null };
  }

  /** ContentAuthor blocks in input order; `history` (published, removed, warnings) only when asked for. */
  async authors(scope: TxScope, refs: readonly AuthorRef[], locale: string, withHistory: boolean): Promise<ContentAuthorView[]> {
    if (refs.length === 0) return [];
    const [names, cards, warnings] = await Promise.all([
      this.names.names(
        scope,
        refs.map((r) => r.userId),
        locale,
      ),
      this.orgs.cards(
        scope,
        refs.map((r) => r.organizationId).filter((x): x is string => !!x),
      ),
      withHistory ? this.warnings(scope, [...new Set(refs.map((r) => r.userId))]) : Promise.resolve(new Map<string, number>()),
    ]);
    return refs.map((r) => {
      const card = r.organizationId ? cards.get(r.organizationId) : undefined;
      return {
        user_id: r.userId,
        display_name: names.get(r.userId)!,
        role: card ? card.organizationType : 'member',
        organization: card ? toOrgSummary(card) : null,
        history: withHistory ? { published: r.published ?? 0, removed: r.removed ?? 0, warnings: warnings.get(r.userId) ?? 0 } : null,
      };
    });
  }

  /** CaseTargetSummary per "type:id" for the records that still exist (one batch per target type). */
  async summaries(scope: TxScope, refs: readonly SubjectRef[], locale: string): Promise<Map<string, TargetSummary>> {
    const byType = new Map<string, string[]>();
    for (const r of refs) byType.set(r.type, [...(byType.get(r.type) ?? []), r.id]);
    const out = new Map<string, TargetSummary>();
    for (const [type, ids] of byType) {
      const found = (await this.targets.get(type)?.summaries(scope, [...new Set(ids)], locale)) ?? new Map<string, TargetSummary>();
      for (const [id, s] of found) out.set(subjectKey({ type, id }), s);
    }
    return out;
  }

  /** warn_user actions on each account (the moderation log records the warned user in params.user_id). */
  private async warnings(scope: TxScope, userIds: string[]): Promise<Map<string, number>> {
    const { rows } = await sql<{ user_id: string; n: string }>`
      SELECT params ->> 'user_id' AS user_id, count(*) AS n
        FROM admin.moderation_actions
       WHERE action_type = 'warn_user' AND params ->> 'user_id' = ANY(${sql.val(userIds)}::text[])
       GROUP BY 1`.execute(scope.db);
    return new Map(rows.map((r) => [r.user_id, Number(r.n)]));
  }
}
