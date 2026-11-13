// DOM-test harness for the admin kit and console pages (AC5.T8): the providers a console page runs in (translations,
// formatters, the API client over a scripted transport, keyboard shortcuts and step-up), a staff session per role
// set, a recording transport, the BFF endpoints the shell calls (/bff/session, /bff/csrf, /bff/intents) and axe in
// jsdom. Mock next/navigation with tests/support/navigation-mock.ts in the test file first.
import { render } from '@testing-library/react';
import axe from 'axe-core';
import type { ReactNode } from 'react';
import { vi } from 'vitest';
import type { StaffOrgSearchRow, StaffOrgView } from '@carpal/api-contracts';
import { headOf } from '@/features/orgs/org-logic';
import { ShortcutProvider } from '@/features/shell/shortcuts';
import { StepUpProvider } from '@/features/shell/step-up';
import { createApiClient, type Transport, type TransportRequest } from '@/lib/api/client';
import type { AdminOperationId, StaffRole } from '@/lib/api/generated';
import { ApiProvider, createQueryClient } from '@/lib/api/query';
import type { SessionView } from '@/lib/api/session';
import { FormatProvider } from '@/lib/format/client';
import { I18nProvider } from '@/lib/i18n/client';
import { BUNDLED, pickNamespaces } from '@/lib/i18n/dictionary';
import { directionOf, type Locale } from '@/lib/i18n/locales';

export function staffView(
  roles: StaffRole[],
  o: { id?: string; name?: string; intents?: SessionView['pending_intents'] } = {},
): SessionView {
  const now = Date.now();
  return {
    signed_in: true,
    staff: {
      id: o.id ?? 'staff-1',
      display_name: o.name ?? 'Sara Staff',
      roles,
      locale: 'en',
      timezone: 'Asia/Tehran',
      acr: 'aal3',
      auth_time: new Date(now - 60_000).toISOString(),
    },
    locale: 'en',
    idle_expires_at: new Date(now + 30 * 60_000).toISOString(),
    expires_at: new Date(now + 8 * 3_600_000).toISOString(),
    pending_intents: o.intents ?? [],
    server_time: new Date(now).toISOString(),
  };
}

export interface RecordedCall {
  opId: AdminOperationId;
  method: string;
  path: string;
  search: string;
  headers: Headers;
  body: Record<string, unknown> | null;
}

export type Handler = (req: TransportRequest, body: Record<string, unknown> | null) => Response | Promise<Response>;

/** A transport that answers per operation (unknown operations: 404) and records every call. */
export function scriptedTransport(handlers: Partial<Record<AdminOperationId, Handler>>) {
  const calls: RecordedCall[] = [];
  const transport: Transport = async (req) => {
    const body = req.body ? (JSON.parse(req.body) as Record<string, unknown>) : null;
    calls.push({ opId: req.opId, method: req.method, path: req.path, search: req.search, headers: req.headers, body });
    const h = handlers[req.opId];
    return h ? h(req, body) : Response.json({ code: 'NOT_FOUND', title: 'not scripted' }, { status: 404 });
  };
  return { transport, calls };
}

export const page = <T,>(items: T[], next: string | null = null) => Response.json({ items, next_cursor: next });

/** The admin.orgs_search row of a full organization view (backend S14: no contact data, no points). */
export const searchRow = (o: StaffOrgView): StaffOrgSearchRow => ({
  ...headOf(o),
  member_count: o.member_count,
  trust_score: o.trust_score,
  created_at: o.created_at,
});
export const problem = (status: number, code: string, headers: Record<string, string> = {}) =>
  Response.json(
    { code, title: code, request_id: 'req-1' },
    { status, headers: { 'content-type': 'application/problem+json', ...headers } },
  );

/** BFF endpoints the shell and step-up call (session view, CSRF, saving and taking a pending action). */
export function mockBff(o: { session: () => SessionView; consume?: (id: string) => unknown }) {
  const posted: { url: string; body: unknown }[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/bff/session') return Response.json(o.session());
    if (url === '/bff/csrf') return Response.json({ csrf_token: 'csrf' });
    posted.push({ url, body: init?.body ? JSON.parse(init.body as string) : null });
    if (url === '/bff/intents') return Response.json({ intent_id: 'intent-1' }, { status: 201 });
    const m = /^\/bff\/intents\/([^/]+)\/consume$/.exec(url);
    if (m) {
      const intent = o.consume?.(decodeURIComponent(m[1]!));
      return intent ? Response.json(intent) : Response.json({ code: 'NOT_FOUND' }, { status: 404 });
    }
    return new Response('{}', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { posted, fetchMock };
}

export function renderConsole(
  ui: ReactNode,
  o: { roles?: StaffRole[]; locale?: Locale; transport?: Transport; session?: SessionView; consume?: (id: string) => unknown } = {},
) {
  const locale = o.locale ?? 'en';
  const session = o.session ?? staffView(o.roles ?? ['ADM']);
  const bff = mockBff({ session: () => session, ...(o.consume ? { consume: o.consume } : {}) });
  const api = createApiClient({
    transport: o.transport ?? scriptedTransport({}).transport,
    sleep: async () => undefined,
  });
  const queryClient = createQueryClient();
  document.documentElement.lang = locale;
  document.documentElement.dir = directionOf(locale);
  const result = render(
    <I18nProvider locale={locale} resources={pickNamespaces(BUNDLED[locale])}>
      <FormatProvider timeZone="Asia/Tehran" distanceUnit="km">
        <ApiProvider client={api} queryClient={queryClient} initialSession={session}>
          <ShortcutProvider>
            <StepUpProvider>
              <main>{ui}</main>
            </StepUpProvider>
          </ShortcutProvider>
        </ApiProvider>
      </FormatProvider>
    </I18nProvider>,
  );
  return { ...result, api, queryClient, bff };
}

/** axe in jsdom (no layout, so colour contrast is checked in the E2E run instead). */
export async function axeViolations(node: Element = document.body): Promise<string[]> {
  const r = await axe.run(node, { rules: { 'color-contrast': { enabled: false } } });
  return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}
