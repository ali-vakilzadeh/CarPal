// AC14-2 DOM tests of the verification additions (backend S19, BR-34): the queue's assignee, call-back, flags and
// paused clock columns and the assignee / waiting filters; Take and Assign to a colleague (admin.verification_assign);
// a check with someone else is not decided until taken over; Request more info (verification_decide info_requested:
// items, template text, message, purpose and reason); the request and its answer as the business sees them; the
// registration number and the AI pre-check; checkClock; axe in EN and FA.
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffOrgView, StaffUserView } from '@carpal/api-contracts';
import { axeViolations, page, renderConsole, scriptedTransport } from '../../../tests/support/console-harness';
import { resetNav } from '../../../tests/support/navigation-mock';
import type { Locale } from '@/lib/i18n/locales';
import { checkClock, infoRequestProblem, itemsOfTemplate, type QueueItem } from './verification-logic';
import { VerificationPage } from './verification-page';

vi.mock('next/navigation', async () => (await import('../../../tests/support/navigation-mock')).navigationMock());

const id = (n: number) => `0193a3c4-5d6e-7f80-9a1b-${String(n).padStart(12, '0')}`;
const ORG = id(21);
const V1 = id(61);
const COLLEAGUE = id(77);
const ago = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
const PURPOSE = `verification:${V1}`;

function item(o: Partial<QueueItem> = {}): QueueItem {
  return {
    id: V1,
    created_at: ago(30),
    updated_at: ago(30),
    version: 1,
    verification_type: 'business_identity',
    status: 'pending',
    submitted_document_ids: [],
    reviewed_at: null,
    rejection_reason: null,
    expires_at: null,
    registration_number: '10103456789',
    info_request: null,
    organization: {
      id: ORG,
      name: 'Asa Auto',
      organization_type: 'provider',
      slug: 'asa-auto',
      logo_url: null,
      status: 'active',
      verification_status: 'pending',
    },
    location_check: null,
    wrong_location_reports: 0,
    assignee: null,
    assigned_at: null,
    sla_started_at: ago(30),
    sla_paused_since: null,
    ai_precheck: { documents_readable: true, name_match: false, duplicate_risk: 'low', checked_at: ago(29) },
    owner: { user_id: id(5), display_name: 'Reza K.' },
    callback_result: 'pending',
    possible_duplicate: true,
    ...o,
  };
}

const org = () =>
  ({
    id: ORG,
    name: 'Asa Auto',
    organization_type: 'provider',
    verification_status: 'pending',
    locations: [],
    verifications: [],
    subscription: { plan: { plan_key: 'provider_basic' } },
    member_count: 2,
    open_cases: 0,
  }) as unknown as StaffOrgView;

const colleague = {
  user_id: COLLEAGUE,
  display_name: 'Mina Moderator',
  platform_roles: ['platform_moderator'],
} as unknown as StaffUserView;

beforeEach(() => resetNav('/verification'));

describe('Verification additions (AC14-2)', () => {
  it('the queue shows assignee, call-back, flags and a paused clock; filters go to the query', async () => {
    const { transport, calls } = scriptedTransport({
      'admin.verifications_queue': () =>
        page([
          item({
            assignee: { user_id: COLLEAGUE, display_name: 'Mina Moderator' },
            sla_paused_since: ago(2),
            info_request: {
              id: id(9),
              missing_items: ['business_document'],
              template_key: 'missing_documents',
              message: 'Please add the licence.',
              status: 'open',
              requested_at: ago(2),
              answered_at: null,
              response_note: null,
              added_document_ids: [],
            },
          }),
        ]),
    });
    renderConsole(<VerificationPage />, { transport, roles: ['MOD'] });
    const table = await screen.findByRole('table', { name: 'Verification requests' });
    const row = (await within(table).findAllByText('Asa Auto'))[0]!.closest('tr')!;
    expect(row).toHaveTextContent('Mina Moderator');
    expect(row).toHaveTextContent('Waiting');
    expect(row).toHaveTextContent('Possible duplicate');
    expect(row).toHaveTextContent('Waiting for the business');
    expect(within(row).getByTestId('sla-paused')).toHaveTextContent('Paused: waiting for the business');
    fireEvent.change(screen.getByRole('combobox', { name: 'Assigned' }), { target: { value: 'me' } });
    await waitFor(() => expect(calls.at(-1)!.search).toContain('assignee=me'));
    fireEvent.change(screen.getByRole('combobox', { name: 'More information' }), { target: { value: 'true' } });
    await waitFor(() => expect(calls.at(-1)!.search).toContain('info_requested=true'));
  });

  it('a check with a colleague is taken over before it is decided; Take sends the button as the reason', async () => {
    resetNav(`/verification?verification=${V1}&purpose=${encodeURIComponent(PURPOSE)}`);
    let mine = false;
    const { transport, calls } = scriptedTransport({
      'admin.verifications_queue': () =>
        page([
          item({
            assignee: mine ? { user_id: 'staff-1', display_name: 'Sara Staff' } : { user_id: COLLEAGUE, display_name: 'Mina Moderator' },
          }),
        ]),
      'admin.org_get': () => Response.json(org()),
      'admin.staff_list': () => page([colleague]),
      'admin.verification_assign': () => {
        mine = true;
        return Response.json(item({ assignee: { user_id: 'staff-1', display_name: 'Sara Staff' } }));
      },
    });
    renderConsole(<VerificationPage />, { transport, roles: ['MOD'] });
    expect(await screen.findByTestId('verification-assignee')).toHaveTextContent('Mina Moderator is reviewing this check');
    expect(screen.queryByTestId('checklist')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Take it over' }));
    await waitFor(() => expect(screen.getByTestId('verification-assignee')).toHaveTextContent('You are reviewing this check.'));
    expect(screen.getByTestId('checklist')).toBeInTheDocument();
    const call = calls.find((c) => c.opId === 'admin.verification_assign')!;
    expect(call.path).toBe(`/v1/admin/verifications/${V1}/assign`);
    expect(call.body).toEqual({ reason: 'taking_check' });
  });

  it('a check opened by its link (not on the loaded page) shows the new assignee after Take', async () => {
    resetNav(`/verification?verification=${V1}&purpose=${encodeURIComponent(PURPOSE)}`);
    let mine = false;
    const { transport } = scriptedTransport({
      'admin.verifications_queue': (req) =>
        req.search.includes('verification_id=')
          ? page([item(mine ? { assignee: { user_id: 'staff-1', display_name: 'Sara Staff' } } : {})])
          : page([item({ id: id(70), organization: { ...item().organization, name: 'Other' } })]),
      'admin.org_get': () => Response.json(org()),
      'admin.staff_list': () => page([]),
      'admin.verification_assign': () => {
        mine = true;
        return Response.json(item({ assignee: { user_id: 'staff-1', display_name: 'Sara Staff' } }));
      },
    });
    renderConsole(<VerificationPage />, { transport, roles: ['MOD'] });
    expect(await screen.findByTestId('verification-assignee')).toHaveTextContent('Nobody is reviewing this check yet.');
    fireEvent.click(screen.getByRole('button', { name: 'Take this check' }));
    await waitFor(() => expect(screen.getByTestId('verification-assignee')).toHaveTextContent('You are reviewing this check.'));
  });

  it('assigns to a colleague with the colleague named in the reason', async () => {
    resetNav(`/verification?verification=${V1}&purpose=${encodeURIComponent(PURPOSE)}`);
    const { transport, calls } = scriptedTransport({
      'admin.verifications_queue': () => page([item()]),
      'admin.org_get': () => Response.json(org()),
      'admin.staff_list': () => page([colleague]),
      'admin.verification_assign': () => Response.json(item({ assignee: { user_id: COLLEAGUE, display_name: 'Mina Moderator' } })),
    });
    renderConsole(<VerificationPage />, { transport, roles: ['ADM'] });
    const panel = await screen.findByTestId('verification-assign');
    expect(within(panel).getByTestId('verification-assignee')).toHaveTextContent('Nobody is reviewing this check yet.');
    fireEvent.change(await within(panel).findByLabelText('Or assign to'), { target: { value: COLLEAGUE } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Assign' }));
    await waitFor(() => expect(calls.some((c) => c.opId === 'admin.verification_assign')).toBe(true));
    expect(calls.find((c) => c.opId === 'admin.verification_assign')!.body).toEqual({
      assignee_user_id: COLLEAGUE,
      reason: 'assigned_to_colleague: Mina Moderator',
    });
  });

  it('Request more info: template text and items, then the decision info_requested under the purpose', async () => {
    resetNav(`/verification?verification=${V1}&purpose=${encodeURIComponent(PURPOSE)}`);
    const { transport, calls } = scriptedTransport({
      'admin.verifications_queue': () => page([item({ assignee: { user_id: 'staff-1', display_name: 'Sara Staff' } })]),
      'admin.org_get': () => Response.json(org()),
      'admin.staff_list': () => page([]),
      'admin.verification_decide': () => Response.json({ id: V1, status: 'pending' }),
    });
    renderConsole(<VerificationPage />, { transport, roles: ['MOD'] });
    expect(await screen.findByTestId('ver-registration')).toHaveTextContent('10103456789');
    expect(screen.getByTestId('ver-callback')).toHaveTextContent('Waiting');
    expect(screen.getByTestId('ver-precheck')).toHaveTextContent('name matches: No');
    fireEvent.click(screen.getByRole('button', { name: 'Ask the business for more' }));
    const form = await screen.findByTestId('info-request-form');
    expect(within(form).getByLabelText('Business document')).toBeChecked();
    fireEvent.change(within(form).getByLabelText('Kind of request'), { target: { value: 'unreadable_documents' } });
    expect(within(form).getByLabelText('Readable copy')).toBeChecked();
    expect(within(form).getByLabelText('Business document')).not.toBeChecked();
    expect((within(form).getByLabelText('Message to the business') as HTMLTextAreaElement).value).toContain('could not read');
    fireEvent.click(within(form).getByLabelText('Readable copy'));
    fireEvent.click(within(form).getByRole('button', { name: 'Send the request' }));
    expect(within(form).getByText('Choose at least one item.')).toBeInTheDocument();
    fireEvent.click(within(form).getByLabelText("Owner's identity"));
    fireEvent.click(within(form).getByRole('button', { name: 'Send the request' }));
    const dialog = await screen.findByRole('dialog', { name: 'Ask the business for more information' });
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'documents_unreadable' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send the request' }));
    expect(await screen.findByText('Sent. The clock is paused until the business answers.')).toBeInTheDocument();
    const call = calls.find((c) => c.opId === 'admin.verification_decide')!;
    expect(call.headers.get('carpal-access-purpose')).toBe(PURPOSE);
    expect(call.body).toEqual({
      decision: 'info_requested',
      info_request: {
        missing_items: ['owner_identity'],
        template_key: 'unreadable_documents',
        message: expect.stringContaining('could not read'),
      },
      reason: 'documents_unreadable',
    });
  });

  it('an answered request shows the answer; a waiting one pauses the clock and hides the form', async () => {
    resetNav(`/verification?verification=${V1}&purpose=${encodeURIComponent(PURPOSE)}`);
    const { transport } = scriptedTransport({
      'admin.verifications_queue': () =>
        page([
          item({
            assignee: { user_id: 'staff-1', display_name: 'Sara Staff' },
            sla_paused_since: ago(3),
            info_request: {
              id: id(9),
              missing_items: ['registration_number'],
              template_key: 'details_mismatch',
              message: 'Your number differs.',
              status: 'open',
              requested_at: ago(3),
              answered_at: null,
              response_note: null,
              added_document_ids: [],
            },
          }),
        ]),
      'admin.org_get': () => Response.json(org()),
      'admin.staff_list': () => page([]),
    });
    renderConsole(<VerificationPage />, { transport, roles: ['MOD'] });
    const request = await screen.findByTestId('info-request');
    expect(request).toHaveTextContent('Asked for more information');
    expect(request).toHaveTextContent('Registration number');
    expect(request).toHaveTextContent('Your number differs.');
    expect(screen.getByTestId('clock-paused')).toHaveTextContent('The clock is paused until the business answers.');
    expect(screen.queryByRole('button', { name: 'Ask the business for more' })).toBeNull();
  });

  for (const locale of ['en', 'fa'] as Locale[]) {
    it(`axe: no violations with the request form open (${locale})`, async () => {
      resetNav(`/verification?verification=${V1}&purpose=${encodeURIComponent(PURPOSE)}`);
      const { transport } = scriptedTransport({
        'admin.verifications_queue': () => page([item({ assignee: { user_id: 'staff-1', display_name: 'Sara Staff' } })]),
        'admin.org_get': () => Response.json(org()),
        'admin.staff_list': () => page([colleague]),
      });
      renderConsole(<VerificationPage />, { transport, roles: ['MOD'], locale });
      await screen.findByTestId('verification-assign');
      fireEvent.click(
        screen.getAllByRole('button').find((b) => b.textContent?.includes(locale === 'en' ? 'Ask the business' : 'درخواست اطلاعات'))!,
      );
      await screen.findByTestId('info-request-form');
      expect(await axeViolations()).toEqual([]);
    });
  }
});

describe('verification rules (AC14-2)', () => {
  it('checkClock starts at sla_started_at and reports a pause', () => {
    const c = checkClock(
      { created_at: '2026-11-01T06:00:00Z', sla_started_at: '2026-11-03T06:00:00Z', sla_paused_since: null },
      'Asia/Tehran',
    );
    expect(c.start).toBe(Date.parse('2026-11-03T06:00:00Z'));
    expect(c.pausedSince).toBeNull();
    expect(checkClock({ created_at: '2026-11-01T06:00:00Z', sla_paused_since: '2026-11-02T06:00:00Z' }, 'Asia/Tehran').pausedSince).toBe(
      Date.parse('2026-11-02T06:00:00Z'),
    );
  });
  it('templates preselect items; a request needs an item and a message', () => {
    expect(itemsOfTemplate('missing_documents', 'location')).toEqual(['address_proof']);
    expect(itemsOfTemplate('callback_failed', 'phone')).toEqual(['phone_callback']);
    expect(infoRequestProblem([], 'x')).toBe('items');
    expect(infoRequestProblem(['other'], '  ')).toBe('message');
    expect(infoRequestProblem(['other'], 'a'.repeat(1001))).toBe('too_long');
    expect(infoRequestProblem(['other'], 'ok')).toBeNull();
  });
});
