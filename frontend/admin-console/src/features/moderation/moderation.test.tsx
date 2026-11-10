// AC8.T1-T5 DOM tests of moderation: the reports inbox (safety first, triage into a new case with the severity floor,
// into the open case about the same target, dismiss; support staff without the case tabs), the content queue (every
// type read at once, safety first, one type paged on the server), a case read for its purpose, "Take this case", an
// action with a reason, the showcase consent rule, a suspension that asks for the security key, a trust penalty with
// its second confirmation, badges (approve, revoke), the media viewer, inventory corrections; axe in EN and FA.
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModerationCase, StaffReport } from '@carpal/api-contracts';
import { axeViolations, page, problem, renderConsole, scriptedTransport } from '../../../tests/support/console-harness';
import { nav, resetNav } from '../../../tests/support/navigation-mock';
import type { TransportRequest } from '@/lib/api/client';
import type { Locale } from '@/lib/i18n/locales';
import { ContentPage, InventoryPage } from './moderation-pages';

vi.mock('next/navigation', async () => (await import('../../../tests/support/navigation-mock')).navigationMock());

const id = (n: number) => `0193a3c4-5d6e-7f80-9a1b-${String(n).padStart(12, '0')}`;
const C1 = id(1);
const C2 = id(2);
const P1 = id(11);
const ORG = id(21);
const BADGE = id(31);
const R1 = id(41);
const R2 = id(42);
const ago = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

function kase(o: Partial<ModerationCase> = {}): ModerationCase {
  return {
    id: C1,
    created_at: ago(2),
    updated_at: ago(2),
    version: 1,
    case_type: 'post',
    target: { type: 'post', id: P1 },
    source: 'user_report',
    reason: 'spam',
    severity: 'medium',
    ai_risk_score: null,
    ai_flag_insight_id: null,
    status: 'open',
    assigned_to_display: null,
    resolution: null,
    resolved_at: null,
    report_count: 2,
    ...o,
  } as ModerationCase;
}

function report(o: Partial<StaffReport> = {}): StaffReport {
  return {
    id: R1,
    reporter_display: 'Ali R.',
    target: { type: 'post', id: P1 },
    reason: 'spam',
    details: 'Link to a shady parts site',
    status: 'open',
    moderation_case_id: null,
    created_at: ago(3),
    ...o,
  } as StaffReport;
}

const postSnapshot = (o: Record<string, unknown> = {}) => ({
  type: 'post',
  id: P1,
  title: 'Winter tyres 20% off',
  body: 'Call us now, link in bio',
  post_type: 'special_offer',
  status: 'published',
  moderation_status: 'approved',
  created_at: ago(30),
  ...o,
});

const caseType = (req: TransportRequest) => new URLSearchParams(req.search).get('case_type');
const reason = async (dialog: HTMLElement, code: string, note?: string) => {
  fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: code } });
  if (note !== undefined)
    fireEvent.change(within(dialog).getByLabelText(/^Note/), {
      target: { value: note },
    });
};
const action = (action_type: string) =>
  Response.json(
    {
      id: 'act-1',
      moderation_case_id: C1,
      action_type,
      target: { type: 'post', id: P1 },
      reason: 'x',
      actor_display: 'Mo D.',
      created_at: ago(0),
    },
    { status: 201 },
  );

beforeEach(() => resetNav('/content'));
afterEach(() => vi.unstubAllGlobals());

describe('Reports inbox (AC8.T1)', () => {
  it('lists open reports, safety first, and opens a case at least high for unsafe advice', async () => {
    let triaged = false;
    const { transport, calls } = scriptedTransport({
      'admin.reports_list': () =>
        page(
          triaged
            ? []
            : [
                report(),
                report({ id: R2, reason: 'unsafe_advice', details: 'Says to skip the brake fluid', target: { type: 'answer', id: P1 } }),
              ],
        ),
      'admin.cases_list': () => page([]),
      'admin.report_triage': () => {
        triaged = true;
        return Response.json(
          report({ id: R2, reason: 'unsafe_advice', status: 'triaged', moderation_case_id: C2, target: { type: 'answer', id: P1 } }),
        );
      },
    });
    renderConsole(<ContentPage />, { transport, roles: ['MOD'] });
    const table = await screen.findByRole('table', { name: 'User reports' });
    await within(table).findByRole('button', { name: 'Spam' });
    expect(calls[0]!.search).toBe('?status=open&limit=50');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(within(rows[0]!).getByRole('button', { name: 'Unsafe advice' })).toBeInTheDocument();
    fireEvent.click(within(rows[0]!).getByRole('button', { name: 'Unsafe advice' }));
    expect(nav.search).toContain(`report=${R2}`);
    const item = await screen.findByTestId('report-item');
    expect(within(item).getByText('Says to skip the brake fluid')).toBeInTheDocument();
    const severity = screen.getByLabelText('Severity') as HTMLSelectElement;
    expect([...severity.options].map((o) => o.value)).toEqual(['high', 'critical']);
    expect(screen.getByText(/at least high/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open a case' }));
    const dialog = await screen.findByRole('dialog', { name: 'Open a case for this report' });
    await reason(dialog, 'safety_risk');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Open a case' }));
    expect(await screen.findByText('The report is in a case now.')).toBeInTheDocument();
    const call = calls.find((c) => c.opId === 'admin.report_triage')!;
    expect(call.path).toBe(`/v1/admin/reports/${R2}/triage`);
    expect(call.body).toEqual({ open_case: { severity: 'high' }, reason: 'safety_risk' });
    expect(screen.getByRole('link', { name: 'Open its case' })).toHaveAttribute(
      'href',
      `/content?tab=content&case=${C2}&purpose=${encodeURIComponent(`case:${C2}`)}`,
    );
  });

  it('adds a report to the open case about the same target', async () => {
    resetNav(`/content?report=${R1}`);
    const { transport, calls } = scriptedTransport({
      'admin.reports_list': () => page([report()]),
      'admin.cases_list': () => page([kase({ id: C2, status: 'investigating' }), kase({ id: C1, target: { type: 'post', id: id(99) } })]),
      'admin.report_triage': () => Response.json(report({ status: 'triaged', moderation_case_id: C2 })),
    });
    renderConsole(<ContentPage />, { transport, roles: ['MOD'] });
    const panel = await screen.findByTestId('same-target-case');
    expect(calls.find((c) => c.opId === 'admin.cases_list')!.search).toBe('?case_type=post&limit=100');
    fireEvent.click(within(panel).getByRole('button', { name: 'Add to that case' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add this report to the open case' });
    await reason(dialog, 'repeat_reports');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add to that case' }));
    await waitFor(() => expect(calls.find((c) => c.opId === 'admin.report_triage')).toBeTruthy());
    expect(calls.find((c) => c.opId === 'admin.report_triage')!.body).toEqual({ moderation_case_id: C2, reason: 'repeat_reports' });
  });

  it('support staff triage reports but see no case queues; dismissing needs a reason', async () => {
    resetNav(`/content?report=${R1}`);
    const { transport, calls } = scriptedTransport({
      'admin.reports_list': () => page([report()]),
      'admin.report_triage': () => Response.json(report({ status: 'dismissed' })),
    });
    renderConsole(<ContentPage />, { transport, roles: ['SUP'] });
    await screen.findByTestId('triage');
    expect(screen.queryByRole('link', { name: 'Content' })).toBeNull();
    expect(screen.queryByTestId('same-target-case')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss the report' }));
    const dialog = await screen.findByRole('dialog', { name: 'Dismiss this report' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Dismiss the report' }));
    expect(within(dialog).getByText('Choose a reason.')).toBeInTheDocument();
    await reason(dialog, 'not_a_violation');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Dismiss the report' }));
    expect(await screen.findByText('The report is dismissed.')).toBeInTheDocument();
    expect(calls.find((c) => c.opId === 'admin.report_triage')!.body).toEqual({ dismiss: true, reason: 'not_a_violation' });
    expect(calls.some((c) => c.opId === 'admin.cases_list')).toBe(false);
  });
});

describe('Content cases (AC8.T2-T4)', () => {
  it('reads every content type at once and puts safety cases first', async () => {
    resetNav('/content?tab=content');
    const cases = [
      kase({ id: C1 }),
      kase({ id: C2, case_type: 'comment', target: { type: 'comment', id: P1 }, reason: 'privacy', severity: 'high' }),
    ];
    const { transport, calls } = scriptedTransport({
      'admin.cases_list': (req) => page(cases.filter((c) => c.case_type === caseType(req))),
    });
    renderConsole(<ContentPage />, { transport, roles: ['MOD'] });
    const table = await screen.findByRole('table', { name: 'Content cases' });
    await within(table).findByRole('button', { name: 'Private data' });
    const types = calls.filter((c) => c.opId === 'admin.cases_list').map((c) => caseType(c as unknown as TransportRequest));
    expect(types).toEqual(['post', 'comment', 'question', 'answer', 'portfolio_item', 'media_asset', 'review_response']);
    const rows = within(table).getAllByRole('row').slice(1);
    expect(within(rows[0]!).getByRole('button', { name: 'Private data' })).toBeInTheDocument();
    expect(within(rows[1]!).getByRole('button', { name: 'Spam' })).toBeInTheDocument();
  });

  it('a chosen type pages on the server', async () => {
    resetNav('/content?tab=content&type=comment');
    const { transport, calls } = scriptedTransport({ 'admin.cases_list': () => page([], 'next-1') });
    renderConsole(<ContentPage />, { transport, roles: ['MOD'] });
    await screen.findByText('No case matches these filters.');
    expect(calls.filter((c) => c.opId === 'admin.cases_list').map((c) => c.search)).toEqual(['?case_type=comment&status=open&limit=50']);
  });

  it('reads the case for its purpose, takes it, and hides the post with a reason', async () => {
    resetNav(`/content?tab=content&case=${C1}`);
    let assigned = false;
    const { transport, calls } = scriptedTransport({
      'admin.cases_list': (req) => page(caseType(req) === 'post' ? [kase()] : []),
      'admin.case_get': () =>
        Response.json({
          case: kase(assigned ? { assigned_to_display: 'Sara Staff', status: 'investigating' } : {}),
          actions: [],
          target_snapshot: postSnapshot(),
        }),
      'admin.case_assign': () => {
        assigned = true;
        return Response.json(kase({ assigned_to_display: 'Sara Staff', status: 'investigating' }));
      },
      'admin.case_action': () => action('hide'),
    });
    renderConsole(<ContentPage publicWeb="https://pwa.carpals.ir" />, { transport, roles: ['MOD'] });
    const target = await screen.findByTestId('case-target');
    expect(within(target).getByText('Winter tyres 20% off')).toBeInTheDocument();
    expect(within(target).getByRole('link', { name: 'Open the public page (new tab)' })).toHaveAttribute(
      'href',
      `https://pwa.carpals.ir/en/post/${P1}`,
    );
    expect(calls.find((c) => c.opId === 'admin.case_get')!.headers.get('carpal-access-purpose')).toBe(`case:${C1}`);

    fireEvent.click(screen.getByRole('button', { name: 'Take this case' }));
    expect(await screen.findByTestId('assigned-to-you')).toHaveTextContent('You are handling this case.');
    expect(calls.find((c) => c.opId === 'admin.case_assign')!.body).toEqual({ reason: 'taking_case' });
    expect(screen.getByTestId('case-assignee')).toHaveTextContent('Sara Staff');

    const actions = screen.getByTestId('case-actions');
    expect(within(actions).queryByRole('button', { name: 'Approve' })).toBeNull();
    fireEvent.click(within(actions).getByRole('button', { name: 'Hide' }));
    const dialog = await screen.findByRole('dialog', { name: 'Hide this post' });
    expect(within(dialog).getByText(/hidden from everyone but kept for review/)).toBeInTheDocument();
    await reason(dialog, 'policy_violation', 'spam link');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Hide' }));
    expect(await screen.findByText('Hidden.')).toBeInTheDocument();
    const call = calls.find((c) => c.opId === 'admin.case_action')!;
    expect(call.headers.get('carpal-access-purpose')).toBe(`case:${C1}`);
    expect(call.body).toEqual({ action_type: 'hide', reason: 'policy_violation: spam link' });
  });

  it('a showcase item without a valid consent cannot be approved', async () => {
    resetNav(`/content?tab=content&case=${C1}`);
    const c = kase({
      case_type: 'portfolio_item',
      target: { type: 'portfolio_item', id: P1 },
      source: 'system_rule',
      reason: 'consent_issue',
    });
    const { transport } = scriptedTransport({
      'admin.cases_list': (req) => page(caseType(req) === 'portfolio_item' ? [c] : []),
      'admin.case_get': () =>
        Response.json({
          case: c,
          actions: [],
          target_snapshot: {
            type: 'portfolio_item',
            id: P1,
            title: 'BMW E90 brake job',
            status: 'pending_review',
            customer_consent_status: 'requested',
            provider_organization_id: ORG,
          },
        }),
    });
    renderConsole(<ContentPage />, { transport, roles: ['MOD'] });
    const actions = await screen.findByTestId('case-actions');
    expect(within(actions).getByRole('button', { name: 'Approve' })).toBeDisabled();
    expect(screen.getByTestId('blocked-approve')).toHaveTextContent('has not given a valid showcase consent');
    expect(screen.getByTestId('consent')).toHaveTextContent('Requested, not given yet');
    expect(within(actions).getByRole('button', { name: 'Request changes' })).toBeEnabled();
  });

  it('a case handled by someone else says so', async () => {
    resetNav(`/content?tab=content&case=${C1}`);
    const { transport } = scriptedTransport({
      'admin.cases_list': (req) =>
        page(caseType(req) === 'post' ? [kase({ assigned_to_display: 'Nima M.', status: 'investigating' })] : []),
      'admin.case_get': () => problem(404, 'NOT_FOUND'),
    });
    renderConsole(<ContentPage />, { transport, roles: ['MOD'] });
    expect(await screen.findByTestId('case-unavailable')).toHaveTextContent('Being handled by Nima M.');
  });
});

describe('Accounts, penalties and badges (AC8.T4/T5)', () => {
  it('suspending an account asks for the security key (AAL3) and saves the action for the replay', async () => {
    resetNav(`/content?tab=accounts&case=${C1}`);
    const c = kase({ case_type: 'user', target: { type: 'user', id: P1 }, reason: 'harassment' });
    const { transport, calls } = scriptedTransport({
      'admin.cases_list': (req) => page(caseType(req) === 'user' ? [c] : []),
      'admin.case_get': () =>
        Response.json({
          case: c,
          actions: [],
          target_snapshot: { type: 'user', id: P1, display_name: 'Troll 42', status: 'active', created_at: ago(400), trusted_user: false },
        }),
      'admin.case_action': () =>
        problem(401, 'STEP_UP_REQUIRED', {
          'www-authenticate': 'DPoP error="insufficient_user_authentication", acr_values="aal3", max_age=600',
        }),
    });
    const { bff } = renderConsole(<ContentPage />, { transport, roles: ['MOD'] });
    const account = await screen.findByTestId('account-actions');
    expect(within(account).queryByRole('button', { name: 'Reactivate the account' })).toBeNull();
    fireEvent.click(within(account).getByRole('button', { name: 'Suspend the account' }));
    const dialog = await screen.findByRole('dialog', { name: 'Suspend the account' });
    expect(within(dialog).getByText('You will be asked for your security key before this is sent.')).toBeInTheDocument();
    await reason(dialog, 'repeated_violations', 'third harassment report');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Suspend the account' }));
    const key = await screen.findByRole('dialog', { name: "Confirm it's you" });
    expect(calls.find((x) => x.opId === 'admin.case_action')!.body).toEqual({
      action_type: 'suspend_account',
      reason: 'repeated_violations: third harassment report',
    });
    fireEvent.click(within(key).getByRole('button', { name: 'Confirm with security key' }));
    await waitFor(() => expect(bff.posted.find((p) => p.url === '/bff/intents')).toBeTruthy());
    expect((bff.posted.find((p) => p.url === '/bff/intents')!.body as { type: string }).type).toBe('act.admin.case_action');
  });

  it('a trust penalty needs 1-100 points and a second confirmation; badges are approved and revoked by id', async () => {
    resetNav(`/content?tab=accounts&case=${C1}`);
    const c = kase({ case_type: 'organization', target: { type: 'organization', id: ORG }, reason: 'fake', severity: 'high' });
    const { transport, calls } = scriptedTransport({
      'admin.cases_list': (req) => page(caseType(req) === 'organization' ? [c] : []),
      'admin.case_get': () =>
        Response.json({
          case: c,
          actions: [],
          target_snapshot: {
            type: 'organization',
            id: ORG,
            name: 'Pars Suspension',
            organization_type: 'provider',
            slug: 'pars',
            status: 'active',
            verification_status: 'verified',
            trust_score: 71,
          },
        }),
      'admin.case_action': (_req, body) => action(String(body?.action_type)),
      'admin.badge_approve': () =>
        Response.json({
          id: BADGE,
          created_at: ago(5),
          updated_at: ago(0),
          version: 2,
          badge_type: 'verified_business',
          scope_taxonomy_node_ids: [],
          rule_key: 'verified_business.v1',
          rule_version: '1',
          evaluation_snapshot: {},
          requires_admin_approval: true,
          awarded_at: ago(0),
          last_evaluated_at: ago(5),
          expires_at: null,
          visibility: 'public',
          status: 'active',
          revoked_reason: null,
        }),
    });
    renderConsole(<ContentPage publicWeb="https://pwa.carpals.ir" />, { transport, roles: ['MOD'] });
    expect(await screen.findByRole('link', { name: 'Open the public page (new tab)' })).toHaveAttribute(
      'href',
      'https://pwa.carpals.ir/en/shop/pars',
    );
    expect(screen.queryByTestId('case-actions')).toBeNull();

    const penalty = screen.getByTestId('penalty');
    fireEvent.click(within(penalty).getByRole('button', { name: 'Apply the penalty' }));
    expect(within(penalty).getByText('Enter a whole number from 1 to 100.')).toBeInTheDocument();
    fireEvent.change(within(penalty).getByLabelText('Penalty points'), { target: { value: '20' } });
    fireEvent.click(within(penalty).getByRole('button', { name: 'Apply the penalty' }));
    let dialog = await screen.findByRole('dialog', { name: 'Apply a trust penalty' });
    expect(within(dialog).getByText('Penalty: 20 points.')).toBeInTheDocument();
    await reason(dialog, 'confirmed_fake_reviews', 'five fake reviews from staff accounts');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply the penalty' }));
    expect(within(dialog).getByText('Tick the box to confirm.')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByLabelText('I understand, and I want to go ahead'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply the penalty' }));
    expect(await screen.findByText(/The penalty is recorded/)).toBeInTheDocument();
    expect(calls.find((x) => x.opId === 'admin.case_action')!.body).toEqual({
      action_type: 'apply_trust_penalty',
      reason: 'confirmed_fake_reviews: five fake reviews from staff accounts',
      params: { trust_penalty_points: 20 },
    });

    const badges = screen.getByTestId('badge-panel');
    fireEvent.click(within(badges).getByRole('button', { name: 'Approve the badge' }));
    expect(within(badges).getByText('Enter a badge id (a UUID).')).toBeInTheDocument();
    fireEvent.change(within(badges).getByLabelText('Badge id'), { target: { value: BADGE } });
    fireEvent.click(within(badges).getByRole('button', { name: 'Approve the badge' }));
    dialog = await screen.findByRole('dialog', { name: 'Approve this badge' });
    await reason(dialog, 'meets_policy');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve the badge' }));
    expect(await within(badges).findByText('Approved: Verified Business is active.')).toBeInTheDocument();
    const approve = calls.find((x) => x.opId === 'admin.badge_approve')!;
    expect(approve.path).toBe(`/v1/admin/badges/${BADGE}/approve`);
    expect(approve.body).toEqual({ reason: 'meets_policy' });

    fireEvent.click(within(badges).getByRole('button', { name: 'Revoke the badge' }));
    dialog = await screen.findByRole('dialog', { name: 'Revoke this badge' });
    await reason(dialog, 'rule_not_met', 'location closed');
    fireEvent.click(within(dialog).getByLabelText('I understand, and I want to go ahead'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke the badge' }));
    expect(await within(badges).findByText('The badge is revoked.')).toBeInTheDocument();
    const revoke = calls.filter((x) => x.opId === 'admin.case_action').at(-1)!;
    expect(revoke.headers.get('carpal-access-purpose')).toBe(`case:${C1}`);
    expect(revoke.body).toEqual({
      action_type: 'revoke_badge',
      target: { type: 'badge', id: BADGE },
      params: { badge_id: BADGE },
      reason: 'rule_not_met: location closed',
    });
  });
});

describe('Media viewer and inventory (AC8.T3/T4)', () => {
  it('shows the file of a case inline with the internal watermark, for the case purpose', async () => {
    resetNav(`/content?tab=content&case=${C1}`);
    const c = kase({ case_type: 'media_asset', target: { type: 'media_asset', id: P1 }, reason: 'non_consensual_media', severity: 'high' });
    const { transport, calls } = scriptedTransport({
      'admin.cases_list': (req) => page(caseType(req) === 'media_asset' ? [c] : []),
      'admin.case_get': () =>
        Response.json({
          case: c,
          actions: [],
          target_snapshot: {
            type: 'media_asset',
            id: P1,
            media_type: 'image',
            purpose: 'post_image',
            privacy_level: 'public',
            status: 'active',
            scan_status: 'clean',
            moderation_status: 'approved',
            owner_type: 'user',
            owner_id: id(77),
          },
        }),
      'admin.media_download_url': () => Response.json({ url: 'http://127.0.0.1:8083/m/x?sig=1', expires_at: ago(-0.08) }),
    });
    renderConsole(<ContentPage />, { transport, roles: ['MOD'] });
    expect(await screen.findByText(/Safety case: decide within 4 hours/)).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Show the file' }));
    const viewer = await screen.findByTestId('media-viewer');
    expect(within(viewer).getByRole('img', { name: 'The reported file (internal copy)' })).toHaveAttribute(
      'src',
      'http://127.0.0.1:8083/m/x?sig=1',
    );
    expect(within(viewer).getByText('CarPal internal')).toBeInTheDocument();
    expect(within(viewer).queryByRole('link')).toBeNull();
    const call = calls.find((x) => x.opId === 'admin.media_download_url')!;
    expect(call.path).toBe(`/v1/admin/media/${P1}/download-url`);
    expect(call.headers.get('carpal-access-purpose')).toBe(`case:${C1}`);
    expect(call.body).toEqual({ variant: 'display' });
  });

  it('inventory reads listings and fitment rows; a correction request needs a note', async () => {
    resetNav(`/inventory?case=${C1}`);
    const c = kase({ case_type: 'inventory_item', target: { type: 'inventory_item', id: P1 }, reason: 'counterfeit' });
    const { transport, calls } = scriptedTransport({
      'admin.cases_list': (req) => page(caseType(req) === 'inventory_item' ? [c] : []),
      'admin.case_get': () =>
        Response.json({
          case: c,
          actions: [],
          target_snapshot: {
            type: 'inventory_item',
            id: P1,
            vendor_organization_id: ORG,
            sku: 'BOS-0986',
            name_translations: { en: 'Brake pads', fa: 'لنت ترمز' },
            status: 'active',
            visibility: 'public',
          },
        }),
      'admin.case_action': () => action('request_changes'),
    });
    renderConsole(<InventoryPage />, { transport, roles: ['ADM'] });
    const target = await screen.findByTestId('case-target');
    expect(within(target).getByText('لنت ترمز')).toBeInTheDocument();
    expect(calls.filter((x) => x.opId === 'admin.cases_list').map((x) => caseType(x as unknown as TransportRequest))).toEqual([
      'inventory_item',
      'inventory_fitment',
    ]);
    fireEvent.click(within(screen.getByTestId('case-actions')).getByRole('button', { name: 'Request changes' }));
    const dialog = await screen.findByRole('dialog', { name: 'Request changes to this listing' });
    await reason(dialog, 'wrong_information');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Request changes' }));
    expect(within(dialog).getByText(/Write a note/)).toBeInTheDocument();
    await reason(dialog, 'wrong_information', 'Not an original Bosch part number');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Request changes' }));
    expect(await screen.findByText('Sent back for changes.')).toBeInTheDocument();
    expect(calls.find((x) => x.opId === 'admin.case_action')!.body).toEqual({
      action_type: 'request_changes',
      reason: 'wrong_information: Not an original Bosch part number',
    });
  });
});

describe('Moderation axe (AC8)', () => {
  for (const locale of ['en', 'fa'] as Locale[]) {
    it(`report: no violations (${locale})`, async () => {
      resetNav(`/content?report=${R1}`);
      const { transport } = scriptedTransport({
        'admin.reports_list': () => page([report()]),
        'admin.cases_list': () => page([]),
      });
      renderConsole(<ContentPage />, { transport, roles: ['MOD'], locale });
      await screen.findByTestId('triage');
      expect(await axeViolations()).toEqual([]);
    });

    it(`content case: no violations (${locale})`, async () => {
      resetNav(`/content?tab=content&case=${C1}`);
      const { transport } = scriptedTransport({
        'admin.cases_list': (req) => page(caseType(req) === 'post' ? [kase()] : []),
        'admin.case_get': () => Response.json({ case: kase(), actions: [], target_snapshot: postSnapshot() }),
      });
      renderConsole(<ContentPage />, { transport, roles: ['MOD'], locale });
      await screen.findByTestId('case-actions');
      expect(await axeViolations()).toEqual([]);
    });

    it(`organization case: no violations (${locale})`, async () => {
      resetNav(`/content?tab=accounts&case=${C1}`);
      const c = kase({ case_type: 'organization', target: { type: 'organization', id: ORG } });
      const { transport } = scriptedTransport({
        'admin.cases_list': (req) => page(caseType(req) === 'organization' ? [c] : []),
        'admin.case_get': () =>
          Response.json({
            case: c,
            actions: [],
            target_snapshot: { type: 'organization', id: ORG, name: 'Pars', organization_type: 'provider', status: 'active' },
          }),
      });
      renderConsole(<ContentPage />, { transport, roles: ['MOD'], locale });
      await screen.findByTestId('badge-panel');
      expect(await axeViolations()).toEqual([]);
    });
  }
});
