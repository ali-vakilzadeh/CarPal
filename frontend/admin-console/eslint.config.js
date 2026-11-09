// ESLint flat config, copied from pwa/eslint.config.js (GD-01) and narrowed for the console. Type-aware rules are
// off for speed; `pnpm typecheck` covers types.
import js from '@eslint/js';
import nextPlugin from '@next/eslint-plugin-next';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import carpal from './tools/eslint/carpal-plugin.js';

export default tseslint.config(
  {
    ignores: [
      '.next/**',
      'node_modules/**',
      'public/ds/**',
      'test-results/**',
      'playwright-report/**',
      'next-env.d.ts',
      'src/lib/api/generated/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  nextPlugin.configs['core-web-vitals'],
  reactHooks.configs.flat['recommended-latest'],
  {
    plugins: { carpal },
    languageOptions: { globals: { ...globals.browser, ...globals.node }, ecmaVersion: 2023, sourceType: 'module' },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports', disallowTypeAnnotations: false }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      // GD-12: console logs never print response bodies; only warn/error, and those without data.
      'no-console': ['error', { allow: ['warn', 'error'] }],
      'carpal/logical-properties': 'error',
      'carpal/no-raw-design-values': 'error',
      'no-restricted-syntax': [
        'error',
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message: 'dangerouslySetInnerHTML is banned; render API text as text.',
        },
      ],
      // GD-12: no personal data in the browser. Responses never go to Web Storage or IndexedDB; the only allowed
      // use (saved views and column choices without data, AC5) goes through one reviewed module.
      'no-restricted-globals': [
        'error',
        { name: 'localStorage', message: 'GD-12: no browser storage for responses. Use src/lib/prefs (AC5) for view settings.' },
        { name: 'sessionStorage', message: 'GD-12: no browser storage for responses.' },
        { name: 'indexedDB', message: 'GD-12: no browser storage for responses.' },
      ],
    },
  },
  {
    // Server-only code is imported only by server code: app routes, the proxy and src/server itself.
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/app/**', 'src/server/**', 'src/proxy.ts', 'src/**/*.test.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [{ group: ['@/server', '@/server/*'], message: 'src/server is server-only.' }] }],
    },
  },
  {
    // GD-03: the BFF (AC3) is written over Request/Response with no Next.js imports, like the PWA's.
    files: ['src/server/bff/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['next', 'next/*', 'server-only'], message: 'The BFF must not depend on Next.js (GD-03).' }] },
      ],
    },
  },
  {
    // Features never reach into each other's internals: import another feature through its index only.
    files: ['src/features/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@/features/*/*'],
              message: "Import another feature through its index ('@/features/<area>'); use relative paths inside a feature.",
            },
          ],
        },
      ],
    },
  },
  {
    // The constant pre-paint theme script is the only inline HTML.
    files: ['src/components/shell/theme-boot-script.tsx'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  {
    files: ['tools/**/*.{js,mjs,ts}', '*.config.{js,mjs,ts}', 'tests/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
);
