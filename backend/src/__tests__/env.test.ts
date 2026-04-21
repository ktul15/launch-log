describe('Environment config validation', () => {
  const originalEnv = process.env

  beforeEach(() => {
    jest.resetModules()
    process.env = { ...originalEnv }
  })

  afterAll(() => {
    // Restore original env and registry — prevents cross-file module cache pollution
    jest.resetModules()
    process.env = originalEnv
  })

  function setValidEnv() {
    process.env.DATABASE_URL = 'postgresql://user:pw@localhost:5432/db'
    process.env.REDIS_URL = 'redis://:pw@localhost:6379'
    process.env.JWT_SECRET = 'a'.repeat(32)
    process.env.JWT_REFRESH_SECRET = 'b'.repeat(32)
  }

  it('parses valid env vars without throwing', () => {
    setValidEnv()
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { env } = require('../config/env')
    expect(env.PORT).toBe(3001)
    expect(env.JWT_ACCESS_EXPIRES_IN).toBe('15m')
    expect(env.JWT_REFRESH_EXPIRES_IN).toBe('7d')
  })

  it('exits if DATABASE_URL is missing', () => {
    setValidEnv()
    delete process.env.DATABASE_URL
    const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit') })
    expect(() => require('../config/env')).toThrow()
    mockExit.mockRestore()
  })

  it('exits if JWT_SECRET is too short', () => {
    setValidEnv()
    process.env.JWT_SECRET = 'tooshort'
    const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit') })
    expect(() => require('../config/env')).toThrow()
    mockExit.mockRestore()
  })

  it('exits if JWT_REFRESH_SECRET is too short', () => {
    setValidEnv()
    process.env.JWT_REFRESH_SECRET = 'tooshort'
    const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit') })
    expect(() => require('../config/env')).toThrow()
    mockExit.mockRestore()
  })

  it('rejects JWT_ACCESS_EXPIRES_IN with invalid format', () => {
    setValidEnv()
    process.env.JWT_ACCESS_EXPIRES_IN = '15 minutes'
    const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit') })
    expect(() => require('../config/env')).toThrow()
    mockExit.mockRestore()
  })

  it('coerces PORT from string to number', () => {
    setValidEnv()
    process.env.PORT = '4000'
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { env } = require('../config/env')
    expect(env.PORT).toBe(4000)
    expect(typeof env.PORT).toBe('number')
  })

  it('defaults NODE_ENV to development when not set', () => {
    setValidEnv()
    delete process.env.NODE_ENV
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { env } = require('../config/env')
    expect(env.NODE_ENV).toBe('development')
  })

  it('defaults LOG_LEVEL to info when not set', () => {
    setValidEnv()
    delete process.env.LOG_LEVEL
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { env } = require('../config/env')
    expect(env.LOG_LEVEL).toBe('info')
  })

  it('accepts valid LOG_LEVEL values', () => {
    for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal']) {
      jest.resetModules()
      process.env = { ...originalEnv }
      setValidEnv()
      process.env.LOG_LEVEL = level
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { env } = require('../config/env')
      expect(env.LOG_LEVEL).toBe(level)
    }
  })

  it('exits if LOG_LEVEL is invalid', () => {
    setValidEnv()
    process.env.LOG_LEVEL = 'verbose'
    const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit') })
    expect(() => require('../config/env')).toThrow()
    mockExit.mockRestore()
  })

  it('parses optional service vars when absent', () => {
    setValidEnv()
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { env } = require('../config/env')
    expect(env.RESEND_API_KEY).toBeUndefined()
    expect(env.STRIPE_SECRET_KEY).toBeUndefined()
    expect(env.GOOGLE_CLIENT_ID).toBeUndefined()
    expect(env.R2_ENDPOINT).toBeUndefined()
  })

  it('parses optional service vars when set', () => {
    setValidEnv()
    process.env.RESEND_API_KEY = 're_test_key_123'
    process.env.STRIPE_SECRET_KEY = 'sk_test_abc'
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_abc'
    process.env.R2_ACCESS_KEY_ID = 'r2-key'
    process.env.R2_SECRET_ACCESS_KEY = 'r2-secret'
    process.env.R2_BUCKET = 'my-bucket'
    process.env.R2_ENDPOINT = 'https://abc123.r2.cloudflarestorage.com'
    process.env.GOOGLE_CLIENT_ID = 'client-id.apps.googleusercontent.com'
    process.env.GOOGLE_CLIENT_SECRET = 'GOCSPX-secret'
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { env } = require('../config/env')
    expect(env.RESEND_API_KEY).toBe('re_test_key_123')
    expect(env.STRIPE_SECRET_KEY).toBe('sk_test_abc')
    expect(env.R2_ENDPOINT).toBe('https://abc123.r2.cloudflarestorage.com')
    expect(env.GOOGLE_CLIENT_ID).toBe('client-id.apps.googleusercontent.com')
  })

  it('exits if R2_ENDPOINT is set but not a valid URL', () => {
    setValidEnv()
    process.env.R2_ENDPOINT = 'not-a-url'
    const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit') })
    expect(() => require('../config/env')).toThrow()
    mockExit.mockRestore()
  })

  it('exits if STRIPE_WEBHOOK_SECRET does not start with whsec_', () => {
    setValidEnv()
    process.env.STRIPE_SECRET_KEY = 'sk_test_abc'
    process.env.STRIPE_WEBHOOK_SECRET = 'sk_live_wrongsecret'
    const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit') })
    expect(() => require('../config/env')).toThrow()
    mockExit.mockRestore()
  })

  it('exits if partial R2 config is set', () => {
    setValidEnv()
    process.env.R2_BUCKET = 'my-bucket'
    // R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ENDPOINT absent
    const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit') })
    expect(() => require('../config/env')).toThrow()
    mockExit.mockRestore()
  })

  it('exits if partial Google OAuth config is set', () => {
    setValidEnv()
    process.env.GOOGLE_CLIENT_ID = 'client-id.apps.googleusercontent.com'
    // GOOGLE_CLIENT_SECRET absent
    const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit') })
    expect(() => require('../config/env')).toThrow()
    mockExit.mockRestore()
  })

  it('exits if partial Stripe config is set', () => {
    setValidEnv()
    process.env.STRIPE_SECRET_KEY = 'sk_test_abc'
    // STRIPE_WEBHOOK_SECRET absent
    const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit') })
    expect(() => require('../config/env')).toThrow()
    mockExit.mockRestore()
  })
})
