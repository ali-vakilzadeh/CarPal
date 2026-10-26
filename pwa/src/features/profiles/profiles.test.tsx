// P5 public-page components with fixtures: header band and badges, Follow/Save through the auth intent, reviews with
// labels and Helpful, the Request card (slots, Request anyway, Call reveal, DI-10 selection), seller parts with the
// anti-scraping rule, the before/after slider, Ask about stock and the showcase body.
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { part, providerProfile, review, showcase, vendorProfile } from '../../../tests/support/public-fixtures';
import { guest, renderApp, signedIn } from '../../../tests/support/render-app';
import { navigation } from '../../../tests/support/next-navigation';
import { ApiProblem } from '@/lib/api';
import { createFormatter } from '@/lib/format';
import { getTranslator } from '@/lib/i18n/dictionary';
import { BeforeAfter } from './before-after';
import { Capabilities } from './capabilities';
import { OrgHeader } from './header';
import { AskAboutStock, FitmentTable } from './part-detail';
import { RequestCard } from './request-card';
import { ReviewList } from './reviews';
import { SEARCH_ORIGIN_KEY, saveSearchOrigin } from './search-origin';
import { ShowcaseBody } from './showcase';
import { VendorParts } from './vendor-parts';

vi.mock('next/navigation', () => import('../../../tests/support/next-navigation'));

const t = getTranslator('en');
const f = createFormatter('en', t, 'UTC');

beforeEach(() => {
  navigation.reset('/en/shop/reza-auto-suspension');
  sessionStorage.clear();
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
});

describe('header band (W-PUB-02/03)', () => {
  it('shows name, type, badges with explanations, rating, area, response time and the actions', () => {
    const p = providerProfile();
    renderApp(<OrgHeader profile={p} as="provider" path="/en/shop/reza" t={t} f={f} />, { locale: 'en' });
    expect(screen.getByRole('heading', { level: 1, name: 'Reza Auto Suspension' })).toBeInTheDocument();
    expect(screen.getByText('Garage')).toBeInTheDocument();
    const verified = screen.getByRole('button', { name: 'Verified Business' });
    expect(verified).toHaveAttribute('popovertarget');
    expect(document.getElementById(verified.getAttribute('popovertarget')!)).toHaveTextContent('licence, address and owner identity');
    expect(screen.getByRole('button', { name: 'Make specialist · BMW' })).toBeInTheDocument();
    expect(screen.getByText('Rated 4.7 out of 5')).toBeInTheDocument();
    expect(screen.getByText('· 126 reviews')).toBeInTheDocument();
    expect(screen.getByText('Usually replies within 40 min')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Follow' })).toBeInTheDocument();
  });

  it('shows "Verification pending" instead of the badge, and seller facts for vendors', () => {
    renderApp(<OrgHeader profile={vendorProfile({ verified: false })} as="vendor" path="/en/parts-seller/mina" t={t} f={f} />, {
      locale: 'en',
    });
    expect(screen.getByRole('button', { name: 'Verification pending' })).toBeInTheDocument();
    expect(screen.getByText('Parts retailer')).toBeInTheDocument();
    expect(screen.getByText('· Pickup')).toBeInTheDocument();
  });

  it('Follow as a guest opens the sign-in context modal; signed in it follows with Undo', async () => {
    const p = providerProfile();
    const { unmount } = renderApp(<OrgHeader profile={p} as="provider" path="/en/shop/reza" t={t} f={f} />, {
      locale: 'en',
      session: guest,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Follow' }));
    expect(screen.getByRole('dialog', { name: 'Sign in to follow Reza Auto Suspension' })).toBeInTheDocument();
    unmount();

    const { api } = renderApp(<OrgHeader profile={p} as="provider" path="/en/shop/reza" t={t} f={f} />, {
      locale: 'en',
      session: signedIn(),
      handlers: {
        'follows.list': () => ({ items: [], next_cursor: null }),
        'favorites.list': () => ({ items: [], next_cursor: null }),
        'follows.put': () => ({}),
        'follows.delete': () => ({ ok: true }),
      },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Follow' }));
    expect(await screen.findByText('You are following Reza Auto Suspension')).toBeInTheDocument();
    expect(api.api).toHaveBeenCalledWith('follows.put', { path: { org_id: p.id }, body: { notification_preference: 'all' } });
    expect(await screen.findByRole('button', { name: 'Following' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(api.api).toHaveBeenCalledWith('follows.delete', { path: { org_id: p.id } }));
  });
});

describe('reviews', () => {
  it('labels every review, shows context, tags and the reply, and asks guests to sign in for Helpful', () => {
    renderApp(
      <ReviewList
        orgId="o1"
        orgName="Reza Auto Suspension"
        initial={{
          items: [review(), review({ id: 'r2', label: 'approved_by_business_and_carpal', disputed_by_business: true, response: null })],
          next_cursor: null,
        }}
      />,
      {
        locale: 'en',
      },
    );
    expect(screen.getByRole('button', { name: 'Verified visit' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approved by the business and CarPal' })).toBeInTheDocument();
    expect(screen.getByText('Disputed by the business')).toBeInTheDocument();
    expect(screen.getAllByText('BMW 3 Series E90 · Suspension')).toHaveLength(2);
    expect(screen.getByText('Reply from Reza Auto Suspension')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Helpful · 12' })[0]!);
    expect(screen.getByRole('dialog', { name: 'Sign in to mark this review helpful' })).toBeInTheDocument();
  });

  it('marks a review helpful for a signed-in user and filters through the API', async () => {
    const { api } = renderApp(<ReviewList orgId="o1" orgName="Reza" initial={{ items: [review()], next_cursor: null }} />, {
      locale: 'en',
      session: signedIn(),
      handlers: { 'reactions.put': () => ({ count: 13 }), 'public.org_reviews': () => ({ items: [], next_cursor: null }) },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Helpful · 12' }));
    expect(await screen.findByRole('button', { name: 'Helpful · 13' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Verified visit only' }));
    expect(await screen.findByText('No reviews match these filters.')).toBeInTheDocument();
    expect(api.api).toHaveBeenCalledWith(
      'public.org_reviews',
      expect.objectContaining({ query: expect.objectContaining({ path: 'visit_based' }) }),
    );
  });

  it('shows the empty state', () => {
    renderApp(<ReviewList orgId="o1" orgName="Reza" initial={{ items: [], next_cursor: null }} />, { locale: 'en' });
    expect(screen.getByText('No reviews yet')).toBeInTheDocument();
  });
});

describe('request card', () => {
  const props = {
    orgId: 'o1',
    slug: 'reza',
    name: 'Reza',
    rating: '4.70',
    locationId: 'l1',
    capabilities: [],
    todayHours: 'Today: 08:00–18:00',
  };

  it('offers "Request anyway" without published slots, grouped slots otherwise', () => {
    const { unmount } = renderApp(<RequestCard {...props} slots={[]} />, { locale: 'en' });
    expect(screen.getByRole('button', { name: 'Request anyway' })).toBeInTheDocument();
    expect(screen.getByText('Next openings not published. You can still send a request.')).toBeInTheDocument();
    unmount();
    const slot = (h: string) => ({
      start_at: `2026-10-26T${h}:00Z`,
      end_at: `2026-10-26T${h}:00Z`,
      location_id: 'l1',
      appointment_types: [],
    });
    renderApp(<RequestCard {...props} slots={[slot('08'), slot('09')]} />, { locale: 'en' });
    expect(screen.getByRole('button', { name: 'Request appointment' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Choose a time to request' })).toHaveTextContent('Monday, October 26');
    expect(screen.getAllByRole('button', { name: /Monday, October 26 \d/ })).toHaveLength(2);
  });

  it('asks a guest to sign in before the request step', () => {
    renderApp(<RequestCard {...props} slots={[]} />, { locale: 'en' });
    fireEvent.click(screen.getByRole('button', { name: 'Request anyway' }));
    expect(screen.getByRole('dialog', { name: 'Sign in to request an appointment with Reza' })).toBeInTheDocument();
  });

  it('reveals the number on Call and counts a selected search result (DI-10)', async () => {
    saveSearchOrigin({ orgId: 'o1', sessionId: 's1', resultId: 'r1' });
    const { api } = renderApp(<RequestCard {...props} slots={[]} />, {
      locale: 'en',
      handlers: {
        'public.org_get': () => providerProfile(),
        'search.result_event': () => ({ ok: true }),
      },
    });
    expect(screen.queryByText('+982166001122')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Call' }));
    const link = await screen.findByRole('link', { name: /Call · \+982166001122/ });
    expect(link).toHaveAttribute('href', 'tel:+982166001122');
    expect(api.api).toHaveBeenCalledWith('search.result_event', {
      path: { session_id: 's1', result_id: 'r1' },
      body: { event: 'selected' },
    });
    expect(sessionStorage.getItem(SEARCH_ORIGIN_KEY)).toBeNull();
  });
});

describe('capabilities', () => {
  it('renders the matrix by vehicle and repair area and the self-declared group', () => {
    renderApp(<Capabilities provider={providerProfile().provider!} />, { locale: 'en' });
    const table = screen.getByRole('table', { name: 'Capabilities by vehicle and repair area' });
    expect(within(table).getByRole('columnheader', { name: 'Suspension' })).toBeInTheDocument();
    expect(within(table).getByRole('rowheader', { name: 'BMW 3 Series E90' })).toBeInTheDocument();
    expect(within(table).getByText('Specialist')).toBeInTheDocument();
    expect(screen.getByText('Self-declared (not yet proven)')).toBeInTheDocument();
  });
});

describe('seller parts (W-PUB-03)', () => {
  it('shows the first page without paging, and searches by text with paging', async () => {
    const card = { ...part(), fitment_confidence_for_vehicle: null };
    const { api } = renderApp(
      <VendorParts
        orgId="v1"
        vendorSlug="mina-parts"
        categories={[{ id: 'pc-1', label: 'Control arms' }]}
        initial={{ items: [card], next_cursor: 'c2' }}
        initialCategory="pc-1"
      />,
      { locale: 'en', handlers: { 'public.org_inventory_search': () => ({ items: [card], next_cursor: 'c3' }) } },
    );
    expect(screen.getByRole('link', { name: 'Front control arm' })).toHaveAttribute(
      'href',
      `/en/parts/mina-parts/${card.id}-front-control-arm`,
    );
    expect(screen.getByText('$45')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show more parts' })).toBeNull();
    expect(screen.getByText('Search by name or number to see more parts from this seller.')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: 'Search this seller' }), { target: { value: 'arm' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByRole('button', { name: 'Show more parts' })).toBeInTheDocument();
    expect(api.api).toHaveBeenCalledWith(
      'public.org_inventory_search',
      expect.objectContaining({ body: expect.objectContaining({ text: 'arm', part_category_node_id: 'pc-1' }) }),
    );
  });
});

describe('part page pieces (W-PUB-08)', () => {
  it('lists the fitment with confidence labels', () => {
    renderApp(<FitmentTable fitment={part().fitment} />, { locale: 'en' });
    expect(screen.getAllByRole('rowheader')[0]).toHaveTextContent('BMW 3 Series E90 · 2005–2012');
    expect(screen.getByText('Confirmed')).toBeInTheDocument();
    expect(screen.getByText('Likely')).toBeInTheDocument();
  });

  it('sends a stock inquiry for a signed-in user and explains a duplicate', async () => {
    let calls = 0;
    const { api } = renderApp(
      <AskAboutStock itemId="i1" itemName="Front control arm" vendorName="Mina Parts" outOfStock={false} policyVersion="2026-10" />,
      {
        locale: 'en',
        session: signedIn(),
        handlers: {
          'vehicles.list': () => ({ items: [], next_cursor: null }),
          'inquiries.create': () => {
            calls++;
            if (calls > 1) throw new ApiProblem(409, { code: 'DUPLICATE' });
            return {};
          },
        },
      },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Ask about stock' }));
    const dialog = screen.getByRole('dialog', { name: 'Ask about stock' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'More' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send inquiry' }));
    expect(await screen.findByText('Inquiry sent to Mina Parts')).toBeInTheDocument();
    expect(api.api).toHaveBeenCalledWith('inquiries.create', {
      body: { inventory_item_id: 'i1', quantity: 2, message: 'Is this part in stock? Does it fit my car?', content_locale: 'en' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Ask about stock' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Ask about stock' })).getByRole('button', { name: 'Send inquiry' }));
    expect(await screen.findByText('You already have an open inquiry about this part.')).toBeInTheDocument();
  });

  it('asks a guest to sign in first', () => {
    renderApp(<AskAboutStock itemId="i1" itemName="Arm" vendorName="Mina Parts" outOfStock policyVersion="v" />, { locale: 'en' });
    fireEvent.click(screen.getByRole('button', { name: "Ask when it's back" }));
    expect(screen.getByRole('dialog', { name: 'Sign in to ask Mina Parts about this part' })).toBeInTheDocument();
  });
});

describe('showcase (W-PUB-05)', () => {
  it('shows labels, the before/after slider, text and the provider card', () => {
    renderApp(<ShowcaseBody item={showcase()} locale="en" t={t} f={f} />, { locale: 'en' });
    expect(screen.getByRole('heading', { level: 1, name: 'Worn front control arm bushing replaced' })).toBeInTheDocument();
    expect(screen.getByText('Showcase')).toBeInTheDocument();
    expect(screen.getByRole('slider', { name: 'Comparison position' })).toHaveValue('50');
    expect(screen.getByRole('link', { name: 'Reza Auto Suspension' })).toHaveAttribute('href', '/en/shop/reza-auto-suspension');
  });

  it('moves the comparison with the range and toggles with the button', () => {
    const s = showcase();
    renderApp(<BeforeAfter before={s.media[0]!} after={s.media[1]!} />, { locale: 'en' });
    const range = screen.getByRole('slider', { name: 'Comparison position' });
    act(() => {
      fireEvent.change(range, { target: { value: '80' } });
    });
    expect(range).toHaveAttribute('aria-valuetext', 'Before 80% · After 20%');
    fireEvent.click(screen.getByRole('button', { name: 'After' }));
    expect(range).toHaveValue('0');
  });

  it('shows a placeholder while photos are under review', () => {
    renderApp(<BeforeAfter before={null} after={{ ...showcase().media[1]!, url: null }} />, { locale: 'en' });
    expect(screen.getByText('Photos are being reviewed')).toBeInTheDocument();
  });
});
