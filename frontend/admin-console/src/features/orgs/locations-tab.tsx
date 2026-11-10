'use client';
// Locations tab (AC9.T3, Docs/23 A-ORG-02 "Locations", Docs/40 §7 Location and admin.location_correct). Each location
// with its typed address, the owner's pin (exact point: staff only), the distance between the pin and the geocoded
// address with the server's verdict (far apart above the region threshold), where the point came from, address
// visibility, the service radius (a circle on the map) and the opening hours. Moderators and platform admins correct
// the pin or the address with a reason: the pin follows a click or a drag on the map, or the coordinates typed in the
// form (the keyboard alternative); only changed fields are sent; the backend re-runs the check, marks the point
// admin_corrected and tells the organization. The correction is audited (Audit drawer, entity organization_location).
import { useState } from 'react';
import type { Location, StaffOrgView } from '@carpal/api-contracts';
import { ActionNotice, AuditDrawer, ReasonDialog, useAdminAction } from '@/components/admin';
import { Badge } from '@/components/ds/badge';
import { Button } from '@/components/ds/button';
import { TextField } from '@/components/ds/text-field';
import { useSession } from '@/lib/api/query';
import { DEFAULT_LOCATION_THRESHOLD_M, type GeoPoint } from '@/lib/config/geo';
import { Bidi } from '@/lib/format/bidi';
import { useFormat } from '@/lib/format/client';
import { useLocale, useT } from '@/lib/i18n/client';
import { canCall } from '@/lib/roles';
import { distanceM } from './map/maplibre';
import { LocationMap } from './map/location-map';
import {
  correctionBody,
  draftOf,
  GEO_SOURCES,
  label,
  parseCoord,
  pinOf,
  pinVerdict,
  type CorrectionDraft,
  type CorrectionProblem,
} from './org-logic';

export interface LocationsTabProps {
  org: StaffOrgView;
  mapStyleUrl: string | null;
  /** The region threshold when the page knows it (from the verification queue), else the backend default. */
  thresholdM?: number;
  onCorrected: () => void;
}

export function LocationsTab({ org, mapStyleUrl, thresholdM = DEFAULT_LOCATION_THRESHOLD_M, onCorrected }: LocationsTabProps) {
  const t = useT();
  const locations = [...org.locations].sort((a, b) => Number(b.is_primary) - Number(a.is_primary));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = locations.find((l) => l.id === selectedId) ?? locations[0] ?? null;
  if (!selected) return <p data-testid="no-locations">{t('admin.orgs.locations.none')}</p>;
  return (
    <div className="adm-locations" data-testid="locations-tab">
      <p className="adm-muted">{t('admin.orgs.locations.threshold', { m: thresholdM })}</p>
      {locations.length > 1 ? (
        <ul className="adm-inline-list" aria-label={t('admin.orgs.locations.listLabel')}>
          {locations.map((l) => (
            <li key={l.id}>
              <Button
                size="sm"
                variant={l.id === selected.id ? 'primary' : 'ghost'}
                aria-pressed={l.id === selected.id}
                onClick={() => setSelectedId(l.id)}
              >
                {l.name ?? l.city}
                {l.location_check_status === 'far_apart' ? ` · ${t('admin.orgs.locations.far')}` : ''}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <LocationPanel
        key={`${selected.id}:${selected.version}`}
        org={org}
        location={selected}
        mapStyleUrl={mapStyleUrl}
        thresholdM={thresholdM}
        onCorrected={onCorrected}
      />
    </div>
  );
}

function LocationPanel({
  org,
  location: l,
  mapStyleUrl,
  thresholdM,
  onCorrected,
}: {
  org: StaffOrgView;
  location: Location;
  mapStyleUrl: string | null;
  thresholdM: number;
  onCorrected: () => void;
}) {
  const t = useT();
  const f = useFormat();
  const session = useSession();
  const canCorrect = canCall('admin.location_correct', session.data?.staff?.roles ?? []);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<CorrectionDraft>(() => draftOf(l));
  const [tried, setTried] = useState(false);
  const [dialog, setDialog] = useState(false);
  const [result, setResult] = useState<Location | null>(null);
  const action = useAdminAction('admin.location_correct', {
    target: l.id,
    onOutcome: (o) => {
      if (o.kind !== 'applied') return;
      setResult(o.data);
      setEditing(false);
      onCorrected();
    },
  });
  const pin = pinOf(l);
  const verdict = pinVerdict(l);
  const { body, problems } = correctionBody(l, draft);
  const proposedLat = parseCoord(draft.lat, 90);
  const proposedLng = parseCoord(draft.lng, 180);
  const proposed: GeoPoint | null = editing && proposedLat !== null && proposedLng !== null ? { lat: proposedLat, lng: proposedLng } : null;
  const moved = proposed && pin && (proposed.lat !== pin.lat || proposed.lng !== pin.lng) ? distanceM(pin, proposed) : null;
  const set = (key: keyof CorrectionDraft) => (e: { target: { value: string } }) => setDraft((d) => ({ ...d, [key]: e.target.value }));
  const err = (key: keyof CorrectionProblem) => (tried && problems[key] ? t(`admin.orgs.correct.problem.${problems[key]!}`) : undefined);

  const submit = (reason: string) => {
    setDialog(false);
    void action.run({ path: { org_id: org.id, location_id: l.id }, body: { ...body, reason }, reason });
  };

  return (
    <section className="adm-location" aria-label={l.name ?? l.city} data-testid="location" data-location={l.id}>
      <div className="adm-location-head">
        <h3 className="adm-subtitle">
          <Bidi>{l.name ?? l.city}</Bidi>
        </h3>
        {l.is_primary ? <Badge tone="accent">{t('admin.orgs.locations.primary')}</Badge> : null}
        {l.status === 'inactive' ? <Badge>{t('admin.orgs.locations.inactive')}</Badge> : null}
        <span className="adm-chip" data-tone={verdict === 'far' ? 'danger' : verdict === 'ok' ? 'ok' : 'neutral'} data-testid="pin-verdict">
          {t(`admin.orgs.locations.verdict.${verdict}`)}
        </span>
        <AuditDrawer entityType="organization_location" entityId={l.id} label={l.name ?? l.city} shortcut={false} />
      </div>
      <dl className="adm-facts">
        <div>
          <dt>{t('admin.orgs.locations.address')}</dt>
          <dd>
            <Bidi>{[l.address_line_1, l.address_line_2, l.city, l.region, l.postal_code].filter(Boolean).join('، ')}</Bidi>
          </dd>
        </div>
        <div>
          <dt>{t('admin.orgs.locations.pin')}</dt>
          <dd data-testid="pin-coords">{pin ? <Bidi ltr>{`${pin.lat}, ${pin.lng}`}</Bidi> : '—'}</dd>
        </div>
        <div>
          <dt>{t('admin.orgs.locations.distance')}</dt>
          <dd data-testid="pin-distance">
            {l.geo_address_distance_m == null
              ? t('admin.orgs.locations.noDistance')
              : t('admin.orgs.locations.distanceText', { d: f.distance(l.geo_address_distance_m), m: thresholdM })}
          </dd>
        </div>
        <div>
          <dt>{t('admin.orgs.locations.source')}</dt>
          <dd>{label(GEO_SOURCES, 'admin.orgs.locations.geoSource', l.geo_source, t)}</dd>
        </div>
        <div>
          <dt>{t('admin.orgs.locations.visibility')}</dt>
          <dd>{t(l.public_address_visibility === 'exact' ? 'admin.orgs.locations.exact' : 'admin.orgs.locations.approximate')}</dd>
        </div>
        <div>
          <dt>{t('admin.orgs.locations.radius')}</dt>
          <dd>{l.service_radius_km ? f.distance(l.service_radius_km * 1000) : '—'}</dd>
        </div>
        <div>
          <dt>{t('admin.orgs.locations.verified')}</dt>
          <dd>{l.location_verified_at ? f.date(l.location_verified_at, 'dateShort') : t('admin.orgs.locations.notVerified')}</dd>
        </div>
        <div>
          <dt>{t('admin.orgs.locations.hours')}</dt>
          <dd>
            <Hours location={l} />
          </dd>
        </div>
      </dl>
      <LocationMap
        pin={pin}
        proposed={proposed}
        radiusKm={l.service_radius_km ?? null}
        editable={editing}
        onPropose={(p) => setDraft((d) => ({ ...d, lat: String(p.lat), lng: String(p.lng) }))}
        styleUrl={mapStyleUrl}
        label={t('admin.orgs.map.label', { name: l.name ?? l.city })}
      />
      {result ? (
        <p data-testid="correct-result">
          {t('admin.orgs.correct.done', { verdict: t(`admin.orgs.locations.verdict.${pinVerdict(result)}`) })}
        </p>
      ) : null}
      <ActionNotice state={action.state} applied={t('admin.orgs.correct.applied')} />
      {canCorrect && !editing ? (
        <div className="adm-actions">
          <Button
            size="sm"
            variant="secondary"
            icon="pin"
            onClick={() => {
              action.reset();
              setResult(null);
              setDraft(draftOf(l));
              setTried(false);
              setEditing(true);
            }}
          >
            {t('admin.orgs.correct.open')}
          </Button>
        </div>
      ) : null}
      {editing ? (
        <form
          className="adm-correct"
          aria-label={t('admin.orgs.correct.formLabel')}
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            setTried(true);
            if (Object.keys(problems).length) return;
            setDialog(true);
          }}
        >
          <p className="adm-muted">{t('admin.orgs.correct.hint')}</p>
          <div className="adm-correct-grid">
            <TextField
              label={t('admin.orgs.correct.lat')}
              value={draft.lat}
              onChange={set('lat')}
              dir="ltr"
              inputMode="decimal"
              error={err('lat')}
            />
            <TextField
              label={t('admin.orgs.correct.lng')}
              value={draft.lng}
              onChange={set('lng')}
              dir="ltr"
              inputMode="decimal"
              error={err('lng')}
            />
          </div>
          {moved !== null ? <p data-testid="move-size">{t('admin.orgs.correct.moved', { d: f.distance(moved) })}</p> : null}
          <TextField
            label={t('admin.orgs.correct.line1')}
            value={draft.address_line_1}
            onChange={set('address_line_1')}
            maxLength={160}
            error={err('address_line_1')}
          />
          <TextField
            label={t('admin.orgs.correct.line2')}
            value={draft.address_line_2}
            onChange={set('address_line_2')}
            maxLength={160}
            error={err('address_line_2')}
          />
          <div className="adm-correct-grid">
            <TextField label={t('admin.orgs.correct.city')} value={draft.city} onChange={set('city')} maxLength={100} error={err('city')} />
            <TextField
              label={t('admin.orgs.correct.region')}
              value={draft.region}
              onChange={set('region')}
              maxLength={100}
              error={err('region')}
            />
            <TextField
              label={t('admin.orgs.correct.postal')}
              value={draft.postal_code}
              onChange={set('postal_code')}
              maxLength={20}
              dir="ltr"
              error={err('postal_code')}
            />
          </div>
          {tried && problems.nothing ? (
            <p className="adm-error" role="alert">
              {t('admin.orgs.correct.nothing')}
            </p>
          ) : null}
          <div className="adm-actions">
            <Button type="submit" size="sm" variant="primary" loading={action.state.status === 'busy'}>
              {t('admin.orgs.correct.save')}
            </Button>
            <Button size="sm" onClick={() => setEditing(false)} disabled={action.state.status === 'busy'}>
              {t('common.actions.cancel')}
            </Button>
          </div>
        </form>
      ) : null}
      <ReasonDialog
        open={dialog}
        onClose={() => setDialog(false)}
        kind="location_correction"
        title={t('admin.orgs.correct.dialog')}
        confirmLabel={t('admin.orgs.correct.save')}
        summary={
          <>
            <ul className="adm-inline-list" data-testid="correct-summary">
              {Object.keys(body).map((k) => (
                <li key={k}>{t(`admin.orgs.correct.field.${k as 'pin'}`)}</li>
              ))}
            </ul>
            <p className="adm-muted">{t('admin.orgs.correct.effect')}</p>
          </>
        }
        onSubmit={submit}
        name="location-correct"
      />
    </section>
  );
}

function Hours({ location: l }: { location: Location }) {
  const t = useT();
  const locale = useLocale();
  const f = useFormat();
  const weekly = l.hours?.weekly ?? [];
  if (!weekly.length) return <>{t('admin.orgs.locations.noHours')}</>;
  // 2024-01-07 was a Sunday: day_of_week 0 = Sunday, as the contract counts.
  const day = (d: number) => new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' }).format(Date.UTC(2024, 0, 7 + d));
  return (
    <ul className="adm-inline-list">
      {[...weekly]
        .sort((a, b) => a.day_of_week - b.day_of_week)
        .map((h) => (
          <li key={`${h.day_of_week}-${h.open}`}>
            {day(h.day_of_week)} {f.digits(h.open)}–{f.digits(h.close)}
          </li>
        ))}
    </ul>
  );
}
