// A psql-compatible runner for the subset of psql the CarPal setup script uses
// (Docs/43.db_setup.sql), so it can be installed without a psql binary:
//
//   variables     -v name=value, \set, :name, :'name' (literal), :"name" (identifier), :{?name}
//   conditionals  \if / \elif / \else / \endif (psql boolean syntax)
//   queries       ';'  \gset (row → variables)  \gexec (every cell is executed as SQL)
//   session       \connect <db>, \echo, \pset (ignored), \set ON_ERROR_STOP / QUIET
//
// Statements run one by one in autocommit mode, like psql. Values reach the
// runner as text, exactly as psql prints them (booleans are 't' / 'f').
import type pg from 'pg';
import { scanCode, splitScript, type ScriptItem } from './lexer.js';

export type ConnectFn = (database: string) => Promise<pg.Client>;

export interface RunOptions {
  /** Opens a new session to the named database (psql \connect). */
  connect: ConnectFn;
  /** Database of the first session. */
  initialDatabase: string;
  /** psql -v variables. */
  variables?: Record<string, string>;
  /** Called for each statement after interpolation; return a replacement, or null to skip it. */
  rewrite?: (sql: string, line: number) => string | null;
  log?: (message: string) => void;
}

export interface RunResult {
  statements: number;
  skipped: number;
  variables: Record<string, string>;
  notices: string[];
}

export class PsqlScriptError extends Error {
  constructor(
    message: string,
    readonly line: number,
    readonly statement: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'PsqlScriptError';
  }
}

// Return every value as psql's text form (no JS parsing of booleans, numbers, dates).
const rawText = { getTypeParser: () => (value: string) => value } as unknown as pg.CustomTypesConfig;

export function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/** psql ParseVariableBool: unique prefixes of true/false/yes/no, on/off, 1/0. */
export function parsePsqlBool(raw: string): boolean {
  const v = raw.trim().toLowerCase();
  if (v.length === 0) throw new Error('empty boolean expression');
  if ('true'.startsWith(v) || 'yes'.startsWith(v) || v === 'on' || v === '1') return true;
  if ('false'.startsWith(v) || 'no'.startsWith(v) || v === 'off' || v === '0') return false;
  throw new Error(`unrecognized value "${raw}" for a boolean expression`);
}

const VAR = /^:(?:'([A-Za-z0-9_]+)'|"([A-Za-z0-9_]+)"|\{\?([A-Za-z0-9_]+)\}|([A-Za-z0-9_]+))/;

/**
 * Replaces psql variable references outside quotes and comments. Unknown
 * variables are left as written (psql behaviour), and '::' casts are not touched.
 */
export function interpolate(text: string, vars: Record<string, string>): string {
  const codeAt = new Uint8Array(text.length);
  for (const { i, code } of scanCode(text)) codeAt[i] = code ? 1 : 0;
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === ':' && codeAt[i] && text[i + 1] !== ':' && text[i - 1] !== ':') {
      const m = VAR.exec(text.slice(i));
      if (m) {
        const [whole, lit, ident, test, raw] = m;
        if (test !== undefined) {
          out += test in vars ? 'TRUE' : 'FALSE';
          i += whole.length;
          continue;
        }
        const name = (lit ?? ident ?? raw)!;
        if (name in vars) {
          const value = vars[name]!;
          out += lit !== undefined ? quoteLiteral(value) : ident !== undefined ? quoteIdent(value) : value;
          i += whole.length;
          continue;
        }
      }
    }
    out += c;
    i++;
  }
  return out;
}

/** Splits meta-command arguments on whitespace, honouring single quotes ('it''s'). */
function metaArgs(args: string, vars: Record<string, string>): string[] {
  const interpolated = interpolate(args, vars);
  const out: string[] = [];
  const re = /'((?:[^']|'')*)'|(\S+)/g;
  for (let m = re.exec(interpolated); m; m = re.exec(interpolated)) {
    out.push(m[1] !== undefined ? m[1].replace(/''/g, "'") : m[2]!);
  }
  return out;
}

interface IfFrame {
  /** The enclosing block is executing. */
  parentActive: boolean;
  /** A branch of this \if chain has already been taken. */
  taken: boolean;
  /** The current branch is executing. */
  active: boolean;
}

export async function runPsqlScript(script: string, opts: RunOptions): Promise<RunResult> {
  const items: ScriptItem[] = splitScript(script);
  const vars: Record<string, string> = { ...(opts.variables ?? {}) };
  const log = opts.log ?? (() => {});
  const notices: string[] = [];
  const ifs: IfFrame[] = [];
  const active = (): boolean => ifs.length === 0 || ifs[ifs.length - 1]!.active;

  let client = await opts.connect(opts.initialDatabase);
  // Server NOTICE / WARNING messages (pg-protocol NoticeMessage; @types/pg does not export it).
  const onNotice = (n: { severity?: string; message?: string }): void => {
    const msg = `${n.severity ?? 'NOTICE'}: ${n.message}`;
    notices.push(msg);
    if (n.severity === 'WARNING') log(msg);
  };
  client.on('notice', onNotice);

  let statements = 0;
  let skipped = 0;

  const exec = async (sql: string, line: number): Promise<pg.QueryResult> => {
    try {
      return await client.query({ text: sql, types: rawText });
    } catch (err) {
      const e = err as pg.DatabaseError;
      const where = e.where ? `\n  where: ${e.where}` : '';
      throw new PsqlScriptError(
        `Statement at line ${line} failed: ${e.message}${e.code ? ` (SQLSTATE ${e.code})` : ''}${where}\n  ${sql.slice(0, 300)}`,
        line,
        sql,
        err,
      );
    }
  };

  try {
    for (const item of items) {
      if (item.kind === 'meta') {
        const { command, line } = item;
        // Conditionals are evaluated even inside inactive branches (to track nesting).
        if (command === 'if') {
          const parentActive = active();
          const value = parentActive ? parsePsqlBool(metaArgs(item.args, vars).join(' ')) : false;
          ifs.push({ parentActive, taken: value, active: parentActive && value });
          continue;
        }
        if (command === 'elif' || command === 'else' || command === 'endif') {
          const frame = ifs[ifs.length - 1];
          if (!frame) throw new PsqlScriptError(`\\${command} without \\if`, line, '');
          if (command === 'endif') {
            ifs.pop();
          } else if (command === 'else') {
            frame.active = frame.parentActive && !frame.taken;
            frame.taken = true;
          } else {
            const value = frame.parentActive && !frame.taken ? parsePsqlBool(metaArgs(item.args, vars).join(' ')) : false;
            frame.active = value;
            frame.taken ||= value;
          }
          continue;
        }
        if (!active()) continue;
        switch (command) {
          case 'set': {
            const [name, ...rest] = metaArgs(item.args, vars);
            if (!name) throw new PsqlScriptError('\\set without a name', line, '');
            vars[name] = rest.join('');
            break;
          }
          case 'unset': {
            const [name] = metaArgs(item.args, vars);
            if (name) delete vars[name];
            break;
          }
          case 'echo':
            log(metaArgs(item.args, vars).join(' '));
            break;
          case 'pset':
            break;
          case 'c':
          case 'connect': {
            const [db] = metaArgs(item.args, vars);
            if (!db) throw new PsqlScriptError('\\connect without a database', line, '');
            client.off('notice', onNotice);
            await client.end();
            client = await opts.connect(db);
            client.on('notice', onNotice);
            break;
          }
          default:
            throw new PsqlScriptError(`Unsupported meta-command \\${command}`, line, '');
        }
        continue;
      }

      if (!active()) continue;
      const interpolated = interpolate(item.text, vars);
      const sql = opts.rewrite ? opts.rewrite(interpolated, item.line) : interpolated;
      if (sql === null) {
        skipped++;
        continue;
      }
      const result = await exec(sql, item.line);
      statements++;
      if (item.terminator === 'gset') {
        if (result.rows.length !== 1) {
          throw new PsqlScriptError(`\\gset expects exactly one row, got ${result.rows.length}`, item.line, sql);
        }
        const row = result.rows[0] as Record<string, string | null>;
        for (const [k, v] of Object.entries(row)) {
          if (v === null) delete vars[k];
          else vars[k] = v;
        }
      } else if (item.terminator === 'gexec') {
        for (const row of result.rows as Record<string, string | null>[]) {
          for (const cell of Object.values(row)) {
            if (cell === null) continue;
            await exec(cell, item.line);
            statements++;
          }
        }
      }
    }
    if (ifs.length > 0) throw new PsqlScriptError('Unterminated \\if block at end of script', items.at(-1)?.line ?? 0, '');
  } finally {
    client.off('notice', onNotice);
    await client.end().catch(() => {});
  }
  return { statements, skipped, variables: vars, notices };
}
