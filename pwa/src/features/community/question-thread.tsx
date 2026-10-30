'use client';
// W-PUB-06 Question page, the interactive part (mirrors C-COMM-05; P8.T3): the question with its context, photos
// (placeholders until moderation, BA-06), comments and the asker's tools (Edit, Close question); the accepted answer
// first with a check mark, then by helpful votes, each with Helpful, the business badge and profile link for answers
// given as a business, Accept (the asker), Delete (the author; never on the accepted answer, BA-17), Report and its
// comments; the answer box. The server page renders the public read; for a signed-in visitor the question is read
// again through the BFF, which adds their own answers that wait for a moderator ("Being reviewed — only you can
// see this"). Authorship is a best guess (memory.ts, DI-50): the server refuses writes on someone else's content.
import type { PublicAnswer, PublicQuestion } from '@carpal/api-contracts';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Badge } from '@/components/ds/badge';
import { Banner } from '@/components/ds/banner';
import { Button } from '@/components/ds/button';
import { TextField } from '@/components/ds/text-field';
import { MediaImage } from '@/components/media/media-image';
import { useGatedAction, useIntentHandler } from '@/components/shell/auth-intent';
import { Dialog } from '@/components/shell/dialog';
import { ReportButton } from '@/components/shell/report';
import { useToast } from '@/components/shell/toast';
import { ApiProblem } from '@/lib/api';
import { apiQueryKey, useApiClient, useApiQuery } from '@/lib/api/query';
import { useSession } from '@/lib/api/session';
import { useFormat } from '@/lib/format/client';
import { useLocale, useT } from '@/lib/i18n/client';
import { orgPath } from '@/lib/seo/urls';
import { CommentIntentHandlers, Comments } from './comments';
import { forgetMine, looksMine, mineIds, rememberMine } from './memory';
import { heldForReview, MAX_BODY, MAX_TITLE, MIN_BODY, MIN_TITLE, orderAnswers, questionContext, textLength } from './model';
import { ReactionIntentHandlers, Reactions } from './reactions';

export interface QuestionData {
  question: PublicQuestion;
  answers: { items: PublicAnswer[]; next_cursor: string | null };
}

function useQuestion(initial: QuestionData) {
  const session = useSession();
  const signedIn = session.data?.signed_in === true;
  const args = { path: { question_id: initial.question.id } };
  // Guests keep the server's public read; signed-in visitors read again (own held answers, current accept state).
  return useApiQuery('questions.get', args, { initialData: initial, initialDataUpdatedAt: 0, enabled: signedIn, staleTime: 15_000 });
}

function StatusBadge({ q }: { q: PublicQuestion }) {
  const t = useT();
  if (q.status === 'answered')
    return (
      <Badge tone="success" icon="check">
        {t('community.question.status.answered')}
      </Badge>
    );
  if (q.status === 'closed') return <Badge icon="lock">{t('community.question.status.closed')}</Badge>;
  return <Badge tone="signal">{t('community.question.status.open')}</Badge>;
}

function EditQuestion({ q, open, onClose }: { q: PublicQuestion; open: boolean; onClose: () => void }) {
  const t = useT();
  const api = useApiClient();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState(q.title);
  const [body, setBody] = useState(q.body);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = textLength(title) >= MIN_TITLE && textLength(body) >= MIN_BODY;
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const updated = await api.api('questions.update', { path: { question_id: q.id }, body: { title: title.trim(), body: body.trim() } });
      queryClient.setQueryData<QuestionData>(apiQueryKey('questions.get', { path: { question_id: q.id } }), (prev) =>
        prev ? { ...prev, question: updated } : prev,
      );
      toast(heldForReview(updated.title, updated.body) ? t('community.question.savedHeld') : t('community.question.saved'));
      onClose();
    } catch (err) {
      // 412: someone (or another tab) changed it; keep the input and offer a reload (GD-09 amendment 5).
      setError(
        err instanceof ApiProblem && err.status === 412 ? t('community.question.changedElsewhere') : t('community.question.saveFailed'),
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      name="edit-question"
      open={open}
      onClose={onClose}
      title={t('community.question.edit')}
      footer={
        <>
          <Button variant="primary" loading={busy} disabled={!valid} onClick={() => void save()}>
            {t('common.actions.save')}
          </Button>
          <Button onClick={onClose}>{t('common.actions.cancel')}</Button>
        </>
      }
    >
      <div className="pwa-stack">
        <TextField
          label={t('community.ask.title')}
          value={title}
          maxLength={MAX_TITLE}
          onChange={(e) => setTitle(e.target.value.replace(/[\r\n]/g, ' '))}
        />
        <TextField
          multiline
          rows={6}
          label={t('community.ask.details')}
          value={body}
          maxLength={MAX_BODY}
          onChange={(e) => setBody(e.target.value)}
        />
        {heldForReview(title, body) ? <Banner tone="warn" icon="info" text={t('community.moderation.contactWarning')} /> : null}
        {error ? (
          <Banner tone="danger" icon="alert" text={error}>
            {error === t('community.question.changedElsewhere') ? (
              <Button
                size="sm"
                onClick={() =>
                  void queryClient.invalidateQueries({ queryKey: apiQueryKey('questions.get', { path: { question_id: q.id } }) })
                }
              >
                {t('community.question.reload')}
              </Button>
            ) : null}
          </Banner>
        ) : null}
      </div>
    </Dialog>
  );
}

function AskerTools({ q }: { q: PublicQuestion }) {
  const t = useT();
  const api = useApiClient();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [busy, setBusy] = useState(false);
  if (q.status === 'closed') return null;
  const close = async () => {
    setBusy(true);
    try {
      const updated = await api.api('questions.update', { path: { question_id: q.id }, body: { status: 'closed' } });
      queryClient.setQueryData<QuestionData>(apiQueryKey('questions.get', { path: { question_id: q.id } }), (prev) =>
        prev ? { ...prev, question: updated } : prev,
      );
      toast(t('community.question.closedToast'));
      setConfirmClose(false);
    } catch {
      toast(t('community.question.saveFailed'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button size="sm" variant="ghost" icon="edit" onClick={() => setEditing(true)}>
        {t('community.question.edit')}
      </Button>
      <Button size="sm" variant="ghost" icon="lock" onClick={() => setConfirmClose(true)}>
        {t('community.question.close')}
      </Button>
      {editing ? <EditQuestion q={q} open onClose={() => setEditing(false)} /> : null}
      <Dialog
        name="close-question"
        open={confirmClose}
        onClose={() => setConfirmClose(false)}
        title={t('community.question.closeTitle')}
        footer={
          <>
            <Button variant="primary" loading={busy} onClick={() => void close()}>
              {t('community.question.close')}
            </Button>
            <Button onClick={() => setConfirmClose(false)}>{t('common.actions.cancel')}</Button>
          </>
        }
      >
        <p className="pwa-text-body">{t('community.question.closeText')}</p>
      </Dialog>
    </>
  );
}

function AnswerItem({ a, q, pending, asker }: { a: PublicAnswer; q: PublicQuestion; pending: boolean; asker: boolean }) {
  const t = useT();
  const f = useFormat();
  const locale = useLocale();
  const api = useApiClient();
  const toast = useToast();
  const router = useRouter();
  const session = useSession();
  const queryClient = useQueryClient();
  const user = session.data?.user ?? null;
  const mine = looksMine(user, 'answer', a);
  const accepted = a.id === q.accepted_answer_id;
  const [busy, setBusy] = useState<'accept' | 'delete' | null>(null);
  const [showComments, setShowComments] = useState(false);
  const key = apiQueryKey('questions.get', { path: { question_id: q.id } });
  const org = a.organization;
  const orgHref = org ? orgPath(locale, org) : null;

  const accept = async () => {
    setBusy('accept');
    try {
      const updated = await api.api('answers.accept', { path: { question_id: q.id }, body: { answer_id: a.id } });
      queryClient.setQueryData<QuestionData>(key, (prev) =>
        prev
          ? { question: updated, answers: { ...prev.answers, items: prev.answers.items.map((x) => ({ ...x, accepted: x.id === a.id })) } }
          : prev,
      );
      toast(t('community.answer.acceptedToast'));
      router.refresh();
    } catch (err) {
      toast(err instanceof ApiProblem && err.status === 404 ? t('community.answer.onlyAsker') : t('community.answer.failed'));
    } finally {
      setBusy(null);
    }
  };
  const remove = async () => {
    setBusy('delete');
    try {
      await api.api('answers.delete', { path: { answer_id: a.id } });
      if (user) forgetMine(user.id, 'answer', a.id);
      queryClient.setQueryData<QuestionData>(key, (prev) =>
        prev ? { ...prev, answers: { ...prev.answers, items: prev.answers.items.filter((x) => x.id !== a.id) } } : prev,
      );
      toast(t('community.answer.deleted'));
    } catch (err) {
      toast(
        err instanceof ApiProblem && err.code === 'INVALID_TRANSITION'
          ? t('community.answer.acceptedNoDelete')
          : t('community.answer.failed'),
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <li className={accepted ? 'pwa-answer is-accepted' : 'pwa-answer'} data-answer={a.id}>
      {accepted ? (
        <Badge tone="success" icon="check">
          {t('community.answer.accepted')}
        </Badge>
      ) : null}
      <div className="pwa-answer-head">
        <bdi className="pwa-text-label">{a.author.display_name}</bdi>
        {org ? (
          <span className="pwa-answer-org">
            {orgHref ? (
              <Link href={orgHref} className="pwa-link">
                <bdi>{org.name}</bdi>
              </Link>
            ) : (
              <bdi>{org.name}</bdi>
            )}
            <Badge tone="accent" icon={org.verified ? 'shield' : 'store'}>
              {org.verified ? t('community.answer.verifiedBusiness') : t('community.answer.business')}
            </Badge>
          </span>
        ) : null}
        <span className="pwa-text-caption">{f.relative(a.created_at)}</span>
        {pending ? (
          <Badge tone="signal" icon="clock">
            {t('community.moderation.beingReviewedMine')}
          </Badge>
        ) : null}
      </div>
      <p className="pwa-text-body pwa-user-text m-0" dir="auto" lang={a.content_locale}>
        {a.body}
      </p>
      <div className="pwa-answer-actions">
        {pending ? null : <Reactions target={{ type: 'answer', id: a.id }} counts={{ helpful: a.helpful_count }} />}
        {asker && !accepted && !pending && q.status !== 'closed' ? (
          <Button size="sm" variant="secondary" icon="check" loading={busy === 'accept'} onClick={() => void accept()}>
            {t('community.answer.accept')}
          </Button>
        ) : null}
        {mine && !accepted ? (
          <Button size="sm" variant="ghost" icon="trash" loading={busy === 'delete'} onClick={() => void remove()}>
            {t('community.answer.delete')}
          </Button>
        ) : null}
        {!mine && !pending ? <ReportButton targetType="answer" targetId={a.id} /> : null}
        {!pending ? (
          <Button size="sm" variant="ghost" icon="comment" aria-expanded={showComments} onClick={() => setShowComments((v) => !v)}>
            {t('community.comments.title')}
          </Button>
        ) : null}
      </div>
      {showComments ? <Comments target={{ type: 'answer', id: a.id }} allowed={q.status !== 'closed'} compact headingLevel={3} /> : null}
    </li>
  );
}

function AnswerBox({ q }: { q: PublicQuestion }) {
  const t = useT();
  const api = useApiClient();
  const locale = useLocale();
  const toast = useToast();
  const gate = useGatedAction();
  const session = useSession();
  const queryClient = useQueryClient();
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = apiQueryKey('questions.get', { path: { question_id: q.id } });

  const post = async (text: string) => {
    const a = await api.api('answers.create', { path: { question_id: q.id }, body: { body: text.trim(), content_locale: locale } });
    const user = session.data?.user;
    if (user) rememberMine(user.id, 'answer', a.id, a.author.display_name);
    queryClient.setQueryData<QuestionData>(key, (prev) =>
      prev ? { ...prev, answers: { ...prev.answers, items: [...prev.answers.items.filter((x) => x.id !== a.id), a] } } : prev,
    );
    void queryClient.invalidateQueries({ queryKey: key });
    return heldForReview(a.body) ? t('community.answer.sentHeld') : t('community.answer.sent');
  };

  // A guest's answer is sent once they are back from signing in (GD-06).
  useIntentHandler<{ body: string }>('answer', async (intent) => {
    if (intent.target !== q.id || !intent.draft?.body) return;
    return post(intent.draft.body);
  });

  if (q.status === 'closed') return <Banner tone="plain" icon="lock" text={t('community.question.closedText')} />;
  const length = textLength(body);
  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      toast(await post(body));
      setBody('');
    } catch (err) {
      setError(
        err instanceof ApiProblem && err.code === 'INVALID_TRANSITION'
          ? t('community.question.closedText')
          : err instanceof ApiProblem && err.status === 429
            ? t('community.comments.slowDown')
            : t('community.answer.failed'),
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="pwa-answer-box"
      aria-labelledby="answer-box-title"
      onSubmit={(e) => {
        e.preventDefault();
        if (length < MIN_BODY || busy) return;
        gate({ type: 'answer', target: q.id, draft: { body: body.trim() }, title: t('community.answer.intent'), run: send });
      }}
    >
      <h2 id="answer-box-title" className="pwa-text-h2 m-0">
        {t('community.answer.yours')}
      </h2>
      <TextField
        multiline
        rows={5}
        label={t('community.answer.label')}
        hint={length > 0 && length < MIN_BODY ? t('community.compose.minLength', { count: MIN_BODY }) : t('community.answer.hint')}
        value={body}
        maxLength={MAX_BODY}
        onChange={(e) => setBody(e.target.value)}
        error={error ?? undefined}
      />
      {heldForReview(body) ? <Banner tone="warn" icon="info" text={t('community.moderation.contactWarning')} /> : null}
      <div>
        <Button type="submit" variant="primary" icon="send" loading={busy} disabled={length < MIN_BODY}>
          {t('community.answer.post')}
        </Button>
      </div>
    </form>
  );
}

export function QuestionThread({ initial }: { initial: QuestionData }) {
  const t = useT();
  const f = useFormat();
  const session = useSession();
  const read = useQuestion(initial);
  const data = read.data ?? initial;
  const q = data.question;
  const user = session.data?.user ?? null;
  const asker = !!user && (mineIds(user.id, 'question').has(q.id) || looksMine(user, 'question', q));
  const publicIds = new Set(initial.answers.items.map((a) => a.id));
  const answers = orderAnswers(data.answers.items, q.accepted_answer_id);
  const context = questionContext(q);
  const visibleCount = answers.filter((a) => publicIds.has(a.id) || !heldForReview(a.body)).length;

  return (
    <article className="pwa-question" lang={q.content_locale}>
      <ReactionIntentHandlers />
      <CommentIntentHandlers />
      <header className="pwa-stack-sm">
        <div className="pwa-badges">
          <StatusBadge q={q} />
          {context.map((c) => (
            <Badge key={c} icon="car">
              <bdi>{c}</bdi>
            </Badge>
          ))}
        </div>
        <h1 className="pwa-text-title m-0" dir="auto">
          {q.title}
        </h1>
        <p className="pwa-text-caption">
          {t('community.question.askedBy', { name: q.author.display_name, date: f.date(q.created_at, 'date') })}
        </p>
      </header>
      <p className="pwa-text-body pwa-user-text" dir="auto">
        {q.body}
      </p>
      {q.media.length ? (
        <div className="pwa-question-media">
          {q.media.map((m) => (
            <MediaImage
              key={m.attachment_id}
              url={m.url}
              thumbnailUrl={m.thumbnail_url}
              alt={m.caption ?? ''}
              aspect="photo"
              width={m.width}
              height={m.height}
              placeholder={t('community.media.pending')}
              placeholderIcon="image"
            />
          ))}
        </div>
      ) : null}
      <div className="pwa-question-actions">{asker ? <AskerTools q={q} /> : <ReportButton targetType="question" targetId={q.id} />}</div>
      {q.status === 'closed' ? <Banner tone="plain" icon="lock" text={t('community.question.closedText')} /> : null}
      <Comments target={{ type: 'question', id: q.id }} allowed={q.status !== 'closed'} compact />

      <section className="pwa-stack" aria-labelledby="answers-title">
        <h2 id="answers-title" className="pwa-text-h2 m-0">
          {t('community.answer.count', { count: visibleCount })}
        </h2>
        {answers.length === 0 ? (
          <p className="pwa-text-body" data-state="no-answers">
            {t('community.answer.none')}
          </p>
        ) : (
          <ol className="pwa-plain-list pwa-answer-list">
            {answers.map((a) => (
              <AnswerItem
                key={a.id}
                a={a}
                q={q}
                asker={asker}
                pending={!publicIds.has(a.id) && heldForReview(a.body) && looksMine(user, 'answer', a)}
              />
            ))}
          </ol>
        )}
      </section>
      <AnswerBox q={q} />
    </article>
  );
}
