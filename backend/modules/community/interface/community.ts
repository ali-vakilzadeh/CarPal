// Public interface of the community module (41 §4.2 interface/): what the
// search indexer (W2), the Discover feed and the notification dispatcher (W5)
// read from community data. Only public content (published posts, approved
// questions and answers) leaves the module; follows and favourites are read
// for their own user (matching preference, feed) or as recipient lists.
import type { TxScope } from '#libs/tenancy/index.js';

export type CommunityEntity = 'post' | 'question' | 'answer';

/** 52 §10 CommunitySearchDoc source of one public post, question or answer. */
export interface CommunitySearchSource {
  entity_type: CommunityEntity;
  entity_id: string;
  title: string | null;
  body: string;
  content_locale: string;
  /** Taxonomy context (vehicle, symptom, category or post tags). */
  node_ids: string[];
  /** Author organization (posts, answers given as a business). */
  organization_id: string | null;
  published_at: Date;
  /** Question status (open, answered) for questions. */
  status: string | null;
  /** Question of an answer. */
  question_id: string | null;
}

export interface FeedQuestion {
  id: string;
  title: string;
  status: string;
  answer_count: number;
  node_ids: string[];
  created_at: Date;
}

export interface FeedPost {
  id: string;
  organization_id: string;
  post_type: string;
  title: string | null;
  body: string;
  published_at: Date;
}

export abstract class CommunityRead {
  /** Sources of public entities, keyed "<type>:<id>"; absent keys are not (or no longer) public. */
  abstract searchSources(
    scope: TxScope,
    refs: readonly { type: CommunityEntity; id: string }[],
  ): Promise<Map<string, CommunitySearchSource>>;
  /** Public entities after a keyset position ("<type>:<id>"), for reconciliation. */
  abstract publicRefs(scope: TxScope, after: string | null, limit: number): Promise<{ type: CommunityEntity; id: string }[]>;
  /** Organizations the user saved as favourites (54 §5.1 user preference bonus). */
  abstract favoriteOrgIds(scope: TxScope, userId: string): Promise<Set<string>>;
  /** Organizations the user follows, newest first. */
  abstract followedOrgIds(scope: TxScope, userId: string, limit: number): Promise<string[]>;
  /** Followers of an organization with one of the notification preferences (W5, system context). */
  abstract followers(scope: TxScope, orgId: string, preferences: readonly ('all' | 'important_only')[]): Promise<string[]>;
  /** Recent public questions, optionally about any of the nodes (Discover feed). */
  abstract recentQuestions(scope: TxScope, o: { nodeIds?: readonly string[]; limit: number }): Promise<FeedQuestion[]>;
  /** Recent published public posts of organizations (Discover feed). */
  abstract recentPosts(scope: TxScope, orgIds: readonly string[], limit: number): Promise<FeedPost[]>;
}
