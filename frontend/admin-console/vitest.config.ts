import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Projects (GD-14, copied from pwa/vitest.config.ts):
//   unit         *.test.ts      node, no network (src/ and tools/)
//   dom          *.test.tsx     jsdom + Testing Library (components)
//   integration  *.int.test.ts  against the live backend in lite mode (`pnpm dev` in backend/; from AC3 on)
const appDir = dirname(fileURLToPath(import.meta.url));

const shared = {
  plugins: [react()],
  resolve: {
    alias: {
      '@': join(appDir, 'src'),
      // 'server-only' throws outside the React server build; tests import server modules directly.
      'server-only': join(appDir, 'tests', 'setup', 'server-only.ts'),
    },
  },
};

export default defineConfig({
  test: {
    projects: [
      {
        ...shared,
        test: { name: 'unit', include: ['src/**/*.test.ts', 'tools/**/*.test.ts'], exclude: ['**/*.int.test.ts'], environment: 'node' },
      },
      {
        ...shared,
        test: {
          name: 'dom',
          include: ['src/**/*.test.tsx'],
          environment: 'jsdom',
          setupFiles: ['tests/setup/dom.ts'],
          testTimeout: 15_000,
        },
      },
      {
        ...shared,
        test: { name: 'integration', include: ['src/**/*.int.test.ts'], environment: 'node', fileParallelism: false },
      },
    ],
  },
});
