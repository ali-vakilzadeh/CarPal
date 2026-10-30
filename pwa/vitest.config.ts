import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Projects:
//   unit         *.test.ts    node, no network (src/ and tools/)
//   dom          *.test.tsx   jsdom + Testing Library (components)
//   integration  *.int.test.ts  against the live backend in lite mode (P2 onward; `pnpm dev` in backend/)
const pwaDir = dirname(fileURLToPath(import.meta.url));

const shared = {
  plugins: [react()],
  resolve: {
    alias: {
      '@': join(pwaDir, 'src'),
      // 'server-only' throws outside the React server build; tests import server modules directly.
      'server-only': join(pwaDir, 'tests', 'setup', 'server-only.ts'),
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
        // jsdom renders of whole screens take well under a second alone but can pass 5 s when every worker is busy (P8).
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
