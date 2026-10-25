import { describe, expect, it } from 'vitest';
import { BUNDLED, NAMESPACES, getTranslator, mergeDictionary, pickNamespaces, type MessageKey } from './dictionary';

describe('getTranslator', () => {
  it('translates namespaced keys per locale', () => {
    expect(getTranslator('en')('system.notFound.metaTitle')).toBe('Page not found');
    expect(getTranslator('fa')('system.notFound.metaTitle')).toBe('صفحه پیدا نشد');
  });

  it('falls back to the key for an unknown key', () => {
    expect(getTranslator('fa')('common.nope' as MessageKey)).toBe('common.nope');
    expect(getTranslator('en')('nope.at.all' as MessageKey)).toBe('nope.at.all');
  });

  it('interpolates variables as text', () => {
    expect(getTranslator('en')('shell.intent.follow', { name: '<b>Reza</b>' })).toBe('Sign in to follow <b>Reza</b>');
  });

  it('selects plurals and formats the count in the UI digits', () => {
    expect(getTranslator('en')('shell.garageBox.openIssues', { count: 1 })).toBe('1 open issue');
    expect(getTranslator('en')('shell.garageBox.openIssues', { count: 3 })).toBe('3 open issues');
    expect(getTranslator('fa')('shell.garageBox.openIssues', { count: 3 })).toBe('۳ مشکل باز');
    expect(getTranslator('fa')('shell.header.notificationsUnread', { count: 12 })).toBe('اعلان‌ها، ۱۲ خوانده‌نشده');
  });
});

describe('namespaces', () => {
  it('are the top-level keys of the dictionary', () => {
    expect(NAMESPACES).toEqual(expect.arrayContaining(['common', 'shell', 'states', 'system', 'consent', 'format', 'vehicle']));
  });

  it('picks only the requested namespaces', () => {
    const picked = pickNamespaces(BUNDLED.fa, ['shell']);
    expect(Object.keys(picked)).toEqual(['shell']);
    expect(picked.shell).toBe(BUNDLED.fa.shell);
  });
});

describe('mergeDictionary (CDN refresh)', () => {
  it('replaces and adds string leaves but never removes or retypes keys', () => {
    const merged = mergeDictionary(BUNDLED.en, {
      common: { appName: 'CarPal+', brandNew: 'New', theme: 'not an object', actions: { close: '' } },
      unknownNs: { a: 'b' },
      shell: null,
    });
    expect(merged.common.appName).toBe('CarPal+');
    expect((merged.common as unknown as Record<string, unknown>).brandNew).toBe('New');
    expect(merged.common.theme.light).toBe('Daylight');
    expect(merged.common.actions.close).toBe('Close');
    expect(merged.shell).toEqual(BUNDLED.en.shell);
    expect(BUNDLED.en.common.appName).toBe('CarPal');
  });

  it('ignores non-objects', () => {
    expect(mergeDictionary(BUNDLED.en, 'x')).toEqual(BUNDLED.en);
    expect(mergeDictionary(BUNDLED.en, [1, 2])).toEqual(BUNDLED.en);
  });
});
