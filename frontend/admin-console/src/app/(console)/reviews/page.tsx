// AC7: the reviews section (Path 2 approval queue for community reviewers and moderators; review cases for moderators
// and platform admins). Other roles see the no-permission state inside the shell (D-26).
import type { Metadata } from 'next';
import { ReviewsPage } from '@/features/reviews';
import { SectionGate, sectionMetadata } from '@/server/section-page';

export function generateMetadata(): Promise<Metadata> {
  return sectionMetadata('reviews', 'admin.reviews.title');
}

export default function Page() {
  return (
    <SectionGate slug="reviews">
      <ReviewsPage />
    </SectionGate>
  );
}
