// P6.T5/T8 (DOM): the Directions menu builds one link per web app of the region (destination only), remembers the
// chosen app in the cp_nav cookie for guests and in me.preferences (navigation_app_key) when signed in, turns a
// remembered app into a direct link, and shows only the area for approximate addresses.
import type { UserPreference } from '@carpal/api-contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderApp, signedIn } from '../../../tests/support/render-app';
import { DirectionsMenu } from './directions';

vi.mock('next/navigation', () => import('../../../tests/support/next-navigation'));

const point = { lat: 35.7, lng: 51.41 };
const clearCookie = () => (document.cookie = 'cp_nav=; Path=/; Max-Age=0');
/** The menu's popover (the providers render other dialogs too). */
const popover = () => document.querySelector<HTMLElement>('.pwa-directions [popover]')!;
const prefs = (key: string | null): UserPreference =>
  ({
    id: 'p1',
    version: 1,
    navigation_app_key: key,
    calendar_system: 'jalali',
    digit_style: 'persian',
    distance_unit: 'km',
  }) as UserPreference;

afterEach(clearCookie);

describe('Directions menu', () => {
  it('links every web app of the region with the destination only', () => {
    renderApp(<DirectionsMenu point={point} name="Reza Auto" address="14 Sattarkhan St, Tehran" />, { locale: 'en' });
    const menu = popover();
    expect(menu).toHaveAttribute('aria-label', 'Directions to Reza Auto');
    const links = within(menu).getAllByRole('link', { hidden: true });
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      'https://neshan.org/maps/@35.7,51.41,16z',
      'https://balad.ir/location?latitude=35.7&longitude=51.41',
      'https://www.google.com/maps/dir/?api=1&destination=35.7,51.41',
      'https://waze.com/ul?ll=35.7,51.41&navigate=yes',
      'https://www.openstreetmap.org/?mlat=35.7&mlon=51.41#map=17/35.7/51.41',
    ]);
    for (const a of links) expect(a).toHaveAttribute('rel', 'noopener noreferrer');
    expect(within(menu).getByText('14 Sattarkhan St, Tehran')).toBeInTheDocument();
  });

  it('a guest’s remembered choice goes into the cp_nav cookie and becomes a direct link', async () => {
    const { unmount } = renderApp(<DirectionsMenu point={point} />, { locale: 'en' });
    const menu = popover();
    fireEvent.click(within(menu).getByRole('checkbox', { name: 'Remember my choice', hidden: true }));
    fireEvent.click(within(menu).getByRole('link', { name: /Waze/, hidden: true }));
    expect(document.cookie).toContain('cp_nav=waze');
    unmount();
    renderApp(<DirectionsMenu point={point} />, { locale: 'en' });
    expect(await screen.findByRole('link', { name: 'Directions in Waze' })).toHaveAttribute(
      'href',
      'https://waze.com/ul?ll=35.7,51.41&navigate=yes',
    );
    expect(screen.getByRole('button', { name: 'Other map apps' })).toBeInTheDocument();
  });

  it('a signed-in user’s choice is saved as navigation_app_key', async () => {
    const update = vi.fn((args: Record<string, unknown>) => prefs((args.body as { navigation_app_key: string }).navigation_app_key));
    renderApp(<DirectionsMenu point={point} />, {
      locale: 'en',
      session: signedIn(),
      handlers: { 'me.preferences_get': () => prefs('neshan'), 'me.preferences_update': update },
    });
    expect(await screen.findByRole('link', { name: 'Directions in Neshan' })).toBeInTheDocument();
    const menu = popover();
    fireEvent.click(within(menu).getByRole('checkbox', { name: 'Remember my choice', hidden: true }));
    fireEvent.click(within(menu).getByRole('link', { name: /Balad/, hidden: true }));
    await waitFor(() => expect(update).toHaveBeenCalledWith(expect.objectContaining({ body: { navigation_app_key: 'balad' } })));
    expect(document.cookie).not.toContain('cp_nav=');
  });

  it('an approximate address shows the area and says when the exact address comes', () => {
    renderApp(<DirectionsMenu point={point} approximate address="Sattarkhan, Tehran" />, { locale: 'en' });
    const menu = popover();
    expect(menu).toHaveTextContent('Approximate area: Sattarkhan, Tehran');
    expect(menu).toHaveTextContent('The exact address is shared when your appointment is confirmed.');
    expect(within(menu).queryByRole('button', { name: 'Copy address', hidden: true })).toBeNull();
  });
});
