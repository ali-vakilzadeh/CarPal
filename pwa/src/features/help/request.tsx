'use client';
// W-HELP-01 Request step (P10.T3; Docs/55 C-HELP-07 shared by every entry point, §4.9; Docs/22 "Request step (web
// additions)"): the shop, the car, what is needed (with triage: the user's own words from Help Me, editable; without:
// "What do you need?", optional category chips and "Describe it with Help Me" — the shop sees "Triage: not provided"),
// service type and mode, urgency, up to 3 preferred times from the shop's 14-day openings (or "Request anyway"), a note
// to the shop with the shared safety check (sending stays possible), photos, and what is shared — vehicle details
// (always), the service history for this appointment (share_history: the vehicle_data_sharing and
// service_history_sharing consents scoped to this appointment, granted to this shop) and the photos.
// "Preview what the shop receives" saves a draft (appointments.create submit=false) and shows pre_visit.requester_get;
// Send turns that draft into the request (update + draft → requested) or creates it directly (submit=true). The
// typed client adds the Idempotency-Key; the caps answer (429, 3 open per shop / 10 in all / 7 days after a no-show)
// is explained in one message and never retried (BA-19).
import type {
  AppointmentCreate,
  AppointmentType,
  AppointmentUpdate,
  NotificationChannel,
  ServiceMode,
  Slot,
  UrgencyLevel,
} from '@carpal/api-contracts';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRef, useState } from 'react';
import { Banner, SafetyBanner } from '@/components/ds/banner';
import { Button, buttonClass } from '@/components/ds/button';
import { Check } from '@/components/ds/check';
import { Chip } from '@/components/ds/chip';
import { Icon } from '@/components/ds/icon';
import { TextField } from '@/components/ds/text-field';
import { useActiveVehicle, useVehicleLabel } from '@/components/shell/active-vehicle';
import { SkeletonCard } from '@/components/shell/skeleton';
import { StateView } from '@/components/shell/states';
import { PreVisitDrawer, TimesPicker, choiceFromSlot, windowsOf, type WindowChoice } from '@/features/appointments';
import { AssetThumb, releaseGroup, UploadZone, useUploads } from '@/features/media';
import { HELP_DRAFT_KEY, saveHelpDraft } from '@/features/onboarding';
import { RatingLine, addressLine } from '@/features/profiles';
import { ApiProblem } from '@/lib/api/problem';
import { apiQueryKey, useApiClient, useApiQuery } from '@/lib/api/query';
import { goTo } from '@/lib/browser-nav';
import { useTaxonomyNodes } from '@/lib/config/taxonomy';
import { useFormat } from '@/lib/format/client';
import { useLocale, useT } from '@/lib/i18n/client';
import type { MessageKey } from '@/lib/i18n/keys';
import { orgPath } from '@/lib/seo/urls';
import {
  answersOf,
  APPOINTMENT_TYPES,
  caseLevel,
  CONTACT_CHANNELS,
  createBody,
  defaultMode,
  descriptionOf,
  draftMatches,
  formErrors,
  helpPath,
  LEVEL_ORDER,
  requestFailure,
  type FormError,
  type RequestFailure,
  type RequestForm,
} from './model';
import type { WizardContext } from './wizard';

const FAILURE: Record<RequestFailure, MessageKey> = {
  caps: 'help.request.errors.caps',
  contact: 'help.request.errors.contact',
  times: 'help.request.errors.times',
  description: 'help.request.errors.description',
  mode: 'help.request.errors.mode',
  provider: 'help.request.errors.provider',
  vehicle: 'help.request.errors.vehicle',
  capacity: 'help.request.errors.capacity',
  stale: 'help.request.errors.stale',
  network: 'help.request.errors.network',
  error: 'help.request.errors.error',
};

const FORM_ERROR: Record<FormError, MessageKey> = {
  vehicle: 'help.request.errors.noVehicle',
  description: 'help.request.errors.description',
  times: 'help.request.errors.noTimes',
};

function clearHelpDraft() {
  try {
    localStorage.removeItem(HELP_DRAFT_KEY);
  } catch {
    /* nothing to clear */
  }
}

function VehicleName({ id }: { id: string }) {
  const { vehicles } = useActiveVehicle();
  const label = useVehicleLabel(vehicles.find((v) => v.id === id) ?? null);
  return <bdi>{label ?? '…'}</bdi>;
}

export function RequestStep({ ctx, policyVersion }: { ctx: WizardContext; policyVersion: string }) {
  const t = useT();
  const f = useFormat();
  const locale = useLocale() as 'en' | 'fa';
  const api = useApiClient();
  const queryClient = useQueryClient();
  const { c, triage, patch } = ctx;
  const p = c.provider;
  const profile = useApiQuery('public.org_get', p?.slug ? { path: { slug: p.slug } } : undefined, {
    enabled: !!p?.slug,
    staleTime: 60_000,
  });
  const org = profile.data ?? null;
  const { vehicles, active, isLoading: vehiclesLoading } = useActiveVehicle();
  const categories = useTaxonomyNodes('service_system', null, c.kind === 'direct');
  const group = `request:${c.id}`;
  const uploads = useUploads(group);

  const fromTriage = triage ? [descriptionOf(triage), ...answersOf(triage).map((a) => a.answer)].join('\n') : c.text;
  const [vehicleChoice, setVehicleChoice] = useState<string | null | undefined>(c.vehicleId ?? undefined);
  const [description, setDescription] = useState(c.kind === 'help' ? fromTriage : '');
  const [categoryId, setCategoryId] = useState<string | null>(c.category?.id ?? null);
  const [type, setType] = useState<AppointmentType>(c.kind === 'help' ? 'diagnosis' : 'repair');
  const [mode, setMode] = useState<ServiceMode | null>(null);
  const [urgency, setUrgency] = useState<UrgencyLevel>(caseLevel(c, triage));
  const [note, setNote] = useState('');
  const [channel, setChannel] = useState<NotificationChannel>('in_app');
  const [share, setShare] = useState(false);
  const [includeMedia, setIncludeMedia] = useState(true);
  const [choices, setChoices] = useState<WindowChoice[]>([]);
  const [errors, setErrors] = useState<FormError[]>([]);
  const [failure, setFailure] = useState<RequestFailure | null>(null);
  const [busy, setBusy] = useState<'preview' | 'send' | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const slotTaken = useRef(false);

  const safety = useApiQuery(
    'safety.check',
    { body: { text: `${description}\n${note}`.trim().slice(0, 3000), locale } },
    { enabled: `${description}${note}`.trim().length >= 3, staleTime: Infinity, placeholderData: (prev) => prev },
  );

  if (c.appointmentId)
    return (
      <Banner tone="success" title={t('help.request.alreadySent')}>
        <Link href={`/${locale}/appointments/${c.appointmentId}`} className={buttonClass({ size: 'sm' })}>
          <span className="cp-btn-label">{t('help.done.track')}</span>
        </Link>
      </Banner>
    );
  if (!p)
    return (
      <StateView
        kind="empty"
        t={t}
        title={t('help.request.noShop')}
        action={
          <Link href={helpPath(locale, c.id, 'recommendations')} className={buttonClass({ variant: 'primary' })}>
            <span className="cp-btn-label">{t('help.request.chooseShop')}</span>
          </Link>
        }
      />
    );
  if (p.slug && profile.isPending) return <SkeletonCard lines={6} />;

  const name = org?.name ?? p.name ?? t('help.request.thisShop');
  const locationId = p.locationId ?? org?.locations[0]?.id ?? null;
  const loc = org?.locations.find((l) => l.id === locationId) ?? null;
  const timeZone = loc?.timezone ?? f.timeZone;
  const modes = org?.provider?.service_modes ?? [];
  const serviceMode = mode ?? defaultMode(modes);
  const vehicleId = vehicleChoice === undefined ? (active?.id ?? null) : vehicleChoice;
  const ready = uploads.filter((u) => u.state.phase === 'ready' && u.state.asset).map((u) => u.state.asset!.id);
  const mediaIds = [...new Set([...c.mediaIds, ...ready])].slice(0, 10);
  const profileHref = org ? orgPath(locale, org) : null;
  const caseWithLocation = { ...c, provider: { ...p, locationId } };

  const form = (): RequestForm => ({
    vehicleId,
    description,
    categoryId,
    appointmentType: type,
    serviceMode,
    urgency,
    note,
    channel,
    share,
    includeMedia,
    mediaIds,
    windows: windowsOf(choices, timeZone),
  });

  /** appointments.create; a search result the server does not count as the caller's (a guest search) is dropped once. */
  const create = async (body: AppointmentCreate) => {
    try {
      return await api.api('appointments.create', { body });
    } catch (err) {
      if (!(err instanceof ApiProblem) || !body.match_result_id || !err.field('/match_result_id')) throw err;
      patch({ provider: { ...p, resultId: null } });
      const { match_result_id: _dropped, ...rest } = body;
      return api.api('appointments.create', { body: rest });
    }
  };
  /** The preview draft, made or brought up to date (its consent and provider are fixed at creation). */
  const ensureDraft = async (fm: RequestForm) => {
    const body = createBody(caseWithLocation, fm, { locale, policyVersion, triage, submit: false });
    const d = c.draft;
    if (d && draftMatches(d, { ...body, share: fm.share })) {
      const update: AppointmentUpdate = {
        description: body.description,
        customer_expectations: body.customer_expectations ?? null,
        time_windows: body.time_windows,
        urgency_level: body.urgency_level,
        preferred_contact_channel: body.preferred_contact_channel!,
        service_system_node_id: body.service_system_node_id ?? null,
        media_ids: body.media_ids ?? [],
      };
      const a = await api.api('appointments.update', { path: { appointment_id: d.id }, body: update, ifMatch: `"v${d.version}"` });
      patch({ draft: { ...d, version: a.version } });
      return { a, body, reused: true };
    }
    if (d) void discard(d.id);
    const a = await create(body);
    patch({
      draft: {
        id: a.id,
        version: a.version,
        share: fm.share,
        providerId: body.provider_organization_id,
        vehicleId: body.vehicle_id,
        source: body.source,
      },
    });
    return { a, body, reused: false };
  };
  const discard = (id: string) =>
    api
      .api('appointments.transition', { path: { appointment_id: id }, body: { to: 'cancelled', cancellation_reason: 'replaced' } })
      .catch(() => undefined);

  const check = (submit: boolean) => {
    const e = formErrors(form(), submit);
    setErrors(e);
    setFailure(null);
    return e.length === 0;
  };
  const failed = (err: unknown) => {
    const kind = requestFailure(err);
    if (kind === 'stale') patch({ draft: null });
    setFailure(kind);
  };

  const preview = async () => {
    if (!check(false)) return;
    setBusy('preview');
    try {
      const { a } = await ensureDraft(form());
      await queryClient.invalidateQueries({ queryKey: apiQueryKey('pre_visit.requester_get', { path: { appointment_id: a.id } }) });
      setPreviewId(a.id);
    } catch (err) {
      failed(err);
    } finally {
      setBusy(null);
    }
  };

  const send = async () => {
    if (!check(true)) return;
    setBusy('send');
    const fm = form();
    try {
      const body = createBody(caseWithLocation, fm, { locale, policyVersion, triage, submit: true });
      let id: string;
      if (c.draft && draftMatches(c.draft, { ...body, share: fm.share })) {
        const { a } = await ensureDraft(fm);
        id = (
          await api.api('appointments.transition', {
            path: { appointment_id: a.id },
            body: { to: 'requested', time_windows: body.time_windows },
          })
        ).id;
      } else {
        id = (await create(body)).id;
        if (c.draft) void discard(c.draft.id);
      }
      patch({ appointmentId: id, draft: null, provider: { ...p, locationId, name } });
      clearHelpDraft();
      releaseGroup(group);
      void queryClient.invalidateQueries({ queryKey: ['appointments.list'] });
      ctx.go('done', { replace: true });
    } catch (err) {
      failed(err);
      setBusy(null);
    }
  };

  const onSlots = (slots: readonly Slot[]) => {
    if (slotTaken.current || !p.slot) return;
    slotTaken.current = true;
    setChoices([choiceFromSlot(p.slot, slots)]);
  };

  return (
    <div className="pwa-stack">
      <h1 className="pwa-text-title m-0">{t('help.request.title')}</h1>

      <section className="pwa-card pwa-help-shop" aria-label={t('help.request.shop')}>
        <span className="pwa-help-shop-icon" aria-hidden="true">
          <Icon name="wrench" />
        </span>
        <div className="pwa-stack-xs">
          <span className="pwa-text-label">
            {profileHref ? (
              <a href={profileHref} className="pwa-link" target="_blank" rel="noopener">
                <bdi>{name}</bdi>
              </a>
            ) : (
              <bdi>{name}</bdi>
            )}
          </span>
          {org ? <RatingLine value={org.overall_rating} count={org.review_count} t={t} f={f} /> : null}
          {loc ? (
            <span className="pwa-text-caption" dir="auto">
              {addressLine([loc.address.address_line_1, loc.address.city], locale)}
            </span>
          ) : null}
        </div>
        {c.kind === 'help' ? (
          <Link href={helpPath(locale, c.id, 'recommendations')} className={buttonClass({ size: 'sm', variant: 'ghost' })}>
            <span className="cp-btn-label">{t('help.request.changeShop')}</span>
          </Link>
        ) : null}
      </section>

      <section className="pwa-stack-sm" aria-labelledby="req-car">
        <h2 id="req-car" className="pwa-text-label m-0">
          {t('help.request.vehicle')}
        </h2>
        {vehiclesLoading ? (
          <SkeletonCard lines={1} />
        ) : vehicles.length ? (
          <div className="pwa-chips" role="group" aria-labelledby="req-car">
            {vehicles.map((v) => (
              <Chip key={v.id} icon="car" selected={vehicleId === v.id} onClick={() => setVehicleChoice(v.id)}>
                <VehicleName id={v.id} />
              </Chip>
            ))}
          </div>
        ) : (
          <Banner tone="info" icon="car" title={t('help.request.addCarTitle')} text={t('help.request.addCarText')}>
            <Link href={`/${locale}/garage/add`} className={buttonClass({ size: 'sm' })}>
              <span className="cp-btn-label">{t('help.describe.addCar')}</span>
            </Link>
          </Banner>
        )}
      </section>

      <section className="pwa-stack-sm" aria-labelledby="req-issue">
        <h2 id="req-issue" className="pwa-text-label m-0">
          {c.kind === 'help' ? t('help.request.issue') : t('help.request.need')}
        </h2>
        <TextField
          multiline
          rows={4}
          label={c.kind === 'help' ? t('help.request.issueLabel') : t('help.request.needLabel')}
          hint={t('help.request.ownWords')}
          error={errors.includes('description') ? t(FORM_ERROR.description) : undefined}
          value={description}
          maxLength={3000}
          onChange={(e) => setDescription(e.target.value)}
        />
        {c.kind === 'direct' ? (
          <>
            <div className="pwa-chips" role="group" aria-label={t('help.request.category')}>
              {(categories.data ?? [])
                .filter((n) => !n.parent_id)
                .slice(0, 12)
                .map((n) => (
                  <Chip key={n.id} selected={categoryId === n.id} onClick={() => setCategoryId(categoryId === n.id ? null : n.id)}>
                    {n.name.text}
                  </Chip>
                ))}
            </div>
            <p className="pwa-text-caption m-0">
              <Icon name="info" size={16} /> {t('help.request.noTriageNote')}{' '}
              <button
                type="button"
                className="pwa-link"
                onClick={() => {
                  saveHelpDraft({ vehicleId, text: description.trim(), symptoms: [] });
                  goTo(`/${locale}/help`);
                }}
              >
                {t('help.request.describeWithHelp')}
              </button>
            </p>
          </>
        ) : triage ? (
          <p className="pwa-text-caption m-0">
            <Icon name="spark" size={16} /> {t('help.request.aiIncluded')}
          </p>
        ) : null}
      </section>

      <section className="pwa-stack-sm" aria-labelledby="req-type">
        <h2 id="req-type" className="pwa-text-label m-0">
          {t('help.request.type')}
        </h2>
        <div className="pwa-chips" role="group" aria-labelledby="req-type">
          {APPOINTMENT_TYPES.map((x) => (
            <Chip key={x} selected={type === x} onClick={() => setType(x)}>
              {t(`appointments.type.${x}`)}
            </Chip>
          ))}
        </div>
        {modes.length > 1 ? (
          <div className="pwa-chips" role="group" aria-label={t('help.request.mode')}>
            {modes.map((m) => (
              <Chip key={m} selected={serviceMode === m} onClick={() => setMode(m)}>
                {t(`appointments.mode.${m}`)}
              </Chip>
            ))}
          </div>
        ) : null}
      </section>

      <section className="pwa-stack-sm" aria-labelledby="req-urgency">
        <h2 id="req-urgency" className="pwa-text-label m-0">
          {t('help.request.urgency')}
        </h2>
        <div className="pwa-chips" role="group" aria-labelledby="req-urgency">
          {LEVEL_ORDER.map((l) => (
            <Chip key={l} icon={l === 'safety_critical' ? 'alert' : undefined} selected={urgency === l} onClick={() => setUrgency(l)}>
              {t(`appointments.urgency.${l}`)}
            </Chip>
          ))}
        </div>
      </section>

      <TimesPicker
        orgId={p.orgId}
        locationId={locationId}
        timeZone={timeZone}
        value={choices}
        onChange={setChoices}
        appointmentType={type}
        onSlots={onSlots}
        error={errors.includes('times') ? t(FORM_ERROR.times) : null}
      />

      <section className="pwa-stack-sm" aria-labelledby="req-note">
        <h2 id="req-note" className="pwa-text-label m-0">
          {t('help.request.noteTitle')}
        </h2>
        <TextField
          multiline
          rows={2}
          label={t('help.request.note')}
          placeholder={t('help.request.notePlaceholder')}
          value={note}
          maxLength={1000}
          onChange={(e) => setNote(e.target.value)}
        />
        {safety.data?.flag ? (
          <SafetyBanner
            title={t('help.request.safetyTitle')}
            text={t('help.request.safetyText')}
            action={
              <Link href={`/${locale}/help?urgent=1`} className={buttonClass({ variant: 'danger', size: 'sm' })}>
                <span className="cp-btn-label">{t('help.safety.findUrgent')}</span>
              </Link>
            }
          />
        ) : null}
      </section>

      <section className="pwa-stack-sm" aria-labelledby="req-media">
        <h2 id="req-media" className="pwa-text-label m-0">
          {t('help.request.media')}
        </h2>
        {c.mediaIds.length ? (
          <ul className="pwa-plain-list pwa-help-thumbs" aria-label={t('help.case.media')}>
            {c.mediaIds.map((id) => (
              <li key={id}>
                <AssetThumb mediaId={id} label={t('help.case.mediaItem')} />
              </li>
            ))}
          </ul>
        ) : null}
        <UploadZone
          group={group}
          purpose="appointment_photo"
          multiple
          label={t('help.request.addMedia')}
          hint={t('help.describe.mediaHint')}
        />
      </section>

      <section className="pwa-stack-sm" aria-labelledby="req-share">
        <h2 id="req-share" className="pwa-text-label m-0">
          {t('help.request.share')}
        </h2>
        <div className="pwa-card pwa-stack-sm">
          <Check checked disabled hint={t('help.request.shareVehicleHint')}>
            {t('help.request.shareVehicle')}
          </Check>
          <Check
            checked={share}
            onChange={(e) => setShare(e.target.checked)}
            hint={share ? t('help.request.shareHistoryOn', { name }) : t('help.request.shareHistoryOff')}
          >
            {t('help.request.shareHistory')}
          </Check>
          <Check
            checked={includeMedia}
            disabled={mediaIds.length === 0}
            onChange={(e) => setIncludeMedia(e.target.checked)}
            hint={mediaIds.length ? t('help.request.shareMediaHint', { count: mediaIds.length }) : t('help.request.noMedia')}
          >
            {t('help.request.shareMedia')}
          </Check>
        </div>
        <div className="pwa-stack-xs">
          <span className="cp-field-label" id="req-channel">
            {t('help.request.channel')}
          </span>
          <div className="pwa-chips" role="group" aria-labelledby="req-channel">
            {CONTACT_CHANNELS.map((ch) => (
              <Chip key={ch} selected={channel === ch} onClick={() => setChannel(ch)}>
                {t(`appointments.channel.${ch}`)}
              </Chip>
            ))}
          </div>
        </div>
        <div>
          <Button icon="eye" variant="ghost" loading={busy === 'preview'} disabled={busy !== null} onClick={() => void preview()}>
            {t('help.request.preview')}
          </Button>
        </div>
      </section>

      {errors.includes('vehicle') ? (
        <p className="pwa-error-text m-0" role="alert">
          {t(FORM_ERROR.vehicle)}
        </p>
      ) : null}
      {failure ? (
        <div className="pwa-error-text pwa-stack-xs" role="alert">
          <p className="m-0">{t(FAILURE[failure])}</p>
          {failure === 'caps' ? (
            <Link href={`/${locale}/appointments?seg=requested`} className="pwa-link">
              {t('help.request.openRequests')}
            </Link>
          ) : null}
          {failure === 'contact' ? (
            <Link href={`/${locale}/settings/profile#contact`} className="pwa-link">
              {t('help.request.verifyContact')}
            </Link>
          ) : null}
        </div>
      ) : null}
      <div className="pwa-help-send">
        <Button variant="primary" icon="send" block loading={busy === 'send'} disabled={busy !== null} onClick={() => void send()}>
          {t('help.request.send')}
        </Button>
        <p className="pwa-text-caption m-0">{t('help.request.sendNote', { name })}</p>
      </div>

      <PreVisitDrawer open={previewId !== null} onClose={() => setPreviewId(null)} appointmentId={previewId} providerName={name} />
    </div>
  );
}
