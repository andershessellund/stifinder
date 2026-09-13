import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/'] },
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { project: './tsconfig.tests.json', tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // `ExplorerConfig` callbacks are declared async by contract; models
      // that happen to be synchronous need no `await`.
      '@typescript-eslint/require-await': 'off',
    },
  },
  { files: ['*.js'], ...tseslint.configs.disableTypeChecked },
);
