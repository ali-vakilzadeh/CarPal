// Review rules (52 §11 Review, ReviewSubRating, ReviewRequest; §21 review
// trust rules; 40 §15): dimension sets, the automatic checks of W4, the
// invitation windows and the masked contact of the ri landing page. Pure.

export const PROVIDER_DIMENSIONS = ['work_quality', 'communication', 'timeliness', 'price_accuracy', 'cleanliness'] as const;
export const VENDOR_DIMENSIONS = ['part_accuracy', 'availability_accuracy', 'price_fairness', 'service_speed', 'communication'] as const;

export function dimensionAllowed(subjectType: 'provider' | 'vendor', dimension: string): boolean {
  return ((subjectType === 'provider' ? PROVIDER_DIMENSIONS : VENDOR_DIMENSIONS) as readonly string[]).includes(dimension);
}

/** 52 ReviewRequest.expires_at: sent_at + 7 days (fixed in the MVP). */
export const INVITATION_TTL_MS = 7 * 86_400_000;
/** 52 Review.business_confirmation_due_at: 7 days after submission (Path 2). */
export const BUSINESS_CONFIRMATION_MS = 7 * 86_400_000;
/** A-NOTIF-01: at most 3 reminders, sent while the link is valid (proposed: 2 and 5 days after sending). */
export const REMINDER_AFTER_MS = [2 * 86_400_000, 5 * 86_400_000] as const;
/** 40 review_invitations.verify: 30-minute grant. */
export const GRANT_TTL_MS = 30 * 60_000;
/** One-time code of the ri landing page: 10 minutes, 5 attempts. */
export const CODE_TTL_MS = 10 * 60_000;
export const CODE_ATTEMPTS = 5;
/** SEC-BF-1 velocity (proposed WP0 values): reviews per author per day. */
export const MAX_REVIEWS_PER_DAY = 5;

const LINK = /(https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(com|ir|net|org|io|app|me)\b/i;
const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const DIGITS = /[0-9۰-۹٠-٩]/g;

/**
 * W4 automatic checks (52 Review rules, SEC-BF-1): a review whose text carries
 * a link, an email address or a phone number stays pending_moderation for the
 * S8 moderation queue (the same rule as community text, GD-22); everything
 * else passes. A rating is never a reason to hold or reject (54 §1.2).
 */
export function autoCheck(text: string): { pass: boolean; reason: string | null } {
  if (LINK.test(text)) return { pass: false, reason: 'link' };
  if (EMAIL.test(text)) return { pass: false, reason: 'email' };
  if ((text.match(DIGITS) ?? []).length >= 8 && /[0-9۰-۹٠-٩][\d۰-۹٠-٩\s\-()+]{6,}/.test(text)) return { pass: false, reason: 'phone' };
  return { pass: true, reason: null };
}

/** 40 InvitationOpenView.code_sent_to: "a•••@g•••.com". */
export function maskEmail(email: string): string {
  const [user = '', domain = ''] = email.split('@');
  const dot = domain.lastIndexOf('.');
  const host = dot > 0 ? domain.slice(0, dot) : domain;
  const tld = dot > 0 ? domain.slice(dot) : '';
  return `${user.slice(0, 1)}•••@${host.slice(0, 1)}•••${tld}`.slice(0, 60);
}

/** The confirmation path an invitation leads to (52 ReviewRequest rules). */
export function invitationPath(r: { provider_job_log_id: string | null }): 'visit_based' | 'approval_based' {
  return r.provider_job_log_id ? 'approval_based' : 'visit_based';
}
