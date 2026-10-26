'use client';
// W-ONB-01 Web Onboarding (P4.T6/T7; mirrors S-AUTH-04, C-ONB-01, C-ONB-02, S-AUTH-05). Every sign-in comes back
// through /<locale>/onboarding?next=<page>: an account that finished (or set aside) the individual flow goes straight
// on to `next`, where a pending intent replays (GD-06); otherwise the stepper resumes at the saved step. Steps: how
// you'll use CarPal → your first car → anything wrong? → permissions. "Your interests" (C-ONB-03) is shown only with
// the community feed and has no operation to store topics yet (DI-31), so it is not offered. Next saves the step
// (onboarding.update with If-Match "v<version>", "v1" creates the flow, BA-14); Skip moves on without marking it
// done (steps 2-4); "Finish later" leaves without saving, and the next sign-in resumes at the same step.
import type { OnboardingProgress } from '@carpal/api-contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { StepBar } from '@/components/ds/meter';
import { SkeletonList } from '@/components/shell/skeleton';
import { StateView, stateFromProblem } from '@/components/shell/states';
import { useToast } from '@/components/shell/toast';
import { Button } from '@/components/ds/button';
import { ApiProblem } from '@/lib/api/problem';
import { apiQueryKey, useApiClient, useApiQuery } from '@/lib/api/query';
import { currentPath, loginUrl, useSession } from '@/lib/api/session';
import { goTo } from '@/lib/browser-nav';
import { useT } from '@/lib/i18n/client';
import { applySignupChoices, syncTimeZone } from './account';
import { PermissionsStep, ProblemStep, RoleStep } from './steps';
import { VehicleStep, type SavedVehicle } from './vehicle-step';

export const STEPS = ['role', 'vehicle', 'problem', 'permissions'] as const;
export type StepKey = (typeof STEPS)[number];
const FLOW = 'individual' as const;

export const isStep = (v: unknown): v is StepKey => typeof v === 'string' && (STEPS as readonly string[]).includes(v);

/** Finished or set aside: no more onboarding on sign-in. */
export function onboardingDone(flow: OnboardingProgress | undefined): boolean {
  return flow?.status === 'completed' || flow?.status === 'abandoned';
}

export interface OnboardingProps {
  /** Where to go afterwards (validated by the page). */
  next: string;
  portalUrl: string;
  /** Policy version of the consent records made here (location). */
  policyVersion: string;
}

export function Onboarding({ next, portalUrl, policyVersion }: OnboardingProps) {
  const t = useT();
  const router = useRouter();
  const search = useSearchParams();
  const session = useSession();
  const signedIn = session.data?.signed_in === true;
  const guest = session.data !== undefined && !session.data.signed_in && !session.isFetching;
  const outcome = search.get('signin');

  // A sign-in that failed comes back here first: pass the outcome on to the page (its gate shows "Log in to see this
  // page" and the shell the message). A guest who opened this page directly signs in first.
  useEffect(() => {
    if (!guest) return;
    if (outcome) {
      const target = new URL(next, location.origin);
      target.searchParams.set('signin', outcome);
      router.replace(`${target.pathname}${target.search}${target.hash}`);
    } else goTo(loginUrl({ returnTo: currentPath() }));
  }, [guest, outcome, next, router]);

  const list = useApiQuery('onboarding.list', undefined, { enabled: signedIn });
  const flow = list.data?.items.find((f) => f.flow_type === FLOW);
  const done = list.isSuccess && onboardingDone(flow);
  useEffect(() => {
    if (done) router.replace(next);
  }, [done, next, router]);

  if (list.isError)
    return (
      <StateView
        kind={stateFromProblem(list.error)}
        t={t}
        action={
          <Button variant="primary" onClick={() => void list.refetch()}>
            {t('common.actions.retry')}
          </Button>
        }
      />
    );
  if (!signedIn || !list.isSuccess || done) return <SkeletonList count={2} label={t('onboarding.checking')} />;
  return (
    <Wizard
      key={flow?.id ?? 'new'}
      flow={flow}
      requested={search.get('step')}
      next={next}
      portalUrl={portalUrl}
      policyVersion={policyVersion}
      onReload={() => void list.refetch()}
    />
  );
}

function Wizard({
  flow,
  requested,
  next,
  portalUrl,
  policyVersion,
  onReload,
}: {
  flow: OnboardingProgress | undefined;
  requested: string | null;
  next: string;
  portalUrl: string;
  policyVersion: string;
  onReload: () => void;
}) {
  const t = useT();
  const api = useApiClient();
  const router = useRouter();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [step, setStep] = useState<StepKey>(() =>
    isStep(requested) ? requested : isStep(flow?.current_step) ? flow.current_step : 'role',
  );
  const [version, setVersion] = useState<number | null>(flow?.version ?? null);
  const [saving, setSaving] = useState(false);
  const [vehicle, setVehicle] = useState<SavedVehicle | null>(null);
  const applied = useRef(false);

  // Once per page: consents chosen at sign-up (DI-30). Never blocks the stepper.
  useEffect(() => {
    if (applied.current) return;
    applied.current = true;
    applySignupChoices(api).catch((err: unknown) => console.warn('sign-up choices not applied', err));
  }, [api]);

  const index = STEPS.indexOf(step);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), [step]);

  /** Saves the move to `to` (or completion); false when it failed (the toast says so). */
  const save = async (o: { to: StepKey | 'done'; completed?: StepKey; status?: 'completed' }): Promise<boolean> => {
    setSaving(true);
    try {
      const res = await api.api('onboarding.update', {
        path: { flow_type: FLOW },
        body: { current_step: o.to, ...(o.completed ? { completed_step: o.completed } : {}), ...(o.status ? { status: o.status } : {}) },
        ifMatch: `"v${version ?? 1}"`,
      });
      setVersion(res.version);
      void queryClient.invalidateQueries({ queryKey: apiQueryKey('onboarding.list') });
      return true;
    } catch (err) {
      if (err instanceof ApiProblem && err.versionMismatch) {
        toast(t('onboarding.changed'));
        onReload();
      } else toast(t('onboarding.saveFailed'));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const advance = async (completed: boolean) => {
    const to = STEPS[index + 1];
    if (!to) return finish(completed);
    if (await save({ to, ...(completed ? { completed: step } : {}) })) setStep(to);
  };

  const finish = async (completed: boolean) => {
    if (!(await save({ to: 'done', ...(completed ? { completed: step } : {}), status: 'completed' }))) return;
    await syncTimeZone(api).catch((err: unknown) => console.warn('time zone not saved', err));
    toast(t('onboarding.finished'));
    router.replace(next);
  };

  const common = { saving, onNext: () => void advance(true), onSkip: () => void advance(false) };
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <p className="pwa-text-caption">
          {t('onboarding.stepOf', { step: index + 1, total: STEPS.length })} · {t(`onboarding.steps.${step}`)}
        </p>
        <StepBar step={index + 1} total={STEPS.length} label={t('onboarding.stepOf', { step: index + 1, total: STEPS.length })} />
      </div>
      <h1 ref={heading} tabIndex={-1} className="pwa-auth-title">
        {t(`onboarding.titles.${step}`)}
      </h1>
      {step === 'role' ? <RoleStep {...common} portalUrl={portalUrl} /> : null}
      {step === 'vehicle' ? <VehicleStep {...common} saved={vehicle} onSaved={setVehicle} /> : null}
      {step === 'problem' ? <ProblemStep {...common} vehicle={vehicle} /> : null}
      {step === 'permissions' ? <PermissionsStep {...common} policyVersion={policyVersion} /> : null}
    </div>
  );
}
