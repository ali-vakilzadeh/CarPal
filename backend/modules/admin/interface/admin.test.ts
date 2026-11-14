// Unit checks of the S18 moderation helpers: the A-CON-01 severity floor (BR-32) and the one-line excerpt of
// CaseTargetSummary (BR-27).
import { describe, expect, it } from 'vitest';
import { caseSeverity, excerpt, SEVERITY_FLOOR_REASONS } from './admin.js';

describe('caseSeverity (Docs/23 A-CON-01)', () => {
  it('raises low and medium to high for the floor reasons and keeps high and critical', () => {
    for (const reason of SEVERITY_FLOOR_REASONS) {
      expect(caseSeverity(reason, 'low')).toBe('high');
      expect(caseSeverity(reason, 'medium')).toBe('high');
      expect(caseSeverity(reason, 'high')).toBe('high');
      expect(caseSeverity(reason, 'critical')).toBe('critical');
    }
    expect([...SEVERITY_FLOOR_REASONS].sort()).toEqual(['non_consensual_media', 'privacy', 'unsafe_advice']);
  });

  it('leaves other reasons as given', () => {
    expect(caseSeverity('spam', 'low')).toBe('low');
    expect(caseSeverity('fake', 'medium')).toBe('medium');
  });
});

describe('excerpt (40 CaseTargetSummary.excerpt)', () => {
  it('collapses whitespace to one line and is null without text', () => {
    expect(excerpt('  Brake\n\tfluid   check ')).toBe('Brake fluid check');
    expect(excerpt('   ')).toBeNull();
    expect(excerpt(null)).toBeNull();
    expect(excerpt(undefined)).toBeNull();
  });

  it('cuts at 120 characters (code points) with an ellipsis', () => {
    const long = 'a'.repeat(200);
    expect([...excerpt(long)!]).toHaveLength(120);
    expect(excerpt(long)!.endsWith('…')).toBe(true);
    expect(excerpt('b'.repeat(120))).toBe('b'.repeat(120));
    // Persian text and emoji count as one character each.
    const fa = 'ترمز '.repeat(40);
    expect([...excerpt(fa)!].length).toBeLessThanOrEqual(120);
    expect([...excerpt('🚗'.repeat(130))!]).toHaveLength(120);
  });
});
