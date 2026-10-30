// P9.T6 (unit): the settings view model — public name preview, consent rows, shares and history, the consent CSV
// (quoting, formula neutralising), the notification matrix update, data requests and the typed deletion
// confirmation; My Activity's inquiry actions.
import type { ConsentRecord, DataSubjectRequest, NotificationPreference } from '@carpal/api-contracts';
import { describe, expect, it } from 'vitest';
import { inquiryActions } from '@/features/activity';
import {
  activeShares,
  consentCsv,
  consentHistory,
  consentRows,
  csvCell,
  deletionConfirmed,
  isOpen,
  isSection,
  latestRequest,
  publicName,
  withPreference,
} from './model';

const ID = (n: number) => `0195f3b1-6a2b-7c3d-8e4f-${String(n).padStart(12, '0')}`;

const consent = (n: number, o: Partial<ConsentRecord> = {}): ConsentRecord => ({
  id: ID(n),
  created_at: '2026-09-23T10:00:00Z',
  updated_at: '2026-09-23T10:00:00Z',
  version: 1,
  subject_type: 'user',
  subject_id: ID(99),
  consent_type: 'ai_personalization',
  scope_entity_type: null,
  scope_entity_id: null,
  granted_to_type: 'platform',
  granted_to_id: null,
  policy_version: '2026-10',
  granted: true,
  granted_at: '2026-09-23T10:00:00Z',
  withdrawn_at: null,
  expires_at: null,
  source: 'ui',
  ...o,
});

const dsr = (n: number, o: Partial<DataSubjectRequest> = {}): DataSubjectRequest => ({
  id: ID(n),
  created_at: '2026-10-01T10:00:00Z',
  updated_at: '2026-10-01T10:00:00Z',
  version: 1,
  request_type: 'export',
  details: null,
  status: 'received',
  requested_at: '2026-10-01T10:00:00Z',
  due_at: '2026-11-01T10:00:00Z',
  rejection_reason: null,
  completed_at: null,
  export_available: false,
  ...o,
});

describe('profile', () => {
  it('previews the public name as "first name + initial"', () => {
    expect(publicName('Sara Mohammadi', null)).toBe('Sara M.');
    expect(publicName('Sara  Ahmadi Mohammadi', '')).toBe('Sara M.');
    expect(publicName('سارا محمدی', null)).toBe('سارا م.');
    expect(publicName('Sara', null)).toBe('Sara');
    expect(publicName('Sara Mohammadi', '  Sara the driver ')).toBe('Sara the driver');
  });

  it('knows its sections', () => {
    expect(isSection('security')).toBe(true);
    expect(isSection('billing')).toBe(false);
    expect(isSection(undefined)).toBe(false);
  });
});

describe('consents', () => {
  const now = Date.parse('2026-10-30T00:00:00Z');

  it('builds one row per general consent with its active records and latest change', () => {
    const rows = consentRows(
      [
        consent(1, { withdrawn_at: '2026-10-01T00:00:00Z' }),
        consent(2, { granted_at: '2026-10-05T00:00:00Z' }),
        consent(3, { consent_type: 'marketing', withdrawn_at: '2026-10-02T00:00:00Z' }),
        consent(4, { consent_type: 'location_usage', expires_at: '2026-10-10T00:00:00Z' }),
        // A scoped consent is a share, not a general row.
        consent(5, {
          consent_type: 'service_history_sharing',
          scope_entity_type: 'appointment',
          scope_entity_id: ID(50),
          granted_to_type: 'organization',
          granted_to_id: ID(60),
        }),
      ],
      now,
    );
    expect(rows.map((r) => r.type)).toEqual(['ai_personalization', 'marketing', 'review_invitations', 'location_usage']);
    expect(rows[0]!.active.map((c) => c.id)).toEqual([ID(2)]);
    expect(rows[1]!.active).toEqual([]);
    expect(rows[1]!.latest?.id).toBe(ID(3));
    expect(rows[2]!.latest).toBeNull();
    expect(rows[3]!.active).toEqual([]); // expired
  });

  it('lists active shares and a history with grants and withdrawals, newest first', () => {
    const records = [
      consent(1, { withdrawn_at: '2026-10-12T00:00:00Z' }),
      consent(5, {
        consent_type: 'showcase_publishing',
        scope_entity_type: 'portfolio_item',
        scope_entity_id: ID(50),
        granted_to_type: 'organization',
        granted_to_id: ID(60),
        granted_at: '2026-10-03T00:00:00Z',
      }),
    ];
    expect(activeShares(records, now).map((c) => c.id)).toEqual([ID(5)]);
    expect(consentHistory(records).map((e) => `${e.record.id}:${e.change}`)).toEqual([
      `${ID(1)}:withdrawn`,
      `${ID(5)}:granted`,
      `${ID(1)}:granted`,
    ]);
  });

  it('downloads the history as CSV with a header, statuses and safe cells', () => {
    const csv = consentCsv(
      [consent(1), consent(2, { consent_type: 'marketing', withdrawn_at: '2026-10-02T00:00:00Z', policy_version: '=HYPERLINK("x")' })],
      now,
    );
    const lines = csv.trimEnd().split('\r\n');
    expect(lines[0]).toBe(
      'consent_type,status,granted_at,withdrawn_at,expires_at,policy_version,scope_type,scope_id,granted_to_type,granted_to_id,source,record_id',
    );
    expect(lines[1]).toContain('ai_personalization,active,2026-09-23T10:00:00Z');
    expect(lines[2]).toContain('marketing,withdrawn');
    expect(lines[2]).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('-1')).toBe("'-1");
    expect(csvCell(null)).toBe('');
  });
});

describe('notification matrix', () => {
  const items: NotificationPreference[] = [
    { channel: 'email', category: 'reviews', enabled: true, frequency: 'immediate' },
    { channel: 'push', category: 'reviews', enabled: true, frequency: 'immediate' },
  ];
  it('changes one cell and keeps every other row (the put replaces the list)', () => {
    const next = withPreference(items, { channel: 'push', category: 'reviews', enabled: false });
    expect(next).toEqual([items[0], { ...items[1], enabled: false }]);
    expect(withPreference(items, { channel: 'email', category: 'reviews', frequency: 'daily_digest' })[0]!.frequency).toBe('daily_digest');
    expect(withPreference(items, { channel: 'in_app', category: 'community', enabled: true })).toHaveLength(3);
  });
});

describe('data requests', () => {
  it('finds the newest request of a type and whether it is still open', () => {
    const list = [dsr(1, { status: 'completed', requested_at: '2026-09-01T00:00:00Z' }), dsr(2), dsr(3, { request_type: 'deletion' })];
    expect(latestRequest(list, 'export')?.id).toBe(ID(2));
    expect(latestRequest(list, 'rectification')).toBeNull();
    expect(isOpen(list[0]!)).toBe(false);
    expect(isOpen(list[1]!)).toBe(true);
  });

  it('accepts the typed deletion word in any case and spacing only', () => {
    expect(deletionConfirmed(' delete ', 'DELETE')).toBe(true);
    expect(deletionConfirmed('حذف', 'حذف')).toBe(true);
    expect(deletionConfirmed('delet', 'DELETE')).toBe(false);
    expect(deletionConfirmed('', '')).toBe(false);
  });
});

describe('inquiry actions', () => {
  it('offers Cancel while open and "I picked it up" once answered or reserved', () => {
    expect(inquiryActions({ status: 'sent' })).toEqual({ cancel: true, pickedUp: false, message: true });
    expect(inquiryActions({ status: 'reserved' })).toEqual({ cancel: true, pickedUp: true, message: true });
    expect(inquiryActions({ status: 'completed' })).toEqual({ cancel: false, pickedUp: false, message: false });
    expect(inquiryActions({ status: 'unavailable' })).toEqual({ cancel: false, pickedUp: false, message: false });
  });
});
