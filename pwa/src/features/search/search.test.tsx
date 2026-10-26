// P6.T8 (DOM): the search hand-over (pending search → search.run → /<locale>/search/<session_id>, BA-16 guest
// request), chip editing and filter URL sync through search.refine, the safety banner with the results still visible,
// the location consent before the browser position (P6.T6), and the header's recent searches. No search text or
// coordinates ever reach a page URL (acceptance criterion 2).
import type { ResultCard, SearchResponse } from '@carpal/api-contracts';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { navigation, router } from '../../../tests/support/next-navigation';
import { renderApp, signedIn, type Handlers } from '../../../tests/support/render-app';
import { PENDING_SEARCH_KEY, SearchBox } from '@/components/shell/search-box';
import { SearchScreen } from './search-page';
import { RECENT_KEY, storeSearch } from './storage';

vi.mock('next/navigation', () => import('../../../tests/support/next-navigation'));
vi.mock('next/link', () => import('../../../tests/support/next-link'));

const BRAND = '0195f3b1-6a2b-7c3d-8e4f-0000000000b1';
const SYSTEM = '0195f3b1-6a2b-7c3d-8e4f-0000000000c1';
const S1 = '0195f3b1-6a2b-7c3d-8e4f-0000000000a1';
const S2 = '0195f3b1-6a2b-7c3d-8e4f-0000000000a2';

function card(id: string, name: string): ResultCard {
  return {
    result_id: id,
    rank: 1,
    target: { type: 'organization', id: `org-${id}` },
    organization: {
      id: `org-${id}`,
      slug: `shop-${id}`,
      name,
      organization_type: 'provider',
      roles: ['provider'],
      verified: true,
      overall_rating: '4.8',
      review_count: 12,
      top_badges: ['verified_business'],
      price_tier: 'mid_range',
      measured_response_time_minutes: null,
      logo_url: null,
      portfolio_thumbnail_url: null,
    },
    item: null,
    location: { location_id: `loc-${id}`, point: { lat: 35.7, lng: 51.4 }, visibility: 'exact', service_radius_km: null, city: 'Tehran' },
    distance_km: '2.4',
    match_score: '0.81',
    confidence: 'high',
    reasons: [
      {
        reason_type: 'capability_evidence',
        summary: { text: 'Specialist in Suspension · 27 verified jobs', locale: 'en' },
        values: { jobs: 27 },
      },
    ],
    explanation: { text: 'Strong evidence for suspension work.', source: 'template' },
    relevant_to_vehicle: null,
    matching_item_count: null,
    next_available_slot: null,
    open_now: true,
    is_sponsored: false,
  };
}

function response(sessionId: string, o: Partial<SearchResponse> = {}): SearchResponse {
  return {
    session_id: sessionId,
    query_normalized: 'clunk over bumps',
    interpreted_intent: {
      target_type: 'provider',
      chips: [
        { kind: 'target_type', text: 'provider', label: { text: 'Shops', locale: 'en' }, removable: false },
        { kind: 'service_system', node_id: SYSTEM, label: { text: 'Suspension', locale: 'en' }, removable: true },
      ],
    },
    interpretation_source: 'rules',
    safety: { flag: false, level: 'none', message_i18n_key: null, urgent_help_available: false },
    results: [card('r1', 'Reza Auto Suspension')],
    next_cursor: null,
    vehicle_filter_fallback: false,
    ...o,
  };
}

const screenProps = { privacyVersion: '2026-10', styleUrl: null, defaultCity: 'tehran' } as const;
const noVehicles = { 'vehicles.list': () => ({ items: [], next_cursor: null }) } satisfies Handlers;

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
});
afterEach(() => vi.unstubAllGlobals());

describe('search hand-over (/search)', () => {
  it('runs the pending search as a guest (car as filters, chosen city) and moves to the session URL without the text', async () => {
    navigation.reset('/en/search');
    sessionStorage.setItem(
      PENDING_SEARCH_KEY,
      JSON.stringify({ text: 'clunk over bumps', vehicle: { brand_node_id: BRAND }, city: 'tehran', entry: 'home', at: Date.now() }),
    );
    const {
      api: { calls },
    } = renderApp(<SearchScreen sessionId={null} {...screenProps} />, {
      locale: 'en',
      handlers: { 'search.run': () => response(S1) },
    });
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith(`/en/search/${S1}?city=tehran&brand=${BRAND}`));
    const run = calls.find((c) => c.opId === 'search.run')!;
    expect(run.args.body).toEqual({
      search_mode: 'all',
      entry_point: 'search_box',
      location: { mode: 'chosen_city', city_key: 'tehran' },
      sort: 'best_match',
      limit: 20,
      query_text: 'clunk over bumps',
      filters: { brand_node_id: BRAND },
      vehicle_filter_applied: true,
    });
    expect(sessionStorage.getItem(PENDING_SEARCH_KEY)).toBeNull();
    expect(JSON.parse(localStorage.getItem(RECENT_KEY)!)[0].text).toBe('clunk over bumps');
    expect(navigation.search).not.toMatch(/clunk|lat|lng/);
  });

  it('without a pending search shows the search entry', () => {
    navigation.reset('/en/search');
    renderApp(<SearchScreen sessionId={null} {...screenProps} />, { locale: 'en' });
    expect(screen.getByRole('heading', { name: 'Find a shop, a part or help for a problem' })).toBeInTheDocument();
  });
});

describe('search results (/search/<session>)', () => {
  function start(handlers: Handlers = {}, o: { session?: ReturnType<typeof signedIn> } = {}) {
    navigation.reset(`/en/search/${S1}?city=tehran`);
    storeSearch(S1, {
      search_mode: 'all',
      entry_point: 'search_box',
      location: { mode: 'chosen_city', city_key: 'tehran' },
      sort: 'best_match',
      limit: 20,
      query_text: 'clunk over bumps',
    });
    return renderApp(<SearchScreen sessionId={S1} {...screenProps} />, {
      locale: 'en',
      ...(o.session ? { session: o.session } : {}),
      handlers: { 'search.run': () => response(S1), ...noVehicles, ...handlers },
    });
  }

  it('re-runs the stored request of the session and shows "Understood as" chips and ranked results with reasons', async () => {
    const {
      api: { calls },
    } = start();
    expect(await screen.findByRole('link', { name: 'Reza Auto Suspension' })).toHaveAttribute('href', '/en/shop/shop-r1');
    expect(calls.find((c) => c.opId === 'search.run')!.args.body).toMatchObject({ query_text: 'clunk over bumps' });
    expect(screen.getByRole('group', { name: 'Understood as' })).toHaveTextContent('Suspension');
    expect(screen.getAllByText('Specialist in Suspension · 27 verified jobs')[0]).toBeInTheDocument();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('removing a chip refines the session with the edited chips and pushes the new session URL', async () => {
    const {
      api: { calls },
    } = start({ 'search.refine': () => response(S2) });
    fireEvent.click(await screen.findByRole('button', { name: 'Remove “Suspension”' }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith(`/en/search/${S2}?city=tehran`, { scroll: false }));
    const refine = calls.find((c) => c.opId === 'search.refine')!;
    expect(refine.args.path).toEqual({ session_id: S1 });
    expect(refine.args.body).toEqual({
      intent_override: { target_type: 'provider', chips: [expect.objectContaining({ kind: 'target_type' })] },
    });
  });

  it('a filter refines at once and is mirrored in the URL (enumerated values only); Back keeps the earlier results', async () => {
    const {
      api: { calls },
    } = start({ 'search.refine': () => response(S2) });
    fireEvent.click(await screen.findByRole('button', { name: /Filters/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /^Open now/ }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith(`/en/search/${S2}?city=tehran&open=1`, { scroll: false }));
    expect(calls.find((c) => c.opId === 'search.refine')!.args.body).toEqual({ filters: { open_now: true } });
    act(() => router.back());
    expect(navigation.search).toBe('city=tehran');
  });

  it('shows the red safety banner above the results, which stay visible', async () => {
    start({
      'search.run': () =>
        response(S1, { safety: { flag: true, level: 'urgent', message_i18n_key: 'safety.brakes', urgent_help_available: true } }),
    });
    const banner = await screen.findByRole('alert');
    expect(banner).toHaveTextContent('Safety words in your search');
    expect(screen.getByRole('link', { name: 'Find urgent help' })).toHaveAttribute('href', '/en/help?urgent=1');
    expect(await screen.findByRole('link', { name: 'Reza Auto Suspension' })).toBeVisible();
  });

  it('asks for the location consent before the browser position, then searches near the user (body only)', async () => {
    const getCurrentPosition = vi.fn((ok: PositionCallback) =>
      ok({ coords: { latitude: 35.712345678, longitude: 51.398765432, accuracy: 42.4 } } as GeolocationPosition),
    );
    vi.stubGlobal('navigator', { ...navigator, geolocation: { getCurrentPosition } });
    const {
      api: { calls },
    } = start(
      {
        'consents.list': () => ({ items: [], next_cursor: null }),
        'consents.grant': () => ({ id: 'c1' }),
        'search.refine': () => response(S2),
      },
      { session: signedIn() },
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Location: Tehran. Change' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Near me' }));
    expect(getCurrentPosition).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: 'Allow and use my location' }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith(`/en/search/${S2}`, { scroll: false }));
    expect(calls.find((c) => c.opId === 'consents.grant')!.args.body).toEqual({
      consent_type: 'location_usage',
      policy_version: '2026-10',
      granted_to: { type: 'platform' },
    });
    expect(calls.find((c) => c.opId === 'search.refine')!.args.body).toEqual({
      location: { mode: 'user_position', point: { lat: 35.71235, lng: 51.39877 }, accuracy_m: 42 },
    });
  });

  it('guests are asked to pick a city or sign in instead of Near me', async () => {
    start();
    fireEvent.click(await screen.findByRole('button', { name: 'Location: Tehran. Change' }));
    expect(screen.queryByRole('button', { name: 'Near me' })).toBeNull();
    expect(screen.getByText('Sign in to search around your position, or pick a city below.')).toBeInTheDocument();
  });
});

describe('header search: recent searches (S-SHARED-01)', () => {
  it('lists the recent searches of this device and runs one again through the hand-over', () => {
    navigation.reset('/en');
    localStorage.setItem(RECENT_KEY, JSON.stringify([{ text: 'brake pads', at: 1 }]));
    renderApp(<SearchBox />, { locale: 'en' });
    fireEvent.focus(screen.getByRole('combobox', { name: 'Search CarPal' }));
    fireEvent.click(screen.getByRole('button', { name: 'brake pads' }));
    expect(JSON.parse(sessionStorage.getItem(PENDING_SEARCH_KEY)!)).toMatchObject({ text: 'brake pads' });
    expect(router.push).toHaveBeenCalledWith('/en/search');
    fireEvent.focus(screen.getByRole('combobox', { name: 'Search CarPal' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove “brake pads” from recent searches' }));
    expect(localStorage.getItem(RECENT_KEY)).toBeNull();
  });
});
