// Small helpers for reading Docs/40.API contract.md: section tracking, fenced
// code blocks and markdown tables. No business knowledge here.

export interface Section {
  /** "12" for "# 12. Vehicles ...", "12.2" for "## 12.2 Operations". */
  number: string;
  title: string;
  /** Module named in the heading ("module `vehicle`"), if any. */
  module?: string;
}

export interface Line {
  /** 1-based line number in the document. */
  n: number;
  text: string;
}

export function lines(doc: string): Line[] {
  return doc
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((text, i) => ({ n: i + 1, text }));
}

const H1 = /^# (\d+)\.\s+(.*)$/;
const H2 = /^## (\d+(?:\.\d+)*)\s+(.*)$/;

export function parseH1(text: string): Section | null {
  const m = H1.exec(text);
  if (!m) return null;
  const module = /module `([a-z-]+)`/.exec(m[2]!)?.[1];
  return { number: m[1]!, title: m[2]!.replace(/\s+—.*$/, '').trim(), ...(module ? { module } : {}) };
}

export function parseH2(text: string): Section | null {
  const m = H2.exec(text);
  return m ? { number: m[1]!, title: m[2]!.trim() } : null;
}

/** Returns the fenced code blocks of the document with their language and start line. */
export function codeBlocks(all: Line[]): { lang: string; startLine: number; body: Line[] }[] {
  const out: { lang: string; startLine: number; body: Line[] }[] = [];
  let open: { lang: string; startLine: number; body: Line[] } | null = null;
  for (const l of all) {
    const fence = /^```(\w*)\s*$/.exec(l.text);
    if (fence) {
      if (open) {
        out.push(open);
        open = null;
      } else {
        open = { lang: fence[1] ?? '', startLine: l.n, body: [] };
      }
      continue;
    }
    if (open) open.body.push(l);
  }
  return out;
}

/** Parses a markdown table starting at the header row index; returns rows of trimmed cells. */
export function tableAt(all: Line[], headerIndex: number): string[][] {
  const rows: string[][] = [];
  for (let i = headerIndex; i < all.length; i++) {
    const t = all[i]!.text.trim();
    if (!t.startsWith('|')) break;
    if (/^\|[\s:|-]+\|$/.test(t)) continue; // separator row
    rows.push(splitTableRow(t));
  }
  return rows;
}

export function splitTableRow(row: string): string[] {
  // Cells are separated by '|' outside backticks; '\|' is a literal pipe.
  const cells: string[] = [];
  let cur = '';
  let inTick = false;
  const s = row.trim().replace(/^\|/, '').replace(/\|$/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === '\\' && s[i + 1] === '|') {
      cur += '|';
      i++;
      continue;
    }
    if (c === '`') inTick = !inTick;
    if (c === '|' && !inTick) {
      cells.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

/** All `backticked` fragments of a string. */
export function ticks(s: string): string[] {
  return [...s.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
}

/**
 * Splits on a separator at nesting depth 0 (outside (), <>, {}, [] and quotes).
 * Used for comma lists in q:, err:, emit: and tag arguments.
 */
export function splitTopLevel(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quote) {
      if (c === quote) quote = null;
      cur += c;
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    else if ('(<{['.includes(c)) depth++;
    else if (')>}]'.includes(c) && !(c === '>' && s[i - 1] === '-')) depth = Math.max(0, depth - 1);
    if (depth === 0 && s.startsWith(sep, i)) {
      out.push(cur.trim());
      cur = '';
      i += sep.length - 1;
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
