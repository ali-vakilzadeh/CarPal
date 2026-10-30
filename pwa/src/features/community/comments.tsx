'use client';
// Comments (Docs/22 W-PUB-05 / W-PUB-06, Docs/56 §10; P8.T2) on showcases, questions and answers: oldest first, 20
// per page; a box to write one (guests: the auth-intent modal, and the comment is sent after sign-in by
// <CommentIntentHandlers>, mounted once per page); the warning before sending text with a link, email or phone
// (held for a moderator, BA-17) and "Being reviewed — only you can see this" on the user's own held comments;
// Thanks (like) reactions; Delete on the user's own comments; Report. Behind community.comments.enabled (off →
// nothing is rendered, GD-13). Comment carries no organization, so provider replies get no Shop badge (DI-50).
import type { Comment } from '@carpal/api-contracts';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { Badge } from '@/components/ds/badge';
import { Banner } from '@/components/ds/banner';
import { Button } from '@/components/ds/button';
import { TextField } from '@/components/ds/text-field';
import { useGatedAction, useIntentHandler } from '@/components/shell/auth-intent';
import { ReportButton } from '@/components/shell/report';
import { useToast } from '@/components/shell/toast';
import { ApiProblem, type ApiClient } from '@/lib/api';
import { useApiClient, useApiInfiniteQuery } from '@/lib/api/query';
import { useSession } from '@/lib/api/session';
import { useFlag } from '@/lib/config/client';
import { useFormat } from '@/lib/format/client';
import { useLocale, useT } from '@/lib/i18n/client';
import type { Locale } from '@/lib/i18n/locales';
import { forgetMine, looksMine, rememberMine } from './memory';
import { heldForReview, MAX_COMMENT, textLength } from './model';
import { Reactions } from './reactions';

export type CommentTargetType = 'post' | 'portfolio_item' | 'question' | 'answer';
export interface CommentTarget {
  type: CommentTargetType;
  id: string;
}

const PAGE = 20;
const listKey = ['comments.list'] as const;

async function postComment(api: ApiClient, target: CommentTarget, body: string, locale: Locale): Promise<Comment> {
  return api.api('comments.create', { body: { target, body: body.trim(), content_locale: locale } });
}

function useAfterPost() {
  const queryClient = useQueryClient();
  const session = useSession();
  return (c: Comment) => {
    const user = session.data?.user;
    if (user) rememberMine(user.id, 'comment', c.id, c.author.display_name);
    void queryClient.invalidateQueries({ queryKey: listKey });
  };
}

/** Sends the comments guests wrote before signing in (mount once per page that shows comments). */
export function CommentIntentHandlers() {
  const api = useApiClient();
  const t = useT();
  const locale = useLocale();
  const after = useAfterPost();
  useIntentHandler<{ body: string }>('comment', async (intent) => {
    const [type, id] = (intent.target ?? '').split(':');
    const body = intent.draft?.body ?? '';
    if (!type || !id || textLength(body) === 0) return;
    const c = await postComment(api, { type: type as CommentTargetType, id }, body, locale);
    after(c);
    return heldForReview(c.body) ? t('community.comments.sentHeld') : t('community.comments.sent');
  });
  return null;
}

function problemText(err: unknown, t: ReturnType<typeof useT>): string {
  if (err instanceof ApiProblem) {
    if (err.code === 'VERIFIED_CONTACT_REQUIRED') return t('community.comments.verifyFirst');
    if (err.code === 'INVALID_TRANSITION') return t('community.comments.closed');
    if (err.status === 429) return t('community.comments.slowDown');
  }
  return t('community.comments.failed');
}

function CommentItem({ c }: { c: Comment }) {
  const t = useT();
  const f = useFormat();
  const api = useApiClient();
  const toast = useToast();
  const session = useSession();
  const queryClient = useQueryClient();
  const user = session.data?.user ?? null;
  const mine = looksMine(user, 'comment', c);
  const [busy, setBusy] = useState(false);
  const remove = async () => {
    setBusy(true);
    try {
      await api.api('comments.delete', { path: { comment_id: c.id } });
      if (user) forgetMine(user.id, 'comment', c.id);
      toast(t('community.comments.deleted'));
      void queryClient.invalidateQueries({ queryKey: listKey });
    } catch {
      toast(t('community.comments.deleteFailed'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="pwa-comment" data-comment={c.id}>
      <div className="pwa-comment-head">
        <bdi className="pwa-text-label">{c.author.display_name}</bdi>
        <span className="pwa-text-caption">{f.relative(c.created_at)}</span>
        {mine && c.status === 'hidden' ? <Badge tone="danger">{t('community.moderation.hidden')}</Badge> : null}
        {mine && c.status === 'active' && heldForReview(c.body) ? (
          <Badge tone="signal" icon="clock">
            {t('community.moderation.beingReviewed')}
          </Badge>
        ) : null}
      </div>
      <p className="pwa-text-body pwa-user-text m-0" dir="auto" lang={c.content_locale}>
        {c.body}
      </p>
      <div className="pwa-comment-actions">
        {c.status === 'active' && !heldForReview(c.body) ? <Reactions target={{ type: 'comment', id: c.id }} counts={{}} /> : null}
        {mine ? (
          <Button size="sm" variant="ghost" icon="trash" loading={busy} onClick={() => void remove()}>
            {t('community.comments.delete')}
          </Button>
        ) : (
          <ReportButton targetType="comment" targetId={c.id} />
        )}
      </div>
    </li>
  );
}

function CommentBox({ target }: { target: CommentTarget }) {
  const t = useT();
  const api = useApiClient();
  const locale = useLocale();
  const toast = useToast();
  const gate = useGatedAction();
  const after = useAfterPost();
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const length = textLength(body);
  const held = heldForReview(body);

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      const c = await postComment(api, target, body, locale);
      after(c);
      setBody('');
      toast(heldForReview(c.body) ? t('community.comments.sentHeld') : t('community.comments.sent'));
    } catch (err) {
      setError(problemText(err, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="pwa-comment-box"
      onSubmit={(e) => {
        e.preventDefault();
        if (length === 0 || busy) return;
        gate({
          type: 'comment',
          target: `${target.type}:${target.id}`,
          draft: { body: body.trim() },
          title: t('community.comments.intent'),
          run: send,
        });
      }}
    >
      <TextField
        multiline
        rows={2}
        label={t('community.comments.write')}
        value={body}
        maxLength={MAX_COMMENT}
        onChange={(e) => setBody(e.target.value)}
        error={error ?? undefined}
        hint={length > MAX_COMMENT - 200 ? t('community.compose.counter', { count: length, max: MAX_COMMENT }) : undefined}
      />
      {held ? <Banner tone="warn" icon="info" text={t('community.moderation.contactWarning')} /> : null}
      {error === t('community.comments.verifyFirst') ? (
        <Link href={`/${locale}/settings/profile#contact`} className="pwa-link">
          {t('community.comments.verifyLink')}
        </Link>
      ) : null}
      <div>
        <Button type="submit" variant="primary" size="sm" icon="send" loading={busy} disabled={length === 0}>
          {t('community.comments.send')}
        </Button>
      </div>
    </form>
  );
}

/** The comment thread of one target. `allowed` = the target takes comments (e.g. a closed question does not). */
export function Comments({
  target,
  allowed = true,
  compact,
  headingLevel = 2,
}: {
  target: CommentTarget;
  allowed?: boolean;
  compact?: boolean;
  /** The heading level in the page outline (h2 under the page title, h3 inside an answer). */
  headingLevel?: 2 | 3;
}) {
  const t = useT();
  const enabled = useFlag('community.comments.enabled');
  const list = useApiInfiniteQuery(
    'comments.list',
    { query: { target_type: target.type, target_id: target.id, limit: PAGE } },
    { enabled, staleTime: 30_000 },
  );
  if (!enabled) return null;
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  return (
    <section className={compact ? 'pwa-comments is-compact' : 'pwa-comments'} aria-label={t('community.comments.title')}>
      <Heading className={compact ? 'pwa-text-label m-0' : 'pwa-text-h2 m-0'}>
        {t('community.comments.title')}
        {items.length ? ` (${items.length}${list.hasNextPage ? '+' : ''})` : ''}
      </Heading>
      {list.isError ? <p className="pwa-text-caption">{t('community.comments.loadFailed')}</p> : null}
      {items.length ? (
        <ul className="pwa-plain-list pwa-comment-list">
          {items.map((c) => (
            <CommentItem key={c.id} c={c} />
          ))}
        </ul>
      ) : list.isSuccess && !compact ? (
        <p className="pwa-text-caption">{t('community.comments.empty')}</p>
      ) : null}
      {list.hasNextPage ? (
        <Button size="sm" variant="ghost" loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
          {t('community.comments.more')}
        </Button>
      ) : null}
      {allowed ? <CommentBox target={target} /> : <p className="pwa-text-caption">{t('community.comments.off')}</p>}
    </section>
  );
}
