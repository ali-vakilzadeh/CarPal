'use client';
// W-HELP-01 wizard frame (P10.T1; Docs/22 W-HELP-01 desktop layout): /<locale>/help/<case>/<step>, every step its own
// URL so refresh and Back work. Top: the step indicator (Describe → Questions → Safety → Recommendations → Request →
// Done; a request without Help Me shows Request → Done). Main column (640 px): the step. Right rail (sticky from
// 1024 px, below the step on smaller screens): "Your case so far" — vehicle, description, the answers given (each
// editable: editing starts a new triage and replays the answers before it), urgency, category and media — with the
// safety banner, which stays once shown. The case lives in this browser (store.ts); its triage session on the server.
import type { TriageSession } from '@carpal/api-contracts';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Button, buttonClass } from '@/components/ds/button';
import { cx } from '@/components/ds/cx';
import { SafetyBanner } from '@/components/ds/banner';
import { Icon } from '@/components/ds/icon';
import { TextField } from '@/components/ds/text-field';
import { Urgency } from '@/components/ds/urgency';
import { useActiveVehicle, useVehicleLabel } from '@/components/shell/active-vehicle';
import { SkeletonCard } from '@/components/shell/skeleton';
import { StateView } from '@/components/shell/states';
import { useToast } from '@/components/shell/toast';
import { uiLevelOf } from '@/features/appointments';
import { AssetThumb } from '@/features/media';
import { ApiProblem } from '@/lib/api/problem';
import { useFormat } from '@/lib/format/client';
import { useLocale, useT } from '@/lib/i18n/client';
import { useHelpActions, useTriage } from './actions';
import { DescribeStep } from './describe';
import { DoneStep } from './done';
import {
  answersOf,
  caseLevel,
  descriptionOf,
  helpPath,
  isCritical,
  replayTexts,
  stepAfterStart,
  stepsOf,
  type HelpCase,
  type HelpStep,
} from './model';
import { QuestionsStep } from './questions';
import { RecommendationsStep } from './recommendations';
import { RequestStep } from './request';
import { SafetyStep } from './safety';
import { useHelpCase } from './store';

export interface WizardContext {
  c: HelpCase;
  triage: TriageSession | null;
  patch: (change: Partial<HelpCase>) => HelpCase | null;
  go: (step: HelpStep, o?: { replace?: boolean }) => void;
}

export interface HelpWizardProps {
  caseId: string;
  step: HelpStep;
  defaultCity: string;
  styleUrl: string | null;
  policyVersion: string;
}

export function StepIndicator({ steps, current }: { steps: readonly HelpStep[]; current: HelpStep }) {
  const t = useT();
  const f = useFormat();
  const at = steps.indexOf(current);
  return (
    <ol className="pwa-help-steps" aria-label={t('help.steps.label')}>
      {steps.map((s, i) => (
        <li key={s} className={cx(i < at && 'is-done', i === at && 'is-now')} aria-current={i === at ? 'step' : undefined}>
          <span className="pwa-help-step-n" aria-hidden="true">
            {i < at ? <Icon name="check" size={16} /> : f.number(i + 1)}
          </span>
          <span className="pwa-help-step-label">{t(`help.steps.${s}`)}</span>
        </li>
      ))}
    </ol>
  );
}

/** Save and exit (wizard) / Close (entry): the case is already saved in this browser. */
export function HelpExit({ saved }: { saved: boolean }) {
  const t = useT();
  const locale = useLocale();
  const router = useRouter();
  const toast = useToast();
  return (
    <Button
      size="sm"
      variant="ghost"
      icon={saved ? 'bookmark' : 'close'}
      onClick={() => {
        if (saved) toast(t('help.exit.saved'));
        router.push(`/${locale}/home`);
      }}
    >
      {saved ? t('help.exit.save') : t('help.exit.close')}
    </Button>
  );
}

export function HelpWizard({ caseId, step, defaultCity, styleUrl, policyVersion }: HelpWizardProps) {
  const t = useT();
  const locale = useLocale();
  const router = useRouter();
  const { c, ready, patch } = useHelpCase(caseId);
  const triage = useTriage(c);
  const steps = c ? stepsOf(c) : [];
  const wrongStep = !!c && (!steps.includes(step) || (step === 'done' && !c.appointmentId));

  useEffect(() => {
    if (!c) return;
    if (wrongStep) router.replace(helpPath(locale, c.id, c.appointmentId ? 'done' : steps.includes(c.step) ? c.step : steps[0]!));
    else if (c.step !== step) patch({ step });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- on a new step or case only
  }, [c?.id, step, wrongStep]);

  if (!ready) return <SkeletonCard lines={5} />;
  if (!c)
    return (
      <StateView
        kind="notFound"
        t={t}
        title={t('help.missing.title')}
        text={t('help.missing.text')}
        action={
          <Link href={`/${locale}/help`} className={buttonClass({ variant: 'primary' })}>
            <span className="cp-btn-label">{t('help.missing.start')}</span>
          </Link>
        }
      />
    );
  if (wrongStep) return <SkeletonCard lines={5} />;
  if (c.triageId && triage.isPending) return <SkeletonCard lines={5} />;

  const ctx: WizardContext = {
    c,
    triage: triage.data ?? null,
    patch,
    go: (next, o) => {
      const href = helpPath(locale, c.id, next);
      if (o?.replace) router.replace(href);
      else router.push(href);
    },
  };

  return (
    <div className="pwa-help">
      <StepIndicator steps={steps} current={step} />
      <div className="pwa-help-grid">
        <div className="pwa-help-main">
          {step === 'describe' ? <DescribeStep ctx={ctx} /> : null}
          {step === 'questions' ? <QuestionsStep ctx={ctx} /> : null}
          {step === 'safety' ? <SafetyStep ctx={ctx} /> : null}
          {step === 'recommendations' ? (
            <RecommendationsStep ctx={ctx} defaultCity={defaultCity} styleUrl={styleUrl} policyVersion={policyVersion} />
          ) : null}
          {step === 'request' ? <RequestStep ctx={ctx} policyVersion={policyVersion} /> : null}
          {step === 'done' ? <DoneStep ctx={ctx} /> : null}
        </div>
        <aside className="pwa-help-rail" aria-labelledby="help-case-title">
          <CaseRail ctx={ctx} step={step} />
        </aside>
      </div>
    </div>
  );
}

/** "Your case so far" (Docs/22 W-HELP-01 right rail). */
export function CaseRail({ ctx, step }: { ctx: WizardContext; step: HelpStep }) {
  const t = useT();
  const locale = useLocale();
  const { c, triage } = ctx;
  const { vehicles } = useActiveVehicle();
  const vehicle = vehicles.find((v) => v.id === c.vehicleId) ?? null;
  const label = useVehicleLabel(vehicle);
  const level = caseLevel(c, triage);
  const critical = isCritical(level);
  const description = triage ? descriptionOf(triage) : c.text;
  const answers = triage ? answersOf(triage) : [];
  const editable = !!triage && step !== 'done' && step !== 'request' && !!c.vehicleId;
  const showSafety = critical || !!c.safety?.flag;

  return (
    <div className="pwa-stack pwa-help-case">
      {showSafety ? (
        <SafetyBanner
          title={critical ? t('help.safety.criticalTitle') : t('help.safety.bannerTitle')}
          text={critical ? t('help.safety.criticalText') : t('help.safety.bannerText')}
          action={
            step !== 'recommendations' && c.kind === 'help' ? (
              <Link href={helpPath(locale, c.id, 'recommendations')} className={buttonClass({ variant: 'danger', size: 'sm' })}>
                <span className="cp-btn-label">{t('help.safety.findUrgent')}</span>
              </Link>
            ) : null
          }
        />
      ) : null}
      <h2 id="help-case-title" className="pwa-text-label m-0">
        {t('help.case.title')}
      </h2>
      <dl className="pwa-help-facts">
        <dt>{t('help.case.vehicle')}</dt>
        <dd>{vehicle ? <bdi>{label ?? ''}</bdi> : <span className="pwa-text-caption">{t('help.case.noVehicle')}</span>}</dd>
        {c.kind === 'help' && description ? (
          <>
            <dt>{t('help.case.description')}</dt>
            <dd className="pwa-user-text" dir="auto">
              {description}
              {step !== 'describe' && step !== 'done' ? (
                <>
                  {' '}
                  <Link href={helpPath(locale, c.id, 'describe')} className="pwa-link pwa-text-caption">
                    {t('help.case.edit')}
                  </Link>
                </>
              ) : null}
            </dd>
          </>
        ) : null}
        {c.kind === 'help' ? (
          <>
            <dt>{t('help.case.urgency')}</dt>
            <dd>
              <Urgency level={uiLevelOf(level)} label={t(`appointments.urgency.${level}`)} />
            </dd>
          </>
        ) : null}
        {c.category || triage?.likely_systems.length ? (
          <>
            <dt>{t('help.case.category')}</dt>
            <dd>{c.category?.label ?? triage!.likely_systems.map((x) => x.label.text).join('، ')}</dd>
          </>
        ) : null}
        {c.provider?.name ? (
          <>
            <dt>{t('help.case.shop')}</dt>
            <dd>
              <bdi>{c.provider.name}</bdi>
            </dd>
          </>
        ) : null}
      </dl>
      {answers.length ? (
        <section className="pwa-stack-xs" aria-labelledby="help-answers">
          <h3 id="help-answers" className="pwa-text-caption m-0">
            {t('help.case.answers')}
          </h3>
          <ol className="pwa-plain-list pwa-stack-sm">
            {answers.map((a) => (
              <AnswerRow key={a.index} ctx={ctx} index={a.index} question={a.question} answer={a.answer} editable={editable} />
            ))}
          </ol>
        </section>
      ) : null}
      {c.mediaIds.length ? (
        <ul className="pwa-plain-list pwa-help-thumbs" aria-label={t('help.case.media')}>
          {c.mediaIds.map((id) => (
            <li key={id}>
              <AssetThumb mediaId={id} label={t('help.case.mediaItem')} />
            </li>
          ))}
        </ul>
      ) : null}
      {c.kind === 'direct' ? (
        <p className="pwa-text-caption m-0">
          {t('help.case.noTriage')}{' '}
          <Link href={`/${locale}/help`} className="pwa-link">
            {t('help.request.describeWithHelp')}
          </Link>
        </p>
      ) : null}
    </div>
  );
}

function AnswerRow({
  ctx,
  index,
  question,
  answer,
  editable,
}: {
  ctx: WizardContext;
  index: number;
  question: string;
  answer: string;
  editable: boolean;
}) {
  const t = useT();
  const { rerun } = useHelpActions();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(answer);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (!ctx.triage || !value.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const { start, replies } = replayTexts(ctx.triage, index, value.trim());
      const s = await rerun(ctx.c, start, replies);
      const next = ctx.patch({ triageId: s.id, safety: s.safety, matchSessionId: null, provider: null, draft: null, ack: false });
      setEditing(false);
      if (next) ctx.go(stepAfterStart(caseLevel(next, s), s));
    } catch (err) {
      setError(err instanceof ApiProblem && err.code === 'AI_UNAVAILABLE' ? t('help.errors.aiOff') : t('help.errors.failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="pwa-help-answer">
      <span className="pwa-text-caption" dir="auto">
        {question}
      </span>
      {editing ? (
        <div className="pwa-stack-xs">
          <TextField label={t('help.case.yourAnswer')} value={value} maxLength={2000} onChange={(e) => setValue(e.target.value)} />
          {error ? (
            <p className="pwa-error-text m-0" role="alert">
              {error}
            </p>
          ) : null}
          <div className="pwa-inline-buttons">
            <Button size="sm" variant="primary" loading={busy} disabled={!value.trim()} onClick={() => void save()}>
              {t('help.case.rerun')}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(false)}>
              {t('common.actions.cancel')}
            </Button>
          </div>
          <p className="pwa-text-caption m-0">{t('help.case.rerunHint')}</p>
        </div>
      ) : (
        <span className="pwa-text-body pwa-user-text" dir="auto">
          {answer}{' '}
          {editable ? (
            <button type="button" className={cx('pwa-link', 'pwa-text-caption')} onClick={() => setEditing(true)}>
              {t('help.case.edit')}
            </button>
          ) : null}
        </span>
      )}
    </li>
  );
}
