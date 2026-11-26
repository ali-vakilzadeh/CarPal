// Part of `pnpm lint` (provider plan PRV-GD-08): ESLint over shared/business-ui with the rules of this app. The package
// has no node_modules of its own and ESLint ignores files outside the folder of its config, so ESLint runs from the
// package's folder with its eslint.config.js, which re-exports this app's config.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pwaDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkgDir = join(pwaDir, '..', 'shared', 'business-ui');
const eslint = join(pwaDir, 'node_modules', 'eslint', 'bin', 'eslint.js');
const run = spawnSync(process.execPath, [eslint, '.'], { cwd: pkgDir, stdio: 'inherit' });
process.exit(run.status ?? 1);
