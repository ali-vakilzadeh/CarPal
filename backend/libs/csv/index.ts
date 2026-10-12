// CSV (40 SEC-IN-11): imports are parsed as data with a strict dialect
// (UTF-8, RFC 4180: comma, double-quote quoting, CRLF or LF) within fixed
// limits; nothing in a cell is ever evaluated. Exports neutralize formula
// injection: a cell starting with =, +, -, @, tab or carriage return gets a
// leading apostrophe, so a spreadsheet shows it as text.

export const CSV_LIMITS = {
  maxBytes: 20 * 1024 * 1024,
  maxRows: 20_000,
  maxColumns: 64,
  maxCellChars: 2_000,
} as const;

export interface CsvLimits {
  maxBytes: number;
  maxRows: number;
  maxColumns: number;
  maxCellChars: number;
}

export type CsvErrorCode = 'encoding' | 'too_large' | 'too_many_rows' | 'too_many_columns' | 'cell_too_long' | 'malformed' | 'empty';

/** A file-level failure: the whole file is refused. */
export class CsvError extends Error {
  constructor(
    readonly code: CsvErrorCode,
    /** 1-based physical line where the problem was found, when it has one. */
    readonly line: number | null = null,
  ) {
    super(line === null ? `csv ${code}` : `csv ${code} at line ${line}`);
    this.name = 'CsvError';
  }
}

export interface CsvRecord {
  /** 1-based physical line on which the record starts. */
  line: number;
  cells: string[];
}

export interface ParsedCsv {
  header: string[];
  /** Data records (without the header); blank lines are skipped. */
  records: CsvRecord[];
}

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });

/**
 * Parses a CSV file with a header row. Throws CsvError for anything outside
 * the dialect or the limits. Records may have a different cell count than
 * the header; the caller reports those per row. Blank lines are skipped.
 */
export function parseCsv(bytes: Buffer, limits: CsvLimits = CSV_LIMITS): ParsedCsv {
  if (bytes.length > limits.maxBytes) throw new CsvError('too_large');
  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch {
    throw new CsvError('encoding');
  }
  const [head, ...records] = tokenize(text, limits);
  if (!head) throw new CsvError('empty');
  return { header: head.cells, records };
}

const QUOTE = '"';
const COMMA = ',';
const CR = '\r';
const LF = '\n';

function tokenize(text: string, limits: CsvLimits): CsvRecord[] {
  const out: CsvRecord[] = [];
  let line = 1;
  let recordLine = 1;
  let cells: string[] = [];
  let cell = '';
  /** The current cell was quoted (an empty quoted cell still counts, and nothing may follow the closing quote). */
  let quoted = false;
  const endCell = () => {
    if (cell.length > limits.maxCellChars) throw new CsvError('cell_too_long', line);
    cells.push(cell);
    if (cells.length > limits.maxColumns) throw new CsvError('too_many_columns', recordLine);
    cell = '';
    quoted = false;
  };
  const endRecord = () => {
    const blank = cells.length === 0 && cell === '' && !quoted;
    if (!blank) {
      endCell();
      out.push({ line: recordLine, cells });
      // Header + data rows.
      if (out.length > limits.maxRows + 1) throw new CsvError('too_many_rows', recordLine);
    }
    cells = [];
    cell = '';
    quoted = false;
  };
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i]!;
    if (c === QUOTE) {
      if (cell !== '' || quoted) throw new CsvError('malformed', line); // a quote inside an unquoted or closed field
      quoted = true;
      i++;
      for (;;) {
        if (i >= n) throw new CsvError('malformed', line); // unterminated quoted field
        const q = text[i]!;
        if (q === QUOTE) {
          if (text[i + 1] === QUOTE) {
            cell += QUOTE;
            i += 2;
            continue;
          }
          i++;
          break;
        }
        if (q === LF) line++;
        cell += q;
        if (cell.length > limits.maxCellChars) throw new CsvError('cell_too_long', line);
        i++;
      }
      continue;
    }
    if (c === COMMA) {
      endCell();
      i++;
      continue;
    }
    if (c === CR || c === LF) {
      if (c === CR && text[i + 1] !== LF) throw new CsvError('malformed', line); // bare CR
      i += c === CR ? 2 : 1;
      endRecord();
      line++;
      recordLine = line;
      continue;
    }
    if (quoted) throw new CsvError('malformed', line); // text after a closing quote
    cell += c;
    i++;
  }
  endRecord();
  return out;
}

const FORMULA_START = /^[=+\-@\t\r]/;

/** SEC-IN-11: a cell that a spreadsheet could evaluate is prefixed with an apostrophe. */
export function neutralizeCell(value: string): string {
  return FORMULA_START.test(value) ? `'${value}` : value;
}

const NEEDS_QUOTES = /[",\r\n]|^\s|\s$/;

/** Writes RFC 4180 CSV (CRLF line ends) with formula-neutralized cells. */
export function writeCsv(rows: readonly (readonly string[])[]): string {
  return rows
    .map((r) =>
      r
        .map((raw) => {
          const v = neutralizeCell(raw);
          return NEEDS_QUOTES.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
        })
        .join(','),
    )
    .map((l) => `${l}\r\n`)
    .join('');
}
