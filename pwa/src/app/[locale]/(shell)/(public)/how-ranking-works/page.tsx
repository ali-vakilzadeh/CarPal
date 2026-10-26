// "How ranking works" (Docs/22 W-PUB-01 trust block and footer; P5.T2): a static, indexable explanation of the ranking
// rules in plain words, taken from Docs/54 §5 (match scores, fairness rules) and §2.1 (badges from evidence). No
// numbers that could drift from the scoring code: the page names the factors and the rules, not the weights.
import type { Metadata } from 'next';
import { isLocale, type Locale } from '@/lib/i18n/locales';
import type { MessageKey } from '@/lib/i18n/keys';
import { pageContext } from '@/server/ssr/page-context';
import { pageMetadata } from '@/server/ssr/seo/metadata';

type Props = { params: Promise<{ locale: string }> };

const FACTORS: { title: MessageKey; text: MessageKey }[] = [
  { title: 'landing.ranking.capability', text: 'landing.ranking.capabilityText' },
  { title: 'landing.ranking.trust', text: 'landing.ranking.trustText' },
  { title: 'landing.ranking.operational', text: 'landing.ranking.operationalText' },
  { title: 'landing.ranking.distance', text: 'landing.ranking.distanceText' },
  { title: 'landing.ranking.preference', text: 'landing.ranking.preferenceText' },
];
const RULES: MessageKey[] = [
  'landing.ranking.ruleNoPaid',
  'landing.ranking.ruleEvidence',
  'landing.ranking.ruleExplain',
  'landing.ranking.ruleSame',
];

async function localeOf(params: Props['params']): Promise<Locale> {
  const { locale } = await params;
  return isLocale(locale) ? locale : 'fa';
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const locale = await localeOf(params);
  const ctx = await pageContext(locale);
  return pageMetadata({
    locale,
    path: `/${locale}/how-ranking-works`,
    title: ctx.t('landing.ranking.metaTitle'),
    description: ctx.t('landing.ranking.metaDescription'),
    type: 'article',
    siteName: ctx.siteName,
  });
}

export default async function HowRankingWorksPage({ params }: Props) {
  const { t } = await pageContext(await localeOf(params));
  return (
    <article className="pwa-landing pwa-prose">
      <h1 className="pwa-text-title m-0">{t('landing.ranking.title')}</h1>
      <p className="pwa-text-body">{t('landing.ranking.intro')}</p>
      <section className="pwa-landing-section" aria-labelledby="factors">
        <h2 id="factors" className="pwa-text-h2 m-0">
          {t('landing.ranking.factorsTitle')}
        </h2>
        <dl className="pwa-stack">
          {FACTORS.map((x) => (
            <div key={x.title} className="pwa-stack-xs">
              <dt className="pwa-text-label">{t(x.title)}</dt>
              <dd className="pwa-text-body m-0">{t(x.text)}</dd>
            </div>
          ))}
        </dl>
      </section>
      <section className="pwa-landing-section" aria-labelledby="parts">
        <h2 id="parts" className="pwa-text-h2 m-0">
          {t('landing.ranking.partsTitle')}
        </h2>
        <p className="pwa-text-body">{t('landing.ranking.partsText')}</p>
      </section>
      <section className="pwa-landing-section" aria-labelledby="rules">
        <h2 id="rules" className="pwa-text-h2 m-0">
          {t('landing.ranking.rulesTitle')}
        </h2>
        <ul className="pwa-stack">
          {RULES.map((k) => (
            <li key={k} className="pwa-text-body">
              {t(k)}
            </li>
          ))}
        </ul>
      </section>
      <section className="pwa-landing-section" aria-labelledby="badges">
        <h2 id="badges" className="pwa-text-h2 m-0">
          {t('landing.ranking.badgesTitle')}
        </h2>
        <p className="pwa-text-body">{t('landing.ranking.badgesText')}</p>
      </section>
    </article>
  );
}
