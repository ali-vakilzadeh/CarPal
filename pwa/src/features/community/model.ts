// Community view models (P8): pure helpers shared by the server pages and the client screens — the contact-data rule
// the backend holds content with (GD-22, BA-17), question indexing, answer order, reaction vocabulary, the Discover
// feed's card shapes (FeedCard is server-defined JSON, so it is read defensively) and its blocks. No React here.
import type { FeedItem, PublicAnswer, PublicOrgCard, PublicQuestion } from '@carpal/api-contracts';
import type { MessageKey } from '@/lib/i18n/keys';

// ---------------------------------------------------------------------------------------------- moderation

const URL_RE = /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(?:com|net|org|ir|io|app|info|me|co)\b/i;
const EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]{2,}/;
const PHONE_RE = /(?:\+?\d[\s-]?){9,}/;

/**
 * True when the backend's automatic pre-moderation will hold this text for a moderator (backend rules.ts
 * autoModeration: a link, an email address or a phone number, Persian/Arabic digits included). The composer warns
 * before sending and shows "Being reviewed" afterwards; community.test.ts checks this copy against the backend's.
 */
export function heldForReview(...texts: (string | null | undefined)[]): boolean {
  const text = texts.filter(Boolean).join('\n');
  const latin = text.replace(/[۰-۹٠-٩]/g, (d) => String((d.charCodeAt(0) & 0xf) % 10));
  return URL_RE.test(latin) || EMAIL_RE.test(latin) || PHONE_RE.test(latin);
}

/** Text length as the backend counts it (code points); bodies need ≥ 10. */
export const textLength = (s: string): number => [...s.trim()].length;
export const MIN_BODY = 10;
export const MIN_TITLE = 5;
export const MAX_TITLE = 160;
export const MAX_BODY = 5000;
export const MAX_COMMENT = 2000;

// ---------------------------------------------------------------------------------------------- questions

/**
 * W-PUB-06 SEO: a question page is indexed (and carries QAPage JSON-LD) only once it is answered — the asker accepted
 * an answer (status answered). Open questions, with or without answers, and closed ones stay noindex (P8 decision,
 * OQ-20: Docs/22 says "at least one answer").
 */
export function isIndexable(q: Pick<PublicQuestion, 'status' | 'accepted_answer_id'>): boolean {
  return q.status === 'answered' && q.accepted_answer_id !== null;
}

/** Accepted answer first, then most helpful, then oldest (the backend's order, kept after local changes). */
export function orderAnswers(answers: readonly PublicAnswer[], acceptedId: string | null): PublicAnswer[] {
  return [...answers].sort(
    (a, b) =>
      Number(b.id === acceptedId) - Number(a.id === acceptedId) ||
      b.helpful_count - a.helpful_count ||
      a.created_at.localeCompare(b.created_at),
  );
}

/** "BMW · 3 Series · Tyres" — the public context of a question (never the private vehicle). */
export function questionContext(q: Pick<PublicQuestion, 'vehicle' | 'category' | 'symptom'>): string[] {
  return [
    [q.vehicle.brand?.text, q.vehicle.model?.text, q.vehicle.series?.text].filter(Boolean).join(' '),
    q.category?.text ?? '',
    q.symptom?.text ?? '',
  ].filter(Boolean);
}

export const excerpt = (text: string, max = 160): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return [...flat].length <= max
    ? flat
    : `${[...flat]
        .slice(0, max - 1)
        .join('')
        .trimEnd()}…`;
};

// ---------------------------------------------------------------------------------------------- reactions

export type ReactionType = 'helpful' | 'like';
export type ReactionTargetType = 'review' | 'answer' | 'post' | 'comment' | 'portfolio_item';

/**
 * The contract has two reaction types (backend rules.ts reactionAllowed): helpful on reviews, answers and posts; like
 * on posts, comments and portfolio items. Docs/22 §7 names three (Helpful / Great work / Thanks): like is shown as
 * "Great work" on showcases and posts and "Thanks" on comments (DI-49).
 */
export function reactionsFor(target: ReactionTargetType): { type: ReactionType; label: MessageKey; icon: 'thumb' | 'star' | 'heart' }[] {
  switch (target) {
    case 'answer':
    case 'review':
      return [{ type: 'helpful', label: 'community.reaction.helpful', icon: 'thumb' }];
    case 'post':
      return [
        { type: 'helpful', label: 'community.reaction.helpful', icon: 'thumb' },
        { type: 'like', label: 'community.reaction.greatWork', icon: 'star' },
      ];
    case 'portfolio_item':
      return [{ type: 'like', label: 'community.reaction.greatWork', icon: 'star' }];
    case 'comment':
      return [{ type: 'like', label: 'community.reaction.thanks', icon: 'heart' }];
  }
}

export interface ReactionState {
  on: boolean;
  count: number;
}

/** The optimistic step of a toggle. */
export const toggled = (s: ReactionState): ReactionState => ({ on: !s.on, count: Math.max(0, s.count + (s.on ? -1 : 1)) });

// ---------------------------------------------------------------------------------------------- Discover feed

type Obj = Record<string, unknown>;
const str = (o: Obj, k: string): string | null => (typeof o[k] === 'string' ? (o[k] as string) : null);
const num = (o: Obj, k: string): number | null => (typeof o[k] === 'number' ? (o[k] as number) : null);
const isOrg = (v: unknown): v is PublicOrgCard =>
  !!v && typeof v === 'object' && typeof (v as Obj).id === 'string' && typeof (v as Obj).name === 'string';
const label = (v: unknown): string | null =>
  v && typeof v === 'object' && typeof (v as Obj).text === 'string' ? ((v as Obj).text as string) : null;

export type FeedCardView =
  | { kind: 'provider'; key: string; forVehicle: boolean; org: PublicOrgCard; distanceKm: number | null }
  | {
      kind: 'showcase';
      key: string;
      id: string;
      title: string;
      org: PublicOrgCard | null;
      system: string | null;
      thumbnail: string | null;
      at: string | null;
    }
  | { kind: 'question'; key: string; id: string; title: string; status: string; answers: number; at: string | null }
  | { kind: 'tip'; key: string; id: string; title: string; priority: string | null; status: string | null }
  | { kind: 'update'; key: string; id: string; orgId: string; postType: string; title: string | null; excerpt: string; at: string | null };

/** One feed item as a typed card, or null when the server's card lacks what the PWA needs. */
export function readFeedItem(item: FeedItem): FeedCardView | null {
  const c = (item.card ?? {}) as Obj;
  const key = `${item.kind}:${item.ref.id}`;
  switch (item.kind) {
    case 'nearby_provider':
    case 'recommended_for_vehicle': {
      if (!isOrg(c.organization)) return null;
      const d = str(c, 'distance_km');
      return {
        kind: 'provider',
        key,
        forVehicle: item.kind === 'recommended_for_vehicle',
        org: c.organization,
        distanceKm: d ? Number(d) : null,
      };
    }
    case 'showcase': {
      const title = str(c, 'title');
      if (!title) return null;
      return {
        kind: 'showcase',
        key,
        id: item.ref.id,
        title,
        org: isOrg(c.organization) ? c.organization : null,
        system: label(c.service_system),
        thumbnail: str(c, 'thumbnail_url'),
        at: str(c, 'published_at'),
      };
    }
    case 'qna': {
      const title = str(c, 'title');
      if (!title) return null;
      return {
        kind: 'question',
        key,
        id: item.ref.id,
        title,
        status: str(c, 'status') ?? 'open',
        answers: num(c, 'answer_count') ?? 0,
        at: str(c, 'created_at'),
      };
    }
    case 'maintenance_tip': {
      const title = str(c, 'title');
      if (!title) return null;
      return { kind: 'tip', key, id: item.ref.id, title, priority: str(c, 'priority'), status: str(c, 'status') };
    }
    case 'followed_update': {
      const orgId = str(c, 'organization_id');
      const text = str(c, 'excerpt');
      if (!orgId || text === null) return null;
      return {
        kind: 'update',
        key,
        id: item.ref.id,
        orgId,
        postType: str(c, 'post_type') ?? 'educational_tip',
        title: str(c, 'title'),
        excerpt: text,
        at: str(c, 'published_at'),
      };
    }
    default:
      return null;
  }
}

export type FeedBlock =
  | { kind: 'card'; card: FeedCardView }
  | { kind: 'recommended'; cards: Extract<FeedCardView, { kind: 'provider' }>[] }
  | { kind: 'tips'; cards: Extract<FeedCardView, { kind: 'tip' }>[] }
  | { kind: 'questions'; cards: Extract<FeedCardView, { kind: 'question' }>[] };

/** Inline blocks after this many stream cards (Docs/22 W-FEED-01 "every ~8 posts"). */
export const BLOCK_EVERY = 8;

/**
 * The Discover stream (Docs/22 W-FEED-01, DI-07): updates from followed shops, showcases and nearby shops as cards;
 * providers for the car, maintenance for the car and questions as inline blocks — the first block after the first
 * two cards (so a thin feed still shows it), the next ones every BLOCK_EVERY cards, any left over at the end.
 * Duplicates (the same item twice across pages) are dropped.
 */
export function feedBlocks(items: readonly FeedItem[]): FeedBlock[] {
  const seen = new Set<string>();
  const stream: FeedCardView[] = [];
  const recommended: Extract<FeedCardView, { kind: 'provider' }>[] = [];
  const tips: Extract<FeedCardView, { kind: 'tip' }>[] = [];
  const questions: Extract<FeedCardView, { kind: 'question' }>[] = [];
  for (const item of items) {
    const card = readFeedItem(item);
    if (!card || seen.has(card.key)) continue;
    seen.add(card.key);
    if (card.kind === 'provider' && card.forVehicle) recommended.push(card);
    else if (card.kind === 'tip') tips.push(card);
    else if (card.kind === 'question') questions.push(card);
    else stream.push(card);
  }
  const blocks: FeedBlock[] = [
    ...(recommended.length ? [{ kind: 'recommended', cards: recommended.slice(0, 3) } as const] : []),
    ...(tips.length ? [{ kind: 'tips', cards: tips.slice(0, 3) } as const] : []),
    ...(questions.length ? [{ kind: 'questions', cards: questions.slice(0, 5) } as const] : []),
  ];
  const out: FeedBlock[] = [];
  let next = Math.min(2, stream.length);
  stream.forEach((card, i) => {
    out.push({ kind: 'card', card });
    if (i + 1 === next && blocks.length) {
      out.push(blocks.shift()!);
      next += BLOCK_EVERY;
    }
  });
  return [...out, ...blocks];
}

/** Fewer than this many items = a thin feed: show the follow prompts and popular questions too (Docs/56 §1.9). */
export const THIN_FEED = 4;
