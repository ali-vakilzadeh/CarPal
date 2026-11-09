// The environment badge (GD-06): always visible, so nobody mistakes production for a test system. DEV and STAGING
// are quiet; PROD is solid red. The hint is read by screen readers after the short label.
import type { Translate } from '@/lib/i18n/keys';

export type AdminEnv = 'dev' | 'staging' | 'prod';

export function EnvBadge({ env, t }: { env: AdminEnv; t: Translate }) {
  return (
    <p className="adm-env-badge" data-env={env} data-testid="env-badge">
      <span className="sr-only">{t('admin.env.label')}: </span>
      <span>{t(`admin.env.${env}`)}</span>
      <span className="sr-only"> — {t(`admin.env.${env}Hint`)}</span>
    </p>
  );
}
