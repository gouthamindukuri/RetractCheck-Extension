import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import baseConfig from '@retractcheck/config/eslint';

const tsconfigRootDir = dirname(fileURLToPath(import.meta.url));

const base = baseConfig.map((entry) => {
  if (!('languageOptions' in entry) || !entry.languageOptions) return entry;
  return {
    ...entry,
    languageOptions: {
      ...entry.languageOptions,
      globals: {
        ...(entry.languageOptions.globals ?? {}),
        chrome: 'readonly',
      },
    },
  };
});

const ignoreSelf = { ignores: ['eslint.config.js', 'vitest.config.ts', 'vitest.setup.ts', 'tsup.config.ts'] };

export default [
  ignoreSelf,
  ...base,
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.json'],
        tsconfigRootDir,
      },
    },
  },
];
