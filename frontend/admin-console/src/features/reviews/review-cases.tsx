'use client';
// Review cases (AC7.T1/T3, Docs/23 A-REV-01 Reported / AI flagged tabs and A-REV-02 actions), on the moderation case
// workspace of AC8: moderation cases of type review (admin.cases_list case_type=review; moderators and platform
// admins), read for their purpose, actioned with a reason and closed with an outcome. Review specifics: the review as
// written (its target snapshot, DI-21), the rating reminder, and "Move to the approval path"
// (admin.review_move_to_approval_path), which turns a Path 1 review whose visit evidence proved invalid into a Path 2
// review; it waits for a second moderator (four-eyes).
import { useId, useState } from 'react';
import { ActionNotice, EntityChip, ReasonDialog, useAdminAction } from '@/components/admin';
import { Button } from '@/components/ds/button';
import { Bidi } from '@/lib/format/bidi';
import { useSession } from '@/lib/api/query';
import { useT } from '@/lib/i18n/client';
import { canCall } from '@/lib/roles';
import { CaseWorkspace, type CaseExtraContext } from '@/features/moderation';
import { canMoveToApprovalPath, excerpt, reviewSnapshot } from './review-logic';
import { Rating, ReviewStatusLine, ReviewText } from './review-parts';

function MovePanel({ target, busy }: CaseExtraContext) {
  const t = useT();
  const uid = useId();
  const session = useSession();
  const review = reviewSnapshot(target?.data);
  const [open, setOpen] = useState(false);
  const move = useAdminAction('admin.review_move_to_approval_path', { target: review?.id });
  if (!canCall('admin.review_move_to_approval_path', session.data?.staff?.roles ?? []) || !canMoveToApprovalPath(review) || !review)
    return null;
  return (
    <section className="adm-panel" aria-labelledby={`${uid}-move`}>
      <h3 id={`${uid}-move`} className="adm-subtitle">
        {t('admin.cases.move.title')}
      </h3>
      <p className="adm-muted">{t('admin.cases.move.text')}</p>
      <Button
        size="sm"
        variant="secondary"
        icon="route"
        disabled={busy || move.state.status === 'busy'}
        onClick={() => {
          move.reset();
          setOpen(true);
        }}
      >
        {t('admin.cases.move.button')}
      </Button>
      <ActionNotice state={move.state} />
      <ReasonDialog
        open={open}
        onClose={() => setOpen(false)}
        kind="path_change"
        title={t('admin.cases.dialog.move')}
        confirmLabel={t('admin.cases.move.button')}
        summary={
          <>
            <p>
              <Bidi>{excerpt(review, 160)}</Bidi>
            </p>
            <p className="adm-muted">{t('admin.cases.effect.move')}</p>
          </>
        }
        onSubmit={(reason) => {
          setOpen(false);
          void move.run({ path: { review_id: review.id }, body: { reason }, reason });
        }}
        name="review-move"
      />
    </section>
  );
}

function ReviewTarget({ data }: { data: unknown }) {
  const t = useT();
  const review = reviewSnapshot(data);
  if (!review) return null;
  return (
    <section className="adm-panel" aria-label={t('admin.reviews.reviewLabel')} data-testid="case-review">
      <ReviewStatusLine status={review.status} path={review.path} verified={review.verifiedStatus} />
      <p className="adm-review-head">
        <Rating value={review.rating} />
        {review.subjectOrganizationId ? <EntityChip type="organization" id={review.subjectOrganizationId} /> : null}
        <EntityChip type="review" id={review.id} />
      </p>
      <ReviewText title={review.title} body={review.body} />
    </section>
  );
}

export function ReviewCases() {
  const t = useT();
  return (
    <CaseWorkspace
      queue="reviews"
      tableId="review-cases"
      listLabel={t('admin.cases.listLabel')}
      emptyText={t('admin.cases.empty')}
      renderTarget={(target) => <ReviewTarget data={target.data} />}
      actionsNote={<p className="adm-muted">{t('admin.reviews.ratingRule')}</p>}
      extra={(ctx) => <MovePanel {...ctx} />}
    />
  );
}
