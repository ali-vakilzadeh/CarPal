'use client';
// W-QA-01 Q&A hub (mirrors C-COMM-03; P8.T3) at /<locale>/questions: search (text stays in the page, never in the
// URL, GD-14), filters — My car (the active vehicle's brand and model; on by default when signed in), brand/model for
// everyone else, category, Unanswered / Answered — kept in the URL as ids (?status&cat&brand&model), and the question
// list (title, car and category, answer count, accepted check, date, excerpt), newest first: questions.search has no
// sort (DI-50). Empty → "No one has asked this yet" + Ask it (the text goes to the ask page). The server renders the
// first page for the URL's filters (indexable); the browser takes over from there.
import type { PublicQuestion } from '@carpal/api-contracts';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { Badge } from '@/components/ds/badge';
import { buttonClass } from '@/components/ds/button';
import { Chip } from '@/components/ds/chip';
import { TextField } from '@/components/ds/text-field';
import { useActiveVehicle, useVehicleLabel } from '@/components/shell/active-vehicle';
import { InfiniteList } from '@/components/shell/infinite-list';
import { StateView } from '@/components/shell/states';
import { VehiclePicker, type VehiclePick } from '@/components/vehicle/vehicle-picker';
import { useApiInfiniteQuery } from '@/lib/api/query';
import { useSession } from '@/lib/api/session';
import { useFlag } from '@/lib/config/client';
import { useTaxonomyNodes } from '@/lib/config/taxonomy';
import { useFormat } from '@/lib/format/client';
import { useLocale, useT } from '@/lib/i18n/client';
import { questionPath } from '@/lib/seo/urls';
import { saveAskDraft } from './ask-draft';
import { excerpt, questionContext } from './model';
import { parseQaFilters, qaFilterQuery, qaSearchBody, type QaFilters } from './qa-filters';

export function QuestionCard({ q, headingLevel = 2 }: { q: PublicQuestion; headingLevel?: 2 | 3 }) {
  const t = useT();
  const f = useFormat();
  const locale = useLocale();
  const H = headingLevel === 2 ? 'h2' : 'h3';
  return (
    <article className="pwa-result pwa-question-card" lang={q.content_locale}>
      <div className="pwa-result-body">
        <H className="pwa-text-label m-0">
          <Link href={questionPath(locale, q)} className="pwa-card-link" dir="auto">
            {q.title}
          </Link>
        </H>
        <span className="pwa-text-caption" dir="auto">
          {questionContext(q).join(' · ')}
        </span>
        <p className="pwa-text-caption m-0" dir="auto">
          {excerpt(q.body, 140)}
        </p>
        <span className="pwa-badges">
          <Badge icon="comment">{t('community.answer.count', { count: q.answer_count })}</Badge>
          {q.accepted_answer_id ? (
            <Badge tone="success" icon="check">
              {t('community.answer.accepted')}
            </Badge>
          ) : null}
          {q.status === 'closed' ? <Badge icon="lock">{t('community.question.status.closed')}</Badge> : null}
          <span className="pwa-text-caption">{f.relative(q.created_at)}</span>
        </span>
      </div>
    </article>
  );
}

export function QaHub({
  initial,
  initialFilters,
}: {
  initial: { items: PublicQuestion[]; next_cursor: string | null } | null;
  initialFilters: QaFilters;
}) {
  const t = useT();
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const enabled = useFlag('qna.enabled');
  const session = useSession();
  const signedIn = session.data?.signed_in === true;
  const active = useActiveVehicle();
  const vehicle = active.active;
  const vehicleLabel = useVehicleLabel(vehicle);
  const filters = useMemo(() => parseQaFilters(search), [search]);
  const [text, setText] = useState('');
  const [typed, setTyped] = useState('');
  const [myCar, setMyCar] = useState<boolean | null>(null);
  const categories = useTaxonomyNodes('service_system', null, enabled);

  // Debounce the text (no request per key stroke).
  useEffect(() => {
    const id = setTimeout(() => setText(typed), 300);
    return () => clearTimeout(id);
  }, [typed]);

  // My car is on by default for signed-in users with a car, unless the URL already names a car.
  const carOn = (myCar ?? (signedIn && !filters.brandId)) && !!vehicle;
  const car = carOn && vehicle ? { brandId: vehicle.brand_node_id, modelId: vehicle.model_node_id } : null;
  const body = qaSearchBody(filters, text, car);
  const useInitial = !!initial && !text.trim() && !car && qaFilterQuery(filters) === qaFilterQuery(initialFilters);
  const list = useApiInfiniteQuery(
    'questions.search',
    { body },
    {
      cursorIn: 'body',
      enabled,
      staleTime: 30_000,
      ...(useInitial && initial ? { initialData: { pages: [initial], pageParams: [null] } } : {}),
    },
  );

  const setFilters = (next: QaFilters) => {
    const qs = qaFilterQuery(next);
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };
  const pick: VehiclePick = { brandId: filters.brandId ?? null, modelId: filters.modelId ?? null, seriesId: null };

  if (!enabled)
    return (
      <div className="py-6">
        <h1 className="pwa-text-title m-0">{t('community.qa.title')}</h1>
        <StateView kind="featureOff" t={t} title={t('community.qa.off')} />
      </div>
    );

  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  const askHref = `/${locale}/questions/ask`;
  return (
    <div className="pwa-qa-hub">
      <header className="pwa-qa-head">
        <h1 className="pwa-text-title m-0">{t('community.qa.title')}</h1>
        <Link href={askHref} className={buttonClass({ variant: 'primary' })}>
          <span className="cp-btn-label">{t('community.qa.ask')}</span>
        </Link>
      </header>
      <TextField
        type="search"
        icon="search"
        label={t('community.qa.search')}
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        maxLength={200}
        enterKeyHint="search"
      />
      <div className="pwa-qa-layout">
        <aside className="pwa-qa-filters" aria-label={t('community.qa.filters')}>
          <div className="pwa-chip-row" role="group" aria-label={t('community.qa.statusLabel')}>
            <Chip selected={!filters.status} onClick={() => setFilters({ ...filters, status: undefined })}>
              {t('community.qa.statusAll')}
            </Chip>
            <Chip selected={filters.status === 'open'} onClick={() => setFilters({ ...filters, status: 'open' })}>
              {t('community.qa.statusOpen')}
            </Chip>
            <Chip selected={filters.status === 'answered'} onClick={() => setFilters({ ...filters, status: 'answered' })}>
              {t('community.qa.statusAnswered')}
            </Chip>
          </div>
          {vehicle ? (
            <Chip icon="car" selected={carOn} onClick={() => setMyCar(!carOn)}>
              {t('community.qa.myCar', { car: vehicleLabel ?? '' })}
            </Chip>
          ) : null}
          {carOn ? null : (
            <VehiclePicker
              value={pick}
              withSeries={false}
              legend="community.qa.carLegend"
              onChange={(v) => setFilters({ ...filters, brandId: v.brandId ?? undefined, modelId: v.modelId ?? undefined })}
            />
          )}
          <div className="cp-field">
            <label className="cp-field-label" htmlFor="qa-category">
              {t('community.qa.category')}
            </label>
            <div className="cp-field-box pwa-select-box">
              <select
                id="qa-category"
                className="cp-field-input pwa-select"
                value={filters.categoryId ?? ''}
                onChange={(e) => setFilters({ ...filters, categoryId: e.target.value || undefined })}
              >
                <option value="">{t('community.qa.anyCategory')}</option>
                {(categories.data ?? []).map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.name.text}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <p className="pwa-text-caption">{t('community.qa.newestFirst')}</p>
        </aside>
        <div className="pwa-qa-list">
          <InfiniteList
            items={items}
            getKey={(q) => q.id}
            renderItem={(q) => <QuestionCard q={q} />}
            status={list.status}
            error={list.error}
            hasNextPage={list.hasNextPage}
            isFetchingNextPage={list.isFetchingNextPage}
            fetchNextPage={() => list.fetchNextPage()}
            refetch={() => list.refetch()}
            label={t('community.qa.listLabel')}
            restoreKey="qa:hub"
            empty={
              <StateView
                kind="empty"
                t={t}
                title={t('community.qa.empty')}
                action={
                  <Link
                    href={askHref}
                    className={buttonClass({ variant: 'primary' })}
                    onClick={() => (typed.trim() ? saveAskDraft({ title: typed.trim() }) : undefined)}
                  >
                    <span className="cp-btn-label">{t('community.qa.askIt')}</span>
                  </Link>
                }
              />
            }
          />
        </div>
      </div>
    </div>
  );
}
