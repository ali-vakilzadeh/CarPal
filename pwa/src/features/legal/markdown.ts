// A parser for the Markdown subset of the legal texts (P13.T7): headings (#, ##, ###), paragraphs, bullet and numbered
// lists, pipe tables, **bold** and backslash escapes. No HTML, links or images: the texts have none, and anything
// else stays plain text, so the output can never carry markup from the source. Placeholders such as [SUPPORT EMAIL]
// become inline tokens; the page fills in the ones the deployment knows and shows the others as written.

export type Inline = { kind: 'text'; text: string } | { kind: 'strong'; text: string } | { kind: 'placeholder'; name: string };

export type Block =
  | { kind: 'heading'; level: 1 | 2 | 3; id: string; text: string; inline: Inline[] }
  | { kind: 'paragraph'; inline: Inline[] }
  | { kind: 'list'; ordered: boolean; items: Inline[][] }
  | { kind: 'table'; head: Inline[][]; rows: Inline[][][] };

/** "10.4 Cookies and similar technologies" → "section-10-4"; headings without a number get a slug of their words. */
export function headingId(text: string): string {
  const n = /^(\d+(?:\.\d+)*)\.?\s/.exec(text);
  if (n) return `section-${n[1]!.replace(/\./g, '-')}`;
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'section'
  );
}

/** Splits a line into text, **bold** and \[PLACEHOLDER\] runs; backslash escapes are resolved. */
export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let text = '';
  let strong: string | null = null;
  const flush = () => {
    if (!text) return;
    if (strong !== null) strong += text;
    else out.push({ kind: 'text', text });
    text = '';
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (c === '\\' && src[i + 1] === '[') {
      const end = src.indexOf('\\]', i + 2);
      if (end > i) {
        const name = src.slice(i + 2, end);
        if (/^[A-Z][A-Z0-9 ,/()-]*$/.test(name)) {
          flush();
          if (strong !== null) {
            // A placeholder inside bold text: close the bold run around it.
            if (strong) out.push({ kind: 'strong', text: strong });
            out.push({ kind: 'placeholder', name });
            strong = '';
          } else out.push({ kind: 'placeholder', name });
          i = end + 1;
          continue;
        }
      }
    }
    if (c === '\\' && i + 1 < src.length && /[\\`*_{}[\]()#+\-.!|>~]/.test(src[i + 1]!)) {
      text += src[++i];
      continue;
    }
    if (c === '*' && src[i + 1] === '*') {
      flush();
      if (strong === null) strong = '';
      else {
        if (strong) out.push({ kind: 'strong', text: strong });
        strong = null;
      }
      i++;
      continue;
    }
    text += c;
  }
  flush();
  // An unclosed ** is literal text.
  if (strong !== null) out.push({ kind: 'text', text: `**${strong}` });
  return merge(out);
}

function merge(runs: Inline[]): Inline[] {
  const out: Inline[] = [];
  for (const r of runs) {
    const last = out[out.length - 1];
    if (last && last.kind === r.kind && r.kind !== 'placeholder' && last.kind !== 'placeholder') last.text += r.text;
    else out.push({ ...r });
  }
  return out;
}

export const plainText = (inline: readonly Inline[]): string =>
  inline.map((r) => (r.kind === 'placeholder' ? `[${r.name}]` : r.text)).join('');

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, '')
    .split(/(?<!\\)\|/)
    .map((c) => parseInline(c.trim()));

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      const inline = parseInline(h[2]!.trim());
      const text = plainText(inline);
      blocks.push({ kind: 'heading', level: h[1]!.length as 1 | 2 | 3, id: headingId(text), text, inline });
      i++;
      continue;
    }
    if (line.trimStart().startsWith('|') && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1] ?? '')) {
      const head = cells(line);
      const rows: Inline[][][] = [];
      i += 2;
      while (i < lines.length && lines[i]!.trimStart().startsWith('|')) rows.push(cells(lines[i++]!));
      blocks.push({ kind: 'table', head, rows });
      continue;
    }
    const bullet = /^\s*[-*]\s+/;
    const numbered = /^\s*\d+\.\s+/;
    if (bullet.test(line) || numbered.test(line)) {
      const ordered = numbered.test(line);
      const marker = ordered ? numbered : bullet;
      const items: Inline[][] = [];
      while (i < lines.length && marker.test(lines[i]!)) items.push(parseInline(lines[i++]!.replace(marker, '').trim()));
      blocks.push({ kind: 'list', ordered, items });
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() &&
      !/^#{1,3}\s/.test(lines[i]!) &&
      !/^\s*([-*]|\d+\.)\s+/.test(lines[i]!) &&
      !lines[i]!.trimStart().startsWith('|')
    )
      para.push(lines[i++]!.trim());
    blocks.push({ kind: 'paragraph', inline: parseInline(para.join(' ')) });
  }
  return blocks;
}

/** The ## sections, for the table of contents. */
export function sections(blocks: readonly Block[]): { id: string; text: string }[] {
  return blocks.flatMap((b) => (b.kind === 'heading' && b.level === 2 ? [{ id: b.id, text: b.text }] : []));
}

export interface LegalDocument {
  title: string;
  blocks: Block[];
  sections: { id: string; text: string }[];
}

/** The parsed text: the # heading becomes the title, the rest the body. */
export function legalDocument(markdown: string): LegalDocument {
  const all = parseMarkdown(markdown);
  const first = all[0];
  const title = first?.kind === 'heading' && first.level === 1 ? first.text : '';
  const blocks = title ? all.slice(1) : all;
  return { title, blocks, sections: sections(blocks) };
}
