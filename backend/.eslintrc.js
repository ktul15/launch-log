/** @type {import('eslint').Linter.Config} */
module.exports = {
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
  ],
  parserOptions: {
    project: './tsconfig.eslint.json',
    tsconfigRootDir: __dirname,
  },
  env: {
    node: true,
    es2022: true,
  },
  rules: {
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/explicit-function-return-type': 'off',
    // console.log is forbidden in production source — use fastify.log instead.
    // console.error and console.warn are allowed for startup/shutdown messages.
    'no-console': ['error', { allow: ['error', 'warn'] }],
  },
  overrides: [
    {
      // Test files use require() for jest.resetModules() module isolation.
      // no-explicit-any is relaxed (not disabled) — 'warn' allows intentional casts
      // in error-object inspection without silently accepting accidental any types.
      files: ['src/**/__tests__/**/*.ts', 'src/**/*.test.ts'],
      rules: {
        '@typescript-eslint/no-require-imports': 'off',
        '@typescript-eslint/no-explicit-any': 'warn',
      },
    },
  ],
  ignorePatterns: ['dist/', 'node_modules/'],
}
