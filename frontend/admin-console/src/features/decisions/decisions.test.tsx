// AC14-2 DOM tests of My decisions (admin.my_decisions_list): no purpose header, the kind filter goes to the query,
// the labels of both kinds, the truncated note, the empty state; axe in EN and FA.
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffDecision } from '@carpal/api-contracts';
import { axeViolations, renderConsole, scriptedTransport } from '../../../tests/support/console-harness';
import { nav, resetNav } from '../../../tests/support/navigation-mock';
import type { Locale } from '@/lib/i18n/locales';
import { DecisionsPage } from './decisions-page';

vi.mock('next/navigation', async () => (await import('../../../tests/support/navigation-mock')).navigationMock());

const ago = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
const org = {
  id: '0193a3c4-5d6e-7f80-9a1b-0000000000a1',
  name: 'Pars Auto',
  organization_type: 'provider',
  slug: 'pars-auto',
  logo_url: null,
  status: 'active',
  verification_status: 'verified',
} as const;

const approval: StaffDecision = {
  kind: 'approval',
  decided_at: ago(2),
  decision: 'approved',
  reason_code: 'customer_confirmed',
  review_id: '0193a3c4-5d6e-7f80-9a1b-0000000000r1',
  review_status: 'published',
  dispute_id: null,
  dispute_type: null,
  dispute_status: null,
  subject: org,
};
const dispute: StaffDecision = {
  kind: 'dispute',
  decided_at: ago(30),
  decision: 'withdrawn',
  reason_code: null,
  review_id: null,
  review_status: null,
  dispute_id: '0193a3c4-5d6e-7f80-9a1b-0000000000d1',
  dispute_type: 'badge_challenge',
  dispute_status: 'withdrawn',
  subject: org,
};

const handlers = (truncated = false) =>
  scriptedTransport({
    'admin.my_decisions_list': (req) =>
      Response.json({
        items: req.search.includes('kind=dispute') ? [dispute] : req.search.includes('kind=approval') ? [approval] : [approval, dispute],
        truncated,
      }),
  });

beforeEach(() => resetNav('/decisions'));

describe('My decisions (AC14-2)', () => {
  it('lists both kinds without a purpose, and the kind filter narrows the read', async () => {
    const { transport, calls } = handlers();
    renderConsole(<DecisionsPage />, { transport, roles: ['CRV'] });
    const table = await screen.findByRole('table', { name: 'My decisions' });
    const first = (await within(table).findAllByText('Review approval', { selector: 'td' }))[0]!.closest('tr')!;
    expect(first).toHaveTextContent('Confirmed');
    expect(first).toHaveTextContent('Pars Auto');
    expect(first).toHaveTextContent('Published');
    expect(first).toHaveTextContent('The business confirmed the customer');
    const second = within(table).getByText('Badge challenge').closest('tr')!;
    expect(second).toHaveTextContent('Withdrawn on request');
    expect(calls[0]!.headers.get('carpal-access-purpose')).toBeNull();
    fireEvent.change(screen.getByRole('combobox', { name: 'Kind' }), { target: { value: 'dispute' } });
    await waitFor(() => expect(nav.search).toContain('kind=dispute'));
    await waitFor(() => expect(calls.at(-1)!.search).toContain('kind=dispute'));
    await waitFor(() => expect(within(table).queryByText('The business confirmed the customer')).toBeNull());
  });

  it('says when the list is cut short, and when it is empty', async () => {
    const { transport } = handlers(true);
    renderConsole(<DecisionsPage />, { transport, roles: ['MOD'] });
    expect(await screen.findByText('Only the newest decisions are listed.')).toBeInTheDocument();
  });

  for (const locale of ['en', 'fa'] as Locale[]) {
    it(`axe: no violations (${locale})`, async () => {
      const { transport } = handlers();
      renderConsole(<DecisionsPage />, { transport, roles: ['MOD'], locale });
      await screen.findAllByText(locale === 'en' ? 'Pars Auto' : 'Pars Auto');
      expect(await axeViolations()).toEqual([]);
    });
  }
});
