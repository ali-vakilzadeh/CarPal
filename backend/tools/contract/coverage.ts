// pnpm contract:coverage — how many contract operations have a handler.
// A handler is a method decorated with @Operation('<op.id>') (S2 router, GD-05);
// operations without one answer 501 NOT_IMPLEMENTED until their stage lands.
// The signed storage PUT is served by the storage listener, not the router
// (STORAGE_OPERATIONS), and the deferred operations answer 501 by decision
// (DEFERRED_OPERATIONS). --strict fails on any other operation without a
// handler (CI).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { loadRegistry } from '#libs/contract/index.js';
import { backendDir } from '../db/config.js';

const SOURCE_DIRS = ['apps', 'libs', 'modules', 'workers'];
// One decorator may bind several ids (@Operation('a.x', 'b.y'), e.g. the AI feature requests).
const DECORATOR = /@Operation\(([^)]*)\)/g;
const OP_ID = /['"]([a-z_]+\.[a-z_]+)['"]/g;

/** Operations that answer 501 NOT_IMPLEMENTED by decision, with the reason (S9c reviewed list; OpenAPI x-carpal-status). */
export const DEFERRED_OPERATIONS: Readonly<Record<string, { status: string; reason: string }>> = {
  'auth.social_start': {
    status: 'deferred-post-mvp',
    reason: 'Google/Apple sign-in is post-MVP (OQ-06, PM-01); the route stays registered and answers 501 NOT_IMPLEMENTED.',
  },
};

/** Operations of the storage host: served by the signed-URL storage listener (file), recognised by its PUT branch. */
export const STORAGE_OPERATIONS: Readonly<Record<string, { file: string; marker: RegExp }>> = {
  'media.upload_put': { file: 'libs/infra/lite/local-storage.ts', marker: /req\.method === 'PUT'/ },
};

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

/** Operation id -> the file that serves it (a handler, or the storage listener). */
export function implementedOperations(): Map<string, string> {
  const found = new Map<string, string>();
  for (const [id, s] of Object.entries(STORAGE_OPERATIONS))
    if (s.marker.test(readFileSync(join(backendDir, s.file), 'utf8'))) found.set(id, s.file);
  for (const d of SOURCE_DIRS) {
    for (const file of tsFiles(join(backendDir, d))) {
      for (const m of readFileSync(file, 'utf8').matchAll(DECORATOR))
        for (const id of m[1]!.matchAll(OP_ID)) found.set(id[1]!, relative(backendDir, file).replace(/\\/g, '/'));
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
  const missing = registry.operations.filter((o) => !implemented.has(o.opId)).map((o) => o.opId);
  for (const id of missing.filter((m) => DEFERRED_OPERATIONS[m])) console.log(`  deferred  ${id}: ${DEFERRED_OPERATIONS[id]!.reason}`);
  for (const id of Object.keys(STORAGE_OPERATIONS).filter((m) => implemented.has(m)))
    console.log(`  storage   ${id}: served by ${implemented.get(id)}`);
  const unexplained = missing.filter((m) => !DEFERRED_OPERATIONS[m]);
  const stale = Object.keys(DEFERRED_OPERATIONS).filter((d) => implemented.has(d) || !registry.operations.some((o) => o.opId === d));
  console.log(`Unexplained 501s: ${unexplained.length}${unexplained.length ? ` (${unexplained.join(', ')})` : ''}`);
  if (unknown.length > 0) {
    console.error(`@Operation ids not in the contract: ${unknown.join(', ')}`);
    process.exit(1);
  }
  if (stale.length > 0) {
    console.error(`Deferred operations that are implemented or not in the contract: ${stale.join(', ')}`);
    process.exit(1);
  }
  if (process.argv.includes('--strict') && unexplained.length > 0) process.exit(1);
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('tools/contract/coverage.ts')) main();
