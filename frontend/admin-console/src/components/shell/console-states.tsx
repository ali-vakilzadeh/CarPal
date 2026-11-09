// The no-permission and not-found states of console pages (AC4.T6), rendered by the page itself inside the shell.
// Console pages never call forbidden() or notFound(): in Next.js 16.4.3 either one thrown by a page escapes the
// server render (Fizz cannot catch it inside the client boundary; PWA P3 found the same), so the response is an empty
// <html id="__next_error__"> shell drawn on the client, and the console's enforced Trusted Types CSP blocks that draw
// (the shell carries none of the root layout's head, so no "default" policy exists): a blank page. Deviation D-26.
// The answer is 200 with this state; the server still refuses every call the role may not make (GD-09).
import { SystemPage } from '@/components/shell/system-page';
import type { StaffRole } from '@/lib/api/generated';
import type { Translate } from '@/lib/i18n/keys';

/** No access: names the roles that may open the page; "Request access" is text until the staff directory (BR-10). */
export function NoPermission({ t, roles, roleNames }: { t: Translate; roles: readonly StaffRole[]; roleNames: string }) {
  return (
    <div data-testid="no-permission">
      <SystemPage kind="forbidden" t={t}>
        {roles.length ? <p data-testid="forbidden-roles">{t('admin.system.forbidden.needs', { roles: roleNames })}</p> : null}
        <p className="adm-muted">{t('admin.system.forbidden.request')}</p>
      </SystemPage>
    </div>
  );
}

export function NotFoundState({ t }: { t: Translate }) {
  return (
    <div data-testid="not-found">
      <SystemPage kind="notFound" t={t} />
    </div>
  );
}
