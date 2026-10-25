import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_PATHS, publishDesignSystem, staleFiles, syncDesignSystem, webFileList } from './sync-design-system.mjs';

const dirs: string[] = [];
function fakeDesignSystem(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ds-src-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'components'), { recursive: true });
  mkdirSync(join(dir, 'fonts'), { recursive: true });
  writeFileSync(join(dir, 'tokens.css'), ':root { --ink: #000; }');
  writeFileSync(join(dir, 'tokens.json'), '{}');
  writeFileSync(join(dir, 'components', 'bundle.css'), '.cp-btn {}');
  writeFileSync(join(dir, 'fonts', 'A.woff2'), 'font');
  writeFileSync(join(dir, 'fonts', 'LICENSE-A.txt'), 'OFL');
  writeFileSync(join(dir, 'fonts', 'notes.md'), 'not synced');
  return dir;
}
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ds-out-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('design-system sync', () => {
  it('shared/design-system/web matches Docs/carpal-design-system', () => {
    expect(staleFiles(DEFAULT_PATHS.source, DEFAULT_PATHS.shared, webFileList(DEFAULT_PATHS.source))).toEqual([]);
  });

  it('copies the web files and fonts, then detects changes and extras', () => {
    const source = fakeDesignSystem();
    const shared = tempDir();
    expect(syncDesignSystem({ source, shared })).toEqual([
      'tokens.css',
      'tokens.json',
      'components/bundle.css',
      'fonts/A.woff2',
      'fonts/LICENSE-A.txt',
    ]);
    const files = webFileList(source);
    expect(staleFiles(source, shared, files)).toEqual([]);

    writeFileSync(join(source, 'tokens.css'), ':root { --ink: #111; }');
    writeFileSync(join(shared, 'old.css'), '');
    expect(staleFiles(source, shared, files)).toEqual(['tokens.css', 'old.css (extra)']);

    syncDesignSystem({ source, shared });
    expect(staleFiles(source, shared, files)).toEqual([]);
  });

  it('publishes only the browser files', () => {
    const source = fakeDesignSystem();
    const shared = tempDir();
    const publicDir = tempDir();
    syncDesignSystem({ source, shared });
    expect(publishDesignSystem({ shared, public: publicDir })).toEqual(['tokens.css', 'components/bundle.css', 'fonts/A.woff2']);
    expect(readFileSync(join(publicDir, 'fonts', 'A.woff2'), 'utf8')).toBe('font');
  });
});
