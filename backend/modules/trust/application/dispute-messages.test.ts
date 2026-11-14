// S20 (BR-28): which thread of a dispute a caller reads and answers.
import { describe, expect, it } from 'vitest';
import type { DisputeRow } from '../api/projections.js';
import { sideOf } from './dispute-messages.js';

const dispute = (o: Partial<DisputeRow>) =>
  ({
    raised_by_user_id: 'raiser',
    raised_by_organization_id: null,
    respondent_user_id: null,
    respondent_organization_id: null,
    ...o,
  }) as DisputeRow;

describe('sideOf', () => {
  it('names the raiser and the recorded respondent, personally or for their organization', () => {
    expect(sideOf(dispute({}), 'raiser', null)).toBe('raiser');
    expect(sideOf(dispute({ respondent_user_id: 'author' }), 'author', null)).toBe('respondent');
    expect(sideOf(dispute({ raised_by_organization_id: 'org' }), 'someone', 'org')).toBe('raiser');
    expect(sideOf(dispute({ respondent_organization_id: 'biz' }), 'manager', 'biz')).toBe('respondent');
  });

  it('gives no thread to anyone else, nor to a respondent CarPal has not written to yet', () => {
    expect(sideOf(dispute({}), 'author', null)).toBeNull();
    expect(sideOf(dispute({ raised_by_organization_id: 'org' }), 'raiser', 'other-org')).toBeNull();
    expect(sideOf(dispute({ respondent_user_id: 'author' }), 'author', 'org')).toBeNull();
  });
});
