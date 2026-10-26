'use client';
// Client islands of the directory pages: Request appointment on a ranked card (the request step, P10, through the
// auth intent for guests) and the one replay handler for the whole list (the intent registry keeps one handler per
// type, so the buttons only gate and this handler goes to the request step of the intent's target).
import { Button } from '@/components/ds/button';
import { useGatedAction, useIntentHandler } from '@/components/shell/auth-intent';
import { requestHref } from '@/features/profiles';
import { goTo } from '@/lib/browser-nav';
import { useLocale, useT } from '@/lib/i18n/client';

export function DirectoryRequestHandler() {
  const locale = useLocale();
  useIntentHandler<{ location?: string | null }>('request', (intent) => {
    if (intent.target) goTo(requestHref(locale, intent.target, intent.draft?.location ?? null));
  });
  return null;
}

export function RequestAction({ orgId, locationId, name }: { orgId: string; locationId: string | null; name: string }) {
  const t = useT();
  const locale = useLocale();
  const gate = useGatedAction();
  return (
    <Button
      size="sm"
      variant="primary"
      onClick={() =>
        gate({
          type: 'request',
          target: orgId,
          draft: { location: locationId },
          title: t('profiles.intent.request', { name }),
          run: () => goTo(requestHref(locale, orgId, locationId)),
        })
      }
    >
      {t('profiles.request.request')}
    </Button>
  );
}
