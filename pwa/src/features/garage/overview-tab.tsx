'use client';
// W-GAR-01 Overview tab (C-GARAGE-02): the safety banner while a safety-critical issue is open, active issues,
// the next two reminders, key specs (expandable), the shops that worked on this car (Book again opens the profile),
// and the AI maintenance tips (AI-off aware). The OBD "coming soon" placeholder is out of scope (P7).
import type { Vehicle } from '@carpal/api-contracts';
import Link from 'next/link';
import { buttonClass } from '@/components/ds/button';
import { SafetyBanner } from '@/components/ds/banner';
import { Icon } from '@/components/ds/icon';
import { Urgency } from '@/components/ds/urgency';
import { SkeletonList } from '@/components/shell/skeleton';
import { useFormat } from '@/lib/format/client';
import { useLocale, useT } from '@/lib/i18n/client';
import { VehicleAiTips } from './ai';
import { useIssues, useRecords, useReminders } from './hooks';
import { garagePath, isActiveIssue, nextReminders, safetyIssue, urgencyStyle } from './model';
import { useNodeNames } from './names';
import { ReminderWhen } from './reminders-tab';

export function OverviewTab({ vehicle: v, readOnly }: { vehicle: Vehicle; readOnly: boolean }) {
  const t = useT();
  const locale = useLocale();
  const issues = useIssues(v.id);
  const reminders = useReminders(v.id);
  const active = (issues.data?.items ?? []).filter(isActiveIssue);
  const safety = safetyIssue(issues.data?.items ?? []);
  const next = nextReminders(reminders.data?.items ?? []);
  return (
    <div className="pwa-tab-stack">
      {safety ? (
        <SafetyBanner
          title={t('garage.safety.title')}
          text={t('garage.safety.text', { title: safety.title })}
          action={
            <Link href={`/${locale}/help?urgent=1`} className={buttonClass({ variant: 'primary', size: 'sm' })}>
              <span className="cp-btn-label">{t('garage.safety.action')}</span>
            </Link>
          }
        />
      ) : null}

      <section className="pwa-card-section" aria-labelledby="ov-issues">
        <div className="pwa-section-head">
          <h3 id="ov-issues" className="pwa-section-title">
            {t('garage.overview.issues')}
          </h3>
          <Link href={garagePath(locale, v.id, 'issues')} className="pwa-link">
            {t('garage.overview.seeAll')}
          </Link>
        </div>
        {issues.isPending ? (
          <SkeletonList count={1} label={t('garage.loading')} />
        ) : active.length === 0 ? (
          <p className="pwa-text-caption">{t('garage.overview.noIssues')}</p>
        ) : (
          <ul className="pwa-plain-list">
            {active.slice(0, 3).map((i) => (
              <li key={i.id}>
                <Link href={`${garagePath(locale, v.id, 'issues')}?modal=issue&issue=${i.id}`} className="pwa-row-link">
                  <span className="flex-1" dir="auto">
                    {i.title}
                  </span>
                  <Urgency level={urgencyStyle(i.urgency_level)} label={t(`garage.urgency.${i.urgency_level}`)} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="pwa-card-section" aria-labelledby="ov-reminders">
        <div className="pwa-section-head">
          <h3 id="ov-reminders" className="pwa-section-title">
            {t('garage.overview.reminders')}
          </h3>
          <Link href={garagePath(locale, v.id, 'reminders')} className="pwa-link">
            {t('garage.overview.seeAll')}
          </Link>
        </div>
        {reminders.isPending ? (
          <SkeletonList count={1} label={t('garage.loading')} />
        ) : next.length === 0 ? (
          <p className="pwa-text-caption">{t('garage.overview.noReminders')}</p>
        ) : (
          <ul className="pwa-plain-list">
            {next.map((r) => (
              <li key={r.id} className="pwa-row">
                <Icon name="calendar" size={20} />
                <span className="flex-1" dir="auto">
                  {r.title}
                  <span className="pwa-text-caption">
                    {' · '}
                    <ReminderWhen reminder={r} />
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <KeySpecs vehicle={v} />
      <ShopsForThisCar vehicle={v} />
      {!readOnly ? <VehicleAiTips vehicle={v} /> : null}
    </div>
  );
}

function KeySpecs({ vehicle: v }: { vehicle: Vehicle }) {
  const t = useT();
  const f = useFormat();
  const engines = useNodeNames('engine_type');
  const fuels = useNodeNames('fuel_type');
  const rows: [string, string | null | undefined][] = [
    [t('garage.form.engine'), engines.name(v.engine_type_node_id)],
    [t('garage.form.fuel'), fuels.name(v.fuel_type_node_id)],
    [t('garage.form.transmission'), v.transmission ? t(`garage.enum.transmission.${v.transmission}`) : null],
    [t('garage.form.drivetrain'), v.drivetrain ? t(`garage.enum.drivetrain.${v.drivetrain}`) : null],
    [t('garage.form.bodyStyle'), v.body_style ? t(`garage.enum.body.${v.body_style}`) : null],
    [t('garage.form.color'), v.color],
    [t('garage.form.plate'), v.license_plate],
    [t('garage.form.ownedSince'), v.ownership_start_date ? f.calendarDate(v.ownership_start_date) : null],
  ];
  const filled = rows.filter(([, value]) => value);
  return (
    <details className="pwa-card-section pwa-specs">
      <summary className="pwa-section-title">{t('garage.overview.specs')}</summary>
      {filled.length === 0 ? (
        <p className="pwa-text-caption">{t('garage.overview.noSpecs')}</p>
      ) : (
        <dl className="pwa-spec-list">
          {filled.map(([k, value]) => (
            <div key={k}>
              <dt className="pwa-text-caption">{k}</dt>
              <dd dir="auto">
                <bdi>{value}</bdi>
              </dd>
            </div>
          ))}
        </dl>
      )}
    </details>
  );
}

/** "Recent and favourite providers for this car (one-tap Book again)": the shops of its service history. */
function ShopsForThisCar({ vehicle: v }: { vehicle: Vehicle }) {
  const t = useT();
  const locale = useLocale();
  const records = useRecords(v.id);
  const seen = new Map<string, { name: string; slug: string | null; vendor: boolean }>();
  for (const page of records.data?.pages ?? [])
    for (const r of page.items)
      if (r.provider && !seen.has(r.provider.id))
        seen.set(r.provider.id, { name: r.provider.name, slug: r.provider.slug, vendor: r.provider.organization_type === 'vendor' });
  const shops = [...seen.values()].slice(0, 3);
  if (shops.length === 0) return null;
  return (
    <section className="pwa-card-section" aria-labelledby="ov-shops">
      <h3 id="ov-shops" className="pwa-section-title">
        {t('garage.overview.shops')}
      </h3>
      <ul className="pwa-plain-list">
        {shops.map((s) => (
          <li key={s.name} className="pwa-row">
            <Icon name="wrench" size={20} />
            <span className="flex-1" dir="auto">
              <bdi>{s.name}</bdi>
            </span>
            {s.slug ? (
              <Link
                href={`/${locale}/${s.vendor ? 'parts-seller' : 'shop'}/${s.slug}`}
                className={buttonClass({ variant: 'ghost', size: 'sm' })}
              >
                <span className="cp-btn-label">{t('garage.overview.bookAgain')}</span>
              </Link>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
