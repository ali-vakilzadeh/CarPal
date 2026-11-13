// AC9 unit tests of the organization rules: status changes the backend accepts, assist flows per type, the work items
// an organization opens for, links, the pin verdict and the location correction body.
import { describe, expect, it } from 'vitest';
import type { Location, OrganizationVerification, StaffOrgView } from '@carpal/api-contracts';
import {
  assistFlows,
  correctionBody,
  draftOf,
  farLocations,
  headOf,
  orgHref,
  parseCoord,
  pinOf,
  pinVerdict,
  publicProfileHref,
  statusChanges,
  verificationPurposes,
} from './org-logic';

const id = (n: number) => `0193a3c4-5d6e-7f80-9a1b-${String(n).padStart(12, '0')}`;

function location(o: Partial<Location> = {}): Location {
  return {
    id: id(51),
    created_at: '2026-11-01T08:00:00Z',
    updated_at: '2026-11-01T08:00:00Z',
    version: 1,
    name: 'Main shop',
    address_line_1: 'Valiasr St 12',
    city: 'Tehran',
    country: 'IR',
    public_address_visibility: 'exact',
    timezone: 'Asia/Tehran',
    service_radius_km: 5,
    is_primary: true,
    status: 'active',
    organization_id: id(21),
    latitude: 35.7,
    longitude: 51.4,
    public_point: { lat: 35.7, lng: 51.4 },
    geo_source: 'user_pin',
    geo_address_distance_m: 1200,
    location_check_status: 'far_apart',
    location_verified_at: null,
    ...o,
  } as Location;
}

const check = (o: Partial<OrganizationVerification>): OrganizationVerification =>
  ({
    id: id(61),
    created_at: '2026-11-02T08:00:00Z',
    updated_at: '2026-11-02T08:00:00Z',
    version: 1,
    verification_type: 'business_identity',
    status: 'pending',
    submitted_document_ids: [],
    reviewed_at: null,
    rejection_reason: null,
    expires_at: null,
    ...o,
  }) as OrganizationVerification;

describe('organization rules (AC9)', () => {
  it('offers the status changes the backend accepts', () => {
    expect(statusChanges('active')).toEqual(['suspend']);
    expect(statusChanges('pending_verification')).toEqual(['suspend']);
    expect(statusChanges('suspended')).toEqual(['reactivate']);
    expect(statusChanges('archived')).toEqual(['reactivate']);
    expect(statusChanges('merged')).toEqual([]);
    expect(statusChanges('something_new')).toEqual([]);
  });

  it('assists only the onboarding flows of the organization type', () => {
    expect(assistFlows('provider', 'active')).toEqual(['provider']);
    expect(assistFlows('hybrid_provider_vendor', 'draft')).toEqual(['provider', 'vendor']);
    expect(assistFlows('fleet', 'active')).toEqual(['fleet']);
    expect(assistFlows('vendor', 'merged')).toEqual([]);
    expect(assistFlows('vendor', 'archived')).toEqual([]);
  });

  it('opens an organization for its pending verifications, oldest first', () => {
    // The full view's checks reduce to the pending ones, as the search row carries them (backend S14).
    const head = headOf({
      id: id(21),
      name: 'Asa Auto',
      organization_type: 'provider',
      slug: null,
      status: 'active',
      verification_status: 'pending',
      merged_into_organization_id: null,
      primary_location_id: null,
      contact_email: 'owner@asa-auto.ir',
      locations: [],
      subscription: { plan: { plan_key: 'provider_basic' } },
      open_cases: 0,
      verifications: [
        check({ id: id(62), created_at: '2026-11-05T00:00:00Z', verification_type: 'location' }),
        check({ id: id(63), status: 'verified' }),
        check({ id: id(61), created_at: '2026-11-03T00:00:00Z' }),
      ],
    } as unknown as StaffOrgView);
    expect(head.pending_verifications.map((v) => v.id)).toEqual([id(62), id(61)]);
    expect(head).toMatchObject({ plan_key: 'provider_basic', city: null });
    expect(head).not.toHaveProperty('contact_email');
    const items = verificationPurposes(head);
    expect(items.map((i) => i.purpose)).toEqual([`verification:${id(61)}`, `verification:${id(62)}`]);
    expect(orgHref(id(21), items[0]!.purpose, 'locations')).toBe(
      `/orgs/${id(21)}?tab=locations&purpose=${encodeURIComponent(`verification:${id(61)}`)}`,
    );
    expect(orgHref(id(21))).toBe(`/orgs/${id(21)}`);
  });

  it('links the public profile only for an active organization with a slug', () => {
    const base = 'https://pwa.carpals.ir/';
    expect(publicProfileHref({ slug: 'asa-auto', status: 'active', organization_type: 'provider' }, base, 'fa')).toBe(
      'https://pwa.carpals.ir/fa/shop/asa-auto',
    );
    expect(publicProfileHref({ slug: 'parts-1', status: 'active', organization_type: 'vendor' }, base, 'en')).toBe(
      'https://pwa.carpals.ir/en/parts-seller/parts-1',
    );
    expect(publicProfileHref({ slug: 'x', status: 'suspended', organization_type: 'provider' }, base, 'en')).toBeNull();
    expect(publicProfileHref({ slug: null, status: 'active', organization_type: 'provider' }, base, 'en')).toBeNull();
    expect(publicProfileHref({ slug: 'f', status: 'active', organization_type: 'fleet' }, base, 'en')).toBeNull();
  });

  it('keeps the server verdict of a pin and finds far pins', () => {
    expect(pinVerdict(location())).toBe('far');
    expect(pinVerdict(location({ location_check_status: 'consistent' }))).toBe('ok');
    expect(pinVerdict(location({ location_check_status: 'not_checked' }))).toBe('unchecked');
    expect(pinOf(location({ latitude: null }))).toBeNull();
    expect(farLocations({ locations: [location(), location({ id: id(52), status: 'inactive' })] }).map((l) => l.id)).toEqual([id(51)]);
  });

  it('reads coordinates in Latin or Persian digits, within range', () => {
    expect(parseCoord('35.7123456789', 90)).toBe(35.712346);
    expect(parseCoord('۳۵٫۷', 90)).toBe(35.7);
    expect(parseCoord('-12', 180)).toBe(-12);
    expect(parseCoord('91', 90)).toBeNull();
    expect(parseCoord('35,7', 90)).toBeNull();
    expect(parseCoord('', 90)).toBeNull();
  });

  it('sends only what changed in a correction, null for a cleared optional field', () => {
    const l = location({ address_line_2: 'Unit 3', postal_code: '1234567890' });
    const d = draftOf(l);
    expect(correctionBody(l, d)).toEqual({ body: {}, problems: { nothing: 'required' } });
    expect(correctionBody(l, { ...d, lat: '35.701', lng: '51.402' }).body).toEqual({ pin: { lat: 35.701, lng: 51.402 } });
    expect(correctionBody(l, { ...d, address_line_1: '  Valiasr   St 14 ', address_line_2: '' }).body).toEqual({
      address_line_1: 'Valiasr St 14',
      address_line_2: null,
    });
    expect(correctionBody(l, { ...d, city: '' }).problems).toEqual({ city: 'required' });
    expect(correctionBody(l, { ...d, lat: 'x' }).problems).toEqual({ lat: 'invalid' });
    expect(correctionBody(l, { ...d, postal_code: '1'.repeat(21) }).problems).toEqual({ postal_code: 'too_long' });
  });
});
