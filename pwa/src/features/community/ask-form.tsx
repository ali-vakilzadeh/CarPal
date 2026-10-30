'use client';
// W-QA-02 Ask a question (mirrors C-COMM-04; P8.T4) at /<locale>/questions/ask: the car (signed in: one of the garage
// cars — a private link the public never sees, only its brand and model; guests: brand / model / series), the title
// with live "Similar questions" beside it, details, a category or symptom (suggested from the text by
// taxonomy.suggest, labelled Suggested — the backend needs a car, a symptom or a category), photos through the upload
// kit (images only, signed-in users; public photos stay private until a moderator approves them, BA-06), the privacy
// note, the red safety banner from safety.check with "Use Help Me" for urgent text, and the warning for contact data.
// Posting: published → the question page; held (contact data, BA-17) → "Being reviewed" here, with the question's
// link for later. Guests write everything first and sign in at Post; the question is posted after sign-in (GD-06).
import type { SafetyBlock, TaxonomyNode, TaxonomySuggestion } from '@carpal/api-contracts';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { Badge } from '@/components/ds/badge';
import { Banner, SafetyBanner } from '@/components/ds/banner';
import { Button, buttonClass } from '@/components/ds/button';
import { Chip } from '@/components/ds/chip';
import { TextField } from '@/components/ds/text-field';
import { useActiveVehicle } from '@/components/shell/active-vehicle';
import { useGatedAction, useIntentHandler } from '@/components/shell/auth-intent';
import { StateView } from '@/components/shell/states';
import { useToast } from '@/components/shell/toast';
import { EMPTY_PICK, VehiclePicker, type VehiclePick } from '@/components/vehicle/vehicle-picker';
import { discardGroup, releaseGroup, uploadsOf, UploadZone, useUploads, whenReady } from '@/features/media';
import { ApiProblem, type ApiClient } from '@/lib/api';
import { useApiClient, useApiQuery } from '@/lib/api/query';
import { useSession } from '@/lib/api/session';
import { useBrowserValue } from '@/lib/browser-value';
import { useFlag } from '@/lib/config/client';
import { useTaxonomyNodes } from '@/lib/config/taxonomy';
import { useLocale, useT } from '@/lib/i18n/client';
import type { Locale } from '@/lib/i18n/locales';
import { questionPath } from '@/lib/seo/urls';
import { clearAskDraft, peekAskTitle } from './ask-draft';
import { HelpMeButton } from './help-link';
import { rememberMine } from './memory';
import { heldForReview, MAX_BODY, MAX_TITLE, MIN_BODY, MIN_TITLE, textLength } from './model';
import { QuestionCard } from './qa-hub';

const GROUP = 'question:new';
const NONE = 'none';

/** What a guest's question carries through sign-in (the auth intent's draft, ≤ 8 KiB). */
export interface AskIntentDraft {
  title: string;
  body: string;
  brandId?: string;
  modelId?: string;
  seriesId?: string;
  categoryId?: string;
  symptomId?: string;
}

export interface AskInput extends AskIntentDraft {
  vehicleId?: string;
  mediaIds?: string[];
}

/** QuestionWrite from the form. */
export function questionBody(input: AskInput, locale: Locale) {
  return {
    ...(input.vehicleId ? { vehicle_id: input.vehicleId } : {}),
    ...(!input.vehicleId && input.brandId ? { brand_node_id: input.brandId } : {}),
    ...(!input.vehicleId && input.brandId && input.modelId ? { model_node_id: input.modelId } : {}),
    ...(!input.vehicleId && input.brandId && input.modelId && input.seriesId ? { series_node_id: input.seriesId } : {}),
    ...(input.categoryId ? { category_node_id: input.categoryId } : {}),
    ...(input.symptomId ? { symptom_node_id: input.symptomId } : {}),
    title: input.title.trim().replace(/[\r\n]+/g, ' '),
    body: input.body.trim(),
    content_locale: locale,
    ...(input.mediaIds?.length ? { media_ids: input.mediaIds } : {}),
  };
}

/** The backend needs a car, a symptom or a category (52 Question). */
export const hasContext = (i: AskInput) => !!(i.vehicleId || i.categoryId || i.symptomId);

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

/** Category and symptom suggestions from the title and details (taxonomy.suggest), debounced. */
function useSuggestions(text: string): TaxonomySuggestion[] {
  const q = useDebounced(text.trim().slice(0, 100), 400);
  const r = useApiQuery(
    'taxonomy.suggest',
    { body: { text: q, types: ['symptom', 'service_system', 'part_category'] } },
    { enabled: [...q].length >= 3, staleTime: 60_000 },
  );
  return [...q].length >= 3 ? (r.data?.items ?? []).slice(0, 5) : [];
}

function useSafety(text: string): SafetyBlock | null {
  const locale = useLocale();
  const q = useDebounced(text.trim().slice(0, 1000), 600);
  const r = useApiQuery('safety.check', { body: { text: q, locale } }, { enabled: [...q].length >= 8, staleTime: 60_000 });
  return [...q].length >= 8 ? (r.data ?? null) : null;
}

async function postQuestion(api: ApiClient, input: AskInput, locale: Locale) {
  return api.api('questions.create', { body: questionBody(input, locale) });
}

type Posted = { id: string; title: string; held: boolean };

export function AskForm() {
  const t = useT();
  const locale = useLocale();
  const api = useApiClient();
  const router = useRouter();
  const toast = useToast();
  const gate = useGatedAction();
  const session = useSession();
  const enabled = useFlag('qna.enabled');
  const signedIn = session.data?.signed_in === true;
  const user = session.data?.user ?? null;
  const { vehicles, active } = useActiveVehicle();
  const uploads = useUploads(GROUP);

  const [vehicleChoice, setVehicleChoice] = useState<string | null>(null);
  const [pick, setPick] = useState<VehiclePick>(EMPTY_PICK);
  // The hub's "Ask it" hands over the typed text as the title (sessionStorage, read after hydration).
  const handedOver = useBrowserValue(peekAskTitle, '');
  const [titleInput, setTitle] = useState<string | null>(null);
  const title = titleInput ?? handedOver;
  const [body, setBody] = useState('');
  const [category, setCategory] = useState<TaxonomyNode | null>(null);
  const [symptom, setSymptom] = useState<TaxonomyNode | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  const [posted, setPosted] = useState<Posted | null>(null);
  const categories = useTaxonomyNodes('service_system', null, enabled);

  useEffect(() => () => discardGroup(GROUP), []);

  const vehicleId = signedIn ? (vehicleChoice ?? active?.id ?? NONE) : NONE;
  const input: AskInput = {
    title,
    body,
    ...(vehicleId !== NONE ? { vehicleId } : {}),
    ...(vehicleId === NONE && pick.brandId ? { brandId: pick.brandId } : {}),
    ...(vehicleId === NONE && pick.modelId ? { modelId: pick.modelId } : {}),
    ...(vehicleId === NONE && pick.seriesId ? { seriesId: pick.seriesId } : {}),
    ...(category ? { categoryId: category.id } : {}),
    ...(symptom ? { symptomId: symptom.id } : {}),
  };
  const suggestions = useSuggestions(`${title} ${body}`);
  const safety = useSafety(`${title}\n${body}`);
  const similarText = useDebounced(title.trim(), 400);
  const similar = useApiQuery(
    'questions.search',
    { body: { text: similarText.slice(0, 200), limit: 5 } },
    { enabled: enabled && [...similarText].length >= 4, staleTime: 60_000 },
  );

  const titleOk = textLength(title) >= MIN_TITLE;
  const bodyOk = textLength(body) >= MIN_BODY;
  const contextOk = hasContext(input);
  const uploading = uploads.some((u) => u.state.phase !== 'ready' && u.state.phase !== 'failed');
  const held = heldForReview(title, body);

  const finish = (q: { id: string; title: string; body: string; author: { display_name: string } }) => {
    clearAskDraft();
    if (user) rememberMine(user.id, 'question', q.id, q.author.display_name);
    if (heldForReview(q.title, q.body)) setPosted({ id: q.id, title: q.title, held: true });
    else router.push(questionPath(locale, q));
  };

  // A guest's question is posted once they are back from signing in (GD-06).
  useIntentHandler<AskIntentDraft>('ask', async (intent) => {
    const d = intent.draft;
    if (!d?.title || !d.body) return;
    try {
      const q = await postQuestion(api, d, locale);
      finish(q);
      return heldForReview(q.title, q.body) ? t('community.ask.postedHeld') : t('community.ask.posted');
    } catch {
      setTitle(d.title);
      setBody(d.body);
      return t('community.ask.failed');
    }
  });

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const assets = await Promise.all(uploadsOf(GROUP).map((u) => whenReady(u.id)));
      const mediaIds = assets.filter((a): a is NonNullable<typeof a> => !!a).map((a) => a.id);
      const q = await postQuestion(api, { ...input, mediaIds }, locale);
      releaseGroup(GROUP);
      toast(heldForReview(q.title, q.body) ? t('community.ask.postedHeld') : t('community.ask.posted'));
      finish(q);
    } catch (err) {
      setError(
        err instanceof ApiProblem && err.status === 422
          ? t('community.ask.invalid')
          : err instanceof ApiProblem && err.status === 429
            ? t('community.comments.slowDown')
            : t('community.ask.failed'),
      );
    } finally {
      setBusy(false);
    }
  };

  const onPost = () => {
    setTried(true);
    if (!titleOk || !bodyOk || !contextOk || uploading || busy) return;
    const draft: AskIntentDraft = {
      title: title.trim(),
      body: body.trim(),
      ...(input.brandId ? { brandId: input.brandId } : {}),
      ...(input.modelId ? { modelId: input.modelId } : {}),
      ...(input.seriesId ? { seriesId: input.seriesId } : {}),
      ...(input.categoryId ? { categoryId: input.categoryId } : {}),
      ...(input.symptomId ? { symptomId: input.symptomId } : {}),
    };
    gate({ type: 'ask', target: 'question', draft, title: t('community.ask.intent'), run: submit });
  };

  const similarItems = useMemo(() => (similar.data?.items ?? []).slice(0, 5), [similar.data]);

  if (!enabled)
    return (
      <div className="py-6">
        <h1 className="pwa-text-title m-0">{t('community.ask.heading')}</h1>
        <StateView kind="featureOff" t={t} title={t('community.qa.off')} />
      </div>
    );

  if (posted)
    return (
      <div className="py-6 pwa-stack">
        <StateView
          kind="beingReviewed"
          t={t}
          title={t('community.ask.heldTitle')}
          text={t('community.ask.heldText')}
          action={
            <Link href={`/${locale}/questions`} className={buttonClass({ variant: 'secondary' })}>
              <span className="cp-btn-label">{t('community.ask.backToQa')}</span>
            </Link>
          }
        />
      </div>
    );

  const urgent = safety?.flag && safety.level !== 'none';
  return (
    <form
      className="pwa-ask"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        onPost();
      }}
    >
      <h1 className="pwa-text-title m-0">{t('community.ask.heading')}</h1>
      <div className="pwa-ask-layout">
        <div className="pwa-stack">
          {urgent ? (
            <SafetyBanner
              title={t('community.ask.safetyTitle')}
              text={t('community.ask.safetyText')}
              action={
                <HelpMeButton
                  text={`${title}\n${body}`}
                  label={t('community.ask.useHelpMe')}
                  urgent
                  variant="danger"
                  vehicleId={input.vehicleId ?? null}
                />
              }
            />
          ) : null}
          {signedIn && vehicles.length ? (
            <div className="cp-field">
              <label className="cp-field-label" htmlFor="ask-vehicle">
                {t('community.ask.vehicle')}
              </label>
              <div className="cp-field-box pwa-select-box">
                <select
                  id="ask-vehicle"
                  className="cp-field-input pwa-select"
                  value={vehicleId}
                  onChange={(e) => setVehicleChoice(e.target.value)}
                >
                  {vehicles.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.nickname ? `${v.nickname} · ${v.year}` : String(v.year)}
                    </option>
                  ))}
                  <option value={NONE}>{t('community.ask.otherCar')}</option>
                </select>
              </div>
              <p className="cp-field-hint">{t('community.ask.vehiclePrivate')}</p>
            </div>
          ) : null}
          {vehicleId === NONE ? <VehiclePicker value={pick} onChange={setPick} legend="community.ask.carLegend" /> : null}
          <TextField
            label={t('community.ask.title')}
            value={title}
            maxLength={MAX_TITLE}
            onChange={(e) => setTitle(e.target.value.replace(/[\r\n]/g, ' '))}
            error={tried && !titleOk ? t('community.compose.minLength', { count: MIN_TITLE }) : undefined}
            hint={t('community.ask.titleHint')}
          />
          <TextField
            multiline
            rows={6}
            label={t('community.ask.details')}
            value={body}
            maxLength={MAX_BODY}
            onChange={(e) => setBody(e.target.value)}
            error={tried && !bodyOk ? t('community.compose.minLength', { count: MIN_BODY }) : undefined}
            hint={
              textLength(body) > MAX_BODY - 1000
                ? t('community.compose.counter', { count: textLength(body), max: MAX_BODY })
                : t('community.ask.detailsHint')
            }
          />
          <fieldset className="pwa-stack-sm">
            <legend className="pwa-text-label">{t('community.ask.category')}</legend>
            {suggestions.length ? (
              <div className="pwa-chip-row" aria-label={t('community.ask.suggested')}>
                <Badge tone="accent">{t('community.ask.suggested')}</Badge>
                {suggestions.map((s) => {
                  const isSymptom = s.node.type === 'symptom';
                  const selected = isSymptom ? symptom?.id === s.node.id : category?.id === s.node.id;
                  return (
                    <Chip
                      key={s.node.id}
                      selected={selected}
                      onClick={() => (isSymptom ? setSymptom(selected ? null : s.node) : setCategory(selected ? null : s.node))}
                    >
                      {s.node.name.text}
                    </Chip>
                  );
                })}
              </div>
            ) : null}
            <div className="cp-field">
              <label className="cp-field-label" htmlFor="ask-category">
                {t('community.ask.categoryPick')}
              </label>
              <div className="cp-field-box pwa-select-box">
                <select
                  id="ask-category"
                  className="cp-field-input pwa-select"
                  value={category?.id ?? ''}
                  onChange={(e) => setCategory((categories.data ?? []).find((n) => n.id === e.target.value) ?? null)}
                >
                  <option value="">{t('community.qa.anyCategory')}</option>
                  {category && !(categories.data ?? []).some((n) => n.id === category.id) ? (
                    <option value={category.id}>{category.name.text}</option>
                  ) : null}
                  {(categories.data ?? []).map((n) => (
                    <option key={n.id} value={n.id}>
                      {n.name.text}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            {symptom ? (
              <Chip
                selected
                iconEnd="close"
                onClick={() => setSymptom(null)}
                label={t('community.ask.removeSymptom', { name: symptom.name.text })}
              >
                {symptom.name.text}
              </Chip>
            ) : null}
            {tried && !contextOk ? <p className="cp-field-hint is-error">{t('community.ask.needContext')}</p> : null}
          </fieldset>
          {signedIn ? (
            <UploadZone group={GROUP} purpose="qna" label={t('community.ask.photos')} hint={t('community.ask.photosHint')} />
          ) : (
            <p className="pwa-text-caption">{t('community.ask.photosSignIn')}</p>
          )}
          {held ? <Banner tone="warn" icon="info" text={t('community.moderation.contactWarning')} /> : null}
          <p className="pwa-text-caption">
            {user ? t('community.ask.privacyNamed', { name: user.display_name }) : t('community.ask.privacy')}
          </p>
          {error ? <Banner tone="danger" icon="alert" text={error} /> : null}
          <div>
            <Button type="submit" variant="primary" icon="send" loading={busy} disabled={uploading}>
              {uploading ? t('community.ask.waitUploads') : t('community.ask.post')}
            </Button>
          </div>
        </div>
        <aside className="pwa-ask-similar" aria-live="polite" aria-label={t('community.ask.similar')}>
          <h2 className="pwa-text-label m-0">{t('community.ask.similar')}</h2>
          {similarItems.length ? (
            <>
              <p className="pwa-text-caption">{t('community.ask.similarHint')}</p>
              <ul className="pwa-plain-list pwa-stack-sm">
                {similarItems.map((q) => (
                  <li key={q.id}>
                    <QuestionCard q={q} headingLevel={3} />
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="pwa-text-caption">{t('community.ask.similarEmpty')}</p>
          )}
        </aside>
      </div>
    </form>
  );
}
