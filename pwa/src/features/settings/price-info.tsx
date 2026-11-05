'use client';
// W-SET-01 Language & region → Prices (OQ-11 update 2026-11-04, backend GD-41): amounts are stored in US dollars and shown
// in the local currency at the rate a system admin sets, the same for everybody. Read only.
import { useRegion } from '@/lib/config/client';
import { useFormat, usePriceDisplay } from '@/lib/format/client';
import { useT } from '@/lib/i18n/client';
import { Card } from './parts';

export function PriceInfo() {
  const t = useT();
  const f = useFormat();
  const region = useRegion();
  const prices = usePriceDisplay();
  const rate = region.exchange_rates.find((r) => r.currency === prices.currency);
  return (
    <Card title={t('settings.prices.title')} text={t('settings.prices.text')}>
      <p className="m-0" data-testid="price-rate">
        {rate
          ? t('settings.prices.rate', { price: f.money('1', region.currency), date: f.date(rate.updated_at) })
          : t('settings.prices.noRate')}
      </p>
    </Card>
  );
}
