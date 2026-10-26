'use client';
// W-ONB-01 steps 1, 3 and 4: how you'll use CarPal (S-AUTH-04; business choices open the business portal sign-up in
// the same tab, keeping the account), anything wrong? (C-ONB-02; the description becomes a Help Me draft) and the web
// permissions (S-AUTH-05 for the browser: location for "near me"; web push is offered in P12).
import { useEffect, useState } from 'react';
import { Banner } from '@/components/ds/banner';
import { Button, buttonClass } from '@/components/ds/button';
import { Chip } from '@/components/ds/chip';
import { cx } from '@/components/ds/cx';
import { Icon, type IconName } from '@/components/ds/icon';
import { TextField } from '@/components/ds/text-field';
import { useVehicleLabel } from '@/components/shell/active-vehicle';
import { useToast } from '@/components/shell/toast';
import { useApiClient } from '@/lib/api/query';
import { useBrowserValue } from '@/lib/browser-value';
import { useT } from '@/lib/i18n/client';
import type { MessageKey } from '@/lib/i18n/keys';
import { saveHelpDraft } from './account';
import type { SavedVehicle } from './vehicle-step';

export interface StepProps {
  saving: boolean;
  onNext: () => void;
  onSkip: () => void;
}

function StepActions({ saving, onNext, onSkip, nextLabel, nextDisabled }: StepProps & { nextLabel?: string; nextDisabled?: boolean }) {
  const t = useT();
  return (
    <div className="pwa-onb-actions">
      <Button variant="primary" loading={saving} disabled={nextDisabled} onClick={onNext}>
        {nextLabel ?? t('onboarding.next')}
      </Button>
      <Button variant="ghost" disabled={saving} onClick={onSkip}>
        {t('onboarding.skip')}
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------- 1. how you'll use CarPal

type Role = 'individual' | 'fleet' | 'provider' | 'vendor';
const ROLES: { key: Role; icon: IconName; title: MessageKey; text: MessageKey }[] = [
  { key: 'individual', icon: 'car', title: 'onboarding.role.individual', text: 'onboarding.role.individualText' },
  { key: 'fleet', icon: 'truck', title: 'onboarding.role.fleet', text: 'onboarding.role.fleetText' },
  { key: 'provider', icon: 'wrench', title: 'onboarding.role.provider', text: 'onboarding.role.providerText' },
  { key: 'vendor', icon: 'store', title: 'onboarding.role.vendor', text: 'onboarding.role.vendorText' },
];

export function RoleStep({ saving, onNext, portalUrl }: StepProps & { portalUrl: string }) {
  const t = useT();
  const [role, setRole] = useState<Role>('individual');
  const business = role !== 'individual';
  return (
    <div className="flex flex-col gap-5">
      <fieldset className="pwa-fieldset">
        <legend className="sr-only">{t('onboarding.titles.role')}</legend>
        <div className="pwa-option-list">
          {ROLES.map((r) => (
            <label key={r.key} className={cx('pwa-option pwa-onb-role', role === r.key && 'is-selected')}>
              <input type="radio" name="role" value={r.key} checked={role === r.key} onChange={() => setRole(r.key)} />
              <span className="pwa-tile" aria-hidden="true">
                <Icon name={r.icon} size={20} />
              </span>
              <span className="flex flex-col">
                <span className="pwa-option-title">{t(r.title)}</span>
                <span className="pwa-text-caption">{t(r.text)}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      {business ? (
        <Banner tone="info" icon="building" title={t('onboarding.role.businessTitle')} text={t('onboarding.role.businessText')}>
          <div className="pwa-banner-actions">
            <a href={portalUrl} className={buttonClass({ size: 'sm' })}>
              <Icon name="globe" size={20} />
              <span className="cp-btn-label">{t('onboarding.role.openPortal')}</span>
            </a>
          </div>
        </Banner>
      ) : null}
      <p className="pwa-text-caption">{t('onboarding.role.note')}</p>
      <div className="pwa-onb-actions">
        <Button variant="primary" loading={saving} onClick={onNext}>
          {business ? t('onboarding.role.continueIndividual') : t('onboarding.next')}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- 3. anything wrong?

const SYMPTOMS = ['light', 'noise', 'brakes', 'vibration', 'overheating', 'start', 'ac', 'suspension', 'leak', 'smell'] as const;

export function ProblemStep({ saving, onNext, onSkip, vehicle }: StepProps & { vehicle: SavedVehicle | null }) {
  const t = useT();
  const toast = useToast();
  const label = useVehicleLabel(vehicle);
  const [text, setText] = useState('');
  const [symptoms, setSymptoms] = useState<string[]>([]);
  const ready = text.trim().length > 0 || symptoms.length > 0;
  const toggle = (s: string) => setSymptoms((v) => (v.includes(s) ? v.filter((x) => x !== s) : [...v, s]));
  return (
    <div className="flex flex-col gap-5">
      {vehicle ? (
        <p className="pwa-onb-vehicle">
          <Icon name="car" size={20} />
          <bdi>{label ?? ''}</bdi>
        </p>
      ) : (
        <p className="pwa-text-caption">{t('onboarding.problem.noVehicle')}</p>
      )}
      <TextField
        multiline
        label={t('onboarding.problem.describe')}
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        maxLength={2000}
      />
      <div className="flex flex-col gap-2">
        <span className="cp-field-label" id="onb-symptoms">
          {t('onboarding.problem.symptoms')}
        </span>
        <div className="flex flex-wrap gap-2" role="group" aria-labelledby="onb-symptoms">
          {SYMPTOMS.map((s) => (
            <Chip key={s} selected={symptoms.includes(s)} onClick={() => toggle(s)}>
              {t(`onboarding.symptoms.${s}`)}
            </Chip>
          ))}
        </div>
      </div>
      <div className="pwa-onb-actions">
        <Button
          variant="primary"
          loading={saving}
          disabled={!ready}
          onClick={() => {
            saveHelpDraft({ vehicleId: vehicle?.id ?? null, text: text.trim(), symptoms });
            toast(t('onboarding.problem.saved'));
            onNext();
          }}
        >
          {t('onboarding.problem.getHelp')}
        </Button>
        <Button variant="ghost" disabled={saving} onClick={onSkip}>
          {t('onboarding.problem.notNow')}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- 4. permissions

type LocationState = 'unknown' | 'asking' | 'allowed' | 'denied' | 'unsupported';

export function PermissionsStep({ saving, onNext, onSkip, policyVersion }: StepProps & { policyVersion: string }) {
  const t = useT();
  const api = useApiClient();
  const supported = useBrowserValue(() => 'geolocation' in navigator, true);
  const [asked, setLocation] = useState<LocationState>('unknown');
  const location: LocationState = supported ? asked : 'unsupported';

  useEffect(() => {
    if (!supported) return;
    navigator.permissions
      ?.query({ name: 'geolocation' })
      .then((s) => {
        if (s.state === 'granted') setLocation('allowed');
        else if (s.state === 'denied') setLocation('denied');
      })
      .catch(() => undefined);
  }, [supported]);

  const ask = () => {
    setLocation('asking');
    navigator.geolocation.getCurrentPosition(
      () => {
        setLocation('allowed');
        api
          .api('consents.grant', {
            body: { consent_type: 'location_usage', policy_version: policyVersion, granted_to: { type: 'platform' } },
          })
          .catch((err: unknown) => console.warn('location consent not saved', err));
      },
      (err) => setLocation(err.code === err.PERMISSION_DENIED ? 'denied' : 'unknown'),
      { maximumAge: 600_000, timeout: 15_000 },
    );
  };

  return (
    <div className="flex flex-col gap-5">
      <p className="pwa-text-body">{t('onboarding.permissions.intro')}</p>
      <div className="pwa-onb-card">
        <div className="flex items-start gap-3">
          <span className="pwa-tile" aria-hidden="true">
            <Icon name="pin" size={20} />
          </span>
          <div className="flex flex-col gap-1">
            <h2 className="pwa-onb-card-title">{t('onboarding.permissions.location')}</h2>
            <p className="pwa-text-caption">{t('onboarding.permissions.locationText')}</p>
          </div>
        </div>
        {location === 'allowed' ? (
          <p className="pwa-onb-allowed" role="status">
            <Icon name="check" size={20} />
            {t('onboarding.permissions.allowed')}
          </p>
        ) : location === 'denied' || location === 'unsupported' ? (
          <p className="pwa-text-caption" role="status">
            {location === 'denied' ? t('onboarding.permissions.denied') : t('onboarding.permissions.unsupported')}
          </p>
        ) : (
          <div>
            <Button size="sm" icon="locate" loading={location === 'asking'} onClick={ask}>
              {t('onboarding.permissions.allowLocation')}
            </Button>
          </div>
        )}
      </div>
      <StepActions saving={saving} onNext={onNext} onSkip={onSkip} nextLabel={t('onboarding.permissions.finish')} />
    </div>
  );
}
