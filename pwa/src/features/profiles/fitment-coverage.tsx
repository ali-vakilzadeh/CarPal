// Fitment coverage of a seller (Docs/22 W-PUB-03, C-VEND-01 "Fitment coverage" tab): the brands and models the seller
// covers. public.org_get gives coverage labels and types only — no confidence per brand (P5 report), so the table
// names the coverage level instead. Server-renderable.
import type { PublicOrgProfile } from '@carpal/api-contracts';
import type { Translate } from '@/lib/i18n/keys';

export function FitmentCoverage({ vendor, t }: { vendor: NonNullable<PublicOrgProfile['vendor']>; t: Translate }) {
  const rows = vendor.coverage.filter((c) => c.coverage_type !== 'part_category');
  if (!rows.length) return <p className="pwa-text-body">{t('profiles.fitment.empty')}</p>;
  return (
    <table className="pwa-table">
      <caption className="sr-only">{t('profiles.fitment.title')}</caption>
      <thead>
        <tr>
          <th scope="col">{t('profiles.fitment.vehicle')}</th>
          <th scope="col">{t('profiles.fitment.coverage')}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((c) => (
          <tr key={c.node_id}>
            <th scope="row">
              <bdi>{c.label.text}</bdi>
            </th>
            <td>{t(`profiles.fitment.type.${c.coverage_type}`)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
