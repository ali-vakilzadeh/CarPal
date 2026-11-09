// The environment badge (GD-06): always visible, so nobody mistakes production for a test system. DEV and STAGING
// are quiet; PROD is solid red. The label is always the Latin DEV / STAGING / PROD in both languages (OQ-12, answered
// 2026-11-09), marked lang="en" so a Persian screen reader reads it as English; the hint after it is translated.
import type { Translate } from '@/lib/i18n/keys';

export type AdminEnv = 'dev' | 'staging' | 'prod';

const ENV_LABEL: Record<AdminEnv, string> = { dev: 'DEV', staging: 'STAGING', prod: 'PROD' };

export function EnvBadge({ env, t }: { env: AdminEnv; t: Translate }) {
  return (
    <p className="adm-env-badge" data-env={env} data-testid="env-badge">
      <span className="sr-only">{t('admin.env.label')}: </span>
      <span lang="en" dir="ltr">
        {ENV_LABEL[env]}
      </span>
      <span className="sr-only"> — {t(`admin.env.${env}Hint`)}</span>
    </p>
  );
}
