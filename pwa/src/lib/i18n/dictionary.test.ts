import { describe, expect, it } from 'vitest';
import { getTranslator, type MessageKey } from './dictionary';

describe('getTranslator', () => {
  it('translates per locale', () => {
    expect(getTranslator('en')('common.notFound.title')).toBe('Page not found');
    expect(getTranslator('fa')('common.notFound.title')).toBe('صفحه پیدا نشد');
  });

  it('falls back to the key for an unknown key', () => {
    expect(getTranslator('fa')('common.nope' as MessageKey)).toBe('common.nope');
  });
});
