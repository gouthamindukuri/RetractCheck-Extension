import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import importPlugin from 'eslint-plugin-import';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default [
  { ignores: ['dist/**', '**/dist/**'] },
  ...tseslint.configs.recommended,
  js.configs.recommended,
  prettier,
  {
    files: ['**/*.{ts,tsx,js,mjs,cjs}'],
    plugins: { import: importPlugin },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.es2021,
        ...globals.node
      },
      parserOptions: {
        project: ['./tsconfig.json'],
        tsconfigRootDir: process.cwd()
      }
    },
    rules: {
      'no-console': 'off',
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'import/order': ['warn', { 'newlines-between': 'always' }],
      '@typescript-eslint/no-explicit-any': 'off',
      // Disable base rule to avoid conflicts with @typescript-eslint/no-unused-vars
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }]
    }
  }
];

