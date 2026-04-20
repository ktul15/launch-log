import dotenv from 'dotenv'
import path from 'path'

// Load .env before any test module is imported so env.ts validation passes.
// env.test.ts overrides process.env per-test via jest.resetModules() — this
// setup only provides the fallback values for integration tests.
dotenv.config({ path: path.resolve(__dirname, '../.env'), quiet: true })
