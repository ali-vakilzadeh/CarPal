'use client';
// Organization detail (AC9.T2/T3/T5, Docs/23 A-ORG-02, Docs/40 admin.org_get). The organization is read for a work item
// (SEC-ADM-5): the backend accepts a purpose only while its item is open — a pending verification of the organization
// or an open moderation case (assigned to nobody or to the caller) — so the page takes ?purpose= from the queue it was
// opened from. Without one (or once the item is closed) the header comes from the organization search, which needs no
// purpose and carries no contact data or points (StaffOrgSearchRow, backend S14), and the page lists the organization's pending verifications to open it
// for. Header: name, type, status chips (organization, verification), plan, city, View public profile, and by role
// Suspend / Reactivate, Assist onboarding, Change plan (a link to the AC6 form), Merge duplicate (ADM, AC14-2) and the
// Audit trail (ADM). Tabs (?tab=): Profile (with the staff correction and the edit history, AC14-2), Locations (map,
// correction), Verification (history, the badge approval), and on the backend S23 reads (AC14-2, org-tabs.tsx)
// Capabilities & badges, Portfolio, Inventory (sellers only), Members and Plan (with its history); Reviews and Cases
// have no read yet and are listed.
import Link from 'next/link';
import type { StaffOrgView } from '@carpal/api-contracts';
import { AuditDrawer, MaskedField, purposeKind, Tabs, usePurpose, useUrlTab, withPurpose } from '@/components/admin';
import { Banner } from '@/components/ds/banner';
import { Icon } from '@/components/ds/icon';
import { useApiQuery, useSession } from '@/lib/api/query';
import { planLabel } from '@/lib/config/plans';
import { Bidi } from '@/lib/format/bidi';
import { useFormat } from '@/lib/format/client';
import { useLocale, useT } from '@/lib/i18n/client';
import { canCall } from '@/lib/roles';
import { BadgePanel } from '../moderation/badge-panel';
import { LocationsTab } from './locations-tab';
import { AssistStart, StatusActions } from './org-actions';
import { MergePanel } from './org-merge';
import { CapabilitiesTab, InventoryTab, MembersTab, PlanHistory, PortfolioTab, ProfileCorrection, ProfileHistory } from './org-tabs';
import {
  CHECK_STATUSES,
  CHECK_TYPES,
  label,
  MISSING_TABS,
  ORG_TYPES,
  orgTabsFor,
  headOf,
  orgHref,
  publicProfileHref,
  VERIFICATION_STATUSES,
  verificationPurposes,
  type OrgHead,
} from './org-logic';
import { OrgStatusChips } from './orgs-page';

export interface OrgPageProps {
  orgId: string;
  publicWeb?: string;
  mapStyleUrl: string | null;
}

export function OrgPage({ orgId, publicWeb, mapStyleUrl }: OrgPageProps) {
  const t = useT();
  const purpose = usePurpose();
  const detail = useApiQuery('admin.org_get', purpose ? { path: { org_id: orgId }, purpose } : undefined, {
    enabled: !!purpose,
    retry: false,
  });
  const needSummary = !purpose || detail.isError;
  const summary = useApiQuery('admin.orgs_search', { body: { organization_id: orgId, limit: 1 } }, { enabled: needSummary });
  const org = detail.data ?? null;
  const head: OrgHead | null = org ? headOf(org) : (summary.data?.items[0] ?? null);

  const refresh = () => {
    if (purpose) void detail.refetch();
    void summary.refetch();
  };

  if (!head) {
    if (summary.isPending && needSummary) return <p className="adm-muted">{t('admin.kit.table.loading')}</p>;
    if (detail.isPending && !needSummary) return <p className="adm-muted">{t('admin.kit.table.loading')}</p>;
    return (
      <div className="adm-page" data-testid="org-not-found">
        <h1 className="adm-page-title">{t('admin.orgs.notFound.title')}</h1>
        <p>{t('admin.orgs.notFound.text')}</p>
        <Link href="/orgs">{t('admin.orgs.back')}</Link>
      </div>
    );
  }

  return (
    <div className="adm-page" data-testid="org-page" data-org={orgId}>
      <OrgHeader org={head} publicWeb={publicWeb} onChanged={refresh} />
      {org && purpose ? (
        <OrgTabs
          org={org}
          purpose={purpose}
          mapStyleUrl={mapStyleUrl}
          onChanged={refresh}
          reload={async () => (await detail.refetch()).data ?? null}
        />
      ) : (
        <ChooseWorkItem org={head} closed={!!purpose && detail.isError} />
      )}
    </div>
  );
}

function OrgHeader({ org, publicWeb, onChanged }: { org: OrgHead; publicWeb?: string; onChanged: () => void }) {
  const t = useT();
  const locale = useLocale();
  const session = useSession();
  const roles = session.data?.staff?.roles ?? [];
  const href = publicProfileHref(org, publicWeb, locale);
  const city = org.city;
  return (
    <header className="adm-org-head">
      <p className="adm-muted">
        <Link href="/orgs">{t('admin.orgs.back')}</Link>
      </p>
      <h1 className="adm-page-title">
        <Bidi>{org.name}</Bidi>
      </h1>
      <p className="adm-org-meta">
        <span>{label(ORG_TYPES, 'admin.orgs.type', org.organization_type, t)}</span>
        <OrgStatusChips org={org} />
        {org.plan_key ? <span>{t('admin.orgs.planIs', { plan: planLabel(org.plan_key, t) })}</span> : null}
        {city ? (
          <span>
            <Icon name="pin" size={16} /> <Bidi>{city}</Bidi>
          </span>
        ) : null}
        {href ? (
          <a href={href} target="_blank" rel="noopener noreferrer" data-testid="public-profile">
            {t('admin.orgs.publicProfile')}
          </a>
        ) : null}
      </p>
      {org.merged_into_organization_id ? (
        <Banner tone="info" text={t('admin.orgs.merged')}>
          <p className="pwa-banner-text">
            <Link href={`/orgs/${org.merged_into_organization_id}`}>{t('admin.orgs.mergedLink')}</Link>
          </p>
        </Banner>
      ) : null}
      <div className="adm-actions adm-org-actions">
        <StatusActions org={org} onChanged={onChanged} />
        <AssistStart org={org} />
        {canCall('admin.subscription_assign', roles) ? (
          <Link className="cp-btn cp-btn-ghost cp-btn-sm" href={`/plans?subscriber=organization:${org.id}#assign`}>
            {t('admin.orgs.changePlan')}
          </Link>
        ) : null}
        <AuditDrawer entityType="organization" entityId={org.id} label={org.name} />
      </div>
      <MergePanel org={org} />
    </header>
  );
}

/** No purpose (or a closed one): the organization's pending verifications to open it for, and the queues. */
function ChooseWorkItem({ org, closed }: { org: OrgHead; closed: boolean }) {
  const t = useT();
  const f = useFormat();
  const items = verificationPurposes(org);
  return (
    <section className="adm-purpose" data-testid="org-choose-item" aria-labelledby="org-choose-t">
      <Banner
        tone="info"
        icon="lock"
        title={closed ? t('admin.orgs.purpose.closed') : t('admin.kit.purpose.title')}
        text={t('admin.orgs.purpose.text')}
      />
      <h2 id="org-choose-t" className="adm-section-title">
        {t('admin.orgs.purpose.items')}
      </h2>
      {items.length ? (
        <ul className="adm-tiles">
          {items.map((i) => (
            <li key={i.purpose}>
              <Link className="adm-tile" href={orgHref(org.id, i.purpose)}>
                <Icon name="shield" size={20} />
                <span>
                  {t('admin.orgs.purpose.verification', {
                    type: label(CHECK_TYPES, 'admin.orgs.check', i.type, t),
                    when: f.date(i.at, 'dateShort'),
                  })}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p>{t('admin.orgs.purpose.none', { cases: f.number(org.open_cases) })}</p>
      )}
      <p className="adm-muted">
        <Link href="/content?tab=accounts">{t('admin.orgs.purpose.cases')}</Link>
      </p>
    </section>
  );
}

function OrgTabs({
  org,
  purpose,
  mapStyleUrl,
  onChanged,
  reload,
}: {
  org: StaffOrgView;
  purpose: NonNullable<ReturnType<typeof usePurpose>>;
  mapStyleUrl: string | null;
  onChanged: () => void;
  /** The purpose-bound re-read (Reveal: logged by the backend as a pii.read). */
  reload: () => Promise<StaffOrgView | null>;
}) {
  const t = useT();
  const tabs = orgTabsFor(org.organization_type);
  const [tab, go] = useUrlTab(tabs);
  // The region's pin-versus-address threshold (admin.region_settings, backend S13, BR-18; D-58 lifted in AC10.T0).
  // The map style stays the console's env setting (blank fallback when unset): the console shows no Neshan basemap
  // (OQ-16 answer (c), AC14b.T6); the region's web map apps open a pin on the real map instead.
  const region = useApiQuery('admin.region_settings', {}, { staleTime: 10 * 60_000 });
  return (
    <>
      <p className="adm-muted" data-testid="org-purpose">
        {t('admin.orgs.purpose.readFor', { kind: t(`admin.orgs.purpose.kind.${purposeKind(purpose)}`) })}
      </p>
      <Tabs
        tabs={tabs}
        current={tab}
        onChange={go}
        label={t('admin.orgs.tabsLabel')}
        idPrefix="org"
        tabLabel={(x) => t(`admin.orgs.tab.${x}`)}
      >
        {tab === 'profile' ? <ProfileTab org={org} purpose={purpose} reload={reload} onChanged={onChanged} /> : null}
        {tab === 'locations' ? (
          <LocationsTab
            org={org}
            mapStyleUrl={mapStyleUrl}
            thresholdM={region.data?.location_check_threshold_m}
            mapApps={region.data?.region.navigation_apps}
            onCorrected={onChanged}
          />
        ) : null}
        {tab === 'verification' ? <VerificationTab org={org} /> : null}
        {tab === 'badges' ? <CapabilitiesTab orgId={org.id} purpose={purpose} /> : null}
        {tab === 'portfolio' ? <PortfolioTab orgId={org.id} purpose={purpose} /> : null}
        {tab === 'inventory' ? <InventoryTab orgId={org.id} purpose={purpose} /> : null}
        {tab === 'members' ? <MembersTab orgId={org.id} purpose={purpose} /> : null}
        {tab === 'plan' ? <PlanTab org={org} purpose={purpose} /> : null}
      </Tabs>
      <section className="adm-missing" aria-labelledby="org-missing-t">
        <h2 id="org-missing-t" className="adm-subtitle">
          {t('admin.orgs.missing.title')}
        </h2>
        <ul className="adm-inline-list">
          {MISSING_TABS.map((x) => (
            <li key={x}>{t(`admin.orgs.missing.tab.${x}`)}</li>
          ))}
        </ul>
        <p className="adm-muted">{t('admin.orgs.missing.text')}</p>
      </section>
    </>
  );
}

function ProfileTab({
  org,
  purpose,
  reload,
  onChanged,
}: {
  org: StaffOrgView;
  purpose: NonNullable<ReturnType<typeof usePurpose>>;
  reload: () => Promise<StaffOrgView | null>;
  onChanged: () => void;
}) {
  const t = useT();
  const f = useFormat();
  const desc = org.description_translations ?? {};
  return (
    <section aria-label={t('admin.orgs.tab.profile')} data-testid="profile-tab">
      <dl className="adm-facts">
        <div>
          <dt>{t('admin.orgs.profile.name')}</dt>
          <dd>
            <Bidi>{org.name}</Bidi>
          </dd>
        </div>
        <div>
          <dt>{t('admin.orgs.profile.legalName')}</dt>
          <dd>{org.legal_name ? <Bidi>{org.legal_name}</Bidi> : '—'}</dd>
        </div>
        <div>
          <dt>{t('admin.orgs.profile.slug')}</dt>
          <dd>{org.slug ? <Bidi ltr>{org.slug}</Bidi> : '—'}</dd>
        </div>
        <div>
          <dt>{t('admin.orgs.profile.id')}</dt>
          <dd>
            <Bidi ltr>{org.id}</Bidi>
          </dd>
        </div>
        <MaskedField
          label={t('admin.orgs.profile.email')}
          kind="email"
          value={org.contact_email}
          onReveal={async () => (await reload())?.contact_email ?? null}
        />
        <MaskedField
          label={t('admin.orgs.profile.phone')}
          kind="phone"
          value={org.contact_phone}
          onReveal={async () => (await reload())?.contact_phone ?? null}
        />
        <div>
          <dt>{t('admin.orgs.profile.website')}</dt>
          <dd>{org.website ? <Bidi ltr>{org.website}</Bidi> : '—'}</dd>
        </div>
        <div>
          <dt>{t('admin.orgs.profile.trust')}</dt>
          <dd>{org.trust_score == null ? '—' : f.number(org.trust_score)}</dd>
        </div>
        <div>
          <dt>{t('admin.orgs.profile.members')}</dt>
          <dd>{f.number(org.member_count)}</dd>
        </div>
        <div>
          <dt>{t('admin.orgs.profile.cases')}</dt>
          <dd>{f.number(org.open_cases)}</dd>
        </div>
        <div>
          <dt>{t('admin.orgs.profile.created')}</dt>
          <dd>{f.date(org.created_at, 'dateShort')}</dd>
        </div>
        <div>
          <dt>{t('admin.orgs.profile.updated')}</dt>
          <dd>{f.date(org.updated_at, 'dateTime')}</dd>
        </div>
      </dl>
      {desc.fa || desc.en ? (
        <>
          <h3 className="adm-subtitle">{t('admin.orgs.profile.description')}</h3>
          {(['fa', 'en'] as const).map((l) =>
            desc[l] ? (
              <blockquote key={l} className="adm-quote" lang={l} dir={l === 'fa' ? 'rtl' : 'ltr'}>
                <p>{desc[l]}</p>
              </blockquote>
            ) : null,
          )}
        </>
      ) : null}
      <p className="adm-muted">{t('admin.orgs.profile.correctable')}</p>
      <ProfileCorrection org={org} onChanged={onChanged} />
      <ProfileHistory orgId={org.id} purpose={purpose} />
    </section>
  );
}

function VerificationTab({ org }: { org: StaffOrgView }) {
  const t = useT();
  const f = useFormat();
  const list = [...org.verifications].sort((a, b) => b.created_at.localeCompare(a.created_at));
  return (
    <section aria-label={t('admin.orgs.tab.verification')} data-testid="verification-tab" className="adm-stack">
      <p>
        {t('admin.orgs.verificationNow', { status: label(VERIFICATION_STATUSES, 'admin.orgs.verification', org.verification_status, t) })}
      </p>
      <p className="adm-muted">{t('admin.orgs.verificationRule')}</p>
      {list.length ? (
        <table className="adm-simple-table">
          <caption className="sr-only">{t('admin.orgs.checks.caption')}</caption>
          <thead>
            <tr>
              <th scope="col">{t('admin.orgs.checks.type')}</th>
              <th scope="col">{t('admin.orgs.checks.status')}</th>
              <th scope="col">{t('admin.orgs.checks.submitted')}</th>
              <th scope="col">{t('admin.orgs.checks.reviewed')}</th>
              <th scope="col">{t('admin.orgs.checks.documents')}</th>
              <th scope="col">{t('admin.orgs.checks.note')}</th>
            </tr>
          </thead>
          <tbody>
            {list.map((v) => (
              <tr key={v.id} data-testid="check-row">
                <td>{label(CHECK_TYPES, 'admin.orgs.check', v.verification_type, t)}</td>
                <td>
                  {v.status === 'pending' ? (
                    <Link href={withPurpose(`/verification?verification=${v.id}`, `verification:${v.id}`)}>
                      {t('admin.orgs.checks.review')}
                    </Link>
                  ) : (
                    label(CHECK_STATUSES, 'admin.orgs.checkStatus', v.status, t)
                  )}
                </td>
                <td>{f.date(v.created_at, 'dateShort')}</td>
                <td>{v.reviewed_at ? f.date(v.reviewed_at, 'dateShort') : '—'}</td>
                <td>{f.number(v.submitted_document_ids.length)}</td>
                <td>
                  {v.rejection_reason ? (
                    <Bidi>{v.rejection_reason}</Bidi>
                  ) : v.expires_at ? (
                    t('admin.orgs.checks.expires', { when: f.date(v.expires_at, 'dateShort') })
                  ) : (
                    '—'
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p>{t('admin.orgs.checks.none')}</p>
      )}
      <BadgePanel orgId={org.id} />
    </section>
  );
}

function PlanTab({ org, purpose }: { org: StaffOrgView; purpose: NonNullable<ReturnType<typeof usePurpose>> }) {
  const t = useT();
  const f = useFormat();
  const session = useSession();
  const s = org.subscription;
  return (
    <section aria-label={t('admin.orgs.tab.plan')} data-testid="plan-tab">
      <dl className="adm-facts">
        <div>
          <dt>{t('admin.orgs.plan.plan')}</dt>
          <dd>{planLabel(s.plan.plan_key, t)}</dd>
        </div>
        <div>
          <dt>{t('admin.orgs.plan.status')}</dt>
          <dd>{label(['trial', 'active', 'expired', 'cancelled'], 'admin.orgs.plan.state', s.status, t)}</dd>
        </div>
        <div>
          <dt>{t('admin.orgs.plan.trialEnds')}</dt>
          <dd>{s.trial_ends_at ? f.date(s.trial_ends_at, 'dateShort') : '—'}</dd>
        </div>
        <div>
          <dt>{t('admin.orgs.plan.started')}</dt>
          <dd>{f.date(s.started_at, 'dateShort')}</dd>
        </div>
        <div>
          <dt>{t('admin.orgs.plan.expires')}</dt>
          <dd>{s.expires_at ? f.date(s.expires_at, 'dateShort') : '—'}</dd>
        </div>
        <div>
          <dt>{t('admin.orgs.plan.entitlements')}</dt>
          <dd>{f.number(s.effective_entitlements.length)}</dd>
        </div>
      </dl>
      {canCall('admin.subscription_assign', session.data?.staff?.roles ?? []) ? (
        <p>
          <Link href={`/plans?subscriber=organization:${org.id}#assign`}>{t('admin.orgs.changePlan')}</Link>
        </p>
      ) : null}
      <PlanHistory orgId={org.id} purpose={purpose} />
    </section>
  );
}
