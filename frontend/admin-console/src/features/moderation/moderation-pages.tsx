'use client';
// Content and Inventory sections (AC8.T1/T2, Docs/23 A-CON-01, A-INV-01). Content: the reports inbox (moderators and
// support staff), then the case queues of moderators and platform admins as tabs — Content (posts, comments, questions,
// answers, showcase items, files, business replies), Accounts & organizations (users, organizations, locations) and AI
// output. Inventory: the cases of listings and fitment records. Review cases stay under Reviews (AC7). Each tab is
// shown only to the roles that may read it; the tab lives in the URL (?tab=reports|content|accounts|ai).
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useSession } from '@/lib/api/query';
import { useT } from '@/lib/i18n/client';
import { canCall } from '@/lib/roles';
import { CaseWorkspace } from './case-workspace';
import { ReportsInbox } from './reports-inbox';

export type ContentTab = 'reports' | 'content' | 'accounts' | 'ai';

export function ContentPage({ publicWeb }: { publicWeb?: string }) {
  const t = useT();
  const session = useSession();
  const roles = session.data?.staff?.roles ?? [];
  const params = useSearchParams();
  const tabs: ContentTab[] = [];
  if (canCall('admin.reports_list', roles)) tabs.push('reports');
  if (canCall('admin.cases_list', roles)) tabs.push('content', 'accounts', 'ai');
  const asked = params.get('tab');
  const tab: ContentTab | undefined = tabs.find((x) => x === asked) ?? tabs[0];

  return (
    <div className="adm-page" data-testid="content-page">
      <h1 className="adm-page-title">{t('admin.moderation.title')}</h1>
      <p className="adm-measure">{t(`admin.moderation.intro.${tab ?? 'reports'}`)}</p>
      <nav className="adm-tabs" aria-label={t('admin.moderation.tabsLabel')}>
        {tabs.map((x) => (
          <Link key={x} href={`/content?tab=${x}`} aria-current={x === tab ? 'page' : undefined} className="adm-tab">
            {t(`admin.moderation.tab.${x}`)}
          </Link>
        ))}
      </nav>
      {tab === 'reports' ? (
        <ReportsInbox key="reports" />
      ) : tab ? (
        <CaseWorkspace
          key={tab}
          queue={tab}
          tableId={`${tab}-cases`}
          listLabel={t(`admin.moderation.list.${tab}`)}
          emptyText={t('admin.moderation.empty')}
          views={tab === 'content'}
          publicWeb={publicWeb}
        />
      ) : null}
    </div>
  );
}

export function InventoryPage({ publicWeb }: { publicWeb?: string }) {
  const t = useT();
  return (
    <div className="adm-page" data-testid="inventory-page">
      <h1 className="adm-page-title">{t('admin.moderation.inventory.title')}</h1>
      <p className="adm-measure">{t('admin.moderation.inventory.intro')}</p>
      <CaseWorkspace
        queue="inventory"
        tableId="inventory-cases"
        listLabel={t('admin.moderation.list.inventory')}
        emptyText={t('admin.moderation.empty')}
        publicWeb={publicWeb}
      />
    </div>
  );
}
