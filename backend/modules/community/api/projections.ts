// Community projections (40 §19.1): allowlists. The private vehicle link of
// a question never leaves (only its taxonomy context); authors are display
// names only; optional PostWrite members are omitted when unset.
import type { Selectable } from 'kysely';
import { textArray, type DB } from '#libs/db/index.js';
import { iso, isoOrNull, meta } from '#libs/http-pipeline/index.js';
import type { L10n } from '#libs/i18n/index.js';
import type { MediaAttachmentView } from '#modules/media/interface/media.js';
import type { PublicOrgCard } from '#modules/organization/interface/public-profiles.js';

export type PostRow = Selectable<DB['community.posts']>;
export type CommentRow = Selectable<DB['community.comments']>;
export type QuestionRow = Selectable<DB['community.questions']>;
export type AnswerRow = Selectable<DB['community.answers']>;
export type Author = { display_name: string; avatar_url: null };

const opt = <K extends string, V>(key: K, v: V | null | undefined): Partial<Record<K, V>> =>
  v === null || v === undefined ? {} : ({ [key]: v } as Record<K, V>);

export function toPost(p: PostRow, x: { org: PublicOrgCard; media: MediaAttachmentView[] }) {
  const nodes = textArray(p.taxonomy_node_ids);
  return {
    ...meta(p),
    post_type: p.post_type,
    ...opt('title', p.title),
    body: p.body,
    content_locale: p.content_locale,
    ...opt('portfolio_item_id', p.portfolio_item_id),
    ...(nodes.length ? { taxonomy_node_ids: nodes } : {}),
    ...opt('offer_valid_until', p.offer_valid_until),
    ...opt('event_starts_at', isoOrNull(p.event_starts_at)),
    comments_enabled: p.comments_enabled,
    ...opt('ai_caption_insight_id', p.ai_caption_insight_id),
    visibility: p.visibility,
    author_organization: x.org,
    moderation_status: p.moderation_status,
    status: p.status,
    published_at: isoOrNull(p.published_at),
    media: x.media.slice(0, 20),
    helpful_count: p.helpful_count,
    like_count: p.like_count,
  };
}

export const toComment = (c: CommentRow, author: Author) => ({
  id: c.id,
  target: { type: c.target_type, id: c.target_id },
  author,
  body: c.body,
  content_locale: c.content_locale,
  created_at: iso(c.created_at),
  status: c.status,
});

export function toPublicQuestion(
  q: QuestionRow,
  x: { author: Author; labels: Map<string, L10n>; media: MediaAttachmentView[]; answerCount: number },
) {
  const lb = (id: string | null) => (id ? (x.labels.get(id) ?? null) : null);
  return {
    id: q.id,
    author: x.author,
    vehicle: { brand: lb(q.brand_node_id), model: lb(q.model_node_id), series: lb(q.series_node_id) },
    symptom: lb(q.symptom_node_id),
    category: lb(q.category_node_id),
    title: q.title,
    body: q.body,
    content_locale: q.content_locale,
    media: x.media.slice(0, 6),
    answer_count: x.answerCount,
    accepted_answer_id: q.accepted_answer_id,
    // "hidden" is a moderation state; the public view shows only open, answered and closed.
    status: q.status === 'hidden' ? 'closed' : q.status,
    created_at: iso(q.created_at),
  };
}

export const toPublicAnswer = (a: AnswerRow, x: { author: Author; org: PublicOrgCard | null; accepted: boolean }) => ({
  id: a.id,
  question_id: a.question_id,
  author: x.author,
  organization: x.org,
  body: a.body,
  content_locale: a.content_locale,
  helpful_count: a.helpful_count,
  accepted: x.accepted,
  created_at: iso(a.created_at),
});
