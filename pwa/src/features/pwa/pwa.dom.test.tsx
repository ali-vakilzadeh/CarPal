// P12.T3 (DOM): a web push click opens /notifications?open=<id>, which goes on to that notification's destination;
// the "Push notifications are off" line appears only where this browser and deployment can do web push.
import type { Notification as CpNotification } from '@carpal/api-contracts';
import { render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { navigation, router } from '../../../tests/support/next-navigation';
import { fallbackConfigForTests } from '../../../tests/support/fallback-config';
import { fakeApi, renderApp, signedIn } from '../../../tests/support/render-app';
import { AppProviders } from '@/components/shell/providers';
import { NotificationsScreen } from '@/features/notifications';
import { BUNDLED, NAMESPACES, pickNamespaces } from '@/lib/i18n/dictionary';
import { PushOffBanner } from './push-ui';

vi.mock('next/navigation', () => import('../../../tests/support/next-navigation'));
vi.mock('next/link', () => import('../../../tests/support/next-link'));
vi.mock('@/lib/browser-nav', () => ({ goTo: vi.fn() }));

const FA = BUNDLED.fa;
const KEY = 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U';

const notification = (o: Partial<CpNotification> = {}): CpNotification =>
  ({
    id: 'n1',
    event_type: 'appointment_confirmed',
    category: 'appointments',
    priority: 'normal',
    template_key: 'appointment.confirmed',
    template_params: { provider_name: 'Reza Auto' },
    locale: 'fa',
    organization_context_id: null,
    reference: { type: 'appointment', id: '0195f3b1-6a2b-7c3d-8e4f-00000000a1b2' },
    read_at: null,
    created_at: '2026-10-31T09:00:00Z',
    ...o,
  }) as CpNotification;

afterEach(() => {
  vi.unstubAllGlobals();
  navigation.reset();
});

describe('web push click', () => {
  it('opens the notification named by ?open= and marks it read', async () => {
    navigation.reset('/fa/notifications?open=n1');
    const {
      api: { calls },
    } = renderApp(<NotificationsScreen />, {
      session: signedIn(),
      handlers: {
        'notifications.list': () => ({ items: [notification()], next_cursor: null }),
        'notifications.unread_count': () => ({ count: 1 }),
        'notifications.mark_read': () => ({ ok: true }),
      },
    });
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/fa/appointments/0195f3b1-6a2b-7c3d-8e4f-00000000a1b2'));
    expect(calls.find((c) => c.opId === 'notifications.mark_read')!.args).toMatchObject({ body: { ids: ['n1'] } });
  });

  it('leaves the list open for an id it does not list (a business notification, DI-16)', async () => {
    navigation.reset('/fa/notifications?open=other');
    renderApp(<NotificationsScreen />, {
      session: signedIn(),
      handlers: {
        'notifications.list': () => ({ items: [notification()], next_cursor: null }),
        'notifications.unread_count': () => ({ count: 1 }),
      },
    });
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/fa/notifications', { scroll: false }));
    expect(router.push).not.toHaveBeenCalled();
  });
});

function renderWithKey(ui: ReactNode, vapidPublicKey: string | null) {
  const config = fallbackConfigForTests('fa');
  return render(
    <AppProviders
      locale="fa"
      resources={pickNamespaces(BUNDLED.fa, NAMESPACES)}
      config={{
        flags: {},
        region: config.region,
        taxonomyVersion: 't1',
        i18nVersion: 'bundled',
        source: 'live',
        pwa: { vapidPublicKey, portalUrl: 'https://portal.carpal.app' },
      }}
      timeZone="UTC"
      themeChoice="light"
      theme="light"
      consent={{ analytics: false }}
      session={signedIn()}
      sessionConfirmed
      apiClient={fakeApi().client}
    >
      {ui}
    </AppProviders>,
  );
}

describe('push off line', () => {
  it('is offered only with a VAPID key and a browser that can do web push', async () => {
    const { unmount } = renderWithKey(<PushOffBanner />, KEY);
    // jsdom has no Push API: nothing.
    expect(screen.queryByText(FA.pwa.push.offBanner)).toBeNull();
    unmount();

    vi.stubGlobal('PushManager', function PushManager() {});
    vi.stubGlobal(
      'Notification',
      Object.assign(function Notification() {}, { permission: 'default' }),
    );
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { ready: new Promise(() => undefined) } });
    try {
      const a = renderWithKey(<PushOffBanner />, KEY);
      expect(await screen.findByText(FA.pwa.push.offBanner)).toBeInTheDocument();
      a.unmount();
      renderWithKey(<PushOffBanner />, null);
      expect(screen.queryByText(FA.pwa.push.offBanner)).toBeNull();
    } finally {
      Reflect.deleteProperty(navigator, 'serviceWorker');
      Reflect.deleteProperty(window, 'isSecureContext');
    }
  });
});
