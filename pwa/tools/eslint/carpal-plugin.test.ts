import { RuleTester } from 'eslint';
import { describe, expect, it } from 'vitest';
import tseslint from 'typescript-eslint';
import carpal, { classTokens, hasRawValue, isPhysicalClass } from './carpal-plugin.js';

RuleTester.describe = describe;
RuleTester.it = it;
const tester = new RuleTester({
  languageOptions: { parser: tseslint.parser, parserOptions: { ecmaFeatures: { jsx: true } } },
});

describe('class helpers', () => {
  it('strips variants and the important mark', () => {
    expect(classTokens('md:ml-4 hover:!pe-2  rtl:text-left')).toEqual(['ml-4', 'pe-2', 'text-left']);
  });
  it('flags physical utilities only', () => {
    for (const c of [
      'ml-4',
      'mr-auto',
      '-ml-2',
      'pl-3',
      'pr-0',
      'left-0',
      'right-4',
      'text-left',
      'text-right',
      'float-left',
      'border-l',
      'border-r-2',
      'rounded-tl-ds-md',
      'rounded-l',
    ]) {
      expect(isPhysicalClass(c), c).toBe(true);
    }
    for (const c of [
      'ms-4',
      'me-auto',
      'ps-3',
      'pe-0',
      'start-0',
      'end-4',
      'text-start',
      'text-end',
      'border-s',
      'rounded-ds-md',
      'mx-auto',
      'px-4',
      'leading-6',
    ]) {
      expect(isPhysicalClass(c), c).toBe(false);
    }
  });
  it('flags raw values in arbitrary utilities only', () => {
    expect(hasRawValue('bg-[#ffa41b]')).toBe(true);
    expect(hasRawValue('p-[13px]')).toBe(true);
    expect(hasRawValue('text-[rgb(0,0,0)]')).toBe(true);
    expect(hasRawValue('p-[var(--tap-min)]')).toBe(false);
    expect(hasRawValue('p-4')).toBe(false);
  });
});

tester.run('logical-properties', carpal.rules['logical-properties'], {
  valid: [
    { code: '<div className="ms-4 pe-2 text-start" />' },
    { code: '<div className={cx("ps-4", active && "me-2")} />' },
    { code: '<div style={{ marginInlineStart: 4, textAlign: "start" }} />' },
  ],
  invalid: [
    { code: '<div className="ml-4 text-right" />', errors: [{ messageId: 'physicalClass' }, { messageId: 'physicalClass' }] },
    {
      code: '<div className={`pr-2 ${x ? "left-0" : "start-0"}`} />',
      errors: [{ messageId: 'physicalClass' }, { messageId: 'physicalClass' }],
    },
    { code: 'const c = cx("float-left");', errors: [{ messageId: 'physicalClass' }] },
    {
      code: '<div style={{ marginLeft: 4, textAlign: "right" }} />',
      errors: [{ messageId: 'physicalStyle' }, { messageId: 'physicalValue' }],
    },
  ],
});

tester.run('no-raw-design-values', carpal.rules['no-raw-design-values'], {
  valid: [{ code: '<div className="bg-surface p-[var(--space-4)]" style={{ color: "var(--ink)" }} />' }],
  invalid: [
    { code: '<div className="bg-[#fff] p-[13px]" />', errors: [{ messageId: 'rawClass' }, { messageId: 'rawClass' }] },
    { code: '<div style={{ color: "#0c1136", padding: "12px" }} />', errors: [{ messageId: 'rawStyle' }, { messageId: 'rawStyle' }] },
  ],
});
