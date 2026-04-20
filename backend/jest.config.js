/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  collectCoverageFrom: ['src/**/*.ts', '!src/**/__tests__/**/*.ts', '!src/test-setup.ts'],
  setupFiles: ['<rootDir>/src/test-setup.ts'],
  testTimeout: 30000,
}
