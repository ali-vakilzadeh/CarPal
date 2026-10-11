// Splits a psql script into SQL statements and backslash meta-commands, the way
// psql does: a statement ends at a top-level ';' (outside quotes, dollar quotes,
// comments and parentheses) or at a \gset / \gexec meta-command.
//
// Supported: '...' (with '' escapes), E'...' (backslash escapes), "...", $tag$...$tag$,
// -- line comments, nested /* */ comments. Not supported: BEGIN ATOMIC bodies,
// \copy, \i (the CarPal setup script uses none of them).

export type QueryTerminator = 'semicolon' | 'gset' | 'gexec' | 'eof';

export type ScriptItem =
  { kind: 'sql'; text: string; line: number; terminator: QueryTerminator } | { kind: 'meta'; command: string; args: string; line: number };

const isIdentChar = (c: string | undefined): boolean => c !== undefined && /[A-Za-z0-9_$]/.test(c);

/** Matches a dollar-quote opening tag ($$ or $tag$) at position i, or returns null. */
export function dollarTagAt(s: string, i: number): string | null {
  if (s[i] !== '$') return null;
  // A '$' that continues an identifier or a positional parameter ($1) is not a quote.
  if (isIdentChar(s[i - 1])) return null;
  const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(s.slice(i, i + 64));
  return m ? m[0] : null;
}

/**
 * Walks the text and reports, for every index, whether it is "code" (outside any
 * quote or comment). Shared by the splitter and the variable interpolator so both
 * agree on what is quoted.
 */
export function* scanCode(s: string): Generator<{ i: number; code: boolean }> {
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    const next = s[i + 1];
    if (c === '-' && next === '-') {
      const end = s.indexOf('\n', i);
      const stop = end === -1 ? s.length : end;
      for (; i < stop; i++) yield { i, code: false };
      continue;
    }
    if (c === '/' && next === '*') {
      let depth = 0;
      while (i < s.length) {
        if (s[i] === '/' && s[i + 1] === '*') {
          depth++;
          yield { i, code: false };
          yield { i: i + 1, code: false };
          i += 2;
        } else if (s[i] === '*' && s[i + 1] === '/') {
          depth--;
          yield { i, code: false };
          yield { i: i + 1, code: false };
          i += 2;
          if (depth === 0) break;
        } else {
          yield { i, code: false };
          i++;
        }
      }
      continue;
    }
    if (c === "'") {
      const escapes = (s[i - 1] === 'E' || s[i - 1] === 'e') && !isIdentChar(s[i - 2]);
      yield { i, code: false };
      i++;
      while (i < s.length) {
        if (escapes && s[i] === '\\') {
          yield { i, code: false };
          yield { i: i + 1, code: false };
          i += 2;
          continue;
        }
        if (s[i] === "'") {
          if (s[i + 1] === "'") {
            yield { i, code: false };
            yield { i: i + 1, code: false };
            i += 2;
            continue;
          }
          yield { i, code: false };
          i++;
          break;
        }
        yield { i, code: false };
        i++;
      }
      continue;
    }
    if (c === '"') {
      yield { i, code: false };
      i++;
      while (i < s.length) {
        if (s[i] === '"') {
          if (s[i + 1] === '"') {
            yield { i, code: false };
            yield { i: i + 1, code: false };
            i += 2;
            continue;
          }
          yield { i, code: false };
          i++;
          break;
        }
        yield { i, code: false };
        i++;
      }
      continue;
    }
    if (c === '$') {
      const tag = dollarTagAt(s, i);
      if (tag) {
        const close = s.indexOf(tag, i + tag.length);
        const stop = close === -1 ? s.length : close + tag.length;
        for (; i < stop; i++) yield { i, code: false };
        continue;
      }
    }
    yield { i, code: true };
    i++;
  }
}

/** Splits a psql script into statements and meta-commands, with 1-based line numbers. */
export function splitScript(script: string): ScriptItem[] {
  const s = script.replace(/\r\n/g, '\n');
  const items: ScriptItem[] = [];
  // Line starts for 1-based line numbers in error messages.
  const lineStarts: number[] = [0];
  for (let k = 0; k < s.length; k++) if (s.charCodeAt(k) === 10) lineStarts.push(k + 1);
  const lineOf = (idx: number): number => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid]! <= idx) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };

  let bufStart = 0;
  let depth = 0;
  let skipUntil = -1;

  const pushSql = (end: number, terminator: QueryTerminator): void => {
    const text = s.slice(bufStart, end);
    if (hasCode(text)) items.push({ kind: 'sql', text: text.trim(), line: lineOf(firstCodeIndex(s, bufStart, end)), terminator });
  };

  for (const { i, code } of scanCode(s)) {
    if (i < skipUntil || !code) continue;
    const c = s[i]!;
    if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (c === ';' && depth === 0) {
      pushSql(i + 1, 'semicolon');
      bufStart = i + 1;
    } else if (c === '\\') {
      const eol = s.indexOf('\n', i);
      const end = eol === -1 ? s.length : eol;
      const line = s.slice(i + 1, end);
      const m = /^([A-Za-z]+)\s*(.*)$/.exec(line);
      if (!m) throw new Error(`Unsupported backslash sequence at line ${lineOf(i)}: \\${line.slice(0, 20)}`);
      const command = m[1]!;
      const args = (m[2] ?? '').trim();
      const pending = hasCode(s.slice(bufStart, i));
      if (command === 'gset' || command === 'gexec') {
        if (!pending) throw new Error(`\\${command} without a query at line ${lineOf(i)}`);
        pushSql(i, command);
        if (command === 'gset' && args) throw new Error(`\\gset prefixes are not supported (line ${lineOf(i)})`);
      } else {
        if (pending) throw new Error(`Meta-command \\${command} inside an unfinished statement at line ${lineOf(i)}`);
        items.push({ kind: 'meta', command, args, line: lineOf(i) });
      }
      bufStart = end;
      skipUntil = end;
      depth = 0;
    }
  }
  pushSql(s.length, 'eof');
  return items;
}

function firstCodeIndex(s: string, start: number, end: number): number {
  const slice = s.slice(start, end);
  for (const { i, code } of scanCode(slice)) if (code && !/\s/.test(slice[i]!)) return start + i;
  return start;
}

/** True when the text holds anything other than whitespace and comments (every statement starts with a keyword). */
export function hasCode(text: string): boolean {
  for (const { i, code } of scanCode(text)) if (code && !/\s/.test(text[i]!)) return true;
  return false;
}
