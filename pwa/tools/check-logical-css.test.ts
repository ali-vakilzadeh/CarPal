import { describe, expect, it } from 'vitest';
import { checkCss } from './check-logical-css.mjs';

describe('checkCss', () => {
  it('accepts logical properties and tokens', () => {
    expect(checkCss('.a { margin-inline-start: var(--space-2); inset-inline-end: 0; text-align: start; color: var(--ink); }')).toEqual([]);
  });

  it('flags physical properties and raw colours', () => {
    const css = [
      '.a {',
      '  margin-left: 4px;',
      '  right: 0;',
      '  text-align: right;',
      '  border-top-left-radius: 2px;',
      '  color: #0c1136;',
      '}',
    ].join('\n');
    expect(checkCss(css).map((p) => p.line)).toEqual([2, 3, 4, 5, 6]);
  });

  it('ignores comments', () => {
    expect(checkCss('/* never use margin-left: 0 or #fff here */ .a { padding-inline: 0; }')).toEqual([]);
  });
});
