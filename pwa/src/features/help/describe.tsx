'use client';
// W-HELP-01 landing and Describe step (P10.T2; Docs/55 C-HELP-01..03 combined on desktop into one step): which car,
// "What is happening with your car?", symptom shortcuts, photos and short videos (issue_photo), how urgent it feels,
// and the shared safety check while typing (safety.check, rule-based, works without AI). Start runs the guided help
// (triage.start); without a car or with AI off it goes on to the category path. /<locale>/help is also where the
// earlier stages hand over: the onboarding's and home's Help Me draft (cp:help-draft, cleared once used), the garage
// (?vehicle&issue), the safety banners (?urgent=1) and the request links of profiles, search, the map and favourites
// (?provider&location&slot&shop&via → a request without triage). Guests can describe but sign in to start (DI-04,
// OQ-04): the description survives sign-in (GD-06); "Find shops by category" works for everybody.
import type { Vehicle } from '@carpal/api-contracts';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Banner, SafetyBanner } from '@/components/ds/banner';
import { Button, buttonClass } from '@/components/ds/button';
import { Chip } from '@/components/ds/chip';
import { Icon } from '@/components/ds/icon';
import { TextField } from '@/components/ds/text-field';
import { useActiveVehicle, useVehicleLabel } from '@/components/shell/active-vehicle';
import { useGatedAction, useIntentHandler } from '@/components/shell/auth-intent';
import { savePendingSearch } from '@/components/shell/search-box';
import { SkeletonCard } from '@/components/shell/skeleton';
import { StateView } from '@/components/shell/states';
import { useLoginHref } from '@/components/shell/use-login-href';
import { UploadZone, useUploads } from '@/features/media';
import { HELP_DRAFT_KEY, readHelpDraft } from '@/features/onboarding';
import { readSearchOrigin } from '@/features/profiles';
import { uuidv7 } from '@/lib/api/uuid';
import { useApiQuery } from '@/lib/api/query';
import { useSession } from '@/lib/api/session';
import { useBrowserValue } from '@/lib/browser-value';
import { useTaxonomyNodes } from '@/lib/config/taxonomy';
import { useFormat } from '@/lib/format/client';
import { useLocale, useT } from '@/lib/i18n/client';
import { useHelpActions } from './actions';
import {
  CHOICE_LEVEL,
  composeText,
  helpPath,
  newCase,
  parseEntry,
  SYMPTOM_KEYS,
  tooShort,
  URGENCY_CHOICES,
  type HelpCase,
  type SymptomKey,
  type UrgencyChoice,
} from './model';
import { useHelpCases } from './store';
import type { WizardContext } from './wizard';

export interface DescribeValues {
  vehicleId: string | null;
  text: string;
  symptoms: SymptomKey[];
  urgency: UrgencyChoice | null;
  mediaIds: string[];
}

const SAFETY_DEBOUNCE_MS = 700;

/** The stored draft as a string (useBrowserValue needs a stable value). */
function readDraftRaw(): string {
  try {
    return localStorage.getItem(HELP_DRAFT_KEY) ?? '';
  } catch {
    return '';
  }
}

function clearHelpDraft() {
  try {
    localStorage.removeItem(HELP_DRAFT_KEY);
  } catch {
    /* nothing to clear */
  }
}

/** The shared safety check on the text while typing (C-HELP-03 "Safety keyword detected → urgent banner"). */
function useLiveSafety(text: string) {
  const [debounced, setDebounced] = useState(text);
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(text.trim().slice(0, 3000)), SAFETY_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [text]);
  const locale = useLocale() as 'en' | 'fa';
  return useApiQuery('safety.check', { body: { text: debounced, locale } }, { enabled: [...debounced].length >= 3, staleTime: Infinity });
}

function VehiclePicker({
  vehicles,
  value,
  onChange,
}: {
  vehicles: readonly Vehicle[];
  value: string | null;
  onChange: (id: string | null) => void;
}) {
  const t = useT();
  const locale = useLocale();
  return (
    <fieldset className="pwa-help-vehicles">
      <legend className="cp-field-label">{t('help.describe.whichCar')}</legend>
      <div className="pwa-chips">
        {vehicles.map((v) => (
          <VehicleChoice key={v.id} v={v} selected={value === v.id} onSelect={() => onChange(v.id)} />
        ))}
        <Chip icon="help" selected={value === null} onClick={() => onChange(null)}>
          {t('help.describe.noCar')}
        </Chip>
      </div>
      <Link href={`/${locale}/garage/add`} className="pwa-link pwa-text-caption">
        <Icon name="plus" size={16} /> {t('help.describe.addCar')}
      </Link>
    </fieldset>
  );
}

function VehicleChoice({ v, selected, onSelect }: { v: Vehicle; selected: boolean; onSelect: () => void }) {
  const label = useVehicleLabel(v);
  return (
    <Chip icon="car" selected={selected} onClick={onSelect}>
      <bdi>{label ?? '…'}</bdi>
    </Chip>
  );
}

export function DescribeForm({
  initial,
  group,
  busy,
  error,
  submitLabel,
  onSubmit,
}: {
  initial: DescribeValues;
  /** Upload group of this form's media (one per case). */
  group: string;
  busy: boolean;
  error: string | null;
  submitLabel: string;
  onSubmit: (v: DescribeValues, symptomLabels: string[]) => void;
}) {
  const t = useT();
  const session = useSession();
  const signedIn = session.data?.signed_in === true;
  const { vehicles, active, isLoading } = useActiveVehicle();
  const { aiOn } = useHelpActions();
  const [vehicleId, setVehicleId] = useState<string | null | undefined>(initial.vehicleId ?? undefined);
  const [text, setText] = useState(initial.text);
  const [symptoms, setSymptoms] = useState<SymptomKey[]>(initial.symptoms);
  const [urgency, setUrgency] = useState<UrgencyChoice | null>(initial.urgency);
  const [touched, setTouched] = useState(false);
  const uploads = useUploads(group);
  const safety = useLiveSafety(text);
  const chosenVehicle = vehicleId === undefined ? (active?.id ?? null) : vehicleId;
  const labels = symptoms.map((s) => t(`help.symptoms.${s}`));
  const short = tooShort(composeText(text, labels));
  const ready = uploads.filter((u) => u.state.phase === 'ready' && u.state.asset).map((u) => u.state.asset!.id);
  const pending = uploads.some((u) => u.state.phase !== 'ready' && u.state.phase !== 'failed');
  const unsafe = urgency === 'unsafe' || safety.data?.level === 'urgent';
  const toggle = (s: SymptomKey) => setSymptoms((v) => (v.includes(s) ? v.filter((x) => x !== s) : [...v, s]));

  const submit = () => {
    setTouched(true);
    if (short) return;
    onSubmit(
      {
        vehicleId: chosenVehicle,
        text: text.trim(),
        symptoms,
        urgency,
        mediaIds: [...new Set([...initial.mediaIds, ...ready])].slice(0, 6),
      },
      labels,
    );
  };

  return (
    <form
      className="pwa-stack"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {!aiOn ? <Banner tone="warn" title={t('help.aiOff.title')} text={t('help.aiOff.text')} /> : null}
      {signedIn ? (
        isLoading ? (
          <SkeletonCard lines={1} />
        ) : vehicles.length ? (
          <VehiclePicker vehicles={vehicles} value={chosenVehicle} onChange={setVehicleId} />
        ) : (
          <Banner tone="info" icon="car" title={t('help.describe.addCarTitle')} text={t('help.describe.addCarText')} />
        )
      ) : (
        <Banner tone="info" icon="car" text={t('help.describe.guestCar')} />
      )}
      {signedIn && chosenVehicle === null && vehicles.length ? (
        <p className="pwa-text-caption m-0">{t('help.describe.noCarHint')}</p>
      ) : null}
      <TextField
        multiline
        rows={4}
        label={t('help.describe.label')}
        placeholder={t('help.describe.placeholder')}
        hint={t('help.describe.hint')}
        error={touched && short ? t('help.describe.short') : undefined}
        value={text}
        maxLength={1800}
        onChange={(e) => setText(e.target.value)}
      />
      {safety.data?.flag ? (
        <SafetyBanner
          title={t('help.safety.bannerTitle')}
          text={t(safety.data.level === 'urgent' ? 'help.safety.urgentText' : 'help.safety.bannerText')}
          action={
            <Button size="sm" variant="danger" onClick={() => setUrgency('unsafe')}>
              {t('help.describe.markUnsafe')}
            </Button>
          }
        />
      ) : null}
      <div className="pwa-stack-xs">
        <span className="cp-field-label" id="help-symptoms">
          {t('help.describe.symptoms')}
        </span>
        <div className="pwa-chips" role="group" aria-labelledby="help-symptoms">
          {SYMPTOM_KEYS.map((s) => (
            <Chip key={s} selected={symptoms.includes(s)} onClick={() => toggle(s)}>
              {t(`help.symptoms.${s}`)}
            </Chip>
          ))}
        </div>
      </div>
      {signedIn ? (
        <UploadZone group={group} purpose="issue_photo" multiple label={t('help.describe.media')} hint={t('help.describe.mediaHint')} />
      ) : null}
      {pending ? <p className="pwa-text-caption m-0">{t('help.describe.mediaPending')}</p> : null}
      <div className="pwa-stack-xs">
        <span className="cp-field-label" id="help-urgency">
          {t('help.describe.urgency')}
        </span>
        <div className="pwa-chips" role="group" aria-labelledby="help-urgency">
          {URGENCY_CHOICES.map((u) => (
            <Chip
              key={u}
              icon={u === 'unsafe' ? 'alert' : undefined}
              selected={urgency === u}
              onClick={() => setUrgency(urgency === u ? null : u)}
            >
              {t(`help.urgency.${u}`)}
            </Chip>
          ))}
        </div>
      </div>
      {error ? (
        <p className="pwa-error-text m-0" role="alert">
          {error}
        </p>
      ) : null}
      <div className="pwa-inline-buttons">
        <Button type="submit" variant={unsafe ? 'danger' : 'primary'} icon={unsafe ? 'alert' : 'next'} loading={busy}>
          {submitLabel}
        </Button>
      </div>
      {!unsafe ? (
        <Banner tone="plain" icon="alert" text={t('help.describe.safetyNotice')}>
          <button type="button" className="pwa-link pwa-text-caption" onClick={() => setUrgency('unsafe')}>
            {t('help.describe.urgentHelp')}
          </button>
        </Banner>
      ) : null}
    </form>
  );
}

/** "Know what you need? Find shops by category" (Docs/21 C-HELP-01 AI-off state; open to guests, DI-04). */
export function CategoryShortcut() {
  const t = useT();
  const locale = useLocale();
  const router = useRouter();
  const nodes = useTaxonomyNodes('service_system', null);
  const top = (nodes.data ?? []).filter((n) => !n.parent_id).slice(0, 12);
  if (!top.length) return null;
  return (
    <section className="pwa-card pwa-stack-sm" aria-labelledby="help-categories">
      <h2 id="help-categories" className="pwa-text-label m-0">
        {t('help.categories.title')}
      </h2>
      <p className="pwa-text-caption m-0">{t('help.categories.text')}</p>
      <div className="pwa-chips">
        {top.map((n) => (
          <Chip
            key={n.id}
            toggle={false}
            onClick={() => {
              savePendingSearch({ text: n.name.text, node: { id: n.id, type: 'service_system', name: n.name.text } });
              router.push(`/${locale}/search`);
            }}
          >
            {n.name.text}
          </Chip>
        ))}
      </div>
    </section>
  );
}

function ContinueCases({ cases }: { cases: readonly HelpCase[] }) {
  const t = useT();
  const f = useFormat();
  const locale = useLocale();
  const open = cases.filter((c) => c.kind === 'help' && !c.appointmentId && (c.text || c.triageId)).slice(0, 3);
  if (!open.length) return null;
  return (
    <section className="pwa-stack-sm" aria-labelledby="help-continue">
      <h2 id="help-continue" className="pwa-text-label m-0">
        {t('help.continue.title')}
      </h2>
      <ul className="pwa-plain-list pwa-stack-sm">
        {open.map((c) => (
          <li key={c.id}>
            <Link href={helpPath(locale, c.id, c.step)} className="pwa-help-continue">
              <Icon name="clock" size={20} />
              <span className="pwa-stack-xs">
                <span className="pwa-text-body pwa-user-text" dir="auto">
                  {[...c.text].length > 80 ? `${[...c.text].slice(0, 79).join('')}…` : c.text || t('help.continue.untitled')}
                </span>
                <span className="pwa-text-caption">{f.relative(c.updatedAt)}</span>
              </span>
              <Icon name="next" size={20} />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** /<locale>/help: the landing with Describe, or the hand-over to a request without triage. */
export function HelpEntry() {
  const t = useT();
  const locale = useLocale();
  const router = useRouter();
  const search = useSearchParams();
  const entry = useMemo(() => parseEntry(new URLSearchParams(search.toString())), [search]);
  const session = useSession();
  const signedIn = session.data?.signed_in === true;
  const loginHref = useLoginHref();
  const gate = useGatedAction();
  const { cases, update, ready } = useHelpCases();
  const { start } = useHelpActions();
  const rawDraft = useBrowserValue(readDraftRaw, '');
  const draft = useMemo(() => (rawDraft ? readHelpDraft() : null), [rawDraft]);
  const [restored, setRestored] = useState<Partial<DescribeValues> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [group] = useState(() => `help:new:${uuidv7()}`);
  const handedOver = useRef(false);
  const issue = useApiQuery(
    'issues.get',
    entry.vehicleId && entry.issueId ? { path: { vehicle_id: entry.vehicleId, issue_id: entry.issueId } } : undefined,
    { enabled: signedIn && !!entry.vehicleId && !!entry.issueId },
  );

  // A request without triage (profile, map, search, favourites): a direct case at its Request step.
  useEffect(() => {
    if (!entry.provider || !signedIn || !ready || handedOver.current) return;
    handedOver.current = true;
    const c = newCase(uuidv7(), {
      kind: 'direct',
      step: 'request',
      vehicleId: entry.vehicleId,
      // A result of the caller's own search links the request to it (match_result_id); request.tsx drops it when the
      // server refuses it (a search made before signing in belongs to the guest session).
      provider: {
        ...entry.provider,
        name: null,
        resultId: entry.provider.via === 'search' ? (readSearchOrigin(entry.provider.orgId)?.resultId ?? null) : null,
      },
    });
    update(c);
    router.replace(helpPath(locale, c.id, 'request'));
  }, [entry, signedIn, ready, update, router, locale]);

  useIntentHandler<Partial<DescribeValues>>('help.start', (intent) => {
    setRestored(intent.draft ?? {});
    return t('help.intent.restored');
  });

  if (entry.provider) {
    if (session.data && !signedIn)
      return (
        <StateView
          kind="noAccess"
          t={t}
          title={t('help.request.signInTitle')}
          text={t('help.request.signInText')}
          action={
            <a href={loginHref} className={buttonClass({ variant: 'primary' })}>
              <span className="cp-btn-label">{t('shell.header.logIn')}</span>
            </a>
          }
        />
      );
    return <SkeletonCard lines={5} />;
  }
  if (entry.issueId && issue.isPending && signedIn) return <SkeletonCard lines={5} />;

  const fromIssue = issue.data
    ? {
        text: [issue.data.title, issue.data.description].filter((x, i, all) => x && all.indexOf(x) === i).join('\n'),
        urgency: (Object.entries(CHOICE_LEVEL).find(([, l]) => l === issue.data!.urgency_level)?.[0] ?? null) as UrgencyChoice | null,
      }
    : null;
  const initial: DescribeValues = {
    vehicleId: restored?.vehicleId ?? entry.vehicleId ?? draft?.vehicleId ?? null,
    text: restored?.text ?? fromIssue?.text ?? draft?.text ?? '',
    symptoms: (restored?.symptoms ?? draft?.symptoms ?? []).filter((s): s is SymptomKey => (SYMPTOM_KEYS as readonly string[]).includes(s)),
    urgency: restored?.urgency ?? (entry.urgent ? 'unsafe' : (fromIssue?.urgency ?? null)),
    mediaIds: [],
  };

  const onSubmit = (v: DescribeValues, labels: string[]) => {
    const run = async () => {
      setBusy(true);
      setError(null);
      try {
        const base = newCase(uuidv7(), {
          vehicleId: v.vehicleId,
          issueId: entry.issueId && entry.vehicleId === v.vehicleId ? entry.issueId : null,
          text: v.text,
          symptoms: v.symptoms,
          urgency: v.urgency,
          mediaIds: v.mediaIds,
        });
        const { c, step } = await start(base, labels);
        update({ ...c, step });
        clearHelpDraft();
        router.push(helpPath(locale, c.id, step));
      } catch {
        setError(t('help.errors.startFailed'));
        setBusy(false);
      }
    };
    gate({
      type: 'help.start',
      draft: { text: v.text, symptoms: v.symptoms, urgency: v.urgency },
      title: t('help.intent.start'),
      run,
    });
  };

  return (
    <div className="pwa-help pwa-help-entry">
      <div className="pwa-help-grid">
        <div className="pwa-help-main pwa-stack">
          <h1 className="pwa-text-title m-0">{t('help.describe.title')}</h1>
          <DescribeForm
            key={restored ? 'restored' : (issue.data?.id ?? draft?.at ?? 'new')}
            initial={initial}
            group={group}
            busy={busy}
            error={error}
            submitLabel={t('help.describe.start')}
            onSubmit={onSubmit}
          />
        </div>
        <aside className="pwa-help-rail pwa-stack">
          {signedIn ? <ContinueCases cases={cases} /> : null}
          <CategoryShortcut />
        </aside>
      </div>
    </div>
  );
}

/** The Describe step of an existing case: edit and start again (a new triage; earlier matches and drafts are dropped). */
export function DescribeStep({ ctx }: { ctx: WizardContext }) {
  const t = useT();
  const { start } = useHelpActions();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const c = ctx.c;
  return (
    <div className="pwa-stack">
      <h1 className="pwa-text-title m-0">{t('help.describe.editTitle')}</h1>
      <DescribeForm
        initial={{ vehicleId: c.vehicleId, text: c.text, symptoms: c.symptoms, urgency: c.urgency, mediaIds: c.mediaIds }}
        group={`help:${c.id}`}
        busy={busy}
        error={error}
        submitLabel={t('help.describe.startAgain')}
        onSubmit={(v, labels) => {
          void (async () => {
            setBusy(true);
            setError(null);
            try {
              const { c: next, step } = await start({ ...c, ...v, issueId: v.vehicleId === c.vehicleId ? c.issueId : null }, labels);
              ctx.patch({ ...next, step });
              ctx.go(step);
            } catch {
              setError(t('help.errors.startFailed'));
              setBusy(false);
            }
          })();
        }}
      />
    </div>
  );
}
