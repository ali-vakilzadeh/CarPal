// AC9.T4 DOM tests of the verification queue and review: oldest first with the SLA, a check read for its purpose
// (submitted data masked, documents shown on demand with zoom and rotate), Approve only after the checklist (sent at
// the end of the reason) and the organization's new status after the decision, a far pin blocking a location check,
// Reject with the message the business reads, moderators only; axe in EN and FA.
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Location, StaffOrgView } from '@carpal/api-contracts';
import { axeViolations, page, renderConsole, scriptedTransport, searchRow } from '../../../tests/support/console-harness';
import { nav, resetNav } from '../../../tests/support/navigation-mock';
import type { Locale } from '@/lib/i18n/locales';
import type { QueueItem } from './verification-logic';
import { VerificationPage } from './verification-page';

vi.mock('next/navigation', async () => (await import('../../../tests/support/navigation-mock')).navigationMock());

const id = (n: number) => `0193a3c4-5d6e-7f80-9a1b-${String(n).padStart(12, '0')}`;
const ORG = id(21);
const V1 = id(61);
const V2 = id(62);
const DOC = id(91);
const ago = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

function item(o: Partial<QueueItem> = {}): QueueItem {
  return {
    id: V1,
    created_at: ago(30),
    updated_at: ago(30),
    version: 1,
    verification_type: 'business_identity',
    status: 'pending',
    submitted_document_ids: [DOC],
    reviewed_at: null,
    rejection_reason: null,
    expires_at: null,
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
    ...o,
  } as QueueItem;
}

const loc = (o: Partial<Location> = {}) =>
  ({
    id: id(51),
    address_line_1: 'Valiasr St 12',
    city: 'Tehran',
    country: 'IR',
    status: 'active',
    is_primary: true,
    location_check_status: 'consistent',
    ...o,
  }) as Location;

function org(o: Partial<StaffOrgView> = {}): StaffOrgView {
  return {
    id: ORG,
    created_at: ago(300),
    updated_at: ago(2),
    version: 1,
    name: 'Asa Auto',
    legal_name: 'Asa Khodro Co.',
    organization_type: 'provider',
    verification_status: 'pending',
    primary_location_id: id(51),
    contact_email: 'owner@asa-auto.ir',
    contact_phone: '+989121234567',
    status: 'active',
    locations: [loc()],
    verifications: [],
    subscription: { plan: { plan_key: 'provider_basic' } },
    member_count: 2,
    open_cases: 0,
    ...o,
  } as unknown as StaffOrgView;
}

const reason = (dialog: HTMLElement, code: string, note?: string) => {
  fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: code } });
  if (note !== undefined) fireEvent.change(within(dialog).getByLabelText(/^Note/), { target: { value: note } });
};

beforeEach(() => resetNav('/verification'));
afterEach(() => vi.unstubAllGlobals());

describe('Verification queue and review (AC9.T4)', () => {
  it('lists pending checks oldest first and opens one for its purpose', async () => {
    const { transport, calls } = scriptedTransport({
      'admin.verifications_queue': () =>
        page([
          item({
            id: V2,
            created_at: ago(5),
            verification_type: 'location',
            location_check: { geocoded_point: null, distance_m: 900, location_check_status: 'far_apart', threshold_m: 300 },
            wrong_location_reports: 2,
          }),
          item(),
        ]),
      'admin.org_get': () => Response.json(org()),
      'admin.media_download_url': () => Response.json({ url: 'https://storage.test/doc.png', expires_at: ago(-0.1) }),
    });
    renderConsole(<VerificationPage />, { transport, roles: ['MOD'] });
    const table = await screen.findByRole('table', { name: 'Verification requests' });
    await within(table).findAllByRole('button', { name: 'Asa Auto' });
    expect(calls[0]!.search).toBe('?status=pending&limit=50');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(within(rows[0]!).getByText('Business identity')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Far from address')).toBeInTheDocument();
    expect(within(rows[0]!).getByText(/^Due in /)).toBeInTheDocument();
    fireEvent.click(within(rows[0]!).getByRole('button', { name: 'Asa Auto' }));
    expect(nav.search).toContain(`verification=${V1}`);
    const panel = await screen.findByTestId('verification-item');
    await within(panel).findByText('Asa Khodro Co.');
    expect(calls.find((c) => c.opId === 'admin.org_get')!.headers.get('carpal-access-purpose')).toBe(`verification:${V1}`);
    expect(within(panel).queryByText('owner@asa-auto.ir')).toBeNull();
    // The document is read on demand for the same purpose and shown with the watermark; zoom and rotate.
    fireEvent.click(within(panel).getByRole('button', { name: 'Show the document' }));
    const img = await within(panel).findByRole('img', { name: 'Submitted document (CarPal internal)' });
    const media = calls.find((c) => c.opId === 'admin.media_download_url')!;
    expect(media.path).toBe(`/v1/admin/media/${DOC}/download-url`);
    expect(media.body).toEqual({ variant: 'display' });
    expect(media.headers.get('carpal-access-purpose')).toBe(`verification:${V1}`);
    expect(within(panel).getByText('CarPal internal')).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole('button', { name: 'Zoom in' }));
    fireEvent.click(within(panel).getByRole('button', { name: 'Rotate' }));
    expect(img).toHaveAttribute('data-zoom', '1.5');
    expect(img).toHaveAttribute('data-turn', '90');
    expect(within(panel).getByText('Document 1 of 1')).toBeInTheDocument();
  });

  it('approves only after the checklist and shows the organization status afterwards', async () => {
    resetNav(`/verification?verification=${V1}&purpose=verification:${V1}`);
    let decided = false;
    const { transport, calls } = scriptedTransport({
      'admin.verifications_queue': () => page(decided ? [] : [item()]),
      'admin.org_get': () => Response.json(org()),
      'admin.verification_decide': () => {
        decided = true;
        return Response.json({ ...item(), status: 'verified', reviewed_at: ago(0) });
      },
      'admin.orgs_search': () => page([searchRow(org({ verification_status: 'verified' }))]),
    });
    renderConsole(<VerificationPage />, { transport, roles: ['ADM'] });
    const checklist = await screen.findByTestId('checklist');
    const approve = screen.getByRole('button', { name: 'Approve' });
    expect(approve).toBeDisabled();
    expect(screen.getByTestId('approve-block')).toHaveTextContent('Tick every checklist item');
    for (const box of within(checklist).getAllByRole('checkbox')) fireEvent.click(box);
    expect(approve).toBeEnabled();
    fireEvent.click(approve);
    const dialog = await screen.findByRole('dialog', { name: 'Approve this check' });
    expect(within(dialog).getByText(/4 of 4 ticked/)).toBeInTheDocument();
    reason(dialog, 'documents_match');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve' }));
    const done = await screen.findByTestId('decision-done');
    expect(within(done).getByText('The check is verified.')).toBeInTheDocument();
    expect(await within(done).findByText("The organization's verification status is now: Verified.")).toBeInTheDocument();
    expect(within(done).getByText(/Verified Business badge/)).toBeInTheDocument();
    const call = calls.find((c) => c.opId === 'admin.verification_decide')!;
    expect(call.path).toBe(`/v1/admin/verifications/${V1}/decision`);
    expect(call.headers.get('carpal-access-purpose')).toBe(`verification:${V1}`);
    expect(call.body).toEqual({
      decision: 'verified',
      reason: 'documents_match [checklist: details_match, contact_verified, taxonomy_consistent, no_duplicate]',
    });
    expect(calls.find((c) => c.opId === 'admin.orgs_search')!.body).toEqual({ organization_id: ORG, limit: 1 });
  });

  it('blocks a location check while a pin is far from its address', async () => {
    resetNav(`/verification?verification=${V2}&purpose=verification:${V2}`);
    const { transport } = scriptedTransport({
      'admin.verifications_queue': () =>
        page([
          item({
            id: V2,
            verification_type: 'location',
            location_check: { geocoded_point: null, distance_m: 900, location_check_status: 'far_apart', threshold_m: 300 },
          }),
        ]),
      'admin.org_get': () => Response.json(org({ locations: [loc({ location_check_status: 'far_apart' })] })),
    });
    renderConsole(<VerificationPage />, { transport, roles: ['MOD'] });
    const checklist = await screen.findByTestId('checklist');
    for (const box of within(checklist).getAllByRole('checkbox')) fireEvent.click(box);
    expect(await screen.findByText('A pin is far from its address')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
    expect(screen.getByTestId('approve-block')).toHaveTextContent('correct it first');
    expect(screen.getByRole('link', { name: 'Correct it on the Locations tab' })).toHaveAttribute(
      'href',
      `/orgs/${ORG}?tab=locations&purpose=${encodeURIComponent(`verification:${V2}`)}`,
    );
    expect(screen.getByTestId('ver-distance')).toHaveTextContent('about 900 m (threshold 300 m)');
  });

  it('rejects with a reason and the message for the business', async () => {
    resetNav(`/verification?verification=${V1}&purpose=verification:${V1}`);
    const { transport, calls } = scriptedTransport({
      'admin.verifications_queue': () => page([item()]),
      'admin.org_get': () => Response.json(org()),
      'admin.verification_decide': () => Response.json({ ...item(), status: 'rejected', rejection_reason: 'Upload a readable licence' }),
      'admin.orgs_search': () => page([searchRow(org({ verification_status: 'rejected' }))]),
    });
    renderConsole(<VerificationPage />, { transport, roles: ['MOD'] });
    fireEvent.click(await screen.findByRole('button', { name: 'Reject' }));
    const dialog = await screen.findByRole('dialog', { name: 'Reject this check' });
    reason(dialog, 'documents_unreadable', 'Blurry scan');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reject' }));
    expect(within(dialog).getByText('Write what the business should fix.')).toBeInTheDocument();
    expect(calls.some((c) => c.opId === 'admin.verification_decide')).toBe(false);
    fireEvent.change(within(dialog).getByLabelText(/Message to the business/), { target: { value: 'Upload a readable licence' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reject' }));
    expect(await screen.findByText('The check is rejected.')).toBeInTheDocument();
    expect(calls.find((c) => c.opId === 'admin.verification_decide')!.body).toEqual({
      decision: 'rejected',
      reason: 'documents_unreadable: Blurry scan [checklist: none]',
      rejection_reason: 'Upload a readable licence',
    });
  });

  it('explains the problem when the check was decided meanwhile', async () => {
    resetNav(`/verification?verification=${V1}&purpose=verification:${V1}`);
    const { transport } = scriptedTransport({
      'admin.verifications_queue': () => page([item({ verification_type: 'phone' })]),
      'admin.org_get': () => Response.json(org()),
      'admin.verification_decide': () =>
        Response.json({ code: 'INVALID_TRANSITION', title: 'x' }, { status: 409, headers: { 'content-type': 'application/problem+json' } }),
    });
    renderConsole(<VerificationPage />, { transport, roles: ['MOD'] });
    fireEvent.click(within(await screen.findByTestId('checklist')).getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    const dialog = await screen.findByRole('dialog', { name: 'Approve this check' });
    reason(dialog, 'contact_confirmed');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(document.querySelector('[data-outcome="failed"]')).not.toBeNull());
    expect(document.querySelector('[data-outcome="failed"]')!.getAttribute('data-code')).toBe('INVALID_TRANSITION');
  });
});

describe('Verification a11y (AC9.T6)', () => {
  for (const locale of ['en', 'fa'] as Locale[])
    it(`has no axe violations on a check under review (${locale})`, async () => {
      resetNav(`/verification?verification=${V1}&purpose=verification:${V1}`);
      const { transport } = scriptedTransport({
        'admin.verifications_queue': () => page([item()]),
        'admin.org_get': () => Response.json(org()),
      });
      const { container } = renderConsole(<VerificationPage />, { transport, roles: ['MOD'], locale });
      await screen.findByTestId('checklist');
      await screen.findByText('Asa Khodro Co.');
      expect(await axeViolations(container)).toEqual([]);
    });
});
