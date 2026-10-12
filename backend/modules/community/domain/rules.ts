// Pure rules of the community module (52 Post, Comment, Reaction, Question,
// Answer; 40 §19).

/**
 * Automated pre-moderation of text (GD-22, S6): community text becomes
 * visible at once unless it carries contact data or links (spam, off-platform
 * deals, doxxing), which waits for the S8 moderation queue. Media stay
 * private until moderation approves them (52 §15 publicly_servable).
 */
export function autoModeration(...texts: (string | null | undefined)[]): 'approved' | 'pending' {
  const text = texts.filter(Boolean).join('\n');
  // Persian/Arabic digits count as digits for phone numbers.
  const latin = text.replace(/[۰-۹٠-٩]/g, (d) => String((d.charCodeAt(0) & 0xf) % 10));
  const url = /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(?:com|net|org|ir|io|app|info|me|co)\b/i;
  const email = /[^\s@]+@[^\s@]+\.[^\s@]{2,}/;
  const phone = /(?:\+?\d[\s-]?){9,}/;
  return url.test(latin) || email.test(latin) || phone.test(latin) ? 'pending' : 'approved';
}

export type ReactionTarget = 'review' | 'answer' | 'post' | 'comment' | 'portfolio_item';

/** 52 Reaction: helpful on reviews, answers and posts; like on posts, comments and portfolio items. */
export function reactionAllowed(target: ReactionTarget, type: 'helpful' | 'like'): boolean {
  return type === 'helpful' ? ['review', 'answer', 'post'].includes(target) : ['post', 'comment', 'portfolio_item'].includes(target);
}

/** Post types whose publication is "important" for followers with notification_preference important_only. */
export const IMPORTANT_POST_TYPES = ['availability', 'special_offer', 'community_event'];

export type PostType =
  'showcase' | 'availability' | 'seasonal_advice' | 'special_offer' | 'educational_tip' | 'job_completion' | 'community_event';

export interface PostFacts {
  post_type: PostType;
  body: string;
  portfolio_item_id?: string | null;
  offer_valid_until?: string | null;
  event_starts_at?: string | null;
}

/** 40 PostWrite conditionals and 52 Post body ≥ 10 characters. */
export function postErrors(p: PostFacts): { pointer: string; code: string; limit?: string }[] {
  const errors: { pointer: string; code: string; limit?: string }[] = [];
  if ([...p.body].length < 10) errors.push({ pointer: '/body', code: 'too_short', limit: '10' });
  if ((p.post_type === 'showcase' || p.post_type === 'job_completion') && !p.portfolio_item_id)
    errors.push({ pointer: '/portfolio_item_id', code: 'conditional_required' });
  if (p.post_type === 'special_offer' && !p.offer_valid_until) errors.push({ pointer: '/offer_valid_until', code: 'conditional_required' });
  if (p.post_type === 'community_event' && !p.event_starts_at) errors.push({ pointer: '/event_starts_at', code: 'conditional_required' });
  return errors;
}
