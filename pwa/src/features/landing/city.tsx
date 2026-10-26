'use client';
// The landing page's city ("Near: Tehran ▾", Docs/22 W-PUB-01): a plain GET form (?city=<key>, works without
// JavaScript) that the browser also remembers in the cp_city cookie for the next visit. IP-based detection is
// optional in the plan and not built (P5 report); without a choice the picker is the first field.
import { useEffect } from 'react';
import { Button } from '@/components/ds/button';
import { Icon } from '@/components/ds/icon';
import { useT } from '@/lib/i18n/client';
import { CITY_COOKIE } from './city-cookie';

const ONE_YEAR_S = 365 * 24 * 60 * 60;

export function RememberCity({ city }: { city: string | null }) {
  useEffect(() => {
    if (!city) return;
    const secure = window.location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = `${CITY_COOKIE}=${encodeURIComponent(city)}; Path=/; Max-Age=${ONE_YEAR_S}; SameSite=Lax${secure}`;
  }, [city]);
  return null;
}

export function CityPicker({ cities, value }: { cities: { key: string; label: string }[]; value: string | null }) {
  const t = useT();
  return (
    <form method="get" className="pwa-city-form">
      <label className="pwa-city-label">
        <span className="cp-field-label">{value ? t('landing.popular.near') : t('landing.popular.choose')}</span>
        <span className="cp-field-box pwa-select-box">
          <select name="city" defaultValue={value ?? ''} className="cp-field-input pwa-select" required>
            {value ? null : (
              <option value="" disabled>
                {t('landing.popular.city')}
              </option>
            )}
            {cities.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </select>
          <Icon name="down" size={20} />
        </span>
      </label>
      <Button type="submit" size="sm">
        {t('landing.popular.show')}
      </Button>
    </form>
  );
}
