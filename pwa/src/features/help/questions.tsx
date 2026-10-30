'use client';
// W-HELP-01 Questions step (P10.T2; Docs/55 C-HELP-04): one AI question at a time — "Question 2 of up to 5" — answered
// in the user's own words, or "Not sure" / "Skip" (also with the number keys 1 and 2 outside text fields). The
// contract's clarifying question is free text without answer options (TriageSession.next_question, DI-58), so there are
// no answer chips. A safety-critical answer, five answers or no further question go on to the Safety step; AI off
// mid-way (503) keeps what was said and goes on too (the match needs no AI).
import { useEffect, useState, type FormEvent } from 'react';
import { Badge } from '@/components/ds/badge';
import { Button } from '@/components/ds/button';
import { TextField } from '@/components/ds/text-field';
import { isTypingTarget } from '@/components/shell/search-box';
import { SkeletonCard } from '@/components/shell/skeleton';
import { ApiProblem } from '@/lib/api/problem';
import { useFormat } from '@/lib/format/client';
import { useT } from '@/lib/i18n/client';
import { triageOpen, useHelpActions } from './actions';
import { answersOf, caseLevel, isCritical, MAX_QUESTIONS } from './model';
import type { WizardContext } from './wizard';

export function QuestionsStep({ ctx }: { ctx: WizardContext }) {
  const t = useT();
  const f = useFormat();
  const { reply } = useHelpActions();
  const s = ctx.triage;
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState<'answer' | 'notSure' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const asked = s ? answersOf(s).length : 0;
  const question = s && triageOpen(s) ? s.next_question : null;
  const done = !question || asked >= MAX_QUESTIONS;

  useEffect(() => {
    if (s && done) ctx.go('safety', { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once the questions are over
  }, [done, s?.id]);

  const send = async (text: string, kind: 'answer' | 'notSure') => {
    if (!s || !text.trim()) return;
    setBusy(kind);
    setError(null);
    try {
      const next = await reply(s, text.trim());
      setAnswer('');
      ctx.patch({ safety: next.safety });
      const more = triageOpen(next) && next.next_question && answersOf(next).length < MAX_QUESTIONS;
      if (isCritical(caseLevel(ctx.c, next)) || !more) ctx.go('safety');
    } catch (err) {
      if (err instanceof ApiProblem && err.code === 'AI_UNAVAILABLE') {
        ctx.patch({ aiOff: true, safety: err.safety ?? ctx.c.safety });
        ctx.go('safety');
      } else if (err instanceof ApiProblem && err.code === 'INVALID_TRANSITION') ctx.go('safety');
      else setError(t('help.errors.failed'));
    } finally {
      setBusy(null);
    }
  };
  const skip = () => ctx.go('safety');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (busy || e.altKey || e.ctrlKey || e.metaKey || isTypingTarget(e.target)) return;
      if (e.key === '1') void send(t('help.questions.notSureAnswer'), 'notSure');
      if (e.key === '2') skip();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (!s || done) return <SkeletonCard lines={4} />;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void send(answer, 'answer');
  };

  return (
    <div className="pwa-stack">
      <p className="pwa-text-label m-0">{t('help.questions.count', { n: f.number(asked + 1), max: f.number(MAX_QUESTIONS) })}</p>
      <section className="pwa-help-question pwa-stack-sm" aria-labelledby="help-question">
        <span className="pwa-badges">
          <Badge icon="spark">{t('help.questions.ai')}</Badge>
        </span>
        <h1 id="help-question" className="pwa-text-h2 m-0" dir="auto">
          {question}
        </h1>
        <form className="pwa-stack-sm" onSubmit={submit} noValidate>
          <TextField
            multiline
            rows={2}
            label={t('help.questions.answer')}
            value={answer}
            maxLength={2000}
            onChange={(e) => setAnswer(e.target.value)}
          />
          <div className="pwa-inline-buttons">
            <Button type="submit" variant="primary" icon="next" loading={busy === 'answer'} disabled={!answer.trim() || busy !== null}>
              {t('help.questions.next')}
            </Button>
            <Button
              loading={busy === 'notSure'}
              disabled={busy !== null}
              aria-keyshortcuts="1"
              onClick={() => void send(t('help.questions.notSureAnswer'), 'notSure')}
            >
              {t('help.questions.notSure')}
            </Button>
            <Button variant="ghost" disabled={busy !== null} aria-keyshortcuts="2" onClick={skip}>
              {t('help.questions.skip')}
            </Button>
          </div>
        </form>
        <p className="pwa-text-caption m-0">{t('help.questions.keys')}</p>
      </section>
      {error ? (
        <p className="pwa-error-text m-0" role="alert">
          {error}
        </p>
      ) : null}
      <p className="pwa-text-caption m-0">{t('help.questions.notDiagnosis')}</p>
    </div>
  );
}
