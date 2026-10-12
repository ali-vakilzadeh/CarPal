import { describe, expect, it } from 'vitest';
import { CsvError, neutralizeCell, parseCsv, writeCsv, type CsvLimits } from './index.js';

const csv = (s: string) => Buffer.from(s, 'utf8');
const code = (fn: () => unknown) => {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof CsvError ? { code: e.code, line: e.line } : e;
  }
};

describe('parseCsv (SEC-IN-11 strict dialect)', () => {
  it('reads a header and records with quoted cells, escaped quotes, embedded newlines, CRLF/LF and a BOM', () => {
    const r = parseCsv(csv('﻿sku,name\r\nA-1,"Brake pad, front"\nB-2,"6"" disc"\r\n\r\nC-3,"two\nlines"\n'));
    expect(r.header).toEqual(['sku', 'name']);
    expect(r.records).toEqual([
      { line: 2, cells: ['A-1', 'Brake pad, front'] },
      { line: 3, cells: ['B-2', '6" disc'] },
      { line: 5, cells: ['C-3', 'two\nlines'] },
    ]);
  });

  it('keeps empty cells and short or long rows (reported per row by the caller)', () => {
    expect(parseCsv(csv('a,b,c\n1,,""\n2\n')).records).toEqual([
      { line: 2, cells: ['1', '', ''] },
      { line: 3, cells: ['2'] },
    ]);
    expect(parseCsv(csv('a\n""')).records).toEqual([{ line: 2, cells: [''] }]);
  });

  it('keeps formula-like cells as plain data', () => {
    expect(parseCsv(csv('sku,name\n=1+1,"=HYPERLINK(""http://x"",""y"")"\n')).records[0]!.cells).toEqual([
      '=1+1',
      '=HYPERLINK("http://x","y")',
    ]);
  });

  it('refuses malformed quoting, bare CR, invalid UTF-8 and empty files', () => {
    expect(code(() => parseCsv(csv('a\nx"y\n')))).toEqual({ code: 'malformed', line: 2 });
    expect(code(() => parseCsv(csv('a\n"x"y\n')))).toEqual({ code: 'malformed', line: 2 });
    expect(code(() => parseCsv(csv('a\n"open\n')))).toEqual({ code: 'malformed', line: 3 });
    expect(code(() => parseCsv(csv('a\rb\n')))).toEqual({ code: 'malformed', line: 1 });
    expect(code(() => parseCsv(Buffer.from([0x61, 0x0a, 0xff, 0xfe])))).toEqual({ code: 'encoding', line: null });
    expect(code(() => parseCsv(csv('\n\n')))).toEqual({ code: 'empty', line: null });
  });

  it('enforces size, row, column and cell limits', () => {
    const limits: CsvLimits = { maxBytes: 200, maxRows: 2, maxColumns: 3, maxCellChars: 5 };
    expect(code(() => parseCsv(csv('a\n'.repeat(101)), limits))).toEqual({ code: 'too_large', line: null });
    expect(code(() => parseCsv(csv('a\n1\n2\n3\n'), limits))).toEqual({ code: 'too_many_rows', line: 4 });
    expect(parseCsv(csv('a\n1\n\n2\n'), limits).records).toHaveLength(2); // blank lines do not count
    expect(code(() => parseCsv(csv('a,b,c,d\n'), limits))).toEqual({ code: 'too_many_columns', line: 1 });
    expect(code(() => parseCsv(csv('a\n123456\n'), limits))).toEqual({ code: 'cell_too_long', line: 2 });
    expect(code(() => parseCsv(csv('a\n"123456"\n'), limits))).toEqual({ code: 'cell_too_long', line: 2 });
  });
});

describe('writeCsv (formula-safe export)', () => {
  it('prefixes cells starting with = + - @ tab or CR, and quotes per RFC 4180', () => {
    expect(['=1+1', '+1', '-1', '@SUM(A1)', '\tx', '\rx', 'plain', ''].map(neutralizeCell)).toEqual([
      "'=1+1",
      "'+1",
      "'-1",
      "'@SUM(A1)",
      "'\tx",
      "'\rx",
      'plain',
      '',
    ]);
    expect(
      writeCsv([
        ['line', 'name'],
        ['2', 'a,"b"'],
        ['3', '=cmd|calc'],
      ]),
    ).toBe('line,name\r\n2,"a,""b"""\r\n3,\'=cmd|calc\r\n');
  });

  it('round-trips through the parser (after neutralization)', () => {
    const out = writeCsv([
      ['a', 'b'],
      ['x\ny', ' padded '],
    ]);
    expect(parseCsv(Buffer.from(out)).records[0]!.cells).toEqual(['x\ny', ' padded ']);
  });
});
