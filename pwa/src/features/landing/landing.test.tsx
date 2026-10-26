// W-PUB-01: the hero hands the query, the guest's car (as filters, BA-16) and the city to the search page without the
// URL (GD-14); the showcase teasers read the server-defined feed cards defensively.
import { fireEvent, screen } from '@testing-library/react';
import type { FeedItem } from '@carpal/api-contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { navigation, router } from '../../../tests/support/next-navigation';
import { renderApp } from '../../../tests/support/render-app';
import { PENDING_SEARCH_KEY } from '@/components/shell/search-box';
import { LandingHero } from './hero';
import { showcaseTeasers } from './feed';

vi.mock('next/navigation', () => import('../../../tests/support/next-navigation'));

beforeEach(() => {
  navigation.reset('/en');
  sessionStorage.clear();
});

const nodes = (items: { id: string; text: string }[]) => ({
  items: items.map((n) => ({ id: n.id, name: { text: n.text, locale: 'en' }, type: 'x', status: 'active', sort_order: 0 })),
  next_cursor: null,
});

describe('landing hero', () => {
  it('needs a problem or a car', () => {
    renderApp(<LandingHero city="tehran" />, { locale: 'en' });
    fireEvent.click(screen.getByRole('button', { name: 'Find specialists' }));
    expect(screen.getByText('Tell us what is wrong or what you need.')).toBeInTheDocument();
    expect(router.push).not.toHaveBeenCalled();
  });

  it('saves the query, the car as filters and the city, then opens the search page', async () => {
    renderApp(<LandingHero city="tehran" />, {
      locale: 'en',
      handlers: {
        'taxonomy.snapshot': (args) => {
          const q = (args as { query: { type: string } }).query;
          return q.type === 'vehicle_brand' ? nodes([{ id: 'b-bmw', text: 'BMW' }]) : nodes([{ id: 'm-3', text: '3 Series' }]);
        },
      },
    });
    await screen.findByRole('option', { name: 'BMW' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Brand' }), { target: { value: 'b-bmw' } });
    fireEvent.change(screen.getByRole('textbox', { name: "What's wrong / what do you need?" }), { target: { value: 'clunk over bumps' } });
    fireEvent.click(screen.getByRole('button', { name: 'Find specialists' }));
    expect(router.push).toHaveBeenCalledWith('/en/search');
    expect(JSON.parse(sessionStorage.getItem(PENDING_SEARCH_KEY)!)).toMatchObject({
      text: 'clunk over bumps',
      vehicle: { brand_node_id: 'b-bmw' },
      city: 'tehran',
    });
  });
});

describe('showcase teasers', () => {
  it('reads showcase cards and skips other kinds and broken shapes', () => {
    const items = [
      {
        kind: 'showcase',
        ref: { type: 'portfolio_item', id: 's1' },
        card: {
          title: 'Arm replaced',
          organization: { name: 'Reza' },
          service_system: { text: 'Suspension' },
          thumbnail_url: 'https://m/t.jpg',
        },
      },
      { kind: 'nearby_provider', ref: { type: 'organization', id: 'o1' }, card: { title: 'x' } },
      { kind: 'showcase', ref: { type: 'portfolio_item', id: 's2' }, card: { title: 42 } },
    ] as unknown as FeedItem[];
    expect(showcaseTeasers(items)).toEqual([
      { id: 's1', title: 'Arm replaced', system: 'Suspension', organization: { name: 'Reza' }, thumbnailUrl: 'https://m/t.jpg' },
    ]);
  });
});
