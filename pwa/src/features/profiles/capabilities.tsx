'use client';
// Services & Capabilities (Docs/22 W-PUB-02, C-PROV-01 tab 2): a matrix on wide screens (rows: vehicles, columns: service
// systems, each cell the evidence level as text and colour, Docs/54 §2.1 public display), the same data as a list on
// phones (CSS), "Only my car" for a signed-in user's active vehicle, and the self-declared services and covered brands
// in a separate, collapsed group (they are claims, ranked below proven work).
import type { PublicOrgProfile } from '@carpal/api-contracts';
import { useMemo, useState } from 'react';
import { Badge } from '@/components/ds/badge';
import { Chip } from '@/components/ds/chip';
import { useT } from '@/lib/i18n/client';
import { useCarNames } from './use-car';
import { capabilitiesForVehicle, capabilityMatrix, confidenceTone } from './view-model';

export function Capabilities({ provider }: { provider: NonNullable<PublicOrgProfile['provider']> }) {
  const t = useT();
  const { car } = useCarNames();
  const [onlyMine, setOnlyMine] = useState(false);
  const caps = useMemo(
    () => (onlyMine && car ? capabilitiesForVehicle(provider.capabilities, car) : provider.capabilities),
    [onlyMine, car, provider.capabilities],
  );
  const matrix = useMemo(() => capabilityMatrix(caps, t('profiles.services.allModels')), [caps, t]);

  return (
    <div className="pwa-stack">
      <p className="pwa-text-caption">{t('profiles.services.intro')}</p>
      {car ? (
        <div>
          <Chip selected={onlyMine} icon="car" onClick={() => setOnlyMine((v) => !v)}>
            {t('profiles.services.onlyMyCar')} · <bdi>{car.label}</bdi>
          </Chip>
        </div>
      ) : null}
      {matrix.rows.length === 0 ? (
        <p className="pwa-text-body">{onlyMine ? t('profiles.services.noneForCar') : t('profiles.services.none')}</p>
      ) : (
        <div className="pwa-matrix-wrap">
          <table className="pwa-matrix">
            <caption className="sr-only">{t('profiles.services.matrixLabel')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('profiles.services.vehicle')}</th>
                {matrix.systems.map((s) => (
                  <th key={s} scope="col">
                    {s}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {matrix.rows.map((row) => (
                <tr key={row.vehicle}>
                  <th scope="row">
                    <bdi>{row.vehicle}</bdi>
                  </th>
                  {matrix.systems.map((s) => {
                    const cell = row.cells[s];
                    return (
                      <td key={s} data-label={s}>
                        {cell ? (
                          <span className="pwa-matrix-cell">
                            <Badge tone={confidenceTone(cell.level)}>{t(`profiles.services.level.${cell.level}`)}</Badge>
                            <span className="pwa-text-caption">{t('profiles.services.evidence', { count: cell.evidence })}</span>
                          </span>
                        ) : (
                          <span className="pwa-text-caption" aria-label="—">
                            —
                          </span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {provider.service_categories.length || provider.coverage.length ? (
        <details className="pwa-disclosure">
          <summary className="pwa-text-label">{t('profiles.services.selfDeclared')}</summary>
          <p className="pwa-text-caption">{t('profiles.services.selfDeclaredText')}</p>
          {provider.service_categories.length ? (
            <>
              <h3 className="pwa-text-label m-0">{t('profiles.services.categories')}</h3>
              <ul className="pwa-plain-list pwa-badges">
                {provider.service_categories.map((c) => (
                  <li key={c.node_id}>
                    <Badge>
                      {c.label.text} · {t(`profiles.services.experience.${c.experience_level}`)}
                    </Badge>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {provider.coverage.length ? (
            <>
              <h3 className="pwa-text-label m-0">{t('profiles.services.brands')}</h3>
              <p className="pwa-text-body">
                {provider.coverage.map((c, i) => (
                  <bdi key={i}>
                    {i ? ' · ' : ''}
                    {[c.brand.text, c.model?.text, c.series?.text].filter(Boolean).join(' ')}
                  </bdi>
                ))}
              </p>
            </>
          ) : null}
        </details>
      ) : null}
    </div>
  );
}
