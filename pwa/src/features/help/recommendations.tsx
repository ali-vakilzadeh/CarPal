'use client';
// W-HELP-01 Summary and recommendations (P10.T2; Docs/55 C-HELP-06, Docs/22 "Recommendations step (web additions)"):
//   - "What we understood": vehicle, description, the likely areas (AI summary badge), urgency, confidence, media and
//     Edit; low confidence says a general inspection is recommended (Docs/55 §5.3);
//   - the category: Change opens the picker; with AI off (or no car) the picker comes first — the category path
//     (GD-13, BA-02); a chosen category runs a Help Me search;
//   - the 3 recommended providers as wide cards with their full match explanation (reasons + explanation, 54 §5),
//     Compare (side by side) and Map (numbered 1-3), the rest of the first page below; safety-critical issues put the
//     shops that can see the user soonest first;
//   - no match: Widen to 100 km, Search for parts instead, Ask the community; and always See more shops (W-SRCH-01 with
//     the same search), Save for later. No Featured block (featured.enabled off, Docs/55 §4.6).
import type { LocationInput, ResultCard, TaxonomyNode } from '@carpal/api-contracts';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { Badge } from '@/components/ds/badge';
import { Banner, SafetyBanner } from '@/components/ds/banner';
import { Button, buttonClass } from '@/components/ds/button';
import { Chip } from '@/components/ds/chip';
import { Icon } from '@/components/ds/icon';
import { Urgency } from '@/components/ds/urgency';
import { useActiveVehicle, useVehicleLabel } from '@/components/shell/active-vehicle';
import { savePendingSearch } from '@/components/shell/search-box';
import { SkeletonList } from '@/components/shell/skeleton';
import { StateView, stateFromProblem } from '@/components/shell/states';
import { useToast } from '@/components/shell/toast';
import { uiLevelOf } from '@/features/appointments';
import { saveAskDraft } from '@/features/community';
import { boundsOf, MapCanvas, placesFromResults } from '@/features/map';
import { AssetThumb } from '@/features/media';
import { RatingLine } from '@/features/profiles';
import { distanceText, LocationChip, ResultCardView, storeSearch, useResultEvent } from '@/features/search';
import { ApiProblem } from '@/lib/api/problem';
import { useFlag, useRegion } from '@/lib/config/client';
import { useTaxonomyNodes } from '@/lib/config/taxonomy';
import { useFormat } from '@/lib/format/client';
import { useLocale, useT } from '@/lib/i18n/client';
import type { MessageKey } from '@/lib/i18n/keys';
import { helpSearch, matchKey, useHelpActions } from './actions';
import { caseLevel, confidenceOf, descriptionOf, isCritical, recommended } from './model';
import type { WizardContext } from './wizard';

function CategoryPicker({ current, onPick }: { current: string | null; onPick: (n: TaxonomyNode) => void }) {
  const t = useT();
  const nodes = useTaxonomyNodes('service_system', null);
  const top = (nodes.data ?? []).filter((n) => !n.parent_id);
  if (nodes.isPending) return <SkeletonList count={1} label={t('common.loading')} />;
  return (
    <div className="pwa-chips" role="group" aria-label={t('help.categories.pick')}>
      {top.map((n) => (
        <Chip key={n.id} selected={current === n.id} onClick={() => onPick(n)}>
          {n.name.text}
        </Chip>
      ))}
    </div>
  );
}

function CompareTable({ items }: { items: readonly ResultCard[] }) {
  const t = useT();
  const f = useFormat();
  const rows: { label: MessageKey; cell: (r: ResultCard) => ReactNode }[] = [
    { label: 'help.compare.distance', cell: (r) => distanceText(r, f) ?? '—' },
    {
      label: 'help.compare.rating',
      cell: (r) => <RatingLine value={r.organization.overall_rating} count={r.organization.review_count} t={t} f={f} />,
    },
    { label: 'help.compare.verified', cell: (r) => (r.organization.verified ? t('help.compare.yes') : t('help.compare.no')) },
    {
      label: 'help.compare.open',
      cell: (r) => (r.open_now === true ? t('profiles.location.openNow') : r.open_now === false ? t('profiles.location.closedNow') : '—'),
    },
    { label: 'help.compare.next', cell: (r) => (r.next_available_slot ? f.date(r.next_available_slot, 'dateTime') : '—') },
    { label: 'help.compare.why', cell: (r) => <span dir="auto">{r.reasons[0]?.summary.text ?? '—'}</span> },
  ];
  return (
    <div className="pwa-table-wrap">
      <table className="pwa-compare">
        <caption className="sr-only">{t('help.compare.caption')}</caption>
        <thead>
          <tr>
            <td />
            {items.map((r) => (
              <th key={r.result_id} scope="col" dir="auto">
                <bdi>{r.organization.name}</bdi>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label}>
              <th scope="row">{t(row.label)}</th>
              {items.map((r) => (
                <td key={r.result_id}>{row.cell(r)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function RecommendationsStep({
  ctx,
  defaultCity,
  styleUrl,
  policyVersion,
}: {
  ctx: WizardContext;
  defaultCity: string;
  styleUrl: string | null;
  policyVersion: string;
}) {
  const t = useT();
  const f = useFormat();
  const locale = useLocale();
  const router = useRouter();
  const toast = useToast();
  const region = useRegion();
  const qna = useFlag('qna.enabled');
  const { match } = useHelpActions();
  const resultEvent = useResultEvent();
  const { c, triage, patch } = ctx;
  const { vehicles } = useActiveVehicle();
  const vehicle = vehicles.find((v) => v.id === c.vehicleId) ?? null;
  const carLabel = useVehicleLabel(vehicle);
  const [location, setLocation] = useState<LocationInput>({ mode: 'chosen_city', city_key: c.city ?? defaultCity });
  const [consentClosed, setConsentClosed] = useState(false);
  const [wider, setWider] = useState(false);
  const [picking, setPicking] = useState(false);
  const [view, setView] = useState<'cards' | 'compare' | 'map'>('cards');
  const level = caseLevel(c, triage);
  const critical = isCritical(level);
  const needsCategory = !triage && !c.category && !critical;
  const key = matchKey(c, location, wider);

  const q = useQuery({
    queryKey: ['help-match', c.id, c.triageId, key],
    enabled: !needsCategory,
    staleTime: Infinity,
    gcTime: 30 * 60_000,
    retry: false,
    queryFn: async () => {
      const { result } = await match(c, triage, location, { reuse: c.matchKey === key, wider });
      patch({ matchSessionId: result.sessionId, matchKey: key, ...(location.mode === 'chosen_city' ? { city: location.city_key } : {}) });
      return result;
    },
  });
  const consentAsked = !consentClosed && q.error instanceof ApiProblem && q.error.code === 'LOCATION_CONSENT_REQUIRED';
  const { top, more } = recommended(q.data?.results ?? [], critical);
  const places = placesFromResults(top);
  const bbox = boundsOf(places.map((p) => p.point));

  const pickCategory = (n: TaxonomyNode) => {
    patch({ category: { id: n.id, label: n.name.text }, matchSessionId: null, matchKey: null, provider: null, draft: null });
    setPicking(false);
    toast(t('help.categories.updated'));
  };
  const request = (r: ResultCard) => {
    if (q.data) resultEvent(q.data.sessionId, r.result_id, 'selected');
    patch({
      provider: {
        orgId: r.organization.id,
        slug: r.organization.slug,
        name: r.organization.name,
        locationId: r.location?.location_id ?? null,
        slot: null,
        resultId: r.result_id,
        via: 'help',
      },
      draft: null,
    });
    ctx.go('request');
  };
  const description = triage ? descriptionOf(triage) : c.text;
  const subject = c.category?.label ?? triage?.likely_systems[0]?.label.text ?? description;
  const seeMore = () => {
    if (!q.data) return;
    storeSearch(q.data.sessionId, helpSearch(c, triage, location, level, locale as 'en' | 'fa', wider));
    router.push(`/${locale}/search/${q.data.sessionId}`);
  };
  const confidence = triage ? confidenceOf(triage) : null;
  const actions = (r: ResultCard) => (
    <>
      <Button size="sm" variant="primary" icon="calendar" onClick={() => request(r)}>
        {t('help.recommendations.request')}
      </Button>
    </>
  );

  return (
    <div className="pwa-stack">
      {critical ? <SafetyBanner title={t('help.recommendations.criticalTitle')} text={t('help.recommendations.criticalText')} /> : null}
      <section className="pwa-card pwa-stack-sm" aria-labelledby="help-understood">
        <div className="pwa-help-head">
          <h1 id="help-understood" className="pwa-text-h2 m-0">
            {t('help.recommendations.understood')}
          </h1>
          <Link href={`/${locale}/help/${c.id}/describe`} className={buttonClass({ size: 'sm', variant: 'ghost' })}>
            <Icon name="edit" size={20} />
            <span className="cp-btn-label">{t('help.case.edit')}</span>
          </Link>
        </div>
        {vehicle ? (
          <p className="pwa-text-body m-0">
            <Icon name="car" size={20} /> <bdi>{carLabel ?? ''}</bdi>
          </p>
        ) : null}
        {description ? (
          <p className="pwa-help-quote pwa-user-text m-0" dir="auto">
            {description}
          </p>
        ) : null}
        {triage ? (
          <div className="pwa-stack-xs">
            <span className="pwa-badges">
              <Badge icon="spark">{t('help.recommendations.aiSummary')}</Badge>
            </span>
            <p className="pwa-text-label m-0">
              {triage.likely_systems.length
                ? t('help.recommendations.likely', { areas: triage.likely_systems.map((x) => x.label.text).join('، ') })
                : t('help.recommendations.unclear')}
            </p>
            {confidence === 'low' ? <p className="pwa-text-body m-0">{t('help.recommendations.inspection')}</p> : null}
          </div>
        ) : c.category ? (
          <p className="pwa-text-label m-0">{t('help.recommendations.youChose', { category: c.category.label })}</p>
        ) : null}
        <span className="pwa-badges">
          <Urgency level={uiLevelOf(level)} label={t(`appointments.urgency.${level}`)} />
          {confidence ? <Badge icon="info">{t(`help.recommendations.confidence.${confidence}`)}</Badge> : null}
        </span>
        {c.mediaIds.length ? (
          <ul className="pwa-plain-list pwa-help-thumbs" aria-label={t('help.case.media')}>
            {c.mediaIds.map((id) => (
              <li key={id}>
                <AssetThumb mediaId={id} label={t('help.case.mediaItem')} />
              </li>
            ))}
          </ul>
        ) : null}
        <p className="pwa-text-caption m-0">{t('help.questions.notDiagnosis')}</p>
      </section>

      <section className="pwa-stack-sm" aria-labelledby="help-category">
        {needsCategory ? (
          <Banner
            tone="warn"
            title={c.aiOff ? t('help.aiOff.title') : t('help.categories.noTriageTitle')}
            text={t('help.categories.chooseText')}
          />
        ) : null}
        <div className="pwa-help-head">
          <h2 id="help-category" className="pwa-text-label m-0">
            {t('help.categories.current', {
              category: c.category?.label ?? triage?.likely_systems[0]?.label.text ?? t('help.categories.general'),
            })}
          </h2>
          {!needsCategory ? (
            <Button size="sm" variant="ghost" aria-expanded={picking} onClick={() => setPicking((v) => !v)}>
              {t('help.categories.change')}
            </Button>
          ) : null}
        </div>
        {needsCategory || picking ? <CategoryPicker current={c.category?.id ?? null} onPick={pickCategory} /> : null}
        <div className="pwa-help-row">
          <LocationChip
            value={location}
            region={region}
            policyVersion={policyVersion}
            onChange={(loc) => {
              setLocation(loc);
              setConsentClosed(false);
            }}
            consentAsked={consentAsked}
            onConsentClosed={() => setConsentClosed(true)}
          />
        </div>
      </section>

      {needsCategory ? null : q.isPending ? (
        <SkeletonList count={3} label={t('help.recommendations.loading')} />
      ) : q.isError ? (
        <StateView
          kind={stateFromProblem(q.error)}
          t={t}
          compact
          action={
            <Button size="sm" onClick={() => void q.refetch()}>
              {t('common.actions.retry')}
            </Button>
          }
        />
      ) : top.length === 0 ? (
        <section className="pwa-card pwa-stack-sm" aria-labelledby="help-nomatch">
          <h2 id="help-nomatch" className="pwa-text-label m-0">
            {t('help.recommendations.noMatch', { subject })}
          </h2>
          <div className="pwa-inline-buttons">
            {!wider ? (
              <Button size="sm" onClick={() => setWider(true)}>
                {t('help.recommendations.widen')}
              </Button>
            ) : null}
            <Button size="sm" icon="part" onClick={() => partsInstead(subject)}>
              {t('help.recommendations.parts')}
            </Button>
            {qna ? (
              <Button size="sm" icon="chat" onClick={() => askCommunity(description)}>
                {t('help.recommendations.ask')}
              </Button>
            ) : null}
          </div>
        </section>
      ) : (
        <section className="pwa-stack-sm" aria-labelledby="help-best">
          <div className="pwa-help-head">
            <h2 id="help-best" className="pwa-text-h2 m-0">
              {critical
                ? t('help.recommendations.soonest')
                : carLabel
                  ? t('help.recommendations.bestFor', { car: carLabel })
                  : t('help.recommendations.best')}
            </h2>
            <div className="pwa-inline-buttons" role="group" aria-label={t('help.recommendations.views')}>
              <Button
                size="sm"
                variant={view === 'compare' ? 'secondary' : 'ghost'}
                aria-pressed={view === 'compare'}
                onClick={() => setView(view === 'compare' ? 'cards' : 'compare')}
              >
                {t('help.recommendations.compare')}
              </Button>
              <Button
                size="sm"
                variant={view === 'map' ? 'secondary' : 'ghost'}
                icon="map"
                aria-pressed={view === 'map'}
                onClick={() => setView(view === 'map' ? 'cards' : 'map')}
              >
                {t('help.recommendations.map')}
              </Button>
            </div>
          </div>
          {view === 'compare' ? <CompareTable items={top} /> : null}
          {view === 'map' && places.length ? (
            <MapCanvas
              className="pwa-help-map"
              center={places[0]!.point}
              zoom={12}
              places={places}
              bestMatch
              styleUrl={styleUrl}
              fit={bbox ? { key: places.map((p) => p.id).join(','), bbox } : null}
              label={t('help.recommendations.mapLabel')}
            />
          ) : null}
          <ol className="pwa-plain-list pwa-stack">
            {top.map((r) => (
              <li key={r.result_id} className="pwa-help-rec">
                <ResultCardView r={r} locale={locale} t={t} f={f} bestMatch={!critical} actions={actions(r)} />
                <div className="pwa-help-why">
                  <h3 className="pwa-text-caption m-0">{t('help.recommendations.why')}</h3>
                  <ul className="pwa-plain-list pwa-stack-xs">
                    {r.reasons.map((x, i) => (
                      <li key={`${x.reason_type}-${i}`} className="pwa-text-body" dir="auto">
                        <Icon name="check" size={16} /> {x.summary.text}
                      </li>
                    ))}
                  </ul>
                  <p className="pwa-text-caption m-0" dir="auto">
                    {r.explanation.source === 'ai' ? <Badge icon="spark">{t('search.result.aiSuggestion')}</Badge> : null}{' '}
                    {r.explanation.text}
                  </p>
                </div>
              </li>
            ))}
          </ol>
          {more.length ? (
            <details className="pwa-disclosure">
              <summary>{t('help.recommendations.more', { count: more.length })}</summary>
              <ul className="pwa-plain-list pwa-stack-sm">
                {more.map((r) => (
                  <li key={r.result_id}>
                    <ResultCardView r={r} locale={locale} t={t} f={f} actions={actions(r)} />
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </section>
      )}

      <section className="pwa-stack-sm" aria-labelledby="help-more">
        <h2 id="help-more" className="pwa-text-label m-0">
          {t('help.recommendations.options')}
        </h2>
        <div className="pwa-inline-buttons">
          {q.data ? (
            <Button icon="map" onClick={seeMore}>
              {t('help.recommendations.seeMore')}
            </Button>
          ) : null}
          <Button icon="part" variant="ghost" onClick={() => partsInstead(subject)}>
            {t('help.recommendations.parts')}
          </Button>
          {qna ? (
            <Button icon="chat" variant="ghost" onClick={() => askCommunity(description)}>
              {t('help.recommendations.ask')}
            </Button>
          ) : null}
          <Button
            icon="bookmark"
            variant="ghost"
            onClick={() => {
              toast(t('help.exit.saved'));
              router.push(`/${locale}/home`);
            }}
          >
            {t('help.recommendations.saveLater')}
          </Button>
        </div>
      </section>
    </div>
  );

  function partsInstead(text: string) {
    savePendingSearch({ text: [...text].slice(0, 120).join('') });
    router.push(`/${locale}/search`);
  }
  function askCommunity(text: string) {
    saveAskDraft({ title: [...text].slice(0, 160).join('') });
    router.push(`/${locale}/questions/ask`);
  }
}
