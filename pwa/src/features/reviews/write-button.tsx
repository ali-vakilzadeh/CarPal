'use client';
// "Write a review" on provider and seller profiles (Docs/22 W-PUB-02/03 Reviews, P11.T6): opens the review page.
// Guests see the sign-in context modal first ("Sign in to review Reza Auto Suspension", GD-06); after the sign-in
// the replayed intent continues to the review page.
import { Button } from '@/components/ds/button';
import { useGatedAction, useIntentHandler } from '@/components/shell/auth-intent';
import { goTo } from '@/lib/browser-nav';
import { useLocale, useT } from '@/lib/i18n/client';
import { reviewHref, type SubjectType } from './model';

export function WriteReviewButton({ orgId, slug, name, as }: { orgId: string; slug: string; name: string; as: SubjectType }) {
  const t = useT();
  const locale = useLocale();
  const gate = useGatedAction();
  const href = reviewHref(locale, slug, { as });
  useIntentHandler('review.write', (intent) => {
    if (intent.target === orgId) goTo(href);
  });
  return (
    <Button
      variant="secondary"
      icon="star"
      onClick={() => gate({ type: 'review.write', target: orgId, title: t('profiles.intent.review', { name }), run: () => goTo(href) })}
    >
      {t('profiles.reviews.write')}
    </Button>
  );
}
