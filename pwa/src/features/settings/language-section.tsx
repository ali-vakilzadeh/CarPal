'use client';
// W-SET-01 Language & region (mirrors C-PROF-08; P9.T3): the page language (a full load, layout direction follows) and
// the account language for emails and notifications (me.update locale); calendar, digits and distance unit as account
// preferences (the app and messages use them; the web follows the page language and the region's unit, GD-10, DI-55);
// the navigation app the Directions menu opens (shared with the app, with Reset); the display theme; and "On this
// device" prices (OQ-11). User-written content keeps its own language.
import type { UserPreference } from '@carpal/api-contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/ds/button';
import { LanguageSwitch, ThemePicker } from '@/components/shell/preferences';
import { useToast } from '@/components/shell/toast';
import { useNavigationChoice } from '@/features/map';
import { apiQueryKey, useApiClient, useApiQuery } from '@/lib/api/query';
import { useRegion } from '@/lib/config/client';
import { useLocale, useT } from '@/lib/i18n/client';
import { useSetPreference } from './consents';
import { Card, ErrorLine, ReadState } from './parts';
import { PriceDisplaySettings } from './price-display';

function Choice<V extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: V;
  options: { value: V; label: string }[];
  onChange: (v: V) => void;
  disabled?: boolean;
}) {
  return (
    <fieldset className="pwa-settings-choice" disabled={disabled}>
      <legend className="pwa-text-label">{label}</legend>
      <div className="pwa-inline-buttons">
        {options.map((o) => (
          <label key={o.value} className="pwa-radio">
            <input type="radio" name={label} value={o.value} checked={value === o.value} onChange={() => onChange(o.value)} />
            <span>{o.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function AccountLanguage() {
  const t = useT();
  const locale = useLocale();
  const api = useApiClient();
  const toast = useToast();
  const queryClient = useQueryClient();
  const me = useApiQuery('me.get', undefined, { staleTime: 60_000 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  if (!me.data) return <ReadState status={me.status} error={me.error} refetch={me.refetch} />;
  const same = me.data.locale === locale;
  return (
    <div className="pwa-stack-xs">
      <p className="pwa-text-body m-0">{t('settings.language.messages', { language: t(`common.language.${me.data.locale}`) })}</p>
      {same ? null : (
        <div className="pwa-inline-buttons">
          <Button
            size="sm"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                queryClient.setQueryData(apiQueryKey('me.get'), await api.api('me.update', { body: { locale } }));
                toast(t('settings.saved'));
              } catch (err) {
                setError(err);
              } finally {
                setBusy(false);
              }
            }}
          >
            {t('settings.language.useForMessages', { language: t(`common.language.${locale}`) })}
          </Button>
        </div>
      )}
      <ErrorLine error={error} />
    </div>
  );
}

function DisplayPreferences() {
  const t = useT();
  const toast = useToast();
  const prefs = useApiQuery('me.preferences_get', undefined, { staleTime: 60_000 });
  const setPreference = useSetPreference();
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  if (!prefs.data) return <ReadState status={prefs.status} error={prefs.error} refetch={prefs.refetch} />;
  const p = prefs.data;
  const save = async (patch: Partial<UserPreference>) => {
    setBusy(true);
    setError(null);
    try {
      await setPreference(patch);
      toast(t('settings.saved'));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="pwa-stack-sm">
      <Choice
        label={t('settings.language.calendar')}
        value={p.calendar_system}
        disabled={busy}
        options={[
          { value: 'jalali', label: t('settings.language.jalali') },
          { value: 'gregorian', label: t('settings.language.gregorian') },
        ]}
        onChange={(v) => void save({ calendar_system: v })}
      />
      <Choice
        label={t('settings.language.digits')}
        value={p.digit_style}
        disabled={busy}
        options={[
          { value: 'persian', label: t('settings.language.persianDigits') },
          { value: 'latin', label: t('settings.language.latinDigits') },
        ]}
        onChange={(v) => void save({ digit_style: v })}
      />
      <Choice
        label={t('settings.language.distance')}
        value={p.distance_unit}
        disabled={busy}
        options={[
          { value: 'km', label: t('settings.language.km') },
          { value: 'mi', label: t('settings.language.mi') },
        ]}
        onChange={(v) => void save({ distance_unit: v })}
      />
      <ErrorLine error={error} />
      <p className="pwa-text-caption m-0">{t('settings.language.webNote')}</p>
    </div>
  );
}

function NavigationApp() {
  const t = useT();
  const toast = useToast();
  const region = useRegion();
  const { remembered, remember } = useNavigationChoice();
  const apps = region.navigation_apps.filter((a) => a.platforms.includes('web'));
  return (
    <div className="pwa-stack-sm">
      <div className="cp-field">
        <label className="cp-field-label" htmlFor="settings-nav-app">
          {t('settings.language.navApp')}
        </label>
        <div className="cp-field-box pwa-select-box">
          <select
            id="settings-nav-app"
            className="cp-field-input pwa-select"
            value={remembered ?? ''}
            onChange={(e) => {
              remember(e.target.value || null);
              toast(e.target.value ? t('settings.saved') : t('settings.language.navReset'));
            }}
          >
            <option value="">{t('settings.language.askEachTime')}</option>
            {apps.map((a) => (
              <option key={a.key} value={a.key}>
                {a.label.text}
              </option>
            ))}
          </select>
        </div>
      </div>
      <p className="pwa-text-caption m-0">{t('settings.language.navHint')}</p>
      {remembered ? (
        <div className="pwa-inline-buttons">
          <Button size="sm" variant="ghost" icon="refresh" onClick={() => (remember(null), toast(t('settings.language.navReset')))}>
            {t('settings.language.reset')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export function LanguageSection() {
  const t = useT();
  return (
    <div className="pwa-stack">
      <Card title={t('settings.language.languageTitle')} text={t('settings.language.languageText')}>
        <div className="pwa-inline-buttons">
          <LanguageSwitch variant="secondary" />
        </div>
        <AccountLanguage />
      </Card>
      <Card title={t('settings.language.regionTitle')}>
        <DisplayPreferences />
      </Card>
      <Card title={t('settings.language.navTitle')}>
        <NavigationApp />
      </Card>
      <Card title={t('settings.language.displayTitle')} text={t('settings.language.displayText')}>
        <ThemePicker />
      </Card>
      <div className="pwa-stack-sm">
        <h3 className="pwa-onb-card-title">{t('settings.local.title')}</h3>
        <p className="pwa-text-caption m-0">{t('settings.local.text')}</p>
        <PriceDisplaySettings />
      </div>
    </div>
  );
}
