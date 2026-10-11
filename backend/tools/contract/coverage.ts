// pnpm contract:coverage — how many contract operations have a handler.
// A handler is a method decorated with @Operation('<op.id>') (S2 router, GD-05);
// operations without one answer 501 NOT_IMPLEMENTED until their stage lands.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { loadRegistry } from '#libs/contract/index.js';
import { backendDir } from '../db/config.js';

const SOURCE_DIRS = ['apps', 'libs', 'modules', 'workers'];
const DECORATOR = /@Operation\(\s*['"]([a-z_]+\.[a-z_]+)['"]/g;

function* tsFiles(dir: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const e of entries) {
    if (e === 'node_modules' || e === 'generated' || e === 'dist') continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) yield* tsFiles(p);
    else if (e.endsWith('.ts') && !e.endsWith('.test.ts')) yield p;
  }
}

export function implementedOperations(): Map<string, string> {
  const found = new Map<string, string>();
  for (const d of SOURCE_DIRS) {
    for (const file of tsFiles(join(backendDir, d))) {
      for (const m of readFileSync(file, 'utf8').matchAll(DECORATOR)) found.set(m[1]!, relative(backendDir, file).replace(/\\/g, '/'));
    }
  }
  return found;
}

function main(): void {
  const registry = loadRegistry();
  const implemented = implementedOperations();
  const unknown = [...implemented.keys()].filter((id) => !registry.operations.some((o) => o.opId === id));
  const byModule = new Map<string, { total: number; done: number }>();
  for (const o of registry.operations) {
    const m = byModule.get(o.module) ?? { total: 0, done: 0 };
    m.total++;
    if (implemented.has(o.opId)) m.done++;
    byModule.set(o.module, m);
  }
  console.log('module            implemented / total');
  for (const [m, c] of [...byModule].sort()) console.log(`${m.padEnd(18)}${String(c.done).padStart(5)} / ${c.total}`);
  const done = [...byModule.values()].reduce((n, c) => n + c.done, 0);
  console.log(
    `TOTAL             ${String(done).padStart(5)} / ${registry.operationCount}   (returning 501: ${registry.operationCount - done})`,
  );
  if (unknown.length > 0) {
    console.error(`@Operation ids not in the contract: ${unknown.join(', ')}`);
    process.exit(1);
  }
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('tools/contract/coverage.ts')) main();
