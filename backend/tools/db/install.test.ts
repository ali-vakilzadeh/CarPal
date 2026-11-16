import { describe, expect, it } from 'vitest';
import { baselineUpToDate } from './install.js';

describe('baseline freshness (backend S25b: an existing server takes migrations 0100 onwards)', () => {
  it('is up to date when Docs/43 is the installed file or the file in step with the last migrations', () => {
    expect(baselineUpToDate('a', 'a', undefined)).toBe(true);
    // Installed before 0100; the update applied the migrations that brought Docs/43 to "b".
    expect(baselineUpToDate('b', 'a', 'b')).toBe(true);
    // Docs/43 changed after the last migration run (no migration for the change, or one still pending).
    expect(baselineUpToDate('c', 'a', 'b')).toBe(false);
    expect(baselineUpToDate('b', 'a', undefined)).toBe(false);
  });
});
