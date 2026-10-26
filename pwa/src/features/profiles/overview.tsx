// Overview sections (C-PROV-01 tab 1, C-VEND-01 overview; Docs/22 W-PUB-02/03): description, key facts, certifications
// with "Verified by CarPal" (public.org_get lists verified certifications only), amenities, warranty and return
// policies, categories and brands carried. The AI review-theme summary of Docs/22 has no public read yet (P5 report).
import type { PublicOrgProfile } from '@carpal/api-contracts';
import { Badge } from '@/components/ds/badge';
import type { Locale } from '@/lib/i18n/locales';
import type { Translate } from '@/lib/i18n/keys';

function languageName(code: string, locale: Locale): string {
  try {
    return new Intl.DisplayNames([locale], { type: 'language' }).of(code) ?? code;
  } catch {
    return code;
  }
}

function UserText({ text, lang }: { text: string; lang?: string }) {
  return (
    <p className="pwa-text-body pwa-ugc" dir="auto" lang={lang}>
      {text}
    </p>
  );
}

/** The business's own site: nofollow (user-supplied), host only as the visible text. */
function WebsiteLink({ url }: { url: string }) {
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    /* shown as given */
  }
  return (
    <a className="pwa-link" href={url} rel="nofollow noopener noreferrer" target="_blank">
      <bdi dir="ltr">{host}</bdi>
    </a>
  );
}

function Fact({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="pwa-text-caption">{term}</dt>
      <dd className="pwa-text-body">{children}</dd>
    </>
  );
}

export function ProviderOverview({ profile: p, locale, t }: { profile: PublicOrgProfile; locale: Locale; t: Translate }) {
  const pr = p.provider;
  return (
    <div className="pwa-stack">
      {p.description ? (
        <UserText text={p.description.text} lang={p.description.locale} />
      ) : (
        <p className="pwa-text-caption">{t('profiles.overview.noDescription')}</p>
      )}
      {pr ? (
        <dl className="pwa-dl pwa-facts" aria-label={t('profiles.overview.facts')}>
          {pr.years_in_business !== null ? (
            <Fact term={t('profiles.overview.experience')}>{t('profiles.overview.years', { count: pr.years_in_business })}</Fact>
          ) : null}
          {pr.service_modes.length ? (
            <Fact term={t('profiles.overview.serviceModes')}>
              {pr.service_modes.map((m) => t(`profiles.overview.mode.${m}`)).join(' · ')}
            </Fact>
          ) : null}
          {pr.languages_spoken.length ? (
            <Fact term={t('profiles.overview.languages')}>{pr.languages_spoken.map((l) => languageName(l, locale)).join(' · ')}</Fact>
          ) : null}
          <Fact term={t('profiles.overview.warranty')}>
            {pr.warranty_offered ? (pr.warranty_policy?.text ?? '✓') : t('profiles.overview.noWarranty')}
          </Fact>
          {p.website ? (
            <Fact term={t('profiles.overview.website')}>
              <WebsiteLink url={p.website} />
            </Fact>
          ) : null}
        </dl>
      ) : null}
      {pr?.certifications.length ? (
        <div className="pwa-stack-sm">
          <h3 className="pwa-text-label m-0">{t('profiles.overview.certifications')}</h3>
          <ul className="pwa-plain-list">
            {pr.certifications.map((c, i) => (
              <li key={i} className="pwa-cert">
                <span className="pwa-text-body">
                  <bdi>{c.name}</bdi>
                </span>
                <span className="pwa-text-caption">{t('profiles.overview.certificationIssuer', { issuer: c.issuer })}</span>
                <Badge tone="success" icon="check">
                  {t('profiles.overview.verifiedByCarpal')}
                </Badge>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {pr?.amenities.length ? (
        <div className="pwa-stack-sm">
          <h3 className="pwa-text-label m-0">{t('profiles.overview.amenities')}</h3>
          <div className="pwa-badges">
            {pr.amenities.map((a) => (
              <Badge key={a.node_id}>{a.label.text}</Badge>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function VendorOverview({ profile: p, t }: { profile: PublicOrgProfile; t: Translate }) {
  const v = p.vendor;
  const categories = (v?.coverage ?? []).filter((c) => c.coverage_type === 'part_category');
  const brands = (v?.coverage ?? []).filter((c) => c.coverage_type !== 'part_category');
  return (
    <div className="pwa-stack">
      {p.description ? (
        <UserText text={p.description.text} lang={p.description.locale} />
      ) : (
        <p className="pwa-text-caption">{t('profiles.overview.noDescription')}</p>
      )}
      <dl className="pwa-dl pwa-facts">
        {categories.length ? <Fact term={t('profiles.vendor.categories')}>{categories.map((c) => c.label.text).join(' · ')}</Fact> : null}
        {brands.length ? <Fact term={t('profiles.vendor.brands')}>{brands.map((c) => c.label.text).join(' · ')}</Fact> : null}
        {v?.warranty_policy ? <Fact term={t('profiles.overview.warranty')}>{v.warranty_policy.text}</Fact> : null}
        {v?.return_policy ? <Fact term={t('profiles.overview.returns')}>{v.return_policy.text}</Fact> : null}
        {v?.trade_customers_supported ? <Fact term={t('profiles.vendor.trade')}>{t('profiles.vendor.tradeNote')}</Fact> : null}
        {p.website ? (
          <Fact term={t('profiles.overview.website')}>
            <WebsiteLink url={p.website} />
          </Fact>
        ) : null}
      </dl>
    </div>
  );
}
