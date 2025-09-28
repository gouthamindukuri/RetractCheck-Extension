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
        D1Database: 'readonly',
        KVNamespace: 'readonly',
        ScheduledEvent: 'readonly',
        ExecutionContext: 'readonly',
        ExportedHandler: 'readonly'
      }
    }
  };
});

const ignoreSelf = { ignores: ['eslint.config.js', 'vitest.config.ts', 'vitest.setup.ts', 'test/**/*.ts'] };

export default [
  ignoreSelf,
  ...base,
  {
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.json'],
        tsconfigRootDir
      }
    }
  }
];

