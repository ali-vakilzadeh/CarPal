// ESLint flat config. Type-aware rules are kept off for speed; `pnpm typecheck` covers types.
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', '.data/**', '.tools/**', 'node_modules/**', '**/generated/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node }, ecmaVersion: 2023, sourceType: 'module' },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports', disallowTypeAnnotations: false }],
      'no-console': 'off',
      // `x != null` (null or undefined) is allowed; everything else is strict.
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },
  {
    // NestJS injects by class: constructor parameter types must stay value imports.
    files: ['apps/**/*.ts', 'modules/**/*.ts', 'workers/**/*.ts', 'libs/platform/**/*.ts'],
    rules: { '@typescript-eslint/consistent-type-imports': 'off' },
  },
);
