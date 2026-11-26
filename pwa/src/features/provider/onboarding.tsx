'use client';
// Compact onboarding of CarPal Workshop (provider plan PW2, PW-ONB-01..04; owner decision PRV-OQ-03): a mechanic with
// only a phone creates the business and publishes a minimal profile at /<locale>/provider/start.
//   1 Start a business  name, type, phone, contact e-mail (prefilled), terms, optional AI analysis consent
//                       → org.create, provider.profile_put, org.consents_grant, onboarding.accept_terms
//   2 Where             map pin or "Use my location", typed address, pin check that warns, exact address or area
//                       (location-step.tsx, loaded only on this step so no other page carries the map, PRV-GD-04)
//   3 What you repair   service systems and brands as chips → provider.service_category_create, provider.coverage_create
//   4 Hours and go live one preset, editable; optional licence photo; summary; Publish
//                       → availability.rule_create per open day, location hours, org.verification_submit, provider.publish
//   result              live with 'Verification pending', the public profile link and what to finish in the Web UI.
// Every step saves its data on the server first, then the step (onboarding.update, flow 'provider'), so the owner can
// leave and continue; a returning owner resumes at the saved step but never past missing data (resumeStep). The
// business being set up is the user's unpublished one (pickDraft). Saving the step is best effort: the data decides.
import type {
  AvailabilityRule,
  Coverage,
  Location,
  OnboardingProgress,
  Organization,
  ProviderProfile,
  ProviderProfileWrite,
  ProviderType,
  ServiceCategory,
} from '@carpal/api-contracts';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { StateBlock, StatusChip } from '@carpal/business-ui';
import { Banner } from '@/components/ds/banner';
import { Button, buttonClass } from '@/components/ds/button';
import { Check } from '@/components/ds/check';
import { Chip } from '@/components/ds/chip';
import { cx } from '@/components/ds/cx';
import { Icon } from '@/components/ds/icon';
import { StepBar } from '@/components/ds/meter';
import { TextField } from '@/components/ds/text-field';
import { SkeletonList } from '@/components/shell/skeleton';
import { useToast } from '@/components/shell/toast';
import { normalizePhone } from '@/features/auth';
import { UploadZone, discardGroup, useUploads, whenReady } from '@/features/media';
import { ApiProblem } from '@/lib/api/problem';
import { apiQueryKey, useApiClient, useApiQuery } from '@/lib/api/query';
import { uuidv7 } from '@/lib/api/uuid';
import { usePwaConfig, useRegion } from '@/lib/config/client';
import { useTaxonomyNodes } from '@/lib/config/taxonomy';
import { useLocale, useT } from '@/lib/i18n/client';
import type { MessageKey } from '@/lib/i18n/keys';
import { useWorkshop } from './context';
import { portalHref, workshopPath } from './model';
import {
  ONB_STEPS,
  QUICK_TYPES,
  badDays,
  ifMatchOf,
  availabilityRules,
  hoursSpec,
  openDays,
  pickDraft,
  presetHours,
  resumeStep,
  serviceModesFor,
  unmetItems,
  weekOrder,
  type DayHours,
  type OnbStep,
} from './onboarding-model';

// The map and its step load only when the owner reaches step 2.
const LocationStep = lazy(() => import('./location-step'));

const FLOW = 'provider' as const;
const LIST = { limit: 50 } as const;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** What the wizard knows about the business being set up; each step updates its part. */
export interface SetupData {
  org: Organization | null;
  profile: ProviderProfile | null;
  location: Location | null;
  categories: ServiceCategory[];
  coverage: Coverage[];
  rules: AvailabilityRule[];
}

const EMPTY: SetupData = { org: null, profile: null, location: null, categories: [], coverage: [], rules: [] };

interface WizardInit {
  step: OnbStep;
  flow: OnboardingProgress | undefined;
  data: SetupData;
}

const notFound = (e: unknown) => e instanceof ApiProblem && e.status === 404;

/** The server's view of a draft business (the reads a returning owner needs); null id = a new business. */
function useSetupReads(orgId: string | null) {
  const enabled = orgId !== null;
  const path = { org_id: orgId ?? '' };
  const org = useApiQuery('org.get', { path }, { enabled });
  const profile = useApiQuery('provider.profile_get', { path }, { enabled, retry: (n, e) => !notFound(e) && n < 2 });
  const locations = useApiQuery('org.locations_list', { path, query: LIST }, { enabled });
  const categories = useApiQuery('provider.service_categories_list', { path, query: { status: 'active', ...LIST } }, { enabled });
  const coverage = useApiQuery('provider.coverage_list', { path, query: { status: 'active', ...LIST } }, { enabled });
  const rules = useApiQuery('availability.rules_list', { path, query: LIST }, { enabled });
  const reads = [org, locations, categories, coverage, rules];
  const failed = reads.find((q) => q.isError) ?? (profile.isError && !notFound(profile.error) ? profile : undefined);
  const ready = reads.every((q) => q.isSuccess) && (profile.isSuccess || notFound(profile.error));
  const data: SetupData | null =
    enabled && ready
      ? {
          org: org.data ?? null,
          profile: profile.data ?? null,
          location: primary(locations.data?.items ?? []),
          categories: categories.data?.items ?? [],
          coverage: coverage.data?.items ?? [],
          rules: (rules.data?.items ?? []).filter((r) => r.status !== 'inactive'),
        }
      : null;
  const retry = () => {
    for (const q of [...reads, profile]) if (q.isError) void q.refetch();
  };
  return { data, failed: failed ?? null, retry };
}

const primary = (items: readonly Location[]) =>
  items.find((l) => l.is_primary && l.status !== 'inactive') ?? items.find((l) => l.status !== 'inactive') ?? null;

/** /<locale>/provider/start: the compact onboarding (below the session gate; no business needed). */
export function WorkshopOnboarding({ styleUrl }: { styleUrl: string | null }) {
  const t = useT();
  const api = useApiClient();
  const { businesses, active, error, retry } = useWorkshop();
  const flows = useApiQuery('onboarding.list', undefined);

  // The account's time zone follows the phone, as W-ONB-01 does at its end (the Workshop's sign-ups skip it).
  useEffect(() => {
    import('@/features/onboarding').then((m) => m.syncTimeZone(api)).catch((err: unknown) => console.warn('time zone not saved', err));
  }, [api]);
  const draft = businesses ? pickDraft(businesses, active?.orgId ?? null) : null;
  const reads = useSetupReads(draft?.orgId ?? null);
  const [init, setInit] = useState<WizardInit | null>(null);

  // Decided once: later membership reads (the new business appears) must not restart the wizard.
  const known = businesses !== null && flows.isSuccess && (draft === null || reads.data !== null);
  if (init === null && known) {
    const flow = flows.data.items.find((f) => f.flow_type === FLOW);
    const data = draft ? reads.data! : EMPTY;
    const facts = draft
      ? { hasProfile: !!data.profile, locations: data.location ? 1 : 0, categories: data.categories.length, brands: data.coverage.length }
      : null;
    setInit({ step: resumeStep(flow?.current_step, facts), flow, data });
  }

  if (init) return <Wizard init={init} styleUrl={styleUrl} />;
  const problem = error ?? (flows.isError ? flows.error : null) ?? reads.failed?.error ?? null;
  if (problem)
    return (
      <div className="pwa-ws-page">
        <StateBlock
          kind="error"
          headingLevel={2}
          title={t('provider.onboarding.loadError')}
          action={
            <Button
              onClick={() => {
                retry();
                void flows.refetch();
                reads.retry();
              }}
            >
              {t('common.actions.retry')}
            </Button>
          }
        />
      </div>
    );
  return <SkeletonList count={3} label={t('provider.onboarding.checking')} />;
}

function Wizard({ init, styleUrl }: { init: WizardInit; styleUrl: string | null }) {
  const t = useT();
  const api = useApiClient();
  const queryClient = useQueryClient();
  const { select } = useWorkshop();
  const [step, setStep] = useState<OnbStep>(init.step);
  const [data, setData] = useState<SetupData>(init.data);
  const [published, setPublished] = useState<Organization | null>(null);
  const version = useRef<number | null>(init.flow?.version ?? null);
  const heading = useRef<HTMLHeadingElement>(null);
  const orgId = data.org?.id ?? null;
  const index = ONB_STEPS.indexOf(step);

  useEffect(() => heading.current?.focus(), [step, published]);

  /** Saves where the owner is (best effort: the data on the server decides a resume anyway). */
  const saveStep = async (to: OnbStep | 'done', completed: OnbStep, done = false) => {
    const body = { current_step: to, completed_step: completed, ...(done ? { status: 'completed' as const } : {}) };
    const put = () => api.api('onboarding.update', { path: { flow_type: FLOW }, body, ifMatch: ifMatchOf(version.current ?? 1) });
    try {
      version.current = (await put()).version;
    } catch (err) {
      if (!(err instanceof ApiProblem && err.versionMismatch)) return console.warn('onboarding step not saved', err);
      // Changed in another tab: take the current version and save once more.
      const list = await api.api('onboarding.list').catch(() => null);
      version.current = list?.items.find((f) => f.flow_type === FLOW)?.version ?? null;
      await put()
        .then((r) => (version.current = r.version))
        .catch((e: unknown) => console.warn('onboarding step not saved', e));
    }
    void queryClient.invalidateQueries({ queryKey: apiQueryKey('onboarding.list') });
  };

  /** A step saved its data: on to the next step; `after` runs once the step save exists (accept_terms needs the row). */
  const done = async (patch: Partial<SetupData>, after?: () => Promise<void>) => {
    setData((d) => ({ ...d, ...patch }));
    const next = ONB_STEPS[index + 1];
    if (!next) return;
    setStep(next);
    await saveStep(next, step);
    await after?.().catch((e: unknown) => console.warn('onboarding follow-up failed', e));
  };

  const created = (org: Organization) => {
    setData((d) => ({ ...d, org }));
    select(org.id);
    void queryClient.invalidateQueries({ queryKey: apiQueryKey('me.memberships_list') });
  };

  const finished = async (org: Organization) => {
    setPublished(org);
    await saveStep('done', 'hours', true);
    for (const op of ['me.memberships_list', 'provider.profile_get', 'org.get'] as const)
      void queryClient.invalidateQueries({ queryKey: apiQueryKey(op) });
  };

  if (published) return <Result org={published} headingRef={heading} />;
  const label = t('provider.onboarding.stepOf', { step: index + 1, total: ONB_STEPS.length });
  return (
    <div className="pwa-ws-page pwa-ws-onb">
      <div className="pwa-stack-sm">
        <p className="pwa-text-caption m-0">
          {label} · {t(`provider.onboarding.steps.${step}` as MessageKey)}
        </p>
        <StepBar step={index + 1} total={ONB_STEPS.length} label={label} />
      </div>
      <h1 ref={heading} tabIndex={-1} className="pwa-ws-title">
        {t(`provider.onboarding.titles.${step}` as MessageKey)}
      </h1>
      {step === 'business' ? <BusinessStep data={data} onCreated={created} onDone={done} /> : null}
      {step === 'location' && orgId ? (
        <Suspense fallback={<SkeletonList count={2} label={t('provider.onboarding.location.loading')} />}>
          <LocationStep orgId={orgId} data={data} styleUrl={styleUrl} onDone={done} />
        </Suspense>
      ) : null}
      {step === 'services' && orgId ? <ServicesStep orgId={orgId} data={data} onDone={done} /> : null}
      {step === 'hours' && orgId ? (
        <HoursStep orgId={orgId} data={data} onGoTo={setStep} onPublished={finished} onSaved={(p) => setData((d) => ({ ...d, ...p }))} />
      ) : null}
      {index > 0 ? (
        <Button variant="ghost" icon="back" onClick={() => setStep(ONB_STEPS[index - 1]!)}>
          {t('provider.onboarding.back')}
        </Button>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- 1. start a business

/** The profile to write: the step's choices over what the profile already says (provider.profile_put replaces). */
export function profileWrite(existing: ProviderProfile | null, type: ProviderType, phone: string): ProviderProfileWrite {
  const keep: Partial<ProviderProfileWrite> = existing
    ? {
        description_translations: existing.description_translations,
        years_in_business: existing.years_in_business,
        languages_spoken: existing.languages_spoken,
        amenity_node_ids: existing.amenity_node_ids,
        warranty_policy_translations: existing.warranty_policy_translations,
        response_time_target: existing.response_time_target,
      }
    : {};
  const others = (existing?.contact_channels ?? []).filter((c) => c.type !== 'phone');
  return {
    ...Object.fromEntries(Object.entries(keep).filter(([, v]) => v !== undefined && v !== null)),
    provider_type: type,
    service_modes: existing && existing.provider_type === type ? existing.service_modes : serviceModesFor(type),
    price_tier: existing?.price_tier ?? 'unspecified',
    warranty_offered: existing?.warranty_offered ?? false,
    contact_channels: [{ type: 'phone', value: phone, preferred: !others.some((c) => c.preferred) }, ...others],
  };
}

type Errors = Partial<Record<'name' | 'phone' | 'email' | 'terms', MessageKey>>;

type StepDone = (p: Partial<SetupData>, after?: () => Promise<void>) => Promise<void>;

function BusinessStep({ data, onCreated, onDone }: { data: SetupData; onCreated: (o: Organization) => void; onDone: StepDone }) {
  const t = useT();
  const api = useApiClient();
  const toast = useToast();
  const locale = useLocale();
  const region = useRegion();
  const me = useApiQuery('me.get', undefined, { enabled: !data.org });
  const { org, profile } = data;
  const [name, setName] = useState<string | null>(null);
  const [type, setType] = useState<ProviderType>(profile?.provider_type ?? 'independent_mechanic');
  const [phone, setPhone] = useState<string | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [terms, setTerms] = useState(!!org);
  const [ai, setAi] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  const [blocked, setBlocked] = useState(false);
  const [saving, setSaving] = useState(false);
  // One key per attempt to create: a retry after a lost answer cannot create a second business.
  const createKey = useMemo(() => uuidv7(), []);
  // Set when this visit created the business: the consent and the terms still follow, also when a later call of the
  // step failed and the owner tries again (the business then already exists).
  const [welcome, setWelcome] = useState(false);

  const nameValue = name ?? org?.name ?? '';
  const phoneValue = phone ?? org?.contact_phone ?? me.data?.phone ?? '';
  const emailValue = email ?? org?.contact_email ?? me.data?.email ?? '';
  const types: readonly ProviderType[] = QUICK_TYPES.includes(type as (typeof QUICK_TYPES)[number]) ? QUICK_TYPES : [...QUICK_TYPES, type];

  const submit = async () => {
    const e164 = normalizePhone(phoneValue, region.sms_country_codes);
    const found: Errors = {};
    if (nameValue.trim().length < 2) found.name = 'provider.onboarding.business.nameRequired';
    if (!e164) found.phone = 'provider.onboarding.business.phoneInvalid';
    if (!EMAIL.test(emailValue.trim())) found.email = 'provider.onboarding.business.emailInvalid';
    if (!terms) found.terms = 'provider.onboarding.business.termsRequired';
    setErrors(found);
    setBlocked(false);
    if (Object.keys(found).length || !e164) return;
    setSaving(true);
    let pending = welcome;
    try {
      let current = org;
      const fields = { name: nameValue.trim(), contact_email: emailValue.trim(), contact_phone: e164 };
      if (!current) {
        current = await api.api('org.create', { body: { ...fields, organization_type: 'provider' }, idempotencyKey: createKey });
        pending = true;
        setWelcome(true);
        onCreated(current);
      } else if (current.name !== fields.name || current.contact_email !== fields.contact_email || current.contact_phone !== e164) {
        current = await api.api('org.update', { path: { org_id: current.id }, body: fields, ifMatch: ifMatchOf(current.version) });
      }
      const path = { org_id: current.id };
      const next = await api.api('provider.profile_put', {
        path,
        body: profileWrite(profile, type, e164),
        ...(profile ? { ifMatch: ifMatchOf(profile.version) } : {}),
      });
      if (!pending) await onDone({ org: current, profile: next });
      else {
        setWelcome(false);
        await consentAi(current.id);
        await onDone({ org: current, profile: next }, acceptTerms);
      }
    } catch (err) {
      if (err instanceof ApiProblem && err.code === 'VERIFIED_CONTACT_REQUIRED') setBlocked(true);
      else if (err instanceof ApiProblem && err.fields.length) {
        const at = (p: string) => err.fields.some((f) => f.pointer === p || f.pointer.startsWith(`${p}/`));
        setErrors({
          ...(at('/name') ? { name: 'provider.onboarding.business.nameRejected' as const } : {}),
          ...(at('/contact_phone') || at('/contact_channels') ? { phone: 'provider.onboarding.business.phoneInvalid' as const } : {}),
          ...(at('/contact_email') ? { email: 'provider.onboarding.business.emailInvalid' as const } : {}),
        });
        toast(t('provider.onboarding.saveFailed'));
      } else toast(t('provider.onboarding.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  // A new business: the optional AI consent and the terms. Best effort: neither blocks the set-up.
  const policy = (key: 'terms' | 'provider_analytics_ai_use') => api.api('policy.current', { path: { policy_key: key } });
  const consentAi = async (id: string) => {
    if (!ai) return;
    await policy('provider_analytics_ai_use')
      .then((p) =>
        api.api('org.consents_grant', {
          path: { org_id: id },
          body: { consent_type: 'provider_analytics_ai_use', policy_version: p.policy_version },
        }),
      )
      .catch((e: unknown) => {
        console.warn('AI consent not saved', e);
        toast(t('provider.onboarding.business.aiNotSaved'));
      });
  };
  /** The terms in force (policy.current 'terms'), recorded on the provider flow once its first save made the row. */
  const acceptTerms = async () => {
    const p = await policy('terms');
    await api.api('onboarding.accept_terms', { path: { flow_type: FLOW }, body: { terms_version: p.policy_version } });
  };

  return (
    <form
      className="pwa-ws-stack"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      {blocked ? (
        <Banner
          tone="warn"
          icon="alert"
          title={t('provider.onboarding.business.verifyTitle')}
          text={t('provider.onboarding.business.verifyText')}
        >
          <div className="pwa-banner-actions">
            <Link href={`/${locale}/settings/profile`} className={buttonClass({ size: 'sm' })}>
              <span className="cp-btn-label">{t('provider.onboarding.business.verifyAction')}</span>
            </Link>
          </div>
        </Banner>
      ) : null}
      <TextField
        label={t('provider.onboarding.business.name')}
        hint={t('provider.onboarding.business.nameHint')}
        value={nameValue}
        onChange={(e) => setName(e.target.value)}
        maxLength={120}
        autoComplete="organization"
        error={errors.name ? t(errors.name) : undefined}
      />
      <fieldset className="pwa-fieldset">
        <legend className="cp-field-label">{t('provider.onboarding.business.type')}</legend>
        <div className="flex flex-wrap gap-2">
          {types.map((k) => (
            <Chip key={k} selected={type === k} onClick={() => setType(k)}>
              {t(`provider.onboarding.types.${k}` as MessageKey)}
            </Chip>
          ))}
        </div>
      </fieldset>
      <TextField
        label={t('provider.onboarding.business.phone')}
        hint={t('provider.onboarding.business.phoneHint')}
        type="tel"
        inputMode="tel"
        autoComplete="tel"
        value={phoneValue}
        onChange={(e) => setPhone(e.target.value)}
        error={errors.phone ? t(errors.phone) : undefined}
      />
      <TextField
        label={t('provider.onboarding.business.email')}
        hint={t('provider.onboarding.business.emailHint')}
        type="email"
        inputMode="email"
        autoComplete="email"
        value={emailValue}
        onChange={(e) => setEmail(e.target.value)}
        error={errors.email ? t(errors.email) : undefined}
      />
      {org && !welcome ? null : (
        <div className="pwa-stack-sm">
          <Check
            checked={terms}
            onChange={(e) => setTerms(e.target.checked)}
            aria-invalid={errors.terms ? true : undefined}
            hint={errors.terms ? <span className="pwa-ws-error">{t(errors.terms)}</span> : undefined}
          >
            {t('provider.onboarding.business.terms')}{' '}
            <a href={`/${locale}/terms`} target="_blank" rel="noopener" className="pwa-link">
              {t('provider.onboarding.business.termsLink')}
            </a>
          </Check>
          <Check checked={ai} onChange={(e) => setAi(e.target.checked)} hint={t('provider.onboarding.business.aiHint')}>
            {t('provider.onboarding.business.ai')}
          </Check>
        </div>
      )}
      <div className="pwa-onb-actions">
        <Button type="submit" variant="primary" loading={saving}>
          {org ? t('provider.onboarding.next') : t('provider.onboarding.business.create')}
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------- 3. what you repair

function ServicesStep({ orgId, data, onDone }: { orgId: string; data: SetupData; onDone: StepDone }) {
  const t = useT();
  const api = useApiClient();
  const toast = useToast();
  const systems = useTaxonomyNodes('service_system');
  const brands = useTaxonomyNodes('vehicle_brand');
  const savedSystems = useMemo(() => new Set(data.categories.map((c) => c.taxonomy_node_id)), [data.categories]);
  const savedBrands = useMemo(() => new Set(data.coverage.map((c) => c.brand_node_id)), [data.coverage]);
  const [newSystems, setNewSystems] = useState<string[]>([]);
  const [newBrands, setNewBrands] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [missing, setMissing] = useState(false);
  const [saving, setSaving] = useState(false);

  const toggle = (set: (f: (v: string[]) => string[]) => void, id: string) =>
    set((v) => (v.includes(id) ? v.filter((x) => x !== id) : [...v, id]));
  const q = search.trim().toLocaleLowerCase();
  const shownBrands = (brands.data ?? []).filter((b) => !q || b.name.text.toLocaleLowerCase().includes(q) || b.slug.includes(q));
  const systemCount = savedSystems.size + newSystems.length;
  const brandCount = savedBrands.size + newBrands.length;

  const submit = async () => {
    if (systemCount === 0 || brandCount === 0) return setMissing(true);
    setMissing(false);
    setSaving(true);
    try {
      const categories = [...data.categories];
      for (const id of newSystems) {
        try {
          categories.push(
            await api.api('provider.service_category_create', {
              path: { org_id: orgId },
              body: { taxonomy_node_id: id, experience_level: 'intermediate', visibility: 'public' },
            }),
          );
        } catch (err) {
          // Already on the profile (saved in an earlier visit): nothing to add.
          if (!(err instanceof ApiProblem && err.code === 'DUPLICATE')) throw err;
        }
      }
      const coverage = [...data.coverage];
      if (newBrands.length) {
        const res = await api.api('provider.coverage_create', {
          path: { org_id: orgId },
          body: { items: newBrands.map((id) => ({ brand_node_id: id, coverage_level: 'standard' as const })) },
        });
        coverage.push(...res.created);
      }
      setNewSystems([]);
      setNewBrands([]);
      await onDone({ categories, coverage });
    } catch (err) {
      console.warn('services not saved', err);
      toast(t('provider.onboarding.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  if (systems.isError || brands.isError)
    return (
      <StateBlock
        kind="error"
        headingLevel={2}
        title={t('provider.onboarding.services.loadError')}
        action={
          <Button
            onClick={() => {
              void systems.refetch();
              void brands.refetch();
            }}
          >
            {t('common.actions.retry')}
          </Button>
        }
      />
    );
  if (!systems.data || !brands.data) return <SkeletonList count={2} label={t('provider.onboarding.checking')} />;
  return (
    <div className="pwa-ws-stack">
      <p className="m-0">{t('provider.onboarding.services.intro')}</p>
      {missing ? (
        <Banner
          tone="warn"
          icon="alert"
          title={t('provider.onboarding.services.missing')}
          text={t('provider.onboarding.services.missingText')}
        />
      ) : null}
      <section className="pwa-stack-sm" aria-labelledby="onb-systems">
        <h2 id="onb-systems" className="pwa-ws-section-title">
          {t('provider.onboarding.services.systems')}
        </h2>
        <div className="flex flex-wrap gap-2">
          {systems.data.map((n) => (
            <Chip
              key={n.id}
              selected={savedSystems.has(n.id) || newSystems.includes(n.id)}
              disabled={savedSystems.has(n.id)}
              onClick={() => toggle(setNewSystems, n.id)}
            >
              {n.name.text}
            </Chip>
          ))}
        </div>
      </section>
      <section className="pwa-stack-sm" aria-labelledby="onb-brands">
        <h2 id="onb-brands" className="pwa-ws-section-title">
          {t('provider.onboarding.services.brands')}
        </h2>
        <TextField
          label={t('provider.onboarding.services.brandSearch')}
          icon="search"
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="flex flex-wrap gap-2" aria-live="polite">
          {shownBrands.map((n) => (
            <Chip
              key={n.id}
              selected={savedBrands.has(n.id) || newBrands.includes(n.id)}
              disabled={savedBrands.has(n.id)}
              onClick={() => toggle(setNewBrands, n.id)}
            >
              {n.name.text}
            </Chip>
          ))}
          {shownBrands.length === 0 ? <p className="pwa-text-caption m-0">{t('provider.onboarding.services.noBrand')}</p> : null}
        </div>
      </section>
      {savedSystems.size || savedBrands.size ? <p className="pwa-text-caption m-0">{t('provider.onboarding.services.savedNote')}</p> : null}
      <p className="pwa-text-caption m-0">{t('provider.onboarding.services.later')}</p>
      <div className="pwa-onb-actions">
        <Button variant="primary" loading={saving} onClick={() => void submit()}>
          {t('provider.onboarding.next')}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- 4. hours and go live

function HoursStep({
  orgId,
  data,
  onGoTo,
  onSaved,
  onPublished,
}: {
  orgId: string;
  data: SetupData;
  onGoTo: (s: OnbStep) => void;
  onSaved: (p: Partial<SetupData>) => void;
  onPublished: (org: Organization) => Promise<void>;
}) {
  const t = useT();
  const api = useApiClient();
  const toast = useToast();
  const locale = useLocale();
  const group = `verification:${orgId}`;
  const uploads = useUploads(group);
  const [hours, setHours] = useState<DayHours[]>(presetHours);
  const [unmet, setUnmet] = useState<string[] | null>(null);
  const [saving, setSaving] = useState(false);
  const saved = data.rules.length > 0;
  const bad = badDays(hours);
  const days = weekOrder(locale);
  const day = (d: number) => t(`provider.onboarding.hours.days.${d}` as MessageKey);
  const change = (d: number, patch: Partial<DayHours>) => setHours((hs) => hs.map((h) => (h.day === d ? { ...h, ...patch } : h)));

  /** The hours: one availability rule per open day, then the same hours on the location (what customers see). */
  const saveHours = async () => {
    const location = data.location;
    if (saved || !location) return;
    const rules: AvailabilityRule[] = [];
    try {
      for (const r of availabilityRules(hours, location.id))
        rules.push(await api.api('availability.rule_create', { path: { org_id: orgId }, body: r }));
    } finally {
      // Rules already made are kept, so a retry does not make them twice.
      if (rules.length) onSaved({ rules });
    }
    const updated = await api
      .api('org.location_update', {
        path: { org_id: orgId, location_id: location.id },
        body: { hours: hoursSpec(hours) },
        ifMatch: ifMatchOf(location.version),
      })
      .catch((e: unknown) => {
        console.warn('location hours not saved', e);
        return null;
      });
    if (updated) onSaved({ location: updated, rules });
  };

  /** The licence photo, when one was added: sent for review; a failure never stops the publish. */
  const sendLicence = async () => {
    const item = uploads.at(-1);
    if (!item || item.state.phase === 'failed') return;
    const asset = await whenReady(item.id);
    if (!asset) return toast(t('provider.onboarding.licence.notSent'));
    await api
      .api('org.verification_submit', {
        path: { org_id: orgId },
        body: { verification_type: 'business_identity', submitted_document_ids: [asset.id] },
      })
      .then(() => discardGroup(group))
      .catch((err: unknown) => {
        if (err instanceof ApiProblem && err.code === 'DUPLICATE') return discardGroup(group);
        console.warn('licence not sent', err);
        toast(t('provider.onboarding.licence.notSent'));
      });
  };

  const publish = async () => {
    if (!saved && (openDays(hours).length === 0 || bad.length)) return;
    setSaving(true);
    setUnmet(null);
    try {
      await saveHours();
      await sendLicence();
      await api.api('provider.publish', { path: { org_id: orgId } });
      const org = await api.api('org.get', { path: { org_id: orgId } }).catch(() => data.org!);
      await onPublished(org);
    } catch (err) {
      if (err instanceof ApiProblem && err.code === 'PUBLISH_REQUIREMENTS_UNMET') setUnmet([...err.requirements]);
      else {
        console.warn('publish failed', err);
        toast(t('provider.onboarding.saveFailed'));
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="pwa-ws-stack">
      {unmet ? <UnmetList requirements={unmet} onGoTo={onGoTo} /> : null}
      <section className="pwa-stack-sm" aria-labelledby="onb-hours">
        <h2 id="onb-hours" className="pwa-ws-section-title">
          {t('provider.onboarding.hours.title')}
        </h2>
        {saved ? (
          <p className="m-0">{t('provider.onboarding.hours.saved', { count: data.rules.length })}</p>
        ) : (
          <>
            <p className="pwa-text-caption m-0">{t('provider.onboarding.hours.intro')}</p>
            <ul className="pwa-plain-list pwa-ws-hours">
              {days.map((d) => {
                const h = hours.find((x) => x.day === d)!;
                return (
                  <li key={d} className={cx('pwa-ws-hours-row', bad.includes(d) && 'is-error')}>
                    <Check checked={h.open} onChange={(e) => change(d, { open: e.target.checked })}>
                      {day(d)}
                    </Check>
                    {h.open ? (
                      <span className="pwa-ws-hours-times">
                        <input
                          type="time"
                          className="cp-field-input"
                          aria-label={t('provider.onboarding.hours.opens', { day: day(d) })}
                          value={h.start}
                          onChange={(e) => change(d, { start: e.target.value })}
                        />
                        <span aria-hidden="true">–</span>
                        <input
                          type="time"
                          className="cp-field-input"
                          aria-label={t('provider.onboarding.hours.closes', { day: day(d) })}
                          value={h.end}
                          onChange={(e) => change(d, { end: e.target.value })}
                        />
                      </span>
                    ) : (
                      <span className="pwa-text-caption">{t('provider.onboarding.hours.closed')}</span>
                    )}
                  </li>
                );
              })}
            </ul>
            {bad.length ? (
              <p className="pwa-ws-error m-0" role="alert">
                {t('provider.onboarding.hours.badTimes')}
              </p>
            ) : null}
            {openDays(hours).length === 0 ? (
              <p className="pwa-ws-error m-0" role="alert">
                {t('provider.onboarding.hours.noDays')}
              </p>
            ) : null}
            <div>
              <Button size="sm" variant="ghost" icon="refresh" onClick={() => setHours(presetHours())}>
                {t('provider.onboarding.hours.preset')}
              </Button>
            </div>
          </>
        )}
      </section>
      <section className="pwa-stack-sm" aria-labelledby="onb-licence">
        <h2 id="onb-licence" className="pwa-ws-section-title">
          {t('provider.onboarding.licence.title')}
        </h2>
        <p className="pwa-text-caption m-0">{t('provider.onboarding.licence.text')}</p>
        <UploadZone
          group={group}
          purpose="verification_document"
          organizationId={orgId}
          multiple={false}
          paste={false}
          label={t('provider.onboarding.licence.add')}
          hint={t('provider.onboarding.licence.hint')}
        />
      </section>
      <Summary data={data} />
      <div className="pwa-onb-actions">
        <Button
          variant="primary"
          loading={saving}
          disabled={!saved && (openDays(hours).length === 0 || bad.length > 0)}
          onClick={() => void publish()}
        >
          {t('provider.onboarding.publish')}
        </Button>
      </div>
      <p className="pwa-text-caption m-0">{t('provider.onboarding.publishNote')}</p>
    </div>
  );
}

function Summary({ data }: { data: SetupData }) {
  const t = useT();
  const type = data.profile?.provider_type;
  const loc = data.location;
  return (
    <section className="pwa-onb-card pwa-stack-sm" aria-labelledby="onb-summary">
      <h2 id="onb-summary" className="pwa-ws-section-title">
        {t('provider.onboarding.summary.title')}
      </h2>
      <dl className="pwa-ws-summary">
        <dt>{t('provider.onboarding.summary.name')}</dt>
        <dd>
          <bdi>{data.org?.name}</bdi>
          {type ? ` · ${t(`provider.onboarding.types.${type}` as MessageKey)}` : null}
        </dd>
        <dt>{t('provider.onboarding.summary.place')}</dt>
        <dd>
          {loc ? (
            <>
              <bdi>{[loc.address_line_1, loc.city].filter(Boolean).join('، ')}</bdi>
              {' · '}
              {t(loc.public_address_visibility === 'exact' ? 'provider.onboarding.location.exact' : 'provider.onboarding.location.area')}
            </>
          ) : (
            '–'
          )}
        </dd>
        <dt>{t('provider.onboarding.summary.repairs')}</dt>
        <dd>{t('provider.onboarding.summary.counts', { systems: data.categories.length, brands: data.coverage.length })}</dd>
      </dl>
    </section>
  );
}

/** PUBLISH_REQUIREMENTS_UNMET in plain words, each with the step that fixes it (PW2.T4). */
export function UnmetList({ requirements, onGoTo }: { requirements: readonly string[]; onGoTo: (s: OnbStep) => void }) {
  const t = useT();
  const items = unmetItems(requirements);
  return (
    <div className="pwa-stack-sm" role="alert">
      <Banner tone="warn" icon="alert" title={t('provider.onboarding.unmet.title')} text={t('provider.onboarding.unmet.text')} />
      <ul className="pwa-plain-list pwa-stack-sm" data-testid="unmet">
        {items.map((i) => (
          <li key={i.key} className="pwa-ws-unmet">
            <span>{i.known ? t(`provider.onboarding.unmet.${i.key}` as MessageKey) : t('provider.onboarding.unmet.other')}</span>
            {i.step ? (
              <Button size="sm" variant="secondary" onClick={() => onGoTo(i.step!)}>
                {t(`provider.onboarding.goTo.${i.step}` as MessageKey)}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------- result

const LATER = [
  { key: 'models', path: 'services' },
  { key: 'portfolio', path: 'portfolio' },
  { key: 'capacity', path: 'availability' },
  { key: 'team', path: 'team' },
] as const;

function Result({ org, headingRef }: { org: Organization; headingRef: RefObject<HTMLHeadingElement | null> }) {
  const t = useT();
  const locale = useLocale();
  const { portalUrl } = usePwaConfig();
  return (
    <div className="pwa-ws-page pwa-ws-onb">
      <div className="pwa-ws-entry-mark is-success" aria-hidden="true">
        <Icon name="check" size={40} />
      </div>
      <h1 ref={headingRef} tabIndex={-1} className="pwa-ws-title">
        {t('provider.onboarding.result.title')}
      </h1>
      <p className="m-0">
        <bdi>{org.name}</bdi> {t('provider.onboarding.result.text')}
      </p>
      {org.verification_status !== 'verified' ? (
        <p className="m-0">
          <StatusChip tone="signal" label={t('provider.onboarding.result.pendingChip')} /> {t('provider.onboarding.result.pending')}
        </p>
      ) : null}
      {org.slug ? (
        <Link href={`/${locale}/shop/${encodeURIComponent(org.slug)}`} className="pwa-link">
          {t('provider.onboarding.result.profile')}
        </Link>
      ) : null}
      <section className="pwa-onb-card pwa-stack-sm" aria-labelledby="onb-later">
        <h2 id="onb-later" className="pwa-ws-section-title">
          {t('provider.onboarding.result.laterTitle')}
        </h2>
        <ul className="pwa-plain-list pwa-stack-sm">
          {LATER.map((l) => (
            <li key={l.key}>
              <a href={portalHref(portalUrl, locale, org.id, l.path)} target="_blank" rel="noopener" className="pwa-ws-later">
                <span>{t(`provider.onboarding.result.later.${l.key}` as MessageKey)}</span>
                <Icon name="globe" size={20} />
              </a>
            </li>
          ))}
        </ul>
        <p className="pwa-text-caption m-0">{t('provider.onboarding.result.laterNote')}</p>
      </section>
      <Link href={workshopPath(locale, 'today')} className={buttonClass({ variant: 'primary', block: true })}>
        <span className="cp-btn-label">{t('provider.onboarding.result.today')}</span>
      </Link>
    </div>
  );
}
