// PRV-GD-08: the shared components import no BFF client, router or app shell, so both apps can wrap them.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const dir = dirname(fileURLToPath(import.meta.url));
const ALLOWED = /^(react|react\/jsx-runtime|\.\/[\w-]+)$/;

describe('@carpal/business-ui imports', () => {
  it('imports only react and its own files', () => {
    const files = readdirSync(dir).filter((n) => /\.tsx?$/.test(n) && !/\.test\.tsx?$/.test(n));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const text = readFileSync(join(dir, f), 'utf8');
      for (const m of text.matchAll(/^\s*(?:import|export)[^'"]*from\s+['"]([^'"]+)['"]/gm))
        expect(ALLOWED.test(m[1]!), `${f}: ${m[1]}`).toBe(true);
    }
  });
});
