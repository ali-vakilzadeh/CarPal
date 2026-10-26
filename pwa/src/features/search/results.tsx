'use client';
// The result list of W-SRCH-01 (Docs/22 "Centre: results", Docs/21 C-SEARCH-01): the cards with their actions, the
// open tracking and the hover link to the map pane.
//   - Opening a card is a normal link (a click opens the profile in this tab, Ctrl/Cmd-click or a middle click a new
//     one); on the way the list records search.result_event 'viewed', the registered search.result_opened event and
//     the search origin, so a Call on the profile can send 'selected' (DI-10).
//   - Request appointment (providers) goes to the request step (P10) through the auth intent for guests and sends
//     'selected'; parts sellers and parts offer Ask about part (their page).
import type { ResultCard } from '@carpal/api-contracts';
import type { MouseEvent } from 'react';
import { Button, buttonClass } from '@/components/ds/button';
import { useGatedAction, useIntentHandler } from '@/components/shell/auth-intent';
import { requestHref, saveSearchOrigin } from '@/features/profiles';
import { useAnalytics } from '@/lib/analytics/client';
import { goTo } from '@/lib/browser-nav';
import { useFormat } from '@/lib/format/client';
import { useLocale, useT } from '@/lib/i18n/client';
import { sellerPath } from '@/lib/seo/urls';
import { ResultCardView, resultHref } from './result-card';
import { useResultEvent } from './use-search';

export function ResultList({
  results,
  sessionId,
  bestMatch,
  highlightedId,
  onHover,
  label,
}: {
  results: readonly ResultCard[];
  sessionId: string;
  bestMatch: boolean;
  /** Location id of the place hovered or selected on the map. */
  highlightedId: string | null;
  onHover?: (locationId: string | null) => void;
  label: string;
}) {
  const t = useT();
  const f = useFormat();
  const locale = useLocale();
  const gate = useGatedAction();
  const { track } = useAnalytics();
  const resultEvent = useResultEvent();

  useIntentHandler<{ location?: string | null; result?: string }>('request', (intent) => {
    if (!intent.target) return;
    if (intent.draft?.result) resultEvent(sessionId, intent.draft.result, 'selected');
    goTo(requestHref(locale, intent.target, intent.draft?.location ?? null));
  });

  const opened = (e: MouseEvent<HTMLElement>) => {
    const a = (e.target as HTMLElement).closest<HTMLAnchorElement>('a[data-result-link]');
    if (!a) return;
    const resultId = a.dataset.resultLink!;
    const orgId = a.dataset.orgId!;
    saveSearchOrigin({ orgId, sessionId, resultId });
    resultEvent(sessionId, resultId, 'viewed');
    track('search.result_opened', {
      target_type: a.dataset.targetType === 'inventory_item' ? 'inventory_item' : 'organization',
      rank: Math.min(1000, Math.max(0, Number(a.dataset.rank) || 0)),
    });
  };

  const request = (r: ResultCard) => {
    const href = requestHref(locale, r.organization.id, r.location?.location_id ?? null);
    gate({
      type: 'request',
      target: r.organization.id,
      draft: { location: r.location?.location_id ?? null, result: r.result_id },
      title: t('profiles.intent.request', { name: r.organization.name }),
      run: () => {
        saveSearchOrigin({ orgId: r.organization.id, sessionId, resultId: r.result_id });
        resultEvent(sessionId, r.result_id, 'selected');
        goTo(href);
      },
    });
  };

  return (
    <ol className="pwa-plain-list pwa-results" aria-label={label} onClick={opened} onAuxClick={opened}>
      {results.map((r) => {
        const provider = r.organization.roles.includes('provider') && r.target.type === 'organization';
        const href = resultHref(r, locale);
        const askHref =
          r.target.type === 'inventory_item' ? href : r.organization.slug ? `${sellerPath(locale, r.organization.slug)}#parts` : null;
        return (
          <li
            key={r.result_id}
            onMouseEnter={() => onHover?.(r.location?.location_id ?? null)}
            onMouseLeave={() => onHover?.(null)}
            onFocus={() => onHover?.(r.location?.location_id ?? null)}
          >
            <ResultCardView
              r={r}
              locale={locale}
              t={t}
              f={f}
              bestMatch={bestMatch}
              highlighted={!!highlightedId && r.location?.location_id === highlightedId}
              actions={
                provider ? (
                  <Button size="sm" variant="primary" onClick={() => request(r)}>
                    {t('profiles.request.request')}
                  </Button>
                ) : askHref ? (
                  <a
                    href={askHref}
                    className={buttonClass({ size: 'sm' })}
                    data-result-link={r.result_id}
                    data-rank={r.rank}
                    data-org-id={r.organization.id}
                    data-target-type={r.target.type}
                  >
                    <span className="cp-btn-label">{t('search.result.askAboutPart')}</span>
                  </a>
                ) : null
              }
            />
          </li>
        );
      })}
    </ol>
  );
}
