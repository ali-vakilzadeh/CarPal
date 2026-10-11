import { describe, expect, it } from 'vitest';
import { hasCode, splitScript } from './lexer.js';

const sqlTexts = (script: string): string[] => splitScript(script).flatMap((i) => (i.kind === 'sql' ? [i.text] : []));

describe('splitScript', () => {
  it('splits on top-level semicolons only', () => {
    expect(sqlTexts('SELECT 1; SELECT (2;3);\nSELECT 4;')).toEqual(['SELECT 1;', 'SELECT (2;3);', 'SELECT 4;']);
  });

  it('ignores semicolons in quotes, identifiers, dollar quotes and comments', () => {
    const script = [
      "SELECT 'a;b', 'it''s;';",
      'SELECT "we;ird";',
      'CREATE FUNCTION f() RETURNS int LANGUAGE plpgsql AS $$ BEGIN RETURN 1; END $$;',
      'DO $roles$ BEGIN PERFORM 1; END $roles$;',
      '-- comment; with semicolon',
      '/* block; /* nested; */ still comment; */ SELECT 5;',
    ].join('\n');
    expect(sqlTexts(script)).toHaveLength(5);
    expect(sqlTexts(script)[4]).toMatch(/SELECT 5;$/);
  });

  it('handles E strings with backslash escapes', () => {
    expect(sqlTexts("SELECT E'a\\';b'; SELECT 2;")).toEqual(["SELECT E'a\\';b';", 'SELECT 2;']);
  });

  it('does not treat $1 or identifiers containing $ as dollar quotes', () => {
    expect(sqlTexts('SELECT $1; SELECT a$b$c; SELECT 3;')).toHaveLength(3);
  });

  it('recognizes meta-commands and \\gset / \\gexec terminators', () => {
    const items = splitScript(
      ['\\set env dev', "SELECT :'env' = 'dev' AS ok \\gset", '\\if :ok', "SELECT format('SELECT 1') \\gexec", '\\endif'].join('\n'),
    );
    expect(items.map((i) => (i.kind === 'meta' ? `\\${i.command}` : i.terminator))).toEqual(['\\set', 'gset', '\\if', 'gexec', '\\endif']);
    expect(items[0]).toMatchObject({ kind: 'meta', command: 'set', args: 'env dev', line: 1 });
    expect(items[3]).toMatchObject({ kind: 'sql', line: 4 });
  });

  it('ignores backslashes inside string literals (regular expressions)', () => {
    expect(sqlTexts("SELECT 'x' ~ '^[a-z]+(\\.[a-z]+)$';")).toHaveLength(1);
  });

  it('reports the line of the first code character, not of leading comments', () => {
    const items = splitScript('SELECT 1;\n\n-- about the next one\nSELECT 2;');
    expect(items[1]).toMatchObject({ kind: 'sql', line: 4 });
  });

  it('refuses a meta-command inside an unfinished statement', () => {
    expect(() => splitScript('SELECT 1\n\\echo hi\n;')).toThrow(/unfinished statement/);
  });
});

describe('hasCode', () => {
  it('is false for whitespace and comments only', () => {
    expect(hasCode('  -- x\n /* y */ ')).toBe(false);
    expect(hasCode(' SELECT 1')).toBe(true);
  });
});
