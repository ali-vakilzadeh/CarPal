'use client';
// "Describe it in Help Me" (Docs/22 W-PUB-06 right rail, W-QA-02 safety banner, W-FEED-01 Help Me bar): saves the text
// as the Help Me draft (cp:help-draft, read by P10) and opens /<locale>/help (or ?urgent=1 for safety text).
import { useRouter } from 'next/navigation';
import { Button, type ButtonVariant } from '@/components/ds/button';
import { RailBox } from '@/components/shell/right-rail';
import { saveHelpDraft } from '@/features/onboarding';
import { useLocale, useT } from '@/lib/i18n/client';

export function helpHref(locale: string, urgent = false): string {
  return `/${locale}/help${urgent ? '?urgent=1' : ''}`;
}

export function HelpMeButton({
  text,
  label,
  urgent,
  vehicleId = null,
  variant = 'secondary',
  block,
}: {
  text: string;
  label: string;
  urgent?: boolean;
  vehicleId?: string | null;
  variant?: ButtonVariant;
  block?: boolean;
}) {
  const locale = useLocale();
  const router = useRouter();
  return (
    <Button
      variant={variant}
      icon="spark"
      block={block}
      onClick={() => {
        saveHelpDraft({ vehicleId, text: text.trim().slice(0, 2000), symptoms: [] });
        router.push(helpHref(locale, urgent));
      }}
    >
      {label}
    </Button>
  );
}

/** "Need hands-on help? Describe it in Help Me" (W-PUB-06 rail; inline below the thread on smaller screens). */
export function HelpMeCard({ text, rail }: { text: string; rail?: boolean }) {
  const t = useT();
  const body = (
    <>
      <p className="pwa-text-caption">{t('community.help.text')}</p>
      <HelpMeButton text={text} label={t('community.help.action')} block />
    </>
  );
  if (rail) return <RailBox title={t('community.help.title')}>{body}</RailBox>;
  return (
    <section className="pwa-card pwa-stack-sm" aria-label={t('community.help.title')}>
      <h2 className="pwa-text-label m-0">{t('community.help.title')}</h2>
      {body}
    </section>
  );
}
