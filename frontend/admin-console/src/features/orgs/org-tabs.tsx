'use client';
// The A-ORG-02 tabs on backend S19/S23 reads (AC14-2, BR-16, BR-34), each under the page's work item (PURP; a record
// outside it answers PURPOSE_RECORD_MISMATCH): Capabilities & badges (the matrix strongest first and every badge with
// the rule evaluation that awarded it), Portfolio (showcase items with the customer's consent and moderation status),
// Inventory (vendors: counts, quality, fitment, inquiry fulfillment, the catalog score computed now and flagged items),
// Members (members and pending invitations, emails masked) and the plan history; and on Profile the staff correction of
// name, legal name, website and description (admin.org_correct, with a reason; the organization is notified) with the
// profile's edit history (admin.org_history).
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type {
  Capability,
  OrgCorrection,
  OrgMember,
  OrgProfileChange,
  ProviderBadge,
  StaffFlaggedItem,
  StaffOrgView,
  StaffPlanHistoryItem,
  StaffPortfolioItem,
} from '@carpal/api-contracts';
import {
  ActionNotice,
  DataTable,
  maskEmail,
  maskName,
  ReasonDialog,
  useAdminAction,
  useCursorPaging,
  type Column,
} from '@/components/admin';
import { Badge } from '@/components/ds/badge';
import { Button } from '@/components/ds/button';
import { TextField } from '@/components/ds/text-field';
import { badgeName, badgeStatus, enumLabel } from '@/features/moderation';
import { overridesText } from '@/features/plans';
import { labelOf, useTypeNodes } from '@/features/taxonomy';
import { membershipRole, membershipStatus } from '@/features/users';
import type { AccessPurpose } from '@/lib/api/client';
import { useApiQuery, useSession } from '@/lib/api/query';
import { planLabel } from '@/lib/config/plans';
import { Bidi } from '@/lib/format/bidi';
import { useFormat } from '@/lib/format/client';
import { useLocale, useT } from '@/lib/i18n/client';
import { canCall } from '@/lib/roles';

const PAGE = 50;
const EXPERIENCE = ['beginner', 'intermediate', 'advanced', 'specialist'] as const;
const CONFIDENCE = ['self_declared', 'low_evidence', 'moderate_evidence', 'strong_evidence', 'verified_expert'] as const;
const CAP_SOURCES = ['self_declared', 'ai_suggested', 'job_evidence', 'review_evidence', 'certification', 'admin_verified'] as const;
const CAP_STATUSES = ['pending_provider_approval', 'active', 'rejected', 'inactive'] as const;
const PORTFOLIO_STATUSES = ['draft', 'pending_review', 'published', 'rejected', 'archived'] as const;
const MODERATION = ['pending', 'approved', 'rejected'] as const;
const MEDIA_CONSENT = ['not_required', 'requested', 'granted', 'withdrawn'] as const;
const VISIBILITY = ['public', 'unlisted', 'private'] as const;
const INVENTORY_STATUSES = ['draft', 'active', 'pending_review', 'hidden', 'discontinued', 'removed'] as const;
const INVENTORY_FLAGS = ['open_case', 'pending_review', 'hidden', 'possible_duplicate', 'low_quality'] as const;
const PROFILE_FIELDS = ['name', 'legal_name', 'contact_email', 'contact_phone', 'website', 'description_translations', 'slug'] as const;
const SUB_STATUSES = ['trial', 'active', 'expired', 'cancelled'] as const;

function paged(paging: ReturnType<typeof useCursorPaging>, next: string | null | undefined) {
  return { page: paging.page, hasPrev: paging.page > 1, hasNext: !!next, onPrev: paging.prev, onNext: () => next && paging.next(next) };
}

/** Taxonomy node names for ids (admin.taxonomy_snapshot, ADM and MOD); others read a short id. */
function useNodeNames(): (id: string | null | undefined) => string | null {
  const session = useSession();
  const locale = useLocale();
  const allowed = canCall('admin.taxonomy_snapshot', session.data?.staff?.roles ?? []);
  const brands = useTypeNodes(allowed ? 'vehicle_brand' : null);
  const models = useTypeNodes(allowed ? 'vehicle_model' : null);
  const systems = useTypeNodes(allowed ? 'service_system' : null);
  const tasks = useTypeNodes(allowed ? 'service_task' : null);
  const all = [brands.data, models.data, systems.data, tasks.data].flatMap((d) => d?.items ?? []);
  return (id) => {
    if (!id) return null;
    const n = all.find((x) => x.id === id);
    return n ? labelOf(n, locale) : `#${id.slice(-6)}`;
  };
}

// ---------------------------------------------------------------- Capabilities & badges

export function CapabilitiesTab({ orgId, purpose }: { orgId: string; purpose: AccessPurpose }) {
  const t = useT();
  const f = useFormat();
  const name = useNodeNames();
  const q = useApiQuery('admin.org_capabilities', { path: { org_id: orgId }, purpose }, { retry: false });
  const scope = (c: Capability) =>
    [name(c.brand_node_id), name(c.model_node_id), name(c.series_node_id)].filter(Boolean).join(' ') || t('admin.orgs.caps.anyVehicle');
  const service = (c: Capability) => [name(c.service_system_node_id), name(c.service_task_node_id)].filter(Boolean).join(' › ');
  const caps: Column<Capability>[] = [
    { id: 'service', header: t('admin.orgs.caps.col.service'), pinned: true, cell: (c) => <Bidi>{service(c)}</Bidi> },
    { id: 'vehicle', header: t('admin.orgs.caps.col.vehicle'), cell: (c) => <Bidi>{scope(c)}</Bidi> },
    {
      id: 'confidence',
      header: t('admin.orgs.caps.col.confidence'),
      cell: (c) => enumLabel(CONFIDENCE, 'admin.orgs.caps.confidence', c.confidence_level, t),
    },
    { id: 'score', header: t('admin.orgs.caps.col.score'), align: 'end', cell: (c, ctx) => ctx.digits(c.confidence_score) },
    { id: 'evidence', header: t('admin.orgs.caps.col.evidence'), align: 'end', cell: (c) => f.number(c.evidence_count) },
    { id: 'source', header: t('admin.orgs.caps.col.source'), cell: (c) => enumLabel(CAP_SOURCES, 'admin.orgs.caps.source', c.source, t) },
    {
      id: 'experience',
      header: t('admin.orgs.caps.col.experience'),
      defaultHidden: true,
      cell: (c) => enumLabel(EXPERIENCE, 'admin.orgs.caps.experience', c.experience_level, t),
    },
    { id: 'status', header: t('admin.orgs.caps.col.status'), cell: (c) => enumLabel(CAP_STATUSES, 'admin.orgs.caps.status', c.status, t) },
    {
      id: 'public',
      header: t('admin.orgs.caps.col.public'),
      cell: (c) => (c.public_visibility ? t('admin.users.yes') : t('admin.users.no')),
    },
  ];
  const badges: Column<ProviderBadge>[] = [
    { id: 'badge', header: t('admin.orgs.badges.col.badge'), pinned: true, cell: (b) => badgeName(b.badge_type, t) },
    { id: 'status', header: t('admin.orgs.badges.col.status'), cell: (b) => badgeStatus(b.status, t) },
    { id: 'rule', header: t('admin.orgs.badges.col.rule'), cell: (b) => <Bidi ltr>{`${b.rule_key} ${b.rule_version}`}</Bidi> },
    { id: 'awarded', header: t('admin.orgs.badges.col.awarded'), align: 'end', cell: (b) => f.date(b.awarded_at, 'dateShort') },
    { id: 'evaluated', header: t('admin.orgs.badges.col.evaluated'), align: 'end', cell: (b) => f.date(b.last_evaluated_at, 'dateShort') },
    {
      id: 'evaluation',
      header: t('admin.orgs.badges.col.evaluation'),
      cell: (b) => <Evaluation snapshot={b.evaluation_snapshot} />,
    },
    {
      id: 'revoked',
      header: t('admin.orgs.badges.col.revoked'),
      defaultHidden: true,
      cell: (b) => (b.revoked_reason ? <Bidi>{b.revoked_reason}</Bidi> : '—'),
    },
  ];
  const data = q.data;
  return (
    <section data-testid="caps-tab" className="adm-stack">
      <h3 className="adm-subtitle">{t('admin.orgs.caps.title')}</h3>
      {data && data.capabilities_total > data.capabilities.length ? (
        <p className="adm-muted" data-testid="caps-more">
          {t('admin.orgs.caps.more', { shown: f.number(data.capabilities.length), total: f.number(data.capabilities_total) })}
        </p>
      ) : null}
      <DataTable
        id="org-capabilities"
        caption={t('admin.orgs.caps.title')}
        columns={caps}
        rows={data?.capabilities}
        rowKey={(c) => c.id}
        loading={q.isPending}
        error={q.error}
        onRetry={() => void q.refetch()}
        emptyText={t('admin.orgs.caps.empty')}
        shortcuts={false}
      />
      <h3 className="adm-subtitle">{t('admin.orgs.badges.title')}</h3>
      <DataTable
        id="org-badges"
        caption={t('admin.orgs.badges.title')}
        columns={badges}
        rows={data?.badges}
        rowKey={(b) => b.id}
        loading={q.isPending}
        error={q.error}
        onRetry={() => void q.refetch()}
        emptyText={t('admin.orgs.badges.empty')}
        shortcuts={false}
      />
      <p className="adm-muted">{t('admin.orgs.badges.decide')}</p>
    </section>
  );
}

/** A badge rule's inputs (counts, ratings, thresholds; no personal data), as typed by the rule. */
function Evaluation({ snapshot }: { snapshot: Record<string, unknown> }) {
  const t = useT();
  const entries = Object.entries(snapshot ?? {}).filter(([, v]) => v === null || ['string', 'number', 'boolean'].includes(typeof v));
  if (!entries.length) return <>—</>;
  return (
    <details>
      <summary>{t('admin.orgs.badges.inputs', { n: entries.length })}</summary>
      <dl className="adm-facts adm-facts-tight">
        {entries.map(([k, v]) => (
          <div key={k}>
            <dt>
              <Bidi ltr>{k}</Bidi>
            </dt>
            <dd>
              <Bidi ltr>{String(v)}</Bidi>
            </dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

// ---------------------------------------------------------------- Portfolio

export function PortfolioTab({ orgId, purpose }: { orgId: string; purpose: AccessPurpose }) {
  const t = useT();
  const f = useFormat();
  const paging = useCursorPaging(orgId);
  const q = useApiQuery(
    'admin.org_portfolio',
    { path: { org_id: orgId }, query: { limit: PAGE, ...(paging.cursor ? { cursor: paging.cursor } : {}) }, purpose },
    { retry: false },
  );
  const columns: Column<StaffPortfolioItem>[] = [
    {
      id: 'title',
      header: t('admin.orgs.portfolio.col.title'),
      pinned: true,
      cell: (p) => (
        <span lang={p.content_locale}>
          <Bidi>{p.title}</Bidi>
        </span>
      ),
    },
    {
      id: 'status',
      header: t('admin.orgs.portfolio.col.status'),
      cell: (p) => enumLabel(PORTFOLIO_STATUSES, 'admin.orgs.portfolio.status', p.status, t),
    },
    {
      id: 'moderation',
      header: t('admin.orgs.portfolio.col.moderation'),
      cell: (p) => enumLabel(MODERATION, 'admin.orgs.portfolio.moderation', p.moderation_status, t),
    },
    {
      id: 'consent',
      header: t('admin.orgs.portfolio.col.consent'),
      cell: (p) => (
        <>
          <Badge
            tone={p.customer_consent_status === 'withdrawn' ? 'danger' : p.customer_consent_status === 'granted' ? 'success' : 'neutral'}
          >
            {enumLabel(MEDIA_CONSENT, 'admin.orgs.portfolio.consent', p.customer_consent_status, t)}
          </Badge>
          {p.consent ? (
            <>
              {' '}
              <span className="adm-muted">
                <Bidi>{p.consent.customer_display_name}</Bidi>
                {p.consent.withdrawn_at
                  ? ` · ${t('admin.orgs.portfolio.withdrawnOn', { when: f.date(p.consent.withdrawn_at, 'dateShort') })}`
                  : p.consent.granted_at
                    ? ` · ${t('admin.orgs.portfolio.grantedOn', { when: f.date(p.consent.granted_at, 'dateShort') })}`
                    : ''}
              </span>
            </>
          ) : null}
        </>
      ),
    },
    {
      id: 'visibility',
      header: t('admin.orgs.portfolio.col.visibility'),
      cell: (p) => enumLabel(VISIBILITY, 'admin.orgs.portfolio.visibility', p.visibility, t),
    },
    { id: 'media', header: t('admin.orgs.portfolio.col.media'), align: 'end', cell: (p) => f.number(p.media.length) },
    { id: 'cases', header: t('admin.orgs.portfolio.col.cases'), align: 'end', cell: (p) => f.number(p.open_cases) },
    {
      id: 'job',
      header: t('admin.orgs.portfolio.col.job'),
      align: 'end',
      defaultHidden: true,
      cell: (p) => (p.job_date ? f.date(p.job_date, 'dateShort') : '—'),
    },
    { id: 'added', header: t('admin.orgs.portfolio.col.added'), align: 'end', cell: (p) => f.date(p.created_at, 'dateShort') },
  ];
  return (
    <section data-testid="portfolio-tab" className="adm-stack">
      <p className="adm-muted">{t('admin.orgs.portfolio.note')}</p>
      <DataTable
        id="org-portfolio"
        caption={t('admin.orgs.tab.portfolio')}
        columns={columns}
        rows={q.data?.items}
        rowKey={(p) => p.id}
        loading={q.isPending}
        error={q.error}
        onRetry={() => void q.refetch()}
        emptyText={t('admin.orgs.portfolio.empty')}
        shortcuts={false}
        paging={paged(paging, q.data?.next_cursor)}
      />
    </section>
  );
}

// ---------------------------------------------------------------- Inventory (vendors)

export function InventoryTab({ orgId, purpose }: { orgId: string; purpose: AccessPurpose }) {
  const t = useT();
  const f = useFormat();
  const locale = useLocale();
  const q = useApiQuery('admin.org_inventory_quality', { path: { org_id: orgId }, purpose }, { retry: false });
  const d = q.data;
  const pct = (v: number | null) => (v == null ? '—' : t('admin.orgs.inventory.percent', { n: f.number(Math.round(v)) }));
  const flagged: Column<StaffFlaggedItem>[] = [
    {
      id: 'name',
      header: t('admin.orgs.inventory.col.item'),
      pinned: true,
      cell: (i) => <Bidi>{i.name_translations[locale] ?? i.name_translations.en ?? i.name_translations.fa ?? i.sku}</Bidi>,
    },
    { id: 'sku', header: t('admin.orgs.inventory.col.sku'), cell: (i) => <Bidi ltr>{i.sku}</Bidi> },
    {
      id: 'status',
      header: t('admin.orgs.inventory.col.status'),
      cell: (i) => enumLabel(INVENTORY_STATUSES, 'admin.orgs.inventory.status', i.status, t),
    },
    { id: 'quality', header: t('admin.orgs.inventory.col.quality'), align: 'end', cell: (i) => f.number(i.data_quality_score) },
    {
      id: 'flags',
      header: t('admin.orgs.inventory.col.flags'),
      cell: (i) => (
        <span className="adm-chips">
          {i.flags.map((x) => (
            <span key={x} className="adm-chip" data-tone={x === 'open_case' || x === 'possible_duplicate' ? 'danger' : 'warn'}>
              {enumLabel(INVENTORY_FLAGS, 'admin.orgs.inventory.flag', x, t)}
            </span>
          ))}
        </span>
      ),
    },
    { id: 'changed', header: t('admin.orgs.inventory.col.changed'), align: 'end', cell: (i) => f.date(i.updated_at, 'dateShort') },
  ];
  return (
    <section data-testid="inventory-tab" className="adm-stack">
      {q.isPending ? <p className="adm-muted">{t('admin.kit.table.loading')}</p> : null}
      {q.isError ? <p className="adm-muted">{t('admin.kit.table.failed')}</p> : null}
      {d ? (
        <>
          <dl className="adm-facts" data-testid="inventory-facts">
            {INVENTORY_STATUSES.map((s) => (
              <div key={s}>
                <dt>{t(`admin.orgs.inventory.status.${s}`)}</dt>
                <dd>{f.number(d.counts[s])}</dd>
              </div>
            ))}
            <div>
              <dt>{t('admin.orgs.inventory.lowQuality')}</dt>
              <dd>{f.number(d.low_quality_active)}</dd>
            </div>
            <div>
              <dt>{t('admin.orgs.inventory.averageQuality')}</dt>
              <dd>{d.average_data_quality == null ? '—' : f.number(Math.round(d.average_data_quality))}</dd>
            </div>
            <div>
              <dt>{t('admin.orgs.inventory.fitment')}</dt>
              <dd>{f.number(d.confirmed_fitment_items)}</dd>
            </div>
            <div>
              <dt>{t('admin.orgs.inventory.inquiries')}</dt>
              <dd>{f.number(d.inquiries_90d)}</dd>
            </div>
            <div>
              <dt>{t('admin.orgs.inventory.fulfillment')}</dt>
              <dd>{pct(d.inquiry_fulfillment_percent)}</dd>
            </div>
            <div>
              <dt>{t('admin.orgs.inventory.response')}</dt>
              <dd>
                {d.measured_response_time_minutes == null
                  ? '—'
                  : t('admin.orgs.inventory.minutes', { n: f.number(d.measured_response_time_minutes) })}
              </dd>
            </div>
            <div>
              <dt>{t('admin.orgs.inventory.score')}</dt>
              <dd data-testid="catalog-score">{f.number(d.catalog_quality_score)}</dd>
            </div>
          </dl>
          <h3 className="adm-subtitle">{t('admin.orgs.inventory.flagged')}</h3>
          {d.flagged_total > d.flagged.length ? (
            <p className="adm-muted">
              {t('admin.orgs.inventory.flaggedMore', { shown: f.number(d.flagged.length), total: f.number(d.flagged_total) })}
            </p>
          ) : null}
          <DataTable
            id="org-inventory-flagged"
            caption={t('admin.orgs.inventory.flagged')}
            columns={flagged}
            rows={d.flagged}
            rowKey={(i) => i.id}
            emptyText={t('admin.orgs.inventory.noFlagged')}
            shortcuts={false}
          />
        </>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------- Members

export function MembersTab({ orgId, purpose }: { orgId: string; purpose: AccessPurpose }) {
  const t = useT();
  const f = useFormat();
  const paging = useCursorPaging(orgId);
  const q = useApiQuery(
    'admin.org_members',
    { path: { org_id: orgId }, query: { limit: PAGE, ...(paging.cursor ? { cursor: paging.cursor } : {}) }, purpose },
    { retry: false },
  );
  const columns: Column<OrgMember>[] = [
    {
      id: 'name',
      header: t('admin.orgs.members.col.name'),
      pinned: true,
      cell: (m) => <Bidi>{m.display_name ?? (m.full_name ? maskName(m.full_name) : t('admin.orgs.members.invited'))}</Bidi>,
    },
    { id: 'email', header: t('admin.orgs.members.col.email'), cell: (m) => <Bidi ltr>{maskEmail(m.email)}</Bidi> },
    { id: 'role', header: t('admin.orgs.members.col.role'), cell: (m) => membershipRole(m.role, t) },
    { id: 'status', header: t('admin.orgs.members.col.status'), cell: (m) => membershipStatus(m.status, t) },
    {
      id: 'joined',
      header: t('admin.orgs.members.col.joined'),
      align: 'end',
      cell: (m) => (m.joined_at ? f.date(m.joined_at, 'dateShort') : '—'),
    },
  ];
  return (
    <section data-testid="members-tab" className="adm-stack">
      <p className="adm-muted">{t('admin.orgs.members.note')}</p>
      <DataTable
        id="org-members"
        caption={t('admin.orgs.tab.members')}
        columns={columns}
        rows={q.data?.items}
        rowKey={(m) => m.membership_id}
        loading={q.isPending}
        error={q.error}
        onRetry={() => void q.refetch()}
        emptyText={t('admin.orgs.members.empty')}
        shortcuts={false}
        paging={paged(paging, q.data?.next_cursor)}
      />
    </section>
  );
}

// ---------------------------------------------------------------- Plan history

export function PlanHistory({ orgId, purpose }: { orgId: string; purpose: AccessPurpose }) {
  const t = useT();
  const f = useFormat();
  const paging = useCursorPaging(orgId);
  const q = useApiQuery(
    'admin.org_plan_history',
    { path: { org_id: orgId }, query: { limit: PAGE, ...(paging.cursor ? { cursor: paging.cursor } : {}) }, purpose },
    { retry: false },
  );
  const n = (x: number) => f.number(x);
  const columns: Column<StaffPlanHistoryItem>[] = [
    { id: 'plan', header: t('admin.plans.col.plan'), pinned: true, cell: (h) => planLabel(h.plan_key, t) },
    { id: 'status', header: t('admin.plans.subs.col.status'), cell: (h) => enumLabel(SUB_STATUSES, 'admin.plans.subStatus', h.status, t) },
    { id: 'started', header: t('admin.plans.subs.col.started'), align: 'end', cell: (h) => f.date(h.started_at, 'dateShort') },
    {
      id: 'trial',
      header: t('admin.plans.subs.col.trialEnds'),
      align: 'end',
      cell: (h) => (h.trial_ends_at ? f.date(h.trial_ends_at, 'dateShort') : '—'),
    },
    {
      id: 'ends',
      header: t('admin.plans.subs.col.expires'),
      align: 'end',
      cell: (h) => (h.expires_at ? f.date(h.expires_at, 'dateShort') : '—'),
    },
    { id: 'overrides', header: t('admin.plans.subs.col.overrides'), cell: (h) => overridesText(h.overrides, t, n) },
    {
      id: 'by',
      header: t('admin.plans.subs.col.assignedBy'),
      cell: (h) => (h.assigned_by_display ? <Bidi>{h.assigned_by_display}</Bidi> : t('admin.plans.subs.bySystem')),
    },
    {
      id: 'request',
      header: t('admin.orgs.planHistory.request'),
      cell: (h) =>
        h.change_request
          ? t('admin.orgs.planHistory.requestLine', {
              plan: planLabel(h.change_request.requested_plan_key, t),
              who: h.change_request.requested_by_display,
              when: f.date(h.change_request.created_at, 'dateShort'),
            })
          : '—',
    },
  ];
  return (
    <section data-testid="plan-history" className="adm-stack">
      <h3 className="adm-subtitle">{t('admin.orgs.planHistory.title')}</h3>
      <DataTable
        id="org-plan-history"
        caption={t('admin.orgs.planHistory.title')}
        columns={columns}
        rows={q.data?.items}
        rowKey={(h) => h.id}
        loading={q.isPending}
        error={q.error}
        onRetry={() => void q.refetch()}
        emptyText={t('admin.orgs.planHistory.empty')}
        shortcuts={false}
        paging={paged(paging, q.data?.next_cursor)}
      />
    </section>
  );
}

// ---------------------------------------------------------------- Profile correction and history

interface ProfileDraft {
  name: string;
  legal_name: string;
  website: string;
  description_en: string;
  description_fa: string;
}

const draftOf = (o: StaffOrgView): ProfileDraft => ({
  name: o.name,
  legal_name: o.legal_name ?? '',
  website: o.website ?? '',
  description_en: o.description_translations?.en ?? '',
  description_fa: o.description_translations?.fa ?? '',
});

export const ORG_NAME_MAX = 200;
export const DESCRIPTION_MAX = 2000;

/** The correction as the contract's write (only the changed fields, never contact data or the slug), or its problems. */
export function correctionOf(
  o: StaffOrgView,
  d: ProfileDraft,
): { body: Record<string, unknown> } | { problems: ('name' | 'website' | 'nothing')[] } {
  const was = draftOf(o);
  const problems: ('name' | 'website' | 'nothing')[] = [];
  const name = d.name.trim();
  if (!name || name.length > ORG_NAME_MAX) problems.push('name');
  const website = d.website.trim();
  if (website && !/^https?:\/\/[^\s/$.?#].[^\s]*$/i.test(website)) problems.push('website');
  const body: Record<string, unknown> = {};
  if (name !== was.name) body.name = name;
  if (d.legal_name.trim() !== was.legal_name) body.legal_name = d.legal_name.trim() || null;
  if (website !== was.website) body.website = website || null;
  if (d.description_en.trim() !== was.description_en || d.description_fa.trim() !== was.description_fa) {
    const tr: Record<string, string> = {};
    if (d.description_en.trim()) tr.en = d.description_en.trim();
    if (d.description_fa.trim()) tr.fa = d.description_fa.trim();
    body.description_translations = Object.keys(tr).length ? tr : null;
  }
  if (!problems.length && !Object.keys(body).length) problems.push('nothing');
  return problems.length ? { problems } : { body };
}

export function ProfileCorrection({ org, onChanged }: { org: StaffOrgView; onChanged: () => void }) {
  const t = useT();
  const session = useSession();
  const queryClient = useQueryClient();
  const allowed = canCall('admin.org_correct', session.data?.staff?.roles ?? []);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<ProfileDraft>(() => draftOf(org));
  const [tried, setTried] = useState(false);
  const [dialog, setDialog] = useState(false);
  const action = useAdminAction('admin.org_correct', {
    target: org.id,
    onOutcome: (o) => {
      if (o.kind !== 'applied') return;
      setOpen(false);
      onChanged();
      void queryClient.invalidateQueries({ queryKey: ['admin.org_history'] });
    },
  });
  if (!allowed || org.status === 'merged') return null;
  const result = correctionOf(org, draft);
  const problems = 'problems' in result ? result.problems : [];
  const set = (k: keyof ProfileDraft) => (e: { target: { value: string } }) => setDraft((d) => ({ ...d, [k]: e.target.value }));
  if (!open)
    return (
      <div className="adm-stack">
        <div className="adm-actions">
          <Button
            size="sm"
            variant="secondary"
            icon="edit"
            onClick={() => {
              action.reset();
              setDraft(draftOf(org));
              setTried(false);
              setOpen(true);
            }}
          >
            {t('admin.orgs.correct2.open')}
          </Button>
        </div>
        <ActionNotice state={action.state} applied={t('admin.orgs.correct2.done')} />
      </div>
    );
  return (
    <form
      className="adm-form adm-panel"
      noValidate
      data-testid="profile-correction"
      aria-labelledby="profile-correction-t"
      onSubmit={(e) => {
        e.preventDefault();
        setTried(true);
        if (problems.length) return;
        setDialog(true);
      }}
    >
      <h3 id="profile-correction-t" className="adm-subtitle">
        {t('admin.orgs.correct2.title')}
      </h3>
      <p className="adm-muted">{t('admin.orgs.correct2.text')}</p>
      <TextField
        label={t('admin.orgs.profile.name')}
        error={tried && problems.includes('name') ? t('admin.orgs.correct2.nameInvalid', { n: ORG_NAME_MAX }) : undefined}
        value={draft.name}
        maxLength={ORG_NAME_MAX}
        onChange={set('name')}
      />
      <TextField label={t('admin.orgs.profile.legalName')} value={draft.legal_name} maxLength={ORG_NAME_MAX} onChange={set('legal_name')} />
      <TextField
        label={t('admin.orgs.profile.website')}
        hint={t('admin.orgs.correct2.websiteHint')}
        error={tried && problems.includes('website') ? t('admin.orgs.correct2.websiteInvalid') : undefined}
        value={draft.website}
        dir="ltr"
        maxLength={300}
        onChange={set('website')}
      />
      <TextField
        multiline
        rows={3}
        label={t('admin.orgs.correct2.descriptionEn')}
        value={draft.description_en}
        maxLength={DESCRIPTION_MAX}
        onChange={set('description_en')}
      />
      <TextField
        multiline
        rows={3}
        label={t('admin.orgs.correct2.descriptionFa')}
        value={draft.description_fa}
        maxLength={DESCRIPTION_MAX}
        onChange={set('description_fa')}
      />
      {tried && problems.includes('nothing') ? <p className="cp-field-error">{t('admin.orgs.correct2.nothing')}</p> : null}
      <div className="adm-actions">
        <Button type="submit" variant="primary" loading={action.state.status === 'busy'}>
          {t('admin.orgs.correct2.save')}
        </Button>
        <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
          {t('admin.orgs.correct2.cancel')}
        </Button>
      </div>
      <ActionNotice state={action.state} />
      <ReasonDialog
        open={dialog}
        onClose={() => setDialog(false)}
        kind="profile_correct"
        title={t('admin.orgs.correct2.dialog')}
        confirmLabel={t('admin.orgs.correct2.save')}
        summary={<p className="adm-muted">{t('admin.orgs.correct2.effect')}</p>}
        onSubmit={(reason) => {
          setDialog(false);
          if (!('body' in result)) return;
          void action.run({ path: { org_id: org.id }, body: { ...result.body, reason } as OrgCorrection, reason });
        }}
        name="org-correct"
      />
    </form>
  );
}

export function ProfileHistory({ orgId, purpose }: { orgId: string; purpose: AccessPurpose }) {
  const t = useT();
  const f = useFormat();
  const paging = useCursorPaging(orgId);
  const q = useApiQuery(
    'admin.org_history',
    { path: { org_id: orgId }, query: { limit: PAGE, ...(paging.cursor ? { cursor: paging.cursor } : {}) }, purpose },
    { retry: false },
  );
  const text = (v: string | null) => (v == null || v === '' ? t('admin.orgs.history.empty') : v);
  const translations = (v: Partial<Record<'en' | 'fa', string>> | null) =>
    v
      ? (['en', 'fa'] as const)
          .filter((l) => v[l])
          .map((l) => `${l.toUpperCase()}: ${v[l]}`)
          .join(' / ') || t('admin.orgs.history.empty')
      : t('admin.orgs.history.empty');
  const columns: Column<OrgProfileChange>[] = [
    { id: 'when', header: t('admin.orgs.history.col.when'), pinned: true, cell: (c) => f.date(c.changed_at, 'dateTime') },
    {
      id: 'who',
      header: t('admin.orgs.history.col.who'),
      cell: (c) => (
        <>
          <Bidi>{c.actor_display}</Bidi> <span className="adm-muted">({t(`admin.orgs.history.actor.${c.actor}`)})</span>
        </>
      ),
    },
    {
      id: 'changes',
      header: t('admin.orgs.history.col.changes'),
      cell: (c) => (
        <ul className="adm-change-list">
          {c.changes.map((x) => (
            <li key={x.field}>
              {enumLabel(PROFILE_FIELDS, 'admin.orgs.history.field', x.field, t)}:{' '}
              <Bidi>
                {x.field === 'description_translations'
                  ? `${translations(x.previous_translations)} → ${translations(x.next_translations)}`
                  : `${text(x.previous)} → ${text(x.next)}`}
              </Bidi>
            </li>
          ))}
        </ul>
      ),
    },
    { id: 'reason', header: t('admin.orgs.history.col.reason'), cell: (c) => (c.reason ? <Bidi>{c.reason}</Bidi> : '—') },
  ];
  return (
    <section data-testid="profile-history" className="adm-stack">
      <h3 className="adm-subtitle">{t('admin.orgs.history.title')}</h3>
      <DataTable
        id="org-profile-history"
        caption={t('admin.orgs.history.title')}
        columns={columns}
        rows={q.data?.items}
        rowKey={(c) => c.id}
        loading={q.isPending}
        error={q.error}
        onRetry={() => void q.refetch()}
        emptyText={t('admin.orgs.history.none')}
        shortcuts={false}
        paging={paged(paging, q.data?.next_cursor)}
      />
    </section>
  );
}
