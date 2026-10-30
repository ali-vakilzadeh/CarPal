// P11 (DOM): W-REV-01 by both paths (Verified visit with the privacy check and stars; Send for approval without a
// visit), a blocked eligibility, /l/ri (open once, sign in first, code → grant → review page; another account),
// /l/cn (the exact photos, Approve), and My Activity Reviews (statuses, open invitations, withdraw).
import type { Eligibility, Review, ReviewInvitation } from '@carpal/api-contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { navigation } from '../../../tests/support/next-navigation';
import { providerProfile } from '../../../tests/support/public-fixtures';
import { guest, renderApp, signedIn } from '../../../tests/support/render-app';
import { forgetFragmentTokens } from '@/features/auth';
import { goTo } from '@/lib/browser-nav';
import { ApiProblem } from '@/lib/api/problem';
import { ConsentLinkPage } from './consent-link';
import { InviteLinkPage } from './invite-link';
import { ReviewPage } from './review-page';
import { ActivityReviews } from './reviews-tab';
import { grantFor } from './storage';

vi.mock('next/navigation', () => import('../../../tests/support/next-navigation'));
vi.mock('next/link', () => import('../../../tests/support/next-link'));
vi.mock('@/lib/browser-nav', () => ({ goTo: vi.fn() }));

const ID = (n: number) => `0195f3b1-6a2b-7c3d-8e4f-${String(n).padStart(12, '0')}`;
const ORG = ID(1);
const APPT = ID(2);
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const profile = providerProfile({ id: ORG, slug: 'reza-auto', name: 'Reza Auto Suspension', roles: ['provider'] });

function eligibility(o: Partial<Eligibility> = {}): Eligibility {
  return { allowed: true, path: 'visit_based', reason_code: 'ok', candidate_visits: [], ...o };
}

function review(o: Partial<Review> = {}): Review {
  return {
    id: ID(9),
    created_at: '2026-10-30T10:00:00Z',
    updated_at: '2026-10-30T10:00:00Z',
    version: 1,
    subject_organization_id: ORG,
    subject_type: 'provider',
    overall_rating: 4,
    body: 'The clunk was the control arm.',
    content_locale: 'en',
    status: 'pending_moderation',
    confirmation_path: 'visit_based',
    verified_status: 'appointment_verified',
    business_confirmation_status: null,
    reviewer_decision: null,
    reviewer_reason_code: null,
    disputed_by_business: false,
    helpful_count: 0,
    report_status: 'none',
    published_at: null,
    media: [],
    can_add_evidence: false,
    response: null,
    ...o,
  };
}

beforeEach(() => {
  navigation.reset('/en/review/reza-auto');
  sessionStorage.clear();
  localStorage.clear();
  vi.mocked(goTo).mockClear();
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => Promise.resolve(String(input) === '/bff/csrf' ? json({ csrf_token: 'c' }) : json({}, 404))),
  );
});
afterEach(() => vi.unstubAllGlobals());

const stars = (group: string, n: number) =>
  within(screen.getByRole('group', { name: group })).getByRole('radio', { name: `${n} of 5 stars` });

describe('W-REV-01 write review', () => {
  it('Path 1: verified visit, required stars, the privacy check and the confirmation', async () => {
    const {
      api: { calls },
    } = renderApp(<ReviewPage slug="reza-auto" query={{ as: null, appointment: APPT, invite: false, edit: null }} />, {
      locale: 'en',
      session: signedIn('Sara M.'),
      handlers: {
        'public.org_get': () => profile,
        'reviews.eligibility': () =>
          eligibility({ candidate_visits: [{ type: 'appointment', id: APPT, date: '2026-10-28', within_invitation_window: true }] }),
        'taxonomy.snapshot': () => ({ items: [], next_cursor: null }),
        'reviews.create': (args) => review({ body: (args.body as { body: string }).body }),
      },
    });
    expect(await screen.findByText('Verified visit')).toBeTruthy();
    expect(screen.getByText(/Shown as Sara M\./)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Submit review' }));
    expect(await screen.findByText('Choose 1 to 5 stars.')).toBeTruthy();
    expect(calls.some((c) => c.opId === 'reviews.create')).toBe(false);

    fireEvent.click(stars('Overall rating', 4));
    fireEvent.click(stars('Work quality', 5));
    fireEvent.change(screen.getByLabelText('Your review'), { target: { value: 'Fixed the clunk. Call me on 0912 345 6789 anytime.' } });
    const findings = await screen.findByTestId('privacy-findings');
    expect(within(findings).getByText(/Looks like a phone number in line 1/)).toBeTruthy();
    fireEvent.click(within(findings).getByRole('button', { name: 'Remove' }));
    expect((screen.getByLabelText('Your review') as HTMLTextAreaElement).value).toBe('Fixed the clunk. Call me on anytime.');

    fireEvent.click(screen.getByRole('button', { name: 'Submit review' }));
    expect(await screen.findByTestId('review-submitted')).toBeTruthy();
    expect(screen.getByText('Thank you, Sara')).toBeTruthy();
    expect(screen.getByText('Being checked — usually published within minutes')).toBeTruthy();
    expect(calls.find((c) => c.opId === 'reviews.create')!.args.body).toMatchObject({
      subject_organization_id: ORG,
      subject_type: 'provider',
      context_appointment_id: APPT,
      overall_rating: 4,
      sub_ratings: [{ dimension: 'work_quality', rating: 5 }],
      body: 'Fixed the clunk. Call me on anytime.',
      content_locale: 'en',
    });
  });

  it('Path 2: no visit → Send for approval and the approval steps', async () => {
    renderApp(<ReviewPage slug="reza-auto" query={{ as: null, invite: false, edit: null }} />, {
      locale: 'en',
      session: signedIn('Sara M.'),
      handlers: {
        'public.org_get': () => profile,
        'reviews.eligibility': () => eligibility({ path: 'approval_based' }),
        'taxonomy.snapshot': () => ({ items: [], next_cursor: null }),
        'reviews.create': () =>
          review({
            status: 'pending_approval',
            confirmation_path: 'approval_based',
            verified_status: 'pending_approval',
            business_confirmation_status: 'pending',
          }),
      },
    });
    expect(await screen.findByText(/No appointment — the shop and CarPal will check this review/)).toBeTruthy();
    fireEvent.click(stars('Overall rating', 3));
    fireEvent.change(screen.getByLabelText('Your review'), { target: { value: 'Quick diagnosis, fair price.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send for approval' }));
    expect(await screen.findByText('Sent for approval')).toBeTruthy();
    expect(screen.getByText('The shop confirms you were its customer')).toBeTruthy();
  });

  it('explains a blocked review (velocity limit)', async () => {
    renderApp(<ReviewPage slug="reza-auto" query={{ as: null, invite: false, edit: null }} />, {
      locale: 'en',
      session: signedIn(),
      handlers: {
        'public.org_get': () => profile,
        'reviews.eligibility': () => eligibility({ allowed: false, path: null, reason_code: 'velocity_limit' }),
      },
    });
    expect(await screen.findByText('You have written 5 reviews in the last 24 hours. Please try again tomorrow.')).toBeTruthy();
  });
});

const opened = {
  invitation_id: ID(4),
  subject: { ...profile, roles: ['provider' as const] },
  visit_context: {
    service_system: { text: 'Suspension', locale: 'en' as const },
    service_task: null,
    service_date: '2026-10-28',
    vehicle: { brand: { text: 'BMW', locale: 'en' as const }, model: { text: '320i', locale: 'en' as const } },
    location_id: null,
  },
  expires_at: '2026-11-04T10:00:00Z',
  path: 'visit_based' as const,
  code_sent_to: 's•••@t•••.app',
};

describe('/l/ri review invitation', () => {
  beforeEach(() => {
    forgetFragmentTokens();
    window.history.replaceState(null, '', '/l/ri#tok_abcdefgh123');
  });

  it('opens once for a guest, keeps the token in the tab and asks to log in first', async () => {
    const {
      api: { calls },
    } = renderApp(<InviteLinkPage />, { locale: 'en', session: guest, handlers: { 'review_invitations.open': () => opened } });
    expect(await screen.findByText('Review your visit to Reza Auto Suspension')).toBeTruthy();
    expect(window.location.hash).toBe('');
    expect(screen.getByText('BMW 320i · Suspension · Oct 28, 2026')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Log in to continue' }));
    expect(vi.mocked(goTo).mock.calls[0]![0]).toMatch(/^\/bff\/login\?return_to=%2Fen%2Fonboarding%3Fnext%3D%252Fl%252Fri/);
    expect(vi.mocked(goTo).mock.calls[0]![0]).not.toContain('tok_');
    expect(JSON.parse(sessionStorage.getItem('cp:link:ri')!)).toMatchObject({ token: 'tok_abcdefgh123', opened: { invitation_id: ID(4) } });
    expect(calls.filter((c) => c.opId === 'review_invitations.open')).toHaveLength(1);
  });

  it('verifies the code for the signed-in invitee and continues with the grant', async () => {
    const {
      api: { calls },
    } = renderApp(<InviteLinkPage />, {
      locale: 'en',
      session: signedIn(),
      handlers: {
        'review_invitations.open': () => opened,
        'review_invitations.verify': () => ({ invitation_grant: 'g'.repeat(43), expires_at: '2099-01-01T00:00:00Z', path: 'visit_based' }),
      },
    });
    await screen.findByText('Review your visit to Reza Auto Suspension');
    const boxes = screen.getAllByRole('textbox');
    fireEvent.change(boxes[0]!, { target: { value: '123456' } });
    await waitFor(() => expect(calls.some((c) => c.opId === 'review_invitations.verify')).toBe(true));
    expect(calls.find((c) => c.opId === 'review_invitations.verify')!.args.body).toEqual({ token: 'tok_abcdefgh123', code: '123456' });
    await waitFor(() => expect(goTo).toHaveBeenCalledWith('/en/review/reza-auto?invite=1'));
    expect(grantFor(ORG)).toMatchObject({ grant: 'g'.repeat(43), path: 'visit_based', slug: 'reza-auto' });
    expect(sessionStorage.getItem('cp:link:ri')).toBeNull();
  });

  it('tells another account to switch', async () => {
    renderApp(<InviteLinkPage />, {
      locale: 'en',
      session: signedIn(),
      handlers: {
        'review_invitations.open': () => opened,
        'review_invitations.verify': () => {
          throw new ApiProblem(403, { code: 'LINK_RECIPIENT_MISMATCH' });
        },
      },
    });
    await screen.findByText('Review your visit to Reza Auto Suspension');
    fireEvent.change(screen.getAllByRole('textbox')[0]!, { target: { value: '123456' } });
    expect(await screen.findByText('This link was sent to another account')).toBeTruthy();
  });

  it('explains an expired link with a way to review from the profile', async () => {
    renderApp(<InviteLinkPage />, {
      locale: 'en',
      session: guest,
      handlers: {
        'review_invitations.open': () => {
          throw new ApiProblem(410, { code: 'LINK_EXPIRED' });
        },
      },
    });
    expect(await screen.findByText('This link has expired')).toBeTruthy();
  });
});

describe('/l/cn showcase consent', () => {
  beforeEach(() => {
    forgetFragmentTokens();
    window.history.replaceState(null, '', '/l/cn#tok_consent12345');
  });

  it('shows the exact photos and approves with the policy version', async () => {
    const {
      api: { calls },
    } = renderApp(<ConsentLinkPage policyVersion="2026-10" />, {
      locale: 'en',
      session: signedIn(),
      handlers: {
        'consents.request_view': () => ({
          consent_type: 'showcase_publishing',
          requested_by: {
            id: ORG,
            name: 'Reza Auto Suspension',
            organization_type: 'provider',
            slug: 'reza-auto',
            logo_url: null,
            status: 'active',
            verification_status: 'verified',
          },
          scope: { type: 'portfolio_item', id: ID(6) },
          purpose_i18n_key: 'consent.purpose.portfolio_showcase',
          preview_media_urls: ['https://media.test/a.jpg', 'https://media.test/b.jpg'],
          expires_at: '2026-11-13T10:00:00Z',
        }),
        'consents.request_respond': () => ({ consent: null }),
      },
    });
    expect(await screen.findByText('Reza Auto Suspension would like to show photos of your repair')).toBeTruthy();
    expect(screen.getAllByRole('img', { name: /Photo \d of your repair/ })).toHaveLength(2);
    expect(screen.getByText('Your choice doesn’t affect your review or your service record.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText('Approved')).toBeTruthy();
    expect(calls.find((c) => c.opId === 'consents.request_respond')!.args.body).toEqual({
      token: 'tok_consent12345',
      decision: 'grant',
      policy_version: '2026-10',
    });
  });

  it('asks a guest to log in before showing anything', async () => {
    const {
      api: { calls },
    } = renderApp(<ConsentLinkPage policyVersion="2026-10" />, { locale: 'en', session: guest });
    expect(await screen.findByTestId('consent-signin')).toBeTruthy();
    expect(calls).toHaveLength(0);
  });
});

describe('My Activity reviews', () => {
  const invitation: ReviewInvitation = {
    id: ID(7),
    created_at: '2026-10-29T10:00:00Z',
    updated_at: '2026-10-29T10:00:00Z',
    version: 1,
    subject: {
      id: ORG,
      name: 'Reza Auto Suspension',
      organization_type: 'provider',
      slug: 'reza-auto',
      logo_url: null,
      status: 'active',
      verification_status: 'verified',
    },
    visit: { type: 'appointment', id: APPT },
    channel: 'in_app',
    status: 'sent',
    business_confirmation_given: false,
    reminder_count: 0,
    sent_at: '2026-10-29T10:00:00Z',
    opened_at: null,
    expires_at: '2026-11-05T10:00:00Z',
    invited_display: null,
  };

  it('lists invitations and reviews with their statuses, and withdraws one', async () => {
    localStorage.setItem('cp:review-orgs', JSON.stringify({ [ORG]: { name: 'Reza Auto Suspension', slug: 'reza-auto', as: 'provider' } }));
    let items = [
      review({ id: ID(10), status: 'pending_approval', confirmation_path: 'approval_based', business_confirmation_status: 'pending' }),
      review({ id: ID(11), status: 'rejected', reviewer_reason_code: 'spam' }),
    ];
    const {
      api: { calls },
    } = renderApp(<ActivityReviews />, {
      locale: 'en',
      session: signedIn(),
      handlers: {
        'review_invitations.mine_list': () => ({ items: [invitation], next_cursor: null }),
        'reviews.mine_list': () => ({ items, next_cursor: null }),
        'disputes.mine_list': () => ({ items: [], next_cursor: null }),
        'appointments.list': () => ({ items: [], next_cursor: null }),
        'inquiries.list': () => ({ items: [], next_cursor: null }),
        'reviews.mine_withdraw': () => {
          items = items.slice(1);
          return { ok: true };
        },
      },
    });
    const invite = await screen.findByTestId('review-invitation');
    expect(within(invite).getByRole('link', { name: 'Write a review' }).getAttribute('href')).toBe(
      `/en/review/reza-auto?appointment=${APPT}`,
    );
    const rows = await screen.findAllByTestId('my-review');
    expect(within(rows[0]!).getByText('Waiting for approval')).toBeTruthy();
    expect(within(rows[0]!).getByRole('link', { name: 'Edit' }).getAttribute('href')).toBe(`/en/review/reza-auto?edit=${ID(10)}`);
    expect(within(rows[1]!).getByText('Not published')).toBeTruthy();
    expect(within(rows[1]!).getByText(/Reason: Spam/i)).toBeTruthy();
    expect(within(rows[1]!).getByRole('button', { name: 'Appeal' })).toBeTruthy();

    fireEvent.click(within(rows[0]!).getByRole('button', { name: 'Withdraw' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Withdraw review' }));
    await waitFor(() => expect(calls.some((c) => c.opId === 'reviews.mine_withdraw')).toBe(true));
    await waitFor(() => expect(screen.getAllByTestId('my-review')).toHaveLength(1));
  });
});
