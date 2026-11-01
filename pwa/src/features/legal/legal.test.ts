import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SOURCES, render, versionOf } from '../../../tools/sync-legal.mjs';
import { LEGAL_VERSIONS, legalDoc } from './documents';
import { LEGAL_TEXTS } from './generated/texts';
import { headingId, legalDocument, parseInline, parseMarkdown, plainText } from './markdown';

describe('legal markdown subset (P13.T7)', () => {
  it('parses bold runs, escapes and placeholders; never produces markup from the source', () => {
    expect(parseInline('**Our role.** For most processing, \\[LEGAL ENTITY NAME\\] decides')).toEqual([
      { kind: 'strong', text: 'Our role.' },
      { kind: 'text', text: ' For most processing, ' },
      { kind: 'placeholder', name: 'LEGAL ENTITY NAME' },
      { kind: 'text', text: ' decides' },
    ]);
    expect(parseInline('within \\[30\\] days')).toEqual([{ kind: 'text', text: 'within [30] days' }]);
    expect(parseInline('a <script>x</script> and **open')).toEqual([{ kind: 'text', text: 'a <script>x</script> and **open' }]);
    expect(plainText(parseInline('Write to \\[SUPPORT EMAIL\\].'))).toBe('Write to [SUPPORT EMAIL].');
  });

  it('parses headings with section ids, lists, numbered lists, tables and paragraphs', () => {
    const blocks = parseMarkdown(
      [
        '## 10. Security',
        '',
        '### 10.4 Cookies and similar technologies',
        'First line',
        'continues here.',
        '',
        '- one',
        '- **two**',
        '1. first',
        '2. second',
        '',
        '| A | B |',
        '| --- | --- |',
        '| a1 | b1 |',
      ].join('\n'),
    );
    expect(blocks.map((b) => b.kind)).toEqual(['heading', 'heading', 'paragraph', 'list', 'list', 'table']);
    expect(blocks[1]).toMatchObject({ level: 3, id: 'section-10-4' });
    expect(blocks[2]).toEqual({ kind: 'paragraph', inline: [{ kind: 'text', text: 'First line continues here.' }] });
    expect(blocks[3]).toMatchObject({ ordered: false, items: [[{ text: 'one' }], [{ kind: 'strong', text: 'two' }]] });
    expect(blocks[4]).toMatchObject({ ordered: true });
    expect(blocks[5]).toMatchObject({ head: [[{ text: 'A' }], [{ text: 'B' }]], rows: [[[{ text: 'a1' }], [{ text: 'b1' }]]] });
    expect(headingId('How it is organized')).toBe('how-it-is-organized');
  });

  it('reads the published texts: title, sections and the cookie section the banner links to', () => {
    const privacy = legalDoc('privacy');
    expect(privacy.title).toBe('CarPal Privacy Policy');
    expect(privacy.sections.length).toBeGreaterThanOrEqual(10);
    expect(privacy.blocks.some((b) => b.kind === 'heading' && b.id === 'section-10-4' && b.text.includes('Cookies'))).toBe(true);
    expect(privacy.blocks.some((b) => b.kind === 'table')).toBe(true);
    const terms = legalDoc('terms');
    expect(terms.title).toBe('CarPal User Agreement');
    expect(terms.sections[0]).toEqual({ id: 'section-1', text: '1. About this agreement' });
    // Every block has text: nothing of the source was dropped silently.
    const blank = [...privacy.blocks, ...terms.blocks].filter((b) => b.kind === 'paragraph' && !plainText(b.inline).trim());
    expect(blank).toEqual([]);
  });

  it('takes the accepted versions from the texts and keeps the generated module in step with Docs/', () => {
    expect(LEGAL_VERSIONS).toEqual({ privacy: '1.0', terms: '1.0' });
    expect(versionOf('Effective date: \\[EFFECTIVE DATE\\] · Version 2.1 (pilot)')).toBe('2.1');
    expect(() => versionOf('# no version')).toThrow(/Version/);
    const generated = readFileSync(join(import.meta.dirname, 'generated', 'texts.ts'), 'utf8').replace(/\r\n/g, '\n');
    const docs = Object.fromEntries(Object.entries(SOURCES).map(([k, f]) => [k, readFileSync(f as string, 'utf8')]));
    expect(generated).toBe(render(docs));
    expect(legalDocument(LEGAL_TEXTS.terms.markdown).title).toBe('CarPal User Agreement');
  });
});
