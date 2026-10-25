// Renders UI inside the real client providers of the [locale] layout with a fake typed client, a seeded session
// and the bundled dictionary. Pair with the next/navigation and next/link doubles in the test file.
import type { OperationId } from '@carpal/api-contracts';
import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { vi } from 'vitest';
import { AppProviders } from '@/components/shell/providers';
import { fallbackConfigForTests } from './fallback-config';
import type { Consent } from '@/lib/analytics/consent';
import type { ApiClient } from '@/lib/api/client';
import { EtagCache } from '@/lib/api/client';
import { ApiProblem } from '@/lib/api/problem';
import { OperationGate } from '@/lib/api/retry';
import type { SessionView } from '@/lib/api/session';
import { BUNDLED, NAMESPACES, pickNamespaces } from '@/lib/i18n/dictionary';
import type { Locale } from '@/lib/i18n/locales';

export type Handlers = Partial<Record<OperationId, (args: Record<string, unknown>) => unknown>>;

export function fakeApi(handlers: Handlers = {}) {
  const calls: { opId: string; args: Record<string, unknown> }[] = [];
  const api = vi.fn(async (opId: string, args: Record<string, unknown> = {}) => {
    calls.push({ opId, args });
    const h = handlers[opId as OperationId];
    if (!h) throw new ApiProblem(501, { code: 'NOT_IMPLEMENTED' });
    return h(args);
  });
  const client = {
    api,
    call: vi.fn(async (opId: string, args: Record<string, unknown>) => ({ data: await api(opId, args), status: 200, etag: null })),
    etags: new EtagCache(),
    gate: new OperationGate(),
  } as unknown as ApiClient;
  return { client, calls, api };
}

export const signedIn = (name = 'Sara M.', intents: SessionView['pending_intents'] = []): SessionView => ({
  signed_in: true,
  user: { id: 'u1', display_name: name, acr: 'aal1', auth_time: 0 },
  locale: 'fa',
  pending_intents: intents,
});

export const guest: SessionView = { signed_in: false, user: null, locale: null, pending_intents: [] };

export function renderApp(
  ui: ReactNode,
  o: {
    locale?: Locale;
    session?: SessionView;
    handlers?: Handlers;
    consent?: Consent | null;
    flags?: Record<string, boolean>;
    taxonomyVersion?: string;
  } = {},
) {
  const locale = o.locale ?? 'fa';
  const api = fakeApi(o.handlers);
  const config = fallbackConfigForTests(locale);
  const utils = render(
    <AppProviders
      locale={locale}
      resources={pickNamespaces(BUNDLED[locale], NAMESPACES)}
      config={{
        flags: o.flags ?? {},
        region: config.region,
        taxonomyVersion: o.taxonomyVersion ?? 't1',
        i18nVersion: 'bundled',
        source: 'live',
      }}
      timeZone="UTC"
      themeChoice="light"
      theme="light"
      consent={o.consent === undefined ? { analytics: false } : o.consent}
      session={o.session ?? guest}
      sessionConfirmed
      apiClient={api.client}
    >
      {ui}
    </AppProviders>,
  );
  return { ...utils, api };
}
