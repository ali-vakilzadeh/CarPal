// AC8 unit tests of the moderation rules: the target snapshot, which actions apply to each target type in its state
// (the backend's ModerationTargets), the showcase consent rule, the queue of a case type and the case links, the
// safety-first order, the SLA targets of cases and reports, the triage severity floor, views and the penalty input.
import { describe, expect, it } from 'vitest';
import type { ModerationCase } from '@carpal/api-contracts';
import {
  actionTexts,
  bySafetyFirst,
  caseDue,
  caseHref,
  inView,
  isId,
  parseTarget,
  penaltyPoints,
  proposedSeverity,
  queueOfType,
  reportDue,
  severityChoices,
  targetActions,
  targetOrganization,
  thingKey,
  type Target,
} from './case-logic';

const ID = '0193a3c4-5d6e-7f80-9a1b-0000000000a1';
const tg = (type: string, data: Record<string, unknown> = {}): Target => parseTarget({ type, id: ID, ...data })!;

describe('target snapshot', () => {
  it('reads type, id and fields; a gone record is unavailable; junk is null', () => {
    expect(tg('post', { status: 'published' })).toMatchObject({ type: 'post', id: ID, available: true });
    expect(parseTarget({ type: 'post', id: ID, available: false })!.available).toBe(false);
    expect(parseTarget(null)).toBeNull();
    expect(parseTarget({ id: ID })).toBeNull();
    expect(targetActions(parseTarget({ type: 'post', id: ID, available: false }))).toMatchObject({ content: [], suspend: false });
    expect(targetActions(null).content).toEqual([]);
  });
});

describe('actions per target (backend ModerationTargets)', () => {
  it('community posts, comments and answers: approve held content, hide, remove, restore, warn; the author can be suspended', () => {
    expect(targetActions(tg('post', { status: 'published', moderation_status: 'approved' })).content).toEqual([
      'hide',
      'remove',
      'warn_user',
    ]);
    expect(targetActions(tg('post', { status: 'draft', moderation_status: 'pending' })).content).toEqual([
      'approve',
      'hide',
      'remove',
      'warn_user',
    ]);
    expect(targetActions(tg('comment', { status: 'hidden' })).content).toEqual(['remove', 'restore', 'warn_user']);
    expect(targetActions(tg('answer', { status: 'removed' })).content).toEqual(['restore', 'warn_user']);
    const a = targetActions(tg('post', { status: 'published' }));
    expect(a.suspend).toBe(true);
    expect(a.penalty).toBe(false);
  });

  it('a question has no removed state: hide only', () => {
    expect(targetActions(tg('question', { status: 'open', moderation_status: 'approved' })).content).toEqual(['hide', 'warn_user']);
    expect(targetActions(tg('question', { status: 'hidden' })).content).toEqual(['restore', 'warn_user']);
  });

  it('a showcase item is approved only with a valid customer consent', () => {
    const missing = targetActions(tg('portfolio_item', { status: 'pending_review', customer_consent_status: 'requested' }));
    expect(missing.content).toEqual(['approve', 'request_changes', 'remove']);
    expect(missing.blocked).toEqual({ approve: 'consent_missing' });
    expect(targetActions(tg('portfolio_item', { status: 'pending_review', customer_consent_status: 'granted' })).blocked).toEqual({});
    expect(targetActions(tg('portfolio_item', { status: 'pending_review', customer_consent_status: 'not_required' })).blocked).toEqual({});
    expect(targetActions(tg('portfolio_item', { status: 'published' })).content).toEqual(['request_changes', 'remove']);
    expect(targetActions(tg('portfolio_item', { status: 'rejected' })).content).toEqual(['restore']);
    expect(targetActions(tg('portfolio_item', { status: 'published' })).suspend).toBe(false);
  });

  it('files: approve pending public files, remove, restore only when clean; the uploader can be suspended', () => {
    expect(targetActions(tg('media_asset', { status: 'active', moderation_status: 'pending' })).content).toEqual([
      'approve',
      'remove',
      'warn_user',
    ]);
    expect(targetActions(tg('media_asset', { status: 'removed', scan_status: 'clean' })).content).toEqual(['restore', 'warn_user']);
    expect(targetActions(tg('media_asset', { status: 'removed', scan_status: 'infected' })).content).toEqual(['warn_user']);
    expect(targetActions(tg('media_asset', { status: 'active', owner_type: 'organization', owner_id: ID })).penalty).toBe(true);
  });

  it('listings and fitment rows (A-INV-01): correction, hide, remove, restore; fitment rows are rejected and restored', () => {
    expect(targetActions(tg('inventory_item', { status: 'active' })).content).toEqual(['request_changes', 'hide', 'remove']);
    expect(targetActions(tg('inventory_item', { status: 'pending_review' })).content).toEqual([
      'approve',
      'request_changes',
      'hide',
      'remove',
    ]);
    expect(targetActions(tg('inventory_item', { status: 'hidden' })).content).toEqual(['remove', 'restore']);
    expect(targetActions(tg('inventory_fitment', { status: 'active' })).content).toEqual(['remove']);
    expect(targetActions(tg('inventory_fitment', { status: 'rejected' })).content).toEqual(['restore']);
    expect(targetActions(tg('inventory_item', { status: 'active' }))).toMatchObject({ suspend: false, penalty: true });
  });

  it('accounts, organizations, locations, business replies, AI output and reviews', () => {
    expect(targetActions(tg('user', { status: 'active' }))).toMatchObject({ content: ['warn_user'], suspend: true, reactivate: false });
    expect(targetActions(tg('user', { status: 'suspended' }))).toMatchObject({ suspend: false, reactivate: true });
    expect(targetActions(tg('organization', { status: 'active' }))).toMatchObject({ content: [], penalty: true, badges: true });
    expect(targetActions(tg('organization_location', {}))).toMatchObject({ content: [], penalty: true, badges: false });
    expect(targetActions(tg('review_response', { status: 'published' })).content).toEqual(['remove', 'warn_user']);
    expect(targetActions(tg('review_response', { status: 'removed' })).content).toEqual(['restore', 'warn_user']);
    expect(targetActions(tg('ai_output', { visibility: 'owner_only' })).content).toEqual(['remove']);
    expect(targetActions(tg('ai_output', { visibility: 'internal' })).content).toEqual(['restore']);
    expect(
      targetActions(tg('review', { status: 'pending_moderation', confirmation_path: 'visit_based', subject_organization_id: ID })),
    ).toMatchObject({ content: ['approve', 'remove', 'warn_user'], suspend: true, penalty: true });
    expect(targetActions(tg('something_new', {}))).toMatchObject({ content: [], suspend: false });
  });

  it('names the organization a target belongs to', () => {
    expect(targetOrganization(tg('organization'))).toBe(ID);
    expect(targetOrganization(tg('inventory_item', { vendor_organization_id: 'v1' }))).toBe('v1');
    expect(targetOrganization(tg('portfolio_item', { provider_organization_id: 'p1' }))).toBe('p1');
    expect(targetOrganization(tg('media_asset', { owner_type: 'user', owner_id: 'u1' }))).toBeNull();
    expect(targetOrganization(null)).toBeNull();
  });

  it('texts: reviews keep the AC7 wording, hide = remove types say so', () => {
    expect(actionTexts('review', 'remove')).toEqual({
      dialog: 'admin.cases.dialog.remove',
      effect: 'admin.cases.effect.remove',
      done: 'admin.cases.done.remove',
    });
    expect(actionTexts('question', 'remove').effect).toBe('admin.moderation.effect.removeOnly');
    expect(actionTexts('portfolio_item', 'approve').effect).toBe('admin.moderation.effect.portfolio.approve');
    expect(actionTexts('inventory_fitment', 'remove').effect).toBe('admin.moderation.effect.fitment.remove');
    expect(actionTexts('user', 'suspend_account').dialog).toBe('admin.moderation.dialog.suspend_account');
    expect(thingKey('nope')).toBe('admin.moderation.thing.item');
  });
});

const kase = (o: Partial<ModerationCase>): ModerationCase =>
  ({
    id: ID,
    created_at: '2026-11-10T08:00:00Z',
    updated_at: '2026-11-10T08:00:00Z',
    version: 1,
    case_type: 'post',
    target: { type: 'post', id: ID },
    source: 'user_report',
    reason: 'spam',
    severity: 'low',
    ai_risk_score: null,
    ai_flag_insight_id: null,
    status: 'open',
    assigned_to_display: null,
    resolution: null,
    resolved_at: null,
    report_count: 1,
    ...o,
  }) as ModerationCase;

describe('queues, order and timers', () => {
  it('maps case types to queues and pages', () => {
    expect(queueOfType('comment')).toBe('content');
    expect(queueOfType('inventory_fitment')).toBe('inventory');
    expect(queueOfType('user')).toBe('accounts');
    expect(queueOfType('ai_output')).toBe('ai');
    expect(queueOfType('review')).toBe('reviews');
    expect(caseHref('review', 'c1')).toBe('/reviews?tab=cases&case=c1&purpose=case%3Ac1');
    expect(caseHref('inventory_item', 'c1')).toBe('/inventory?case=c1&purpose=case%3Ac1');
    expect(caseHref('organization', 'c1')).toBe('/content?tab=accounts&case=c1&purpose=case%3Ac1');
  });

  it('safety cases first, then severity, then the oldest; closed cases last', () => {
    const rows = [
      kase({ id: 'old-low', created_at: '2026-11-01T00:00:00Z' }),
      kase({ id: 'high', severity: 'high' }),
      kase({ id: 'unsafe', reason: 'unsafe_advice', severity: 'medium' }),
      kase({ id: 'closed-critical', severity: 'critical', status: 'dismissed' }),
      kase({ id: 'new-low', created_at: '2026-11-09T00:00:00Z' }),
    ];
    expect(bySafetyFirst(rows).map((c) => c.id)).toEqual(['unsafe', 'high', 'old-low', 'new-low', 'closed-critical']);
  });

  it('Docs/23 §6: safety 4 h, reviews 24 h, inventory and other content 48 h', () => {
    const at = Date.parse('2026-11-10T08:00:00Z');
    const h = (c: Partial<ModerationCase>) => (caseDue(kase(c), 'Asia/Tehran') - at) / 3_600_000;
    expect(h({ reason: 'privacy' })).toBe(4);
    expect(h({ severity: 'critical' })).toBe(4);
    expect(h({ case_type: 'review' })).toBe(24);
    expect(h({ case_type: 'inventory_item' })).toBe(48);
    expect(h({})).toBe(48);
    expect(
      (reportDue(
        { created_at: '2026-11-10T08:00:00Z', reason: 'non_consensual_media', target: { type: 'media_asset', id: ID } },
        'Asia/Tehran',
      ) -
        at) /
        3_600_000,
    ).toBe(4);
  });

  it('triage severity: safety reasons start at high and cannot go lower', () => {
    expect(proposedSeverity('unsafe_advice')).toBe('high');
    expect(severityChoices('unsafe_advice')).toEqual(['high', 'critical']);
    expect(proposedSeverity('spam')).toBe('medium');
    expect(severityChoices('spam')).toEqual(['low', 'medium', 'high', 'critical']);
  });

  it('views narrow by source or reason', () => {
    expect(inView(kase({ source: 'ai_flag' }), 'ai')).toBe(true);
    expect(inView(kase({ source: 'ai_flag' }), 'reported')).toBe(false);
    expect(inView(kase({ reason: 'redaction_issue' }), 'consent')).toBe(true);
    expect(inView(kase({ reason: 'unsafe_advice' }), 'unsafe')).toBe(true);
    expect(inView(kase({}), '')).toBe(true);
  });

  it('penalty points 1-100 and badge ids', () => {
    expect(penaltyPoints('20')).toBe(20);
    expect(penaltyPoints(' 100 ')).toBe(100);
    expect(penaltyPoints('0')).toBeNull();
    expect(penaltyPoints('101')).toBeNull();
    expect(penaltyPoints('2.5')).toBeNull();
    expect(isId(ID)).toBe(true);
    expect(isId('badge-1')).toBe(false);
  });
});
