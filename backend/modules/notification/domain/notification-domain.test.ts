// Notification rules (S6): EN/FA templates, preference defaults and channel
// decisions (critical, opt-out, digests, critical-alerts-only), event routing.
import { describe, expect, it } from 'vitest';
import { channelsFor, defaultPreference, mergedPreferences, type Channel } from './preferences.js';
import { route } from './routing.js';
import { render, TEMPLATES } from './templates.js';

describe('templates', () => {
  it('render in EN and FA with params and never leave a placeholder', () => {
    expect(render('inventory.import_finished', 'en', { created_count: 3, updated_count: 1, error_count: 0 }).text).toBe(
      'Your import is done: 3 created, 1 updated, 0 rows with errors.',
    );
    expect(render('vehicle.reminder_due', 'fa', { reminder_type: 'oil_change', status: 'due' }).subject).toBe(
      'خودروی شما نیاز به رسیدگی دارد',
    );
    for (const key of Object.keys(TEMPLATES))
      for (const locale of ['en', 'fa']) expect(render(key, locale, {}).text).not.toMatch(/\{[a-z_]+\}/);
  });
});

describe('preferences', () => {
  it('defaults: in-app on except marketing, SMS off, email and push for operational categories', () => {
    expect(mergedPreferences([])).toHaveLength(44);
    expect(defaultPreference('in_app', 'marketing').enabled).toBe(false);
    expect(defaultPreference('sms', 'appointments').enabled).toBe(false);
    expect(defaultPreference('email', 'inquiries').enabled).toBe(true);
  });

  it('critical goes out regardless; opt-outs, digests and critical_alerts_only apply otherwise', () => {
    const preferences = [{ channel: 'email' as const, category: 'inquiries' as const, enabled: true, frequency: 'daily_digest' as const }];
    const allowed: Channel[] = ['in_app', 'email', 'push', 'sms'];
    const base = { category: 'inquiries' as const, preferences, allowed };
    expect(channelsFor({ ...base, priority: 'normal', criticalAlertsOnly: false })).toEqual([
      { channel: 'email', outcome: 'digest' },
      { channel: 'push', outcome: 'send' },
      { channel: 'sms', outcome: 'suppressed' },
    ]);
    expect(channelsFor({ ...base, priority: 'normal', criticalAlertsOnly: true }).map((d) => d.outcome)).toEqual([
      'suppressed',
      'suppressed',
      'suppressed',
    ]);
    expect(channelsFor({ ...base, priority: 'critical', criticalAlertsOnly: true })).toEqual([
      { channel: 'email', outcome: 'send' },
      { channel: 'push', outcome: 'send' },
    ]);
  });
});

describe('routing', () => {
  it('routes S3-S6 events to their audiences', () => {
    expect(
      route({ type: 'inquiry.sent', aggregateType: 'stock_inquiry', aggregateId: 'q1', payload: { vendor_organization_id: 'v1' } }),
    ).toEqual([
      expect.objectContaining({
        audience: { kind: 'members', orgId: 'v1', roles: ['vendor_owner', 'vendor_staff'] },
        event_type: 'inquiry_received',
        organization_context_id: 'v1',
      }),
    ]);
    const fleet = route({
      type: 'vehicle.reminder.due',
      aggregateType: 'maintenance_reminder',
      aggregateId: 'r',
      payload: { owner_type: 'organization', owner_id: 'f1', status: 'overdue' },
    });
    expect(fleet[0]).toMatchObject({ event_type: 'vehicle_due_for_service', category: 'fleet', organization_context_id: 'f1' });
    expect(
      route({
        type: 'media.scan.completed',
        aggregateType: 'media_asset',
        aggregateId: 'm',
        payload: { scan_status: 'clean', owner_id: 'u' },
      }),
    ).toEqual([]);
    expect(
      route({
        type: 'community.post.published',
        aggregateType: 'post',
        aggregateId: 'p',
        payload: { organization_id: 'o', post_type: 'special_offer' },
      })[0]!.audience,
    ).toEqual({ kind: 'followers', orgId: 'o', preferences: ['all', 'important_only'] });
    expect(route({ type: 'unknown.event', aggregateType: 'x', aggregateId: 'y', payload: {} })).toEqual([]);
  });
});

describe('S7 routing', () => {
  const ids = { provider: 'p0000000-0000-0000-0000-000000000000', user: 'u0000000-0000-0000-0000-000000000000' };
  const e = (type: string, payload: Record<string, unknown>) => ({ type, aggregateType: 'appointment', aggregateId: 'a1', payload });

  it('appointments go to the other side; confirmations stay in-app and push (the email carries the ci link)', () => {
    expect(route(e('appointment.requested', { provider_organization_id: ids.provider }))[0]).toMatchObject({
      audience: { kind: 'members', orgId: ids.provider },
      event_type: 'appointment_request_received',
      category: 'appointments',
    });
    expect(route(e('appointment.confirmed', { provider_organization_id: ids.provider, requester_user_id: ids.user }))[0]).toMatchObject({
      audience: { kind: 'users', ids: [ids.user] },
      channels: ['in_app', 'push'],
    });
    const cancelledByRequester = route(
      e('appointment.status_changed', {
        new_status: 'cancelled',
        changed_by_side: 'requester',
        provider_organization_id: ids.provider,
        requester_user_id: ids.user,
      }),
    );
    expect(cancelledByRequester[0]!.audience).toMatchObject({ kind: 'members', orgId: ids.provider });
    expect(route(e('appointment.status_changed', { new_status: 'confirmed', provider_organization_id: ids.provider }))).toEqual([]);
  });

  it('reviews: the business gets approval questions and new reviews, authors their publication; inquiries their answers', () => {
    expect(
      route({
        ...e('review.approval.requested', { subject_organization_id: ids.provider, business_confirmation_status: 'pending' }),
        aggregateType: 'review',
      })[0],
    ).toMatchObject({
      event_type: 'review_approval_needed',
      category: 'reviews',
    });
    expect(
      route({
        ...e('review.approval.requested', { subject_organization_id: ids.provider, business_confirmation_status: 'confirmed' }),
        aggregateType: 'review',
      }),
    ).toEqual([]);
    expect(
      route({ ...e('review.published', { subject_organization_id: ids.provider, author_user_id: ids.user }), aggregateType: 'review' }).map(
        (i) => i.event_type,
      ),
    ).toEqual(['review_received', 'review_status_updated']);
    expect(
      route(e('inquiry.status_changed', { new_status: 'answered', requester_user_id: ids.user, requester_type: 'user' }))[0]!.event_type,
    ).toBe('inquiry_answered');
    expect(route(e('inquiry.status_changed', { new_status: 'cancelled', requester_user_id: ids.user, requester_type: 'user' }))).toEqual(
      [],
    );
  });
});

describe('S20 routing', () => {
  const posted = (payload: Record<string, unknown>) =>
    route({ type: 'dispute.message.posted', aggregateType: 'dispute', aggregateId: 'd1', payload });

  it('tells the party of a staff message in its dispute thread, never of its own reply', () => {
    expect(posted({ dispute_id: 'd1', author: 'staff', side: 'respondent', dispute_type: 'inaccurate_review', user_id: 'u1' })).toEqual([
      expect.objectContaining({
        audience: { kind: 'users', ids: ['u1'] },
        template_key: 'dispute.message_received',
        reference: { type: 'dispute', id: 'd1' },
        channels: ['in_app', 'email'],
      }),
    ]);
    expect(posted({ dispute_id: 'd1', author: 'staff', side: 'raiser', organization_id: 'o1' })[0]).toMatchObject({
      audience: { kind: 'members', orgId: 'o1' },
      organization_context_id: 'o1',
    });
    expect(posted({ dispute_id: 'd1', author: 'party', side: 'raiser', user_id: 'u1' })).toEqual([]);
  });

  it('notifies edit requests and fitment downgrades, but not weight reductions', () => {
    const action = (action_type: string) =>
      route({
        type: 'moderation.action.taken',
        aggregateType: 'moderation_action',
        aggregateId: 'a1',
        payload: { action_type, user_id: 'u1' },
      });
    expect(action('edit_request')).toHaveLength(1);
    expect(action('downgrade_fitment')).toHaveLength(1);
    expect(action('reduce_weight')).toEqual([]);
  });
});

describe('S19 routing', () => {
  it('tells the owners and managers that CarPal needs more information, or corrected their profile', () => {
    const [info] = route({
      type: 'organization.verification.info_requested',
      aggregateType: 'organization_verification',
      aggregateId: 'v1',
      payload: { organization_id: 'o1', verification_id: 'v1', verification_type: 'business_identity' },
    });
    expect(info).toMatchObject({
      audience: { kind: 'members', orgId: 'o1' },
      template_key: 'organization.verification_info_requested',
      params: { verification_type: 'business_identity' },
      reference: { type: 'organization_verification', id: 'v1' },
      organization_context_id: 'o1',
      channels: ['in_app', 'email'],
    });
    const [corrected] = route({
      type: 'organization.profile.corrected',
      aggregateType: 'organization',
      aggregateId: 'o1',
      payload: { organization_id: 'o1', fields: ['name'] },
    });
    expect(corrected).toMatchObject({
      template_key: 'organization.profile_corrected',
      params: {},
      reference: { type: 'organization', id: 'o1' },
    });
    expect(route({ type: 'organization.profile.corrected', aggregateType: 'organization', aggregateId: 'o1', payload: {} })).toEqual([]);
  });
});
