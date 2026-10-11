import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// Two projects:
//   unit         *.test.ts      no database, runs in parallel
//   integration  *.int.test.ts  needs the local PostgreSQL (pnpm db:start && pnpm db:setup)
// SWC compiles the TypeScript so NestJS decorator metadata is emitted (esbuild cannot).
const backendDir = dirname(fileURLToPath(import.meta.url));
const shared = {
  plugins: [swc.vite({ module: { type: 'es6' } })],
  resolve: {
    // Same "source" condition as tsconfig customConditions: #libs/* etc. resolve to .ts sources.
    conditions: ['source', 'module', 'node', 'import', 'default'],
    // Vite maps "./x.js" to "./x.ts" only for relative imports; do the same for the
    // package.json subpath imports (#libs/crypto/index.js -> libs/crypto/index.ts).
    alias: [{ find: /^#(apps|libs|modules|workers|tools)\/(.+)\.js$/, replacement: `${backendDir.replace(/\\/g, '/')}/$1/$2.ts` }],
  },
};

export default defineConfig({
  test: {
    projects: [
      {
        ...shared,
        test: {
          name: 'unit',
          include: ['{apps,libs,modules,workers,tools}/**/*.test.ts'],
          exclude: ['**/*.int.test.ts', 'node_modules/**', 'dist/**'],
          environment: 'node',
        },
      },
      {
        ...shared,
        test: {
          name: 'integration',
          globalSetup: ['tools/db/vitest.global-setup.ts'],
          include: ['{apps,libs,modules,workers,tools}/**/*.int.test.ts'],
          environment: 'node',
          testTimeout: 60_000,
          hookTimeout: 120_000,
          // One worker: suites share the local cluster and its roles.
          fileParallelism: false,
        },
      },
    ],
  },
});
