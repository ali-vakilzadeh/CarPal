'use client';
// Landing hero (Docs/22 W-PUB-01): "Your car" (brand → model → series) and "What's wrong / what do you need?" →
// Find specialists. Search works without an account: the query, the car (as brand/model/series filters, never a
// vehicle_id, BA-16) and the chosen city go to the search page in sessionStorage (GD-14, never the URL); P6 runs
// search.run there. Secondary links: Help Me and the map.
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ds/button';
import { TextField } from '@/components/ds/text-field';
import { savePendingSearch } from '@/components/shell/search-box';
import { EMPTY_PICK, VehiclePicker, type VehiclePick } from '@/components/vehicle/vehicle-picker';
import { useLocale, useT } from '@/lib/i18n/client';

export function LandingHero({ city }: { city: string | null }) {
  const t = useT();
  const locale = useLocale();
  const router = useRouter();
  const [car, setCar] = useState<VehiclePick>(EMPTY_PICK);
  const [text, setText] = useState('');
  const [missing, setMissing] = useState(false);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const query = text.trim().slice(0, 500);
    if (!query && !car.brandId) {
      setMissing(true);
      return;
    }
    savePendingSearch({
      text: query,
      ...(car.brandId
        ? {
            vehicle: {
              brand_node_id: car.brandId,
              ...(car.modelId ? { model_node_id: car.modelId } : {}),
              ...(car.seriesId ? { series_node_id: car.seriesId } : {}),
            },
          }
        : {}),
      ...(city ? { city } : {}),
      entry: 'home',
    });
    router.push(`/${locale}/search`);
  };

  return (
    <form className="pwa-hero-form" onSubmit={submit} role="search" aria-label={t('landing.hero.find')}>
      <VehiclePicker value={car} onChange={setCar} legend="landing.hero.yourCar" className="pwa-hero-car" />
      <TextField
        label={t('landing.hero.whatsWrong')}
        placeholder={t('landing.hero.placeholder')}
        value={text}
        maxLength={500}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
          setText(e.target.value);
          setMissing(false);
        }}
        error={missing ? t('landing.hero.needText') : undefined}
        icon="search"
      />
      <Button type="submit" variant="primary" icon="search" block>
        {t('landing.hero.find')}
      </Button>
      <p className="pwa-hero-links">
        <a className="pwa-link" href={`/${locale}/help`}>
          {t('landing.hero.helpMe')}
        </a>
        <a className="pwa-link" href={`/${locale}/map`}>
          {t('landing.hero.map')}
        </a>
      </p>
    </form>
  );
}
