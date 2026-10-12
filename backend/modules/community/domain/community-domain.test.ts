// Community rules (S6): automated pre-moderation (GD-22), reaction types per
// target (52 Reaction) and PostWrite conditionals.
import { describe, expect, it } from 'vitest';
import { autoModeration, postErrors, reactionAllowed } from './rules.js';

describe('community rules', () => {
  it('holds text with links, email addresses or phone numbers (also in Persian digits) for moderation', () => {
    expect(autoModeration('Change brake fluid every two years.')).toBe('approved');
    expect(autoModeration('See www.cheap-parts.ir')).toBe('pending');
    expect(autoModeration('mail me: ali@example.com')).toBe('pending');
    expect(autoModeration('تماس: ۰۹۱۲ ۱۲۳ ۴۵۶۷')).toBe('pending');
    expect(autoModeration('Model year 2019, 1600 cc')).toBe('approved');
  });

  it('allows helpful on reviews, answers and posts and like on posts, comments and portfolio items', () => {
    expect(reactionAllowed('review', 'helpful')).toBe(true);
    expect(reactionAllowed('review', 'like')).toBe(false);
    expect(reactionAllowed('comment', 'like')).toBe(true);
    expect(reactionAllowed('comment', 'helpful')).toBe(false);
  });

  it('requires the conditional post fields', () => {
    expect(postErrors({ post_type: 'special_offer', body: 'Ten percent off brakes this week' })).toEqual([
      { pointer: '/offer_valid_until', code: 'conditional_required' },
    ]);
    expect(postErrors({ post_type: 'job_completion', body: 'short' }).map((e) => e.pointer)).toEqual(['/body', '/portfolio_item_id']);
  });
});
