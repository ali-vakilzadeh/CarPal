'use client';
// W-SET-01 "On this device" → Prices (OQ-11): prices are based in US dollars; a visitor can enter their own rate and
// tick "Convert USD prices with this rate" to see them in toman or rial. The choice is this browser's (cp_price
// cookie, read by the server so pages render the same text), not an account setting.
import { useRouter } from 'next/navigation';
import { useId, useState, type FormEvent } from 'react';
import { Button } from '@/components/ds/button';
import { Check } from '@/components/ds/check';
import { Chip } from '@/components/ds/chip';
import { TextField } from '@/components/ds/text-field';
import { useToast } from '@/components/shell/toast';
import { formatMoney, MAX_USD_RATE, PRICE_COOKIE, serializePriceDisplay, toLatinDigits, type PriceDisplay } from '@/lib/format';
import { usePriceDisplay } from '@/lib/format/client';
import { useLocale, useT } from '@/lib/i18n/client';

const ONE_YEAR_S = 365 * 24 * 60 * 60;

/** "105,000" / "۱۰۵٬۰۰۰" / "105000.5" → 105000.5; null when it is not a positive number in range. */
export function parseRate(raw: string): number | null {
  const s = toLatinDigits(raw)
    .replace(/[,\s٬']/g, '')
    .replace('٫', '.');
  if (!/^\d{1,10}(\.\d{1,4})?$/.test(s)) return null;
  const n = Number(s);
  return n > 0 && n <= MAX_USD_RATE ? n : null;
}

export function writePriceCookie(p: PriceDisplay): void {
  const secure = location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${PRICE_COOKIE}=${serializePriceDisplay(p)}; Path=/; Max-Age=${ONE_YEAR_S}; SameSite=Lax${secure}`;
}

export function PriceDisplaySettings() {
  const t = useT();
  const locale = useLocale();
  const router = useRouter();
  const toast = useToast();
  const current = usePriceDisplay();
  const id = useId();
  const [rate, setRate] = useState(current.usdRate !== null ? String(current.usdRate) : '');
  const [unit, setUnit] = useState<PriceDisplay['unit']>(current.unit);
  const [convert, setConvert] = useState(current.convertUsd);
  const [error, setError] = useState(false);

  const parsed = parseRate(rate);
  const preview: PriceDisplay = { convertUsd: convert && parsed !== null, usdRate: parsed, unit };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (convert && parsed === null) return setError(true);
    setError(false);
    writePriceCookie({ convertUsd: convert && parsed !== null, usdRate: parsed, unit });
    toast(t('settings.prices.saved'));
    // Server components render prices too: render the page again with the new cookie.
    router.refresh();
  };

  return (
    <form className="pwa-settings-card" onSubmit={submit} noValidate aria-labelledby={`${id}-t`}>
      <h3 id={`${id}-t`} className="pwa-onb-card-title">
        {t('settings.prices.title')}
      </h3>
      <p className="pwa-text-caption">{t('settings.prices.text')}</p>
      <div className="flex flex-col gap-2">
        <span className="cp-field-label" id={`${id}-u`}>
          {t('settings.prices.unit')}
        </span>
        <div className="flex flex-wrap gap-2" role="group" aria-labelledby={`${id}-u`}>
          <Chip selected={unit === 'toman'} onClick={() => setUnit('toman')}>
            {t('settings.prices.toman')}
          </Chip>
          <Chip selected={unit === 'rial'} onClick={() => setUnit('rial')}>
            {t('settings.prices.rial')}
          </Chip>
        </div>
      </div>
      <TextField
        label={t('settings.prices.rate', { unit: t(unit === 'toman' ? 'settings.prices.toman' : 'settings.prices.rial') })}
        value={rate}
        onChange={(e) => setRate(e.target.value)}
        inputMode="decimal"
        dir="ltr"
        error={error ? t('settings.prices.rateInvalid') : undefined}
      />
      <Check checked={convert} onChange={(e) => setConvert(e.target.checked)}>
        {t('settings.prices.convert')}
      </Check>
      <p className="pwa-text-caption" aria-live="polite">
        {t('settings.prices.example', { price: formatMoney(10, 'USD', locale, t, preview) })}
      </p>
      <div>
        <Button type="submit" variant="primary">
          {t('common.actions.save')}
        </Button>
      </div>
    </form>
  );
}
