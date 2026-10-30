'use client';
// Reactions, comments and Report under a showcase (Docs/22 W-PUB-05; P8.T2): "Great work" (like) on the portfolio item
// with its count, the comment thread (target portfolio_item; behind community.comments.enabled) and Report.
import { ReportButton } from '@/components/shell/report';
import { CommentIntentHandlers, Comments } from './comments';
import { ReactionIntentHandlers, Reactions } from './reactions';

export function ShowcaseSocial({ itemId, likeCount }: { itemId: string; likeCount: number }) {
  return (
    <div className="pwa-stack">
      <ReactionIntentHandlers />
      <CommentIntentHandlers />
      <div className="pwa-social-bar">
        <Reactions target={{ type: 'portfolio_item', id: itemId }} counts={{ like: likeCount }} />
        <ReportButton targetType="portfolio_item" targetId={itemId} />
      </div>
      <Comments target={{ type: 'portfolio_item', id: itemId }} />
    </div>
  );
}
