import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';

export default [
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2020,
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-console': 'off',
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },
  {
    files: ['tests/**/*.ts', 'scripts/**/*.ts', 'specgen/generator/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['../src/**', '../../src/**', '../../../src/**'],
              message: "Import source modules through the '#src/...' alias.",
            },
          ],
        },
      ],
    },
  },
  {
    ignores: [
      'dist/**',
      'build/**',
      'node_modules/**',
      // The SDK package has its own typecheck and tests (packages/typescript-api-sdk).
      'packages/**',
      '*.js',
      '*.mjs',
    ],
  },
];
