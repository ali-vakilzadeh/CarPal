// AC14-2 DOM tests of the organization additions (backend S19/S22/S23): /orgs filters (city, plan, flags as booleans),
// the four saved views and the flags column; the tabs Capabilities & badges, Portfolio, Inventory (sellers only),
// Members (masked) and the plan history, each under the purpose; the profile correction (only changed fields, website
// check, reason) and the profile history; Merge duplicate (search, preview, blocked, four-eyes request); the assist
// banner from admin.assist_sessions_list; correctionOf and mergeReady; axe in EN and FA.
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrgMergePreview, StaffOrgView } from '@carpal/api-contracts';
import { axeViolations, page, renderConsole, scriptedTransport, searchRow } from '../../../tests/support/console-harness';
import { nav, resetNav } from '../../../tests/support/navigation-mock';
import type { Locale } from '@/lib/i18n/locales';
import { AssistBanner, assistStore } from './assist';
import { mergeReady } from './org-merge';
import { OrgPage } from './org-page';
import { correctionOf } from './org-tabs';
import { OrgsPage } from './orgs-page';

vi.mock('next/navigation', async () => (await import('../../../tests/support/navigation-mock')).navigationMock());

const id = (n: number) => `0193a3c4-5d6e-7f80-9a1b-${String(n).padStart(12, '0')}`;
const ORG = id(21);
const OTHER = id(22);
const V1 = id(61);
const PURPOSE = `verification:${V1}`;
const ago = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
const summary = (o: Partial<{ id: string; name: string; status: string }> = {}) =>
  ({
    id: ORG,
    name: 'Asa Auto',
    organization_type: 'provider',
    slug: 'asa-auto',
    logo_url: null,
    status: 'active',
    verification_status: 'pending',
    ...o,
  }) as never;

function org(o: Partial<StaffOrgView> = {}): StaffOrgView {
  return {
    id: ORG,
    created_at: ago(300),
    updated_at: ago(2),
    version: 3,
    name: 'Asa Auto',
    legal_name: 'Asa Khodro Co.',
    organization_type: 'provider',
    verification_status: 'pending',
    primary_location_id: null,
    contact_email: 'owner@asa-auto.ir',
    contact_phone: '+989121234567',
    website: 'https://asa-auto.ir',
    description_translations: { fa: 'تعمیرگاه' },
    slug: 'asa-auto',
    trust_score: 72,
    status: 'active',
    merged_into_organization_id: null,
    locations: [],
    verifications: [],
    subscription: {
      plan: { plan_key: 'provider_basic' },
      status: 'active',
      started_at: ago(300),
      trial_ends_at: null,
      expires_at: null,
      effective_entitlements: [],
    },
    member_count: 3,
    open_cases: 1,
    ...o,
  } as unknown as StaffOrgView;
}

const preview = (o: Partial<OrgMergePreview> = {}): OrgMergePreview => ({
  organization: summary(),
  into: summary({ id: OTHER, name: 'Asa Auto Tehran' }),
  references: [
    { module: 'trust', reference: 'trust.reviews', rule: 'move', count: 12, conflicts: 0 },
    { module: 'identity', reference: 'identity.memberships', rule: 'retire', count: 3, conflicts: 0 },
  ],
  blocked_by: [],
  ...o,
});

const reason = (dialog: HTMLElement, code: string, note?: string) => {
  fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: code } });
  if (note !== undefined) fireEvent.change(within(dialog).getByLabelText(/^Note/), { target: { value: note } });
};

const tabUrl = (tab?: string) => `/orgs/${ORG}?purpose=${encodeURIComponent(PURPOSE)}${tab ? `&tab=${tab}` : ''}`;

const tabHandlers = (o: Partial<StaffOrgView> = {}) =>
  scriptedTransport({
    'admin.org_get': () => Response.json(org(o)),
    'admin.org_history': () =>
      page([
        {
          id: id(90),
          changed_at: ago(5),
          actor: 'staff',
          actor_display: 'Sara Staff',
          source: 'admin.org_correct',
          reason: 'obvious_error: typo',
          changes: [{ field: 'name', previous: 'Asa Atuo', next: 'Asa Auto', previous_translations: null, next_translations: null }],
        },
      ]),
    'admin.org_capabilities': () =>
      Response.json({
        capabilities: [
          {
            id: id(31),
            created_at: ago(100),
            updated_at: ago(10),
            version: 1,
            service_system_node_id: id(41),
            experience_level: 'specialist',
            public_visibility: true,
            confidence_level: 'strong_evidence',
            confidence_score: '0.82',
            evidence_count: 14,
            badge_eligible: true,
            source: 'job_evidence',
            status: 'active',
          },
        ],
        capabilities_total: 600,
        badges: [
          {
            id: id(32),
            created_at: ago(100),
            updated_at: ago(10),
            version: 1,
            badge_type: 'system_expert',
            scope_taxonomy_node_ids: [],
            rule_key: 'system_expert',
            rule_version: 'v2',
            evaluation_snapshot: { jobs: 14, min_jobs: 10, rating: 4.7 },
            requires_admin_approval: false,
            awarded_at: ago(50),
            last_evaluated_at: ago(2),
            expires_at: null,
            visibility: 'public',
            status: 'active',
            revoked_reason: null,
          },
        ],
      }),
    'admin.org_portfolio': () =>
      page([
        {
          id: id(33),
          created_at: ago(20),
          updated_at: ago(20),
          version: 1,
          title: 'Brake job',
          content_locale: 'en',
          service_system_node_id: id(41),
          visibility: 'public',
          customer_consent_status: 'withdrawn',
          consent_reference_id: null,
          moderation_status: 'approved',
          status: 'published',
          media: [],
          consent: {
            customer_display_name: 'Reza K.',
            consent_type: 'showcase_publishing',
            scope: null,
            granted: false,
            granted_at: ago(30),
            withdrawn_at: ago(1),
            expires_at: null,
          },
          open_cases: 1,
        },
      ]),
    'admin.org_inventory_quality': () =>
      Response.json({
        counts: { draft: 1, active: 40, pending_review: 2, hidden: 1, discontinued: 0, removed: 3 },
        low_quality_active: 4,
        average_data_quality: 71.4,
        confirmed_fitment_items: 22,
        inquiries_90d: 18,
        inquiry_fulfillment_percent: 83.3,
        measured_response_time_minutes: 45,
        catalog_quality_score: 77,
        flagged: [
          {
            id: id(34),
            sku: 'BRK-001',
            name_translations: { en: 'Brake pad' },
            status: 'active',
            visibility: 'public',
            data_quality_score: 30,
            flags: ['low_quality', 'possible_duplicate'],
            updated_at: ago(3),
          },
        ],
        flagged_total: 1,
      }),
    'admin.org_members': () =>
      page([
        {
          membership_id: id(35),
          version: 1,
          user_id: id(36),
          full_name: 'Reza Karimi',
          display_name: null,
          email: 'reza.karimi@example.com',
          role: 'provider_owner',
          status: 'active',
          joined_at: ago(300),
        },
      ]),
    'admin.org_plan_history': () =>
      page([
        {
          id: id(37),
          subscriber: { type: 'organization', id: ORG, display: 'Asa Auto' },
          plan_key: 'provider_pro',
          status: 'active',
          started_at: ago(30),
          trial_ends_at: null,
          expires_at: null,
          overrides: { vehicle_limit: null, user_limit: 8, entitlements: [] },
          assigned_by_display: 'Ali Admin',
          change_request: {
            id: id(38),
            requested_plan_key: 'provider_pro',
            requested_by_display: 'Reza K.',
            note: null,
            created_at: ago(40),
          },
        },
      ]),
    'admin.org_correct': () =>
      Response.json({
        id: id(91),
        changed_at: ago(0),
        actor: 'staff',
        actor_display: 'Sara Staff',
        source: 'admin.org_correct',
        reason: 'x',
        changes: [],
      }),
  });

beforeEach(() => resetNav('/orgs'));
afterEach(() => assistStore.clear());

describe('Organization list filters (AC14-2)', () => {
  it('sends the yes-only filters as booleans and the city; flags in rows; four saved views', async () => {
    resetNav('/orgs?location_issue=true&plan_key=provider_pro&city=Tehran');
    const { transport, calls } = scriptedTransport({
      'admin.orgs_search': () =>
        Response.json({ items: [{ ...searchRow(org()), location_issue: true, possible_duplicate: true }], next_cursor: 'c2' }),
    });
    renderConsole(<OrgsPage />, { transport, roles: ['MOD'] });
    const table = await screen.findByRole('table', { name: 'Organizations' });
    const row = (await within(table).findByText('Asa Auto')).closest('tr')!;
    expect(row).toHaveTextContent('Location issue');
    expect(row).toHaveTextContent('Possible duplicate');
    expect(calls[0]!.body).toEqual({ location_issue: true, plan_key: 'provider_pro', city: 'Tehran', limit: 50 });
    expect(screen.getByTestId('orgs-short-page')).toBeInTheDocument();
    const views = screen.getByRole('navigation', { name: 'Saved views' });
    expect(within(views).getByRole('link', { name: 'Possible duplicates' })).toHaveAttribute('href', '/orgs?possible_duplicate=true');
    expect(within(views).getByRole('link', { name: 'Location issues' })).toHaveAttribute('href', '/orgs?location_issue=true');
    fireEvent.change(screen.getByLabelText('City (optional)'), { target: { value: 'Shiraz' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(nav.search).toContain('city=Shiraz'));
  });
});

describe('Organization tabs (AC14-2)', () => {
  it('Capabilities & badges: the matrix, the cap note and the rule evaluation', async () => {
    resetNav(tabUrl('badges'));
    const { transport, calls } = tabHandlers();
    renderConsole(<OrgPage orgId={ORG} mapStyleUrl={null} />, { transport, roles: ['SUP'] });
    const tab = await screen.findByTestId('caps-tab');
    expect(await within(tab).findByText('Strong evidence')).toBeInTheDocument();
    expect(within(tab).getByTestId('caps-more')).toHaveTextContent('The 1 strongest of 600 capabilities are listed.');
    expect(within(tab).getByText('Completed jobs')).toBeInTheDocument();
    const badges = within(tab).getByRole('table', { name: 'Badges' });
    expect(badges).toHaveTextContent('system_expert v2');
    fireEvent.click(within(badges).getByText('3 inputs'));
    expect(within(badges).getByText('min_jobs')).toBeInTheDocument();
    expect(calls.find((c) => c.opId === 'admin.org_capabilities')!.headers.get('carpal-access-purpose')).toBe(PURPOSE);
  });

  it('Portfolio shows a withdrawn consent; Members masks the email; Plan has the history', async () => {
    resetNav(tabUrl('portfolio'));
    const { transport } = tabHandlers();
    renderConsole(<OrgPage orgId={ORG} mapStyleUrl={null} />, { transport, roles: ['MOD'] });
    const portfolio = await screen.findByTestId('portfolio-tab');
    const row = (await within(portfolio).findByText('Brake job')).closest('tr')!;
    expect(row).toHaveTextContent('Withdrawn');
    expect(row).toHaveTextContent('Reza K.');
    fireEvent.click(screen.getByRole('tab', { name: 'Members' }));
    const members = await screen.findByTestId('members-tab');
    expect(await within(members).findByText('Workshop owner')).toBeInTheDocument();
    expect(members).not.toHaveTextContent('reza.karimi@example.com');
    fireEvent.click(screen.getByRole('tab', { name: 'Plan' }));
    const history = await screen.findByTestId('plan-history');
    expect(await within(history).findByText(/asked by Reza K\./)).toBeInTheDocument();
    expect(history).toHaveTextContent('Ali Admin');
    expect(history).toHaveTextContent('8 users');
  });

  it('Inventory is a tab for sellers only, with the quality figures and flagged items', async () => {
    resetNav(tabUrl('inventory'));
    const { transport } = tabHandlers({ organization_type: 'vendor' });
    renderConsole(<OrgPage orgId={ORG} mapStyleUrl={null} />, { transport, roles: ['ADM'] });
    const tab = await screen.findByTestId('inventory-tab');
    expect(await within(tab).findByTestId('catalog-score')).toHaveTextContent('77');
    expect(within(tab).getByText('Brake pad').closest('tr')!).toHaveTextContent('Low quality');
  });

  it('a provider has no Inventory tab', async () => {
    resetNav(tabUrl('inventory'));
    const { transport } = tabHandlers();
    renderConsole(<OrgPage orgId={ORG} mapStyleUrl={null} />, { transport, roles: ['ADM'] });
    await screen.findByTestId('profile-tab');
    expect(screen.queryByRole('tab', { name: 'Inventory' })).toBeNull();
  });

  it('Profile: a correction sends only the changed fields with a reason; the history lists changes', async () => {
    resetNav(tabUrl());
    const { transport, calls } = tabHandlers();
    renderConsole(<OrgPage orgId={ORG} mapStyleUrl={null} />, { transport, roles: ['MOD'] });
    const history = await screen.findByTestId('profile-history');
    expect(await within(history).findByText(/Asa Atuo → Asa Auto/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Correct the profile' }));
    const form = await screen.findByTestId('profile-correction');
    fireEvent.click(within(form).getByRole('button', { name: 'Save the correction' }));
    expect(within(form).getByText('Nothing was changed.')).toBeInTheDocument();
    fireEvent.change(within(form).getByLabelText('Website'), { target: { value: 'asa-auto.ir' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save the correction' }));
    expect(within(form).getByText('Enter a web address starting with http:// or https://.')).toBeInTheDocument();
    fireEvent.change(within(form).getByLabelText('Website'), { target: { value: 'https://asaauto.ir' } });
    fireEvent.change(within(form).getByLabelText('Legal name'), { target: { value: '' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save the correction' }));
    const dialog = await screen.findByRole('dialog', { name: "Correct this organization's profile" });
    reason(dialog, 'obvious_error');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save the correction' }));
    expect(await screen.findByText('Corrected. The business is told.')).toBeInTheDocument();
    const call = calls.find((c) => c.opId === 'admin.org_correct')!;
    expect(call.path).toBe(`/v1/admin/orgs/${ORG}/correct`);
    expect(call.body).toEqual({ legal_name: null, website: 'https://asaauto.ir', reason: 'obvious_error' });
    expect(call.headers.get('carpal-access-purpose')).toBeNull();
  });
});

describe('Merge duplicate (AC14-2)', () => {
  it('finds the organization that stays (never itself) and previews; a blocking reference stops the merge', async () => {
    resetNav(`/orgs/${ORG}`);
    const { transport, calls } = scriptedTransport({
      'admin.orgs_search': (_req, body) =>
        body?.organization_id ? page([searchRow(org())]) : page([searchRow(org()), searchRow(org({ id: OTHER, name: 'Asa Auto Tehran' }))]),
      'admin.org_merge_preview': () => Response.json(preview({ blocked_by: ['onboarding.assist_sessions'] })),
      'admin.org_merge': () =>
        Response.json(
          {
            change_id: id(99),
            op_id: 'admin.org_merge',
            summary: 'Merge Asa Auto into Asa Auto Tehran',
            requested_by_display: 'Sara Staff',
            requested_at: ago(0),
            reason: 'duplicate: same shop',
            status: 'pending',
            expires_at: ago(-72),
            decided_by_display: null,
            decided_at: null,
            decision_reason: null,
            job_id: null,
          },
          { status: 202 },
        ),
    });
    renderConsole(<OrgPage orgId={ORG} mapStyleUrl={null} />, { transport, roles: ['ADM'] });
    fireEvent.click(await screen.findByRole('button', { name: 'Merge duplicate' }));
    const panel = await screen.findByTestId('merge-panel');
    fireEvent.change(within(panel).getByLabelText('Name of the organization that stays'), { target: { value: 'Asa' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Search' }));
    const hits = await within(panel).findByTestId('merge-hits');
    expect(within(hits).queryByRole('radio', { name: /^Asa Auto ·/ })).toBeNull();
    fireEvent.click(within(hits).getByRole('radio', { name: /Asa Auto Tehran/ }));
    const prev = await within(panel).findByTestId('merge-preview');
    expect(within(prev).getByRole('table', { name: 'What the merge would change' })).toHaveTextContent('trust.reviews');
    expect(within(prev).getByTestId('merge-blocked')).toHaveTextContent('onboarding.assist_sessions');
    expect(within(prev).getByRole('button', { name: 'Send the merge for approval' })).toBeDisabled();
    expect(calls.find((c) => c.opId === 'admin.org_merge_preview')!.search).toBe(`?into_organization_id=${OTHER}`);
  });

  it('a preview without blocks sends org_merge with the reason and shows the four-eyes banner', async () => {
    resetNav(`/orgs/${ORG}`);
    const { transport, calls } = scriptedTransport({
      'admin.orgs_search': () => page([searchRow(org())]),
      'admin.org_merge_preview': () => Response.json(preview()),
      'admin.org_merge': () =>
        Response.json(
          {
            change_id: id(99),
            op_id: 'admin.org_merge',
            summary: 'Merge',
            requested_by_display: 'Sara Staff',
            requested_at: ago(0),
            reason: 'duplicate: same shop',
            status: 'pending',
            expires_at: ago(-72),
            decided_by_display: null,
            decided_at: null,
            decision_reason: null,
            job_id: null,
          },
          { status: 202 },
        ),
    });
    renderConsole(<OrgPage orgId={ORG} mapStyleUrl={null} />, { transport, roles: ['ADM'] });
    fireEvent.click(await screen.findByRole('button', { name: 'Merge duplicate' }));
    const panel = await screen.findByTestId('merge-panel');
    fireEvent.change(within(panel).getByLabelText('Or its ID'), { target: { value: OTHER } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Preview with this ID' }));
    const send = await within(panel).findByRole('button', { name: 'Send the merge for approval' });
    expect(send).toBeEnabled();
    fireEvent.click(send);
    const dialog = await screen.findByRole('dialog', { name: 'Merge this organization' });
    reason(dialog, 'duplicate', 'same shop');
    fireEvent.click(within(dialog).getByLabelText('I understand, and I want to go ahead'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send the merge for approval' }));
    expect(await within(panel).findByText('Waiting for a second staff member')).toBeInTheDocument();
    expect(calls.find((c) => c.opId === 'admin.org_merge')!.body).toEqual({ into_organization_id: OTHER, reason: 'duplicate: same shop' });
  });

  it('is not offered to moderators', async () => {
    resetNav(`/orgs/${ORG}`);
    const { transport } = scriptedTransport({ 'admin.orgs_search': () => page([searchRow(org())]) });
    renderConsole(<OrgPage orgId={ORG} mapStyleUrl={null} />, { transport, roles: ['MOD'] });
    await screen.findByTestId('org-page');
    expect(screen.queryByRole('button', { name: 'Merge duplicate' })).toBeNull();
  });
});

describe('Assist sessions from the server (AC14-2)', () => {
  it('the banner shows the caller’s open sessions after a reload', async () => {
    const { transport, calls } = scriptedTransport({
      'admin.assist_sessions_list': () =>
        page([
          {
            assist_session_id: id(81),
            organization: summary(),
            flow_type: 'provider',
            status: 'active',
            staff_display: 'Sara Staff',
            mine: true,
            started_at: ago(1),
            expires_at: ago(-3),
            ended_at: null,
          },
        ]),
    });
    renderConsole(<AssistBanner />, { transport, roles: ['SUP'] });
    const banner = await screen.findByTestId('assist-banner');
    expect(within(banner).getByRole('link', { name: 'Asa Auto' })).toHaveAttribute('href', `/orgs/${ORG}`);
    expect(calls[0]!.search).toBe('?mine=true&status=active&limit=10');
  });
});

describe('organization rules (AC14-2)', () => {
  it('correctionOf sends only changes and never contact data', () => {
    const o = org();
    const base = {
      name: 'Asa Auto',
      legal_name: 'Asa Khodro Co.',
      website: 'https://asa-auto.ir',
      description_en: '',
      description_fa: 'تعمیرگاه',
    };
    expect(correctionOf(o, base)).toEqual({ problems: ['nothing'] });
    expect(correctionOf(o, { ...base, name: ' ' })).toEqual({ problems: ['name'] });
    expect(correctionOf(o, { ...base, description_en: 'Brakes' })).toEqual({
      body: { description_translations: { en: 'Brakes', fa: 'تعمیرگاه' } },
    });
    expect(correctionOf(o, { ...base, description_fa: '' })).toEqual({ body: { description_translations: null } });
  });
  it('mergeReady needs a preview without blocks into another live organization', () => {
    expect(mergeReady(undefined)).toBe(false);
    expect(mergeReady(preview())).toBe(true);
    expect(mergeReady(preview({ blocked_by: ['x'] }))).toBe(false);
    expect(mergeReady(preview({ into: summary({ id: OTHER, status: 'merged' }) }))).toBe(false);
  });
});

describe('axe (AC14-2 organization screens)', () => {
  for (const locale of ['en', 'fa'] as Locale[]) {
    for (const tab of ['badges', 'portfolio', 'members', 'plan']) {
      it(`no violations on ${tab} (${locale})`, async () => {
        resetNav(tabUrl(tab));
        const { transport } = tabHandlers();
        renderConsole(<OrgPage orgId={ORG} mapStyleUrl={null} />, { transport, roles: ['ADM'], locale });
        await screen.findByRole('tablist');
        await waitFor(() => expect(document.querySelector('[aria-busy="true"]')).toBeNull());
        await new Promise((r) => setTimeout(r, 50));
        expect(await axeViolations()).toEqual([]);
      });
    }
    it(`no violations on the profile with the correction form (${locale})`, async () => {
      resetNav(tabUrl());
      const { transport } = tabHandlers();
      renderConsole(<OrgPage orgId={ORG} mapStyleUrl={null} />, { transport, roles: ['ADM'], locale });
      await screen.findByTestId('profile-history');
      fireEvent.click(
        screen.getAllByRole('button').find((b) => b.textContent === (locale === 'en' ? 'Correct the profile' : 'اصلاح نمایه'))!,
      );
      await screen.findByTestId('profile-correction');
      expect(await axeViolations()).toEqual([]);
    });
  }
});
