// Copies runtime JSON assets (generated contract registry and schemas) into dist/
// after tsc, which only emits .js. Run by `pnpm build`.
import { cpSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const backendDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const roots = ['apps', 'libs', 'modules', 'workers'];
let copied = 0;
function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p);
    else if (entry.endsWith('.json')) {
      cpSync(p, join(backendDir, 'dist', relative(backendDir, p)));
      copied++;
    }
  }
}
for (const r of roots) if (existsSync(join(backendDir, r))) walk(join(backendDir, r));
console.log(`Copied ${copied} JSON assets to dist/`);
