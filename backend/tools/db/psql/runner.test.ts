import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { interpolate, parsePsqlBool, runPsqlScript } from './runner.js';

describe('interpolate', () => {
  const vars = { env: 'dev', name: "o'brien", db: 'car"pal' };

  it('substitutes literal, identifier and raw forms', () => {
    expect(interpolate('SELECT :\'env\', :"db", :env', vars)).toBe(`SELECT 'dev', "car""pal", dev`);
    expect(interpolate("SELECT :'name'", vars)).toBe(`SELECT 'o''brien'`);
  });

  it('tests variable existence with :{?name}', () => {
    expect(interpolate('\\if :{?env} :{?missing}', vars)).toBe('\\if TRUE FALSE');
  });

  it('leaves casts, unknown variables, quoted and dollar-quoted text alone', () => {
    const sql = "SELECT x::text, a[1:2], :unknown, ':env', $$ :env $$ -- :env";
    expect(interpolate(sql, vars)).toBe(sql);
  });
});

describe('parsePsqlBool', () => {
  it('accepts psql boolean spellings', () => {
    for (const v of ['t', 'true', 'on', '1', 'y', 'YES']) expect(parsePsqlBool(v)).toBe(true);
    for (const v of ['f', 'false', 'off', '0', 'n', 'No']) expect(parsePsqlBool(v)).toBe(false);
    expect(() => parsePsqlBool('maybe')).toThrow();
  });
});

/** Minimal stand-in for pg.Client: records statements and answers from a table. */
function fakeConnect(answers: Record<string, Record<string, string | null>[]>, log: string[]) {
  return async (database: string): Promise<pg.Client> => {
    log.push(`connect ${database}`);
    const client = {
      on: () => client,
      off: () => client,
      end: async () => {},
      query: async ({ text }: { text: string }) => {
        log.push(text);
        if (text.includes('fail')) throw Object.assign(new Error('boom'), { code: 'XX000' });
        return { rows: answers[text] ?? [] };
      },
    };
    return client as unknown as pg.Client;
  };
}

describe('runPsqlScript', () => {
  it('follows conditionals, \\gset, \\gexec and \\connect', async () => {
    const log: string[] = [];
    const script = [
      '\\if :{?env}',
      '\\else',
      '  \\set env dev',
      '\\endif',
      "SELECT :'env' = 'dev' AS is_dev \\gset",
      '\\if :is_dev',
      "  SELECT 'dev branch';",
      '\\else',
      "  SELECT 'other branch';",
      '\\endif',
      "SELECT 'CREATE TABLE t1()' AS a, NULL AS b UNION ALL SELECT 'CREATE TABLE t2()', NULL \\gexec",
      '\\connect :db',
      'SELECT 2;',
    ].join('\n');
    const answers = {
      "SELECT 'dev' = 'dev' AS is_dev": [{ is_dev: 't' }],
      "SELECT 'CREATE TABLE t1()' AS a, NULL AS b UNION ALL SELECT 'CREATE TABLE t2()', NULL": [
        { a: 'CREATE TABLE t1()', b: null },
        { a: 'CREATE TABLE t2()', b: null },
      ],
    };
    const result = await runPsqlScript(script, {
      connect: fakeConnect(answers, log),
      initialDatabase: 'postgres',
      variables: { db: 'carpal' },
    });
    expect(log).toEqual([
      'connect postgres',
      "SELECT 'dev' = 'dev' AS is_dev",
      "SELECT 'dev branch';",
      "SELECT 'CREATE TABLE t1()' AS a, NULL AS b UNION ALL SELECT 'CREATE TABLE t2()', NULL",
      'CREATE TABLE t1()',
      'CREATE TABLE t2()',
      'connect carpal',
      'SELECT 2;',
    ]);
    expect(result.variables).toMatchObject({ env: 'dev', is_dev: 't' });
    expect(result.statements).toBe(6); // gset query, branch, gexec query + its two statements, final select
  });

  it('applies the rewrite hook and can skip statements', async () => {
    const log: string[] = [];
    const result = await runPsqlScript('SELECT 1; SELECT 2;', {
      connect: fakeConnect({}, log),
      initialDatabase: 'x',
      rewrite: (sql) => (sql.includes('2') ? null : sql.replace('1', '42')),
    });
    expect(log).toEqual(['connect x', 'SELECT 42;']);
    expect(result.skipped).toBe(1);
  });

  it('stops at the first failing statement with its line number', async () => {
    await expect(
      runPsqlScript('SELECT 1;\nSELECT fail;\nSELECT 3;', { connect: fakeConnect({}, []), initialDatabase: 'x' }),
    ).rejects.toMatchObject({ name: 'PsqlScriptError', line: 2 });
  });
});
