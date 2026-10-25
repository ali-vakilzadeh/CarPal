// Placeholder for a shell destination whose screen arrives in a later stage: the GD-13 "not available yet" state
// under the destination's heading, so navigation never lands on a 404.
import type { MessageKey, Translate } from '@/lib/i18n/keys';
import type { Locale } from '@/lib/i18n/locales';
import { typeClass } from '@/lib/design-system';
import { StateView } from './states';

export function ComingSoon({ locale, t, title }: { locale: Locale; t: Translate; title: MessageKey }) {
  return (
    <div className="flex flex-col gap-4 py-6">
      <h1 className={`${typeClass(locale, 'title')} m-0`}>{t(title)}</h1>
      <StateView kind="notAvailable" t={t} />
    </div>
  );
}
