// Locations on disk, valid both for TypeScript sources (libs/config/paths.ts)
// and the compiled build (dist/libs/config/paths.js): the backend folder is
// found by walking up to the package.json of @carpal/backend.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function findBackendDir(start: string): string {
  let dir = start;
  for (;;) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg)) {
      try {
        if ((JSON.parse(readFileSync(pkg, 'utf8')) as { name?: string }).name === '@carpal/backend') return dir;
      } catch {
        // not our package.json; keep walking
      }
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`@carpal/backend package.json not found above ${start}`);
    dir = parent;
  }
}

export const backendDir = findBackendDir(dirname(fileURLToPath(import.meta.url)));
export const repoDir = resolve(backendDir, '..');
/** Lite-mode runtime data (embedded PostgreSQL, local object storage, mail/SMS/push sinks). Gitignored. */
export const dataDir = join(backendDir, '.data');
/** Region configuration files (Plan §3.5): shared/region-config/<region_key>.json. */
export const regionConfigDir = join(repoDir, 'shared', 'region-config');
