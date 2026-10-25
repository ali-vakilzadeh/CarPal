// ESLint flat config (P1.T3). Type-aware rules are off for speed, as in backend/; `pnpm typecheck` covers types.
import js from '@eslint/js';
import nextPlugin from '@next/eslint-plugin-next';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import carpal from './tools/eslint/carpal-plugin.js';

export default tseslint.config(
  { ignores: ['.next/**', 'node_modules/**', 'public/ds/**', 'test-results/**', 'playwright-report/**', 'next-env.d.ts'] },
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
      'no-console': ['error', { allow: ['warn', 'error'] }],
      'carpal/logical-properties': 'error',
      'carpal/no-raw-design-values': 'error',
      // GD-15: API text renders as text. The JSON-LD helper (src/server/ssr/seo/, P5) is the only exception.
      'no-restricted-syntax': [
        'error',
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message: 'dangerouslySetInnerHTML is banned (GD-15); render API text as text. JSON-LD goes through src/server/ssr/seo/.',
        },
      ],
    },
  },
  {
    // Server-only code is imported only by server code: app routes, the proxy, instrumentation and src/server itself.
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/app/**', 'src/server/**', 'src/proxy.ts', 'src/instrumentation.ts', 'src/**/*.test.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [{ group: ['@/server', '@/server/*'], message: 'src/server is server-only.' }] }],
    },
  },
  {
    // GD-03: the BFF is written over Request/Response with no Next.js imports, so it can move to backend/api-gateway.
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
    // JSON-LD (P5) and the constant pre-paint theme script (P3.T3) are the only inline HTML.
    files: ['src/server/ssr/seo/**/*.{ts,tsx}', 'src/components/shell/theme-boot-script.tsx'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  {
    files: ['tools/**/*.{js,mjs,ts}', '*.config.{js,mjs,ts}', 'tests/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
);
