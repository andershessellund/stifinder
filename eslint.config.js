import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
  { ignores: ['dist/'] },
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { project: './tsconfig.tests.json', tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // A `Model`'s callbacks may be async or not. The test fixtures are
      // async on purpose, to cover that form, and have nothing to `await`.
      '@typescript-eslint/require-await': 'off',
    },
  },
  // Plain JavaScript (this file, scripts/) is in no tsconfig project.
  { files: ['**/*.js', '**/*.mjs'], extends: [tseslint.configs.disableTypeChecked] },
);
